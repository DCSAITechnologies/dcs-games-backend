// Games-B world: GameConcept → WorldSpec (contract §2, ids per §4.5).
//
// Synchronous and deterministic: the same concept and seed give byte-identical
// JSON. The stages run in dependency order, because each one needs the facts
// the previous one fixed:
//
//   1. base heightfield by biome shape          (terrain.mjs)
//   2. region layout on suitable ground          (greedy + seeded relaxation)
//   3. pads flattened, paths routed (MST + terrain-aware A*) and carved
//   4. location compositions from lib: pieces, each with a collider
//   5. scatter entries by biome                  (expanded by terrain-sample.mjs)
//   6. navigation baked from slope, water and every solid collider
//   7. spawns, checkpoints and pickups chosen from cells REACHABLE from the
//      player spawn, so reachability is constructed rather than hoped for
//   8. focal / pickup / talk interactables with the §4.5 ids

import { seeded, hashString, clamp, round2 } from "../common/rng.mjs";
import { generateBaseTerrain, flattenPad, corridorProfile, carveCorridors, relaxPathSeams, sampleGrid, slopeGrid } from "./terrain.mjs";
import { sampleHeight, slopeAt, expandScatter, footprintRadius, distToPolyline } from "./terrain-sample.mjs";
import { buildColliders, containsXZ, pointInCollider } from "./collision.mjs";
import { reachableSet, nearestWalkable, cellCenter } from "./nav-grid.mjs";

export const WORLD_SPEC_VERSION = "1.0.0";
export const SIZE_BY_SCALE = { small: 160, medium: 240, large: 320 };
export const MAX_SLOPE_DEG = 38;
export const STEP_HEIGHT = 0.45;
export const PLAYER_RADIUS = 0.45;

// ------------------------------------------------------------------ library

const box = (x, y, z, solid = true) => ({ shape: "box", size: { x, y, z }, solid });
const cyl = (radius, height, solid = true) => ({ shape: "cylinder", radius, height, solid });
const NONE = { shape: "none", solid: false };

/** Collider and default role for every lib: name the world stage uses. */
export const LIB = {
  lighthouse: { role: "landmark", col: cyl(3, 16) }, watchtower: { role: "landmark", col: box(4, 10, 4) },
  stone_hut: { role: "structure", col: box(5, 3.5, 5) }, cottage: { role: "structure", col: box(6, 5, 5) },
  ruin_arch: { role: "structure", col: box(5, 5, 1.2) }, ruin_wall: { role: "structure", col: box(6, 3, 1) },
  ruin_pillar: { role: "structure", col: cyl(0.7, 4) }, shrine: { role: "landmark", col: box(3, 3.2, 3) },
  dock: { role: "structure", col: box(4, 0.6, 12, false) }, bridge: { role: "structure", col: NONE },
  well: { role: "prop", col: cyl(1.2, 1.2) }, tent: { role: "structure", col: box(3, 2.4, 3) },
  campfire: { role: "decor", col: cyl(0.8, 0.5, false) }, lantern_post: { role: "prop", col: cyl(0.25, 3) },
  altar: { role: "landmark", col: box(2, 1.1, 1.2) }, beacon_brazier: { role: "landmark", col: cyl(1, 1.6) },
  gate: { role: "structure", col: box(4, 4, 0.8) }, statue: { role: "landmark", col: cyl(0.9, 3.5) },
  obelisk: { role: "landmark", col: box(1.2, 6, 1.2) },
  crate: { role: "prop", col: box(1, 1, 1) }, barrel: { role: "prop", col: cyl(0.45, 1) },
  chest: { role: "prop", col: box(1, 0.8, 0.7) }, signpost: { role: "prop", col: cyl(0.15, 2.2) },
  fence: { role: "decor", col: box(4, 1.1, 0.2) }, boat: { role: "decor", col: box(2, 1, 5, false) },
  cart: { role: "prop", col: box(1.6, 1.4, 3) },
  pine_tree: { role: "foliage", col: cyl(0.45, 8) }, broadleaf_tree: { role: "foliage", col: cyl(0.5, 7) },
  palm_tree: { role: "foliage", col: cyl(0.35, 7) }, dead_tree: { role: "foliage", col: cyl(0.35, 5) },
  bush: { role: "foliage", col: NONE }, grass_tuft: { role: "foliage", col: NONE },
  rock_small: { role: "decor", col: NONE }, rock_large: { role: "decor", col: cyl(1.3, 1.8) },
  cliff_rock: { role: "decor", col: box(4, 6, 3) }, cactus: { role: "foliage", col: cyl(0.35, 3) },
  crystal_cluster: { role: "decor", col: cyl(0.8, 1.6) }, mushroom: { role: "foliage", col: NONE },
  flowers: { role: "foliage", col: NONE }, reeds: { role: "foliage", col: NONE },
};
export const PICKUP_LIBS = ["lantern_core", "relic", "gem", "key", "scroll", "herb", "shard"];

/** Focal interactable kind for each location kind (§4.5). */
export const FOCAL_KIND = {
  shrine: "altar", tower: "lantern", summit: "lantern", ruin: "container", dock: "sign", camp: "sign",
  cave: "container", grove: "altar", village: "door", hub: "sign", landmark: "lever",
};
const PROMPT = {
  altar: "Touch the altar", lantern: "Light the lantern", container: "Open the chest", sign: "Read the sign",
  door: "Knock on the door", lever: "Pull the lever",
};
const REGION_KIND = {
  hub: "district", village: "district", camp: "wilderness", grove: "wilderness", dock: "transit",
  cave: "landmark", ruin: "landmark", shrine: "landmark", tower: "landmark", summit: "landmark", landmark: "landmark",
};

const HOUSES = {
  island: ["cottage", "stone_hut"], forest: ["cottage", "stone_hut"], snow: ["cottage", "stone_hut"],
  ruins: ["stone_hut", "cottage"], city: ["cottage", "cottage"], desert: ["stone_hut", "stone_hut"],
  canyon: ["stone_hut", "tent"], volcanic: ["stone_hut", "stone_hut"], scifi_base: ["stone_hut", "stone_hut"],
};
const TREE = {
  island: "palm_tree", forest: "broadleaf_tree", snow: "pine_tree", desert: "cactus", canyon: "dead_tree",
  volcanic: "dead_tree", ruins: "broadleaf_tree", city: "broadleaf_tree", scifi_base: "crystal_cluster",
};

/**
 * Pieces per location kind: [lib, { focal?, ring: [rmin, rmax], n? }].
 * ring is the distance band from the region centre; the centre itself is kept
 * clear so it stays walkable.
 */
