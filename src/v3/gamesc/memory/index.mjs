// GAMES-C — World Memory v2 (versioning + persistence facade).
//
// What the existing estate already has, and what this adds:
//   src/core/worldstore.mjs      WorldRepository: ONE current manifest per world
//                                + retained full-manifest versions (0003
//                                dcsgames_world_versions). No parent pointer, no
//                                patch record, no hash chain.
//   src/v3/memory/world-memory   B7 chronicle of FACTS (what NPCs may cite).
//                                Unchanged; this module does not replace it.
//   src/v3/expansion/rollback    planRollback: rollback = NEW version with old
//                                content. restoreVersion() here keeps that rule.
//
// This facade adds: an immutable, monotonic, hash-chained version log whose
// edit versions are PATCHES (with inverses) replayable from content-addressed
// snapshots taken every K versions; per-player state; opaque companion context;
// generation provenance; an asset identity map keyed by content hash; and an
// expansion/fork lineage DAG. Storage is a pluggable adapter (adapters.mjs).
//
// The patch engine is INJECTED (applyPatch / replayPatches / hashManifest /
// diffManifests), so this module works with the GAMES-C patch module, a stub, or
// a future engine. loadPatchModule() wires the real one when it is present.
import { Errors } from "../../../core/errors.mjs";
import { createKeyedMutex } from "../../../core/mutex.mjs";
import { canonicalJSON, hashValue, defaultHashManifest, versionHash, recordDigest, hexOf, jsonBytes } from "./hash.mjs";
import { createMemoryAdapter, createFsAdapter } from "./adapters.mjs";

export { createMemoryAdapter, createFsAdapter, canonicalJSON, hashValue, versionHash, recordDigest, defaultHashManifest };

export const MEMORY_VERSION = "2";

export const DEFAULT_LIMITS = Object.freeze({
  snapshotEvery: 10,              // K: an edit version whose number is a multiple of K is also snapshotted
  maxEditHistory: 500,            // bounded edit-history log (summaries; patch bodies are kept per version)
  maxGenerationHistory: 500,      // bounded generation-provenance log
  maxHistoryReturn: 100,          // most history rows a RETURN can ask for
  maxManifestBytes: 5 * 1024 * 1024,
  maxSpecBytes: 256 * 1024,
  maxPlayerStateBytes: 32 * 1024,
  maxInventoryItems: 1000,
  maxCompanionBytes: 64 * 1024,
  maxLabelChars: 200,
  maxAssetIdHistory: 50,          // per asset id, how many content changes are remembered
});

/** Version kinds. Only patch-based kinds may lack a snapshot. */
export const VERSION_KINDS = ["save", "edit", "restore", "expand", "fork"];

const SAFE_ID = /^[A-Za-z0-9._:@-]{1,200}$/;
const vkey = (n) => String(n).padStart(10, "0");
const fail = (make, msg, reason, meta = {}) => make(msg, { meta: { reason, ...meta } });

function authorOf(a) {
  if (!a) return { kind: "system", id: null };
  if (typeof a === "string") return { kind: "user", id: a };
  return { kind: ["user", "companion", "system"].includes(a.kind) ? a.kind : "user", id: a.id ?? null };
}

/**
 * Try to load the GAMES-C patch module. Returns its exports, or null if it is
 * not there yet. The facade never requires it; this is only a convenience.
 */
export async function loadPatchModule() {
  try { return await import("../patch/index.mjs"); }
  catch (e) { if (e?.code === "ERR_MODULE_NOT_FOUND") return null; throw e; }
}

/** Minimal structural diff used when no diffManifests is injected. */
export function genericDiff(a, b, base = "") {
  const out = [];
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  const byId = (arr) => Array.isArray(arr) && arr.length && arr.every((x) => isObj(x) && typeof x.id === "string");
  if (canonicalJSON(a) === canonicalJSON(b)) return out;
  if (byId(a) && byId(b)) {
    const ma = new Map(a.map((x) => [x.id, x])), mb = new Map(b.map((x) => [x.id, x]));
    for (const [id, x] of ma) if (!mb.has(id)) out.push({ op: "removed", path: `${base}[${id}]`, before: x });
    for (const [id, x] of mb) if (!ma.has(id)) out.push({ op: "added", path: `${base}[${id}]`, after: x });
    for (const [id, x] of ma) if (mb.has(id)) out.push(...genericDiff(x, mb.get(id), `${base}[${id}]`));
    return out;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = base ? `${base}.${k}` : k;
      if (!(k in b)) out.push({ op: "removed", path: p, before: a[k] });
      else if (!(k in a)) out.push({ op: "added", path: p, after: b[k] });
      else out.push(...genericDiff(a[k], b[k], p));
    }
    return out;
  }
  out.push({ op: "changed", path: base || "$", before: a, after: b });
  return out;
}

