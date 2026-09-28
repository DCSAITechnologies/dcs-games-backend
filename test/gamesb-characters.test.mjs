// Games-B characters: schema, generator and dialogue runner.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCharacters, validateCharacters, validateDialogues,
  openDialogue, availableChoices, choose, evalCondition, ASSUMED_PLAYER_WALK,
} from "../src/gamesb/characters/index.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/gamesb/characters");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const FIXTURES = ["saltmere", "relay"].map((n) => ({ n, concept: load(`concept-${n}.json`), world: load(`world-${n}.json`) }));
const [SALT] = FIXTURES;
const clone = (v) => JSON.parse(JSON.stringify(v));
const fresh = () => generateCharacters({ concept: SALT.concept, world: SALT.world });
const byId = (spec, id) => spec.characters.find((c) => c.id === id);

test("generated characters validate for every fixture concept (dialogues included)", () => {
  for (const { n, concept, world } of FIXTURES) {
    const spec = generateCharacters({ concept, world });
    const v = validateCharacters(spec, { world, concept });
    assert.deepEqual(v.errors, [], `${n}: ${JSON.stringify(v.errors)}`);
    assert.equal(validateDialogues(spec).ok, true, n);
    assert.equal(spec.characters.length, concept.characters.length);
    for (const c of spec.characters) {
      assert.equal(c.asset_ref, `char:${c.id}`);
      assert.equal(c.spawn_ref, `spawn_npc_${c.id}`);
      assert.equal(c.dialogue_ref === null, c.role === "enemy", `${c.id} dialogue_ref`);
    }
    assert.equal(spec.characters.filter((c) => c.companion).length, 1);
  }
});

test("generation is deterministic and independent of other characters", () => {
  assert.equal(JSON.stringify(fresh()), JSON.stringify(fresh()));
  const fewer = clone(SALT.concept);
  fewer.characters = fewer.characters.filter((c) => c.id !== "trader_oska");
  const a = generateCharacters({ concept: fewer, world: SALT.world });
  assert.deepEqual(byId(a, "warden_bram"), byId(fresh(), "warden_bram"));
  // Without a world it still produces a valid spec; patrollers fall back to guarding a post.
  const noWorld = generateCharacters({ concept: SALT.concept });
  assert.deepEqual(validateCharacters(noWorld).errors, []);
  assert.equal(byId(noWorld, "warden_bram").behavior.initial, "guard");
});

test("role → body and behaviour mapping", () => {
  const s = fresh();
  const keeper = byId(s, "keeper_maren"), pip = byId(s, "pip"), oska = byId(s, "trader_oska");
  const bram = byId(s, "warden_bram"), sentinel = byId(s, "tide_sentinel"), crab = byId(s, "reef_crab"), lio = byId(s, "fisher_lio");
  assert.deepEqual(keeper.body.accessories.slice(0, 2), ["hood", "lantern"]);
  assert.equal(keeper.behavior.initial, "idle");
  assert.ok(oska.body.accessories.includes("satchel") && oska.body.accessories.includes("hat"));
  assert.equal(oska.behavior.initial, "idle");
  assert.ok(bram.body.accessories.includes("hat") && bram.body.accessories.includes("staff"));
  assert.equal(bram.behavior.initial, "patrol");
  assert.ok(bram.behavior.patrol.length >= 2);
  const region = SALT.world.regions.find((r) => r.id === "region_shrine");
  for (const p of bram.behavior.patrol) {
    assert.ok(p.x >= region.bounds[0] && p.x <= region.bounds[2] && p.z >= region.bounds[1] && p.z <= region.bounds[3], "patrol stays in region");
  }
  assert.equal(pip.companion, true);
  assert.equal(pip.behavior.initial, "follow_player");
  assert.ok(pip.behavior.speed > ASSUMED_PLAYER_WALK);
  assert.equal(pip.body.locomotion, "quadruped");
  assert.ok(pip.body.height < 1);
  for (const e of [sentinel, crab]) {
    assert.equal(e.behavior.hostile, true);
    assert.equal(e.behavior.initial, "patrol");
    assert.equal(e.behavior.on_player_near, "chase");
    assert.ok(e.behavior.leash_radius >= e.behavior.sight_radius);
  }
  assert.equal(sentinel.kind, "spirit");
  assert.equal(sentinel.body.locomotion, "hover");
  assert.equal(sentinel.body.glow, SALT.concept.palette.accent);
  assert.equal(lio.behavior.initial, "wander");
  assert.ok(lio.behavior.wander_radius > 0);
  // Robot on the sci-fi base; its quest giver is not a lantern keeper.
  const relay = generateCharacters(FIXTURES[1]);
  assert.equal(byId(relay, "sec_unit").kind, "robot");
  assert.equal(byId(relay, "bolt").kind, "robot");
  assert.ok(!byId(relay, "engineer_ada").body.accessories.includes("lantern"));
});

