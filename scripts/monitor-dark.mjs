#!/usr/bin/env node
// Poll a RUNNING DCS Games server and prove money is still dark.
//
// verify-release.mjs proves it about the source tree and the local data store.
// This proves it about a process that is actually serving traffic — which is a
// different question, because a running server has a database, an environment,
// and rows that arrived after the build was cut. A migration, a manual edit or
// an import can put a priced row in a table long after a green release gate.
//
// Exit codes:  0 dark   1 NOT dark (alarm)   2 could not tell (also an alarm)
//
// "Could not tell" is deliberately not success. A monitor that reports OK when
// it cannot reach the thing it monitors is worse than no monitor, because it
// converts an outage into a green light.
//
//   node scripts/monitor-dark.mjs --base http://127.0.0.1:8787
//   node scripts/monitor-dark.mjs --base https://api.example.com --json
import process from "node:process";

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : (argv.includes("--" + n) ? true : d);
};
const BASE = String(flag("base", process.env.DCS_MONITOR_BASE || "http://127.0.0.1:8787")).replace(/\/$/, "");
const AS_JSON = !!flag("json", false);
const TIMEOUT_MS = Number(flag("timeout", 15000));

const findings = [];
const fail = (check, detail) => findings.push({ check, ok: false, detail });
const pass = (check, detail) => findings.push({ check, ok: true, detail });
let unreachable = false;

async function get(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
}

/** A check that cannot reach its target reports "unknown", never "ok". */
async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail);
  } catch (e) {
    if (e?.name === "TimeoutError" || /fetch failed|ECONNREFUSED|ENOTFOUND/.test(String(e?.message || e))) {
      unreachable = true;
      fail(name, `could not reach ${BASE}: ${e?.message || e}`);
    } else {
      fail(name, String(e?.message || e));
    }
  }
}

await check("the server is reachable and reports its payment state", async () => {
  const { status, body } = await get("/health");
  if (status !== 200) throw new Error(`/health answered ${status}`);
  if (body?.payments_live !== false) throw new Error(`/health reports payments_live=${JSON.stringify(body?.payments_live)} — real money is reachable`);
  return `payments_live=false, auth=${body.auth}, persistence=${body.persistence}, schema=${JSON.stringify(body.schema_assertion?.version ?? "n/a")}`;
});

await check("the marketplace is dark in this running process", async () => {
  const { status, body } = await get("/v3/marketplace/assert-dark");
  if (status !== 200 || body?.dark !== true) throw new Error(`assert-dark answered ${status}: ${JSON.stringify(body?.problems ?? body)}`);
  return "no priced listing, paid acquisition or non-test ledger entry";
});

await check("the subscription surface is dark in this running process", async () => {
  const { status, body } = await get("/v3/subscriptions/assert-dark");
  if (status !== 200 || body?.dark !== true) throw new Error(`assert-dark answered ${status}: ${JSON.stringify(body?.problems ?? body)}`);
  return "no price, no paid status, no grant outliving the internal window";
});

await check("nothing can be bought", async () => {
  const { body } = await get("/v3/subscriptions/plans");
  if (body?.purchasable !== false) throw new Error(`plans report purchasable=${JSON.stringify(body?.purchasable)}`);
  const priced = (body.plans || []).filter((p) => Number(p.price_minor || 0) !== 0);
  if (priced.length) throw new Error(`these plans carry a price: ${priced.map((p) => p.id).join(", ")}`);
  return `${(body.plans || []).length} plan(s), none purchasable, none priced`;
});

await check("the retired revenue route has not come back", async () => {
  const { status, body } = await get("/api/me/revenue");
  // 401 is also acceptable: it means the route is gone from the public surface.
  if (status !== 410 && status !== 401) throw new Error(`/api/me/revenue answered ${status} — a retired route is serving again`);
  if (body && ("total_minor" in body || "payouts" in body)) throw new Error("the retired revenue route is reporting figures again");
  return `answers ${status}, reports no figure`;
});

const bad = findings.filter((f) => !f.ok);
const code = bad.length === 0 ? 0 : (unreachable ? 2 : 1);

if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, dark: bad.length === 0, unreachable, checked_at: new Date().toISOString(), findings }, null, 2));
} else {
  console.log(`money-dark monitor — ${BASE}\n`);
  for (const f of findings) console.log(`  ${f.ok ? "PASS" : "FAIL"}  ${f.check}\n        ${f.detail}`);
  console.log("");
  if (code === 0) console.log(`RESULT: DARK (${findings.length}/${findings.length})`);
  else if (code === 2) console.log(`RESULT: UNKNOWN — could not reach the server. This is an alarm, not an all-clear.`);
  else console.log(`RESULT: NOT DARK — ${bad.length} check(s) failed. Investigate before anyone transacts.`);
}
process.exit(code);
