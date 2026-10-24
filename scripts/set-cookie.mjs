#!/usr/bin/env node
/**
 * Paste a cookie and identify the account.
 *
 *   pbpaste | npm run session
 *   npm run session -- --cookie 'sb-...-auth-token.0=...; ...'
 *
 * Accepts a full Cookie header, the sb-* chunk rows, or a bare base64- value.
 * Validates against /api/perchai/account before saving to data/state.json.
 */
import { PerchClient, decodeClaims, writeState } from "../src/perch.mjs";
import { AccountPool } from "../src/account-pool.mjs";

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const args = process.argv.slice(2);
let raw = args.includes("--cookie") ? args[args.indexOf("--cookie") + 1] : process.env.PERCHAI_COOKIE || "";
if (!raw) raw = await readStdin();
raw = String(raw || "").trim();

if (!raw) {
  console.error("用法: pbpaste | npm run session   或   npm run session -- --cookie '<cookie>'");
  process.exit(1);
}

const client = new PerchClient({ cookie: raw });
if (!client.session) {
  console.error("这段内容里没有可解析的 Supabase session。");
  console.error("需要 sb-zlfuvsfjtgsdtqcaykia-auth-token.0 / .1 两个 cookie，或 base64- 开头的值。");
  process.exit(1);
}

const claims = decodeClaims(client.session) || {};
console.log("session: 解出 access_token" + (claims.email ? " · " + claims.email : ""));

try {
  const account = await client.account();
  writeState({ cookie: client.cookieHeader });
  const pool = new AccountPool();
  const saved = await pool.add({ cookie: client.cookieHeader, label: account.profile?.email || claims.email });
  const s = account.session || {};
  const meter = account.usageMeter || {};
  console.log("");
  console.log("邮箱     " + (account.profile?.email || claims.email || "-"));
  console.log("名字     " + (account.profile?.name || "-"));
  console.log("套餐     " + (s.planName || "-") + " (" + (s.planCode || "?") + ")");
  console.log("角色     " + (s.membershipRole || "-"));
  console.log("手动选模型 " + ((s.planCode === "pro" || ["admin", "internal"].includes(s.membershipRole)) ? "允许" : "可能受限"));
  if (meter && Object.keys(meter).length) console.log("用量     " + JSON.stringify(meter));
  const exp = Number(client.session.expires_at || claims.exp || 0);
  if (exp) console.log("过期     还有 " + Math.max(0, Math.round((exp * 1000 - Date.now()) / 60000)) + " 分钟（会自动刷新）");
  console.log("");
  console.log("已加入号池：" + saved.account.label + "（共 " + pool.count() + " 个账号），现在可以直接 npm start / npm run probe。");
} catch (err) {
  console.error("识别失败: " + err.message + (err.code ? " (" + err.code + ")" : ""));
  process.exit(1);
}
