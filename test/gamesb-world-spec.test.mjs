// Games-B world stage: WorldSpec generation and validation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateWorldSpec, validateWorldSpec, findPath, isWalkable, navIndex, buildColliders, pointInCollider,
  reachableSet, nearestWalkable, sampleHeight, segmentWalkable, LIB_NAMES, BIOMES } from "../src/gamesb/world/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/gamesb/world", f), "utf8"));
const ISLAND = load("island-concept.json");
const DESERT = load("desert-camp-concept.json");
const clone = (v) => JSON.parse(JSON.stringify(v));

const islandWorld = generateWorldSpec(ISLAND);

test("island fixture generates a valid world with the §4.5 ids", () => {
  const v = validateWorldSpec(islandWorld, { concept: ISLAND });
  assert.deepEqual(v.errors, []);
  assert.equal(islandWorld.world_spec_version, "1.0.0");
  assert.equal(islandWorld.size.w, 240);
  assert.equal(islandWorld.terrain.shape, "island");
  assert.ok(islandWorld.environment.water.enabled);
  const ids = (arr) => new Set(arr.map((x) => x.id));
  const regions = ids(islandWorld.regions), spawns = ids(islandWorld.spawn_points), ixs = ids(islandWorld.interactables);
  assert.equal(islandWorld.regions[0].id, "region_harbour_village");
  for (const l of ISLAND.key_locations) {
    assert.ok(regions.has(`region_${l.id}`), l.id);
    assert.ok(ixs.has(`ix_${l.id}`), l.id);
  }
  for (const r of islandWorld.regions.slice(1)) assert.ok(spawns.has(`spawn_cp_${r.id}`), r.id);
  for (const c of ISLAND.characters) {
    assert.ok(spawns.has(`spawn_npc_${c.id}`), c.id);
    assert.equal(ixs.has(`ix_talk_${c.id}`), c.role !== "enemy", c.id);
  }
  const pickups = islandWorld.interactables.filter((x) => x.kind === "pickup");
  assert.ok(pickups.length >= 3);
  const pl = new Map(islandWorld.placements.map((p) => [p.id, p]));
  for (const p of pickups) {
    assert.equal(p.item_ref, `item_${p.id.slice(7)}`);
    assert.equal(pl.get(p.placement_ref).role, "pickup");
    assert.notEqual(pl.get(p.placement_ref).region, islandWorld.regions[0].id, "pickups live outside the hub");
  }
  // Focal kinds follow the §4.5 mapping.
  const kindOf = Object.fromEntries(islandWorld.interactables.map((x) => [x.id, x.kind]));
  assert.equal(kindOf.ix_old_lighthouse, "lantern");
  assert.equal(kindOf.ix_sunken_ruins, "container");
  assert.equal(kindOf.ix_moss_shrine, "altar");
  assert.equal(kindOf.ix_gull_dock, "sign");
  assert.equal(kindOf.ix_harbour_village, "sign");
  // Only §4.1a lib names.
  for (const p of islandWorld.placements) assert.ok(LIB_NAMES.includes(p.asset_ref.slice(4)), p.asset_ref);
  for (const s of islandWorld.scatter) assert.ok(LIB_NAMES.includes(s.asset_ref.slice(4)), s.asset_ref);
  // Every location is composed of several pieces with colliders.
  for (const r of islandWorld.regions) {
    const pieces = islandWorld.placements.filter((p) => p.region === r.id && p.role !== "pickup");
    assert.ok(pieces.length >= 3, `${r.id} has ${pieces.length} pieces`);
    assert.ok(pieces.some((p) => p.collider.solid), `${r.id} has a solid piece`);
  }
});

test("island terrain looks like an island: sea around, beach, raised summit", () => {
  const t = islandWorld.terrain, wl = islandWorld.environment.water.level;
  const edgeH = [t.heights[0], t.heights[t.cols - 1], t.heights[(t.rows - 1) * t.cols], t.heights[t.rows * t.cols - 1]];
  assert.ok(edgeH.every((h) => h < wl - 2), "corners are under the sea");
  const land = t.heights.filter((h) => h > wl).length / t.heights.length;
  assert.ok(land > 0.25 && land < 0.75, `land fraction ${land}`);
  assert.ok(t.max_y > wl + 10, "a raised summit");
  assert.ok(t.heights.length <= 160 * 160);
  const layers = t.material_layers.map((m) => m.material_ref);
  assert.deepEqual(layers, ["mat:sand", "mat:grass", "mat:rock"]);
});

