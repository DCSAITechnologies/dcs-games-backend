// GAMES-C Agent 2 — World Memory v2 (versioning / persistence) tests.
//
// Uses the real GAMES-C patch module (src/v3/gamesc/patch/index.mjs) when it
// exists; otherwise a minimal local stub implementing the same contract for the
// op kinds these tests use. Which engine ran is printed as a diagnostic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  createWorldMemoryV2, createMemoryAdapter, createFsAdapter, loadPatchModule, hashValue, versionHash, defaultHashManifest,
} from "../src/v3/gamesc/memory/index.mjs";
import { emptyManifest } from "../src/v3/manifest/schema.mjs";

// ---------------------------------------------------------------- engine
// GAMESC_MEMORY_FORCE_STUB=1 runs the same suite against the local stub.
const real = process.env.GAMESC_MEMORY_FORCE_STUB === "1" ? null : await loadPatchModule();

/** Minimal stub of the patch contract: set / add / remove / update, with inverses. */
function stubEngine() {
  const hashManifest = defaultHashManifest;
  const getP = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  const setP = (o, p, v) => { const ks = p.split("."); const last = ks.pop(); let x = o; for (const k of ks) x = x[k] ??= {}; x[last] = v; };
  function applyPatch(manifest, patch) {
    if (patch.base_hash && patch.base_hash !== hashManifest(manifest)) return { ok: false, errors: [{ message: "base hash mismatch" }] };
    const m = structuredClone(manifest);
    const inv = [];
    for (const [i, op] of (patch.ops || []).entries()) {
      if (op.op === "set") { inv.unshift({ op: "set", path: op.path, value: getP(m, op.path) }); setP(m, op.path, op.value); }
      else if (op.op === "add") { (m[op.collection] ||= []).push(op.value); inv.unshift({ op: "remove", collection: op.collection, id: op.value.id }); }
      else if (op.op === "remove") { const arr = m[op.collection] || []; const x = arr.find((e) => e.id === op.id); if (!x) return { ok: false, errors: [{ op_index: i, message: "no such id" }] }; m[op.collection] = arr.filter((e) => e.id !== op.id); inv.unshift({ op: "add", collection: op.collection, value: x }); }
      else if (op.op === "update") { const x = (m[op.collection] || []).find((e) => e.id === op.id); if (!x) return { ok: false, errors: [{ op_index: i }] }; const old = {}; for (const k of Object.keys(op.set)) old[k] = x[k]; Object.assign(x, op.set); inv.unshift({ op: "update", collection: op.collection, id: op.id, set: old }); }
      else return { ok: false, errors: [{ op_index: i, message: `unknown op ${op.op}` }] };
    }
    m.world_version = (manifest.world_version || 0) + 1;
    return { ok: true, manifest: m, inverse: { ...patch, patch_id: patch.patch_id + "_inv", ops: inv }, errors: [] };
  }
  function replayPatches(base, patches) {
    let m = base;
    for (const [i, p] of patches.entries()) { const r = applyPatch(m, p); if (!r.ok) return { ok: false, manifest: m, applied: i, errors: r.errors }; m = r.manifest; }
    return { ok: true, manifest: m, applied: patches.length, errors: [] };
  }
  return { applyPatch, replayPatches, hashManifest, diffManifests: null, name: "local-stub" };
}

const engine = real
  ? { applyPatch: real.applyPatch, replayPatches: real.replayPatches, hashManifest: real.hashManifest, diffManifests: real.diffManifests, name: "src/v3/gamesc/patch (real)" }
  : stubEngine();
test(`diagnostic: patch engine under test = ${engine.name}`, () => { assert.ok(engine.applyPatch); });

