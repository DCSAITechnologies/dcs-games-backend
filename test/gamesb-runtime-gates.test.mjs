// Games-B runtime gates on the hand-built fixture package: assembly/integrity,
// validatePackage cross-checks, headless playtest + save/reload, objective
// reachability and the WorldManifestV3 bridge. Uses mock sim deps, so it does
// not depend on the other stages; validatePackage additionally runs whichever
// stage validators exist and reports the rest in `skipped`.
import test from "node:test";
import assert from "node:assert/strict";
import { assemblePackage, computeIntegrity, seal, EDIT_OPS } from "../src/gamesb/runtime/assemble.mjs";
import { validatePackage, estimateBudgets } from "../src/gamesb/runtime/validate-package.mjs";
import { headlessPlaytest, checkObjectiveReachability } from "../src/gamesb/runtime/headless-playtest.mjs";
import { toManifestV3 } from "../src/gamesb/runtime/to-manifest-v3.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";
import { mockDeps } from "./fixtures/gamesb/runtime/mock-deps.mjs";
import { fixtureParts, fixturePackage } from "./fixtures/gamesb/runtime/fixture-package.mjs";

const assembled = () => { const p = fixtureParts(); return assemblePackage({ gameId: "fixture_isle", ...p, createdAt: "2026-09-28T00:00:00.000Z" }); };
const mutate = (fn) => { const pkg = JSON.parse(JSON.stringify(assembled())); fn(pkg); return seal(pkg); };

test("assemble: §7 shape, hooks, companion and a matching integrity hash", () => {
  const pkg = assembled();
  assert.equal(pkg.package_version, "1.0.0");
  assert.equal(pkg.version, 1);
  assert.deepEqual(pkg.hooks.edit.ops, [...EDIT_OPS]);
  assert.equal(pkg.hooks.companion.character_ref, "maren");
  assert.equal(pkg.provenance.pipeline_version, "gamesb-1.0.0");
  assert.equal(pkg.provenance.stages.at(-1).stage, "assemble");
  assert.equal(pkg.integrity.sha256, computeIntegrity(pkg));
  assert.equal(assembled().integrity.sha256, pkg.integrity.sha256, "deterministic with a fixed createdAt");
});

test("validatePackage: the fixture is ok and reports what it checked", () => {
  const v = validatePackage(assembled());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  for (const c of ["shape", "integrity", "asset_refs", "world_refs", "scripts", "budgets"]) assert.ok(v.checks.includes(c), c);
});

test("validatePackage: a tampered package fails the integrity check", () => {
  const pkg = assembled();
  const bad = JSON.parse(JSON.stringify(pkg));
  bad.gameplay.rules.lives = 99;
  const v = validatePackage(bad);
  assert.ok(v.errors.some((e) => e.path === "integrity.sha256"));
});

test("validatePackage: a removed asset record is a missing asset ref", () => {
  const pkg = mutate((p) => { p.assets.records = p.assets.records.filter((r) => r.ref !== "lib:chest"); });
  const v = validatePackage(pkg);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /lib:chest/.test(e.message) && e.path.startsWith("world.placements")), JSON.stringify(v.errors));
  assert.ok(v.errors.some((e) => /lib:chest/.test(e.message) && e.path.startsWith("scene.nodes")));
});

test("validatePackage: a missing material referenced by a mesh part is caught", () => {
  const pkg = mutate((p) => { p.assets.records = p.assets.records.filter((r) => r.ref !== "mat:stone"); });
  assert.ok(validatePackage(pkg).errors.some((e) => /part material 'mat:stone'/.test(e.message)));
});

test("validatePackage: interactable on a missing placement is caught", () => {
  const pkg = mutate((p) => { p.world.interactables.find((i) => i.id === "ix_lantern").placement_ref = "pl_gone"; });
  assert.ok(validatePackage(pkg).errors.some((e) => /has no placement 'pl_gone'/.test(e.message)));
});

