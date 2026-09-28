// Games-B gameplay stage: schema, generator, rules engine, solver.
// Offline; fixture worlds follow CONTRACT §2/§4.5/§6 ids (see fixtures/gamesb/gameplay).
process.env.DCS_PROVIDERS_OFFLINE = "1";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateGameplay, gameplaySkeleton, mergeProposal, gameplayAdapters, validateGameplay,
  createGameState, applyGameEvent, evaluateEnd, solveGameplay, locksFromWorld,
} from "../src/gamesb/gameplay/index.mjs";
import { conceptLocally } from "../src/gamesb/concept/concept.mjs";
import { buildFixtureWorld, buildFixtureCharacters } from "./fixtures/gamesb/gameplay/build-fixture.mjs";

console.warn = () => {};

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/gamesb/gameplay");
const load = (name) => ({
  concept: JSON.parse(fs.readFileSync(path.join(FIX, `${name}.concept.json`), "utf8")),
  world: JSON.parse(fs.readFileSync(path.join(FIX, `${name}.world.json`), "utf8")),
  characters: JSON.parse(fs.readFileSync(path.join(FIX, `${name}.characters.json`), "utf8")),
});
const ISLAND = load("island");
const DESERT = load("desert");
const clone = (x) => JSON.parse(JSON.stringify(x));

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

// ------------------------------------------------------------ generation

test("generated gameplay validates with ctx for multiple fixture worlds", async () => {
  for (const fx of [ISLAND, DESERT]) {
    const { gameplay, provenance } = await generateGameplay(fx);
    const v = validateGameplay(gameplay, { world: fx.world, characters: fx.characters });
    assert.ok(v.ok, JSON.stringify(v.errors));
    assert.equal(provenance.stage, "gameplay");
    assert.equal(provenance.status, "FALLBACK");
    assert.deepEqual(provenance.after_failed, ["cerebras:gpt-oss-120b"]);
    // Every world item has an inventory entry; every pickup is a collect objective.
    const items = new Set(gameplay.inventory.items.map((i) => i.id));
    for (const x of fx.world.interactables) if (x.item_ref) assert.ok(items.has(x.item_ref));
    assert.equal(gameplay.win_conditions[0].kind, "all_required_objectives");
    assert.equal(gameplay.objectives[0].kind, "talk");
    assert.equal(fx.characters.characters.find((c) => c.id === gameplay.objectives[0].target_ref).role, "quest_giver");
    // game_start puts the companion on follow_player.
    const intro = gameplay.events.find((e) => e.trigger.kind === "game_start");
    const comp = fx.characters.characters.find((c) => c.companion);
    assert.ok(intro.actions.some((a) => a.kind === "set_npc_state" && a.ref === comp.id && a.value === "follow_player"));
  }
  // Island: hostile → sentinel active after the first objective; storm → storm_zone.
  const { gameplay: g } = await generateGameplay(ISLAND);
  assert.ok(g.hazards.some((h) => h.kind === "sentinel" && h.character_ref === "reef_crab" && h.active_after === g.objectives[0].id));
  assert.ok(g.hazards.some((h) => h.kind === "storm_zone"));
  assert.ok(g.checkpoints.every((c) => c.spawn_ref.startsWith("spawn_cp_region_")));
  // The locked finale requires the key item's collect objective.
  const fin = g.objectives.find((o) => o.id === "activate_old_lighthouse");
  assert.ok(fin.requires.includes("collect_item_1"));
  assert.equal(g.inventory.items.find((i) => i.id === "item_1").kind, "key");
  // Desert is a puzzle: no hostiles, combat off.
  const { gameplay: d } = await generateGameplay(DESERT);
  assert.equal(d.game_type, "puzzle");
  assert.equal(d.combat.enabled, false);
  assert.ok(!d.hazards.some((h) => h.kind === "sentinel"));
});

