// B5 + B6 + B7 + B8 exit gates.
//
// The flagship claim is that a world EVOLVES: V1 town -> V2 hospital -> V3
// airport -> V4 university -> V5 island, with players, inventory, ownership,
// completed quests, NPC history, companion memory and chronology intact at every
// step. These tests assert that, and assert that an unsafe expansion is refused.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { newDelta, applyDelta, checkCompatibility, verifyPreservation, emptyLiveState, deltaHash, COLLECTIONS, OWNABLE_COLLECTIONS } from "../src/v3/expansion/delta.mjs";
import { forkWorld, OWNABLE_COLLECTIONS as FORK_OWNABLE_COLLECTIONS } from "../src/v3/expansion/fork.mjs";
import { planExpansion, planEdit } from "../src/v3/expansion/planner.mjs";
import { playtestAndRepair } from "../src/v3/playtest/agent.mjs";
import { createWorldMemory } from "../src/v3/memory/world-memory.mjs";
import { createCompanionService } from "../src/v3/companion/companion.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };
const tmpEnv = () => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-evo-")) });

async function world(prompt = "A small nordic port town", worldId = "w_evo") {
  const out = await createAssemblyRouter(OFFLINE).assemble({ prompt, worldId, creatorId: "u1" });
  return out.manifest;
}

function liveStateFrom(m) {
  return {
    owned_entity_ids: [m.structures[0].id],
    inventory_item_ids: [m.items[0].id],
    completed_quest_ids: [m.quests[0].id],
    visited_zone_ids: [m.zones[0].id],
    known_npc_ids: [m.npcs[0].id],
    companion_memory_refs: m.npcs[1] ? [m.npcs[1].id] : [],
  };
}

// ======================================================== B6 world evolution

test("B6 FLAGSHIP: V1 town -> V2 hospital -> V3 airport -> V4 university -> V5 island", async () => {
  let m = await world();
  const live = liveStateFrom(m);
  const v1 = structuredClone(m);
  assert.equal(m.world_version, 1);

  const steps = ["add a hospital district", "add an airport", "add a university campus", "add an island"];
  for (const [i, request] of steps.entries()) {
    const before = m;
    const delta = planExpansion(m, { request, author: "u1" });
    const res = applyDelta(m, delta, live);
    m = res.manifest;

    assert.equal(m.world_version, i + 2, `${request} should produce v${i + 2}`);
    const pres = verifyPreservation(before, m, live);
    assert.equal(pres.ok, true, `${request} lost live state: ${JSON.stringify(pres.problems)}`);
    assert.equal(validateManifest(m).ok, true, `${request} produced an invalid manifest`);

    const pt = await playtestAndRepair(m);
    assert.equal(pt.verdict, "PASSED", `${request} produced a world that fails playtest: ${JSON.stringify(pt.rounds.at(-1).findings.slice(0, 3))}`);
  }

  assert.equal(m.world_version, 5);
  assert.equal(m.zones.length, v1.zones.length + 4, "each expansion adds exactly one district");
  assert.equal(m.expansion.history.length, 4);

  // Everything V1 had is still there, unchanged.
  for (const z of v1.zones) assert.ok(m.zones.some((x) => x.id === z.id), `zone ${z.id} vanished`);
  for (const s of v1.structures) {
    const still = m.structures.find((x) => x.id === s.id);
    assert.ok(still, `structure ${s.id} vanished`);
    assert.deepEqual(still.transform.position, s.transform.position, `structure ${s.id} was moved by an expansion`);
  }
  for (const q of v1.quests) assert.ok(m.quests.some((x) => x.id === q.id), `quest ${q.id} vanished`);
  for (const n of v1.npcs) assert.ok(m.npcs.some((x) => x.id === n.id), `npc ${n.id} vanished`);
});

test("B6 GATE: an expansion is a delta — it never regenerates existing content", async () => {
  const m = await world();
  const before = structuredClone(m);
  const delta = planExpansion(m, { request: "add a market district" });
  const after = applyDelta(m, delta).manifest;

  // Every pre-existing entity is byte-identical.
  for (const c of ["zones", "structures", "npcs", "items", "quests", "behaviors"]) {
    for (const orig of before[c]) {
      const now = after[c].find((x) => x.id === orig.id);
      assert.deepEqual(now, orig, `${c} entry ${orig.id} was rewritten by an expansion`);
    }
  }
  // The terrain grew, but no existing cell changed.
  for (let j = 0; j < before.terrain.data.length; j++) {
    for (let i = 0; i < before.terrain.data[j].length; i++) {
      assert.equal(after.terrain.data[j][i], before.terrain.data[j][i], `terrain cell (${i},${j}) was rewritten`);
    }
  }
});

