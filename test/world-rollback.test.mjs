// B6 — rolling back a world that people are playing in.
//
// The two claims under test are the ones a creator and a player each need:
//   creator: I can go back to how it was, and the record still says what I did
//   player:  going back cannot cost me my house, my inventory or my history
//
// So every test here checks either that the version counter and the chronology
// only ever move forward, or that a rollback which would take something off a
// player is refused by name rather than negotiated.
import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { applyDelta, emptyLiveState, verifyPreservation } from "../src/v3/expansion/delta.mjs";
import { planExpansion, planEdit } from "../src/v3/expansion/planner.mjs";
import { planRollback, rollbackHistoryOf, rollbackMemoryEvent, recordRollback } from "../src/v3/expansion/rollback.mjs";
import { diffManifests } from "../src/v3/expansion/diff.mjs";
import { planStitch, recordStitch, stitchSummary } from "../src/v3/expansion/stitch.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";
import { playtestAndRepair } from "../src/v3/playtest/agent.mjs";
import { manifestHash } from "../src/core/worldstore.mjs";
import { createWorldMemory } from "../src/v3/memory/world-memory.mjs";
import { createLiveStateService, mergeLiveState } from "../src/core/livestate.mjs";     // B2: the server reads live state for itself
import { createCompanionService } from "../src/v3/companion/companion.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };

async function world(prompt = "A small nordic port town", worldId = "w_rollback") {
  const out = await createAssemblyRouter(OFFLINE).assemble({ prompt, worldId, creatorId: "u1" });
  return out.manifest;
}

const expand = (m, request) => applyDelta(m, planExpansion(m, { request, author: "u1" })).manifest;

/** Ids that exist in `after` but not in `before` — everything an expansion brought. */
function newIds(before, after) {
  const d = diffManifests(before, after);
  return Object.fromEntries(["zones", "structures", "npcs", "items", "quests"].map((c) => [c, d.added.entities.filter((e) => e.collection === c).map((e) => e.id)]));
}

// ======================================================== forward-only versions

test("B6 rollback: the version counter moves FORWARD, never back", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  assert.equal(v3.world_version, 3);

  const { manifest: v4 } = planRollback(v3, v1, { actorId: "u1", toVersion: 1 });
  assert.equal(v4.world_version, 4, "rolling back to v1 must produce v4, not v1");

  const { manifest: v5 } = planRollback(v4, v2, { actorId: "u1", toVersion: 2 });
  assert.equal(v5.world_version, 5, "rolling back again keeps moving forward");
});

test("B6 rollback: the earlier CONTENT comes back, byte for byte", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  assert.equal(v2.zones.length, v1.zones.length + 1);

  const { manifest: v3 } = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });

  const back = diffManifests(v1, v3);
  assert.equal(back.summary.changed, false, `the restored content should match v1 exactly: ${back.summary.text}`);
  assert.match(back.summary.text, /Nothing changed between v1 and v3/);
  assert.equal(v3.zones.length, v1.zones.length);
  assert.deepEqual(v3.terrain.size, v1.terrain.size, "the map goes back to its earlier extent");

  // What was added at v2 really is gone from the world's content.
  const added = newIds(v1, v2);
  for (const id of added.zones.concat(added.structures, added.npcs)) {
    assert.ok(!JSON.stringify(v3.zones.concat(v3.structures, v3.npcs)).includes(`"${id}"`), `${id} should not survive the rollback`);
  }
});

test("B6 rollback: an edit can be rolled back as well as an expansion", async () => {
  const v1 = await world();
  const wanted = v1.environment.weather === "storm" ? "fog" : "storm";
  const v2 = applyDelta(v1, planEdit(v1, { request: `set weather to ${wanted}` }).delta).manifest;
  assert.equal(v2.environment.weather, wanted);

  const { manifest: v3, record } = planRollback(v2, v1, { actorId: "u1" });
  assert.equal(v3.environment.weather, v1.environment.weather);
  assert.equal(record.removed, 0, "reverting the weather removes no entities");
  assert.match(record.summary, /weather changed/);
});

// ======================================================== append-only history

test("B6 rollback: history is append-only and gains exactly one rollback entry", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  const before = structuredClone(v3.expansion.history);

  const { manifest: v4, record } = planRollback(v3, v1, { actorId: "u1", toVersion: 1, reason: "the airport ruined the skyline" });

  assert.equal(v4.expansion.history.length, before.length + 1);
  for (let i = 0; i < before.length; i++) {
    assert.deepEqual(v4.expansion.history[i], before[i], `history entry ${i} was rewritten`);
  }
  const last = v4.expansion.history.at(-1);
  assert.deepEqual(last, record, "the returned record must be the entry that was appended");
  record.to_version = 99;
  assert.equal(v4.expansion.history.at(-1).to_version, 1, "and the chronology must not be editable through it");
  assert.equal(last.kind, "rollback");
  assert.equal(last.version, 4);
  assert.equal(last.from_version, 3);
  assert.equal(last.to_version, 1);
  assert.equal(last.author, "u1");
  assert.equal(last.reason, "the airport ruined the skyline");
  assert.match(last.delta_hash, /^[0-9a-f]{64}$/);

  // The expansions that were rolled past are still on the record.
  assert.ok(v4.expansion.history.some((h) => /hospital/i.test(h.label)));
  assert.ok(v4.expansion.history.some((h) => /airport/i.test(h.label)));
});

test("B6 rollback: the record carries what a caller needs to identify the versions", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a market district");
  const { record } = planRollback(v2, v1, { actorId: "u_creator", toVersion: 1 });

  assert.equal(record.to_version, 1);
  assert.equal(record.from_version, 2);
  assert.equal(record.author, "u_creator");
  assert.equal(record.to_manifest_hash, manifestHash(v1), "the record must name the exact snapshot restored");
  assert.equal(record.from_manifest_hash, manifestHash(v2));
});

