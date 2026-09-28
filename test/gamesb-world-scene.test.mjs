// Games-B world stage: scene graph compile/validate and scatter expansion.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateWorldSpec, compileSceneGraph, validateSceneGraph, sceneAssetRefs, sceneMaterialRefs, expandScatter,
  footprintRadius, distToPolyline, buildColliders } from "../src/gamesb/world/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ISLAND = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/gamesb/world/island-concept.json"), "utf8"));
const world = generateWorldSpec(ISLAND);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Fake AssetRecords: one per logical ref, alternating ref / asset_id matching. */
function fakeRecords(refs) {
  return refs.map((ref, i) => (i % 2 ? { asset_id: ref, ref: null, kind: "prop" } : { asset_id: `ast_${i.toString(16).padStart(16, "0")}`, ref, kind: "prop" }));
}

test("compiled scene is complete, resolves against records for its logical refs, and matches the world", () => {
  const scene = compileSceneGraph(world, {});
  const refs = sceneAssetRefs(scene);
  assert.ok(refs.includes("lib:lighthouse") && refs.includes("char:keeper_maren") && refs.includes("lib:palm_tree"));
  const assets = fakeRecords([...refs, ...sceneMaterialRefs(scene)]);
  const v = validateSceneGraph(scene, { assets, world });
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  const count = (t) => scene.nodes.filter((n) => n.type === t).length;
  for (const t of ["root", "environment", "sky", "sun_light", "ambient_light", "terrain", "camera_rig", "nav_grid", "fog", "water"]) assert.equal(count(t), 1, t);
  assert.equal(count("region"), world.regions.length);
  assert.equal(count("mesh_instance"), world.placements.length);
  assert.equal(count("instanced_group"), world.scatter.length);
  assert.equal(count("character"), ISLAND.characters.length);
  assert.equal(count("spawn"), world.spawn_points.length);
  assert.equal(count("interactable"), world.interactables.length);
  assert.equal(count("trigger_volume"), world.regions.length + world.interactables.length);
  assert.ok(count("audio_emitter") >= 3, "biome + weather ambience");
  const cues = scene.nodes.filter((n) => n.type === "audio_emitter").map((n) => n.cue);
  assert.ok(cues.includes("amb_surf"));
  // Instanced counts equal the deterministic expansion.
  const inst = expandScatter(world);
  for (const g of scene.nodes.filter((n) => n.type === "instanced_group")) {
    assert.equal(g.count, inst.filter((i) => i.scatter_id === g.scatter_ref).length);
  }
  // Talk interactables hang off their character.
  const talk = scene.nodes.find((n) => n.id === "interactable:ix_talk_keeper_maren");
  assert.equal(talk.parent, "character:keeper_maren");
  assert.equal(talk.placement_ref, null);
  // Sun direction is a unit vector pointing up at the light.
  const sun = scene.nodes.find((n) => n.type === "sun_light");
  assert.ok(Math.abs(Math.hypot(sun.direction.x, sun.direction.y, sun.direction.z) - 1) < 0.01);
  assert.ok(sun.direction.y > 0);
  assert.equal(scene.transform_space, "world");
  // Deterministic.
  assert.equal(JSON.stringify(compileSceneGraph(world, {})), JSON.stringify(scene));
});

test("CharactersSpec asset_refs are used when supplied", () => {
  const characters = { character_spec_version: "1.0.0", characters: ISLAND.characters.map((c) => ({ id: c.id, name: c.name, asset_ref: `ast_${c.id}`, spawn_ref: `spawn_npc_${c.id}` })) };
  const scene = compileSceneGraph(world, { characters });
  const ch = scene.nodes.filter((n) => n.type === "character");
  assert.ok(ch.every((n) => n.asset_ref === `ast_${n.character_ref}`));
});

test("missing asset refs are detected by name", () => {
  const scene = compileSceneGraph(world, {});
  const refs = sceneAssetRefs(scene).filter((r) => r !== "lib:lighthouse" && r !== "char:pip");
  const v = validateSceneGraph(scene, { assets: { records: fakeRecords(refs) } });
  assert.equal(v.ok, false);
  const msgs = v.errors.map((e) => e.message).join("\n");
  assert.match(msgs, /'lib:lighthouse' does not resolve/);
  assert.match(msgs, /'char:pip' does not resolve/);
  // Material layers unresolved: warnings, not errors.
  assert.ok(v.warnings.some((w) => /mat:sand/.test(w.message)));
  // No assets at all: a warning, no resolution errors.
  const noAssets = validateSceneGraph(scene, {});
  assert.equal(noAssets.ok, true);
  assert.ok(noAssets.warnings.some((w) => w.path === "assets"));
});

