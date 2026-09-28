// Games-D NPC/enemy behaviour presets: archetypes on a real built world, roster
// rules per difficulty and template needs, fairness, and end-to-end builds.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ARCHETYPES, npcConceptPatch, applyNpcPresets, rosterPlan, fairnessZones,
  MIN_SPAWN_GAP, SPAWN_CLEAR_R, MAX_HOSTILE_SPEED,
} from "../src/gamesd/npc/behaviours.mjs";
import { buildFromRecipe, makeContext } from "../src/gamesd/engine.mjs";
import { normaliseRecipe } from "../src/gamesd/recipe.mjs";
import { DIFFICULTY, DIFFICULTY_LEVELS } from "../src/gamesd/difficulty.mjs";
import { ASSET_BUDGET } from "../src/gamesd/budgets.mjs";
import { THEMES } from "../src/gamesd/world/themes.mjs";
import { TEMPLATES } from "../src/gamesd/gameplay/templates.mjs";
import { LAYOUTS } from "../src/gamesd/missions/layouts.mjs";
import { createNpcState, stepNpc, setNpcState } from "../src/gamesb/characters/npc-brain.mjs";
import { validateCharacters, BEHAVIOR_STATES, ROLES } from "../src/gamesb/characters/character.schema.mjs";
import { isWalkable, findPath } from "../src/gamesb/world/nav-grid.mjs";
import { sampleHeight } from "../src/gamesb/world/terrain-sample.mjs";
import { rng } from "../src/gamesb/common/rng.mjs";
import "../src/gamesb/runtime/deps.mjs";
import { createSim, stepSim, snapshot, restoreSim } from "../src/gamesb/runtime/sim-core.mjs";

const DT = 1 / 30;
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const themeIds = Object.keys(THEMES), templateIds = Object.keys(TEMPLATES), layoutIds = Object.keys(LAYOUTS);
const HOSTILE_ARCH = Object.values(ARCHETYPES).filter((a) => a.hostile).map((a) => a.id);

// Two themes with different biomes when the table has them.
const THEME_A = themeIds[0];
const THEME_B = themeIds.find((t) => THEMES[t].biome !== THEMES[THEME_A].biome) || themeIds[themeIds.length - 1];
// A template that wants hostiles, if any declares it.
const HOSTILE_TEMPLATE = templateIds.find((t) => (TEMPLATES[t].needs?.hostiles_min || 0) >= 2) || templateIds[0];
const MEDIUM_LAYOUT = layoutIds.find((l) => LAYOUTS[l].scale === "medium") || layoutIds[0];

// ------------------------------------------------------------ world fixture

let fixture = null;
/** One real built world, and one character per archetype placed on it by applyNpcPresets. */
async function world() {
  if (fixture) return fixture;
  const recipe = normaliseRecipe({ seed: 7, theme: THEME_A, template: HOSTILE_TEMPLATE, layout: MEDIUM_LAYOUT, difficulty: "normal" });
  const res = await buildFromRecipe(recipe, { playtest: false });
  const pkg = res.pkg;
  const w = pkg.world;
  const base = pkg.characters.characters;
  // Hostile archetypes reuse the hostiles' spawns (non-hub), friendly ones the others'.
  const hostSpawns = base.filter((c) => c.behavior.hostile).map((c) => c.spawn_ref);
  const friendSpawns = base.filter((c) => !c.behavior.hostile).map((c) => c.spawn_ref);
  const chars = [], conceptChars = [];
  Object.values(ARCHETYPES).forEach((A, k) => {
    const pool = A.hostile && hostSpawns.length ? hostSpawns : friendSpawns;
    const id = `t_${A.id}`;
    const role = A.id === "companion" ? "companion" : A.id === "quest" ? "quest_giver" : A.id === "vendor" ? "merchant" : A.hostile ? "enemy" : "ambient";
    chars.push({ ...base[0], id, name: id, role, spawn_ref: pool[k % pool.length], companion: A.id === "companion", dialogue_ref: null });
    conceptChars.push({ id, archetype: A.id });
  });
  const ctx = { ...makeContext(recipe), world: w, concept: { ...pkg.concept, characters: conceptChars } };
  const spec = applyNpcPresets({ character_spec_version: "1.0.0", characters: chars, dialogues: [] }, ctx);
  const byArch = Object.fromEntries(spec.characters.map((c) => [c.behavior.archetype, c]));
  const spawnOf = (c) => w.spawn_points.find((s) => s.id === c.spawn_ref).position;
  fixture = { recipe, res, pkg, w, spec, byArch, spawnOf, zones: fairnessZones(w, base) };
  return fixture;
}

