import fs from "node:fs";

const origin = process.env.E2E_ORIGIN || "http://127.0.0.1:18791";
const key = process.env.E2E_KEY || JSON.parse(fs.readFileSync(new URL("../data/state.json", import.meta.url), "utf8")).apiKey;
const auth = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
const mode = process.argv[2] || "stream";
const model = process.argv[3] || "glm-5.3-flash-starter";

const health = await fetch(origin + "/healthz");
if (!health.ok) throw new Error("adapter not healthy: " + health.status);

const reportPath = new URL("../reports/cli-protocol-live-test.json", import.meta.url);
let report = {};
try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); } catch {}
report.at = new Date().toISOString();
report.runtime = "direct cli protocol";
report.results = report.results || {};

const result = { mode, model, ok: false };
try {
  if (mode === "stream" || mode === "nonstream") {
    const stream = mode === "stream";
    const started = Date.now();
    const res = await fetch(origin + "/v1/chat/completions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        model,
        stream,
        user: "e2e-live-" + Date.now(),
        messages: [{ role: "user", content: "Reply with exactly: E2E-OK" }],
      }),
    });
    const raw = await res.text();
    Object.assign(result, { status: res.status, wallMs: Date.now() - started });
    if (!res.ok) {
      result.error = raw.slice(0, 600);
    } else if (stream) {
      const chunks = raw.split("\n\n").filter((b) => b.startsWith("data: ") && b !== "data: [DONE]")
        .map((b) => JSON.parse(b.slice(6)));
      result.text = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
      result.reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content || "").join("");
      result.perch = chunks.find((c) => c.perch)?.perch || null;
      result.error = chunks.find((c) => c.perch_error)?.perch_error || null;
      result.ok = result.text.trim() === "E2E-OK" && !result.error;
    } else {
      const body = JSON.parse(raw);
      result.text = body.choices?.[0]?.message?.content || "";
      result.reasoning = body.choices?.[0]?.message?.reasoning_content || "";
      result.modelReported = body.model;
      result.perch = body.perch || null;
      result.error = body.error || null;
      result.ok = result.text.trim() === "E2E-OK";
    }
  } else if (mode === "console") {
    const page = await fetch(origin + "/console");
    const cookie = page.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    await page.body.cancel();
    const started = Date.now();
    const res = await fetch(origin + "/console/api/model-test", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const body = await res.json();
    Object.assign(result, { status: res.status, wallMs: Date.now() - started, ...body });
  } else {
    throw new Error("unknown mode " + mode);
  }
} catch (error) {
  result.error = error.message;
}

report.results[mode] = result;
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
