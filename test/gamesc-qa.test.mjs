// GAMES-C QA gate runner. A fixture world passes the headless gates; worlds
// broken in one specific way fail exactly the gate that owns that defect; a
// missing module is SKIPPED (never PASS) and makes the run INCOMPLETE.
// Offline; the browser gates are exercised through an injected probe.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { runGates, loadGamescModules, GATES, STATUS } from "../src/v3/gamesc/qa/gates.mjs";

process.env.DCS_PROVIDERS_OFFLINE = "1";
const ENV = { DCS_PROVIDERS_OFFLINE: "1" };      // browser gates NOT enabled
let BASE;
async function world() {
  if (!BASE) BASE = (await createAssemblyRouter(ENV).assemble({ prompt: "Ashfall Harbour, a rainy nordic port town", worldId: "w_qa_fixture", creatorId: "u1" })).manifest;
  return structuredClone(BASE);
}
const byGate = (r) => Object.fromEntries(r.gates.map((g) => [g.gate, g]));
const HEADLESS = ["launch", "navigation", "movement", "collision", "objective_reachability", "asset_load"];
const NO_MODULES = { patch: null, memory: null, publish: null, companion: null, multiplayer: null, reasons: { patch: "absent (test)", memory: "absent (test)", publish: "absent (test)" } };

test("QA: fixture world passes every headless gate; report shape is complete", async () => {
  const r = await runGates(await world(), { env: ENV });
  assert.deepEqual(r.gates.map((g) => g.gate), [...GATES]);
  const g = byGate(r);
  for (const name of HEADLESS) assert.equal(g[name].status, STATUS.PASS, `${name}: ${g[name].reason} ${JSON.stringify(g[name].evidence).slice(0, 300)}`);
  for (const name of ["fps", "memory", "console_errors"]) {
    assert.equal(g[name].status, STATUS.SKIPPED);
    assert.match(g[name].reason, /DCS_GAMESC_BROWSER_GATES/);
  }
  assert.equal(r.overall, "INCOMPLETE", "skipped gates must keep overall from PASS");
  assert.equal(r.summary.total, GATES.length);
  assert.ok(r.manifest_hash.startsWith("sha256:"));
  JSON.parse(JSON.stringify(r));    // serialisable
});

test("QA: module-backed gates PASS when the sibling module is present, SKIPPED otherwise — never PASS without it", async () => {
  const mods = await loadGamescModules();
  const r = await runGates(await world(), { env: ENV, modules: mods });
  const g = byGate(r);
  const needs = { save_reload: "memory", edit_retest: "patch", publish_package: "publish", reopen_published_preview: "publish" };
  for (const [gate, mod] of Object.entries(needs)) {
    if (mods[mod]) assert.equal(g[gate].status, STATUS.PASS, `${gate}: ${g[gate].reason} ${JSON.stringify(g[gate].evidence).slice(0, 400)}`);
    else assert.equal(g[gate].status, STATUS.SKIPPED, gate);
  }
});

test("QA: missing modules → SKIPPED with reason, overall INCOMPLETE (not PASS)", async () => {
  const r = await runGates(await world(), { env: ENV, modules: structuredClone(NO_MODULES) });
  const g = byGate(r);
  for (const gate of ["save_reload", "edit_retest", "publish_package", "reopen_published_preview"]) {
    assert.equal(g[gate].status, STATUS.SKIPPED, gate);
    assert.ok(g[gate].reason && g[gate].reason.length > 0);
  }
  assert.equal(r.overall, "INCOMPLETE");
  assert.equal(r.summary.pass, HEADLESS.length);
});