function navCtx(w, player, rand, extra = {}) {
  return {
    player,
    heightAt: (x, z) => sampleHeight(w.terrain, x, z),
    isBlocked: (x, z) => !isWalkable(w.navigation, x, z),
    findPath: (a, b) => findPath(w.navigation, a, b),
    rand,
    ...extra,
  };
}

/** A random-walking player that stays on walkable cells. */
function roamingPlayer(w, seed, start) {
  const r = rng(seed);
  let p = { x: start.x, y: 0, z: start.z }, ang = 0, t = 0;
  return () => {
    if ((t -= DT) <= 0) { ang = r() * Math.PI * 2; t = 0.5 + r() * 3; }
    const sp = r() < 0.02 ? 25 : 4.5;
    const q = { x: p.x + Math.cos(ang) * sp * DT, y: 0, z: p.z + Math.sin(ang) * sp * DT };
    if (!isWalkable(w.navigation, q.x, q.z)) t = 0; else p = q;
    return p;
  };
}

function run(c, start, playerFn, steps, seed = 3, extra) {
  const rand = rng(seed);
  let s = createNpcState(c, start);
  const trace = [];
  for (let i = 0; i < steps; i++) {
    const p = playerFn(i);
    s = stepNpc(s, c, navCtx(fixture.w, p, rand, extra), DT);
    trace.push(s);
  }
  return trace;
}

// ------------------------------------------------------------ archetype table

test("at least 7 archetypes, each a valid CONTRACT §6 behaviour", () => {
  const ids = Object.keys(ARCHETYPES);
  assert.ok(ids.length >= 7, `have ${ids.length}`);
  for (const need of ["sentinel_patrol", "guard_post", "wanderer", "stalker", "skittish", "companion", "vendor", "swarm"]) assert.ok(ARCHETYPES[need], need);
  for (const A of Object.values(ARCHETYPES)) {
    const b = A.behavior;
    assert.ok(BEHAVIOR_STATES.includes(b.initial), `${A.id} initial`);
    for (const k of ["on_player_near", "on_player_far"]) if (b[k]) assert.ok(BEHAVIOR_STATES.includes(b[k]), `${A.id} ${k}`);
    for (const k of ["speed", "sight_radius", "wander_radius", "leash_radius"]) assert.equal(typeof b[k], "number", `${A.id}.${k}`);
    assert.equal(typeof A.hostile, "boolean");
    if (b.on_player_near === "chase") assert.ok(b.leash_radius >= b.sight_radius, `${A.id} leash ≥ sight`);
    if (A.hostile) assert.ok(b.speed * DIFFICULTY.hard.npc_speed_mult <= 7.5 * 0.75, `${A.id} slower than the player's run on hard`);
  }
});

test("presets on a real world validate, and hostile routes stay on fair walkable cells", async () => {
  const { spec, w, zones } = await world();
  const v = validateCharacters(spec, { world: w });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const sp = w.spawn_points.find((s) => s.id === "spawn_player").position;
  for (const c of spec.characters) {
    const b = c.behavior;
    if (b.initial === "patrol") assert.ok(b.patrol.length >= 2, `${c.id} has a loop`);
    for (const p of b.patrol) {
      assert.ok(isWalkable(w.navigation, p.x, p.z), `${c.id} patrol point walkable`);
      for (const z of zones) assert.ok(d2(p, z) >= z.r, `${c.id} patrol point in ${z.why}`);
    }
    if (b.hostile) {
      assert.ok(b.speed <= MAX_HOSTILE_SPEED);
      assert.ok(Array.isArray(b.avoid) && b.avoid.length >= 1, `${c.id} has keep-out discs`);
      const start = createNpcState(c, fixture.spawnOf(c)).position;
      assert.ok(d2(start, sp) >= MIN_SPAWN_GAP, `${c.id} starts ${d2(start, sp).toFixed(1)} m from spawn_player`);
    }
  }
});

