// Games-D theme presets (STUB — owned by the world/terrain agent). ISOMORPHIC data + pure patches.
import { seeded } from "../../gamesb/common/rng.mjs";

export const THEMES = Object.freeze({
  storm_isle: { id: "storm_isle", name: "Storm Isle", biome: "island", weathers: ["storm", "rain"], lightings: ["dusk"], palette: null, mood: "tense", keywords: ["island", "storm", "lighthouse", "sea"], tags: ["water"] },
  pine_valley: { id: "pine_valley", name: "Pine Valley", biome: "forest", weathers: ["clear", "fog"], lightings: ["noon"], palette: null, mood: "serene", keywords: ["forest", "woods", "pine"], tags: [] },
});

export function themeConceptPatch(concept, ctx) {
  const t = ctx.theme;
  const r = ctx.rand("theme");
  return { ...concept, biome: t.biome, weather: r.pick(t.weathers), mood: t.mood || concept.mood, ...(t.palette ? { palette: { ...concept.palette, ...t.palette } } : {}) };
}

export function themeWorldPatch(world, ctx) { return world; }
