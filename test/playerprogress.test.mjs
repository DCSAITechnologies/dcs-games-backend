// Lane I — the player-progress store, under the only tests that matter.
//
// The claims under test, in the order the module makes them:
//
//   1. A recorded observation is DURABLE: it survives the process that wrote it.
//   2. A CLIENT CLAIM IS REFUSED. Not downgraded, not stored with a flag —
//      refused, at every door: the claim seam itself, an NPC id that names
//      nothing, dialogue the server did not serve, an encounter in a world the
//      player never entered, and a quest step the server cannot see.
//   3. CONCURRENT WRITES DO NOT LOSE RECORDS. The collection layer serialises
//      the write; that does not make check-then-insert atomic, and that exact
//      bug produced 128 rows for one principal here recently. Proved for this
//      module's own usage, on both the observation path and the derivation.
//   4. A READ THAT COULD NOT LOOK REPORTS UNKNOWN, never empty — through the
//      service, through the source adapters, and end to end through
//      `createLiveStateService`, which is where an empty array would become a
//      licence to delete a player's things.
//   5. ONE PLAYER CANNOT READ OR WRITE ANOTHER'S PROGRESS, and the world-scoped
//      read a rollback uses leaks no principal at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createPlayerProgressService,
  playerProgressSources,
  questProgressSource,
  npcAcquaintanceSource,
  visitedZoneSource,
  EVIDENCE,
  ACCEPTED_EVIDENCE,
} from "../src/core/playerprogress.mjs";
import { createLiveStateService, COVERAGE, CATEGORIES } from "../src/core/livestate.mjs";

// --------------------------------------------------------------- fixtures

const tmpEnv = () => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-pp-")) });

const alice = { id: "u_alice", source: "local-hs256" };
const bob = { id: "u_bob", source: "local-hs256" };

/** A world manifest of the shape the v3 stack produces. */
function world(over = {}) {
  return {
    world_id: "w1",
    world_version: 3,
    zones: [{ id: "zone_town", name: "Town" }, { id: "zone_docks", name: "Docks" }],
    structures: [{ id: "struct_hall", enterable: true }],
    npcs: [{ id: "npc_mayor", name: "Mayor" }, { id: "npc_smith", name: "Smith" }],
    items: [{ id: "item_key", name: "Key" }],
    behaviors: [{ id: "b_pickup", kind: "pickup", spec: { item: "item_key" } }],
    interactions: [{ id: "i_pickup", trigger: "proximity", target_ref: "struct_hall", behavior_ref: "b_pickup" }],
    quests: [],
    spawn: { player_spawns: [{ id: "spawn_default", position: { x: 1, y: 0, z: 1 }, zone: "zone_town" }] },
    ...over,
  };
}

/** Exactly what `npcMemory.linesFor()` returns, which is what the store checks. */
const servedLines = (npcId) => ({ npc: { id: npcId, name: npcId, role: null, zone: "zone_town" }, remembered: [], observes: [], note: null });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Enter the world the way the play route would, then meet an NPC. */
async function enterAndMeet(svc, principal, m, npcId) {
  await svc.recordWorldEntry({ principal, worldId: m.world_id, manifest: m, worldVersion: m.world_version });
  return await svc.recordNpcDialogueServed({
    principal, worldId: m.world_id, npcId, manifest: m,
    lines: servedLines(npcId), worldVersion: m.world_version,
  });
}

// ==================================================== 1. durable, and honest

test("Lane I: the store persists what the server observed, and nothing else", async () => {
  const env = tmpEnv();
  const m = world();
  const svc = createPlayerProgressService({ env });

  assert.equal(svc.status(), COVERAGE.AVAILABLE);

  const entry = await svc.recordWorldEntry({ principal: alice, worldId: "w1", manifest: m, worldVersion: 3 });
  assert.equal(entry.first_entry, true);
  // The zone came out of the manifest's spawn, not out of any argument.
  assert.equal(entry.zone_recorded, "zone_town");

  const met = await svc.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_mayor", manifest: m, lines: servedLines("npc_mayor") });
  assert.equal(met.first_meeting, true);
  assert.equal(met.encounter.evidence, EVIDENCE.SERVER_NPC_DIALOGUE);

  const p = await svc.progressFor(alice, "w1");
  assert.deepEqual(p.visited_zone_ids, ["zone_town"]);
  assert.deepEqual(p.known_npc_ids, ["npc_mayor"]);
  assert.deepEqual(p.completed_quest_ids, []);
  assert.equal(p.zone_visits[0].evidence, EVIDENCE.SERVER_SPAWN_PLACEMENT);
});

