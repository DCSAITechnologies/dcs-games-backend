// B4 exit gate. The headline requirement is that the quality gate MUST be able
// to fail. Half of this file constructs worlds that are broken in exactly the
// ways the handoff names — trapped spawn, unreachable NPC, dead quest, bad
// collision, missing asset, impossible path, absent gameplay loop — and asserts
// that each one is REJECTED.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateManifest, QUEST_STEP_KINDS } from "../src/v3/manifest/schema.mjs";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { simulatePlaythrough, simulateQuests, critique, repair, playtestAndRepair, npcHasSpeech, UNREPAIRABLE } from "../src/v3/playtest/agent.mjs";
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
  // The canonical v3 shape. `lines` is empty on every generation path; the
  // seed is what says this NPC is meant to be spoken to.
  m.npcs[0].dialogue = { seed: "The tide is wrong today.", lines: [] };
  const mute = { id: "npc_mute", name: "Silent Watcher", zone: m.zones[0].id, dialogue: { seed: null, lines: [] } };
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
    const speaks = npcHasSpeech(n);
    assert.equal(talkable.has(n.id), speaks,
      `${n.id} has speech=${speaks} but interactive=${talkable.has(n.id)}`);
  }

  // The wiring must be real: the behaviour it points at has to exist.
  for (const i of r.manifest.interactions.filter((x) => x.id.startsWith("interaction_talk_"))) {
    assert.ok((r.manifest.behaviors || []).some((b) => b.id === i.behavior_ref),
      `interaction ${i.id} points at a behaviour that does not exist`);
  }
  assert.equal(runAllValidators(r.manifest).some((f) => f.id === "npcs_not_interactive"), false,
    "and the finding that prompted the repair is gone");
});

test("B4 GATE: speech is judged by the shape real manifests actually use", () => {
  // The first version of add_interactions asked `Array.isArray(npc.dialogue)`.
  // No generated world has ever had that shape — migrate.mjs, assembly.mjs and
  // expansion/planner.mjs all build `{ seed, lines: [] }` — so every NPC in
  // every real world counted as mute, and the repair reported success while
  // wiring nothing. Reading `lines` alone is the same bug: lines are EMPTY at
  // generation time on every path, and the seed is the intent.
  assert.equal(npcHasSpeech({ dialogue: { seed: "old tides whisper", lines: [] } }), true,
    "a seed with no lines yet is still an NPC the world means you to talk to");
  assert.equal(npcHasSpeech({ dialogue: { seed: null, lines: [] } }), false, "genuinely mute");
  assert.equal(npcHasSpeech({ dialogue: { seed: "   ", lines: [] } }), false, "whitespace is not speech");
  assert.equal(npcHasSpeech({ dialogue: { seed: null, lines: ["Hello."] } }), true, "realised lines count");
  assert.equal(npcHasSpeech({ dialogue: ["Hello."] }), true, "legacy array form still loads from disk");
  assert.equal(npcHasSpeech({ dialogue: [] }), false);
  assert.equal(npcHasSpeech({}), false);
  assert.equal(npcHasSpeech(null), false);
});

test("B4 GATE: a manifest in the real generated shape is actually wired", async () => {
  // The end-to-end version of the above, against a world whose NPCs carry
  // exactly what a provider emits.
  const m = await goodWorld("Tidebound Echoes", "w_realshape");
  m.interactions = (m.interactions || []).filter((i) => !m.npcs.some((n) => n.id === i.target_ref));
  for (const n of m.npcs) n.dialogue = { seed: `${n.name || n.id} has something to say`, lines: [] };

  const r = repair(m, [{ id: "npcs_not_interactive", severity: "major", fix: "add_interactions" }]);
  const talkable = new Set((r.manifest.interactions || []).map((i) => i.target_ref));

  const applied = r.applied.find((a) => a.fix === "add_interactions");
  assert.ok(applied, "the repair must run, not skip the whole world as mute");
  assert.equal(applied.wired, m.npcs.length, "every NPC with a seed must be wired");
  assert.equal(applied.left_mute, 0);
  for (const n of m.npcs) assert.ok(talkable.has(n.id), `${n.id} was left unreachable`);
  assert.equal(runAllValidators(r.manifest).some((f) => f.id === "npcs_not_interactive"), false);
});

