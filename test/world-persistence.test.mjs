// A3 exit gate: create -> save -> restart -> load the same world, with canonical
// equivalence. "Restart" is simulated by constructing an entirely new repository
// over the same directory, which is exactly what a process restart does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  FileWorldStore, WorldRepository, MirroredWorldStore, VersionHistoryStore,
  SupabaseWorldStore, SupabaseVersionHistoryStore, MirroredVersionHistoryStore,
  createWorldRepository, manifestHash, canonicalize,
} from "../src/core/worldstore.mjs";

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
  // Refused as 404, not 403: see the oracle test at the end of this file. The
  // property under test here is that the draft does not come back.
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await repo.upsert({ worldId: "w1", ownerId: "user-alice", manifest: richManifest, state: "draft" });
  await assert.rejects(() => repo.get("w1", { requesterId: "user-mallory" }), (e) => e.httpStatus === 404);
  await assert.rejects(() => repo.get("w1", { requesterId: null }), (e) => e.httpStatus === 404);
  assert.equal((await repo.get("w1", { requesterId: "user-alice" })).state, "draft", "and its creator still has it");
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

// ---------------------------------------------------- retained version history
//
// Migration 0003 declared dcsgames_world_versions for the B6 rollback
// requirement and nothing ever wrote to it. The table existed, the feature it
// was for could not work, and the gap was invisible because no code referenced
// the table at all.

const versioned = () => {
  const d = tmp();
  return new WorldRepository(new FileWorldStore(path.join(d, "w")), new VersionHistoryStore(path.join(d, "v")));
};

test("A3 GATE: every accepted version is retained, so a rollback has a target", async () => {
  const repo = versioned();
  for (const n of [1, 2, 3]) await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: { meta: { title: "V" + n }, n } });
  const versions = await repo.listVersions("w1", { requesterId: "u1" });
  assert.deepEqual(versions.map((v) => v.version), [1, 2, 3]);
  assert.equal((await repo.getVersion("w1", 2, { requesterId: "u1" })).manifest.meta.title, "V2");
});

test("A3 GATE: a retained version is IMMUTABLE — history cannot be rewritten", async () => {
  const repo = versioned();
  await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: { meta: { title: "V1" } } });
  const original = await repo.getVersion("w1", 1, { requesterId: "u1" });
  // Force a write at the same version, as a buggy caller or a replay might.
  await repo.versions.put("w1", 1, { world_id: "w1", version: 1, manifest: { meta: { title: "TAMPERED" } }, manifest_hash: "x", created_at: new Date().toISOString() });
  const after = await repo.getVersion("w1", 1, { requesterId: "u1" });
  assert.deepEqual(after.manifest, original.manifest, "an already-recorded version must never be overwritten");
});

test("A3: an idempotent re-save does not create a duplicate version", async () => {
  const repo = versioned();
  const m = { meta: { title: "V1" }, a: 1 };
  await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: m });
  await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: m });
  assert.deepEqual((await repo.listVersions("w1", { requesterId: "u1" })).map((v) => v.version), [1]);
});

test("A3: version history respects the same permissions as the world", async () => {
  // The world is checked FIRST, so a draft world takes its history with it. A
  // stranger gets the world's own refusal — which is a 404, because the world
  // itself must not be confirmed to exist.
  const repo = versioned();
  await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: { meta: { title: "V1" } }, state: "draft" });
  await assert.rejects(() => repo.listVersions("w1", { requesterId: "stranger" }), (e) => e.httpStatus === 404);
  await assert.rejects(() => repo.getVersion("w1", 1, { requesterId: "stranger" }), (e) => e.httpStatus === 404);
  await assert.rejects(() => repo.getVersion("w1", 99, { requesterId: "u1" }), (e) => e.httpStatus === 404);
  assert.deepEqual((await repo.listVersions("w1", { requesterId: "u1" })).map((v) => v.version), [1]);
});

test("A3: an unsafe world id or version cannot escape the version directory", async () => {
  const repo = versioned();
  await assert.rejects(() => repo.versions.put("../../etc/passwd", 1, {}), (e) => e.httpStatus === 422);
  await assert.rejects(() => repo.versions.put("w1", -1, {}), (e) => e.httpStatus === 422);
});

// =============================================================================
// Lane N — the defects Lane J and Lane L reproduced against this store.
// Every test below fails against the code as it was, and each names the
// property it is protecting rather than the line that used to break it.
// =============================================================================

// ------------------------------------------------------ ids and sidecar names
//
// A world id may contain a dot, so `<id>.json` and `<id>.summary.json` were two
// namespaces sharing one directory: the RECORD of world "x.summary" and the
// SIDECAR of world "x" were the same file.

test("a world id ending in .summary is not another world's cache", async () => {
  const dir = tmp();
  const repo = new WorldRepository(new FileWorldStore(dir));
  await repo.upsert({ worldId: "alpha.summary", ownerId: "user-alice", manifest: { meta: { title: "Alice's World" } }, state: "published" });
  // Mallory saves the world whose sidecar wants Alice's record's old name.
  await repo.upsert({ worldId: "alpha", ownerId: "user-mallory", manifest: { meta: { title: "Mallory's World" } }, state: "published" });

  const alice = await repo.get("alpha.summary", { requesterId: "user-alice" });
  assert.equal(alice.owner_id, "user-alice", "saving one world must not rewrite another world's owner");
  assert.equal(alice.title, "Alice's World");
  assert.equal(alice._summary, undefined, "a cache file must never be served as a world record");
  assert.equal(canonicalize(alice.manifest), canonicalize({ meta: { title: "Alice's World" } }), "and the manifest is still there");

  // Alice still owns her world: she can write to it, and Mallory cannot.
  const next = await repo.upsert({ worldId: "alpha.summary", ownerId: "user-alice", manifest: { meta: { title: "Alice's World II" } } });
  assert.equal(next.version, 2);
  await assert.rejects(
    () => repo.upsert({ worldId: "alpha.summary", ownerId: "user-mallory", manifest: { hacked: true } }),
    (e) => e.httpStatus === 403,
    "the id must not have been taken over",
  );
  assert.equal((await repo.get("alpha", { requesterId: "user-mallory" })).owner_id, "user-mallory", "and Mallory's own world is intact");
});