test("Lane I: a recorded observation survives a restart", async () => {
  const env = tmpEnv();
  const m = world();
  const first = createPlayerProgressService({ env });
  await enterAndMeet(first, alice, m, "npc_mayor");

  // A brand-new service over the same data directory — the restart.
  const second = createPlayerProgressService({ env });
  const p = await second.progressFor(alice, "w1");
  assert.deepEqual(p.known_npc_ids, ["npc_mayor"]);
  assert.deepEqual(p.visited_zone_ids, ["zone_town"]);
  assert.equal(p.entered, true);

  // And so does a derived completion.
  const m2 = world({ quests: [{ id: "q_talk", title: "A Word", steps: [{ id: "s1", kind: "talk", target: "npc_mayor" }] }] });
  await first.reconcileQuests({ principal: alice, worldId: "w1", manifest: m2, worldVersion: 3 });
  const third = createPlayerProgressService({ env });
  assert.deepEqual((await third.progressFor(alice, "w1")).completed_quest_ids, ["q_talk"]);
  assert.deepEqual((await third.heldInWorld("w1")).completed_quest_ids, ["q_talk"]);
});

test("Lane I: the spawn zone comes from the manifest, so a caller cannot name one", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world();

  // Every shape a client might use to smuggle a zone in. None of them is a
  // parameter of recordWorldEntry, so none of them can reach the store.
  await svc.recordWorldEntry({
    principal: alice, worldId: "w1", manifest: m, worldVersion: 3,
    zone: "zone_docks", zone_id: "zone_docks", visited_zone_ids: ["zone_docks"],
  });
  assert.deepEqual((await svc.progressFor(alice, "w1")).visited_zone_ids, ["zone_town"]);

  // A spawn with no zone records nothing, and SAYS so rather than picking one.
  const noZone = world({ world_id: "w2", spawn: { player_spawns: [{ id: "s", position: { x: 0, y: 0, z: 0 }, zone: null }] } });
  const r = await svc.recordWorldEntry({ principal: alice, worldId: "w2", manifest: noZone });
  assert.equal(r.zone_recorded, null);
  assert.match(r.zone_note, /declares no zone/);
  assert.deepEqual((await svc.progressFor(alice, "w2")).visited_zone_ids, []);

  // A spawn naming a zone the manifest does not contain records nothing either:
  // an id that names nothing would refuse a rollback over a phantom entity.
  const badZone = world({ world_id: "w3", spawn: { player_spawns: [{ id: "s", position: { x: 0, y: 0, z: 0 }, zone: "zone_ghost" }] } });
  const r2 = await svc.recordWorldEntry({ principal: alice, worldId: "w3", manifest: badZone });
  assert.equal(r2.zone_recorded, null);
  assert.match(r2.zone_note, /not a zone in this manifest/);
});

// =========================================== 2. a client claim never lands

test("Lane I: the claim seam refuses, and explains what would be needed instead", async () => {
  const svc = createPlayerProgressService({ env: tmpEnv() });
  await assert.rejects(
    () => svc.recordClientClaim({ world_id: "w1", quest_id: "q_epic", completed: true }),
    (e) => {
      assert.equal(e.code, "forbidden");
      assert.equal(e.httpStatus, 403);
      assert.match(e.detail, /never recorded from a client claim/);
      assert.match(e.detail, /server-authoritative session/);
      return true;
    }
  );
  // There is no evidence value a client could supply.
  assert.deepEqual(ACCEPTED_EVIDENCE, [EVIDENCE.SERVER_SPAWN_PLACEMENT, EVIDENCE.SERVER_NPC_DIALOGUE]);
  assert.equal(ACCEPTED_EVIDENCE.includes("client_asserted"), false);
});