test("B6 rollback: the record's counts are the manifests' own, not the caller's", async () => {
  const v1 = await world();
  const delta = planExpansion(v1, { request: "add a hospital district" });
  const v2 = applyDelta(v1, delta).manifest;

  const { manifest: v3, record } = planRollback(v2, v1, { actorId: "u1" });
  const change = diffManifests(v2, v3);

  assert.equal(record.removed, change.removed.total);
  assert.equal(record.modified, 0);
  assert.deepEqual(record.added, {}, "rolling back an expansion restores nothing new");
  assert.equal(record.removed, Object.values(delta.add).reduce((n, xs) => n + xs.length, 0), "exactly the expansion's content is withdrawn");
  assert.match(record.summary, /Removed/);
});

test("B6 rollback: rollbackHistoryOf reports every rollback and no expansion", async () => {
  const v1 = await world();
  assert.deepEqual(rollbackHistoryOf(v1), [], "a fresh world has been rolled back nowhere");

  const v2 = expand(v1, "add a hospital district");
  assert.deepEqual(rollbackHistoryOf(v2), [], "an expansion is not a rollback");

  const v3 = planRollback(v2, v1, { actorId: "u1", toVersion: 1 }).manifest;
  const v4 = expand(v3, "add an airport");
  const v5 = planRollback(v4, v1, { actorId: "u2", toVersion: 1 }).manifest;

  const rolls = rollbackHistoryOf(v5);
  assert.equal(rolls.length, 2);
  assert.deepEqual(rolls.map((r) => r.version), [3, 5]);
  assert.deepEqual(rolls.map((r) => r.to_version), [1, 1]);
  assert.deepEqual(rolls.map((r) => r.author), ["u1", "u2"]);
  assert.equal(v5.expansion.history.length, 4, "two expansions and two rollbacks, all recorded");
});

// ====================================================== live state is not the
// ====================================================== creator's to delete

const HOLDERS = [
  ["owned_entity_ids", "structures", /owned by a player/],
  ["inventory_item_ids", "items", /in a player's inventory/],
  ["completed_quest_ids", "quests", /part of a completed quest/],
  ["visited_zone_ids", "zones", /somewhere a player has been/],
  ["known_npc_ids", "npcs", /someone a player has met/],
  ["companion_memory_refs", "npcs", /remembered by a companion/],
];

for (const [key, collection, phrase] of HOLDERS) {
  test(`B6 rollback GATE: REFUSED when it would delete something in ${key}`, async () => {
    const v1 = await world();
    const v2 = expand(v1, "add a hospital district");
    const id = newIds(v1, v2)[collection][0];
    assert.ok(id, `the fixture needs a new ${collection} entry at v2`);

    const live = { ...emptyLiveState(), [key]: [id] };
    assert.throws(
      () => planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: live }),
      (e) => {
        assert.equal(e.httpStatus, 409, "a rollback that costs a player something is a conflict");
        assert.ok(e.detail.includes(id), `the refusal must name '${id}', said: ${e.detail}`);
        assert.match(e.detail, phrase);
        assert.deepEqual(e.meta.blocked_by.map((b) => b.id), [id]);
        return true;
      },
    );
  });
}

test("B6 rollback GATE: every entity in the way is named, not just the first", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const added = newIds(v1, v2);
  const live = {
    ...emptyLiveState(),
    owned_entity_ids: [added.structures[0]],
    inventory_item_ids: [added.items[0]],
    known_npc_ids: [added.npcs[0]],
  };

  assert.throws(
    () => planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: live }),
    (e) => {
      for (const id of [added.structures[0], added.items[0], added.npcs[0]]) {
        assert.ok(e.detail.includes(id), `'${id}' was not named in the refusal: ${e.detail}`);
      }
      assert.equal(e.meta.blocked_by.length, 3);
      return true;
    },
  );
});

test("B6 rollback GATE: a player's property is protected even when live state is not supplied", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  // A player bought a house in the new district; the caller forgot to pass live
  // state. The manifest's own ownership record has to be enough.
  const bought = newIds(v1, v2).structures[0];
  v2.structures.find((s) => s.id === bought).owner_id = "u_player";

  assert.throws(
    () => planRollback(v2, v1, { actorId: "u1", toVersion: 1 }),
    (e) => {
      assert.equal(e.httpStatus, 409);
      assert.ok(e.detail.includes(bought));
      assert.match(e.detail, /owned by u_player/);
      return true;
    },
  );
});

test("B6 rollback: ACCEPTED when everything live is older than the target version", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");

  // Live state that only touches V1 content survives a rollback to V1 intact.
  const live = {
    owned_entity_ids: [v1.structures[0].id],
    inventory_item_ids: [v1.items[0].id],
    completed_quest_ids: [v1.quests[0].id],
    visited_zone_ids: [v1.zones[0].id],
    known_npc_ids: [v1.npcs[0].id],
    companion_memory_refs: [v1.npcs[1].id],
  };

  const { manifest: v4 } = planRollback(v3, v1, { actorId: "u1", toVersion: 1, liveState: live });

  const ids = new Set(["zones", "structures", "npcs", "items", "quests"].flatMap((c) => v4[c].map((x) => x.id)));
  for (const held of Object.values(live).flat()) assert.ok(ids.has(held), `${held} was referenced by live state and must survive`);
  assert.equal(verifyPreservation(v3, v4, live).ok, true, JSON.stringify(verifyPreservation(v3, v4, live).problems));
});

test("B6 rollback: a player's ownership of restored property is preserved, and reported", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  // The player bought a V1 house AFTER the expansion. It exists in the target,
  // so the rollback goes ahead — but the sale is theirs, not the creator's.
  const bought = v1.structures[0].id;
  v2.structures.find((s) => s.id === bought).owner_id = "u_player";

  const live = { ...emptyLiveState(), owned_entity_ids: [bought] };
  const { manifest: v3, record } = planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: live });

  assert.equal(v3.structures.find((s) => s.id === bought).owner_id, "u_player", "a rollback must not repossess a house");
  assert.deepEqual(record.ownership_preserved, [{ id: bought, owner_id: "u_player" }], "and it must say that it did so");
  assert.equal(verifyPreservation(v2, v3, live).ok, true);
});

// =========================================================== the result ships

