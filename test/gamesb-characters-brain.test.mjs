// Games-B NPC brain: movement invariants over long runs on a grid with walls.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCharacters, createNpcState, stepNpc, setNpcState } from "../src/gamesb/characters/index.mjs";
import { rng } from "../src/gamesb/common/rng.mjs";
import { makeCtx, isBlockedNav } from "./fixtures/gamesb/characters/nav-ctx.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/gamesb/characters");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const concept = load("concept-saltmere.json");
const world = load("world-saltmere.json");
const spec = generateCharacters({ concept, world });
const CH = Object.fromEntries(spec.characters.map((c) => [c.id, c]));
const spawnOf = (c) => world.spawn_points.find((s) => s.id === c.spawn_ref).position;
const DT = 1 / 30;
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const blocked = (p) => isBlockedNav(world.navigation, p.x, p.z);

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

/** A random-walking player that never enters a blocked cell. */
function wanderingPlayer(seed, start) {
  const r = rng(seed);
  let p = { ...start, y: 0 }, ang = 0, t = 0;
  return () => {
    if ((t -= DT) <= 0) { ang = r() * Math.PI * 2; t = 0.5 + r() * 3; }
    const sp = r() < 0.02 ? 30 : 4.5; // the odd sprint burst makes followers teleport and chasers leash
    const q = { x: p.x + Math.cos(ang) * sp * DT, y: 0, z: p.z + Math.sin(ang) * sp * DT };
    if (blocked(q)) t = 0; else p = q;
    return p;
  };
}

test("10k steps with random player motion: no NPC ever ends a step on a blocked cell", () => {
  for (const c of spec.characters) {
    // The player roams around this NPC's own post, so chasers chase and
    // followers follow through the walls rather than idling in an empty map.
    const sp = spawnOf(c);
    const player = wanderingPlayer(99 + c.id.length, { x: sp.x + 1, z: sp.z });
    const rand = rng(7);
    let s = createNpcState(c, sp);
    const seen = new Set(), states = new Set();
    for (let i = 0; i < 10000; i++) {
      s = stepNpc(s, c, makeCtx(world, player(), rand), DT);
      states.add(s.state);
      assert.ok(Number.isFinite(s.position.x) && Number.isFinite(s.position.z) && Number.isFinite(s.position.y), `${c.id} finite`);
      assert.equal(blocked(s.position), false, `${c.id} in blocked cell at step ${i}: ${JSON.stringify(s.position)}`);
      seen.add(s.anim);
    }
    if (c.behavior.speed > 0 && c.behavior.initial !== "idle") assert.ok(seen.has("walk") || seen.has("run"), `${c.id} moved`);
    if (c.behavior.on_player_near === "chase") assert.ok(states.has("chase"), `${c.id} chased at least once`);
  }
});

test("follow_player keeps the companion in its band and teleports when left far behind", () => {
  const c = CH.pip;
  const loop = [{ x: 5, z: 14 }, { x: 16, z: 14 }, { x: 16, z: 27 }, { x: 5, z: 27 }];
  let seg = 0, p = { ...loop[0], y: 0 };
  const rand = rng(1);
  let s = createNpcState(c, { x: 7, y: 0, z: 14 });
  const ds = [];
  for (let i = 0; i < 3000; i++) {
    const goal = loop[(seg + 1) % 4];
    const d = d2(p, goal), step = 4.5 * DT;
    if (d <= step) { p = { ...goal, y: 0 }; seg = (seg + 1) % 4; } else p = { x: p.x + (goal.x - p.x) / d * step, y: 0, z: p.z + (goal.z - p.z) / d * step };
    s = stepNpc(s, c, makeCtx(world, p, rand), DT);
    if (i > 90) ds.push(d2(s.position, p));
  }
  const inBand = ds.filter((d) => d >= 1.5 && d <= 5).length / ds.length;
  assert.ok(inBand > 0.95, `in band ${inBand}`);
  assert.ok(Math.max(...ds) < 8, `max ${Math.max(...ds)}`);
  // Leave it 50 m behind: one step later it is beside the player again, on open ground.
  const far = { x: 56, y: 0, z: 56 };
  s = stepNpc(s, c, makeCtx(world, far, rand), DT);
  assert.ok(d2(s.position, far) <= 4, `after teleport ${d2(s.position, far)}`);
  assert.equal(blocked(s.position), false);
});

test("chase: aggro inside sight, give up past the leash, walk back to the post", () => {
  const c = CH.tide_sentinel;
  const home = spawnOf(c);
  const rand = rng(3);
  let s = createNpcState(c, home);
  let p = { x: 22, y: 0, z: 46 };
  const states = new Set();
  let gaveUp = false, i = 0;
  for (; i < 3000; i++) {
    if (p.x < 60) p = { x: Math.min(60, p.x + 5 * DT), y: 0, z: 46 };
    const prev = s;
    s = stepNpc(s, c, makeCtx(world, p, rand), DT);
    states.add(s.state);
    if (prev.state === "chase" && s.state !== "chase") { gaveUp = true; assert.equal(s.returning, true); assert.equal(s.state, "patrol"); }
    if (gaveUp && !s.returning) break;
  }
  assert.ok(states.has("chase"), "it chased");
  assert.ok(gaveUp, "it gave up");
  assert.ok(d2(s.position, home) <= 1.5, `back at post: ${d2(s.position, home)}`);
  // Player far away now: it resumes its patrol rather than re-aggroing.
  for (let k = 0; k < 60; k++) s = stepNpc(s, c, makeCtx(world, p, rand), DT);
  assert.equal(s.state, "patrol");
});

