// B4 exit gate. The headline requirement is that the quality gate MUST be able
// to fail. Half of this file constructs worlds that are broken in exactly the
// ways the handoff names — trapped spawn, unreachable NPC, dead quest, bad
// collision, missing asset, impossible path, absent gameplay loop — and asserts
// that each one is REJECTED.
import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { simulatePlaythrough, simulateQuests, critique, repair, playtestAndRepair } from "../src/v3/playtest/agent.mjs";
import { runAllValidators, validateStructure, validateNavigation, validateQuests, validateGameplayLoop, validateReferences } from "../src/v3/playtest/validators.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };

async function goodWorld(prompt = "Ashfall Harbour, a rainy nordic port town", worldId = "w_good") {
  const out = await createAssemblyRouter(OFFLINE).assemble({ prompt, worldId, creatorId: "u1" });
  return out.manifest;
}

const run = (m) => {
  const walk = simulatePlaythrough(m);
  const quests = simulateQuests(m, walk);
  return { walk, quests, verdict: critique(m, { walk, quests }) };
};

const has = (v, id) => v.findings.some((f) => f.id === id);

// ------------------------------------------------------------- happy path

test("B4: a well-formed generated world passes the gate", async () => {
  const { verdict, walk, quests } = run(await goodWorld());
  assert.equal(verdict.passed, true, JSON.stringify(verdict.findings.slice(0, 5), null, 2));
  assert.equal(verdict.verdict, "PASSED");
  assert.ok(walk.coverage > 0.3, `the agent should be able to walk most of the world, got ${walk.coverage}`);
  assert.ok(quests.every((q) => q.completable), "every quest must be completable");
});

test("B4: the agent's walk is reproducible", async () => {
  const m = await goodWorld();
  const a = simulatePlaythrough(m), b = simulatePlaythrough(m);
  assert.equal(a.visited_cells, b.visited_cells);
  assert.equal(a.coverage, b.coverage);
});

// ---------------------------------------------- the gate must be able to fail

test("B4 GATE: a trapped spawn is REJECTED", async () => {
  const m = await goodWorld();
  // Wall the spawn in with structures on every side.
  const p = m.spawn.player_spawns[0].position;
  const asset = m.assets.find((a) => a.kind === "building").id;
  for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6], [5, 5], [-5, -5], [5, -5], [-5, 5]]) {
    m.structures.push({
      id: `wall_${dx}_${dz}`, zone: m.zones[0].id, asset_ref: asset,
      transform: { position: { x: p.x + dx, y: 0, z: p.z + dz }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      footprint: { w: 14, d: 14, h: 6 }, enterable: false, interactable: false, portals: [],
    });
  }
  const { verdict, walk } = run(m);
  assert.equal(verdict.passed, false, "a walled-in spawn must not ship");
  assert.equal(verdict.verdict, "REJECTED");
  assert.ok(walk.visited_cells <= 2, `the agent should be stuck, it walked ${walk.visited_cells} cells`);
  assert.ok(has(verdict, "spawn_trapped_sim") || has(verdict, "spawn_inside_structure") || has(verdict, "spawn_trapped"));
});

test("B4 GATE: a spawn placed inside a building is REJECTED", async () => {
  const m = await goodWorld();
  m.spawn.player_spawns[0].position = { ...m.structures[0].transform.position, y: 1 };
  const { verdict } = run(m);
  assert.equal(verdict.passed, false);
  assert.ok(has(verdict, "spawn_inside_structure"));
});

test("B4 GATE: an unreachable NPC is REJECTED", async () => {
  const m = await goodWorld();
  // Put the NPC on a plateau the player cannot climb.
  const npc = m.npcs[0];
  npc.spawn = { x: 5, y: 400, z: 5 };
  const rows = m.terrain.data.length, cols = m.terrain.data[0].length;
  for (let j = 0; j < Math.min(3, rows); j++) for (let i = 0; i < Math.min(3, cols); i++) m.terrain.data[j][i] = 400;
  const { verdict } = run(m);
  assert.equal(verdict.passed, false, "an NPC nobody can reach must not ship");
  assert.ok(has(verdict, "npc_unreachable"));
});

