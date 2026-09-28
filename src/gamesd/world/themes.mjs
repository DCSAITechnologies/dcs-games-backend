// Games-D theme presets (CONTRACT §3 Theme). Data + pure patches, no I/O.
//
// A theme fixes the look of a fallback world: the Games-B biome, the terrain
// shape (an optional concept field the world stage reads), weathers, lighting
// presets, a full palette, scatter density and mix, the pickup item and the
// material/audio preset ids (both keyed by the theme id). Every one of the nine
// Games-B biomes has at least one theme, and each has two visibly different
// variants (different shape, palette, weather and scatter).
//
// `keywords` feed recipeFromPrompt()'s keyword scoring, so they are the words
// a player would type. A keyword may be two words ("sci fi"); both must appear.

import { hashString, round2, clamp } from "../../gamesb/common/rng.mjs";
import { isConnected, bakeNavigation } from "../../gamesb/world/world-spec.mjs";
import { expandScatter } from "../../gamesb/world/terrain-sample.mjs";
import { buildColliders, pointInCollider } from "../../gamesb/world/collision.mjs";
import { reachableSet, navIndex } from "../../gamesb/world/nav-grid.mjs";
import { ASSET_BUDGET } from "../budgets.mjs";

/**
 * Optional theme extras beyond CONTRACT §3 (read only by this file):
 *   scatter_mix  {lib → multiplier} applied on top of scatter_density
 *   scatter_add  extra scatter rows [lib, density per 10 000 m², minScale, maxScale, colliderR, extra];
 *                min_h / max_h in `extra` are relative to the water line
 *   fog_k        multiplier on the environment fog distances (< 1 is thicker)
 */
const T = (id, o) => Object.freeze({ id, material_style: id, audio: id, scatter_density: 1, tags: [], ...o });
const REEDS = ["reeds", 9, 0.8, 1.3, 0, { zone: "shore", min_h: -0.3, max_h: 0.9, max_slope_deg: 20 }];