test("QA: a module with the wrong API is SKIPPED, not PASS", async () => {
  const r = await runGates(await world(), { env: ENV, modules: { ...structuredClone(NO_MODULES), memory: { nothing: true }, patch: { hashManifest: () => "x" }, publish: {} } });
  const g = byGate(r);
  assert.match(g.save_reload.reason, /createWorldMemoryV2/);
  assert.match(g.edit_retest.reason, /createPatch/);
  assert.match(g.publish_package.reason, /buildStagingPackage/);
  for (const gate of ["save_reload", "edit_retest", "publish_package"]) assert.equal(g[gate].status, STATUS.SKIPPED);
});

test("QA: loadGamescModules on an empty tree reports every module absent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gamesc-empty-"));
  try {
    const m = await loadGamescModules({ root: dir });
    for (const k of ["patch", "memory", "publish", "companion", "multiplayer"]) { assert.equal(m[k], null); assert.match(m.reasons[k], /absent/); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------ failing worlds fail the right gate
const only = HEADLESS;
async function headless(mutate) {
  const m = await world();
  mutate(m);
  return byGate(await runGates(m, { env: ENV, modules: structuredClone(NO_MODULES), only }));
}

test("QA FAIL: spawn walled in → movement + navigation FAIL", async () => {
  const g = await headless((m) => {
    const p = m.spawn.player_spawns[0].position;
    const asset = m.assets.find((a) => a.kind === "building")?.id || m.assets[0].id;
    for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6], [5, 5], [-5, -5], [5, -5], [-5, 5]]) {
      m.structures.push({ id: `wall_${dx}_${dz}`, zone: m.zones[0].id, asset_ref: asset, transform: { position: { x: p.x + dx, y: 0, z: p.z + dz }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, footprint: { w: 14, d: 14, h: 6 }, enterable: false, interactable: false, portals: [] });
    }
  });
  assert.equal(g.movement.status, STATUS.FAIL, JSON.stringify(g.movement.evidence));
  assert.equal(g.navigation.status, STATUS.FAIL);
  assert.equal(g.asset_load.status, STATUS.PASS, "an unrelated gate is not dragged down");
});

test("QA FAIL: quest targeting a deleted NPC → objective_reachability FAIL", async () => {
  const g = await headless((m) => { m.quests[0].steps[0].target = "npc_that_does_not_exist"; });
  assert.equal(g.objective_reachability.status, STATUS.FAIL);
  assert.equal(g.movement.status, STATUS.PASS);
});

test("QA FAIL: no quests at all → objective_reachability FAIL", async () => {
  const g = await headless((m) => { m.quests = []; });
  assert.equal(g.objective_reachability.status, STATUS.FAIL);
  assert.match(g.objective_reachability.reason, /no quests/);
});

test("QA FAIL: solid asset without collision → collision FAIL", async () => {
  const g = await headless((m) => { const a = m.assets.find((x) => ["building", "vehicle", "terrain_feature"].includes(x.kind)) || m.assets[0]; a.kind = "building"; delete a.collision; });
  assert.equal(g.collision.status, STATUS.FAIL);
  assert.match(g.collision.reason, /asset_no_collision/);
});

test("QA FAIL: structure referencing a missing asset → asset_load FAIL", async () => {
  const g = await headless((m) => { m.structures[0].asset_ref = "asset_gone"; });
  assert.equal(g.asset_load.status, STATUS.FAIL);
  assert.match(g.asset_load.reason, /missing_asset/);
});

test("QA FAIL: hostile asset uri → launch (guard) + asset_load FAIL", async () => {
  const g = await headless((m) => { m.assets.push({ id: "evil", kind: "prop", format: "glb", uri: "javascript:alert(1)" }); });
  assert.equal(g.launch.status, STATUS.FAIL);
  assert.equal(g.asset_load.status, STATUS.FAIL);
  assert.match(g.asset_load.reason, /asset_url_scheme_blocked/);
});

test("QA FAIL: world without spawn → launch FAIL", async () => {
  const g = await headless((m) => { m.spawn.player_spawns = []; });
  assert.equal(g.launch.status, STATUS.FAIL);
  assert.equal(g.movement.status, STATUS.FAIL);
});