const { name: _n, ...inject } = engine;
const mk = (opts = {}) => createWorldMemoryV2({ ...inject, ...opts });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gamesc-memory-"));
const base = (worldId) => ({ ...emptyManifest({ worldId, title: "Test World", creatorId: "u1" }), meta: { ...emptyManifest({ worldId }).meta, created_at: "2026-09-28T00:00:00.000Z", updated_at: "2026-09-28T00:00:00.000Z", title: "Test World", creator_id: "u1" } });
let pn = 0;
function patchFor(head, ops, extra = {}) {
  return {
    patch_version: "1", patch_id: "p_" + crypto.randomBytes(6).toString("hex") + (pn++),
    world_id: head.world_id, base_version: head.version, base_hash: head.manifest_hash,
    author: { kind: "user", id: "u1" }, intent: { text: "test edit", category: "lighting_weather" },
    created_at: "2026-09-28T00:00:00.000Z", ops, ...extra,
  };
}
const tod = (k) => [{ op: "set", path: "environment.time_of_day", value: Math.round((k % 100) * 0.01 * 100) / 100 }];
async function editN(mem, w, n, start = 1) {
  for (let k = start; k < start + n; k++) {
    const head = await mem.head(w);
    await mem.edit(w, patchFor(head, tod(k)));
  }
}
const reason = (e) => e?.meta?.reason;

// ------------------------------------------------------------------ tests
test("SAVE/RETURN round trip: manifest, spec, player state, companion context, history", async () => {
  const mem = mk();
  const w = "w_round";
  const m = base(w);
  const s1 = await mem.save(w, { manifest: m, spec: { genre: "platformer", rules: { lives: 3 } }, author: "u1", label: "genesis" });
  assert.equal(s1.idempotent, false);
  assert.equal(s1.version.version, 1);
  assert.equal(s1.version.parent_hash, null);
  assert.equal(s1.version.manifest_hash, engine.hashManifest(m));

  const again = await mem.save(w, { manifest: structuredClone(m), spec: { rules: { lives: 3 }, genre: "platformer" } });
  assert.equal(again.idempotent, true, "same content + same spec is a no-op");
  assert.equal((await mem.listVersions(w)).length, 1);

  await mem.putPlayerState(w, "player-1", { position: { x: 1, y: 2, z: 3 }, inventory: ["key"], progress: { quest_a: "done" } });
  await mem.putCompanionContext(w, "player-1", { mood: "curious", notes: ["likes rain"] });
  await mem.recordGeneration(w, { lane: "world", provider: "offline", stage: "layout", version: 1, output_hash: s1.version.manifest_hash });

  const r = await mem.resume(w, { player_id: "player-1" });
  assert.equal(r.version, 1);
  assert.equal(r.manifest_hash, engine.hashManifest(r.manifest));
  assert.deepEqual(r.manifest, m);
  assert.deepEqual(r.spec, { genre: "platformer", rules: { lives: 3 } });
  assert.deepEqual(r.player_state.data.position, { x: 1, y: 2, z: 3 });
  assert.deepEqual(r.companion_context.data, { mood: "curious", notes: ["likes rain"] });
  assert.equal(r.generation_history.length, 1);
  assert.equal(r.generation_history[0].lane, "world");
});

test("EDIT chain: versions are monotonic, hash-chained, snapshotted every K, replayable", async () => {
  const mem = mk({ limits: { snapshotEvery: 5 } });
  const w = "w_chain";
  await mem.save(w, { manifest: base(w) });
  await editN(mem, w, 12);
  const vs = await mem.listVersions(w);
  assert.equal(vs.length, 13);
  assert.deepEqual(vs.map((v) => v.version), Array.from({ length: 13 }, (_, i) => i + 1));
  assert.deepEqual(vs.filter((v) => v.snapshot).map((v) => v.version), [1, 5, 10], "genesis + every 5th");
  for (const [i, v] of vs.entries()) {
    const rec = await mem.getVersion(w, v.version);
    assert.equal(rec.parent_version, i === 0 ? null : i);
    assert.equal(rec.version_hash, versionHash(rec.parent_hash, rec.manifest_hash, rec.patch_ids));
    if (i) assert.equal(rec.parent_hash, vs[i - 1].version_hash);
  }
  const head = await mem.resume(w);
  assert.equal(head.manifest.environment.time_of_day, 0.12);
  const eh = await mem.editHistory(w, 50);
  assert.equal(eh.length, 12);
  assert.equal(eh.at(-1).version, 13);
  const vi = await mem.verifyIntegrity(w, { deep: true });
  assert.equal(vi.ok, true, JSON.stringify(vi.problems));
});