test("a world id ending in .summary is listed, not skipped as a cache file", async () => {
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await repo.upsert({ worldId: "beta.summary", ownerId: "u1", manifest: { meta: { title: "Beta" } }, state: "published" });

  assert.deepEqual((await repo.listOwned("u1")).map((w) => w.world_id), ["beta.summary"], "listOwned must not lose a world get() returns");
  assert.deepEqual((await repo.listPublished()).map((w) => w.world_id), ["beta.summary"], "and neither may discovery");
});

test("a record left at the pre-fix colliding path keeps working, and is moved rather than overwritten", async () => {
  const dir = tmp();
  const store = new FileWorldStore(dir);
  const repo = new WorldRepository(store);
  // Exactly what an earlier build wrote for world "gamma.summary".
  fs.writeFileSync(path.join(dir, "gamma.summary.json"), JSON.stringify({
    world_id: "gamma.summary", owner_id: "user-alice", title: "Legacy", state: "published", version: 3,
    manifest: { meta: { title: "Legacy" } }, manifest_hash: "legacy-hash", manifest_version: "3.1.0",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  }));

  assert.equal((await store.get("gamma.summary")).owner_id, "user-alice", "an id already in use must keep resolving");
  assert.deepEqual((await store.list({})).map((r) => r.world_id), ["gamma.summary"], "and must keep being listed");

  await repo.upsert({ worldId: "gamma", ownerId: "user-mallory", manifest: { meta: { title: "Mallory" } }, state: "published" });
  assert.equal((await store.get("gamma.summary")).owner_id, "user-alice", "the legacy record is rescued, not destroyed by a cache write");
  assert.deepEqual(
    (await store.list({ summary: true })).map((r) => r.world_id).sort(), ["gamma", "gamma.summary"],
    "both worlds exist, and each appears exactly once",
  );
});

// -------------------------------------------------------- the listing sidecar
//
// The record is the truth and the sidecar is only ever a cache of it. These are
// the ways that stopped being true.

const published = (dir) => {
  const store = new FileWorldStore(dir);
  return { store, repo: new WorldRepository(store) };
};

test("a corrupt sidecar costs a read, not a row", async () => {
  const dir = tmp();
  const { store, repo } = published(dir);
  await repo.upsert({ worldId: "w_corrupt", ownerId: "o", manifest: { meta: { title: "Real" } }, state: "published" });
  fs.writeFileSync(path.join(dir, "w_corrupt.summary.json"), '{"world_id":"w_corr');   // truncated

  const cards = await store.list({ state: "published", summary: true });
  assert.deepEqual(cards.map((r) => r.world_id), ["w_corrupt"], "a cache miss must fall back to the record");
  assert.equal(cards[0].title, "Real");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "w_corrupt.summary.json"), "utf8")).title, "Real", "and the cache is repaired");
});

test("a missing sidecar costs a read, not a row", async () => {
  const dir = tmp();
  const { store, repo } = published(dir);
  await repo.upsert({ worldId: "w_nocache", ownerId: "o", manifest: { meta: { title: "Real" } }, state: "published" });
  fs.rmSync(path.join(dir, "w_nocache.summary.json"));

  assert.deepEqual((await store.list({ summary: true })).map((r) => r.world_id), ["w_nocache"]);
});

test("the sidecar repair is atomic, so concurrent repairs cannot truncate it", async () => {
  const dir = tmp();
  // A store that records every write that went through the atomic path.
  class Watched extends FileWorldStore {
    constructor(d) { super(d); this.atomic = []; }
    async _atomicWrite(p, data) { this.atomic.push(path.basename(p)); return super._atomicWrite(p, data); }
  }
  const store = new Watched(dir);
  await new WorldRepository(store).upsert({ worldId: "w_rep", ownerId: "o", manifest: { meta: { title: "Real" } }, state: "published" });
  fs.writeFileSync(path.join(dir, "w_rep.summary.json"), '{"broken":');
  store.atomic.length = 0;

  const runs = await Promise.all(Array.from({ length: 24 }, () => store.list({ summary: true })));
  for (const rows of runs) assert.deepEqual(rows.map((r) => r.world_id), ["w_rep"], "no concurrent repair may hide the world");
  assert.ok(
    store.atomic.includes("w_rep.summary.json"),
    "the repair must go through tmp+rename like every other write here, or two of them interleave into a truncated file",
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "w_rep.summary.json"), "utf8")).title, "Real");
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0, "and no temp file is left behind");
});

test("a sidecar cannot publish a draft, change an owner, or rename a world", async () => {
  const dir = tmp();
  const { store, repo } = published(dir);
  await repo.upsert({ worldId: "w_leak", ownerId: "victim", manifest: { meta: { title: "Unfinished Draft" } }, state: "draft" });
  const sp = path.join(dir, "w_leak.summary.json");
  const real = JSON.parse(fs.readFileSync(sp, "utf8"));

  fs.writeFileSync(sp, JSON.stringify({ ...real, state: "published" }));
  assert.deepEqual((await store.list({ state: "published", summary: true })).map((r) => r.world_id), [],
    "a cache file must not be able to answer 'is this world published?'");

  fs.writeFileSync(sp, JSON.stringify({ ...real, owner_id: "attacker" }));
  assert.deepEqual((await store.list({ ownerId: "attacker", summary: true })).map((r) => r.world_id), [],
    "nor 'whose world is this?'");
  assert.deepEqual((await store.list({ ownerId: "victim", summary: true })).map((r) => r.world_id), ["w_leak"],
    "and the real owner still sees it");

  fs.writeFileSync(sp, JSON.stringify({ ...real, title: "Something Else" }));
  const [card] = await store.list({ summary: true });
  assert.equal(card.title, "Unfinished Draft", "nor what the card is called");
});