function composition(kind, biome, hasWater) {
  const [h1, h2] = HOUSES[biome] || HOUSES.island;
  const tree = TREE[biome] || "broadleaf_tree";
  switch (kind) {
    case "hub": return [
      ["signpost", { focal: true, ring: [4, 6] }], [h1, { ring: [9, 15] }], [h2, { ring: [9, 15] }],
      ["well", { ring: [5, 7] }], ["lantern_post", { ring: [5, 9], n: 2 }], ["fence", { ring: [11, 16], n: 2 }],
      ["crate", { ring: [6, 11] }], ["barrel", { ring: [6, 11] }]];
    case "village": return [
      [h1, { focal: true, ring: [8, 12] }], [h2, { ring: [8, 13] }], [h1, { ring: [9, 13] }],
      ["well", { ring: [4.5, 6] }], ["gate", { ring: [10, 13] }], ["lantern_post", { ring: [5, 8] }], ["cart", { ring: [6, 11] }]];
    case "tower": return [
      [hasWater ? "lighthouse" : "watchtower", { ring: [7, 11] }], ["lantern_post", { focal: true, ring: [4, 6] }],
      ["rock_large", { ring: [9, 13], n: 2 }], ["crate", { ring: [5, 9] }]];
    case "summit": return [
      ["beacon_brazier", { focal: true, ring: [4, 6] }], ["watchtower", { ring: [8, 11] }],
      ["lantern_post", { ring: [5, 8] }], ["rock_large", { ring: [8, 13], n: 3 }]];
    case "ruin": return [
      ["chest", { focal: true, ring: [4, 6] }], ["ruin_arch", { ring: [6, 10] }], ["ruin_wall", { ring: [8, 12], n: 2 }],
      ["ruin_pillar", { ring: [5, 12], n: 4 }], ["rock_small", { ring: [6, 12], n: 2 }]];
    case "shrine": return [
      ["altar", { focal: true, ring: [4, 5.5] }], ["shrine", { ring: [6.5, 9] }], [biome === "ruins" ? "statue" : "obelisk", { ring: [7, 10] }],
      ["lantern_post", { ring: [5, 8], n: 2 }], ["flowers", { ring: [4, 9], n: 2 }]];
    case "dock": return [
      ["signpost", { focal: true, ring: [4, 6] }], ["dock", { dock: true }], ["boat", { boat: true }],
      ["crate", { ring: [5, 10], n: 2 }], ["barrel", { ring: [5, 10] }]];
    case "camp": return [
      ["signpost", { focal: true, ring: [4.5, 6] }], ["campfire", { ring: [4.5, 6] }], ["tent", { ring: [7, 11], n: 2 }],
      ["crate", { ring: [6, 10] }], ["barrel", { ring: [6, 10] }]];
    case "cave": return [
      ["chest", { focal: true, ring: [5, 7] }], ["cliff_rock", { ring: [9, 13], n: 4, arc: true }], ["rock_large", { ring: [8, 12] }]];
    case "grove": return [
      ["altar", { focal: true, ring: [4, 6] }], [tree === "cactus" ? "dead_tree" : tree, { ring: [9, 12.5], n: 7 }],
      ["flowers", { ring: [4, 9], n: 3 }], ["mushroom", { ring: [5, 9], n: 2 }]];
    case "landmark": default: return [
      ["obelisk", { focal: true, ring: [4, 6] }], ["statue", { ring: [6, 9] }], ["rock_large", { ring: [8, 12], n: 2 }],
      ["lantern_post", { ring: [5, 8] }]];
  }
}

/** Scatter table by biome: [lib, density per 10 000 m², minScale, maxScale, colliderR, extra]. */
function scatterTable(biome, wl) {
  const land = { max_slope_deg: 32 };
  switch (biome) {
    case "island": return [
      ["palm_tree", 5, 0.9, 1.3, 0.35, { max_h: wl + 5, max_slope_deg: 24 }],
      ["broadleaf_tree", 3, 0.8, 1.2, 0.5, { min_h: wl + 3, max_h: wl + 12 }],
      ["pine_tree", 3, 0.8, 1.25, 0.45, { min_h: wl + 7 }],
      ["bush", 10, 0.7, 1.3, 0, land], ["grass_tuft", 26, 0.7, 1.3, 0, { min_h: wl + 1.2, max_slope_deg: 30 }],
      ["rock_small", 6, 0.6, 1.4, 0, { max_slope_deg: 45 }], ["rock_large", 1.2, 0.8, 1.3, 1.3, { max_slope_deg: 40 }],
      ["reeds", 6, 0.8, 1.2, 0, { zone: "shore", min_h: wl - 0.3, max_h: wl + 0.9, max_slope_deg: 20 }],
      ["flowers", 7, 0.7, 1.2, 0, { min_h: wl + 1.5, max_slope_deg: 22 }]];
    case "forest": return [
      ["pine_tree", 7, 0.8, 1.3, 0.45, land], ["broadleaf_tree", 8, 0.8, 1.3, 0.5, land], ["dead_tree", 0.8, 0.8, 1.1, 0.35, land],
      ["bush", 12, 0.7, 1.3, 0, land], ["grass_tuft", 24, 0.7, 1.3, 0, land], ["mushroom", 5, 0.6, 1.2, 0, land],
      ["rock_small", 5, 0.6, 1.4, 0, { max_slope_deg: 45 }], ["rock_large", 1.2, 0.8, 1.3, 1.3, { max_slope_deg: 40 }], ["flowers", 5, 0.7, 1.2, 0, land]];
    case "desert": return [
      ["cactus", 4, 0.8, 1.3, 0.35, land], ["dead_tree", 0.8, 0.8, 1.1, 0.35, land], ["bush", 3, 0.6, 1.1, 0, land],
      ["grass_tuft", 4, 0.6, 1.1, 0, land], ["rock_small", 7, 0.6, 1.5, 0, { max_slope_deg: 45 }], ["rock_large", 1.8, 0.8, 1.4, 1.3, { max_slope_deg: 40 }]];
    case "snow": return [
      ["pine_tree", 8, 0.8, 1.3, 0.45, land], ["dead_tree", 1.5, 0.8, 1.1, 0.35, land], ["bush", 3, 0.6, 1.1, 0, land],
      ["rock_small", 6, 0.6, 1.4, 0, { max_slope_deg: 45 }], ["rock_large", 1.8, 0.8, 1.4, 1.3, { max_slope_deg: 40 }], ["crystal_cluster", 0.6, 0.6, 1.1, 0.8, land]];
    case "volcanic": return [
      ["dead_tree", 2.5, 0.8, 1.2, 0.35, land], ["rock_small", 9, 0.6, 1.5, 0, { max_slope_deg: 45 }],
      ["rock_large", 2.5, 0.8, 1.4, 1.3, { max_slope_deg: 40 }], ["crystal_cluster", 1.2, 0.6, 1.2, 0.8, land], ["cliff_rock", 0.4, 0.8, 1.1, 2, { max_slope_deg: 40 }]];
    case "canyon": return [
      ["cactus", 2.5, 0.8, 1.3, 0.35, land], ["dead_tree", 1.2, 0.8, 1.1, 0.35, land], ["bush", 4, 0.6, 1.1, 0, land],
      ["rock_small", 8, 0.6, 1.5, 0, { max_slope_deg: 45 }], ["rock_large", 2.2, 0.8, 1.4, 1.3, { max_slope_deg: 40 }], ["cliff_rock", 0.5, 0.8, 1.1, 2, { max_slope_deg: 40 }]];
    case "ruins": return [
      ["broadleaf_tree", 4, 0.8, 1.3, 0.5, land], ["dead_tree", 1.5, 0.8, 1.1, 0.35, land], ["bush", 10, 0.7, 1.3, 0, land],
      ["grass_tuft", 20, 0.7, 1.3, 0, land], ["rock_small", 6, 0.6, 1.4, 0, { max_slope_deg: 45 }], ["flowers", 5, 0.7, 1.2, 0, land]];
    case "city": return [
      ["broadleaf_tree", 3, 0.9, 1.2, 0.5, land], ["bush", 6, 0.7, 1.2, 0, land], ["flowers", 6, 0.7, 1.2, 0, land],
      ["grass_tuft", 8, 0.7, 1.2, 0, land], ["rock_small", 2, 0.6, 1.2, 0, land]];
    case "scifi_base": default: return [
      ["crystal_cluster", 2.5, 0.7, 1.4, 0.8, land], ["rock_small", 7, 0.6, 1.4, 0, { max_slope_deg: 45 }],
      ["rock_large", 1.5, 0.8, 1.3, 1.3, { max_slope_deg: 40 }], ["bush", 2, 0.6, 1.0, 0, land], ["dead_tree", 0.6, 0.8, 1.1, 0.35, land]];
  }
}