test("REPLAY reconstruction of every version equals its stored hash (incl. cross-check of snapshots)", async () => {
  const mem = mk({ limits: { snapshotEvery: 4 } });
  const w = "w_replay";
  await mem.save(w, { manifest: base(w) });
  await editN(mem, w, 10);
  for (let v = 1; v <= 11; v++) {
    const r = await mem.reconstruct(w, v);
    assert.equal(r.match, true, `v${v}`);
    assert.equal(r.manifest_hash, (await mem.getVersion(w, v)).manifest_hash);
    if (v > 1) {
      const x = await mem.reconstruct(w, v, { preferReplay: true });
      assert.equal(x.match, true, `v${v} via replay`);
      assert.ok(x.replayed_patches >= 1);
    }
  }
  const r9 = await mem.reconstruct(w, 11);
  assert.equal(r9.from_snapshot, 8, "nearest snapshot at or before v11 with K=4");
  assert.equal(r9.replayed_patches, 3);
});

test("RESTORE is non-destructive: a NEW version whose content hash equals the old one", async () => {
  const mem = mk();
  const w = "w_restore";
  await mem.save(w, { manifest: base(w) });
  await editN(mem, w, 4);
  const v3 = await mem.getVersion(w, 3);
  const before = await mem.listVersions(w);
  const r = await mem.restoreVersion(w, 3, { author: "u1" });
  assert.equal(r.version.version, 6);
  assert.equal(r.version.kind, "restore");
  assert.equal(r.version.restored_from, 3);
  assert.equal(r.version.manifest_hash, v3.manifest_hash, "content equals v3");
  assert.notEqual(r.version.version_hash, v3.version_hash, "but it is a different version in the chain");
  assert.equal(r.version.parent_version, 5);
  const after = await mem.listVersions(w);
  assert.deepEqual(after.slice(0, 5), before, "history untouched");
  assert.equal((await mem.resume(w)).manifest_hash, v3.manifest_hash);
  // Editing continues from the restored version.
  await mem.edit(w, patchFor(await mem.head(w), tod(77)));
  assert.equal((await mem.head(w)).version, 7);
  const d = await mem.diffVersions(w, 3, 6);
  assert.equal(d.same_content, true);
  assert.equal((await mem.verifyIntegrity(w, { deep: true })).ok, true);
  assert.equal((await mem.editHistory(w)).some((e) => e.kind === "restore" && e.restored_from === 3), true);
});