test("B4 GATE: a dead quest (step targets nothing) is REJECTED", async () => {
  const m = await goodWorld();
  m.quests[0].steps[0].target = null;
  const { verdict } = run(m);
  assert.equal(verdict.passed, false);
  assert.ok(has(verdict, "quest_step_no_target"));
  assert.ok(has(verdict, "quest_not_completable"));
});

test("B4 GATE: a quest requiring an item that exists nowhere is REJECTED", async () => {
  const m = await goodWorld();
  m.items.push({ id: "item_phantom", name: "Phantom", kind: "misc", asset_ref: m.assets[0].id });
  m.quests[0].steps.push({ id: "step_phantom", kind: "collect", target: "item_phantom", description: "Find the phantom" });
  const { verdict } = run(m);
  assert.equal(verdict.passed, false, "an unobtainable quest item must not ship");
  assert.ok(has(verdict, "quest_item_unobtainable"));
});

test("B4 GATE: a quest with no steps is REJECTED", async () => {
  const m = await goodWorld();
  m.quests.push({ id: "quest_empty", title: "Nothing", giver_npc: null, steps: [], rewards: [], prerequisites: [] });
  assert.ok(runAllValidators(m).some((f) => f.id === "quest_no_steps"));
});

test("B4 GATE: a missing asset reference is REJECTED", async () => {
  const m = await goodWorld();
  m.structures[0].asset_ref = "asset_that_does_not_exist";
  const { verdict } = run(m);
  assert.equal(verdict.passed, false);
  assert.ok(has(verdict, "missing_asset"));
});

test("B4 GATE: a solid asset with no collision is caught", async () => {
  const m = await goodWorld();
  const building = m.assets.find((a) => a.kind === "building");
  delete building.collision;
  const f = validateStructure(m);
  assert.ok(f.some((x) => x.id === "asset_no_collision"), "a solid object with no collision is walk-through");
});

test("B4 GATE: a world with no gameplay at all is REJECTED", async () => {
  const m = await goodWorld();
  m.behaviors = [];
  m.interactions = [];
  const { verdict } = run(m);
  assert.equal(verdict.passed, false, "scenery is not a game");
  assert.ok(has(verdict, "no_gameplay"));
  assert.ok(has(verdict, "no_interactions"));
});

test("B4 GATE: an impossible path — an unlinked, unwalkable zone — is caught", async () => {
  const m = await goodWorld();
  m.zones.push({ id: "zone_island", name: "Island", kind: "landmark", bounds: [1, 1, 20, 20], parent_zone: null, tags: [], ambience: null });
  m.navigation.walkable_zones.push({ zone: "zone_island", walkable_fraction: 0.0, mean_ground_y: 0 });
  const f = validateNavigation(m);
  assert.ok(f.some((x) => x.id === "zone_unreachable"), "a zone with no navigation link is unreachable");
  assert.ok(f.some((x) => x.id === "zone_not_walkable"), "a zone with nowhere to stand is not a place");
});

test("B4: a floating structure is caught", async () => {
  const m = await goodWorld();
  m.structures[0].transform.position.y = 90;
  assert.ok(validateStructure(m).some((f) => f.id === "structure_floating"));
});

test("B4: an out-of-bounds structure is a blocker", async () => {
  const m = await goodWorld();
  m.structures[0].transform.position.x = 99999;
  const f = validateStructure(m);
  const hit = f.find((x) => x.id === "structure_out_of_bounds");
  assert.ok(hit);
  assert.equal(hit.severity, "blocker");
});

