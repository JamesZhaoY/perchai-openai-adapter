import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  PerchClient,
  PerchError,
  listModels,
  resolveModel,
  readState,
  writeState,
  randomId,
  decodeClaims,
  webModelAccess,
  validateWebModelAccess,
  STARTER_DESKTOP_MODELS,
  isCliModel,
} from "./src/perch.mjs";
import { AccountPool, PoolError } from "./src/account-pool.mjs";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 18791);
const ROOT = path.resolve(new URL(".", import.meta.url).pathname);
const THREADS_PATH = process.env.PERCHAI_THREADS_PATH || path.join(ROOT, "data", "threads.json");
const CONSOLE_DIR = path.join(ROOT, "console");
const CONSOLE_COOKIE = "perch_console";
const CONSOLE_TOKEN = crypto.randomBytes(18).toString("base64url");
const pool = new AccountPool();

function accountClient(account) {
  return new PerchClient({
    account,
    onRefresh: (cookie) => pool.updateCookie(account.id, cookie),
  });
}

function publicAccount(account) {
  if (!account) return null;
  return { id: account.id, label: account.label || account.email || account.id, email: account.email || null };
}

function localKey() {
  if (process.env.PERCHAI_ADAPTER_KEY) return process.env.PERCHAI_ADAPTER_KEY;
  const state = readState();
  if (state.apiKey) return state.apiKey;
  const key = "sk-perch-" + crypto.randomBytes(18).toString("base64url");
  writeState({ apiKey: key });
  return key;
}

const API_KEY = localKey();

