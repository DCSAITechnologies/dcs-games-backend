// Games-B runtime: sim-core against hand-written mock deps, so these pass
// whatever state the other stage modules are in. The same scenarios run
// against the real modules in gamesb-runtime-integration.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createSim, stepSim, snapshot, restoreSim, nearestInteractable, currentDialogue, teleport, SIM_DT } from "../src/gamesb/runtime/sim-core.mjs";
import { mockDeps } from "./fixtures/gamesb/runtime/mock-deps.mjs";
import { fixturePackage } from "./fixtures/gamesb/runtime/fixture-package.mjs";
import { sha256Json } from "../src/gamesb/common/hash.mjs";

const NOW = "2026-09-28T00:00:00.000Z";
const run = (sim, input, n) => { const ev = []; for (let i = 0; i < n; i++) ev.push(...stepSim(sim, input).events); return ev; };
const press = (sim, extra = {}) => { const a = stepSim(sim, { interact: true, ...extra }).events; const b = stepSim(sim, {}).events; return [...a, ...b]; };
const reseal = (pkg) => { delete pkg.integrity; pkg.integrity = { sha256: sha256Json(pkg) }; return pkg; };

test("createSim refuses to start without deps and names what is missing", () => {
  assert.throws(() => createSim(fixturePackage(), { terrain: {} }), /missing deps .*terrain\.sampleHeight/);
});

test("spawn: player starts grounded on the terrain at spawn_player", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  assert.deepEqual(sim.player.position, { x: 10, y: 2, z: 10 });
  assert.equal(sim.player.grounded, true);
  assert.equal(sim.status, "playing");
  assert.equal(sim.colliders.length, 2);
});

test("movement: accelerates to walk speed, run is faster, decelerates to rest", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  stepSim(sim, { move: { x: 1, z: 0 } });
  assert.ok(sim.player.velocity.x > 0 && sim.player.velocity.x < 4.5, "one step is not full speed");
  run(sim, { move: { x: 1, z: 0 } }, 30);
  assert.equal(sim.player.velocity.x, 4.5);
  run(sim, { move: { x: 1, z: 0 }, run: true }, 30);
  assert.equal(sim.player.velocity.x, 8);
  assert.ok(Math.abs(sim.player.rotation_y - Math.PI / 2) < 1e-9, "faces the move direction");
  run(sim, {}, 20);
  assert.equal(sim.player.velocity.x, 0);
  // Wish vectors longer than 1 are clamped.
  const s2 = createSim(fixturePackage(), mockDeps);
  run(s2, { move: { x: 5, z: 0 } }, 40);
  assert.equal(s2.player.velocity.x, 4.5);
});

test("jump: rises under gravity, lands back on the ground, one jump per press", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  const ev = stepSim(sim, { jump: true }).events;
  assert.ok(ev.some((e) => e.kind === "jump"));
  assert.equal(sim.player.grounded, false);
  let peak = 0, landed = null;
  for (let i = 0; i < 120 && landed === null; i++) {
    const r = stepSim(sim, { jump: true }); // held: must not re-jump
    peak = Math.max(peak, sim.player.position.y);
    if (r.events.some((e) => e.kind === "land")) landed = i;
  }
  assert.ok(landed !== null, "lands");
  const expected = 6.5 ** 2 / (2 * 20);
  assert.ok(Math.abs(peak - 2 - expected) < 0.12, `peak ${peak - 2} ≈ ${expected}`);
  assert.equal(sim.player.position.y, 2);
  assert.equal(sim.player.grounded, true);
  assert.ok(!run(sim, { jump: true }, 10).some((e) => e.kind === "jump"), "holding jump does not bunny-hop");
});

test("slope limit: cannot walk up a face steeper than max_slope_deg", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 64, 5);
  const ev = run(sim, { move: { x: 0, z: 1 } }, 180);
  assert.ok(ev.some((e) => e.kind === "slope_blocked"));
  assert.ok(sim.player.position.z < 10, `stopped at the foot of the plateau (z=${sim.player.position.z})`);
  assert.ok(sim.player.position.y < 3, "did not climb");
  // Sliding along the face still works.
  const x0 = sim.player.position.x;
  run(sim, { move: { x: 0.7, z: 0.7 } }, 60);
  assert.ok(sim.player.position.x > x0 + 1, "slides sideways along the face");
});