test("Lane I: an NPC encounter is refused unless the SERVER served that NPC's dialogue", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world();
  await svc.recordWorldEntry({ principal: alice, worldId: "w1", manifest: m });

  // No dialogue at all — the caller is simply asserting the meeting.
  await assert.rejects(
    () => svc.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_mayor", manifest: m }),
    (e) => (assert.equal(e.code, "validation_failed"), assert.match(e.detail, /a caller cannot assert an encounter/), true)
  );

  // Dialogue that names a DIFFERENT NPC: real artefact, wrong subject.
  await assert.rejects(
    () => svc.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_mayor", manifest: m, lines: servedLines("npc_smith") }),
    (e) => (assert.equal(e.code, "validation_failed"), true)
  );

  // An id that is not an NPC in this world would put a phantom into
  // known_npc_ids, and a phantom refuses a rollback over nothing.
  await assert.rejects(
    () => svc.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_ghost", manifest: m, lines: servedLines("npc_ghost") }),
    (e) => (assert.equal(e.code, "validation_failed"), assert.match(e.detail, /is not an NPC in this world/), true)
  );

  assert.deepEqual((await svc.progressFor(alice, "w1")).known_npc_ids, []);
});

test("Lane I: meeting an NPC in a world you never entered is refused", async () => {
  const svc = createPlayerProgressService({ env: tmpEnv() });
  const m = world();
  // The NPC-memory route is a GET over a public manifest. Without this rule a
  // stranger could "meet" every NPC in a world and freeze its creator's
  // rollback with ids they acquired by reading.
  await assert.rejects(
    () => svc.recordNpcDialogueServed({ principal: bob, worldId: "w1", npcId: "npc_mayor", manifest: m, lines: servedLines("npc_mayor") }),
    (e) => (assert.equal(e.code, "conflict"), assert.match(e.detail, /has not entered this world/), true)
  );
  assert.deepEqual((await svc.heldInWorld("w1")).known_npc_ids, []);
});

test("Lane I: a completion is derived from observations, never written on request", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world({ quests: [{ id: "q_talk", title: "A Word", steps: [{ id: "s1", kind: "talk", target: "npc_mayor" }] }] });

  // Before any observation: not completed, and the reason is stated.
  const before = await svc.reconcileQuests({ principal: alice, worldId: "w1", manifest: m });
  assert.deepEqual(before.completed, []);
  assert.equal(before.blocked[0].quest_id, "q_talk");
  assert.match(before.blocked[0].steps[0].reason, /has not served this NPC's dialogue/);

  await enterAndMeet(svc, alice, m, "npc_mayor");
  const after = await svc.reconcileQuests({ principal: alice, worldId: "w1", manifest: m });
  assert.equal(after.completed.length, 1);
  assert.equal(after.completed[0].newly_completed, true);

  // The row carries its own proof: which observation satisfied which step.
  const row = after.completed[0].completion;
  assert.equal(row.steps.length, 1);
  assert.equal(row.steps[0].evidence, EVIDENCE.SERVER_NPC_DIALOGUE);
  assert.ok(row.steps[0].evidence_id);
  assert.ok(row.quest_fingerprint);

  // Idempotent: re-deriving over the same evidence adds nothing.
  const again = await svc.reconcileQuests({ principal: alice, worldId: "w1", manifest: m });
  assert.equal(again.completed[0].newly_completed, false);
  assert.deepEqual((await svc.heldInWorld("w1")).completed_quest_ids, ["q_talk"]);

  const audit = await svc.verifyCompletion({ principal: alice, worldId: "w1", questId: "q_talk", manifest: m });
  assert.equal(audit.still_supported, true);
  assert.equal(audit.fingerprint_matches, true);
});