test("a sidecar that disagrees with its record loses, whatever the two mtimes say", async () => {
  const dir = tmp();
  const { store, repo } = published(dir);
  await repo.upsert({ worldId: "w_tick", ownerId: "o", manifest: { meta: { title: "V1" } }, state: "published" });
  await repo.upsert({ worldId: "w_tick", ownerId: "o", manifest: { meta: { title: "V2" } }, state: "published" });

  const recordPath = path.join(dir, "w_tick.json");
  const sp = path.join(dir, "w_tick.summary.json");
  const stale = JSON.parse(fs.readFileSync(sp, "utf8"));
  fs.writeFileSync(sp, JSON.stringify({ ...stale, title: "V1", version: 1 }));
  const sameTick = new Date(1788700000000);                 // the record write that lands in the sidecar's own tick
  fs.utimesSync(recordPath, sameTick, sameTick);
  fs.utimesSync(sp, sameTick, sameTick);

  const [card] = await store.list({ summary: true });
  assert.equal(card.version, 2, "an equal mtime is not evidence of freshness");
  assert.equal(card.title, "V2");

  // The other direction: a sidecar NEWER than its record is still only valid if
  // it agrees with it.
  const later = new Date(1788800000000);
  fs.writeFileSync(sp, JSON.stringify({ ...stale, title: "Forged", version: 99 }));
  fs.utimesSync(sp, later, later);
  assert.equal((await store.list({ summary: true }))[0].title, "V2");
});

test("the sidecar is still a cache: a valid one answers without parsing the manifest", async () => {
  // The point of the sidecar is that a 200-world catalogue does not parse 200
  // manifests to return 24 cards, so a fix that re-reads the record on every
  // card would be no fix at all. Proven by leaving a record whose HEAD is intact
  // and whose manifest is not parseable: if the card still comes back, the
  // manifest was never read.
  const dir = tmp();
  const { store, repo } = published(dir);
  await repo.upsert({ worldId: "w_cache", ownerId: "o", manifest: richManifest, title: "Cached", state: "published" });
  const recordPath = path.join(dir, "w_cache.json");
  const text = fs.readFileSync(recordPath, "utf8");
  const cut = text.indexOf(',"manifest":');
  assert.ok(cut > 0, "the record is written with its manifest last, so the head can be read cheaply");
  fs.writeFileSync(recordPath, text.slice(0, cut) + ',"manifest":{"meta":{"title":"Cached"} <<<UNPARSEABLE');

  const [card] = await store.list({ summary: true });
  assert.equal(card.world_id, "w_cache", "the cached card answered");
  assert.equal(card.title, "Cached");
  assert.equal(card._summary, true);
  assert.deepEqual(await store.list({}), [], "self-check: the manifest genuinely cannot be parsed, so nothing read it");
});

// ------------------------------------------------------------ version history

test("a stranger can LIST every published version they are allowed to FETCH", async () => {
  const repo = versioned();
  await repo.upsert({ worldId: "w_vis", ownerId: "o", manifest: { meta: { title: "A" } }, state: "published" });
  await repo.upsert({ worldId: "w_vis", ownerId: "o", manifest: { meta: { title: "B" } }, state: "published" });

  const listed = (await repo.listVersions("w_vis", { requesterId: "stranger" })).map((v) => v.version);
  assert.deepEqual(listed, [1, 2], "the list route and the item route must agree about the same version");
  assert.equal((await repo.getVersion("w_vis", 1, { requesterId: "stranger" })).version, 1);
  assert.deepEqual((await repo.listVersions("w_vis", { requesterId: "o" })).map((v) => v.version), [1, 2]);
});

test("listing versions still withholds the drafts a world passed through", async () => {
  const repo = versioned();
  await repo.upsert({ worldId: "w_mix", ownerId: "o", manifest: { meta: { title: "draft" } }, state: "draft" });
  await repo.upsert({ worldId: "w_mix", ownerId: "o", manifest: { meta: { title: "public" } }, state: "published" });

  assert.deepEqual(
    (await repo.listVersions("w_mix", { requesterId: "stranger" })).map((v) => v.version), [2],
    "publishing a world must not retroactively publish the versions it passed through as a draft",
  );
  await assert.rejects(() => repo.getVersion("w_mix", 1, { requesterId: "stranger" }), (e) => e.httpStatus === 404);
  assert.deepEqual((await repo.listVersions("w_mix", { requesterId: "o" })).map((v) => v.version), [1, 2]);
});

// ------------------------------------------------------------------- renaming

test("renaming a world is stored, not answered with a false idempotent:true", async () => {
  const dir = tmp();
  const { store, repo } = published(dir);
  const a = await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: richManifest, title: "First Name", state: "published" });
  const b = await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: richManifest, title: "Second Name", state: "published" });

  assert.equal(b.idempotent, false, "a write that changes something is not idempotent");
  assert.equal(b.title, "Second Name");
  assert.equal(b.version, a.version + 1);
  assert.equal((await repo.get("w1", { requesterId: "u1" })).title, "Second Name", "and the new name is what was stored");
  assert.equal((await store.list({ summary: true }))[0].title, "Second Name", "including on the discovery card");

  const c = await repo.upsert({ worldId: "w1", ownerId: "u1", manifest: richManifest, title: "Second Name", state: "published" });
  assert.equal(c.idempotent, true, "a genuinely identical re-save is still a no-op");
  assert.equal(c.version, b.version);
});

// --------------------------------------------------------- the mirrored store

