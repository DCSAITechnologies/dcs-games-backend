// B4 — structural, navigation and quest-reachability validators.
//
// The requirement is explicit: the quality gate MUST be able to fail. These
// checks answer questions a player would hit in the first two minutes —
// can I get out of my spawn, can I reach the NPC, can this quest be finished,
// will I fall through the floor, is anything actually interactive — and they
// return findings the repair pass can act on rather than a pass/fail bit.
//
// Every finding has: id, severity, what is wrong, and where.

import { specRefsOf } from "../expansion/delta.mjs";

export const SEVERITY = { BLOCKER: "blocker", MAJOR: "major", MINOR: "minor", INFO: "info" };
const ORDER = { blocker: 0, major: 1, minor: 2, info: 3 };

function finding(id, severity, message, { where = null, fix = null, data = null } = {}) {
  return { id, severity, message, ...(where ? { where } : {}), ...(fix ? { fix } : {}), ...(data ? { data } : {}) };
}

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

/**
 * Sample the terrain height at a world position.
 *
 * Non-finite input returns 0 rather than throwing. Math.round(NaN) is NaN, and
 * Math.max/min propagate it, so `data[NaN][NaN]` used to raise a TypeError from
 * deep inside a repair and abort the entire repair pass — a crash caused by one
 * malformed coordinate, reported nowhere near where it came from.
 */
export function heightAt(terrain, x, z) {
  if (!terrain || terrain.kind !== "heightmap" || !Array.isArray(terrain.data) || !terrain.data.length) return 0;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const rows = terrain.data.length, cols = terrain.data[0].length;
  const cw = terrain.resolution?.cell_w || terrain.size.w / cols;
  const ch = terrain.resolution?.cell_h || terrain.size.h / rows;
  if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw === 0 || ch === 0) return 0;
  const i = Math.max(0, Math.min(cols - 1, Math.round(x / cw)));
  const j = Math.max(0, Math.min(rows - 1, Math.round(z / ch)));
  const row = terrain.data[j];
  return Array.isArray(row) && Number.isFinite(row[i]) ? row[i] : 0;
}

// ---------------------------------------------------------------- structural

export function validateStructure(m) {
  const out = [];
  const size = m.terrain?.size || { w: 0, h: 0 };

  if (!m.structures?.length) out.push(finding("no_structures", SEVERITY.MAJOR, "the world contains no structures at all", { fix: "add_structures" }));
  if (!m.npcs?.length) out.push(finding("no_npcs", SEVERITY.MAJOR, "the world contains no NPCs", { fix: "add_npcs" }));
  if (!m.interactions?.length) out.push(finding("no_interactions", SEVERITY.MAJOR, "nothing in the world is interactive", { fix: "add_interactions" }));

  // Anything outside the terrain is unreachable, whatever the manifest says.
  for (const s of m.structures || []) {
    const p = s.transform?.position;
    if (!p) continue;
    if (p.x < 0 || p.z < 0 || p.x > size.w || p.z > size.h) {
      out.push(finding("structure_out_of_bounds", SEVERITY.BLOCKER, `structure '${s.id}' sits outside the terrain`, { where: s.id, fix: "clamp_into_zone", data: p }));
    }
    const ground = heightAt(m.terrain, p.x, p.z);
    if (Math.abs((p.y ?? 0) - ground) > 3.5) {
      out.push(finding("structure_floating", SEVERITY.MAJOR, `structure '${s.id}' floats ${((p.y ?? 0) - ground).toFixed(1)}m off the ground`, { where: s.id, fix: "reseat_on_ground", data: { y: p.y, ground } }));
    }
  }

  // Overlapping footprints read to a player as buildings growing through each other.
  const structs = (m.structures || []).filter((s) => s.transform?.position);
  for (let i = 0; i < structs.length; i++) {
    for (let j = i + 1; j < structs.length; j++) {
      const a = structs[i], b = structs[j];
      const ra = Math.max(a.footprint?.w || 6, a.footprint?.d || 6) / 2;
      const rb = Math.max(b.footprint?.w || 6, b.footprint?.d || 6) / 2;
      const d = Math.sqrt(dist2(a.transform.position, b.transform.position));
      if (d < (ra + rb) * 0.55) {
        out.push(finding("structures_overlap", SEVERITY.MINOR, `structures '${a.id}' and '${b.id}' overlap`, { where: a.id, fix: "separate", data: { other: b.id, distance: Number(d.toFixed(2)), needed: Number(((ra + rb) * 0.55).toFixed(2)) } }));
      }
    }
  }

  // A collision-less solid is something a player walks through.
  for (const a of m.assets || []) {
    if (["building", "vehicle", "terrain_feature"].includes(a.kind) && !a.collision) {
      out.push(finding("asset_no_collision", SEVERITY.MAJOR, `asset '${a.id}' is solid but has no collision volume`, { where: a.id, fix: "add_collision" }));
    }
  }

  // A reference that does not resolve is a missing model at runtime.
  const assetIds = new Set((m.assets || []).map((a) => a.id));
  for (const s of m.structures || []) {
    if (s.asset_ref && !assetIds.has(s.asset_ref)) out.push(finding("missing_asset", SEVERITY.BLOCKER, `structure '${s.id}' references missing asset '${s.asset_ref}'`, { where: s.id, fix: "drop_or_substitute" }));
  }
  for (const n of m.npcs || []) {
    if (n.asset_ref && !assetIds.has(n.asset_ref)) out.push(finding("missing_asset", SEVERITY.BLOCKER, `npc '${n.id}' references missing asset '${n.asset_ref}'`, { where: n.id, fix: "drop_or_substitute" }));
  }
  return out;
}

