// B6 — what actually changed between two versions of a world.
//
// A creator who expands, edits, stitches or rolls back a world is entitled to a
// straight answer about what that did to it. This module gives that answer by
// COMPARING two manifests, not by reading anybody's claim about them: a delta's
// label, a history entry's counts and a chat summary are all assertions, and an
// assertion can be wrong. The manifests cannot.
//
// The rule this module lives by: report exact counts, name the entities, and say
// plainly when nothing changed. Never round, never estimate, never soften. A
// diff that flatters an expansion is worse than no diff at all, because a
// creator would act on it.
import { COLLECTIONS } from "./delta.mjs";
import { Errors } from "../../core/errors.mjs";

/** Singular/plural prose for each collection. The manifest keys stay as they are. */
const NOUNS = {
  zones: ["zone", "zones"],
  structures: ["structure", "structures"],
  npcs: ["NPC", "NPCs"],
  items: ["item", "items"],
  quests: ["quest", "quests"],
  behaviors: ["behaviour", "behaviours"],
  interactions: ["interaction", "interactions"],
  assets: ["asset", "assets"],
};

/**
 * Order-independent comparison. Two manifests that mean the same thing can carry
 * their keys in a different order — a JSON round trip, a structuredClone, an
 * Object.assign — and a naive stringify would call that a modification.
 */
function stable(v) {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

/** What a creator calls this thing. Falls back to the id rather than inventing a name. */
function labelOf(entity) {
  return entity?.name || entity?.title || entity?.purpose || entity?.id || null;
}

function indexOf(m) {
  const idx = {};
  for (const c of COLLECTIONS) idx[c] = new Map((m?.[c] || []).filter((x) => x?.id).map((x) => [x.id, x]));
  return idx;
}

function zeroCounts() {
  return Object.fromEntries(COLLECTIONS.map((c) => [c, 0]));
}

function listPhrase(parts) {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(", ") + " and " + parts.at(-1);
}

function countPhrase(byCollection) {
  return listPhrase(COLLECTIONS
    .filter((c) => byCollection[c] > 0)
    .map((c) => `${byCollection[c]} ${NOUNS[c][byCollection[c] === 1 ? 0 : 1]}`));
}

/** Which top-level fields differ on an entity that exists on both sides. */
function changedFields(a, b) {
  const fields = [];
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (stable(a?.[k]) !== stable(b?.[k])) fields.push(k);
  }
  return fields.sort();
}

function terrainCells(t) {
  if (!Array.isArray(t?.data)) return null;
  return t.data.reduce((n, row) => n + (Array.isArray(row) ? row.length : 0), 0);
}

/** Height cells that exist on both sides and hold a different value. */
function overlapChanged(before, after) {
  if (!Array.isArray(before?.data) || !Array.isArray(after?.data)) return null;
  let changed = 0;
  const rows = Math.min(before.data.length, after.data.length);
  for (let j = 0; j < rows; j++) {
    const a = before.data[j], b = after.data[j];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const cols = Math.min(a.length, b.length);
    for (let i = 0; i < cols; i++) if (a[i] !== b[i]) changed++;
  }
  return changed;
}

function diffTerrain(before, after) {
  const tb = before?.terrain || null;
  const ta = after?.terrain || null;
  const sizeBefore = tb?.size ? { w: tb.size.w, h: tb.size.h } : null;
  const sizeAfter = ta?.size ? { w: ta.size.w, h: ta.size.h } : null;
  const cellsBefore = terrainCells(tb);
  const cellsAfter = terrainCells(ta);
  const cellsChanged = overlapChanged(tb, ta);

  const sizeChanged = stable(sizeBefore) !== stable(sizeAfter);
  const out = {
    changed: false,
    kind_before: tb?.kind ?? null,
    kind_after: ta?.kind ?? null,
    kind_changed: (tb?.kind ?? null) !== (ta?.kind ?? null),
    size_before: sizeBefore,
    size_after: sizeAfter,
    size_change: sizeBefore && sizeAfter ? { w: sizeAfter.w - sizeBefore.w, h: sizeAfter.h - sizeBefore.h } : null,
    grew: !!(sizeBefore && sizeAfter && (sizeAfter.w > sizeBefore.w || sizeAfter.h > sizeBefore.h)),
    shrank: !!(sizeBefore && sizeAfter && (sizeAfter.w < sizeBefore.w || sizeAfter.h < sizeBefore.h)),
    cells_before: cellsBefore,
    cells_after: cellsAfter,
    // null, not 0, when the two terrains cannot be compared cell by cell — an
    // unknown is not the same as "nothing changed".
    cells_changed: cellsChanged,
  };
  out.changed = out.kind_changed || sizeChanged || cellsBefore !== cellsAfter || (cellsChanged || 0) > 0;
  return out;
}