test("a discovery card stays a card when a primary store is configured", async () => {
  const heavy = { ...richManifest, structures: Array.from({ length: 40 }, (_, i) => ({ id: "s" + i, blob: "x".repeat(200) })) };
  const fetchImpl = async (_u, o) => (o?.method === "POST"
    ? { ok: true, status: 200, json: async () => [{}] }
    : {
      ok: true, status: 200, json: async () => [{
        world_id: "w_mir", owner_id: "o", title: "Heavy", state: "published", version: 1,
        manifest: heavy, manifest_hash: "h", manifest_version: "3.0.0",
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
      }],
    });
  const primary = { kind: "fake-primary", async put() { return null; }, async get() { return null; },
    async list() { return (await (await fetchImpl("u", {})).json()); }, async delete() {} };
  const repo = new WorldRepository(new MirroredWorldStore(primary, new FileWorldStore(tmp())));
  await repo.upsert({ worldId: "w_mir", ownerId: "o", manifest: heavy, state: "published" });

  const [card] = await repo.listPublished();
  assert.equal((card.manifest?.structures || []).length, 0, "listPublished promises cards, on every store behind it");
  assert.equal(card.world_id, "w_mir");
  assert.equal(card.title, "Heavy");
  assert.deepEqual(card.manifest.meta, heavy.meta, "and a card still carries the fields a card is made of");

  const full = await repo.listOwned("o");
  assert.equal(full[0].manifest.structures.length, 40, "a caller that did not ask for cards still gets whole records");
});

// ---------------------------------------------------------- existence oracles

test("a caller who may not see a world cannot tell it from a world that does not exist", async () => {
  const repo = versioned();
  await repo.upsert({ worldId: "w_real_private", ownerId: "owner", manifest: richManifest, state: "draft" });

  // Same status, same code, and the same detail string — a differing message
  // leaks which id is real exactly as well as a differing status does.
  const answer = async (fn) => {
    try { await fn(); return { status: 200, code: null, detail: null }; }
    catch (e) { return { status: e.httpStatus, code: e.code, detail: e.detail }; }
  };
  const norm = (a, id) => ({ ...a, detail: String(a.detail).replaceAll(id, "<id>") });

  for (const [label, call] of [
    ["get", (id, who) => repo.get(id, { requesterId: who })],
    ["listVersions", (id, who) => repo.listVersions(id, { requesterId: who })],
    ["getVersion", (id, who) => repo.getVersion(id, 1, { requesterId: who })],
  ]) {
    for (const who of [null, "stranger"]) {
      const present = norm(await answer(() => call("w_real_private", who)), "w_real_private");
      const absent = norm(await answer(() => call("no-such-world-at-all", who)), "no-such-world-at-all");
      assert.equal(present.status, 404, `${label}: a world a caller may not see must not be confirmed to exist`);
      assert.deepEqual(present, absent, `${label} (requester ${who}) distinguishes a real world id from an invented one`);
    }
  }

  // And the world is not lost to the caller who does own it.
  assert.equal((await repo.get("w_real_private", { requesterId: "owner" })).state, "draft");
});

test("an owner acting on their own world is still told when a world is somebody else's", async () => {
  // The oracle fix must not reach the requireOwner path. That caller has
  // authenticated and supplied the id, and turning "this belongs to another
  // creator" into "no such world" would make a real ownership conflict
  // unreadable — and upsert's refusal is the same answer to the same question.
  const repo = new WorldRepository(new FileWorldStore(tmp()));
  await repo.upsert({ worldId: "w1", ownerId: "user-alice", manifest: richManifest, state: "published" });

  await assert.rejects(
    () => repo.get("w1", { requesterId: "user-mallory", requireOwner: true }),
    (e) => e.httpStatus === 403 && /another creator/.test(e.detail),
  );
  await assert.rejects(
    () => repo.upsert({ worldId: "w1", ownerId: "user-mallory", manifest: { hacked: true } }),
    (e) => e.httpStatus === 403,
  );
  // A world that is not there is still a 404 on that path, for a caller who is
  // being told about ids they already hold.
  await assert.rejects(() => repo.get("nope", { requesterId: "user-mallory", requireOwner: true }), (e) => e.httpStatus === 404);
});

// =============================================================================
// Lane U2 — the mirrored and Supabase-backed paths.
//
// Everything above this line runs with SUPABASE_URL unset, so it exercises
// FileWorldStore and nothing else. The deployed configuration is a different
// set of objects — SupabaseWorldStore, MirroredWorldStore, and now the version
// history's own pair — and every defect below survived precisely because no
// test in this estate ever constructed them.
//
// These drive them over REAL HTTP against a local node:http server that speaks
// the part of PostgREST this store uses. NOTHING here contacts a real Supabase
// instance and no real credential is used: every URL is 127.0.0.1 on an
// ephemeral port. The stub is deliberately small — it is not a Postgres, and it
// says nothing about RLS, types or the updated_at trigger.
// =============================================================================

const J = (o) => JSON.stringify(o);

/** Silence the deliberate degradation logging so the test output stays readable. */
function quiet() {
  const w = console.warn, e = console.error;
  console.warn = () => {}; console.error = () => {};
  return () => { console.warn = w; console.error = e; };
}

/** Columns migration 0003 declares, so a write it would reject is rejected here. */
const WORLD_COLS = ["world_id", "owner_id", "title", "state", "version", "manifest", "manifest_hash", "manifest_version", "created_at", "updated_at"];
const VERSION_COLS = ["world_id", "version", "manifest", "manifest_hash", "label", "created_by", "created_at"];

/**
 * A local PostgREST stand-in: filters, ordering, limit, `select=` projection
 * INCLUDING the `col->key` json arrow (which is the whole point of the wire-cost
 * fix), upsert via on_conflict + merge-duplicates, plain-insert duplicate 409,
 * DELETE, and injectable faults.
 */
