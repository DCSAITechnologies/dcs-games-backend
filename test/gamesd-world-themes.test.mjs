// Games-D world themes and terrain shapes: every theme builds a playable,
// deterministic game on its own biome and shape, and the themes look distinct.
import test from "node:test";
import assert from "node:assert/strict";

import { THEMES } from "../src/gamesd/world/themes.mjs";
import { buildFromRecipe } from "../src/gamesd/engine.mjs";
import { recipeFromPrompt } from "../src/gamesd/recipe.mjs";
import { TEMPLATES } from "../src/gamesd/gameplay/templates.mjs";
import { LAYOUTS } from "../src/gamesd/missions/layouts.mjs";
import { ASSET_BUDGET } from "../src/gamesd/budgets.mjs";
import { generateBaseTerrain, SHAPE_BY_BIOME, TERRAIN_SHAPES, WATER_SHAPES } from "../src/gamesb/world/terrain.mjs";
import { SHAPES } from "../src/gamesb/world/world-spec.schema.mjs";
import { PICKUP_LIBS } from "../src/gamesb/world/world-spec.mjs";
import { expandScatter } from "../src/gamesb/world/terrain-sample.mjs";
import { BIOMES, WEATHERS, PALETTE_KEYS } from "../src/gamesb/concept/concept.schema.mjs";

const LIGHTING_IDS = ["dawn", "noon", "golden_hour", "dusk", "night", "overcast", "storm_dark", "neon_night"];
const NEW_SHAPES = ["archipelago", "caldera", "terraces", "dunes", "marsh"];
const TEMPLATE = TEMPLATES.classic_chain ? "classic_chain" : Object.keys(TEMPLATES)[0];
const LAYOUT = LAYOUTS.classic ? "classic" : Object.keys(LAYOUTS)[0];
const SEEDS = [1, 7];
const ids = Object.keys(THEMES);

test("theme catalogue: at least 12 complete themes covering all 9 biomes", () => {
  assert.ok(ids.length >= 12, `have ${ids.length}`);
  assert.deepEqual([...new Set(ids.map((id) => THEMES[id].biome))].sort(), [...BIOMES].sort());
  const perBiome = {};
  for (const id of ids) {
    const t = THEMES[id];
    assert.equal(t.id, id);
    assert.ok(t.name && typeof t.name === "string", `${id}.name`);
    assert.ok(BIOMES.includes(t.biome), `${id}.biome`);
    assert.ok(TERRAIN_SHAPES.includes(t.terrain_shape), `${id}.terrain_shape`);
    assert.ok(t.weathers.length && t.weathers.every((w) => WEATHERS.includes(w)), `${id}.weathers`);
    assert.ok(t.lightings.length && t.lightings.every((l) => LIGHTING_IDS.includes(l)), `${id}.lightings`);
    for (const k of PALETTE_KEYS) assert.match(t.palette[k], /^#[0-9a-f]{6}$/i, `${id}.palette.${k}`);
    assert.ok(typeof t.mood === "string" && t.mood, `${id}.mood`);
    assert.ok(t.scatter_density > 0 && t.scatter_density <= 3, `${id}.scatter_density`);
    assert.ok(PICKUP_LIBS.includes(t.pickup_lib), `${id}.pickup_lib`);
    assert.equal(t.material_style, id);
    assert.equal(t.audio, id);
    assert.ok(Array.isArray(t.keywords) && t.keywords.length >= 5, `${id}.keywords`);
    assert.ok(Array.isArray(t.tags), `${id}.tags`);
    (perBiome[t.biome] ||= []).push(t);
  }
  // Biomes with two themes differ in shape or palette mood, not just name.
  for (const [b, ts] of Object.entries(perBiome)) {
    if (ts.length < 2) continue;
    assert.ok(new Set(ts.map((t) => t.terrain_shape)).size > 1 || new Set(ts.map((t) => t.weathers.join())).size > 1, `${b} variants look alike`);
  }
  // Every new shape is used by at least one theme.
  for (const s of NEW_SHAPES) assert.ok(ids.some((id) => THEMES[id].terrain_shape === s), `no theme uses ${s}`);
});

test("themes are visually distinct: no shared palette, sky or ground colour", () => {
  const pal = ids.map((id) => PALETTE_KEYS.map((k) => THEMES[id].palette[k].toLowerCase()).join());
  assert.equal(new Set(pal).size, ids.length);
  assert.equal(new Set(ids.map((id) => THEMES[id].palette.sky.toLowerCase())).size, ids.length);
  assert.equal(new Set(ids.map((id) => THEMES[id].palette.ground.toLowerCase())).size, ids.length);
});

test("each theme's first keyword maps back to it through recipeFromPrompt", () => {
  for (const id of ids) {
    const r = recipeFromPrompt(THEMES[id].keywords[0], { seed: 3 });
    assert.equal(r.theme, id, `'${THEMES[id].keywords[0]}' → ${r.theme}`);
  }
});

test("terrain: schema knows every shape; default shapes are unchanged by the shape argument", () => {
  assert.deepEqual([...TERRAIN_SHAPES].sort(), [...SHAPES].sort());
  for (const s of WATER_SHAPES) assert.ok(TERRAIN_SHAPES.includes(s));
  for (const [biome, shape] of Object.entries(SHAPE_BY_BIOME)) {
    const size = { w: 240, h: 240 };
    const a = generateBaseTerrain({ size, biome, seed: 42 });
    const b = generateBaseTerrain({ size, biome, seed: 42, shape });
    const c = generateBaseTerrain({ size, biome, seed: 42, shape: "not_a_shape" });
    assert.equal(a.shape, shape);
    assert.deepEqual(Array.from(b.heights), Array.from(a.heights));
    assert.deepEqual(Array.from(c.heights), Array.from(a.heights));
  }
});

/** Normalised 12-bin height histogram plus relief, for comparing shapes. */
function signature(heights) {
  let lo = Infinity, hi = -Infinity;
  for (const v of heights) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const bins = new Array(12).fill(0);
  for (const v of heights) bins[Math.min(11, Math.floor(((v - lo) / (hi - lo || 1)) * 12))]++;
  return { bins: bins.map((b) => b / heights.length), relief: hi - lo, lo };
}
const l1 = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);

