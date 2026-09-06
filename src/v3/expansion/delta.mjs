// B6 — persistent world evolution. The flagship feature.
//
// Expanding a world is a DELTA, never a regeneration. V1 town -> V2 hospital ->
// V3 airport -> V4 university district -> V5 island. Across every one of those
// steps the following MUST survive: players, inventory, player-built structures,
// ownership, completed quests, NPC history, companion memory, social state and
// chronology.
//
// The mechanism that guarantees it: a delta may ADD freely, may MODIFY a narrow
// allow-list of cosmetic fields, and may REMOVE only an entity that no live
// player state references. Compatibility is checked BEFORE anything is applied,
// so an unsafe expansion is refused rather than half-applied.
import crypto from "node:crypto";
import { validateManifest } from "../manifest/schema.mjs";
import { Errors } from "../../core/errors.mjs";

/** Fields a delta is allowed to change on an EXISTING entity. */
const MODIFIABLE = {
  zone: new Set(["name", "ambience", "tags", "density"]),
  structure: new Set(["purpose", "interactable", "enterable", "transform", "footprint"]),
  npc: new Set(["name", "role", "dialogue", "schedule", "faction", "stats", "behavior_ref", "spawn", "zone"]),
  item: new Set(["name", "effects", "stackable"]),
  quest: new Set(["title", "rewards", "difficulty"]),
  behavior: new Set(["spec"]),
  environment: new Set(["weather", "time_of_day", "sky", "fog", "ambient_light", "directional_light", "wind", "palette"]),
};

const COLLECTIONS = ["zones", "structures", "npcs", "items", "quests", "behaviors", "interactions", "assets"];
const SINGULAR = { zones: "zone", structures: "structure", npcs: "npc", items: "item", quests: "quest", behaviors: "behavior", interactions: "interaction", assets: "asset" };

/**
 * Grow the heightmap so a new district has real ground under it.
 *
 * Existing cells are copied through untouched — that is what keeps an expansion
 * a delta. New cells continue the edge height with mild noise, so the join is
 * walkable rather than a cliff the playtest agent cannot cross.
 */
export function extendTerrain(terrain, newSize, seed = 1) {
  if (!terrain || terrain.kind !== "heightmap" || !Array.isArray(terrain.data) || !terrain.data.length) return terrain;
  const cw = terrain.resolution?.cell_w || 1;
  const ch = terrain.resolution?.cell_h || 1;
  const cols = Math.max(terrain.data[0].length, Math.ceil(newSize.w / cw));
  const rows = Math.max(terrain.data.length, Math.ceil(newSize.h / ch));

  let a = (seed >>> 0) || 1;
  const rand = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const oldRows = terrain.data.length, oldCols = terrain.data[0].length;
  const data = [];
  for (let j = 0; j < rows; j++) {
    const src = terrain.data[Math.min(j, oldRows - 1)];
    const row = new Array(cols);
    for (let i = 0; i < cols; i++) {
      if (j < oldRows && i < oldCols) { row[i] = terrain.data[j][i]; continue; }
      // Continue from the nearest existing cell, gently.
      const base = j < oldRows ? src[oldCols - 1] : (i < oldCols ? terrain.data[oldRows - 1][i] : terrain.data[oldRows - 1][oldCols - 1]);
      const prev = i > 0 ? row[i - 1] : base;
      row[i] = Number((prev * 0.75 + base * 0.25 + (rand() - 0.5) * 0.7).toFixed(2));
    }
    data.push(row);
  }
  return {
    ...terrain,
    size: { w: Math.max(terrain.size.w, newSize.w), h: Math.max(terrain.size.h, newSize.h) },
    resolution: { ...terrain.resolution, cols, rows },
    data,
  };
}

export function newDelta({ label, author = null, reason = null } = {}) {
  return {
    delta_id: "delta_" + crypto.randomBytes(8).toString("hex"),
    label: label || "Untitled expansion",
    author,
    reason,
    created_at: new Date().toISOString(),
    add: { zones: [], structures: [], npcs: [], items: [], quests: [], behaviors: [], interactions: [], assets: [] },
    modify: [],   // { collection, id, changes: {...} }
    remove: [],   // { collection, id, reason }
    environment: null,
    terrain_patch: null,   // { region:[x0,z0,x1,z1], data:[[...]] }
  };
}