async function pgStub({ tables = {}, key = "stub-key", rejectArrows = false } = {}) {
  const state = { key, rejectArrows, tables: {}, wire: [], faults: [] };
  for (const [n, t] of Object.entries(tables)) state.tables[n] = { columns: t.columns || null, pk: t.pk || ["id"], rows: (t.rows || []).map((r) => ({ ...r })) };

  const pick = (row, sel) => {
    if (sel === "*") return row;
    const out = {};
    for (const raw of sel.split(",")) {
      const c = raw.trim();
      const i = c.indexOf("->");
      if (i < 0) { out[c] = row[c] === undefined ? null : row[c]; continue; }
      const base = c.slice(0, i), leaf = c.slice(i + 2).replace(/^>/, "");
      out[leaf] = (row[base] || {})[leaf] ?? null;
    }
    return out;
  };
  const badCols = (T, sel) => {
    if (sel === "*" || !T.columns) return null;
    for (const raw of sel.split(",")) {
      const c = raw.trim();
      const arrow = c.includes("->");
      if (arrow && state.rejectArrows) return c;
      const base = arrow ? c.slice(0, c.indexOf("->")) : c;
      if (!T.columns.includes(base)) return c;
    }
    return null;
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const [pathname, qs] = String(req.url).split("?");
      const q = new URLSearchParams(qs || "");
      const send = (status, body = "") => {
        state.wire.push({ method: req.method, url: req.url, table: (/^\/rest\/v1\/([^?]+)/.exec(req.url) || [])[1] || null, status, resBytes: Buffer.byteLength(body) });
        if (status === 204) { res.writeHead(204); return res.end(); }
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      };
      const m = /^\/rest\/v1\/([^/]+)$/.exec(pathname);
      if (!m) return send(404, J({ code: "PGRST002", message: "no route" }));
      for (const f of state.faults) {
        if (f.times <= 0) continue;
        if (f.method && f.method !== req.method) continue;
        if (f.table && f.table !== m[1]) continue;
        f.times -= 1;
        return send(f.status, J({ code: "XX000", message: "stub-injected upstream failure" }));
      }
      if (req.headers.apikey !== state.key) return send(401, J({ message: "Invalid API key" }));
      const T = state.tables[m[1]];
      if (!T) return send(404, J({ code: "PGRST205", message: `Could not find the table 'public.${m[1]}'` }));

      const filters = [];
      for (const [k, v] of q.entries()) {
        if (["select", "order", "limit", "offset", "on_conflict"].includes(k)) continue;
        filters.push([k, v.slice(v.indexOf(".") + 1)]);
      }
      const match = (r) => filters.every(([c, v]) => String(r[c]) === v);

      if (req.method === "GET") {
        const sel = q.get("select") || "*";
        const bad = badCols(T, sel);
        if (bad) return send(400, J({ code: "42703", message: `column ${m[1]}.${bad} does not exist` }));
        let rows = T.rows.filter(match);
        const order = q.get("order");
        if (order) {
          const [c, dir = "asc"] = order.split(".");
          rows = rows.slice().sort((a, b) => String(a[c] ?? "").localeCompare(String(b[c] ?? "")) * (dir.startsWith("desc") ? -1 : 1));
        }
        if (q.has("limit")) rows = rows.slice(0, Number(q.get("limit")));
        return send(200, J(rows.map((r) => pick(r, sel))));
      }
      if (req.method === "POST") {
        const body = JSON.parse(raw || "null");
        const rows = Array.isArray(body) ? body : [body];
        const merge = /resolution=merge-duplicates/.test(String(req.headers.prefer || ""));
        const pk = q.get("on_conflict") ? decodeURIComponent(q.get("on_conflict")).split(",") : T.pk;
        const written = [];
        for (const r of rows) {
          if (T.columns) for (const c of Object.keys(r)) if (!T.columns.includes(c)) return send(400, J({ code: "PGRST204", message: `Could not find the '${c}' column of '${m[1]}' in the schema cache` }));
          const k = pk.map((c) => String(r[c])).join(" ");
          const i = T.rows.findIndex((x) => pk.map((c) => String(x[c])).join(" ") === k);
          if (i >= 0) {
            if (!merge) return send(409, J({ code: "23505", message: `duplicate key value violates unique constraint "${m[1]}_pkey"` }));
            T.rows[i] = { ...T.rows[i], ...r };
            written.push(T.rows[i]);
          } else { T.rows.push({ ...r }); written.push(r); }
        }
        return send(201, /return=minimal/.test(String(req.headers.prefer || "")) ? "" : J(written));
      }
      if (req.method === "DELETE") { T.rows = T.rows.filter((r) => !match(r)); return send(204); }
      return send(405, J({ code: "PGRST105", message: "method not allowed" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, key,
    get wire() { return state.wire; },
    rows: (t) => state.tables[t].rows,
    seed: (t, rows) => { state.tables[t].rows = rows.map((r) => ({ ...r })); },
    fail: (m) => state.faults.push({ times: Infinity, status: 503, ...m }),
    clearFaults: () => { state.faults.length = 0; },
    resetWire: () => { state.wire.length = 0; },
    bytes: (pred = () => true) => state.wire.filter(pred).reduce((n, w) => n + w.resBytes, 0),
    close: () => new Promise((r) => server.close(r)),
  };
}

const bothTables = () => ({
  dcsgames_base_worlds: { columns: WORLD_COLS, pk: ["world_id"], rows: [] },
  dcsgames_world_versions: { columns: VERSION_COLS, pk: ["world_id", "version"], rows: [] },
});

/** A stub + temp dir + the repository createWorldRepository builds for them. */
async function withRepo(t, opts = {}) {
  const stub = await pgStub({ tables: bothTables(), ...opts });
  const dir = tmp();
  t.after(async () => { await stub.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const mk = () => createWorldRepository({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: stub.key, DCS_DATA_DIR: dir });
  return { stub, dir, mk, repo: mk() };
}

/** A manifest big enough that the wire cost of shipping it is measurable. */
const bigManifest = (n = 60) => ({
  manifest_version: "3.0.0",
  meta: { title: "Pirate Island", genre: "adventure" },
  media: { cover: "https://example.invalid/cover.png" },
  zones: Array.from({ length: n }, (_, i) => ({ id: "z" + i, description: "long-form generated description ".repeat(6) })),
});

// ------------------------------------------- 1. re-sync after a refused write

test("a world the primary refused is pushed back the moment the primary recovers", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  stub.fail({ method: "POST", table: "dcsgames_base_worlds" });
  const first = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(2), state: "published", title: "W" });
  assert.equal(first._mirrored, false, "the caller is told the write was degraded");
  assert.equal(stub.rows("dcsgames_base_worlds").length, 0);

  stub.clearFaults();
  // A plain READ is enough: the row the primary was never told about is replayed.
  await repo.get("w1", { requesterId: "alice" });
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1, "a read pushes the missing row back");
  assert.equal(stub.rows("dcsgames_base_worlds")[0].version, 1);
  assert.deepEqual(stub.rows("dcsgames_base_worlds")[0].manifest, bigManifest(2), "and pushes the WHOLE manifest, not a projection");
});

test("re-issuing the identical save repairs the mirror instead of short-circuiting on the shadow", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  const manifest = bigManifest(2);
  stub.fail({ method: "POST", table: "dcsgames_base_worlds" });
  const first = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest, state: "published", title: "W" });
  assert.equal(first._mirrored, false);

  // Still degraded: the idempotent answer must not claim the world is mirrored.
  const whileDown = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest, state: "published", title: "W" });
  assert.equal(whileDown.idempotent, true);
  assert.equal(whileDown._mirrored, false, "an idempotent answer must still admit the mirror is behind");

  stub.clearFaults();
  const retry = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest, state: "published", title: "W" });
  assert.equal(retry.idempotent, true, "the content really is unchanged, so no version churn");
  assert.equal(retry._mirrored, undefined, "and it no longer claims to be degraded");
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1, "the retry is a real remedy: the primary now has the world");
  assert.equal(stub.rows("dcsgames_base_worlds")[0].manifest_hash, manifestHash(manifest));
});

