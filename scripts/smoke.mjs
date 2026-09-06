#!/usr/bin/env node
// A7 — post-deploy smoke. Run against any environment; it asserts the safety
// invariants rather than merely that something answered.
//   node scripts/smoke.mjs https://api.games.dcsai.ai
//
// THE GATE IS "RESULT: PASS", NOT A CHECK COUNT. The count printed at the end
// grows whenever a new invariant is added; an older runbook that says "stop
// unless 8/8" is quoting a stale number, not a stricter rule. Read the word.
//
// What this script can and cannot see, stated up front so nobody over-reads a
// green run: it holds no credential, so it can only prove that private routes
// REFUSE. It cannot prove that a valid token is honoured — test/api-integration
// and test/smoke-gate cover that with minted tokens. The 401 assertions here
// are therefore paired with checks that require a 200 from the public surface
// (/health, both assert-dark routes, the plans route, moderation-history), so a
// server that had regressed to refusing *everything* fails this gate rather
// than passing it on the strength of its 401s.
const BASE = (process.argv[2] || process.env.DCS_API || "http://127.0.0.1:8080").replace(/\/$/, "");
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const get = (p, opts = {}) => fetch(BASE + p, opts).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));

check("service is healthy", async () => {
  const r = await get("/health");
  if (r.status !== 200) throw new Error(`health returned ${r.status}`);
  if (r.body.ok !== true) throw new Error(`health does not report ok:true (got ${JSON.stringify(r.body.ok)})`);
  // Reporting a field that may be undefined is how a check quietly stops
  // checking: "auth=undefined" reads like a value. Require them.
  for (const k of ["auth", "persistence"]) {
    if (!r.body[k]) throw new Error(`health does not name its ${k} — it must state what it is running on, not omit it`);
  }
  return `auth=${r.body.auth} store=${r.body.persistence} schema=v${r.body.schema_assertion?.version ?? "n/a"}`;
});

check("PAYMENTS_LIVE is false", async () => {
  const r = await get("/health");
  if (r.status !== 200) throw new Error(`health returned ${r.status} — cannot confirm the payment state`);
  if (r.body.payments_live !== false) throw new Error(`payments_live is ${JSON.stringify(r.body.payments_live)}, not false — real money may be reachable`);
  return "money dark";
});

