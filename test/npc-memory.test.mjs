// Section 9.5 — NPC memory and procedural quests from RECORDED state.
//
// The whole point is that an NPC cannot make something up. These tests assert
// that a world with no history produces an NPC with nothing to remember, that
// every line carries the row it came from, and that a generated quest only ever
// targets entities that exist and can actually be completed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { createWorldMemory } from "../src/v3/memory/world-memory.mjs";
import { createNpcMemory } from "../src/v3/companion/npc-memory.mjs";
import { createCompanionService } from "../src/v3/companion/companion.mjs";
import { playtestAndRepair } from "../src/v3/playtest/agent.mjs";
import { applyDelta, newDelta, emptyLiveState } from "../src/v3/expansion/delta.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };
const tmp = () => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-npc-")) });

async function setup() {
  const env = tmp();
  const worldMemory = createWorldMemory(env);
  const npcMemory = createNpcMemory({ worldMemory });
  const out = await createAssemblyRouter(OFFLINE).assemble({ prompt: "A rainy nordic port town", worldId: "w_npc", creatorId: "u1" });
  return { worldMemory, npcMemory, manifest: out.manifest };
}

test("9.5 GATE: with no recorded history, an NPC has nothing to remember and says so", async () => {
  const { npcMemory, manifest } = await setup();
  const r = await npcMemory.linesFor("w_npc", manifest.npcs[0].id, manifest);
  assert.deepEqual(r.remembered, [], "an NPC must not invent a past");
  assert.match(r.note, /nothing to remember/);
  // Present-tense observation is still fine: it describes what is verifiably there.
  assert.ok(r.observes.length > 0);
  assert.ok(r.observes.every((o) => o.source), "even an observation names its source");
});

test("9.5 GATE: every remembered line carries the record it came from", async () => {
  const { worldMemory, npcMemory, manifest } = await setup();
  await worldMemory.record("w_npc", { kind: "expanded", summary: "the hospital district was added", worldVersion: 2 });
  const r = await npcMemory.linesFor("w_npc", manifest.npcs[0].id, manifest);
  assert.ok(r.remembered.length >= 1);
  for (const line of r.remembered) {
    assert.equal(line.source.kind, "world_memory");
    assert.ok(line.source.event_id, "a line without an event id could not be checked");
    assert.ok(line.source.summary);
    assert.ok(line.text.includes(line.source.summary) || line.text.length > 0);
  }
});

test("9.5: an NPC in the affected zone remembers it more strongly", async () => {
  const { worldMemory, npcMemory, manifest } = await setup();
  const zone = manifest.zones[0];
  const local = manifest.npcs.find((n) => n.zone === zone.id);
  const distant = manifest.npcs.find((n) => n.zone !== zone.id);
  await worldMemory.record("w_npc", { kind: "expanded", summary: `${zone.name} was rebuilt`, worldVersion: 2 });

  const a = await npcMemory.linesFor("w_npc", local.id, manifest);
  assert.ok(a.remembered[0].relevance >= 5, "a change to your own zone should rank highest");
  if (distant) {
    const b = await npcMemory.linesFor("w_npc", distant.id, manifest);
    assert.ok(b.remembered[0].relevance < a.remembered[0].relevance, "someone elsewhere should care less");
  }
});

test("9.5 GATE: a line about something never recorded is refused", async () => {
  const { worldMemory, npcMemory } = await setup();
  await worldMemory.record("w_npc", { kind: "expanded", summary: "the hospital district was added" });

  const good = await npcMemory.verifyLine("w_npc", "the hospital district was added");
  assert.equal(good.speakable, true);

  const bad = await npcMemory.verifyLine("w_npc", "I remember when the river flooded and took the old bridge");
  assert.equal(bad.speakable, false);
  assert.match(bad.note, /must not be spoken/);
});

test("9.5: nobody 'remembers' the world being created", async () => {
  const { worldMemory, npcMemory, manifest } = await setup();
  await worldMemory.record("w_npc", { kind: "created", summary: "the world was generated", worldVersion: 1 });
  const r = await npcMemory.linesFor("w_npc", manifest.npcs[0].id, manifest);
  assert.deepEqual(r.remembered, [], "an NPC has no memory of the world beginning");
});

// -------------------------------------------------------- procedural quests

test("9.5 GATE: a generated quest only targets entities that exist", async () => {
  const { npcMemory, manifest } = await setup();
  const gen = await npcMemory.proceduralQuest("w_npc", manifest);
  const ids = new Set([
    ...manifest.zones.map((z) => z.id), ...manifest.structures.map((s) => s.id),
    ...manifest.npcs.map((n) => n.id), ...manifest.items.map((i) => i.id),
  ]);
  assert.ok(gen.quest.steps.length >= 2);
  for (const s of gen.quest.steps) assert.ok(ids.has(s.target), `step ${s.id} targets missing '${s.target}'`);
  assert.ok(ids.has(gen.quest.giver_npc));
});

