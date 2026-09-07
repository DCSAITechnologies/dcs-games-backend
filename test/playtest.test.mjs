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
import { runAllValidators, validateStructure, validateNavigation, validateQuests, validateGameplayLoop, validateReferences, heightAt } from "../src/v3/playtest/validators.mjs";

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
  // A spawn, because a quest is only an objective if somebody can start it. The
  // fixture used to have none, so the walk reached nothing and the quest it
  // asserted would have been uncompletable the moment it was written.
  m.spawn = { player_spawns: [{ id: "sp", position: { x: 4, y: 0, z: 4 }, zone: "z0" }] };
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
  m.spawn = { player_spawns: [{ id: "sp", position: { x: 8, y: 0, z: 8 }, zone: "z0" }] };
  m.npcs = [{ id: "n1", name: "Ferrier", zone: "z0", spawn: { x: 12, y: 0, z: 12 }, dialogue: { seed: "the tide took it", lines: [] } }];
  m.items = [{ id: "i1", name: "Bell Clapper" }];
  // An item is only a collect target if something in the world hands it over.
  // The fixture used to have a bare item and no way to obtain it, which is the
  // other blocker a collect step can raise — `quest_item_unobtainable`.
  m.structures = [{ id: "s1", name: "Boathouse", zone: "z0", transform: { position: { x: 16, y: 0, z: 16 } }, footprint: { w: 6, d: 6, h: 4 } }];
  m.behaviors = [{ id: "b_pickup_i1", kind: "pickup", spec: { item: "i1" } }];
  m.interactions = [{ id: "x_pickup_i1", trigger: "proximity", target_ref: "s1", behavior_ref: "b_pickup_i1" }];

  const r = repair(m, [{ id: "no_quests", severity: "major", fix: "add_quest" }]);
  const q = r.manifest.quests[0];
  assert.equal(q.giver_npc, "n1");
  assert.deepEqual(q.steps.map((s) => s.target), ["i1", "n1"]);

  // And the quest it built is one the agent can actually finish.
  const walk = simulatePlaythrough(r.manifest);
  assert.ok(simulateQuests(r.manifest, walk).every((x) => x.completable),
    "add_quest must not write a quest that fails simulateQuests the moment it exists");
});

test("B4 GATE: add_quest declines rather than inventing steps for an empty world", () => {
  const m = emptyish();
  m.zones = [{ id: "z0", name: "Hollow", bounds: [0, 0, 64, 64] }];
  m.spawn = { player_spawns: [{ id: "sp", position: { x: 8, y: 0, z: 8 }, zone: "z0" }] };
  const r = repair(m, [{ id: "no_quests", severity: "major", fix: "add_quest" }]);
  assert.equal(r.manifest.quests.length, 0, "a quest whose steps reference nothing is worse than no quest");
  assert.match(r.skipped.find((s) => s.fix === "add_quest").why, /nothing REACHABLE to build an objective from/);
});

test("B4 GATE: add_quest declines when the world exists but none of it can be reached", () => {
  // The distinction the previous test cannot make. There is plenty here to
  // build a quest out of — it is simply all on the far side of a wall.
  const m = emptyish();
  m.terrain = { kind: "heightmap", size: { w: 128, h: 64 }, data: Array.from({ length: 32 }, (_, r) => Array.from({ length: 64 }, (_, c) => (c > 20 && c < 26 ? 90 : 0))) };
  m.zones = [
    { id: "z_home", name: "Home", bounds: [0, 0, 40, 64] },
    { id: "z_far", name: "Far Side", bounds: [60, 0, 128, 64] },
  ];
  m.spawn = { player_spawns: [{ id: "sp", position: { x: 8, y: 0, z: 8 }, zone: "z_home" }] };
  m.npcs = [{ id: "n_far", name: "Hermit", zone: "z_far", spawn: { x: 100, y: 0, z: 30 }, dialogue: { seed: "hello", lines: [] } }];
  m.items = [{ id: "i_far", name: "Relic" }];

  const r = repair(m, [{ id: "no_quests", severity: "major", fix: "add_quest" }]);
  assert.equal(r.manifest.quests.length, 0, "a quest aimed at the unreachable side of a wall can never be completed");
  const why = r.skipped.find((s) => s.fix === "add_quest").why;
  assert.match(why, /nothing REACHABLE/, why);
});

test("B4 GATE: the quest add_quest writes is completable the moment it is written", async () => {
  // The staging failure this closes, in its own words: a real generation was
  // refused 422 with `quest_not_completable` naming `quest_recovered_delivery`
  // — the quest this repair invents. It fixed `no_quests`, a MAJOR, and the
  // quest it added raised a BLOCKER. The repair pass was manufacturing the
  // finding that rejected the world.
  //
  // Existing was never enough: `simulateQuests` judges a step by
  // `walk.reached.has(target)`, so an item in a zone the walk never enters is
  // uncompletable from the instant the quest names it.
  const failures = [];
  for (const prompt of [
    "A quarry town where the stone remembers who cut it.",
    "Ashfall Harbour, a rainy nordic port town",
    "a neon cyberpunk megacity",
    "a lush jungle temple complex",
    "a desert canyon outpost under a red sun",
  ]) {
    for (let seed = 0; seed < 4; seed++) {
      const m = await goodWorld(prompt, "w_addquest");
      m.meta.seed = seed;
      m.quests = [];
      const r = repair(m, [{ id: "no_quests", severity: "major", fix: "add_quest" }]);
      if (!r.manifest.quests.length) continue;            // declining is always allowed
      const walk = simulatePlaythrough(r.manifest);
      for (const q of simulateQuests(r.manifest, walk)) {
        if (!q.completable) failures.push(`${prompt} #${seed}: ${q.quest} — ${q.steps.filter((x) => !x.ok).map((x) => x.why).join("; ")}`);
      }
      // And the world must not come out with a blocker it did not go in with.
      const blockers = critique(r.manifest, { walk, quests: simulateQuests(r.manifest, walk) })
        .findings.filter((f) => f.severity === "blocker").map((f) => f.id);
      if (blockers.length) failures.push(`${prompt} #${seed}: adding a quest raised ${blockers.join(", ")}`);
    }
  }
  assert.deepEqual(failures, [], `add_quest wrote quests that cannot be completed:\n  ${failures.join("\n  ")}`);
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
  // The grid is `terrain.data`. This fixture used to say `terrain.heightmap`,
  // which no manifest anywhere has ever had, so the test and the repair agreed
  // with each other about a world that does not exist while the repair skipped
  // on every real one. `heightmap` is the terrain KIND; `data` is the field.
  const m = emptyish();
  m.terrain = {
    kind: "heightmap", size: { w: 64, h: 64 },
    data: Array.from({ length: 32 }, () => Array.from({ length: 32 }, (_, c) => (c < 16 ? 0 : 40))),
  };
  m.zones = [{ id: "z0", name: "Cliffside", bounds: [0, 0, 64, 64] }];
  const before = m.terrain.data.map((r) => [...r]);
  const r = repair(m, [{ id: "zone_not_walkable", severity: "major", where: "z0", fix: "flatten_zone", data: { zone: "z0", walkable_fraction: 0.05 } }]);
  const after = r.manifest.terrain.data;
  const spreadOf = (h) => { const f = h.flat(); return Math.max(...f) - Math.min(...f); };
  assert.ok(spreadOf(after) < spreadOf(before), "the ground must actually become more level");
  assert.ok(spreadOf(after) > 0, "but not a billiard table, which reads as broken terrain");
  assert.ok(r.applied.some((a) => a.fix === "flatten_zone" && a.cells > 0));
});