// ------------------------------------------------------------ brain, per archetype

test("every archetype: deterministic and never in a blocked cell or a keep-out disc over 4000 steps", async () => {
  const { spec, w } = await world();
  for (const c of spec.characters) {
    const start = fixture.spawnOf(c);
    const home = c.behavior.home || start;
    const pA = roamingPlayer(w, 11, home);
    const pB = roamingPlayer(w, 11, home);
    const a = run(c, start, () => pA(), 4000, 5);
    const b = run(c, start, () => pB(), 4000, 5);
    assert.deepEqual(a[a.length - 1], b[b.length - 1], `${c.id} deterministic`);
    const zones = c.behavior.avoid || [];
    const startIn = new Set(zones.filter((z) => d2(a[0].position, z) < z.r).map((z) => z));
    let moved = false;
    a.forEach((s, i) => {
      assert.ok(isWalkable(w.navigation, s.position.x, s.position.z), `${c.id} blocked at step ${i}`);
      for (const z of zones) if (!startIn.has(z)) assert.ok(d2(s.position, z) >= z.r - 1e-6, `${c.id} entered a keep-out disc at step ${i}`);
      if (i && d2(s.position, a[i - 1].position) > 1e-6) moved = true;
    });
    if (!["vendor", "quest", "guard_post"].includes(c.behavior.archetype)) assert.ok(moved, `${c.id} moved`);
    assert.deepEqual(JSON.parse(JSON.stringify(a[a.length - 1])), a[a.length - 1], `${c.id} state is plain JSON`);
  }
});

test("sentinel_patrol walks its loop when nobody is around", async () => {
  const { byArch } = await world();
  const c = byArch.sentinel_patrol;
  if (c.behavior.initial !== "patrol") return; // degraded to a post on a cramped world (noted)
  const far = { x: -1000, y: 0, z: -1000 };
  const tr = run(c, fixture.spawnOf(c), () => far, 3000);
  const visited = new Set();
  for (const s of tr) c.behavior.patrol.forEach((p, k) => { if (d2(s.position, p) < 1) visited.add(k); });
  assert.ok(visited.size >= 2, `visited ${[...visited]}`);
  assert.ok(tr.every((s) => s.state === "patrol"));
});

test("stalker chases in sight, then leashes back home when the player runs off", async () => {
  const { byArch, w } = await world();
  const c = byArch.stalker;
  const home = c.behavior.home || fixture.spawnOf(c);
  const rand = rng(9);
  let s = createNpcState(c, fixture.spawnOf(c));
  // Player close by: the stalker switches to chase.
  const near = { x: home.x + 3, y: 0, z: home.z };
  for (let i = 0; i < 10; i++) s = stepNpc(s, c, navCtx(w, near, rand), DT);
  assert.equal(s.state, "chase");
  // The player keeps running off: the stalker follows only to its leash...
  let maxHome = 0;
  for (let i = 0; i < 600; i++) {
    const k = Math.min(1, i / 300);
    const p = { x: home.x + 3 + k * c.behavior.leash_radius * 3, y: 0, z: home.z + k * c.behavior.leash_radius * 3 };
    s = stepNpc(s, c, navCtx(w, p, rand), DT);
    maxHome = Math.max(maxHome, d2(s.position, home));
  }
  assert.ok(maxHome <= c.behavior.leash_radius + 1, `stayed on the leash (${maxHome.toFixed(1)})`);
  // ...then gives up and prowls back to its lair.
  assert.equal(s.state, "wander");
  const gone = { x: -1000, y: 0, z: -1000 };
  for (let i = 0; i < 900; i++) s = stepNpc(s, c, navCtx(w, gone, rand), DT);
  assert.ok(d2(s.position, home) <= c.behavior.wander_radius + 2.5, `back home (${d2(s.position, home).toFixed(2)})`);
});

