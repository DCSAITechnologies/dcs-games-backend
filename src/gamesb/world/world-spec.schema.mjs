// Games-B WorldSpec validator (contract §2 and the §4.5 ids). ISOMORPHIC.
//
// Structure first, then geometry: a world can be perfectly shaped JSON and
// still unplayable — a spawn under the sea, a chest nobody can reach, a nav
// string one row short. The geometric checks here use the same sampling,
// collision and nav modules the runtime uses, so "valid" means "the runtime
// will agree".
//
// validateWorldSpec(world, { concept?, reachability? = true })
//   concept       when given, the §4.5 ids are checked against its
//                 key_locations and characters as well as against the world.
//   reachability  set false to skip the flood-fill checks (cheap mode).

import { Issues, isObj, isArr, isStr, isNum, isBool, isVec3, isHex, requireEnum, requireNum, uniqueIds } from "../common/issues.mjs";
import { sampleHeight, footprintRadius } from "./terrain-sample.mjs";
import { buildColliders, pointInCollider, containsXZ } from "./collision.mjs";
import { navIndex, isWalkable, reachableSet, nearestWalkable, cellCenter } from "./nav-grid.mjs";

// Must equal PLAYER_RADIUS in world-spec.mjs: the stale-nav check below repeats
// bakeNavigation's own blocking test, and a different pad would flag cells the
// bake correctly left open.
const NAV_BAKE_PAD = 0.45;

export const BIOMES = ["island", "forest", "desert", "snow", "volcanic", "canyon", "ruins", "city", "scifi_base"];
export const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "sandstorm", "ash"];
export const SHAPES = ["island", "valley", "plateau", "open"];
export const REGION_KINDS = ["district", "interior", "landmark", "wilderness", "transit", "arena", "instance"];
export const PLACEMENT_ROLES = ["structure", "prop", "landmark", "foliage", "interactable", "pickup", "decor"];
export const COLLIDER_SHAPES = ["box", "cylinder", "none"];
export const SPAWN_KINDS = ["player", "npc", "respawn", "checkpoint"];
export const CAMERA_MODES = ["third_person", "first_person", "top_down"];
export const INTERACTABLE_KINDS = ["door", "switch", "pickup", "container", "terminal", "lantern", "altar", "talk", "portal", "lever", "sign"];
export const LIB_NAMES = [
  "lighthouse", "watchtower", "stone_hut", "cottage", "ruin_arch", "ruin_wall", "ruin_pillar", "shrine", "dock", "bridge", "well", "tent",
  "campfire", "lantern_post", "altar", "beacon_brazier", "gate", "statue", "obelisk",
  "crate", "barrel", "chest", "signpost", "fence", "boat", "cart",
  "pine_tree", "broadleaf_tree", "palm_tree", "dead_tree", "bush", "grass_tuft", "rock_small", "rock_large", "cliff_rock", "cactus",
  "crystal_cluster", "mushroom", "flowers", "reeds",
  "lantern_core", "relic", "gem", "key", "scroll", "herb", "shard",
];

const inside = (p, size, tol = 0.01) => p.x >= -tol && p.z >= -tol && p.x <= size.w + tol && p.z <= size.h + tol;

