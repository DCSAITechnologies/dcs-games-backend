// Games-B hooks on the fixture package: edit ops (happy + rejection paths),
// deterministic expansion that preserves ids and stays winnable, and the
// gated static publish. Sim deps are mocks so the playtest gate is fast and
// independent of the other stages.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyEdit, applyEdits, EditRejected, EDIT_OPS } from "../src/gamesb/hooks/edit.mjs";
import { expandWorld } from "../src/gamesb/hooks/expand.mjs";
import { publishPackage, PublishRefused } from "../src/gamesb/hooks/publish.mjs";
import { validatePackage } from "../src/gamesb/runtime/validate-package.mjs";
import { headlessPlaytest } from "../src/gamesb/runtime/headless-playtest.mjs";
import { computeIntegrity, seal, EDIT_OPS as PKG_EDIT_OPS } from "../src/gamesb/runtime/assemble.mjs";
import { sha256 } from "../src/gamesb/common/hash.mjs";
import { mockDeps } from "./fixtures/gamesb/runtime/mock-deps.mjs";
import { fixturePackage } from "./fixtures/gamesb/runtime/fixture-package.mjs";

const HAS_BAKE = fs.existsSync(new URL("../src/gamesb/world/world-spec.mjs", import.meta.url));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `gamesb-${name}-`));

function edited(op) {
  const base = fixturePackage();
  const snapshotBefore = JSON.stringify(base);
  const r = applyEdit(base, op);
  assert.equal(JSON.stringify(base), snapshotBefore, "input package is not mutated");
  assert.equal(r.pkg.version, base.version + 1);
  assert.equal(r.pkg.integrity.sha256, computeIntegrity(r.pkg));
  const v = validatePackage(r.pkg);
  assert.deepEqual(v.errors, [], `${op.op} leaves a valid package`);
  return r;
}

const rejects = (op, re) => assert.throws(() => applyEdit(fixturePackage(), op), (e) => e instanceof EditRejected && re.test(e.message), `${op.op} should be rejected with ${re}`);

test("edit: the hook and the package advertise the same op list", () => {
  assert.deepEqual(EDIT_OPS, [...PKG_EDIT_OPS]);
  assert.deepEqual(fixturePackage().hooks.edit.ops.length, 0, "fixture was hand-built");
});

test("edit: move_placement re-seats on the ground and re-bakes nav around a solid", () => {
  const { pkg } = edited({ op: "move_placement", id: "pl_hut", position: { x: 26, z: 12 } });
  const hut = pkg.world.placements.find((p) => p.id === "pl_hut");
  assert.deepEqual(hut.position, { x: 26, y: 2, z: 12 });
  assert.deepEqual(pkg.scene.nodes.find((n) => n.placement_ref === "pl_hut").transform.position, hut.position);
  if (HAS_BAKE) {
    const nav = pkg.world.navigation;
    const walk = (x, z) => nav.walkable[Math.floor(z / nav.cell) * nav.cols + Math.floor(x / nav.cell)] === "1";
    assert.equal(walk(30, 20), true, "old footprint is walkable again");
    assert.equal(walk(26, 12), false, "new footprint is blocked");
  }
});

test("edit: add_placement reuses a shipped asset, remove_placement drops an unreferenced one", () => {
  const { pkg, created } = edited({ op: "add_placement", asset_ref: "lib:gem", position: { x: 15, z: 15 } });
  assert.equal(created, "pl_edit_" + (fixturePackage().world.placements.length + 1));
  const pl = pkg.world.placements.find((p) => p.id === created);
  assert.equal(pl.region, "region_hub");
  assert.ok(pkg.scene.nodes.some((n) => n.placement_ref === created && n.asset_ref === "lib:gem"));
  const r2 = applyEdit(pkg, { op: "remove_placement", id: "pl_hut" });
  assert.ok(!r2.pkg.world.placements.some((p) => p.id === "pl_hut"));
  assert.ok(!r2.pkg.scene.nodes.some((n) => n.placement_ref === "pl_hut"));
  assert.equal(r2.pkg.version, 3);
});

test("edit: recolor_material bumps the record version and sha", () => {
  const before = fixturePackage().assets.records.find((r) => r.ref === "mat:stone");
  const { pkg } = edited({ op: "recolor_material", material: "mat:stone", color: "#AA3311" });
  const rec = pkg.assets.records.find((r) => r.ref === "mat:stone");
  assert.equal(rec.payload.color, "#aa3311");
  assert.equal(rec.version, before.version + 1);
  assert.notEqual(rec.sha256, before.sha256);
  assert.equal(rec.asset_id, before.asset_id, "asset_id stays stable so references hold");
});

test("edit: time of day and weather update the environment", () => {
  let { pkg } = edited({ op: "set_time_of_day", value: 0.9 });
  assert.equal(pkg.world.environment.time_of_day, 0.9);
  assert.equal(pkg.concept.time_of_day, 0.9);
  ({ pkg } = edited({ op: "set_weather", value: "fog" }));
  assert.equal(pkg.world.environment.weather, "fog");
  assert.equal(pkg.world.environment.water.enabled, true, "water survives the environment rebuild");
});

