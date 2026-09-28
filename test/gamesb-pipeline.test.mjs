// Games-B pipeline integration: real stage modules, offline providers.
//
// prompt → concept → world → characters → gameplay → assets → scene →
// assemble → validate → headless playtest, then every gate and hook on the
// result. Each test skips, naming the missing file, while a stage module has
// not landed yet; once they all exist the whole chain runs for real.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };
const CREATED = "2026-09-28T00:00:00.000Z";

const STAGES = [
  "src/gamesb/concept/concept.mjs", "src/gamesb/world/world-spec.mjs", "src/gamesb/characters/characters.mjs",
  "src/gamesb/gameplay/generate.mjs", "src/gamesb/assets/asset-pipeline.mjs", "src/gamesb/world/scene-graph.mjs",
];
const ISO = [
  "src/gamesb/world/terrain-sample.mjs", "src/gamesb/world/collision.mjs", "src/gamesb/world/nav-grid.mjs",
  "src/gamesb/gameplay/rules-engine.mjs", "src/gamesb/characters/npc-brain.mjs", "src/gamesb/characters/dialogue.mjs",
];
const missing = (files) => files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
const skipIso = missing(ISO).length ? `sim modules not landed yet: ${missing(ISO).join(", ")}` : false;
const skipAll = missing([...STAGES, ...ISO]).length ? `stage modules not landed yet: ${missing([...STAGES, ...ISO]).join(", ")}` : false;

const PROMPTS = [
  "a storm-lashed lighthouse island where the keeper vanished",
  "a sun-baked desert canyon with a buried temple and scorpions",
  "a frozen mountain pass where a hermit guards an ice shrine",
];

const lazy = (fn) => { let p; return () => (p ||= fn()); };
const mods = lazy(async () => ({
  pipeline: await import("../src/gamesb/pipeline.mjs"),
  validate: await import("../src/gamesb/runtime/validate-package.mjs"),
  playtest: await import("../src/gamesb/runtime/headless-playtest.mjs"),
  assemble: await import("../src/gamesb/runtime/assemble.mjs"),
  sim: await import("../src/gamesb/runtime/sim-core.mjs"),
  deps: await import("../src/gamesb/runtime/deps.mjs"),
  v3: await import("../src/gamesb/runtime/to-manifest-v3.mjs"),
  schema: await import("../src/v3/manifest/schema.mjs"),
  edit: await import("../src/gamesb/hooks/edit.mjs"),
  expand: await import("../src/gamesb/hooks/expand.mjs"),
  publish: await import("../src/gamesb/hooks/publish.mjs"),
}));
const builds = new Map();
async function build(prompt, opts = {}) {
  const key = prompt + JSON.stringify(opts);
  if (!builds.has(key)) builds.set(key, (await mods()).pipeline.buildGame(prompt, { env: OFFLINE, createdAt: CREATED, ...opts }));
  return builds.get(key);
}
const reseal = async (pkg) => (await mods()).assemble.seal(pkg);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------ real sim deps

test("real deps: the fixture package plays to a win on the real sim modules", { skip: skipIso }, async () => {
  const { playtest, deps } = await mods();
  const { fixturePackage } = await import("./fixtures/gamesb/runtime/fixture-package.mjs");
  const r = await playtest.headlessPlaytest(fixturePackage(), { deps: deps.realDeps });
  assert.equal(r.won, true, `${r.reason} ${r.pending}`);
  assert.equal(r.save_reload.ok, true);
});

// ----------------------------------------------------------------- pipeline