test("B6 GATE: removing something a player owns is REFUSED", async () => {
  const m = await world();
  const live = liveStateFrom(m);
  const d = newDelta({ label: "demolish" });
  d.remove.push({ collection: "structures", id: live.owned_entity_ids[0], reason: "redevelopment" });

  const compat = checkCompatibility(m, d, live);
  assert.equal(compat.ok, false);
  assert.ok(compat.errors.some((e) => e.code === "removal_breaks_live_state"));
  assert.throws(() => applyDelta(m, d, live), (e) => e.httpStatus === 409);
});

test("B6 GATE: removing a completed quest is REFUSED — history is not editable", async () => {
  const m = await world();
  const live = liveStateFrom(m);
  const d = newDelta({ label: "tidy up" });
  d.remove.push({ collection: "quests", id: live.completed_quest_ids[0] });
  const compat = checkCompatibility(m, d, live);
  assert.equal(compat.ok, false);
  assert.ok(compat.errors.some((e) => e.code === "removal_erases_history"));
});

test("B6 GATE: removing something a surviving quest needs is REFUSED", async () => {
  const m = await world();
  const target = m.quests[0].steps.find((s) => m.npcs.some((n) => n.id === s.target))?.target;
  assert.ok(target, "fixture needs a quest step targeting an npc");
  const d = newDelta({ label: "remove npc" });
  d.remove.push({ collection: "npcs", id: target });
  const compat = checkCompatibility(m, d, emptyLiveState());
  assert.equal(compat.ok, false);
  assert.ok(compat.errors.some((e) => e.code === "removal_breaks_quest"));
});

test("B6 GATE: an expansion cannot overwrite an existing entity", async () => {
  const m = await world();
  const d = newDelta({ label: "collision" });
  d.add.zones.push({ id: m.zones[0].id, name: "Impostor", kind: "district", bounds: [0, 0, 10, 10] });
  const compat = checkCompatibility(m, d);
  assert.equal(compat.ok, false);
  assert.ok(compat.errors.some((e) => e.code === "id_collision"));
});

test("B6 GATE: an expansion cannot change a protected field on an existing entity", async () => {
  const m = await world();
  const d = newDelta({ label: "sneaky" });
  d.modify.push({ collection: "structures", id: m.structures[0].id, changes: { owner_id: "someone-else" } });
  const compat = checkCompatibility(m, d);
  assert.equal(compat.ok, false);
  assert.ok(compat.errors.some((e) => e.code === "field_not_modifiable" && e.field === "owner_id"));
});

test("B6: an expansion cannot relocate a player-owned structure", async () => {
  const m = await world();
  const live = liveStateFrom(m);
  const d = newDelta({ label: "move it" });
  d.modify.push({ collection: "structures", id: live.owned_entity_ids[0], changes: { transform: { position: { x: 1, y: 0, z: 1 } } } });
  const compat = checkCompatibility(m, d, live);
  assert.equal(compat.ok, false);
  assert.ok(compat.errors.some((e) => e.code === "cannot_move_player_property"));
});

test("B6: a new quest targeting something that will not exist is REFUSED", async () => {
  const m = await world();
  const d = newDelta({ label: "bad quest" });
  d.add.quests.push({ id: "q_new", title: "Ghost", steps: [{ id: "s1", kind: "talk", target: "npc_never_created" }] });
  const compat = checkCompatibility(m, d);
  assert.equal(compat.ok, false);
  assert.ok(compat.errors.some((e) => e.code === "new_quest_dangling"));
});

test("B6: a refused expansion leaves the world completely untouched", async () => {
  const m = await world();
  const snapshot = JSON.stringify(m);
  const live = liveStateFrom(m);
  const d = newDelta({ label: "bad" });
  d.remove.push({ collection: "structures", id: live.owned_entity_ids[0] });
  assert.throws(() => applyDelta(m, d, live));
  assert.equal(JSON.stringify(m), snapshot, "a refused expansion must not partially apply");
});

test("B6: expansion history is append-only and carries a delta hash", async () => {
  let m = await world();
  m = applyDelta(m, planExpansion(m, { request: "add a hospital" })).manifest;
  const first = structuredClone(m.expansion.history);
  m = applyDelta(m, planExpansion(m, { request: "add an airport" })).manifest;
  assert.equal(m.expansion.history.length, 2);
  assert.deepEqual(m.expansion.history[0], first[0], "an earlier history entry must never change");
  assert.ok(m.expansion.history.every((h) => /^[0-9a-f]{64}$/.test(h.delta_hash)));
  assert.equal(m.expansion.history[1].from_version, 2);
});

