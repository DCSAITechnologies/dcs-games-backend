// Games-D material styles. ISOMORPHIC data + a pure concept patch.
//
// A style re-dresses the 19 Games-B library materials for one theme: new colour
// ramps where the library look would be wrong (red canyon rock, black volcanic
// sand, station alloy), a light tint over everything else, roughness, texture
// weathering params (SURFACE_PASSES in src/gamesb/assets/texture-synth.mjs:
// moss, cracks, rust, wear, frost, wet, grime), a seed offset so two themes
// never share a texture by accident, and a tile size multiplier.
//
// materialConceptPatch copies the chosen style into `concept.material_style`
// (optional, add-only). src/gamesb/assets/asset-pipeline.mjs hands it to
// buildMaterialSpec, which applies it; when the field is absent Games-B builds
// exactly the materials it always did. The style travels as plain data inside
// the concept, so Games-B never imports Games-D.
//
// Shape (every field but id optional):
//   { id, name, tint: [hex, weight], seed_offset, tile_mult, roughness_add,
//     texture_size: 64|128|256, params: {...all textured materials but water},
//     materials: { <mat name>: { colors, flat, tint, roughness, metalness, params,
//                                generator, scale, tile_m, emissive: [hex, weight],
//                                emissive_intensity, opacity } } }

import { hashString } from "../../gamesb/common/rng.mjs";

export const MATERIAL_STYLE_VERSION = "1.0.0";
export const DEFAULT_STYLE_ID = "default";

const S = (id, name, body) => Object.freeze({ id, name, seed_offset: hashString(`style:${id}`) % 65521, ...body });

