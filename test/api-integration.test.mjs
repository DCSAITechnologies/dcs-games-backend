// Phase 1 HTTP-level exit gate. Boots the REAL server.mts in a child process
// against a temp data dir and local HS256 auth, then exercises the routes the
// Round-2 audit found exploitable. Run with: node --import tsx --test
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");
const SECRET = "integration-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-api-"));
const PORT = 8100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;

const ALICE = signLocalToken(SECRET, { sub: "user-alice", email: "alice@dcsai.ai", roles: ["internal_tester"] }, 3600);
const MALLORY = signLocalToken(SECRET, { sub: "user-mallory", email: "mallory@example.com" }, 3600);
const MALLORY_TESTER = signLocalToken(SECRET, { sub: "user-mallory", email: "mallory@example.com", roles: ["internal_tester"] }, 3600);

let proc;

function baseEnv(extra = {}) {
  return {
    ...process.env,
    PORT: String(PORT),
    DCS_AUTH_SECRET: SECRET,
    DCS_DATA_DIR: DATA,
    PAYMENTS_LIVE: "0",
    NODE_ENV: "test",
    // force the local/offline profile: no Supabase, no live LLM calls in CI
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    CEREBRAS_API_KEY: "",
    CEREBRAS_API_KEY_1: "",
    CEREBRAS_API_KEY_2: "",
    CEREBRAS_KEY_2: "",
    ...extra,
  };
}

async function boot(env) {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB, env, stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return p;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

const req = (p, o = {}) => fetch(BASE + p, o);
const auth = (t) => ({ Authorization: "Bearer " + t });
const json = (t, b) => ({ ...auth(t), "Content-Type": "application/json", ...(b ? {} : {}) });

before(async () => { proc = await boot(baseEnv()); });
after(() => { proc?.kill("SIGKILL"); fs.rmSync(DATA, { recursive: true, force: true }); });

test("health reports the truth about auth, persistence and payments", async () => {
  const r = await req("/health");
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.payments_live, false, "PAYMENTS_LIVE must stay false");
  assert.equal(b.auth, "local-hs256");
  assert.equal(b.auth_header_fallback_removed, true);
  assert.equal(b.persistence, "file", "persistence must name the real backend, not a guess");
});

// ---------------------------------------------------------------- A1 gate
test("A1 GATE: the exact live exploit is dead — bad token + forged x-user-id is 401", async () => {
  const r = await req("/api/worlds/mine", { headers: { Authorization: "Bearer nope", "x-user-id": "victim-uuid" } });
  const b = await r.json();
  assert.equal(r.status, 401, "production returned 200 with owner:victim-uuid before this fix");
  assert.equal(b.ok, false);
  assert.equal(b.error, "invalid_token");
  assert.ok(b.correlation_id, "every error carries a correlation id");
});

test("A1: x-user-id alone is 401 and names the removed header", async () => {
  const r = await req("/api/worlds/mine", { headers: { "x-user-id": "victim-uuid" } });
  const b = await r.json();
  assert.equal(r.status, 401);
  assert.equal(b.meta?.removed_header, "x-user-id");
});

test("A1: unauthenticated private routes are 401, not empty 200s", async () => {
  for (const p of ["/api/worlds/mine", "/api/me/revenue"]) {
    const r = await req(p);
    assert.equal(r.status, 401, `${p} must refuse anonymous callers`);
  }
});

test("A1: a valid token reaches the caller's OWN data only", async () => {
  const r = await req("/api/worlds/mine", { headers: auth(ALICE) });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.owner, "user-alice");
});

test("A1: a forged x-user-id is ignored when a valid token is present", async () => {
  const r = await req("/api/worlds/mine", { headers: { ...auth(ALICE), "x-user-id": "user-victim" } });
  const b = await r.json();
  assert.equal(b.owner, "user-alice", "the token wins; the header is never consulted");
});

test("A1/doctrine: builder surfaces refuse a non-tester with 403 and name the window", async () => {
  const r = await req("/worlds/generate", { method: "POST", headers: json(MALLORY), body: JSON.stringify({ prompt: "x" }) });
  const b = await r.json();
  assert.equal(r.status, 403);
  assert.equal(b.error, "forbidden");
  assert.equal(b.meta?.window_ends, "2026-09-30");
});