test("B4 GATE: flatten_zone fires on a REAL generated world, not only on a fixture", async () => {
  // The assertion the hand-built fixture could not make. A repair that only
  // works on a shape the generator never produces is a repair that never runs:
  // `zone_not_walkable` survived every round and the world was REJECTED for a
  // finding the gate believed it had a fix for.
  const m = await goodWorld("a desert canyon outpost under a red sun", "w_flat");
  assert.equal(m.terrain.kind, "heightmap", "this probe needs a world with real ground");
  assert.ok(Array.isArray(m.terrain.data) && m.terrain.data.length, "the grid is `terrain.data`");
  assert.equal(m.terrain.heightmap, undefined, "there is no `terrain.heightmap`, and never was");

  const z = m.zones[0];
  // Measure through heightAt — the same sampler the walk simulation uses, so
  // this asserts the ground the PLAYER stands on changed, not just an array.
  const spread = (mm) => {
    const ys = [];
    for (let x = z.bounds[0]; x < z.bounds[2]; x += 4) for (let zz = z.bounds[1]; zz < z.bounds[3]; zz += 4) ys.push(heightAt(mm.terrain, x, zz));
    return Math.max(...ys) - Math.min(...ys);
  };
  const before = spread(m);
  assert.ok(before > 1, `the probe zone needs real relief to level, got ${before}`);

  m.navigation.walkable_zones = [{ zone: z.id, walkable_fraction: 0.02 }];
  const r = repair(m, [{ id: "zone_not_walkable", severity: "major", where: z.id, fix: "flatten_zone", data: { zone: z.id, walkable_fraction: 0.02 } }]);

  const skipped = r.skipped.find((x) => x.fix === "flatten_zone");
  assert.equal(skipped, undefined, `flatten_zone declined a world it can fix: ${skipped?.why}`);
  const done = r.applied.find((a) => a.fix === "flatten_zone");
  assert.ok(done && done.cells > 0, `flatten_zone reported no work: ${JSON.stringify(r.applied)}`);
  assert.ok(spread(r.manifest) < before, `the walkable ground must actually level: ${before} -> ${spread(r.manifest)}`);
});