test("Lane I: a quest step the server cannot see is never completed, and says why", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });

  const m = world({
    quests: [
      // The procedural-quest shape from npc-memory.mjs: talk, reach, collect, deliver.
      { id: "q_fetch", title: "Fetch", steps: [
        { id: "s1", kind: "talk", target: "npc_mayor" },
        { id: "s2", kind: "reach", target: "zone_town" },
        { id: "s3", kind: "collect", target: "item_key" },
        { id: "s4", kind: "deliver", target: "npc_smith" },
      ] },
      // A reach step to a zone the world never spawned anyone into.
      { id: "q_walk", title: "Walk", steps: [{ id: "s1", kind: "reach", target: "zone_docks" }] },
      // A reach step to a STRUCTURE: no observation covers entering a building.
      { id: "q_enter", title: "Enter", steps: [{ id: "s1", kind: "reach", target: "struct_hall" }] },
      // A quest with no steps can never have been completed.
      { id: "q_empty", title: "Empty", steps: [] },
    ],
  });

  await enterAndMeet(svc, alice, m, "npc_mayor");
  await svc.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_smith", manifest: m, lines: servedLines("npc_smith") });

  const r = await svc.reconcileQuests({ principal: alice, worldId: "w1", manifest: m });
  assert.deepEqual(r.completed, []);
  assert.equal(r.blocked.length, 4);

  const by = Object.fromEntries(r.blocked.map((b) => [b.quest_id, b.steps]));
  // The collect step names the real reason, which is an authorisation defect in
  // the store it would otherwise have read.
  assert.match(by.q_fetch.find((s) => s.step_id === "s3").reason, /set_inventory op names its own player_id/);
  assert.match(by.q_fetch.find((s) => s.step_id === "s4").reason, /never sees an item change hands/);
  assert.match(by.q_walk[0].reason, /only spawn placement is observed/);
  assert.match(by.q_enter[0].reason, /only spawn placement is observed/);
  assert.match(by.q_empty[0].reason, /no steps/);

  // Nothing was recorded, so nothing false gates a rollback.
  assert.deepEqual((await svc.heldInWorld("w1")).completed_quest_ids, []);
});

test("Lane I: evidence for every step, gathered out of order, is not a completion", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world({
    quests: [{ id: "q_seq", title: "In Order", steps: [
      { id: "s1", kind: "talk", target: "npc_mayor" },
      { id: "s2", kind: "talk", target: "npc_smith" },
    ] }],
  });

  // Meet the SECOND NPC first, with a real gap so the timestamps differ.
  await svc.recordWorldEntry({ principal: alice, worldId: "w1", manifest: m });
  await svc.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_smith", manifest: m, lines: servedLines("npc_smith") });
  await sleep(15);
  await svc.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_mayor", manifest: m, lines: servedLines("npc_mayor") });

  const r = await svc.reconcileQuests({ principal: alice, worldId: "w1", manifest: m });
  assert.deepEqual(r.completed, []);
  assert.match(r.blocked[0].steps[0].reason, /not done in the quest's order/);

  // The same two facts in the quest's order DO complete it.
  const env2 = tmpEnv();
  const svc2 = createPlayerProgressService({ env: env2 });
  await svc2.recordWorldEntry({ principal: alice, worldId: "w1", manifest: m });
  await svc2.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_mayor", manifest: m, lines: servedLines("npc_mayor") });
  await sleep(15);
  await svc2.recordNpcDialogueServed({ principal: alice, worldId: "w1", npcId: "npc_smith", manifest: m, lines: servedLines("npc_smith") });
  const ok = await svc2.reconcileQuests({ principal: alice, worldId: "w1", manifest: m });
  assert.equal(ok.completed.length, 1);
});

// ============================================ 3. concurrency loses nothing

test("Lane I: 64 concurrent DISTINCT encounters all survive", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const npcs = Array.from({ length: 64 }, (_, i) => ({ id: `npc_${i}`, name: `n${i}` }));
  const m = world({ npcs });

  await svc.recordWorldEntry({ principal: alice, worldId: "w1", manifest: m });
  await Promise.all(npcs.map((n) => svc.recordNpcDialogueServed({
    principal: alice, worldId: "w1", npcId: n.id, manifest: m, lines: servedLines(n.id),
  })));

  const p = await svc.progressFor(alice, "w1");
  assert.equal(p.known_npc_ids.length, 64, "a concurrent write was lost");
  assert.equal(new Set(p.known_npc_ids).size, 64);

  // And all 64 are on disk, not only in this process.
  const afterRestart = await createPlayerProgressService({ env }).heldInWorld("w1");
  assert.equal(afterRestart.known_npc_ids.length, 64);
});