test("B4 GATE: every fix a validator can name is one repair() actually knows", () => {
  // The structural version of a bug that has now bitten twice on staging.
  // `npcs_not_interactive` named `add_interactions` and nothing implemented it;
  // `no_quests` named `add_quest` and nothing implemented that either. Each
  // time, the gate rejected a world while advertising a repair that could not
  // run. Nothing forced the two lists to agree, so nothing caught it until a
  // real provider produced a world the offline planner never would.
  //
  // This asserts the invariant behaviourally rather than by reading source: a
  // fix name is acceptable if repair() either performs it or declines it for a
  // DECLARED reason. What is not acceptable is falling through to "no repair
  // implemented", which is the shape of an unnoticed gap.
  const emitted = fixNamesEmittedByValidators();
  assert.ok(emitted.size > 10, `expected to find the validator fix names, got ${emitted.size}`);

  const orphans = [];
  for (const fix of emitted) {
    const r = repair(emptyish(), [{ id: "synthetic", severity: "major", fix }]);
    const skip = r.skipped.find((s) => s.fix === fix);
    if (skip && /no repair implemented for/.test(skip.why)) orphans.push(fix);
  }
  assert.deepEqual(orphans, [],
    `these findings name a fix that does not exist, so the world is rejected with a promise nothing can keep: ${orphans.join(", ")}`);
});

/** The fix names validators can put in front of a user, read from the source of truth. */
function fixNamesEmittedByValidators() {
  const src = fs.readFileSync(new URL("../src/v3/playtest/validators.mjs", import.meta.url), "utf8");
  return new Set([...src.matchAll(/fix:\s*"([a-z_]+)"/g)].map((m) => m[1]));
}

/** A minimal manifest: enough structure to be walked, empty enough to trigger anything. */
function emptyish() {
  return {
    manifest_version: "3.0.0",
    terrain: { size: { w: 64, h: 64 }, heightmap: null },
    zones: [{ id: "z0", name: "Hollow", bounds: [0, 0, 64, 64] }],
    structures: [], npcs: [], items: [], quests: [], behaviors: [], interactions: [],
    spawn: { player_spawns: [] },
    navigation: { walkable_zones: [] },
  };
}

test("B4: add_spawn puts a player on real ground when the world has no spawn", () => {
  const m = emptyish();
  m.terrain.heightmap = Array.from({ length: 32 }, () => Array(32).fill(0));
  m.structures = [{ id: "s0", name: "Hall", zone: "z0", enterable: true, transform: { position: { x: 8, y: 0, z: 8 }, scale: { x: 4, y: 4, z: 4 } } }];
  const r = repair(m, [{ id: "no_spawn", severity: "blocker", fix: "add_spawn" }]);
  const sp = r.manifest.spawn.player_spawns;
  assert.equal(sp.length, 1, "a spawn must exist");
  assert.ok(Number.isFinite(sp[0].position.x) && Number.isFinite(sp[0].position.z));
  assert.ok(r.applied.some((a) => a.fix === "add_spawn"));
  assert.equal(runAllValidators(r.manifest).some((f) => f.id === "no_spawn"), false);
});

test("B4 GATE: move_spawn on a world with no spawn does not abort the whole repair pass", () => {
  // It threw a TypeError indexing player_spawns[0], which is not one skipped
  // repair — it takes down every remaining finding with it and fails the
  // generation outright.
  const m = emptyish();
  m.terrain.heightmap = Array.from({ length: 16 }, () => Array(16).fill(0));
  const r = repair(m, [
    { id: "spawn_in_rock", severity: "blocker", fix: "move_spawn" },
    { id: "no_quests", severity: "major", fix: "add_quest" },
  ]);
  assert.ok(r.applied.length + r.skipped.length === 2, "both findings must be considered, not abandoned at the first throw");
});

