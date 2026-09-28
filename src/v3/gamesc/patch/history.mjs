// GAMES-C patch — linear undo/redo history over patches + their inverses.
//
// Linear: applying a new patch after an undo truncates the redo tail (the same
// model as every editor). Undo applies the stored inverse, redo re-applies the
// stored patch; both are re-pinned (rebasePatch) onto the current manifest, so
// world_version keeps climbing while the CONTENT hash returns exactly to what it
// was. Undo/redo run with {trusted:true} because the history holds patches that
// already passed validation (or inverses the engine itself produced).
import { applyPatch, hashManifest, rebasePatch, KNOWN_BASE_HASH } from "./index.mjs";

/**
 * @param {object} manifest   starting manifest (deep-copied)
 * @param {{limit?:number}} [opts] max entries kept (oldest dropped past it)
 */
export function createEditHistory(manifest, { limit = 500 } = {}) {
  let current = structuredClone(manifest);
  let currentHash = hashManifest(current); // history owns `current` (never handed out uncloned), so this cannot go stale
  let entries = [];   // { patch, inverse, hash_before, hash_after, version_applied }
  let cursor = 0;     // entries[0..cursor) are applied

  // Hand out copies: `current` must never be reachable (and mutable) from outside.
  const out = (r) => ({ ...r, manifest: structuredClone(r.manifest) });
  const err = (message) => ({ ok: false, manifest: null, inverse: null, errors: [{ op_index: null, path: null, message }], warnings: [] });

  return {
    /** Apply a new (untrusted) patch. On success the redo tail is discarded. */
    apply(patch, options = {}) {
      const hashBefore = currentHash;
      const r = applyPatch(current, patch, { ...options, trusted: false, [KNOWN_BASE_HASH]: currentHash });
      if (!r.ok) return r;
      entries = entries.slice(0, cursor);
      // the inverse is pinned to the new state, so its base_hash IS the new content hash
      entries.push({ patch, inverse: r.inverse, hash_before: hashBefore, hash_after: r.inverse.base_hash, version_applied: r.manifest.world_version });
      if (entries.length > limit) entries.shift();
      cursor = entries.length;
      current = r.manifest;
      currentHash = r.inverse.base_hash;
      return out(r);
    },
    undo() {
      if (cursor === 0) return err("nothing to undo");
      const entry = entries[cursor - 1];
      if (currentHash !== entry.hash_after) return err("history diverged: current manifest is not the state this undo was recorded against");
      const r = applyPatch(current, rebasePatch(entry.inverse, current, currentHash), { trusted: true, [KNOWN_BASE_HASH]: currentHash });
      if (!r.ok) return r;
      if (r.inverse.base_hash !== entry.hash_before) return err("undo did not restore the recorded content hash");
      current = r.manifest;
      currentHash = r.inverse.base_hash;
      cursor--;
      return out(r);
    },
    redo() {
      if (cursor >= entries.length) return err("nothing to redo");
      const entry = entries[cursor];
      if (currentHash !== entry.hash_before) return err("history diverged: current manifest is not the state this redo was recorded against");
      const r = applyPatch(current, rebasePatch(entry.patch, current, currentHash), { trusted: true, [KNOWN_BASE_HASH]: currentHash });
      if (!r.ok) return r;
      if (r.inverse.base_hash !== entry.hash_after) return err("redo did not reproduce the recorded content hash");
      entry.inverse = r.inverse;
      current = r.manifest;
      currentHash = r.inverse.base_hash;
      cursor++;
      return out(r);
    },
    canUndo: () => cursor > 0,
    canRedo: () => cursor < entries.length,
    /** Deep copy of the current manifest. */
    current: () => structuredClone(current),
    currentHash: () => currentHash,
    list: () => entries.map((e, i) => ({
      index: i, patch_id: e.patch.patch_id, inverse_id: e.inverse.patch_id,
      status: i < cursor ? "applied" : "undone", ops: e.patch.ops.length,
      hash_before: e.hash_before, hash_after: e.hash_after, intent: e.patch.intent ?? null, author: e.patch.author,
    })),
    get size() { return entries.length; },
    get cursor() { return cursor; },
  };
}