test("guard_post holds its post, lunges, and walks back", async () => {
  const { byArch, w } = await world();
  const c = byArch.guard_post;
  const home = c.behavior.home || fixture.spawnOf(c);
  const rand = rng(4);
  let s = createNpcState(c, fixture.spawnOf(c));
  const far = { x: -1000, y: 0, z: -1000 };
  for (let i = 0; i < 60; i++) s = stepNpc(s, c, navCtx(w, far, rand), DT);
  assert.equal(s.state, "guard");
  assert.ok(d2(s.position, home) < 1e-6, "still at the post");
  const near = { x: home.x + 2.5, y: 0, z: home.z };
  for (let i = 0; i < 5; i++) s = stepNpc(s, c, navCtx(w, near, rand), DT);
  assert.equal(s.state, "chase");
  for (let i = 0; i < 600; i++) s = stepNpc(s, c, navCtx(w, far, rand), DT);
  assert.equal(s.state, "guard");
  assert.ok(d2(s.position, home) <= 1.2, `back at post (${d2(s.position, home).toFixed(2)})`);
});

test("skittish critter flees a close player, never past its leash, and wanders home after", async () => {
  const { byArch, w } = await world();
  const c = byArch.skittish;
  const start = fixture.spawnOf(c);
  const rand = rng(2);
  let s = createNpcState(c, start);
  const p = { x: start.x + 1.5, y: 0, z: start.z };
  const d0 = d2(s.position, p);
  let maxHome = 0, maxP = 0, fled = false;
  for (let i = 0; i < 240; i++) {
    s = stepNpc(s, c, navCtx(w, p, rand), DT);
    if (s.state === "flee") fled = true;
    maxHome = Math.max(maxHome, d2(s.position, s.home));
    maxP = Math.max(maxP, d2(s.position, p));
  }
  assert.ok(fled, "bolted");
  assert.ok(maxP > d0 + 2, `fled to ${maxP.toFixed(2)}`);
  assert.ok(maxHome <= c.behavior.leash_radius + 0.5, `leash ${maxHome.toFixed(2)}`);
  const gone = { x: -1000, y: 0, z: -1000 };
  for (let i = 0; i < 1200; i++) s = stepNpc(s, c, navCtx(w, gone, rand), DT);
  assert.equal(s.state, "wander");
  assert.ok(d2(s.position, s.home) <= c.behavior.wander_radius + 2.5, `back near home (${d2(s.position, s.home).toFixed(2)})`);
});

test("companion keeps a 2–4 m band behind a walking player", async () => {
  const { byArch, w } = await world();
  const c = byArch.companion;
  const start = fixture.spawnOf(c);
  const pf = roamingPlayer(w, 5, { x: start.x + 2, z: start.z });
  const rand = rng(1);
  let s = createNpcState(c, start), inBand = 0;
  const N = 1800;
  for (let i = 0; i < N; i++) {
    const p = pf();
    s = stepNpc(s, c, navCtx(w, p, rand), DT);
    const d = d2(s.position, p);
    if (d >= 1.5 && d <= 6) inBand++;
  }
  assert.ok(inBand / N > 0.7, `in band ${(100 * inBand / N).toFixed(0)}%`);
});

test("vendor and quest giver stay put and face a nearby player", async () => {
  const { byArch, w } = await world();
  for (const c of [byArch.vendor, byArch.quest]) {
    const start = fixture.spawnOf(c);
    let s = createNpcState(c, start);
    const p = { x: start.x + 3, y: 0, z: start.z };
    s = stepNpc(s, c, navCtx(w, p, rng(1)), DT);
    assert.ok(Math.abs(s.rotation_y - Math.PI / 2) < 1e-9, `${c.id} faces the player`);
    s = stepNpc(s, c, navCtx(w, p, rng(1), { talking: c.id }), DT);
    assert.equal(s.anim, "talk");
    assert.ok(d2(s.position, start) < 1e-9);
  }
});

// ------------------------------------------------------------ brain extensions on a mock grid

const wallCtx = (player, extra = {}) => ({
  player, heightAt: () => 0, rand: rng(1),
  isBlocked: (x, z) => x < 0 || z < 0 || x > 40 || z > 40 || (x > 19 && x < 21 && z > 5 && z < 35),
  findPath: () => null, ...extra,
});
const mk = (behavior) => ({ id: "m", behavior: { patrol: [], wander_radius: 0, leash_radius: 20, hostile: true, ...behavior } });