test("validatePackage: broken scripts — unknown action kind, dangling refs, unknown trigger", () => {
  let v = validatePackage(mutate((p) => { p.gameplay.events[0].actions.push({ kind: "summon_dragon", ref: "x" }); }));
  assert.ok(v.errors.some((e) => /unknown action kind 'summon_dragon'/.test(e.message)), JSON.stringify(v.errors));
  v = validatePackage(mutate((p) => { p.characters.dialogues[0].nodes[1].choices[0].actions.push({ kind: "give_item", ref: "item_404" }); }));
  assert.ok(v.errors.some((e) => /give_item names unknown item 'item_404'/.test(e.message)));
  v = validatePackage(mutate((p) => { p.gameplay.events[0].actions[0].ref = "nobody"; }));
  assert.ok(v.errors.some((e) => /set_npc_state names unknown character 'nobody'/.test(e.message)));
  v = validatePackage(mutate((p) => { p.characters.dialogues[0].nodes[0].choices[0].actions.push({ kind: "teleport_player" }); }));
  assert.ok(v.errors.some((e) => /unknown action kind 'teleport_player'/.test(e.message)));
  v = validatePackage(mutate((p) => { p.gameplay.events[0].trigger = { kind: "full_moon" }; }));
  assert.ok(v.errors.some((e) => /trigger/.test(e.path)));
});

test("validatePackage: performance budget is measured and enforced", () => {
  const pkg = assembled();
  const b = estimateBudgets(pkg);
  assert.ok(b.triangles > 1600 * 2, "terrain triangles counted");
  assert.ok(b.draw_calls >= 8);
  assert.ok(b.texture_mb > 0.9 && b.texture_mb < 1.1, "one 256² texture set ≈ 1 MB");
  const v = validatePackage(pkg, { budgets: { triangles: 1000, draw_calls: 3, texture_mb: 0.5 } });
  for (const k of ["triangles", "draw_calls", "texture_mb"]) assert.ok(v.errors.some((e) => e.path === `budgets.${k}`), k);
  assert.equal(v.budgets.limits.triangles, 1000);
});

test("headlessPlaytest: the agent finishes the fixture and verifies save/reload midway", async () => {
  const r = await headlessPlaytest(assembled(), { deps: mockDeps });
  assert.equal(r.won, true, JSON.stringify({ reason: r.reason, pending: r.pending }));
  assert.deepEqual([...r.objectives_done].sort(), ["obj_key", "obj_open", "obj_talk"]);
  assert.equal(r.save_reload.ok, true, JSON.stringify(r.save_reload));
  assert.ok(r.timeline.some((e) => e.kind === "save_reload"));
  assert.ok(r.sim_seconds < 60);
  assert.ok(r.timeline.some((e) => e.kind === "locked") === false, "the solver order fetched the key first");
});

test("headlessPlaytest: an unreachable key is reported as not won, not a hang", async () => {
  // Put the key on top of the steep plateau: nav-walkable up there, but not connected.
  const pkg = mutate((p) => { p.world.placements.find((x) => x.id === "pl_pickup_1").position = { x: 64, y: 12, z: 14 }; });
  const r = await headlessPlaytest(pkg, { deps: mockDeps, maxSimSeconds: 90 });
  assert.equal(r.won, false);
  assert.ok(r.pending.some((p) => p.startsWith("obj_key")));
  assert.ok(r.reason);
});

test("checkObjectiveReachability: all targets reachable, and a stranded one is flagged", async () => {
  const ok = await checkObjectiveReachability(assembled(), { deps: mockDeps });
  assert.equal(ok.ok, true, JSON.stringify(ok.results));
  const bad = await checkObjectiveReachability(mutate((p) => { p.world.placements.find((x) => x.id === "pl_pickup_1").position = { x: 64, y: 12, z: 14 }; }), { deps: mockDeps });
  assert.equal(bad.ok, false);
  assert.equal(bad.results.find((r) => r.objective_id === "obj_key").reachable, false);
});

test("toManifestV3: the projection passes validateManifest and references the package", () => {
  const pkg = assembled();
  const m = toManifestV3(pkg);
  const v = validateManifest(m);
  assert.deepEqual(v.errors, []);
  assert.equal(m.world_id, pkg.game_id);
  assert.equal(m.gamesb.package_sha256, pkg.integrity.sha256);
  assert.deepEqual(m.zones.map((z) => z.id), ["region_hub", "region_ruin", "region_field"]);
  assert.equal(m.npcs.length, 2);
  assert.equal(m.quests[0].steps.length, 3);
  assert.equal(m.quests[0].steps.find((s) => s.id === "obj_open").target, "pl_ruin", "interactable target projected onto its placement");
  assert.ok(m.interactions.some((i) => i.id === "ix_talk_maren" && i.target_ref === "maren"));
  assert.equal(m.spawn.player_spawns[0].id, "spawn_player");
  assert.equal(m.terrain.data.length, pkg.world.terrain.rows);
});

test("fixturePackage helper and assemblePackage agree on content", () => {
  const a = fixturePackage(), b = assembled();
  assert.deepEqual(a.world, b.world);
  assert.deepEqual(a.gameplay, b.gameplay);
});