export function validateWorldSpec(world, opts = {}) {
  const iss = new Issues();
  if (!isObj(world)) { iss.err("world", "must be an object"); return iss.toJSON(); }
  if (world.world_spec_version !== "1.0.0") iss.err("world_spec_version", `must be "1.0.0", got ${JSON.stringify(world.world_spec_version)}`);
  if (!isStr(world.id)) iss.err("id", "is required");
  if (!isStr(world.title)) iss.err("title", "is required");
  requireNum(iss, world.seed, "seed", { integer: true });
  const sizeOk = isObj(world.size) && isNum(world.size.w) && isNum(world.size.h) && world.size.w > 0 && world.size.h > 0;
  if (!sizeOk) iss.err("size", "must be { w > 0, h > 0 }");
  requireEnum(iss, world.biome, BIOMES, "biome");
  const size = sizeOk ? world.size : { w: Infinity, h: Infinity };

  checkEnvironment(iss, world.environment);
  const terrainOk = checkTerrain(iss, world.terrain, size, sizeOk);

  // Regions.
  const regionIds = uniqueIds(iss, world.regions, "regions");
  if (isArr(world.regions) && !world.regions.length) iss.err("regions", "needs at least one region (the start hub)");
  (world.regions || []).forEach((r, i) => {
    const p = `regions[${i}]`;
    if (!isStr(r?.name)) iss.err(`${p}.name`, "is required");
    requireEnum(iss, r?.kind, REGION_KINDS, `${p}.kind`);
    const b = r?.bounds;
    if (!isArr(b) || b.length !== 4 || !b.every(isNum) || b[0] >= b[2] || b[1] >= b[3]) {
      iss.err(`${p}.bounds`, "must be [minX, minZ, maxX, maxZ] with min < max");
    } else if (b[0] < -0.01 || b[1] < -0.01 || b[2] > size.w + 0.01 || b[3] > size.h + 0.01) {
      iss.err(`${p}.bounds`, "lies outside the world size", "clamp bounds to [0, size.w] × [0, size.h]");
    }
    if (!isVec3(r?.center)) iss.err(`${p}.center`, "must be {x,y,z}");
    else if (isArr(b) && b.length === 4 && (r.center.x < b[0] || r.center.x > b[2] || r.center.z < b[1] || r.center.z > b[3])) iss.err(`${p}.center`, "is outside the region's bounds");
    if (r?.location_ref !== undefined && !isStr(r.location_ref)) iss.err(`${p}.location_ref`, "must be a string when present");
    if (r?.pad_radius !== undefined) requireNum(iss, r.pad_radius, `${p}.pad_radius`, { min: 0 });
  });

  // Paths.
  uniqueIds(iss, world.paths, "paths");
  (world.paths || []).forEach((pa, i) => {
    const p = `paths[${i}]`;
    if (!regionIds.has(pa?.from_region)) iss.err(`${p}.from_region`, `'${pa?.from_region}' is not a region`);
    if (!regionIds.has(pa?.to_region)) iss.err(`${p}.to_region`, `'${pa?.to_region}' is not a region`);
    requireNum(iss, pa?.width, `${p}.width`, { min: 0.5, max: 50 });
    if (!isArr(pa?.points) || pa.points.length < 2) iss.err(`${p}.points`, "needs at least two {x,z} points");
    else pa.points.forEach((q, k) => {
      const ok = isObj(q) && isNum(q.x) && isNum(q.z);
      if (!ok) iss.err(`${p}.points[${k}]`, "must be {x,z}");
      else if (!inside(q, size)) iss.err(`${p}.points[${k}]`, "lies outside the world");
    });
  });

  // Placements.
  const placementIds = uniqueIds(iss, world.placements, "placements");
  (world.placements || []).forEach((pl, i) => {
    const p = `placements[${i}]`;
    if (!isStr(pl?.asset_ref)) iss.err(`${p}.asset_ref`, "is required");
    else if (pl.asset_ref.startsWith("lib:") && !LIB_NAMES.includes(pl.asset_ref.slice(4))) iss.warn(`${p}.asset_ref`, `'${pl.asset_ref}' is not a §4.1a library name; the asset stage will substitute`);
    if (!regionIds.has(pl?.region)) iss.err(`${p}.region`, `'${pl?.region}' is not a region`);
    if (!isVec3(pl?.position)) iss.err(`${p}.position`, "must be {x,y,z}");
    else if (!inside(pl.position, size)) iss.err(`${p}.position`, "lies outside the world");
    requireNum(iss, pl?.rotation_y, `${p}.rotation_y`);
    requireNum(iss, pl?.scale, `${p}.scale`, { min: 0.01, max: 100 });
    requireEnum(iss, pl?.role, PLACEMENT_ROLES, `${p}.role`);
    const c = pl?.collider;
    if (!isObj(c)) iss.err(`${p}.collider`, "is required");
    else {
      requireEnum(iss, c.shape, COLLIDER_SHAPES, `${p}.collider.shape`);
      if (!isBool(c.solid)) iss.err(`${p}.collider.solid`, "must be a boolean");
      if (c.shape === "box" && !(isVec3(c.size) && c.size.x > 0 && c.size.y > 0 && c.size.z > 0)) iss.err(`${p}.collider.size`, "box colliders need a positive size {x,y,z}");
      if (c.shape === "cylinder" && !(isNum(c.radius) && c.radius > 0 && isNum(c.height) && c.height > 0)) iss.err(`${p}.collider`, "cylinder colliders need radius > 0 and height > 0");
      if (c.shape === "none" && c.solid) iss.err(`${p}.collider.solid`, "a 'none' collider cannot be solid");
    }
    if (!isArr(pl?.tags) || !pl.tags.every((t) => typeof t === "string")) iss.err(`${p}.tags`, "must be an array of strings");
  });

  // Scatter.
  uniqueIds(iss, world.scatter, "scatter");
  (world.scatter || []).forEach((s, i) => {
    const p = `scatter[${i}]`;
    if (!isStr(s?.asset_ref)) iss.err(`${p}.asset_ref`, "is required");
    if (s?.region !== null && !regionIds.has(s?.region)) iss.err(`${p}.region`, "must be null or a region id");
    requireNum(iss, s?.count, `${p}.count`, { min: 0, max: 5000, integer: true });
    requireNum(iss, s?.min_scale, `${p}.min_scale`, { min: 0.01 });
    requireNum(iss, s?.max_scale, `${p}.max_scale`, { min: 0.01 });
    if (isNum(s?.min_scale) && isNum(s?.max_scale) && s.min_scale > s.max_scale) iss.err(`${p}.min_scale`, "must not exceed max_scale");
    requireNum(iss, s?.seed, `${p}.seed`, { integer: true });
    if (!isBool(s?.avoid_paths)) iss.err(`${p}.avoid_paths`, "must be a boolean");
    requireNum(iss, s?.collider_radius, `${p}.collider_radius`, { min: 0 });
    if (s?.zone !== undefined) requireEnum(iss, s.zone, ["land", "shore", "any"], `${p}.zone`);
    if (s?.collider_radius > 0 && s?.avoid_paths === false) iss.warn(`${p}.avoid_paths`, "solid scatter that ignores paths can block them");
  });

  // Spawns.
  uniqueIds(iss, world.spawn_points, "spawn_points");
  (world.spawn_points || []).forEach((s, i) => {
    const p = `spawn_points[${i}]`;
    requireEnum(iss, s?.kind, SPAWN_KINDS, `${p}.kind`);
    if (!isVec3(s?.position)) iss.err(`${p}.position`, "must be {x,y,z}");
    else if (!inside(s.position, size)) iss.err(`${p}.position`, "lies outside the world");
    requireNum(iss, s?.rotation_y, `${p}.rotation_y`);
    if (!regionIds.has(s?.region)) iss.err(`${p}.region`, `'${s?.region}' is not a region`);
  });

  // Camera.
  const cam = world.camera;
  if (!isObj(cam)) iss.err("camera", "is required");
  else {
    requireEnum(iss, cam.mode, CAMERA_MODES, "camera.mode");
    requireNum(iss, cam.distance, "camera.distance", { min: 0 });
    requireNum(iss, cam.height, "camera.height");
    requireNum(iss, cam.fov, "camera.fov", { min: 10, max: 150 });
    requireNum(iss, cam.min_pitch, "camera.min_pitch");
    requireNum(iss, cam.max_pitch, "camera.max_pitch");
    if (isNum(cam.min_pitch) && isNum(cam.max_pitch) && cam.min_pitch >= cam.max_pitch) iss.err("camera.min_pitch", "must be below max_pitch");
    if (!isBool(cam.collide)) iss.err("camera.collide", "must be a boolean");
  }

  // Interactables.
  uniqueIds(iss, world.interactables, "interactables");
  (world.interactables || []).forEach((ix, i) => {
    const p = `interactables[${i}]`;
    requireEnum(iss, ix?.kind, INTERACTABLE_KINDS, `${p}.kind`);
    requireNum(iss, ix?.radius, `${p}.radius`, { min: 0.1, max: 50 });
    if (!isStr(ix?.prompt)) iss.err(`${p}.prompt`, "is required");
    if (ix?.placement_ref === null) {
      if (ix.kind !== "talk" || !isStr(ix.character_ref)) iss.err(`${p}.placement_ref`, "may be null only for a 'talk' interactable with a character_ref");
    } else if (!placementIds.has(ix?.placement_ref)) iss.err(`${p}.placement_ref`, `'${ix?.placement_ref}' is not a placement`);
    if (ix?.kind === "pickup" && !isStr(ix.item_ref)) iss.err(`${p}.item_ref`, "a pickup must name the item it grants");
    if (ix?.kind === "talk" && !isStr(ix.character_ref)) iss.err(`${p}.character_ref`, "a talk interactable must name its character");
    for (const k of ["item_ref", "locked_by", "character_ref"]) if (ix?.[k] !== undefined && !isStr(ix[k])) iss.err(`${p}.${k}`, "must be a non-empty string when present");
  });

  const navOk = checkNavigation(iss, world.navigation, size, sizeOk);

  if (iss.ok) checkRequiredIds(iss, world, opts.concept);
  if (iss.ok && terrainOk && navOk) checkGeometry(iss, world, opts);
  return iss.toJSON();
}