test("generation is deterministic and works across many generated worlds", async () => {
  const a = await generateGameplay(ISLAND), b = await generateGameplay(ISLAND);
  assert.equal(JSON.stringify(a.gameplay), JSON.stringify(b.gameplay));
  const prompts = ["stealth heist in a neon city", "survive a blizzard on a frozen mountain", "vast volcanic caldera mission",
    "sci-fi mars colony reactor repair", "collect gems across a canyon", "misty temple labyrinth", "small tropical beach"];
  for (const p of prompts) {
    const concept = conceptLocally(p);
    for (const opts of [{}, { pickupsPerRegion: 2 }, { lockFinal: false }]) {
      const world = buildFixtureWorld(concept, opts);
      const characters = buildFixtureCharacters(concept);
      const { gameplay } = await generateGameplay({ concept, world, characters });
      const v = validateGameplay(gameplay, { world, characters });
      assert.ok(v.ok, `${p} ${JSON.stringify(opts)}: ${JSON.stringify(v.errors)}`);
      const s = solveGameplay(gameplay, { locks: locksFromWorld(world) });
      assert.ok(s.solvable, `${p}: ${s.reason}`);
      if (["survival", "mission"].includes(concept.genre)) {
        assert.ok(gameplay.rules.time_limit_s >= 600, "time limit is generous");
        assert.ok(gameplay.lose_conditions.some((l) => l.kind === "time_expired"));
      } else assert.equal(gameplay.rules.time_limit_s, null);
    }
  }
});

test("LLM proposal: text merged, valid extras kept, invalid extras dropped, skeleton survives", async () => {
  const skeleton = gameplaySkeleton(ISLAND);
  const ctx = { world: ISLAND.world, characters: ISLAND.characters };
  const proposal = {
    intro: "The lamp went dark the night the storm came.",
    objectives: [{ id: "talk_keeper_maren", title: "Hear Maren's tale", description: "She remembers the last light." }, { id: "made_up", title: "x" }],
    extra_optional: [
      { title: "Visit the sea cave", kind: "reach", target_ref: "region_sea_cave" },
      { title: "Talk to the harbour", kind: "talk", target_ref: "region_harbour_village" },   // wrong kind
      { title: "Fly", kind: "defeat", target_ref: "reef_crab" },                             // kind not allowed
      { title: "Ghost item", kind: "collect", target_ref: "item_99" },                        // dangling
    ],
  };
  const m = mergeProposal(skeleton, proposal, ctx);
  assert.ok(validateGameplay(m.gameplay, ctx).ok);
  assert.equal(m.applied.extras, 1);
  assert.equal(m.applied.intro, true);
  assert.equal(m.gameplay.objectives[0].title, "Hear Maren's tale");
  assert.equal(m.dropped.length, 4);
  // Required structure is untouched.
  const req = (g) => g.objectives.filter((o) => !o.optional).map((o) => [o.id, o.kind, o.target_ref, o.requires]);
  assert.deepEqual(req(m.gameplay), req(skeleton));

  // End to end through the Lane with an injected transport returning fenced + truncated JSON.
  const text = "```json\n" + JSON.stringify(proposal).slice(0, -30);
  const adapters = gameplayAdapters({ env: {}, chat: async () => ({ text, model: "gpt-oss-120b", usage: { prompt_tokens: 900, completion_tokens: 300 } }) }).slice(0, 1);
  const r = await generateGameplay({ ...ISLAND, adapters });
  assert.ok(validateGameplay(r.gameplay, ctx).ok);
  assert.equal(r.provenance.status, "AVAILABLE");
  assert.deepEqual(r.provenance.tokens, { in: 900, out: 300 });
  assert.ok(r.provenance.cost_usd > 0);

  // Garbage proposal → skeleton, FALLBACK, but the call is still costed.
  const junk = gameplayAdapters({ env: {}, chat: async () => ({ text: '{"nothing": true}', model: "gpt-oss-120b", usage: { prompt_tokens: 10, completion_tokens: 5 } }) }).slice(0, 1);
  const j = await generateGameplay({ ...ISLAND, adapters: junk });
  assert.equal(JSON.stringify(j.gameplay), JSON.stringify(skeleton));
  assert.equal(j.provenance.status, "FALLBACK");
  assert.ok(j.provenance.cost_usd > 0);
});

// ---------------------------------------------------------------- schema

