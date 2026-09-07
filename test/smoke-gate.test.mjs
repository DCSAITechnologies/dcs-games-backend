// Tests the DEPLOY GATE itself — scripts/smoke.mjs.
//
// Run with:  node --import tsx --test test/smoke-gate.test.mjs
// (tsx is required because this boots the real server.mts, same as
// test/api-integration.test.mjs.)
//
// Why this file exists. smoke.mjs is what a human runs before promoting a
// build, and until now nothing tested it. It had drifted into asserting 401
// for /api/me/revenue, a route deliberately retired to 410 this sprint — so a
// CORRECT build failed its own gate, with a message that read like an
// authentication hole. A gate nobody tests is a gate that quietly stops gating.
//
// So there are two obligations here and this file asserts both:
//   1. the gate PASSES a correct build (otherwise it trains people to ignore it), and
//   2. the gate FAILS when a security property is actually violated (otherwise
//      it is decoration).
//
// (2) is exercised with a reverse proxy that sits in front of the REAL server
// and corrupts exactly one field or one route. Every other byte is the real
// server's answer, so a failure is attributable to the injected defect and
// nothing else — and a no-fault control run proves the proxy itself is
// transparent.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");
const SMOKE = path.join(GB, "scripts", "smoke.mjs");
const SECRET = "smoke-gate-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-smoke-gate-"));
const PORT = 9200 + Math.floor(Math.random() * 300);   // outside the 8100-8899 range test/api-integration uses
const BASE = `http://127.0.0.1:${PORT}`;

let proc;

async function boot() {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env,
      PORT: String(PORT), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA,
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_INTERNAL_TESTERS: "alice@dcsai.ai",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "", CEREBRAS_KEY_2: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return p; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

/** Run scripts/smoke.mjs against a base URL. Returns { code, out }. */
function runSmoke(base) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SMOKE, base], { cwd: GB, env: { ...process.env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
}

/** Which named checks did the run report as FAIL? */
const failedChecks = (out) => out.split("\n").filter((l) => l.startsWith("  FAIL")).map((l) => l.slice(8).trim());

/**
 * A reverse proxy in front of the real server that injects exactly one defect.
 * Returns { base, close }.
 */
async function faultProxy(fault) {
  const srv = http.createServer(async (req, res) => {
    const url = (req.url || "").split("?")[0];
    // the server strips a leading /api/; normalise so a fault can name one path
    const norm = url.startsWith("/api/") && !url.startsWith("/api/public/") ? "/" + url.slice(5) : url;
    const xu = req.headers["x-user-id"];
    const bearerOk = /^Bearer .+\..+\..+$/.test(String(req.headers.authorization || ""));
    const reply = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json", "X-Correlation-Id": "cid_injected" });
      res.end(JSON.stringify(obj));
    };

    // Faults served without consulting upstream (a wrong answer outright).
    // "impersonate" is the exact pre-A1 production exploit: a request carrying
    // only x-user-id was served as that user.
    if (fault === "impersonate" && norm === "/worlds/mine" && xu && !req.headers.authorization) return reply(200, { ok: true, count: 0, worlds: [], owner: xu });
    if (fault === "token_fallthrough" && norm === "/worlds/mine" && xu && !bearerOk) return reply(200, { ok: true, count: 0, worlds: [], owner: xu });
    if (fault === "revenue_back" && norm === "/me/revenue") return reply(200, { ok: true, total_minor: 0, payouts: [], split: "70/30" });
    if (fault === "private_open" && norm === "/me/profile") return reply(200, { ok: true, id: "anonymous" });

    const r = await fetch(BASE + req.url, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== "host")),
    });
    let body = await r.text();
    let status = r.status;
    try {
      const j = JSON.parse(body);
      // Faults that corrupt one field of an otherwise real response.
      if (fault === "payments_live" && norm === "/health") j.payments_live = true;
      if (fault === "minors_on" && norm === "/health") j.safety.minor_onboarding_enabled = true;
      if (fault === "removed_header_meta_gone" && norm === "/worlds/mine" && status === 401) delete j.meta;
      if (fault === "no_correlation_id" && status >= 400) delete j.correlation_id;
      if (fault === "market_not_dark" && norm === "/v3/marketplace/assert-dark") { status = 500; j.dark = false; j.problems = ["a priced listing exists"]; }
      if (fault === "subs_not_dark" && norm === "/v3/subscriptions/assert-dark") { status = 500; j.dark = false; j.problems = ["a paid grant exists"]; }
      if (fault === "purchasable" && norm === "/v3/subscriptions/plans") { j.purchasable = true; if (j.plans?.[1]) j.plans[1].price_minor = 999; }
      body = JSON.stringify(j);
    } catch { /* not json — pass through untouched */ }
    res.writeHead(status, { "Content-Type": "application/json", "X-Correlation-Id": r.headers.get("x-correlation-id") || "cid_injected" });
    res.end(body);
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