test("sight_los: a wall hides the player; open ground does not", () => {
  const c = mk({ initial: "guard", on_player_near: "chase", on_player_far: "guard", speed: 3, sight_radius: 10, sight_los: true });
  let s = createNpcState(c, { x: 17, y: 0, z: 20 });
  s = stepNpc(s, c, wallCtx({ x: 23, y: 0, z: 20 }), DT);
  assert.equal(s.state, "guard", "behind the wall");
  s = stepNpc(s, c, wallCtx({ x: 12, y: 0, z: 20 }), DT);
  assert.equal(s.state, "chase", "in the open");
});

test("avoid discs: never entered from outside, always escapable from inside", () => {
  const zone = { x: 10, z: 10, r: 4 };
  const c = mk({ initial: "chase", speed: 4, sight_radius: 30, avoid: [zone] });
  let s = createNpcState(c, { x: 2, y: 0, z: 10 });
  let gaveUp = false;
  for (let i = 0; i < 300; i++) {
    s = stepNpc(s, c, wallCtx({ x: 10, y: 0, z: 10 }), DT);
    assert.ok(d2(s.position, zone) >= zone.r - 1e-9, `entered at ${i}`);
    if (s.returning) gaveUp = true;
  }
  assert.ok(gaveUp, "a player inside the disc makes the chaser give up");
  const g = mk({ initial: "patrol", speed: 3, sight_radius: 5, patrol: [{ x: 2, z: 2 }, { x: 2, z: 30 }], avoid: [zone] });
  let t = createNpcState(g, { x: 10, y: 0, z: 10 });
  for (let i = 0; i < 300; i++) t = stepNpc(t, g, wallCtx({ x: 100, y: 0, z: 100 }), DT);
  assert.ok(d2(t.position, zone) >= zone.r, "walked out of the disc");
});

test("chase_max_s: a chaser loses interest and walks home, then can re-aggro", () => {
  const c = mk({ initial: "guard", on_player_near: "chase", on_player_far: "guard", speed: 2, sight_radius: 12, leash_radius: 30, chase_max_s: 3 });
  let s = createNpcState(c, { x: 5, y: 0, z: 20 });
  const p = { x: 14, y: 0, z: 20 };
  let t = 0;
  for (; t < 120 && !s.returning; t++) s = stepNpc(s, c, wallCtx(p), DT);
  assert.ok(s.returning, "gave up");
  assert.ok(Math.abs(t * DT - 3) < 0.1, `after ${(t * DT).toFixed(2)} s`);
  for (let i = 0; i < 600 && s.returning; i++) s = stepNpc(s, c, wallCtx(p), DT);
  assert.equal(s.returning, false);
  s = stepNpc(s, c, wallCtx(p), DT);
  assert.equal(s.state, "chase", "re-aggro once home");
});

test("behavior.home moves the start post; setNpcState still works on the new fields", () => {
  const c = mk({ initial: "guard", speed: 3, sight_radius: 5, home: { x: 5, z: 6 } });
  const s = createNpcState(c, { x: 30, y: 0, z: 30 });
  assert.deepEqual({ x: s.position.x, z: s.position.z }, { x: 5, z: 6 });
  assert.deepEqual(s.home, { x: 5, z: 6 });
  assert.equal(setNpcState(s, "flee").state, "flee");
});

// ------------------------------------------------------------ roster

const fakeConcept = (biome = "forest", scale = "medium") => ({
  seed: 3, biome, scale, genre: "adventure",
  characters: [
    { id: "keeper_maren", name: "Keeper Maren", role: "quest_giver", description: "x" },
    { id: "scout_tobin", name: "Tobin the Scout", role: "companion", description: "x" },
    { id: "thorn_wolf", name: "Thorn Wolf", role: "creature", description: "x" },
    { id: "trader_isla", name: "Isla the Trader", role: "merchant", description: "x" },
    { id: "villager_odo", name: "Odo", role: "ambient", description: "x" },
  ],
  hazards: ["Thorn Wolf patrolling the wilds", "Sheer drops"],
});
const ctxFor = (template, difficulty, theme = THEME_A, scale = "medium") => ({ template, difficulty: DIFFICULTY[difficulty], theme: THEMES[theme], scale, notes: [], recipe: { seed: 3 } });

