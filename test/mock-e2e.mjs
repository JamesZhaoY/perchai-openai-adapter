#!/usr/bin/env node
/**
 * End-to-end test against a local mock of the Perch web API.
 * Verifies: cookie auth wiring, thread creation/reuse, SSE parsing,
 * OpenAI streaming chunks and non-streaming completions.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const MOCK_PORT = 18881;
const ADAPTER_PORT = 18882;
const API_KEY = "sk-test-key";

process.env.PERCHAI_ORIGIN = "http://127.0.0.1:" + MOCK_PORT;
process.env.PERCHAI_ADAPTER_KEY = API_KEY;
process.env.PORT = String(ADAPTER_PORT);
process.env.HOST = "127.0.0.1";
process.env.PERCHAI_CLI_HISTORY_DIR = path.join(os.tmpdir(), "perch-mock-cli-history-" + process.pid);
process.env.PERCHAI_THREADS_PATH = path.join(os.tmpdir(), "perch-mock-threads-" + process.pid + ".json");
process.env.PERCHAI_ACCOUNTS_PATH = path.join(os.tmpdir(), "perch-mock-accounts-" + process.pid + ".json");
process.env.PERCHAI_COOKIE =
  "sb-zlfuvsfjtgsdtqcaykia-auth-token=base64-" +
  Buffer.from(
    JSON.stringify({
      access_token: "mock-access",
      refresh_token: "mock-refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "u1", email: "mock@example.com" },
    }),
  ).toString("base64url");

const seen = { threadsCreated: 0, chatBodies: [], cliCalls: [], tickets: 0 };

function accountEmail(req) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/sb-zlfuvsfjtgsdtqcaykia-auth-token=(base64-[^;]+)/);
  if (!match) return null;
  try {
    const session = JSON.parse(Buffer.from(match[1].slice("base64-".length), "base64url").toString("utf8"));
    return session.user?.email || session.access_token || null;
  } catch {
    return null;
  }
}

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (obj, type = "application/json") => {
    res.writeHead(200, { "Content-Type": type });
    res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
  };
  if (url.pathname === "/api/perchai/account") {
    return send({ ok: true, profile: { email: accountEmail(req) || "mock@example.com" }, session: { planCode: "pro", planName: "Pro" }, usageMeter: null });
  }
  if (url.pathname === "/api/perchai/threads" && req.method === "GET") return send({ ok: true, threads: [] });
  if (url.pathname === "/api/perchai/threads" && req.method === "POST") {
    seen.threadsCreated += 1;
    return send({ ok: true, thread: { id: "t" + seen.threadsCreated } });
  }
  if (url.pathname === "/api/perchai/chat") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.chatBodies.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        { type: "reasoning_delta", text: "thinking" },
        { type: "answer_delta", text: "Hello" },
        { type: "answer_delta", text: " there" },
        { type: "citations", citations: [{ title: "doc", url: "https://example.com" }] },
        { type: "done", ok: true, text: "Hello there", modelLabel: "Roost Pro", tier: "pro", durationMs: 12 },
      ];
      res.write(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""));
      res.end();
    });
    return;
  }
  if (url.pathname === "/api/perch-terminal/cli-context") {
    return send({ ok: true, session: { userId: "u1", workspaceId: "w1", planCode: "pilot" } });
  }
  if (url.pathname === "/api/perch-terminal/turn-ticket") {
    seen.tickets += 1;
    return send({
      ok: true, ticket: "mock-ticket", ticketId: "ticket-1", runId: "tkt-cli-mock",
      expiresAt: new Date(Date.now() + 300000).toISOString(), profile: "standard", enforced: false,
    });
  }
  if (url.pathname === "/api/perch-terminal/model-call") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.cliCalls.push({ headers: req.headers, body });
      if (req.headers["x-perch-turn-ticket"] !== "mock-ticket") {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "perch_surface_required" }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const model = body.manualModelOptionId === "openrouter-z-ai-glm-5-3-flash"
        ? "z-ai/glm-5.3-flash" : "minimax/minimax-m3.1-flash";
      const events = [
        { type: "reasoning_delta", text: "cli-thinking" },
        { type: "answer_delta", text: "CLI " },
        { type: "answer_delta", text: "OK" },
        { type: "done", ok: true, text: "CLI OK", model, provider: "perch", durationMs: 7,
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      ];
      res.write(events.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""));
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitReady(url) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error("adapter did not start");
}

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exitCode = 1;
}

await new Promise((r) => upstream.listen(MOCK_PORT, "127.0.0.1", r));
const adapter = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  env: process.env,
  stdio: ["ignore", "pipe", "inherit"],
});
let logs = "";
adapter.stdout.on("data", (d) => (logs += d.toString()));

try {
  await waitReady("http://127.0.0.1:" + ADAPTER_PORT + "/healthz");

  const models = await (await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/v1/models", {
    headers: { Authorization: "Bearer " + API_KEY },
  })).json();
  if (!models.data.some((m) => m.id === "perch-auto")) fail("models missing perch-auto");
  if (!models.data.some((m) => m.id === "gpt-6-sol")) fail("models missing named gpt-6-sol");

  const noAuth = await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/v1/models");
  if (noAuth.status !== 401) fail("expected 401 without local key, got " + noAuth.status);

  const body = {
    model: "perch-pro",
    stream: true,
    messages: [
      { role: "system", content: "Be terse." },
      { role: "user", content: "hi" },
    ],
  };
  const res = await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!raw.includes("Hello") || !raw.includes("[DONE]")) fail("stream missing content/DONE: " + raw.slice(0, 200));
  if (!seen.chatBodies.length) fail("upstream chat not called");
  const sent = seen.chatBodies.at(-1);
  if (sent.roostChoice !== "pro") fail("roostChoice not forwarded");
  if (!sent.message.includes("Be terse.")) fail("system prompt not prepended");
  if (!seen.chatBodies.at(-1).threadId) fail("threadId missing");

  const res2 = await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "perch-auto",
      stream: false,
      user: "u1",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "Hello there" },
        { role: "user", content: "second" },
      ],
    }),
  });
  const completion = await res2.json();
  if (completion.choices?.[0]?.message?.content !== "Hello there") fail("non-stream content wrong");
  if (completion.choices?.[0]?.message?.reasoning_content !== "thinking") fail("reasoning not forwarded");
  if (seen.threadsCreated !== 2) fail("expected a fresh thread for mismatched history, got " + seen.threadsCreated);

  const cliRes = await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3-flash-starter", stream: true, user: "cli-user", messages: [{ role: "user", content: "hi" }] }),
  });
  const cliRaw = await cliRes.text();
  const cliText = cliRaw.split("\n\n").filter((b) => b.startsWith("data: ") && b !== "data: [DONE]")
    .map((b) => JSON.parse(b.slice(6)))
    .map((c) => c.choices?.[0]?.delta?.content || "").join("");
  if (cliText !== "CLI OK") fail("cli stream content wrong: " + JSON.stringify(cliText) + " raw=" + cliRaw.slice(0, 400));
  if (!seen.cliCalls.length) fail("cli model-call not called");
  const cliCall = seen.cliCalls.at(-1);
  if (cliCall.headers["x-perch-turn-ticket"] !== "mock-ticket") fail("turn ticket header missing");
  if (cliCall.body.clientSurface !== "cli") fail("clientSurface not cli");
  if (cliCall.body.strictManual !== true) fail("strictManual not pinned");
  if (cliCall.body.manualModelOptionId !== "openrouter-z-ai-glm-5-3-flash") fail("wrong manualModelOptionId");
  if (!cliRaw.includes("\"reasoning_content\":\"cli-thinking\"")) fail("cli reasoning not forwarded");

  const consolePage = await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/console");
  const consoleCookie = consolePage.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
  await consolePage.body.cancel();
  const mockCookie = (token, id, email) => "sb-zlfuvsfjtgsdtqcaykia-auth-token=base64-" +
    Buffer.from(JSON.stringify({
      access_token: token, refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id, email },
    })).toString("base64url");
  const second = await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/console/api/session", {
    method: "POST",
    headers: { Cookie: consoleCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ cookie: mockCookie("mock-access-b", "u2", "b@example.com"), label: "账号B" }),
  });
  const secondBody = await second.json();
  if (!secondBody.ok) fail("second account was not added: " + JSON.stringify(secondBody));
  const list = await (await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/console/api/accounts", {
    headers: { Cookie: consoleCookie },
  })).json();
  if (list.count !== 2) fail("expected 2 pooled accounts, got " + list.count);
  if (JSON.stringify(list).includes("mock-access")) fail("account list leaked a cookie");
  const accA = list.accounts.find((a) => a.email === "mock@example.com");
  const accB = list.accounts.find((a) => a.email === "b@example.com");
  if (!accA || !accB) fail("pooled account identities missing");

  const poolChat = async ({ user, messages, accountId }) => {
    const res = await fetch("http://127.0.0.1:" + ADAPTER_PORT + "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + API_KEY,
        "Content-Type": "application/json",
        ...(accountId ? { "X-Perch-Account": accountId } : {}),
      },
      body: JSON.stringify({ model: "perch-auto", stream: false, user, messages }),
    });
    const data = await res.json();
    if (!res.ok) fail("pool chat failed: " + res.status + " " + JSON.stringify(data));
    return data;
  };

  const first = await poolChat({ user: "pool-a", messages: [{ role: "user", content: "first" }] });
  const firstAccount = first.perch?.account?.id;
  if (!firstAccount) fail("perch.account missing");
  const followUp = await poolChat({
    user: "pool-a",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: first.choices[0].message.content },
      { role: "user", content: "second" },
    ],
  });
  if (followUp.perch?.account?.id !== firstAccount) fail("sticky user changed accounts");
  if (followUp.perch?.threadId !== first.perch?.threadId) fail("sticky user changed threads");

  const other = await poolChat({ user: "pool-b", messages: [{ role: "user", content: "hello" }] });
  if (other.perch?.account?.id === firstAccount) fail("round-robin did not rotate accounts");
  const pinned = await poolChat({ user: "pool-c", accountId: accB.id, messages: [{ role: "user", content: "pinned" }] });
  if (pinned.perch?.account?.id !== accB.id) fail("X-Perch-Account pin ignored");

  const switched = await poolChat({
    user: "pool-a",
    accountId: accB.id,
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: first.choices[0].message.content },
      { role: "user", content: "second" },
    ],
  });
  if (switched.perch?.account?.id !== accB.id) fail("pinned switch did not use the new account");
  if (switched.perch?.threadId === first.perch?.threadId) fail("thread leaked across accounts");

  console.log("PASS: adapter mock e2e (web + cli protocol, account pool, stream + non-stream, thread reuse/replay, auth)");
} finally {
  adapter.kill();
  upstream.close();
}