/** Assert that one injected defect makes the gate fail, and names the right check. */
async function assertFaultIsCaught(fault, expectedCheck) {
  const p = await faultProxy(fault);
  try {
    const { code, out } = await runSmoke(p.base);
    assert.equal(code, 1, `the gate exited 0 with "${fault}" injected — it is not gating that property\n${out}`);
    assert.match(out, /^RESULT: FAIL/m, out);
    assert.ok(failedChecks(out).includes(expectedCheck),
      `"${fault}" was caught, but not by "${expectedCheck}" — it failed: ${JSON.stringify(failedChecks(out))}`);
  } finally { await p.close(); }
}

before(async () => { proc = await boot(); }, { timeout: 60000 });
after(() => { proc?.kill("SIGKILL"); fs.rmSync(DATA, { recursive: true, force: true }); });

// ------------------------------------------------ 1. the gate passes a correct build
test("the smoke gate PASSES against a correct build", async () => {
  const { code, out } = await runSmoke(BASE);
  assert.equal(code, 0, `a correct build failed its own deploy gate:\n${out}`);
  assert.match(out, /^RESULT: PASS/m, out);
  assert.equal(failedChecks(out).length, 0, out);
});

test("REGRESSION (the task-1 defect): the retired /api/me/revenue answers 410, and the gate still passes", async () => {
  // The gate asserted 401 for this route in the same loop as the genuinely
  // private ones. /me/revenue was retired to 410 for everyone, so a correct
  // build failed with "/api/me/revenue returned 410, expected 401" — a message
  // that sends a reader hunting an authentication hole that does not exist.
  const r = await fetch(BASE + "/api/me/revenue");
  assert.equal(r.status, 410, "the route under test is no longer 410; this test's premise has changed");
  const { code, out } = await runSmoke(BASE);
  assert.equal(code, 0, `410 on a retired route must not fail the gate:\n${out}`);
  assert.ok(!out.includes("expected 401"), "a retired route is still being asserted as 401 somewhere");
});

test("the gate reports every check it ran, and the count is the check count", async () => {
  const { out } = await runSmoke(BASE);
  const ran = out.split("\n").filter((l) => /^ {2}(PASS|FAIL) {2}/.test(l)).length;
  const m = out.match(/^RESULT: \w+ \((\d+)\/(\d+) checks\)/m);
  assert.ok(m, `the result line does not state a count:\n${out}`);
  assert.equal(Number(m[2]), ran, "the reported total does not match the checks actually run");
  assert.ok(ran >= 13, `the gate ran only ${ran} checks; it must cover this sprint's invariants`);
});

test("CONTROL: a transparent proxy in front of the real server still passes", async () => {
  // Without this, a FAIL in the tests below could be the proxy's fault rather
  // than the injected defect's.
  const p = await faultProxy("none");
  try {
    const { code, out } = await runSmoke(p.base);
    assert.equal(code, 0, `the fault harness is not transparent, so the fault tests prove nothing:\n${out}`);
  } finally { await p.close(); }
});

// ------------------------------------------------ 2. the gate fails on a real violation
test("the gate FAILS when the x-user-id impersonation path is reopened", async () => {
  await assertFaultIsCaught("impersonate", "the x-user-id impersonation path is gone");
});

test("the gate FAILS when a bad token falls through to the x-user-id header", async () => {
  await assertFaultIsCaught("token_fallthrough", "an invalid token does not fall through to a header");
});

test("the gate FAILS when the refusal stops naming the removed header", async () => {
  // A bare 401 is also what an anonymous request gets, so asserting only the
  // status cannot tell "the header is ignored" from "this route needs auth".
  await assertFaultIsCaught("removed_header_meta_gone", "the x-user-id impersonation path is gone");
});

test("the gate FAILS when a private route serves an anonymous caller", async () => {
  await assertFaultIsCaught("private_open", "private routes refuse anonymous callers");
});

test("the gate FAILS when /health reports payments_live: true", async () => {
  await assertFaultIsCaught("payments_live", "PAYMENTS_LIVE is false");
});

test("the gate FAILS when the marketplace is no longer dark", async () => {
  await assertFaultIsCaught("market_not_dark", "the marketplace is dark in this running process");
});

test("the gate FAILS when the subscription surface is no longer dark", async () => {
  await assertFaultIsCaught("subs_not_dark", "the subscription surface is dark in this running process");
});

test("the gate FAILS when a plan becomes purchasable", async () => {
  await assertFaultIsCaught("purchasable", "nothing can be bought");
});

test("the gate FAILS when the retired revenue route starts reporting figures again", async () => {
  await assertFaultIsCaught("revenue_back", "the retired revenue route stays retired");
});

test("the gate FAILS when error bodies stop carrying a correlation id", async () => {
  // The header is set on every response before routing, so a check that accepts
  // "body OR header" passes even when every error body has lost its id.
  await assertFaultIsCaught("no_correlation_id", "errors carry a correlation id");
});

test("the gate FAILS when minor onboarding is switched on", async () => {
  await assertFaultIsCaught("minors_on", "the safety surface is present");
});

