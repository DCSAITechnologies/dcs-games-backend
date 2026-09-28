// Games-B world: WorldSpec → SceneGraph (contract §3).
//
// The scene graph is the renderer's shopping list: a flat node array with
// parent links. It deliberately does not duplicate bulky data — the terrain
// heights and the nav grid stay in the WorldSpec and are referenced by
// "world.terrain" / "world.navigation" — so a package carries them once.
//
// Conventions (documented in DCS_GAMES_3D_WORLD_SCHEMA.md):
//   - Every `transform` is WORLD-space; `parent` is logical grouping only
//     (scene.transform_space = "world", an optional contract addition).
//   - sun_light.direction points FROM the scene TOWARDS the light, with
//     azimuth measured clockwise from +z towards +x (90° = +x = east) — a
//     renderer places the light at target + direction * distance.
//   - Node ids are "<type-ish prefix>:<ref>", unique within the scene.

import { expandScatter } from "./terrain-sample.mjs";
import { SCENE_GRAPH_VERSION } from "./scene-graph.schema.mjs";

const AMBIENT_BY_BIOME = {
  island: ["amb_surf", "amb_gulls", "amb_wind_light"], forest: ["amb_forest_birds", "amb_leaves"], desert: ["amb_wind_dry"],
  snow: ["amb_wind_cold"], volcanic: ["amb_rumble", "amb_lava_bubbles"], canyon: ["amb_wind_canyon", "amb_hawk"],
  ruins: ["amb_ruins_wind", "amb_insects"], city: ["amb_city_hum"], scifi_base: ["amb_machinery_hum"],
};
const AMBIENT_BY_WEATHER = {
  rain: ["amb_rain"], storm: ["amb_rain_heavy", "amb_thunder"], snow: ["amb_snow_wind"], fog: ["amb_fog_drip"],
  sandstorm: ["amb_sandstorm"], ash: ["amb_ash_wind"], cloudy: [], clear: [],
};
const LOCAL_CUES = {
  "lib:campfire": ["sfx_fire_crackle", 10], "lib:beacon_brazier": ["sfx_fire_crackle", 12], "lib:dock": ["amb_water_lap", 18],
  "lib:shrine": ["amb_shrine_chime", 14], "lib:lighthouse": ["amb_wind_high", 20], "lib:well": ["sfx_well_drip", 6],
};

const DEG = Math.PI / 180;
const r3 = (v) => Math.round(v * 1000) / 1000;
const tf = (p, rot = 0, scale = 1) => ({ position: { x: p.x, y: p.y, z: p.z }, rotation_y: rot, scale });

function characterList(characters, world) {
  const list = Array.isArray(characters) ? characters : Array.isArray(characters?.characters) ? characters.characters : null;
  if (list) return list.map((c) => ({ id: c.id, name: c.name, asset_ref: c.asset_ref || `char:${c.id}`, spawn_ref: c.spawn_ref || `spawn_npc_${c.id}` }));
  // No CharactersSpec yet: every npc spawn implies a character.
  return world.spawn_points.filter((s) => s.kind === "npc" && s.id.startsWith("spawn_npc_"))
    .map((s) => { const id = s.id.slice("spawn_npc_".length); return { id, name: id, asset_ref: `char:${id}`, spawn_ref: s.id }; });
}

/**
 * Compile the scene. `assets` is accepted for signature parity with the
 * contract but the graph uses logical refs, so it compiles before assets
 * exist; resolution is checked by validateSceneGraph.
 */