test("B6 rollback GATE: the restored world is valid and still playable", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an island");
  const { manifest: v4 } = planRollback(v3, v1, { actorId: "u1", toVersion: 1 });

  const validation = validateManifest(v4);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));

  const pt = await playtestAndRepair(v4);
  assert.equal(pt.verdict, "PASSED", `a rolled-back world must still be playable: ${JSON.stringify(pt.rounds.at(-1).findings.slice(0, 3))}`);
});

test("B6 rollback GATE: rolling back to a mid-point leaves that mid-point playable", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  const v4 = expand(v3, "add a university campus");

  const { manifest: v5 } = planRollback(v4, v2, { actorId: "u1", toVersion: 2 });
  assert.equal(v5.world_version, 5);
  assert.equal(v5.zones.length, v2.zones.length);
  assert.equal(validateManifest(v5).ok, true);
  assert.equal((await playtestAndRepair(v5)).verdict, "PASSED");
});

// ================================================================= refusals

test("B6 rollback: a rollback must be attributed to a principal", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  assert.throws(() => planRollback(v2, v1, { toVersion: 1 }), (e) => e.httpStatus === 401);
});

test("B6 rollback: rolling FORWARD, or to the present, is refused", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  assert.throws(() => planRollback(v1, v2, { actorId: "u1" }), (e) => e.httpStatus === 422 && /only goes backwards/.test(e.detail));
  assert.throws(() => planRollback(v2, structuredClone(v2), { actorId: "u1" }), (e) => e.httpStatus === 422);
});

test("B6 rollback: a target from another world is refused", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const other = await world("A desert outpost", "w_other");

  assert.throws(
    () => planRollback(v2, other, { actorId: "u1" }),
    (e) => e.httpStatus === 422 && /w_other/.test(e.detail) && /w_rollback/.test(e.detail),
  );
});

test("B6 rollback: a version number that disagrees with the manifest is refused", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  // The caller asked for v2 but fetched v1: rolling back anyway would silently
  // restore the wrong world.
  assert.throws(
    () => planRollback(v3, v1, { actorId: "u1", toVersion: 2 }),
    (e) => e.httpStatus === 422 && /is v1, not the v2 that was asked for/.test(e.detail),
  );
});

test("B6 rollback: a target from a diverged lineage is refused", async () => {
  const v1 = await world();
  const branchA = expand(expand(v1, "add a hospital district"), "add an airport");
  const branchB = expand(v1, "add an island");
  assert.equal(branchB.world_version, 2);

  assert.throws(
    () => planRollback(branchA, branchB, { actorId: "u1", toVersion: 2 }),
    (e) => e.httpStatus === 409 && /diverges at history entry 0/.test(e.detail),
  );
});

test("B6 rollback: a target claiming more history than the present is refused", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  // A manifest that calls itself v1 while carrying two versions' worth of
  // chronology is incoherent, whichever half of it is the lie.
  const forged = structuredClone(v1);
  forged.expansion.history = structuredClone(v3.expansion.history);

  assert.throws(
    () => planRollback(v2, forged, { actorId: "u1", toVersion: 1 }),
    (e) => e.httpStatus === 409 && /records more history/.test(e.detail),
  );
});

test("B6 rollback: a refused rollback changes neither manifest", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const before = { v1: JSON.stringify(v1), v2: JSON.stringify(v2) };
  const live = { ...emptyLiveState(), owned_entity_ids: [newIds(v1, v2).structures[0]] };

  assert.throws(() => planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: live }));
  assert.equal(JSON.stringify(v1), before.v1, "the target must not be touched by a refused rollback");
  assert.equal(JSON.stringify(v2), before.v2, "nor the live world");
});

test("B6 rollback: the world it was called on is never mutated", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const liveSnapshot = JSON.stringify(v2);
  const targetSnapshot = JSON.stringify(v1);
  const { manifest: v3 } = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });

  assert.equal(JSON.stringify(v2), liveSnapshot, "planRollback must return a new manifest, not edit the old one");

  // The restored content must be a copy, not a view onto the retained version.
  v3.zones.push({ id: "zone_scribble", name: "Scribble", kind: "district", bounds: [0, 0, 1, 1] });
  v3.terrain.data[0][0] = 999;
  assert.equal(JSON.stringify(v1), targetSnapshot, "the target snapshot must not alias the restored world");
});

// ============================== the chronicle, under attack
//
// Everything above tests that a rollback does the right thing when it is used
// the way it is meant to be. This section tries to break the record instead.
// The chronology is the one artefact a world cannot recover from losing: every
// player's history, every companion memory and every retained version is
// addressed by it, so a chronicle with a gap, a duplicate or a rewritten entry
// is not a cosmetic defect. Each test below is an attempt to produce one.

const tmpEnv = () => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-rb-")) });
const versionsIn = (m) => (m.expansion?.history || []).map((h) => h.version);

test("B6 rollback ATTACK: no earlier history entry is truncated, reordered or rewritten", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  const v4 = expand(v3, "add a university campus");
  const before = structuredClone(v4.expansion.history);

  const { manifest: v5 } = planRollback(v4, v1, { actorId: "u1", toVersion: 1 });
  const after = v5.expansion.history;

  assert.equal(after.length, before.length + 1, "the chronology gains exactly one entry");
  for (let i = 0; i < before.length; i++) {
    assert.deepEqual(after[i], before[i], `history entry ${i} was altered by a rollback`);
  }
  assert.deepEqual(versionsIn(v5), [2, 3, 4, 5], "and it stays in order, with no gap and no repeat");
  // The entries that describe expansions still describe expansions — restoring
  // v1's content does not un-happen the work that came after it.
  assert.deepEqual(after.slice(0, 3).map((h) => h.label), before.map((h) => h.label));
});

test("B6 rollback ATTACK: a stale world_version cannot mint a version the chronicle already has", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  assert.deepEqual(versionsIn(v3), [2, 3]);

  // A manifest resaved from a stale read: its content and chronology are v3's,
  // but it calls itself v2. Left unchecked the rollback would number itself v3
  // and the chronicle would read 2, 3, 3.
  const stale = structuredClone(v3);
  stale.world_version = 2;

  assert.throws(
    () => planRollback(stale, v1, { actorId: "u1" }),
    (e) => e.httpStatus === 409 && /claims to be v2 but its history records a later v3/.test(e.detail),
  );
});