test("edit: character name and behavior", () => {
  let { pkg } = edited({ op: "rename_character", id: "maren", name: "Ada" });
  assert.equal(pkg.characters.characters.find((c) => c.id === "maren").name, "Ada");
  assert.equal(pkg.world.interactables.find((i) => i.id === "ix_talk_maren").prompt, "Talk to Ada");
  ({ pkg } = edited({ op: "set_character_behavior", id: "warden", behavior: { initial: "guard", speed: 3 } }));
  const b = pkg.characters.characters.find((c) => c.id === "warden").behavior;
  assert.equal(b.initial, "guard"); assert.equal(b.speed, 3); assert.equal(b.hostile, true, "other fields kept");
});

test("edit: objective text, optional objective, difficulty", () => {
  let { pkg } = edited({ op: "set_objective_text", id: "obj_key", title: "Find the rusty key", description: "Somewhere in the ruin." });
  assert.equal(pkg.gameplay.objectives.find((o) => o.id === "obj_key").title, "Find the rusty key");
  let created;
  ({ pkg, created } = edited({ op: "add_optional_objective", kind: "reach", target_ref: "region_field", title: "Walk the field" }));
  const o = pkg.gameplay.objectives.find((x) => x.id === created);
  assert.equal(o.optional, true); assert.equal(o.target_ref, "region_field");
  ({ pkg } = edited({ op: "set_difficulty", level: "hard" }));
  assert.equal(pkg.gameplay.difficulty.level, "hard");
  assert.ok(pkg.gameplay.difficulty.damage_mult > 1);
});

