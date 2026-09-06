// Lane F — the CI-safe half of the load work.
//
// scripts/load-test.mjs is the exploratory harness: it ramps concurrency and
// hunts for the knee. This file is the deterministic residue of what that hunt
// found, sized so it runs in a few seconds on a shared runner.
//
// It asserts CORRECTNESS PROPERTIES, not speed:
//   - every read returns 200
//   - concurrent writes are all persisted (no lost update)
//   - a burst of distinct first sign-ins produces one profile row each
//   - concurrent world saves either all land or are refused with 409
//
// The only timing assertion is an absurdly generous ceiling whose job is to
// catch a hang, not to police latency. A tight p95 assertion on a shared CI box
// is a test that will eventually lie to whoever is on call.
//
// STATUS AS WRITTEN: three of these assertions FAIL against the current server.
// That is deliberate and it is not flakiness — the failures reproduce 5/5 at a
// concurrency of two. They pin the defects recorded in reports/LOAD_AND_SCALE.md
// (LF-1 world plays, LF-2 principal profiles, LF-3 world saves). This file is not
// referenced by any npm script, so it cannot redden another lane's build; wire it
// into test:ci once collection.mjs and WorldRepository.upsert serialise their
// read-modify-write.
//
// Run: node --import tsx --test test/load-smoke.test.mjs

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");
const SECRET = "load-smoke-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-load-smoke-"));
const PORT = 8200 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;
const ATLAS_SEED = crypto.randomBytes(32).toString("base64");

// Modest, fixed and deterministic: a request COUNT, not a duration, so the test
// does the same amount of work on a fast laptop and a contended CI runner.
const CONCURRENCY = 8;
const REQUESTS_PER_WORKER = 15;         // 120 reads total
const WRITE_BURST = 8;
const SAVE_BURST = 4;
const HANG_CEILING_MS = 15_000;         // a ceiling for "did it hang", nothing else

const TESTER = signLocalToken(SECRET, { sub: "smoke-tester", email: "loadsmoke@dcsai.ai", roles: ["internal_tester"] }, 3600);
const READER = signLocalToken(SECRET, { sub: "smoke-reader", email: "smokereader@example.com" }, 3600);

let proc;
let worldId;

function env() {
  return {
    ...process.env,
    PORT: String(PORT),
    DCS_AUTH_SECRET: SECRET,
    DCS_DATA_DIR: DATA,
    PAYMENTS_LIVE: "0",
    NODE_ENV: "test",
    DCS_PROVIDERS_OFFLINE: "1",
    DCS_INTERNAL_TESTERS: "loadsmoke@dcsai.ai",
    ATLAS_PRIVATE_KEY: ATLAS_SEED,
    SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "",
    CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "", CEREBRAS_KEY_2: "",
    DEEPSEEK_API_KEY: "", TOGETHER_API_KEY: "", DATABASE_URL: "",
  };
}

async function boot() {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB, env: env(), stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return p; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

const call = async (p, { method = "GET", token = null, body } = {}) => {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};

const rows = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, "social", name + ".json"), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
};

before(async () => {
  proc = await boot();

  // The safety service refuses 'create' for an unknown age tier. Record a real
  // age assurance rather than reaching around the check.
  const age = await call("/safety/age", { method: "POST", token: TESTER, body: { date_of_birth: "1988-03-14" } });
  assert.equal(age.status, 200, "age assurance setup failed: " + age.text.slice(0, 200));

  const g = await call("/v3/worlds/generate", { method: "POST", token: TESTER, body: { prompt: "A quiet harbour town" } });
  assert.equal(g.status, 200, "world generation setup failed: " + g.text.slice(0, 300));
  worldId = g.body.world_id;

  const pub = await call(`/worlds/${worldId}/publish`, { method: "POST", token: TESTER, body: {} });
  assert.equal(pub.status, 200, "publish setup failed: " + pub.text.slice(0, 300));
  assert.equal(pub.body.published, true);
});

after(() => {
  proc?.kill("SIGKILL");
  fs.rmSync(DATA, { recursive: true, force: true });
});

// ------------------------------------------------------------------- reads
test("load smoke: the public read paths survive modest concurrency with zero errors", async () => {
  const paths = [
    "/health",
    "/v3/discover?limit=24",
    `/v3/worlds/${worldId}/manifest`,
    `/v3/worlds/${worldId}/stats`,
    "/me/profile",
  ];
  const byStatus = new Map();
  const latencies = [];
  const transportErrors = [];

  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
    for (let i = 0; i < REQUESTS_PER_WORKER; i++) {
      const p = paths[(w + i) % paths.length];
      const headers = p === "/me/profile" ? { Authorization: "Bearer " + READER } : undefined;
      const s = performance.now();
      try {
        const r = await fetch(BASE + p, { headers });
        await r.arrayBuffer();
        latencies.push(performance.now() - s);
        byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
      } catch (e) {
        transportErrors.push(`${p}: ${e.message}`);
      }
    }
  }));
  const elapsed = performance.now() - t0;

  assert.deepEqual(transportErrors, [], "the server dropped connections under concurrency");
  const statuses = Object.fromEntries(byStatus);
  assert.deepEqual(statuses, { 200: CONCURRENCY * REQUESTS_PER_WORKER },
    "every public read must be a 200 under concurrency; got " + JSON.stringify(statuses));

  // Deliberately not a latency SLO. This only catches a hang or a deadlock.
  assert.ok(elapsed < HANG_CEILING_MS,
    `${latencies.length} reads at concurrency ${CONCURRENCY} took ${Math.round(elapsed)}ms, over the ${HANG_CEILING_MS}ms hang ceiling`);
});

