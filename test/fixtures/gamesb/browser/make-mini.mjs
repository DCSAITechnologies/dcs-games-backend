// Generates mini.package.json: a tiny, hand-authored GamePackage (contract §7)
// the browser runtime is developed and tested against before — and independently
// of — the real pipeline. Everything is written from the contract, so if this
// fixture stops validating it is the fixture (or the contract) that moved.
//
//   node test/fixtures/gamesb/browser/make-mini.mjs
//
// Deterministic: re-running it rewrites the same bytes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256, sha256Json, promptHash } from "../../../../src/gamesb/common/hash.mjs";
import { rng } from "../../../../src/gamesb/common/rng.mjs";
import { buildColliders, containsXZ } from "../../../../src/gamesb/world/collision.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAME = "mini";
const PROMPT = "A tiny harbour on a dusk island: talk to the keeper, find the lantern core, light the beacon.";
const AT = "2026-09-28T00:00:00.000Z";

// ---- terrain -----------------------------------------------------------------
const SIZE = 160, CELL = 4, COLS = SIZE / CELL + 1, ROWS = COLS;
const r = rng(7);
const noise = Array.from({ length: COLS * ROWS }, () => r());
const heights = [];
for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
  const x = i * CELL, z = j * CELL;
  const d = Math.hypot(x - 80, z - 80) / 70;
  const island = 9 * Math.max(0, 1 - d * d) - 2.5;
  const hill = 10 * Math.exp(-((x - 108) ** 2 + (z - 56) ** 2) / 500);
  const flat = Math.exp(-((x - 62) ** 2 + (z - 96) ** 2) / 300);          // the hub is levelled
  let h = island + hill + (noise[j * COLS + i] - 0.5) * 0.6;
  h = h * (1 - flat) + 2.2 * flat;
  heights.push(Math.round(h * 100) / 100);
}
const hAt = (x, z) => {
  const fx = Math.max(0, Math.min(COLS - 1.001, x / CELL)), fz = Math.max(0, Math.min(ROWS - 1.001, z / CELL));
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const a = heights[j * COLS + i], b = heights[j * COLS + i + 1], c = heights[(j + 1) * COLS + i], e = heights[(j + 1) * COLS + i + 1];
  return Math.round(((a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz) * 100) / 100;
};
const P = (x, z) => ({ x, y: hAt(x, z), z });

// ---- assets ------------------------------------------------------------------
const records = [];
function rec(kind, ref, format, payload, extra = {}) {
  const asset_id = "ast_" + sha256Json({ kind, payload }).slice(0, 16);
  const record = {
    asset_record_version: "1.0.0", asset_id, ref, kind, name: ref.replace(/^\w+:/, ""),
    provider: "local:procedural", model: "deterministic", prompt: null, prompt_hash: sha256Json(payload),
    version: 1, source: "procedural", cost_usd: 0, latency_ms: 0, format,
    dimensions: extra.dimensions ?? null, bytes: canonicalJson(payload).length, sha256: sha256Json(payload),
    game_bindings: [{ game_id: GAME, refs: extra.bindings || [] }],
    provenance: { generated_at: AT, lane: "assets", adapter: "local:procedural", status: "FALLBACK", after_failed: [],
      license: { spdx: "CC0-1.0", commercial_use: "cleared" } },
    payload, uri: null,
  };
  records.push(record);
  return record;
}
const tex = (name, generator, colors, size = 128) =>
  rec("texture", `tex:${name}_albedo`, "texture-recipe", { generator, size, seed: 11, colors, scale: 1, params: {} }, { dimensions: { px_w: size, px_h: size } });
const mat = (name, color, o = {}) => {
  const t = o.gen ? tex(name, o.gen, o.colors || [color]) : null;
  return rec("material", `mat:${name}`, "material", {
    material_id: `mat:${name}`, ...(t ? { albedo_texture: t.asset_id } : {}), color, roughness: o.roughness ?? 0.85, metalness: o.metalness ?? 0,
    emissive: o.emissive ?? null, emissive_intensity: o.emissive_intensity ?? 0, transparent: !!o.transparent, opacity: o.opacity ?? 1,
    repeat: o.repeat || { u: 1, v: 1 }, double_sided: !!o.double_sided,
  });
};
mat("grass", "#5d7a3a", { gen: "grass", colors: ["#4f6e32", "#6d8c45", "#3f5a28"], repeat: { u: 8, v: 8 } });
mat("sand", "#c9b48a", { gen: "sand", colors: ["#d2bf95", "#b9a47a"] });
mat("rock", "#6b6b70", { gen: "rock", colors: ["#6d6c72", "#55545a", "#85848a"] });
mat("dirt", "#6a5238", { gen: "dirt", colors: ["#6a5238", "#57432e"] });
mat("stone", "#8a8580", { gen: "stone_tiles", colors: ["#8a8580", "#6f6a66"] });
mat("wood", "#6b4a2f", { gen: "planks", colors: ["#6b4a2f", "#5a3d26"] });
mat("planks", "#7a5a3a", { gen: "planks", colors: ["#7a5a3a", "#634829"] });
mat("roof", "#7a3b2e", { gen: "roof_tiles", colors: ["#7a3b2e", "#5e2c22"] });
mat("plaster", "#d8cdb8", { gen: "plaster", colors: ["#d8cdb8", "#c4b8a2"] });
mat("leaves", "#3f6b35", { gen: "leaves", colors: ["#3f6b35", "#2f5528"] });
mat("bark", "#4a3627", { gen: "bark", colors: ["#4a3627", "#3a2a1e"] });
mat("brass", "#b08d3c", { metalness: 0.8, roughness: 0.35 });
mat("cloth", "#3d4f6e", { gen: "cloth", colors: ["#3d4f6e", "#34445f"] });
mat("glow", "#ffb347", { emissive: "#ffa030", emissive_intensity: 2.5, roughness: 0.4 });
mat("ember", "#ff7a2a", { emissive: "#ff6a1a", emissive_intensity: 2, roughness: 0.5 });
mat("crystal", "#7fd6ff", { emissive: "#3aa8ff", emissive_intensity: 1.2, roughness: 0.2, transparent: true, opacity: 0.85 });
mat("water", "#2a5a78", { transparent: true, opacity: 0.8, roughness: 0.1 });

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
const part = (shape, material_ref, position, o = {}) => ({ shape, material_ref, position, rotation: V(), ...o });
const mesh = (kind, ref, bounds, parts, extra = {}) =>
  rec(kind, ref, "mesh-recipe", { builder: "parts", bounds, parts, ...(extra.rig ? { rig: extra.rig } : {}) }, { dimensions: { w: bounds.w, h: bounds.h, d: bounds.d } });

mesh("structure", "lib:cottage", { w: 8, h: 6.5, d: 6 }, [
  part("box", "mat:stone", V(0, 0.3, 0), { size: V(8.2, 0.6, 6.2) }),
  part("box", "mat:plaster", V(0, 2.1, 0), { size: V(8, 3.2, 6) }),
  part("extrude", "mat:roof", V(0, 3.7, 3.3), { outline: [[-4.4, 0], [4.4, 0], [0, 0]], depth: 6.6, rotation: V(Math.PI / 2, 0, 0) }),
  part("box", "mat:roof", V(-2.2, 4.9, 0), { size: V(5.2, 0.25, 6.8), rotation: V(0, 0, 0.5) }),
  part("box", "mat:roof", V(2.2, 4.9, 0), { size: V(5.2, 0.25, 6.8), rotation: V(0, 0, -0.5) }),
  part("box", "mat:wood", V(0, 1.4, 3.02), { size: V(1.2, 2.2, 0.12) }),
  part("box", "mat:glow", V(-2.5, 2.4, 3.02), { size: V(1, 0.9, 0.08), emissive: true }),
  part("box", "mat:glow", V(2.5, 2.4, 3.02), { size: V(1, 0.9, 0.08), emissive: true }),
  part("box", "mat:stone", V(2.8, 5.2, -1.2), { size: V(0.8, 2.2, 0.8) }),
]);
mesh("structure", "lib:lantern_post", { w: 0.6, h: 3.2, d: 0.6 }, [
  part("cylinder", "mat:wood", V(0, 1.4, 0), { radius_top: 0.08, radius_bottom: 0.12, height: 2.8, segments: 8 }),
  part("box", "mat:brass", V(0, 2.85, 0), { size: V(0.35, 0.08, 0.35) }),
  part("sphere", "mat:glow", V(0, 3.05, 0), { radius: 0.16, emissive: true, cast_shadow: false }),
  part("cone", "mat:brass", V(0, 3.3, 0), { radius: 0.24, height: 0.22, segments: 8 }),
]);
mesh("structure", "lib:beacon_brazier", { w: 2.4, h: 4, d: 2.4 }, [
  part("lathe", "mat:stone", V(0, 0, 0), { profile: [[1.2, 0], [1.1, 0.4], [0.6, 0.6], [0.5, 2.4], [0.9, 2.8], [1.1, 3.2], [0.01, 3.2]], segments: 12 }),
  part("torus", "mat:brass", V(0, 3.2, 0), { radius: 1.0, tube: 0.1, segments: 16, rotation: V(Math.PI / 2, 0, 0) }),
  part("icosphere", "mat:ember", V(0, 3.4, 0), { radius: 0.45, detail: 1, noise: 0.15, seed: 3, emissive: true, cast_shadow: false }),
]);
mesh("structure", "lib:ruin_arch", { w: 6, h: 5, d: 1.2 }, [
  part("box", "mat:stone", V(-2.4, 2, 0), { size: V(1.1, 4, 1.1) }),
  part("box", "mat:stone", V(2.4, 1.5, 0), { size: V(1.1, 3, 1.1) }),
  part("torus", "mat:stone", V(0, 4, 0), { radius: 2.4, tube: 0.45, segments: 12 }),
  part("rock", "mat:rock", V(1.6, 0.3, 1), { radius: 0.6, detail: 1, noise: 0.3, seed: 5 }),
]);
mesh("prop", "lib:signpost", { w: 1, h: 2.2, d: 0.2 }, [
  part("cylinder", "mat:wood", V(0, 1, 0), { radius: 0.07, height: 2, segments: 6 }),
  part("box", "mat:planks", V(0.3, 1.7, 0), { size: V(0.9, 0.3, 0.06) }),
]);
mesh("foliage", "lib:pine_tree", { w: 3, h: 7, d: 3 }, [
  part("cylinder", "mat:bark", V(0, 1.2, 0), { radius_top: 0.12, radius_bottom: 0.22, height: 2.4, segments: 7 }),
  part("cone", "mat:leaves", V(0, 2.8, 0), { radius: 1.6, height: 2.6, segments: 8 }),
  part("cone", "mat:leaves", V(0, 4.2, 0), { radius: 1.2, height: 2.2, segments: 8 }),
  part("cone", "mat:leaves", V(0, 5.5, 0), { radius: 0.8, height: 1.8, segments: 8 }),
]);
mesh("foliage", "lib:rock_small", { w: 1.2, h: 0.8, d: 1.2 }, [
  part("rock", "mat:rock", V(0, 0.2, 0), { radius: 0.6, detail: 1, noise: 0.35, seed: 9, size: V(1, 0.7, 1) }),
]);
mesh("foliage", "lib:grass_tuft", { w: 0.6, h: 0.5, d: 0.6 }, [
  part("cone", "mat:grass", V(0, 0.25, 0), { radius: 0.25, height: 0.5, segments: 5, cast_shadow: false }),
  part("cone", "mat:grass", V(0.15, 0.2, 0.1), { radius: 0.15, height: 0.4, segments: 5, cast_shadow: false }),
]);
const core = mesh("prop", "lib:lantern_core", { w: 0.6, h: 0.9, d: 0.6 }, [
  part("icosphere", "mat:crystal", V(0, 0.45, 0), { radius: 0.28, detail: 0, emissive: true }),
  part("torus", "mat:brass", V(0, 0.45, 0), { radius: 0.33, tube: 0.03, segments: 16 }),
  part("cylinder", "mat:brass", V(0, 0.1, 0), { radius: 0.12, height: 0.12, segments: 8 }),
]);

// Characters: rig joints are pivots; each part names the joint it hangs from.
const biped = (ref, pal, h = 1.75) => mesh("npc", ref, { w: 0.6, h, d: 0.4 }, [
  part("capsule", pal.primary, V(0, 1.2, 0), { radius: 0.24, height: 0.55, joint: "spine" }),
  part("sphere", pal.skin, V(0, 1.68, 0), { radius: 0.15, joint: "head" }),
  part("cone", pal.secondary, V(0, 1.85, 0), { radius: 0.2, height: 0.25, joint: "head" }),
  part("capsule", pal.primary, V(-0.3, 1.2, 0), { radius: 0.07, height: 0.45, joint: "arm_l" }),
  part("capsule", pal.primary, V(0.3, 1.2, 0), { radius: 0.07, height: 0.45, joint: "arm_r" }),
  part("capsule", pal.secondary, V(-0.11, 0.45, 0), { radius: 0.09, height: 0.6, joint: "leg_l" }),
  part("capsule", pal.secondary, V(0.11, 0.45, 0), { radius: 0.09, height: 0.6, joint: "leg_r" }),
], { rig: { kind: "biped", joints: {
  spine: { parent: null, pivot: V(0, 0.9, 0) }, head: { parent: "spine", pivot: V(0, 1.55, 0) },
  arm_l: { parent: "spine", pivot: V(-0.3, 1.45, 0) }, arm_r: { parent: "spine", pivot: V(0.3, 1.45, 0) },
  leg_l: { parent: null, pivot: V(-0.11, 0.85, 0) }, leg_r: { parent: null, pivot: V(0.11, 0.85, 0) },
} } });
const maren = biped("char:keeper_maren", { primary: "mat:cloth", secondary: "mat:wood", skin: "mat:plaster" });
const ember = mesh("creature", "char:ember", { w: 0.4, h: 0.6, d: 0.8 }, [
  part("capsule", "mat:ember", V(0, 0.35, 0), { radius: 0.14, height: 0.35, rotation: V(Math.PI / 2, 0, 0), joint: "body", emissive: true }),
  part("sphere", "mat:ember", V(0, 0.5, 0.3), { radius: 0.13, joint: "head", emissive: true }),
  part("cone", "mat:ember", V(0, 0.4, -0.4), { radius: 0.08, height: 0.4, rotation: V(-Math.PI / 2, 0, 0), joint: "tail" }),
], { rig: { kind: "quadruped", joints: {
  body: { parent: null, pivot: V(0, 0.35, 0) }, head: { parent: "body", pivot: V(0, 0.45, 0.25) }, tail: { parent: "body", pivot: V(0, 0.4, -0.2) },
} } });
const iconSvg = (fill) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 6 L54 32 L32 58 L10 32 Z" fill="${fill}" stroke="#fff" stroke-width="3"/></svg>` });
const icon2 = rec("icon", "icon:item_2", "svg", iconSvg("#6fd0b0"), { dimensions: { px_w: 64, px_h: 64 } });
const icon3 = rec("icon", "icon:item_3", "svg", iconSvg("#d06f9a"), { dimensions: { px_w: 64, px_h: 64 } });
const icon = rec("icon", "icon:item_1", "svg", { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="18" fill="#7fd6ff" stroke="#b08d3c" stroke-width="4"/><circle cx="32" cy="32" r="7" fill="#fff"/></svg>' }, { dimensions: { px_w: 64, px_h: 64 } });
rec("sky", "sky:main", "json", { top: "#1d2a4a", horizon: "#e08a4c", bottom: "#3a3040" });

// ---- world -------------------------------------------------------------------
const place = (id, asset_ref, region, pos, role, collider, rot = 0, scale = 1, tags = []) =>
  ({ id, asset_ref, region, position: pos, rotation_y: rot, scale, role, collider, tags });
const none = { shape: "none", solid: false };
const regions = [
  { id: "region_harbour", name: "Harbour", kind: "district", bounds: [40, 70, 90, 120], center: P(62, 96), location_ref: "harbour" },
  { id: "region_beacon_hill", name: "Beacon Hill", kind: "landmark", bounds: [90, 36, 130, 80], center: P(108, 56), location_ref: "beacon_hill" },
];
const placements = [
  place("pl_cottage", "lib:cottage", "region_harbour", P(72, 108), "structure", { shape: "box", size: V(8, 6, 6), solid: true }),
  place("pl_post_1", "lib:lantern_post", "region_harbour", P(66, 92), "decor", { shape: "cylinder", radius: 0.3, height: 3.2, solid: true }),
  place("pl_post_2", "lib:lantern_post", "region_harbour", P(84, 84), "decor", { shape: "cylinder", radius: 0.3, height: 3.2, solid: true }),
  place("pl_sign", "lib:signpost", "region_harbour", P(58, 90), "interactable", none),
  place("pl_arch", "lib:ruin_arch", "region_beacon_hill", P(100, 66), "landmark", { shape: "box", size: V(6, 5, 1.2), solid: false }, 0.6),
  place("pl_beacon", "lib:beacon_brazier", "region_beacon_hill", P(108, 54), "interactable", { shape: "cylinder", radius: 1.2, height: 4, solid: true }),
  place("pl_pickup_1", "lib:lantern_core", "region_beacon_hill", P(96, 70), "pickup", none),
  place("pl_pickup_2", "lib:lantern_core", "region_beacon_hill", P(118, 64), "pickup", none),
  place("pl_pickup_3", "lib:lantern_core", "region_beacon_hill", P(104, 44), "pickup", none),
];
const scatter = [
  { id: "sc_pines", asset_ref: "lib:pine_tree", region: null, count: 40, min_scale: 0.8, max_scale: 1.3, seed: 21, avoid_paths: true, collider_radius: 0.4 },
  { id: "sc_rocks", asset_ref: "lib:rock_small", region: null, count: 30, min_scale: 0.6, max_scale: 1.6, seed: 22, avoid_paths: false, collider_radius: 0 },
  { id: "sc_grass", asset_ref: "lib:grass_tuft", region: "region_harbour", count: 60, min_scale: 0.7, max_scale: 1.4, seed: 23, avoid_paths: true, collider_radius: 0 },
];
const navCols = SIZE / CELL, navRows = navCols;
let walkable = "";
for (let j = 0; j < navRows; j++) for (let i = 0; i < navCols; i++) walkable += hAt(i * CELL + CELL / 2, j * CELL + CELL / 2) > 0.4 ? "1" : "0";

const world = {
  world_spec_version: "1.0.0", id: "mini_world", title: "Mini Harbour", seed: 7, size: { w: SIZE, h: SIZE }, biome: "island",
  environment: {
    time_of_day: 0.78, weather: "cloudy",
    sky: { top: "#1d2a4a", horizon: "#e08a4c", bottom: "#3a3040" },
    fog: { color: "#6a5a66", near: 40, far: 220 },
    sun: { azimuth_deg: 250, elevation_deg: 14, color: "#ffb070", intensity: 2.2, shadows: true },
    ambient: { color: "#8fa0c8", ground_color: "#4a3a30", intensity: 0.7 },
    water: { enabled: true, level: 0, color: "#2a5a78", opacity: 0.82 },
  },
  terrain: {
    kind: "heightfield", shape: "island", cols: COLS, rows: ROWS, cell: CELL, heights,
    min_y: Math.min(...heights), max_y: Math.max(...heights),
    material_layers: [
      { material_ref: "mat:sand", min_h: -10, max_h: 1.0, max_slope_deg: 90 },
      { material_ref: "mat:grass", min_h: 1.0, max_h: 9, max_slope_deg: 28 },
      { material_ref: "mat:dirt", min_h: 9, max_h: 100, max_slope_deg: 32 },
      { material_ref: "mat:rock", min_h: -10, max_h: 100, max_slope_deg: 90 },
    ],
  },
  regions,
  paths: [{ id: "path_hub_hill", from_region: "region_harbour", to_region: "region_beacon_hill", width: 3, points: [{ x: 62, z: 96 }, { x: 84, z: 80 }, { x: 108, z: 58 }] }],
  placements, scatter,
  spawn_points: [
    { id: "spawn_player", kind: "player", position: P(62, 98), rotation_y: 0, region: "region_harbour" },
    { id: "spawn_npc_keeper_maren", kind: "npc", position: P(66, 100), rotation_y: Math.PI, region: "region_harbour" },
    { id: "spawn_npc_ember", kind: "npc", position: P(60, 99), rotation_y: 0, region: "region_harbour" },
    { id: "spawn_cp_region_beacon_hill", kind: "checkpoint", position: P(98, 72), rotation_y: 0, region: "region_beacon_hill" },
  ],
  camera: { mode: "third_person", distance: 7, height: 2.6, fov: 60, min_pitch: -0.3, max_pitch: 1.2, collide: true },
  interactables: [
    { id: "ix_harbour", placement_ref: "pl_sign", kind: "sign", radius: 2.5, prompt: "Read the harbour sign" },
    { id: "ix_beacon_hill", placement_ref: "pl_beacon", kind: "lantern", radius: 3, prompt: "Light the beacon", locked_by: "item_1" },
    { id: "pickup_1", placement_ref: "pl_pickup_1", kind: "pickup", radius: 2, prompt: "Take the lantern core", item_ref: "item_1" },
    { id: "pickup_2", placement_ref: "pl_pickup_2", kind: "pickup", radius: 2, prompt: "Pick up the sea glass", item_ref: "item_2" },
    { id: "pickup_3", placement_ref: "pl_pickup_3", kind: "pickup", radius: 2, prompt: "Pick up the rose shell", item_ref: "item_3" },
    { id: "ix_talk_keeper_maren", placement_ref: null, kind: "talk", radius: 3, prompt: "Talk to Keeper Maren", character_ref: "keeper_maren" },
    { id: "ix_talk_ember", placement_ref: null, kind: "talk", radius: 2.5, prompt: "Talk to Ember", character_ref: "ember" },
  ],
  navigation: { cell: CELL, cols: navCols, rows: navRows, max_slope_deg: 40, step_height: 0.5, walkable },
};

// Nav cells inside a solid (grown by a player radius) are not walkable — the
// same rule the world stage bakes by, so the package validator accepts it.
{
  const cells = world.navigation.walkable.split("");
  for (const c of buildColliders(world)) {
    for (let j = 0; j < navRows; j++) for (let i = 0; i < navCols; i++) {
      if (containsXZ(c, (i + 0.5) * CELL, (j + 0.5) * CELL, 0.45)) cells[j * navCols + i] = "0";
    }
  }
  world.navigation.walkable = cells.join("");
}

const concept = {
  concept_version: "1.0.0", title: "Mini Harbour", logline: "Light the beacon before dark.",
  source_prompt: PROMPT, prompt_hash: promptHash(PROMPT), seed: 7, genre: "adventure", biome: "island", scale: "small",
  mood: "hushed dusk", time_of_day: 0.78, weather: "cloudy",
  palette: { primary: "#e08a4c", secondary: "#3d4f6e", accent: "#ffb347", ground: "#5d7a3a", sky: "#1d2a4a", water: "#2a5a78" },
  player_fantasy: "The traveller who brings the light back.",
  key_locations: [
    { id: "harbour", name: "Harbour", kind: "hub", description: "A cottage and a sign by the water." },
    { id: "beacon_hill", name: "Beacon Hill", kind: "tower", description: "The unlit beacon." },
  ],
  characters: [
    { id: "keeper_maren", name: "Keeper Maren", role: "quest_giver", description: "Keeps the lights." },
    { id: "ember", name: "Ember", role: "companion", description: "A little fox spirit." },
  ],
  objectives_outline: ["Talk to Keeper Maren", "Find the lantern core", "Light the beacon"], hazards: [],
};

const characters = {
  character_spec_version: "1.0.0",
  characters: [
    { id: "keeper_maren", name: "Keeper Maren", role: "quest_giver", kind: "humanoid",
      body: { height: 1.75, build: "average", palette: { skin: "#e0b89a", primary: "#3d4f6e", secondary: "#6b4a2f", accent: "#ffb347" }, accessories: ["hood", "lantern"] },
      asset_ref: "char:keeper_maren", spawn_ref: "spawn_npc_keeper_maren",
      behavior: { initial: "idle", patrol: [], wander_radius: 0, speed: 1.2, sight_radius: 8, hostile: false, leash_radius: 10 },
      dialogue_ref: "dlg_keeper_maren", interaction_radius: 3, companion: false, invulnerable: true },
    { id: "ember", name: "Ember", role: "companion", kind: "spirit",
      body: { height: 0.6, build: "slim", palette: { skin: "#ff7a2a", primary: "#ff7a2a", secondary: "#ffd0a0", accent: "#ffffff" }, accessories: [] },
      asset_ref: "char:ember", spawn_ref: "spawn_npc_ember",
      behavior: { initial: "follow_player", patrol: [], wander_radius: 3, speed: 4.5, sight_radius: 30, hostile: false, leash_radius: 40 },
      dialogue_ref: "dlg_ember", interaction_radius: 2.5, companion: true, invulnerable: true },
  ],
  dialogues: [{
    id: "dlg_ember", character_ref: "ember", entry: [{ node: "hi", conditions: [] }],
    nodes: [{ id: "hi", speaker: "ember", text: "*Ember's tail flickers towards the hill.*", choices: [{ text: "Lead on.", next: null }] }],
  }, {
    id: "dlg_keeper_maren", character_ref: "keeper_maren",
    entry: [{ node: "done", conditions: [{ kind: "objective_state", ref: "obj_light", value: "done" }] }, { node: "greet", conditions: [] }],
    nodes: [
      { id: "greet", speaker: "keeper_maren", text: "The beacon on the hill is dark. Bring it a lantern core, would you?",
        choices: [{ text: "I'll find one.", next: "thanks", actions: [{ kind: "set_flag", ref: "accepted", value: true }] }, { text: "Not now.", next: null }] },
      { id: "thanks", speaker: "keeper_maren", text: "Look near the old arch. Ember will follow you.", choices: [{ text: "Goodbye.", next: null }] },
      { id: "done", speaker: "keeper_maren", text: "The light is back. Thank you, traveller.", choices: [{ text: "Goodbye.", next: null }] },
    ],
  }],
};

const gameplay = {
  gameplay_version: "1.0.0", game_type: "adventure",
  rules: { player_health: 100, lives: 3, fall_damage: false, fall_y: -12, time_limit_s: 1200 },
  movement: { walk_speed: 4, run_speed: 7, jump_velocity: 6, gravity: -18, max_slope_deg: 40, step_height: 0.5, air_control: 0.3, player_radius: 0.35, player_height: 1.8 },
  camera: { mode: "third_person", distance: 7, height: 2.6, fov: 60, sensitivity: 1 },
  interaction: { radius: 2.5, key: "KeyE", hold_ms: 0 },
  inventory: { slots: 8, items: [
    { id: "item_1", name: "Lantern Core", kind: "quest", stackable: false, max_stack: 1, icon_ref: icon.asset_id },
    { id: "item_2", name: "Sea Glass", kind: "collectible", stackable: true, max_stack: 9, icon_ref: icon2.asset_id },
    { id: "item_3", name: "Rose Shell", kind: "collectible", stackable: true, max_stack: 9, icon_ref: icon3.asset_id },
  ] },
  objectives: [
    { id: "obj_talk", title: "Speak with Keeper Maren", description: "She waits by the cottage.", kind: "talk", target_ref: "keeper_maren", count: 1, requires: [], optional: false, reward: { xp: 10 } },
    { id: "obj_core", title: "Find the lantern core", description: "Near the old arch.", kind: "collect", target_ref: "item_1", count: 1, requires: ["obj_talk"], optional: false, reward: { xp: 20 } },
    { id: "obj_glass", title: "Find the sea glass", description: "Optional: somewhere on the hill.", kind: "collect", target_ref: "item_2", count: 1, requires: [], optional: true, reward: { xp: 5 } },
    { id: "obj_light", title: "Light the beacon", description: "On Beacon Hill.", kind: "activate", target_ref: "ix_beacon_hill", count: 1, requires: ["obj_core"], optional: false, reward: { xp: 50 } },
  ],
  events: [
    { id: "ev_start", once: true, trigger: { kind: "game_start" }, actions: [{ kind: "message", value: "The beacon is dark. Find Keeper Maren." }] },
    { id: "ev_core", once: true, trigger: { kind: "objective_complete", ref: "obj_core" }, actions: [{ kind: "message", value: "The core hums in your pack." }] },
  ],
  combat: { enabled: false, mode: "none", player_damage: 0, hazard_damage_per_s: 0 },
  hazards: [],
  progression: { xp_per_level: 100, max_level: 5 },
  difficulty: { level: "normal", damage_mult: 1, speed_mult: 1, time_mult: 1 },
  checkpoints: [{ id: "cp_hill", spawn_ref: "spawn_cp_region_beacon_hill", trigger: { kind: "enter_region", ref: "region_beacon_hill" } }],
  win_conditions: [{ kind: "all_required_objectives" }],
  lose_conditions: [{ kind: "health_zero" }, { kind: "lives_zero" }, { kind: "time_expired" }],
};

// ---- scene graph -------------------------------------------------------------
const nodes = [];
const node = (id, type, parent, fields = {}) => nodes.push({ id, type, parent, ...fields });
const env = world.environment;
node("root", "root", null);
node("env", "environment", "root");
node("sky", "sky", "env", { ...env.sky });
const el = env.sun.elevation_deg * Math.PI / 180, az = env.sun.azimuth_deg * Math.PI / 180;
node("sun", "sun_light", "env", { color: env.sun.color, intensity: env.sun.intensity, direction: { x: -Math.cos(el) * Math.sin(az), y: -Math.sin(el), z: -Math.cos(el) * Math.cos(az) }, shadows: true });
node("ambient", "ambient_light", "env", { color: env.ambient.color, ground_color: env.ambient.ground_color, intensity: env.ambient.intensity });
node("fog", "fog", "env", { ...env.fog });
node("water", "water", "env", { level: 0, color: env.water.color, opacity: env.water.opacity, size: { w: SIZE, h: SIZE } });
node("terrain", "terrain", "root", { terrain_ref: "world.terrain", material_layers: world.terrain.material_layers });
node("camera", "camera_rig", "root", { mode: "third_person", distance: 7, height: 2.6, fov: 60, min_pitch: -0.3, max_pitch: 1.2 });
node("nav", "nav_grid", "root", { nav_ref: "world.navigation" });
for (const rg of regions) node(`node_${rg.id}`, "region", "root", { region_ref: rg.id, bounds: rg.bounds });
for (const pl of placements) node(`node_${pl.id}`, "mesh_instance", `node_${pl.region}`, { asset_ref: pl.asset_ref, placement_ref: pl.id, transform: { position: pl.position, rotation_y: pl.rotation_y, scale: pl.scale } });
for (const sc of scatter) node(`node_${sc.id}`, "instanced_group", "root", { asset_ref: sc.asset_ref, scatter_ref: sc.id, count: sc.count });
for (const sp of world.spawn_points) node(`node_${sp.id}`, "spawn", "root", { spawn_ref: sp.id, kind: sp.kind, transform: { position: sp.position, rotation_y: sp.rotation_y, scale: 1 } });
for (const c of characters.characters) node(`node_char_${c.id}`, "character", "root", { character_ref: c.id, asset_ref: c.asset_ref, spawn_ref: c.spawn_ref });
void maren; void ember;
for (const ix of world.interactables) node(`node_${ix.id}`, "interactable", "root", { interactable_ref: ix.id, placement_ref: ix.placement_ref, radius: ix.radius, prompt: ix.prompt });

const pkg = {
  package_version: "1.0.0", game_id: GAME, version: 1, title: "Mini Harbour", created_at: AT,
  concept, world, scene: { scene_graph_version: "1.0.0", world_id: world.id, nodes },
  assets: { records }, gameplay, characters,
  hooks: { edit: { ops: ["move_placement", "recolor_material"] }, expand: { ops: ["add_region"] }, companion: { character_ref: "ember", knowledge: ["The beacon needs a lantern core."] } },
  provenance: { pipeline_version: "gamesb-1.0.0", prompt_hash: promptHash(PROMPT), stages: [
    { stage: "concept", lane: "fixture", provider: "hand-authored", model: "none", status: "FALLBACK", latency_ms: 0, cost_usd: 0, at: AT },
  ] },
};
pkg.integrity = { sha256: sha256(canonicalJson(pkg)) };
fs.writeFileSync(path.join(HERE, "mini.package.json"), JSON.stringify(pkg));
console.log("wrote mini.package.json", records.length, "records");