test("edit: rejections carry a reason", () => {
  rejects({ op: "remove_placement", id: "pl_ruin" }, /used by interactable 'ix_ruin', objective 'obj_open'/);
  rejects({ op: "remove_placement", id: "pl_pickup_1" }, /objective 'obj_key'/);
  rejects({ op: "move_placement", id: "pl_hut", position: { x: 500, z: 5 } }, /outside/);
  rejects({ op: "move_placement", id: "nope", position: { x: 5, z: 5 } }, /no placement 'nope'/);
  rejects({ op: "add_placement", asset_ref: "lib:dragon", position: { x: 5, z: 5 } }, /not in this package's asset records/);
  rejects({ op: "recolor_material", material: "mat:stone", color: "red" }, /#rrggbb/);
  rejects({ op: "set_time_of_day", value: 2 }, /\[0, 1\]/);
  rejects({ op: "set_weather", value: "meteor" }, /weather must be/);
  rejects({ op: "rename_character", id: "maren", name: "" }, /1–60/);
  rejects({ op: "set_character_behavior", id: "warden", behavior: { initial: "dance" } }, /not an NPC state/);
  rejects({ op: "add_optional_objective", kind: "talk", target_ref: "ghost", title: "x" }, /does not exist/);
  rejects({ op: "set_difficulty", level: "nightmare" }, /easy, normal or hard/);
  rejects({ op: "explode" }, /unknown edit op/);
});

test("edit: an op that would break validation is rejected even when its own checks pass", () => {
  // A pickup placed outside every region trips the world validator.
  const base = fixturePackage();
  base.world.regions[0].bounds = [0, 0, 20, 20];
  const pkg = seal(base);
  assert.throws(() => applyEdit(pkg, { op: "add_placement", asset_ref: "lib:gem", position: { x: 42, z: 20 } }), (e) => e instanceof EditRejected && /would break the package/.test(e.message));
});

test("edit: applyEdits chains ops and edited packages still play to a win", async () => {
  const { pkg, applied } = applyEdits(fixturePackage(), [
    { op: "set_weather", value: "rain" }, { op: "rename_character", id: "maren", name: "Ada" }, { op: "set_difficulty", level: "easy" },
  ]);
  assert.deepEqual(applied, ["set_weather", "rename_character", "set_difficulty"]);
  assert.equal(pkg.version, 4);
  const pt = await headlessPlaytest(pkg, { deps: mockDeps });
  assert.equal(pt.won, true, pt.reason);
});

test("expand: adds a region deterministically, preserves every id, validates and still wins", async () => {
  const base = fixturePackage();
  const r = await expandWorld(base, { prompt: "a moss-covered shrine", direction: "east", deps: mockDeps });
  const again = await expandWorld(base, { prompt: "a moss-covered shrine", direction: "east", deps: mockDeps });
  assert.equal(r.pkg.integrity.sha256 === again.pkg.integrity.sha256 || stripTimes(r.pkg) === stripTimes(again.pkg), true, "deterministic");
  const ids = (p) => ({
    regions: p.world.regions.map((x) => x.id), placements: p.world.placements.map((x) => x.id), interactables: p.world.interactables.map((x) => x.id),
    spawns: p.world.spawn_points.map((x) => x.id), objectives: p.gameplay.objectives.map((x) => x.id), items: p.gameplay.inventory.items.map((x) => x.id),
    characters: p.characters.characters.map((x) => x.id),
  });
  const before = ids(base), after = ids(r.pkg);
  for (const k of Object.keys(before)) for (const id of before[k]) assert.ok(after[k].includes(id), `${k}: '${id}' preserved`);
  assert.equal(r.added.region, "region_exp_1");
  assert.equal(r.direction, "east");
  const reg = r.pkg.world.regions.find((x) => x.id === "region_exp_1");
  assert.ok(reg.center.x > 40, "placed toward the east");
  assert.equal(r.pkg.version, 2);
  assert.equal(r.pkg.hooks.expand.history.length, 1);
  assert.ok(r.pkg.gameplay.objectives.filter((o) => r.added.objectives.includes(o.id)).every((o) => o.optional), "expansion objectives are optional");
  const v = validatePackage(r.pkg);
  assert.deepEqual(v.errors, []);
  const pt = await headlessPlaytest(r.pkg, { deps: mockDeps });
  assert.equal(pt.won, true, pt.reason);
  // The new content itself is reachable and completable: promote it to required and play again.
  const req = JSON.parse(JSON.stringify(r.pkg));
  for (const o of req.gameplay.objectives) if (r.added.objectives.includes(o.id)) o.optional = false;
  const pt2 = await headlessPlaytest(seal(req), { deps: mockDeps });
  assert.equal(pt2.won, true, `${pt2.reason} ${pt2.pending}`);
  for (const id of r.added.objectives) assert.ok(pt2.objectives_done.includes(id), id);
});

test("expand: a full world refuses a further expansion with a clear reason", async () => {
  // The 80 m fixture has room for exactly one 20 m region; the generated-world
  // integration test covers two successive expansions.
  const one = await expandWorld(fixturePackage(), { prompt: "watchtower", direction: "east", deps: mockDeps });
  await assert.rejects(expandWorld(one.pkg, { prompt: "camp", deps: mockDeps }), /no free, walkable, reachable ground left/);
});

function stripTimes(p) { return JSON.stringify({ ...p, created_at: null }); }

test("publish: writes a self-contained folder whose manifest hashes every file", async () => {
  const out = tmp("publish");
  const pkg = fixturePackage();
  const { manifest } = await publishPackage(pkg, { outDir: out, deps: mockDeps, now: "2026-09-28T00:00:00.000Z" });
  assert.equal(manifest.package_sha256, pkg.integrity.sha256);
  assert.equal(manifest.gates.validate.ok, true);
  assert.equal(manifest.gates.playtest.won, true);
  for (const f of manifest.files) {
    const buf = fs.readFileSync(path.join(out, f.path));
    assert.equal(buf.length, f.bytes, f.path);
    assert.equal(sha256(buf), f.sha256, f.path);
  }
  const paths = manifest.files.map((f) => f.path);
  for (const p of ["package.json", "src/gamesb/runtime/sim-core.mjs", "src/gamesb/runtime/deps.mjs", "src/gamesb/common/rng.mjs"]) assert.ok(paths.includes(p), p);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8")), pkg);
  // Every relative import inside the published folder resolves inside it.
  for (const p of paths.filter((x) => x.endsWith(".mjs"))) {
    const src = fs.readFileSync(path.join(out, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(path.join(out, p)), m[1])), `${p} → ${m[1]}`);
    }
  }
  if (fs.existsSync(new URL("../games-b-runtime/play.html", import.meta.url))) {
    assert.ok(paths.includes("games-b-runtime/play.html"));
    assert.match(manifest.entry, /^games-b-runtime\/play\.html\?pkg=/);
  }
});

test("publish: refuses a package that fails validation, and writes nothing", async () => {
  const out = path.join(tmp("refuse"), "site");
  const bad = JSON.parse(JSON.stringify(fixturePackage()));
  bad.assets.records = bad.assets.records.filter((r) => r.ref !== "lib:chest");
  await assert.rejects(publishPackage(seal(bad), { outDir: out, deps: mockDeps }), (e) => e instanceof PublishRefused && /validation failed/.test(e.message) && e.gates.validate.ok === false);
  assert.equal(fs.existsSync(out), false);
});

test("publish: refuses a valid package the headless agent cannot win", async () => {
  const out = path.join(tmp("unwinnable"), "site");
  const p = JSON.parse(JSON.stringify(fixturePackage()));
  // A solid wall block around the chest that the baked nav grid does not know
  // about: every static check passes, but nobody can physically reach the chest.
  p.world.placements.push({ id: "pl_wall", asset_ref: "lib:stone_hut", region: "region_ruin", position: { x: 66, y: 2, z: 66 }, rotation_y: 0, scale: 1,
    role: "structure", collider: { shape: "box", size: { x: 14, y: 4, z: 14 }, solid: true }, tags: [] });
  const pkg = seal(p);
  const pt = await headlessPlaytest(pkg, { deps: mockDeps, maxSimSeconds: 60 });
  await assert.rejects(publishPackage(pkg, { outDir: out, deps: mockDeps, playtest: pt }), (e) => e instanceof PublishRefused && /did not win/.test(e.message));
  assert.equal(fs.existsSync(out), false);
});
