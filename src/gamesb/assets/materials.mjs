// Games-B material library: every `mat:` name in CONTRACT §4.1a → a material
// payload plus the texture recipes it needs. Written isomorphic-clean (no
// node:*), so the texture gallery can import it too.
//
// Tinting: each material starts from a hand-tuned look and is pulled toward
// the concept palette (and nudged by biome) by a fixed weight. The weights are
// deliberately modest — a palette of "#ff00ff" should give pinkish roof tiles,
// not a magenta roof that no longer reads as tile.
//
// Colour semantics (CONTRACT addition, optional fields):
//   * `color` is the flat mid-tone — what the runtime should draw when it does
//     not load the albedo texture (low-perf mode, texture still baking).
//   * `color_with_map` is the multiplier to use WITH the albedo texture
//     (always "#ffffff" here, since the tint is already baked into the texture).
//   * `texture_refs` names the tex: refs, and `tile_m` is metres per texture
//     tile for world-space (triplanar / terrain) mapping.

import { hashString, clamp } from "../common/rng.mjs";

export const MATERIAL_NAMES = Object.freeze([
  "grass", "sand", "rock", "dirt", "snow", "stone", "wood", "planks", "roof", "metal",
  "plaster", "leaves", "bark", "water", "cloth", "glow", "crystal", "brass", "ember",
]);
export const MATERIAL_REFS = Object.freeze(MATERIAL_NAMES.map((n) => `mat:${n}`));

const hex2 = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "")); const n = m ? parseInt(m[1], 16) : 0x808080; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = ([r, g, b]) => "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
export function mixHex(a, b, t) { if (!b || !t) return a; const x = hex2(a), y = hex2(b); return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]); }

// generator, colours (dark→light, extra), PBR, which palette key pulls it and how hard.
const LIBRARY = {
  grass:   { gen: "grass",       colors: ["#34591f", "#4f7f2c", "#7fa845", "#a39352"], roughness: 0.92, metalness: 0, tile_m: 4, pull: ["ground", 0.25] },
  sand:    { gen: "sand",        colors: ["#b8925a", "#d6b882", "#efdcae", "#9c7a4a"], roughness: 0.9, metalness: 0, tile_m: 4, pull: ["ground", 0.2] },
  rock:    { gen: "rock",        colors: ["#4a4743", "#6f6b64", "#958f84", "#2e2c29"], roughness: 0.85, metalness: 0, tile_m: 6, pull: ["ground", 0.12] },
  dirt:    { gen: "dirt",        colors: ["#4c3727", "#6e5139", "#8d6c4b", "#8a8378"], roughness: 0.95, metalness: 0, tile_m: 3, pull: ["ground", 0.2] },
  snow:    { gen: "snow",        colors: ["#b7c6d8", "#dfe8f1", "#f7fafd", "#ffffff"], roughness: 0.75, metalness: 0, tile_m: 5, pull: ["sky", 0.08] },
  stone:   { gen: "stone_tiles", colors: ["#625d56", "#817b71", "#a29b8e", "#3f3b35"], roughness: 0.82, metalness: 0, tile_m: 2.5, pull: ["secondary", 0.1], params: { cells: 5 } },
  wood:    { gen: "planks",      colors: ["#5a3d27", "#76523a", "#936c4c", "#3a281a"], roughness: 0.75, metalness: 0, tile_m: 1.5, pull: ["secondary", 0.08], params: { boards: 3, gap: 0.01 } },
  planks:  { gen: "planks",      colors: ["#5e4029", "#80593a", "#a07650", "#20160d"], roughness: 0.72, metalness: 0, tile_m: 2, pull: ["secondary", 0.08] },
  roof:    { gen: "roof_tiles",  colors: ["#6e3324", "#8c4630", "#ab5f40", "#2c140d"], roughness: 0.7, metalness: 0, tile_m: 2, pull: ["primary", 0.3] },
  metal:   { gen: "metal",       colors: ["#5c6268", "#7d848b", "#a7aeb4", "#3c4145"], roughness: 0.38, metalness: 0.85, tile_m: 1.5, pull: null },
  plaster: { gen: "plaster",     colors: ["#c2b59b", "#d7cdb7", "#ebe4d3", "#9c8f77"], roughness: 0.9, metalness: 0, tile_m: 3, pull: ["secondary", 0.1] },
  leaves:  { gen: "leaves",      colors: ["#1f3d17", "#355f25", "#5a8a36", "#11220c"], roughness: 0.8, metalness: 0, tile_m: 1.5, pull: ["ground", 0.15], double_sided: true },
  bark:    { gen: "bark",        colors: ["#2a1d13", "#4b3524", "#6c4f36", "#140d08"], roughness: 0.95, metalness: 0, tile_m: 1, pull: null },
  water:   { gen: "water",       colors: ["#153f5a", "#23617f", "#3f8aa8", "#d4ecf2"], roughness: 0.08, metalness: 0.1, tile_m: 8, pull: ["water", 0.6], transparent: true, opacity: 0.82 },
  cloth:   { gen: "cloth",       colors: ["#553a63", "#6f4e80", "#8d6ba0", "#2f2038"], roughness: 0.95, metalness: 0, tile_m: 0.6, pull: ["primary", 0.55], double_sided: true },
  glow:    { gen: null, flat: "#ffd27a", roughness: 0.4, metalness: 0, emissive: "#ffc86a", emissive_intensity: 2.2, pull: ["accent", 0.35] },
  crystal: { gen: null, flat: "#8fd8ff", roughness: 0.08, metalness: 0.1, emissive: "#5fb8ff", emissive_intensity: 0.6, pull: ["accent", 0.5], transparent: true, opacity: 0.72 },
  brass:   { gen: "metal",       colors: ["#7a5a22", "#a8812f", "#d8b25a", "#4a3514"], roughness: 0.32, metalness: 0.95, tile_m: 1, pull: null, params: { panels: 1, rivets: false } },
  ember:   { gen: "noise",       colors: ["#2a0a04", "#8a2a0a", "#ff7a2a"], roughness: 0.9, metalness: 0, tile_m: 0.8, pull: null, emissive: "#ff5a1f", emissive_intensity: 1.4 },
};

