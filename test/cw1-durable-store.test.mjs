// CW1 must not run on an in-memory store in staging or production.
//
// Staging L1 (1 Oct 2026): every staging deployment logged
//   [cw1][db] IN-MEMORY FALLBACK ENGAGED (reason=repo_constructed_without_client)
// because server.mts mounted the T&S/KYC slice with a literal { mode: "memory" }.
// Everything CW1 held there was gone at each restart, and nothing stopped the
// process from serving. These tests were written before the fix and failed
// against it: the negative cases first (a staging or production boot without a
// durable CW1 client must EXIT NON-ZERO), then persistence across a real
// process restart against a database that outlives the process.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFakePostgrest } from "./fixtures/fake-postgrest.mjs";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = crypto.randomBytes(24).toString("hex");
const ATLAS = crypto.randomBytes(32).toString("base64");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dcs-cw1-"));
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// The real server, as a real process. Resolves when it exits or answers /health.
function bootServer(extraEnv) {
  const port = 9800 + Math.floor(Math.random() * 180);
  const data = tmp(); dirs.push(data);
  const env = {
    ...process.env, PORT: String(port), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: data,
    PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1", ATLAS_PRIVATE_KEY: ATLAS,
    DCS_INTERNAL_TESTERS: "tester@dcsai.ai",
    SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SERVICE_KEY: "", DATABASE_URL: "",
    CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
    DCS_ENV: "", RAILWAY_ENVIRONMENT_NAME: "", RAILWAY_ENVIRONMENT: "",
    ...extraEnv,
  };
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], { cwd: GB, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d)); proc.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => proc.on("exit", (code, signal) => r({ code, signal })));
  const result = (async () => {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const raced = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 150))]);
      if (raced) return { exited: true, ...raced, out };
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) return { exited: false, health: await r.json(), out };
      } catch { /* not up yet */ }
    }
    throw new Error("server neither exited nor became healthy:\n" + out.slice(-2000));
  })();
  return { proc, result, exited, stop: async () => { proc.kill("SIGKILL"); await exited; } };
}

// ---------------------------------------------------------------- negative first
test("NEGATIVE: DCS_ENV=staging with no CW1 Supabase client refuses to boot (exit non-zero)", async () => {
  const s = bootServer({ DCS_ENV: "staging" });
  const r = await s.result;
  if (!r.exited) await s.stop();
  assert.equal(r.exited, true, "it must not serve; /health answered instead");
  assert.notEqual(r.code, 0, "exit code must be non-zero");
  assert.match(r.out, /cw1/i);
  assert.match(r.out, /refusing to start/i);
});

test("NEGATIVE: DCS_ENV=production with no CW1 Supabase client refuses to boot (exit non-zero)", async () => {
  const s = bootServer({ DCS_ENV: "production" });
  const r = await s.result;
  if (!r.exited) await s.stop();
  assert.equal(r.exited, true, "it must not serve; /health answered instead");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /refusing to start/i);
});

test("NEGATIVE: DCS_ENV=staging with a client whose CW1 tables are unreachable refuses to boot", async () => {
  const pg = await startFakePostgrest({ failTables: ["dcsgames_users", "dcsgames_profiles"] });
  try {
    const s = bootServer({ DCS_ENV: "staging", SUPABASE_URL: pg.url, SUPABASE_SERVICE_ROLE_KEY: "fake-service-role" });
    const r = await s.result;
    if (!r.exited) await s.stop();
    assert.equal(r.exited, true, "a configured-but-unusable client is not a durable store");
    assert.notEqual(r.code, 0);
    assert.match(r.out, /dcsgames_users|dcsgames_profiles/);
  } finally { await pg.close(); }
});

test("NEGATIVE: on Railway with DCS_ENV unset, boot refuses rather than guessing local", async () => {
  const s = bootServer({ RAILWAY_ENVIRONMENT_NAME: "Staging" });
  const r = await s.result;
  if (!r.exited) await s.stop();
  assert.equal(r.exited, true);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /DCS_ENV/);
});

test("NEGATIVE: an unknown DCS_ENV refuses to boot", async () => {
  const s = bootServer({ DCS_ENV: "prod" });
  const r = await s.result;
  if (!r.exited) await s.stop();
  assert.equal(r.exited, true);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /DCS_ENV/);
});

// ---------------------------------------------------------------- where memory is permitted
for (const name of ["", "local", "test", "ci"]) {
  test(`memory fallback is permitted for DCS_ENV=${name || "(unset, not on Railway)"} and is reported as cw1_store=memory`, async () => {
    const s = bootServer({ DCS_ENV: name });
    const r = await s.result;
    try {
      assert.equal(r.exited, false, "local/test/CI must still boot without Supabase:\n" + r.out.slice(-1500));
      assert.equal(r.health.cw1_store, "memory");
    } finally { if (!r.exited) await s.stop(); }
  });
}

test("DCS_ENV=staging with a reachable client boots and reports cw1_store=supabase", async () => {
  const pg = await startFakePostgrest();
  try {
    const s = bootServer({ DCS_ENV: "staging", SUPABASE_URL: pg.url, SUPABASE_SERVICE_ROLE_KEY: "fake-service-role" });
    const r = await s.result;
    try {
      assert.equal(r.exited, false, r.out.slice(-1500));
      assert.equal(r.health.cw1_store, "supabase");
      assert.doesNotMatch(r.out, /IN-MEMORY FALLBACK ENGAGED/);
    } finally { if (!r.exited) await s.stop(); }
  } finally { await pg.close(); }
});