// ---------------------------------------------------------------- navigation

/**
 * Can a player leave the spawn, and reach every zone?
 * Uses the zone-link graph plus a slope check on the terrain, which is the same
 * data the runtime walks on.
 */
export function validateNavigation(m) {
  const out = [];
  const spawns = m.spawn?.player_spawns || [];
  if (!spawns.length) {
    out.push(finding("no_spawn", SEVERITY.BLOCKER, "the world has no player spawn", { fix: "add_spawn" }));
    return out;
  }

  const size = m.terrain?.size || { w: 0, h: 0 };
  for (const sp of spawns) {
    const p = sp.position;
    if (p.x < 0 || p.z < 0 || p.x > size.w || p.z > size.h) {
      out.push(finding("spawn_out_of_bounds", SEVERITY.BLOCKER, `spawn '${sp.id}' is outside the terrain`, { where: sp.id, fix: "move_spawn", data: p }));
      continue;
    }
    // Trapped spawn: a structure directly on top of the spawn point.
    for (const s of m.structures || []) {
      const sp2 = s.transform?.position;
      if (!sp2) continue;
      const r = Math.max(s.footprint?.w || 6, s.footprint?.d || 6) / 2;
      if (Math.sqrt(dist2(p, sp2)) < r) {
        out.push(finding("spawn_inside_structure", SEVERITY.BLOCKER, `spawn '${sp.id}' is inside structure '${s.id}'`, { where: sp.id, fix: "move_spawn", data: { structure: s.id } }));
      }
    }
    // Boxed-in spawn: no walkable escape in any direction.
    const ground = heightAt(m.terrain, p.x, p.z);
    let escapes = 0;
    for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, -4], [4, -4], [-4, 4]]) {
      const nx = p.x + dx, nz = p.z + dz;
      if (nx < 0 || nz < 0 || nx > size.w || nz > size.h) continue;
      if (Math.abs(heightAt(m.terrain, nx, nz) - ground) < 2.5) escapes++;
    }
    if (escapes === 0) {
      out.push(finding("spawn_trapped", SEVERITY.BLOCKER, `spawn '${sp.id}' has no walkable exit — the player is trapped`, { where: sp.id, fix: "move_spawn" }));
    }
  }

  // Zone connectivity from the spawn's zone.
  const zones = m.zones || [];
  if (zones.length > 1) {
    const adj = new Map(zones.map((z) => [z.id, new Set()]));
    for (const l of m.navigation?.links || []) {
      if (adj.has(l.from) && adj.has(l.to)) { adj.get(l.from).add(l.to); adj.get(l.to).add(l.from); }
    }
    const start = spawns[0].zone || zones[0].id;
    const seen = new Set([start]);
    const q = [start];
    while (q.length) for (const n of adj.get(q.pop()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
    for (const z of zones) {
      if (!seen.has(z.id)) {
        out.push(finding("zone_unreachable", SEVERITY.MAJOR, `zone '${z.name || z.id}' cannot be reached from the spawn`, { where: z.id, fix: "link_zone" }));
      }
    }
  }

  // A zone with nowhere to stand is not a place.
  for (const w of m.navigation?.walkable_zones || []) {
    if (w.walkable_fraction < 0.15) {
      out.push(finding("zone_not_walkable", SEVERITY.MAJOR, `zone '${w.zone}' is only ${(w.walkable_fraction * 100).toFixed(0)}% walkable`, { where: w.zone, fix: "flatten_zone", data: w }));
    }
  }
  return out;
}

// ------------------------------------------------------------ quest validity

/** Every quest must be completable from the spawn, in order. */
export function validateQuests(m) {
  const out = [];
  const npcs = new Map((m.npcs || []).map((n) => [n.id, n]));
  const items = new Set((m.items || []).map((i) => i.id));
  const structs = new Map((m.structures || []).map((s) => [s.id, s]));
  const zones = new Map((m.zones || []).map((z) => [z.id, z]));

  if (!m.quests?.length) {
    out.push(finding("no_quests", SEVERITY.MAJOR, "the world has no quests — there is nothing to do", { fix: "add_quest" }));
  }

  // Which items can actually be obtained? A collect step for an item with no
  // pickup anywhere in the world is a dead quest.
  const obtainable = new Set();
  for (const b of m.behaviors || []) {
    if (b.kind === "pickup" && b.spec?.item) obtainable.add(b.spec.item);
    if (b.kind === "container" && Array.isArray(b.spec?.contains)) for (const it of b.spec.contains) obtainable.add(it);
  }

  for (const q of m.quests || []) {
    if (!q.steps?.length) {
      out.push(finding("quest_no_steps", SEVERITY.BLOCKER, `quest '${q.id}' has no steps and can never be completed`, { where: q.id, fix: "drop_quest" }));
      continue;
    }
    if (q.giver_npc && !npcs.has(q.giver_npc)) {
      out.push(finding("quest_giver_missing", SEVERITY.MAJOR, `quest '${q.id}' is given by an NPC that does not exist`, { where: q.id, fix: "reassign_giver" }));
    }
    for (const st of q.steps) {
      if (!st.target) {
        out.push(finding("quest_step_no_target", SEVERITY.BLOCKER, `step '${st.id}' of quest '${q.id}' has no target and can never complete`, { where: `${q.id}.${st.id}`, fix: "retarget_step" }));
        continue;
      }
      const isNpc = npcs.has(st.target), isItem = items.has(st.target), isStruct = structs.has(st.target), isZone = zones.has(st.target);
      if (!isNpc && !isItem && !isStruct && !isZone) {
        out.push(finding("quest_step_dangling", SEVERITY.BLOCKER, `step '${st.id}' of quest '${q.id}' targets '${st.target}', which does not exist`, { where: `${q.id}.${st.id}`, fix: "retarget_step" }));
        continue;
      }
      // The step KIND has to make sense for what it points at.
      if (st.kind === "talk" && !isNpc) {
        out.push(finding("quest_step_kind_mismatch", SEVERITY.MAJOR, `step '${st.id}' asks the player to talk to '${st.target}', which is not an NPC`, { where: `${q.id}.${st.id}`, fix: "retarget_step" }));
      }
      if (st.kind === "collect" && !isItem) {
        out.push(finding("quest_step_kind_mismatch", SEVERITY.MAJOR, `step '${st.id}' asks the player to collect '${st.target}', which is not an item`, { where: `${q.id}.${st.id}`, fix: "retarget_step" }));
      }
      if (st.kind === "collect" && isItem && !obtainable.has(st.target)) {
        out.push(finding("quest_item_unobtainable", SEVERITY.BLOCKER, `item '${st.target}' is required by quest '${q.id}' but exists nowhere in the world`, { where: `${q.id}.${st.id}`, fix: "place_item" }));
      }
      if (st.kind === "reach" && !isZone && !isStruct) {
        out.push(finding("quest_step_kind_mismatch", SEVERITY.MINOR, `step '${st.id}' asks the player to reach '${st.target}', which is not a place`, { where: `${q.id}.${st.id}`, fix: "retarget_step" }));
      }
      // An NPC in an unreachable zone makes the step impossible.
      const npc = npcs.get(st.target);
      if (npc && npc.zone && !zones.has(npc.zone)) {
        out.push(finding("quest_npc_nowhere", SEVERITY.BLOCKER, `NPC '${npc.id}' needed by quest '${q.id}' is in a zone that does not exist`, { where: `${q.id}.${st.id}`, fix: "relocate_npc" }));
      }
    }
  }
  return out;
}

// -------------------------------------------------------- reference integrity

/**
 * Entity references held INSIDE a behaviour's spec, checked against the world.
 *
 * The schema validator resolves `target_ref`, `behavior_ref`, `asset_ref`,
 * `zone` and quest-step targets, and stops there. It does not look inside a
 * behaviour's spec, so a world can pass validation while containing a pickup
 * that grants a deleted item, a door locked by a key that no longer exists, a
 * teleporter aimed at a demolished zone or a lift called from a zone that went
 * with a rollback. Every one of those reads to a player as a thing they can
 * never obtain, open or reach, with nothing anywhere saying why.
 *
 * The severity split follows the consequence, not the tidiness. Losing the
 * entity a behaviour EXISTS for (a pickup's item, a teleporter's destination)
 * makes the behaviour unusable and blocks: there is nothing left for it to do.
 * Losing one entry of a list, or a lock, degrades it — the rest still works —
 * so those are major and repairable by scrubbing the reference.
 */
export function validateReferences(m) {
  const out = [];
  const present = {
    zones: new Set((m.zones || []).map((z) => z.id)),
    structures: new Set((m.structures || []).map((s) => s.id)),
    npcs: new Set((m.npcs || []).map((n) => n.id)),
    items: new Set((m.items || []).map((i) => i.id)),
    behaviors: new Set((m.behaviors || []).map((b) => b.id)),
  };

  for (const b of m.behaviors || []) {
    for (const { field, id, rule } of specRefsOf(b)) {
      if (rule.points_at.some((c) => present[c]?.has(id))) continue;
      const fatal = rule.on_missing === "defunct";
      out.push(finding(
        "behavior_spec_dangling",
        fatal ? SEVERITY.BLOCKER : SEVERITY.MAJOR,
        `${b.kind || "behaviour"} '${b.id}' references '${id}' through spec.${field}, which does not exist`,
        {
          where: b.id,
          // A pickup with no item cannot be repaired by inventing one, so the
          // honest repair is to drop it. A scrubbable field is scrubbed.
          fix: fatal ? "wire_or_drop" : "scrub_spec_ref",
          data: { field, ref: id, expected: rule.points_at },
        }
      ));
    }
  }
  return out;
}

// ------------------------------------------------------------ gameplay depth

/** Is there actually a game here, or just scenery? */
export function validateGameplayLoop(m) {
  const out = [];
  const kinds = new Set((m.behaviors || []).map((b) => b.kind));
  const interactive = new Set((m.interactions || []).map((i) => i.target_ref));

  if (kinds.size === 0) {
    out.push(finding("no_gameplay", SEVERITY.BLOCKER, "the world has no behaviours — it is scenery, not a game", { fix: "add_behaviors" }));
  } else if (kinds.size < 3) {
    out.push(finding("shallow_gameplay", SEVERITY.MINOR, `only ${kinds.size} kind(s) of interaction exist`, { fix: "add_behaviors", data: { kinds: [...kinds] } }));
  }

  const talkable = (m.npcs || []).filter((n) => interactive.has(n.id));
  if ((m.npcs || []).length && !talkable.length) {
    out.push(finding("npcs_not_interactive", SEVERITY.MAJOR, "no NPC can be interacted with", { fix: "add_interactions" }));
  }

  const enterable = (m.structures || []).filter((s) => s.enterable);
  if (enterable.length && !enterable.some((s) => interactive.has(s.id))) {
    out.push(finding("enterable_no_door", SEVERITY.MAJOR, "structures are marked enterable but none has a door", { fix: "add_doors" }));
  }

  // A behaviour nothing triggers will never run.
  //
  // An interaction is not the only thing that drives one. `npc.behavior_ref` is
  // an ownership edge the assembler writes deliberately (assembly.mjs attaches
  // the behaviour to its NPC "so the runtime does not have to search"), and the
  // NPC runs it whether or not a proximity or interact trigger also points at
  // it. Counting only `interactions[].behavior_ref` called those behaviours
  // orphans, `wire_or_drop` then deleted them, and every NPC in the world was
  // left holding a `behavior_ref` to a behaviour that no longer existed — a
  // schema BLOCKER manufactured by the repair pass itself, out of a MINOR
  // finding, on a manifest that had been valid when it arrived.
  const used = new Set((m.interactions || []).map((i) => i.behavior_ref));
  for (const n of m.npcs || []) if (n.behavior_ref) used.add(n.behavior_ref);
  for (const b of m.behaviors || []) {
    if (!used.has(b.id)) out.push(finding("orphan_behavior", SEVERITY.MINOR, `behaviour '${b.id}' is never triggered by anything`, { where: b.id, fix: "wire_or_drop" }));
  }
  return out;
}

/** Run every validator and return findings sorted by severity. */
export function runAllValidators(m) {
  const findings = [
    ...validateStructure(m),
    ...validateNavigation(m),
    ...validateQuests(m),
    ...validateReferences(m),
    ...validateGameplayLoop(m),
  ];
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return findings;
}

export function summarize(findings) {
  const by = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) by[f.severity]++;
  return { ...by, total: findings.length, passed: by.blocker === 0 && by.major === 0 };
}
