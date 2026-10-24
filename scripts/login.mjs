#!/usr/bin/env node
/**
 * One-time interactive login.
 *
 * Launches a dedicated Chrome profile, opens chat.perchai.app and waits for you
 * to finish Google/GitHub sign-in. The Supabase session cookie is then saved to
 * data/state.json (0600) so the adapter can keep using that web session.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PerchClient, ORIGIN, writeState, COOKIE_BASE } from "../src/perch.mjs";
import { AccountPool } from "../src/account-pool.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PROFILE = path.join(ROOT, "data", "browser-profile");
const CHROME =
  process.env.PERCHAI_CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort() {
  const file = path.join(PROFILE, "DevToolsActivePort");
  for (let i = 0; i < 120; i += 1) {
    try {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const port = Number(lines[0]);
      if (port) return port;
    } catch {}
    await sleep(500);
  }
  throw new Error("Chrome did not expose a DevTools port");
}

function connect(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", (e) => reject(new Error("WebSocket error")));
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  return {
    ready,
    send(method, params = {}) {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close: () => ws.close(),
  };
}

async function collectCookie(port) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/list");
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && String(t.url).includes("perchai.app"));
  if (!page) return null;
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Network.enable");
  const { cookies } = await cdp.send("Network.getAllCookies");
  cdp.close();
  const mine = cookies.filter((c) => c.name === COOKIE_BASE || c.name.startsWith(COOKIE_BASE + "."));
  if (!mine.length) return null;
  mine.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const extra = cookies.filter((c) => c.name === "perch_lang");
  return [...mine, ...extra].map((c) => c.name + "=" + c.value).join("; ");
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error("Chrome not found at " + CHROME + "; set PERCHAI_CHROME to a Chrome/Chromium binary.");
    process.exit(1);
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(
    CHROME,
    [
      "--remote-debugging-port=0",
      "--user-data-dir=" + PROFILE,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      ORIGIN + "/",
    ],
    { stdio: "ignore", detached: false },
  );
  const port = await waitForPort();
  console.log("Chrome is open. Sign in to chat.perchai.app in that window (Google or GitHub).");
  const deadline = Date.now() + 10 * 60 * 1000;
  let cookie = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    cookie = await collectCookie(port).catch(() => null);
    if (cookie) {
      const client = new PerchClient({ cookie });
      try {
        const account = await client.account();
        if (account.ok && account.session) {
          writeState({ cookie });
          const pool = new AccountPool();
          await pool.add({ cookie, label: account.profile?.email });
          const s = account.session;
          console.log("Saved session for " + (account.profile?.email || "unknown user") + " (pool: " + pool.count() + " accounts)");
          console.log("Plan: " + (s.planName || s.planCode || "unknown") + " (" + (s.planCode || "?") + ")");
          console.log("Tier selection required: " + Boolean(account.session.tierSelectionRequired));
          child.kill();
          return;
        }
      } catch (e) {
        // session exists but is not fully provisioned yet; keep waiting
      }
    }
  }
  child.kill();
  console.error("Timed out waiting for a usable Perch session.");
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