test("QA FAIL: a world that fails playtest cannot be packaged (publish gate uses the real module)", async (t) => {
  const mods = await loadGamescModules({ only: ["publish"] });
  if (!mods.publish) return t.skip("publish module absent");
  const m = await world();
  m.quests[0].steps[0].target = "npc_that_does_not_exist";
  const r = await runGates(m, { env: ENV, modules: mods, only: ["publish_package", "reopen_published_preview"] });
  const g = byGate(r);
  assert.equal(g.publish_package.status, STATUS.FAIL);
  assert.equal(g.reopen_published_preview.status, STATUS.SKIPPED, "nothing to reopen");
});

// ----------------------------------------------------------- browser gates (injected probe)
test("QA browser: enabled + probe evidence → fps/memory/console judged against thresholds", async () => {
  const probe = async () => ({ ok: true, evidence: { booted: true, boot_ms: 900, fps: 12, heap_mb: 900, page_errors: ["TypeError: x"], console_errors: [], request_failures: [], bad_responses: [] } });
  const r = await runGates(await world(), { env: { ...ENV, DCS_GAMESC_BROWSER_GATES: "1" }, modules: structuredClone(NO_MODULES), browserProbe: probe, only: ["launch", "fps", "memory", "console_errors"] });
  const g = byGate(r);
  assert.equal(g.fps.status, STATUS.FAIL);
  assert.equal(g.memory.status, STATUS.FAIL);
  assert.equal(g.console_errors.status, STATUS.FAIL);
  assert.equal(g.launch.status, STATUS.PASS);
  const good = async () => ({ ok: true, evidence: { booted: true, boot_ms: 900, fps: 60, heap_mb: 40, page_errors: [], console_errors: [], request_failures: [], bad_responses: [] } });
  const g2 = byGate(await runGates(await world(), { env: { ...ENV, DCS_GAMESC_BROWSER_GATES: "1" }, modules: structuredClone(NO_MODULES), browserProbe: good, only: ["fps", "memory", "console_errors"] }));
  for (const n of ["fps", "memory", "console_errors"]) assert.equal(g2[n].status, STATUS.PASS, n);
});

test("QA browser: runtime that does not boot fails launch; unavailable browser is SKIPPED", async () => {
  const dead = async () => ({ ok: true, evidence: { booted: false, boot_ms: 25000, fps: null, heap_mb: null, page_errors: [], console_errors: [], request_failures: [], bad_responses: [] } });
  const g = byGate(await runGates(await world(), { env: { ...ENV, DCS_GAMESC_BROWSER_GATES: "1" }, modules: structuredClone(NO_MODULES), browserProbe: dead, only: ["launch", "fps"] }));
  assert.equal(g.launch.status, STATUS.FAIL);
  assert.equal(g.fps.status, STATUS.FAIL);
  const none = async () => ({ ok: false, reason: "no Chrome binary" });
  const g2 = byGate(await runGates(await world(), { env: { ...ENV, DCS_GAMESC_BROWSER_GATES: "1" }, modules: structuredClone(NO_MODULES), browserProbe: none, only: ["fps", "memory", "console_errors"] }));
  for (const n of ["fps", "memory", "console_errors"]) { assert.equal(g2[n].status, STATUS.SKIPPED); assert.equal(g2[n].reason, "no Chrome binary"); }
});

test("QA: edit_retest drives the companion (text → patch) when that module is present", async (t) => {
  const mods = await loadGamescModules({ only: ["patch", "companion"] });
  if (!mods.patch || !mods.companion) return t.skip("patch or companion module absent");
  const g = byGate(await runGates(await world(), { env: ENV, modules: mods, only: ["edit_retest"] }));
  assert.equal(g.edit_retest.status, STATUS.PASS, g.edit_retest.reason);
  assert.equal(g.edit_retest.evidence.probe_source, "companion");
  assert.equal(g.edit_retest.evidence.ops[0].path, "environment.weather");
});