function materialLayers(biome, wl, minY, maxY) {
  const lo = round2(Math.floor(minY) - 1), hi = round2(Math.ceil(maxY) + 1);
  const L = (m, a, b, s) => ({ material_ref: `mat:${m}`, min_h: round2(a), max_h: round2(b), max_slope_deg: s });
  switch (biome) {
    case "island": return [L("sand", lo, wl + 1.6, 30), L("grass", wl + 1.6, hi, 30), L("rock", lo, hi, 90)];
    case "forest": return [L("grass", lo, hi, 30), L("dirt", lo, hi, 40), L("rock", lo, hi, 90)];
    case "desert": return [L("sand", lo, hi, 28), L("rock", lo, hi, 90)];
    case "snow": return [L("snow", lo, hi, 34), L("rock", lo, hi, 90)];
    case "volcanic": return [L("dirt", lo, hi, 24), L("rock", lo, hi, 90)];
    case "canyon": return [L("dirt", lo, hi, 22), L("rock", lo, hi, 90)];
    case "ruins": return [L("grass", lo, hi, 26), L("dirt", lo, hi, 36), L("rock", lo, hi, 90)];
    case "city": return [L("stone", lo, hi, 18), L("grass", lo, hi, 32), L("rock", lo, hi, 90)];
    case "scifi_base": default: return [L("stone", lo, hi, 18), L("dirt", lo, hi, 32), L("rock", lo, hi, 90)];
  }
}

// ------------------------------------------------------------- environment

const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(String(h).slice(k, k + 2), 16) || 0);
const rgbHex = (c) => "#" + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, k) => v + (y[k] - v) * t)); };
const shade = (a, k) => rgbHex(hexRgb(a).map((v) => v * k));
const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

const WEATHER_LIGHT = { clear: 1, cloudy: 0.72, rain: 0.5, storm: 0.35, snow: 0.6, fog: 0.55, sandstorm: 0.5, ash: 0.45 };
const WEATHER_FOG = { clear: 1.6, cloudy: 1.2, rain: 0.75, storm: 0.55, snow: 0.6, fog: 0.3, sandstorm: 0.32, ash: 0.45 };
const WEATHER_TINT = { cloudy: ["#9aa3ad", 0.35], rain: ["#7d8791", 0.5], storm: ["#4d5560", 0.65], snow: ["#d9e2ea", 0.45],
  fog: ["#c9cfd4", 0.6], sandstorm: ["#c9a46b", 0.6], ash: ["#6e625a", 0.6] };
const DEFAULT_PALETTE = { primary: "#3f7f5a", secondary: "#c9a66b", accent: "#ffcc55", ground: "#6f8f4e", sky: "#8cc4ec", water: "#2f7fa6" };

/** Sky, fog, sun and ambient from the concept's time of day, weather and palette. */
export function buildEnvironment(concept, edge, water) {
  const pal = { ...DEFAULT_PALETTE };
  for (const k of Object.keys(pal)) if (isHex(concept.palette?.[k])) pal[k] = concept.palette[k];
  const t = Number.isFinite(concept.time_of_day) ? clamp(concept.time_of_day, 0, 1) : 0.45;
  const weather = WEATHER_LIGHT[concept.weather] !== undefined ? concept.weather : "clear";
  const day = t >= 0.22 && t <= 0.78;
  let elevation, azimuth, sunColor, intensity;
  if (day) {
    const p = (t - 0.22) / 0.56;
    elevation = Math.max(4, 72 * Math.sin(Math.PI * p));
    azimuth = 90 + 180 * p; // rises east, sets west
    sunColor = mix("#ff9a5c", "#fff3de", smooth01(elevation / 35));
    intensity = (0.55 + 0.85 * smooth01(elevation / 40)) * WEATHER_LIGHT[weather];
  } else {
    const p = ((t + 0.5) % 1 - 0.22) / 0.56;
    elevation = 38; azimuth = 90 + 180 * clamp(p, 0, 1);
    sunColor = "#9db4ff"; intensity = 0.3 * Math.max(0.5, WEATHER_LIGHT[weather]);
  }
  const dayK = day ? smooth01(elevation / 25) : 0;
  let top = shade(pal.sky, 0.72), horizon = mix(pal.sky, "#ffffff", 0.35);
  const tint = WEATHER_TINT[weather];
  if (tint) { top = mix(top, tint[0], tint[1]); horizon = mix(horizon, tint[0], tint[1]); }
  if (day && elevation < 20) horizon = mix(horizon, "#ff9a5c", 0.45 * (1 - elevation / 20));
  if (!day) { top = mix(shade(top, 0.16), "#0b1330", 0.5); horizon = mix(shade(horizon, 0.25), "#1c2a4a", 0.5); }
  const bottom = mix(shade(pal.ground, day ? 0.8 : 0.25), horizon, 0.5);
  const far = Math.round(edge * WEATHER_FOG[weather]);
  return {
    time_of_day: round2(t), weather,
    sky: { top, horizon, bottom },
    fog: { color: horizon, near: Math.round(far * (weather === "fog" ? 0.05 : 0.2)), far },
    sun: { azimuth_deg: round2(azimuth), elevation_deg: round2(elevation), color: sunColor, intensity: round2(intensity), shadows: intensity > 0.4 },
    ambient: { color: mix(horizon, "#ffffff", 0.2), ground_color: shade(pal.ground, 0.6), intensity: round2(0.3 + 0.3 * dayK) },
    water: { enabled: !!water.enabled, level: round2(water.level), color: pal.water, opacity: 0.82 },
  };
}
function smooth01(x) { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); }