export const MATERIAL_STYLES = Object.freeze({
  default: S("default", "Neutral", {
    tint: ["#8a8a80", 0.06], tile_mult: 1, roughness_add: 0,
    materials: {},
  }),

  storm_isle: S("storm_isle", "Storm-washed stone", {
    tint: ["#4d5a66", 0.14], tile_mult: 1, roughness_add: -0.04,
    params: { wet: 0.35 },
    materials: {
      grass: { colors: ["#2c4a24", "#3f6433", "#5d8248", "#77805a"], params: { wet: 0.3 } },
      rock: { colors: ["#3a3e42", "#565b60", "#7b8086", "#1f2225"], params: { wet: 0.45, moss: 0.25, moss_color: "#51683a" } },
      sand: { colors: ["#8d8270", "#ab9f88", "#c8bca3", "#6d6352"], params: { wet: 0.5 } },
      stone: { params: { moss: 0.35, wet: 0.4 } },
      wood: { tint: ["#4b4f52", 0.3], params: { grime: 0.4, wet: 0.35 } },
      planks: { tint: ["#4b4f52", 0.3], params: { grime: 0.4, wet: 0.35 } },
      roof: { colors: ["#3c4650", "#53606b", "#6c7a86", "#1b2126"] },
      water: { colors: ["#12303f", "#1e4a5c", "#3a6f80", "#c8dde2"], opacity: 0.86 },
      metal: { params: { rust: 0.45 } },
    },
  }),

  tropical_cove: S("tropical_cove", "Sun-bleached tropics", {
    tint: ["#f2d58a", 0.08], tile_mult: 1.1, roughness_add: 0.02,
    materials: {
      grass: { colors: ["#2e6b22", "#4c9432", "#7cc04a", "#b5b765"] },
      sand: { colors: ["#e3c893", "#f3e2b8", "#fff6dc", "#c9a672"], params: { ripples: 7 } },
      rock: { colors: ["#6a6358", "#8f877a", "#b3aa99", "#403b33"], params: { moss: 0.15, moss_color: "#5a7a38" } },
      water: { colors: ["#0e6a7e", "#169aa8", "#46cbc8", "#eafaf7"], opacity: 0.78 },
      wood: { colors: ["#8a6a48", "#a8865e", "#c7a67c", "#5a4430"], params: { wear: 0.4 } },
      planks: { colors: ["#94744f", "#b39066", "#d1b085", "#3a2a1a"], params: { wear: 0.35 } },
      roof: { colors: ["#8e7a45", "#ae9656", "#ccb46e", "#4a3c1c"], generator: "leaves", params: { cells: 12 } },
      cloth: { colors: ["#b8452e", "#d9653c", "#f09250", "#6a2418"] },
      leaves: { colors: ["#1f5a1a", "#2f7f26", "#58aa3c", "#0e2a0c"] },
    },
  }),

  pine_valley: S("pine_valley", "Mossy highland", {
    tint: ["#3e5a3a", 0.08], tile_mult: 1, roughness_add: 0.01,
    materials: {
      grass: { colors: ["#2a4a1c", "#3d6828", "#62883c", "#8c8248"] },
      rock: { colors: ["#4c4c48", "#6a6a64", "#8e8d85", "#2a2a27"], params: { moss: 0.4, moss_color: "#4a6a2c" } },
      dirt: { colors: ["#3e2e20", "#5a4430", "#78603f", "#7a766e"] },
      stone: { params: { moss: 0.45, moss_color: "#4f6f2e" } },
      bark: { colors: ["#2b1d14", "#46301f", "#5f4430", "#120b06"], params: { moss: 0.2 } },
      leaves: { colors: ["#16301a", "#234a26", "#3a6c38", "#0a180c"] },
      wood: { params: { grime: 0.25 } },
      roof: { colors: ["#4a3a2a", "#5f4b37", "#7a6249", "#1f160e"], params: { moss: 0.3 } },
    },
  }),

  swamp_fen: S("swamp_fen", "Rotting fen", {
    tint: ["#4a5230", 0.18], tile_mult: 0.9, roughness_add: -0.03,
    params: { wet: 0.45, grime: 0.3 },
    materials: {
      grass: { colors: ["#343d1c", "#4a5526", "#6a7334", "#716a3e"], params: { wet: 0.4 } },
      dirt: { colors: ["#2a2418", "#3d3322", "#54472e", "#4a4a3a"], params: { wet: 0.7, pebbles: 5 } },
      rock: { colors: ["#34362c", "#4c4f40", "#686b58", "#1c1d16"], params: { moss: 0.6, moss_color: "#56662a", wet: 0.5 } },
      water: { colors: ["#1f2a16", "#2f3d1f", "#4a5a30", "#8a9468"], opacity: 0.9 },
      wood: { colors: ["#3a3022", "#4f4230", "#665740", "#1c160e"], params: { moss: 0.35, grime: 0.5 } },
      planks: { colors: ["#3d3223", "#544531", "#6c5b42", "#15100a"], params: { moss: 0.3, grime: 0.5 } },
      stone: { params: { moss: 0.55 } },
      leaves: { colors: ["#27351a", "#3a4c24", "#566a34", "#10170a"] },
      glow: { flat: "#c8f07a", emissive: ["#a0e060", 0.6] },
    },
  }),

  dune_sea: S("dune_sea", "Sand-scoured", {
    tint: ["#d6a660", 0.14], tile_mult: 1.25, roughness_add: 0.03,
    materials: {
      sand: { colors: ["#c08a4e", "#d9a868", "#efc98a", "#9a6a3a"], params: { ripples: 14 } },
      grass: { colors: ["#7f7a3a", "#9c954c", "#bcb266", "#b0915a"] },
      rock: { colors: ["#8a6a4a", "#a8825c", "#c49e74", "#5a4230"], params: { strata: 11, wear: 0.3 } },
      dirt: { colors: ["#8a643e", "#a67c4e", "#c29a66", "#9a8a78"] },
      stone: { colors: ["#a88e6a", "#c2a680", "#dcc39c", "#6a563c"], params: { wear: 0.35 } },
      plaster: { colors: ["#d2b88c", "#e2cca4", "#f0e0be", "#a88e66"], params: { cracks: 0.35 } },
      wood: { params: { wear: 0.5 } },
      cloth: { colors: ["#8a3a26", "#b0543a", "#d27a50", "#4a1e12"] },
      metal: { params: { wear: 0.4, rust: 0.2 } },
    },
  }),

  frost_peaks: S("frost_peaks", "Rime and granite", {
    tint: ["#b8cce0", 0.12], tile_mult: 1, roughness_add: -0.02,
    materials: {
      snow: { colors: ["#aebfd4", "#d8e4f0", "#f5f9fd", "#ffffff"] },
      grass: { colors: ["#5a6e5e", "#7a8e7c", "#9fb0a0", "#c8d0cc"], params: { frost: 0.45 } },
      rock: { colors: ["#4a525c", "#6a737e", "#8e98a2", "#2a3038"], params: { frost: 0.4, cracks: 0.3 } },
      dirt: { colors: ["#4a4640", "#625d55", "#7c766c", "#9aa2a8"], params: { frost: 0.35 } },
      stone: { params: { frost: 0.4 } },
      wood: { tint: ["#6a7580", 0.25], params: { frost: 0.3 } },
      planks: { tint: ["#6a7580", 0.25], params: { frost: 0.3 } },
      roof: { colors: ["#4e5a66", "#66737f", "#808c98", "#20262c"], params: { frost: 0.55 } },
      water: { colors: ["#244a66", "#3a6a88", "#6a9ab8", "#e8f4fa"], opacity: 0.88 },
      crystal: { flat: "#bfe6ff", emissive: ["#a8dcff", 0.5] },
    },
  }),

  ember_caldera: S("ember_caldera", "Basalt and ember", {
    tint: ["#3a2420", 0.18], tile_mult: 1, roughness_add: 0.02,
    params: { grime: 0.35 },
    materials: {
      rock: { colors: ["#1e1b1a", "#2f2b29", "#48423e", "#0c0a0a"], params: { cracks: 0.6, crack_color: "#ff5a1a", crack_cells: 6 } },
      sand: { colors: ["#232020", "#35302e", "#4a4440", "#141212"] },
      dirt: { colors: ["#2a1e18", "#3d2c22", "#56402f", "#4a403a"], params: { cracks: 0.3, crack_color: "#c8401a" } },
      grass: { colors: ["#3a3a22", "#4f4c2c", "#6a6438", "#5a3a22"] },
      stone: { colors: ["#2e2a28", "#44403c", "#5c5650", "#141210"], params: { cracks: 0.35, crack_color: "#d04a1a" } },
      ember: { colors: ["#2a0a04", "#a0300c", "#ff8a30"], emissive_intensity: 1.8 },
      metal: { colors: ["#3a3230", "#544a46", "#716560", "#1a1614"], params: { rust: 0.3, rust_color: "#7a3a1a" } },
      glow: { flat: "#ff9a4a", emissive: ["#ff6a20", 0.55] },
      water: { colors: ["#3a1a0a", "#6a2a0a", "#c04a10", "#ffb060"], opacity: 0.95 },
    },
  }),

  red_canyon: S("red_canyon", "Red rock", {
    tint: ["#b0583a", 0.12], tile_mult: 1.2, roughness_add: 0.02,
    materials: {
      rock: { colors: ["#7a3522", "#a24a2e", "#c46a44", "#4a1e12"], params: { strata: 13, cracks: 0.2 } },
      dirt: { colors: ["#8a4a2e", "#a8603c", "#c27c52", "#a08a78"] },
      sand: { colors: ["#b8683e", "#d0844e", "#e6a468", "#8a4a2a"], params: { ripples: 9 } },
      grass: { colors: ["#6a6a34", "#86843e", "#a4a052", "#9a7a4a"] },
      stone: { colors: ["#8a5a42", "#a8735a", "#c28e72", "#4a2e20"], params: { wear: 0.3 } },
      wood: { params: { wear: 0.4 } },
      plaster: { colors: ["#c89a78", "#dab292", "#eacaae", "#a07458"], params: { cracks: 0.3 } },
    },
  }),

  sunken_ruins: S("sunken_ruins", "Drowned masonry", {
    tint: ["#4a6a64", 0.14], tile_mult: 1, roughness_add: -0.02,
    params: { wet: 0.3 },
    materials: {
      stone: { colors: ["#56605a", "#727c74", "#909a90", "#2e3430"], params: { moss: 0.55, moss_color: "#3f6a4a", cracks: 0.35 } },
      rock: { colors: ["#3e4844", "#58625e", "#76807a", "#222826"], params: { moss: 0.5, moss_color: "#3a664a" } },
      plaster: { colors: ["#9aa498", "#b2baae", "#c8d0c4", "#6a7468"], params: { moss: 0.4, cracks: 0.45 } },
      sand: { colors: ["#8a8a74", "#a8a68c", "#c4c2a6", "#5e5e4a"] },
      grass: { colors: ["#2a4a34", "#3a6446", "#58845e", "#6a7a5a"] },
      water: { colors: ["#0e3a44", "#16565e", "#2e7e80", "#bfe6e0"], opacity: 0.84 },
      metal: { params: { rust: 0.6, rust_color: "#6a5a2a" } },
      brass: { tint: ["#4a7a64", 0.4], params: { rust: 0.5, rust_color: "#3f8a6a" } },
    },
  }),

  fog_city: S("fog_city", "Soot and slate", {
    tint: ["#5a5e66", 0.16], tile_mult: 0.9, roughness_add: -0.02,
    params: { grime: 0.4 },
    materials: {
      stone: { colors: ["#4e5054", "#66686c", "#808286", "#2a2b2e"], params: { grime: 0.5, wet: 0.35, wear: 0.2 } },
      plaster: { colors: ["#8a867e", "#a29e96", "#bab6ae", "#5e5a54"], params: { grime: 0.6, cracks: 0.3 } },
      roof: { colors: ["#34383e", "#464b52", "#5a6068", "#16181c"] },
      metal: { colors: ["#44484c", "#5e6368", "#7c8288", "#222528"], params: { rust: 0.3, wear: 0.3 } },
      wood: { colors: ["#3a2e26", "#4e3e33", "#665244", "#1a140f"] },
      planks: { colors: ["#3e3228", "#544436", "#6c5a48", "#140f0a"] },
      grass: { colors: ["#34402c", "#48563a", "#62704c", "#6a6a58"] },
      glow: { flat: "#ffd9a0", emissive: ["#ffcf8a", 0.4] },
      water: { colors: ["#1e282c", "#2e3a40", "#4a5a60", "#b8c4c8"], opacity: 0.9 },
    },
  }),

  orbital_base: S("orbital_base", "Station alloy", {
    tint: ["#7a90a8", 0.1], tile_mult: 0.8, roughness_add: -0.05,
    materials: {
      metal: { colors: ["#5a646e", "#7a8592", "#a2adb8", "#2e343a"], params: { panels: 4, wear: 0.45 }, roughness: 0.32 },
      stone: { colors: ["#6a7078", "#868c94", "#a4aab2", "#3a3e44"], generator: "metal", params: { panels: 3, rivets: false, wear: 0.3 }, metalness: 0.4 },
      plaster: { colors: ["#c8ced6", "#dce2e8", "#eef2f6", "#9aa2aa"], params: { wear: 0.2 } },
      roof: { colors: ["#4a5460", "#5e6a78", "#76828e", "#1e242a"], generator: "metal", params: { panels: 2 }, metalness: 0.6 },
      planks: { colors: ["#4a525a", "#5e6870", "#747e88", "#1a1e22"], generator: "metal", params: { panels: 6, rivets: false }, metalness: 0.55 },
      wood: { colors: ["#50585e", "#667078", "#7e8890", "#22262a"], generator: "metal", params: { panels: 3 }, metalness: 0.5 },
      rock: { colors: ["#5a5a5e", "#76767a", "#949498", "#2e2e32"], params: { cracks: 0.2 } },
      dirt: { colors: ["#5a5652", "#726c66", "#8c857c", "#8a8a8a"] },
      grass: { colors: ["#4a5a4a", "#5e705e", "#788a76", "#8a8a7a"] },
      glow: { flat: "#7ad8ff", emissive: ["#4ac8ff", 0.7] },
      cloth: { colors: ["#2e4a6a", "#3e6088", "#5a80a8", "#18263a"] },
    },
  }),

  crystal_hollow: S("crystal_hollow", "Geode glow", {
    tint: ["#5a4a7a", 0.14], tile_mult: 1, roughness_add: -0.03,
    materials: {
      rock: { colors: ["#2e2a3a", "#443e56", "#5e5676", "#16141e"], params: { cracks: 0.45, crack_color: "#8a6aff", crack_cells: 5 } },
      stone: { colors: ["#3e3a4e", "#565068", "#706a84", "#1e1c28"], params: { cracks: 0.3, crack_color: "#7a5ae0" } },
      dirt: { colors: ["#2e2632", "#40363e", "#564a52", "#5a5068"] },
      grass: { colors: ["#2a4a4a", "#3a6664", "#56887e", "#6a6a8a"] },
      sand: { colors: ["#5a5270", "#746a8a", "#8e86a4", "#3a3448"] },
      crystal: { flat: "#b89aff", emissive: ["#9a7aff", 0.7], emissive_intensity: 1.2 },
      glow: { flat: "#c8a8ff", emissive: ["#a080ff", 0.6] },
      water: { colors: ["#1a1a3a", "#2a2a5a", "#4a4a8a", "#c8c0f0"], opacity: 0.85 },
      leaves: { colors: ["#1e3a3a", "#2a5450", "#3e7468", "#0c1a1a"] },
    },
  }),

  oasis_flats: S("oasis_flats", "Palm and mudbrick", {
    tint: ["#e0b070", 0.1], tile_mult: 1.15, roughness_add: 0.02,
    materials: {
      sand: { colors: ["#c89a62", "#dcb47c", "#f0d09c", "#a07448"], params: { ripples: 10 } },
      grass: { colors: ["#4a7a2a", "#6a9a3a", "#94b85a", "#b8a060"] },
      plaster: { colors: ["#c89a6a", "#d8b084", "#e8c89e", "#a07a50"], params: { cracks: 0.25, wear: 0.2 } },
      stone: { colors: ["#b08a5e", "#c8a272", "#dcbc8c", "#7a5c3a"], params: { wear: 0.3 } },
      water: { colors: ["#0e6a78", "#1a8e9a", "#40b8bc", "#e0f6f2"], opacity: 0.8 },
      cloth: { colors: ["#a02a3a", "#c83e4e", "#e46272", "#5a1420"] },
      wood: { colors: ["#7a5a3a", "#94724e", "#b08e66", "#4a3422"], params: { wear: 0.4 } },
    },
  }),

  glacier_steps: S("glacier_steps", "Blue ice", {
    tint: ["#a8d0ec", 0.16], tile_mult: 1.1, roughness_add: -0.06,
    materials: {
      snow: { colors: ["#a4c4e0", "#cce0f2", "#eef6fc", "#ffffff"] },
      rock: { colors: ["#5a7a98", "#7a9ab8", "#a2c0da", "#2e4a64"], params: { frost: 0.5, cracks: 0.35, crack_color: "#1e4a7a" }, roughness: 0.35 },
      stone: { colors: ["#7a9ab4", "#98b6ce", "#bcd4e6", "#3e5a74"], params: { frost: 0.45 }, roughness: 0.4 },
      grass: { colors: ["#6a8a8a", "#88a6a6", "#a8c2c2", "#d0dce0"], params: { frost: 0.6 } },
      dirt: { colors: ["#5a6470", "#747e8a", "#909aa4", "#b4c0cc"], params: { frost: 0.4 } },
      water: { colors: ["#1e4e74", "#306a94", "#5a94bc", "#eaf6fc"], opacity: 0.9 },
      crystal: { flat: "#c8b0ff", emissive: ["#b388eb", 0.5] },
      wood: { tint: ["#7a8898", 0.3], params: { frost: 0.4 } },
    },
  }),

  obsidian_mesa: S("obsidian_mesa", "Glassy basalt", {
    tint: ["#2b2d42", 0.2], tile_mult: 1, roughness_add: -0.05,
    params: { grime: 0.3 },
    materials: {
      rock: { colors: ["#141418", "#24242c", "#3a3a46", "#08080a"], params: { cracks: 0.4, crack_color: "#ff8a1c", wear: 0.35 }, roughness: 0.4 },
      sand: { colors: ["#2a2628", "#3a3538", "#4e484c", "#18161a"] },
      dirt: { colors: ["#2e2a2c", "#403a3c", "#564e50", "#5c4d5a"] },
      stone: { colors: ["#26262e", "#3a3a44", "#50505c", "#101014"], params: { wear: 0.4 }, roughness: 0.45 },
      grass: { colors: ["#3a3830", "#4c4a3c", "#625e4a", "#5c4d5a"] },
      ember: { colors: ["#2a0804", "#b03a0c", "#ffa030"], emissive_intensity: 2 },
      metal: { colors: ["#2e2a2c", "#48423e", "#665e58", "#141212"], params: { rust: 0.25, rust_color: "#6a2a14" } },
      water: { colors: ["#4a1208", "#8a2a0e", "#d2452d", "#ffb070"], opacity: 0.95 },
      glow: { flat: "#ffb04a", emissive: ["#ff9f1c", 0.6] },
    },
  }),

  sandstone_steps: S("sandstone_steps", "Banded sandstone", {
    tint: ["#d0a070", 0.1], tile_mult: 1.2, roughness_add: 0.02,
    materials: {
      rock: { colors: ["#a86e46", "#c48a5c", "#dcaa7a", "#6a4028"], params: { strata: 17, wear: 0.25 } },
      stone: { colors: ["#c8a07a", "#dab896", "#eacdb0", "#8a6a4a"], params: { wear: 0.35, cracks: 0.2 } },
      sand: { colors: ["#caa072", "#dcb68a", "#eccca4", "#a07a50"], params: { ripples: 8 } },
      dirt: { colors: ["#9a6a44", "#b28258", "#c89c72", "#b0a08a"] },
      plaster: { colors: ["#d6b490", "#e4c8a8", "#f0dcc2", "#b08e6a"], params: { cracks: 0.3 } },
      grass: { colors: ["#6a7036", "#848a44", "#a0a458", "#a8865a"] },
      cloth: { colors: ["#4a3a8a", "#5e4fbb", "#8070d4", "#2a1e5a"] },
    },
  }),

  overgrown_temple: S("overgrown_temple", "Jungle-swallowed stone", {
    tint: ["#3f7d3a", 0.12], tile_mult: 1, roughness_add: -0.01,
    params: { moss: 0.3 },
    materials: {
      stone: { colors: ["#6a6a58", "#848470", "#a0a08a", "#3a3a2e"], params: { moss: 0.65, moss_color: "#3f7d3a", cracks: 0.35 } },
      rock: { colors: ["#4a4c3e", "#646856", "#828670", "#262820"], params: { moss: 0.55, moss_color: "#3a7034" } },
      plaster: { colors: ["#a09a7a", "#b8b292", "#ccc6a8", "#6e6a52"], params: { moss: 0.5, cracks: 0.4 } },
      grass: { colors: ["#24561e", "#35742a", "#56963c", "#7a8a4a"] },
      leaves: { colors: ["#143e14", "#1e5a1e", "#34802e", "#08200a"] },
      dirt: { colors: ["#3e2e1e", "#56402a", "#70583a", "#6a6a52"], params: { wet: 0.3 } },
      water: { colors: ["#12463e", "#1e6458", "#3a8c7c", "#c8eadc"], opacity: 0.86 },
      brass: { tint: ["#c8a030", 0.3] },
      glow: { flat: "#f0d060", emissive: ["#e8c547", 0.5] },
    },
  }),

  hillside_town: S("hillside_town", "Terracotta and whitewash", {
    tint: ["#e0c8a0", 0.06], tile_mult: 1, roughness_add: 0,
    materials: {
      roof: { colors: ["#9a3a26", "#b8502e", "#d06c44", "#3e160c"] },
      plaster: { colors: ["#e6dcc6", "#f0e8d6", "#faf6ec", "#c8b89a"], params: { wear: 0.15, grime: 0.15 } },
      stone: { colors: ["#9a8e7a", "#b4a892", "#ccc2ac", "#5e5648"], params: { wear: 0.3 } },
      grass: { colors: ["#4a6a2a", "#628a36", "#86aa4c", "#a8a060"] },
      wood: { colors: ["#6a4a2e", "#86603c", "#a07a52", "#3a2616"] },
      planks: { colors: ["#6e4e30", "#8a6640", "#a88258", "#261a0e"] },
      cloth: { colors: ["#1e4a98", "#2e6fd8", "#5a94ec", "#0e2658"] },
      leaves: { colors: ["#244a1a", "#356a26", "#528c3a", "#10240c"] },
    },
  }),
});

