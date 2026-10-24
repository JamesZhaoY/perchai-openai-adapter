/**
 * Multi-account pool for Perch sessions.
 *
 * Stored locally in data/accounts.json (0600). Cookies are never returned by
 * the console API; only derived identity/status is exposed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  PerchClient,
  sessionFromCookies,
  decodeClaims,
  normalizeCookieInput,
  readState,
} from "./perch.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_PATH = process.env.PERCHAI_ACCOUNTS_PATH || path.join(ROOT, "data", "accounts.json");
const STRATEGIES = new Set(["round-robin", "least-recently-used"]);
const COOLDOWN_AUTH_MS = 5 * 60_000;
const COOLDOWN_RATE_MS = 60_000;

export class PoolError extends Error {
  constructor(message, { status = 400, code = "pool_error", detail = null } = {}) {
    super(message);
    this.name = "PoolError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function newId() {
  return "acc_" + crypto.randomBytes(6).toString("hex");
}

function identityOf(cookie) {
  const session = sessionFromCookies(cookie);
  if (!session) return null;
  const claims = decodeClaims(session);
  return {
    session,
    userId: session.user?.id || claims?.sub || null,
    email: session.user?.email || claims?.email || null,
    expiresAt: Number(session.expires_at || claims?.exp || 0) || null,
  };
}

function blankPool() {
  return { version: 1, activeId: null, strategy: "round-robin", rrIndex: 0, accounts: [], bindings: {} };
}

export class AccountPool {
  constructor({ file = DEFAULT_PATH } = {}) {
    this.file = file;
  }

  load() {
    let pool;
    try {
      pool = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      pool = this.#seed();
      this.save(pool);
      return pool;
    }
    if (!pool || typeof pool !== "object") pool = blankPool();
    pool.accounts = Array.isArray(pool.accounts) ? pool.accounts : [];
    pool.bindings = pool.bindings && typeof pool.bindings === "object" ? pool.bindings : {};
    if (!STRATEGIES.has(pool.strategy)) pool.strategy = "round-robin";
    if (pool.activeId && !pool.accounts.some((a) => a.id === pool.activeId)) pool.activeId = null;
    if (!pool.activeId && pool.accounts.length) pool.activeId = pool.accounts[0].id;
    return pool;
  }

  #seed() {
    const pool = blankPool();
    const cookie = normalizeCookieInput(process.env.PERCHAI_COOKIE || readState().cookie || "");
    if (!cookie) return pool;
    const identity = identityOf(cookie);
    if (!identity) return pool;
    const { session: _session, ...fields } = identity;
    pool.accounts.push({
      id: "default",
      label: "默认账号",
      cookie,
      enabled: true,
      addedAt: new Date().toISOString(),
      lastUsedAt: null,
      lastOkAt: null,
      lastError: null,
      cooldownUntil: 0,
      ...fields,
    });
    pool.activeId = "default";
    return pool;
  }

  save(pool) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(pool, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch {}
  }

  count() {
    return this.load().accounts.length;
  }

  get(id) {
    return this.load().accounts.find((a) => a.id === id) || null;
  }

  active({ create = false } = {}) {
    const pool = this.load();
    let account = pool.accounts.find((a) => a.id === pool.activeId) || pool.accounts[0] || null;
    if (!account && create) throw new PoolError("号池里还没有账号", { status: 401, code: "pool_empty" });
    return account;
  }

  setStrategy(strategy) {
    if (!STRATEGIES.has(strategy)) throw new PoolError("未知的分配策略", { code: "bad_strategy" });
    const pool = this.load();
    pool.strategy = strategy;
    this.save(pool);
    return pool.strategy;
  }

  setActive(id) {
    const pool = this.load();
    if (!pool.accounts.some((a) => a.id === id)) throw new PoolError("账号不存在", { status: 404, code: "account_not_found" });
    pool.activeId = id;
    this.save(pool);
    return this.summarize(pool.accounts.find((a) => a.id === id));
  }

  update(id, patch = {}) {
    const pool = this.load();
    const account = pool.accounts.find((a) => a.id === id);
    if (!account) throw new PoolError("账号不存在", { status: 404, code: "account_not_found" });
    if (typeof patch.label === "string" && patch.label.trim()) account.label = patch.label.trim().slice(0, 60);
    if (typeof patch.enabled === "boolean") account.enabled = patch.enabled;
    this.save(pool);
    return this.summarize(account);
  }

  remove(id) {
    const pool = this.load();
    const index = pool.accounts.findIndex((a) => a.id === id);
    if (index < 0) throw new PoolError("账号不存在", { status: 404, code: "account_not_found" });
    pool.accounts.splice(index, 1);
    for (const [key, value] of Object.entries(pool.bindings)) {
      if (value?.accountId === id) delete pool.bindings[key];
    }
    if (pool.activeId === id) pool.activeId = pool.accounts[0]?.id || null;
    this.save(pool);
    return { ok: true, remaining: pool.accounts.length };
  }

  /** Validate a pasted Cookie and add (or refresh) its account. */
  async add({ cookie, label } = {}) {
    const normalized = normalizeCookieInput(cookie || "");
    const identity = identityOf(normalized);
    if (!identity) throw new PoolError("没能从这段内容里解出 Supabase session。", { code: "invalid_cookie" });
    const { session: _session, ...fields } = identity;
    const client = new PerchClient({ cookie: normalized, onRefresh: () => {} });
    const account = await client.account().catch((error) => {
      throw new PoolError(error.message || "账号校验失败", { status: error.status || 401, code: error.code || "account_invalid" });
    });
    const finalCookie = client.cookieHeader || normalized;
    const pool = this.load();
    let entry = pool.accounts.find((a) => a.userId && a.userId === identity.userId) || null;
    const now = new Date().toISOString();
    if (entry) {
      entry.cookie = finalCookie;
      entry.email = identity.email || entry.email;
      entry.expiresAt = identity.expiresAt;
      entry.planCode = account.session?.planCode || entry.planCode || null;
      entry.enabled = true;
      entry.lastError = null;
      entry.cooldownUntil = 0;
      if (label && label.trim()) entry.label = label.trim().slice(0, 60);
    } else {
      entry = {
        id: newId(),
        label: (label && label.trim()) || identity.email || "账号 " + (pool.accounts.length + 1),
        cookie: finalCookie,
        enabled: true,
        addedAt: now,
        lastUsedAt: null,
        lastOkAt: null,
        lastError: null,
        cooldownUntil: 0,
        planCode: account.session?.planCode || null,
        ...fields,
      };
      pool.accounts.push(entry);
    }
    entry.userId = client.session?.user?.id || entry.userId;
    entry.email = client.session?.user?.email || entry.email;
    entry.expiresAt = Number(client.session?.expires_at || entry.expiresAt) || entry.expiresAt;
    pool.activeId = entry.id;
    this.save(pool);
    return { account: this.summarize(entry), refreshed: Boolean(entry.addedAt !== now) };
  }

  updateCookie(id, cookie) {
    const pool = this.load();
    const account = pool.accounts.find((a) => a.id === id);
    if (!account) return;
    const identity = identityOf(cookie);
    account.cookie = cookie;
    if (identity) {
      account.userId = identity.userId || account.userId;
      account.email = identity.email || account.email;
      account.expiresAt = identity.expiresAt || account.expiresAt;
      account.session = undefined;
    }
    this.save(pool);
  }

  /** Persist identity fields learned from a successful account probe. */
  saveIdentity(id, { cookie, email, planCode } = {}) {
    const pool = this.load();
    const account = pool.accounts.find((a) => a.id === id);
    if (!account) return;
    if (cookie) {
      account.cookie = cookie;
      const identity = identityOf(cookie);
      if (identity) {
        account.userId = identity.userId || account.userId;
        account.email = identity.email || account.email;
        account.expiresAt = identity.expiresAt || account.expiresAt;
      }
    }
    if (email) account.email = email;
    if (planCode) account.planCode = planCode;
    this.save(pool);
  }

  /** Refresh an account's Supabase token and re-read its plan. */
  async refresh(id) {
    const account = this.get(id);
    if (!account) throw new PoolError("账号不存在", { status: 404, code: "account_not_found" });
    const client = new PerchClient({
      account,
      onRefresh: (cookie) => this.updateCookie(id, cookie),
    });
    await client.ensureFresh();
    const data = await client.account();
    const pool = this.load();
    const entry = pool.accounts.find((a) => a.id === id);
    entry.cookie = client.cookieHeader;
    entry.planCode = data.session?.planCode || entry.planCode || null;
    entry.email = data.profile?.email || entry.email;
    this.save(pool);
    return this.summarize(entry);
  }

  /** Probe an account without inference: /api/perchai/account. */
  async test(id) {
    const account = this.get(id);
    if (!account) throw new PoolError("账号不存在", { status: 404, code: "account_not_found" });
    const client = new PerchClient({
      account,
      onRefresh: (cookie) => this.updateCookie(id, cookie),
    });
    const data = await client.account();
    const pool = this.load();
    const entry = pool.accounts.find((a) => a.id === id);
    entry.cookie = client.cookieHeader;
    entry.planCode = data.session?.planCode || entry.planCode || null;
    entry.email = data.profile?.email || entry.email;
    entry.lastOkAt = new Date().toISOString();
    entry.lastError = null;
    entry.cooldownUntil = 0;
    this.save(pool);
    return {
      ...this.summarize(entry),
      profile: { email: data.profile?.email || null, name: data.profile?.name || null },
      session: { planCode: data.session?.planCode || null, planName: data.session?.planName || null },
      usageMeter: data.usageMeter || null,
    };
  }

  /**
   * Pick an account for one request.
   * Priority: explicit pin > thread binding > sticky conversation > strategy.
   */
  resolve({ accountId = null, stickyKey = null, threadAccountId = null } = {}) {
    const pool = this.load();
    const now = Date.now();
    const available = (a) => a && a.enabled && (a.cooldownUntil || 0) <= now;
    const byId = (id) => pool.accounts.find((a) => a.id === id) || null;

    if (accountId) {
      const pinned = byId(accountId);
      if (!pinned) throw new PoolError("指定账号不存在", { status: 404, code: "account_not_found" });
      if (!pinned.enabled) throw new PoolError("指定账号已停用", { status: 409, code: "account_disabled" });
      const cooling = (pinned.cooldownUntil || 0) - now;
      if (cooling > 0) throw new PoolError("指定账号正在冷却", { status: 429, code: "account_cooldown", detail: { retryAfterSec: Math.ceil(cooling / 1000) } });
      return this.#use(pool, pinned, stickyKey);
    }
    if (threadAccountId) {
      const bound = byId(threadAccountId);
      if (available(bound)) return this.#use(pool, bound, stickyKey);
    }
    if (stickyKey && pool.bindings[stickyKey]) {
      const bound = byId(pool.bindings[stickyKey].accountId);
      if (available(bound)) return this.#use(pool, bound, stickyKey);
    }
    const candidates = pool.accounts.filter(available);
    if (!candidates.length) {
      const retryAt = Math.min(...pool.accounts.map((a) => a.cooldownUntil || Infinity));
      throw new PoolError(
        pool.accounts.length ? "号池里没有可用账号（冷却中或已停用）" : "号池里还没有账号",
        { status: 503, code: "no_available_account", detail: { retryAfterSec: Number.isFinite(retryAt) ? Math.max(1, Math.ceil((retryAt - now) / 1000)) : null } },
      );
    }
    let chosen;
    if (pool.strategy === "least-recently-used") {
      chosen = [...candidates].sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0))[0];
    } else {
      const start = Number(pool.rrIndex || 0) % pool.accounts.length;
      for (let i = 0; i < pool.accounts.length; i += 1) {
        const candidate = pool.accounts[(start + i) % pool.accounts.length];
        if (available(candidate)) { chosen = candidate; break; }
      }
      pool.rrIndex = ((pool.accounts.indexOf(chosen) + 1) % pool.accounts.length) || 0;
    }
    return this.#use(pool, chosen, stickyKey);
  }

  #use(pool, account, stickyKey) {
    account.lastUsedAt = Date.now();
    if (stickyKey) {
      pool.bindings[stickyKey] = { accountId: account.id, updatedAt: Date.now() };
      const keys = Object.keys(pool.bindings);
      if (keys.length > 500) {
        for (const key of keys.sort((a, b) => pool.bindings[a].updatedAt - pool.bindings[b].updatedAt).slice(0, keys.length - 500)) {
          delete pool.bindings[key];
        }
      }
    }
    this.save(pool);
    return account;
  }

  noteSuccess(id) {
    const pool = this.load();
    const account = pool.accounts.find((a) => a.id === id);
    if (!account) return;
    account.lastOkAt = Date.now();
    account.lastError = null;
    account.cooldownUntil = 0;
    this.save(pool);
  }

  noteError(id, error) {
    const pool = this.load();
    const account = pool.accounts.find((a) => a.id === id);
    if (!account) return;
    const status = Number(error?.status || 0);
    account.lastError = String(error?.message || error || "request failed").slice(0, 300);
    if (status === 401 || status === 403) account.cooldownUntil = Date.now() + COOLDOWN_AUTH_MS;
    else if (status === 429 || error?.code === "turn_rate_limited" || error?.code === "usage_limit_reached") {
      account.cooldownUntil = Date.now() + COOLDOWN_RATE_MS;
    }
    this.save(pool);
  }

  summarize(account) {
    if (!account) return null;
    const now = Date.now();
    const expiresAt = Number(account.expiresAt || 0) || null;
    return {
      id: account.id,
      label: account.label || account.email || account.id,
      email: account.email || null,
      userId: account.userId || null,
      planCode: account.planCode || null,
      enabled: account.enabled !== false,
      addedAt: account.addedAt || null,
      lastUsedAt: account.lastUsedAt || null,
      lastOkAt: account.lastOkAt || null,
      lastError: account.lastError || null,
      cooldownUntil: account.cooldownUntil || 0,
      cooldownSec: Math.max(0, Math.ceil(((account.cooldownUntil || 0) - now) / 1000)),
      expiresAt,
      expiresInSec: expiresAt ? Math.max(0, expiresAt - Math.floor(now / 1000)) : null,
    };
  }

  summary() {
    const pool = this.load();
    return {
      strategy: pool.strategy,
      activeId: pool.activeId,
      count: pool.accounts.length,
      accounts: pool.accounts.map((a) => this.summarize(a)),
    };
  }
}