function diffEnvironment(before, after) {
  const eb = before?.environment || {};
  const ea = after?.environment || {};
  const fields = [];
  for (const k of [...new Set([...Object.keys(eb), ...Object.keys(ea)])].sort()) {
    if (stable(eb[k]) === stable(ea[k])) continue;
    fields.push({ field: k, before: eb[k] ?? null, after: ea[k] ?? null });
  }
  return { changed: fields.length > 0, fields };
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const short = (v) => (v === null || v === undefined ? "nothing" : typeof v === "object" ? "a new setting" : `'${v}'`);

/**
 * Compare two versions of a world.
 *
 * `before` and `after` are two manifests of the same world. Direction matters:
 * everything is reported as what happened TO `before` to arrive at `after`, so
 * diffing a rollback's result against the live world reports the entities the
 * rollback would take away as removals.
 *
 * @returns {{added:object, removed:object, modified:object, environment:object, terrain:object, summary:object}}
 */
export function diffManifests(before, after) {
  if (!before || typeof before !== "object") throw Errors.validation("a diff needs a 'before' manifest");
  if (!after || typeof after !== "object") throw Errors.validation("a diff needs an 'after' manifest");

  const ib = indexOf(before);
  const ia = indexOf(after);

  const added = { total: 0, by_collection: zeroCounts(), entities: [] };
  const removed = { total: 0, by_collection: zeroCounts(), entities: [] };
  const modified = { total: 0, by_collection: zeroCounts(), entities: [] };

  for (const c of COLLECTIONS) {
    for (const [id, entity] of ia[c]) {
      if (ib[c].has(id)) continue;
      added.by_collection[c]++;
      added.total++;
      added.entities.push({ collection: c, id, name: labelOf(entity) });
    }
    for (const [id, entity] of ib[c]) {
      if (ia[c].has(id)) continue;
      removed.by_collection[c]++;
      removed.total++;
      removed.entities.push({ collection: c, id, name: labelOf(entity) });
    }
    for (const [id, entity] of ib[c]) {
      const now = ia[c].get(id);
      if (!now) continue;
      const fields = changedFields(entity, now);
      if (!fields.length) continue;
      modified.by_collection[c]++;
      modified.total++;
      modified.entities.push({ collection: c, id, name: labelOf(now), fields });
    }
  }

  const environment = diffEnvironment(before, after);
  const terrain = diffTerrain(before, after);

  // ---- the creator-facing account ----------------------------------------
  const lines = [];
  if (added.total) {
    lines.push(`Added ${countPhrase(added.by_collection)}.`);
    const zones = added.entities.filter((e) => e.collection === "zones").map((e) => e.name);
    if (zones.length) lines.push(`New ${NOUNS.zones[zones.length === 1 ? 0 : 1]}: ${listPhrase(zones)}.`);
    const quests = added.entities.filter((e) => e.collection === "quests").map((e) => e.name);
    if (quests.length) lines.push(`New ${NOUNS.quests[quests.length === 1 ? 0 : 1]}: ${listPhrase(quests)}.`);
  }
  if (removed.total) {
    lines.push(`Removed ${countPhrase(removed.by_collection)}.`);
    const gone = removed.entities.filter((e) => e.collection === "zones" || e.collection === "quests").map((e) => e.name);
    if (gone.length) lines.push(`Gone: ${listPhrase(gone)}.`);
  }
  if (modified.total) {
    lines.push(`Changed ${countPhrase(modified.by_collection)}.`);
    for (const e of modified.entities.slice(0, 5)) lines.push(`${e.name} (${e.id}): ${listPhrase(e.fields)}.`);
    if (modified.entities.length > 5) lines.push(`...and ${modified.entities.length - 5} more.`);
  }
  for (const f of environment.fields) {
    lines.push(isPlain(f.before) || isPlain(f.after)
      ? `Environment: ${f.field} changed.`
      : `Environment: ${f.field} changed from ${short(f.before)} to ${short(f.after)}.`);
  }
  if (terrain.kind_changed) lines.push(`Terrain kind changed from ${short(terrain.kind_before)} to ${short(terrain.kind_after)}.`);
  if (terrain.size_before && terrain.size_after && stable(terrain.size_before) !== stable(terrain.size_after)) {
    const verb = terrain.grew && !terrain.shrank ? "grew" : terrain.shrank && !terrain.grew ? "shrank" : "changed shape";
    lines.push(`The map ${verb} from ${terrain.size_before.w}x${terrain.size_before.h} to ${terrain.size_after.w}x${terrain.size_after.h}.`);
  }
  if (terrain.cells_changed) lines.push(`${terrain.cells_changed} height ${terrain.cells_changed === 1 ? "cell was" : "cells were"} re-sculpted.`);

  const changed = added.total > 0 || removed.total > 0 || modified.total > 0 || environment.changed || terrain.changed;
  const fromV = before.world_version ?? null;
  const toV = after.world_version ?? null;
  const versions = fromV !== null && toV !== null && fromV !== toV ? ` between v${fromV} and v${toV}` : "";

  // Saying "nothing changed" out loud matters as much as listing what did: a
  // creator who is told nothing happened will go and look for the reason.
  const text = changed
    ? (versions ? `v${fromV} to v${toV}: ` : "") + lines.join(" ")
    : `Nothing changed${versions}.`;

  return {
    added,
    removed,
    modified,
    environment,
    terrain,
    summary: {
      changed,
      from_version: fromV,
      to_version: toV,
      added_total: added.total,
      removed_total: removed.total,
      modified_total: modified.total,
      environment_fields_changed: environment.fields.length,
      terrain_changed: terrain.changed,
      lines,
      text,
    },
  };
}

export { NOUNS };