test("TAMPER detection: metadata, content hash, patch body, snapshot content, head", async () => {
  const adapter = createMemoryAdapter();
  const mem = mk({ adapter, limits: { snapshotEvery: 3 } });
  const w = "w_tamper";
  await mem.save(w, { manifest: base(w) });
  await editN(mem, w, 5);
  assert.equal((await mem.verifyIntegrity(w, { deep: true })).ok, true);
  const { docs, k3 } = adapter._raw;
  const mutate = (ns, key, fn) => { const k = k3(w, ns, key); const v = JSON.parse(docs.get(k)); fn(v); docs.set(k, JSON.stringify(v)); return () => {}; };
  const snapshotOf = (k) => { const orig = docs.get(k); return () => docs.set(k, orig); };
  const vk = (n) => String(n).padStart(10, "0");

  // 1. label rewritten -> record_hash
  let undo = snapshotOf(k3(w, "version", vk(2)));
  mutate("version", vk(2), (r) => { r.label = "nothing happened"; });
  let vi = await mem.verifyIntegrity(w);
  assert.deepEqual(vi.problems.map((p) => [p.version, p.code]), [[2, "record_hash"]]);
  undo();

  // 2. manifest_hash swapped -> version_hash + record_hash, and the NEXT link breaks nothing else (parent_hash still stored)
  undo = snapshotOf(k3(w, "version", vk(4)));
  mutate("version", vk(4), (r) => { r.manifest_hash = "sha256:" + "0".repeat(64); });
  vi = await mem.verifyIntegrity(w);
  assert.ok(vi.problems.some((p) => p.version === 4 && p.code === "version_hash"));
  undo();

  // 3. patch body altered -> patch_hash, and reconstruct refuses
  const p5 = (await mem.getVersion(w, 5)).patch_ids[0];
  undo = snapshotOf(k3(w, "patch", p5));
  mutate("patch", p5, (p) => { p.patch.ops[0].value = 0.99; });
  vi = await mem.verifyIntegrity(w, { deep: true });
  assert.ok(vi.problems.some((p) => p.version === 5 && p.code === "patch_hash"));
  await assert.rejects(mem.reconstruct(w, 5), (e) => reason(e) === "integrity");
  undo();

  // 4. snapshot content altered -> snapshot_hash; replay cross-check flags it too
  const h3 = (await mem.getVersion(w, 3)).manifest_hash.replace("sha256:", "");
  undo = snapshotOf(k3(w, "snapshot", h3));
  mutate("snapshot", h3, (s) => { s.manifest.meta.title = "forged"; });
  vi = await mem.verifyIntegrity(w);
  assert.ok(vi.problems.some((p) => p.version === 3 && p.code === "snapshot_hash"));
  undo();

  // 5. a whole version rewritten consistently (record_hash recomputed) still breaks the chain at the child
  undo = snapshotOf(k3(w, "version", vk(2)));
  mutate("version", vk(2), (r) => {
    r.manifest_hash = "sha256:" + "1".repeat(64);
    r.version_hash = versionHash(r.parent_hash, r.manifest_hash, r.patch_ids);
    const { record_hash, ...rest } = r; r.record_hash = hashValue(rest);
  });
  vi = await mem.verifyIntegrity(w);
  assert.ok(vi.problems.some((p) => p.version === 3 && p.code === "parent_hash"), JSON.stringify(vi.problems));
  undo();

  assert.equal((await mem.verifyIntegrity(w, { deep: true })).ok, true, "all restored -> clean");
});

test("TAMPER detection on disk (FS adapter): an edited version file is caught", async () => {
  const dir = tmpDir();
  const mem = mk({ adapter: createFsAdapter(dir) });
  const w = "w_fs_tamper";
  await mem.save(w, { manifest: base(w) });
  await editN(mem, w, 3);
  const p = createFsAdapter(dir)._paths.docPath(w, "version", "0000000002");
  const rec = JSON.parse(fs.readFileSync(p, "utf8"));
  rec.author.id = "someone-else";
  fs.writeFileSync(p, JSON.stringify(rec));
  const vi = await mem.verifyIntegrity(w);
  assert.equal(vi.ok, false);
  assert.deepEqual(vi.problems.map((x) => x.code), ["record_hash"]);
});

test("STALE edit rejected: wrong base_version or base_hash; world unchanged", async () => {
  const mem = mk();
  const w = "w_stale";
  await mem.save(w, { manifest: base(w) });
  const h1 = await mem.head(w);
  await mem.edit(w, patchFor(h1, tod(1)));
  await assert.rejects(mem.edit(w, patchFor(h1, tod(2))), (e) => e.httpStatus === 409 && reason(e) === "stale_base");
  const h2 = await mem.head(w);
  await assert.rejects(mem.edit(w, patchFor(h2, tod(3), { base_hash: h1.manifest_hash })), (e) => reason(e) === "stale_base");
  assert.equal((await mem.head(w)).version, 2);
  // expected_version is checked independently
  await assert.rejects(mem.edit(w, patchFor(h2, tod(4)), { expected_version: 1 }), (e) => reason(e) === "version_conflict");
  await assert.rejects(mem.save(w, { manifest: base(w), expected_version: 1 }), (e) => reason(e) === "version_conflict");
  // a patch for another world is refused
  await assert.rejects(mem.edit(w, patchFor({ ...h2, world_id: "other" }, tod(5))), (e) => reason(e) === "wrong_world");
});