export const THEMES = Object.freeze({
  // ------------------------------------------------------------- island
  storm_isle: T("storm_isle", {
    name: "Storm Isle", biome: "island", terrain_shape: "island",
    weathers: ["storm", "rain"], lightings: ["storm_dark", "dusk"], mood: "tense",
    palette: { primary: "#3d5a6c", secondary: "#8a8f7a", accent: "#ffd166", ground: "#5e6e4f", sky: "#5f7385", water: "#1f4e66" },
    scatter_density: 0.9, scatter_mix: { palm_tree: 0.5, pine_tree: 1.6, flowers: 0.3, rock_large: 1.8 }, fog_k: 0.85,
    pickup_lib: "lantern_core",
    keywords: ["storm", "stormy", "lighthouse", "island", "thunder", "shipwreck", "sea", "coast", "waves", "gale"],
    tags: ["water", "coastal", "dark"],
  }),
  tropical_cove: T("tropical_cove", {
    name: "Tropical Cove", biome: "island", terrain_shape: "archipelago",
    weathers: ["clear", "cloudy"], lightings: ["noon", "golden_hour"], mood: "cheerful",
    palette: { primary: "#2fa37a", secondary: "#f2d492", accent: "#ff7b54", ground: "#7fbf5a", sky: "#6fd3f7", water: "#1fb5c9" },
    scatter_density: 1.2, scatter_mix: { palm_tree: 2.2, pine_tree: 0.2, flowers: 1.8, broadleaf_tree: 0.6 },
    pickup_lib: "gem",
    keywords: ["tropical", "beach", "cove", "lagoon", "palm", "paradise", "archipelago", "islands", "reef", "sunny", "treasure", "pirate"],
    tags: ["water", "bright", "archipelago"],
  }),
  // ------------------------------------------------------------- forest
  pine_valley: T("pine_valley", {
    name: "Pine Valley", biome: "forest", terrain_shape: "valley",
    weathers: ["clear", "fog"], lightings: ["dawn", "noon"], mood: "serene",
    palette: { primary: "#2f5d3a", secondary: "#a47c4b", accent: "#f4b942", ground: "#4d7a3a", sky: "#9cc9e8", water: "#3a7ca5" },
    scatter_density: 1.15, scatter_mix: { pine_tree: 1.7, broadleaf_tree: 0.6 },
    pickup_lib: "herb",
    keywords: ["forest", "woods", "pine", "valley", "woodland", "trees", "cabin", "hiking", "ranger"],
    tags: ["green"],
  }),
  swamp_fen: T("swamp_fen", {
    name: "Swamp Fen", biome: "forest", terrain_shape: "marsh",
    weathers: ["fog", "rain"], lightings: ["overcast", "dusk"], mood: "eerie",
    palette: { primary: "#4b5a32", secondary: "#7a6a45", accent: "#b6e05a", ground: "#3e4a2c", sky: "#8a9a86", water: "#3f4d36" },
    scatter_density: 1.1, scatter_mix: { dead_tree: 4, mushroom: 2.5, pine_tree: 0.3, broadleaf_tree: 0.7, flowers: 0.3 },
    scatter_add: [REEDS], fog_k: 0.7,
    pickup_lib: "herb",
    keywords: ["swamp", "marsh", "bog", "fen", "bayou", "wetland", "mud", "frog", "witch", "murky"],
    tags: ["water", "dark", "wet"],
  }),
  // ------------------------------------------------------------- desert
  dune_sea: T("dune_sea", {
    name: "Dune Sea", biome: "desert", terrain_shape: "dunes",
    weathers: ["clear", "sandstorm"], lightings: ["noon", "golden_hour"], mood: "lonely",
    palette: { primary: "#c77d3a", secondary: "#e8c07d", accent: "#3fa7a0", ground: "#d9b27a", sky: "#f2d6a2", water: "#3b8fa0" },
    scatter_density: 0.6, scatter_mix: { cactus: 0.5, rock_large: 0.6, grass_tuft: 0.4 },
    pickup_lib: "relic",
    keywords: ["desert", "dunes", "dune", "sand", "sahara", "nomad", "caravan", "sandstorm", "arid"],
    tags: ["dry", "bright"],
  }),
  oasis_flats: T("oasis_flats", {
    name: "Oasis Flats", biome: "desert", terrain_shape: "open",
    weathers: ["clear", "cloudy"], lightings: ["golden_hour", "dusk"], mood: "peaceful",
    palette: { primary: "#7a9a4a", secondary: "#d8a86a", accent: "#e04f5f", ground: "#caa477", sky: "#f5c58a", water: "#2aa8b8" },
    scatter_density: 1.1, scatter_mix: { cactus: 1.8, bush: 2.5, grass_tuft: 2.5, dead_tree: 0.3 },
    scatter_add: [["palm_tree", 1.6, 0.9, 1.3, 0.35, { max_slope_deg: 20 }]],
    pickup_lib: "gem",
    keywords: ["oasis", "bazaar", "mirage", "flats", "savanna", "pyramid", "egypt", "camel"],
    tags: ["dry", "warm"],
  }),
  // ------------------------------------------------------------- snow
  frost_peaks: T("frost_peaks", {
    name: "Frost Peaks", biome: "snow", terrain_shape: "valley",
    weathers: ["snow", "clear"], lightings: ["dawn", "overcast"], mood: "harsh",
    palette: { primary: "#5a7d9a", secondary: "#c9d6e0", accent: "#ff6b35", ground: "#e6eef3", sky: "#b8d4ea", water: "#4a7fa6" },
    scatter_density: 1.0, scatter_mix: { pine_tree: 1.3, rock_large: 1.4 },
    pickup_lib: "shard",
    keywords: ["snow", "mountain", "mountains", "peaks", "winter", "alpine", "yeti", "blizzard", "ski", "summit"],
    tags: ["cold", "bright"],
  }),
  glacier_steps: T("glacier_steps", {
    name: "Glacier Steps", biome: "snow", terrain_shape: "terraces",
    weathers: ["fog", "snow"], lightings: ["noon", "night"], mood: "awed",
    palette: { primary: "#6fa8c8", secondary: "#e8f1f6", accent: "#b388eb", ground: "#d7e4ec", sky: "#cfe3f1", water: "#6b9fc0" },
    scatter_density: 0.8, scatter_mix: { pine_tree: 0.3, crystal_cluster: 4, dead_tree: 0.5 }, fog_k: 0.8,
    pickup_lib: "shard",
    keywords: ["glacier", "ice", "icy", "frozen", "tundra", "arctic", "polar", "crevasse", "aurora", "penguin"],
    tags: ["cold", "terraced"],
  }),
  // ------------------------------------------------------------- volcanic
  ember_caldera: T("ember_caldera", {
    name: "Ember Caldera", biome: "volcanic", terrain_shape: "caldera",
    weathers: ["ash", "clear"], lightings: ["dusk", "night"], mood: "ominous",
    palette: { primary: "#7a2e1f", secondary: "#3b2f2f", accent: "#ff5a1f", ground: "#4a3b36", sky: "#d9744a", water: "#ff6a1f" },
    scatter_density: 1.0, scatter_mix: { dead_tree: 1.4, crystal_cluster: 1.5 },
    pickup_lib: "gem",
    keywords: ["volcano", "volcanic", "lava", "caldera", "crater", "magma", "eruption", "ember", "dragon", "fire"],
    tags: ["hot", "dark"],
  }),
  obsidian_mesa: T("obsidian_mesa", {
    name: "Obsidian Mesa", biome: "volcanic", terrain_shape: "plateau",
    weathers: ["ash", "storm"], lightings: ["storm_dark", "dusk"], mood: "grim",
    palette: { primary: "#2b2d42", secondary: "#5c4d5a", accent: "#ff9f1c", ground: "#3a3538", sky: "#8d6a7a", water: "#d2452d" },
    scatter_density: 0.9, scatter_mix: { rock_large: 1.6, cliff_rock: 2, dead_tree: 0.6 },
    pickup_lib: "shard",
    keywords: ["obsidian", "basalt", "scorched", "ash", "forge", "cinder", "hellscape", "brimstone"],
    tags: ["hot", "dark"],
  }),
  // ------------------------------------------------------------- canyon
  red_canyon: T("red_canyon", {
    name: "Red Canyon", biome: "canyon", terrain_shape: "valley",
    weathers: ["clear", "sandstorm"], lightings: ["golden_hour", "noon"], mood: "adventurous",
    palette: { primary: "#b5482c", secondary: "#e0a15e", accent: "#2e86ab", ground: "#b86a45", sky: "#f0b27a", water: "#3a8fb7" },
    scatter_density: 1.0,
    pickup_lib: "gem",
    keywords: ["canyon", "gorge", "western", "cowboy", "gulch", "outlaw", "badlands", "ravine", "wild west"],
    tags: ["dry", "warm"],
  }),
  sandstone_steps: T("sandstone_steps", {
    name: "Sandstone Steps", biome: "canyon", terrain_shape: "terraces",
    weathers: ["clear", "cloudy"], lightings: ["dawn", "golden_hour"], mood: "curious",
    palette: { primary: "#c98b5a", secondary: "#efd3a8", accent: "#6b4fbb", ground: "#c49a6c", sky: "#e8c9a0", water: "#4b9bb5" },
    scatter_density: 1.1, scatter_mix: { cactus: 0.4, bush: 2, cliff_rock: 1.5 },
    pickup_lib: "scroll",
    keywords: ["mesa", "sandstone", "terraces", "ledges", "pueblo", "cliff dwelling", "strata", "quarry", "cliffs"],
    tags: ["dry", "terraced"],
  }),
  // ------------------------------------------------------------- ruins
  sunken_ruins: T("sunken_ruins", {
    name: "Sunken Ruins", biome: "ruins", terrain_shape: "marsh",
    weathers: ["fog", "rain"], lightings: ["overcast", "dusk"], mood: "mysterious",
    palette: { primary: "#4f6f6a", secondary: "#a39b82", accent: "#7fe0d0", ground: "#5d6b4f", sky: "#9fb3b0", water: "#2f6f6a" },
    scatter_density: 1.0, scatter_mix: { broadleaf_tree: 0.6, dead_tree: 1.8, flowers: 0.4 },
    scatter_add: [REEDS], fog_k: 0.75,
    pickup_lib: "relic",
    keywords: ["ruins", "sunken", "flooded", "drowned", "atlantis", "lost city", "ancient", "submerged"],
    tags: ["water", "ancient"],
  }),
  overgrown_temple: T("overgrown_temple", {
    name: "Overgrown Temple", biome: "ruins", terrain_shape: "plateau",
    weathers: ["clear", "rain"], lightings: ["noon", "golden_hour"], mood: "wondrous",
    palette: { primary: "#3f7d3a", secondary: "#b9a27a", accent: "#e8c547", ground: "#58793f", sky: "#a8d8c8", water: "#3c8c7c" },
    scatter_density: 1.3, scatter_mix: { broadleaf_tree: 2, bush: 1.6, flowers: 1.5 },
    scatter_add: [["mushroom", 3, 0.6, 1.2, 0, { max_slope_deg: 32 }]],
    pickup_lib: "scroll",
    keywords: ["jungle", "temple", "overgrown", "aztec", "maya", "mayan", "idol", "vines", "explorer"],
    tags: ["green", "ancient"],
  }),
  // ------------------------------------------------------------- city
  fog_city: T("fog_city", {
    name: "Fog City", biome: "city", terrain_shape: "open",
    weathers: ["fog", "rain"], lightings: ["overcast", "night"], mood: "noir",
    palette: { primary: "#4a4e69", secondary: "#9a8c98", accent: "#f2e94e", ground: "#5a5a5f", sky: "#a3a9b3", water: "#3d5a73" },
    scatter_density: 0.8, scatter_mix: { flowers: 0.3, broadleaf_tree: 0.7 }, fog_k: 0.6,
    pickup_lib: "key",
    keywords: ["city", "streets", "fog", "foggy", "noir", "detective", "victorian", "london", "alley", "urban"],
    tags: ["urban", "dark"],
  }),
  hillside_town: T("hillside_town", {
    name: "Hillside Town", biome: "city", terrain_shape: "terraces",
    weathers: ["clear", "cloudy"], lightings: ["golden_hour", "noon"], mood: "warm",
    palette: { primary: "#c0504d", secondary: "#f2e1c1", accent: "#2e6fd8", ground: "#8aa05a", sky: "#9fd0f0", water: "#3e8ec4" },
    scatter_density: 1.2, scatter_mix: { flowers: 2, bush: 1.4 },
    pickup_lib: "key",
    keywords: ["town", "hillside", "village", "terraced", "mediterranean", "vineyard", "italian", "market", "cozy"],
    tags: ["urban", "bright", "terraced"],
  }),
  // ------------------------------------------------------------- scifi_base
  orbital_base: T("orbital_base", {
    name: "Orbital Base", biome: "scifi_base", terrain_shape: "open",
    weathers: ["clear", "cloudy"], lightings: ["neon_night", "night"], mood: "sleek",
    palette: { primary: "#3a4a6b", secondary: "#b8c4d6", accent: "#00e5ff", ground: "#6b7280", sky: "#1b2440", water: "#3355aa" },
    scatter_density: 0.8, scatter_mix: { bush: 0.2, dead_tree: 0.2 },
    pickup_lib: "shard",
    keywords: ["space", "base", "station", "scifi", "sci fi", "futuristic", "robot", "alien", "planet", "colony", "moon", "orbital"],
    tags: ["tech", "dark"],
  }),
  crystal_hollow: T("crystal_hollow", {
    name: "Crystal Hollow", biome: "scifi_base", terrain_shape: "caldera",
    weathers: ["fog", "clear"], lightings: ["neon_night", "dusk"], mood: "dreamlike",
    palette: { primary: "#6a4c93", secondary: "#c3b1e1", accent: "#4df0c8", ground: "#4b4460", sky: "#7e6aa8", water: "#5b4fbf" },
    scatter_density: 1.1, scatter_mix: { crystal_cluster: 4, rock_small: 0.8, dead_tree: 0 }, fog_k: 0.8,
    pickup_lib: "gem",
    keywords: ["crystal", "crystals", "hollow", "cavern", "glowing", "geode", "mine", "gems", "underground"],
    tags: ["tech", "glow"],
  }),
});