test("generation is deterministic: same concept + seed gives identical JSON; a new seed changes it", () => {
  const a = JSON.stringify(generateWorldSpec(ISLAND));
  const b = JSON.stringify(generateWorldSpec(clone(ISLAND)));
  assert.equal(a, b);
  assert.equal(a, JSON.stringify(islandWorld));
  const c = JSON.stringify(generateWorldSpec(ISLAND, { seed: 7 }));
  assert.notEqual(a, c);
  assert.equal(JSON.stringify(generateWorldSpec(ISLAND, { seed: 7 })), c);
});

// ---------------------------------------------------------------- mutations

const MUTATIONS = [
  ["wrong version", (w) => { w.world_spec_version = "0.9.0"; }, "world_spec_version"],
  ["heights length", (w) => { w.terrain.heights.pop(); }, "terrain.heights"],
  ["non-finite height", (w) => { w.terrain.heights[5] = null; }, "terrain.heights[5]"],
  ["walkable length", (w) => { w.navigation.walkable = w.navigation.walkable.slice(1); }, "navigation.walkable"],
  ["nav dims vs size", (w) => { w.navigation.cols += 7; }, "navigation"],
  ["missing spawn_player", (w) => { w.spawn_points = w.spawn_points.filter((s) => s.id !== "spawn_player"); }, "spawn_points"],
  ["spawn outside the world", (w) => { w.spawn_points.find((s) => s.id === "spawn_player").position.x = -5; }, "spawn_points[0].position"],
  ["spawn on an unwalkable cell", (w) => {
    const s = w.spawn_points.find((x) => x.id === "spawn_player");
    const idx = w.navigation.walkable.indexOf("0");
    const i = idx % w.navigation.cols, j = Math.floor(idx / w.navigation.cols);
    s.position.x = (i + 0.5) * w.navigation.cell; s.position.z = (j + 0.5) * w.navigation.cell;
  }, "spawn_points.spawn_player.position"],
  ["spawn inside a solid collider", (w) => {
    const s = w.spawn_points.find((x) => x.id === "spawn_player");
    const hut = w.placements.find((p) => p.region === w.regions[0].id && p.collider.shape === "box" && p.collider.solid);
    s.position.x = hut.position.x; s.position.z = hut.position.z;
    // Keep the nav cell walkable so only the collider check can catch it.
    const idx = navIndex(w.navigation, s.position.x, s.position.z);
    w.navigation.walkable = w.navigation.walkable.slice(0, idx) + "1" + w.navigation.walkable.slice(idx + 1);
  }, "spawn_points.spawn_player.position"],
  ["dangling placement_ref", (w) => { w.interactables[0].placement_ref = "pl_nope"; }, "interactables[0].placement_ref"],
  ["null placement_ref on a non-talk", (w) => { w.interactables[0].placement_ref = null; }, "interactables[0].placement_ref"],
  ["talk without character_ref", (w) => { const t = w.interactables.find((x) => x.kind === "talk"); delete t.character_ref; }, "placement_ref"],
  ["path to an unknown region", (w) => { w.paths[0].to_region = "region_atlantis"; }, "paths[0].to_region"],
  ["empty material_layers", (w) => { w.terrain.material_layers = []; }, "terrain.material_layers"],
  ["region bounds outside size", (w) => { w.regions[1].bounds[2] = w.size.w + 40; }, "regions[1].bounds"],
  ["duplicate placement id", (w) => { w.placements[1].id = w.placements[0].id; }, "placements[1].id"],
  ["missing focal interactable", (w) => { w.interactables = w.interactables.filter((x) => x.id !== "ix_moss_shrine"); }, "interactables"],
  ["too few pickups", (w) => { w.interactables = w.interactables.filter((x) => x.id !== "pickup_1" && x.id !== "pickup_2"); }, "interactables"],
  ["bad colour", (w) => { w.environment.sky.top = "blue"; }, "environment.sky.top"],
  ["scatter min > max", (w) => { w.scatter[0].min_scale = 5; }, "scatter[0].min_scale"],
  ["bad biome enum", (w) => { w.biome = "moon"; }, "biome"],
  ["pickup item_ref mismatch", (w) => { w.interactables.find((x) => x.id === "pickup_1").item_ref = "item_9"; }, "interactables.pickup_1.item_ref"],
  ["missing checkpoint", (w) => { w.spawn_points = w.spawn_points.filter((s) => !s.id.startsWith("spawn_cp_region_gull_dock")); }, "spawn_points"],
  ["missing npc spawn (concept)", (w) => { w.spawn_points = w.spawn_points.filter((s) => s.id !== "spawn_npc_pip"); }, "spawn_points"],
  ["region centre walled off", (w) => {
    // Block every nav cell around the dock so it becomes unreachable.
    const r = w.regions.find((x) => x.id === "region_gull_dock");
    const nav = w.navigation; const arr = nav.walkable.split("");
    for (let j = 0; j < nav.rows; j++) for (let i = 0; i < nav.cols; i++) {
      const d = Math.hypot((i + 0.5) * nav.cell - r.center.x, (j + 0.5) * nav.cell - r.center.z);
      if (d > 22 && d < 26) arr[j * nav.cols + i] = "0";
    }
    nav.walkable = arr.join("");
  }, "regions.region_gull_dock.center"],
];

