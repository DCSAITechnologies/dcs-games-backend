// Games-B SceneGraph validator (contract §3). ISOMORPHIC.
//
// A scene is "complete" when the renderer has everything it cannot invent:
// one root/environment/sky/sun/ambient/terrain/camera/nav node, a player
// spawn, parents that exist, unique ids — and every asset_ref resolving to an
// AssetRecord. The asset check is what catches a world that names a lib: piece
// the asset stage never produced, before the browser renders a hole.
//
// validateSceneGraph(scene, { assets?, characters?, world? })
//   assets  AssetRecord[] or { records }. A ref resolves when some record has
//           record.ref === ref or record.asset_id === ref (§4.1a). Without
//           assets the resolution check is skipped with a warning.
//   world   optional: placement/scatter/spawn/interactable refs are then
//           checked against it too.

import { Issues, isObj, isArr, isStr, isNum, isInt, isVec3, requireNum } from "../common/issues.mjs";

export const SCENE_GRAPH_VERSION = "1.0.0";
export const NODE_TYPES = [
  "root", "environment", "sky", "sun_light", "ambient_light", "fog", "water", "terrain", "region", "mesh_instance",
  "instanced_group", "character", "spawn", "camera_rig", "collider", "trigger_volume", "interactable", "audio_emitter", "nav_grid",
];
const EXACTLY_ONE = ["root", "environment", "sky", "sun_light", "ambient_light", "terrain", "camera_rig", "nav_grid"];

/** Every asset_ref a scene needs, sorted and unique. */
export function sceneAssetRefs(scene) {
  const out = new Set();
  for (const n of scene?.nodes || []) if (isStr(n?.asset_ref)) out.add(n.asset_ref);
  return [...out].sort();
}

/** Every material_ref the terrain layers need, sorted and unique. */
export function sceneMaterialRefs(scene) {
  const out = new Set();
  for (const n of scene?.nodes || []) if (n?.type === "terrain") for (const m of n.material_layers || []) if (isStr(m?.material_ref)) out.add(m.material_ref);
  return [...out].sort();
}

function assetIndex(assets) {
  const recs = isArr(assets) ? assets : isArr(assets?.records) ? assets.records : null;
  if (!recs) return null;
  const idx = new Set();
  for (const r of recs) { if (isStr(r?.ref)) idx.add(r.ref); if (isStr(r?.asset_id)) idx.add(r.asset_id); }
  return idx;
}