test("scene structure violations are caught", () => {
  const good = compileSceneGraph(world, {});
  const cases = [
    ["two roots", (s) => s.nodes.push({ id: "root2", type: "root", parent: null })],
    ["missing sky", (s) => { s.nodes = s.nodes.filter((n) => n.type !== "sky"); }],
    ["missing camera", (s) => { s.nodes = s.nodes.filter((n) => n.type !== "camera_rig"); }],
    ["dangling parent", (s) => { s.nodes.find((n) => n.type === "mesh_instance").parent = "region:nowhere"; }],
    ["duplicate id", (s) => { s.nodes[5].id = s.nodes[4].id; }],
    ["no player spawn", (s) => { s.nodes = s.nodes.filter((n) => !(n.type === "spawn" && n.kind === "player")); }],
    ["unknown type", (s) => { s.nodes[3].type = "hologram"; }],
    ["bad version", (s) => { s.scene_graph_version = "2.0.0"; }],
    ["placement_ref not in world", (s) => { s.nodes.find((n) => n.type === "mesh_instance").placement_ref = "pl_ghost"; }],
    ["parent cycle", (s) => { const a = s.nodes.find((n) => n.type === "region"); const t = s.nodes.find((n) => n.parent === a.id); a.parent = t.id; }],
  ];
  for (const [name, mutate] of cases) {
    const s = clone(good);
    mutate(s);
    assert.equal(validateSceneGraph(s, { world }).ok, false, name);
  }
});

test("scatter expansion is deterministic and keeps out of footprints, paths, pads and the sea", () => {
  const a = expandScatter(world), b = expandScatter(clone(world));
  assert.deepEqual(a, b);
  assert.ok(a.length > 100);
  const solids = world.placements.filter((p) => p.role !== "pickup");
  const byId = new Map(world.scatter.map((s) => [s.id, s]));
  const wl = world.environment.water.level;
  for (const i of a) {
    const s = byId.get(i.scatter_id);
    const self = Math.max(s.collider_radius, 0.5);
    for (const p of solids) {
      assert.ok(Math.hypot(p.position.x - i.position.x, p.position.z - i.position.z) >= footprintRadius(p) + 0.8 + self - 0.02,
        `${i.scatter_id} inside the footprint of ${p.id}`);
    }
    if (s.avoid_paths) for (const p of world.paths) assert.ok(distToPolyline(p.points, i.position.x, i.position.z) >= p.width / 2 + 1 + self - 0.02, `${i.scatter_id} on ${p.id}`);
    for (const r of world.regions) assert.ok(Math.hypot(r.center.x - i.position.x, r.center.z - i.position.z) >= r.pad_radius, `${i.scatter_id} on the ${r.id} pad`);
    if (s.zone !== "shore") assert.ok(i.position.y >= wl + 0.4 - 0.02, `${i.scatter_id} under water`);
    assert.ok(i.scale >= s.min_scale - 0.01 && i.scale <= s.max_scale + 0.01);
    assert.equal(i.asset_ref, s.asset_ref);
  }
  // Reeds hug the shoreline.
  const reeds = a.filter((i) => i.scatter_id === "sc_reeds");
  assert.ok(reeds.length > 0 && reeds.every((i) => i.position.y < wl + 1));
  // Colliders from scatter carry the scaled radius.
  const cols = buildColliders(world);
  const tree = a.find((i) => i.collider_radius > 0);
  assert.ok(cols.some((c) => c.center.x === tree.position.x && c.center.z === tree.position.z && c.radius === tree.collider_radius));
});

test("dropping one scatter instance does not reshuffle the others", () => {
  // Adding an obstacle may remove or move instances near it, but instances
  // far from it are drawn from their own streams and must not move.
  const w2 = clone(world);
  const hub = w2.regions[0];
  w2.placements.push({ id: "pl_probe", asset_ref: "lib:statue", region: hub.id, position: { x: hub.center.x + 15, y: 0, z: hub.center.z }, rotation_y: 0, scale: 1,
    role: "landmark", collider: { shape: "cylinder", radius: 3, height: 3, solid: true }, tags: [] });
  const before = expandScatter(world), after = expandScatter(w2);
  const key = (i) => `${i.scatter_id}|${i.position.x}|${i.position.z}`;
  const afterKeys = new Set(after.map(key));
  const far = before.filter((i) => Math.hypot(i.position.x - (hub.center.x + 15), i.position.z - hub.center.z) > 10);
  assert.ok(far.every((i) => afterKeys.has(key(i))));
});