test("patrol visits every point in order and loops", () => {
  const c = CH.warden_bram;
  const rand = rng(5);
  let s = createNpcState(c, spawnOf(c));
  const far = { x: 5, y: 0, z: 5 };
  const order = [s.patrol_idx];
  for (let i = 0; i < 6000; i++) {
    s = stepNpc(s, c, makeCtx(world, far, rand), DT);
    if (s.patrol_idx !== order[order.length - 1]) order.push(s.patrol_idx);
  }
  const n = c.behavior.patrol.length;
  assert.ok(order.length > n + 1, `advanced ${order.length}`);
  for (let k = 1; k < order.length; k++) assert.equal(order[k], (order[k - 1] + 1) % n);
});

test("wander stays within its radius of home", () => {
  const c = CH.fisher_lio;
  const home = spawnOf(c);
  const rand = rng(11);
  let s = createNpcState(c, home);
  let maxD = 0, moved = 0;
  for (let i = 0; i < 10000; i++) {
    const prev = s.position;
    s = stepNpc(s, c, makeCtx(world, { x: 60, y: 0, z: 60 }, rand), DT);
    moved += d2(prev, s.position);
    maxD = Math.max(maxD, d2(s.position, home));
  }
  assert.ok(moved > 20, `wandered ${moved}`);
  assert.ok(maxD <= c.behavior.wander_radius + 1.5, `max ${maxD}`);
});

test("flee increases distance from the player", () => {
  const c = CH.trader_oska;
  const rand = rng(2);
  let s = setNpcState(createNpcState(c, { x: 10, y: 0, z: 22 }), "flee");
  const p = { x: 8, y: 0, z: 22 };
  const d0 = d2(s.position, p);
  for (let i = 0; i < 90; i++) s = stepNpc(s, c, makeCtx(world, p, rand), DT);
  assert.ok(d2(s.position, p) > d0 + 3, `fled ${d2(s.position, p)}`);
  assert.equal(s.state, "flee");
});

test("idle faces a nearby player; talking plays the talk anim", () => {
  const c = CH.keeper_maren;
  const rand = rng(1);
  const sp = spawnOf(c);
  let s = createNpcState(c, sp);
  const p = { x: sp.x + 3, y: 0, z: sp.z };
  s = stepNpc(s, c, makeCtx(world, p, rand), DT);
  assert.ok(Math.abs(s.rotation_y - Math.PI / 2) < 1e-9, `rot ${s.rotation_y}`);
  assert.equal(s.anim, "idle");
  s = stepNpc(s, c, makeCtx(world, p, rand, { talking: c.id }), DT);
  assert.equal(s.anim, "talk");
  assert.deepEqual({ x: s.position.x, z: s.position.z }, { x: sp.x, z: sp.z });
});

test("stepNpc is pure (deep-frozen inputs) and JSON-serialisable", () => {
  const c = deepFreeze(structuredClone(CH.tide_sentinel));
  const rand = rng(4);
  let s = deepFreeze(createNpcState(c, spawnOf(c)));
  for (let i = 0; i < 400; i++) {
    const p = deepFreeze({ x: 18 + Math.sin(i / 40) * 4, y: 0, z: 48 });
    const before = JSON.stringify(s);
    const next = stepNpc(s, c, deepFreeze(makeCtx(world, p, rand)), DT);
    assert.equal(JSON.stringify(s), before);
    assert.notEqual(next, s);
    s = deepFreeze(next);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test("deterministic given a seeded rand", () => {
  const run = () => {
    const out = [];
    for (const c of spec.characters) {
      const rand = rng(1234), player = wanderingPlayer(5, { x: 8, z: 8 });
      let s = createNpcState(c, spawnOf(c));
      for (let i = 0; i < 1500; i++) s = stepNpc(s, c, makeCtx(world, player(), rand), DT);
      out.push(s);
    }
    return JSON.stringify(out);
  };
  assert.equal(run(), run());
});

test("setNpcState clears navigation and rejects unknown states", () => {
  const c = CH.warden_bram;
  let s = createNpcState(c, spawnOf(c));
  s = { ...s, path: [{ x: 1, z: 1 }], target: { x: 1, z: 1 }, returning: true };
  const t = setNpcState(s, "guard");
  assert.equal(t.state, "guard");
  assert.equal(t.path, null);
  assert.equal(t.target, null);
  assert.equal(t.returning, false);
  assert.throws(() => setNpcState(s, "dance"), TypeError);
});