test("EDIT idempotent by patch_id; reusing a patch_id for different content is a conflict", async () => {
  const mem = mk();
  const w = "w_idem";
  await mem.save(w, { manifest: base(w) });
  const p = patchFor(await mem.head(w), tod(10));
  const a = await mem.edit(w, p);
  const b = await mem.edit(w, structuredClone(p));
  assert.equal(b.idempotent, true);
  assert.equal(b.version.version, a.version.version);
  assert.equal((await mem.head(w)).version, 2);
  await assert.rejects(mem.edit(w, { ...p, ops: tod(11) }), (e) => reason(e) === "patch_id_reused");
});

test("CONCURRENT edits: same expected_version -> exactly one wins; unguarded saves serialise without loss", async () => {
  const mem = mk();
  const w = "w_conc";
  await mem.save(w, { manifest: base(w) });
  const h = await mem.head(w);
  const results = await Promise.allSettled([
    mem.edit(w, patchFor(h, tod(21)), { expected_version: 1 }),
    mem.edit(w, patchFor(h, tod(22)), { expected_version: 1 }),
    mem.edit(w, patchFor(h, tod(23)), { expected_version: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.httpStatus === 409));
  assert.equal((await mem.head(w)).version, 2);

  // 32 concurrent distinct saves, no guard: all 32 land as 32 contiguous versions.
  const saves = await Promise.all(Array.from({ length: 32 }, (_, i) => {
    const m = base(w); m.meta.title = "t" + i; return mem.save(w, { manifest: m });
  }));
  assert.equal(new Set(saves.map((s) => s.version.version)).size, 32);
  assert.equal((await mem.head(w)).version, 34);
  assert.equal((await mem.verifyIntegrity(w)).ok, true);
});

test("CONCURRENT writers in two PROCESS-LIKE instances over one directory: atomic create lets exactly one own vN", async () => {
  const dir = tmpDir();
  const a = mk({ adapter: createFsAdapter(dir) });
  const b = mk({ adapter: createFsAdapter(dir) });
  const w = "w_two_writers";
  await a.save(w, { manifest: base(w) });
  const h = await a.head(w);
  const r = await Promise.allSettled([a.edit(w, patchFor(h, tod(31))), b.edit(w, patchFor(h, tod(32)))]);
  const ok = r.filter((x) => x.status === "fulfilled");
  assert.equal(ok.length, 1, "one writer wins v2");
  const bad = r.find((x) => x.status === "rejected");
  assert.ok(["version_conflict", "stale_base"].includes(reason(bad.reason)), String(bad.reason));
  assert.equal((await b.head(w)).version, 2);
  // The loser's orphan patch record does not corrupt anything.
  assert.equal((await b.verifyIntegrity(w, { deep: true })).ok, true);
});

test("EXPANSION lineage: area expansion edge, fork DAG, ancestors, cycle refusal, endpoint verification", async () => {
  const mem = mk();
  await mem.save("A", { manifest: base("A") });
  const area = await mem.expand("A", { patch: patchFor(await mem.head("A"), tod(40)), area_id: "district_hospital", label: "hospital district" });
  assert.equal(area.version.kind, "expand");
  assert.equal(area.edge.kind, "expand_area");
  assert.deepEqual([area.edge.from.version, area.edge.to.version], [1, 2]);

  const b = await mem.expand("A", { child_world_id: "B", manifest: base("B"), author: "u2", label: "remix" });
  assert.equal(b.version.version, 1);
  assert.equal(b.version.kind, "fork");
  assert.deepEqual(b.version.lineage, { parent_world_id: "A", parent_version: 2, parent_version_hash: area.version.version_hash, kind: "fork" });
  await mem.expand("B", { child_world_id: "C", manifest: base("C") });
  await mem.expand("A", { child_world_id: "D", manifest: base("D"), parent_version: 1 });

  const lc = await mem.lineage("C");
  assert.deepEqual(lc.ancestors.sort(), ["A", "B"]);
  const la = await mem.lineage("A");
  assert.deepEqual(la.children.map((e) => e.to.world_id), ["A", "B", "D"]);
  assert.equal(la.children.find((e) => e.to.world_id === "D").from.version, 1, "fork pinned to an older parent version");

  await assert.rejects(mem.expand("C", { child_world_id: "A", manifest: base("A") }), (e) => reason(e) === "lineage_cycle");
  await assert.rejects(mem.expand("A", { child_world_id: "B", manifest: base("B") }), (e) => reason(e) === "child_exists");
  for (const x of ["A", "B", "C", "D"]) assert.equal((await mem.verifyLineage(x)).ok, true, x);
  const r = await mem.resume("B");
  assert.equal(r.lineage.parents[0].from.world_id, "A");
});

test("PLAYER STATE + COMPANION CONTEXT persist with optimistic revs and validation", async () => {
  const mem = mk();
  const w = "w_players";
  await mem.save(w, { manifest: base(w) });
  const s1 = await mem.putPlayerState(w, "p1", { position: { x: 0, y: 0, z: 0 }, inventory: [], progress: {} });
  assert.equal(s1.rev, 1);
  assert.equal(s1.at_version, 1);
  assert.equal(s1.source, "client_reported", "player state is labelled, never mistaken for rollback evidence");
  assert.equal((await mem.putPlayerState(w, "srv", { position: { x: 0, y: 0, z: 0 } }, { source: "server_authoritative" })).source, "server_authoritative");
  await assert.rejects(mem.putPlayerState(w, "srv", {}, { source: "trust_me" }), (e) => reason(e) === "bad_player_state");
  const s2 = await mem.putPlayerState(w, "p1", { position: { x: 5, y: 0, z: 1 }, inventory: ["gem"], progress: { q1: 1 } }, { expected_rev: 1 });
  assert.equal(s2.rev, 2);
  await assert.rejects(mem.putPlayerState(w, "p1", { position: { x: 9, y: 9, z: 9 } }, { expected_rev: 1 }), (e) => reason(e) === "rev_conflict");
  await mem.putPlayerState(w, "p2", { position: { x: 1, y: 1, z: 1 } });
  assert.deepEqual(await mem.listPlayers(w), ["p1", "p2", "srv"]);
  await assert.rejects(mem.putPlayerState(w, "p3", { position: { x: "a", y: 0, z: 0 } }), (e) => reason(e) === "bad_player_state");
  await assert.rejects(mem.putPlayerState(w, "../etc", { position: { x: 0, y: 0, z: 0 } }), (e) => reason(e) === "bad_player_id");

  const blob = { opaque: true, turns: [{ role: "companion", text: "hello" }], nested: { a: [1, 2, { b: null }] } };
  const c = await mem.putCompanionContext(w, "world", blob);
  assert.equal(c.context_hash, hashValue(blob));
  assert.deepEqual((await mem.getCompanionContext(w, "world")).data, blob, "returned verbatim");
  // resume falls back to the world-scoped context when the player has none
  assert.deepEqual((await mem.resume(w, { player_id: "p2" })).companion_context.data, blob);
});

test("FS adapter survives RESTART: a new instance on the same dir resumes, verifies, and keeps editing", async () => {
  const dir = tmpDir();
  const w = "w_restart";
  {
    const mem = mk({ adapter: createFsAdapter(dir), limits: { snapshotEvery: 3 } });
    await mem.save(w, { manifest: base(w), spec: { genre: "puzzle" } });
    await editN(mem, w, 7);
    await mem.putPlayerState(w, "p1", { position: { x: 3, y: 1, z: 4 }, inventory: ["lamp"], progress: { level: 2 } });
    await mem.putCompanionContext(w, "p1", { remembered: ["lamp"] });
    await mem.recordGeneration(w, { lane: "asset", provider: "offline", asset_ids: ["a1"] });
    await mem.restoreVersion(w, 4);
  }
  const mem2 = mk({ adapter: createFsAdapter(dir), limits: { snapshotEvery: 3 } });
  const r = await mem2.resume(w, { player_id: "p1", history_limit: 50 });
  assert.equal(r.version, 9);
  assert.equal(r.manifest_hash, (await mem2.getVersion(w, 4)).manifest_hash);
  assert.deepEqual(r.spec, { genre: "puzzle" });
  assert.deepEqual(r.player_state.data.inventory, ["lamp"]);
  assert.deepEqual(r.companion_context.data, { remembered: ["lamp"] });
  assert.equal(r.edit_history.length, 8);
  assert.equal(r.generation_history[0].lane, "asset");
  assert.equal((await mem2.verifyIntegrity(w, { deep: true })).ok, true);
  await mem2.edit(w, patchFor(await mem2.head(w), tod(55)));
  assert.equal((await mem2.head(w)).version, 10);
  for (let v = 1; v <= 10; v++) assert.equal((await mem2.reconstruct(w, v)).match, true, `v${v}`);
});

test("HEAD repair: a lost head pointer is rebuilt from the immutable version records", async () => {
  const adapter = createMemoryAdapter();
  const mem = mk({ adapter });
  const w = "w_head";
  await mem.save(w, { manifest: base(w) });
  await editN(mem, w, 3);
  await adapter.put(w, "head", "current", { version: 2, version_hash: "x", manifest_hash: "y" }); // lagging head
  const fresh = mk({ adapter });
  assert.equal((await fresh.head(w)).version, 4);
  assert.equal((await adapter.get(w, "head", "current")).version, 4);
});

test("SIZE bounds: bounded logs keep the newest; oversize blobs, manifests, inventories refused", async () => {
  const mem = mk({ limits: { maxEditHistory: 5, maxGenerationHistory: 3, maxHistoryReturn: 4, maxCompanionBytes: 200, maxInventoryItems: 3, maxManifestBytes: 20000, maxPlayerStateBytes: 300 } });
  const w = "w_bounds";
  await mem.save(w, { manifest: base(w) });
  await editN(mem, w, 9);
  const eh = await mem.editHistory(w, 100);
  assert.equal(eh.length, 4, "return capped at maxHistoryReturn");
  assert.deepEqual(eh.map((e) => e.version), [7, 8, 9, 10]);
  assert.deepEqual((await mem.adapter.tail(w, "edit_history")).map((e) => e.seq), [5, 6, 7, 8, 9], "stored log bounded to 5, seq monotonic");
  assert.equal((await mem.listVersions(w)).length, 10, "versions themselves are never dropped");
  for (let i = 0; i < 6; i++) await mem.recordGeneration(w, { lane: "l" + i });
  assert.deepEqual((await mem.generationHistory(w, 10)).map((g) => g.lane), ["l3", "l4", "l5"]);

  await assert.rejects(mem.putCompanionContext(w, "world", { big: "x".repeat(500) }), (e) => reason(e) === "too_large");
  await assert.rejects(mem.putPlayerState(w, "p", { inventory: [1, 2, 3, 4] }), (e) => reason(e) === "too_large");
  await assert.rejects(mem.putPlayerState(w, "p", { progress: { s: "y".repeat(400) } }), (e) => reason(e) === "too_large");
  const huge = base(w); huge.meta.description = "z".repeat(30000);
  await assert.rejects(mem.save(w, { manifest: huge }), (e) => reason(e) === "too_large");
  assert.equal((await mem.head(w)).version, 10, "refusals change nothing");
});

test("ASSET identity: content-hash identities are stable across edits and id renames", async () => {
  const mem = mk();
  const w = "w_assets";
  const m = base(w);
  const tree = { kind: "prop", format: "primitive", primitive: { shape: "cone", h: 3 } };
  m.assets = [{ id: "tree_1", ...tree }, { id: "rock_1", kind: "prop", format: "primitive", primitive: { shape: "box" } }];
  await mem.save(w, { manifest: m });
  const id1 = (await mem.assetIdentities(w)).by_asset_id.tree_1.at(-1).identity;
  await editN(mem, w, 3);
  assert.equal((await mem.assetIdentities(w)).by_asset_id.tree_1.length, 1, "unchanged content across edits -> no new identity");
  const m2 = structuredClone((await mem.resume(w)).manifest);
  m2.assets[0] = { id: "oak_tree", ...tree };                        // renamed, same content
  m2.assets[1] = { ...m2.assets[1], primitive: { shape: "sphere" } }; // same id, new content
  await mem.save(w, { manifest: m2 });
  const map = await mem.assetIdentities(w);
  assert.equal(map.by_asset_id.oak_tree.at(-1).identity, id1, "renamed asset keeps its identity");
  assert.equal(map.by_asset_id.rock_1.length, 2, "changed content under the same id is recorded as a move");
  assert.notEqual(map.by_asset_id.rock_1[0].identity, map.by_asset_id.rock_1[1].identity);
});

test("DIFF between versions lists the change and the versions in between", async () => {
  const mem = mk();
  const w = "w_diff";
  await mem.save(w, { manifest: base(w) });
  await editN(mem, w, 2, 30);
  const d = await mem.diffVersions(w, 1, 3);
  assert.equal(d.same_content, false);
  assert.deepEqual(d.versions_between.map((v) => v.version), [2, 3]);
  assert.ok(Array.isArray(d.ops) || typeof d.ops === "object");
  if (!engine.diffManifests) assert.deepEqual(d.ops.map((o) => o.path), ["environment.time_of_day"]);
});

test("NO patch engine: EDIT is refused as not_configured, SAVE/RETURN still work", async () => {
  const mem = createWorldMemoryV2();
  await mem.save("w_noeng", { manifest: base("w_noeng") });
  await assert.rejects(mem.edit("w_noeng", patchFor(await mem.head("w_noeng"), tod(1))), (e) => e.httpStatus === 503 && reason(e) === "no_patch_engine");
  assert.equal((await mem.resume("w_noeng")).version, 1);
  await assert.rejects(mem.save("../x", { manifest: {} }), (e) => reason(e) === "bad_world_id");
});

test("WIRING: createWorldMemoryV2WithPatchModule picks up the real patch module when present", async () => {
  const { createWorldMemoryV2WithPatchModule } = await import("../src/v3/gamesc/memory/index.mjs");
  const { memory, patchModule } = await createWorldMemoryV2WithPatchModule();
  if (!patchModule) return; // module absent: nothing to wire (the stub path is covered above)
  const w = "w_wired";
  await memory.save(w, { manifest: base(w) });
  const p = patchModule.createPatch({ manifest: (await memory.resume(w)).manifest, ops: tod(12), author: { kind: "companion", id: "c1" }, world_id: w });
  const r = await memory.edit(w, p);
  assert.equal(r.version.version, 2);
  assert.equal(r.version.author.kind, "companion");
  assert.ok(r.inverse && Array.isArray(r.inverse.ops), "inverse patch recorded");
  assert.equal((await memory.verifyIntegrity(w, { deep: true })).ok, true);
});