test("B4: add_doors opens structures the world already calls enterable", () => {
  const m = emptyish();
  m.structures = [
    { id: "s_shrine", name: "Shrine", zone: "z0", enterable: true, transform: { position: { x: 4, y: 0, z: 4 } } },
    { id: "s_rock", name: "Boulder", zone: "z0", enterable: false, transform: { position: { x: 9, y: 0, z: 9 } } },
  ];
  const r = repair(m, [{ id: "enterable_no_door", severity: "major", fix: "add_doors" }]);
  const targets = new Set(r.manifest.interactions.map((i) => i.target_ref));
  assert.ok(targets.has("s_shrine"), "an enterable structure must get a door");
  assert.equal(targets.has("s_rock"), false, "a boulder must not");
  for (const i of r.manifest.interactions) {
    assert.ok(r.manifest.behaviors.some((b) => b.id === i.behavior_ref), "every door must point at a behaviour that exists");
  }
});

test("B4: add_behaviors derives a game from the cast that already exists", () => {
  const m = emptyish();
  m.npcs = [{ id: "n1", name: "Warden", zone: "z0", dialogue: { seed: "who goes there", lines: [] } }];
  m.items = [{ id: "i1", name: "Lantern" }];
  m.structures = [{ id: "s1", name: "Keep", zone: "z0", enterable: true, transform: { position: { x: 5, y: 0, z: 5 } } }];
  const r = repair(m, [{ id: "no_gameplay", severity: "blocker", fix: "add_behaviors" }]);
  const kinds = new Set(r.manifest.behaviors.map((b) => b.kind));
  assert.deepEqual([...kinds].sort(), ["door", "npc_ai", "pickup"]);
  assert.equal(runAllValidators(r.manifest).some((f) => f.id === "no_gameplay"), false);
});

test("B4 GATE: add_behaviors refuses to invent a game out of an empty world", () => {
  const r = repair(emptyish(), [{ id: "no_gameplay", severity: "blocker", fix: "add_behaviors" }]);
  assert.equal(r.applied.some((a) => a.fix === "add_behaviors"), false);
  const s = r.skipped.find((x) => x.fix === "add_behaviors");
  assert.match(s.why, /cannot be invented from an empty world/);
});

test("B4: add_quest builds an objective only out of things that exist", () => {
  const m = emptyish();
  m.zones = [
    { id: "z0", name: "Hollow", bounds: [0, 0, 32, 32] },
    { id: "z1", name: "Ridge", bounds: [32, 0, 64, 32] },
  ];
  const r = repair(m, [{ id: "no_quests", severity: "major", fix: "add_quest" }]);
  const q = r.manifest.quests[0];
  assert.ok(q, "a quest must be added");
  assert.ok(q.steps.length >= 2);
  const ids = new Set([...m.zones.map((z) => z.id)]);
  for (const st of q.steps) assert.ok(ids.has(st.target), `step ${st.id} points at ${st.target}, which does not exist`);
  assert.equal(runAllValidators(r.manifest).some((f) => f.id === "no_quests"), false);
});

test("B4: add_quest prefers a delivery when there is an item and someone to speak to", () => {
  const m = emptyish();
  m.npcs = [{ id: "n1", name: "Ferrier", zone: "z0", dialogue: { seed: "the tide took it", lines: [] } }];
  m.items = [{ id: "i1", name: "Bell Clapper" }];
  const r = repair(m, [{ id: "no_quests", severity: "major", fix: "add_quest" }]);
  const q = r.manifest.quests[0];
  assert.equal(q.giver_npc, "n1");
  assert.deepEqual(q.steps.map((s) => s.target), ["i1", "n1"]);
});

test("B4 GATE: add_quest declines rather than inventing steps for an empty world", () => {
  const m = emptyish();
  m.zones = [{ id: "z0", name: "Hollow", bounds: [0, 0, 64, 64] }];
  const r = repair(m, [{ id: "no_quests", severity: "major", fix: "add_quest" }]);
  assert.equal(r.manifest.quests.length, 0, "a quest whose steps reference nothing is worse than no quest");
  assert.match(r.skipped.find((s) => s.fix === "add_quest").why, /nothing to build an objective from/);
});