test("B4: NPCs that cannot be interacted with are flagged", async () => {
  const m = await goodWorld();
  m.interactions = m.interactions.filter((i) => !m.npcs.some((n) => n.id === i.target_ref));
  assert.ok(validateGameplayLoop(m).some((f) => f.id === "npcs_not_interactive"));
});

test("B4: a behaviour nothing triggers is flagged as an orphan", async () => {
  const m = await goodWorld();
  m.behaviors.push({ id: "behavior_orphan", kind: "switch", spec: { toggles: [], starts: "off" } });
  assert.ok(validateGameplayLoop(m).some((f) => f.id === "orphan_behavior" && f.where === "behavior_orphan"));
});

// -------------------------------------------------------------------- repair

test("B4 GATE: repair fixes a broken world and the re-test then passes", async () => {
  const m = await goodWorld();
  // Three genuinely repairable defects.
  m.structures[0].transform.position.y = 80;                       // floating
  m.assets.find((a) => a.kind === "building").collision = undefined; // no collision
  m.spawn.player_spawns[0].position = { ...m.structures[1].transform.position, y: 1 }; // spawn in a wall

  const before = run(m);
  assert.equal(before.verdict.passed, false, "the broken world must fail first");

  const res = await playtestAndRepair(m);
  assert.equal(res.passed, true, `repair should have fixed this: ${JSON.stringify(res.rounds.at(-1).findings.slice(0, 4), null, 2)}`);
  assert.ok(res.rounds.length >= 2, "a repair round plus a re-test round");
  const fixes = res.rounds[0].repairs.map((r) => r.fix);
  assert.ok(fixes.includes("reseat_on_ground"));
  assert.ok(fixes.includes("add_collision"));
  assert.ok(fixes.includes("move_spawn"));
});

test("B4 GATE: repair REMOVES an uncompletable quest rather than inventing a target", async () => {
  const m = await goodWorld();
  const questCount = m.quests.length;
  m.quests[0].steps[0].target = null;
  const findings = run(m).verdict.findings.filter((f) => f.fix);
  const r = repair(m, findings);
  assert.equal(r.manifest.quests.length, questCount - 1, "the dead quest is dropped");
  const dropped = r.applied.find((a) => a.fix === "drop_quest");
  assert.ok(dropped);
  assert.match(dropped.note, /removed rather than fabricating/);
  // and nothing was conjured into existence to satisfy it
  assert.equal(r.manifest.items.length, m.items.length);
  assert.equal(r.manifest.npcs.length, m.npcs.length);
});

test("B4: repair does not silently pass a world it cannot fix", async () => {
  const m = await goodWorld();
  m.behaviors = [];
  m.interactions = [];
  m.quests = [];
  m.npcs = [];
  m.structures = [];
  const res = await playtestAndRepair(m);
  assert.equal(res.passed, false, "an empty world must not be repaired into a pass");
  assert.equal(res.verdict, "REJECTED");
});

test("B4: repair prunes interactions orphaned by its own removals", async () => {
  const m = await goodWorld();
  const orphanCount = m.interactions.length;
  m.structures[0].asset_ref = "gone";
  const findings = run(m).verdict.findings.filter((f) => f.fix);
  const r = repair(m, findings);
  const ids = new Set([...r.manifest.zones.map((z) => z.id), ...r.manifest.structures.map((s) => s.id), ...r.manifest.npcs.map((n) => n.id), ...r.manifest.items.map((i) => i.id)]);
  for (const i of r.manifest.interactions) assert.ok(ids.has(i.target_ref), `interaction ${i.id} still points at a removed entity`);
  assert.ok(r.manifest.interactions.length <= orphanCount);
});

test("B4: repair reports what it could NOT fix rather than staying silent", async () => {
  const m = await goodWorld();
  m.zones = [];
  m.structures = [];
  m.npcs = [];
  const findings = run(m).verdict.findings;
  const r = repair(m, findings);
  assert.ok(r.skipped.length > 0, "unfixable findings must be reported as skipped");
  assert.ok(r.skipped.every((s) => s.why), "every skip says why");
});