function terrainHeightAt(terrain, x, z) {
  if (!terrain || terrain.kind !== "heightmap" || !Array.isArray(terrain.data) || !terrain.data.length) return 0;
  const rows = terrain.data.length, cols = terrain.data[0].length;
  const cw = terrain.resolution?.cell_w || terrain.size.w / cols;
  const ch = terrain.resolution?.cell_h || terrain.size.h / rows;
  const i = Math.max(0, Math.min(cols - 1, Math.round(x / cw)));
  const j = Math.max(0, Math.min(rows - 1, Math.round(z / ch)));
  return terrain.data[j][i];
}

function hashDeltaSeed(delta) {
  let h = 2166136261;
  const src = String(delta.delta_id || delta.label || "delta");
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function deltaHash(delta) {
  const stable = JSON.stringify(delta, Object.keys(delta).sort());
  return crypto.createHash("sha256").update(stable).digest("hex");
}

/**
 * Live state that an expansion must not break. This is what makes preservation
 * checkable instead of aspirational.
 *
 * @typedef {Object} LiveState
 * @property {string[]} owned_entity_ids     structures/items a player owns
 * @property {string[]} inventory_item_ids   items sitting in player inventories
 * @property {string[]} completed_quest_ids  quests players have finished
 * @property {string[]} visited_zone_ids     zones players have been to
 * @property {string[]} known_npc_ids        NPCs players or companions have met
 * @property {string[]} companion_memory_refs entity ids the companion remembers
 */
export function emptyLiveState() {
  return {
    owned_entity_ids: [], inventory_item_ids: [], completed_quest_ids: [],
    visited_zone_ids: [], known_npc_ids: [], companion_memory_refs: [],
  };
}

function indexManifest(m) {
  const idx = {};
  for (const c of COLLECTIONS) idx[c] = new Map((m[c] || []).map((x) => [x.id, x]));
  return idx;
}

/**
 * Would this delta break anything that already exists or is already in play?
 * Runs BEFORE any mutation. Returns { ok, errors, warnings }.
 */
export function checkCompatibility(manifest, delta, liveState = emptyLiveState()) {
  const errors = [];
  const warnings = [];
  const idx = indexManifest(manifest);

  const referenced = new Set([
    ...liveState.owned_entity_ids, ...liveState.inventory_item_ids,
    ...liveState.completed_quest_ids, ...liveState.visited_zone_ids,
    ...liveState.known_npc_ids, ...liveState.companion_memory_refs,
  ]);

  // ---- removals ----------------------------------------------------------
  for (const r of delta.remove || []) {
    const coll = idx[r.collection];
    if (!coll) { errors.push({ code: "unknown_collection", detail: `'${r.collection}' is not a manifest collection` }); continue; }
    if (!coll.has(r.id)) { warnings.push({ code: "remove_missing", detail: `'${r.id}' is not in ${r.collection}; nothing to remove` }); continue; }
    if (referenced.has(r.id)) {
      errors.push({
        code: "removal_breaks_live_state",
        detail: `cannot remove ${SINGULAR[r.collection]} '${r.id}': players or companions still reference it`,
        entity: r.id,
      });
    }
    // Removing something a surviving quest needs would strand that quest.
    for (const q of manifest.quests || []) {
      if ((delta.remove || []).some((x) => x.collection === "quests" && x.id === q.id)) continue;
      if ((q.steps || []).some((s) => s.target === r.id)) {
        errors.push({ code: "removal_breaks_quest", detail: `removing '${r.id}' would break quest '${q.id}'`, entity: r.id, quest: q.id });
      }
    }
  }

  // A completed quest can never be deleted: it is part of a player's history.
  for (const r of (delta.remove || []).filter((x) => x.collection === "quests")) {
    if (liveState.completed_quest_ids.includes(r.id)) {
      errors.push({ code: "removal_erases_history", detail: `quest '${r.id}' has been completed by players and cannot be removed`, entity: r.id });
    }
  }

  // ---- additions ---------------------------------------------------------
  for (const c of COLLECTIONS) {
    for (const item of delta.add?.[c] || []) {
      if (!item?.id) { errors.push({ code: "add_missing_id", detail: `an entry added to ${c} has no id` }); continue; }
      if (idx[c].has(item.id)) {
        errors.push({ code: "id_collision", detail: `${SINGULAR[c]} '${item.id}' already exists; an expansion must not overwrite an existing entity`, entity: item.id });
      }
    }
  }

  // ---- modifications -----------------------------------------------------
  for (const mod of delta.modify || []) {
    const coll = idx[mod.collection];
    if (!coll) { errors.push({ code: "unknown_collection", detail: `'${mod.collection}' is not a manifest collection` }); continue; }
    if (!coll.has(mod.id)) { errors.push({ code: "modify_missing", detail: `${SINGULAR[mod.collection]} '${mod.id}' does not exist`, entity: mod.id }); continue; }
    const allowed = MODIFIABLE[SINGULAR[mod.collection]];
    for (const field of Object.keys(mod.changes || {})) {
      if (!allowed || !allowed.has(field)) {
        errors.push({
          code: "field_not_modifiable",
          detail: `'${field}' cannot be changed on an existing ${SINGULAR[mod.collection]}; add a new entity instead`,
          entity: mod.id, field,
        });
      }
    }
    // Player-owned things are not the creator's to move.
    if (liveState.owned_entity_ids.includes(mod.id) && mod.changes?.transform) {
      errors.push({ code: "cannot_move_player_property", detail: `'${mod.id}' is owned by a player and cannot be relocated by an expansion`, entity: mod.id });
    }
  }

  // ---- environment -------------------------------------------------------
  for (const field of Object.keys(delta.environment || {})) {
    if (!MODIFIABLE.environment.has(field)) {
      errors.push({ code: "field_not_modifiable", detail: `environment.${field} cannot be changed by an expansion`, field });
    }
  }

  // ---- new content must be internally consistent -------------------------
  const futureIds = new Set([
    ...COLLECTIONS.flatMap((c) => [...idx[c].keys()]),
    ...COLLECTIONS.flatMap((c) => (delta.add?.[c] || []).map((x) => x.id)),
  ]);
  for (const r of delta.remove || []) futureIds.delete(r.id);

  for (const q of delta.add?.quests || []) {
    for (const st of q.steps || []) {
      if (st.target && !futureIds.has(st.target)) {
        errors.push({ code: "new_quest_dangling", detail: `new quest '${q.id}' step '${st.id}' targets '${st.target}', which will not exist`, entity: q.id });
      }
    }
  }
  for (const s of delta.add?.structures || []) {
    if (s.zone && !futureIds.has(s.zone)) errors.push({ code: "new_structure_bad_zone", detail: `new structure '${s.id}' is in zone '${s.zone}', which will not exist`, entity: s.id });
    if (s.asset_ref && !futureIds.has(s.asset_ref)) errors.push({ code: "new_structure_bad_asset", detail: `new structure '${s.id}' references asset '${s.asset_ref}', which will not exist`, entity: s.id });
  }
  for (const n of delta.add?.npcs || []) {
    if (n.zone && !futureIds.has(n.zone)) errors.push({ code: "new_npc_bad_zone", detail: `new npc '${n.id}' is in zone '${n.zone}', which will not exist`, entity: n.id });
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Apply a delta. Refuses outright if compatibility fails — there is no partial
 * application, so a world is never left half-expanded.
 *
 * @returns {{manifest:object, applied:object, previous_version:number}}
 */
export function applyDelta(manifest, delta, liveState = emptyLiveState()) {
  const compat = checkCompatibility(manifest, delta, liveState);
  if (!compat.ok) {
    throw Errors.conflict(
      `expansion refused: ${compat.errors.map((e) => e.detail).join("; ")}`,
      { meta: { errors: compat.errors, warnings: compat.warnings, delta_id: delta.delta_id } }
    );
  }

  const next = structuredClone(manifest);
  const previousVersion = Number(next.world_version || 1);

  // --- remove (already proven safe) ---------------------------------------
  const removedIds = new Set();
  for (const r of delta.remove || []) {
    const before = next[r.collection]?.length ?? 0;
    next[r.collection] = (next[r.collection] || []).filter((x) => x.id !== r.id);
    if ((next[r.collection].length) < before) removedIds.add(r.id);
  }

  // --- modify (allow-listed fields only) ----------------------------------
  for (const mod of delta.modify || []) {
    const target = (next[mod.collection] || []).find((x) => x.id === mod.id);
    if (!target) continue;
    Object.assign(target, mod.changes);
  }

  // --- add ----------------------------------------------------------------
  for (const c of COLLECTIONS) {
    const additions = delta.add?.[c] || [];
    if (additions.length) next[c] = [...(next[c] || []), ...structuredClone(additions)];
  }

  // --- environment --------------------------------------------------------
  if (delta.environment) Object.assign(next.environment, delta.environment);

  // --- terrain growth: a new district needs real ground under it -----------
  // Without this the district lands outside the heightmap, every structure in it
  // is out of bounds and the playtest agent cannot walk to it.
  if (delta.terrain_extend) {
    next.terrain = extendTerrain(next.terrain, delta.terrain_extend, hashDeltaSeed(delta));
  }

  // --- navigation: link the new content into the existing graph ------------
  if (Array.isArray(delta.navigation_links) && delta.navigation_links.length) {
    next.navigation = next.navigation || { links: [], walkable_zones: [], navmesh_ref: null };
    next.navigation.links = [...(next.navigation.links || []), ...delta.navigation_links];
  }
  // A delta may supply MEASURED walkability for the zones it brings (a stitch
  // carries the guest's own figures). Anything it does not cover falls back to a
  // default, so navigation validation always has something to check.
  if (Array.isArray(delta.navigation_walkable) && delta.navigation_walkable.length) {
    next.navigation = next.navigation || { links: [], walkable_zones: [], navmesh_ref: null };
    next.navigation.walkable_zones = next.navigation.walkable_zones || [];
    for (const w of delta.navigation_walkable) {
      const i = next.navigation.walkable_zones.findIndex((x) => x.zone === w.zone);
      if (i >= 0) next.navigation.walkable_zones[i] = w;
      else next.navigation.walkable_zones.push(w);
    }
  }
  for (const z of delta.add?.zones || []) {
    next.navigation = next.navigation || { links: [], walkable_zones: [], navmesh_ref: null };
    next.navigation.walkable_zones = next.navigation.walkable_zones || [];
    if (!next.navigation.walkable_zones.some((w) => w.zone === z.id)) {
      next.navigation.walkable_zones.push({ zone: z.id, walkable_fraction: 1, mean_ground_y: 0, source: "expansion" });
    }
  }

  // --- terrain patch: only the named region changes -----------------------
  //
  // This MUST run before structures are reseated. It used to run after, so a
  // delta that brought its own terrain (a stitched region, most obviously) had
  // its buildings seated on the freshly-extended filler ground rather than on
  // the terrain the delta actually supplied.
  if (delta.terrain_patch && next.terrain?.kind === "heightmap" && Array.isArray(next.terrain.data)) {
    const [x0, z0] = delta.terrain_patch.region;
    const cw = next.terrain.resolution?.cell_w || 1;
    const ch = next.terrain.resolution?.cell_h || 1;
    const i0 = Math.max(0, Math.round(x0 / cw));
    const j0 = Math.max(0, Math.round(z0 / ch));
    delta.terrain_patch.data.forEach((row, dj) => {
      const j = j0 + dj;
      if (!next.terrain.data[j]) return;
      row.forEach((v, di) => {
        const i = i0 + di;
        if (i < next.terrain.data[j].length) next.terrain.data[j][i] = v;
      });
    });
  }

  // --- reseat added structures on the (possibly extended) ground -----------
  for (const st of delta.add?.structures || []) {
    const live = (next.structures || []).find((x) => x.id === st.id);
    if (live?.transform?.position) live.transform.position.y = terrainHeightAt(next.terrain, live.transform.position.x, live.transform.position.z);
  }
  for (const n of delta.add?.npcs || []) {
    const live = (next.npcs || []).find((x) => x.id === n.id);
    if (live?.spawn) live.spawn.y = terrainHeightAt(next.terrain, live.spawn.x, live.spawn.z);
  }

  // --- prune anything the removals orphaned -------------------------------
  if (removedIds.size) {
    next.interactions = (next.interactions || []).filter((x) => !removedIds.has(x.target_ref) && !removedIds.has(x.behavior_ref));
    for (const n of next.npcs || []) if (removedIds.has(n.behavior_ref)) n.behavior_ref = null;
  }

  // --- version + history --------------------------------------------------
  next.world_version = previousVersion + 1;
  next.meta.updated_at = new Date().toISOString();
  next.expansion = next.expansion || { history: [], compatibility: { min_runtime: "3.0.0", migrated_from: null } };
  next.expansion.history = [
    ...(next.expansion.history || []),
    {
      version: next.world_version,
      from_version: previousVersion,
      label: delta.label,
      delta_id: delta.delta_id,
      delta_hash: deltaHash(delta),
      author: delta.author,
      at: new Date().toISOString(),
      added: Object.fromEntries(COLLECTIONS.map((c) => [c, (delta.add?.[c] || []).length]).filter(([, n]) => n > 0)),
      modified: (delta.modify || []).length,
      removed: (delta.remove || []).length,
    },
  ];

  return {
    manifest: next,
    previous_version: previousVersion,
    applied: {
      delta_id: delta.delta_id,
      label: delta.label,
      added: Object.fromEntries(COLLECTIONS.map((c) => [c, (delta.add?.[c] || []).length])),
      modified: (delta.modify || []).length,
      removed: removedIds.size,
      warnings: compat.warnings,
    },
  };
}

/**
 * Prove that everything that had to survive an expansion actually did.
 * Called after applyDelta so preservation is asserted, not assumed.
 */
export function verifyPreservation(before, after, liveState = emptyLiveState()) {
  const problems = [];
  const idsOf = (m) => new Set(COLLECTIONS.flatMap((c) => (m[c] || []).map((x) => x.id)));
  const beforeIds = idsOf(before);
  const afterIds = idsOf(after);

  for (const id of [
    ...liveState.owned_entity_ids, ...liveState.inventory_item_ids,
    ...liveState.completed_quest_ids, ...liveState.visited_zone_ids,
    ...liveState.known_npc_ids, ...liveState.companion_memory_refs,
  ]) {
    if (beforeIds.has(id) && !afterIds.has(id)) {
      problems.push({ code: "live_state_lost", detail: `'${id}' was referenced by live player state and no longer exists`, entity: id });
    }
  }

  // Ownership must be untouched.
  const ownerBefore = new Map((before.structures || []).map((s) => [s.id, s.owner_id ?? null]));
  for (const s of after.structures || []) {
    if (ownerBefore.has(s.id) && ownerBefore.get(s.id) !== (s.owner_id ?? null)) {
      problems.push({ code: "ownership_changed", detail: `ownership of '${s.id}' changed during an expansion`, entity: s.id });
    }
  }

  // Version must move forward, and history must extend rather than be rewritten.
  if (Number(after.world_version) !== Number(before.world_version) + 1) {
    problems.push({ code: "version_not_incremented", detail: `expected v${Number(before.world_version) + 1}, got v${after.world_version}` });
  }
  const hb = before.expansion?.history || [];
  const ha = after.expansion?.history || [];
  if (ha.length !== hb.length + 1) {
    problems.push({ code: "history_not_extended", detail: "the expansion history must gain exactly one entry" });
  }
  for (let i = 0; i < hb.length; i++) {
    if (JSON.stringify(ha[i]) !== JSON.stringify(hb[i])) {
      problems.push({ code: "history_rewritten", detail: `history entry ${i} changed; chronology is append-only` });
    }
  }

  const validation = validateManifest(after);
  if (!validation.ok) {
    for (const e of validation.errors) problems.push({ code: "expanded_world_invalid", detail: `${e.path}: ${e.message}` });
  }

  return { ok: problems.length === 0, problems };
}

export { COLLECTIONS, MODIFIABLE };
