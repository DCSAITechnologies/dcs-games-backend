// A3 exit gate: create -> save -> restart -> load the same world, with canonical
// equivalence. "Restart" is simulated by constructing an entirely new repository
// over the same directory, which is exactly what a process restart does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWorldStore, WorldRepository, MirroredWorldStore, manifestHash, canonicalize } from "../src/core/worldstore.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dcs-worlds-"));

const richManifest = {
  manifest_version: "3.0.0",
  meta: { title: "Ashfall Harbour", seed: 1234, style: "weathered nordic port" },
  zones: [{ id: "docks", bounds: [0, 0, 120, 80] }, { id: "old_town", bounds: [120, 0, 240, 80] }],
  terrain: { heightmap: [[0, 1, 2], [1, 2, 3]], material: "wet_stone" },
  npcs: [{ id: "npc_harbourmaster", zone: "docks", dialogue: ["The tide is wrong today."] }],
  quests: [{ id: "q_missing_net", steps: ["find_net", "return_net"], reward: { item: "brass_hook" } }],
  environment: { weather: "rain", time_of_day: 0.72 },
  unicode_note: "héllo — 世界 — emoji \u{1f30d}",
};

test("A3 GATE: create -> save -> restart -> load returns a canonically identical world", async () => {
  const dir = tmp();
  const repo1 = new WorldRepository(new FileWorldStore(dir));
  const saved = await repo1.upsert({ worldId: "w_ashfall", ownerId: "user-alice", manifest: richManifest, state: "published" });
  assert.equal(saved.version, 1);

  // process restart: brand new store object, same disk
  const repo2 = new WorldRepository(new FileWorldStore(dir));
  const loaded = await repo2.get("w_ashfall", { requesterId: "user-alice" });

  assert.equal(canonicalize(loaded.manifest), canonicalize(richManifest), "manifest must round-trip losslessly");
  assert.equal(loaded.manifest_hash, manifestHash(richManifest));
  assert.equal(loaded.owner_id, "user-alice");
  assert.equal(loaded.title, "Ashfall Harbour");
  assert.deepEqual(loaded.manifest.terrain.heightmap, richManifest.terrain.heightmap, "nested arrays survive");
  assert.equal(loaded.manifest.unicode_note, richManifest.unicode_note, "unicode survives");
});

test("an identical re-save is idempotent and does not bump the version", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  const a = await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: richManifest });
  const b = await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: richManifest });
  assert.equal(b.idempotent, true);
  assert.equal(b.version, a.version);
});

test("a changed manifest bumps the version and the hash", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  const a = await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: richManifest });
  const b = await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: { ...richManifest, environment: { weather: "clear", time_of_day: 0.2 } } });
  assert.equal(b.version, a.version + 1);
  assert.notEqual(b.manifest_hash, a.manifest_hash);
});

test("IDOR: another user cannot overwrite a world they do not own", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await repo.upsert({ worldId: "w1", ownerId: "user-alice", manifest: richManifest });
  await assert.rejects(
    () => repo.upsert({ worldId: "w1", ownerId: "user-mallory", manifest: { hacked: true } }),
    (e) => e.httpStatus === 403
  );
});

test("IDOR: another user cannot read someone else's draft", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await repo.upsert({ worldId: "w1", ownerId: "user-alice", manifest: richManifest, state: "draft" });
  await assert.rejects(() => repo.get("w1", { requesterId: "user-mallory" }), (e) => e.httpStatus === 403);
});

test("a published world is readable by anyone", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await repo.upsert({ worldId: "w1", ownerId: "user-alice", manifest: richManifest, state: "published" });
  const r = await repo.get("w1", { requesterId: "user-bob" });
  assert.equal(r.world_id, "w1");
});

test("a missing world is a real 404, not an empty success", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await assert.rejects(() => repo.get("nope"), (e) => e.httpStatus === 404 && e.code === "not_found");
});

test("optimistic concurrency: a stale expected_version is a 409", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: richManifest });
  await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: { ...richManifest, meta: { title: "v2" } } });
  await assert.rejects(
    () => repo.upsert({ worldId: "w1", ownerId: "u1", manifest: { x: 1 }, expected_version: 1 }),
    (e) => e.httpStatus === 409
  );
});

test("listOwned only returns the caller's worlds", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await repo.upsert({ worldId: "a", ownerId: "u1", manifest: { a: 1 } });
  await repo.upsert({ worldId: "b", ownerId: "u2", manifest: { b: 1 } });
  const mine = await repo.listOwned("u1");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].world_id, "a");
});

test("a world id that would escape the data directory is rejected", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await assert.rejects(() => repo.upsert({ worldId: "../../etc/passwd", ownerId: "u1", manifest: {} }), (e) => e.httpStatus === 422);
});

test("a failing primary store does NOT report a clean success (no false ok:true)", async () => {
  const broken = {
    kind: "broken",
    put: async () => { throw new Error("supabase down"); },
    get: async () => { throw new Error("down"); },
    list: async () => { throw new Error("down"); },
    delete: async () => {},
  };
  const repo = new WorldRepository(new MirroredWorldStore(broken, new FileWorldStore(tmp())));
  const r = await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: richManifest });
  assert.equal(r._mirrored, false, "degradation must be reported to the caller");
  assert.match(r._mirror_error, /supabase down/);
  // and the world is still durably recoverable locally
  const back = await repo.get("w1", { requesterId: "u1" });
  assert.equal(back.manifest_hash, manifestHash(richManifest));
});

test("canonical hashing is key-order independent", () => {
  assert.equal(manifestHash({ a: 1, b: { c: 2, d: 3 } }), manifestHash({ b: { d: 3, c: 2 }, a: 1 }));
});