test("B4: reassign_giver prefers an NPC on the quest's own ground", () => {
  const m = emptyish();
  m.zones = [{ id: "z0", name: "Hollow", bounds: [0, 0, 32, 32] }, { id: "z1", name: "Ridge", bounds: [32, 0, 64, 32] }];
  m.npcs = [
    { id: "n_far", name: "Stranger", zone: "z1", dialogue: { seed: "hm", lines: [] } },
    { id: "n_near", name: "Local", zone: "z0", dialogue: { seed: "aye", lines: [] } },
  ];
  m.quests = [{ id: "q1", title: "Look Around", giver_npc: "n_ghost", zone: null, difficulty: "easy", steps: [{ id: "s1", kind: "reach", target: "z0", description: "Go." }], rewards: [], prerequisites: [] }];
  const r = repair(m, [{ id: "quest_giver_missing", severity: "major", where: "q1", fix: "reassign_giver" }]);
  assert.equal(r.manifest.quests[0].giver_npc, "n_near");
});

test("B4 GATE: reassign_giver clears the giver rather than attaching a stranger", () => {
  const m = emptyish();
  m.zones = [{ id: "z0", name: "Hollow", bounds: [0, 0, 32, 32] }, { id: "z1", name: "Ridge", bounds: [32, 0, 64, 32] }];
  m.npcs = [{ id: "n_far", name: "Stranger", zone: "z1", dialogue: { seed: "hm", lines: [] } }];
  m.quests = [{ id: "q1", title: "Look Around", giver_npc: "n_ghost", zone: null, difficulty: "easy", steps: [{ id: "s1", kind: "reach", target: "z0", description: "Go." }], rewards: [], prerequisites: [] }];
  const r = repair(m, [{ id: "quest_giver_missing", severity: "major", where: "q1", fix: "reassign_giver" }]);
  assert.equal(r.manifest.quests[0].giver_npc, null, "an unrelated NPC across the map is not a fix");
  assert.equal(runAllValidators(r.manifest).some((f) => f.id === "quest_giver_missing"), false);
});

test("B4: flatten_zone actually changes the terrain the runtime walks on", () => {
  const m = emptyish();
  m.terrain = { size: { w: 64, h: 64 }, heightmap: Array.from({ length: 32 }, (_, r) => Array.from({ length: 32 }, (_, c) => (c < 16 ? 0 : 40))) };
  m.zones = [{ id: "z0", name: "Cliffside", bounds: [0, 0, 64, 64] }];
  const before = m.terrain.heightmap.map((r) => [...r]);
  const r = repair(m, [{ id: "zone_not_walkable", severity: "major", where: "z0", fix: "flatten_zone", data: { zone: "z0", walkable_fraction: 0.05 } }]);
  const after = r.manifest.terrain.heightmap;
  const spreadOf = (h) => { const f = h.flat(); return Math.max(...f) - Math.min(...f); };
  assert.ok(spreadOf(after) < spreadOf(before), "the ground must actually become more level");
  assert.ok(spreadOf(after) > 0, "but not a billiard table, which reads as broken terrain");
  assert.ok(r.applied.some((a) => a.fix === "flatten_zone" && a.cells > 0));
});

test("B4 GATE: fabricating characters and buildings is a DECLARED refusal, not an oversight", () => {
  // These two are the cases where a repair would have to author the world's
  // actual content. Passing the gate by inventing them would make the world
  // pass while staying empty, which is the exact failure the gate exists to
  // prevent. The rejection is correct; what matters is that it is a decision on
  // the record, so the structural test above can tell it apart from a hole.
  for (const fix of ["add_npcs", "add_structures"]) {
    const r = repair(emptyish(), [{ id: "x", severity: "major", fix }]);
    const s = r.skipped.find((x) => x.fix === fix);
    assert.equal(s.declined, true, `${fix} must be a declared refusal`);
    assert.ok(s.why.length > 40, "and must say why in terms a person can act on");
  }
  assert.deepEqual(Object.keys(UNREPAIRABLE).sort(), ["add_npcs", "add_structures"]);
});

