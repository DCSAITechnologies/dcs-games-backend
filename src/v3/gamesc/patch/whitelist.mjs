// GAMES-C patch — what an edit is allowed to touch.
//
// Every entry here is derived from src/v3/manifest/schema.mjs (validateManifest +
// emptyManifest), from what src/v3/router/assembly.mjs actually emits, or is
// marked `source: "added"`. An "added" path is a NEW optional manifest field:
// validateManifest ignores unknown keys, so it is structurally safe, but no
// runtime in this repo reads it yet (DESIGN-ONLY until the runtime consumes it).
import {
  WEATHERS, ZONE_KINDS, ASSET_KINDS, ASSET_FORMATS, BEHAVIOR_KINDS, TRIGGERS, QUEST_STEP_KINDS,
} from "../../manifest/schema.mjs";
import { COLLECTIONS, MODIFIABLE } from "../../expansion/delta.mjs";

export { WEATHERS, ZONE_KINDS, ASSET_KINDS, ASSET_FORMATS, BEHAVIOR_KINDS, TRIGGERS, QUEST_STEP_KINDS, COLLECTIONS };

export const RULE_DIFFICULTIES = ["easy", "normal", "hard"];
export const UI_THEMES = ["default", "dark", "light", "high_contrast"];

/**
 * Settable scalar/object paths. type:
 *   enum | number | int | boolean | string | tags | palette | data (null or bounded plain object)
 */
export const SET_PATH_SPECS = Object.freeze({
  // environment — schema.mjs validates weather/time_of_day/gravity; delta.mjs MODIFIABLE.environment lists the rest
  "environment.weather":           { type: "enum", values: WEATHERS, source: "schema" },
  "environment.time_of_day":       { type: "number", min: 0, max: 1, source: "schema" },
  "environment.gravity":           { type: "number", min: -50, max: 0, source: "schema" },
  "environment.sky":               { type: "data", nullable: true, source: "emptyManifest" },
  "environment.fog":               { type: "data", nullable: true, source: "emptyManifest" },
  "environment.ambient_light":     { type: "data", nullable: true, source: "emptyManifest" },
  "environment.directional_light": { type: "data", nullable: true, source: "emptyManifest" },
  "environment.wind":              { type: "data", nullable: true, source: "emptyManifest" },
  "environment.palette":           { type: "palette", nullable: true, source: "assembly" },
  // meta
  "meta.title":                    { type: "string", min: 1, max: 120, source: "schema" },
  "meta.description":              { type: "string", nullable: true, max: 2000, source: "emptyManifest" },
  "meta.tags":                     { type: "tags", source: "schema" },
  "meta.genre":                    { type: "string", nullable: true, max: 64, source: "emptyManifest" },
  "meta.style":                    { type: "string", nullable: true, max: 64, source: "emptyManifest" },
  "meta.gameplay_loop":            { type: "string", nullable: true, max: 500, source: "assembly" },
  // physics / spawn / multiplayer / companion / runtime
  "physics.gravity":               { type: "number", min: -50, max: 0, source: "emptyManifest" },
  "physics.ground_friction":       { type: "number", min: 0, max: 2, source: "assembly" },
  "spawn.safe_radius":             { type: "number", min: 0, max: 100, source: "emptyManifest" },
  "multiplayer.enabled":           { type: "boolean", source: "emptyManifest" },
  "multiplayer.max_players":       { type: "int", min: 1, max: 64, source: "schema" },
  "companion.enabled":             { type: "boolean", source: "emptyManifest" },
  "runtime_config.render_distance":{ type: "number", min: 40, max: 2000, source: "emptyManifest" },
  "runtime_config.streaming":      { type: "boolean", source: "emptyManifest" },
  // ADDED — gameplay rules / player params / ui (no such fields existed; runtime consumption is DESIGN-ONLY)
  "gameplay.player.move_speed":    { type: "number", min: 0.5, max: 30, source: "added" },
  "gameplay.player.jump_height":   { type: "number", min: 0, max: 20, source: "added" },
  "gameplay.player.max_health":    { type: "int", min: 1, max: 10000, source: "added" },
  "gameplay.rules.difficulty":     { type: "enum", values: RULE_DIFFICULTIES, source: "added" },
  "gameplay.rules.permadeath":     { type: "boolean", source: "added" },
  "gameplay.rules.time_limit_s":   { type: "int", nullable: true, min: 0, max: 86400, source: "added" },
  "ui.hud_visible":                { type: "boolean", source: "added" },
  "ui.minimap":                    { type: "boolean", source: "added" },
  "ui.show_objectives":            { type: "boolean", source: "added" },
  "ui.crosshair":                  { type: "boolean", source: "added" },
  "ui.theme":                      { type: "enum", values: UI_THEMES, source: "added" },
});