test("Lane I: 64 concurrent IDENTICAL encounters make one row, counted 64 times", async () => {
  // The check-then-insert bug in person. `one()` then `insert()` would have all
  // 64 callers see nothing and all 64 insert; `ensure` is why they do not.
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world();
  await svc.recordWorldEntry({ principal: alice, worldId: "w1", manifest: m });

  const results = await Promise.all(Array.from({ length: 64 }, () => svc.recordNpcDialogueServed({
    principal: alice, worldId: "w1", npcId: "npc_mayor", manifest: m, lines: servedLines("npc_mayor"),
  })));

  const p = await svc.progressFor(alice, "w1");
  assert.equal(p.npc_encounters.length, 1, "check-then-insert duplicated a row");
  assert.equal(results.filter((r) => r.first_meeting).length, 1, "more than one caller was told it was the first meeting");
  // Not one increment lost, which is the other half of the same bug.
  assert.equal(p.npc_encounters[0].occurrences, 64);
});

test("Lane I: 32 concurrent world entries make one session and one spawn-zone visit", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world();
  await Promise.all(Array.from({ length: 32 }, () => svc.recordWorldEntry({ principal: alice, worldId: "w1", manifest: m })));
  const p = await svc.progressFor(alice, "w1");
  assert.equal(p.zone_visits.length, 1);
  assert.equal(p.zone_visits[0].occurrences, 32);
  assert.equal(p.session.occurrences, 32);
});

test("Lane I: 32 concurrent derivations of the same quest make one completion", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world({ quests: [{ id: "q_talk", title: "A Word", steps: [{ id: "s1", kind: "talk", target: "npc_mayor" }] }] });
  await enterAndMeet(svc, alice, m, "npc_mayor");

  const runs = await Promise.all(Array.from({ length: 32 }, () => svc.reconcileQuests({ principal: alice, worldId: "w1", manifest: m })));
  assert.equal(runs.filter((r) => r.completed[0]?.newly_completed).length, 1);
  assert.equal((await svc.progressFor(alice, "w1")).quest_completions.length, 1);
});

// ================================ 4. could-not-look reports UNKNOWN, not empty

test("Lane I: an unopenable store is UNAVAILABLE and every read THROWS", async () => {
  // A data directory that cannot exist: DCS_DATA_DIR points at a FILE.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-pp-bad-"));
  const asFile = path.join(base, "not-a-dir");
  fs.writeFileSync(asFile, "x");
  const svc = createPlayerProgressService({ env: { DCS_DATA_DIR: asFile } });

  assert.equal(svc.status(), COVERAGE.UNAVAILABLE);
  assert.match(svc.describe().reason, /could not be opened/);

  for (const call of [
    () => svc.heldInWorld("w1"),
    () => svc.progressFor(alice, "w1"),
    () => svc.recordWorldEntry({ principal: alice, worldId: "w1", manifest: world() }),
    () => svc.reconcileWorld("w1", world()),
  ]) {
    await assert.rejects(call, (e) => (assert.equal(e.code, "not_configured"), assert.equal(e.httpStatus, 503), true));
  }
});

test("Lane I: a store that fails mid-read reports UNKNOWN rather than empty", async () => {
  const boom = () => { throw new Error("EIO: the disk went away"); };
  const failing = {
    all: async () => boom(),
    one: async () => boom(),
    find: async () => boom(),
    ensure: async () => boom(),
    update: async () => boom(),
  };
  const svc = createPlayerProgressService({ collections: { sessions: failing, npcs: failing, zones: failing, quests: failing } });

  // The store thinks it is configured — the failure is at read time, which is
  // the case that matters: it must not degrade into an empty answer.
  assert.equal(svc.status(), COVERAGE.AVAILABLE);
  await assert.rejects(() => svc.heldInWorld("w1"), (e) => (assert.equal(e.code, "upstream_failure"), true));

  const src = questProgressSource({ progress: svc });
  assert.equal(src.status(), COVERAGE.AVAILABLE);
  await assert.rejects(() => src.read("w1"), (e) => (assert.equal(e.code, "upstream_failure"), true));
});

test("Lane I: an empty store returns EMPTY only because it genuinely looked", async () => {
  const svc = createPlayerProgressService({ env: tmpEnv() });
  const held = await svc.heldInWorld("w_never_played");
  assert.deepEqual(held.completed_quest_ids, []);
  assert.deepEqual(held.known_npc_ids, []);
  assert.deepEqual(held.visited_zone_ids, []);
});