function checkEnvironment(iss, env) {
  if (!isObj(env)) { iss.err("environment", "is required"); return; }
  requireNum(iss, env.time_of_day, "environment.time_of_day", { min: 0, max: 1 });
  requireEnum(iss, env.weather, WEATHERS, "environment.weather");
  for (const k of ["top", "horizon", "bottom"]) if (!isHex(env.sky?.[k])) iss.err(`environment.sky.${k}`, "must be #rrggbb");
  if (!isHex(env.fog?.color)) iss.err("environment.fog.color", "must be #rrggbb");
  requireNum(iss, env.fog?.near, "environment.fog.near", { min: 0 });
  requireNum(iss, env.fog?.far, "environment.fog.far", { min: 0 });
  if (isNum(env.fog?.near) && isNum(env.fog?.far) && env.fog.near >= env.fog.far) iss.err("environment.fog.near", "must be below fog.far");
  requireNum(iss, env.sun?.azimuth_deg, "environment.sun.azimuth_deg", { min: -360, max: 360 });
  requireNum(iss, env.sun?.elevation_deg, "environment.sun.elevation_deg", { min: -90, max: 90 });
  if (!isHex(env.sun?.color)) iss.err("environment.sun.color", "must be #rrggbb");
  requireNum(iss, env.sun?.intensity, "environment.sun.intensity", { min: 0, max: 20 });
  if (!isBool(env.sun?.shadows)) iss.err("environment.sun.shadows", "must be a boolean");
  if (!isHex(env.ambient?.color)) iss.err("environment.ambient.color", "must be #rrggbb");
  if (!isHex(env.ambient?.ground_color)) iss.err("environment.ambient.ground_color", "must be #rrggbb");
  requireNum(iss, env.ambient?.intensity, "environment.ambient.intensity", { min: 0, max: 20 });
  const w = env.water;
  if (!isObj(w)) iss.err("environment.water", "is required");
  else {
    if (!isBool(w.enabled)) iss.err("environment.water.enabled", "must be a boolean");
    requireNum(iss, w.level, "environment.water.level");
    if (!isHex(w.color)) iss.err("environment.water.color", "must be #rrggbb");
    requireNum(iss, w.opacity, "environment.water.opacity", { min: 0, max: 1 });
  }
}

