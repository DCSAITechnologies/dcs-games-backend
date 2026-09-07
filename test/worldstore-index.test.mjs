// The listing index must never change an ANSWER, only the cost of getting it.
//
// A page of 24 cards used to cost the whole catalogue: every file opened and
// parsed on every request, and two files per world because each sidecar was
// read in full just to decide whether it was a cache or a record. Measured at
// 8 worlds 1.41ms, 64 worlds 6.49ms, on the route every anonymous visitor hits.
//
// An index is the obvious fix and the dangerous one. A listing that silently
// drops a published world is far worse than a slow listing, and a stale entry
// reporting an old state is worse still — it would say "draft" about a world
// that is public, or "published" about one that has been withdrawn.
//
// So every test here asks the same question in a different way: after some
// change, does the listing still say exactly what a full re-read would say?
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorldRepository } from "../src/core/worldstore.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dcs-idx-"));
const env = (dir) => ({ DCS_DATA_DIR: dir });
const manifest = (title) => ({ meta: { title }, zones: [{ id: "z1" }] });

/** A fresh repository over the same directory — the restart. */
const repoOver = (dir) => createWorldRepository(env(dir));

const ids = (rows) => rows.map((r) => r.world_id).sort();

// --------------------------------------------------------- the basic contract

test("INDEX: a listing over a cold index equals a listing over a warm one", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  for (let i = 0; i < 12; i++) {
    await repo.upsert({ worldId: `w${i}`, ownerId: i % 2 ? "alice" : "bob", manifest: manifest(`W${i}`), state: i % 3 ? "draft" : "published" });
  }
  const cold = await repo.listPublished(50);          // builds the index
  const warm = await repo.listPublished(50);          // uses it
  assert.deepEqual(ids(warm), ids(cold), "the index must not change which worlds are listed");
  assert.deepEqual(warm.map((w) => w.state), cold.map((w) => w.state));
});

// ------------------------------------------------ every state transition

test("INDEX GATE: publishing a world makes it appear, on the very next read", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("One"), state: "draft" });
  assert.deepEqual(ids(await repo.listPublished(50)), [], "a draft is not published");

  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("One"), state: "published" });
  assert.deepEqual(ids(await repo.listPublished(50)), ["w1"],
    "a stale index entry here would keep a published world out of the catalogue");
});

test("INDEX GATE: unpublishing removes it, on the very next read", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("One"), state: "published" });
  assert.deepEqual(ids(await repo.listPublished(50)), ["w1"]);

  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("One"), state: "draft" });
  assert.deepEqual(ids(await repo.listPublished(50)), [],
    "a stale entry here would keep a withdrawn world in the public catalogue");
});

test("INDEX GATE: an edit is reflected, not remembered", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("Before"), state: "published", title: "Before" });
  assert.equal((await repo.listPublished(50))[0].title, "Before");

  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("After"), state: "published", title: "After" });
  assert.equal((await repo.listPublished(50))[0].title, "After", "the index must not serve the previous title");
});

test("INDEX GATE: ownership changes are reflected", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("One"), state: "draft" });
  assert.deepEqual(ids(await repo.listOwned("alice", 50)), ["w1"]);
  assert.deepEqual(ids(await repo.listOwned("bob", 50)), []);
});

test("INDEX GATE: a deleted world disappears", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("One"), state: "published" });
  await repo.upsert({ worldId: "w2", ownerId: "alice", manifest: manifest("Two"), state: "published" });
  assert.deepEqual(ids(await repo.listPublished(50)), ["w1", "w2"]);

  await repo.store.delete("w1");
  assert.deepEqual(ids(await repo.listPublished(50)), ["w2"],
    "readdir drives the file set, so a deleted world cannot survive in the index");
});

test("INDEX GATE: a world deleted and recreated with different content is not the old one", async () => {
  // The nastiest staleness case: same filename, so an index keyed on name alone
  // would serve the corpse.
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("Original"), state: "published", title: "Original" });
  assert.equal((await repo.listPublished(50))[0].title, "Original");

  await repo.store.delete("w1");
  await repo.upsert({ worldId: "w1", ownerId: "bob", manifest: manifest("Replacement"), state: "published", title: "Replacement" });

  const rows = await repo.listPublished(50);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Replacement");
  assert.equal(rows[0].owner_id, "bob");
});

// ------------------------------------------------------------------ restart

test("INDEX GATE: a restart sees exactly what the previous process saw", async () => {
  const dir = tmp();
  const a = repoOver(dir);
  for (let i = 0; i < 8; i++) {
    await a.upsert({ worldId: `w${i}`, ownerId: "alice", manifest: manifest(`W${i}`), state: i < 5 ? "published" : "draft" });
  }
  const before = ids(await a.listPublished(50));

  const b = repoOver(dir);                              // the restart
  assert.deepEqual(ids(await b.listPublished(50)), before);
});