test("dialogue text is authored for the concept", () => {
  const s = fresh();
  const all = s.dialogues.flatMap((d) => d.nodes.map((n) => n.text)).join(" ");
  assert.match(all, /Saltmere Harbor/);
  assert.match(all, /Keeper Maren/);
  assert.match(all, /Gull Shrine|Drowned Arches|Beacon Summit/);
  const qg = s.dialogues.find((d) => d.character_ref === "keeper_maren");
  const lore = qg.nodes.find((n) => n.id === "lore");
  assert.ok(lore.choices.length >= 2 && lore.choices.length <= 3);
  // Progress entries key on items the world actually places, not on objective ids.
  const conds = qg.entry.flatMap((e) => e.conditions);
  assert.ok(conds.some((c) => c.kind === "has_item" && c.ref === "item_1"));
  assert.ok(!conds.some((c) => c.kind === "objective_state"));
});

// --- schema: invalid mutations ------------------------------------------------

const MUTATIONS = [
  ["wrong version", (s) => { s.character_spec_version = "2.0.0"; }, "character_spec_version"],
  ["duplicate id", (s) => { s.characters[1].id = s.characters[0].id; }, "characters[1].id"],
  ["bad role", (s) => { s.characters[0].role = "wizard"; }, "characters[0].role"],
  ["bad kind", (s) => { s.characters[0].kind = "dragon"; }, "characters[0].kind"],
  ["bad palette hex", (s) => { s.characters[0].body.palette.skin = "tan"; }, "characters[0].body.palette.skin"],
  ["unknown accessory", (s) => { s.characters[0].body.accessories.push("jetpack"); }, "characters[0].body.accessories"],
  ["absurd height", (s) => { s.characters[0].body.height = 40; }, "characters[0].body.height"],
  ["negative speed", (s) => { s.characters[3].behavior.speed = -1; }, "characters[3].behavior.speed"],
  ["bad initial state", (s) => { s.characters[0].behavior.initial = "dance"; }, "characters[0].behavior.initial"],
  ["patrol out of world", (s) => { s.characters[3].behavior.patrol[0] = { x: 500, z: 5 }; }, "characters[3].behavior.patrol[0]"],
  ["patroller with 1 point", (s) => { s.characters[3].behavior.patrol.length = 1; }, "characters[3].behavior.patrol"],
  ["spawn does not resolve", (s) => { s.characters[0].spawn_ref = "spawn_npc_nobody"; }, "characters[0].spawn_ref"],
  ["spawn is not npc", (s) => { s.characters[0].spawn_ref = "spawn_player"; }, "characters[0].spawn_ref"],
  ["dialogue_ref dangling", (s) => { s.characters[0].dialogue_ref = "dlg_missing"; }, "characters[0].dialogue_ref"],
  ["two companions", (s) => { s.characters[0].companion = true; }, "characters"],
  ["hostile companion", (s) => { s.characters[1].behavior.hostile = true; }, "characters[1].companion"],
  ["wander radius 0", (s) => { s.characters[6].behavior.wander_radius = 0; }, "characters[6].behavior.wander_radius"],
  ["dialogue next dangling", (s) => { s.dialogues[0].nodes[0].choices[0].next = "nowhere"; }, "dialogues[0].nodes[0].choices[0].next"],
  ["dialogue entry dangling", (s) => { s.dialogues[0].entry[0].node = "nowhere"; }, "dialogues[0].entry[0].node"],
  ["five choices", (s) => { const n = s.dialogues[0].nodes[0]; while (n.choices.length < 5) n.choices.push({ text: "x", next: null }); }, "dialogues[0].nodes[0].choices"],
  ["bad action kind", (s) => { s.dialogues[0].nodes[0].choices[0].actions = [{ kind: "explode" }]; }, "dialogues[0].nodes[0].choices[0].actions[0].kind"],
  ["bad condition", (s) => { s.dialogues[0].entry[0].conditions = [{ kind: "has_item" }]; }, "dialogues[0].entry[0].conditions[0].ref"],
  ["objective_state bad value", (s) => { s.dialogues[0].entry[0].conditions = [{ kind: "objective_state", ref: "o1", value: "maybe" }]; }, "dialogues[0].entry[0].conditions[0].value"],
  ["dialogue for unknown character", (s) => { s.dialogues[0].character_ref = "ghost"; }, "dialogues[0].character_ref"],
];