test("collision: the solid hut pushes the player out on the XZ plane", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 22, 20);
  run(sim, { move: { x: 1, z: 0 } }, 180);
  assert.ok(sim.player.position.x <= 30 - 3 - 0.4 + 1e-6, `stopped outside the hut (x=${sim.player.position.x})`);
  assert.ok(sim.stats.collisions > 0);
});

test("interact: pickup grants the item once and disappears", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 51, 50);
  assert.equal(nearestInteractable(sim)?.id, "pickup_1");
  const ev = press(sim);
  assert.ok(ev.some((e) => e.kind === "pickup" && e.ref === "item_1"));
  assert.equal(sim.game.inventory.item_1, 1);
  assert.deepEqual(sim.collected, ["pickup_1"]);
  assert.equal(nearestInteractable(sim), null, "collected pickup is hidden");
  press(sim);
  assert.equal(sim.game.inventory.item_1, 1, "no second grant");
});

test("interact: interact is edge-triggered (holding E acts once)", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 21, 35);
  const ev = run(sim, { interact: true }, 10);
  assert.equal(ev.filter((e) => e.kind === "interact").length, 1);
});

test("interact: a locked container needs its key, then opens", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 66, 63.5);
  assert.equal(nearestInteractable(sim)?.id, "ix_ruin");
  let ev = press(sim);
  assert.ok(ev.some((e) => e.kind === "locked" && e.needs === "item_1"));
  assert.ok(sim.game.messages.at(-1).text.includes("Rusty Key"));
  assert.ok(!sim.collected.includes("ix_ruin"));
  sim.game = { ...sim.game, inventory: { item_1: 1 } };
  ev = press(sim);
  assert.ok(ev.some((e) => e.kind === "interact" && e.ref === "ix_ruin"));
  assert.ok(ev.some((e) => e.kind === "pickup" && e.ref === "item_core"));
  assert.ok(sim.unlocked.includes("ix_ruin"));
});

test("talk: opens dialogue on the NPC, roots the player, choices apply actions", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 18, 22.5);
  assert.equal(nearestInteractable(sim)?.id, "ix_talk_maren");
  const ev = press(sim);
  assert.ok(ev.some((e) => e.kind === "talk" && e.ref === "maren"));
  assert.ok(ev.some((e) => e.kind === "objective_done" && e.ref === "obj_talk"));
  const d = currentDialogue(sim);
  assert.equal(d.node.id, "n0");
  assert.equal(d.choices.length, 2);
  const p0 = { ...sim.player.position };
  stepSim(sim, { move: { x: 1, z: 0 }, choice: 0 });
  assert.deepEqual(sim.player.position, p0, "no walking while the dialogue was open");
  assert.equal(sim.game.flags.quest_taken, true, "set_flag action applied");
  assert.equal(currentDialogue(sim).node.id, "n1");
  const ev2 = stepSim(sim, { choice: 0 }).events;
  assert.equal(currentDialogue(sim), null, "closed");
  assert.ok(ev2.some((e) => e.kind === "message" && /waves/.test(e.text)));
  // The objective_complete event fired set_npc_state on the warden.
  assert.equal(sim.npcs.warden.state, "patrol");
});

test("dialogue give_item action goes through the rules engine as a pickup", () => {
  const pkg = fixturePackage();
  pkg.characters.dialogues[0].nodes[1].choices[0].actions.push({ kind: "give_item", ref: "item_1", value: 1 });
  const sim = createSim(reseal(pkg), mockDeps);
  teleport(sim, 18, 22.5);
  press(sim);
  stepSim(sim, { choice: 0 });
  const ev = stepSim(sim, { choice: 0 }).events;
  assert.ok(ev.some((e) => e.kind === "pickup" && e.ref === "item_1"));
  assert.equal(sim.game.objectives.obj_key, "done", "collect objective completed by a dialogue gift");
});