for (const prompt of PROMPTS) {
  test(`buildGame offline: "${prompt}" validates, is reachable, wins and survives save/reload`, { skip: skipAll }, async () => {
    const res = await build(prompt);
    assert.deepEqual(res.validation.errors, [], "validation errors");
    assert.equal(res.validation.ok, true);
    assert.deepEqual(res.validation.skipped, [], "every stage validator ran");
    assert.equal(res.reachability.ok, true, JSON.stringify(res.reachability.results.filter((r) => !r.reachable)));
    assert.equal(res.playtest.won, true, `${res.playtest.reason} pending=${res.playtest.pending}`);
    assert.equal(res.playtest.save_reload.ok, true, JSON.stringify(res.playtest.save_reload));
    assert.equal(res.ok, true);
    const b = res.validation.budgets;
    assert.ok(b.triangles > 0 && b.triangles <= 1_500_000, `triangles ${b.triangles}`);
    assert.ok(b.draw_calls > 0 && b.draw_calls <= 600, `draw calls ${b.draw_calls}`);
    assert.ok(b.texture_mb <= 96, `texture ${b.texture_mb} MB`);
    for (const s of ["concept", "world", "characters", "gameplay", "assets", "scene", "assemble", "validate", "playtest"]) assert.ok(res.timings[s] >= 0, `timing ${s}`);
    const stages = new Set(res.pkg.provenance.stages.map((s) => s.stage));
    for (const s of ["concept", "world", "characters", "gameplay", "scene", "assemble"]) assert.ok(stages.has(s), `provenance ${s}`);
    test.diagnostic?.(`${res.pkg.game_id}: tri=${b.triangles} draws=${b.draw_calls} tex=${b.texture_mb}MB won in ${res.playtest.sim_seconds}s sim; build ${res.timings.total}ms`);
  });
}

test("buildGame is deterministic for the same prompt, seed and createdAt", { skip: skipAll }, async () => {
  const { pipeline } = await mods();
  const a = await pipeline.buildGame(PROMPTS[0], { env: OFFLINE, seed: 7, createdAt: CREATED, playtest: false });
  const b = await pipeline.buildGame(PROMPTS[0], { env: OFFLINE, seed: 7, createdAt: CREATED, playtest: false });
  const strip = (p) => JSON.stringify({ ...p, provenance: { ...p.provenance, stages: p.provenance.stages.map(({ at, latency_ms, ...s }) => s) }, integrity: null });
  assert.equal(strip(a.pkg), strip(b.pkg));
});

test("gates: a removed asset record is caught as a missing asset ref", { skip: skipAll }, async () => {
  const { validate } = await mods();
  const pkg = clone((await build(PROMPTS[0])).pkg);
  const used = pkg.world.placements[0].asset_ref;
  pkg.assets.records = pkg.assets.records.filter((r) => r.ref !== used && r.asset_id !== used);
  const v = validate.validatePackage(await reseal(pkg));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes(`'${used}'`)), JSON.stringify(v.errors.slice(0, 5)));
});

test("gates: an unknown action kind and a dangling dialogue action are broken scripts", { skip: skipAll }, async () => {
  const { validate } = await mods();
  const pkg = clone((await build(PROMPTS[1])).pkg);
  pkg.gameplay.events.push({ id: "ev_bad", once: true, trigger: { kind: "game_start" }, actions: [{ kind: "open_portal_to_hell" }] });
  const d = pkg.characters.dialogues[0];
  d.nodes[0].choices[0].actions = [...(d.nodes[0].choices[0].actions || []), { kind: "give_item", ref: "item_does_not_exist" }];
  const v = validate.validatePackage(await reseal(pkg));
  assert.ok(v.errors.some((e) => /open_portal_to_hell/.test(e.message)));
  assert.ok(v.errors.some((e) => /item_does_not_exist/.test(e.message)));
});

test("V3 bridge: toManifestV3 of a built game passes validateManifest", { skip: skipAll }, async () => {
  const { v3, schema } = await mods();
  for (const prompt of PROMPTS) {
    const { pkg } = await build(prompt);
    const m = v3.toManifestV3(pkg);
    const v = schema.validateManifest(m);
    assert.deepEqual(v.errors, [], prompt);
    assert.equal(m.gamesb.package_sha256, pkg.integrity.sha256);
    assert.equal(m.zones.length, pkg.world.regions.length);
    assert.equal(m.npcs.length, pkg.characters.characters.length);
  }
});

test("perf: one sim step on a generated medium world is < 0.5 ms", { skip: skipAll }, async () => {
  const { sim, deps } = await mods();
  const { pkg } = await build(PROMPTS[0]);
  const s = sim.createSim(pkg, deps.realDeps);
  const input = (i) => ({ move: { x: Math.sin(i / 50), z: Math.cos(i / 70) }, run: i % 200 < 100, jump: i % 90 === 0 });
  for (let i = 0; i < 300; i++) sim.stepSim(s, input(i));
  const N = 3000, t0 = performance.now();
  for (let i = 0; i < N; i++) sim.stepSim(s, input(i + 300));
  const per = (performance.now() - t0) / N;
  assert.ok(per < 0.5, `${per.toFixed(4)} ms/step`);
  test.diagnostic?.(`sim step ${per.toFixed(4)} ms on ${pkg.world.size.w} m world with ${s.colliders.length} colliders and ${Object.keys(s.npcs).length} NPCs`);
});