// ------------------------------------------------------------------ concept

export function themeConceptPatch(concept, ctx) {
  const t = ctx.theme;
  const r = ctx.rand("theme");
  const out = { ...concept, biome: t.biome, weather: r.pick(t.weathers), mood: t.mood || concept.mood };
  if (t.terrain_shape) out.terrain_shape = t.terrain_shape; // optional concept field read by the world stage
  if (t.palette) out.palette = { ...concept.palette, ...t.palette };
  return out;
}

// -------------------------------------------------------------------- world

const PICKUP_LIBS = ["lantern_core", "relic", "gem", "key", "scroll", "herb", "shard"];

/** Theme pass over the finished world: pickup item, fog distance, scatter density. Never throws. */
export function themeWorldPatch(world, ctx) {
  const t = ctx?.theme;
  if (!t || !world) return world;
  try {
    let w = patchPickups(world, t);
    w = patchFog(w, t);
    return patchScatter(w, t, ctx);
  } catch (e) {
    ctx.notes?.push?.(`themes: world patch skipped (${e.message})`);
    return world;
  }
}

function patchPickups(world, t) {
  if (!PICKUP_LIBS.includes(t.pickup_lib)) return world;
  const ref = `lib:${t.pickup_lib}`, name = t.pickup_lib.replace(/_/g, " ");
  const ids = new Set();
  const placements = world.placements.map((p) => {
    if (p.role !== "pickup" || p.asset_ref === ref) return p;
    ids.add(p.id);
    return { ...p, asset_ref: ref };
  });
  if (!ids.size) return world;
  const interactables = world.interactables.map((ix) => (ix.kind === "pickup" && ids.has(ix.placement_ref) ? { ...ix, prompt: `Pick up the ${name}` } : ix));
  return { ...world, placements, interactables };
}