test("B4 GATE: a world is not failed for the consequences of its own correct repairs", async () => {
  // The sequence staging produced: two quests were uncompletable, drop_quest
  // correctly removed both rather than inventing targets for them, and the
  // world was then rejected for `no_quests` — a finding add_quest handles and
  // never got a chance to, because two rounds is exactly one repair
  // opportunity. The repair pass was failing worlds for doing the right thing.
  const m = await goodWorld("Bellreach", "w_cascade");
  m.quests = [{
    id: "q_broken", title: "Find the Bell", giver_npc: m.npcs[0].id, zone: null, difficulty: "easy",
    steps: [{ id: "s1", kind: "collect", target: "item_that_does_not_exist", description: "Find it." }],
    rewards: [], prerequisites: [],
  }];

  const g = await playtestAndRepair(m);
  const dropped = g.rounds.flatMap((r) => r.repairs || []).some((a) => a.fix === "drop_quest");
  assert.ok(dropped, "the uncompletable quest must still be dropped, not patched with an invented target");
  assert.ok(g.passed, `the world must then be repaired to passing, got ${g.verdict}: ` +
    JSON.stringify(g.rounds.at(-1).findings.map((f) => f.id)));
  assert.ok(g.manifest.quests.length > 0, "and it must end with something to do");
  for (const q of g.manifest.quests) {
    for (const st of q.steps) {
      const exists = [...g.manifest.zones, ...g.manifest.structures, ...g.manifest.npcs, ...(g.manifest.items || [])]
        .some((e) => e.id === st.target);
      assert.ok(exists, `replacement quest step points at ${st.target}, which does not exist`);
    }
  }
});

test("B4: the repair loop stops as soon as a round changes nothing", async () => {
  // The extra round must cost nothing on worlds that cannot be helped.
  const m = emptyish();
  const g = await playtestAndRepair(m);
  assert.equal(g.passed, false);
  assert.match(g.note || "", /no repair could be applied/);
  assert.ok(g.rounds.length <= 2, `should not keep re-validating an unchanged manifest, ran ${g.rounds.length} rounds`);
});

test("B4 GATE: no repair may produce a manifest the schema rejects", async () => {
  // The third instance of one class of bug: add_quest was written against a
  // remembered shape rather than the schema, and emitted `name`/`target_ref`/
  // kind "visit" where WorldManifestV3 requires `title`/`target` and a kind
  // from QUEST_STEP_KINDS. A repair that emits an invalid manifest is worse
  // than the finding it fixes — it fails the whole generation on a schema
  // error instead of one missing quest.
  //
  // So: run every fix over a REAL assembled world and validate the result.
  const base = await goodWorld("Schema Probe", "w_schema");
  const emitted = fixNamesEmittedByValidators();
  const broke = [];
  for (const fix of emitted) {
    const m = structuredClone(base);
    // Give each fix something plausible to act on.
    const where = m.structures?.[0]?.id || m.zones?.[0]?.id;
    const r = repair(m, [{ id: "synthetic", severity: "major", fix, where, data: { other: m.structures?.[1]?.id } }]);
    const v = validateManifest(r.manifest);
    if (!v.ok) broke.push(`${fix}: ${(v.errors || []).slice(0, 2).map((e) => `${e.path} ${e.message}`).join("; ")}`);
  }
  assert.deepEqual(broke, [], `these repairs emit a manifest the schema rejects:\n  ${broke.join("\n  ")}`);
});

test("B4 GATE: an added quest satisfies the schema on a world that has none", async () => {
  const m = await goodWorld("Quest Probe", "w_quest");
  m.quests = [];
  const r = repair(m, [{ id: "no_quests", severity: "major", fix: "add_quest" }]);
  assert.equal(r.manifest.quests.length, 1);
  const v = validateManifest(r.manifest);
  assert.ok(v.ok, `the added quest must be schema-valid: ${JSON.stringify((v.errors || []).slice(0, 3))}`);
  const q = r.manifest.quests[0];
  assert.ok(typeof q.title === "string" && q.title.length > 0, "the schema requires `title`, not `name`");
  for (const st of q.steps) {
    assert.ok(typeof st.target === "string", "the schema requires `target`, not `target_ref`");
    assert.ok(QUEST_STEP_KINDS.includes(st.kind), `${st.kind} is not a real step kind`);
  }
});