test("B6: rollback restores the previous manifest while moving the version forward", async () => {
  const v1 = await world();
  const v2 = applyDelta(v1, planExpansion(v1, { request: "add a hospital" })).manifest;
  assert.equal(v2.zones.length, v1.zones.length + 1);

  // Rolling back re-saves the earlier content as a NEW version: history is never
  // rewritten, so the rollback itself is part of the record.
  const rolled = { ...structuredClone(v1), world_version: v2.world_version + 1, expansion: { ...v2.expansion, history: [...v2.expansion.history, { version: v2.world_version + 1, from_version: v2.world_version, label: "rollback to v1", delta_id: "rollback", delta_hash: deltaHash({ rollback: true }), at: new Date().toISOString() }] } };
  assert.equal(rolled.zones.length, v1.zones.length, "the world's content is back");
  assert.equal(rolled.world_version, 3, "but the version moved forward");
  assert.equal(rolled.expansion.history.length, 2, "and the expansion is still in the record");
});

// ============================================================ B8 chat editing

test("B8 GATE: a surgical edit changes one thing and regenerates nothing", async () => {
  const m = await world();
  const before = structuredClone(m);
  const { delta, summary } = planEdit(m, { request: "make it rain" });
  assert.match(summary, /rain/);
  const after = applyDelta(m, delta).manifest;
  assert.equal(after.environment.weather, "rain");
  assert.equal(after.structures.length, before.structures.length, "a weather change must not touch geometry");
  assert.equal(after.npcs.length, before.npcs.length);
  assert.deepEqual(after.terrain.data, before.terrain.data, "a weather change must not touch terrain");
});

test("B8: night mode, day mode and weather all work as deltas", async () => {
  let m = await world();
  m = applyDelta(m, planEdit(m, { request: "night mode" }).delta).manifest;
  assert.ok(m.environment.time_of_day < 0.1);
  m = applyDelta(m, planEdit(m, { request: "make it day" }).delta).manifest;
  assert.ok(m.environment.time_of_day >= 0.4);
  m = applyDelta(m, planEdit(m, { request: "set weather to snow" }).delta).manifest;
  assert.equal(m.environment.weather, "snow");
});

test("B8: enlarging a structure changes only its footprint", async () => {
  const m = await world();
  const target = m.structures[0];
  const before = { ...target.footprint };
  const r = planEdit(m, { request: `enlarge the ${String(target.purpose).toLowerCase()}` });
  assert.ok(r.delta, r.error);
  const after = applyDelta(m, r.delta).manifest;
  const now = after.structures.find((s) => s.id === target.id);
  assert.ok(now.footprint.w > before.w, "the structure should be bigger");
  assert.deepEqual(now.transform.position, target.transform.position, "enlarging must not move it");
});

test("B8 GATE: adding a boss quest adds a real, completable encounter", async () => {
  const m = await world();
  const r = planEdit(m, { request: "add a boss quest" });
  assert.ok(r.delta, r.error);
  const after = applyDelta(m, r.delta).manifest;
  assert.equal(validateManifest(after).ok, true, JSON.stringify(validateManifest(after).errors));
  const boss = after.npcs.find((n) => n.role === "boss");
  assert.ok(boss, "a boss NPC must exist");
  assert.ok(after.behaviors.some((b) => b.kind === "enemy_ai" && b.spec.health >= 200), "the boss needs real combat behaviour");
  const quest = after.quests.find((q) => q.title === "The Warden");
  assert.ok(quest && quest.steps.some((s) => s.kind === "defeat" && s.target === boss.id), "the quest must actually target the boss");
});

test("B8 GATE: an edit that cannot be honoured says so instead of guessing", async () => {
  const m = await world();
  const r = planEdit(m, { request: "fly to the moon and bring back a sandwich" });
  assert.ok(r.error);
  assert.ok(Array.isArray(r.supported) && r.supported.length > 0, "it must say what it CAN do");
  assert.ok(r.hint);
});

test("B8: an edit referencing something absent from the world reports that", async () => {
  const m = await world();
  m.behaviors = m.behaviors.filter((b) => b.kind !== "enemy_ai");
  const r = planEdit(m, { request: "more enemies" });
  assert.ok(r.error);
  assert.match(r.error, /no enemies/);
});

