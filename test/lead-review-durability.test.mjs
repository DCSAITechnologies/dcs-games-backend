// Lane G — what "GET /worlds/:id/load tolerates a missing runtime snapshot"
// costs, and what /health does not say about it.
//
// The Lead's change (server.mts:2100) is right about the case it names: a world
// created through POST /worlds/:id/save has never been through the runtime, so
// a load must not 500. But the tolerated condition is `base world ... not
// found`, and that is ALSO the condition produced when the runtime store has
// lost everything it was holding — which, whenever Supabase is not configured,
// is what happens at every restart, because server.mts:67 falls back to
// `new InMemoryPersistenceStore()`.
//
// So the route that used to answer 500 for a lost world now answers 200 with
// `runtime_note: "this world has no runtime state yet"`. "Yet" is a claim about
// the past, and in this case it is false: the state was saved, acknowledged with
// ok:true and a seq, and is gone.
//
// This suite boots the server, saves runtime state, restarts the process against
// the SAME data directory, and asks for it back.
//
// Run: node --import tsx --test test/lead-review-durability.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "lead-review-durability-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-lead-dur-"));
const PORT = 8860 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = crypto.randomBytes(4).toString("hex");
const ATLAS = crypto.randomBytes(32).toString("base64");
const OWNER = signLocalToken(SECRET, { sub: "user-d-owner", email: "d-owner@dcsai.ai", roles: ["internal_tester"] }, 7200);

let proc;
let world;

function spawnServer() {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env,
      PORT: String(PORT), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA,
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1",
      ATLAS_PRIVATE_KEY: ATLAS, DCS_INTERNAL_TESTERS: "d-owner@dcsai.ai",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
      DEEPSEEK_API_KEY: "", TOGETHER_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  return p;
}

async function healthy() {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

async function call(method, url, body, auth = true) {
  const headers = {};
  if (auth) headers.Authorization = "Bearer " + OWNER;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

before(async () => {
  proc = spawnServer();
  await healthy();
  await call("POST", "/safety/age", { date_of_birth: "1990-01-01", method: "synthetic_test" });
  for (let i = 0; i < 12 && !world; i++) {
    const r = await call("POST", "/v3/worlds/generate", { prompt: `a durable world ${RUN} ${i}` });
    if (r.status === 200) world = r.body.world_id;
  }
  assert.ok(world, "a world was generated");

  const saved = await call("POST", `/worlds/${world}/save`, {
    seq: 1,
    ops: [{ op: "place_object", object_id: `player_built_${RUN}`, kind: "structure", transform: { x: 1, y: 2, z: 3 }, owner_id: "user-d-owner" }],
  });
  assert.equal(saved.status, 200, "the runtime delta is accepted: " + saved.text.slice(0, 200));
  assert.equal(saved.body.seq, 1);

  const before_ = await call("GET", `/worlds/${world}/load`);
  assert.ok(
    (before_.body.runtime_state?.objects || []).some((o) => o.object_id === `player_built_${RUN}`),
    "and it is in the world before the restart"
  );

  // Restart, same data directory — a redeploy, in other words.
  proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 400));
  proc = spawnServer();
  await healthy();
});

after(() => {
  proc?.kill("SIGKILL");
  fs.rmSync(DATA, { recursive: true, force: true });
});

test("DEFECT, OPEN: acknowledged runtime state is lost at restart and load calls it 'not yet'", async () => {
  const r = await call("GET", `/worlds/${world}/load`);
  assert.equal(r.status, 200, "the load succeeds");

  const objects = r.body.runtime_state?.objects || [];
  assert.ok(
    objects.some((o) => o.object_id === `player_built_${RUN}`),
    "an object the server acknowledged with ok:true and seq 1 is not in the world after a restart. " +
    "server.mts:67 uses InMemoryPersistenceStore whenever Supabase is not configured — which is every " +
    "file-mode deployment, every CI run, and any deploy that loses its Supabase variables — so the " +
    `append-only delta store is emptied by the restart. Observed runtime_state=${JSON.stringify(r.body.runtime_state)}, ` +
    `runtime_note=${JSON.stringify(r.body.runtime_note)}.`
  );
});

test("DEFECT, OPEN: 'no runtime state yet' is asserted for a world that HAD runtime state", async () => {
  // Even granting the loss, the note is a positive claim about history and it is
  // wrong. The route cannot tell "never had any" from "had some and lost it",
  // and it resolves the ambiguity in the reassuring direction. The previous
  // behaviour — a 500 — was wrong about the first case and right about this one;
  // the new behaviour is the reverse, and this one is the dangerous direction.
  const r = await call("GET", `/worlds/${world}/load`);
  assert.notEqual(
    r.body.runtime_note, "this world has no runtime state yet",
    "this world had runtime state; it was accepted at seq 1 before the restart. A load that cannot " +
    "distinguish 'never saved' from 'saved and lost' must not assert the first."
  );
});

test("DEFECT, OPEN: a seq the store already accepted is accepted again after a restart", async () => {
  // save() is documented append-only, idempotent and monotonic. Across a restart
  // none of the three survives: seq 1 is neither refused as non-monotonic nor
  // reported as a duplicate, so a client replaying its outbox writes a second,
  // different delta at a seq the server already acknowledged.
  const again = await call("POST", `/worlds/${world}/save`, {
    seq: 1, ops: [{ op: "var_set", key: `after_restart_${RUN}`, value: 1 }],
  });
  assert.ok(
    again.status !== 200 || again.body.duplicate === true,
    `seq 1 was accepted a second time as a fresh delta (${again.status} ${JSON.stringify(again.body)}). ` +
    "The engine's monotonic and duplicate guarantees are only as durable as the store beneath them."
  );
});

test("DEFECT, OPEN: /health does not say the runtime state store is in-memory", async () => {
  // /health names the kind of every other store — `persistence: "file"` for the
  // world repository, `safety_persistence`, `verification`, `player_progress`,
  // `cors.mode`, `build.source`. The cw5 runtime store, the one holding what
  // players built, is the exception: `live_state` reports the source
  // "cw5-runtime-state" as AVAILABLE with owned entities AVAILABLE, which is
  // true only until the next restart, and nothing in the document says which
  // store is answering.
  //
  // This matters beyond reporting: livestate reads exactly this source to decide
  // whether a rollback or an expansion may delete a player's property. After a
  // restart in file mode it answers "AVAILABLE, and they own nothing", which is
  // the answer that licenses the deletion.
  const h = (await call("GET", "/health", undefined, false)).body;
  const src = (h.live_state?.sources || []).find((s) => s.name === "cw5-runtime-state");
  assert.ok(src, "the live-state source is reported");
  assert.ok(
    typeof src.store === "string" || typeof h.runtime_persistence === "string",
    "/health reports persistence:\"" + h.persistence + "\" for the world store but says nothing about " +
    "which store is behind cw5-runtime-state. It reports " + JSON.stringify(src) + ", and in this " +
    "process that source is an in-memory Map that the restart above emptied."
  );
});