test("9.5 GATE: a collect step only ever targets an item something actually holds", async () => {
  const { npcMemory, manifest } = await setup();
  const obtainable = new Set();
  for (const b of manifest.behaviors) if (b.kind === "pickup" && b.spec?.item) obtainable.add(b.spec.item);
  for (let i = 0; i < 6; i++) {
    const gen = await npcMemory.proceduralQuest("w_npc", manifest, { seed: i });
    for (const s of gen.quest.steps) {
      if (s.kind === "collect") assert.ok(obtainable.has(s.target), `'${s.target}' is not obtainable anywhere in the world`);
    }
  }
});

test("9.5 GATE: the premise is sourced, or explicitly says it is not", async () => {
  const { worldMemory, npcMemory, manifest } = await setup();

  const unsourced = await npcMemory.proceduralQuest("w_npc", manifest);
  assert.equal(unsourced.premise.source, null);
  assert.equal(unsourced.grounded_in, "present_state");
  assert.match(unsourced.premise.note, /No recorded event applies/);

  await worldMemory.record("w_npc", { kind: "expanded", summary: "the hospital district was added", worldVersion: 2 });
  const sourced = await npcMemory.proceduralQuest("w_npc", manifest);
  assert.equal(sourced.grounded_in, "recorded_event");
  assert.equal(sourced.premise.source.kind, "world_memory");
  assert.match(sourced.premise.text, /hospital district/);
});

test("9.5 GATE: a generated quest, applied, still has to pass the playtest gate", async () => {
  const { npcMemory, manifest } = await setup();
  const gen = await npcMemory.proceduralQuest("w_npc", manifest);
  const delta = newDelta({ label: gen.quest.title });
  delta.add.quests.push(gen.quest);
  const applied = applyDelta(manifest, delta, emptyLiveState());
  assert.equal(validateManifest(applied.manifest).ok, true, JSON.stringify(validateManifest(applied.manifest).errors));
  const gate = await playtestAndRepair(applied.manifest);
  assert.equal(gate.verdict, "PASSED", "a generated quest must be completable, not merely well-formed");
});

test("9.5: generation is deterministic for a given seed", async () => {
  const { npcMemory, manifest } = await setup();
  const a = await npcMemory.proceduralQuest("w_npc", manifest, { seed: 42 });
  const b = await npcMemory.proceduralQuest("w_npc", manifest, { seed: 42 });
  assert.deepEqual(a.quest.steps, b.quest.steps);
  assert.equal(a.quest.title, b.quest.title);
});

test("9.5: a world with no NPCs cannot produce a quest, and says so", async () => {
  const { npcMemory, manifest } = await setup();
  const empty = { ...manifest, npcs: [] };
  await assert.rejects(() => npcMemory.proceduralQuest("w_npc", empty), (e) => e.httpStatus === 422);
});

test("9.5: asking about an NPC that does not exist is a 404", async () => {
  const { npcMemory, manifest } = await setup();
  await assert.rejects(() => npcMemory.linesFor("w_npc", "npc_ghost", manifest), (e) => e.httpStatus === 404);
});

// ------------------------------------ the companion store honours its directory

test("B5 GATE: a companion service writes where it is told, however it is asked", async () => {
  // The failure this closes was silent by construction. `createCompanionService`
  // takes an options object with an `env` inside it, but its sibling
  // `createWorldMemory(env)` takes an environment directly, so several callers
  // passed a bare `{ DCS_DATA_DIR }` in. Destructuring `env` off that gives
  // undefined, the default `process.env` has no DCS_DATA_DIR, and the store
  // landed in `process.cwd()/.dcs-data` — one directory shared by every test
  // that thought it had a private temp one, and by every previous run of the
  // suite. Nothing failed until an unrelated id change made a rollback test read
  // back a companion memory written days earlier.
  const dirs = [];
  for (const build of [
    (root) => createCompanionService({ env: { DCS_DATA_DIR: root } }),   // the documented shape
    (root) => createCompanionService({ DCS_DATA_DIR: root }),            // a bare environment
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-cmp-iso-"));
    const svc = build(root);
    assert.ok(svc.dir.startsWith(root), `the store must live under ${root}, not ${svc.dir}`);

    await svc.adopt("u_iso", "w_iso", { persona: "guide" });
    await svc.remember("u_iso", "w_iso", { text: "we met by the docks", refs: ["npc_iso"] });
    assert.ok(fs.readdirSync(svc.dir).length > 0, "the memory must be on disk in that directory");
    dirs.push(svc.dir);
  }
  assert.notEqual(dirs[0], dirs[1], "two services given two directories must not share one");

  // The point of the isolation: neither can see the other's memories.
  for (const [i, dir] of dirs.entries()) {
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1, `${dir} holds another test's state: ${files.join(", ")}`);
    void i;
  }
});