test("B4: every severity level is reachable, so the verdict is meaningful", async () => {
  const good = run(await goodWorld()).verdict;
  assert.equal(good.verdict, "PASSED");

  const notes = await goodWorld();
  notes.behaviors.push({ id: "behavior_unused", kind: "switch", spec: { starts: "off" } });
  assert.equal(run(notes).verdict.verdict, "PASSED_WITH_NOTES");

  const needsWork = await goodWorld();
  needsWork.interactions = needsWork.interactions.filter((i) => !needsWork.npcs.some((n) => n.id === i.target_ref));
  assert.equal(run(needsWork).verdict.verdict, "NEEDS_WORK");

  const rejected = await goodWorld();
  rejected.quests[0].steps[0].target = null;
  assert.equal(run(rejected).verdict.verdict, "REJECTED");
});

// -------------------------------------------- references held inside a spec
//
// A behaviour can name an entity from inside its own `spec` — the item a pickup
// grants, the key a door is locked by, the zone a teleporter aims at. Nothing
// that walks `target_ref`/`behavior_ref` sees those, and the schema validator
// does not look inside a spec either, so a world can lose the entity and still
// be pronounced valid. What the player gets is an item nothing can obtain, a
// door nothing can open, a teleporter to nowhere, and no error anywhere.

test("B4: the agent does not claim to have picked up an item that does not exist", async () => {
  const m = await goodWorld();
  const pickup = m.behaviors.find((b) => b.kind === "pickup" && b.spec?.item);
  assert.ok(pickup, "the fixture needs a pickup");
  const itemId = pickup.spec.item;

  // The item is gone; the pickup that granted it survives, still naming it.
  m.items = m.items.filter((i) => i.id !== itemId);

  const walk = simulatePlaythrough(m);
  assert.equal(walk.reached.has(itemId), false, "the walk must not report reaching an entity the world no longer contains");

  // And a quest step aimed at it is not judged completable on the strength of it.
  m.quests[0].steps[0] = { id: "step_ghost", kind: "collect", target: itemId, description: "Recover the missing thing." };
  const quests = simulateQuests(m, simulatePlaythrough(m));
  assert.equal(quests[0].completable, false);
  assert.match(quests[0].steps[0].why, new RegExp(itemId));
});

test("B4: a pickup whose item was deleted is a BLOCKER, not a valid world", async () => {
  const m = await goodWorld();
  const pickup = m.behaviors.find((b) => b.kind === "pickup" && b.spec?.item);
  const itemId = pickup.spec.item;
  m.items = m.items.filter((i) => i.id !== itemId);
  m.quests = m.quests.map((q) => ({ ...q, steps: q.steps.filter((s) => s.target !== itemId) })).filter((q) => q.steps.length);

  const findings = validateReferences(m);
  const f = findings.find((x) => x.where === pickup.id);
  assert.ok(f, "a pickup naming a deleted item must be reported");
  assert.equal(f.id, "behavior_spec_dangling");
  assert.equal(f.severity, "blocker");
  assert.equal(f.data.field, "item");
  assert.equal(f.data.ref, itemId);
  assert.match(f.message, new RegExp(itemId));

  // And it reaches the verdict, so the gate can actually fail on it.
  assert.equal(run(m).verdict.verdict, "REJECTED");
  assert.ok(has(run(m).verdict, "behavior_spec_dangling"));
});