/** Theme → style id: the theme's own `material_style`, else its id, else the default. */
export function styleIdFor(theme) {
  const want = theme?.material_style || theme?.id;
  return want && MATERIAL_STYLES[want] ? want : DEFAULT_STYLE_ID;
}

/**
 * The concrete style a game gets: a deep copy of the preset plus a small
 * per-recipe variant (seed % 4), so games of one theme share most textures in
 * the content cache but are not all identical.
 */
export function resolveStyle(theme, recipe = {}) {
  const id = styleIdFor(theme);
  const preset = MATERIAL_STYLES[id];
  const variant = (Number.isInteger(recipe?.seed) ? Math.abs(recipe.seed) : 0) % 4;
  return {
    ...JSON.parse(JSON.stringify(preset)),
    style_version: MATERIAL_STYLE_VERSION,
    variant,
    seed_offset: (preset.seed_offset + variant * 7919) % 1000003,
  };
}

/** Concept patch (CONTRACT §3): sets the optional concept.material_style. Never throws. */
export function materialConceptPatch(concept, ctx) {
  try {
    const theme = ctx?.theme || null;
    const want = theme?.material_style || theme?.id || null;
    if (want && !MATERIAL_STYLES[want]) ctx?.notes?.push?.(`material style '${want}' unknown; used '${DEFAULT_STYLE_ID}'`);
    return { ...concept, material_style: resolveStyle(theme, ctx?.recipe) };
  } catch (e) {
    ctx?.notes?.push?.(`material style skipped: ${e.message}`);
    return concept;
  }
}
