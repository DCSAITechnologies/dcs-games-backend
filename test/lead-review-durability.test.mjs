// Lane G — does runtime state survive a restart, and does /health say where it
// lives?
//
// WHAT THIS FOUND, 7 Sep 2026. `GET /worlds/:id/load` had been made to tolerate
// a missing runtime snapshot. That is right for the case it names — a world
// created through POST /worlds/:id/save has never been through the runtime, so
// a load must not 500. But the tolerated condition is `base world ... not
// found`, which is ALSO what a runtime store that has lost everything produces,
// and without Supabase the store was `new InMemoryPersistenceStore()`. So an
// object saved at seq 1 and acknowledged `ok:true` was gone at the next
// restart, seq 1 was accepted again as a fresh delta, and the route reported
// the loss as `runtime_note: "this world has no runtime state yet"`. "Yet" is a
// claim about the past, and it was false.
//
// The Lead did not paper over that. There is now a FilePersistenceStore, a
// deployment without Supabase uses it instead of a Map, and /health names the
// store and whether it is durable. All four tests below now assert the fixed
// behaviour; the account of the defect is kept because the interaction between
// "tolerate a missing snapshot" and "the store is a Map" is not visible from
// either side alone.
//
// This suite boots the server, saves runtime state, restarts the process
// against the SAME data directory, and asks for it back.
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
import { InMemoryPersistenceStore, FilePersistenceStore } from "../src/cw5/cw5_persistence.ts";

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
const OBJ = () => `player_built_${RUN}`;

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
    ops: [
      { op: "place_object", object_id: OBJ(), kind: "structure", transform: { x: 1, y: 2, z: 3 }, owner_id: "user-d-owner" },
      { op: "set_inventory", player_id: "user-d-owner", inventory: [{ item_id: "lantern", qty: 1 }] },
      { op: "var_set", key: "door_open", value: true },
    ],
  });
  assert.equal(saved.status, 200, "the runtime delta is accepted: " + saved.text.slice(0, 200));
  assert.equal(saved.body.seq, 1);

  const before_ = await call("GET", `/worlds/${world}/load`);
  assert.ok(
    (before_.body.runtime_state?.objects || []).some((o) => o.object_id === OBJ()),
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

test("CLOSED (was DEFECT, OPEN): acknowledged runtime state survives a restart", async () => {
  const r = await call("GET", `/worlds/${world}/load`);
  assert.equal(r.status, 200, "the load succeeds");

  const state = r.body.runtime_state;
  assert.ok(state, "there is runtime state at all: " + JSON.stringify(r.body.runtime_note));

  const obj = (state.objects || []).find((o) => o.object_id === OBJ());
  assert.ok(obj, "the object the server acknowledged with ok:true and seq 1 is still there");
  assert.deepEqual(obj.transform, { x: 1, y: 2, z: 3 }, "with the transform it was saved with");
  assert.equal(obj.owner_id, "user-d-owner", "and its owner, which is what livestate reads to protect it");

  // The other two op kinds in the same delta, because a store that keeps
  // objects and drops inventories would pass a weaker test.
  assert.deepEqual(state.inventories["user-d-owner"], [{ item_id: "lantern", qty: 1 }]);
  assert.equal(state.vars.door_open, true);
});

test("CLOSED (was DEFECT, OPEN): the load note no longer asserts a history it cannot know", async () => {
  // WAS: "this world has no runtime state yet" — said for a world that had
  // saved state and lost it, because the route cannot tell "never saved" from
  // "saved and lost" and resolved the ambiguity in the reassuring direction.
  const r = await call("GET", `/worlds/${world}/load`);
  assert.equal(r.body.runtime_note, undefined, "a world WITH runtime state gets no note at all");

  // A world that genuinely never had any still answers 200 rather than 500 —
  // the case the tolerance was added for — and the wording no longer claims to
  // know that nothing was ever saved.
  const fresh = `neverplayed_${RUN}`;
  assert.equal((await call("POST", `/worlds/${fresh}/save`, { manifest: { meta: { title: "never entered" } } })).status, 200);
  const none = await call("GET", `/worlds/${fresh}/load`);
  assert.equal(none.status, 200, "a save-then-load still works");
  assert.equal(none.body.runtime_state, null);
  assert.doesNotMatch(
    String(none.body.runtime_note), /yet/,
    `"${none.body.runtime_note}" must not imply that nothing was ever saved — the route cannot know that`
  );
});

test("CLOSED (was DEFECT, OPEN): a used seq is still refused after a restart", async () => {
  // save() is documented append-only, idempotent and monotonic. Across a restart
  // none of the three survived a Map: seq 1 was neither refused as
  // non-monotonic nor reported as a duplicate, so a client replaying its outbox
  // wrote a second, different delta at a seq the server had already
  // acknowledged.
  const replay = await call("POST", `/worlds/${world}/save`, {
    seq: 1, ops: [{ op: "var_set", key: `after_restart_${RUN}`, value: 1 }],
  });
  assert.ok(
    replay.status !== 200 || replay.body.duplicate === true,
    `seq 1 was accepted a second time as a fresh delta (${replay.status} ${JSON.stringify(replay.body)})`
  );

  // And the world was not altered by the attempt.
  const after = await call("GET", `/worlds/${world}/load`);
  assert.equal(after.body.runtime_state.vars[`after_restart_${RUN}`], undefined);

  // A genuinely new seq still works, so the store is refusing the replay rather
  // than refusing everything.
  const next = await call("POST", `/worlds/${world}/save`, {
    seq: 2, ops: [{ op: "var_set", key: `next_${RUN}`, value: 2 }],
  });
  assert.equal(next.status, 200, "the next seq is accepted: " + next.text.slice(0, 160));
  const grown = await call("GET", `/worlds/${world}/load`);
  assert.equal(grown.body.runtime_state.vars[`next_${RUN}`], 2);
});

test("CLOSED (was DEFECT, OPEN): /health names the runtime state store and whether it is durable", async () => {
  // /health named the kind of every other store — `persistence` for the world
  // repository, safety_persistence, verification, player_progress, cors.mode,
  // build.source — and was silent about the one holding what players built,
  // while `live_state` reported it AVAILABLE with owned entities AVAILABLE.
  // That mattered beyond reporting: livestate reads that source to decide
  // whether a rollback may delete a player's property, and an emptied store
  // answers "AVAILABLE, and they own nothing", which is the answer that
  // licenses the deletion.
  const h = (await call("GET", "/health", undefined, false)).body;
  assert.ok(h.runtime_state_store, "the runtime store is described at all");
  assert.equal(h.runtime_state_store.kind, "file", "this deployment has no Supabase, so it is the file store");
  assert.equal(h.runtime_state_store.durable, true, "and it says whether that survives a restart");

  const src = (h.live_state?.sources || []).find((s) => s.name === "cw5-runtime-state");
  assert.ok(src, "the live-state source is still reported");
  assert.equal(src.status, "AVAILABLE", "and it is genuinely available now, not merely claiming to be");
});

// ---------------------------------------------------------------------------
// The new store itself. It is code written today and reviewed by its author.
// ---------------------------------------------------------------------------

test("DEFECT, OPEN: the two persistence stores disagree about base-world immutability", async () => {
  // FilePersistenceStore.putBaseWorld carries the comment "Same contract as the
  // in-memory store: a base world is written once." It is not the same
  // contract. InMemoryPersistenceStore THROWS on a second write — the guard is
  // labelled "BASE IMMUTABILITY GUARD: base is Atlas-signed; never overwrite
  // once set" — and the file store returns silently.
  //
  // The data is safe either way; what differs is whether a caller is told. A
  // second registerBaseWorld is a 500 on a Supabase-less deployment today and a
  // silent success tomorrow when the file store is in use, so the same bug in a
  // caller is loud in one environment and invisible in the other — and the
  // comment tells the next reader they need not check.
  //
  // Either behaviour is defensible. They have to be the same one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-g-store-"));
  const base = { world_id: "w_immutable", schema_version: "1.0", objects: [{ object_id: "o1", kind: "structure", transform: {}, owner_id: null }] };
  const outcomes = {};
  for (const [name, store] of [["memory", new InMemoryPersistenceStore()], ["file", new FilePersistenceStore(dir)]]) {
    await store.putBaseWorld(base);
    try {
      await store.putBaseWorld({ ...base, objects: [] });
      outcomes[name] = "accepted silently";
    } catch (e) {
      outcomes[name] = "threw";
    }
    // Both must at least protect the data.
    assert.equal((await store.getBaseWorld("w_immutable")).objects.length, 1, `${name} keeps the original base`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(
    outcomes.file, outcomes.memory,
    `the in-memory store ${outcomes.memory} a second putBaseWorld and the file store ${outcomes.file}, ` +
    "while the file store's comment says they share a contract. Whichever is right, a deployment must not " +
    "change whether an overwrite attempt is an error."
  );
});

test("DISPROVED: the file delta store does not degrade as a world's history grows", async () => {
  // Hypothesis: every save re-reads and re-parses the whole .deltas.jsonl (in
  // load(), getMaxSeq() and hasSeq()), nothing ever calls writeSnapshot(), and
  // the file is append-only — so a long-lived world should get slower to save
  // in proportion to its own history, which is the cliff the creator dashboard
  // was just fixed for.
  //
  // Measured: 400 sequential deltas on one world stayed at ~1-3 ms per save
  // (37 KB of JSONL), and the load after them took 2.3 ms. The constant is small
  // enough that the linearity does not bite at any size this estate will see
  // during the test window. Recorded rather than fixed: it IS linear, and a
  // world with a hundred thousand deltas would feel it, so the absence of any
  // caller for writeSnapshot() is worth knowing.
  const w = `growth_${RUN}`;
  assert.equal((await call("POST", `/worlds/${w}/save`, { manifest: { meta: { title: "growth" } } })).status, 200);

  const timeSave = async (seq) => {
    const t = process.hrtime.bigint();
    const r = await call("POST", `/worlds/${world}/save`, { seq, ops: [{ op: "var_set", key: "k" + seq, value: seq }] });
    assert.equal(r.status, 200, `seq ${seq}: ${r.text.slice(0, 120)}`);
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const early = [];
  for (let seq = 100; seq < 110; seq++) early.push(await timeSave(seq));
  for (let seq = 110; seq < 300; seq++) await timeSave(seq);
  const late = [];
  for (let seq = 300; seq < 310; seq++) late.push(await timeSave(seq));

  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  assert.ok(
    median(late) < Math.max(median(early) * 6, 40),
    `save cost went from ${median(early).toFixed(1)}ms to ${median(late).toFixed(1)}ms over 200 deltas`
  );
});