test("Lane I: the source adapters implement livestate's LiveStateSource contract", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const sources = playerProgressSources({ progress: svc });
  assert.equal(sources.length, 3);

  for (const s of sources) {
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.status, "function");
    assert.equal(typeof s.read, "function");
    // PARTIAL, never AVAILABLE: everything returned is real, and it is not the
    // whole set, so livestate must never call the category determined.
    for (const v of Object.values(s.covers)) assert.equal(v, COVERAGE.PARTIAL);
    for (const c of Object.keys(s.covers)) assert.ok(CATEGORIES.includes(c), `${c} is not a live-state category`);
    assert.equal(s.status(), COVERAGE.AVAILABLE);
  }

  // A source over a store that cannot be read refuses, exactly like the null
  // sources it replaces.
  for (const build of [questProgressSource, npcAcquaintanceSource, visitedZoneSource]) {
    const dead = build({ progress: null });
    assert.equal(dead.status(), COVERAGE.UNAVAILABLE);
    await assert.rejects(() => dead.read("w1"), (e) => (assert.equal(e.code, "not_configured"), true));
  }
});

test("Lane I: dropped into createLiveStateService, real holds appear and the category stays UNDETERMINED", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world({ quests: [{ id: "q_talk", title: "A Word", steps: [{ id: "s1", kind: "talk", target: "npc_mayor" }] }] });
  await enterAndMeet(svc, alice, m, "npc_mayor");
  await svc.reconcileQuests({ principal: alice, worldId: "w1", manifest: m });

  const live = createLiveStateService({ sources: playerProgressSources({ progress: svc }) });
  const r = await live.liveStateFor("w1");

  assert.deepEqual(r.live_state.completed_quest_ids, ["q_talk"]);
  assert.deepEqual(r.live_state.known_npc_ids, ["npc_mayor"]);
  assert.deepEqual(r.live_state.visited_zone_ids, ["zone_town"]);

  for (const c of ["completed_quest_ids", "known_npc_ids", "visited_zone_ids"]) {
    assert.equal(r.coverage[c].status, COVERAGE.PARTIAL);
    assert.equal(r.determined.includes(c), false, `${c} must never be reported as fully determined`);
  }
  assert.equal(r.complete, false);
  assert.equal(r.nothing_held, false);
  assert.match(r.note, /NOT determined/);
});

test("Lane I: a failing store leaves the categories undetermined, not empty", async () => {
  const boom = { all: async () => { throw new Error("EIO"); }, one: async () => { throw new Error("EIO"); }, ensure: async () => { throw new Error("EIO"); }, update: async () => { throw new Error("EIO"); } };
  const svc = createPlayerProgressService({ collections: { sessions: boom, npcs: boom, zones: boom, quests: boom } });
  const live = createLiveStateService({ sources: playerProgressSources({ progress: svc }) });
  const r = await live.liveStateFor("w1");

  for (const c of ["completed_quest_ids", "known_npc_ids", "visited_zone_ids"]) {
    assert.equal(r.determined.includes(c), false);
    assert.deepEqual(r.live_state[c], []);
    assert.match(r.coverage[c].reason, /player-progress/);
  }
  // THE LINE THAT MATTERS: empty arrays plus a failed read must never read as
  // "nothing is held", because a rollback would act on it.
  assert.equal(r.nothing_held, false);
  assert.equal(r.complete, false);
});

// ================================================== 5. progress is personal

test("Lane I: one player cannot read another player's progress", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world();
  await enterAndMeet(svc, alice, m, "npc_mayor");

  // Asking for someone else by name is refused outright.
  await assert.rejects(
    () => svc.progressFor(bob, "w1", { subjectId: alice.id }),
    (e) => (assert.equal(e.code, "forbidden"), assert.equal(e.httpStatus, 403), true)
  );
  // And asking without naming anyone returns bob's own rows, which are none —
  // there is no path from bob to alice's data.
  const mine = await svc.progressFor(bob, "w1");
  assert.deepEqual(mine.known_npc_ids, []);
  assert.deepEqual(mine.visited_zone_ids, []);
  assert.equal(mine.entered, false);

  // An anonymous caller gets 401, not an empty page of somebody's progress.
  await assert.rejects(() => svc.progressFor(null, "w1"), (e) => (assert.equal(e.code, "unauthenticated"), true));
  await assert.rejects(() => svc.progressFor({}, "w1"), (e) => (assert.equal(e.code, "unauthenticated"), true));
});