for (const [name, mutate, pathPrefix] of MUTATIONS) {
  test(`schema rejects: ${name}`, () => {
    const s = fresh();
    assert.equal(s.characters[3].id, "warden_bram"); // mutations index by fixture order
    mutate(s);
    const v = validateCharacters(s, { world: SALT.world, concept: SALT.concept });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.path.startsWith(pathPrefix)), `${pathPrefix} not in ${JSON.stringify(v.errors)}`);
  });
}

// --- dialogue graph checks ----------------------------------------------------

const tinyDialogue = () => [{
  id: "dlg_a", character_ref: "a",
  entry: [{ node: "hi", conditions: [{ kind: "flag", ref: "met_a", value: true }] }, { node: "first", conditions: [] }],
  nodes: [
    { id: "first", speaker: "A", text: "Hello.", choices: [{ text: "Hi", next: "hi", actions: [{ kind: "set_flag", ref: "met_a", value: true }] }] },
    { id: "hi", speaker: "A", text: "Again.", choices: [
      { text: "Key?", next: "key", conditions: [{ kind: "has_item", ref: "item_1" }] },
      { text: "Bye", next: null },
    ] },
    { id: "key", speaker: "A", text: "Nice key.", choices: [{ text: "Here", next: null, actions: [{ kind: "remove_item", ref: "item_1", value: 1 }] }] },
  ],
}];

test("validateDialogues: unreachable nodes and exitless loops are errors", () => {
  assert.deepEqual(validateDialogues(tinyDialogue()).errors, []);
  const orphan = tinyDialogue();
  orphan[0].nodes.push({ id: "lost", speaker: "A", text: "…", choices: [{ text: "bye", next: null }] });
  const v1 = validateDialogues(orphan);
  assert.ok(v1.errors.some((e) => /unreachable/.test(e.message) && e.path === "[0].nodes[3]"), JSON.stringify(v1.errors));
  const loop = tinyDialogue();
  loop[0].nodes.push({ id: "l1", speaker: "A", text: "1", choices: [{ text: ">", next: "l2" }] },
    { id: "l2", speaker: "A", text: "2", choices: [{ text: ">", next: "l1" }] });
  loop[0].nodes[0].choices.push({ text: "loop", next: "l1" });
  const v2 = validateDialogues(loop);
  assert.ok(v2.errors.some((e) => /cannot reach an exit/.test(e.message)), JSON.stringify(v2.errors));
  const empty = tinyDialogue();
  empty[0].nodes[2].choices = [];
  assert.ok(validateDialogues(empty).errors.some((e) => e.path === "[0].nodes[2].choices"));
});