test("the pending-mirror marker is durable, so a restart does not forget what the primary is owed", async (t) => {
  const restore = quiet();
  const { stub, mk } = await withRepo(t);
  t.after(restore);
  stub.fail({ method: "POST", table: "dcsgames_base_worlds" });
  await mk().upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  assert.equal(stub.rows("dcsgames_base_worlds").length, 0);

  stub.clearFaults();
  // A brand new process over the same disk — which is what a redeploy is.
  const repo2 = mk();
  assert.equal((await repo2.listPublished(10)).length, 1);
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1,
    "the marker was on disk, not in a process-local flag, so the new process still owed the write");
});

test("a shadow row the primary does not have, and no marker explains, is reported rather than served", async (t) => {
  // The alternative — serving any shadow row the primary lacks — is what makes
  // a deleted world immortal, because the store would push it back too. So the
  // divergence is refused by BOTH get() and list(), identically, and logged
  // instead of passed over. Nothing is destroyed: the record is still on disk.
  const { stub, dir } = await withRepo(t);
  const warned = [];
  const w = console.warn;
  console.warn = (line) => warned.push(String(line));
  t.after(() => { console.warn = w; });

  const shadow = new FileWorldStore(path.join(dir, "worlds"));
  const record = { world_id: "orphaned", owner_id: "alice", title: "Only Local", state: "published", version: 4, manifest: { meta: { title: "Only Local" } }, manifest_hash: "h", manifest_version: null, created_at: "t", updated_at: "t" };
  await shadow.put(record);
  const store = new MirroredWorldStore(new SupabaseWorldStore({ url: stub.url, serviceRoleKey: stub.key }), shadow);

  assert.equal(await store.get("orphaned"), null, "the primary answered, and it said no");
  assert.deepEqual(await store.list({ state: "published" }), [], "and the listing says exactly the same thing");
  assert.equal(stub.rows("dcsgames_base_worlds").length, 0, "a world the primary deleted is not pushed back to it");
  assert.equal(warned.filter((l) => l.includes("supabase-world-divergence")).length, 1, "but the divergence is visible");
  assert.deepEqual(await shadow.get("orphaned"), record, "and the record itself is untouched on disk");

  // Logged once per world per process, not once per read.
  await store.get("orphaned");
  assert.equal(warned.filter((l) => l.includes("supabase-world-divergence")).length, 1);
});

// ------------------------------------------------------- 2. an honest delete

test("a delete the primary refused does not resurrect the world, and says so", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1);

  stub.fail({ method: "DELETE" });
  const res = await repo.store.delete("w1");
  assert.equal(res.deleted, true);
  assert.equal(res._mirrored, false, "a delete that only half happened must not resolve silently");
  assert.match(String(res._mirror_error), /world delete failed \(503\)/);

  // The row does survive remotely — but it is NOT served, and it is NOT in the
  // public catalogue, because the tombstone outranks the primary's copy.
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1);
  await assert.rejects(() => repo.get("w1", { requesterId: null }), (e) => e.httpStatus === 404);
  assert.deepEqual(await repo.listPublished(10), []);
  assert.deepEqual(await repo.listOwned("alice", 10), []);
});

test("a refused delete is retried until the primary converges", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  stub.fail({ method: "DELETE" });
  await repo.store.delete("w1");
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1);

  stub.clearFaults();
  assert.deepEqual(await repo.listPublished(10), [], "still gone from the catalogue");
  assert.equal(stub.rows("dcsgames_base_worlds").length, 0, "and now genuinely gone from the primary");
  // A world can be recreated at the same id afterwards: the tombstone is spent.
  const again = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  assert.equal(again.version, 1);
  assert.equal((await repo.get("w1", { requesterId: null })).version, 1);
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1);
});