test("Lane I: one player cannot write progress for another", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world();
  await svc.recordWorldEntry({ principal: bob, worldId: "w1", manifest: m });

  for (const call of [
    () => svc.recordWorldEntry({ principal: bob, worldId: "w1", manifest: m, subjectId: alice.id }),
    () => svc.recordNpcDialogueServed({ principal: bob, worldId: "w1", npcId: "npc_mayor", manifest: m, lines: servedLines("npc_mayor"), subjectId: alice.id }),
    () => svc.reconcileQuests({ principal: bob, worldId: "w1", manifest: m, subjectId: alice.id }),
    () => svc.verifyCompletion({ principal: bob, worldId: "w1", questId: "q", manifest: m, subjectId: alice.id }),
  ]) {
    await assert.rejects(call, (e) => (assert.equal(e.code, "forbidden"), true));
  }

  // Nothing was written under alice's name by any of those attempts.
  const p = await svc.progressFor(alice, "w1");
  assert.equal(p.entered, false);
  assert.deepEqual(p.known_npc_ids, []);
});

test("Lane I: the world-scoped read a rollback uses leaks no principal at all", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world({ quests: [{ id: "q_talk", title: "A Word", steps: [{ id: "s1", kind: "talk", target: "npc_mayor" }] }] });
  await enterAndMeet(svc, alice, m, "npc_mayor");
  await enterAndMeet(svc, bob, m, "npc_smith");
  await svc.reconcileWorld("w1", m, 3);

  const held = await svc.heldInWorld("w1");
  // Both players' holds are protected...
  assert.deepEqual(held.known_npc_ids.sort(), ["npc_mayor", "npc_smith"]);
  assert.deepEqual(held.completed_quest_ids, ["q_talk"]);
  // ...and neither player is named.
  const serialised = JSON.stringify(held);
  assert.equal(serialised.includes(alice.id), false);
  assert.equal(serialised.includes(bob.id), false);
  assert.equal(serialised.includes("principal"), false);
});

test("Lane I: reconcileWorld derives for every player who actually entered", async () => {
  const env = tmpEnv();
  const svc = createPlayerProgressService({ env });
  const m = world();
  await enterAndMeet(svc, alice, m, "npc_mayor");
  await enterAndMeet(svc, bob, m, "npc_mayor");

  // The quest is added AFTER the evidence was gathered — the case that would
  // otherwise let a rollback delete a quest two people had finished.
  const withQuest = world({ quests: [{ id: "q_late", title: "Late", steps: [{ id: "s1", kind: "talk", target: "npc_mayor" }] }] });
  const r = await svc.reconcileWorld("w1", withQuest, 4);
  assert.equal(r.sessions_seen, 2);
  assert.equal(r.completions, 2);
  assert.deepEqual((await svc.heldInWorld("w1")).completed_quest_ids, ["q_late"]);
  assert.equal(JSON.stringify(r).includes(alice.id), false);
});

test("Lane I: describe() states the capability and the gap without dressing either up", async () => {
  const d = createPlayerProgressService({ env: tmpEnv() }).describe();
  assert.equal(d.status, COVERAGE.AVAILABLE);
  for (const v of Object.values(d.covers)) assert.equal(v, COVERAGE.PARTIAL);
  assert.match(d.note, /No client claim is recorded/);
  assert.match(d.cannot_verify, /no server-authoritative session/);
  assert.deepEqual(d.substantiable_step_kinds, ["talk", "reach"]);
  assert.ok(d.unsubstantiable_step_kinds.includes("collect"));
});

test("Lane I: a bad world id is refused rather than reaching the store", async () => {
  const svc = createPlayerProgressService({ env: tmpEnv() });
  for (const bad of ["", null, "../escape", "w/../../etc/passwd", "x".repeat(201)]) {
    await assert.rejects(() => svc.heldInWorld(bad), (e) => (assert.equal(e.code, "validation_failed"), true));
  }
});