function checkTerrain(iss, t, size, sizeOk) {
  if (!isObj(t)) { iss.err("terrain", "is required"); return false; }
  let ok = true;
  if (t.kind !== "heightfield") iss.err("terrain.kind", "must be 'heightfield'");
  requireEnum(iss, t.shape, SHAPES, "terrain.shape");
  const dims = requireNum(iss, t.cols, "terrain.cols", { min: 2, max: 1024, integer: true })
    & requireNum(iss, t.rows, "terrain.rows", { min: 2, max: 1024, integer: true })
    & requireNum(iss, t.cell, "terrain.cell", { min: 0.01 });
  if (!dims) ok = false;
  if (!isArr(t.heights)) { iss.err("terrain.heights", "must be an array"); ok = false; }
  else if (dims && t.heights.length !== t.cols * t.rows) { iss.err("terrain.heights", `length ${t.heights.length} ≠ rows*cols (${t.rows * t.cols})`); ok = false; }
  else {
    const bad = t.heights.findIndex((h) => !isNum(h));
    if (bad >= 0) { iss.err(`terrain.heights[${bad}]`, "must be a finite number"); ok = false; }
  }
  requireNum(iss, t.min_y, "terrain.min_y");
  requireNum(iss, t.max_y, "terrain.max_y");
  if (ok && isNum(t.min_y) && isNum(t.max_y)) {
    let lo = Infinity, hi = -Infinity;
    for (const h of t.heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
    if (Math.abs(lo - t.min_y) > 0.01 || Math.abs(hi - t.max_y) > 0.01) iss.err("terrain.min_y", `min_y/max_y (${t.min_y}/${t.max_y}) disagree with the heights (${lo}/${hi})`);
  }
  if (ok && sizeOk && ((t.cols - 1) * t.cell < size.w - t.cell || (t.rows - 1) * t.cell < size.h - t.cell)) iss.warn("terrain", "heightfield does not cover the whole world; edges are clamped");
  if (!isArr(t.material_layers) || !t.material_layers.length) iss.err("terrain.material_layers", "needs at least one layer");
  else t.material_layers.forEach((m, i) => {
    const p = `terrain.material_layers[${i}]`;
    if (!isStr(m?.material_ref)) iss.err(`${p}.material_ref`, "is required");
    requireNum(iss, m?.min_h, `${p}.min_h`); requireNum(iss, m?.max_h, `${p}.max_h`);
    if (isNum(m?.min_h) && isNum(m?.max_h) && m.min_h > m.max_h) iss.err(`${p}.min_h`, "must not exceed max_h");
    requireNum(iss, m?.max_slope_deg, `${p}.max_slope_deg`, { min: 0, max: 90 });
  });
  return ok;
}

function checkNavigation(iss, nav, size, sizeOk) {
  if (!isObj(nav)) { iss.err("navigation", "is required"); return false; }
  const dims = requireNum(iss, nav.cell, "navigation.cell", { min: 0.05 })
    & requireNum(iss, nav.cols, "navigation.cols", { min: 1, integer: true })
    & requireNum(iss, nav.rows, "navigation.rows", { min: 1, integer: true });
  requireNum(iss, nav.max_slope_deg, "navigation.max_slope_deg", { min: 0, max: 90 });
  requireNum(iss, nav.step_height, "navigation.step_height", { min: 0 });
  if (!dims) return false;
  let ok = true;
  if (sizeOk && (Math.abs(nav.cols * nav.cell - size.w) > nav.cell || Math.abs(nav.rows * nav.cell - size.h) > nav.cell)) {
    iss.err("navigation", `cols*cell × rows*cell (${nav.cols * nav.cell} × ${nav.rows * nav.cell}) does not match the world size`); ok = false;
  }
  if (typeof nav.walkable !== "string" || nav.walkable.length !== nav.cols * nav.rows) {
    iss.err("navigation.walkable", `must be a string of rows*cols (${nav.cols * nav.rows}) characters`); ok = false;
  } else if (!/^[01]*$/.test(nav.walkable)) { iss.err("navigation.walkable", "may contain only '0' and '1'"); ok = false; }
  return ok;
}

/** §4.5 ids: derived from the world itself, and from the concept when given. */
function checkRequiredIds(iss, world, concept) {
  const spawns = new Map(world.spawn_points.map((s) => [s.id, s]));
  const ixs = new Map(world.interactables.map((x) => [x.id, x]));
  const placements = new Map(world.placements.map((p) => [p.id, p]));
  const player = spawns.get("spawn_player");
  if (!player) iss.err("spawn_points", "spawn_player is required");
  else if (player.kind !== "player") iss.err("spawn_points.spawn_player.kind", "must be 'player'");
  else if (player.region !== world.regions[0].id) iss.err("spawn_points.spawn_player.region", `must be the start hub '${world.regions[0].id}'`);
  world.regions.slice(1).forEach((r) => {
    const cp = spawns.get(`spawn_cp_${r.id}`);
    if (!cp || cp.kind !== "checkpoint") iss.err("spawn_points", `missing checkpoint spawn 'spawn_cp_${r.id}'`);
  });
  for (const r of world.regions) {
    if (r.location_ref && !ixs.has(`ix_${r.location_ref}`)) iss.err("interactables", `missing focal interactable 'ix_${r.location_ref}' for ${r.id}`);
  }
  const pickups = world.interactables.filter((x) => /^pickup_\d+$/.test(x.id));
  if (pickups.length < 3) iss.err("interactables", `needs at least three pickup_<n> interactables, found ${pickups.length}`);
  for (const x of pickups) {
    const n = x.id.slice(7);
    if (x.kind !== "pickup") iss.err(`interactables.${x.id}.kind`, "must be 'pickup'");
    if (x.item_ref !== `item_${n}`) iss.err(`interactables.${x.id}.item_ref`, `must be 'item_${n}'`);
    const pl = placements.get(x.placement_ref);
    if (pl && pl.role !== "pickup") iss.err(`interactables.${x.id}.placement_ref`, "must point at a placement with role 'pickup'");
    if (pl && world.regions.length > 1 && pl.region === world.regions[0].id) iss.warn(`interactables.${x.id}`, "pickups should be spread over non-hub regions");
  }
  for (const x of world.interactables) {
    if (x.id.startsWith("ix_talk_") && x.character_ref !== x.id.slice(8)) iss.err(`interactables.${x.id}.character_ref`, `must be '${x.id.slice(8)}'`);
  }
  if (!concept) return;
  const locs = concept.key_locations || [];
  locs.forEach((l, i) => {
    if (!world.regions.some((r) => r.id === `region_${l.id}`)) iss.err("regions", `missing region 'region_${l.id}'`);
    if (!ixs.has(`ix_${l.id}`)) iss.err("interactables", `missing focal interactable 'ix_${l.id}'`);
    if (i === 0 && world.regions[0]?.id !== `region_${l.id}`) iss.err("regions[0]", `must be the start hub 'region_${l.id}'`);
  });
  for (const ch of concept.characters || []) {
    if (!spawns.has(`spawn_npc_${ch.id}`)) iss.err("spawn_points", `missing npc spawn 'spawn_npc_${ch.id}'`);
    else if (spawns.get(`spawn_npc_${ch.id}`).kind !== "npc") iss.err(`spawn_points.spawn_npc_${ch.id}.kind`, "must be 'npc'");
    if (ch.role !== "enemy" && !ixs.has(`ix_talk_${ch.id}`)) iss.err("interactables", `missing talk interactable 'ix_talk_${ch.id}'`);
  }
}

/**
 * Geometry: the player spawn stands on a walkable cell outside every solid;
 * placements and spawns stand near the ground; and (unless disabled) every
 * region centre, npc/checkpoint spawn and fixed interactable is reachable
 * from the player spawn.
 */
function checkGeometry(iss, world, opts) {
  const nav = world.navigation, t = world.terrain;
  const colliders = buildColliders(world);
  const player = world.spawn_points.find((s) => s.id === "spawn_player");
  if (!isWalkable(nav, player.position.x, player.position.z)) iss.err("spawn_points.spawn_player.position", "is not on a walkable nav cell");
  const hit = pointInCollider(colliders, player.position.x, player.position.z, 0.3);
  if (hit) iss.err("spawn_points.spawn_player.position", `is inside the solid collider of '${hit.ref}'`);
  for (const s of world.spawn_points) {
    const g = sampleHeight(t, s.position.x, s.position.z);
    if (Math.abs(s.position.y - g) > 1.5) iss.warn(`spawn_points.${s.id}.position.y`, `is ${round(s.position.y - g)} m off the ground`);
  }
  if (world.environment.water.enabled && sampleHeight(t, player.position.x, player.position.z) < world.environment.water.level) {
    iss.err("spawn_points.spawn_player.position", "is under water");
  }
  // A stale nav grid. bakeNavigation blocks every cell within a solid plus the
  // player radius, so a solid whose centre still sits on a walkable cell was
  // added (by an edit, an expansion, a hand patch) without re-baking. Every
  // path check below would then plan straight through it, and the world reads
  // as winnable to every static gate while the player walks into a wall —
  // only the headless playtest used to catch it.
  for (const c of colliders) {
    if (c.solid === false) continue;
    const idx = navIndex(nav, c.center.x, c.center.z);
    if (idx < 0 || nav.walkable[idx] !== "1") continue;
    const cc = cellCenter(nav, idx);
    if (containsXZ(c, cc.x, cc.z, NAV_BAKE_PAD)) {
      iss.err("navigation.walkable", `solid collider '${c.ref}' stands on a walkable nav cell`, "re-bake navigation after changing placements");
    }
  }
  if (opts.reachability === false || !iss.ok) return;
  const reach = reachableSet(nav, player.position);
  const reachable = (x, z, r = 0) => {
    const idx = navIndex(nav, x, z);
    if (reach.has(idx)) return true;
    return r > 0 && nearestWalkable(nav, x, z, r, (i) => reach.has(i)) >= 0;
  };
  for (const r of world.regions) {
    if (!reachable(r.center.x, r.center.z, nav.cell)) iss.err(`regions.${r.id}.center`, "is not reachable from spawn_player");
  }
  for (const s of world.spawn_points) {
    if (s.kind === "player") continue;
    if (!reachable(s.position.x, s.position.z, nav.cell)) iss.err(`spawn_points.${s.id}`, "is not reachable from spawn_player");
  }
  const pmap = new Map(world.placements.map((p) => [p.id, p]));
  for (const ix of world.interactables) {
    if (!ix.placement_ref) continue;
    const pl = pmap.get(ix.placement_ref);
    if (!reachable(pl.position.x, pl.position.z, ix.radius)) iss.err(`interactables.${ix.id}`, `no reachable ground within its radius (${ix.radius} m)`);
    else if (ix.radius < footprintRadius(pl) && pl.collider?.solid) iss.warn(`interactables.${ix.id}.radius`, "is smaller than the placement's footprint");
  }
}

const round = (v) => Math.round(v * 100) / 100;