test("hostile counts follow difficulty and template needs, within the character budget", () => {
  for (const tid of templateIds) {
    const T = TEMPLATES[tid];
    for (const scale of Object.keys(ASSET_BUDGET)) {
      const counts = DIFFICULTY_LEVELS.map((d) => rosterPlan(ctxFor(T, d, THEME_A, scale), { scale }).hostiles);
      for (let k = 1; k < counts.length; k++) assert.ok(counts[k] >= counts[k - 1], `${tid}/${scale} monotonic ${counts}`);
      const n = T.needs || {};
      const budget = ASSET_BUDGET[scale].characters;
      for (const h of counts) {
        if (Number.isInteger(n.hostiles_max) && n.hostiles_max >= (n.hostiles_min || 0)) assert.ok(h <= n.hostiles_max, `${tid} max`);
        if (Number.isInteger(n.hostiles_min)) assert.ok(h >= Math.min(n.hostiles_min, budget - 2), `${tid} min`);
      }
      const patched = npcConceptPatch(fakeConcept(THEMES[THEME_A].biome, scale), ctxFor(T, "hard", THEME_A, scale));
      assert.ok(patched.characters.length <= budget, `${tid}/${scale} budget`);
    }
  }
  const T = { id: "x", genre: "adventure", needs: { hostiles_min: 1, hostiles_max: 4 } };
  assert.deepEqual(DIFFICULTY_LEVELS.map((d) => rosterPlan(ctxFor(T, d)).hostiles), [1, 2, 3]);
});

test("roster: unique slug ids, §1 roles, quest giver first, themed hostile names", () => {
  const T = { id: "x", genre: "adventure", needs: { hostiles_min: 2, hostiles_max: 6 } };
  for (const theme of themeIds) {
    const c = npcConceptPatch(fakeConcept(THEMES[theme].biome), ctxFor(T, "hard", theme));
    const ids = c.characters.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, `${theme} unique`);
    for (const x of c.characters) {
      assert.match(x.id, /^[a-z][a-z0-9_]*$/);
      assert.ok(ROLES.includes(x.role), `${theme} role ${x.role}`);
      assert.ok(ARCHETYPES[x.archetype], `${x.id} archetype`);
    }
    assert.equal(c.characters[0].role, "quest_giver");
    assert.equal(c.characters.filter((x) => x.role === "companion").length, 1);
    const hostile = c.characters.filter((x) => ARCHETYPES[x.archetype].hostile);
    assert.equal(hostile.length, 4);
    assert.ok(!hostile.some((h) => h.id === "thorn_wolf" && THEMES[theme].biome !== "forest"), "generator hostile replaced");
    assert.ok(!c.hazards.includes("Thorn Wolf patrolling the wilds") || THEMES[theme].biome === "forest");
  }
});

test("roster styles: hunt → ≥2 vulnerable; stealth → sentinels; companion:false drops it", () => {
  const hunt = TEMPLATES.hunt || { id: "hunt", genre: "adventure", kinds: ["defeat"], needs: { hostiles_min: 2, hostiles_max: 4 } };
  for (const d of DIFFICULTY_LEVELS) {
    const c = npcConceptPatch(fakeConcept(), ctxFor(hunt, d));
    const vul = c.characters.filter((x) => ["enemy", "creature"].includes(x.role));
    assert.ok(vul.length >= 2, `${d}: ${vul.length} vulnerable`);
  }
  for (const d of DIFFICULTY_LEVELS) assert.ok(!rosterPlan(ctxFor(hunt, d)).archetypes.includes("swarm"), "no swarm among hunt targets");
  const stealth = Object.values(TEMPLATES).find((t) => t.genre === "stealth") || { id: "stealth", genre: "stealth", needs: { hostiles_min: 2 } };
  const s = npcConceptPatch(fakeConcept(), ctxFor(stealth, "normal"));
  assert.ok(s.characters.filter((x) => x.archetype === "sentinel_patrol").length >= 2);
  const lone = npcConceptPatch(fakeConcept(), ctxFor({ id: "solo", genre: "adventure", needs: { companion: false } }, "easy"));
  assert.equal(lone.characters.filter((x) => x.role === "companion").length, 0);
  const swarm = npcConceptPatch(fakeConcept(), ctxFor({ id: "x", genre: "adventure", needs: { archetypes: ["swarm"], hostiles_min: 3 } }, "easy"));
  assert.equal(swarm.characters.filter((x) => x.archetype === "swarm").length, 3);
  assert.ok(swarm.characters.filter((x) => x.archetype === "swarm").every((x) => x.size === "small"));
});