test("B6 rollback ATTACK: a version ahead of its own chronicle cannot open a gap", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");

  const ahead = structuredClone(v3);
  ahead.world_version = 9;   // as if versions had been assigned elsewhere

  assert.throws(
    () => planRollback(ahead, v1, { actorId: "u1" }),
    (e) => e.httpStatus === 409 && /claims to be v9 but its chronology ends at v3/.test(e.detail),
  );
});

test("B6 rollback ATTACK: a chronicle that does not move forward is refused", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");

  const reordered = structuredClone(v3);
  reordered.expansion.history = [reordered.expansion.history[1], reordered.expansion.history[0]];

  assert.throws(
    () => planRollback(reordered, v1, { actorId: "u1" }),
    (e) => e.httpStatus === 409 && /does not move forward/.test(e.detail),
  );

  const duplicated = structuredClone(v3);
  duplicated.expansion.history = [duplicated.expansion.history[0], structuredClone(duplicated.expansion.history[0]), duplicated.expansion.history[1]];
  assert.throws(() => planRollback(duplicated, v1, { actorId: "u1" }), (e) => e.httpStatus === 409);
});

test("B6 rollback ATTACK: two rollbacks off the same base cannot interleave", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");

  // Two callers each fetch v3 and roll it back to a different point. Both plans
  // legitimately claim v4 — that is what optimistic concurrency at the store is
  // for — but neither may be applied ON TOP of the other, because that would
  // produce a chronology containing v4 twice.
  const a = planRollback(v3, v1, { actorId: "u1", toVersion: 1 });
  const b = planRollback(v3, v2, { actorId: "u2", toVersion: 2 });
  assert.equal(a.record.version, 4);
  assert.equal(b.record.version, 4);

  assert.throws(
    () => planRollback(a.manifest, b.manifest, { actorId: "u1" }),
    (e) => e.httpStatus === 422 && /only goes backwards/.test(e.detail),
  );
  assert.throws(
    () => planRollback(b.manifest, a.manifest, { actorId: "u2" }),
    (e) => e.httpStatus === 422 && /only goes backwards/.test(e.detail),
  );

  // Applied one after the other — the way a store that serialises writes would
  // do it — the chronology stays contiguous.
  const first = planRollback(v3, v1, { actorId: "u1", toVersion: 1 });
  const second = planRollback(first.manifest, v2, { actorId: "u2", toVersion: 2 });
  assert.deepEqual(versionsIn(second.manifest), [2, 3, 4, 5]);
  assert.equal(new Set(versionsIn(second.manifest)).size, 4, "no version appears twice");
});

test("B6 rollback ATTACK: a rollback of a rollback is recorded, not cancelled out", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");

  const back = planRollback(v3, v1, { actorId: "u1", toVersion: 1 });      // v4, content of v1
  const forward = planRollback(back.manifest, v3, { actorId: "u1", toVersion: 3 }); // v5, content of v3

  assert.equal(forward.manifest.world_version, 5, "undoing an undo still moves forward");
  assert.deepEqual(versionsIn(forward.manifest), [2, 3, 4, 5]);
  const rollbacks = rollbackHistoryOf(forward.manifest);
  assert.equal(rollbacks.length, 2, "both rollbacks are in the record; neither erases the other");
  assert.deepEqual(rollbacks.map((r) => [r.from_version, r.to_version]), [[3, 1], [4, 3]]);

  // The content really is v3's again, and the chronicle says how it got there.
  assert.equal(diffManifests(v3, forward.manifest).summary.changed, false);
  assert.equal(forward.manifest.expansion.history.filter((h) => h.kind === "rollback").length, 2);
});

test("B6 rollback ATTACK: editing the returned record cannot edit the stored chronicle", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const { manifest: v3, record, memory_event } = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });
  const stored = structuredClone(v3.expansion.history.at(-1));

  record.version = 999;
  record.to_version = 999;
  record.author = "someone_else";
  record.label = "TAMPERED";
  record.summary = "nothing happened";
  record.added.zones = 99;
  if (record.ownership_preserved) record.ownership_preserved.push({ id: "fake", owner_id: "u9" });

  assert.deepEqual(v3.expansion.history.at(-1), stored, "the chronicle holds its own copy");
  assert.equal(rollbackHistoryOf(v3)[0].to_version, 1);
  assert.equal(rollbackHistoryOf(v3)[0].author, "u1");
  assert.deepEqual(memory_event.detail.added, stored.added, "and so does the event that will be written to world memory");
});

test("B6 rollback ATTACK: editing the source manifests afterwards cannot edit the stored chronicle", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const { manifest: v3 } = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });
  const stored = structuredClone(v3.expansion.history);

  v2.expansion.history[0].label = "REWRITTEN";
  v2.expansion.history[0].version = 99;
  v2.expansion.history.push({ version: 100, label: "FABRICATED" });
  v1.zones.push({ id: "zone_scribble", name: "Scribble", kind: "district", bounds: [0, 0, 1, 1] });

  assert.deepEqual(v3.expansion.history, stored, "the restored world's chronology is not a view onto its inputs");
  assert.ok(!v3.zones.some((z) => z.id === "zone_scribble"));
});

test("B6 rollback ATTACK: a forged ancestor carrying a chronology it could not have is refused", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");

  // Equal-length: a manifest calling itself v1 while carrying v3's whole
  // chronology. An identical history IS a prefix of itself, so the prefix test
  // alone waves this through — but a real v1 has no history at all.
  const forged = structuredClone(v1);
  forged.expansion.history = structuredClone(v3.expansion.history);
  assert.throws(
    () => planRollback(v3, forged, { actorId: "u1" }),
    (e) => e.httpStatus === 409 && /claims to be v1 but its history records a later v2/.test(e.detail),
  );

  // Diverged: same length, different content. A different world's second version.
  const other = await world("A desert trading post", v1.world_id);
  const otherV2 = expand(other, "add a hospital district");
  const diverged = structuredClone(otherV2);
  diverged.world_version = 2;
  assert.throws(
    () => planRollback(v3, diverged, { actorId: "u1", toVersion: 2 }),
    (e) => e.httpStatus === 409 && /diverges at history entry/.test(e.detail),
  );

  // Doctored: the right lineage with one entry quietly altered.
  const doctored = structuredClone(v2);
  doctored.expansion.history[0].delta_hash = "0".repeat(64);
  assert.throws(
    () => planRollback(v3, doctored, { actorId: "u1", toVersion: 2 }),
    (e) => e.httpStatus === 409 && /diverges at history entry 0/.test(e.detail),
  );
});