// ------------------------------------------------------------- lost updates
test("load smoke: concurrent plays are all persisted (no lost update in the collection store)", async () => {
  const before = rows("world_plays").length;
  const statuses = await Promise.all(Array.from({ length: WRITE_BURST }, (_, i) =>
    call(`/v3/worlds/${worldId}/play`, { method: "POST", token: READER, body: { seconds: 10 + i } }).then((r) => r.status)));

  const accepted = statuses.filter((s) => s === 200 || s === 201).length;
  assert.equal(accepted, WRITE_BURST, "every play write was accepted with 2xx; got " + JSON.stringify(statuses));

  await new Promise((r) => setTimeout(r, 250));
  const persisted = rows("world_plays").length - before;
  assert.equal(persisted, accepted,
    `${accepted} plays were accepted with 2xx but only ${persisted} reached the store — ` +
    "collection.insert() reads the whole file, mutates and writes it back with awaits in between, " +
    "so concurrent writers overwrite each other and the caller is never told");

  const stats = await call(`/v3/worlds/${worldId}/stats`);
  assert.equal(stats.status, 200);
  assert.ok(stats.body.stats.plays >= accepted,
    `the stats endpoint reports ${stats.body.stats.plays} plays after ${accepted} accepted writes`);
});

test("load smoke: a burst of distinct first sign-ins writes one profile each", async () => {
  const subs = Array.from({ length: WRITE_BURST }, (_, i) => `smoke-burst-${i}-${crypto.randomBytes(2).toString("hex")}`);
  const beforeIds = new Set(rows("principals").map((r) => r.principal_id));

  const statuses = await Promise.all(subs.map((sub) =>
    call("/me/profile", { token: signLocalToken(SECRET, { sub, email: `${sub}@example.com` }, 3600) }).then((r) => r.status)));
  assert.deepEqual([...new Set(statuses)], [200], "every /me/profile read must be a 200; got " + JSON.stringify(statuses));

  await new Promise((r) => setTimeout(r, 250));
  const after = rows("principals");
  const afterIds = new Set(after.map((r) => r.principal_id));

  const lostPreExisting = [...beforeIds].filter((id) => !afterIds.has(id));
  assert.deepEqual(lostPreExisting, [], "a concurrent sign-in burst deleted pre-existing principal rows");

  const persisted = subs.filter((s) => afterIds.has(s));
  assert.equal(persisted.length, subs.length,
    `${subs.length} distinct principals each got a 200 from GET /me/profile but only ${persisted.length} profiles reached the store — ` +
    "ensureProfile() inserts through the same read-modify-write window");

  for (const sub of subs) {
    assert.equal(after.filter((r) => r.principal_id === sub).length, 1, `principal ${sub} must have exactly one profile row`);
  }
});

test("load smoke: concurrent world saves either all land or are refused with a conflict", async () => {
  const before = await call(`/v3/worlds/${worldId}/manifest`, { token: TESTER });
  assert.equal(before.status, 200);
  const baseVersion = Number(before.body.world_version);
  const manifest = before.body.manifest;

  const results = await Promise.all(Array.from({ length: SAVE_BURST }, (_, i) =>
    call(`/worlds/${worldId}/save`, {
      method: "POST", token: TESTER,
      body: { manifest: { ...manifest, meta: { ...manifest.meta, title: `smoke concurrent edit ${i}` } }, state: "published" },
    }).then((r) => r.status)));

  const accepted = results.filter((s) => s === 200).length;
  const conflicted = results.filter((s) => s === 409).length;
  assert.equal(accepted + conflicted, SAVE_BURST,
    "a concurrent save must be either applied or refused as a conflict; got " + JSON.stringify(results));

  await new Promise((r) => setTimeout(r, 250));
  const after = await call(`/v3/worlds/${worldId}/manifest`, { token: TESTER });
  assert.equal(after.status, 200);
  const advanced = Number(after.body.world_version) - baseVersion;

  assert.equal(advanced, accepted,
    `${accepted} saves returned 200 but the world advanced only ${advanced} version(s) — ` +
    "WorldRepository.upsert derives version from a value it read before the write, and " +
    "POST /worlds/:id/save defaults expected_version to null so nothing forces optimistic concurrency");

  // A version the caller was told was saved must be retrievable for a rollback.
  const versions = await call(`/v3/worlds/${worldId}/versions`, { token: TESTER });
  assert.equal(versions.status, 200);
  assert.ok(versions.body.versions.length >= baseVersion + accepted - 1,
    `version history holds ${versions.body.versions.length} entries after ${accepted} accepted saves from v${baseVersion}`);
});

// ------------------------------------------------------------------ health
test("load smoke: the server is still healthy and money is still dark after the burst", async () => {
  const r = await call("/health");
  assert.equal(r.status, 200, "the server must still be serving after the concurrency burst");
  assert.equal(r.body.payments_live, false, "PAYMENTS_LIVE must stay false");
});
