// Games-C persistence-delta module, as REGISTERED in server.mts by Games-B.
//
//   flag OFF (default)   both routes are this server's 404; /health says not
//                        registered and advertises no multiplayer routes
//   flag ON, no token    not registered, and /ready says so (503)
//   flag ON + token      the netcode service token (not a user JWT) reaches the
//                        module; the permission check is the INTERNAL publish
//                        control: a published world takes deltas only from its
//                        owner or an internal tester; drafts owner-only; replay
//                        works (also under /api/) and survives a restart
//   flag ON + public     the Games-C contract as written: any player may change
//                        a published world
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = crypto.randomBytes(24).toString("hex");
const TOKEN = "ingest-" + crypto.randomBytes(24).toString("hex");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-pdelta-"));

// Seed a published world and a draft straight into the store the server reads.
process.env.DCS_DATA_DIR = DATA;
const { createWorldRepository } = await import(path.join(GB, "src/core/worldstore.mjs"));
const repo = createWorldRepository({ DCS_DATA_DIR: DATA });
await repo.upsert({ worldId: "world-pub", ownerId: "owner-1", manifest: { title: "pub" }, state: "published" });
await repo.upsert({ worldId: "world-draft", ownerId: "owner-1", manifest: { title: "draft" }, state: "draft" });

function userJwt(sub) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "HS256", typ: "JWT" }), b = enc({ sub, iss: "dcs-games-local", iat: now, exp: now + 3600 });
  return `${h}.${b}.${crypto.createHmac("sha256", SECRET).update(`${h}.${b}`).digest("base64url")}`;
}

const running = [];
async function boot(extra = {}) {
  const port = 11000 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PORT: String(port), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA, NODE_ENV: "test", PAYMENTS_LIVE: "0",
    DCS_PROVIDERS_OFFLINE: "1", DCS_INTERNAL_TESTERS: "tester-1", ATLAS_PRIVATE_KEY: crypto.randomBytes(32).toString("base64"),
    SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "", CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
    DCS_PUBLISH_VISIBILITY: "", DCS_MULTIPLAYER_ENABLED: "", DCS_NETCODE_INGEST_TOKEN: "", DCS_PERSISTENCE_DELTA_DIR: "",
    ...extra,
  };
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], { cwd: GB, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  const exited = new Promise((r) => proc.once("exit", r));
  const s = { proc, base, exited };
  running.push(s);
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + "/health")).ok) return s; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}
async function stop(s) { s.proc.kill("SIGKILL"); await s.exited; }
after(async () => { for (const s of running) { try { s.proc.kill("SIGKILL"); } catch { /* gone */ } } fs.rmSync(DATA, { recursive: true, force: true }); });

