// GameConcept validator (CONTRACT §1). ISOMORPHIC.
//
// The concept is the first thing every later stage reads, and the world stage
// derives region/spawn/interactable ids straight from `key_locations` and
// `characters` (§4.5). So beyond shape, this enforces the things those ids
// depend on: snake_case unique ids, and the start hub being FIRST.
import { Issues, isObj, isArr, isStr, isHex, requireEnum, requireNum, uniqueIds } from "../common/issues.mjs";

export const CONCEPT_VERSION = "1.0.0";
export const GENRES = ["adventure", "exploration", "mission", "puzzle", "survival", "collectathon", "stealth"];
export const BIOMES = ["island", "forest", "desert", "snow", "volcanic", "canyon", "ruins", "city", "scifi_base"];
export const SCALES = ["small", "medium", "large"];
export const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "sandstorm", "ash"];
export const LOCATION_KINDS = ["hub", "landmark", "ruin", "shrine", "camp", "cave", "tower", "village", "dock", "summit", "grove"];
export const CHARACTER_ROLES = ["companion", "quest_giver", "merchant", "guard", "enemy", "creature", "ambient"];
export const PALETTE_KEYS = ["primary", "secondary", "accent", "ground", "sky", "water"];
export const HOSTILE_ROLES = ["guard", "enemy", "creature"];
export const SCALE_EDGE_M = { small: 160, medium: 240, large: 320 };

const SNAKE = /^[a-z][a-z0-9_]*$/;

export function validateConcept(c) {
  const iss = new Issues();
  if (!isObj(c)) { iss.err("", "concept must be an object"); return iss.toJSON(); }

  if (c.concept_version !== CONCEPT_VERSION) iss.err("concept_version", `must be "${CONCEPT_VERSION}"`);
  for (const k of ["title", "logline", "source_prompt", "mood", "player_fantasy"]) {
    if (!isStr(c[k])) iss.err(k, "is required and must be a non-empty string");
  }
  if (!(typeof c.prompt_hash === "string" && /^[0-9a-f]{64}$/.test(c.prompt_hash))) iss.err("prompt_hash", "must be a sha256 hex string");
  requireNum(iss, c.seed, "seed", { integer: true, min: 0 });
  requireEnum(iss, c.genre, GENRES, "genre");
  requireEnum(iss, c.biome, BIOMES, "biome");
  requireEnum(iss, c.scale, SCALES, "scale");
  requireEnum(iss, c.weather, WEATHERS, "weather");
  requireNum(iss, c.time_of_day, "time_of_day", { min: 0, max: 1 });

  if (!isObj(c.palette)) iss.err("palette", "is required");
  else for (const k of PALETTE_KEYS) if (!isHex(c.palette[k])) iss.err(`palette.${k}`, "must be #rrggbb");

  // Key locations: the world stage makes region_<id>, ix_<id> and spawn_cp_region_<id>
  // from these, so an id that is not snake_case would leak into every stage.
  if (!isArr(c.key_locations) || c.key_locations.length < 2) {
    iss.err("key_locations", "needs at least 2 locations (a hub plus somewhere to go)");
  } else {
    uniqueIds(iss, c.key_locations, "key_locations");
    c.key_locations.forEach((l, i) => {
      const p = `key_locations[${i}]`;
      if (!isObj(l)) { iss.err(p, "must be an object"); return; }
      if (isStr(l.id) && !SNAKE.test(l.id)) iss.err(`${p}.id`, `'${l.id}' must be snake_case`);
      if (!isStr(l.name)) iss.err(`${p}.name`, "is required");
      if (!isStr(l.description)) iss.err(`${p}.description`, "is required");
      requireEnum(iss, l.kind, LOCATION_KINDS, `${p}.kind`);
      if (i > 0 && l.kind === "hub") iss.err(`${p}.kind`, "only the first key_location may be the hub");
    });
    if (c.key_locations[0]?.kind !== "hub") iss.err("key_locations[0].kind", "the first key_location must be the start hub", "move the hub first");
    if (c.key_locations.length < 4 || c.key_locations.length > 6) iss.warn("key_locations", `expected 4–6 locations, got ${c.key_locations.length}`);
  }

  if (!isArr(c.characters) || c.characters.length < 1) {
    iss.err("characters", "needs at least one character");
  } else {
    uniqueIds(iss, c.characters, "characters");
    c.characters.forEach((ch, i) => {
      const p = `characters[${i}]`;
      if (!isObj(ch)) { iss.err(p, "must be an object"); return; }
      if (isStr(ch.id) && !SNAKE.test(ch.id)) iss.err(`${p}.id`, `'${ch.id}' must be snake_case`);
      if (!isStr(ch.name)) iss.err(`${p}.name`, "is required");
      if (!isStr(ch.description)) iss.err(`${p}.description`, "is required");
      requireEnum(iss, ch.role, CHARACTER_ROLES, `${p}.role`);
    });
    const roles = new Set(c.characters.map((x) => x?.role));
    if (!roles.has("quest_giver")) iss.err("characters", "needs a quest_giver (the main chain starts by talking to them)");
    if (!roles.has("companion")) iss.warn("characters", "no companion character");
    if (c.characters.length < 3 || c.characters.length > 5) iss.warn("characters", `expected 3–5 characters, got ${c.characters.length}`);
  }

  // Location and character ids share the interactable namespace (ix_<loc>, ix_talk_<char>),
  // which cannot collide by construction, but the same id for both is still confusing.
  if (isArr(c.key_locations) && isArr(c.characters)) {
    const locIds = new Set(c.key_locations.map((l) => l?.id));
    c.characters.forEach((ch, i) => { if (locIds.has(ch?.id)) iss.warn(`characters[${i}].id`, `'${ch.id}' is also a location id`); });
  }

  for (const k of ["objectives_outline", "hazards"]) {
    if (!isArr(c[k])) iss.err(k, "must be an array of strings");
    else c[k].forEach((s, i) => { if (!isStr(s)) iss.err(`${k}[${i}]`, "must be a non-empty string"); });
  }
  return iss.toJSON();
}