// ---------------------------------------------------------------- routing

/**
 * Terrain-aware A* between two points on the heightfield vertex grid. Steep
 * steps cost quadratically more and wading costs a lot, so paths follow the
 * contours and the coast instead of charging over cliffs or through the sea.
 */
function routeOnTerrain(t, a, b, wl, size) {
  const { cols, rows, cell } = t;
  const toV = (p) => clamp(Math.round(p.z / cell), 1, rows - 2) * cols + clamp(Math.round(p.x / cell), 1, cols - 2);
  const s = toV(a), g = toV(b), N = cols * rows;
  const gs = new Float64Array(N).fill(Infinity), fs = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const gi = g % cols, gj = (g - gi) / cols;
  const hf = (v) => { const i = v % cols, j = (v - i) / cols; return Math.hypot(i - gi, j - gj) * cell; };
  const heap = [];
  const push = (v) => { heap.push(v); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (fs[heap[p]] <= fs[heap[k]]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && fs[heap[l]] < fs[heap[m]]) m = l; if (r < heap.length && fs[heap[r]] < fs[heap[m]]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  gs[s] = 0; fs[s] = hf(s); push(s);
  const edgeCells = 3;
  while (heap.length) {
    const cur = pop();
    if (closed[cur]) continue;
    if (cur === g) break;
    closed[cur] = 1;
    const ci = cur % cols, cj = (cur - ci) / cols;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 1 || nj < 1 || ni >= cols - 1 || nj >= rows - 1) continue;
      const n = nj * cols + ni;
      if (closed[n]) continue;
      const len = (di && dj ? Math.SQRT2 : 1) * cell;
      const hN = t.heights[n], grade = Math.abs(hN - t.heights[cur]) / len;
      let c = len * (1 + 4 * grade * grade);
      if (hN < wl + 0.8) c += len * 40;
      if (ni < edgeCells || nj < edgeCells || ni >= cols - edgeCells || nj >= rows - edgeCells) c += len * 20;
      const tg = gs[cur] + c;
      if (tg < gs[n]) { gs[n] = tg; came[n] = cur; fs[n] = tg + hf(n); push(n); }
    }
  }
  const pts = [];
  for (let v = g; v !== -1; v = came[v]) { const i = v % cols; pts.push({ x: i * cell, z: ((v - i) / cols) * cell }); }
  pts.reverse();
  if (pts.length < 2) return [{ x: a.x, z: a.z }, { x: b.x, z: b.z }];
  pts[0] = { x: a.x, z: a.z }; pts[pts.length - 1] = { x: b.x, z: b.z };
  return smoothPolyline(douglasPeucker(pts, cell * 1.2), size);
}

function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts;
  let idx = 0, dmax = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let k = 1; k < pts.length - 1; k++) {
    const d = distToPolyline([a, b], pts[k].x, pts[k].z);
    if (d > dmax) { dmax = d; idx = k; }
  }
  if (dmax <= eps) return [a, b];
  return douglasPeucker(pts.slice(0, idx + 1), eps).slice(0, -1).concat(douglasPeucker(pts.slice(idx), eps));
}