// Biome nudges applied before the palette pull.
const BIOME_TINT = {
  desert:   { grass: ["#9c8f4a", 0.45], dirt: ["#a0764a", 0.3], rock: ["#9a7b5a", 0.3], sand: ["#d9a860", 0.2] },
  canyon:   { rock: ["#a65a3a", 0.45], dirt: ["#9a5a3a", 0.35], sand: ["#c77a4a", 0.3], grass: ["#8a8a4a", 0.3] },
  snow:     { grass: ["#9fb0a4", 0.35], rock: ["#8a95a0", 0.2], dirt: ["#6a6560", 0.2] },
  volcanic: { rock: ["#2a2624", 0.5], sand: ["#3a3632", 0.6], dirt: ["#3a2a22", 0.4], grass: ["#4a5a2a", 0.3] },
  forest:   { grass: ["#2f5a22", 0.2], leaves: ["#284f1c", 0.2] },
  island:   { sand: ["#f0dcaa", 0.25], water: ["#1a8aa0", 0.3] },
  ruins:    { stone: ["#8a8274", 0.2], grass: ["#5a7a3a", 0.1] },
  city:     { stone: ["#7a7a7a", 0.2] },
  scifi_base: { metal: ["#7a8fa0", 0.2], plaster: ["#d8dde2", 0.4] },
};

export const materialRef = (name) => `mat:${name}`;
export const textureRef = (name, channel) => `tex:${name}_${channel}`;

/**
 * Material payload + texture recipes for one `mat:` name.
 * @returns {{ name, ref, material, textures: [{ ref, channel, recipe }] } | null}
 */
export function buildMaterialSpec(nameOrRef, { palette = null, biome = null, seed = 0, textureSize = 256 } = {}) {
  const name = String(nameOrRef || "").replace(/^mat:/, "");
  const def = LIBRARY[name];
  if (!def) return null;
  const pull = def.pull && palette?.[def.pull[0]] ? [palette[def.pull[0]], def.pull[1]] : null;
  const bt = BIOME_TINT[biome]?.[name];
  const tint = (c) => { let x = bt ? mixHex(c, bt[0], bt[1]) : c; if (pull) x = mixHex(x, pull[0], pull[1]); return x; };

  const textures = [];
  let color;
  if (def.gen) {
    const colors = def.colors.map(tint);
    color = colors[1];
    // Seed per material (not per game) so a texture is shared by every game
    // with the same palette — that is what makes the content cache pay off.
    const recipe = {
      generator: def.gen, size: [64, 128, 256, 512].includes(textureSize) ? textureSize : 256,
      seed: ((hashString(name) ^ (seed | 0)) >>> 0) % 1000003, colors, scale: 1, params: { ...(def.params || {}) },
    };
    for (const channel of ["albedo", "normal", "roughness"]) textures.push({ ref: textureRef(name, channel), channel, recipe: { ...recipe, channel } });
  } else {
    color = tint(def.flat);
  }
  const emissive = def.emissive ? (pull ? mixHex(def.emissive, pull[0], pull[1]) : def.emissive) : null;
  const material = {
    material_id: materialRef(name),
    color,
    color_with_map: def.gen ? "#ffffff" : color,
    roughness: def.roughness, metalness: def.metalness,
    emissive, emissive_intensity: def.emissive_intensity ?? 0,
    transparent: !!def.transparent, opacity: def.opacity ?? 1,
    repeat: { u: 1, v: 1 }, tile_m: def.tile_m ?? 1,
    double_sided: !!def.double_sided,
    texture_refs: Object.fromEntries(textures.map((t) => [t.channel, t.ref])),
  };
  return { name, ref: materialRef(name), material, textures };
}