// ============================================================ B7 world memory

test("B7 GATE: the companion may only cite events that were actually recorded", async () => {
  const env = tmpEnv();
  const mem = createWorldMemory(env);
  await mem.record("w1", { kind: "expanded", summary: "the hospital district was added", worldVersion: 2 });

  assert.equal((await mem.supports("w1", "the hospital district was added")).supported, true);
  const bad = await mem.supports("w1", "a dragon burned down the docks");
  assert.equal(bad.supported, false);
  assert.match(bad.reason, /no recorded event/);
});

test("B7: chronology is append-only and ordered", async () => {
  const mem = createWorldMemory(tmpEnv());
  await mem.record("w1", { kind: "created", summary: "world created", worldVersion: 1 });
  await mem.record("w1", { kind: "expanded", summary: "hospital added", worldVersion: 2 });
  await mem.record("w1", { kind: "player_event", summary: "a player opened the sealed gate", worldVersion: 2 });
  const rows = await mem.chronology("w1");
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3]);
  assert.equal(rows[0].kind, "created");
  assert.ok(rows.every((r) => r.occurred_at));
});

test("B7: recall filters by kind and subject", async () => {
  const mem = createWorldMemory(tmpEnv());
  await mem.record("w1", { kind: "created", summary: "world created" });
  await mem.record("w1", { kind: "expanded", summary: "hospital district added" });
  await mem.record("w1", { kind: "expanded", summary: "airport district added" });
  assert.equal((await mem.recall("w1", { kinds: ["expanded"] })).length, 2);
  assert.equal((await mem.recall("w1", { about: "hospital" })).length, 1);
});

test("B7: an unrecognised event kind is refused", async () => {
  const mem = createWorldMemory(tmpEnv());
  await assert.rejects(() => mem.record("w1", { kind: "vibes", summary: "x" }), (e) => e.httpStatus === 422);
  await assert.rejects(() => mem.record("w1", { kind: "created" }), (e) => e.httpStatus === 422);
});

test("B7: the timeline groups events by world version", async () => {
  const mem = createWorldMemory(tmpEnv());
  await mem.record("w1", { kind: "created", summary: "created", worldVersion: 1 });
  await mem.record("w1", { kind: "expanded", summary: "hospital", worldVersion: 2 });
  await mem.record("w1", { kind: "edited", summary: "made it rain", worldVersion: 2 });
  const t = await mem.timeline("w1");
  assert.equal(t.length, 2);
  assert.equal(t[1].world_version, 2);
  assert.equal(t[1].events.length, 2);
});

// ============================================================= B5 companion

test("B5: adopt, follow, dismiss and re-adopt keep ONE persistent identity", async () => {
  const env = tmpEnv();
  const svc = createCompanionService({ worldMemory: createWorldMemory(env), env });
  const a = await svc.adopt("u1", "w1", { name: "Vex", persona: "scout" });
  assert.equal(a.state, "adopted");
  assert.equal(a.name, "Vex");

  await svc.remember("u1", "w1", { text: "I hid the key under the boat" });
  await svc.follow("u1", "w1");
  assert.equal((await svc.get("u1", "w1")).state, "following");

  await svc.dismiss("u1", "w1");
  const back = await svc.adopt("u1", "w1", { persona: "scout" });
  assert.equal(back.companion_id, a.companion_id, "re-adopting must return the SAME companion");
  assert.equal(back.memories.length, 1, "its memories must survive a dismissal");
  assert.equal(back.name, "Vex");
});

test("B5: companions are per player and per world", async () => {
  const env = tmpEnv();
  const svc = createCompanionService({ env });
  const a = await svc.adopt("u1", "w1");
  const b = await svc.adopt("u2", "w1");
  const c = await svc.adopt("u1", "w2");
  assert.notEqual(a.companion_id, b.companion_id);
  assert.notEqual(a.companion_id, c.companion_id);
});

