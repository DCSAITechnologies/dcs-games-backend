// Regression tests for the Games-B bugs found and fixed while building the
// Games-D fallback engine (29 Sep 2026). Each drives the real sim/playtest code
// on the hand-authored mini fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSim, stepSim, nearestInteractable } from "../src/gamesb/runtime/sim-core.mjs";
import { checkObjectiveReachability } from "../src/gamesb/runtime/headless-playtest.mjs";
import { realDeps } from "../src/gamesb/runtime/deps.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mini = () => JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/gamesb/browser/mini.package.json"), "utf8"));
const IDLE = { move: { x: 0, z: 0 }, run: false, jump: false, interact: false };

test("hazard damage applies difficulty.damage_mult once, not squared", () => {
  const pkg = mini();
  pkg.gameplay.hazards = [{ id: "hz_test", kind: "storm_zone", region: "region_harbour", damage_per_s: 10 }];
  pkg.gameplay.difficulty = { level: "hard", damage_mult: 2, speed_mult: 1, time_mult: 1 };
  const sim = createSim(pkg, realDeps);
  const h0 = sim.game.health;
  for (let i = 0; i < 60; i++) stepSim(sim, IDLE);
  const lost = h0 - sim.game.health;
  // 10 dps × 2 for one second ≈ 20 (a few frames pass before the region
  // registers); squared it was ≈ 36–40.
  assert.ok(lost >= 15 && lost <= 22, `lost ${lost} health in 1 s, expected ~20`);
});

test("an opened container stays usable but grants its item only once", () => {
  const pkg = mini();
  const ix = pkg.world.interactables.find((i) => i.id === "pickup_1");
  ix.kind = "container";
  const sim = createSim(pkg, realDeps);
  const pl = pkg.world.placements.find((p) => p.id === ix.placement_ref);
  const press = () => { stepSim(sim, { ...IDLE, interact: true }); stepSim(sim, IDLE); };
  sim.player.position = { x: pl.position.x + 0.8, y: pl.position.y, z: pl.position.z };
  stepSim(sim, IDLE);
  assert.equal(nearestInteractable(sim)?.id, "pickup_1");
  press();
  assert.equal(sim.game.inventory.item_1, 1);
  assert.equal(nearestInteractable(sim)?.id, "pickup_1", "opened container must stay interactable");
  press();
  assert.equal(sim.game.inventory.item_1, 1, "a container must not grant its item twice");
});

test("reachability: a sealed nearest cell does not hide a connected approach within reach", async () => {
  const pkg = mini();
  const nav = pkg.world.navigation;
  const ix = pkg.world.interactables.find((i) => i.id === "ix_harbour");
  const pos = pkg.world.placements.find((p) => p.id === ix.placement_ref).position;
  const w = nav.walkable.split("");
  const at = (i, j) => j * nav.cols + i;
  const ci = Math.floor(pos.x / nav.cell), cj = Math.floor(pos.z / nav.cell);
  const centre = (i, j) => ({ x: (i + 0.5) * nav.cell, z: (j + 0.5) * nav.cell });
  const d = (i, j) => Math.hypot(centre(i, j).x - pos.x, centre(i, j).z - pos.z);
  // Block the target's own cell; make the nearest ring-1 cell an isolated pocket.
  w[at(ci, cj)] = "0";
  const ring = [];
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (di || dj) ring.push([ci + di, cj + dj]);
  ring.sort((a, b) => d(...a) - d(...b));
  const [ai, aj] = ring[0];
  w[at(ai, aj)] = "1";
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && !(ai + di === ci && aj + dj === cj)) w[at(ai + di, aj + dj)] = "0";
  // Keep one connected ring-1 cell (not adjacent to the pocket) open, with its outward neighbour.
  const far = ring.filter(([i, j]) => Math.max(Math.abs(i - ai), Math.abs(j - aj)) >= 2).sort((a, b) => d(...a) - d(...b))[0];
  assert.ok(far, "fixture has a ring-1 cell away from the pocket");
  w[at(far[0], far[1])] = "1";
  w[at(far[0] + (far[0] - ci), far[1] + (far[1] - cj))] = "1";
  nav.walkable = w.join("");
  pkg.gameplay.objectives = [{ id: "obj_sign", title: "Sign", description: "", kind: "interact", target_ref: "ix_harbour", count: 1, requires: [], optional: false, reward: { xp: 1 } }];

  const fixed = await checkObjectiveReachability(pkg, { deps: realDeps });
  const r = fixed.results.find((x) => x.objective_id === "obj_sign");
  assert.ok(d(...far) <= ix.radius + nav.cell * 0.75 + 0.5, "fixture geometry must exercise the fix");
  {
    assert.equal(r.reachable, true, JSON.stringify(r));
    // The pre-fix nearest-cell path (deps without reachableSet) reports it unreachable.
    const legacy = await checkObjectiveReachability(pkg, { deps: { ...realDeps, nav: { isWalkable: realDeps.nav.isWalkable, findPath: realDeps.nav.findPath } } });
    assert.equal(legacy.results.find((x) => x.objective_id === "obj_sign").reachable, false);
  }
});

test("input.unstuck returns the player to the checkpoint (or spawn) and leaves game state alone", () => {
  const pkg = mini();
  const sim = createSim(pkg, realDeps);
  const sp = pkg.world.spawn_points.find((s) => s.id === "spawn_player").position;
  sim.player.position = { x: sp.x + 20, y: sp.y, z: sp.z - 15 };
  const before = JSON.stringify(sim.game.objectives);
  const { events } = stepSim(sim, { ...IDLE, unstuck: true });
  assert.ok(events.some((e) => e.kind === "unstuck"));
  assert.ok(Math.hypot(sim.player.position.x - sp.x, sim.player.position.z - sp.z) < 0.5);
  assert.equal(JSON.stringify(sim.game.objectives), before);
});

test("nav edge guard: opt-in, recorded on the grid, and no walkable cell sits on a cliff rim", async () => {
  const { buildFromRecipe } = await import("../src/gamesd/engine.mjs");
  const { sampleHeight } = await import("../src/gamesb/world/terrain-sample.mjs");
  const { generateWorldSpec, MAX_SLOPE_DEG } = await import("../src/gamesb/world/world-spec.mjs");
  const r = await buildFromRecipe({ seed: 1, theme: "red_canyon", layout: "gauntlet", template: "classic_chain", difficulty: "normal" }, { playtest: false });
  const w = r.pkg.world, nav = w.navigation, c = nav.cell, maxStep = Math.tan((MAX_SLOPE_DEG * Math.PI) / 180);
  assert.equal(nav.edge_guard, true);
  let rims = 0;
  for (let j = 1; j < nav.rows - 1; j++) for (let i = 1; i < nav.cols - 1; i++) {
    if (nav.walkable[j * nav.cols + i] !== "1") continue;
    const x = (i + 0.5) * c, z = (j + 0.5) * c, h = sampleHeight(w.terrain, x, z);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if ((di || dj) && Math.abs(sampleHeight(w.terrain, x + di * c, z + dj * c) - h) / (c * Math.hypot(di, dj)) > maxStep + 1e-9) rims++;
    }
  }
  assert.equal(rims, 0);
  // Without the concept flag (plain Games-B) the grid is baked exactly as before.
  const { nav_edge_guard, ...plain } = r.pkg.concept;
  assert.equal(generateWorldSpec(plain, { seed: 1 }).navigation.edge_guard, undefined);
});