test("B6 rollback ATTACK: the world it produces satisfies the rule it demanded of its inputs", async () => {
  const v1 = await world();
  let m = v1;
  for (const r of ["add a hospital district", "add an airport", "add a university campus"]) m = expand(m, r);

  // Roll back and forward repeatedly; the chronology must stay contiguous and
  // must always be a manifest planRollback would itself accept as an input.
  let current = m;
  for (const target of [v1, m, v1]) {
    const out = planRollback(current, target, { actorId: "u1" });
    const vs = versionsIn(out.manifest);
    assert.deepEqual(vs, Array.from({ length: vs.length }, (_, i) => i + 2), "the chronology stays contiguous");
    assert.equal(vs.at(-1), out.manifest.world_version, "and ends at the version the manifest claims to be");
    current = out.manifest;
  }
  assert.equal(current.world_version, 7);
  assert.equal(rollbackHistoryOf(current).length, 3);
});

// ==================================== a rollback is an event the world remembers

test("B6 rollback: the world chronicle records the rollback, with both versions and the actor", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const planned = planRollback(v2, v1, { actorId: "u7", toVersion: 1, reason: "the district broke the harbour" });

  const event = planned.memory_event;
  assert.equal(event.kind, "rolled_back");
  assert.equal(event.fromVersion, 2);
  assert.equal(event.toVersion, 1);
  assert.equal(event.actorId, "u7");
  assert.equal(event.worldVersion, 3, "the version the restored content was saved as");
  assert.match(event.summary, /rolled back from v2 to the content of v1 by u7/);
  assert.equal(event.detail.reason, "the district broke the harbour");
  assert.equal(event.detail.restored_as_version, 3);
  assert.equal(event.detail.from_manifest_hash, manifestHash(v2));
  assert.equal(event.detail.to_manifest_hash, manifestHash(v1));

  const mem = createWorldMemory(tmpEnv());
  await mem.record(v1.world_id, { kind: "created", summary: "the town was generated", worldVersion: 1, actorId: "u7" });
  await mem.record(v1.world_id, { kind: "expanded", summary: "the hospital district was added", worldVersion: 2, actorId: "u7" });
  const row = await recordRollback(mem, v1.world_id, planned);

  assert.equal(row.kind, "rolled_back");
  assert.equal(row.from_version, 2);
  assert.equal(row.to_version, 1);
  assert.equal(row.actor_id, "u7");

  // It reads as a world event in the world's own history, in sequence.
  const chronology = await mem.chronology(v1.world_id);
  assert.deepEqual(chronology.map((r) => r.kind), ["created", "expanded", "rolled_back"]);
  assert.deepEqual(chronology.map((r) => r.seq), [1, 2, 3]);
  const timeline = await mem.timeline(v1.world_id);
  assert.deepEqual(timeline.map((t) => t.world_version), [1, 2, 3]);
  assert.equal(timeline.at(-1).events[0].kind, "rolled_back");
});

test("B6 rollback: the memory event is built from the record, so it cannot overstate the rollback", async () => {
  const v1 = await world();
  const wanted = v1.environment.weather === "storm" ? "fog" : "storm";
  const v2 = applyDelta(v1, planEdit(v1, { request: `set weather to ${wanted}` }).delta).manifest;
  const planned = planRollback(v2, v1, { actorId: "u1" });

  // Reverting the weather removes nothing, and the event must say so rather
  // than describing a rollback as a demolition.
  assert.equal(planned.record.removed, 0);
  assert.equal(planned.memory_event.detail.removed, 0);
  assert.deepEqual(planned.memory_event.detail.added, {});
  assert.equal(planned.memory_event.detail.change_summary, planned.record.summary);

  // And it is independently derivable from the record alone.
  assert.deepEqual(rollbackMemoryEvent(planned.record), planned.memory_event);
});

test("B6 rollback: a rollback event with no versions is refused by the chronicle", async () => {
  const mem = createWorldMemory(tmpEnv());
  await assert.rejects(
    () => mem.record("w_rb", { kind: "rolled_back", summary: "the world went back somehow", actorId: "u1" }),
    (e) => e.httpStatus === 422,
  );
  assert.deepEqual(await mem.chronology("w_rb"), [], "an event that cannot say what it undid is not written");
});

// ====================================================== B2: the server reads
// ====================================================== live state for itself
//
// The gate above works, and until now it only worked if the CALLER chose to
// arm it. `server.mts:1273` built the live state from `b.live_state`, so a
// request that simply omitted the field disarmed five of the six HOLDS
// categories — the protection was opt-in by the very caller it protects
// against. These tests drive the same gate from `src/core/livestate.mjs`,
// which reads the stores instead of asking.

/** A live-state service over a real companion store plus a stand-in CW5 engine. */
function liveStateOver({ dir, snapshotsByWorld = null } = {}) {
  return createLiveStateService({
    companions: dir ? { dir } : null,
    persistence: snapshotsByWorld
      ? {
        async load(worldId) {
          if (!(worldId in snapshotsByWorld)) throw new Error(`load: base world ${worldId} not found`);
          return snapshotsByWorld[worldId];
        },
      }
      : null,
  });
}