/** Two Chaikin passes, endpoints pinned, clamped inside the world. */
function smoothPolyline(pts, size) {
  let p = pts;
  for (let it = 0; it < 2; it++) {
    if (p.length < 3) break;
    const q = [p[0]];
    for (let k = 0; k + 1 < p.length; k++) {
      const a = p[k], b = p[k + 1];
      q.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 }, { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p.map((v) => ({ x: round2(clamp(v.x, 1, size.w - 1)), z: round2(clamp(v.z, 1, size.h - 1)) }));
}

// ------------------------------------------------------------------ layout

function regionHalf(kind, edge) {
  const k = edge / 240;
  return kind === "hub" ? Math.round(18 + 4 * k) : kind === "village" ? Math.round(16 + 3 * k) : Math.round(13 + 3 * k);
}
function padRadius(kind) { return kind === "hub" ? 12 : kind === "village" ? 11 : 9; }

/**
 * Place one region per key location. Candidates are jittered grid points on
 * gentle ground (and dry land when there is water). The hub goes first and
 * prefers the centre; other kinds carry a preference (summit/tower high, dock
 * coastal) and a spacing term. A few relaxation passes then nudge each
 * non-hub region to the best nearby candidate, which evens out the spread.
 */
function layoutRegions(base, locations, size, wl, hasWater, R) {
  const edge = Math.max(size.w, size.h);
  const step = edge / 30;
  const cands = [];
  let maxH = -Infinity, minH = Infinity;
  for (let gz = step; gz < size.h - step / 2; gz += step) {
    for (let gx = step; gx < size.w - step / 2; gx += step) {
      const x = gx + (R.next() - 0.5) * step * 0.8, z = gz + (R.next() - 0.5) * step * 0.8;
      const h = sampleGrid(base, x, z);
      let sl = slopeGrid(base, x, z);
      for (let a = 0; a < 4; a++) sl = Math.max(sl, slopeGrid(base, x + Math.cos(a * 1.57) * 6, z + Math.sin(a * 1.57) * 6));
      let dry = true, coast = 0;
      if (hasWater) {
        for (let a = 0; a < 8; a++) {
          const ax = Math.cos((a * Math.PI) / 4), az = Math.sin((a * Math.PI) / 4);
          if (sampleGrid(base, x + ax * 13, z + az * 13) < wl + 0.5) dry = false;
          if (sampleGrid(base, x + ax * 26, z + az * 26) < wl) coast++;
        }
      }
      cands.push({ x, z, h, sl, dry, coast });
      maxH = Math.max(maxH, h); minH = Math.min(minH, h);
    }
  }
  const n = locations.length;
  let spacing = clamp((edge * 0.55) / Math.sqrt(Math.max(n, 1)), 30, 95);
  const placed = [];
  const valid = (c, loc) => {
    const half = regionHalf(loc.kind, edge);
    if (c.x < half + 3 || c.z < half + 3 || c.x > size.w - half - 3 || c.z > size.h - half - 3) return false;
    const maxSl = loc.kind === "summit" || loc.kind === "tower" ? 17 : 14;
    if (c.sl > maxSl) return false;
    if (hasWater) {
      if (c.h < wl + (loc.kind === "dock" ? 1.0 : 1.8)) return false;
      if (loc.kind !== "dock" && !c.dry) return false;
    }
    return true;
  };
  const kindScore = (c, loc, idx) => {
    const hN = (c.h - minH) / Math.max(1e-6, maxH - minH);
    const dc = Math.hypot(c.x - size.w / 2, c.z - size.h / 2) / edge;
    if (idx === 0) return -dc * (hasWater ? 14 : 8);
    switch (loc.kind) {
      case "summit": case "tower": return hN * 6;
      case "dock": return hasWater ? (c.coast > 0 ? 6 - Math.abs(c.h - (wl + 1.8)) : -6) : -hN * 2;
      case "cave": return c.sl * 0.15;
      default: return 0;
    }
  };
  const minDist = (c, except) => {
    let d = Infinity;
    placed.forEach((p, k) => { if (k !== except && p) d = Math.min(d, Math.hypot(p.x - c.x, p.z - c.z)); });
    return d;
  };
  const noise = cands.map(() => R.next());
  for (let li = 0; li < n; li++) {
    const loc = locations[li];
    let best = null;
    for (let attempt = 0; attempt < 6 && !best; attempt++) {
      let bs = -Infinity;
      cands.forEach((c, ci) => {
        if (!valid(c, loc)) return;
        const d = minDist(c, -1);
        if (d < spacing) return;
        const s = kindScore(c, loc, li) + noise[ci] * 1.5 + Math.min(d, spacing * 1.6) / spacing;
        if (s > bs) { bs = s; best = c; }
      });
      if (!best) spacing *= 0.8;
    }
    if (!best) {
      // Nothing valid even at reduced spacing: take the driest, flattest
      // candidate farthest from the others, so generation never fails.
      let bs = -Infinity;
      for (const c of cands) {
        const s = -c.sl + (hasWater ? (c.h - wl) : 0) + Math.min(minDist(c, -1), 60) / 10;
        if (s > bs) { bs = s; best = c; }
      }
    }
    placed.push({ x: best.x, z: best.z });
  }
  // Relaxation: each non-hub region may hop to a nearby candidate that
  // increases its clearance, weighted by its kind preference.
  for (let it = 0; it < 3; it++) {
    for (let li = 1; li < n; li++) {
      const loc = locations[li], cur = placed[li];
      let best = cur, bs = -Infinity;
      for (const c of cands) {
        if (Math.hypot(c.x - cur.x, c.z - cur.z) > spacing * 0.6 || !valid(c, loc)) continue;
        const d = minDist(c, li);
        if (d < spacing) continue;
        const s = kindScore(c, loc, li) + Math.min(d, spacing * 1.4) / spacing * 2;
        if (s > bs) { bs = s; best = c; }
      }
      placed[li] = { x: best.x, z: best.z };
    }
  }
  return placed;
}

/** Prim's MST over region centres, rooted at the hub. */
function mst(points) {
  const n = points.length, inTree = new Array(n).fill(false), edges = [];
  if (!n) return edges;
  inTree[0] = true;
  for (let added = 1; added < n; added++) {
    let best = null, bd = Infinity;
    for (let a = 0; a < n; a++) {
      if (!inTree[a]) continue;
      for (let b = 0; b < n; b++) {
        if (inTree[b]) continue;
        const d = Math.hypot(points[a].x - points[b].x, points[a].z - points[b].z);
        if (d < bd) { bd = d; best = [a, b]; }
      }
    }
    inTree[best[1]] = true;
    edges.push(best);
  }
  return edges;
}

// -------------------------------------------------------------- generation

function normaliseLocations(concept) {
  const locs = Array.isArray(concept.key_locations) ? concept.key_locations.filter((l) => l && typeof l.id === "string" && l.id) : [];
  if (!locs.length) locs.push({ id: "hub", name: "Home", kind: "hub", description: "" });
  const seen = new Set();
  return locs.map((l, i) => {
    let id = l.id;
    while (seen.has(id)) id = `${id}_${i}`;
    seen.add(id);
    const kind = FOCAL_KIND[l.kind] ? l.kind : "landmark";
    return { ...l, id, kind: i === 0 ? "hub" : kind, concept_kind: l.kind };
  });
}

function pickupLib(concept) {
  const text = [concept.title, concept.logline, concept.player_fantasy, ...(concept.objectives_outline || [])].join(" ").toLowerCase();
  const byWord = [["lantern", "lantern_core"], ["relic", "relic"], ["gem", "gem"], ["crystal", "gem"], ["key", "key"],
    ["scroll", "scroll"], ["map", "scroll"], ["herb", "herb"], ["flower", "herb"], ["shard", "shard"], ["star", "shard"]];
  for (const [w, lib] of byWord) if (new RegExp(`\\b${w}`).test(text)) return lib;
  return { island: "relic", forest: "herb", desert: "relic", snow: "shard", volcanic: "gem", canyon: "gem",
    ruins: "relic", city: "key", scifi_base: "shard" }[concept.biome] || "relic";
}

/**
 * Generate a WorldSpec from a GameConcept. `seed` defaults to concept.seed.
 *
 * Layout is tried up to four times with a salted layout stream; the first
 * attempt whose hub reaches every region centre and every focal interactable
 * wins. Rare steep layouts (canyon rims) are re-laid out rather than shipped
 * disconnected. The salt is derived from the seed, so this stays
 * deterministic.
 */
export function generateWorldSpec(concept, { seed } = {}) {
  const S = (Number.isInteger(seed) ? seed : Number.isInteger(concept?.seed) ? concept.seed : hashString(concept?.title || "world")) >>> 0;
  let world = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    world = buildWorld(concept, S, attempt);
    if (isConnected(world)) break;
  }
  return world;
}

/** Hub reaches every region centre and every fixed interactable's radius. */
export function isConnected(world) {
  const nav = world.navigation;
  const sp = world.spawn_points.find((s) => s.id === "spawn_player");
  const reach = reachableSet(nav, sp.position);
  const near = (x, z, r) => nearestWalkable(nav, x, z, r, (i) => reach.has(i)) >= 0;
  if (!world.regions.every((r) => near(r.center.x, r.center.z, nav.cell))) return false;
  const pl = new Map(world.placements.map((p) => [p.id, p]));
  return world.interactables.every((ix) => !ix.placement_ref || near(pl.get(ix.placement_ref).position.x, pl.get(ix.placement_ref).position.z, ix.radius));
}

function buildWorld(concept, S, attempt) {
  const biome = ["island", "forest", "desert", "snow", "volcanic", "canyon", "ruins", "city", "scifi_base"].includes(concept.biome) ? concept.biome : "island";
  const edge = SIZE_BY_SCALE[concept.scale] || SIZE_BY_SCALE.medium;
  const size = { w: edge, h: edge };
  const locations = normaliseLocations(concept);
  const hasWater = biome === "island" || locations.some((l) => l.kind === "dock");
  const R = seeded(hashString(attempt ? `layout|${S}|${attempt}` : `layout|${S}`));

  // 1. Base terrain. Non-island worlds with a dock get a low water line at
  // the 4th percentile so the dock has something to face.
  const base = generateBaseTerrain({ size, biome, seed: S, waterLevel: 0 });
  let wl = 0;
  if (hasWater && biome !== "island") {
    const sorted = Array.from(base.heights).sort((a, b) => a - b);
    wl = round2(sorted[Math.floor(sorted.length * 0.04)]);
  }

  // 2. Regions.
  const centres = layoutRegions(base, locations, size, wl, hasWater, R);
  const regions = locations.map((loc, i) => {
    const half = regionHalf(loc.kind, edge), c = centres[i];
    return {
      id: `region_${loc.id}`, name: loc.name || loc.id, kind: REGION_KIND[loc.kind] || "landmark",
      bounds: [round2(Math.max(0, c.x - half)), round2(Math.max(0, c.z - half)), round2(Math.min(size.w, c.x + half)), round2(Math.min(size.h, c.z + half))],
      center: { x: round2(c.x), y: 0, z: round2(c.z) }, location_ref: loc.id, pad_radius: padRadius(loc.kind),
    };
  });

  // 3. Pads, then paths carved between them, then pads re-levelled so the
  // plaza is exactly flat where the corridors arrive.
  const padH = regions.map((r) => {
    let h = sampleGrid(base, r.center.x, r.center.z);
    if (hasWater) h = Math.max(h, wl + 1.4);
    return round2(h);
  });
  // A path can only climb so fast, so a pad may sit at most a gentle grade
  // above or below its MST parent. Prim's order visits parents first.
  const tree = mst(regions.map((r) => r.center));
  const padGrade = Math.tan((12 * Math.PI) / 180);
  for (const [a, b] of tree) {
    const d = Math.hypot(regions[a].center.x - regions[b].center.x, regions[a].center.z - regions[b].center.z) - regions[a].pad_radius - regions[b].pad_radius;
    const lim = Math.max(0, d) * padGrade;
    padH[b] = round2(clamp(padH[b], padH[a] - lim, padH[a] + lim));
  }
  regions.forEach((r, i) => flattenPad(base, r.center.x, r.center.z, r.pad_radius, padH[i], 9));
  const paths = tree.map(([a, b], k) => {
    const ra = regions[a], rb = regions[b];
    const pts = routeOnTerrain(base, ra.center, rb.center, hasWater ? wl : -Infinity, size);
    return { id: `path_${k + 1}`, from_region: ra.id, to_region: rb.id, width: a === 0 ? 3.5 : 3, points: pts };
  });
  const pins = regions.map((r, i) => ({ x: r.center.x, z: r.center.z, r: r.pad_radius, h: padH[i] }));
  const corridors = [];
  for (const p of paths) corridors.push(corridorProfile(base, p.points, p.width, { maxGradeDeg: 18, minH: hasWater ? wl + 0.9 : -Infinity, pins, keep: corridors.slice() }));
  carveCorridors(base, corridors);
  regions.forEach((r, i) => flattenPad(base, r.center.x, r.center.z, r.pad_radius - 2, padH[i], 2));
  relaxPathSeams(base, paths, { maxSlopeDeg: 30, pinned: (x, z) => regions.some((r) => Math.hypot(r.center.x - x, r.center.z - z) < r.pad_radius - 3) });

  const heights = Array.from(base.heights, (v) => round2(v));
  let minY = Infinity, maxY = -Infinity;
  for (const v of heights) { if (v < minY) minY = v; if (v > maxY) maxY = v; }
  const terrain = {
    kind: "heightfield", shape: base.shape, cols: base.cols, rows: base.rows, cell: base.cell, heights,
    min_y: minY, max_y: maxY, material_layers: materialLayers(biome, wl, minY, maxY),
  };
  for (const r of regions) r.center.y = round2(sampleHeight(terrain, r.center.x, r.center.z));

  // 4. Location compositions.
  const placements = [];
  const occupied = []; // {x, z, r}
  const pathClear = (x, z, r, solid) => paths.every((p) => distToPolyline(p.points, x, z) >= p.width / 2 + (solid ? r + 0.8 : 0.4));
  const focalOf = {};
  const addPlacement = (loc, region, lib, pos, rot, opts = {}) => {
    const def = LIB[lib] || { role: "prop", col: NONE };
    const n = placements.filter((p) => p.id.startsWith(`pl_${loc.id}_${lib}_`)).length + 1;
    const y = opts.y !== undefined ? opts.y : sampleHeight(terrain, pos.x, pos.z);
    const scale = def.col.solid ? 1 : round2(opts.scale || 1);
    const pl = {
      id: `pl_${loc.id}_${lib}_${n}`, asset_ref: `lib:${lib}`, region: region.id,
      position: { x: round2(pos.x), y: round2(y), z: round2(pos.z) }, rotation_y: round2(rot), scale,
      role: opts.focal ? "interactable" : def.role, collider: JSON.parse(JSON.stringify(def.col)),
      tags: [loc.kind, ...(opts.focal ? ["focal"] : [])],
    };
    placements.push(pl);
    occupied.push({ x: pl.position.x, z: pl.position.z, r: footprintRadius(pl) });
    return pl;
  };

  locations.forEach((loc, li) => {
    const region = regions[li], c = region.center, half = regionHalf(loc.kind, edge);
    const PR = seeded(hashString(`place|${S}|${loc.id}`));
    const arcA = PR.next() * Math.PI * 2; // cave mouth direction
    // Water direction for docks: the lowest ground around the region.
    let wdir = null;
    if (loc.kind === "dock" && hasWater) {
      let lowest = Infinity;
      for (let a = 0; a < 24; a++) {
        const ang = (a / 24) * Math.PI * 2;
        const h = sampleHeight(terrain, c.x + Math.cos(ang) * 22, c.z + Math.sin(ang) * 22);
        if (h < lowest) { lowest = h; wdir = { x: Math.cos(ang), z: Math.sin(ang) }; }
      }
    }
    for (const [lib, spec] of composition(loc.kind, biome, hasWater)) {
      const count = spec.n || 1;
      for (let k = 0; k < count; k++) {
        if (spec.dock) {
          if (!wdir) { // no water: an ordinary jetty-shaped structure on the ring
            placeOnRing(loc, region, lib, { ring: [9, half - 2] }, PR, c, half);
            continue;
          }
          let d = 6;
          while (d < 40 && sampleHeight(terrain, c.x + wdir.x * d, c.z + wdir.z * d) > wl + 0.3) d += 1;
          const dx = c.x + wdir.x * (d + 3), dz = c.z + wdir.z * (d + 3);
          const pl = addPlacement(loc, region, lib, { x: clamp(dx, 3, size.w - 3), z: clamp(dz, 3, size.h - 3) }, Math.atan2(wdir.x, wdir.z),
            { y: Math.max(sampleHeight(terrain, c.x + wdir.x * d, c.z + wdir.z * d), wl) + 0.35 });
          pl.tags.push("waterfront");
          continue;
        }
        if (spec.boat) {
          const dock = placements.find((p) => p.region === region.id && p.asset_ref === "lib:dock");
          if (!dock || !wdir) continue;
          const bx = dock.position.x + wdir.x * 7 - wdir.z * 3.5, bz = dock.position.z + wdir.z * 7 + wdir.x * 3.5;
          if (bx < 3 || bz < 3 || bx > size.w - 3 || bz > size.h - 3) continue;
          addPlacement(loc, region, lib, { x: bx, z: bz }, Math.atan2(wdir.x, wdir.z), { y: wl });
          continue;
        }
        const pl = placeOnRing(loc, region, lib, spec, PR, c, half, arcA);
        if (spec.focal && pl) focalOf[loc.id] = pl;
      }
    }
    if (!focalOf[loc.id]) {
      // Every location needs its focal piece; fall back to a signpost at a
      // guaranteed-clear spot just off the centre.
      const [lib] = composition(loc.kind, biome, hasWater).find(([, s]) => s.focal);
      focalOf[loc.id] = placeOnRing(loc, region, lib, { focal: true, ring: [4, 7] }, PR, c, half, arcA, true)
        || addPlacement(loc, region, lib, { x: c.x + 4.5, z: c.z }, 0, { focal: true });
    }
  });

  function placeOnRing(loc, region, lib, spec, PR, c, half, arcA = 0, relaxed = false) {
    const def = LIB[lib] || { col: NONE };
    const fr = footprintRadius({ collider: def.col });
    const solid = !!def.col.solid;
    const [r0, r1] = spec.ring || [5, half - 2];
    for (let tr = 0; tr < 40; tr++) {
      const ang = spec.arc ? arcA + (PR.next() - 0.5) * 1.9 : PR.next() * Math.PI * 2;
      const rad = r0 + (Math.min(r1, half + 4) - r0) * PR.next();
      const x = c.x + Math.cos(ang) * rad, z = c.z + Math.sin(ang) * rad;
      const scale = PR.range(0.85, 1.15);
      if (x < fr + 2 || z < fr + 2 || x > size.w - fr - 2 || z > size.h - fr - 2) continue;
      if (Math.hypot(x - c.x, z - c.z) < 3.5 + fr) continue;
      const h = sampleHeight(terrain, x, z);
      if (hasWater && h < wl + 0.5) continue;
      if (slopeAt(terrain, x, z) > (lib === "cliff_rock" || lib === "rock_large" ? 40 : 26)) continue;
      if (!relaxed && !pathClear(x, z, fr, solid)) continue;
      if (occupied.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + fr + 0.9)) continue;
      // Other regions' plazas stay open.
      if (regions.some((r) => r !== region && Math.hypot(r.center.x - x, r.center.z - z) < r.pad_radius + fr)) continue;
      const faceCentre = Math.atan2(c.x - x, c.z - z);
      return addPlacement(loc, region, lib, { x, z }, faceCentre, { focal: !!spec.focal, scale });
    }
    return null;
  }

  // 5. Scatter.
  const scatter = [];
  const area = size.w * size.h;
  for (const [lib, dens, mn, mx, cr, extra] of scatterTable(biome, wl)) {
    const count = Math.min(900, Math.round((dens * area) / 10000));
    if (!count) continue;
    scatter.push({
      id: `sc_${lib}`, asset_ref: `lib:${lib}`, region: null, count, min_scale: mn, max_scale: mx,
      seed: hashString(`scatter|${S}|${lib}`), avoid_paths: true, collider_radius: cr,
      ...Object.fromEntries(Object.entries(extra || {}).map(([k, v]) => [k, typeof v === "number" ? round2(v) : v])),
    });
  }

  const environment = buildEnvironment({ ...concept, biome }, edge, { enabled: hasWater, level: wl });
  const world = {
    world_spec_version: WORLD_SPEC_VERSION,
    id: `world_${hashString(`${concept.title || ""}|${S}|${biome}|${edge}`).toString(16).padStart(8, "0")}`,
    title: String(concept.title || "Untitled world"), seed: S, size, biome, environment, terrain, regions, paths,
    placements, scatter, spawn_points: [],
    camera: { mode: "third_person", distance: 7, height: 2.4, fov: 60, min_pitch: -0.35, max_pitch: 1.1, collide: true },
    interactables: [], navigation: null,
  };

  // 6. Navigation.
  const instances = expandScatter(world);
  const colliders = buildColliders(world, null, instances);
  world.navigation = bakeNavigation(world, colliders);
  const nav = world.navigation;

  // 7. Spawns — all chosen from cells reachable from the player spawn.
  const hub = regions[0];
  const clearOf = (idx, pad) => { const p = cellCenter(nav, idx); return !pointInCollider(colliders, p.x, p.z, pad); };
  const hubIdx = nearestWalkable(nav, hub.center.x, hub.center.z + 2.5, 40, (i) => clearOf(i, 1.2));
  const spawnPos = hubIdx >= 0 ? cellCenter(nav, hubIdx) : { x: hub.center.x, z: hub.center.z };
  const reach = reachableSet(nav, spawnPos);
  const spawns = world.spawn_points;
  const facing = (from, to) => round2(Math.atan2(to.x - from.x, to.z - from.z));
  const other = regions[1] || hub;
  const mkSpawn = (id, kind, p, region, rot) => spawns.push({
    id, kind, position: { x: round2(p.x), y: round2(sampleHeight(terrain, p.x, p.z)), z: round2(p.z) }, rotation_y: rot, region: region.id,
  });
  mkSpawn("spawn_player", "player", spawnPos, hub, facing(spawnPos, other.center));
  const taken = [spawnPos];
  const pickCell = (tx, tz, maxD, pad, minSep, region) => {
    for (const d of [maxD, maxD * 2, edge]) {
      const idx = nearestWalkable(nav, tx, tz, d, (i) => {
        if (!reach.has(i) || !clearOf(i, pad)) return false;
        const p = cellCenter(nav, i);
        if (region && (p.x < region.bounds[0] || p.z < region.bounds[1] || p.x > region.bounds[2] || p.z > region.bounds[3]) && d === maxD) return false;
        return taken.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= minSep);
      });
      if (idx >= 0) return cellCenter(nav, idx);
    }
    return { x: tx, z: tz };
  };
  const SR = seeded(hashString(`spawns|${S}`));
  const chars = Array.isArray(concept.characters) ? concept.characters.filter((ch) => ch && typeof ch.id === "string" && ch.id) : [];
  const nonHub = regions.slice(1);
  let hostileK = 0, guardK = 0;
  for (const ch of chars) {
    let region = hub;
    if (ch.role === "enemy" || ch.role === "creature") region = nonHub.length ? nonHub[nonHub.length - 1 - (hostileK++ % nonHub.length)] : hub;
    else if (ch.role === "guard") region = nonHub.length ? nonHub[guardK++ % nonHub.length] : hub;
    const a = SR.next() * Math.PI * 2, rr = SR.range(4.5, 7.5);
    const p = pickCell(region.center.x + Math.cos(a) * rr, region.center.z + Math.sin(a) * rr, 8, 1.0, 1.8, region);
    taken.push(p);
    mkSpawn(`spawn_npc_${ch.id}`, "npc", p, region, facing(p, region.center));
  }
  for (const r of nonHub) {
    const dx = hub.center.x - r.center.x, dz = hub.center.z - r.center.z, L = Math.hypot(dx, dz) || 1;
    const p = pickCell(r.center.x + (dx / L) * 4, r.center.z + (dz / L) * 4, 6, 0.9, 1.5, r);
    taken.push(p);
    mkSpawn(`spawn_cp_${r.id}`, "checkpoint", p, r, facing(p, r.center));
  }

  // 8. Interactables.
  const ixs = world.interactables;
  for (const loc of locations) {
    const pl = focalOf[loc.id];
    const kind = FOCAL_KIND[loc.kind];
    ixs.push({ id: `ix_${loc.id}`, placement_ref: pl.id, kind, radius: round2(footprintRadius(pl) + 1.8 + terrain.cell * 0.5), prompt: PROMPT[kind] });
  }
  const lib = pickupLib(concept);
  const pickTargets = nonHub.length ? nonHub : [hub];
  const nPick = Math.max(3, nonHub.length);
  const PK = seeded(hashString(`pickups|${S}`));
  const itemName = lib.replace(/_/g, " ");
  for (let n = 1; n <= nPick; n++) {
    const region = pickTargets[(n - 1) % pickTargets.length];
    const half = (region.bounds[2] - region.bounds[0]) / 2;
    const a = PK.next() * Math.PI * 2, rr = PK.range(5, Math.max(6, half - 3));
    const p = pickCell(region.center.x + Math.cos(a) * rr, region.center.z + Math.sin(a) * rr, 8, 0.8, 3, region);
    taken.push(p);
    const pl = {
      id: `pl_pickup_${n}`, asset_ref: `lib:${lib}`, region: region.id,
      position: { x: round2(p.x), y: round2(sampleHeight(terrain, p.x, p.z) + 0.5), z: round2(p.z) }, rotation_y: round2(PK.next() * 6.28), scale: 1,
      role: "pickup", collider: { shape: "none", solid: false }, tags: ["pickup"],
    };
    placements.push(pl);
    ixs.push({ id: `pickup_${n}`, placement_ref: pl.id, kind: "pickup", radius: 1.6, prompt: `Pick up the ${itemName}`, item_ref: `item_${n}` });
  }
  for (const ch of chars) {
    if (ch.role === "enemy") continue;
    ixs.push({ id: `ix_talk_${ch.id}`, placement_ref: null, kind: "talk", radius: 2.5, prompt: `Talk to ${ch.name || ch.id}`, character_ref: ch.id });
  }
  return world;
}