export const SET_PATH_WHITELIST = Object.freeze(Object.keys(SET_PATH_SPECS));

/**
 * Fields `update` may change on an existing entity, per collection. Starts from
 * delta.mjs MODIFIABLE and widens it with reference fields (whose integrity
 * validateManifest re-checks after apply). NEVER: id, owner_id, script, uri.
 */
const u = (k) => [...(MODIFIABLE[k] || [])];
export const UPDATE_FIELDS = Object.freeze({
  zones:        new Set([...u("zone"), "kind", "bounds", "parent_zone"]),
  structures:   new Set([...u("structure"), "asset_ref", "zone"]),
  npcs:         new Set([...u("npc"), "asset_ref"]),
  items:        new Set([...u("item"), "asset_ref", "kind"]),
  quests:       new Set([...u("quest"), "steps", "giver_npc", "zone", "prerequisites", "description"]),
  behaviors:    new Set([...u("behavior"), "kind"]),
  interactions: new Set(["trigger", "target_ref", "behavior_ref", "params"]),
  assets:       new Set(["name", "tags", "collision", "lod", "composition", "primitive"]),
});

/** Fields no op may ever write, in any collection. */
export const FORBIDDEN_FIELDS = new Set(["id", "owner_id", "script", "uri"]);

/** Where `move` writes a position, per movable collection. */
export const MOVE_TARGETS = Object.freeze({
  structures: ["transform", "position"],
  npcs: ["spawn"],
  player_spawns: ["position"], // entries of manifest.spawn.player_spawns
});

/** Enum-typed fields checked at op level (validateManifest re-checks after apply). */
export const FIELD_ENUMS = Object.freeze({
  zones: { kind: ZONE_KINDS },
  assets: { kind: ASSET_KINDS, format: ASSET_FORMATS },
  behaviors: { kind: BEHAVIOR_KINDS },
  interactions: { trigger: TRIGGERS },
});

/**
 * replace_asset is the ONLY op that may carry a URL, and only in `uri`, and
 * only matching this allowlist (same-origin asset paths or the DCS asset CDN).
 */
export const ASSET_URI_ALLOWLIST = Object.freeze([
  /^\/assets\/[A-Za-z0-9_\-/]+\.(glb|gltf)$/,
  /^dcs-asset:\/\/[A-Za-z0-9_\-/]+\.(glb|gltf)$/,
  /^https:\/\/assets\.dcsai\.ai\/[A-Za-z0-9_\-/]+\.(glb|gltf)$/,
]);

export const LIMITS = Object.freeze({
  MAX_OPS_PER_PATCH: 64,
  MAX_VALUE_BYTES: 32 * 1024,     // canonical JSON of one op
  MAX_PATCH_BYTES: 256 * 1024,
  MAX_STRING: 4000,
  MAX_DEPTH: 10,
  MAX_KEYS: 256,
  MAX_ARRAY: 2048,
  MAX_COLLECTION: 5000,
  MAX_COORD: 100000,
});