test("B2 rollback: a companion memory recorded on the SERVER refuses the rollback, with no client live_state", async () => {
  const v1 = await world("A small nordic port town", "w_b2_companion");
  const v2 = expand(v1, "add a hospital district");
  const held = newIds(v1, v2).npcs[0];
  assert.ok(held, "the fixture needs an NPC that only exists at v2");

  // A real player, a real companion, a real memory in the real store.
  const companions = createCompanionService(tmpEnv());
  await companions.adopt("u_player", v1.world_id, { persona: "guide" });
  await companions.remember("u_player", v1.world_id, { text: "the ward doctor helped me", refs: [held] });

  // The defect, demonstrated: the caller omits live_state and the rollback goes
  // through, taking the NPC the companion remembers with it.
  const undefended = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });
  assert.ok(!undefended.manifest.npcs.some((n) => n.id === held), "without server-side live state the held NPC is deleted");

  // The fix: the server determines live state for itself and the same rollback
  // is refused by name.
  const determined = await liveStateOver({ dir: companions.dir }).liveStateFor(v1.world_id);
  assert.deepEqual(determined.live_state.companion_memory_refs, [held]);

  assert.throws(
    () => planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: determined.live_state }),
    (e) => {
      assert.equal(e.httpStatus, 409);
      assert.ok(e.detail.includes(held), `the refusal must name '${held}': ${e.detail}`);
      assert.match(e.detail, /remembered by a companion/);
      assert.deepEqual(e.meta.blocked_by.map((b) => b.id), [held]);
      return true;
    },
  );
});

test("B2 rollback: a player's inventory in the runtime store refuses the rollback", async () => {
  const v1 = await world("A small nordic port town", "w_b2_inventory");
  const v2 = expand(v1, "add a hospital district");
  const held = newIds(v1, v2).items[0];
  assert.ok(held, "the fixture needs an item that only exists at v2");

  // A stored CW5 snapshot: one player, one item, actually written down.
  const svc = liveStateOver({
    snapshotsByWorld: {
      [v1.world_id]: {
        world_id: v1.world_id, base_world_id: v1.world_id, as_of_seq: 3, ts: new Date().toISOString(),
        objects: [], inventories: { u_player: [{ item_id: held, qty: 1 }] },
        npc_states: {}, economy: {}, vars: {},
      },
    },
  });
  const determined = await svc.liveStateFor(v1.world_id);
  assert.deepEqual(determined.live_state.inventory_item_ids, [held]);

  assert.throws(
    () => planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: determined.live_state }),
    (e) => {
      assert.equal(e.httpStatus, 409);
      assert.ok(e.detail.includes(held));
      assert.match(e.detail, /in a player's inventory/);
      return true;
    },
  );
});

test("B2 rollback: an empty client live_state cannot disarm what the server determined", async () => {
  const v1 = await world("A small nordic port town", "w_b2_optout");
  const v2 = expand(v1, "add a hospital district");
  const held = newIds(v1, v2).items[0];

  const svc = liveStateOver({
    snapshotsByWorld: {
      [v1.world_id]: {
        world_id: v1.world_id, base_world_id: v1.world_id, as_of_seq: 1, ts: new Date().toISOString(),
        objects: [], inventories: { u_player: [{ item_id: held, qty: 2 }] },
        npc_states: {}, economy: {}, vars: {},
      },
    },
  });
  const determined = await svc.liveStateFor(v1.world_id);

  // Every shape of opt-out a caller could send, folded through the merge the
  // route will use. None of them may reach a successful rollback.
  for (const attempt of [undefined, null, {}, emptyLiveState(), { inventory_item_ids: [] }, { inventory_item_ids: null }]) {
    const { live_state } = mergeLiveState(determined.live_state, attempt);
    assert.throws(
      () => planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: live_state }),
      (e) => e.httpStatus === 409 && e.detail.includes(held),
      `live_state=${JSON.stringify(attempt)} disarmed the gate`,
    );
  }
});

test("B2 rollback: client-supplied live state is ADDITIVE — it can still block what the server cannot see", async () => {
  const v1 = await world("A small nordic port town", "w_b2_additive");
  const v2 = expand(v1, "add a hospital district");
  const quest = newIds(v1, v2).quests[0];
  assert.ok(quest, "the fixture needs a quest that only exists at v2");

  // completed_quest_ids has no store on this estate, so the server determines
  // nothing for it and says so. A client that DOES know must still be heard.
  const determined = await liveStateOver({ snapshotsByWorld: { [v1.world_id]: {
    world_id: v1.world_id, base_world_id: v1.world_id, as_of_seq: 0, ts: new Date().toISOString(),
    objects: [], inventories: {}, npc_states: {}, economy: {}, vars: {},
  } } }).liveStateFor(v1.world_id);
  assert.ok(determined.undetermined.some((u) => u.category === "completed_quest_ids"));
  assert.equal(determined.nothing_held, false, "an undetermined category is never reported as safe");

  // Without the client's evidence the rollback is allowed.
  planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: determined.live_state });

  const { live_state, added } = mergeLiveState(determined.live_state, { completed_quest_ids: [quest] });
  assert.deepEqual(added.completed_quest_ids, [quest]);
  assert.throws(
    () => planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: live_state }),
    (e) => e.httpStatus === 409 && e.detail.includes(quest) && /cannot be removed|part of a completed quest/.test(e.detail),
  );
});

test("B2 rollback: a world with no recorded activity is still rolled back, and says what it could not check", async () => {
  const v1 = await world("A small nordic port town", "w_b2_quiet");
  const v2 = expand(v1, "add a hospital district");

  const companions = createCompanionService(tmpEnv());
  const determined = await liveStateOver({
    dir: companions.dir,
    snapshotsByWorld: { [v1.world_id]: {
      world_id: v1.world_id, base_version: 1, base_world_id: v1.world_id, as_of_seq: 0, ts: new Date().toISOString(),
      objects: [], inventories: {}, npc_states: {}, economy: {}, vars: {},
    } },
  }).liveStateFor(v1.world_id);

  assert.deepEqual(determined.live_state, emptyLiveState());
  assert.equal(determined.held_total, 0);
  // Nobody holds anything the server can see, so the rollback proceeds.
  const { manifest: v3 } = planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: determined.live_state });
  assert.equal(v3.world_version, 3);
  // And the caller is told exactly how far the check reached, rather than being
  // left to read six empty arrays as a guarantee.
  assert.equal(determined.complete, false);
  assert.deepEqual(determined.undetermined.map((u) => u.category).sort(), ["completed_quest_ids", "known_npc_ids", "visited_zone_ids"]);
  assert.match(determined.note, /not evidence that nothing is held/);
});