/**
 * @param {object} o
 * @param {object} [o.adapter]        storage adapter (default: in-memory)
 * @param {Function} [o.applyPatch]   (manifest, patch) -> {ok, manifest, inverse, errors}
 * @param {Function} [o.replayPatches](base, patches[]) -> {ok, manifest, applied, errors}
 * @param {Function} [o.hashManifest] (manifest) -> "sha256:<hex>"
 * @param {Function} [o.diffManifests](a, b) -> ops[]
 * @param {object} [o.limits]         overrides for DEFAULT_LIMITS
 * @param {Function} [o.clock]        () -> ISO string (tests)
 * @param {boolean}  [o.stampWorldVersion=true] keep manifest.world_version equal
 *        to the record version (the patch engine checks base_version against it).
 *        world_version is a volatile field, so stamping never changes a content hash.
 */
export function createWorldMemoryV2({
  adapter = createMemoryAdapter(),
  applyPatch = null,
  replayPatches = null,
  hashManifest = defaultHashManifest,
  diffManifests = null,
  limits = {},
  clock = () => new Date().toISOString(),
  stampWorldVersion = true,
} = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (!Number.isInteger(L.snapshotEvery) || L.snapshotEvery < 1) throw new Error("snapshotEvery must be a positive integer");
  const lock = createKeyedMutex();
  const headCache = new Map();          // worldId -> {version_hash, manifest}  (in-process only)

  const checkWorld = (w) => {
    if (!SAFE_ID.test(String(w))) throw fail(Errors.validation, `unsafe world id: ${String(w).slice(0, 60)}`, "bad_world_id");
    return String(w);
  };
  const checkBytes = (v, max, what) => {
    const n = jsonBytes(v);
    if (n > max) throw fail(Errors.validation, `${what} is ${n} bytes; the limit is ${max}`, "too_large", { bytes: n, limit: max, what });
    return n;
  };
  /**
   * ONE counter. The estate has two (manifest world_version vs repository
   * record version) and rollback.mjs has to be told which one a caller means.
   * Here the facade owns world_version: it always equals the record version of
   * the version that holds the manifest.
   */
  const stamp = (m, v) => (stampWorldVersion && m && typeof m === "object" && !Array.isArray(m) ? { ...m, world_version: v } : m);
  const cleanLabel = (s) => (s == null ? null : String(s).slice(0, L.maxLabelChars));

  // ------------------------------------------------------------- versions
  async function readVersion(w, n) { return await adapter.get(w, "version", vkey(n)); }

  /**
   * The newest version record, or null. The head document is a cache; the
   * version records are the truth, so a head that lags (a crash between the
   * version write and the head write) is repaired forward on read.
   */
  async function headRecord(w) {
    const h = await adapter.get(w, "head", "current");
    let n = h?.version || 0;
    let rec = n ? await readVersion(w, n) : null;
    for (;;) {
      const next = await readVersion(w, n + 1);
      if (!next) break;
      rec = next; n += 1;
    }
    if (rec && (!h || h.version !== rec.version)) {
      await adapter.put(w, "head", "current", { version: rec.version, version_hash: rec.version_hash, manifest_hash: rec.manifest_hash });
    }
    return rec;
  }

  function buildVersion(w, head, { manifest_hash, patch_ids = [], patch_hashes = [], kind, snapshot, author, label = null, restored_from = null, spec_hash = null, lineage = null }) {
    const parent_hash = head?.version_hash ?? null;
    const rec = {
      memory_version: MEMORY_VERSION,
      world_id: w,
      version: (head?.version || 0) + 1,
      parent_version: head?.version ?? null,
      parent_hash,
      manifest_hash,
      patch_ids,
      patch_hashes,
      version_hash: versionHash(parent_hash, manifest_hash, patch_ids),
      kind,
      snapshot: !!snapshot,
      author: authorOf(author),
      label: cleanLabel(label),
      restored_from,
      spec_hash,
      lineage,
      created_at: clock(),
    };
    rec.record_hash = recordDigest(rec);
    return rec;
  }

  /** Commit a version: atomic create, so two writers can never both own version N. */
  async function commitVersion(w, rec) {
    const r = await adapter.put(w, "version", vkey(rec.version), rec, { ifAbsent: true });
    if (!r.ok) {
      throw fail(Errors.conflict, `world ${w} already has v${rec.version}; another writer got there first`, "version_conflict", { version: rec.version });
    }
    await adapter.put(w, "head", "current", { version: rec.version, version_hash: rec.version_hash, manifest_hash: rec.manifest_hash });
    return rec;
  }

  async function putSnapshot(w, manifest, manifest_hash) {
    // Content-addressed: a restore to old content reuses the old snapshot, and
    // a writer that loses a version race leaves nothing that can be misread.
    await adapter.put(w, "snapshot", hexOf(manifest_hash), { manifest_hash, manifest }, { ifAbsent: true });
  }

  function expectVersion(head, expected_version) {
    if (expected_version === null || expected_version === undefined) return;
    const have = head?.version || 0;
    if (Number(expected_version) !== have) {
      throw fail(Errors.conflict, `world was modified concurrently (have v${have}, expected v${expected_version})`, "version_conflict", { have, expected: Number(expected_version) });
    }
  }

  function doReplay(base, patches) {
    if (!patches.length) return { ok: true, manifest: base, errors: [] };
    if (replayPatches) return replayPatches(base, patches);
    if (!applyPatch) return { ok: false, errors: [{ message: "no patch engine injected (applyPatch/replayPatches)" }] };
    let m = base;
    for (const [i, p] of patches.entries()) {
      const r = applyPatch(m, p);
      if (!r?.ok) return { ok: false, manifest: m, applied: i, errors: r?.errors || [] };
      m = r.manifest;
    }
    return { ok: true, manifest: m, applied: patches.length, errors: [] };
  }

  /**
   * Rebuild version n: nearest snapshot at or before n, then replay the patches
   * of every version after it. preferReplay skips n's OWN snapshot when n is a
   * patch version, so a snapshot can be cross-checked against the patch chain.
   */
  async function reconstruct(worldId, n, { preferReplay = false } = {}) {
    const w = checkWorld(worldId);
    const target = await readVersion(w, Number(n));
    if (!target) throw fail(Errors.notFound, `version ${n} of world ${w}`, "no_version");
    const chain = [];
    let cur = target;
    for (;;) {
      const skipOwn = preferReplay && cur === target && cur.patch_ids.length > 0;
      if (cur.snapshot && !skipOwn) break;
      if (!cur.patch_ids.length) {
        throw fail(Errors.internal, `v${cur.version} has neither a snapshot nor patches; it cannot be rebuilt`, "integrity", { version: cur.version });
      }
      chain.unshift(cur);
      const parent = cur.parent_version ? await readVersion(w, cur.parent_version) : null;
      if (!parent) throw fail(Errors.internal, `v${cur.version}'s parent is missing`, "integrity", { version: cur.version });
      cur = parent;
    }
    const snap = await adapter.get(w, "snapshot", hexOf(cur.manifest_hash));
    if (!snap) throw fail(Errors.internal, `snapshot for v${cur.version} is missing`, "integrity", { version: cur.version });
    if (hashManifest(snap.manifest) !== cur.manifest_hash) {
      throw fail(Errors.internal, `snapshot for v${cur.version} does not hash to its recorded manifest_hash`, "integrity", { version: cur.version });
    }
    const patches = [];
    for (const v of chain) {
      for (const [i, id] of v.patch_ids.entries()) {
        const pr = await adapter.get(w, "patch", id);
        if (!pr) throw fail(Errors.internal, `patch ${id} (v${v.version}) is missing`, "integrity", { version: v.version, patch_id: id });
        if (hashValue(pr.patch) !== v.patch_hashes[i] || pr.patch_hash !== v.patch_hashes[i]) {
          throw fail(Errors.internal, `patch ${id} (v${v.version}) does not match the hash its version recorded`, "integrity", { version: v.version, patch_id: id });
        }
        patches.push(pr.patch);
      }
    }
    const r = doReplay(snap.manifest, patches);
    if (!r?.ok) throw fail(Errors.internal, `replay to v${n} failed`, "replay_failed", { errors: (r?.errors || []).slice(0, 10) });
    const rebuilt = stamp(r.manifest, target.version);
    const manifest_hash = hashManifest(rebuilt);
    return {
      version: target.version, manifest: rebuilt, manifest_hash,
      expected_hash: target.manifest_hash, match: manifest_hash === target.manifest_hash,
      from_snapshot: cur.version, replayed_versions: chain.length, replayed_patches: patches.length,
    };
  }

  /** The manifest AT a version record, refusing to hand out content that fails its hash. */
  async function manifestOf(w, rec) {
    const c = headCache.get(w);
    if (c && c.version_hash === rec.version_hash) return structuredClone(c.manifest);
    const r = await reconstruct(w, rec.version);
    if (!r.match) throw fail(Errors.internal, `v${rec.version} rebuilt to ${r.manifest_hash}, recorded ${rec.manifest_hash}`, "integrity", { version: rec.version });
    return r.manifest;
  }
  const cacheHead = (w, rec, manifest) => headCache.set(w, { version_hash: rec.version_hash, manifest: structuredClone(manifest) });

  // ------------------------------------------------------- asset identity
  /**
   * Asset identity = hash of the asset's CONTENT (every field but `id`). The
   * same model re-added under a new id, or carried unchanged through a hundred
   * edits, keeps one identity; a replace_asset that changes content gets a new
   * one, and the asset id's history records the move.
   */
  async function registerAssets(w, manifest, version) {
    if (!Array.isArray(manifest?.assets)) return;
    const map = (await adapter.get(w, "assets", "map")) || { by_content: {}, by_asset_id: {} };
    let changed = false;
    for (const a of manifest.assets) {
      if (!a || typeof a !== "object" || typeof a.id !== "string") continue;
      const { id, ...content } = a;
      const ch = hashValue(content);
      const hex = hexOf(ch);
      const slot = map.by_content[hex];
      if (!slot) { map.by_content[hex] = { identity: "asset_" + hex.slice(0, 16), content_hash: ch, first_version: version, asset_ids: [id] }; changed = true; }
      else if (!slot.asset_ids.includes(id)) { slot.asset_ids.push(id); changed = true; }
      const hist = map.by_asset_id[id] || (map.by_asset_id[id] = []);
      if (hist.at(-1)?.content_hash !== ch) {
        hist.push({ version, content_hash: ch, identity: "asset_" + hex.slice(0, 16) });
        if (hist.length > L.maxAssetIdHistory) hist.splice(0, hist.length - L.maxAssetIdHistory);
        changed = true;
      }
    }
    if (changed) await adapter.put(w, "assets", "map", map);
  }

  // ------------------------------------------------------------------ API
  async function save(worldId, { manifest, spec, author = null, label = null, expected_version = null, kind = "save", restored_from = null, lineage = null, idempotent = true } = {}) {
    const w = checkWorld(worldId);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw fail(Errors.validation, "manifest must be an object", "bad_manifest");
    if (!VERSION_KINDS.includes(kind)) throw fail(Errors.validation, `kind must be one of ${VERSION_KINDS.join(", ")}`, "bad_kind");
    checkBytes(manifest, L.maxManifestBytes, "manifest");
    return await lock(`w:${w}`, async () => {
      const head = await headRecord(w);
      expectVersion(head, expected_version);
      const nextV = (head?.version || 0) + 1;
      const stored = stamp(manifest, nextV);
      const manifest_hash = hashManifest(stored);
      let spec_hash = head?.spec_hash ?? null;
      if (spec !== undefined && spec !== null) {
        checkBytes(spec, L.maxSpecBytes, "game spec");
        spec_hash = hashValue(spec);
        await adapter.put(w, "spec", hexOf(spec_hash), { spec_hash, spec }, { ifAbsent: true });
      }
      // SAVE is idempotent by content: re-saving what is already the head is a
      // no-op that returns the head, so a retried request cannot mint versions.
      if (idempotent && kind === "save" && head && head.manifest_hash === hashManifest(stamp(manifest, head.version)) && head.spec_hash === spec_hash) {
        return { idempotent: true, version: head };
      }
      await putSnapshot(w, stored, manifest_hash);
      const rec = buildVersion(w, head, { manifest_hash, kind, snapshot: true, author, label, restored_from, spec_hash, lineage });
      await commitVersion(w, rec);
      await registerAssets(w, stored, rec.version);
      cacheHead(w, rec, stored);
      if (kind === "restore") {
        await adapter.append(w, "edit_history", { version: rec.version, kind, restored_from, author: rec.author, label: rec.label, manifest_hash, at: rec.created_at }, { max: L.maxEditHistory });
      }
      return { idempotent: false, version: rec };
    });
  }

  async function edit(worldId, patch, { expected_version = null, kind = "edit", label = null } = {}) {
    const w = checkWorld(worldId);
    if (!applyPatch) throw fail(Errors.notConfigured, "patch engine (applyPatch)", "no_patch_engine");
    if (!patch || typeof patch !== "object" || !SAFE_ID.test(String(patch.patch_id || ""))) {
      throw fail(Errors.validation, "patch must be an object with a safe patch_id", "bad_patch");
    }
    if (patch.world_id != null && patch.world_id !== w) throw fail(Errors.validation, `patch is for world ${patch.world_id}, not ${w}`, "wrong_world");
    const patch_hash = hashValue(patch);
    return await lock(`w:${w}`, async () => {
      // Idempotent by patch_id: a retried edit returns the version it made.
      const prior = await adapter.get(w, "patch", patch.patch_id);
      if (prior) {
        const pv = await readVersion(w, prior.version);
        if (pv && pv.patch_ids.includes(patch.patch_id)) {
          if (prior.patch_hash !== patch_hash) throw fail(Errors.conflict, `patch_id ${patch.patch_id} was already used for a different patch`, "patch_id_reused");
          return { idempotent: true, version: pv, inverse: prior.inverse };
        }
        // otherwise an orphan from a write that lost its race or crashed: overwrite below
      }
      const head = await headRecord(w);
      if (!head) throw fail(Errors.notFound, `world ${w}`, "no_world");
      expectVersion(head, expected_version);
      if (Number(patch.base_version) !== head.version || patch.base_hash !== head.manifest_hash) {
        throw fail(Errors.conflict, `stale edit: patch is based on v${patch.base_version}, world is at v${head.version}`, "stale_base",
          { head_version: head.version, head_hash: head.manifest_hash, base_version: patch.base_version ?? null, base_hash: patch.base_hash ?? null });
      }
      const current = await manifestOf(w, head);
      const r = applyPatch(current, patch);
      if (!r?.ok) throw fail(Errors.validation, "patch was rejected by the patch engine", "patch_rejected", { errors: (r?.errors || []).slice(0, 20) });
      const next = head.version + 1;
      const after = stamp(r.manifest, next);
      checkBytes(after, L.maxManifestBytes, "manifest");
      const manifest_hash = hashManifest(after);
      const snapshot = next % L.snapshotEvery === 0;
      const author = authorOf(patch.author);
      await adapter.put(w, "patch", patch.patch_id, {
        patch_id: patch.patch_id, world_id: w, version: next, patch, patch_hash, inverse: r.inverse ?? null, author, created_at: clock(),
      });
      if (snapshot) await putSnapshot(w, after, manifest_hash);
      const rec = buildVersion(w, head, { manifest_hash, patch_ids: [patch.patch_id], patch_hashes: [patch_hash], kind, snapshot, author, label: label ?? patch.intent?.text ?? null, spec_hash: head.spec_hash ?? null });
      await commitVersion(w, rec);
      await adapter.append(w, "edit_history", {
        version: rec.version, kind, patch_id: patch.patch_id, author, intent: patch.intent ?? null,
        op_count: Array.isArray(patch.ops) ? patch.ops.length : null, manifest_hash, at: rec.created_at,
      }, { max: L.maxEditHistory });
      await registerAssets(w, after, rec.version);
      cacheHead(w, rec, after);
      return { idempotent: false, version: rec, inverse: r.inverse ?? null, manifest_hash };
    });
  }

  /**
   * RESTORE is non-destructive, exactly like rollback.mjs: the old content is
   * re-committed as a NEW version (v1..v5, restore v2 -> v6 with v2's content).
   * Nothing is deleted; the chain only grows. Player-state protection (the
   * planRollback live-state refusal) stays the caller's job — see the spec.
   */
  async function restoreVersion(worldId, n, { expected_version = null, author = null, label = null } = {}) {
    const w = checkWorld(worldId);
    const r = await reconstruct(w, Number(n));
    if (!r.match) throw fail(Errors.internal, `v${n} does not rebuild to its recorded hash; refusing to restore corrupted content`, "integrity", { version: Number(n) });
    const out = await save(w, { manifest: r.manifest, author, label: label ?? `restored v${n}`, expected_version, kind: "restore", restored_from: Number(n), idempotent: false });
    return { ...out, restored_from: Number(n), manifest_hash: r.manifest_hash };
  }

  async function expand(parentWorldId, { child_world_id = null, manifest = null, patch = null, kind = null, area_id = null, label = null, author = null, parent_version = null, expected_version = null } = {}) {
    const pw = checkWorld(parentWorldId);
    const same = !child_world_id || child_world_id === pw;
    if (same) {
      // An AREA expansion inside the same world: a new version, plus an edge.
      const head = await headRecord(pw);
      if (!head) throw fail(Errors.notFound, `world ${pw}`, "no_world");
      let out;
      if (patch) out = await edit(pw, patch, { expected_version, kind: "expand", label });
      else if (manifest) out = await save(pw, { manifest, author, label, expected_version, kind: "expand", idempotent: false });
      else throw fail(Errors.validation, "an area expansion needs a patch or a manifest", "bad_expand");
      const edge = {
        kind: kind || "expand_area", area_id, label: cleanLabel(label), author: authorOf(author ?? patch?.author),
        from: { world_id: pw, version: out.version.parent_version, version_hash: out.version.parent_hash },
        to: { world_id: pw, version: out.version.version, version_hash: out.version.version_hash }, at: clock(),
      };
      await adapter.append(pw, "lineage_out", edge);
      return { ...out, edge };
    }
    const cw = checkWorld(child_world_id);
    if (!manifest) throw fail(Errors.validation, "a child world needs its genesis manifest", "bad_expand");
    const parentHead = await headRecord(pw);
    if (!parentHead) throw fail(Errors.notFound, `world ${pw}`, "no_world");
    const pv = parent_version ?? parentHead.version;
    const pRec = await readVersion(pw, pv);
    if (!pRec) throw fail(Errors.notFound, `version ${pv} of world ${pw}`, "no_version");
    // DAG: the child may not already be an ancestor of the parent.
    const ancestors = await ancestorsOf(pw);
    if (ancestors.has(cw)) throw fail(Errors.conflict, `${cw} is an ancestor of ${pw}; lineage must stay acyclic`, "lineage_cycle");
    if (await headRecord(cw)) throw fail(Errors.conflict, `world ${cw} already exists; a child world starts new`, "child_exists");
    const lineage = { parent_world_id: pw, parent_version: pv, parent_version_hash: pRec.version_hash, kind: kind || "fork" };
    const out = await save(cw, { manifest, author, label, expected_version: 0, kind: "fork", lineage, idempotent: false });
    const edge = {
      kind: kind || "fork", area_id, label: cleanLabel(label), author: authorOf(author),
      from: { world_id: pw, version: pv, version_hash: pRec.version_hash },
      to: { world_id: cw, version: out.version.version, version_hash: out.version.version_hash }, at: clock(),
    };
    await adapter.append(pw, "lineage_out", edge);
    await adapter.append(cw, "lineage_in", edge);
    return { ...out, edge };
  }

  async function ancestorsOf(w) {
    const seen = new Set();
    const stack = [w];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of await adapter.tail(cur, "lineage_in")) {
        const p = e.from.world_id;
        if (p !== cur && !seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
    return seen;
  }

  async function lineage(worldId) {
    const w = checkWorld(worldId);
    const parents = await adapter.tail(w, "lineage_in");
    const children = await adapter.tail(w, "lineage_out");
    return { world_id: w, parents, children, ancestors: [...(await ancestorsOf(w))] };
  }

  /** Every edge's endpoints must still exist with the hashes the edge recorded. */
  async function verifyLineage(worldId) {
    const w = checkWorld(worldId);
    const problems = [];
    for (const [dir, ns] of [["in", "lineage_in"], ["out", "lineage_out"]]) {
      for (const e of await adapter.tail(w, ns)) {
        for (const end of [e.from, e.to]) {
          const r = await readVersion(end.world_id, end.version);
          if (!r || r.version_hash !== end.version_hash) problems.push({ dir, seq: e.seq, world_id: end.world_id, version: end.version, code: "lineage_endpoint_mismatch" });
        }
      }
    }
    return { ok: problems.length === 0, problems };
  }

  async function listVersions(worldId, { limit = 100, before = null } = {}) {
    const w = checkWorld(worldId);
    const keys = (await adapter.keys(w, "version")).sort();
    let nums = keys.map(Number).filter(Number.isInteger);
    if (before != null) nums = nums.filter((n) => n < Number(before));
    nums = nums.slice(-Math.max(0, Math.min(Number(limit) || 100, 1000)));
    const out = [];
    for (const n of nums) {
      const r = await readVersion(w, n);
      if (r) out.push({ version: r.version, parent_version: r.parent_version, kind: r.kind, manifest_hash: r.manifest_hash, version_hash: r.version_hash, patch_ids: r.patch_ids, snapshot: r.snapshot, restored_from: r.restored_from, label: r.label, author: r.author, created_at: r.created_at });
    }
    return out;
  }

  async function getVersion(worldId, n, { withManifest = false } = {}) {
    const w = checkWorld(worldId);
    const r = await readVersion(w, Number(n));
    if (!r) throw fail(Errors.notFound, `version ${n} of world ${w}`, "no_version");
    if (!withManifest) return r;
    return { ...r, manifest: await manifestOf(w, r) };
  }

  async function diffVersions(worldId, a, b) {
    const w = checkWorld(worldId);
    const [ra, rb] = [await getVersion(w, a, { withManifest: true }), await getVersion(w, b, { withManifest: true })];
    const between = [];
    const [lo, hi] = ra.version <= rb.version ? [ra.version, rb.version] : [rb.version, ra.version];
    for (let v = lo + 1; v <= hi; v++) {
      const r = await readVersion(w, v);
      between.push({ version: v, kind: r.kind, patch_ids: r.patch_ids, restored_from: r.restored_from });
    }
    // Fallback diff ignores the volatile fields (world_version etc.), which
    // differ between any two versions and say nothing about content.
    const strip = (m) => { const x = structuredClone(m); if (x && typeof x === "object") { delete x.world_version; if (x.meta) delete x.meta.updated_at; if (x.provenance) delete x.provenance.manifest_hash; } return x; };
    const ops = diffManifests ? diffManifests(ra.manifest, rb.manifest) : genericDiff(strip(ra.manifest), strip(rb.manifest));
    return { world_id: w, from: ra.version, to: rb.version, from_hash: ra.manifest_hash, to_hash: rb.manifest_hash, same_content: ra.manifest_hash === rb.manifest_hash, versions_between: between, ops };
  }

  /**
   * Walk the whole chain. Detects: gaps, broken parent pointers, a version hash
   * that no longer matches its inputs, edited metadata (record_hash), snapshots
   * whose content drifted, patches whose body changed, and a head that points
   * off the chain. deep:true also rebuilds every patch version by replay and
   * compares it with the recorded manifest_hash.
   */
  async function verifyIntegrity(worldId, { deep = false } = {}) {
    const w = checkWorld(worldId);
    const problems = [];
    const add = (version, code, message) => problems.push({ version, code, message });
    const nums = (await adapter.keys(w, "version")).map(Number).filter(Number.isInteger).sort((x, y) => x - y);
    let prev = null;
    for (const [i, n] of nums.entries()) {
      const r = await readVersion(w, n);
      if (n !== i + 1) add(n, "gap", `expected v${i + 1}, found v${n}`);
      if (!r || r.version !== n) { add(n, "key_mismatch", `record stored at v${n} claims v${r?.version}`); prev = r; continue; }
      if (r.parent_version !== (prev ? prev.version : null)) add(n, "parent_pointer", `parent_version ${r.parent_version} != ${prev?.version ?? null}`);
      if (r.parent_hash !== (prev ? prev.version_hash : null)) add(n, "parent_hash", "parent_hash does not match the previous version's hash");
      if (r.version_hash !== versionHash(r.parent_hash, r.manifest_hash, r.patch_ids)) add(n, "version_hash", "version_hash does not match H(parent_hash, manifest_hash, patch_ids)");
      if (r.record_hash !== recordDigest(r)) add(n, "record_hash", "record metadata was altered after it was written");
      if (r.snapshot) {
        const s = await adapter.get(w, "snapshot", hexOf(r.manifest_hash));
        if (!s) add(n, "snapshot_missing", "snapshot missing");
        else if (hashManifest(s.manifest) !== r.manifest_hash) add(n, "snapshot_hash", "snapshot content does not hash to manifest_hash");
      } else if (!r.patch_ids.length) add(n, "unrebuildable", "neither snapshot nor patches");
      for (const [j, id] of r.patch_ids.entries()) {
        const p = await adapter.get(w, "patch", id);
        if (!p) add(n, "patch_missing", `patch ${id} missing`);
        else if (hashValue(p.patch) !== r.patch_hashes[j] || p.patch_hash !== r.patch_hashes[j]) add(n, "patch_hash", `patch ${id} body does not match its recorded hash`);
      }
      if (deep && r.patch_ids.length && !problems.some((x) => x.version === n)) {
        try {
          const rb = await reconstruct(w, n, { preferReplay: true });
          if (!rb.match) add(n, "replay_mismatch", `replay gives ${rb.manifest_hash}, recorded ${r.manifest_hash}`);
        } catch (e) { add(n, "replay_failed", String(e?.message || e)); }
      }
      prev = r;
    }
    const h = await adapter.get(w, "head", "current");
    if (h && prev && (h.version > prev.version || (h.version === prev.version && h.version_hash !== prev.version_hash))) add(h.version, "head", "head points off the chain");
    return { ok: problems.length === 0, world_id: w, versions: nums.length, head_version: prev?.version ?? 0, head_hash: prev?.version_hash ?? null, problems };
  }

  // ---------------------------------------------------------- player state
  function checkPlayerState(s) {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw fail(Errors.validation, "player state must be an object", "bad_player_state");
    if (s.position != null) {
      const p = s.position;
      if (typeof p !== "object" || !["x", "y", "z"].every((k) => Number.isFinite(p[k]))) throw fail(Errors.validation, "position must be {x,y,z} finite numbers", "bad_player_state");
    }
    if (s.inventory != null) {
      if (!Array.isArray(s.inventory)) throw fail(Errors.validation, "inventory must be an array", "bad_player_state");
      if (s.inventory.length > L.maxInventoryItems) throw fail(Errors.validation, `inventory has ${s.inventory.length} items; the limit is ${L.maxInventoryItems}`, "too_large");
    }
    if (s.progress != null && (typeof s.progress !== "object" || Array.isArray(s.progress))) throw fail(Errors.validation, "progress must be an object", "bad_player_state");
    checkBytes(s, L.maxPlayerStateBytes, "player state");
  }

  async function putRevDoc(w, ns, key, data, expected_rev, extra = {}) {
    return await lock(`${ns}:${w}:${key}`, async () => {
      const prior = await adapter.get(w, ns, key);
      const have = prior?.rev || 0;
      if (expected_rev != null && Number(expected_rev) !== have) {
        throw fail(Errors.conflict, `${ns} was modified concurrently (have rev ${have}, expected ${expected_rev})`, "rev_conflict", { have, expected: Number(expected_rev) });
      }
      const head = await adapter.get(w, "head", "current");
      const doc = { key, rev: have + 1, at_version: head?.version ?? null, updated_at: clock(), ...extra, data };
      await adapter.put(w, ns, key, doc);
      return doc;
    });
  }

  /**
   * Resume state for RETURN (where the player stands, what they carry, how far
   * they got). It is NOT rollback evidence: src/core/playerprogress.mjs remains
   * the authority for completions, because it refuses to launder a client claim
   * into a fact. Every row says where it came from so no reader can confuse the
   * two: "client_reported" (default) or "server_authoritative".
   */
  const PLAYER_SOURCES = ["client_reported", "server_authoritative"];
  async function putPlayerState(worldId, playerId, state, { expected_rev = null, source = "client_reported" } = {}) {
    const w = checkWorld(worldId);
    if (!SAFE_ID.test(String(playerId))) throw fail(Errors.validation, "unsafe player id", "bad_player_id");
    if (!PLAYER_SOURCES.includes(source)) throw fail(Errors.validation, `source must be one of ${PLAYER_SOURCES.join(", ")}`, "bad_player_state");
    checkPlayerState(state);
    return await putRevDoc(w, "player", String(playerId), state, expected_rev, { source });
  }
  async function getPlayerState(worldId, playerId) {
    const w = checkWorld(worldId);
    if (!SAFE_ID.test(String(playerId))) throw fail(Errors.validation, "unsafe player id", "bad_player_id");
    return await adapter.get(w, "player", String(playerId));
  }
  async function listPlayers(worldId) { return (await adapter.keys(checkWorld(worldId), "player")).sort(); }

  // ----------------------------------------------------- companion context
  async function putCompanionContext(worldId, scope, blob, { expected_rev = null } = {}) {
    const w = checkWorld(worldId);
    if (!SAFE_ID.test(String(scope))) throw fail(Errors.validation, "unsafe companion scope", "bad_scope");
    checkBytes(blob, L.maxCompanionBytes, "companion context");
    // Opaque: stored and returned verbatim. Its hash is kept so a caller can
    // tell whether the context it holds is the one on record.
    return await putRevDoc(w, "companion", String(scope), blob, expected_rev, { context_hash: hashValue(blob) });
  }
  async function getCompanionContext(worldId, scope) {
    const w = checkWorld(worldId);
    if (!SAFE_ID.test(String(scope))) throw fail(Errors.validation, "unsafe companion scope", "bad_scope");
    return await adapter.get(w, "companion", String(scope));
  }

  // --------------------------------------------------- generated history
  async function recordGeneration(worldId, entry = {}) {
    const w = checkWorld(worldId);
    if (!entry.lane || typeof entry.lane !== "string") throw fail(Errors.validation, "a generation record needs its lane", "bad_generation");
    const row = {
      lane: entry.lane, stage: entry.stage ?? null, provider: entry.provider ?? null, model: entry.model ?? null,
      status: entry.status ?? "ok", version: entry.version ?? null, input_hash: entry.input_hash ?? null,
      output_hash: entry.output_hash ?? null, asset_ids: Array.isArray(entry.asset_ids) ? entry.asset_ids.slice(0, 200) : [],
      note: entry.note == null ? null : String(entry.note).slice(0, 500), at: entry.at ?? clock(),
    };
    checkBytes(row, 16 * 1024, "generation record");
    return await adapter.append(w, "generation_history", row, { max: L.maxGenerationHistory });
  }
  const cap = (n) => Math.max(0, Math.min(Number.isFinite(Number(n)) ? Number(n) : 20, L.maxHistoryReturn));
  async function generationHistory(worldId, limit = 20) { return await adapter.tail(checkWorld(worldId), "generation_history", cap(limit)); }
  async function editHistory(worldId, limit = 20) { return await adapter.tail(checkWorld(worldId), "edit_history", cap(limit)); }

  async function getSpec(worldId, specHash = null) {
    const w = checkWorld(worldId);
    const h = specHash ?? (await headRecord(w))?.spec_hash;
    if (!h) return null;
    return (await adapter.get(w, "spec", hexOf(h)))?.spec ?? null;
  }
  async function assetIdentities(worldId) { return (await adapter.get(checkWorld(worldId), "assets", "map")) || { by_content: {}, by_asset_id: {} }; }

  /**
   * RETURN: everything a returning player/creator needs, in one read — the
   * latest manifest (hash-verified), the game spec, this player's state, the
   * companion context (player-scoped, then world-scoped), and the last N rows
   * of edit and generation history.
   */
  async function resume(worldId, { player_id = null, history_limit = 20, companion_scope = null } = {}) {
    const w = checkWorld(worldId);
    const head = await headRecord(w);
    if (!head) throw fail(Errors.notFound, `world ${w}`, "no_world");
    const manifest = await manifestOf(w, head);
    const scope = companion_scope ?? player_id;
    return {
      world_id: w,
      version: head.version, version_hash: head.version_hash, manifest_hash: head.manifest_hash,
      manifest,
      spec: await getSpec(w, head.spec_hash),
      player_state: player_id ? await getPlayerState(w, player_id) : null,
      companion_context: (scope ? await getCompanionContext(w, scope) : null) ?? await getCompanionContext(w, "world"),
      edit_history: await editHistory(w, history_limit),
      generation_history: await generationHistory(w, history_limit),
      lineage: { parents: (await adapter.tail(w, "lineage_in", 5)), children_count: (await adapter.tail(w, "lineage_out")).length },
    };
  }

  async function head(worldId) { return await headRecord(checkWorld(worldId)); }

  return {
    kind: adapter.kind, limits: L, adapter,
    save, resume, edit, expand, restoreVersion,
    head, listVersions, getVersion, diffVersions, reconstruct, verifyIntegrity,
    lineage, verifyLineage,
    putPlayerState, getPlayerState, listPlayers,
    putCompanionContext, getCompanionContext,
    recordGeneration, generationHistory, editHistory,
    getSpec, assetIdentities,
  };
}

/** Convenience: the facade wired to the real GAMES-C patch module if present. */
export async function createWorldMemoryV2WithPatchModule(opts = {}) {
  const pm = await loadPatchModule();
  if (!pm) return { memory: createWorldMemoryV2(opts), patchModule: null };
  return {
    memory: createWorldMemoryV2({
      applyPatch: pm.applyPatch, replayPatches: pm.replayPatches, hashManifest: pm.hashManifest, diffManifests: pm.diffManifests, ...opts,
    }),
    patchModule: pm,
  };
}