test("validator catches ≥12 kinds of invalid mutation", async () => {
  const { gameplay } = await generateGameplay(ISLAND);
  const ctx = { world: ISLAND.world, characters: ISLAND.characters };
  assert.ok(validateGameplay(gameplay, ctx).ok);
  const byId = (g, id) => g.objectives.find((o) => o.id === id);
  const cases = {
    "dangling target": (g) => { byId(g, "activate_sea_cave").target_ref = "ix_nowhere"; },
    "wrong kind target (talk → region)": (g) => { g.objectives[0].target_ref = "region_harbour_village"; },
    "wrong kind target (collect → interactable)": (g) => { byId(g, "collect_item_2").target_ref = "pickup_2"; },
    "wrong kind target (reach → character)": (g) => { byId(g, "reach_old_lighthouse").target_ref = "keeper_maren"; },
    "requires cycle": (g) => { g.objectives[0].requires = ["activate_old_lighthouse"]; },
    "requires unknown objective": (g) => { byId(g, "collect_item_1").requires = ["ghost"]; },
    "required depends on optional": (g) => { byId(g, "collect_item_1").requires.push("talk_trader_odo"); },
    "no win condition": (g) => { g.win_conditions = []; },
    "unsatisfiable win (item_count beyond supply)": (g) => { g.win_conditions = [{ kind: "item_count", ref: "item_1", value: 5 }]; },
    "win on unknown region": (g) => { g.win_conditions = [{ kind: "reach_region", ref: "region_mars" }]; },
    "checkpoint spawn missing": (g) => { g.checkpoints[0].spawn_ref = "spawn_cp_region_nowhere"; },
    "checkpoint trigger on unknown objective": (g) => { g.checkpoints.push({ id: "cp_x", spawn_ref: "spawn_player", trigger: { kind: "objective_complete", ref: "ghost" } }); },
    "hazard character missing": (g) => { g.hazards[0].character_ref = "kraken"; },
    "hazard active_after unknown": (g) => { g.hazards[0].active_after = "ghost"; },
    "event trigger ref dangling": (g) => { g.events.push({ id: "ev_x", once: true, trigger: { kind: "enter_region", ref: "region_mars" }, actions: [{ kind: "message", value: "hi" }] }); },
    "event action set_npc_state on region": (g) => { g.events[0].actions.push({ kind: "set_npc_state", ref: "region_sea_cave", value: "idle" }); },
    "event action bad weather": (g) => { g.events[0].actions.push({ kind: "set_weather", value: "tornado" }); },
    "collect item with no source in world": (g) => { g.inventory.items.push({ id: "item_9", name: "X", kind: "quest", stackable: true, max_stack: 9, icon_ref: null }); byId(g, "collect_item_2").target_ref = "item_9"; },
    "collect count beyond supply": (g) => { byId(g, "collect_item_2").count = 3; },
    "world item missing from inventory": (g) => { g.inventory.items = g.inventory.items.filter((i) => i.id !== "item_4"); byId(g, "collect_item_4").target_ref = "item_3"; },
    "time_expired without time limit": (g) => { g.lose_conditions.push({ kind: "time_expired" }); },
    "bad enum objective kind": (g) => { g.objectives[0].kind = "dance"; },
    "positive gravity": (g) => { g.movement.gravity = 9.8; },
    "duplicate objective id": (g) => { g.objectives[1].id = g.objectives[0].id; },
    "talk to a character without ix_talk": (g) => { g.objectives[0].target_ref = "reef_crab"; },
    "reward item unknown": (g) => { g.objectives[0].reward.item_ref = "item_77"; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const g = clone(gameplay);
    mutate(g);
    const v = validateGameplay(g, ctx);
    assert.ok(!v.ok, `mutation '${name}' was not caught`);
  }
  assert.ok(Object.keys(cases).length >= 12);
  // The cycle is reported as a path.
  const g = clone(gameplay); g.objectives[0].requires = ["activate_old_lighthouse"];
  assert.ok(validateGameplay(g, ctx).errors.some((e) => /cycle: .*→/.test(e.message)));
  // Structural checks work without ctx; world refs are skipped.
  const noCtx = clone(gameplay); noCtx.objectives[0].target_ref = "whatever";
  assert.ok(validateGameplay(noCtx).ok);
});

// ---------------------------------------------------------- rules engine

/** A small hand-written spec exercising every mechanic. */
function spec(over = {}) {
  return {
    gameplay_version: "1.0.0", game_type: "adventure",
    rules: { player_health: 100, lives: 2, fall_damage: false, fall_y: -10, time_limit_s: null },
    movement: { walk_speed: 4, run_speed: 7, jump_velocity: 6, gravity: -20, max_slope_deg: 40, step_height: 0.4, air_control: 0.3, player_radius: 0.4, player_height: 1.8 },
    camera: { mode: "third_person", distance: 6, height: 2, fov: 60, sensitivity: 1 },
    interaction: { radius: 2, key: "KeyE", hold_ms: 0 },
    inventory: { slots: 8, items: [{ id: "item_1", name: "Gem", kind: "quest", stackable: true, max_stack: 9, icon_ref: null }, { id: "item_2", name: "Key", kind: "key", stackable: true, max_stack: 9, icon_ref: null }] },
    objectives: [
      { id: "talk", title: "Talk", description: "", kind: "talk", target_ref: "keeper", count: 1, requires: [], optional: false, reward: { xp: 60 } },
      { id: "gems", title: "Gems", description: "", kind: "collect", target_ref: "item_1", count: 3, requires: ["talk"], optional: false, reward: { xp: 60, item_ref: "item_2" } },
      { id: "altar", title: "Altar", description: "", kind: "activate", target_ref: "ix_altar", count: 1, requires: ["gems"], optional: false, reward: { xp: 100 } },
      { id: "side", title: "Side", description: "", kind: "reach", target_ref: "region_cave", count: 1, requires: [], optional: true, reward: { xp: 5 } },
    ],
    events: [
      { id: "ev_start", once: true, trigger: { kind: "game_start" }, actions: [{ kind: "message", value: "Hello" }, { kind: "set_npc_state", ref: "buddy", value: "follow_player" }] },
      { id: "ev_talked", once: true, trigger: { kind: "objective_complete", ref: "talk" }, actions: [{ kind: "reveal", ref: "region_cave" }, { kind: "checkpoint", ref: "spawn_cp_region_cave" }] },
      { id: "ev_cave", once: true, trigger: { kind: "enter_region", ref: "region_cave" }, actions: [{ kind: "message", value: "A cave!" }] },
      { id: "ev_cave_repeat", once: false, trigger: { kind: "enter_region", ref: "region_cave" }, actions: [{ kind: "set_flag", ref: "cave_seen" }] },
      { id: "ev_timer", once: true, trigger: { kind: "timer", value: 10 }, actions: [{ kind: "set_weather", value: "storm" }] },
      { id: "ev_hurt", once: true, trigger: { kind: "health_below", value: 50 }, actions: [{ kind: "message", value: "Ouch" }] },
    ],
    combat: { enabled: true, mode: "avoid", player_damage: 0, hazard_damage_per_s: 10 },
    hazards: [],
    progression: { xp_per_level: 100, max_level: 3 },
    difficulty: { level: "normal", damage_mult: 1, speed_mult: 1, time_mult: 1 },
    checkpoints: [{ id: "cp_cave", spawn_ref: "spawn_cp_region_cave", trigger: { kind: "enter_region", ref: "region_cave" } }],
    win_conditions: [{ kind: "all_required_objectives" }],
    lose_conditions: [{ kind: "health_zero" }, { kind: "lives_zero" }, { kind: "fell_out" }],
    ...over,
  };
}

const run = (g, events) => {
  let state = createGameState(g);
  const all = [];
  for (const e of events) { const r = applyGameEvent(state, g, e); state = r.state; all.push(...r.effects); }
  return { state, effects: all };
};

test("hand-written spec is itself valid", () => {
  const v = validateGameplay(spec());
  assert.ok(v.ok, JSON.stringify(v.errors));
});

test("applyGameEvent is pure (deep-frozen inputs, input unchanged)", () => {
  const g = deepFreeze(spec());
  const s0 = deepFreeze(createGameState(g));
  const snap = JSON.stringify(s0);
  const evs = [{ kind: "talk", ref: "keeper" }, { kind: "pickup", ref: "item_1", count: 3 }, { kind: "tick", dt: 11 }, { kind: "damage", value: 60 },
    { kind: "enter_region", ref: "region_cave" }, { kind: "interact", ref: "ix_altar" }, { kind: "fell_out" }];
  let s = s0;
  for (const e of evs) {
    const frozen = deepFreeze(s);
    const before = JSON.stringify(frozen);
    const r = applyGameEvent(frozen, g, deepFreeze({ ...e }));
    assert.equal(JSON.stringify(frozen), before);
    assert.notEqual(r.state, frozen);
    s = r.state;
  }
  assert.equal(JSON.stringify(s0), snap);
});

test("activation order, count progression, start effects, rewards and levels", () => {
  const g = spec();
  const s0 = createGameState(g);
  assert.deepEqual(s0.objectives, { talk: "active", gems: "locked", altar: "locked", side: "active" });
  assert.deepEqual(s0.npc_states, { buddy: "follow_player" });
  assert.equal(s0.messages[0].text, "Hello");
  // Start effects are delivered with the first event.
  const first = applyGameEvent(s0, g, { kind: "tick", dt: 0.1 });
  assert.ok(first.effects.some((e) => e.kind === "set_npc_state" && e.ref === "buddy"));
  assert.deepEqual(first.state.pending, []);

  // Only active objectives progress: interacting with the altar early does nothing.
  let { state } = run(g, [{ kind: "interact", ref: "ix_altar" }, { kind: "talk", ref: "keeper" }]);
  assert.equal(state.objectives.altar, "locked");
  assert.equal(state.objectives.talk, "done");
  assert.equal(state.objectives.gems, "active");
  assert.equal(state.checkpoint, "spawn_cp_region_cave");
  assert.equal(state.flags["revealed:region_cave"], true);

  ({ state } = run(g, [{ kind: "talk", ref: "ix_talk_keeper" }, { kind: "pickup", ref: "item_1", count: 1 }, { kind: "pickup", ref: "item_1", count: 1 }]));
  assert.equal(state.progress.gems, 2);
  assert.equal(state.objectives.gems, "active");
  const r = applyGameEvent(state, g, { kind: "pickup", ref: "item_1", count: 1 });
  assert.equal(r.state.objectives.gems, "done");
  assert.equal(r.state.objectives.altar, "active");
  assert.equal(r.state.inventory.item_2, 1, "reward item granted");
  assert.equal(r.state.xp, 120);
  assert.equal(r.state.level, 2);
  assert.ok(r.effects.some((e) => e.kind === "level_up" && e.value === 2));

  // Items picked up before a collect objective unlocks still count.
  ({ state } = run(g, [{ kind: "pickup", ref: "item_1", count: 3 }, { kind: "talk", ref: "keeper" }]));
  assert.equal(state.objectives.gems, "done");
  assert.equal(state.objectives.altar, "active");
});

test("events fire once (or repeatedly when once=false); timers and health_below are edge-triggered", () => {
  const g = spec();
  const { state } = run(g, [
    { kind: "enter_region", ref: "region_cave" }, { kind: "enter_region", ref: "region_cave" }, { kind: "enter_region", ref: "region_cave" },
    { kind: "tick", dt: 5 }, { kind: "tick", dt: 6 }, { kind: "tick", dt: 20 },
    { kind: "damage", value: 55 }, { kind: "damage", value: 1 },
  ]);
  assert.equal(state.messages.filter((m) => m.text === "A cave!").length, 1);
  assert.equal(state.flags.cave_seen, true);
  assert.equal(state.objectives.side, "done");
  assert.equal(state.weather, "storm");
  assert.equal(state.t, 31);
  assert.equal(state.messages.filter((m) => m.text === "Ouch").length, 1);
  assert.equal(state.fired.filter((f) => f === "ev_timer").length, 1);
});

test("checkpoint, damage → life loss → respawn effect → lives_zero lost", () => {
  const g = spec({ difficulty: { level: "hard", damage_mult: 2, speed_mult: 1, time_mult: 1 } });
  let { state, effects } = run(g, [{ kind: "enter_region", ref: "region_cave" }, { kind: "damage", value: 30 }]);
  assert.equal(state.health, 40, "damage_mult applied");
  assert.equal(state.checkpoint, "spawn_cp_region_cave");
  assert.ok(effects.some((e) => e.kind === "checkpoint" && e.ref === "spawn_cp_region_cave"));
  let r = applyGameEvent(state, g, { kind: "damage", value: 25 });
  assert.equal(r.state.lives, 1);
  assert.equal(r.state.health, 100, "health restored on respawn");
  assert.equal(r.state.status, "playing");
  assert.deepEqual(r.effects.find((e) => e.kind === "respawn"), { kind: "respawn", ref: "spawn_cp_region_cave", reason: "health_zero" });
  r = applyGameEvent(r.state, g, { kind: "damage", value: 500 });
  assert.equal(r.state.lives, 0);
  assert.equal(r.state.status, "lost");
  assert.ok(r.effects.some((e) => e.kind === "lose"));
  assert.ok(!r.effects.some((e) => e.kind === "respawn"));
  assert.equal(evaluateEnd(r.state, g), "lost");
});

test("fell_out: free respawn without fall_damage, a death with it", () => {
  let r = applyGameEvent(createGameState(spec()), spec(), { kind: "fell_out" });
  assert.equal(r.state.lives, 2);
  assert.ok(r.effects.some((e) => e.kind === "respawn" && e.ref === "spawn_player"));
  const g = spec({ rules: { ...spec().rules, fall_damage: true } });
  r = applyGameEvent(createGameState(g), g, { kind: "fell_out" });
  assert.equal(r.state.lives, 1);
  assert.equal(r.state.health, 100);
  r = applyGameEvent(r.state, g, { kind: "fell_out" });
  assert.equal(r.state.status, "lost");
});

test("time_expired honours difficulty time_mult", () => {
  const g = spec({ rules: { ...spec().rules, time_limit_s: 100 }, difficulty: { level: "easy", damage_mult: 0.5, speed_mult: 1, time_mult: 1.5 }, lose_conditions: [{ kind: "time_expired" }, { kind: "lives_zero" }] });
  assert.ok(validateGameplay(g).ok);
  let { state } = run(g, [{ kind: "tick", dt: 120 }]);
  assert.equal(state.status, "playing", "100 s × 1.5 = 150 s");
  const r = applyGameEvent(state, g, { kind: "tick", dt: 31 });
  assert.equal(r.state.status, "lost");
  assert.ok(r.effects.some((e) => e.kind === "lose"));
});

test("win via all_required_objectives, then status is terminal", () => {
  const g = spec();
  let { state, effects } = run(g, [{ kind: "talk", ref: "keeper" }, { kind: "pickup", ref: "item_1", count: 3 }, { kind: "interact", ref: "ix_altar" }]);
  assert.equal(state.status, "won");
  assert.equal(state.objectives.side, "active", "optional objectives are not needed");
  assert.equal(effects.filter((e) => e.kind === "win").length, 1);
  const r = applyGameEvent(state, g, { kind: "damage", value: 1000 });
  assert.equal(r.state.status, "won");
  assert.equal(r.state.health, state.health);
  assert.deepEqual(r.effects, []);
  // Other win kinds.
  const g2 = spec({ win_conditions: [{ kind: "reach_region", ref: "region_cave" }] });
  assert.equal(run(g2, [{ kind: "enter_region", ref: "region_cave" }]).state.status, "won");
  const g3 = spec({ win_conditions: [{ kind: "item_count", ref: "item_1", value: 2 }] });
  assert.equal(run(g3, [{ kind: "pickup", ref: "item_1", count: 2 }]).state.status, "won");
  // Actions win/lose from events.
  const g4 = spec({ events: [{ id: "ev_x", once: true, trigger: { kind: "interact", ref: "ix_trap" }, actions: [{ kind: "lose" }] }] });
  assert.equal(run(g4, [{ kind: "interact", ref: "ix_trap" }]).state.status, "lost");
});

test("remaining actions and event kinds behave", () => {
  const g = spec({
    objectives: [
      { id: "give", title: "Give", description: "", kind: "deliver", target_ref: "keeper", item_ref: "item_1", count: 1, requires: [], optional: false, reward: { xp: 0 } },
      { id: "beat", title: "Beat", description: "", kind: "defeat", target_ref: "crab", count: 1, requires: [], optional: true, reward: { xp: 0 } },
      { id: "wait", title: "Wait", description: "", kind: "survive", target_ref: null, count: 5, requires: [], optional: true, reward: { xp: 0 } },
      { id: "walk", title: "Walk", description: "", kind: "escort", target_ref: "buddy", count: 1, requires: [], optional: true, reward: { xp: 0 } },
    ],
    events: [
      { id: "ev_a", once: true, trigger: { kind: "game_start" }, actions: [{ kind: "give_item", ref: "item_1", value: 2 }, { kind: "remove_item", ref: "item_1" }, { kind: "unlock", ref: "ix_gate" }, { kind: "set_time", value: 0.8 }, { kind: "play_cinematic", ref: "cine:intro" }] },
      { id: "ev_b", once: true, trigger: { kind: "item_count", ref: "item_2", value: 1 }, actions: [{ kind: "heal", value: 10 }, { kind: "damage", value: 20 }] },
    ],
  });
  assert.ok(validateGameplay(g).ok, JSON.stringify(validateGameplay(g).errors));
  const s0 = createGameState(g);
  assert.equal(s0.inventory.item_1, 1);
  assert.deepEqual(s0.unlocked, ["ix_gate"]);
  assert.equal(s0.time_of_day, 0.8);
  let { state } = run(g, [{ kind: "defeat", ref: "crab" }, { kind: "tick", dt: 5 }, { kind: "npc_state", ref: "buddy", value: "arrived" }, { kind: "pickup", ref: "item_2" },
    { kind: "deliver", ref: "keeper", item: "item_2" }, { kind: "deliver", ref: "keeper", item: "item_1" }]);
  assert.equal(state.status, "won", "deliver was the only required objective");
  assert.equal(state.inventory.item_2, 1, "delivering the wrong item does nothing");
  assert.equal(state.objectives.give, "done");
  assert.equal(state.inventory.item_1, undefined, "delivered item consumed");
  assert.equal(state.objectives.beat, "done");
  assert.equal(state.objectives.wait, "done");
  assert.equal(state.objectives.walk, "done");
  assert.equal(state.health, 80);
});

// ---------------------------------------------------------------- solver

test("solver finds a plan for generated gameplay and flags broken ones", async () => {
  const { gameplay } = await generateGameplay(ISLAND);
  const locks = locksFromWorld(ISLAND.world);
  const s = solveGameplay(gameplay, { locks });
  assert.ok(s.solvable, s.reason);
  const ids = s.plan.map((p) => p.objective_id);
  assert.equal(ids[0], "talk_keeper_maren");
  assert.equal(ids.at(-1), "activate_old_lighthouse");
  for (const p of s.plan) {
    const o = gameplay.objectives.find((x) => x.id === p.objective_id);
    for (const r of o.requires) assert.ok(ids.indexOf(r) < ids.indexOf(p.objective_id), `${r} before ${p.objective_id}`);
  }
  // Unreachable target.
  const u = solveGameplay(gameplay, { reachable: (ref) => ref !== "region_old_lighthouse", locks });
  assert.equal(u.solvable, false);
  assert.match(u.reason, /reach_old_lighthouse.*unreachable/);
  // A lock whose key is never obtainable.
  const broken = clone(gameplay);
  const u2 = solveGameplay(broken, { locks: { ...locks, ix_sea_cave: "item_404" } });
  assert.equal(u2.solvable, false);
  assert.match(u2.reason, /item_404/);
  // A time limit too short to finish.
  const rushed = clone(gameplay);
  rushed.objectives.push({ id: "wait_long", title: "Wait", description: "", kind: "survive", target_ref: null, count: 999, requires: [], optional: false, reward: { xp: 0 } });
  rushed.rules.time_limit_s = 60;
  rushed.lose_conditions.push({ kind: "time_expired" });
  const u3 = solveGameplay(rushed);
  assert.equal(u3.solvable, false);
  assert.match(u3.reason, /lost/);
});
