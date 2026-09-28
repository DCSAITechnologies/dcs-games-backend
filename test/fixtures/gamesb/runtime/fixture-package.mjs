// A small, hand-authored GamePackage for the runtime tests.
//
// 80 x 80 m, three regions, a steep plateau (slope limit), a deep-water pit
// (drowning), a solid hut (collision), a key pickup, a locked chest, a talk NPC
// with a two-node dialogue and a patrolling sentinel. Small enough to reason
// about by hand, and it exercises every sim-core path the unit tests need.

import { sha256Json } from "../../../../src/gamesb/common/hash.mjs";

const CELL = 2, COLS = 41, ROWS = 41, SIZE = 80;

function heightAtCell(i, j) {
  if (i >= 30 && i <= 34 && j >= 5 && j <= 9) return 12;     // plateau at x 60–68, z 10–18
  if (i >= 4 && i <= 7 && j >= 30 && j <= 35) return -4;      // water pit at x 8–14, z 60–70
  return 2;
}

export function fixtureParts() {
  const heights = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) heights.push(heightAtCell(i, j));
  const terrain = { kind: "heightfield", shape: "open", cols: COLS, rows: ROWS, cell: CELL, heights, min_y: -4, max_y: 12,
    material_layers: [{ material_ref: "mat:grass", min_h: -10, max_h: 100, max_slope_deg: 90 }] };

  const box = (x, y, z) => ({ shape: "box", size: { x, y, z }, solid: true });
  const none = { shape: "none", solid: false };
  const placements = [
    { id: "pl_hut", asset_ref: "lib:stone_hut", region: "region_hub", position: { x: 30, y: 2, z: 20 }, rotation_y: 0, scale: 1, role: "structure", collider: box(6, 4, 6), tags: [] },
    { id: "pl_pickup_1", asset_ref: "lib:key", region: "region_ruin", position: { x: 50, y: 2, z: 50 }, rotation_y: 0, scale: 1, role: "pickup", collider: none, tags: [] },
    { id: "pl_ruin", asset_ref: "lib:chest", region: "region_ruin", position: { x: 66, y: 2, z: 66 }, rotation_y: 0, scale: 1, role: "interactable", collider: box(2, 1, 2), tags: [] },
    { id: "pl_lantern", asset_ref: "lib:lantern_post", region: "region_hub", position: { x: 20, y: 2, z: 35 }, rotation_y: 0, scale: 1, role: "interactable", collider: none, tags: [] },
    { id: "pl_sign", asset_ref: "lib:signpost", region: "region_hub", position: { x: 12, y: 2, z: 30 }, rotation_y: 0, scale: 1, role: "interactable", collider: none, tags: [] },
    { id: "pl_lever", asset_ref: "lib:signpost", region: "region_field", position: { x: 30, y: 2, z: 55 }, rotation_y: 0, scale: 1, role: "interactable", collider: none, tags: [] },
    { id: "pl_pickup_2", asset_ref: "lib:gem", region: "region_ruin", position: { x: 72, y: 2, z: 50 }, rotation_y: 0, scale: 1, role: "pickup", collider: none, tags: [] },
    { id: "pl_pickup_3", asset_ref: "lib:gem", region: "region_field", position: { x: 34, y: 2, z: 72 }, rotation_y: 0, scale: 1, role: "pickup", collider: none, tags: [] },
  ];

  // Nav: a cell is walkable when its corners are level, dry and outside solids.
  const navCols = 40, navRows = 40;
  let walkable = "";
  for (let j = 0; j < navRows; j++) for (let i = 0; i < navCols; i++) {
    const hs = [heightAtCell(i, j), heightAtCell(i + 1, j), heightAtCell(i, j + 1), heightAtCell(i + 1, j + 1)];
    const x = (i + 0.5) * CELL, z = (j + 0.5) * CELL;
    const inSolid = placements.some((p) => p.collider.solid && Math.abs(x - p.position.x) < p.collider.size.x / 2 + 0.6 && Math.abs(z - p.position.z) < p.collider.size.z / 2 + 0.6);
    walkable += Math.max(...hs) - Math.min(...hs) < 0.5 && Math.min(...hs) > -0.5 && !inSolid ? "1" : "0";
  }

  const world = {
    world_spec_version: "1.0.0", id: "fixture_world", title: "Fixture Isle", seed: 7, size: { w: SIZE, h: SIZE }, biome: "island",
    environment: {
      time_of_day: 0.5, weather: "clear", sky: { top: "#3a6ea5", horizon: "#a8c8e8", bottom: "#d8e4ec" },
      fog: { color: "#a8c8e8", near: 40, far: 200 }, sun: { azimuth_deg: 120, elevation_deg: 50, color: "#fff4e0", intensity: 1.2, shadows: true },
      ambient: { color: "#8090a0", ground_color: "#404030", intensity: 0.5 }, water: { enabled: true, level: 0, color: "#2a5a7a", opacity: 0.8 },
    },
    terrain,
    regions: [
      { id: "region_hub", name: "Hub", kind: "district", bounds: [0, 0, 40, 40], center: { x: 20, y: 2, z: 20 }, location_ref: "hub" },
      { id: "region_ruin", name: "Ruin", kind: "landmark", bounds: [44, 44, 80, 80], center: { x: 62, y: 2, z: 62 }, location_ref: "ruin" },
      { id: "region_field", name: "Stormfield", kind: "wilderness", bounds: [0, 44, 40, 80], center: { x: 20, y: 2, z: 60 }, location_ref: "field" },
    ],
    paths: [{ id: "path_hub_ruin", from_region: "region_hub", to_region: "region_ruin", width: 3, points: [{ x: 20, z: 20 }, { x: 62, z: 62 }] }],
    placements,
    scatter: [],
    spawn_points: [
      { id: "spawn_player", kind: "player", position: { x: 10, y: 2, z: 10 }, rotation_y: 0, region: "region_hub" },
      { id: "spawn_npc_maren", kind: "npc", position: { x: 18, y: 2, z: 24 }, rotation_y: 0, region: "region_hub" },
      { id: "spawn_npc_warden", kind: "npc", position: { x: 56, y: 2, z: 30 }, rotation_y: 0, region: "region_hub" },
      { id: "spawn_cp_region_ruin", kind: "checkpoint", position: { x: 50, y: 2, z: 46 }, rotation_y: 0, region: "region_ruin" },
      { id: "spawn_cp_region_field", kind: "checkpoint", position: { x: 30, y: 2, z: 50 }, rotation_y: 0, region: "region_field" },
    ],
    camera: { mode: "third_person", distance: 6, height: 2.5, fov: 60, min_pitch: -0.4, max_pitch: 1.1, collide: true },
    interactables: [
      { id: "pickup_1", placement_ref: "pl_pickup_1", kind: "pickup", radius: 2, prompt: "Take the key", item_ref: "item_1" },
      { id: "pickup_2", placement_ref: "pl_pickup_2", kind: "pickup", radius: 2, prompt: "Take the gem", item_ref: "item_2" },
      { id: "pickup_3", placement_ref: "pl_pickup_3", kind: "pickup", radius: 2, prompt: "Take the gem", item_ref: "item_3" },
      { id: "ix_ruin", placement_ref: "pl_ruin", kind: "container", radius: 3.2, prompt: "Open the chest", item_ref: "item_core", locked_by: "item_1" },
      { id: "ix_hub", placement_ref: "pl_sign", kind: "sign", radius: 2, prompt: "Read the sign" },
      { id: "ix_field", placement_ref: "pl_lever", kind: "lever", radius: 2, prompt: "Pull the lever" },
      { id: "ix_talk_maren", placement_ref: null, kind: "talk", radius: 2.5, prompt: "Talk to Maren", character_ref: "maren" },
      { id: "ix_lantern", placement_ref: "pl_lantern", kind: "lantern", radius: 2.5, prompt: "Light the lantern" },
    ],
    navigation: { cell: CELL, cols: navCols, rows: navRows, max_slope_deg: 40, step_height: 0.45, walkable },
  };

  const concept = {
    concept_version: "1.0.0", title: "Fixture Isle", logline: "Find the key, open the chest.", source_prompt: "a tiny test island", prompt_hash: "0".repeat(64), seed: 7,
    genre: "adventure", biome: "island", scale: "small", mood: "calm", time_of_day: 0.5, weather: "clear",
    palette: { primary: "#336699", secondary: "#99aa55", accent: "#ffcc33", ground: "#557733", sky: "#88bbee", water: "#2a5a7a" },
    player_fantasy: "a curious traveller",
    key_locations: [{ id: "hub", name: "Hub", kind: "hub", description: "" }, { id: "ruin", name: "Ruin", kind: "ruin", description: "" }, { id: "field", name: "Stormfield", kind: "landmark", description: "" }],
    characters: [{ id: "maren", name: "Maren", role: "quest_giver", description: "" }, { id: "warden", name: "Warden", role: "enemy", description: "" }],
    objectives_outline: ["talk", "key", "chest"], hazards: ["sentinel", "storm"],
  };

  const characters = {
    character_spec_version: "1.0.0",
    characters: [
      { id: "maren", name: "Maren", role: "quest_giver", kind: "humanoid", body: { height: 1.7, build: "slim", palette: { skin: "#c89f7f", primary: "#336699", secondary: "#223344", accent: "#ffcc33" }, accessories: ["scarf"] },
        asset_ref: "char:maren", spawn_ref: "spawn_npc_maren", behavior: { initial: "idle", patrol: [], wander_radius: 0, speed: 1.2, sight_radius: 8, hostile: false, leash_radius: 10 },
        dialogue_ref: "dlg_maren", interaction_radius: 2.5, companion: false, invulnerable: true },
      { id: "warden", name: "Warden", role: "enemy", kind: "robot", body: { height: 2, build: "broad", palette: { skin: "#777777", primary: "#aa3333", secondary: "#222222", accent: "#ff0000" }, accessories: [] },
        asset_ref: "char:warden", spawn_ref: "spawn_npc_warden", behavior: { initial: "patrol", patrol: [{ x: 56, z: 30 }, { x: 72, z: 30 }], wander_radius: 0, speed: 2, sight_radius: 6, hostile: true, leash_radius: 20 },
        dialogue_ref: null, interaction_radius: 0, companion: false, invulnerable: true },
    ],
    dialogues: [{
      id: "dlg_maren", character_ref: "maren",
      entry: [{ node: "n_done", conditions: [{ kind: "objective_state", ref: "obj_open", value: "done" }] }, { node: "n0", conditions: [] }],
      nodes: [
        { id: "n0", speaker: "maren", text: "The chest in the ruin holds our lantern core. The key is out there.", choices: [
          { text: "I'll find it.", next: "n1", actions: [{ kind: "set_flag", ref: "quest_taken", value: true }] },
          { text: "Not now.", next: null } ] },
        { id: "n1", speaker: "maren", text: "Mind the warden.", choices: [{ text: "Farewell.", next: null, actions: [{ kind: "message", value: "Maren waves you off." }] }] },
        { id: "n_done", speaker: "maren", text: "You did it!", choices: [{ text: "Bye.", next: null }] },
      ],
    }],
  };

  const gameplay = {
    gameplay_version: "1.0.0", game_type: "adventure",
    rules: { player_health: 100, lives: 3, fall_damage: false, fall_y: -20, time_limit_s: null },
    movement: { walk_speed: 4.5, run_speed: 8, jump_velocity: 6.5, gravity: -20, max_slope_deg: 42, step_height: 0.45, air_control: 0.35, player_radius: 0.4, player_height: 1.8 },
    camera: { mode: "third_person", distance: 6, height: 2.5, fov: 60, sensitivity: 1 },
    interaction: { radius: 2.2, key: "KeyE", hold_ms: 0 },
    inventory: { slots: 8, items: [
      { id: "item_1", name: "Rusty Key", kind: "key", stackable: false, max_stack: 1, icon_ref: null },
      { id: "item_2", name: "Blue Gem", kind: "collectible", stackable: false, max_stack: 1, icon_ref: null },
      { id: "item_3", name: "Green Gem", kind: "collectible", stackable: false, max_stack: 1, icon_ref: null },
      { id: "item_core", name: "Lantern Core", kind: "quest", stackable: false, max_stack: 1, icon_ref: null } ] },
    objectives: [
      { id: "obj_talk", title: "Speak with Maren", description: "", kind: "talk", target_ref: "maren", count: 1, requires: [], optional: false, reward: { xp: 10 } },
      { id: "obj_key", title: "Find the key", description: "", kind: "collect", target_ref: "item_1", count: 1, requires: ["obj_talk"], optional: false, reward: { xp: 20 } },
      { id: "obj_open", title: "Open the chest", description: "", kind: "interact", target_ref: "ix_ruin", count: 1, requires: ["obj_key"], optional: false, reward: { xp: 50 } },
      { id: "obj_lantern", title: "Light the lantern", description: "", kind: "interact", target_ref: "ix_lantern", count: 1, requires: [], optional: true, reward: { xp: 5 } },
    ],
    events: [
      { id: "ev_talked", once: true, trigger: { kind: "objective_complete", ref: "obj_talk" }, actions: [{ kind: "set_npc_state", ref: "warden", value: "patrol" }, { kind: "message", value: "The warden stirs." }] },
      { id: "ev_open", once: true, trigger: { kind: "objective_complete", ref: "obj_open" }, actions: [{ kind: "message", value: "The core glows." }] },
    ],
    combat: { enabled: false, mode: "avoid", player_damage: 0, hazard_damage_per_s: 10 },
    hazards: [
      { id: "hz_warden", kind: "sentinel", character_ref: "warden", damage_per_s: 40, active_after: "obj_talk" },
      { id: "hz_storm", kind: "storm_zone", region: "region_field", damage_per_s: 6 },
    ],
    progression: { xp_per_level: 100, max_level: 5 },
    difficulty: { level: "normal", damage_mult: 1, speed_mult: 1, time_mult: 1 },
    checkpoints: [{ id: "cp_ruin", spawn_ref: "spawn_cp_region_ruin", trigger: { kind: "enter_region", ref: "region_ruin" } }],
    win_conditions: [{ kind: "all_required_objectives" }],
    lose_conditions: [{ kind: "lives_zero" }],
  };

  const mesh = (ref, kind, parts) => ({
    asset_record_version: "1.0.0", asset_id: "ast_" + sha256Json({ ref, parts }).slice(0, 16), ref, kind, name: ref, provider: "local:procedural", model: "deterministic",
    prompt: null, prompt_hash: sha256Json(parts), version: 1, source: "procedural", cost_usd: 0, latency_ms: 0, format: "mesh-recipe",
    dimensions: { w: 2, h: 2, d: 2 }, bytes: JSON.stringify(parts).length, sha256: sha256Json(parts), game_bindings: [],
    provenance: { generated_at: "2026-09-28T00:00:00.000Z", lane: "assets", adapter: "local", status: "AVAILABLE", after_failed: [], license: { spdx: "CC0-1.0", commercial_use: "cleared" } },
    payload: { builder: "parts", bounds: { w: 2, h: 2, d: 2 }, parts }, uri: null,
  });
  const part = (shape, mat, extra = {}) => ({ shape, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, material_ref: mat, ...extra });
  const matRec = { ...mesh("mat:grass", "material", []), format: "material", payload: { material_id: "mat:grass", color: "#557733", roughness: 0.9, metalness: 0, emissive: null, emissive_intensity: 0, transparent: false, opacity: 1, repeat: { u: 8, v: 8 }, double_sided: false } };
  const stoneRec = { ...mesh("mat:stone", "material", [1]), format: "material", payload: { material_id: "mat:stone", color: "#888888", roughness: 0.8, metalness: 0, emissive: null, emissive_intensity: 0, transparent: false, opacity: 1, repeat: { u: 1, v: 1 }, double_sided: false } };
  const texRec = { ...mesh("tex:grass_albedo", "texture", [2]), format: "texture-recipe", payload: { generator: "grass", size: 256, seed: 1, colors: ["#557733"], scale: 1, params: {} } };
  const records = [
    mesh("lib:stone_hut", "structure", [part("box", "mat:stone", { size: { x: 6, y: 4, z: 6 } }), part("cone", "mat:stone", { radius: 4, height: 2, segments: 8 })]),
    mesh("lib:key", "prop", [part("torus", "mat:stone", { radius: 0.2, tube: 0.05, segments: 12 })]),
    mesh("lib:chest", "prop", [part("box", "mat:stone", { size: { x: 2, y: 1, z: 2 } })]),
    mesh("lib:signpost", "prop", [part("box", "mat:stone", { size: { x: 0.2, y: 2, z: 0.2 } })]),
    mesh("lib:gem", "prop", [part("icosphere", "mat:stone", { radius: 0.3, detail: 1 })]),
    mesh("lib:lantern_post", "structure", [part("cylinder", "mat:stone", { radius_top: 0.1, radius_bottom: 0.1, height: 3, segments: 8 })]),
    mesh("char:maren", "character", [part("capsule", "mat:stone", { radius: 0.3, height: 1.7, segments: 8 })]),
    mesh("char:warden", "npc", [part("box", "mat:stone", { size: { x: 1, y: 2, z: 1 } })]),
    matRec, stoneRec, texRec,
  ];

  const nodes = [
    { id: "root", type: "root", parent: null },
    { id: "env", type: "environment", parent: "root" },
    { id: "sky", type: "sky", parent: "env", ...world.environment.sky },
    { id: "sun", type: "sun_light", parent: "env", color: "#fff4e0", intensity: 1.2, direction: { x: -0.5, y: -0.8, z: -0.3 }, shadows: true },
    { id: "ambient", type: "ambient_light", parent: "env", color: "#8090a0", ground_color: "#404030", intensity: 0.5 },
    { id: "water", type: "water", parent: "env", level: 0, color: "#2a5a7a", opacity: 0.8, size: { w: SIZE, h: SIZE } },
    { id: "terrain", type: "terrain", parent: "root", terrain_ref: "world.terrain", material_layers: terrain.material_layers },
    { id: "camera", type: "camera_rig", parent: "root", mode: "third_person", distance: 6, height: 2.5, fov: 60, min_pitch: -0.4, max_pitch: 1.1 },
    { id: "nav", type: "nav_grid", parent: "root", nav_ref: "world.navigation" },
    { id: "spawn_player", type: "spawn", parent: "root", spawn_ref: "spawn_player", kind: "player", transform: { position: { x: 10, y: 2, z: 10 }, rotation_y: 0, scale: 1 } },
    ...placements.map((p) => ({ id: `mi_${p.id}`, type: "mesh_instance", parent: "root", asset_ref: p.asset_ref, placement_ref: p.id, transform: { position: p.position, rotation_y: 0, scale: 1 } })),
    ...characters.characters.map((c) => ({ id: `ch_${c.id}`, type: "character", parent: "root", character_ref: c.id, asset_ref: c.asset_ref, spawn_ref: c.spawn_ref })),
    ...world.interactables.map((i) => ({ id: `in_${i.id}`, type: "interactable", parent: "root", interactable_ref: i.id, placement_ref: i.placement_ref, radius: i.radius, prompt: i.prompt })),
  ];
  const scene = { scene_graph_version: "1.0.0", world_id: world.id, nodes };

  return { concept, world, scene, assets: records, gameplay, characters };
}

/** Assembled without runtime/assemble.mjs so sim-core tests do not depend on it. */
export function fixturePackage() {
  const p = fixtureParts();
  const pkg = {
    package_version: "1.0.0", game_id: "fixture_isle", version: 1, title: p.concept.title, created_at: "2026-09-28T00:00:00.000Z",
    concept: p.concept, world: p.world, scene: p.scene, assets: { records: p.assets }, gameplay: p.gameplay, characters: p.characters,
    hooks: { edit: { ops: [] }, expand: { ops: [] }, companion: { character_ref: "maren", knowledge: [] } },
    provenance: { pipeline_version: "gamesb-1.0.0", prompt_hash: p.concept.prompt_hash, stages: [] },
  };
  pkg.integrity = { sha256: sha256Json(pkg) };
  return pkg;
}