test("a fully mirrored delete reports a clean success", async (t) => {
  const { stub, repo } = await withRepo(t);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  const res = await repo.store.delete("w1");
  assert.equal(res._mirrored, true);
  assert.equal(res._mirror_error, undefined);
  assert.equal(stub.rows("dcsgames_base_worlds").length, 0);
});

// --------------------------------------------- 3. version history in the DB

test("retained version history reaches dcsgames_world_versions, not just the disk", async (t) => {
  const { stub, dir, repo } = await withRepo(t);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "v1" });
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(2), state: "published", title: "v2" });

  const stored = stub.rows("dcsgames_world_versions");
  assert.deepEqual(stored.map((v) => v.version).sort(), [1, 2], "both versions are in the table migration 0003 declared");
  assert.deepEqual(stored.find((v) => v.version === 2).manifest, bigManifest(2), "with the whole manifest, so a rollback has something to roll back TO");
  assert.ok(fs.existsSync(path.join(dir, "world-versions", "w1@1.json")), "and the disk copy is still written first");

  // The operational point: a redeploy on an ephemeral disk keeps the database.
  await fsp.rm(path.join(dir, "world-versions"), { recursive: true, force: true });
  const repo2 = createWorldRepository({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: stub.key, DCS_DATA_DIR: dir });
  assert.deepEqual((await repo2.listVersions("w1", { requesterId: "alice" })).map((v) => v.version), [1, 2],
    "the rollback targets survive the disk that used to be the only copy");
  const v1 = await repo2.getVersion("w1", 1, { requesterId: "alice" });
  assert.deepEqual(v1.manifest, bigManifest(1));
  assert.equal(v1.manifest_hash, manifestHash(bigManifest(1)));
});

test("a version recovered from the database alone is private, because the table cannot record its state", async (t) => {
  // migrations/0003 declares dcsgames_world_versions without a `state` column,
  // and inventing one would make every write a PGRST204. So a version known
  // only to the database has no provable state and stays owner-only — the
  // fail-closed direction. Deciding from the world's CURRENT state instead is
  // exactly the bug that retroactively published every draft it passed through.
  const { stub, dir, repo } = await withRepo(t);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "v1" });
  assert.deepEqual(Object.keys(stub.rows("dcsgames_world_versions")[0]).sort(), VERSION_COLS.slice().sort(),
    "only the columns the migration declares are ever sent");

  const stranger = await repo.listVersions("w1", { requesterId: "mallory" });
  assert.deepEqual(stranger.map((v) => v.version), [1], "with the disk copy present, its state is known and a stranger sees it");

  await fsp.rm(path.join(dir, "world-versions"), { recursive: true, force: true });
  const repo2 = createWorldRepository({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: stub.key, DCS_DATA_DIR: dir });
  assert.deepEqual(await repo2.listVersions("w1", { requesterId: "mallory" }), [], "without it, an unprovable state is treated as private");
  assert.deepEqual((await repo2.listVersions("w1", { requesterId: "alice" })).map((v) => v.version), [1], "the owner still has the target");
});

test("a version the primary refused is replayed the next time history is read", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  stub.fail({ method: "POST", table: "dcsgames_world_versions" });
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "v1" });
  assert.equal(stub.rows("dcsgames_world_versions").length, 0);

  stub.clearFaults();
  assert.deepEqual((await repo.listVersions("w1", { requesterId: "alice" })).map((v) => v.version), [1]);
  assert.equal(stub.rows("dcsgames_world_versions").length, 1, "the missing version was replayed");
});

test("retained history is append-only across BOTH backings: a duplicate is a success, never a rewrite", async (t) => {
  const stub = await pgStub({ tables: bothTables() });
  const dir = tmp();
  t.after(async () => { await stub.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const s = new SupabaseVersionHistoryStore({ url: stub.url, serviceRoleKey: stub.key });
  const rec = { world_id: "w1", version: 1, manifest: { a: 1 }, manifest_hash: "h1", label: null, created_by: "alice", created_at: "t" };
  await s.put("w1", 1, rec);
  const again = await s.put("w1", 1, { ...rec, manifest: { TAMPERED: true }, manifest_hash: "h2" });
  assert.equal(again.already_recorded, true, "a 23505 on an append-only table means the row is already there");
  assert.deepEqual(stub.rows("dcsgames_world_versions")[0].manifest, { a: 1 }, "history was not rewritten");
});

// ------------------------------- 4. get() and list() answer the same question

test("get() and list() agree about a world the primary has not caught up with", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "V1" });
  stub.fail({ method: "POST", table: "dcsgames_base_worlds" });
  const v2 = bigManifest(2);
  const saved = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: v2, state: "published", title: "V2" });
  assert.equal(saved._mirrored, false);
  assert.equal(stub.rows("dcsgames_base_worlds")[0].version, 1, "the primary is genuinely stale");

  const one = await repo.get("w1", { requesterId: "alice" });
  const [listed] = await repo.listOwned("alice");
  const [card] = await repo.listPublished(10);
  assert.equal(one.version, 2);
  assert.equal(listed.version, 2, "one repository must not answer the same question two ways");
  assert.equal(card.version, 2);
  assert.equal(listed.title, "V2");
  assert.equal(card.manifest_hash, manifestHash(v2));
  assert.equal(one.manifest_hash, card.manifest_hash);
});

test("an EMPTY answer from the primary is an answer, not a failure", async (t) => {
  const { stub, repo } = await withRepo(t);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  stub.seed("dcsgames_base_worlds", []);                  // removed out of band
  assert.deepEqual(await repo.listPublished(10), [], "a world the primary no longer has does not reappear from the shadow");
  await assert.rejects(() => repo.get("w1", { requesterId: "alice" }), (e) => e.httpStatus === 404,
    "and get() says the same thing list() says");
});

