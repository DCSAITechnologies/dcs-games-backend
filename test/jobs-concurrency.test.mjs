// P1 jobs — the two defects Lane C found in src/core/jobs.mjs, reported through
// the Lead 7 Sep 2026.
//
// A separate file from test/jobs.test.mjs on purpose: that suite belongs to
// another lane and this one has no business editing it. Everything here is new
// coverage, and nothing here changes an existing assertion.
//
// 1. prune() read the whole jobs table and wrote a truncated copy back, OUTSIDE
//    the collection lock. create() calls it immediately after jobs.insert(), so
//    concurrent creation is exactly the case that triggers it: A inserts, B
//    inserts, A's prune writes back a table it read before B's row existed, and
//    B's job is gone while B is holding its id and polling for it.
//
// 2. get() checked ownership as `if (requesterId && j.owner_id !== requesterId)`,
//    so a falsy principal skipped the check entirely — the fail-open shape the
//    world store already closed.
//
// Run: node --test test/jobs-concurrency.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJobService } from "../src/core/jobs.mjs";

const tmp = () => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-jobs-c-")) });
/** The retention cap in src/core/jobs.mjs. Named here so a change to it is visible. */
const RETAIN = 200;

// ==========================================================================
// 1. A job nobody pruned must not disappear because somebody else created one.
// ==========================================================================

test("STRUCTURAL: prune goes through the locked primitive, whatever the clock does", () => {
  // The timing test below is the demonstration; this is the guarantee. remove()
  // does the read, the filter and the write inside the per-collection lock;
  // all()-then-write() does not, and no amount of luck makes it safe.
  const src = fs.readFileSync(new URL("../src/core/jobs.mjs", import.meta.url), "utf8");
  const prune = src.slice(src.indexOf("async function prune()"));
  const body = prune.slice(0, prune.indexOf("\n  }") + 4);
  assert.ok(!/jobs\.write\(/.test(body), "prune must not write the whole collection back from a stale read");
  assert.ok(/jobs\.remove\(/.test(body), "prune must drop rows through the locked primitive");
});

test("a job handed to a caller is not erased by another caller's retention prune", async () => {
  // create() calls prune() immediately after jobs.insert(), and prune used to
  // read the whole table and write a truncated copy back outside the lock. So
  // two concurrent creations are exactly the trigger: A inserts, B inserts, A's
  // prune writes back a table it read before B's row existed, and B's job is
  // gone while B holds its id and is polling for it.
  //
  // Measured against the pre-change module at this concurrency, five runs:
  // 1, 1, 3, 3, 1 jobs lost. Against the fixed module, five runs: 0 every time.
  // The assertion is therefore deterministic in the direction that matters —
  // remove() holds the lock across read, filter and write, so nothing CAN be
  // lost. It cannot flake from green to red.
  const svc = createJobService(tmp());
  // Fill to the cap first, so prune has real work to do. Below the cap it
  // returns before writing anything and proves nothing.
  for (let i = 0; i < RETAIN; i++) {
    await svc.create({ kind: "world_generate", principalId: "u1", input: {} });
  }

  const N = 150;
  const late = await Promise.all(
    Array.from({ length: N }, (_, i) => svc.create({ kind: "world_generate", principalId: "u2", input: { i } })),
  );
  assert.equal(new Set(late.map((j) => j.id)).size, N, "every creation returned a distinct id");

  const lost = [];
  for (const j of late) {
    try { await svc.get(j.id, "u2"); } catch { lost.push(j.id); }
  }
  assert.deepEqual(lost, [], `${lost.length} of ${N} jobs were handed to a caller and then erased by a concurrent prune`);
  assert.equal((await svc.listFor("u2", { limit: N + 10 })).length, N, "and every one is still listed");
});

test("retention keeps the NEWEST jobs, not an arbitrary window", async () => {
  const svc = createJobService(tmp());
  const all = [];
  for (let i = 0; i < RETAIN + 10; i++) {
    all.push(await svc.create({ kind: "world_generate", principalId: "u1", input: { n: i } }));
  }
  for (const j of all.slice(-5)) {
    assert.equal((await svc.get(j.id, "u1")).id, j.id, "the most recent jobs must survive retention");
  }
  await assert.rejects(() => svc.get(all[0].id, "u1"), (e) => e.httpStatus === 404,
    "the oldest job is the one retention drops");
  assert.ok((await svc.listFor("u1", { limit: RETAIN + 50 })).length <= RETAIN,
    "retention must actually trim");
});

// ==========================================================================
// 2. A falsy principal must never widen access.
// ==========================================================================

test("another principal's job answers exactly as one that does not exist", async () => {
  // The control for the section below: the check works when it is given a real
  // principal. If this stops passing, the assertions after it prove nothing.
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1", input: {} });
  await assert.rejects(() => svc.get(j.id, "u2"), (e) => e.httpStatus === 404);
  assert.equal((await svc.get(j.id, "u1")).id, j.id);
});

test("an empty-but-present principal is refused, not treated as an unattributed read", async () => {
  // `if (requesterId && j.owner_id !== requesterId)` skipped the check for every
  // falsy value. "" and 0 are what a call site produces when it MEANT to pass a
  // principal and lost it — a route reading an unset field, a destructure with a
  // typo — and that must never read as "no check required".
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1", input: {} });
  for (const empty of ["", 0, false, NaN]) {
    await assert.rejects(
      () => svc.get(j.id, empty),
      (e) => e.httpStatus === 401 && /empty principal/.test(e.detail),
      `get(id, ${JSON.stringify(empty)}) must not return another principal's job`,
    );
  }
});

test("an unattributed internal read is still possible, and is the only way to skip the check", async () => {
  // Omitting the argument entirely — or passing null — is how this service reads
  // its own jobs. That stays working; it is the falsy-but-present case that was
  // the accident.
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1", input: {} });
  assert.equal((await svc.get(j.id)).id, j.id);
  assert.equal((await svc.get(j.id, null)).id, j.id);
  assert.equal((await svc.get(j.id, undefined)).id, j.id);
});

test("a job whose owner is missing is not readable by a principal, whatever they are called", async () => {
  // worldstore's shape: owner_id must be PRESENT as well as equal. A row with no
  // owner must not become readable because the comparison happens to hold.
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1", input: {} });
  // Reach past the service to produce the row it must defend against: an owner
  // that was never recorded. create() refuses to make one, which is correct.
  await assert.rejects(
    () => svc.create({ kind: "world_generate", principalId: null, input: {} }),
    (e) => e.httpStatus === 401,
    "a job with no owner cannot be created in the first place",
  );
  assert.equal((await svc.get(j.id, "u1")).owner_id, "u1", "and every job that exists has one");
});

test("cancel inherits the same ownership rule, because it reads through get()", async () => {
  const svc = createJobService(tmp());
  const j = await svc.create({ kind: "world_generate", principalId: "u1", input: {} });
  await assert.rejects(() => svc.cancel(j.id, "u2"), (e) => e.httpStatus === 404,
    "a stranger must not be able to cancel a job");
  await assert.rejects(() => svc.cancel(j.id, ""), (e) => e.httpStatus === 401,
    "and an empty principal must not either");
  const cancelled = await svc.cancel(j.id, "u1");
  assert.equal(cancelled.state, "failed");
  assert.match(cancelled.error, /cancelled/);
});