test(`validator catches ${MUTATIONS.length} mutated-invalid worlds`, () => {
  assert.ok(MUTATIONS.length >= 12);
  for (const [name, mutate, pathHint] of MUTATIONS) {
    const w = clone(islandWorld);
    mutate(w);
    const v = validateWorldSpec(w, { concept: ISLAND });
    assert.equal(v.ok, false, `mutation '${name}' was not caught`);
    assert.ok(v.errors.some((e) => e.path.includes(pathHint)), `mutation '${name}': expected an error at ${pathHint}, got ${JSON.stringify(v.errors.slice(0, 3))}`);
  }
});

test("validator rejects non-objects without throwing", () => {
  assert.equal(validateWorldSpec(null).ok, false);
  assert.equal(validateWorldSpec({}).ok, false);
  assert.equal(validateWorldSpec({ world_spec_version: "1.0.0", terrain: { heights: "x" } }).ok, false);
});

// ------------------------------------------------------ all biomes × scales

const KINDS = ["village", "summit", "camp", "cave", "grove", "landmark", "tower", "ruin", "shrine", "dock"];
function conceptFor(biome, scale, k) {
  const locs = [{ id: "home", name: "Home", kind: "hub", description: "" }];
  for (let i = 1; i < 5; i++) locs.push({ id: `loc_${i}`, name: `Place ${i}`, kind: KINDS[(i + k) % KINDS.length], description: "" });
  return {
    concept_version: "1.0.0", title: `${biome} ${scale}`, seed: 1000 + k * 17, genre: "exploration", biome, scale,
    time_of_day: (k % 10) / 10, weather: ["clear", "rain", "fog", "storm", "snow", "sandstorm", "ash", "cloudy"][k % 8],
    palette: { primary: "#446688", secondary: "#886644", accent: "#ffcc00", ground: "#667744", sky: "#88bbee", water: "#336699" },
    key_locations: locs,
    characters: [{ id: "friend", name: "Friend", role: "companion" }, { id: "boss", name: "Boss", role: "enemy" }, { id: "beast", name: "Beast", role: "creature" }, { id: "warden", name: "Warden", role: "guard" }],
  };
}

const SCALES = ["small", "medium", "large"];
const MATRIX = [];
let k = 0;
for (const biome of BIOMES) for (const scale of SCALES) {
  const concept = conceptFor(biome, scale, k++);
  const t0 = performance.now();
  const world = generateWorldSpec(concept);
  MATRIX.push({ biome, scale, concept, world, ms: performance.now() - t0 });
}

test("all 9 biomes × 3 scales generate valid worlds within the time budget", () => {
  const edge = { small: 160, medium: 240, large: 320 };
  for (const { biome, scale, concept, world, ms } of MATRIX) {
    const v = validateWorldSpec(world, { concept });
    assert.deepEqual(v.errors, [], `${biome}/${scale}`);
    assert.equal(world.size.w, edge[scale]);
    assert.ok(world.terrain.cols <= 160 && world.terrain.rows <= 160);
    assert.ok(ms < 1500, `${biome}/${scale} took ${ms.toFixed(0)} ms`);
  }
  const worst = Math.max(...MATRIX.map((m) => m.ms));
  console.log(`# world generation: worst ${worst.toFixed(0)} ms over ${MATRIX.length} biome×scale worlds`);
});

test("spawns are in bounds, on walkable ground and clear of colliders", () => {
  for (const { biome, scale, world } of [...MATRIX, { biome: "island", scale: "fixture", world: islandWorld }]) {
    const cols = buildColliders(world);
    for (const s of world.spawn_points) {
      const tag = `${biome}/${scale} ${s.id}`;
      assert.ok(s.position.x >= 0 && s.position.x <= world.size.w && s.position.z >= 0 && s.position.z <= world.size.h, tag);
      assert.ok(isWalkable(world.navigation, s.position.x, s.position.z), `${tag} walkable`);
      assert.equal(pointInCollider(cols, s.position.x, s.position.z, 0.45), null, `${tag} clear of colliders`);
      assert.ok(Math.abs(s.position.y - sampleHeight(world.terrain, s.position.x, s.position.z)) < 0.05, `${tag} on the ground`);
      if (world.environment.water.enabled) assert.ok(s.position.y > world.environment.water.level, `${tag} above water`);
    }
    const p = world.spawn_points.find((s) => s.id === "spawn_player");
    assert.equal(p.region, world.regions[0].id);
  }
});