// ---------------------------------------------------------------- persistence across a process restart
// One child process writes through the CW1 store and exits; a SECOND process,
// with a fresh, empty data directory (so no file shadow can answer), reads.
const CHILD = `
  const { createCw1Store } = await import(${JSON.stringify(path.join(GB, "src/cw1/store.mjs"))});
  const [op, dir] = process.argv.slice(1);
  const store = await createCw1Store({ env: process.env, dir });
  const id = "8270dcf7-308a-4714-b541-395f30610b78";
  if (op === "write") {
    await store.repo.upsertUser({ id, username: "cw1-restart-probe", name: "Restart Probe" });
    await store.repo.updateProfile(id, { bio: "written before the restart" });
  }
  const user = await store.repo.getUser(id);
  const profile = await store.repo.getProfile(id);
  console.log(JSON.stringify({ mode: store.mode, user, profile }));
`;
function child(op, env) {
  const dir = tmp(); dirs.push(dir);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD, op, dir], { env: { ...process.env, DCS_ENV: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => code === 0 ? resolve(JSON.parse(out.trim().split("\n").pop())) : reject(new Error(`child ${op} exit ${code}: ${err}`)));
  });
}

test("create user + profile -> restart the process -> both still present (durable CW1 store)", async () => {
  const pg = await startFakePostgrest();
  try {
    const env = { SUPABASE_URL: pg.url, SUPABASE_SERVICE_ROLE_KEY: "fake-service-role" };
    const a = await child("write", env);
    assert.equal(a.mode, "supabase");
    assert.equal(a.user?.username, "cw1-restart-probe");
    const b = await child("read", env);                                 // new process, empty data dir
    assert.equal(b.mode, "supabase");
    assert.equal(b.user?.username, "cw1-restart-probe", "the user survived the restart");
    assert.equal(b.user?.name, "Restart Probe");
    assert.equal(b.profile?.bio, "written before the restart", "the profile survived the restart");
    // and it is in the database, in the v14 columns, not only in a file
    assert.equal(pg.rows("dcsgames_users")[0].display_name, "Restart Probe");
    assert.equal(pg.rows("dcsgames_profiles")[0].user_id, "8270dcf7-308a-4714-b541-395f30610b78");
  } finally { await pg.close(); }
});

test("control: the memory store loses the same user across the same restart (the test can see loss)", async () => {
  const env = { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SERVICE_KEY: "" };
  const a = await child("write", env);
  assert.equal(a.mode, "memory");
  assert.equal(a.user?.username, "cw1-restart-probe");
  const b = await child("read", env);
  assert.equal(b.user, null, "a memory store must NOT appear durable");
});

// ---------------------------------------------------------------- the served CW1 surfaces on a durable store
test("durable mode: the T&S/KYC slice never writes to process memory", async () => {
  const pg = await startFakePostgrest();
  try {
    const { createCw1Store } = await import("../src/cw1/store.mjs");
    const { handleTrustSafetySSO } = await import("../src/cw1/ts-sso-kyc-slice.mjs");
    const dir = tmp(); dirs.push(dir);
    const store = await createCw1Store({ env: { SUPABASE_URL: pg.url, SUPABASE_SERVICE_ROLE_KEY: "k" }, dir });
    assert.equal(store.mode, "supabase");
    assert.equal(store.repo._mem, undefined, "no in-memory map behind a durable repo");
    const call = async (method, url, user) => {
      let out;
      const req = Object.assign(require_stream(), { method, url });
      const handled = await handleTrustSafetySSO(req, {}, { user, repo: store.repo, send: (_res, code, json) => (out = { code, json }), body: async () => ({}) });
      return { handled, ...out };
    };
    // KYC: no durable table exists in v14, so it must refuse to write, not keep it in memory.
    const start = await call("POST", "/payout/kyc/start", { id: "8270dcf7-308a-4714-b541-395f30610b78" });
    assert.equal(start.code, 503);
    assert.equal(start.json.error, "kyc_store_not_provisioned");
    const kyc = await call("GET", "/payout/kyc", { id: "8270dcf7-308a-4714-b541-395f30610b78" });
    assert.equal(kyc.code, 200);
    assert.equal(kyc.json.status, "none");
    assert.equal(kyc.json.durable_store, "not_provisioned");
    // Moderation: a moderator is sent to the durable /safety surface.
    const mod = { id: "696a6131-82db-478c-8c39-59aeebeec65c", is_moderator: true };
    const q = await call("GET", "/ts/reports", mod);
    assert.equal(q.code, 410);
    assert.equal(q.json.superseded_by, "/safety/reports");
    const act = await call("POST", "/ts/reports/r1/action", mod);
    assert.equal(act.code, 410);
    // a non-moderator is still refused first, exactly as before
    assert.equal((await call("GET", "/ts/reports", { id: "8270dcf7-308a-4714-b541-395f30610b78" })).code, 403);
  } finally { await pg.close(); }
});

function require_stream() {
  // an empty readable request body
  return { [Symbol.asyncIterator]: async function* () {} };
}