test("a primary OUTAGE still degrades to the shadow rather than emptying the catalogue", async (t) => {
  // The correction above must not become "the primary's silence is an empty
  // catalogue". A failed read and an empty read are different events.
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  stub.fail({ method: "GET" });
  const cards = await repo.listPublished(10);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]._summary, true);
  assert.equal((await repo.get("w1", { requesterId: "alice" })).version, 1);
});

// ------------------------------------------- 5. the listing gate is re-applied

test("the listing gate is re-applied to whatever the primary returns", async (t) => {
  // Not a thing PostgREST does on its own — it is what a dropped filter, a
  // mis-set RLS policy or a view with a different definition looks like from
  // this side. This file's own gate is what keeps drafts out of the public
  // catalogue, so it has to be applied on this side of the wire too.
  const dir = tmp();
  t.after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
  const disobedient = {
    kind: "supabase",
    list: async () => ([
      { world_id: "bob-private", owner_id: "bob", title: "Bob's draft", state: "draft", version: 1, updated_at: "t", manifest: { secret: "unpublished" } },
      { world_id: "alice-pub", owner_id: "alice", title: "A", state: "published", version: 1, updated_at: "t", manifest: { meta: { title: "A" } } },
    ]),
    get: async () => null, put: async () => null, delete: async () => {},
  };
  const store = new MirroredWorldStore(disobedient, new FileWorldStore(path.join(dir, "worlds")));

  assert.deepEqual((await store.list({ ownerId: "alice" })).map((r) => r.world_id), ["alice-pub"], "the owner filter is re-applied");
  assert.deepEqual((await store.list({ state: "published" })).map((r) => r.world_id), ["alice-pub"], "and so is the state filter");
  const cards = await store.list({ state: "published", summary: true });
  assert.equal(cards.length, 1);
  assert.equal(cards[0]._summary, true);
  assert.deepEqual((await store.list({})).map((r) => r.world_id).sort(), ["alice-pub", "bob-private"], "an unfiltered listing still returns everything");
  assert.equal((await store.list({ limit: 1 })).length, 1, "and limit is applied after the merge, not before it");
});

// ---------------------------------------------------- 6. the wire projection

test("a discovery listing projects on the wire: the manifest body never leaves the database", async (t) => {
  const { stub, repo } = await withRepo(t);
  const N = 24;
  for (let i = 0; i < N; i++) await repo.upsert({ worldId: "w" + i, ownerId: "alice", manifest: bigManifest(60), state: "published", title: "World " + i });

  stub.resetWire();
  const cards = await repo.listPublished(N);
  const gets = stub.wire.filter((w) => w.method === "GET" && w.table === "dcsgames_base_worlds");
  assert.equal(gets.length, 1, "one query, not a query plus a repair");
  assert.doesNotMatch(gets[0].url, /select=\*/, "select=* pulled 24 whole manifests to build 24 cards");
  // `>` is percent-encoded by the URL parser on the way out; PostgREST decodes it.
  assert.match(decodeURIComponent(gets[0].url), /select=world_id,owner_id,title,state,version,manifest_hash,manifest_version,created_at,updated_at,manifest->meta,manifest->media/);

  // The cards are unchanged in shape and content...
  assert.equal(cards.length, N);
  assert.ok(cards.every((c) => c._summary === true));
  assert.ok(cards.every((c) => !("zones" in (c.manifest || {}))));
  assert.deepEqual(cards[0].manifest.meta, bigManifest(60).meta);
  assert.deepEqual(cards[0].manifest.media, bigManifest(60).media);
  assert.equal(cards[0].owner_id, "alice");
  assert.ok(cards.every((c) => typeof c.manifest_hash === "string" && c.manifest_hash.length === 64));

  // ...and the transfer is now the size of the answer rather than 90x it.
  const projected = gets[0].resBytes;
  stub.resetWire();
  await new SupabaseWorldStore({ url: stub.url, serviceRoleKey: stub.key }).list({ state: "published", limit: N });
  const wholeRows = stub.wire.at(-1).resBytes;
  assert.ok(projected * 20 < wholeRows, `the projection must be an order of magnitude smaller (projected ${projected} vs select=* ${wholeRows})`);
  assert.ok(projected < Buffer.byteLength(JSON.stringify(cards)) * 2, "and roughly the size of the cards it serves");
});

test("an endpoint that cannot project into the manifest still gets correct cards", async (t) => {
  // A view, an older PostgREST, or a `manifest` column that is text rather than
  // jsonb. The saving is lost; the shape the caller asked for is not.
  const { stub, repo } = await withRepo(t, { rejectArrows: true });
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(3), state: "published", title: "W" });
  const cards = await repo.listPublished(10);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]._summary, true);
  assert.deepEqual(Object.keys(cards[0].manifest).sort(), ["media", "meta"]);
  assert.deepEqual(cards[0].manifest.meta, bigManifest(3).meta);
  // ...and it is remembered, so the rejected projection is asked for once, not per listing.
  stub.resetWire();
  await repo.listPublished(10);
  assert.equal(stub.wire.filter((w) => w.method === "GET" && w.status === 400).length, 0);
});

// ----------------------------------------------------- 7. the limit parameter

test("`limit` cannot smuggle query parameters into a listing", async (t) => {
  const stub = await pgStub({ tables: bothTables() });
  t.after(() => stub.close());
  const s = new SupabaseWorldStore({ url: stub.url, serviceRoleKey: stub.key });
  await s.list({ limit: "1&owner_id=eq.injected" });
  assert.doesNotMatch(stub.wire.at(-1).url, /owner_id/, "caller-supplied text must not reach the query string");
  assert.match(stub.wire.at(-1).url, /limit=50/, "an unusable limit falls back to the default");
  await s.list({ limit: "12" });
  assert.match(stub.wire.at(-1).url, /limit=12/, "a numeric string is still honoured");
});