/** Every sample along the returned polyline lies on a walkable cell. */
function assertPathWalkable(nav, pts, tag) {
  for (let q = 0; q + 1 < pts.length; q++) {
    const a = pts[q], b = pts[q + 1];
    assert.ok(segmentWalkable(nav, a, b), `${tag}: segment ${q} crosses a blocked cell`);
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (nav.cell / 5)));
    for (let s = 0; s <= n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n, z = a.z + ((b.z - a.z) * s) / n;
      assert.ok(isWalkable(nav, x, z), `${tag}: point ${x.toFixed(2)},${z.toFixed(2)} unwalkable`);
    }
  }
}

test("every region centre, fixed interactable and npc spawn is reachable from spawn_player by findPath", () => {
  let searched = 0;
  for (const { biome, scale, world } of [...MATRIX, { biome: "island", scale: "fixture", world: islandWorld }]) {
    const nav = world.navigation;
    const start = world.spawn_points.find((s) => s.id === "spawn_player").position;
    const reach = reachableSet(nav, start);
    const targets = [];
    for (const r of world.regions) targets.push([r.id, r.center, nav.cell]);
    const pl = new Map(world.placements.map((p) => [p.id, p]));
    for (const ix of world.interactables) if (ix.placement_ref) targets.push([ix.id, pl.get(ix.placement_ref).position, ix.radius]);
    for (const s of world.spawn_points) if (s.kind === "npc" || s.kind === "checkpoint") targets.push([s.id, s.position, 0]);
    for (const [id, pos, radius] of targets) {
      // Target the nearest reachable walkable cell within the interaction
      // radius — the thing itself may be solid.
      let goal = pos;
      if (!isWalkable(nav, pos.x, pos.z) || radius > 0) {
        const idx = nearestWalkable(nav, pos.x, pos.z, Math.max(radius, nav.cell), (i) => reach.has(i));
        assert.ok(idx >= 0, `${biome}/${scale} ${id}: nothing walkable within ${radius} m`);
        goal = { x: ((idx % nav.cols) + 0.5) * nav.cell, z: (Math.floor(idx / nav.cols) + 0.5) * nav.cell };
      }
      const route = findPath(nav, start, goal);
      assert.ok(route && route.length >= 1, `${biome}/${scale} ${id} unreachable`);
      assertPathWalkable(nav, route, `${biome}/${scale} ${id}`);
      searched++;
    }
  }
  assert.ok(searched > 300);
});

test("desert camp fixture: valid, sandstorm fog is short, no water", () => {
  const w = generateWorldSpec(DESERT);
  assert.deepEqual(validateWorldSpec(w, { concept: DESERT }).errors, []);
  assert.equal(w.environment.water.enabled, false);
  assert.equal(w.terrain.shape, "open");
  assert.ok(w.environment.fog.far < w.size.w, "sandstorm fog closes in");
  assert.ok(w.placements.some((p) => p.asset_ref === "lib:cliff_rock"), "cave uses cliff rocks");
  assert.ok(w.interactables.some((x) => x.id === "ix_talk_dune_stalker"), "creatures still get a talk interactable (only enemies do not)");
  assert.ok(!w.interactables.some((x) => x.id === "ix_talk_boss"));
});

test("environment follows time of day and weather", () => {
  const noon = generateWorldSpec({ ...ISLAND, time_of_day: 0.5, weather: "clear" }).environment;
  const dusk = generateWorldSpec({ ...ISLAND, time_of_day: 0.76, weather: "clear" }).environment;
  const night = generateWorldSpec({ ...ISLAND, time_of_day: 0.95, weather: "clear" }).environment;
  const fog = generateWorldSpec({ ...ISLAND, time_of_day: 0.5, weather: "fog" }).environment;
  assert.ok(noon.sun.elevation_deg > 60);
  assert.ok(dusk.sun.elevation_deg < 20 && dusk.sun.azimuth_deg > 240, "low in the west at dusk");
  assert.ok(night.sun.intensity < 0.4 && night.ambient.intensity < noon.ambient.intensity);
  assert.ok(fog.fog.far < noon.fog.far / 3);
  assert.ok(fog.sun.intensity < noon.sun.intensity);
});

test("degenerate concepts still produce a valid world", () => {
  const bare = { title: "Bare", biome: "nowhere", scale: "huge" };
  const w = generateWorldSpec(bare, { seed: 3 });
  assert.deepEqual(validateWorldSpec(w).errors, []);
  assert.equal(w.regions.length, 1);
  assert.equal(w.biome, "island");
  const one = generateWorldSpec({ ...ISLAND, key_locations: [ISLAND.key_locations[0]], characters: [] });
  const v = validateWorldSpec(one);
  assert.deepEqual(v.errors, []);
  assert.equal(one.interactables.filter((x) => x.kind === "pickup").length, 3, "pickups fall back to the hub");
});