test("terrain: every shape has its own height histogram", () => {
  const size = { w: 240, h: 240 };
  const sig = Object.fromEntries(TERRAIN_SHAPES.map((shape) => [shape, signature(generateBaseTerrain({ size, biome: "forest", seed: 5, shape }).heights)]));
  for (let i = 0; i < TERRAIN_SHAPES.length; i++) for (let j = i + 1; j < TERRAIN_SHAPES.length; j++) {
    const a = sig[TERRAIN_SHAPES[i]], b = sig[TERRAIN_SHAPES[j]];
    const d = l1(a.bins, b.bins) + Math.abs(a.relief - b.relief) / Math.max(a.relief, b.relief);
    assert.ok(d > 0.15, `${TERRAIN_SHAPES[i]} vs ${TERRAIN_SHAPES[j]}: ${d.toFixed(3)}`);
  }
  // Water shapes dip below the water line; the dry ones do not rely on it.
  for (const s of ["island", "archipelago", "marsh"]) assert.ok(sig[s].lo < 0, `${s} has no water`);
});

test("terrain: new shapes are deterministic in the seed and vary between seeds", () => {
  const size = { w: 240, h: 240 };
  for (const shape of NEW_SHAPES) {
    const a = generateBaseTerrain({ size, biome: "desert", seed: 11, shape });
    const b = generateBaseTerrain({ size, biome: "desert", seed: 11, shape });
    const c = generateBaseTerrain({ size, biome: "desert", seed: 12, shape });
    assert.equal(a.shape, shape);
    assert.deepEqual(Array.from(a.heights), Array.from(b.heights));
    assert.ok(a.heights.some((v, i) => v !== c.heights[i]), `${shape} ignores the seed`);
  }
});

const built = {};
for (const id of ids) {
  for (const seed of SEEDS) {
    test(`build ${id} seed ${seed}: playable on its biome and shape`, async () => {
      const recipe = { seed, theme: id, template: TEMPLATE, layout: LAYOUT, difficulty: "normal" };
      const r = await buildFromRecipe(recipe);
      const why = JSON.stringify({ validation: r.validation?.ok, won: r.playtest?.won, reach: r.reachability?.ok });
      assert.equal(r.validation.ok, true, why);
      assert.equal(r.playtest.won, true, why);
      assert.equal(r.reachability.ok, true, why);
      assert.equal(r.ok, true, why);
      const t = THEMES[id], w = r.pkg.world;
      assert.equal(w.biome, t.biome);
      assert.equal(r.pkg.concept.terrain_shape, t.terrain_shape);
      assert.equal(w.terrain.shape, t.terrain_shape);
      assert.equal(w.environment.water.enabled, WATER_SHAPES.includes(t.terrain_shape) || w.regions.some((g) => g.kind === "transit"));
      for (const k of PALETTE_KEYS) assert.equal(r.pkg.concept.palette[k], t.palette[k]);
      assert.ok(t.weathers.includes(r.pkg.concept.weather));
      const scale = ASSET_BUDGET[r.pkg.concept.scale] ? r.pkg.concept.scale : "medium";
      const n = expandScatter(w).length;
      assert.ok(n > 0 && n <= ASSET_BUDGET[scale].scatter_instances, `scatter ${n}`);
      assert.ok(w.placements.filter((p) => p.role === "pickup").every((p) => p.asset_ref === `lib:${t.pickup_lib}`));
      built[`${id}|${seed}`] = r.pkg.integrity.sha256;
      if (seed === SEEDS[0]) {
        const again = await buildFromRecipe(recipe);
        assert.equal(again.pkg.integrity.sha256, r.pkg.integrity.sha256, "rebuild is not byte-identical");
      }
    });
  }
}

test("different themes and seeds give different packages", () => {
  const hashes = Object.values(built);
  assert.equal(hashes.length, ids.length * SEEDS.length);
  assert.equal(new Set(hashes).size, hashes.length);
});