function patchFog(world, t) {
  const fog = world.environment?.fog;
  if (!fog || !Number.isFinite(t.fog_k) || t.fog_k === 1) return world;
  const k = clamp(t.fog_k, 0.3, 1.5);
  const near = Math.round(fog.near * k);
  return { ...world, environment: { ...world.environment, fog: { ...fog, near, far: Math.max(near + 20, Math.round(fog.far * k)) } } };
}

/** Scatter rows scaled for a theme. With `solidCap`, rows with colliders never grow past the base world's count. */
function scaledScatter(world, t, budget, solidCap) {
  const d = Number.isFinite(t.scatter_density) ? clamp(t.scatter_density, 0, 3) : 1;
  const mix = t.scatter_mix || {};
  const area = world.size.w * world.size.h;
  const water = world.environment?.water;
  const wl = water?.enabled ? water.level : 0;
  const rows = world.scatter.map((s) => {
    const lib = s.asset_ref.replace(/^lib:/, "");
    const m = Number.isFinite(mix[lib]) ? mix[lib] : 1;
    let count = Math.min(900, Math.round(s.count * d * m));
    if (solidCap && s.collider_radius > 0) count = Math.min(count, s.count);
    return { ...s, count };
  });
  for (const [lib, dens, mn, mx, cr, extra] of t.scatter_add || []) {
    const id = `sc_${lib}`;
    if (rows.some((s) => s.id === id) || (solidCap && cr > 0)) continue;
    const ex = { ...(extra || {}) };
    if (ex.zone === "shore" && !water?.enabled) continue;
    for (const k of ["min_h", "max_h"]) if (Number.isFinite(ex[k])) ex[k] = ex[k] + wl;
    const count = Math.min(900, Math.round((dens * d * area) / 10000));
    if (!count) continue;
    rows.push({
      id, asset_ref: `lib:${lib}`, region: null, count, min_scale: mn, max_scale: mx,
      seed: hashString(`scatter|${world.seed}|${lib}`), avoid_paths: true, collider_radius: cr,
      ...Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, typeof v === "number" ? round2(v) : v])),
    });
  }
  // Budget: the sum of counts is an upper bound on the expanded instances.
  const total = rows.reduce((a, s) => a + s.count, 0);
  if (total > budget) {
    const f = budget / total;
    for (const s of rows) s.count = Math.floor(s.count * f);
  }
  return rows.filter((s) => s.count > 0);
}