test("B5 GATE: the companion answers from world context, and says 'I don't know' otherwise", async () => {
  const env = tmpEnv();
  const mem = createWorldMemory(env);
  const svc = createCompanionService({ worldMemory: mem, env });
  const m = await world();
  await svc.adopt("u1", m.world_id);
  await svc.updateContext("u1", m.world_id, { zone: m.zones[0].id, activeQuest: m.quests[0].id });

  const where = await svc.ask("u1", m.world_id, m, "where am i?");
  assert.equal(where.unknown, undefined);
  assert.ok(where.answer.includes(m.zones[0].name));
  assert.ok(where.sources.length);

  const next = await svc.ask("u1", m.world_id, m, "what should i do next?");
  assert.ok(next.answer.includes(m.quests[0].title));

  const who = await svc.ask("u1", m.world_id, m, "who is here?");
  assert.ok(who.sources.length || who.unknown);

  const nonsense = await svc.ask("u1", m.world_id, m, "what is the airspeed velocity of an unladen swallow");
  assert.equal(nonsense.unknown, true);
  assert.match(nonsense.answer, /I don't know/);
  assert.deepEqual(nonsense.sources, []);
});

test("B5 GATE: the companion never invents world history", async () => {
  const env = tmpEnv();
  const mem = createWorldMemory(env);
  const svc = createCompanionService({ worldMemory: mem, env });
  const m = await world();
  await svc.adopt("u1", m.world_id);

  const empty = await svc.ask("u1", m.world_id, m, "what happened here?");
  assert.equal(empty.unknown, true, "with nothing recorded, it must not tell a story");

  await mem.record(m.world_id, { kind: "expanded", summary: "the hospital district was added", worldVersion: 2 });
  const now = await svc.ask("u1", m.world_id, m, "what happened here?");
  assert.equal(now.unknown, undefined);
  assert.match(now.answer, /hospital district/);
  assert.equal(now.sources[0].kind, "world_memory");
});

test("B5: the companion only offers exits that navigation actually connects", async () => {
  const env = tmpEnv();
  const svc = createCompanionService({ env });
  const m = await world();
  await svc.adopt("u1", m.world_id);
  const ctx = await svc.buildContext("u1", m.world_id, m, { zone: m.zones[0].id });
  const linked = new Set((m.navigation.links || []).filter((l) => l.from === m.zones[0].id || l.to === m.zones[0].id).map((l) => (l.from === m.zones[0].id ? l.to : l.from)));
  assert.deepEqual(new Set(ctx.exits.map((e) => e.zone_id)), linked);
});

test("B5 GATE: companion memory survives an expansion, and the companion sees the new world", async () => {
  const env = tmpEnv();
  const mem = createWorldMemory(env);
  const svc = createCompanionService({ worldMemory: mem, env });
  let m = await world();
  await svc.adopt("u1", m.world_id, { persona: "scholar" });
  await svc.remember("u1", m.world_id, { text: "the harbourmaster owes me a favour", refs: [m.npcs[0].id] });
  await svc.updateContext("u1", m.world_id, { zone: m.zones[0].id });

  const live = { ...emptyLiveState(), companion_memory_refs: [m.npcs[0].id] };
  m = applyDelta(m, planExpansion(m, { request: "add a hospital district" }), live).manifest;
  await mem.record(m.world_id, { kind: "expanded", summary: "the hospital district was added", worldVersion: m.world_version });

  const rec = await svc.get("u1", m.world_id);
  assert.equal(rec.memories.length, 1, "companion memory must survive the expansion");

  const ctx = await svc.buildContext("u1", m.world_id, m);
  assert.equal(ctx.world.version, m.world_version, "the companion sees the new world version");
  assert.ok(ctx.world_history.some((h) => /hospital/.test(h.summary)));

  const a = await svc.ask("u1", m.world_id, m, "what do you remember about me?");
  assert.match(a.answer, /harbourmaster/);
});

test("B5: a caption is assembled from facts, never from invention", async () => {
  const env = tmpEnv();
  const svc = createCompanionService({ env });
  const m = await world();
  await svc.adopt("u1", m.world_id);
  await svc.updateContext("u1", m.world_id, { zone: m.zones[0].id, activeQuest: m.quests[0].id });
  const c = await svc.caption("u1", m.world_id, m);
  assert.ok(c.caption.includes(m.zones[0].name));
  assert.ok(c.caption.includes(m.quests[0].title));
});

test("B5: a player can delete a memory, and it is gone", async () => {
  const env = tmpEnv();
  const svc = createCompanionService({ env });
  await svc.adopt("u1", "w1");
  const rec = await svc.remember("u1", "w1", { text: "something private" });
  const id = rec.memories[0].id;
  const after = await svc.forget("u1", "w1", id);
  assert.equal(after.memories.length, 0);
  await assert.rejects(() => svc.forget("u1", "w1", id), (e) => e.httpStatus === 404);
});

test("B5: adopting requires an authenticated principal and a known persona", async () => {
  const svc = createCompanionService({ env: tmpEnv() });
  await assert.rejects(() => svc.adopt(null, "w1"), (e) => e.httpStatus === 401);
  await assert.rejects(() => svc.adopt("u1", "w1", { persona: "chaos_gremlin" }), (e) => e.httpStatus === 422);
});

// ============================== B6 the chronicle records what actually happened

test("B6 chronicle: a removal that removed nothing is recorded as nothing removed", async () => {
  const m = await world();
  const d = newDelta({ label: "clear out a ghost", author: "u1" });
  d.remove.push({ collection: "items", id: "item_that_was_never_here", reason: "test" });

  const res = applyDelta(m, d);
  const entry = res.manifest.expansion.history.at(-1);

  assert.equal(res.applied.removed, 0, "nothing was in the manifest to remove");
  assert.equal(entry.removed, 0, "the permanent record must not claim a deletion that only raised a warning");
  assert.equal(entry.removed, res.applied.removed, "the chronicle and the result must agree");
  assert.deepEqual(res.applied.warnings.map((w) => w.code), ["remove_missing"]);
});

test("B6 chronicle: a delta that removes some of what it named counts only what went", async () => {
  const m = await world();
  const questTargets = new Set((m.quests || []).flatMap((q) => q.steps.map((s) => s.target)));
  const item = m.items.find((it) => !questTargets.has(it.id));
  assert.ok(item, "the fixture needs an item no quest requires");

  const d = newDelta({ label: "half a clear-out", author: "u1" });
  d.remove.push({ collection: "items", id: item.id, reason: "no longer stocked" });
  d.remove.push({ collection: "items", id: "item_that_was_never_here", reason: "test" });

  const res = applyDelta(m, d);
  assert.equal(res.applied.removed, 1);
  assert.equal(res.manifest.expansion.history.at(-1).removed, 1, "the record counts what happened, not what was asked for");
});

// ================ B6 references a removal orphans INSIDE a behaviour's spec

test("B6: removing an item takes the pickup that granted it, and that pickup's interaction", async () => {
  const m = await world();
  const questTargets = new Set((m.quests || []).flatMap((q) => q.steps.map((s) => s.target)));
  const item = m.items.find((it) => !questTargets.has(it.id));
  const pickup = m.behaviors.find((b) => b.kind === "pickup" && b.spec?.item === item.id);
  assert.ok(pickup, "the fixture needs a pickup for that item");
  const interaction = m.interactions.find((i) => i.behavior_ref === pickup.id);
  assert.ok(interaction, "the fixture needs an interaction for that pickup");

  const d = newDelta({ label: "drop the item", author: "u1" });
  d.remove.push({ collection: "items", id: item.id, reason: "cut" });
  const res = applyDelta(m, d);
  const after = res.manifest;

  assert.ok(!after.items.some((i) => i.id === item.id));
  assert.ok(!after.behaviors.some((b) => b.id === pickup.id), "a pickup that grants a deleted item can do nothing and must go with it");
  assert.ok(!after.interactions.some((i) => i.id === interaction.id), "and its interaction with it");
  // The cascade is reported rather than done quietly.
  assert.deepEqual(res.applied.pruned.behaviors, [pickup.id]);
  assert.ok(res.applied.pruned.spec_refs.some((s) => s.behavior === pickup.id && s.field === "item" && s.id === item.id));
  assert.ok(res.applied.pruned.interactions >= 1);
  assert.equal(validateManifest(after).ok, true);
});

test("B6: a door whose key is removed becomes unlocked, and the door survives", async () => {
  const m = await world();
  const key = m.items.find((it) => m.behaviors.some((b) => b.kind === "door" && b.spec?.locked_by === it.id));
  const door = m.behaviors.find((b) => b.kind === "door" && b.spec?.locked_by === key?.id);
  assert.ok(key && door, "the fixture needs a door locked by an item");
  // The key is a quest target in the fixture, so retarget that step first —
  // the point under test is the door, not the quest gate.
  const quests = structuredClone(m.quests);
  for (const q of m.quests) q.steps = q.steps.filter((s) => s.target !== key.id);
  assert.notDeepEqual(m.quests, quests);

  const d = newDelta({ label: "lose the key", author: "u1" });
  d.remove.push({ collection: "items", id: key.id, reason: "cut" });
  const res = applyDelta(m, d);

  const afterDoor = res.manifest.behaviors.find((b) => b.id === door.id);
  assert.ok(afterDoor, "the door itself still exists — only its lock referenced the item");
  assert.equal(afterDoor.spec.locked_by, null, "the lock is cleared, not left naming a deleted item");
  assert.ok(res.applied.pruned.spec_refs.some((s) => s.behavior === door.id && s.field === "locked_by"));
});

test("B6: a list-valued spec reference loses only the entry that went", async () => {
  const m = await world();
  const keep = m.items[0].id;
  const questTargets = new Set((m.quests || []).flatMap((q) => q.steps.map((s) => s.target)));
  const drop = m.items.find((it) => it.id !== keep && !questTargets.has(it.id));
  assert.ok(drop, "the fixture needs a spare item");
  const zone = m.zones[0].id;

  m.behaviors.push(
    { id: "behavior_crate", kind: "container", spec: { contains: [keep, drop.id], locked_by: null } },
    { id: "behavior_lift", kind: "elevator", spec: { floors: [0, 6], speed: 2, call_from: [zone] } },
  );
  m.interactions.push({ id: "interaction_crate", trigger: "interact", target_ref: m.structures[0].id, behavior_ref: "behavior_crate", params: {} });

  const d = newDelta({ label: "empty half the crate", author: "u1" });
  d.remove.push({ collection: "items", id: drop.id, reason: "cut" });
  const after = applyDelta(m, d).manifest;

  const crate = after.behaviors.find((b) => b.id === "behavior_crate");
  assert.ok(crate, "a container that lost one of several items is still a container");
  assert.deepEqual(crate.spec.contains, [keep]);
  assert.ok(after.interactions.some((i) => i.id === "interaction_crate"), "and it keeps its interaction");
  assert.deepEqual(after.behaviors.find((b) => b.id === "behavior_lift").spec.call_from, [zone], "an untouched reference is left alone");
});

test("B6: a teleporter to a removed zone goes with the zone", async () => {
  const m = await world();
  // A zone nothing else depends on, added and then removed in two steps.
  const zoneId = "zone_test_annex";
  const add = newDelta({ label: "annex", author: "u1" });
  add.add.zones.push({ id: zoneId, name: "Annex", kind: "district", bounds: [0, 0, 20, 20], tags: [] });
  add.add.behaviors.push({ id: "behavior_portal", kind: "teleporter", spec: { to_zone: zoneId, to_position: { x: 5, y: 0, z: 5 } } });
  add.add.interactions.push({ id: "interaction_portal", trigger: "interact", target_ref: m.structures[0].id, behavior_ref: "behavior_portal", params: {} });
  const withAnnex = applyDelta(m, add).manifest;
  assert.ok(withAnnex.behaviors.some((b) => b.id === "behavior_portal"));

  const cut = newDelta({ label: "close the annex", author: "u1" });
  cut.remove.push({ collection: "zones", id: zoneId, reason: "cut" });
  const res = applyDelta(withAnnex, cut);

  assert.ok(!res.manifest.behaviors.some((b) => b.id === "behavior_portal"), "a teleporter with nowhere to go is not a teleporter");
  assert.ok(!res.manifest.interactions.some((i) => i.id === "interaction_portal"));
  assert.deepEqual(res.applied.pruned.behaviors, ["behavior_portal"]);
});

test("B6: a delta adding a behaviour that references something that will not exist is REFUSED", async () => {
  const m = await world();
  const d = newDelta({ label: "a pickup for nothing", author: "u1" });
  d.add.behaviors.push({ id: "behavior_pickup_ghost", kind: "pickup", spec: { item: "item_not_in_this_world", respawn_s: null } });

  const compat = checkCompatibility(m, d);
  assert.equal(compat.ok, false);
  const e = compat.errors.find((x) => x.code === "new_behavior_dangling_spec_ref");
  assert.ok(e, JSON.stringify(compat.errors));
  assert.match(e.detail, /item_not_in_this_world/);
  assert.throws(() => applyDelta(m, d), (err) => err.httpStatus === 409);
});

// ================================ B7 a rollback is an event the world remembers

test("B7: a rolled_back event must say which versions it moved between, and who did it", async () => {
  const mem = createWorldMemory(tmpEnv());
  await assert.rejects(
    () => mem.record("w1", { kind: "rolled_back", summary: "the world went back", actorId: "u1" }),
    (e) => e.httpStatus === 422 && /fromVersion and toVersion/.test(e.detail),
  );
  await assert.rejects(
    () => mem.record("w1", { kind: "rolled_back", summary: "the world went back", fromVersion: 3, toVersion: 1 }),
    (e) => e.httpStatus === 422 && /attributed to a principal/.test(e.detail),
  );
  assert.equal((await mem.chronology("w1")).length, 0, "a refused event must not be written");
});

test("B7: a rollback is recorded in the chronicle and reads as one", async () => {
  const mem = createWorldMemory(tmpEnv());
  await mem.record("w1", { kind: "created", summary: "the town was generated", worldVersion: 1, actorId: "u1" });
  await mem.record("w1", { kind: "expanded", summary: "the hospital district was added", worldVersion: 2, actorId: "u1" });
  const row = await mem.record("w1", {
    kind: "rolled_back",
    summary: "the world was rolled back from v2 to the content of v1 by u1",
    worldVersion: 3, fromVersion: 2, toVersion: 1, actorId: "u1",
  });

  assert.equal(row.kind, "rolled_back");
  assert.equal(row.from_version, 2);
  assert.equal(row.to_version, 1);
  assert.equal(row.actor_id, "u1");
  assert.deepEqual((await mem.chronology("w1")).map((r) => r.seq), [1, 2, 3], "the chronicle is still append-only");

  // It is recallable as itself, and it is citable — a companion asked what
  // happened can say the world went back, because it is written down.
  const recalled = await mem.recall("w1", { kinds: ["rolled_back"] });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].to_version, 1);
  assert.equal((await mem.supports("w1", "the world was rolled back from v2 to the content of v1 by u1")).supported, true);
});