test("hooks on a built game: edits apply, a harmful edit is refused, the result still wins", { skip: skipAll }, async () => {
  const { edit, playtest, validate } = await mods();
  const { pkg } = await build(PROMPTS[2]);
  const target = pkg.gameplay.objectives.find((o) => o.kind === "activate" || o.kind === "interact");
  const ix = pkg.world.interactables.find((i) => i.id === target.target_ref);
  assert.throws(() => edit.applyEdit(pkg, { op: "remove_placement", id: ix.placement_ref }), (e) => e instanceof edit.EditRejected && /objective/.test(e.message));
  const decor = pkg.world.placements.find((p) => (p.role === "decor" || p.role === "prop") && !pkg.world.interactables.some((i) => i.placement_ref === p.id));
  const ops = [{ op: "set_weather", value: "fog" }, { op: "set_time_of_day", value: 0.8 }, { op: "set_difficulty", level: "easy" },
    { op: "rename_character", id: pkg.characters.characters[0].id, name: "Ada Quill" }];
  if (decor) ops.push({ op: "remove_placement", id: decor.id });
  const { pkg: out } = edit.applyEdits(pkg, ops);
  assert.equal(out.version, pkg.version + ops.length);
  assert.deepEqual(validate.validatePackage(out).errors, []);
  const pt = await playtest.headlessPlaytest(out);
  assert.equal(pt.won, true, pt.reason);
});

test("hooks on a built game: two expansions preserve ids, validate and stay winnable", { skip: skipAll }, async () => {
  const { expand, playtest, validate } = await mods();
  const { pkg } = await build(PROMPTS[0]);
  const one = await expand.expandWorld(pkg, { prompt: "a sunken chapel", direction: "east" });
  const two = await expand.expandWorld(one.pkg, { prompt: "a smugglers' camp", direction: "west" });
  const allIds = (p) => [...p.world.regions, ...p.world.placements, ...p.world.interactables, ...p.world.spawn_points, ...p.gameplay.objectives, ...p.characters.characters].map((x) => x.id);
  const after = new Set(allIds(two.pkg));
  for (const id of allIds(pkg)) assert.ok(after.has(id), `id '${id}' preserved`);
  assert.deepEqual(validate.validatePackage(two.pkg).errors, []);
  const pt = await playtest.headlessPlaytest(two.pkg);
  assert.equal(pt.won, true, pt.reason);
  const req = clone(two.pkg);
  const added = [...one.added.objectives, ...two.added.objectives];
  for (const o of req.gameplay.objectives) if (added.includes(o.id)) o.optional = false;
  const pt2 = await playtest.headlessPlaytest(await reseal(req));
  assert.equal(pt2.won, true, `${pt2.reason} ${pt2.pending}`);
});

test("publish a built game: manifest hashes match the files; package round-trips", { skip: skipAll }, async () => {
  const { publish, pipeline } = await mods();
  const res = await build(PROMPTS[1]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gamesb-pub-"));
  const { manifest } = await publish.publishPackage(res.pkg, { outDir: out, validation: res.validation, playtest: res.playtest });
  const { sha256 } = await import("../src/gamesb/common/hash.mjs");
  for (const f of manifest.files) assert.equal(sha256(fs.readFileSync(path.join(out, f.path))), f.sha256, f.path);
  assert.equal(pipeline.readPackage(path.join(out, "package.json")).integrity.sha256, res.pkg.integrity.sha256);
  assert.ok(manifest.baked.count > 0 || manifest.baked.status === "unavailable");
});

test("CLI: scripts/gamesb-build.mjs builds, reports and publishes offline", { skip: skipAll }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "gamesb-cli-"));
  const r = spawnSync(process.execPath, ["scripts/gamesb-build.mjs", "--prompt", PROMPTS[0], "--out", out, "--seed", "3", "--offline", "--publish"],
    { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, DCS_PROVIDERS_OFFLINE: "1" }, timeout: 120000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, "BUILD_REPORT.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.publish.ok, true);
  assert.ok(fs.existsSync(path.join(out, "site", "PUBLISH_MANIFEST.json")));
});