// ============================================ what a rollback must not strip,
// ============================================ claim, or contradict
//
// Everything above is about content the rollback DELETES. This section is about
// what it keeps: an entity that exists at both versions comes back, and the
// facts attached to it — who owns it, what format it is in, whose work is in
// the world — have to come back with it, or not be claimed at all.

test("B6 rollback: a player's item and NPC keep their owner, not just their house", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  // Three v1 entities the player acquired AFTER the expansion. All three exist
  // in the target, so none of them is in the rollback's way — which is exactly
  // why losing their owner was silent.
  const house = v1.structures[0].id, sword = v1.items[0].id, companion = v1.npcs[0].id;
  v2.structures.find((s) => s.id === house).owner_id = "u_player";
  v2.items.find((i) => i.id === sword).owner_id = "u_player";
  v2.npcs.find((n) => n.id === companion).owner_id = "u_player";

  const live = { ...emptyLiveState(), owned_entity_ids: [house], inventory_item_ids: [sword], known_npc_ids: [companion] };
  const { manifest: v3, record } = planRollback(v2, v1, { actorId: "u1", toVersion: 1, liveState: live });

  assert.equal(v3.structures.find((s) => s.id === house).owner_id, "u_player", "a rollback must not repossess a house");
  assert.equal(v3.items.find((i) => i.id === sword).owner_id, "u_player", "nor confiscate an item");
  assert.equal(v3.npcs.find((n) => n.id === companion).owner_id, "u_player", "nor reassign an NPC");

  assert.deepEqual(
    record.ownership_preserved.map((o) => o.id).sort(),
    [house, sword, companion].sort(),
    "and the record must not affirm the house while saying nothing about the other two",
  );
  assert.deepEqual([...new Set(record.ownership_preserved.map((o) => o.owner_id))], ["u_player"]);
  assert.equal(verifyPreservation(v2, v3, live).ok, true, JSON.stringify(verifyPreservation(v2, v3, live).problems));
});

test("B6 rollback: an owner erased on a surviving entity is caught by the preservation check", async () => {
  // Belt and braces: if the restoration above were ever dropped, this is the
  // check that has to refuse rather than ship a world with an owner missing.
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const sword = v1.items[0].id;
  v2.items.find((i) => i.id === sword).owner_id = "u_player";

  const { manifest: v3 } = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });
  const stripped = structuredClone(v3);
  stripped.items.find((i) => i.id === sword).owner_id = undefined;

  const { ok, problems } = verifyPreservation(v2, stripped);
  assert.equal(ok, false, "a rollback that returned an item with no owner must not verify");
  assert.ok(problems.some((p) => p.code === "ownership_changed" && p.entity === sword));
});

// ---------------------------------------------------------- the two counters

test("B6 rollback: a version number from the repository's counter is not refused as a wrong snapshot", async () => {
  // The repository advances its RECORD version on every accepted save, a
  // state-only save (publishing) included, while the manifest's own
  // world_version only moves on a content change. Save, expand, publish, expand
  // and the two are permanently one apart: the version GET /versions offers as
  // 3 holds a manifest that calls itself v2. Comparing the caller's 3 against
  // the manifest's 2 as if they were one number refused a rollback to a version
  // the server itself had just offered — a 422 blaming the caller for the
  // server's own numbering.
  //
  // The counter is declared, never guessed: "roll back to v7 of a world that
  // has only ever had two versions" is indistinguishable from a retained-record
  // number, and must keep being refused.
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");     // record 3 after a publish in between
  const v3 = expand(v2, "add an airport");              // record 4

  const { manifest: v4, record } = planRollback(v3, v2, { actorId: "u1", toVersion: 3, versionCounter: "record" });
  // And undeclared, because a number equal to the version the world is already
  // at cannot be naming an earlier one: it can only have come from the counter
  // that runs ahead.
  const undeclared = planRollback(v3, v2, { actorId: "u1", toVersion: 3 }).record;
  assert.equal(undeclared.to_version, 2);
  assert.equal(undeclared.to_version_counter, "record");

  assert.equal(v4.world_version, 4);
  assert.equal(record.to_version, 2, "the chronicle records the version the manifest actually is");
  assert.equal(record.to_version_asked, 3, "and the number the caller asked for, so the two can be reconciled");
  assert.equal(record.to_version_counter, "record");
  assert.equal(record.to_manifest_hash, manifestHash(v2), "and the snapshot itself, which belongs to no counter");
});

test("B6 rollback: an undeclared counter is the manifest's own, and is still held to it exactly", async () => {
  // A caller that asked for v2 and fetched v1 is wrong, and a caller that asked
  // for a version this world has never had is wrong. Neither is quietly reread
  // as a number from the other counter.
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  assert.throws(
    () => planRollback(v3, v1, { actorId: "u1", toVersion: 2 }),
    (e) => e.httpStatus === 422 && /is v1, not the v2 that was asked for/.test(e.detail),
  );
  assert.throws(
    () => planRollback(v3, v1, { actorId: "u1", toVersion: 7 }),
    (e) => e.httpStatus === 422 && /is v1, not the v7 that was asked for/.test(e.detail),
  );
});

test("B6 rollback: an assertion in the repository's counter refuses a manifest later than the number asked for", async () => {
  // The record counter runs AHEAD of the manifest's own, never behind, so a
  // manifest whose world_version exceeds the retained number it was fetched by
  // is not the snapshot that number names.
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");
  assert.throws(
    () => planRollback(v3, v2, { actorId: "u1", toVersion: 1, versionCounter: "record" }),
    (e) => e.httpStatus === 422 && /is v2, which is later than the v1 that was asked for/.test(e.detail),
  );
});

test("B6 rollback: the snapshot can be asserted by hash, which belongs to neither counter", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const v3 = expand(v2, "add an airport");

  const { record } = planRollback(v3, v2, { actorId: "u1", toVersion: 3, versionCounter: "record", toManifestHash: manifestHash(v2) });
  assert.equal(record.to_manifest_hash, manifestHash(v2));

  assert.throws(
    () => planRollback(v3, v2, { actorId: "u1", toManifestHash: manifestHash(v1) }),
    (e) => e.httpStatus === 422 && /not the snapshot that was asked for/.test(e.detail),
  );
  assert.throws(
    () => planRollback(v3, v2, { actorId: "u1", versionCounter: "retained" }),
    (e) => e.httpStatus === 422 && /versionCounter must be one of/.test(e.detail),
  );
});