const sameScatter = (a, b) => a.length === b.length && a.every((s, i) => s.id === b[i].id && s.count === b[i].count);
const solidSig = (rows) => rows.filter((s) => s.collider_radius > 0).map((s) => `${s.id}:${s.count}`).join(",");

/** Apply new scatter rows, re-baking navigation when solid scatter changed. Null if anything became unreachable. */
function withScatter(world, rows) {
  const w = { ...world, scatter: rows };
  if (solidSig(rows) === solidSig(world.scatter)) return w; // colliders unchanged, so is the nav
  const colliders = buildColliders(w, null, expandScatter(w));
  w.navigation = bakeNavigation(w, colliders);
  if (!isConnected(w)) return null;
  const nav = w.navigation;
  const sp = w.spawn_points.find((s) => s.id === "spawn_player");
  const reach = reachableSet(nav, sp.position);
  for (const s of w.spawn_points) {
    const idx = navIndex(nav, s.position.x, s.position.z);
    if (idx < 0 || !reach.has(idx) || pointInCollider(colliders, s.position.x, s.position.z, 0.5)) return null;
  }
  for (const p of w.placements) {
    if (p.role !== "pickup") continue;
    const idx = navIndex(nav, p.position.x, p.position.z);
    if (idx < 0 || !reach.has(idx)) return null;
  }
  return w;
}

function patchScatter(world, t, ctx) {
  if (!Array.isArray(world.scatter) || !world.size) return world;
  const scale = ASSET_BUDGET[ctx.scale] ? ctx.scale : "medium";
  const budget = Math.floor(ASSET_BUDGET[scale].scatter_instances * 0.9);
  const full = scaledScatter(world, t, budget, false);
  if (sameScatter(full, world.scatter)) return world;
  const a = withScatter(world, full);
  if (a) return a;
  // Denser solid scatter blocked a spawn or objective: keep solid rows no
  // denser than the base world (removing colliders only frees cells).
  ctx.notes?.push?.(`themes: ${t.id} solid scatter capped to keep objectives reachable`);
  return withScatter(world, scaledScatter(world, t, budget, true)) || world;
}