// ------------------------------------------------------- A3 gate + A4 honesty
let generatedId;

test("A3: an internal tester can generate a world and it is stamped with a real owner", async () => {
  const r = await req("/worlds/generate", { method: "POST", headers: json(ALICE), body: JSON.stringify({ prompt: "Ashfall Harbour, a rainy nordic port" }) });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.ok, true);
  assert.equal(b.owner, "user-alice");
  assert.equal(b.world_version, 1);
  assert.ok(b.manifest_hash, "a content hash is recorded for every world");
  generatedId = b.world_id;
});

test("A3 GATE: the world survives a full process restart and loads canonically identical", async () => {
  const before = await (await req(`/worlds/${generatedId}/manifest`, { headers: auth(ALICE) })).json();

  proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  proc = await boot(baseEnv());                       // brand new process, same data dir

  const r = await req(`/worlds/${generatedId}/manifest`, { headers: auth(ALICE) });
  assert.equal(r.status, 200, "the world must still exist after a restart");
  const after_ = await r.json();
  assert.deepEqual(after_, before, "the manifest must be byte-equivalent across the restart");
});

test("A3: IDOR — another creator cannot read the draft", async () => {
  const r = await req(`/worlds/${generatedId}/manifest`, { headers: auth(MALLORY) });
  assert.equal(r.status, 403);
});

test("A3: IDOR — another creator cannot overwrite the world", async () => {
  const r = await req(`/worlds/${generatedId}/save`, {
    method: "POST", headers: json(MALLORY_TESTER),
    body: JSON.stringify({ manifest: { hacked: true } }),
  });
  assert.equal(r.status, 403);
});

test("A3: save is idempotent and versions monotonically", async () => {
  const m = { manifest_version: "3.0.0", meta: { title: "Edited" }, zones: [{ id: "z1" }] };
  const a = await (await req(`/worlds/${generatedId}/save`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ manifest: m }) })).json();
  const b = await (await req(`/worlds/${generatedId}/save`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ manifest: m }) })).json();
  assert.equal(b.idempotent, true);
  assert.equal(b.world_version, a.world_version);
  const c = await (await req(`/worlds/${generatedId}/save`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ manifest: { ...m, meta: { title: "Edited again" } } }) })).json();
  assert.equal(c.world_version, a.world_version + 1);
});

test("A3: a stale expected_version is rejected with 409, not silently applied", async () => {
  const r = await req(`/worlds/${generatedId}/save`, {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ manifest: { x: 1 }, expected_version: 1 }),
  });
  assert.equal(r.status, 409);
});

// -------------------------------------------------------------- A4 honesty
test("A4: a missing world is a real 404 with a correlation id", async () => {
  const r = await req("/worlds/does-not-exist/manifest", { headers: auth(ALICE) });
  const b = await r.json();
  assert.equal(r.status, 404);
  assert.equal(b.ok, false);
  assert.ok(b.correlation_id);
});

test("A4: every response carries the correlation id as a header too", async () => {
  const r = await req("/health");
  assert.match(r.headers.get("x-correlation-id") || "", /^cid_/);
});

test("A4: a caller-supplied correlation id is honoured for cross-service tracing", async () => {
  const r = await req("/health", { headers: { "x-correlation-id": "cid_from_client" } });
  assert.equal(r.headers.get("x-correlation-id"), "cid_from_client");
});

test("A4/B10: publish refuses to claim success when no Atlas signing key exists", async () => {
  const r = await req(`/worlds/${generatedId}/publish`, { method: "POST", headers: json(ALICE) });
  const b = await r.json();
  assert.equal(r.status, 503, "an unsigned publish must not return ok:true");
  assert.equal(b.error, "not_configured");
  assert.match(b.detail, /ATLAS_PRIVATE_KEY/);
});

// ---------------------------------------------------------------- money dark
test("payments stay dark: revenue is zero and flagged, never fabricated", async () => {
  const b = await (await req("/api/me/revenue", { headers: auth(ALICE) })).json();
  assert.equal(b.payments_live, false);
  assert.equal(b.total_minor, 0);
  assert.deepEqual(b.payouts, []);
  assert.equal(b.dark, true);
});