let n = 0;
const delta = (o = {}) => ({
  delta_id: `d-${Date.now().toString(36)}-${(n++).toString(36)}-abcd`, op: "place", session_id: "s-1", world_id: "world-pub",
  actor_entity_id: "e-1", actor_user_id: "tester-1", tick: 5,
  payload: { entity_id: "crate-" + n, object_type: "crate", position: { x: 1, y: 0, z: 2 }, rotation: { yaw: 0 } },
  ts: new Date().toISOString(), ...o,
});
async function post(base, d, token = TOKEN, prefix = "") {
  const r = await fetch(`${base}${prefix}/persistence/delta`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": d.delta_id }, body: JSON.stringify(d),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const replay = async (base, world, prefix = "", token = TOKEN) => {
  const r = await fetch(`${base}${prefix}/persistence/delta/replay?world_id=${world}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test("flag OFF (default): both routes are 404, nothing is stored, /health says not registered", async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(`${s.base}/persistence/delta`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${s.base}/api/persistence/delta`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${s.base}/persistence/delta/replay?world_id=world-pub`)).status, 404);
    const withToken = await post(s.base, delta());
    assert.notEqual(withToken.status, 200, "a service token cannot reach an unregistered route");
    const h = await (await fetch(`${s.base}/health`)).json();
    assert.equal(h.multiplayer.flag_enabled, false);
    assert.equal(h.multiplayer.persistence_delta.registered, false);
    assert.equal(h.multiplayer.persistence_delta.reason, "flag_off");
    assert.deepEqual(h.multiplayer.routes, []);
    assert.equal(h.routes.multiplayer, undefined, "no multiplayer route is advertised when OFF");
    const ready = await fetch(`${s.base}/ready`);
    assert.equal(ready.status, 200, "flag OFF is a valid preview configuration");
    assert.equal(fs.existsSync(path.join(DATA, "persistence-delta")), false, "nothing written with the flag OFF");
  } finally { await stop(s); }
});

test("flag ON without a service token: not registered, and /ready reports the misconfiguration", async () => {
  const s = await boot({ DCS_MULTIPLAYER_ENABLED: "1" });
  try {
    assert.equal((await fetch(`${s.base}/persistence/delta/replay?world_id=world-pub`)).status, 404);
    const h = await (await fetch(`${s.base}/health`)).json();
    assert.equal(h.multiplayer.flag_enabled, true);
    assert.equal(h.multiplayer.persistence_delta.registered, false);
    assert.equal(h.multiplayer.persistence_delta.reason, "token_unset");
    const r = await fetch(`${s.base}/ready`);
    const b = await r.json();
    assert.equal(r.status, 503);
    assert.ok(b.failing.includes("multiplayer_persistence_delta"));
  } finally { await stop(s); }
});

test("flag ON + token, INTERNAL visibility: service token reaches the module; the publish control decides who may change a world", async () => {
  const s = await boot({ DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_INGEST_TOKEN: TOKEN });
  try {
    const h = await (await fetch(`${s.base}/health`)).json();
    assert.equal(h.multiplayer.persistence_delta.registered, true);
    assert.equal(h.multiplayer.persistence_delta.store, "file");
    assert.deepEqual(h.routes.multiplayer, ["POST /persistence/delta", "GET /persistence/delta/replay"]);
    assert.equal((await fetch(`${s.base}/ready`)).status, 200);

    const t = await post(s.base, delta({ actor_user_id: "tester-1" }));
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.seq, 1);
    assert.equal((await post(s.base, delta({ actor_user_id: "owner-1" }))).status, 200, "the owner may change their published world");
    const stranger = await post(s.base, delta({ actor_user_id: "player-9" }));
    assert.equal(stranger.status, 404, "a non-tester gets the same answer as a world that does not exist");
    assert.equal(stranger.body.error, "world_not_found");
    assert.equal((await post(s.base, delta({ world_id: "world-draft", actor_user_id: "tester-1" }))).status, 404, "a draft is owner-only, testers included");
    assert.equal((await post(s.base, delta({ world_id: "world-draft", actor_user_id: "owner-1" }))).status, 200);
    assert.equal((await post(s.base, delta({ world_id: "world-none" }))).status, 404);

    // Service auth only: a wrong token, and a USER credential, are both refused.
    assert.equal((await post(s.base, delta(), "wrong-token-0123456789abcdef0123456789")).status, 401);
    assert.equal((await post(s.base, delta(), userJwt("tester-1"))).status, 401);

    // Idempotency: same id + same content is a duplicate; same id + different content is a conflict.
    const d = delta();
    assert.equal((await post(s.base, d)).status, 200);
    const again = await post(s.base, d);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal((await post(s.base, { ...d, tick: 99 })).status, 409);

    const rp = await replay(s.base, "world-pub", "/api");
    assert.equal(rp.status, 200);
    assert.equal(rp.body.deltas.length, 3);
    assert.deepEqual(rp.body.deltas.map((x) => x.seq), [1, 2, 3]);
    assert.equal((await replay(s.base, "world-pub", "", userJwt("tester-1"))).status, 401);
    assert.equal(fs.readdirSync(path.join(DATA, "persistence-delta")).length, 2, "one log per world under DCS_DATA_DIR");
  } finally { await stop(s); }
});

test("flag ON: the delta log survives a restart and replays in order", async () => {
  const s = await boot({ DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_INGEST_TOKEN: TOKEN });
  try {
    const rp = await replay(s.base, "world-pub");
    assert.equal(rp.status, 200);
    assert.deepEqual(rp.body.deltas.map((x) => x.seq), [1, 2, 3]);
    const next = await post(s.base, delta());
    assert.equal(next.body.seq, 4, "the sequence continues after a restart");
  } finally { await stop(s); }
});

test("flag ON + PUBLIC visibility: the Games-C contract as written — any player may change a published world", async () => {
  const s = await boot({ DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_INGEST_TOKEN: TOKEN, DCS_PUBLISH_VISIBILITY: "public" });
  try {
    assert.equal((await post(s.base, delta({ actor_user_id: "player-9" }))).status, 200);
    assert.equal((await post(s.base, delta({ world_id: "world-draft", actor_user_id: "player-9" }))).status, 404);
  } finally { await stop(s); }
});