/**
 * Bake walkability per nav cell: inside the border, above the water line,
 * under the slope limit and not inside any solid collider grown by the player
 * radius. Colliders are rasterised over their own bounding box rather than
 * tested per cell, which keeps a large forest cheap.
 */
export function bakeNavigation(world, colliders) {
  const t = world.terrain;
  const cell = t.cell;
  const cols = Math.round(world.size.w / cell), rows = Math.round(world.size.h / cell);
  const water = world.environment.water;
  const wl = water.enabled ? water.level : -Infinity;
  const walk = new Uint8Array(cols * rows);
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const x = (i + 0.5) * cell, z = (j + 0.5) * cell;
      if (sampleHeight(t, x, z) < wl + 0.25) continue;
      if (slopeAt(t, x, z) > MAX_SLOPE_DEG) continue;
      walk[j * cols + i] = 1;
    }
  }
  for (const c of colliders) {
    if (!c.solid) continue;
    const b = (c.bound ?? (c.shape === "box" ? Math.hypot(c.half.x, c.half.z) : c.radius)) + PLAYER_RADIUS;
    const i0 = Math.max(0, Math.floor((c.center.x - b) / cell)), i1 = Math.min(cols - 1, Math.floor((c.center.x + b) / cell));
    const j0 = Math.max(0, Math.floor((c.center.z - b) / cell)), j1 = Math.min(rows - 1, Math.floor((c.center.z + b) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (walk[j * cols + i] && containsXZ(c, (i + 0.5) * cell, (j + 0.5) * cell, PLAYER_RADIUS)) walk[j * cols + i] = 0;
    }
  }
  let s = "";
  for (let k = 0; k < walk.length; k++) s += walk[k] ? "1" : "0";
  return { cell, cols, rows, max_slope_deg: MAX_SLOPE_DEG, step_height: STEP_HEIGHT, walkable: s };
}

