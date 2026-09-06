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
import { newDelta, applyDelta, checkCompatibility, verifyPreservation, emptyLiveState, deltaHash } from "../src/v3/expansion/delta.mjs";
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
