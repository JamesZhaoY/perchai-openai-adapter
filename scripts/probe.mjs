#!/usr/bin/env node
/**
 * Protocol smoke test: account -> thread -> one SSE turn.
 * Run after `npm run login`.
 */
import { PerchClient, resolveModel, PerchError } from "../src/perch.mjs";
import { AccountPool } from "../src/account-pool.mjs";

const args = process.argv.slice(2);
const modelArg = args.includes("--model") ? args[args.indexOf("--model") + 1] : "perch-auto";
const webSearch = args.includes("--web-search");
const prompt = args.includes("--prompt") ? args[args.indexOf("--prompt") + 1] : "Say OK and nothing else.";

const pool = new AccountPool();
const pooled = pool.active();
const client = pooled
  ? new PerchClient({ account: pooled, onRefresh: (cookie) => pool.updateCookie(pooled.id, cookie) })
  : new PerchClient();
if (!client.ready) {
  console.error("No stored session. Run npm run login first.");
  process.exit(1);
}
const model = resolveModel(modelArg);
if (!model) {
  console.error("Unknown model: " + modelArg);
  process.exit(1);
}

try {
  const account = await client.account();
  const s = account.session || {};
  console.log("account:", account.profile?.email || account.profile?.name || "unknown");
  console.log("plan:", s.planName || s.planCode, "| role:", s.membershipRole || "-", "| web model pick:", Boolean(s.entitlements));
  console.log("usageMeter:", JSON.stringify(account.usageMeter || null).slice(0, 300));

  const created = await client.createThread(model.publicName);
  const threadId = created.thread?.id;
  console.log("thread:", threadId);

  let text = "";
  for await (const ev of client.chat({
    threadId,
    message: prompt,
    webSearch,
    roostChoice: model.roostChoice || "standard",
    manualModelOptionId: model.manualModelOptionId || null,
  })) {
    if (ev.type === "answer_delta") {
      text += ev.text || "";
      process.stdout.write(ev.text || "");
    } else if (ev.type === "done") {
      console.log("\n--- done:", JSON.stringify({
        ok: ev.ok,
        error: ev.error,
        errorCode: ev.errorCode,
        modelLabel: ev.modelLabel,
        tier: ev.tier,
        durationMs: ev.durationMs,
        thinkingMs: ev.thinkingMs,
        citations: (ev.citations || []).length,
      }));
    } else {
      console.log("\n[" + ev.type + "]", JSON.stringify(ev).slice(0, 400));
    }
  }
} catch (e) {
  if (e instanceof PerchError) {
    console.error("PerchError:", e.status, e.code, e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
}