test("regions: enter_region fires on each transition, not every step", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 20, 38);
  const ev = run(sim, { move: { x: 0, z: 1 } }, 150);
  const enters = ev.filter((e) => e.kind === "enter_region").map((e) => e.ref);
  assert.deepEqual(enters, ["region_hub", "region_field"]);
  assert.equal(sim.region, "region_field");
});

test("hazards: storm zone damages over time; death costs a life and respawns", () => {
  const pkg = fixturePackage();
  pkg.gameplay.hazards[1].damage_per_s = 120;
  const sim = createSim(reseal(pkg), mockDeps);
  teleport(sim, 30, 60);
  const ev = run(sim, {}, 20);
  assert.ok(ev.some((e) => e.kind === "damage" && e.source === "hazard"));
  assert.ok(sim.game.health < 100);
  run(sim, {}, 60);
  assert.equal(sim.game.lives, 2);
  assert.equal(sim.game.health, 100);
  assert.deepEqual([sim.player.position.x, sim.player.position.z], [10, 10], "respawned at spawn_player");
});

test("hazards: sentinel only hurts after its active_after objective, within its radius", () => {
  const pkg = fixturePackage();
  pkg.characters.characters[1].behavior.initial = "idle";
  const sim = createSim(reseal(pkg), mockDeps);
  teleport(sim, 57, 30);
  run(sim, {}, 60);
  assert.equal(sim.game.health, 100, "inactive before obj_talk");
  sim.game = { ...sim.game, objectives: { ...sim.game.objectives, obj_talk: "done" } };
  run(sim, {}, 60);
  assert.ok(sim.game.health <= 100 - 30, `~40 dps for 1 s (health ${sim.game.health})`);
});

test("water: standing in deep water is fell_out and respawns", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 10, 64);
  const ev = stepSim(sim, {}).events;
  assert.ok(ev.some((e) => e.kind === "fell_out" && e.reason === "deep_water"));
  assert.equal(sim.stats.falls, 1);
  assert.deepEqual([sim.player.position.x, sim.player.position.z], [10, 10]);
});

test("fall_y: dropping below the kill plane is fell_out", () => {
  const pkg = fixturePackage();
  // A kill plane above the ground: the only way to test "below fall_y" on a
  // heightfield, since a body under the terrain is snapped back onto it.
  pkg.world.environment.water.enabled = false;
  pkg.gameplay.rules.fall_y = 5;
  const sim = createSim(reseal(pkg), mockDeps);
  const ev = stepSim(sim, {}).events;
  assert.ok(ev.some((e) => e.kind === "fell_out" && e.reason === "fall"));
});

test("win is terminal: stepping a won sim does nothing", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  teleport(sim, 18, 22.5); press(sim); stepSim(sim, { choice: 1 });
  teleport(sim, 51, 50); press(sim);
  teleport(sim, 66, 63.5);
  const ev = press(sim);
  assert.ok(ev.some((e) => e.kind === "status" && e.value === "won"));
  assert.equal(sim.status, "won");
  const t = sim.t;
  assert.deepEqual(stepSim(sim, { move: { x: 1, z: 0 } }).events, []);
  assert.equal(sim.t, t);
});

test("lose is terminal: running out of lives ends the game", () => {
  const pkg = fixturePackage();
  pkg.gameplay.rules.lives = 1;
  pkg.gameplay.hazards[1].damage_per_s = 500;
  const sim = createSim(reseal(pkg), mockDeps);
  teleport(sim, 30, 60);
  const ev = run(sim, {}, 60);
  assert.equal(sim.status, "lost");
  assert.ok(ev.some((e) => e.kind === "status" && e.value === "lost"));
  assert.deepEqual(stepSim(sim, {}).events, []);
});