test("B4 GATE: a world failed only for unwalkable ground is repaired, not rejected", async () => {
  // The whole consequence, end to end: this is the false rejection the field
  // name caused.
  const m = await goodWorld("a desert canyon outpost under a red sun", "w_flat2");
  m.navigation.walkable_zones = m.zones.map((z) => ({ zone: z.id, walkable_fraction: 0.02 }));
  const out = await playtestAndRepair(m);
  assert.equal(out.passed, true, `verdict ${out.verdict}, remaining: ${JSON.stringify((out.rounds.at(-1).findings || []).filter((f) => f.severity !== "minor" && f.severity !== "info").map((f) => f.id))}`);
  assert.ok(out.repairs.some((r) => r.fix === "flatten_zone"), `it must have been the terrain pass that saved it: ${JSON.stringify(out.repairs.map((r) => r.fix))}`);
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

test("B4 GATE: link_zone connects an orphan cluster to the spawn, not to itself", async () => {
  // The repair used to link each unreachable zone to its NEAREST zone. When
  // several zones are orphaned together — the usual case, since a cluster is
  // orphaned as a cluster — the nearest zone is another orphan, so the repair
  // wired orphans to each other and never to the spawn. It reported success
  // every round, the loop counted that as progress, and the world was rejected
  // anyway. Staging applied the identical three links in rounds 1 and 2.
  const m = emptyish();
  m.terrain = { kind: "heightmap", size: { w: 400, h: 100 }, data: Array.from({ length: 16 }, () => Array(64).fill(0)) };
  m.zones = [
    { id: "z_spawn", name: "Home", bounds: [0, 0, 50, 100] },
    { id: "z_a", name: "Far A", bounds: [200, 0, 250, 100] },
    { id: "z_b", name: "Far B", bounds: [260, 0, 310, 100] },
    { id: "z_c", name: "Far C", bounds: [320, 0, 370, 100] },
  ];
  m.spawn = { player_spawns: [{ id: "sp", position: { x: 25, y: 0, z: 50 }, zone: "z_spawn" }] };
  m.navigation = { links: [], walkable_zones: [] };

  // The orphans are far from home and close to each other — precisely the
  // arrangement that made "nearest" the wrong answer.
  const orphans = ["z_a", "z_b", "z_c"].map((id) => ({ id: "zone_unreachable", severity: "major", where: id, fix: "link_zone" }));
  const r = repair(m, orphans);

  const adj = new Map(r.manifest.zones.map((z) => [z.id, new Set()]));
  for (const l of r.manifest.navigation.links) { adj.get(l.from)?.add(l.to); adj.get(l.to)?.add(l.from); }
  const seen = new Set(["z_spawn"]); const q = ["z_spawn"];
  while (q.length) for (const n of adj.get(q.shift()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }

  for (const z of m.zones) {
    assert.ok(seen.has(z.id), `${z.id} is still unreachable from the spawn after the repair claimed to link it`);
  }
});

test("B4: link_zone does not pile up duplicate links round after round", () => {
  const m = emptyish();
  m.zones = [
    { id: "z_spawn", name: "Home", bounds: [0, 0, 50, 50] },
    { id: "z_a", name: "A", bounds: [60, 0, 110, 50] },
  ];
  m.spawn = { player_spawns: [{ id: "sp", position: { x: 25, y: 0, z: 25 }, zone: "z_spawn" }] };
  const first = repair(m, [{ id: "zone_unreachable", severity: "major", where: "z_a", fix: "link_zone" }]);
  assert.equal(first.manifest.navigation.links.length, 1);

  const second = repair(first.manifest, [{ id: "zone_unreachable", severity: "major", where: "z_a", fix: "link_zone" }]);
  assert.equal(second.manifest.navigation.links.length, 1, "a second pass must not append the same link again");
  assert.match(second.skipped.find((s) => s.fix === "link_zone").why, /already reachable/);
});

// ------------------------------------------- the behaviour an NPC owns is not an orphan

test("B4 GATE: a behaviour its NPC drives is not reported as an orphan", async () => {
  // `orphan_behavior` counted only `interactions[].behavior_ref`. But the
  // assembler also attaches a behaviour directly to its NPC — assembly.mjs
  // writes `npc.behavior_ref` "so the runtime does not have to search" — and
  // the NPC runs it with or without a trigger pointing at it. Under the narrow
  // definition, dropping the interactions turned every NPC behaviour in the
  // world into an orphan.
  const m = await goodWorld("Orphan Probe", "w_orphan");
  const owner = m.npcs.find((n) => n.behavior_ref);
  assert.ok(owner, "the assembler is expected to attach a behaviour to at least one NPC");

  m.interactions = [];
  const orphans = validateGameplayLoop(m).filter((f) => f.id === "orphan_behavior").map((f) => f.where);
  assert.ok(!orphans.includes(owner.behavior_ref),
    `'${owner.behavior_ref}' is driven by NPC '${owner.id}', so nothing may call it untriggered`);
});

test("B4 GATE: dropping behaviours never leaves an NPC pointing at one that is gone", async () => {
  // The failure this closes: a MINOR finding (`orphan_behavior`) was escalated
  // by the repair pass into a schema BLOCKER. `wire_or_drop` deleted the
  // behaviour, `npc.behavior_ref` was left naming it, and validateManifest then
  // rejected a manifest that had been perfectly valid when it arrived. A 300-
  // trial damage sweep hit it twelve times, always through the same door:
  // clear the interactions and every NPC behaviour looks unused.
  const m = await goodWorld("Drop Probe", "w_drop");
  const owner = m.npcs.find((n) => n.behavior_ref);
  assert.ok(owner, "the assembler is expected to attach a behaviour to at least one NPC");
  assert.ok(validateManifest(m).ok, "the probe world must start valid or it proves nothing");

  // Ask for the drop directly, so the test holds even if the validator stops
  // raising the finding for this shape.
  const r = repair(m, [{ id: "orphan_behavior", severity: "minor", where: owner.behavior_ref, fix: "wire_or_drop" }]);
  const v = validateManifest(r.manifest);
  assert.ok(v.ok, `repair turned a valid world invalid: ${JSON.stringify((v.errors || []).slice(0, 3))}`);

  const after = r.manifest.npcs.find((n) => n.id === owner.id);
  const ids = new Set(r.manifest.behaviors.map((b) => b.id));
  assert.ok(!after.behavior_ref || ids.has(after.behavior_ref),
    "an NPC may hold no behaviour, but never a reference to one that does not exist");
});

test("B4 GATE: a valid world stays valid through a full repair pass, however it is damaged", async () => {
  // A property, not a case. The single sharpest invariant the repair pass has:
  // whatever it does to a world that arrived schema-valid, the world it hands
  // back is still schema-valid. Anything else converts a finding the gate could
  // report into a hard generation failure somewhere downstream.
  const damages = [
    ["interactions cleared", (m) => { m.interactions = []; }],
    ["behaviours cleared", (m) => { m.behaviors = []; }],
    ["quests cleared", (m) => { m.quests = []; }],
    ["navigation links cleared", (m) => { m.navigation.links = []; }],
    ["spawn removed", (m) => { m.spawn.player_spawns = []; }],
    ["spawn out of bounds", (m) => { const p = m.spawn.player_spawns[0].position; p.x = m.terrain.size.w + 500; p.z = -400; }],
    ["structures floated", (m) => { for (const s of m.structures) s.transform.position.y += 40; }],
    ["structures stacked", (m) => { if (m.structures.length > 1) m.structures[1].transform.position = { ...m.structures[0].transform.position }; }],
    ["collision stripped", (m) => { for (const a of m.assets) delete a.collision; }],
    ["every NPC muted", (m) => { for (const n of m.npcs) n.dialogue = { seed: "", lines: [] }; }],
    ["an NPC placed in no zone", (m) => { if (m.npcs.length) m.npcs[0].zone = null; }],
    ["a zone starved of walkable ground", (m) => { m.navigation.walkable_zones = [{ zone: m.zones[0].id, walkable_fraction: 0.02 }]; }],
    ["a pickup for an item nobody has", (m) => { m.behaviors.push({ id: "behavior_pickup_ghost", kind: "pickup", spec: { item: "ghost_item" } }); }],
    ["a door locked by a key nobody has", (m) => { m.behaviors.push({ id: "behavior_door_ghost", kind: "door", spec: { locked_by: "ghost_key" } }); }],
  ];

  const failures = [];
  for (const prompt of ["Ashfall Harbour, a rainy nordic port town", "a neon cyberpunk megacity", "a lush jungle temple complex"]) {
    const base = await goodWorld(prompt, "w_prop");
    assert.ok(validateManifest(base).ok, `${prompt} did not assemble into a valid world`);
    for (const [label, damage] of damages) {
      const m = structuredClone(base);
      damage(m);
      if (!validateManifest(m).ok) continue;   // the damage itself broke the schema; not this invariant's business
      const out = await playtestAndRepair(m);
      const v = validateManifest(out.manifest);
      if (!v.ok) failures.push(`${prompt} / ${label}: ${(v.errors || []).slice(0, 2).map((e) => `${e.path} ${e.message}`).join("; ")}`);
    }
  }
  assert.deepEqual(failures, [], `repair produced a manifest the schema rejects:\n  ${failures.join("\n  ")}`);
});

// ------------------------------------------------ interaction ids are unique

test("B4 GATE: a repair never gives two interactions the same id", async () => {
  // Found on a HEALTHY generated world, not a damaged one. The planner hosts a
  // pickup on the structure the item is found in, so the item's own id is not
  // in the repair's `wired` set; `add_behaviors` wired it a second time and
  // named the interaction `interaction_pickup_<item>` — an id the planner had
  // already used. Five collisions in a five-item world, and the schema let it
  // through because interactions were the one id-bearing collection it did not
  // check for duplicates.
  const emitted = fixNamesEmittedByValidators();
  const collisions = [];
  for (const prompt of ["Ashfall Harbour, a rainy nordic port town", "a neon cyberpunk megacity", "a lush jungle temple complex"]) {
    const base = await goodWorld(prompt, "w_dupint");
    // Every wiring repair at once, which is what a badly-broken world gets.
    const m = structuredClone(base);
    const findings = [...emitted].map((fix) => ({ id: "synthetic", severity: "major", fix, where: m.structures?.[0]?.id }));
    const r = repair(m, findings);
    const ids = r.manifest.interactions.map((i) => i.id);
    const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    if (dup.length) collisions.push(`${prompt}: ${dup.join(", ")}`);
    assert.ok(validateManifest(r.manifest).ok,
      `${prompt}: ${JSON.stringify(validateManifest(r.manifest).errors.slice(0, 3))}`);
  }
  assert.deepEqual(collisions, [], `two interactions share an id:\n  ${collisions.join("\n  ")}`);
});

test("B4: an item the world already hands out is not given a second pickup", async () => {
  const m = await goodWorld("Pickup Probe", "w_pickup");
  const before = m.interactions.filter((i) => i.id.startsWith("interaction_pickup_")).length;
  assert.ok(before > 0, "the planner is expected to place pickups");

  const r = repair(m, [{ id: "no_gameplay", severity: "blocker", fix: "add_behaviors" }]);
  const after = r.manifest.interactions.filter((i) => i.id.startsWith("interaction_pickup_")).length;
  assert.equal(after, before, "an item that can already be picked up must not gain a second pickup");
});

test("B0: the schema rejects two interactions sharing an id", () => {
  // Every other id-bearing collection was checked; this one was not, so a
  // duplicate rode through validation and into the runtime, where interactions
  // are keyed by id and one silently shadows the other.
  const m = emptyManifestForTest();
  m.interactions = [
    { id: "interaction_x", trigger: "interact", target_ref: "z0", behavior_ref: null },
    { id: "interaction_x", trigger: "proximity", target_ref: "z0", behavior_ref: null },
  ];
  const v = validateManifest(m);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /duplicate interaction id 'interaction_x'/.test(e.message)),
    `errors: ${JSON.stringify(v.errors)}`);

  // ...and accepts them once the ids differ, so the check is about duplication
  // and not about interactions in general.
  m.interactions[1].id = "interaction_y";
  assert.equal(validateManifest(m).ok, true, JSON.stringify(validateManifest(m).errors));
});

/** A schema-valid manifest with a single zone, for schema-level assertions. */
function emptyManifestForTest() {
  return {
    manifest_version: "3.0.0", world_id: "w_schema_probe", world_version: 1,
    meta: { title: "Probe", created_at: new Date().toISOString() },
    environment: {}, terrain: { kind: "flat", size: { w: 64, h: 64 } },
    zones: [{ id: "z0", kind: "district", bounds: [0, 0, 64, 64] }],
    assets: [], structures: [], npcs: [], items: [], quests: [], behaviors: [], interactions: [],
    spawn: { player_spawns: [{ id: "sp", position: { x: 8, y: 1, z: 8 }, zone: "z0" }] },
    provenance: { generated_by: [] },
  };
}

// ---------------------------------------- a repair may not undo a guarantee

test("B4 GATE: a repair never deletes an entity a player is recorded as holding", async () => {
  // The sequence this closes, from server.mts's expansion path:
  //   applyDelta -> verifyPreservation says the player's state is safe -> the
  //   playtest gate runs -> the REPAIRED manifest is what gets stored.
  // Preservation was certified on a manifest that is not the one saved. So a
  // `drop_quest` on a quest the player had completed, or a `drop_or_substitute`
  // on the house they own, destroyed state that had been certified safe a
  // moment earlier, after the certification.
  const m = await goodWorld("Ownership Probe", "w_own");
  const owned = m.structures[0];
  owned.owner_id = "player_42";
  const doneQuest = m.quests[0].id;
  const liveState = {
    owned_entity_ids: [owned.id], inventory_item_ids: [], completed_quest_ids: [doneQuest],
    visited_zone_ids: [], known_npc_ids: [], companion_memory_refs: [],
  };
  // Make both findings genuine: the structure's asset really is gone.
  m.assets = m.assets.filter((a) => a.id !== owned.asset_ref);
  const findings = [
    { id: "missing_asset", severity: "blocker", where: owned.id, fix: "drop_or_substitute" },
    { id: "quest_not_completable", severity: "blocker", where: doneQuest, fix: "drop_quest" },
  ];

  // Without live state, only what the manifest can say for itself is protected.
  // The structure carries `owner_id`, so it survives on that evidence alone
  // (see the property test below). A completed quest carries no owner field —
  // "I finished this" lives in the player's record, not the world's — so
  // nothing but live state can protect it, and that is the gap this closes.
  const blind = repair(structuredClone(m), findings);
  assert.ok(blind.manifest.structures.some((s) => s.id === owned.id), "owner_id alone must protect the structure");
  assert.equal(blind.manifest.quests.some((q) => q.id === doneQuest), false, "nothing in the manifest records that a quest was completed");

  // With it, neither is touched, and the refusal says why.
  const guarded = repair(structuredClone(m), findings, { liveState });
  assert.ok(guarded.manifest.structures.some((s) => s.id === owned.id), "the player's structure was deleted");
  assert.ok(guarded.manifest.quests.some((q) => q.id === doneQuest), "the player's completed quest was deleted");
  for (const id of [owned.id, doneQuest]) {
    const why = guarded.skipped.find((x) => x.where === id)?.why;
    assert.match(why || "", /held by a player/, `the refusal must name why '${id}' survived: ${why}`);
  }

  // And the world is then REJECTED rather than shipped, which is the honest
  // outcome: the only repair available would have destroyed player state.
  const out = await playtestAndRepair(m, { liveState });
  assert.equal(out.passed, false);
  assert.ok(out.manifest.structures.some((s) => s.id === owned.id), "the rejected world must still hold the player's structure");
});

test("B4 GATE: the live-state guard covers every removing repair", async () => {
  // Enumerated from the source rather than listed by hand, so a new removing
  // repair cannot be added without either honouring the guard or failing here.
  const m = await goodWorld("Removal Probe", "w_remove");
  const cases = [
    ["drop_or_substitute", m.structures[0].id, (mm, id) => mm.structures.some((s) => s.id === id)],
    ["retarget_step", m.quests[0].id, (mm, id) => mm.quests.some((q) => q.id === id)],
    ["drop_quest", m.quests[0].id, (mm, id) => mm.quests.some((q) => q.id === id)],
    ["wire_or_drop", m.behaviors[0].id, (mm, id) => mm.behaviors.some((b) => b.id === id)],
  ];
  const lost = [];
  for (const [fix, id, survives] of cases) {
    const liveState = { owned_entity_ids: [id], inventory_item_ids: [], completed_quest_ids: [], visited_zone_ids: [], known_npc_ids: [], companion_memory_refs: [] };
    const r = repair(structuredClone(m), [{ id: "synthetic", severity: "blocker", where: id, fix }], { liveState });
    if (!survives(r.manifest, id)) lost.push(`${fix} deleted held '${id}'`);
  }
  assert.deepEqual(lost, [], lost.join("; "));
});

test("B4: a quest a player has completed survives losing its last step", async () => {
  // The consistency pass drops a quest left with no steps. That is right for a
  // quest nobody has played and wrong for one somebody has finished: the record
  // of having done it is the player's, not the world's.
  const m = await goodWorld("Emptied Quest Probe", "w_emptied");
  const q = m.quests[0];
  q.steps = [{ id: "step_ghost", kind: "talk", target: "npc_that_does_not_exist" }];

  const blind = repair(structuredClone(m), []);
  assert.equal(blind.manifest.quests.some((x) => x.id === q.id), false, "with nobody holding it, an emptied quest goes");

  const liveState = { owned_entity_ids: [], inventory_item_ids: [], completed_quest_ids: [q.id], visited_zone_ids: [], known_npc_ids: [], companion_memory_refs: [] };
  const guarded = repair(structuredClone(m), [], { liveState });
  assert.ok(guarded.manifest.quests.some((x) => x.id === q.id), "a completed quest must not be erased");
});

// -------------------------------------------- a lost zone is not a lost world

test("B4 GATE: losing a zone does not brick the world", async () => {
  // Every reference to a removed zone is a schema BLOCKER, schema findings
  // carry no `fix`, and playtestAndRepair used to return on round one the
  // moment no FINDING named a repair — before ever reaching the consistency
  // pass, which is the one thing that could have mended them. So one missing
  // label rejected a world permanently, with a note saying nothing could be
  // done, from a pass that could have done it.
  const m = await goodWorld("Zone Loss Probe", "w_zoneloss");
  assert.ok(m.zones.length > 2, "this probe needs a world with several zones");
  const gone = m.zones.at(-1).id;
  const before = { structures: m.structures.length, npcs: m.npcs.length };
  assert.ok(m.structures.some((s) => s.zone === gone), "the fixture needs buildings in the zone that vanishes");
  m.zones = m.zones.filter((z) => z.id !== gone);
  assert.equal(validateManifest(m).ok, false, "the damage must really be a schema error, or this proves nothing");

  const out = await playtestAndRepair(m);
  assert.equal(out.passed, true, `verdict ${out.verdict}: ${out.note || JSON.stringify(out.rounds.at(-1).findings.slice(0, 3))}`);
  assert.ok(validateManifest(out.manifest).ok, JSON.stringify(validateManifest(out.manifest).errors.slice(0, 3)));

  // The reference goes; the content stays. A building is still standing where
  // it stands — what was lost is the name of the district it was in.
  assert.equal(out.manifest.structures.length, before.structures, "buildings were deleted over a lost label");
  assert.equal(out.manifest.npcs.length, before.npcs, "characters were deleted over a lost label");
  for (const s of out.manifest.structures) assert.notEqual(s.zone, gone);
  for (const n of out.manifest.npcs) assert.notEqual(n.zone, gone);
  assert.ok(!out.manifest.navigation.links.some((l) => l.from === gone || l.to === gone), "a route to nowhere must go");
});

test("B4: the consistency pass runs even when no finding names a repair", async () => {
  // The general form of the bug above: repair() does work that no validator
  // asks for, so the loop must not decide there is nothing to do by reading the
  // findings alone.
  const m = await goodWorld("Consistency Probe", "w_consistency");
  const gone = m.zones.at(-1).id;
  m.zones = m.zones.filter((z) => z.id !== gone);
  const findings = critique(m, {}).findings;
  assert.ok(findings.length > 0, "the damaged world must have findings");
  assert.equal(findings.some((f) => f.fix), false, "and none of them may name a fix, or this tests the wrong path");

  const r = repair(m, []);   // no findings at all — only the consistency pass
  assert.ok(r.applied.length > 0, "the consistency pass must still do its work");
  assert.ok(validateManifest(r.manifest).ok, JSON.stringify(validateManifest(r.manifest).errors.slice(0, 3)));
});

// ------------------------------- a repair may not undo another repair's work

test("B4 GATE: a world whose behaviours were wiped is repaired, not rejected forever", async () => {
  // Two defects met here and neither was visible alone.
  //
  // Clearing the behaviours leaves every interaction pointing at one that is
  // gone. `add_behaviors` seeded its "already wired" set from those dead
  // interactions, so it built the behaviours and connected none of them; the
  // consistency pass then removed the dead interactions, leaving behaviours
  // nothing triggers. Next round those counted as orphans, and `wire_or_drop`
  // deleted the very behaviours `add_interactions` had just created in the same
  // round — because the findings were all written before any of them ran.
  //
  // The world failed for `npcs_not_interactive` round after round while the
  // repair log reported every repair as a success. Twenty out of twenty worlds
  // in a per-damage sweep.
  for (const prompt of ["Ashfall Harbour, a rainy nordic port town", "a neon cyberpunk megacity", "a lush jungle temple complex"]) {
    const m = await goodWorld(prompt, "w_wiped");
    m.behaviors = [];
    const out = await playtestAndRepair(m);
    assert.equal(out.passed, true,
      `${prompt}: ${out.verdict} — ${JSON.stringify(out.rounds.at(-1).findings.filter((f) => f.severity !== "minor" && f.severity !== "info").map((f) => f.id))}`);
    assert.ok(validateManifest(out.manifest).ok, JSON.stringify(validateManifest(out.manifest).errors.slice(0, 3)));

    // Repaired for real: the NPCs can be spoken to again.
    const wired = new Set(out.manifest.interactions.map((i) => i.target_ref));
    assert.ok(out.manifest.npcs.filter((n) => wired.has(n.id)).length > 0, `${prompt}: no NPC ended up interactive`);
    const behaviourIds = new Set(out.manifest.behaviors.map((b) => b.id));
    for (const i of out.manifest.interactions) {
      assert.ok(behaviourIds.has(i.behavior_ref), `${prompt}: interaction '${i.id}' triggers a behaviour that is gone`);
    }
  }
});

test("B4: wire_or_drop keeps a behaviour something now triggers, and still drops a defunct one", () => {
  // The two findings that share this fix mean different things. "Nothing
  // triggers it" can stop being true within a round; "the thing it exists for
  // is gone" cannot.
  const m = emptyish();
  m.npcs = [{ id: "npc_a", name: "A", spawn: { x: 1, y: 0, z: 1 }, dialogue: { seed: "hello", lines: [] } }];
  m.items = [{ id: "item_a", name: "Thing" }];
  m.behaviors = [
    { id: "behavior_talk_npc_a", kind: "npc_ai", spec: { npc: "npc_a" } },
    { id: "behavior_pickup_ghost", kind: "pickup", spec: { item: "item_that_is_gone" } },
  ];
  m.interactions = [
    { id: "interaction_talk_npc_a", trigger: "interact", target_ref: "npc_a", behavior_ref: "behavior_talk_npc_a" },
    { id: "interaction_pickup_ghost", trigger: "proximity", target_ref: "npc_a", behavior_ref: "behavior_pickup_ghost" },
  ];

  const r = repair(m, [
    { id: "orphan_behavior", severity: "minor", where: "behavior_talk_npc_a", fix: "wire_or_drop" },
    { id: "behavior_spec_dangling", severity: "blocker", where: "behavior_pickup_ghost", fix: "wire_or_drop" },
  ]);
  const ids = r.manifest.behaviors.map((b) => b.id);
  assert.ok(ids.includes("behavior_talk_npc_a"), "a behaviour something triggers must survive a stale orphan finding");
  assert.ok(!ids.includes("behavior_pickup_ghost"), "a pickup with no item is defunct however many things trigger it");
});

test("B4 GATE: losing a prop asset does not dangle every item in the world", async () => {
  // validateStructure checks structures and NPCs for a missing asset and not
  // items, and nothing repaired `items[].asset_ref`. So one lost prop asset
  // left every item dangling — a schema BLOCKER with no `fix` — on a world that
  // was otherwise perfectly fine.
  const m = await goodWorld("Item Asset Probe", "w_itemasset");
  const propRef = m.items.find((it) => it.asset_ref)?.asset_ref;
  assert.ok(propRef, "the probe needs items that reference an asset");
  const itemsBefore = m.items.length;
  m.assets = m.assets.filter((a) => a.id !== propRef);
  assert.equal(validateManifest(m).ok, false, "the damage must really be a schema error");

  const out = await playtestAndRepair(m);
  assert.ok(validateManifest(out.manifest).ok, JSON.stringify(validateManifest(out.manifest).errors.slice(0, 3)));
  // The item survives without its model: it is carried, not inhabited, so it
  // can still be picked up and still finish the quest that wants it.
  assert.equal(out.manifest.items.length, itemsBefore, "items were deleted over a missing mesh");
  for (const it of out.manifest.items) assert.notEqual(it.asset_ref, propRef);
});

test("B4: add_behaviors connects what it builds, in the round it builds it", async () => {
  // The half of the previous defect that a multi-round test cannot see, because
  // a later round covers for it.
  //
  // Clearing the behaviours leaves the interactions pointing at behaviours that
  // are gone. `add_behaviors` seeded its "already wired" set from those dead
  // interactions, so every NPC looked connected already and it connected none
  // of them — then reported `added: 10` and success. The consistency pass
  // removed the dead interactions a moment later and the world came out of the
  // round with ten behaviours and nothing triggering any of them.
  const m = await goodWorld("Wiring Probe", "w_wiring");
  m.behaviors = [];
  const r = repair(m, [{ id: "no_gameplay", severity: "blocker", fix: "add_behaviors" }]);

  assert.ok(r.applied.some((a) => a.fix === "add_behaviors"), "add_behaviors must run");
  const wired = new Set(r.manifest.interactions.map((i) => i.target_ref));
  const talkable = r.manifest.npcs.filter((n) => wired.has(n.id));
  assert.equal(talkable.length, r.manifest.npcs.length,
    `add_behaviors reported success having wired ${talkable.length} of ${r.manifest.npcs.length} NPCs`);

  // The consequence, stated as the budget it costs: one round has to be enough.
  const out = await playtestAndRepair(await (async () => { const x = await goodWorld("Wiring Probe", "w_wiring2"); x.behaviors = []; return x; })(), { maxRounds: 2 });
  assert.equal(out.passed, true, `a wiped world must not need a third round: ${out.verdict}`);
});

// ------------------------------------------ the loop is bounded, and it is inert

test("B4 GATE: the repair pass never mutates the manifest it was given", async () => {
  // The /v3/worlds/:id/playtest endpoint runs the full pass over a stored
  // manifest and reports without saving. If the pass mutated its input, that
  // read-only probe would silently rewrite the caller's world in memory — and
  // on the expansion path it would rewrite the very manifest verifyPreservation
  // was about to be shown.
  const damages = [
    ["untouched", () => {}],
    ["behaviours cleared", (m) => { m.behaviors = []; }],
    ["interactions cleared", (m) => { m.interactions = []; }],
    ["spawn removed", (m) => { m.spawn.player_spawns = []; }],
    ["a zone lost", (m) => { m.zones = m.zones.slice(0, -1); }],
    ["structures floated", (m) => { for (const s of m.structures) s.transform.position.y += 40; }],
    ["quests cleared", (m) => { m.quests = []; }],
    ["a zone starved of ground", (m) => { m.navigation.walkable_zones = [{ zone: m.zones[0].id, walkable_fraction: 0.02 }]; }],
  ];
  const base = await goodWorld("Immutability Probe", "w_immutable");
  const changed = [];
  for (const [label, damage] of damages) {
    const m = structuredClone(base);
    damage(m);
    const before = JSON.stringify(m);
    const out = await playtestAndRepair(m);
    if (JSON.stringify(m) !== before) changed.push(label);
    // And the repaired world is a different object, not the same one edited.
    if (out.repairs.length) assert.notEqual(out.manifest, m, `${label}: the result must not be the input`);
  }
  assert.deepEqual(changed, [], `the pass edited the manifest it was handed: ${changed.join(", ")}`);
});

test("B4 GATE: the repair loop is bounded and cannot churn", async () => {
  // Two failure modes, one test. A loop that never terminates hangs the
  // generate request; a loop that applies the same repair round after round
  // terminates but calls no progress progress, which is how link_zone once
  // failed worlds while reporting three successful repairs every round.
  const damages = [
    ["behaviours cleared", (m) => { m.behaviors = []; }],
    ["interactions cleared", (m) => { m.interactions = []; }],
    ["everything wired away", (m) => { m.behaviors = []; m.interactions = []; m.quests = []; }],
    ["a zone lost", (m) => { m.zones = m.zones.slice(0, -1); }],
    ["nav links cut", (m) => { m.navigation.links = []; }],
    ["no cast at all", (m) => { m.npcs = []; m.structures = []; m.items = []; m.behaviors = []; m.interactions = []; m.quests = []; }],
  ];
  const base = await goodWorld("Churn Probe", "w_churn");
  for (const [label, damage] of damages) {
    const m = structuredClone(base);
    damage(m);
    const out = await playtestAndRepair(m);

    assert.ok(out.rounds.length <= 3, `${label}: ${out.rounds.length} rounds ran`);

    // No round may repeat the previous round's repairs exactly: that is work
    // without progress, and the loop counting it as progress is the churn.
    const sigs = out.rounds.map((r) => (r.repairs || []).map((x) => JSON.stringify(x)).sort().join("|"));
    for (let i = 1; i < sigs.length; i++) {
      assert.ok(!(sigs[i] && sigs[i] === sigs[i - 1]),
        `${label}: round ${i + 1} applied exactly what round ${i} did — ${sigs[i].slice(0, 200)}`);
    }
    // A round that changed nothing must be the last one.
    for (let i = 0; i < out.rounds.length - 1; i++) {
      assert.ok((out.rounds[i].repairs || []).length > 0,
        `${label}: round ${i + 1} applied nothing and the loop went round again`);
    }
  }
});

test("B4 GATE: a repaired world does not need repairing again", async () => {
  // The strongest statement of "no churn": run the whole pass twice. If the
  // second run finds more to do, the first one did not finish, and the loop
  // bound is hiding it rather than the repairs being complete.
  const base = await goodWorld("Idempotence Probe", "w_idem");
  const unstable = [];
  for (const [label, damage] of [
    ["behaviours cleared", (m) => { m.behaviors = []; }],
    ["interactions cleared", (m) => { m.interactions = []; }],
    ["a zone lost", (m) => { m.zones = m.zones.slice(0, -1); }],
    ["spawn removed", (m) => { m.spawn.player_spawns = []; }],
    ["quests cleared", (m) => { m.quests = []; }],
  ]) {
    const m = structuredClone(base);
    damage(m);
    const first = await playtestAndRepair(m);
    if (!first.passed) continue;                    // a rejection is a separate question
    const second = await playtestAndRepair(first.manifest);
    if ((second.repairs || []).length) unstable.push(`${label}: ${JSON.stringify(second.repairs.map((r) => r.fix))}`);
  }
  assert.deepEqual(unstable, [], `a second pass still found work to do:\n  ${unstable.join("\n  ")}`);
});

test("B4 GATE: a PASS means the world is genuinely playable, on every damage the pass survives", async () => {
  // The other side of "the gate must be able to fail": whenever it says yes,
  // the yes has to be worth something. Every property here is one a player
  // would hit in the first two minutes.
  const damages = [
    ["untouched", () => {}],
    ["behaviours cleared", (m) => { m.behaviors = []; }],
    ["interactions cleared", (m) => { m.interactions = []; }],
    ["quests cleared", (m) => { m.quests = []; }],
    ["spawn removed", (m) => { m.spawn.player_spawns = []; }],
    ["spawn out of bounds", (m) => { const p = m.spawn.player_spawns[0].position; p.x = m.terrain.size.w + 500; p.z = -400; }],
    ["a zone lost", (m) => { m.zones = m.zones.slice(0, -1); }],
    ["nav links cut", (m) => { m.navigation.links = []; }],
    ["a quest step aimed at nothing", (m) => { if (m.quests[0]?.steps?.[0]) m.quests[0].steps[0].target = "ghost"; }],
    ["a pickup for an item nobody has", (m) => { m.behaviors.push({ id: "behavior_pickup_ghost", kind: "pickup", spec: { item: "ghost_item" } }); }],
    ["every NPC muted", (m) => { for (const n of m.npcs) n.dialogue = { seed: "", lines: [] }; }],
    ["structures floated", (m) => { for (const s of m.structures) s.transform.position.y += 40; }],
  ];

  const lies = [];
  for (const prompt of ["Ashfall Harbour, a rainy nordic port town", "a lush jungle temple complex"]) {
    const base = await goodWorld(prompt, "w_nolie");
    for (const [label, damage] of damages) {
      const m = structuredClone(base);
      damage(m);
      const out = await playtestAndRepair(m);
      if (!out.passed) continue;                 // a refusal is honest by construction
      const w = out.manifest;
      const say = (why) => lies.push(`${prompt} / ${label}: ${why}`);

      if (!validateManifest(w).ok) say(`the manifest is invalid: ${JSON.stringify(validateManifest(w).errors.slice(0, 2))}`);

      // It can be entered, and the player can move once inside.
      const walk = simulatePlaythrough(w);
      if (!walk.ok) say("there is no spawn");
      else if (walk.visited_cells <= 1) say("the player cannot move from the spawn");

      // Every quest it still claims to have can be finished.
      for (const q of simulateQuests(w, walk)) {
        if (!q.completable) say(`quest '${q.quest}' cannot be completed: ${q.steps.filter((s) => !s.ok).map((s) => s.why).join("; ")}`);
      }

      // Everything interactive points at something that exists.
      const ids = new Set([...w.zones, ...w.structures, ...w.npcs, ...(w.items || [])].map((x) => x.id));
      const behaviours = new Set(w.behaviors.map((b) => b.id));
      for (const i of w.interactions) {
        if (!ids.has(i.target_ref)) say(`interaction '${i.id}' targets '${i.target_ref}', which does not exist`);
        if (!behaviours.has(i.behavior_ref)) say(`interaction '${i.id}' triggers '${i.behavior_ref}', which does not exist`);
      }

      // And there is something to do at all.
      if (!w.behaviors.length) say("the world has no behaviours — it is scenery");
    }
  }
  assert.deepEqual(lies, [], `the gate passed worlds that are not playable:\n  ${lies.join("\n  ")}`);
});

test("B4 GATE: a repair never deletes a player's property, with or without live state", async () => {
  // The live-state guard needs a caller to supply live state, and the generate
  // path has none to give. `owner_id` is written INTO the manifest on every
  // ownable collection — the generator writes null and only a real transfer
  // writes a principal — so a structure with an owner is a player's property on
  // the evidence of the world alone. That makes this the guard that holds on
  // every path today rather than only where a caller remembers to arm it.
  const base = await goodWorld("Property Probe", "w_property");

  const owned = structuredClone(base);
  owned.structures[0].owner_id = "player_42";
  const ownedId = owned.structures[0].id;
  owned.assets = owned.assets.filter((a) => a.id !== owned.structures[0].asset_ref);

  const r = repair(owned, [{ id: "missing_asset", severity: "blocker", where: ownedId, fix: "drop_or_substitute" }]);
  assert.ok(r.manifest.structures.some((s) => s.id === ownedId), "a player's building was deleted to clear a finding");
  assert.match(r.skipped.find((x) => x.where === ownedId)?.why || "", /belongs to a player/);

  // The guard must be about ownership, not about refusing to repair: an
  // unowned structure with the same defect is still removed.
  const free = structuredClone(base);
  const freeId = free.structures[0].id;
  free.assets = free.assets.filter((a) => a.id !== free.structures[0].asset_ref);
  const r2 = repair(free, [{ id: "missing_asset", severity: "blocker", where: freeId, fix: "drop_or_substitute" }]);
  assert.ok(!r2.manifest.structures.some((s) => s.id === freeId), "an unowned broken structure must still be dropped");

  // It covers every collection that can carry an owner.
  for (const [collection, mutate] of [
    ["npcs", (m) => { m.npcs[0].owner_id = "player_9"; return m.npcs[0].id; }],
    ["items", (m) => { m.items[0].owner_id = "player_9"; return m.items[0].id; }],
    ["behaviors", (m) => { m.behaviors[0].owner_id = "player_9"; return m.behaviors[0].id; }],
  ]) {
    const m = structuredClone(base);
    const id = mutate(m);
    const out = repair(m, [
      { id: "missing_asset", severity: "blocker", where: id, fix: "drop_or_substitute" },
      { id: "orphan_behavior", severity: "minor", where: id, fix: "wire_or_drop" },
    ]);
    assert.ok((out.manifest[collection] || []).some((e) => e.id === id), `a player's ${collection} entry was deleted`);
  }
});

// ----------------------------------- the general form: no repair invents a blocker

test("B4 GATE: no repair may leave the manifest with a BLOCKER it did not arrive with", async () => {
  // The general form of two separate defects, both found the same way — a
  // repair fixing one finding and raising a worse one:
  //
  //   add_quest        fixed `no_quests` (MAJOR) and wrote a quest aimed at an
  //                    item the walk never reaches, raising
  //                    `quest_not_completable` (BLOCKER). Staging refused a
  //                    real generation on it.
  //   separate         fixed `structures_overlap` (MINOR) by pushing a building
  //                    clean out of the terrain, raising
  //                    `structure_out_of_bounds` (BLOCKER).
  //   reseat_on_ground fixed `structure_floating` (MAJOR) by seating a building
  //                    on a spike, putting a quest target out of reach.
  //
  // A repair that trades up in severity is worse than the finding it fixed: the
  // gate can report a MAJOR and let a creator act on it, but a BLOCKER the pass
  // invented is a world refused for something that was never wrong with it.
  const damages = [
    ["untouched", () => {}],
    ["behaviours cleared", (m) => { m.behaviors = []; }],
    ["interactions cleared", (m) => { m.interactions = []; }],
    ["quests cleared", (m) => { m.quests = []; }],
    ["spawn removed", (m) => { m.spawn.player_spawns = []; }],
    ["spawn out of bounds", (m) => { const p = m.spawn.player_spawns[0].position; p.x = m.terrain.size.w + 500; p.z = -400; }],
    ["a zone lost", (m) => { m.zones = m.zones.slice(0, -1); }],
    ["nav links cut", (m) => { m.navigation.links = []; }],
    ["structures floated", (m) => { for (const s of m.structures) s.transform.position.y += 40; }],
    ["structures stacked", (m) => { if (m.structures.length > 1) m.structures[1].transform.position = { ...m.structures[0].transform.position }; }],
    ["footprints made enormous", (m) => { for (const s of m.structures) s.footprint = { w: 200, d: 200, h: 8 }; }],
    ["terrain spiked", (m) => { const d = m.terrain.data; for (let r = 0; r < d.length; r++) for (let c = 0; c < d[r].length; c++) d[r][c] = ((r + c) % 2) * 60; }],
    ["collision stripped", (m) => { for (const a of m.assets) delete a.collision; }],
    ["every NPC muted", (m) => { for (const n of m.npcs) n.dialogue = { seed: "", lines: [] }; }],
    ["a zone starved of ground", (m) => { m.navigation.walkable_zones = m.zones.map((z) => ({ zone: z.id, walkable_fraction: 0.02 })); }],
    ["an item nobody can obtain", (m) => { m.behaviors = m.behaviors.filter((b) => b.kind !== "pickup"); }],
    ["a quest step aimed at nothing", (m) => { if (m.quests[0]?.steps?.[0]) m.quests[0].steps[0].target = "ghost"; }],
    ["a giver who does not exist", (m) => { if (m.quests[0]) m.quests[0].giver_npc = "ghost_npc"; }],
  ];

  const blockersOf = (m) => {
    const walk = simulatePlaythrough(m);
    return critique(m, { walk, quests: simulateQuests(m, walk) })
      .findings.filter((f) => f.severity === "blocker")
      .map((f) => f.id + (f.where ? `@${f.where}` : ""));
  };

  const invented = [];
  for (const prompt of [
    "A quarry town where the stone remembers who cut it.",
    "Ashfall Harbour, a rainy nordic port town",
    "a neon cyberpunk megacity",
    "a lush jungle temple complex",
  ]) {
    const base = await goodWorld(prompt, "w_noblocker");
    for (const [label, damage] of damages) {
      const m = structuredClone(base);
      damage(m);
      const before = new Set(blockersOf(m));
      const walk = simulatePlaythrough(m);
      const fixable = critique(m, { walk, quests: simulateQuests(m, walk) }).findings.filter((f) => f.fix);
      const r = repair(m, fixable);
      const after = blockersOf(r.manifest).filter((b) => !before.has(b));
      if (after.length) invented.push(`${prompt} / ${label}: ${after.slice(0, 3).join(", ")} (applied ${JSON.stringify(r.applied.map((a) => a.fix))})`);
    }
  }
  assert.deepEqual(invented, [], `repairs invented blockers the world did not have:\n  ${invented.join("\n  ")}`);
});