test("B4: every spec-held reference kind is checked, not just a pickup's item", async () => {
  const m = await goodWorld();
  const zone = m.zones[0].id;
  const item = m.items[0].id;
  m.behaviors.push(
    { id: "behavior_door_ghostkey", kind: "door", spec: { opens: "inward", speed: 1, locked_by: "item_no_such_key", auto_close_s: 6 } },
    { id: "behavior_crate_ghost", kind: "container", spec: { contains: [item, "item_no_such_loot"], locked_by: null } },
    { id: "behavior_switch_ghost", kind: "switch", spec: { toggles: ["struct_no_such_gate"], starts: "off" } },
    { id: "behavior_terminal_ghost", kind: "terminal", spec: { screens: ["welcome"], unlocks: ["npc_no_such_warden"] } },
    { id: "behavior_lift_ghost", kind: "elevator", spec: { floors: [0, 6], speed: 2, call_from: [zone, "zone_no_such_floor"] } },
    { id: "behavior_portal_ghost", kind: "teleporter", spec: { to_zone: "zone_no_such_place", to_position: { x: 1, y: 0, z: 1 } } },
  );

  const byBehavior = new Map(validateReferences(m).map((f) => [f.where, f]));
  const expected = {
    behavior_door_ghostkey: ["locked_by", "item_no_such_key", "major"],
    behavior_crate_ghost: ["contains", "item_no_such_loot", "major"],
    behavior_switch_ghost: ["toggles", "struct_no_such_gate", "major"],
    behavior_terminal_ghost: ["unlocks", "npc_no_such_warden", "major"],
    behavior_lift_ghost: ["call_from", "zone_no_such_floor", "major"],
    behavior_portal_ghost: ["to_zone", "zone_no_such_place", "blocker"],
  };
  for (const [id, [field, ref, severity]] of Object.entries(expected)) {
    const f = byBehavior.get(id);
    assert.ok(f, `${id}: a dangling spec.${field} must be reported`);
    assert.equal(f.data.field, field);
    assert.equal(f.data.ref, ref);
    assert.equal(f.severity, severity, `${id}: losing spec.${field} is a ${severity}`);
  }
  // The references that DO resolve are left alone — no false positives.
  assert.equal(byBehavior.size, Object.keys(expected).length);
});

test("B4: repair scrubs a dead spec reference rather than substituting another entity", async () => {
  const m = await goodWorld();
  const door = m.behaviors.find((b) => b.kind === "door");
  door.spec.locked_by = "item_no_such_key";
  m.behaviors.push({ id: "behavior_crate_ghost", kind: "container", spec: { contains: [m.items[0].id, "item_no_such_loot"], locked_by: null } });
  m.interactions.push({ id: "interaction_crate_ghost", trigger: "interact", target_ref: m.structures[0].id, behavior_ref: "behavior_crate_ghost", params: {} });

  const r = repair(m, validateReferences(m));
  const fixedDoor = r.manifest.behaviors.find((b) => b.id === door.id);
  const fixedCrate = r.manifest.behaviors.find((b) => b.id === "behavior_crate_ghost");

  assert.equal(fixedDoor.spec.locked_by, null, "the door is simply not locked any more");
  assert.deepEqual(fixedCrate.spec.contains, [m.items[0].id], "only the dead entry goes; the real one stays");
  assert.equal(validateReferences(r.manifest).length, 0);
  // Nothing was invented to satisfy the reference.
  assert.ok(!r.manifest.items.some((i) => i.id === "item_no_such_key" || i.id === "item_no_such_loot"));
  assert.ok(r.applied.some((a) => a.fix === "scrub_spec_ref" && a.dropped === "item_no_such_key"));
});

test("B4: a pickup with no item left is dropped, not patched with an invented one", async () => {
  const m = await goodWorld();
  const pickup = m.behaviors.find((b) => b.kind === "pickup" && b.spec?.item);
  const itemId = pickup.spec.item;
  m.items = m.items.filter((i) => i.id !== itemId);
  m.quests = m.quests.map((q) => ({ ...q, steps: q.steps.filter((s) => s.target !== itemId) })).filter((q) => q.steps.length);

  const r = repair(m, validateReferences(m));
  assert.ok(!r.manifest.behaviors.some((b) => b.id === pickup.id), "the pickup goes with the item it granted");
  assert.ok(!r.manifest.items.some((i) => i.id === itemId), "and no item is invented to keep it alive");
  assert.ok(!r.manifest.interactions.some((i) => i.behavior_ref === pickup.id), "its interaction goes too");
  assert.equal(validateReferences(r.manifest).length, 0);
});

