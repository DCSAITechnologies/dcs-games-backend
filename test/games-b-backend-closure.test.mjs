// Games-B backend closure — the INTERNAL STAGING PREVIEW bar, against the real
// server in its DEFAULT configuration (DCS_PUBLISH_VISIBILITY unset = internal).
//
//   internal publish control   published worlds are visible to owner + internal
//                              testers only; every public listing is empty for
//                              everyone else; publish is tester-only
//   audit log                  every prompt (refused ones by hash only), every
//                              stored output hash, every publish action;
//                              append-only, hash-chained, survives restart,
//                              tamper is detected and fails readiness
//   B5                         editing a published world returns it to draft;
//                              republish re-attests with a new package
//   package integrity          verified from disk after writing; on-disk tamper
//                              is detected by /worlds/:id/staging/verify
//   SEC-01                     the public moderation log carries no moderator
//                              id, report id or rationale
//   token hygiene              no-store on every answer; a credential in a URL
//                              is refused
//   route guards               every advertised route, called anonymously, is
//                              refused or public — and no public answer names
//                              an internally published world
//   readiness                  /ready is 200 when configured, 503 naming the
//                              failing check when not
//   restart                    world, internal visibility, package, audit chain
//                              and resume all survive a restart
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = crypto.randomBytes(24).toString("hex");
const ATLAS = crypto.randomBytes(32).toString("base64");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-gbclose-"));

