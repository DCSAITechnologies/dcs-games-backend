// src/variety.mjs
// MAXIMUM mandate: generation variety (biomes + objective types) + regenerate/remix.
// All output stays C1-conformant (validated). Builds on generate.mjs; additive, zero-dep.

import crypto from "node:crypto";
import { generateWorld, parsePrompt } from "./generate.mjs";
import { validateWorld } from "./validator.mjs";

// ---- biomes: a terrain flavor layered onto a genre (additive meta + zone naming) ----
export const BIOMES = {
  horror:    ["derelict-ward", "flooded-basement", "morgue", "asylum-wing"],
  cyberpunk: ["neon-slums", "corpo-spire", "data-undercity", "rooftop-sprawl"],
  fantasy:   ["throne-keep", "dragon-roost", "enchanted-wood", "ruined-crypt"],
  pirate:    ["smugglers-cove", "sunken-galleon", "treasure-isle", "port-town"],
  scifi:     ["docking-bay", "reactor-core", "derelict-hull", "orbital-ring"],
  western:   ["dusty-street", "box-canyon", "saloon-row", "mine-shaft"],
  underwater:["coral-trench", "sunken-city", "abyssal-vent", "kelp-forest"],
  jungle:    ["overgrown-plaza", "temple-interior", "river-crossing", "canopy-walk"],
  apocalypse:["ruined-overpass", "fallout-bunker", "scrap-yard", "dead-mall"],
  medieval:  ["village-square", "castle-bailey", "tavern-quarter", "siege-camp"],
  adventure: ["wilds", "canyon", "outpost", "cavern"],
};
export function pickBiome(genre, seed) {
  const list = BIOMES[genre] || BIOMES.adventure;
  let h = 0; for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

// ---- objective variety: more quest templates than the base seeder's single objective ----
export const OBJECTIVE_TYPES = {
  collect:  (n) => ({ id: "o_collect", text: `Collect ${n} key items`, trigger: `collect:item:${n}` }),
  reach:    () => ({ id: "o_reach", text: "Reach the extraction zone", trigger: "enter_zone:z2" }),
  survive:  (s) => ({ id: "o_survive", text: `Survive ${s}s against the threat`, trigger: `survive:${s}` }),
  defeat:   (k) => ({ id: "o_defeat", text: `Defeat the ${k}`, trigger: `defeat:npc:${k}` }),
  escort:   () => ({ id: "o_escort", text: "Escort the survivor to safety", trigger: "escort:npc_1:z2" }),
  solve:    () => ({ id: "o_solve", text: "Solve the door cipher", trigger: "interact:ob_door" }),
};
// Build a varied quest set for a genre (deterministic per seed).
export function variedQuests(genre, seed) {
  let h = 0; for (const c of String(seed)) h = (h * 131 + c.charCodeAt(0)) >>> 0;
  const keys = Object.keys(OBJECTIVE_TYPES);
  const pick = (i) => keys[(h + i) % keys.length];
  const o1 = OBJECTIVE_TYPES[pick(0)](3);
  const o2 = OBJECTIVE_TYPES[pick(2)](30);
  return [{
    quest_id: "q1",
    title: genre === "horror" ? "Escape the outbreak" : genre === "pirate" ? "Claim the treasure" : "Complete the run",
    objectives: [o1, o2],
    reward: { item_id: "it_1", xp: 150 },
  }];
}

// ---- generate WITH variety: a richer world than the base seeder (biome + varied objectives) ----
export function generateVariedWorld(prompt, opts = {}) {
  const seed = opts.seed || prompt;
  const world = generateWorld(prompt, opts);
  const { genre } = parsePrompt(prompt);
  const biome = pickBiome(genre, seed);
  world.meta.biome = biome;                              // additive meta (C1 allows additional props)
  if (world.terrain.zones && world.terrain.zones[0]) world.terrain.zones[0].name = biome;
  world.quests = variedQuests(genre, seed);              // varied objectives
  return world;
}

// ---- regenerate: same prompt, NEW seed -> a different valid world ----
export function regenerate(prompt, opts = {}) {
  const newSeed = (opts.seed || prompt) + ":" + crypto.randomBytes(4).toString("hex");
  return generateVariedWorld(prompt, { ...opts, seed: newSeed });
}

// ---- remix: take an existing world, produce a C1-valid variant that keeps identity lineage ----
export function remixWorld(sourceWorld, opts = {}) {
  const seed = (sourceWorld.world_id || "remix") + ":" + (opts.seed || crypto.randomBytes(4).toString("hex"));
  const prompt = sourceWorld.meta?.prompt || sourceWorld.meta?.title || "remix";
  const variant = generateVariedWorld(prompt, { ...opts, seed, creator_id: opts.creator_id || sourceWorld.meta.creator_id });
  variant.meta.remixed_from = sourceWorld.world_id;       // lineage for CW7 provenance
  variant.meta.title = (sourceWorld.meta?.title || "World") + " (Remix)";
  return variant;
}

// Guard: all variety output must be C1-valid (the seam never emits a bad world).
export function generateVariedValidated(prompt, opts = {}) {
  const w = generateVariedWorld(prompt, opts);
  const v = validateWorld(w);
  if (!v.valid) { const e = new Error("varied_world_invalid"); e.details = v.errors; throw e; }
  return w;
}