// Scripted input tape covering walking, running, jumping, talking and a choice.
function tape(i) {
  if (i === 5) return { interact: true };
  if (i === 7) return { choice: 0 };
  if (i === 9) return { choice: 0 };
  return { move: { x: Math.sin(i / 40), z: Math.cos(i / 55) }, run: i % 120 < 60, jump: i % 97 === 0 };
}

test("snapshot → restoreSim → snapshot is identical", () => {
  const pkg = fixturePackage();
  const sim = createSim(pkg, mockDeps);
  teleport(sim, 18, 22.5);
  for (let i = 0; i < 6; i++) stepSim(sim, tape(i)); // leaves the dialogue OPEN
  assert.ok(sim.activeDialogue, "saving mid-dialogue");
  for (let i = 0; i < 300; i++) stepSim(sim, { move: { x: 0.3, z: 0.1 } });
  const save = snapshot(sim, { now: NOW });
  assert.equal(save.save_version, "1.0.0");
  assert.equal(save.package_sha256, pkg.integrity.sha256);
  const again = snapshot(restoreSim(pkg, JSON.parse(JSON.stringify(save)), mockDeps), { now: NOW });
  assert.deepEqual(again, save);
});

test("save/reload: restore + continue equals the uninterrupted run", () => {
  const pkg = fixturePackage();
  const a = createSim(pkg, mockDeps);
  teleport(a, 18, 22.5);
  const b = createSim(pkg, mockDeps);
  teleport(b, 18, 22.5);
  for (let i = 0; i < 1200; i++) stepSim(a, tape(i));
  for (let i = 0; i < 600; i++) stepSim(b, tape(i));
  const save = JSON.parse(JSON.stringify(snapshot(b, { now: NOW })));
  const c = restoreSim(pkg, save, mockDeps);
  for (let i = 600; i < 1200; i++) stepSim(c, tape(i));
  assert.deepEqual(snapshot(c, { now: NOW }), snapshot(a, { now: NOW }));
  assert.ok(a.npcs.warden.position.x !== 56 || a.npcs.warden.position.z !== 30, "the warden actually moved (NPC state is covered)");
});

test("restoreSim refuses a save from a different package build", () => {
  const pkg = fixturePackage();
  const save = snapshot(createSim(pkg, mockDeps), { now: NOW });
  const other = fixturePackage();
  other.gameplay.rules.lives = 9;
  assert.throws(() => restoreSim(reseal(other), save, mockDeps), /different package build/);
  assert.throws(() => restoreSim({ ...pkg, game_id: "x" }, save, mockDeps), /is for 'fixture_isle'/);
});

test("perf: one sim step stays under 0.5 ms with ~400 colliders and NPCs", () => {
  const pkg = fixturePackage();
  for (let k = 0; k < 400; k++) {
    const x = 2 + ((k * 37) % 76), z = 2 + ((k * 53) % 76);
    if (Math.hypot(x - 10, z - 10) < 6) continue;
    pkg.world.placements.push({ id: `tree_${k}`, asset_ref: "lib:lantern_post", region: null, position: { x, y: 2, z }, rotation_y: 0, scale: 1, role: "foliage", collider: { shape: "cylinder", radius: 0.4, height: 4, solid: true }, tags: [] });
  }
  const sim = createSim(reseal(pkg), mockDeps);
  assert.ok(sim.colliders.length > 380);
  for (let i = 0; i < 300; i++) stepSim(sim, tape(i + 20)); // warm-up
  const N = 3000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) stepSim(sim, tape(i + 320));
  const per = (performance.now() - t0) / N;
  assert.ok(per < 0.5, `step took ${per.toFixed(4)} ms`);
  test.diagnostic?.(`sim step ${per.toFixed(4)} ms (fixture + 400 colliders, mock deps)`);
});

test("fixed step: SIM_DT is 1/60 and t accumulates exactly per step", () => {
  const sim = createSim(fixturePackage(), mockDeps);
  run(sim, {}, 60);
  assert.equal(SIM_DT, 1 / 60);
  assert.ok(Math.abs(sim.t - 1) < 1e-9);
  assert.equal(sim.stats.steps, 60);
});