export function validateSceneGraph(scene, ctx = {}) {
  const iss = new Issues();
  if (!isObj(scene)) { iss.err("scene", "must be an object"); return iss.toJSON(); }
  if (scene.scene_graph_version !== SCENE_GRAPH_VERSION) iss.err("scene_graph_version", `must be "${SCENE_GRAPH_VERSION}"`);
  if (!isStr(scene.world_id)) iss.err("world_id", "is required");
  if (!isArr(scene.nodes)) { iss.err("nodes", "must be an array"); return iss.toJSON(); }

  const ids = new Map();
  const counts = {};
  scene.nodes.forEach((n, i) => {
    const p = `nodes[${i}]`;
    if (!isObj(n)) { iss.err(p, "must be an object"); return; }
    if (!isStr(n.id)) iss.err(`${p}.id`, "is required");
    else if (ids.has(n.id)) iss.err(`${p}.id`, `duplicate node id '${n.id}'`);
    else ids.set(n.id, n);
    if (!NODE_TYPES.includes(n.type)) iss.err(`${p}.type`, `'${n.type}' is not a node type`);
    counts[n.type] = (counts[n.type] || 0) + 1;
    if (n.transform !== undefined) {
      if (!isObj(n.transform) || !isVec3(n.transform.position) || !isNum(n.transform.rotation_y) || !isNum(n.transform.scale)) {
        iss.err(`${p}.transform`, "must be { position:{x,y,z}, rotation_y, scale }");
      }
    }
  });
  for (const t of EXACTLY_ONE) if (counts[t] !== 1) iss.err("nodes", `needs exactly one '${t}' node, found ${counts[t] || 0}`);

  // Parents.
  scene.nodes.forEach((n, i) => {
    if (!isObj(n)) return;
    const p = `nodes[${i}].parent`;
    if (n.type === "root") { if (n.parent !== null) iss.err(p, "the root node's parent must be null"); return; }
    if (!isStr(n.parent)) iss.err(p, "is required (only the root has no parent)");
    else if (!ids.has(n.parent)) iss.err(p, `'${n.parent}' is not a node`);
    else if (n.parent === n.id) iss.err(p, "a node cannot parent itself");
  });
  // Cycles: walk each node up to the root.
  for (const n of ids.values()) {
    let cur = n, steps = 0;
    while (cur && cur.parent && steps <= ids.size) { cur = ids.get(cur.parent); steps++; }
    if (steps > ids.size) { iss.err(`nodes.${n.id}.parent`, "parent chain has a cycle"); break; }
  }

  // Per-type fields.
  const w = ctx.world;
  const placementIds = w ? new Set(w.placements.map((x) => x.id)) : null;
  const scatterIds = w ? new Set(w.scatter.map((x) => x.id)) : null;
  const spawnMap = w ? new Map(w.spawn_points.map((x) => [x.id, x])) : null;
  const ixIds = w ? new Set(w.interactables.map((x) => x.id)) : null;
  let playerSpawns = 0;
  scene.nodes.forEach((n, i) => {
    if (!isObj(n)) return;
    const p = `nodes[${i}]`;
    const need = (k, pred = isStr) => { if (!pred(n[k])) iss.err(`${p}.${k}`, `is required for ${n.type}`); };
    switch (n.type) {
      case "sky": need("top"); need("horizon"); need("bottom"); break;
      case "sun_light":
        need("color"); requireNum(iss, n.intensity, `${p}.intensity`, { min: 0 });
        if (!isVec3(n.direction)) iss.err(`${p}.direction`, "must be {x,y,z}");
        break;
      case "ambient_light": need("color"); need("ground_color"); requireNum(iss, n.intensity, `${p}.intensity`, { min: 0 }); break;
      case "fog": need("color"); requireNum(iss, n.near, `${p}.near`, { min: 0 }); requireNum(iss, n.far, `${p}.far`, { min: 0 }); break;
      case "water": requireNum(iss, n.level, `${p}.level`); need("color"); break;
      case "terrain":
        if (n.terrain_ref !== "world.terrain") iss.err(`${p}.terrain_ref`, "must be 'world.terrain'");
        if (!isArr(n.material_layers) || !n.material_layers.length) iss.err(`${p}.material_layers`, "needs at least one layer");
        break;
      case "region": need("region_ref"); if (!isArr(n.bounds) || n.bounds.length !== 4) iss.err(`${p}.bounds`, "must be [minX, minZ, maxX, maxZ]"); break;
      case "mesh_instance":
        need("asset_ref"); need("placement_ref");
        if (placementIds && !placementIds.has(n.placement_ref)) iss.err(`${p}.placement_ref`, `'${n.placement_ref}' is not a world placement`);
        break;
      case "instanced_group":
        need("asset_ref"); need("scatter_ref"); need("count", (v) => isInt(v) && v >= 0);
        if (scatterIds && !scatterIds.has(n.scatter_ref)) iss.err(`${p}.scatter_ref`, `'${n.scatter_ref}' is not a world scatter entry`);
        break;
      case "character":
        need("character_ref"); need("asset_ref"); need("spawn_ref");
        if (spawnMap && !spawnMap.has(n.spawn_ref)) iss.err(`${p}.spawn_ref`, `'${n.spawn_ref}' is not a world spawn`);
        break;
      case "spawn":
        need("spawn_ref"); need("kind");
        if (n.kind === "player") playerSpawns++;
        if (spawnMap && !spawnMap.has(n.spawn_ref)) iss.err(`${p}.spawn_ref`, `'${n.spawn_ref}' is not a world spawn`);
        break;
      case "camera_rig": need("mode"); for (const k of ["distance", "height", "fov", "min_pitch", "max_pitch"]) requireNum(iss, n[k], `${p}.${k}`); break;
      case "collider": need("collider_ref"); break;
      case "trigger_volume":
        need("shape"); need("ref");
        if (n.shape === "sphere") requireNum(iss, n.radius, `${p}.radius`, { min: 0 });
        else if (n.shape === "box") { if (!isVec3(n.half)) iss.err(`${p}.half`, "box triggers need half {x,y,z}"); }
        else iss.err(`${p}.shape`, "must be 'sphere' or 'box'");
        break;
      case "interactable":
        need("interactable_ref"); requireNum(iss, n.radius, `${p}.radius`, { min: 0 }); need("prompt");
        if (n.placement_ref !== null && !isStr(n.placement_ref)) iss.err(`${p}.placement_ref`, "must be a placement id or null");
        if (ixIds && !ixIds.has(n.interactable_ref)) iss.err(`${p}.interactable_ref`, `'${n.interactable_ref}' is not a world interactable`);
        break;
      case "audio_emitter": need("cue"); requireNum(iss, n.radius, `${p}.radius`, { min: 0 }); break;
      case "nav_grid": if (n.nav_ref !== "world.navigation") iss.err(`${p}.nav_ref`, "must be 'world.navigation'"); break;
      default: break;
    }
  });
  if (playerSpawns < 1) iss.err("nodes", "needs at least one spawn node with kind 'player'");

  // Asset resolution.
  const idx = assetIndex(ctx.assets);
  if (!idx) iss.warn("assets", "no asset records supplied; asset_ref resolution not checked");
  else {
    scene.nodes.forEach((n, i) => {
      if (isStr(n?.asset_ref) && !idx.has(n.asset_ref)) iss.err(`nodes[${i}].asset_ref`, `'${n.asset_ref}' does not resolve to any AssetRecord`, "the asset stage must emit a record with this ref");
    });
    for (const m of sceneMaterialRefs(scene)) if (!idx.has(m)) iss.warn("terrain.material_layers", `material '${m}' does not resolve to any AssetRecord`);
  }
  return iss.toJSON();
}