test("the gate FAILS when it cannot reach the service at all", async () => {
  // A gate that reports OK when it cannot reach its target converts an outage
  // into a green light. Point it at a closed port.
  const { code, out } = await runSmoke("http://127.0.0.1:1");
  assert.equal(code, 1, out);
  assert.match(out, /^RESULT: FAIL/m, out);
});

// ============================================ the money-dark monitor itself
//
// scripts/monitor-dark.mjs is the thing that would tell somebody money had
// stopped being dark on a RUNNING server — the question verify-release.mjs
// cannot answer, because a migration, a manual edit or an import can put a
// priced row in a table long after a green release gate.
//
// Nothing tested it. A monitor that always exits 0 is indistinguishable from a
// healthy system, and it is worse than no monitor because it converts an
// outage into a green light — which is the monitor's own stated reason for
// treating "could not tell" as an alarm. So both obligations, same as the
// deploy gate above: it must pass a correct server, and it must ALARM when a
// property it claims to watch is actually violated.
//
// The faults are injected by the same reverse proxy, so every byte except the
// one corrupted field is the real server's answer.

const MONITOR = path.join(GB, "scripts", "monitor-dark.mjs");

/** Run scripts/monitor-dark.mjs against a base URL. Returns { code, out, json }. */
function runMonitor(base, { json = true } = {}) {
  return new Promise((resolve) => {
    const args = [MONITOR, "--base", base, ...(json ? ["--json"] : [])];
    const p = spawn(process.execPath, args, { cwd: GB, env: { ...process.env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => {
      let parsed = null;
      if (json) { try { parsed = JSON.parse(out); } catch { /* reported as null */ } }
      resolve({ code, out, json: parsed });
    });
  });
}

/** One injected defect must make the monitor alarm, and name the right check. */
async function assertMonitorAlarms(fault, expectedCheck) {
  const p = await faultProxy(fault);
  try {
    const { code, json, out } = await runMonitor(p.base);
    assert.equal(code, 1,
      `the monitor exited ${code} with "${fault}" injected — it is not watching that property\n${out}`);
    assert.ok(json, `the monitor produced no JSON to read:\n${out}`);
    assert.equal(json.dark, false, "a monitor that alarms must not also report dark:true");
    assert.equal(json.unreachable, false, "this is a reachable server answering wrongly, not an outage");
    const failed = json.findings.filter((f) => !f.ok).map((f) => f.check);
    assert.ok(failed.includes(expectedCheck),
      `"${fault}" was caught, but not by "${expectedCheck}" — it failed: ${JSON.stringify(failed)}`);
  } finally { await p.close(); }
}

test("MONITOR: money-dark reports DARK against a correct running server", async () => {
  const { code, json, out } = await runMonitor(BASE);
  assert.equal(code, 0, `a correct server was reported as not dark:\n${out}`);
  assert.equal(json.dark, true, out);
  assert.equal(json.unreachable, false, out);
  assert.deepEqual(json.findings.filter((f) => !f.ok), [], out);
  // If the monitor ever shrinks to one check it would still be green here.
  assert.ok(json.findings.length >= 5,
    `the monitor ran only ${json.findings.length} checks; it must cover health, both assert-dark surfaces, plans and the retired route`);
});

test("MONITOR: it alarms when /health reports payments_live", async () => {
  await assertMonitorAlarms("payments_live", "the server is reachable and reports its payment state");
});

test("MONITOR: it alarms when the marketplace stops being dark in the running process", async () => {
  await assertMonitorAlarms("market_not_dark", "the marketplace is dark in this running process");
});

test("MONITOR: it alarms when the subscription surface stops being dark", async () => {
  await assertMonitorAlarms("subs_not_dark", "the subscription surface is dark in this running process");
});

test("MONITOR: it alarms when a plan becomes purchasable or carries a price", async () => {
  await assertMonitorAlarms("purchasable", "nothing can be bought");
});

test("MONITOR: it alarms when the retired revenue route starts answering with figures", async () => {
  await assertMonitorAlarms("revenue_back", "the retired revenue route has not come back");
});

test("MONITOR: an unreachable server is an alarm with its own exit code, never an all-clear", async () => {
  // The distinction the monitor's own header insists on: 1 means NOT DARK and
  // 2 means COULD NOT TELL. Both are alarms; conflating either with 0 turns an
  // outage into a green light, and conflating them with each other sends
  // whoever is paged looking for a transaction that never happened.
  const dead = await new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
  const { code, json, out } = await runMonitor(`http://127.0.0.1:${dead}`);
  assert.equal(code, 2, `an unreachable server must exit 2, got ${code}:\n${out}`);
  assert.equal(json.dark, false, "an unreachable server must never be reported as dark");
  assert.equal(json.unreachable, true, out);

  // And it must SAY so in the words a human reads, not only in the exit code.
  const human = await runMonitor(`http://127.0.0.1:${dead}`, { json: false });
  assert.equal(human.code, 2);
  assert.match(human.out, /RESULT: UNKNOWN/, human.out);
  assert.match(human.out, /alarm, not an all-clear/i, human.out);
});