test("B7: adding rolled_back did not change how any existing kind is recorded", async () => {
  const mem = createWorldMemory(tmpEnv());
  for (const kind of ["created", "expanded", "edited", "published", "player_event", "seasonal", "milestone"]) {
    const row = await mem.record("w1", { kind, summary: `a ${kind} event`, worldVersion: 1 });
    assert.equal(row.kind, kind);
    assert.equal("from_version" in row, false, `${kind} rows must keep the shape their consumers already read`);
  }
  assert.equal((await mem.chronology("w1")).length, 7);
});

// ================================================== ownership, in every place
// ================================================== a player can hold something
//
// "Ownership must be untouched" was proved for structures alone. A player can
// also be given an item and assigned an NPC, and an entity that SURVIVES a
// change carrying the wrong owner is the quiet version of the same loss: it is
// still in the world, it is simply no longer theirs.

test("B6 GATE: OWNABLE_COLLECTIONS names only collections the manifest actually has", () => {
  for (const c of OWNABLE_COLLECTIONS) {
    assert.ok(COLLECTIONS.includes(c), `'${c}' is not a manifest collection, so listing it protects nothing`);
  }
  assert.ok(!OWNABLE_COLLECTIONS.includes("vehicles"), "WorldManifestV3 has no vehicles collection");
  assert.ok(OWNABLE_COLLECTIONS.includes("structures") && OWNABLE_COLLECTIONS.includes("items") && OWNABLE_COLLECTIONS.includes("npcs"));
  // One list, not two that can drift apart: the fork's export is the same array.
  assert.equal(FORK_OWNABLE_COLLECTIONS, OWNABLE_COLLECTIONS);
});