test("B4: an item held in a container is obtainable, and the walk agrees with the validators", async () => {
  const m = await goodWorld();
  // A brand new item that exists only inside a container, on a structure the
  // agent can already reach.
  const host = m.structures.find((s) => simulatePlaythrough(m).reached.has(s.id));
  assert.ok(host, "the fixture needs a reachable structure");
  m.items.push({ id: "item_strongbox_key", name: "Strongbox Key", kind: "key", asset_ref: null, stackable: false, effects: [] });
  m.behaviors.push({ id: "behavior_strongbox", kind: "container", spec: { contains: ["item_strongbox_key"], locked_by: null } });
  m.interactions.push({ id: "interaction_strongbox", trigger: "interact", target_ref: host.id, behavior_ref: "behavior_strongbox", params: { prompt: "Open" } });
  m.quests[0].steps.push({ id: "step_key", kind: "collect", target: "item_strongbox_key", description: "Take the key." });

  const walk = simulatePlaythrough(m);
  assert.equal(walk.reached.has("item_strongbox_key"), true, "an item in a reachable container is reachable");
  const quests = simulateQuests(m, walk);
  assert.equal(quests.find((q) => q.quest === m.quests[0].id).completable, true);
  assert.equal(validateReferences(m).length, 0);
});

test("B4 GATE: an NPC with dialogue but no interaction is WIRED, and a mute one is not invented for", async () => {
  // Found on the first real-provider generation against staging: the model
  // produced NPCs with dialogue and no interactions, the validator raised
  // `npcs_not_interactive` with fix `add_interactions`, and NOTHING implemented
  // that fix — so the finding was skipped and the world was rejected. The
  // offline planner always emits interactions, which is why every local run
  // passed.
  const m = await goodWorld("Saltmarsh Reach", "w_wire");
  m.interactions = (m.interactions || []).filter((i) => !m.npcs.some((n) => n.id === i.target_ref));
  m.npcs[0].dialogue = ["The tide is wrong today."];
  const mute = { id: "npc_mute", name: "Silent Watcher", zone: m.zones[0].id, dialogue: [] };
  m.npcs.push(mute);

  const r = repair(m, [{ id: "npcs_not_interactive", severity: "major", fix: "add_interactions" }]);

  const talkable = new Set((r.manifest.interactions || []).map((i) => i.target_ref));
  assert.ok(talkable.has(m.npcs[0].id), "an NPC that has something to say must become reachable");
  assert.equal(talkable.has("npc_mute"), false, "an NPC with no dialogue must NOT be given invented speech");

  const wired = r.applied.find((a) => a.fix === "add_interactions");
  assert.ok(wired, "the repair must report itself");
  assert.ok(wired.left_mute >= 1, "and must say it left the mute ones alone rather than silently dropping them");

  // The property, not a count: every NPC that HAS something to say became
  // reachable, and every NPC that has nothing to say was left exactly as it was.
  for (const n of r.manifest.npcs) {
    const hasLines = Array.isArray(n.dialogue) && n.dialogue.filter(Boolean).length > 0;
    assert.equal(talkable.has(n.id), hasLines,
      `${n.id} has dialogue=${hasLines} but interactive=${talkable.has(n.id)}`);
  }

  // The wiring must be real: the behaviour it points at has to exist.
  for (const i of r.manifest.interactions.filter((x) => x.id.startsWith("interaction_talk_"))) {
    assert.ok((r.manifest.behaviors || []).some((b) => b.id === i.behavior_ref),
      `interaction ${i.id} points at a behaviour that does not exist`);
  }
  assert.equal(runAllValidators(r.manifest).some((f) => f.id === "npcs_not_interactive"), false,
    "and the finding that prompted the repair is gone");
});
