#!/usr/bin/env node
// A7 — post-deploy smoke. Run against any environment; it asserts the safety
// invariants rather than merely that something answered.
//   node scripts/smoke.mjs https://api.games.dcsai.ai
const BASE = (process.argv[2] || process.env.DCS_API || "http://127.0.0.1:8080").replace(/\/$/, "");
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const get = (p, opts = {}) => fetch(BASE + p, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));

check("service is healthy", async () => {
  const r = await get("/health");
  if (r.status !== 200) throw new Error(`health returned ${r.status}`);
  return `auth=${r.body.auth} store=${r.body.persistence} schema=v${r.body.schema_assertion?.version ?? "n/a"}`;
});

check("PAYMENTS_LIVE is false", async () => {
  const r = await get("/health");
  if (r.body.payments_live !== false) throw new Error("payments_live is not false — real money may be reachable");
  return "money dark";
});

check("the x-user-id impersonation path is gone", async () => {
  const r = await get("/api/worlds/mine", { headers: { "x-user-id": "victim-uuid" } });
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status} (${JSON.stringify(r.body).slice(0, 120)})`);
  return "401";
});

check("an invalid token does not fall through to a header", async () => {
  const r = await get("/api/worlds/mine", { headers: { Authorization: "Bearer nope", "x-user-id": "victim-uuid" } });
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  if (JSON.stringify(r.body).includes("victim-uuid")) throw new Error("the forged header still reached the response");
  return "401";
});

check("private routes refuse anonymous callers", async () => {
  for (const p of ["/api/worlds/mine", "/api/me/revenue"]) {
    const r = await get(p);
    if (r.status !== 401) throw new Error(`${p} returned ${r.status}, expected 401`);
  }
  return "401 on all private routes";
});

check("errors carry a correlation id", async () => {
  const r = await get("/api/worlds/mine");
  if (!r.body.correlation_id && !r.headers.get("x-correlation-id")) throw new Error("no correlation id on an error response");
  return r.body.correlation_id || r.headers.get("x-correlation-id");
});

check("the safety surface is present", async () => {
  const r = await get("/health");
  const s = r.body.safety;
  if (!s) throw new Error("health does not report the safety surface");
  if (s.minor_onboarding_enabled !== false) throw new Error("minor onboarding is enabled — it must stay disabled");
  if (s.automated_content_moderation !== false) throw new Error("health claims automated moderation that does not exist");
  return "age gating + report/block + consent, minors disabled";
});

check("moderation history is honest", async () => {
  const r = await get("/safety/moderation-history");
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
  if (r.body.automated_moderation !== false) throw new Error("the API claims automated moderation");
  return `${r.body.count} recorded human decision(s)`;
});

const results = [];
for (const c of checks) {
  try { results.push({ name: c.name, ok: true, detail: await c.fn() }); }
  catch (e) { results.push({ name: c.name, ok: false, detail: e.message }); }
}
console.log(`smoke: ${BASE}\n`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}\n        ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} (${results.length - failed}/${results.length})`);
process.exit(failed === 0 ? 0 : 1);