// ------------------------------------------------- the format of the content

test("B6 rollback: crossing a manifest migration restores the format with the content, and records it", async () => {
  const v1 = await world();
  v1.manifest_version = "3.0.0";
  v1.expansion.compatibility = { min_runtime: "3.0.0", migrated_from: "1.0.0" };
  const v2 = expand(v1, "add a hospital district");
  v2.manifest_version = "3.1.0";                                              // migrated at v2
  v2.expansion.compatibility = { min_runtime: "3.1.0", migrated_from: "3.0.0" };

  const { manifest: v3, record } = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });

  assert.equal(v3.manifest_version, "3.0.0", "the restored content is 3.0.0 content");
  assert.deepEqual(
    v3.expansion.compatibility, { min_runtime: "3.0.0", migrated_from: "1.0.0" },
    "so it must not carry a compatibility block demanding a newer runtime and naming itself as what it migrated FROM",
  );
  assert.equal(validateManifest(v3).ok, true);

  // And the format regression is on the record, not silent.
  assert.deepEqual(record.manifest_version_restored, { from: "3.1.0", to: "3.0.0", min_runtime: "3.0.0" });
  assert.deepEqual(rollbackHistoryOf(v3).at(-1).manifest_version_restored, { from: "3.1.0", to: "3.0.0", min_runtime: "3.0.0" });
  assert.deepEqual(rollbackMemoryEvent(record).detail.manifest_version_restored, { from: "3.1.0", to: "3.0.0", min_runtime: "3.0.0" });
});

test("B6 rollback: a rollback that crosses no migration says nothing about the format", async () => {
  const v1 = await world();
  const v2 = expand(v1, "add a hospital district");
  const { manifest: v3, record } = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });
  assert.equal("manifest_version_restored" in record, false, "there was no format change to report");
  assert.equal(v3.manifest_version, v1.manifest_version);
  assert.deepEqual(v3.expansion.compatibility, v1.expansion.compatibility);
});

test("B6 rollback: a target whose own format contradicts itself is refused, not repaired", async () => {
  const v1 = await world();
  v1.manifest_version = "3.0.0";
  v1.expansion.compatibility = { min_runtime: "3.2.0", migrated_from: null };   // incoherent on its own terms
  const v2 = expand(v1, "add a hospital district");

  assert.throws(
    () => planRollback(v2, v1, { actorId: "u1", toVersion: 1 }),
    (e) => e.httpStatus === 409 && /declares manifest_version 3\.0\.0 while its own compatibility demands a 3\.2\.0 runtime/.test(e.detail),
  );
});

// ----------------------------------------------------- credit is not content

test("B6 rollback: past a stitch the counts go with the content, and the credit stays", async () => {
  const v1 = await world();
  const guest = await world("A neon city", "w_rollback_guest");
  const { delta, stitch } = planStitch(
    { world_id: "w_rollback", owner_id: "u1", state: "draft", version: 1, manifest: v1 },
    { world_id: "w_rollback_guest", owner_id: "u2", state: "published", version: 1, manifest: guest },
    { stitcherId: "u1" },
  );
  const v2 = recordStitch(applyDelta(v1, delta).manifest, stitch);
  const contributed = Object.values(stitch.counts).reduce((a, b) => a + b, 0);
  assert.ok(contributed > 0, "the fixture needs the guest to have contributed something");
  assert.equal(stitchSummary(v2).part_count, 2);

  const { manifest: v3 } = planRollback(v2, v1, { actorId: "u1", toVersion: 1 });

  const leftBehind = ["zones", "structures", "npcs", "items", "quests", "behaviors", "interactions", "assets"]
    .reduce((n, c) => n + (v3[c] || []).filter((e) => String(e.id).startsWith(stitch.namespace)).length, 0);
  assert.equal(leftBehind, 0, "precondition: the rollback removed every guest entity");

  // The claim about CONTENT goes with the content, in the manifest itself...
  assert.deepEqual(v3.expansion.stitched_from[0].counts, {}, "a count of entities must not outlive the entities");
  assert.equal(v3.expansion.stitched_from[0].content_present, false);
  assert.deepEqual(v3.expansion.stitched_from[0].counts_at_stitch, stitch.counts, "what arrived on the day is still recorded, named as such");

  // ...and in what any dashboard, listing or provenance view reads.
  const summary = stitchSummary(v3);
  assert.equal(Object.values(summary.parts[0].contributed).reduce((a, b) => a + b, 0), 0);
  assert.equal(summary.part_count, 0, "nothing of the guest is left for the world to be made of");

  // The CREDIT survives: the stitch happened, and u2's name stays on it.
  assert.equal(summary.is_stitched, true);
  assert.equal(summary.parts[0].creator, "u2");
  assert.deepEqual(summary.parts[0].contributed_at_stitch, stitch.counts);
  assert.deepEqual(v3.meta.stitched_attribution, v2.meta.stitched_attribution, "attribution is credit, and credit is not content");
  assert.equal(validateManifest(v3).ok, true);
});

test("B6 rollback: a stitch whose content is still there keeps its counts untouched", async () => {
  // The correction is a recount, not a purge: rolling back to a version that
  // still contains the guest must leave the record exactly as it was.
  const v1 = await world();
  const guest = await world("A neon city", "w_rollback_guest2");
  const { delta, stitch } = planStitch(
    { world_id: "w_rollback", owner_id: "u1", state: "draft", version: 1, manifest: v1 },
    { world_id: "w_rollback_guest2", owner_id: "u1", state: "draft", version: 1, manifest: guest },
    { stitcherId: "u1" },
  );
  const v2 = recordStitch(applyDelta(v1, delta).manifest, stitch);
  const v3 = expand(v2, "add an airport");

  const { manifest: v4 } = planRollback(v3, v2, { actorId: "u1", toVersion: 2 });
  assert.deepEqual(v4.expansion.stitched_from, v2.expansion.stitched_from, "the guest's content is still here, so its record is untouched");
  assert.equal(stitchSummary(v4).part_count, 2);
});