test("INDEX GATE: a world written while the process was down is found", async () => {
  // The index cannot know about it. readdir must.
  const dir = tmp();
  const a = repoOver(dir);
  await a.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("One"), state: "published" });
  await a.listPublished(50);                             // warm the index

  // Another process writes a record directly, exactly as a second server would.
  const worldsDir = path.join(dir, "worlds");
  const rec = JSON.parse(await fsp.readFile(path.join(worldsDir, "w1.json"), "utf8"));
  await fsp.writeFile(path.join(worldsDir, "w2.json"),
    JSON.stringify({ ...rec, world_id: "w2", title: "Written elsewhere" }));

  const b = repoOver(dir);
  assert.deepEqual(ids(await b.listPublished(50)), ["w1", "w2"],
    "a record the index has never seen is an index miss, never an omission");
});

// ------------------------------------------------------ index recovery

test("INDEX GATE: a corrupt index costs reads, never rows", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  for (let i = 0; i < 6; i++) {
    await repo.upsert({ worldId: `w${i}`, ownerId: "alice", manifest: manifest(`W${i}`), state: "published" });
  }
  const good = ids(await repo.listPublished(50));

  const idx = path.join(dir, "worlds", ".index", "cards.json");
  await fsp.writeFile(idx, "{not json at all");
  assert.deepEqual(ids(await repo.listPublished(50)), good, "an unparseable index must fall back to the records");

  await fsp.writeFile(idx, JSON.stringify({ v: 99, entries: { "w0.json": { m: 1, s: 1, k: "cache", c: null } } }));
  assert.deepEqual(ids(await repo.listPublished(50)), good, "an index from another version is not trusted");

  await fsp.rm(idx, { force: true });
  assert.deepEqual(ids(await repo.listPublished(50)), good, "a missing index rebuilds");
});

test("INDEX GATE: a FORGED index cannot hide a world or invent one", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "real", ownerId: "alice", manifest: manifest("Real"), state: "published" });
  await repo.listPublished(50);

  const idx = path.join(dir, "worlds", ".index", "cards.json");
  await fsp.writeFile(idx, JSON.stringify({
    v: 1,
    entries: {
      // claims the real world is a draft, with mtimes that cannot match
      "real.json": { m: 1, s: 1, k: "record", c: { world_id: "real", state: "draft", owner_id: "alice", updated_at: "1970-01-01" } },
      // claims a world that does not exist
      "ghost.json": { m: 1, s: 1, k: "record", c: { world_id: "ghost", state: "published", owner_id: "alice", updated_at: "2030-01-01" } },
    },
  }));

  const rows = await repo.listPublished(50);
  assert.deepEqual(ids(rows), ["real"], "the forged draft claim is ignored and the invented world never appears");
  assert.equal(rows[0].state, "published");
});

test("INDEX GATE: a world whose id ends in .summary is still listed", async () => {
  // The collision this store lost a world to once already. The index must not
  // reintroduce it by classifying on the filename.
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "alpha.summary", ownerId: "alice", manifest: manifest("Alpha"), state: "published" });
  await repo.upsert({ worldId: "beta", ownerId: "alice", manifest: manifest("Beta"), state: "published" });

  assert.deepEqual(ids(await repo.listPublished(50)), ["alpha.summary", "beta"]);
  assert.deepEqual(ids(await repo.listPublished(50)), ["alpha.summary", "beta"], "and again from the warm index");
});

// -------------------------------------------------------------- pagination

test("INDEX GATE: a page is the FIRST n by recency, and the pages tile the set", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  for (let i = 0; i < 20; i++) {
    await repo.upsert({ worldId: `w${String(i).padStart(2, "0")}`, ownerId: "alice", manifest: manifest(`W${i}`), state: "published" });
    await new Promise((r) => setTimeout(r, 2));         // distinct updated_at
  }
  const all = await repo.listPublished(50);
  assert.equal(all.length, 20);

  // Sorted by updated_at descending, strictly.
  for (let i = 1; i < all.length; i++) {
    assert.ok(String(all[i - 1].updated_at) >= String(all[i].updated_at), "the listing must be ordered by recency");
  }

  const five = await repo.listPublished(5);
  assert.equal(five.length, 5);
  assert.deepEqual(five.map((w) => w.world_id), all.slice(0, 5).map((w) => w.world_id),
    "a page must be the FIRST five of the full order, not five arbitrary rows");
});