export function compileSceneGraph(world, { assets: _assets, characters } = {}) {
  const nodes = [];
  const add = (n) => { nodes.push(n); return n.id; };
  const env = world.environment;
  const W = world.size.w, H = world.size.h;
  const mid = { x: W / 2, y: 0, z: H / 2 };

  const root = add({ id: "root", type: "root", parent: null, name: world.title });
  const envId = add({ id: "environment", type: "environment", parent: root, time_of_day: env.time_of_day, weather: env.weather });
  add({ id: "sky", type: "sky", parent: envId, ...env.sky });
  const az = env.sun.azimuth_deg * DEG, el = env.sun.elevation_deg * DEG;
  add({ id: "sun", type: "sun_light", parent: envId, color: env.sun.color, intensity: env.sun.intensity, shadows: env.sun.shadows,
    direction: { x: r3(Math.sin(az) * Math.cos(el)), y: r3(Math.sin(el)), z: r3(Math.cos(az) * Math.cos(el)) } });
  add({ id: "ambient", type: "ambient_light", parent: envId, ...env.ambient });
  add({ id: "fog", type: "fog", parent: envId, ...env.fog });
  if (env.water.enabled) add({ id: "water", type: "water", parent: envId, level: env.water.level, color: env.water.color, opacity: env.water.opacity, size: { w: W, h: H } });
  add({ id: "terrain", type: "terrain", parent: root, terrain_ref: "world.terrain", material_layers: world.terrain.material_layers });
  add({ id: "nav", type: "nav_grid", parent: root, nav_ref: "world.navigation" });

  // Regions and their trigger volumes.
  const regionNode = {};
  for (const r of world.regions) {
    const [x0, z0, x1, z1] = r.bounds;
    regionNode[r.id] = add({ id: `region:${r.id}`, type: "region", parent: root, name: r.name, region_ref: r.id, bounds: r.bounds, transform: tf(r.center) });
    add({ id: `trigger:${r.id}`, type: "trigger_volume", parent: regionNode[r.id], shape: "box", ref: r.id,
      half: { x: r3((x1 - x0) / 2), y: 20, z: r3((z1 - z0) / 2) }, transform: tf({ x: r3((x0 + x1) / 2), y: r.center.y, z: r3((z0 + z1) / 2) }) });
  }

  // Placements.
  const meshNode = {};
  for (const p of world.placements) {
    meshNode[p.id] = add({ id: `mesh:${p.id}`, type: "mesh_instance", parent: regionNode[p.region] || root, asset_ref: p.asset_ref,
      placement_ref: p.id, role: p.role, transform: tf(p.position, p.rotation_y, p.scale) });
    const cue = LOCAL_CUES[p.asset_ref];
    if (cue) add({ id: `audio:${p.id}`, type: "audio_emitter", parent: meshNode[p.id], cue: cue[0], radius: cue[1], transform: tf(p.position) });
  }

  // Scatter: one instanced group per entry, carrying the expanded count.
  const inst = expandScatter(world);
  const counts = {};
  for (const i of inst) counts[i.scatter_id] = (counts[i.scatter_id] || 0) + 1;
  for (const s of world.scatter) {
    add({ id: `inst:${s.id}`, type: "instanced_group", parent: s.region ? regionNode[s.region] || root : root, asset_ref: s.asset_ref,
      scatter_ref: s.id, count: counts[s.id] || 0, requested_count: s.count });
  }

  // Spawns and characters.
  const spawnMap = new Map(world.spawn_points.map((s) => [s.id, s]));
  for (const s of world.spawn_points) {
    add({ id: `spawn:${s.id}`, type: "spawn", parent: regionNode[s.region] || root, spawn_ref: s.id, kind: s.kind, transform: tf(s.position, s.rotation_y) });
  }
  const charNode = {};
  for (const c of characterList(characters, world)) {
    const sp = spawnMap.get(c.spawn_ref);
    charNode[c.id] = add({ id: `character:${c.id}`, type: "character", parent: sp ? `spawn:${sp.id}` : root, name: c.name,
      character_ref: c.id, asset_ref: c.asset_ref, spawn_ref: c.spawn_ref, ...(sp ? { transform: tf(sp.position, sp.rotation_y) } : {}) });
  }

  // Interactables and their trigger spheres.
  const plMap = new Map(world.placements.map((p) => [p.id, p]));
  for (const ix of world.interactables) {
    const pl = ix.placement_ref ? plMap.get(ix.placement_ref) : null;
    const parent = pl ? meshNode[pl.id] : (ix.character_ref && charNode[ix.character_ref]) || root;
    const pos = pl ? pl.position : spawnMap.get(`spawn_npc_${ix.character_ref}`)?.position;
    const t = pos ? { transform: tf(pos) } : {};
    const id = add({ id: `interactable:${ix.id}`, type: "interactable", parent, interactable_ref: ix.id, placement_ref: ix.placement_ref,
      kind: ix.kind, radius: ix.radius, prompt: ix.prompt, ...(ix.character_ref ? { character_ref: ix.character_ref } : {}), ...t });
    add({ id: `trigger:${ix.id}`, type: "trigger_volume", parent: id, shape: "sphere", radius: ix.radius, ref: ix.id, ...t });
  }

  // Ambient audio: biome bed, weather layer, and a night layer.
  const cues = [...(AMBIENT_BY_BIOME[world.biome] || []), ...(AMBIENT_BY_WEATHER[env.weather] || [])];
  if ((env.time_of_day < 0.22 || env.time_of_day > 0.78) && world.biome !== "snow") cues.push("amb_night_insects");
  for (const cue of cues) add({ id: `audio:${cue}`, type: "audio_emitter", parent: envId, cue, radius: Math.max(W, H), ambient: true, transform: tf(mid) });

  const cam = world.camera;
  const player = world.spawn_points.find((s) => s.kind === "player");
  add({ id: "camera", type: "camera_rig", parent: root, mode: cam.mode, distance: cam.distance, height: cam.height, fov: cam.fov,
    min_pitch: cam.min_pitch, max_pitch: cam.max_pitch, collide: cam.collide, ...(player ? { target_ref: player.id, transform: tf(player.position, player.rotation_y) } : {}) });

  return { scene_graph_version: SCENE_GRAPH_VERSION, world_id: world.id, transform_space: "world", nodes };
}

export { validateSceneGraph, sceneAssetRefs, sceneMaterialRefs } from "./scene-graph.schema.mjs";