function readThreads() {
  try {
    return JSON.parse(fs.readFileSync(THREADS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeThreads(next) {
  fs.mkdirSync(path.dirname(THREADS_PATH), { recursive: true });
  fs.writeFileSync(THREADS_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

function openaiError(res, status, message, code = null, extra = {}) {
  json(res, status, {
    error: {
      message,
      type: status === 401 ? "authentication_error" : "perch_error",
      code,
      ...extra,
    },
  });
}

function consoleJson(res, status, body) {
  json(res, status, body);
}

function hasConsoleAuth(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").some((part) => part.trim() === CONSOLE_COOKIE + "=" + CONSOLE_TOKEN);
}

function summarizeAccount(client, account) {
  const s = account.session || {};
  const claims = decodeClaims(client.session);
  const expiresAt = Number(client.session?.expires_at || claims?.exp || 0);
  return {
    ok: true,
    hasSession: true,
    email: account.profile?.email || claims?.email || null,
    name: account.profile?.name || null,
    planCode: s.planCode || null,
    planName: s.planName || null,
    webModelAccess: webModelAccess(s),
    role: s.membershipRole || null,
    entitlements: s.entitlements || [],
    tierSelectionRequired: Boolean(s.tierSelectionRequired),
    usageMeter: account.usageMeter || null,
    userId: client.session?.user?.id || claims?.sub || null,
    expiresAt: expiresAt || null,
    expiresInSec: expiresAt ? Math.max(0, expiresAt - Math.floor(Date.now() / 1000)) : null,
  };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && part.type === "text") return part.text || "";
        return "";
      })
      .join("");
  }
  return "";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new PerchError("Request body too large", { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new PerchError("Invalid JSON body", { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Turn an OpenAI-style message list into one Perch turn.
 * Perch keeps thread history server-side, so only the newest user message is sent.
 * Prior turns are replayed as text when a fresh thread is needed.
 */
function buildTurn(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).filter(Boolean);
  const convo = list.filter((m) => m.role === "user" || m.role === "assistant");
  const users = convo.filter((m) => m.role === "user");
  const lastUser = users[users.length - 1];
  if (!lastUser || !textOf(lastUser.content).trim()) {
    throw new PerchError("No user message with text content", { status: 400 });
  }
  return { system, convo, userCount: users.length, text: textOf(lastUser.content) };
}

function transcript(convo) {
  const lines = [];
  for (const m of convo) {
    const body = textOf(m.content).trim();
    if (!body) continue;
    lines.push((m.role === "user" ? "User: " : "Assistant: ") + body);
  }
  return lines.join("\n\n");
}

async function prepare({ client, body, headers }) {
  const turn = buildTurn(body.messages);
  const model = resolveModel(body.model);
  if (!model) {
    throw new PerchError(
      "Unknown model '" + (body.model || "") + "'. Call /v1/models for available ids.",
      { status: 400, code: "unknown_model" },
    );
  }
  const pinnedThread = headers["x-perch-thread"];
  const stateless = String(headers["x-perch-stateless"] || "") === "1";
  const key = String(body.user || headers["x-perch-conversation"] || "default");
  const threads = readThreads();
  let record = pinnedThread ? { threadId: pinnedThread, turns: turn.userCount - 1 } : threads[key];
  const recordAccount = record?.accountId || null;
  const accountMismatch = Boolean(record && client.accountId && recordAccount && recordAccount !== client.accountId);
  const legacyAccountMismatch = Boolean(record && !recordAccount && client.accountId && client.accountId !== "default");
  const needNew = stateless || !record || accountMismatch || legacyAccountMismatch ||
    record.turns !== turn.userCount - 1 || record.threadId.startsWith("cli-") !== isCliModel(model.publicName);
  let threadId = needNew ? null : record.threadId;
  let message = turn.text;
  const notice = [];

  if (needNew && turn.convo.length > 1) {
    message = transcript(turn.convo.slice(0, -1)) + "\n\nCurrent message:\n" + turn.text;
    notice.push("history_replayed");
  }
  if (turn.system.length) {
    message = "Instructions for this reply:\n" + turn.system.join("\n\n") + "\n\n" + message;
    notice.push("system_prepended");
  }
  if (!threadId) {
    const created = await client.createThread(model.publicName);
    threadId = created.thread && created.thread.id;
    if (!threadId) throw new PerchError("Perch did not return a thread id", { status: 502 });
  }
  return { turn, model, key, threads, threadId, message, stateless, notice, accountId: client.accountId || null };
}

function commitThread(prepared, threadId, turns, modelName) {
  if (prepared.stateless) return;
  prepared.threads[prepared.key] = {
    threadId, turns, model: modelName,
    ...(prepared.accountId ? { accountId: prepared.accountId } : {}),
    updatedAt: Date.now(),
  };
  writeThreads(prepared.threads);
}

async function handleChat(req, res, body) {
  const wantsStream = Boolean(body.stream);
  const stickyKey = String(body.user || req.headers["x-perch-conversation"] || "default");
  const requestedAccount = String(req.headers["x-perch-account"] || body.perch?.account || "").trim() || null;
  const existing = readThreads()[stickyKey] || null;
  let account;
  try {
    account = pool.resolve({
      accountId: requestedAccount,
      stickyKey,
      threadAccountId: existing?.accountId || null,
    });
  } catch (err) {
    return openaiError(res, err.status || 503, err.message, err.code || null, err.detail ? { detail: err.detail } : {});
  }
  const client = accountClient(account);
  const prepared = await prepare({ client, body, headers: req.headers });
  const chatOpts = {
    threadId: prepared.threadId,
    message: prepared.message,
    webSearch: Boolean(body.web_search || body.webSearch || (body.perch && body.perch.webSearch)),
    roostChoice: prepared.model.roostChoice || "standard",
    manualModelOptionId: prepared.model.manualModelOptionId || null,
    ...(Number.isFinite(Number(body.temperature)) ? { temperature: Number(body.temperature) } : {}),
    ...(Number.isFinite(Number(body.max_tokens)) && Number(body.max_tokens) > 0 ? { maxTokens: Math.floor(Number(body.max_tokens)) } : {}),
  };
  const id = "chatcmpl-" + randomId(12);
  const created = Math.floor(Date.now() / 1000);
  const modelName = prepared.model.publicName;
  let finished = false;
  let text = "";
  let reasoning = "";
  let citations = [];
  let artifact = null;
  let doneEvent = null;

  if (!wantsStream) {
    try {
    for await (const ev of client.chat(chatOpts)) {
      if (ev.type === "answer_delta") text += String(ev.text || "");
      else if (ev.type === "reasoning_delta") reasoning += String(ev.text || "");
      else if (ev.type === "citations") citations = ev.citations || citations;
      else if (ev.type === "artifact") artifact = ev.artifact || artifact;
      else if (ev.type === "done") doneEvent = ev;
    }
    if (!doneEvent) throw new PerchError("Perch stream ended before done", { status: 502, code: "stream_truncated" });
    if (!doneEvent.ok) {
      throw new PerchError(String(doneEvent.error || "Perch request failed"), {
        status: 502,
        code: doneEvent.errorCode || null,
        detail: { limit: doneEvent.limit || null },
      });
    }
    const finalText = typeof doneEvent.text === "string" && doneEvent.text ? doneEvent.text : text;
    commitThread(prepared, prepared.threadId, prepared.turn.userCount, modelName);
    pool.noteSuccess(account.id);
    return json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model: doneEvent.modelLabel || modelName,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: finalText,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: doneEvent.stopped ? "stop" : "stop",
        },
      ],
      usage: null,
      perch: {
        threadId: prepared.threadId,
        account: publicAccount(account),
        tier: doneEvent.tier || null,
        durationMs: doneEvent.durationMs || null,
        model: doneEvent.model || null,
        usage: doneEvent.usage || null,
        citations,
        artifact,
        notices: prepared.notice,
      },
    });
    } catch (err) {
      pool.noteError(account.id, err);
      throw err;
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
  const chunk = (delta, finish = null, extra = {}) =>
    send({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    });

  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    chunk({ role: "assistant", content: "" });
    for await (const ev of client.chat({ ...chatOpts, signal: controller.signal })) {
      if (ev.type === "answer_delta") {
        const t = String(ev.text || "");
        if (t) {
          text += t;
          chunk({ content: t });
        }
      } else if (ev.type === "reasoning_delta") {
        const t = String(ev.text || "");
        if (t) {
          reasoning += t;
          chunk({ reasoning_content: t });
        }
      } else if (ev.type === "citations") {
        citations = ev.citations || [];
      } else if (ev.type === "artifact") {
        artifact = ev.artifact || null;
      } else if (ev.type === "done") {
        doneEvent = ev;
        finished = true;
        if (!ev.ok) {
          chunk(
            { content: "" },
            "stop",
            { perch_error: { message: String(ev.error || "Perch request failed"), code: ev.errorCode || null, limit: ev.limit || null } },
          );
        } else {
          if (typeof ev.text === "string" && ev.text && ev.text !== text && ev.text.startsWith(text)) {
            chunk({ content: ev.text.slice(text.length) });
            text = ev.text;
          }
          chunk({ content: "" }, "stop", {
            perch: {
              threadId: prepared.threadId,
              account: publicAccount(account),
              tier: ev.tier || null,
              durationMs: ev.durationMs || null,
              model: ev.model || null,
              usage: ev.usage || null,
              citations,
              artifact,
              notices: prepared.notice,
            },
          });
        }
      }
    }
    if (!finished) chunk({ content: "" }, "stop", { perch_error: { message: "stream ended early", code: "stream_truncated" } });
    if (finished && doneEvent && doneEvent.ok) {
      commitThread(prepared, prepared.threadId, prepared.turn.userCount, modelName);
      pool.noteSuccess(account.id);
    }
  } catch (err) {
    pool.noteError(account.id, err);
    if (!res.writableEnded) {
      chunk({ content: "" }, "stop", { perch_error: { message: err.message, code: err.code || null } });
    }
  } finally {
    if (!res.writableEnded) res.end("data: [DONE]\n\n");
  }
}

async function handleConsoleChat(req, res, body) {
  const model = resolveModel(body.model);
  if (!model) return consoleJson(res, 400, { ok: false, error: "Unknown model: " + (body.model || "") });
  const message = String(body.message || "").trim();
  if (!message) return consoleJson(res, 400, { ok: false, error: "Empty message" });
  const pinned = String(body.accountId || "").trim() || null;
  let account;
  try {
    account = pinned ? pool.resolve({ accountId: pinned }) : pool.resolve({ stickyKey: "console" });
  } catch (err) {
    return consoleJson(res, err.status || 503, { ok: false, error: err.message, errorCode: err.code || null, detail: err.detail || null });
  }
  const client = accountClient(account);
  if (model.manualModelOptionId || ["pro", "pro_max"].includes(model.roostChoice)) {
    const data = await client.account();
    validateWebModelAccess(data.session, model);
  }

  let threadId = typeof body.threadId === "string" && body.threadId ? body.threadId : null;
  if (threadId) {
    const bound = readThreads()["console:" + threadId];
    if (bound?.accountId && bound.accountId !== account.id) threadId = null;
  }
  const cli = isCliModel(model.publicName);
  const transportChanged = Boolean(threadId && threadId.startsWith('cli-') !== cli);
  if (transportChanged) threadId = null;
  let created = false;
  if (!threadId) {
    const made = await client.createThread(model.publicName);
    threadId = made.thread && made.thread.id;
    if (!threadId) return consoleJson(res, 502, { ok: false, error: "Could not create thread" });
    created = true;
    const all = readThreads();
    all["console:" + threadId] = { threadId, accountId: account.id, model: model.publicName, updatedAt: Date.now() };
    writeThreads(all);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
  send({ type: "thread", threadId, created, transportChanged, transport: cli ? "official-cli" : "web", model: model.publicName, manualModelOptionId: model.manualModelOptionId || null, account: publicAccount(account) });

  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    for await (const ev of client.chat({
      threadId,
      message,
      webSearch: Boolean(body.webSearch),
      roostChoice: model.roostChoice || "standard",
      manualModelOptionId: model.manualModelOptionId || null,
      signal: controller.signal,
    })) {
      if (ev.type === "answer_delta") send({ type: "delta", text: String(ev.text || "") });
      else if (ev.type === "reasoning_delta") send({ type: "reasoning", text: String(ev.text || "") });
      else if (ev.type === "citations") send({ type: "citations", citations: ev.citations || [] });
      else if (ev.type === "status") send({ type: "status", phase: ev.phase || null, query: ev.query || null });
      else if (ev.type === "artifact") send({ type: "artifact", artifact: ev.artifact || null });
      else if (ev.type === "done")
        send({
          type: "done",
          ok: Boolean(ev.ok),
          error: ev.error || null,
          errorCode: ev.errorCode || null,
          limited: ev.limit || null,
          text: typeof ev.text === "string" ? ev.text : null,
          stopped: Boolean(ev.stopped),
          modelLabel: ev.modelLabel || null,
          model: ev.model || null,
          provider: ev.provider || null,
          transport: ev.transport || "web",
          usage: ev.usage || null,
          tier: ev.tier || null,
          durationMs: ev.durationMs || null,
          thinkingMs: ev.thinkingMs || null,
          citations: ev.citations || null,
          messageId: ev.messageId || null,
          account: publicAccount(account),
        });
      if (ev.type === "done" && ev.ok) pool.noteSuccess(account.id);
      else if (ev.type === "done" && !ev.ok) pool.noteError(account.id, { message: ev.error, code: ev.errorCode });
    }
  } catch (err) {
    pool.noteError(account.id, err);
    send({ type: "done", ok: false, error: err.message, errorCode: err.code || null });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

async function handleModelTest(req, res, body) {
  const model = resolveModel(body.model);
  if (!model) return consoleJson(res, 400, { ok: false, error: "Unknown model: " + (body.model || "") });
  const pinned = String(body.accountId || "").trim() || null;
  let account;
  try {
    account = pinned ? pool.resolve({ accountId: pinned }) : pool.resolve({ stickyKey: "console" });
  } catch (err) {
    return consoleJson(res, 200, { ok: false, model: model.publicName, error: err.message, errorCode: err.code || null, elapsedMs: 0 });
  }
  const client = accountClient(account);
  const started = Date.now();
  try {
    const made = await client.createThread(model.publicName);
    const threadId = made.thread && made.thread.id;
    let text = "";
    let done = null;
    for await (const ev of client.chat({
      threadId,
      message: "Reply with exactly: OK",
      roostChoice: model.roostChoice || "standard",
      manualModelOptionId: model.manualModelOptionId || null,
    })) {
      if (ev.type === "answer_delta") text += String(ev.text || "");
      if (ev.type === "done") done = ev;
    }
    if (!done) return consoleJson(res, 200, { ok: false, model: model.publicName, error: "stream ended early", elapsedMs: Date.now() - started });
    if (done.ok) pool.noteSuccess(account.id);
    else pool.noteError(account.id, { message: done.error, code: done.errorCode });
    return consoleJson(res, 200, {
      ok: Boolean(done.ok),
      model: model.publicName,
      error: done.error || null,
      errorCode: done.errorCode || null,
      text: (done.text || text || "").slice(0, 200),
      modelLabel: done.modelLabel || null,
      transport: done.transport || "web",
      modelId: done.model || null,
      provider: done.provider || null,
      usage: done.usage || null,
      tier: done.tier || null,
      durationMs: done.durationMs || null,
      elapsedMs: Date.now() - started,
      threadId,
      account: publicAccount(account),
    });
  } catch (err) {
    pool.noteError(account.id, err);
    return consoleJson(res, 200, {
      ok: false,
      model: model.publicName,
      error: err.message,
      errorCode: err.code || null,
      elapsedMs: Date.now() - started,
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (url.pathname === "/console" || url.pathname === "/console/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": CONSOLE_COOKIE + "=" + CONSOLE_TOKEN + "; HttpOnly; SameSite=Strict; Path=/",
      "Cache-Control": "no-store",
    });
    return res.end(fs.readFileSync(path.join(CONSOLE_DIR, "index.html")));
  }
  if (url.pathname.startsWith("/console/api/")) {
    if (!hasConsoleAuth(req)) return consoleJson(res, 401, { ok: false, error: "Reload /console to get a console session." });
    try {
      if (url.pathname === "/console/api/account") {
        const wanted = url.searchParams.get("accountId");
        const selected = (wanted && pool.get(wanted)) || pool.active();
        if (!selected) return consoleJson(res, 200, { ok: true, hasSession: false, pool: pool.summary() });
        const client = accountClient(selected);
        const account = await client.account();
        pool.saveIdentity(selected.id, {
          cookie: client.cookieHeader,
          email: account.profile?.email || null,
          planCode: account.session?.planCode || null,
        });
        return consoleJson(res, 200, {
          ...summarizeAccount(client, account),
          account: pool.summarize(pool.get(selected.id)),
          pool: pool.summary(),
        });
      }
      if (url.pathname === "/console/api/accounts") {
        if (req.method === "GET") return consoleJson(res, 200, { ok: true, ...pool.summary() });
        if (req.method === "POST") {
          const body = await readBody(req);
          const result = await pool.add({ cookie: body.cookie, label: body.label });
          return consoleJson(res, 200, { ok: true, added: result.account, ...pool.summary() });
        }
        if (req.method === "PATCH") {
          const body = await readBody(req);
          const updated = pool.update(body.id, { label: body.label, enabled: body.enabled });
          return consoleJson(res, 200, { ok: true, updated, ...pool.summary() });
        }
        if (req.method === "DELETE") {
          const body = await readBody(req).catch(() => ({}));
          const id = String(body.id || url.searchParams.get("id") || pool.active()?.id || "");
          if (!id) return consoleJson(res, 400, { ok: false, error: "没有可移除的账号" });
          const result = pool.remove(id);
          return consoleJson(res, 200, { ok: true, removed: id, ...result, ...pool.summary() });
        }
        return consoleJson(res, 405, { ok: false, error: "Method not allowed" });
      }
      if (url.pathname === "/console/api/accounts/select" && req.method === "POST") {
        const body = await readBody(req);
        const selected = pool.setActive(String(body.id || ""));
        return consoleJson(res, 200, { ok: true, selected, ...pool.summary() });
      }
      if (url.pathname === "/console/api/accounts/strategy" && req.method === "POST") {
        const body = await readBody(req);
        const strategy = pool.setStrategy(String(body.strategy || ""));
        return consoleJson(res, 200, { ok: true, strategy, ...pool.summary() });
      }
      if (url.pathname === "/console/api/accounts/test" && req.method === "POST") {
        const body = await readBody(req);
        const account = await pool.test(String(body.id || ""));
        return consoleJson(res, 200, { ok: true, account, ...pool.summary() });
      }
      if (url.pathname === "/console/api/accounts/refresh" && req.method === "POST") {
        const body = await readBody(req);
        const account = await pool.refresh(String(body.id || ""));
        return consoleJson(res, 200, { ok: true, account, ...pool.summary() });
      }
      if (url.pathname === "/console/api/session" && req.method === "POST") {
        const body = await readBody(req);
        const raw = String(body.cookie || "").trim();
        if (!raw) return consoleJson(res, 400, { ok: false, error: "Cookie 为空" });
        const result = await pool.add({ cookie: raw, label: body.label });
        const selected = pool.get(result.account.id);
        const candidate = accountClient(selected);
        const account = await candidate.account();
        return consoleJson(res, 200, {
          ...summarizeAccount(candidate, account),
          account: pool.summarize(pool.get(selected.id)),
          pool: pool.summary(),
        });
      }
      if (url.pathname === "/console/api/session" && req.method === "DELETE") {
        const body = await readBody(req).catch(() => ({}));
        const id = String(body.id || pool.active()?.id || "");
        if (id) pool.remove(id);
        return consoleJson(res, 200, { ok: true, hasSession: pool.count() > 0, pool: pool.summary() });
      }
      if (url.pathname === "/console/api/local-key") {
        return consoleJson(res, 200, { ok: true, apiKey: API_KEY });
      }
      if (url.pathname === "/console/api/models") {
        const starter = [...STARTER_DESKTOP_MODELS];
        return consoleJson(res, 200, {
          ok: true,
          models: listModels().map((m) => ({
            ...m,
            group: m.perch?.roostChoice ? "roost" : starter.includes(m.id) ? "starter" : "named",
            starterPool: starter.includes(m.id),
            transport: isCliModel(m.id) ? "official-cli" : "web",
            expired: m.id === "beam-1.0-starter" && Date.now() >= Date.parse("2026-10-23T18:00:00Z"),
          })),
        });
      }
      if (url.pathname === "/console/api/threads") {
        const wanted = url.searchParams.get("accountId");
        const selected = wanted ? pool.get(wanted) : pool.active();
        if (!selected) return consoleJson(res, 200, { ok: true, threads: [] });
        const client = accountClient(selected);
        const data = await client.threads();
        return consoleJson(res, 200, { ok: true, account: publicAccount(selected), threads: (data.threads || []).slice(0, 30) });
      }
      if (url.pathname === "/console/api/chat" && req.method === "POST") {
        return await handleConsoleChat(req, res, await readBody(req));
      }
      if (url.pathname === "/console/api/model-test" && req.method === "POST") {
        return await handleModelTest(req, res, await readBody(req));
      }
      if (url.pathname === "/console/api/stop" && req.method === "POST") {
        const body = await readBody(req);
        const selected = body.accountId ? pool.get(body.accountId) : pool.active();
        if (selected && body.threadId) await accountClient(selected).stop(body.threadId);
        return consoleJson(res, 200, { ok: true });
      }
      return consoleJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      return consoleJson(res, 200, { ok: false, error: err.message, errorCode: err.code || null });
    }
  }
  if (url.pathname === "/" ) {
    return json(res, 200, {
      ok: true,
      service: "perchai-openai-adapter",
      baseUrl: "http://" + HOST + ":" + PORT + "/v1",
      console: "http://" + HOST + ":" + PORT + "/console",
      session: pool.count() > 0,
      accounts: pool.count(),
    });
  }
  if (!url.pathname.startsWith("/v1/")) return openaiError(res, 404, "Not found");
  const auth = req.headers.authorization || "";
  if (auth !== "Bearer " + API_KEY) return openaiError(res, 401, "Invalid API key", "invalid_api_key");
  if (url.pathname === "/v1/models") {
    return json(res, 200, { object: "list", data: listModels() });
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    try {
      const body = await readBody(req);
      await handleChat(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        const status = err.status || 500;
        return openaiError(res, status, err.message, err.code || null, err.detail ? { detail: err.detail } : {});
      }
    }
    return;
  }
  return openaiError(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  const accounts = pool.count();
  console.log("Perch OpenAI adapter: http://" + HOST + ":" + PORT + "/v1");
  console.log("API key: " + API_KEY);
  console.log("Accounts: " + (accounts ? accounts + " in pool" : "missing (run npm run login or add via console)"));
});