test("dialogue traversal: entries gated by flags, choices by items, actions returned", () => {
  const d = tinyDialogue();
  const gs0 = { flags: {}, inventory: {}, objectives: {} };
  const o = openDialogue(d, "a", gs0);
  assert.equal(o.dialogue_id, "dlg_a");
  assert.equal(o.node.id, "first");
  const r1 = choose(o.dialogue, o.node, 0, gs0);
  assert.equal(r1.node.id, "hi");
  assert.deepEqual(r1.actions, [{ kind: "set_flag", ref: "met_a", value: true }]);
  const gs1 = { ...gs0, flags: { met_a: true } };
  assert.equal(openDialogue(d, "a", gs1).node.id, "hi");
  // No item: the key choice is hidden and index 0 is "Bye".
  assert.deepEqual(availableChoices(r1.node, gs1).map((c) => c.text), ["Bye"]);
  assert.deepEqual(choose(d[0], "hi", 0, gs1), { node: null, actions: [] });
  const gs2 = { ...gs1, inventory: { item_1: 1 } };
  assert.deepEqual(availableChoices("hi", gs2, d[0]).map((c) => c.index), [0, 1]);
  const r2 = choose(d[0], "hi", 0, gs2);
  assert.equal(r2.node.id, "key");
  const r3 = choose(d[0], r2.node, 0, gs2);
  assert.equal(r3.node, null);
  assert.deepEqual(r3.actions, [{ kind: "remove_item", ref: "item_1", value: 1 }]);
  // A stray key press keeps the player where they are.
  const bad = choose(d[0], "hi", 3, gs1);
  assert.equal(bad.invalid, true);
  assert.equal(bad.node.id, "hi");
  assert.equal(openDialogue(d, "nobody", gs0), null);
});

test("conditions evaluate as documented", () => {
  const gs = { flags: { a: true, n: 2 }, inventory: { item_1: 2 }, objectives: { o1: "done" } };
  assert.equal(evalCondition({ kind: "flag", ref: "a", value: true }, gs), true);
  assert.equal(evalCondition({ kind: "flag", ref: "missing", value: false }, gs), true);
  assert.equal(evalCondition({ kind: "flag", ref: "n", value: 2 }, gs), true);
  assert.equal(evalCondition({ kind: "has_item", ref: "item_1", value: 3 }, gs), false);
  assert.equal(evalCondition({ kind: "has_item", ref: "item_1" }, gs), true);
  assert.equal(evalCondition({ kind: "objective_state", ref: "o1", value: "done" }, gs), true);
  assert.equal(evalCondition({ kind: "objective_state", ref: "o2", value: "locked" }, gs), true);
  assert.equal(evalCondition({ kind: "weird", ref: "x" }, gs), false);
});

test("generated quest-giver dialogue: first meet → returning → progress", () => {
  const s = fresh();
  const gs = { flags: {}, inventory: {}, objectives: {} };
  const o = openDialogue(s, "keeper_maren", gs);
  assert.equal(o.node.id, "first_meet");
  const r = choose(o.dialogue, o.node, 2, gs);
  assert.equal(r.node, null);
  assert.deepEqual(r.actions, [{ kind: "set_flag", ref: "met_keeper_maren", value: true }]);
  assert.equal(openDialogue(s, "keeper_maren", { ...gs, flags: { met_keeper_maren: true } }).node.id, "welcome_back");
  assert.equal(openDialogue(s, "keeper_maren", { ...gs, inventory: { item_2: 1 } }).node.id, "progress");
  // Walk every generated dialogue to an end by always taking the last visible choice.
  for (const d of s.dialogues) {
    let node = openDialogue(s, d.character_ref, gs).node, steps = 0;
    while (node && steps++ < 20) {
      const vis = availableChoices(node, gs);
      node = choose(d, node, vis.length - 1, gs).node;
    }
    assert.equal(node, null, `${d.id} ends`);
  }
  // Companion's "stay" choice asks the rules engine to park it.
  const comp = s.dialogues.find((d) => d.character_ref === "pip");
  const banter = comp.nodes.find((n) => n.id === "banter");
  assert.ok(banter.choices.some((c) => (c.actions || []).some((a) => a.kind === "set_npc_state" && a.ref === "pip" && a.value === "idle")));
});
