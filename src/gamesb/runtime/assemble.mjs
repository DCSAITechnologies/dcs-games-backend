// Games-B package assembly (CONTRACT §7). Node-side (hashing).
//
// Assembly is deliberately dumb: it does not generate, repair or reorder
// anything. It stitches the stage outputs into the one object the runtime
// loads, declares which edit/expand operations the package supports, picks the
// companion, and seals the result with a content hash. Keeping it dumb is what
// makes the integrity hash meaningful — every byte in the package came from a
// named stage recorded in provenance.

import { sha256Json } from "../common/hash.mjs";

export const PACKAGE_VERSION = "1.0.0";
export const PIPELINE_VERSION = "gamesb-1.0.0";

export const EDIT_OPS = Object.freeze([
  "move_placement", "add_placement", "remove_placement", "recolor_material", "set_time_of_day", "set_weather",
  "rename_character", "set_character_behavior", "set_objective_text", "add_optional_objective", "set_difficulty",
]);
export const EXPAND_OPS = Object.freeze(["add_region"]);

/** The companion is the first non-hostile character flagged companion, else the first quest giver. */
function pickCompanion(characters, concept) {
  const list = characters?.characters || [];
  const c = list.find((x) => x.companion && !x.behavior?.hostile)
    || list.find((x) => x.role === "companion")
    || list.find((x) => x.role === "quest_giver")
    || null;
  const knowledge = [];
  if (concept?.title) knowledge.push(`world:${concept.title}`);
  for (const l of concept?.key_locations || []) knowledge.push(`location:${l.id}`);
  for (const ch of list) knowledge.push(`character:${ch.id}`);
  return { character_ref: c?.id ?? null, knowledge };
}

/** sha256 over the canonical package without its integrity block. */
export function computeIntegrity(pkg) {
  const { integrity, ...rest } = pkg;
  return sha256Json(rest);
}

/** Return a copy of `pkg` with integrity.sha256 recomputed. */
export function seal(pkg) {
  const { integrity, ...rest } = pkg;
  return { ...rest, integrity: { sha256: sha256Json(rest) } };
}

/**
 * @param {object} a
 * @param {string} a.gameId
 * @param {number} [a.version=1]
 * @param {object[]} a.assets AssetRecord[]
 * @param {object[]} [a.provenance] ProvenanceStage[]
 * @param {string} [a.createdAt] fixed timestamp for byte-identical rebuilds
 * @param {object} [a.extras] optional add-only top-level fields (e.g. `audio`); never overrides a contract field
 */
export function assemblePackage({ gameId, version = 1, concept, world, scene, assets, gameplay, characters, provenance = [], createdAt, hooks, extras } = {}) {
  if (!gameId) throw new Error("assemblePackage: gameId is required");
  const records = Array.isArray(assets) ? assets : assets?.records || [];
  const pkg = {
    package_version: PACKAGE_VERSION,
    game_id: gameId,
    version,
    title: concept?.title || world?.title || gameId,
    created_at: createdAt || new Date().toISOString(),
    concept, world, scene,
    assets: { records },
    gameplay, characters,
    hooks: {
      edit: { ops: [...EDIT_OPS] },
      expand: { ops: [...EXPAND_OPS], ...(hooks?.expand?.history ? { history: hooks.expand.history } : {}) },
      companion: hooks?.companion || pickCompanion(characters, concept),
    },
    provenance: {
      pipeline_version: PIPELINE_VERSION,
      prompt_hash: concept?.prompt_hash ?? null,
      stages: [...provenance, { stage: "assemble", lane: "local", provider: "local", model: "deterministic", status: "AVAILABLE", latency_ms: 0, cost_usd: 0, at: createdAt || new Date().toISOString() }],
    },
  };
  for (const [k, v] of Object.entries(extras || {})) if (!(k in pkg) && v !== undefined && v !== null) pkg[k] = v;
  return seal(pkg);
}
