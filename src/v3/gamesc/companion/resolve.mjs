// GAMES-C companion — resolve a phrase ("the castle", "the old tower", "Tomas")
// to a manifest entity by fuzzy match, and read/write positions.
//
// Resolution is deterministic: candidates are scored, ties are reported as
// ambiguity (the caller asks a clarification question) rather than broken by
// array order.
import { STRUCTURE_WORDS } from "./lexicon.mjs";

const STOP = new Set(["the", "a", "an", "my", "our", "this", "that", "those", "these", "of", "big", "small", "little", "old", "new", "one", "thing", "building", "place"]);

export const tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
const singular = (w) => (w.length > 3 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}

/** Words that mean the same archetype: "castle" also finds a keep_hall. */
function expandWord(w) {
  const out = new Set([w, singular(w)]);
  const arch = STRUCTURE_WORDS[w] || STRUCTURE_WORDS[singular(w)];
  if (arch) { out.add(arch); for (const p of arch.split("_")) out.add(p); }
  return out;
}

/** Everything addressable, as a flat list of {collection, id, label, words, entity}. */
export function entityIndex(manifest, pending = []) {
  const out = [];
  const push = (collection, e, labelParts) => {
    if (!e || typeof e.id !== "string") return;
    const words = new Set();
    for (const part of labelParts) for (const w of tokens(part)) { words.add(w); words.add(singular(w)); }
    const assetArch = e.asset_ref ? String(e.asset_ref).replace(/^asset_/, "") : null;
    if (assetArch) for (const w of tokens(assetArch)) words.add(w);
    const label = labelParts.find((p) => typeof p === "string" && p.trim()) || e.id;
    out.push({ collection, id: e.id, label: String(label), words, entity: e });
  };
  const m = manifest || {};
  for (const s of m.structures || []) push("structures", s, [s.name, s.purpose, s.id.replace(/^struct_/, "").replace(/_v\d+_/, "_")]);
  for (const n of m.npcs || []) push("npcs", n, [n.name, n.role, n.faction, n.id.replace(/^npc_/, "")]);
  for (const z of m.zones || []) push("zones", z, [z.name, ...(z.tags || []), z.id.replace(/^zone_/, "")]);
  for (const it of m.items || []) push("items", it, [it.name, it.kind, it.id.replace(/^item_/, "")]);
  for (const p of pending) if (!out.some((o) => o.id === p.value.id)) push(p.collection, p.value, p.labelParts || [p.value.name, p.value.purpose, p.value.role, p.value.id]);
  return out;
}

/**
 * @returns {{status:"found", match} | {status:"ambiguous", candidates} | {status:"none", phrase}}
 */
export function resolveEntity(phrase, manifest, { pending = [], collections = null, plural = false } = {}) {
  const want = tokens(phrase).filter((w) => !STOP.has(w));
  if (!want.length) return { status: "none", phrase };
  const index = entityIndex(manifest, pending).filter((e) => !collections || collections.includes(e.collection));
  const scored = [];
  for (const e of index) {
    if (e.id.toLowerCase() === String(phrase).toLowerCase().trim()) { scored.push({ e, score: 100 }); continue; }
    let score = 0;
    for (const w of want) {
      const forms = expandWord(w);
      if ([...forms].some((f) => e.words.has(f))) score += 10;
      else if (w.length >= 5 && [...e.words].some((ew) => ew.length >= 4 && lev(w, ew) <= 1)) score += 6;   // "casle" -> castle
    }
    if (score > 0) {
      // Prefer the entity that matches every word, then a shorter label.
      const coverage = score / (want.length * 10);
      // A named thing beats the area it stands in: "the castle" is the keep, not
      // "Castle Grounds". Two things of the same kind still tie -> ambiguous.
      const prio = e.collection === "structures" ? 2 : e.collection === "npcs" ? 1 : 0;
      scored.push({ e, score: score + (coverage >= 1 ? 5 : 0) + prio });
    }
  }
  if (!scored.length) return { status: "none", phrase };
  scored.sort((a, b) => b.score - a.score || a.e.id.localeCompare(b.e.id));
  const best = scored[0].score;
  const top = scored.filter((s) => s.score === best);
  // "the enemies" / "all towers": a plural phrase means every equally good match.
  if (top.length > 1 && plural) return { status: "found_many", matches: top.slice(0, 20).map(({ e }) => describe(e)) };
  if (top.length > 1) return { status: "ambiguous", candidates: top.slice(0, 6).map(({ e }) => describe(e)), phrase };
  return { status: "found", match: describe(top[0].e), fuzzy: best < want.length * 10 };
}

const describe = (e) => ({ collection: e.collection, id: e.id, label: e.label, entity: e.entity });

/** Current position of an entity, or null when it has none (items, quests). */
export function positionOf(collection, entity) {
  if (!entity) return null;
  if (collection === "structures") return entity.transform?.position ? { ...entity.transform.position } : null;
  if (collection === "npcs") return entity.spawn ? { ...entity.spawn } : null;
  if (collection === "zones" && Array.isArray(entity.bounds)) {
    const [x0, z0, x1, z1] = entity.bounds;
    return { x: (x0 + x1) / 2, y: 0, z: (z0 + z1) / 2 };
  }
  return null;
}

export function spawnPosition(manifest) {
  const p = manifest?.spawn?.player_spawns?.[0]?.position;
  return p ? { ...p } : { x: 0, y: 1, z: 0 };
}

/** The zone whose bounds contain a point, or null. */
export function zoneAt(manifest, pos, pending = []) {
  const zones = [...(manifest?.zones || []), ...pending.filter((p) => p.collection === "zones").map((p) => p.value)];
  const hit = zones.find((z) => Array.isArray(z.bounds) && pos.x >= z.bounds[0] && pos.x <= z.bounds[2] && pos.z >= z.bounds[1] && pos.z <= z.bounds[3]);
  return hit ? hit.id : null;
}

/** A short, human list of what exists — used in clarification questions. */
export function describeWorld(manifest, limit = 8) {
  const names = [];
  for (const s of manifest?.structures || []) names.push(s.name || s.purpose || s.id);
  for (const n of manifest?.npcs || []) names.push(n.name || n.id);
  for (const z of manifest?.zones || []) names.push(z.name || z.id);
  return [...new Set(names.map(String))].slice(0, limit);
}