test("B4 GATE: removing an entity does not leave quests pointing at it", async () => {
  // drop_or_substitute removed a structure and left quest steps aimed at it.
  // A dangling reference fails WorldManifestV3, which turns a world the gate
  // could have repaired into a hard generation failure — strictly worse than
  // the finding it was fixing.
  const m = await goodWorld("Orphan Probe", "w_orphan");
  const victim = m.structures[0].id;
  m.quests = [{
    id: "q_points_at_victim", title: "Visit the Doomed Hall", giver_npc: null, zone: null, difficulty: "easy",
    steps: [
      { id: "s_a", kind: "reach", target: victim, description: "Go there." },
      { id: "s_b", kind: "reach", target: m.zones[0].id, description: "Then here." },
    ],
    rewards: [], prerequisites: [],
  }];
  const r = repair(m, [{ id: "asset_missing", severity: "blocker", where: victim, fix: "drop_or_substitute" }]);

  assert.equal(r.manifest.structures.some((s) => s.id === victim), false, "the broken entity is still removed");
  const v = validateManifest(r.manifest);
  assert.ok(v.ok, `the manifest must stay valid: ${JSON.stringify((v.errors || []).slice(0, 3))}`);
  const q = r.manifest.quests.find((x) => x.id === "q_points_at_victim");
  assert.ok(q, "a quest that still has a reachable step survives");
  assert.deepEqual(q.steps.map((s) => s.target), [m.zones[0].id]);
  assert.ok(r.applied.some((a) => a.fix === "prune_dangling_quest_steps"));
});

test("B4: a quest left with no reachable steps is removed, not patched", async () => {
  const m = await goodWorld("Orphan Probe 2", "w_orphan2");
  const victim = m.structures[0].id;
  m.quests = [{
    id: "q_only_victim", title: "Visit the Doomed Hall", giver_npc: null, zone: null, difficulty: "easy",
    steps: [{ id: "s_a", kind: "reach", target: victim, description: "Go there." }],
    rewards: [], prerequisites: [],
  }];
  const r = repair(m, [{ id: "asset_missing", severity: "blocker", where: victim, fix: "drop_or_substitute" }]);
  assert.equal(r.manifest.quests.some((q) => q.id === "q_only_victim"), false);
  assert.ok(r.applied.some((a) => a.fix === "drop_emptied_quests" && a.quests.includes("q_only_victim")));
  assert.ok(validateManifest(r.manifest).ok);
});

test("B4 GATE: a malformed overlap finding does not write NaN into the world", () => {
  // (needed - distance) with neither present is NaN, which propagated into the
  // structure's position and then crashed heightAt with data[NaN][NaN] —
  // aborting the whole repair pass from deep inside, far from the cause.
  const m = emptyish();
  m.terrain = { kind: "heightmap", size: { w: 64, h: 64 }, data: Array.from({ length: 16 }, () => Array(16).fill(0)) };
  m.structures = [
    { id: "a", name: "A", zone: "z0", transform: { position: { x: 10, y: 0, z: 10 } } },
    { id: "b", name: "B", zone: "z0", transform: { position: { x: 12, y: 0, z: 12 } } },
  ];
  const r = repair(m, [{ id: "structures_overlap", severity: "minor", where: "a", fix: "separate", data: { other: "b" } }]);
  for (const s of r.manifest.structures) {
    for (const axis of ["x", "y", "z"]) {
      assert.ok(Number.isFinite(s.transform.position[axis]), `${s.id}.${axis} became ${s.transform.position[axis]}`);
    }
  }
  assert.match(r.skipped.find((x) => x.fix === "separate").why, /no measurements/);
});

test("B4: heightAt degrades on nonsense input instead of throwing", async () => {
  const { heightAt } = await import("../src/v3/playtest/validators.mjs");
  const t = { kind: "heightmap", size: { w: 64, h: 64 }, data: [[1, 2], [3, 4]] };
  assert.equal(heightAt(t, NaN, 0), 0);
  assert.equal(heightAt(t, 0, Infinity), 0);
  assert.equal(heightAt(t, 1e9, 1e9), 4, "far out of bounds still clamps to the edge");
  assert.equal(heightAt(null, 0, 0), 0);
});