test("INDEX GATE: the page is drawn from the whole catalogue, not the first files read", async () => {
  // The failure this guards: filter and sort applied AFTER slicing, so the page
  // is whatever readdir happened to return first.
  const dir = tmp();
  const repo = repoOver(dir);
  for (let i = 0; i < 15; i++) {
    await repo.upsert({ worldId: `draft${i}`, ownerId: "alice", manifest: manifest(`D${i}`), state: "draft" });
  }
  await new Promise((r) => setTimeout(r, 5));
  await repo.upsert({ worldId: "the-only-published-one", ownerId: "alice", manifest: manifest("P"), state: "published" });

  const rows = await repo.listPublished(5);
  assert.deepEqual(ids(rows), ["the-only-published-one"],
    "fifteen drafts must not crowd the single published world out of a five-row page");
});

// -------------------------------------------------------------- concurrency

test("INDEX GATE: concurrent listings agree with each other and with a cold read", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  for (let i = 0; i < 25; i++) {
    await repo.upsert({ worldId: `w${String(i).padStart(2, "0")}`, ownerId: "alice", manifest: manifest(`W${i}`), state: "published" });
  }

  const many = await Promise.all(Array.from({ length: 16 }, () => repo.listPublished(50)));
  const first = ids(many[0]);
  for (const m of many) assert.deepEqual(ids(m), first, "sixteen concurrent listings must not disagree");

  // And a process that has never seen the index agrees too.
  assert.deepEqual(ids(await repoOver(dir).listPublished(50)), first);
});

test("INDEX GATE: writes concurrent with listings never produce a torn answer", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  for (let i = 0; i < 10; i++) {
    await repo.upsert({ worldId: `w${i}`, ownerId: "alice", manifest: manifest(`W${i}`), state: "published" });
  }

  // Publish five more while listing repeatedly.
  const writes = (async () => {
    for (let i = 10; i < 15; i++) {
      await repo.upsert({ worldId: `w${i}`, ownerId: "alice", manifest: manifest(`W${i}`), state: "published" });
    }
  })();
  const reads = Array.from({ length: 12 }, () => repo.listPublished(50));
  const [, ...results] = await Promise.all([writes, ...reads]);
  await writes;

  for (const rows of results) {
    const seen = new Set();
    for (const r of rows) {
      assert.ok(r.world_id, "every row is a world");
      assert.equal(seen.has(r.world_id), false, "no row may appear twice");
      seen.add(r.world_id);
      assert.equal(r.state, "published", "a filtered listing may never contain a row that fails the filter");
    }
  }

  // After the writes settle, everything is there.
  assert.equal((await repo.listPublished(50)).length, 15);
  assert.equal((await repoOver(dir).listPublished(50)).length, 15, "and a cold process agrees");
});

test("INDEX GATE: the index never becomes a world", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: manifest("One"), state: "published" });
  await repo.listPublished(50);

  const rows = await repo.listPublished(50);
  assert.deepEqual(ids(rows), ["w1"], "the index file must not be picked up as a record");
  assert.ok(fs.existsSync(path.join(dir, "worlds", ".index", "cards.json")), "and it really was written");
});

// ---------------------------------------------------------------------------
// listOwnedCards — the summary path the home screen needed and was not asking
// for. /me/home and /me/achievements together read up to 250 FULL world records
// per page load to use five fields the card already carries; on an account with
// a real catalogue that put the first authenticated screen at ~4.5s.
//
// This asserts the card carries exactly what those two routes read, and that it
// is genuinely a summary rather than a full record wearing a flag — otherwise
// the fix would be a rename.
test("listOwnedCards returns summaries carrying every field /me/home reads", async () => {
  const dir = tmp();
  const repo = repoOver(dir);
  for (let i = 0; i < 5; i++) {
    await repo.upsert({
      worldId: `w_card_${i}`, ownerId: "p_cards",
      manifest: { meta: { title: `World ${i}` }, zones: [{ id: `z${i}`, big: "x".repeat(4096) }] },
      state: i % 2 ? "published" : "draft",
    });
  }

  const cards = await repo.listOwnedCards("p_cards", 50);
  assert.equal(cards.length, 5);

  for (const c of cards) {
    // The exact fields server.mts reads on /me/home and /me/achievements.
    for (const f of ["world_id", "title", "state", "version", "updated_at"]) {
      assert.ok(f in c, `the card is missing ${f}, which /me/home renders`);
    }
    assert.equal(c._summary, true, "listOwnedCards must return summaries");
    // A summary that still carries the whole world is not a summary.
    assert.equal(c.manifest?.zones, undefined,
      "the card carried the full manifest \u2014 the read this exists to avoid");
  }

  // It must be the SAME page as listOwned, or the two routes would disagree
  // about what the creator owns.
  const full = await repo.listOwned("p_cards", 50);
  assert.deepEqual(ids(cards), ids(full),
    "the card page and the record page must describe the same worlds, in the same order");
});