check("the x-user-id impersonation path is gone", async () => {
  // The live exploit: a request carrying only x-user-id was served as that user.
  // A bare 401 does not distinguish "the header is ignored" from "this route
  // happens to need auth", so assert the server names the removed header, that
  // the forged id is nowhere in the response, and that /health still claims the
  // fallback is deleted.
  const r = await get("/api/worlds/mine", { headers: { "x-user-id": "victim-uuid" } });
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status} (${JSON.stringify(r.body).slice(0, 120)})`);
  if (JSON.stringify(r.body).includes("victim-uuid")) throw new Error("the forged x-user-id reached the response body");
  if (r.body.meta?.removed_header !== "x-user-id") throw new Error(`the refusal does not name the removed header (meta=${JSON.stringify(r.body.meta)})`);
  const h = await get("/health");
  if (h.body.auth_header_fallback_removed !== true) throw new Error(`/health reports auth_header_fallback_removed=${JSON.stringify(h.body.auth_header_fallback_removed)}`);
  return "401, names the removed header, health agrees";
});

check("an invalid token does not fall through to a header", async () => {
  const r = await get("/api/worlds/mine", { headers: { Authorization: "Bearer nope", "x-user-id": "victim-uuid" } });
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  if (r.body.ok !== false) throw new Error("a rejected credential did not return ok:false");
  if (r.body.error !== "invalid_token") throw new Error(`expected error=invalid_token, got ${JSON.stringify(r.body.error)}`);
  if (JSON.stringify(r.body).includes("victim-uuid")) throw new Error("the forged header still reached the response");
  return "401 invalid_token";
});

check("private routes refuse anonymous callers", async () => {
  // These must all still be PRIVATE. /api/me/revenue was in this list and is
  // not private any more — it is retired, and answers 410 to everyone; it now
  // has its own check below. A retired route asserted as 401 fails a correct
  // build and reads like an authentication hole, which is worse than no check.
  for (const p of ["/api/worlds/mine", "/me/profile", "/me/subscription", "/v3/marketplace/owned", "/v3/marketplace/ledger"]) {
    const r = await get(p);
    if (r.status !== 401) throw new Error(`${p} returned ${r.status}, expected 401`);
  }
  return "401 on all 5 private routes";
});

check("errors carry a correlation id", async () => {
  const r = await get("/api/worlds/mine");
  const header = r.headers.get("x-correlation-id");
  // Not "body OR header": the header is set on every response before routing,
  // so accepting either made this pass even if error bodies stopped carrying
  // the id. The id a user quotes out of a body has to be the one in the logs.
  if (!r.body.correlation_id) throw new Error("the error body carries no correlation_id");
  if (!header) throw new Error("the error response carries no X-Correlation-Id header");
  if (r.body.correlation_id !== header) throw new Error(`body correlation_id ${r.body.correlation_id} != header ${header}`);
  return r.body.correlation_id;
});

check("the retired revenue route stays retired", async () => {
  // Retired this sprint: it used to answer 200 with hard-coded zeros, which is
  // indistinguishable from a real measurement of zero. 410 is the invariant —
  // and it must report no figure and name what replaced it. (Same treatment
  // scripts/monitor-dark.mjs gives it against a running process.)
  const r = await get("/api/me/revenue");
  if (r.status !== 410) throw new Error(`/api/me/revenue answered ${r.status}, expected 410 — a retired route is serving again`);
  if ("total_minor" in r.body || "payouts" in r.body) throw new Error("the retired revenue route is reporting figures again");
  if (!r.body.replacement) throw new Error("the 410 does not name a replacement, so a caller is told 'no' with nowhere to go");
  return `410, no figure, points at ${r.body.replacement.split(" ")[0]}`;
});

check("the retired CW6 economy routes stay retired", async () => {
  // These derived the buyer from x-user-id — the impersonation path A1 removed.
  // If they come back, the removed header comes back with them.
  for (const p of ["/api/marketplace", "/api/me/payouts"]) {
    const r = await get(p);
    if (r.status !== 410) throw new Error(`${p} answered ${r.status}, expected 410`);
  }
  return "410 on both legacy economy routes";
});

check("the marketplace is dark in this running process", async () => {
  const r = await get("/v3/marketplace/assert-dark");
  if (r.status !== 200 || r.body.dark !== true) throw new Error(`assert-dark answered ${r.status}: ${JSON.stringify(r.body.problems ?? r.body)}`);
  return "no priced listing, paid acquisition or non-test ledger entry";
});

check("the subscription surface is dark in this running process", async () => {
  const r = await get("/v3/subscriptions/assert-dark");
  if (r.status !== 200 || r.body.dark !== true) throw new Error(`assert-dark answered ${r.status}: ${JSON.stringify(r.body.problems ?? r.body)}`);
  return "no price, no paid status, no grant outliving the internal window";
});

check("nothing can be bought", async () => {
  const r = await get("/v3/subscriptions/plans");
  if (r.status !== 200) throw new Error(`plans answered ${r.status}`);
  if (r.body.purchasable !== false) throw new Error(`plans report purchasable=${JSON.stringify(r.body.purchasable)}`);
  const plans = r.body.plans || [];
  const priced = plans.filter((p) => Number(p.price_minor || 0) !== 0);
  if (priced.length) throw new Error(`these plans carry a price: ${priced.map((p) => p.id).join(", ")}`);
  return `${plans.length} plan(s), none purchasable, none priced`;
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
console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} (${results.length - failed}/${results.length} checks) — promote only on PASS with every check green`);
process.exit(failed === 0 ? 0 : 1);
