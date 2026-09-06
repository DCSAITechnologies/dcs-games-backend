// A3 exit gate: create -> save -> restart -> load the same world, with canonical
// equivalence. "Restart" is simulated by constructing an entirely new repository
// over the same directory, which is exactly what a process restart does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileWorldStore, WorldRepository, MirroredWorldStore, VersionHistoryStore, manifestHash, canonicalize } from "../src/core/worldstore.mjs";

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
