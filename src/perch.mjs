import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CliProtocol } from "./cli-protocol.mjs";

export const ORIGIN = "https://chat.perchai.app";
export const SUPABASE_URL = "https://zlfuvsfjtgsdtqcaykia.supabase.co";
export const SUPABASE_KEY = "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO";
export const COOKIE_BASE = "sb-zlfuvsfjtgsdtqcaykia-auth-token";
export const BASE_URL = process.env.PERCHAI_ORIGIN || ORIGIN;

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DATA_DIR = path.join(ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const MODEL_OPTIONS_PATH = path.join(DATA_DIR, "model-options.json");

export class PerchError extends Error {
  constructor(message, { status = 0, code = null, detail = null } = {}) {
    super(message);
    this.name = "PerchError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// Mirrors the shipped Web client's plan-first permission check.
export function webModelAccess(session = {}) {
  const starter = ["pilot", "demo", "starter"].includes(session.planCode);
  const canPin = !starter && (["internal", "admin"].includes(session.membershipRole) ||
    ["pro", "internal"].includes(session.planCode) ||
    (session.entitlements || []).some(e => e.key === "models.manual_select" && e.value_json?.enabled === true));
  return { starter, canPin };
}

export function validateWebModelAccess(session, { manualModelOptionId, roostChoice } = {}) {
  const access = webModelAccess(session);
  if (access.starter && manualModelOptionId) {
    const desktopIncluded = loadModelOptions().some(m => STARTER_DESKTOP_MODELS.has(m.name) && m.optionId === manualModelOptionId);
    if (desktopIncluded) {
      if (manualModelOptionId === resolveModel('beam-1.0-starter')?.manualModelOptionId && Date.now() >= Date.parse('2026-10-23T18:00:00Z')) {
        throw new PerchError("Beam Starter 限时体验已结束，当前不能使用。", { status: 403, code: "model_trial_expired" });
      }
      return;
    }
    throw new PerchError("这个具名模型属于升级组，当前 Starter（Pilot）套餐不包含它。", { status: 403, code: "model_upgrade_required" });
  }
  if (manualModelOptionId && !access.canPin) {
    throw new PerchError("当前套餐不支持在 Web 中锁定具名模型。请选择 perch-auto，或使用具有 Web 手动选模权限的账号；本次未发送模型请求。", { status: 403, code: "web_manual_model_unavailable" });
  }
  if (access.starter && ["pro", "pro_max"].includes(roostChoice)) {
    throw new PerchError("当前账号为 Starter（Pilot），没有 Pro 档位权限。", { status: 403, code: "pro_tier_unavailable" });
  }
}

// Public free-model map in the inspected 2026-10-24 client bundle.
// Desktop entitlement and availability through this Web adapter are separate.
export const STARTER_DESKTOP_MODELS = new Set([
  "laguna-s", "deepseek-flash-starter", "glm-5.3-flash-starter",
  "minimax-m3.1-flash-starter", "beam-1.0-starter",
]);

// Model ids the CLI protocol reports back in `done.model`. The adapter fails
// the turn when the upstream reports a different model than the one requested.
export const CLI_MODEL_IDS = {
  "laguna-s": "poolside/laguna-s-2.1",
  "deepseek-flash-starter": "deepseek/deepseek-v4.1-flash-1017",
  "glm-5.3-flash-starter": "z-ai/glm-5.3-flash",
  "minimax-m3.1-flash-starter": "minimax/minimax-m3.1-flash",
};

const CLI_HISTORY_DIR = process.env.PERCHAI_CLI_HISTORY_DIR || path.join(DATA_DIR, "cli-history");
const cliActiveTurns = new Set();

function cliHistoryPath(session, threadId) {
  const key = crypto.createHash("sha256").update(session.user.id + ":" + threadId).digest("hex");
  return { key, file: path.join(CLI_HISTORY_DIR, key + ".json") };
}

function readCliHistory(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new PerchError("无法读取此对话的 CLI 历史。", { status: 500, code: "history_read_failed" });
  }
}

function writeCliHistory(file, turns) {
  fs.mkdirSync(CLI_HISTORY_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(turns), { mode: 0o600 });
}

/** Split the legacy CLI prompt into the two wire messages the protocol expects. */
function cliMessages(history, message) {
  const turns = [...history, { role: "user", content: message }];
  const prompt = "Answer the final user message. Do not use tools.\n" +
    (history.length ? "Conversation (JSON):\n" + JSON.stringify(turns) : message);
  if (prompt.length > 64000) {
    throw new PerchError("当前 CLI 对话上下文过长，请新建对话。", { status: 400, code: "context_too_long" });
  }
  return {
    turns,
    messages: [
      { role: "system", content: "Answer the final user message. Do not use tools." },
      { role: "user", content: history.length ? "Conversation (JSON):\n" + JSON.stringify(turns) : message },
    ],
  };
}

export function isCliModel(name) { return STARTER_DESKTOP_MODELS.has(name); }

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeState(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next = { ...readState(), ...patch };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function loadModelOptions() {
  try {
    return JSON.parse(fs.readFileSync(MODEL_OPTIONS_PATH, "utf8"));
  } catch {
    return [];
  }
}

/** Split a raw Cookie header into name/value pairs. */
export function parseCookieHeader(header) {
  const out = [];
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

/**
 * Accept any of these shapes:
 *   - full Cookie header: "sb-...-auth-token.0=...; sb-...-auth-token.1=..."
 *   - just the cookie value: "base64-eyJ..."
 *   - DevTools rows pasted line by line
 */
export function normalizeCookieInput(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\r/g, "").split("\n").map((s) => s.trim()).filter(Boolean).join("; ");
  if (/^sb-[a-z0-9]+-auth-token(\.\d+)?\s*=/i.test(text)) return text;
  if (text.startsWith("base64-") || text.startsWith("eyJ")) return COOKIE_BASE + "=" + text;
  return text;
}

/** Best-effort claims from the Supabase access token (no signature check). */
export function decodeClaims(session) {
  if (!session || !session.access_token) return null;
  const part = String(session.access_token).split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Supabase SSR stores the auth session as a cookie:
 *   value = "base64-" + base64url(JSON session), chunked at 3180 chars when long.
 */
export function sessionFromCookies(header) {
  const pairs = parseCookieHeader(header);
  const exact = pairs.find(([n]) => n === COOKIE_BASE);
  if (exact) return decodeSession(exact[1]);
  const chunks = pairs
    .map(([n, v]) => {
      const m = n.match(new RegExp("^" + COOKIE_BASE + "[.]([0-9]+)$"));
      return m ? { i: Number(m[1]), v } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.i - b.i);
  if (!chunks.length) return null;
  return decodeSession(chunks.map((c) => c.v).join(""));
}

function decodeSession(raw) {
  let text = String(raw);
  try {
    text = decodeURIComponent(text);
  } catch {}
  if (text.startsWith("base64-")) {
    text = Buffer.from(text.slice("base64-".length), "base64url").toString("utf8");
  }
  try {
    const session = JSON.parse(text);
    return session && session.access_token ? session : null;
  } catch {
    return null;
  }
}

export function cookieHeaderFromSession(session, extra = {}) {
  const encoded = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const parts = [];
  const limit = 3180;
  if (encoded.length <= limit) {
    parts.push(COOKIE_BASE + "=" + encoded);
  } else {
    for (let i = 0, n = 0; i < encoded.length; i += limit, n += 1) {
      parts.push(COOKIE_BASE + "." + n + "=" + encoded.slice(i, i + limit));
    }
  }
  for (const [k, v] of Object.entries(extra)) parts.push(k + "=" + v);
  return parts.join("; ");
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("base64url");
}

async function supabaseRefresh(refreshToken) {
  const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new PerchError(
      "Supabase session refresh failed: " + (data.msg || data.error_description || data.error || res.status),
      { status: res.status, code: data.error_code || data.error || null },
    );
  }
  return data;
}

export class PerchClient {
  constructor({ cookie, account = null, onRefresh = null } = {}) {
    const state = readState();
    this.extraCookies = {};
    const raw = normalizeCookieInput(cookie || account?.cookie || process.env.PERCHAI_COOKIE || state.cookie || "");
    this.cookieHeader = raw;
    this.session = sessionFromCookies(raw);
    this.refreshing = null;
    this.accountId = account?.id || null;
    this.onRefresh = onRefresh;
  }

  get ready() {
    return Boolean(this.cookieHeader);
  }

  requireSession() {
    if (!this.cookieHeader) {
      throw new PerchError(
        "No Perch session. Run npm run login once, or set PERCHAI_COOKIE to your chat.perchai.app cookie header.",
        { status: 401, code: "no_session" },
      );
    }
  }

  ensureFresh() {
    const s = this.session;
    if (!s || !s.refresh_token) return Promise.resolve();
    const expiresAt = Number(s.expires_at || 0);
    if (expiresAt && expiresAt - Math.floor(Date.now() / 1000) > 120) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = supabaseRefresh(s.refresh_token)
        .then((data) => {
          this.session = { ...s, ...data, user: data.user || s.user };
          this.cookieHeader = cookieHeaderFromSession(this.session, this.extraCookies);
          if (this.onRefresh) this.onRefresh(this.cookieHeader, this.session);
          else writeState({ cookie: this.cookieHeader });
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  async request(pathname, { method = "GET", headers = {}, body, retry = true, signal } = {}) {
    this.requireSession();
    await this.ensureFresh();
    const res = await fetch(BASE_URL + pathname, {
      method,
      signal,
      headers: {
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: this.cookieHeader,
        Origin: ORIGIN,
        Referer: ORIGIN + "/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
        ...headers,
      },
      body,
    });
    if (res.status === 401 && retry && this.session && this.session.refresh_token) {
      this.session = { ...this.session, expires_at: 0 };
      try {
        await this.ensureFresh();
      } catch {
        return res;
      }
      return this.request(pathname, { method, headers, body, retry: false, signal });
    }
    return res;
  }

  async json(pathname, opts) {
    const res = await this.request(pathname, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new PerchError(data.error || "Perch request failed (" + res.status + ")", {
        status: res.status,
        code: data.errorCode || data.error || null,
        detail: data,
      });
    }
    return data;
  }

  account() {
    return this.json("/api/perchai/account");
  }

  threads() {
    return this.json("/api/perchai/threads");
  }

  createThread(modelName) {
    if (isCliModel(modelName)) return Promise.resolve({ ok: true, thread: { id: 'cli-' + crypto.randomUUID() } });
    return this.json("/api/perchai/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  }

  async stop(threadId) {
    if (threadId?.startsWith('cli-')) return { ok: true };
    const res = await this.request("/api/perchai/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId }),
    });
    return res.json().catch(() => ({}));
  }

  /**
   * Send one turn and yield parsed SSE events:
   * citations | reasoning_delta | status | artifact | answer_delta | done
   */
  async *chat(opts = {}) {
    const {
      threadId,
      message,
      webSearch = false,
      roostChoice = "standard",
      manualModelOptionId = null,
      promoOverflowAccepted = false,
      temperature = 0.6,
      maxTokens = 32000,
      signal,
    } = opts;
    if (manualModelOptionId || ["pro", "pro_max"].includes(roostChoice)) {
      const account = await this.account();
      validateWebModelAccess(account.session, { manualModelOptionId, roostChoice });
    }
    const cliModel = loadModelOptions().find(m => m.optionId === manualModelOptionId && isCliModel(m.name));
    if (cliModel) {
      if (webSearch) throw new PerchError('当前 CLI 模型通道不支持 Web Search，请关闭后重试。', { status: 400, code: 'cli_web_search_unsupported' });
      await this.ensureFresh();
      yield { type: 'status', phase: 'cli_running' };
      if (!this.session?.user?.id) throw new PerchError('请重新导入 Cookie。', { status: 401, code: 'not_authenticated' });
      const { key, file } = cliHistoryPath(this.session, threadId);
      if (cliActiveTurns.has(key)) throw new PerchError('这个对话仍在响应，请等本轮完成。', { status: 409, code: 'thread_busy' });
      cliActiveTurns.add(key);
      try {
        const history = readCliHistory(file);
        const prepared = cliMessages(history, message);
        const protocol = new CliProtocol({ origin: BASE_URL, session: this.session });
        let text = '';
        let reasoning = '';
        let doneEvent = null;
        let runId = null;
        for await (const ev of protocol.stream({
          optionId: cliModel.optionId,
          messages: prepared.messages,
          temperature,
          maxTokens,
          signal,
        })) {
          if (ev.type === 'answer_delta' && typeof ev.text === 'string') {
            text += ev.text;
            yield { type: 'answer_delta', text: ev.text };
          } else if (ev.type === 'reasoning_delta' && typeof ev.text === 'string') {
            reasoning += ev.text;
            yield { type: 'reasoning_delta', text: ev.text };
          } else if (ev.type === 'stream_restart') {
            text = '';
            reasoning = '';
            yield { type: 'status', phase: 'stream_restart' };
          } else if (ev.type === 'retrying') {
            yield { type: 'status', phase: 'retrying' };
          } else if (ev.type === 'error') {
            throw new PerchError(String(ev.message || 'Perch model call failed'), { status: 502, code: 'api_error' });
          } else if (ev.type === 'done') {
            doneEvent = ev;
            runId = ev.runId || runId;
          }
        }
        if (!doneEvent) throw new PerchError('Perch CLI 流提前结束。', { status: 502, code: 'stream_truncated' });
        if (doneEvent.ok === false) {
          throw new PerchError(String(doneEvent.error || 'Perch request failed'), {
            status: 502,
            code: doneEvent.errorCode || 'api_error',
            detail: { limit: doneEvent.limit || null },
          });
        }
        const finalText = typeof doneEvent.text === 'string' && doneEvent.text ? doneEvent.text : text;
        if (!finalText) throw new PerchError('CLI 返回空内容。', { status: 502, code: 'cli_empty_response' });
        const expected = CLI_MODEL_IDS[cliModel.name];
        if (expected && doneEvent.model && doneEvent.model !== expected) {
          throw new PerchError('上游返回的模型与所选模型不一致，本轮不视为成功。', {
            status: 502, code: 'model_identity_unverified',
            detail: { requested: expected, reported: doneEvent.model },
          });
        }
        if (finalText !== text && finalText.startsWith(text)) {
          yield { type: 'answer_delta', text: finalText.slice(text.length) };
        }
        writeCliHistory(file, [...prepared.turns, { role: 'assistant', content: finalText }]);
        yield {
          type: 'done', ok: true, text: finalText,
          model: doneEvent.model || expected || cliModel.optionId,
          modelLabel: doneEvent.model || cliModel.name,
          provider: doneEvent.provider || 'perch',
          usage: doneEvent.usage || null,
          contextFillTokens: doneEvent.contextFillTokens ?? doneEvent.contextInputTokens ?? null,
          durationMs: doneEvent.durationMs ?? null,
          runId: runId || protocol.lastRunId || null,
          transport: 'official-cli',
          transportDetail: 'cli-protocol',
          tier: 'starter',
          requestedModel: cliModel.name,
          ...(reasoning ? { reasoning } : {}),
        };
      } finally {
        cliActiveTurns.delete(key);
      }
      return;
    }
    const res = await this.request("/api/perchai/chat", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        message,
        clientMessageId: randomId(9),
        threadId,
        webSearch: Boolean(webSearch),
        roostChoice,
        manualModelOptionId: manualModelOptionId || null,
        promoOverflowAccepted: Boolean(promoOverflowAccepted),
      }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new PerchError(data.error || "Perch chat failed (" + res.status + ")", {
        status: res.status,
        code: data.errorCode || data.error || null,
        detail: data,
      });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload);
          } catch {}
        }
      }
    }
  }
}

export function resolveModel(model) {
  const name = String(model || "perch-auto").trim();
  const lower = name.toLowerCase().replace(/[\s_]+/g, "-");
  const tiers = {
    "perch-auto": ["standard", "perch-auto"],
    "perch-auto-1m": ["standard_max", "perch-auto-1m"],
    "perch-pro": ["pro", "perch-pro"],
    "perch-pro-1m": ["pro_max", "perch-pro-1m"],
    standard: ["standard", "perch-auto"],
    "standard-1m": ["standard_max", "perch-auto-1m"],
    "standard-max": ["standard_max", "perch-auto-1m"],
    pro: ["pro", "perch-pro"],
    "pro-1m": ["pro_max", "perch-pro-1m"],
    "pro-max": ["pro_max", "perch-pro-1m"],
    max: ["pro_max", "perch-pro-1m"],
    "1m": ["pro_max", "perch-pro-1m"],
    roost: ["standard", "perch-auto"],
    auto: ["standard", "perch-auto"],
  };
  if (tiers[lower]) {
    return { kind: "roost", roostChoice: tiers[lower][0], publicName: tiers[lower][1] };
  }
  const hit = loadModelOptions().find((m) => m.name.toLowerCase() === lower || m.optionId === name);
  if (hit) return { kind: "manual", manualModelOptionId: hit.optionId, publicName: hit.name };
  return null;
}

export function listModels() {
  const manual = loadModelOptions().map((m) => ({
    id: m.name,
    object: "model",
    owned_by: "perch-ai",
    perch: { manualModelOptionId: m.optionId },
  }));
  return [
    { id: "perch-auto", object: "model", owned_by: "perch-ai", perch: { roostChoice: "standard" } },
    { id: "perch-auto-1m", object: "model", owned_by: "perch-ai", perch: { roostChoice: "standard_max" } },
    { id: "perch-pro", object: "model", owned_by: "perch-ai", perch: { roostChoice: "pro" } },
    { id: "perch-pro-1m", object: "model", owned_by: "perch-ai", perch: { roostChoice: "pro_max" } },
    ...manual,
  ];
}