function tok(claims, ttl = 3600) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const body = enc({ ...claims, iss: "dcs-games-local", iat: now, exp: now + ttl });
  return `${head}.${body}.${crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const OWNER = tok({ sub: "u-gb-owner", email: "gb-owner@dcsai.ai" });          // tester by allowlisted email
const TESTER2 = tok({ sub: "u-gb-tester2", roles: ["internal_tester"] });      // tester by role
const READER = tok({ sub: "u-gb-reader", roles: ["internal_tester"] });        // tester AND audit reader (by id)
const PLAYER = tok({ sub: "u-gb-player", email: "player@example.com" });       // signed in, NOT a tester

const ENV = (extra = {}) => ({
  ...process.env, DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA,
  PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1",
  DCS_INTERNAL_TESTERS: "gb-owner@dcsai.ai", DCS_AUDIT_READERS: "u-gb-reader", ATLAS_PRIVATE_KEY: ATLAS,
  DCS_PUBLISH_VISIBILITY: "",
  SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
  CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "", DCS_GAMES_ENGINE_EXTERNAL: "",
  ...extra,
});

async function boot(env) {
  const port = 10100 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], { cwd: GB, env: { ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  const exited = new Promise((r) => proc.once("exit", r));
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + "/health")).ok) return { proc, base, exited }; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error("server did not become healthy");
}
async function stop(s) { s.proc.kill("SIGKILL"); await s.exited; }

let S;
const call = async (token, method, url, body, base = S.base) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, headers: r.headers };
};

const W = {};   // fixtures
before(async () => {
  S = await boot(ENV());
  for (const t of [OWNER, TESTER2, READER, PLAYER]) {
    assert.equal((await call(t, "POST", "/safety/age", { date_of_birth: "1990-01-01", method: "synthetic_test" })).status, 200);
  }
  const g = await call(OWNER, "POST", "/v3/worlds/generate", { prompt: "a harbour town with a lighthouse and a fish market", seed: 11 });
  assert.equal(g.status, 200, g.text.slice(0, 300));
  W.id = g.body.world_id;
  const d = await call(OWNER, "POST", "/v3/worlds/generate", { prompt: "a quiet mill by a river", seed: 12 });
  assert.equal(d.status, 200, d.text.slice(0, 300));
  W.draft = d.body.world_id;
});
after(async () => {
  try { await stop(S); } catch { /* gone */ }
  fs.rmSync(DATA, { recursive: true, force: true });
});

// --------------------------------------------------------------- readiness
test("readiness: /ready is 200 in the preview configuration and names every check", async () => {
  const r = await call(null, "GET", "/ready");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ready, true);
  assert.equal(r.body.publish_visibility, "internal");
  const names = r.body.checks.map((c) => c.name);
  for (const n of ["auth_configured", "data_dir_writable", "world_memory_writable", "audit_log_chain", "prompt_guard", "tester_allowlist", "atlas_signing", "staging_registry"]) {
    assert.ok(names.includes(n), `missing readiness check ${n}`);
  }
  assert.doesNotMatch(r.text, new RegExp(DATA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "readiness must not disclose the data path");
  const h = await call(null, "GET", "/health");
  assert.equal(h.body.publish_control.visibility, "internal");
  assert.equal(h.body.publish_control.prompt_guard, true);
});

test("readiness: an instance with no tester allowlist and no signing key is NOT ready, and says why", async () => {
  const other = await boot(ENV({ DCS_INTERNAL_TESTERS: "", ATLAS_PRIVATE_KEY: "", DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-gbclose-nr-")) }));
  try {
    const r = await call(null, "GET", "/ready", undefined, other.base);
    assert.equal(r.status, 503);
    assert.equal(r.body.ready, false);
    assert.ok(r.body.failing.includes("tester_allowlist"));
    assert.ok(r.body.failing.includes("atlas_signing"));
  } finally { await stop(other); }
});

// ------------------------------------------------ internal publish control
test("publish control: only an internal tester publishes; the package is verified from disk and the action is logged", async () => {
  const refused = await call(PLAYER, "POST", `/worlds/${W.id}/publish`, {});
  assert.equal(refused.status, 403, "a signed-in non-tester cannot publish");
  const p = await call(OWNER, "POST", `/worlds/${W.id}/publish`, {});
  assert.equal(p.status, 200, p.text.slice(0, 400));
  assert.equal(p.body.visibility, "internal");
  const integ = p.body.staging_package.integrity;
  assert.equal(integ.verified, true);
  assert.equal(integ.signature_key_trusted, true);
  assert.equal(integ.package_sha256, p.body.staging_package.package_id, "the package id IS the sha256 of the signed archive");
  assert.match(integ.descriptor_manifest_hash, /^[0-9a-f]{64}$|^sha256:/);
  assert.ok(Number.isInteger(p.body.audit.seq) && p.body.audit.seq > 0);
  W.pkg1 = p.body.staging_package.package_id;
});

test("publish control: a published world is invisible to anonymous callers and to signed-in non-testers", async () => {
  for (const who of [null, PLAYER]) {
    const label = who ? "non-tester" : "anonymous";
    for (const u of [`/v3/worlds/${W.id}/manifest`, `/worlds/${W.id}/manifest`, `/worlds/${W.id}/load`, `/v3/worlds/${W.id}/versions`, `/v3/worlds/${W.id}/versions/1`, `/v3/worlds/${W.id}/stats`, `/v3/worlds/${W.id}/attribution`, `/v3/worlds/${W.id}/parts`, `/v3/worlds/${W.id}/diff?from=1&to=2`]) {
      const r = await call(who, "GET", u);
      assert.equal(r.status, 404, `${label} GET ${u} -> ${r.status}`);
    }
    const ghost = await call(who, "GET", `/v3/worlds/w3_doesnotexist000/manifest`);
    const real = await call(who, "GET", `/v3/worlds/${W.id}/manifest`);
    assert.equal(real.body?.error, ghost.body?.error, "the same answer as a world that does not exist");
    for (const u of ["/v3/discover", "/api/public/worlds", "/api/public/events", "/api/public/atlas/feed", "/api/public/stats"]) {
      const r = await call(who, "GET", u);
      assert.equal(r.status, 200, `${label} ${u}`);
      assert.ok(!r.text.includes(W.id), `${label} ${u} names the internally published world`);
    }
    assert.equal((await call(who, "GET", "/api/public/stats")).body.published_worlds, 0);
  }
  assert.equal((await call(PLAYER, "POST", `/v3/worlds/${W.id}/play`, { seconds: 10 })).status, 404, "a non-tester cannot enter it either");
});

test("publish control: another internal tester sees the published world, and the owner sees it in the catalogue", async () => {
  assert.equal((await call(TESTER2, "GET", `/v3/worlds/${W.id}/manifest`)).status, 200);
  assert.ok((await call(TESTER2, "GET", "/v3/discover")).text.includes(W.id));
  assert.ok((await call(TESTER2, "GET", "/api/public/worlds")).text.includes(W.id));
  // A tester's catalogue must never be served from cache to an anonymous caller.
  assert.ok(!(await call(null, "GET", "/api/public/worlds")).text.includes(W.id));
  // Drafts stay owner-only for everyone, testers included.
  assert.equal((await call(TESTER2, "GET", `/v3/worlds/${W.draft}/manifest`)).status, 404);
  const v = await call(TESTER2, "GET", `/worlds/${W.id}/staging/verify`);
  assert.equal(v.status, 200);
  assert.equal(v.body.consistent, true);
  assert.equal(v.body.package.verified, true);
  assert.equal(v.body.published_package_id, W.pkg1);
});

// ---------------------------------------------------------------------- B5
test("B5: editing a published world returns it to draft, strips the trust fields, and republishing re-attests", async () => {
  const e = await call(OWNER, "POST", `/v3/worlds/${W.id}/edit`, { request: "make it rain" });
  assert.equal(e.status, 200, e.text.slice(0, 300));
  assert.equal(e.body.state ?? e.body.publication?.state, "draft", JSON.stringify(e.body).slice(0, 300));
  const m = await call(OWNER, "GET", `/v3/worlds/${W.id}/manifest`);
  const meta = (m.body.manifest || m.body).meta;
  for (const k of ["atlas_signed", "atlas_receipt_hash", "published_package_id", "published_manifest_hash"]) assert.equal(meta[k], undefined, `${k} survived the edit`);
  assert.equal((await call(TESTER2, "GET", `/v3/worlds/${W.id}/manifest`)).status, 404, "a draft again, so owner-only");
  const v = await call(OWNER, "GET", `/worlds/${W.id}/staging/verify`);
  assert.equal(v.body.state, "draft");
  assert.equal(v.body.consistent, null, "a draft makes no publication claim");
  const p = await call(OWNER, "POST", `/worlds/${W.id}/publish`, {});
  assert.equal(p.status, 200, p.text.slice(0, 300));
  assert.notEqual(p.body.staging_package.package_id, W.pkg1, "new content, new package");
  W.pkg2 = p.body.staging_package.package_id;
  const v2 = await call(OWNER, "GET", `/worlds/${W.id}/staging/verify`);
  assert.equal(v2.body.consistent, true);
  assert.equal(v2.body.published_package_id, W.pkg2);
});

// -------------------------------------------------------------- audit log
test("audit: prompts, output hashes and publish actions are logged; a refused prompt keeps only its hash", async () => {
  const secret = "sk-ant-api03-" + "Q".repeat(40);
  const bad = await call(OWNER, "POST", "/v3/worlds/generate", { prompt: `build a castle, key ${secret}` });
  assert.equal(bad.status, 422);
  assert.equal((await call(null, "GET", "/v3/audit")).status, 401);
  assert.equal((await call(TESTER2, "GET", "/v3/audit")).status, 403, "a tester is not an audit reader");
  assert.equal((await call(PLAYER, "GET", "/v3/audit")).status, 403);
  const a = await call(READER, "GET", "/v3/audit?limit=500");
  assert.equal(a.status, 200);
  assert.ok(!a.text.includes(secret), "the refused credential must not be on disk or on the wire");
  const es = a.body.entries;
  const prompts = es.filter((e) => e.kind === "prompt");
  const accepted = prompts.find((e) => e.world_id === W.id && e.route === "POST /v3/worlds/generate");
  assert.ok(accepted && accepted.prompt_text.includes("harbour town") && /^[0-9a-f]{64}$/.test(accepted.prompt_sha256));
  const refused = prompts.find((e) => e.guard.ok === false);
  assert.ok(refused, "the refused prompt is logged");
  assert.equal(refused.prompt_text, undefined);
  assert.equal(refused.guard.code, "contains_secret");
  const outputs = es.filter((e) => e.kind === "output" && e.world_id === W.id);
  assert.ok(outputs.some((e) => e.route === "POST /v3/worlds/generate" && /^sha256:/.test(e.content_hash)));
  assert.ok(outputs.some((e) => /edit/.test(e.route)), "the edit's stored output is logged");
  const pubs = es.filter((e) => e.kind === "publish" && e.world_id === W.id).map((e) => e.action);
  assert.deepEqual(pubs, ["publish", "returned_to_draft", "publish"]);
  const pubEntry = es.find((e) => e.kind === "publish" && e.package_id === W.pkg2);
  assert.equal(pubEntry.package_sha256, W.pkg2);
  assert.ok(pubEntry.receipt_hash && pubEntry.content_hash);
  // Hash chain: seq contiguous, each prev_hash is the previous line's hash.
  for (let i = 1; i < es.length; i++) {
    assert.equal(es[i].seq, es[i - 1].seq + 1);
    assert.equal(es[i].prev_hash, es[i - 1].hash);
  }
  const v = await call(READER, "GET", "/v3/audit/verify");
  assert.equal(v.body.ok, true);
});

// ------------------------------------------------------------------ SEC-01
test("SEC-01: the public moderation log carries no moderator id, report id or rationale; staff see full rows", async () => {
  const rep = await call(PLAYER, "POST", "/safety/report", { subject_type: "user", subject_id: "u-someone", reason: "spam", detail: "posted links" });
  assert.equal(rep.status, 201);
  const q = await call(OWNER, "GET", "/safety/reports");
  assert.equal(q.status, 200);
  const action = q.body.actions.find((x) => /dismiss|warn|remove|no_action|resolve/.test(x)) || q.body.actions[0];
  const mod = await call(OWNER, "POST", `/safety/reports/${rep.body.report_id}/moderate`, { action });
  assert.equal(mod.status, 200, mod.text.slice(0, 300));
  const pub = await call(null, "GET", "/safety/moderation-history");
  assert.equal(pub.status, 200);
  assert.ok(pub.body.count >= 1);
  assert.equal(pub.body.redacted, true);
  for (const leak of ["u-gb-owner", rep.body.report_id, "u-someone", "report "]) {
    assert.ok(!pub.text.includes(leak), `the public log leaks ${leak}`);
  }
  for (const row of pub.body.actions) {
    assert.deepEqual(Object.keys(row).filter((k) => row[k] !== undefined).sort(), ["action", "decided_at", "decided_by", "subject_type"].sort());
    assert.equal(row.decided_by, "human_moderator");
  }
  const staff = await call(OWNER, "GET", "/safety/moderation-history");
  assert.equal(staff.body.redacted, false);
  assert.ok(staff.text.includes(rep.body.report_id), "staff keep the full record");
});

// ------------------------------------------------------------ token hygiene
test("token: every API answer is no-store/nosniff/no-referrer, and a credential in the URL is refused", async () => {
  for (const [t, u] of [[OWNER, "/me/home"], [null, "/health"], [null, "/ready"], [null, "/v3/discover"]]) {
    const r = await call(t, "GET", u);
    assert.equal(r.headers.get("cache-control"), "no-store", u);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", u);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer", u);
  }
  for (const k of ["access_token", "token", "refresh_token", "id_token", "apikey"]) {
    const r = await call(null, "GET", `/me/home?${k}=${encodeURIComponent(OWNER)}`);
    assert.equal(r.status, 400, k);
    assert.equal(r.body.error, "credential_in_url");
    assert.ok(!r.text.includes(OWNER), "the refusal must not echo the token");
  }
  // Only the header is ever read.
  assert.equal((await call(OWNER, "GET", "/me/home")).status, 200);
});

// ------------------------------------------------------------ route guards
const PUBLIC_OK = new Set([
  "GET /health", "GET /ready", "GET /atlas/key", "GET /verify", "GET /atlas/receipt/:id", "GET /v3/providers",
  "GET /v3/discover", "GET /api/public/worlds", "GET /api/public/stats", "GET /api/public/events", "GET /api/public/market",
  "GET /api/public/atlas/feed", "GET /api/public/atlas/stats", "GET /safety/moderation-history",
  "GET /v3/subscriptions/plans", "GET /v3/subscriptions/assert-dark", "GET /v3/marketplace/assert-dark",
  "GET /v3/marketplace", "GET /v3/marketplace/split", "GET /v3/marketplace/storefronts", "GET /profiles/:username",
  // How a token is obtained, so public by definition. Without Supabase they answer 503 not_configured.
  "POST /auth/signup", "POST /auth/login",
]);
test("route guards: every advertised route refuses an anonymous caller or is public, and no public answer names an internal world", async () => {
  const h = await call(null, "GET", "/health");
  const all = Object.values(h.body.routes).flat().map((r) => r.split(" ").slice(0, 2).join(" ")).filter((r) => /^(GET|POST|PUT|PATCH|DELETE) \//.test(r));
  const fill = (p) => p
    .replace(/\/(v3\/)?worlds\/:id/, (m0) => m0.replace(":id", W.id))
    .replace(":n", "1").replace(":npc", "npc-1").replace(":channel", "email").replace(":username", "someone").replace(/:id/g, "x-" + "0".repeat(8));
  const bad = [];
  for (const r of new Set(all)) {
    const [method, p] = r.split(" ");
    const res = await call(null, method, fill(p), method === "GET" || method === "DELETE" ? undefined : {});
    if (PUBLIC_OK.has(r)) {
      if (res.status >= 500 && !(res.status === 503 && res.body?.error === "not_configured")) bad.push(`${r} -> ${res.status}`);
      if (res.text.includes(W.id)) bad.push(`${r} is public and names the internally published world`);
      continue;
    }
    // Refused, retired, absent (same answer as nonexistent), or rejected input — never served.
    if (![400, 401, 403, 404, 405, 410, 422].includes(res.status)) bad.push(`${r} -> ${res.status} ${res.text.slice(0, 100)}`);
    if (res.status < 300 && res.text.includes(W.id)) bad.push(`${r} served the internal world anonymously`);
  }
  assert.deepEqual(bad, [], "route-guard matrix failures:\n" + bad.join("\n"));
});

// --------------------------------------------------------------- restart
test("restart: world, internal visibility, package integrity, audit chain and resume survive; the chain continues", async () => {
  const before = await call(READER, "GET", "/v3/audit?limit=1");
  const seqBefore = before.body.head.seq;
  const manBefore = await call(OWNER, "GET", `/v3/worlds/${W.id}/manifest`);
  await stop(S);
  S = await boot(ENV());
  const man = await call(OWNER, "GET", `/v3/worlds/${W.id}/manifest`);
  assert.equal(man.status, 200);
  assert.equal(man.body.manifest_hash ?? man.body.hash, manBefore.body.manifest_hash ?? manBefore.body.hash);
  assert.equal((await call(null, "GET", `/v3/worlds/${W.id}/manifest`)).status, 404, "still internal after a restart");
  assert.equal((await call(TESTER2, "GET", `/v3/worlds/${W.id}/manifest`)).status, 200);
  const v = await call(OWNER, "GET", `/worlds/${W.id}/staging/verify`);
  assert.equal(v.body.consistent, true);
  assert.equal(v.body.published_package_id, W.pkg2);
  const load = await call(OWNER, "GET", `/worlds/${W.id}/load`);
  assert.equal(load.status, 200);
  assert.ok(load.body.resume && load.body.resume.version, "World Memory v2 resume survives the restart");
  const ready = await call(null, "GET", "/ready");
  assert.equal(ready.status, 200, JSON.stringify(ready.body.failing));
  // A new prompt after the restart extends the SAME chain.
  assert.equal((await call(OWNER, "POST", `/v3/worlds/${W.draft}/expand`, { request: "add a bakery district" })).status < 500, true);
  const after = await call(READER, "GET", "/v3/audit?limit=5");
  assert.ok(after.body.head.seq > seqBefore);
  assert.equal((await call(READER, "GET", "/v3/audit/verify")).body.ok, true);
});

// ----------------------------------------------------------- tamper (last)
test("integrity: tampering with a staged package on disk is detected by staging/verify", async () => {
  const dir = path.join(DATA, "staging-packages", W.id, W.pkg2);
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".json") && x !== "package.sig.json");
  const p = path.join(dir, f);
  fs.chmodSync(p, 0o644);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/.$/s, " "));
  const v = await call(OWNER, "GET", `/worlds/${W.id}/staging/verify`);
  assert.equal(v.body.package.verified, false);
  assert.equal(v.body.consistent, false);
});

test("integrity: an edited audit line breaks the chain, verify names it, and the instance stops being ready", async () => {
  const file = path.join(DATA, "audit", "audit.jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const e = JSON.parse(lines[1]);
  e.actor = "someone-else";
  lines[1] = JSON.stringify(e);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const v = await call(READER, "GET", "/v3/audit/verify");
  assert.equal(v.body.ok, false);
  assert.equal(v.body.broken_at, 2);
  const r = await call(null, "GET", "/ready");
  assert.equal(r.status, 503);
  assert.ok(r.body.failing.includes("audit_log_chain"));
  // Truncation back to a self-consistent prefix is caught by the head record.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(0, 1).join("\n") + "\n");
  const t = await call(READER, "GET", "/v3/audit/verify");
  assert.equal(t.body.ok, false);
  assert.match(t.body.reason, /truncated|diverges/);
});