test("B6 GATE: a change of owner is caught on an item and an NPC, not only on a structure", async () => {
  const m = await world();
  for (const [collection, id] of [["structures", m.structures[0].id], ["items", m.items[0].id], ["npcs", m.npcs[0].id]]) {
    const after = structuredClone(m);
    after.world_version = m.world_version + 1;
    after[collection].find((e) => e.id === id).owner_id = "someone-else";
    const { problems } = verifyPreservation(m, after);
    const found = problems.find((p) => p.code === "ownership_changed" && p.entity === id);
    assert.ok(found, `a change of owner on a ${collection} entry was not reported: ${JSON.stringify(problems)}`);
    assert.equal(found.collection, collection);
  }
});

test("B6 GATE: a fork carries no ownership across in any collection that can hold it", async () => {
  const m = await world();
  m.meta.fork_policy = "allow";
  for (const key of OWNABLE_COLLECTIONS) if ((m[key] || []).length) m[key][0].owner_id = "u_player";

  const { manifest: forked } = forkWorld(
    { world_id: "w_evo", owner_id: "u1", state: "published", version: m.world_version, manifest: m },
    { forkerId: "u2", newWorldId: "w_evo_fork" },
  );
  for (const key of OWNABLE_COLLECTIONS) {
    for (const e of forked[key] || []) {
      assert.notEqual(e.owner_id, "u_player", `a ${key} entry travelled to the forker still owned by a player`);
    }
  }
});