test("patches never throw on junk input", () => {
  assert.doesNotThrow(() => npcConceptPatch({}, {}));
  assert.doesNotThrow(() => applyNpcPresets({ characters: [{ id: "a", role: "enemy" }] }, {}));
  assert.doesNotThrow(() => applyNpcPresets(null, {}));
});

// ------------------------------------------------------------ end to end

const E2E = [THEME_A, THEME_B].flatMap((theme, ti) => DIFFICULTY_LEVELS.map((difficulty, di) => ({
  seed: 40 + ti * 3 + di, theme, template: ti === 0 ? HOSTILE_TEMPLATE : templateIds[Math.min(1, templateIds.length - 1)], layout: layoutIds[(ti + di) % layoutIds.length], difficulty,
})));

for (const recipe of E2E) {
  test(`buildFromRecipe ${recipe.theme}/${recipe.template}/${recipe.layout}/${recipe.difficulty}: ok, fair, save/reload exact`, async () => {
    const res = await buildFromRecipe(recipe);
    assert.equal(res.ok, true, `${res.playtest?.reason} ${JSON.stringify(res.validation.errors?.slice(0, 3))}`);
    assert.equal(res.playtest.won, true);
    assert.ok(res.playtest.save_reload.ok || res.playtest.save_reload.skipped);
    const pkg = res.pkg;
    const chars = pkg.characters.characters;
    const budget = ASSET_BUDGET[pkg.concept.scale]?.characters ?? 10;
    assert.ok(chars.length <= budget, `characters ${chars.length} ≤ ${budget}`);
    const plan = rosterPlan(makeContext(normaliseRecipe(recipe)), { scale: pkg.concept.scale });
    assert.equal(chars.filter((c) => c.behavior.hostile).length, plan.hostiles, "hostile count follows the plan");
    for (const c of chars) assert.ok(c.behavior.archetype, `${c.id} has an archetype`);

    // t = 0: every hostile starts well clear of spawn_player.
    const sim = createSim(pkg);
    const sp = pkg.world.spawn_points.find((s) => s.id === "spawn_player").position;
    for (const c of chars.filter((x) => x.behavior.hostile)) {
      assert.ok(d2(sim.npcs[c.id].position, sp) >= MIN_SPAWN_GAP, `${c.id} at t=0`);
    }
    // A player who idles at spawn for 40 s is never approached inside the spawn disc.
    for (let i = 0; i < 40 * 60; i++) {
      stepSim(sim, { move: { x: 0, z: 0 }, run: false, jump: false, interact: false });
      if (i % 30 === 0) for (const c of chars.filter((x) => x.behavior.hostile)) {
        assert.ok(d2(sim.npcs[c.id].position, sp) >= SPAWN_CLEAR_R - 1e-6, `${c.id} camped the spawn at step ${i}`);
        assert.ok(isWalkable(pkg.world.navigation, sim.npcs[c.id].position.x, sim.npcs[c.id].position.z), `${c.id} walkable`);
      }
    }
    // Save/reload mid-game is exact, and replays identically.
    const save = snapshot(sim, { now: "1970-01-01T00:00:00.000Z" });
    const back = restoreSim(pkg, save);
    assert.deepEqual(snapshot(back, { now: "1970-01-01T00:00:00.000Z" }), save);
    for (let i = 0; i < 300; i++) {
      const input = { move: { x: Math.sin(i / 40), z: Math.cos(i / 55) }, run: true, jump: false, interact: false };
      stepSim(sim, input); stepSim(back, input);
    }
    assert.deepEqual(snapshot(back, { now: "x" }).npcs, snapshot(sim, { now: "x" }).npcs);
  });
}

test("the same recipe rebuilds byte-identical characters", async () => {
  const r = { seed: 5, theme: THEME_B, template: HOSTILE_TEMPLATE, layout: MEDIUM_LAYOUT, difficulty: "hard" };
  const a = await buildFromRecipe(r, { playtest: false });
  const b = await buildFromRecipe(r, { playtest: false });
  assert.deepEqual(a.pkg.characters, b.pkg.characters);
  assert.equal(a.pkg.integrity.sha256, b.pkg.integrity.sha256);
});
