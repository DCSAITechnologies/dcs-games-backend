// Lane J — full regression and adversarial sweep over the surfaces that were
// integrated fast: livestate, playerprogress, the keyed mutex, the durable
// collection, the world store's listing sidecar and version gating, and the
// expansion stack (fork / stitch / rollback / diff / delta).
//
// Every feature here was tested ALONE and passed. This file tests them
// TOGETHER, because that is where the estate disagrees with itself: a world
// that is forked, then stitched, then rolled back; a rollback whose versions
// span a manifest migration; a listing cache that is asked about a world that
// no longer exists; a version whose visibility depends on a field the listing
// projection does not carry.
//
// CONVENTION, the same one test/adversarial-evolution.test.mjs uses: a test
// titled "DEFECT, OPEN" FAILS ON PURPOSE. Lane J does not own src/, so a hole
// found there is recorded as a failing test carrying the reproduction and the
// file+line where the fix belongs, rather than patched across an ownership
// boundary or weakened into a green assertion. Everything else passes, and is
// the proof that the attack it names was tried and held.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createKeyedMutex } from "../src/core/mutex.mjs";
import { createCollection } from "../src/core/collection.mjs";
import {
  FileWorldStore, MirroredWorldStore, SupabaseWorldStore,
  VersionHistoryStore, WorldRepository,
} from "../src/core/worldstore.mjs";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { applyDelta, emptyLiveState } from "../src/v3/expansion/delta.mjs";
import { planExpansion } from "../src/v3/expansion/planner.mjs";
import { planRollback } from "../src/v3/expansion/rollback.mjs";
import { planStitch, recordStitch, stitchSummary } from "../src/v3/expansion/stitch.mjs";
import { forkWorld, attributionChain } from "../src/v3/expansion/fork.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";
import { createLiveStateService, mergeLiveState, COVERAGE } from "../src/core/livestate.mjs";
import { createPlayerProgressService, playerProgressSources } from "../src/core/playerprogress.mjs";
import { createSubscriptionsService } from "../src/core/subscriptions.mjs";
import { createSocialService } from "../src/core/social.mjs";
import { createProgressionService } from "../src/core/progression.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };
const tmp = (p = "dcs-sweep-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real, schema-valid v3 manifest, generated offline so no provider is called. */
async function world(worldId = "w_sweep", creatorId = "creator-a", prompt = "A small nordic port town") {
  return (await createAssemblyRouter(OFFLINE).assemble({ prompt, worldId, creatorId })).manifest;
}
const rec = (worldId, manifest, owner = "creator-a", state = "published") => ({
  world_id: worldId, owner_id: owner, state, version: manifest.world_version ?? 1, manifest,
});
const expand = (m, request, author = "creator-a") =>
  applyDelta(m, planExpansion(m, { request, author })).manifest;

/** A fresh repository, its store and its version history, over a throwaway dir. */
function repository(prefix = "dcs-sweep-repo-") {
  const dir = tmp(prefix);
  const worldsDir = path.join(dir, "worlds");
  const store = new FileWorldStore(worldsDir);
  return {
    dir, worldsDir, store,
    versions: new VersionHistoryStore(path.join(dir, "world-versions")),
    repo: new WorldRepository(store, new VersionHistoryStore(path.join(dir, "world-versions"))),
  };
}
/** A minimal record shaped like the ones FileWorldStore holds. */
const tinyManifest = (title) => ({ manifest_version: "3.1.0", meta: { title, genre: "rpg" }, media: { thumbnail_ref: "t_" + title } });

// =============================================================================
// 1. CROSS-FEATURE INTERACTIONS — each feature was tested alone; these are the
//    combinations nobody ran.
// =============================================================================

test("a world that is forked, expanded, stitched and then rolled back stays coherent", async () => {
  // Four features in one chronology. The world must remain a valid
  // WorldManifestV3, the version counter must only move forward, the chronology
  // must be append-only across all four steps, and the fork attribution must
  // survive the rollback that removed the content it arrived with.
  const source = await world("w_x_src", "creator-a");
  const { manifest: forked } = forkWorld(rec("w_x_src", source), { forkerId: "creator-b", newWorldId: "w_x_fork" });
  assert.equal(forked.world_version, 1);
  assert.deepEqual(forked.expansion.history, [], "a fork starts with its own, empty chronology");

  const v1 = forked;
  let cur = expand(forked, "add a hospital district", "creator-b");
  assert.equal(cur.world_version, 2);

  const guest = await world("w_x_guest", "creator-c");
  const { delta, stitch } = planStitch(
    rec("w_x_fork", cur, "creator-b"), rec("w_x_guest", guest, "creator-c"), { stitcherId: "creator-b" });
  cur = recordStitch(applyDelta(cur, delta).manifest, stitch);
  assert.equal(cur.world_version, 3);
  assert.equal(validateManifest(cur).ok, true, "the stitched fork must still be a valid v3 manifest");

  const rb = planRollback(cur, v1, { actorId: "creator-b", toVersion: 1 });
  assert.equal(rb.manifest.world_version, 4, "a rollback moves the counter forward, never back");
  assert.deepEqual(
    rb.manifest.expansion.history.map((h) => h.version), [2, 3, 4],
    "the chronology keeps the expansion and the stitch and gains the rollback"
  );
  assert.equal(validateManifest(rb.manifest).ok, true);
  // Credit survives content: the fork attribution and the root creator are still named.
  assert.ok(rb.manifest.meta.forked_from, "the fork attribution survives a rollback");
  assert.equal(attributionChain(rb.manifest).original_creator, "creator-a");
  // And no guest entity is left behind in the restored content.
  const guestLeftovers = ["zones", "structures", "npcs", "items", "assets", "behaviors", "interactions", "quests"]
    .flatMap((c) => (rb.manifest[c] || []).filter((e) => String(e.id).startsWith(stitch.namespace)));
  assert.equal(guestLeftovers.length, 0, "rolling back past a stitch must not strand namespaced guest entities");
});

test("DEFECT, OPEN: after a rollback past a stitch the world still advertises the guest's content", async () => {
  // DEFECT, OPEN (found by this file). planRollback rebuilds the restored
  // manifest's `expansion` from the CURRENT version wholesale
  // (src/v3/expansion/rollback.mjs:280-287):
  //     const expansion = structuredClone(current.expansion || {});
  //     next.expansion = { ...expansion, compatibility, history: [...] };
  // `expansion.stitched_from` therefore survives untouched, including its
  // `counts` block — "this guest contributed 6 zones, 14 structures, 9 npcs".
  // The rollback has just DELETED every one of those entities. stitchSummary()
  // (src/v3/expansion/stitch.mjs:439-455) reads only that record, so it reports
  // is_stitched:true, part_count:2 and a contributed count for content the
  // manifest no longer contains, and there is nothing in the manifest a reader
  // could consult to discover otherwise.
  //
  // This is not the "credit is not content" rule that deliberately preserves
  // meta.stitched_attribution: a name in an attribution list is a credit, but a
  // per-collection count of entities is a claim ABOUT THE CONTENT, and it is now
  // false. A creator's dashboard, a marketplace listing or an Atlas provenance
  // view built on stitchSummary will tell a viewer that a third creator's work
  // is in this world when none of it is.
  //
  // Fix belongs in src/v3/expansion/rollback.mjs:280-287: when rebuilding
  // next.expansion, mark or drop each stitched_from entry whose namespaced
  // entities the restored manifest no longer contains (the namespace is on the
  // record), or have stitchSummary (src/v3/expansion/stitch.mjs:439) count what
  // the manifest actually holds rather than what the record claimed.
  const source = await world("w_x2_src", "creator-a");
  const { manifest: v1 } = forkWorld(rec("w_x2_src", source), { forkerId: "creator-b", newWorldId: "w_x2" });
  const v2 = expand(v1, "add a hospital district", "creator-b");
  const guest = await world("w_x2_guest", "creator-c");
  const { delta, stitch } = planStitch(rec("w_x2", v2, "creator-b"), rec("w_x2_guest", guest, "creator-c"), { stitcherId: "creator-b" });
  const v3 = recordStitch(applyDelta(v2, delta).manifest, stitch);

  const { manifest: v4 } = planRollback(v3, v1, { actorId: "creator-b", toVersion: 1 });

  const stillThere = ["zones", "structures", "npcs", "items"]
    .reduce((n, c) => n + (v4[c] || []).filter((e) => String(e.id).startsWith(stitch.namespace)).length, 0);
  assert.equal(stillThere, 0, "precondition: the rollback removed every guest entity");

  const summary = stitchSummary(v4);
  const claimed = Object.values(summary.parts[0]?.contributed || {}).reduce((a, b) => a + b, 0);
  assert.equal(
    claimed, 0,
    `stitchSummary claims ${claimed} entities contributed by '${stitch.guest_world_id}' that the rollback deleted; ` +
    "a content count must not outlive the content. Fix: src/v3/expansion/rollback.mjs:280-287 (prune or mark " +
    "expansion.stitched_from when the restored manifest no longer contains the namespace) or " +
    "src/v3/expansion/stitch.mjs:439 (count what the manifest holds)."
  );
});

test("DEFECT, OPEN: a rollback across a manifest migration produces a manifest that contradicts itself", async () => {
  // DEFECT, OPEN (found by this file). planRollback takes the restored CONTENT
  // from the target (`next = structuredClone(target)`, rollback.mjs:214) — and
  // `manifest_version` is part of that content — but takes `expansion` from the
  // CURRENT version (rollback.mjs:280-283), including
  // `expansion.compatibility { min_runtime, migrated_from }`.
  //
  // So a world generated at 3.0.0 and migrated to 3.1.0 at v2, rolled back to
  // v1, comes out as:
  //     manifest_version: "3.0.0"
  //     expansion.compatibility: { min_runtime: "3.1.0", migrated_from: "3.0.0" }
  // A manifest that declares itself to be 3.0.0 while its own compatibility
  // block demands a 3.1.0 runtime and records that it was migrated FROM the
  // version it now claims to be. validateManifest passes it, so nothing
  // downstream notices; a runtime that dispatches on manifest_version loads it
  // as 3.0.0 against a 3.1.0 min_runtime, and WorldRepository stores the
  // regressed manifest_version on the record (worldstore.mjs:295) with nothing
  // recording that the world went backwards across a migration.
  //
  // Fix belongs in src/v3/expansion/rollback.mjs:280-287: `compatibility` must
  // be reconciled with the restored `manifest_version` — either carry the
  // current manifest_version forward (content restored, format not) or restore
  // the target's compatibility block alongside its manifest_version. The two
  // must not be taken from different versions.
  const v1 = await world("w_mig", "creator-a");
  v1.manifest_version = "3.0.0";
  v1.expansion.compatibility = { min_runtime: "3.0.0", migrated_from: "1.0.0" };
  const v2 = expand(v1, "add a hospital district");
  v2.manifest_version = "3.1.0";                                        // migrated at v2
  v2.expansion.compatibility = { min_runtime: "3.1.0", migrated_from: "3.0.0" };

  const { manifest: v3 } = planRollback(v2, v1, { actorId: "creator-a", toVersion: 1 });

  const declared = String(v3.manifest_version).split(".").map(Number);
  const demanded = String(v3.expansion.compatibility.min_runtime).split(".").map(Number);
  const meetsItsOwnRuntime = declared[0] > demanded[0] || (declared[0] === demanded[0] && declared[1] >= demanded[1]);
  assert.ok(
    meetsItsOwnRuntime,
    `the restored manifest declares manifest_version ${JSON.stringify(v3.manifest_version)} while its own ` +
    `expansion.compatibility demands min_runtime ${JSON.stringify(v3.expansion.compatibility.min_runtime)} ` +
    `and records migrated_from ${JSON.stringify(v3.expansion.compatibility.migrated_from)}. ` +
    "Fix: src/v3/expansion/rollback.mjs:280-287 — manifest_version and expansion.compatibility must come from " +
    "the same version."
  );
});

test("DEFECT, OPEN: publishing a world makes a retained version that rollback can never target", async () => {
  // DEFECT, OPEN (found by this file). There are TWO version counters and the
  // API mixes them:
  //   * WorldRepository._upsert increments the RECORD version on every accepted
  //     save (src/core/worldstore.mjs:292), including a save that only changes
  //     `state` — which is exactly what publishing is;
  //   * the manifest carries its own `world_version`, which only applyDelta and
  //     the migrator advance.
  // Publish a world and the two diverge permanently: record v3 holds a manifest
  // that still says world_version 2.
  //
  // GET /v3/worlds/:id/versions lists the RECORD numbers (worldstore.mjs:239,
  // server.mts:1309). POST /v3/worlds/:id/rollback is handed that number as
  // `to_version`, fetches the retained record, and then stamps the manifest's
  // OWN world_version in preference to the record's (server.mts:1348-1355) —
  // whereupon planRollback's assertion (src/v3/expansion/rollback.mjs:168)
  // compares the record number the caller asked for against the manifest number
  // it got and refuses:
  //     "the manifest supplied is v2, not the v3 that was asked for"
  // A 422 that blames the caller for the server's own numbering, on a version
  // the server itself just offered. Reproduced below with no route involved:
  // save, expand, publish, expand, then try to roll back to the version the
  // history lists.
  //
  // Fix belongs in src/core/worldstore.mjs:292 (do not advance the retained
  // version for a state-only change, or record the manifest's world_version on
  // the retained entry so the two can be reconciled) and server.mts:1348-1355
  // (`stamp` must not prefer the manifest's world_version over the record
  // version it was fetched by).
  const { repo } = repository();
  const m1 = await world("w_pub", "o");
  await repo.upsert({ worldId: "w_pub", ownerId: "o", manifest: m1, state: "draft" });        // record 1 / manifest 1
  const m2 = expand(m1, "add a hospital district", "o");
  await repo.upsert({ worldId: "w_pub", ownerId: "o", manifest: m2, state: "draft" });        // record 2 / manifest 2
  await repo.upsert({ worldId: "w_pub", ownerId: "o", manifest: m2, state: "published" });    // record 3 / manifest 2  <- publish
  const m3 = expand(m2, "add an airport", "o");
  await repo.upsert({ worldId: "w_pub", ownerId: "o", manifest: m3, state: "published" });    // record 4 / manifest 3

  const listed = (await repo.listVersions("w_pub", { requesterId: "o" })).map((v) => v.version);
  assert.deepEqual(listed, [1, 2, 3, 4], "precondition: the history offers four versions");

  const current = await repo.get("w_pub", { requesterId: "o" });
  const target = await repo.getVersion("w_pub", 3, { requesterId: "o" });
  // Exactly what server.mts:1348-1355 does before calling planRollback.
  const stamp = (m, v) => ({ ...m, world_id: m?.world_id ?? "w_pub", world_version: Number.isInteger(m?.world_version) && m.world_version >= 1 ? m.world_version : v });

  let refusal = null;
  try {
    planRollback(stamp(current.manifest, Number(current.version)), stamp(target.manifest, Number(target.version)),
      { actorId: "o", toVersion: 3, liveState: emptyLiveState() });
  } catch (e) { refusal = e; }

  assert.equal(
    refusal, null,
    "rolling back to a version the history itself lists must not be refused. " +
    `It was refused with ${refusal?.httpStatus} "${refusal?.detail}" because the record version (3) and the ` +
    "manifest's world_version (2) are different counters. Fix: src/core/worldstore.mjs:292 and server.mts:1348-1355."
  );
});

test("a stitch into a world that has retained draft versions does not expose them", async () => {
  // Retained history is not flattened by a later stitch: the versions saved
  // while the host was a draft stay private to its owner, and the stitch does
  // not give a stranger a way in through the version API.
  const { repo } = repository();
  const host = await world("w_sd_host", "o");
  await repo.upsert({ worldId: "w_sd_host", ownerId: "o", manifest: host, state: "draft" });
  const host2 = expand(host, "add a market square", "o");
  await repo.upsert({ worldId: "w_sd_host", ownerId: "o", manifest: host2, state: "published" });

  const guest = await world("w_sd_guest", "o2");
  await repo.upsert({ worldId: "w_sd_guest", ownerId: "o2", manifest: guest, state: "published" });

  const hrec = await repo.get("w_sd_host", { requesterId: "o" });
  const grec = await repo.get("w_sd_guest", { requesterId: "o" });
  const { delta } = planStitch(hrec, grec, { stitcherId: "o" });
  const joined = applyDelta(hrec.manifest, delta).manifest;
  await repo.upsert({ worldId: "w_sd_host", ownerId: "o", manifest: joined, state: "published" });

  assert.deepEqual((await repo.listVersions("w_sd_host", { requesterId: "o" })).map((v) => v.version), [1, 2, 3],
    "the owner still sees every retained version after the stitch");
  await assert.rejects(() => repo.getVersion("w_sd_host", 1, { requesterId: "stranger" }),
    (e) => e.httpStatus === 404, "the draft-era version stays private after the world is stitched and published");
  await assert.rejects(() => repo.getVersion("w_sd_host", 1, { requesterId: null }),
    (e) => e.httpStatus === 404, "and anonymous is not a way around it");
});

test("subscriptions, social and progression report one answer for one principal", async () => {
  // Three services read the same subscription. Round-3 had social hardcoding
  // dcs_plus:false while subscriptions reported the comped grant, so /me said 1
  // publish credit and /entitlements said 10. This walks a grant and a
  // revocation and requires all three to agree at every step, and requires the
  // money fact to stay false in every one of them.
  const env = { DCS_DATA_DIR: tmp("dcs-sweep-triple-") };
  const subs = createSubscriptionsService(env);
  const social = createSocialService(env, { isBlocked: async () => false, subscriptions: subs });
  const progression = createProgressionService({ social });
  const me = { id: "u_triple", email: "u_triple@example.com", isInternalTester: true };

  const before = await social.me(me);
  const entBefore = await subs.entitlementsFor(me.id, { level: before.level, publishedCount: before.worlds_published });
  assert.equal(before.subscription.plan, "free");
  assert.equal(before.publish_credits, entBefore.entitlements[0].value, "free-plan credits must agree before any grant");

  await subs.grantTestPlan(me, me, "dcs_plus", { reason: "internal sweep" });
  const after = await social.me(me);
  const entAfter = await subs.entitlementsFor(me.id, { level: after.level, publishedCount: after.worlds_published });
  assert.equal(after.subscription.plan, "dcs_plus");
  assert.equal(after.publish_credits, entAfter.entitlements[0].value, "a comped grant must raise the same allowance in both services");
  assert.equal(after.subscription.dcs_plus_paid, false);
  assert.equal(after.economy.dcs_plus, false, "a comped grant is never revenue");
  assert.equal(entAfter.dcs_plus_paid, false);
  assert.equal((await subs.listGrants()).revenue_minor, 0);

  // Progression reads social, which reads subscriptions. It must not fall over
  // or invent an achievement from a plan.
  const ach = await progression.achievements(me.id, []);
  assert.equal(ach.achievements.every((a) => !a.unlocked), true, "no achievement is unlocked by a subscription");

  await subs.revokeTestPlan(me, me.id);
  const afterRevoke = await social.me(me);
  const entRevoke = await subs.entitlementsFor(me.id, { level: afterRevoke.level, publishedCount: afterRevoke.worlds_published });
  assert.equal(afterRevoke.subscription.plan, "free");
  assert.equal(afterRevoke.publish_credits, entRevoke.entitlements[0].value, "and they must agree again after a revocation");
  assert.deepEqual(await subs.assertDark(), { dark: true, problems: [] });
});

test("player progress observed by the server is a real hold that refuses a rollback", async () => {
  // The whole point of livestate + playerprogress: the rollback guarantee stops
  // being opt-in by the caller it protects against. An NPC the SERVER served
  // dialogue for becomes a hold, the rollback that would delete it is refused
  // by name, and a client cannot subtract that hold by supplying its own
  // live_state.
  const env = { DCS_DATA_DIR: tmp("dcs-sweep-hold-") };
  const progress = createPlayerProgressService({ env });
  const liveState = createLiveStateService({ sources: playerProgressSources({ progress }) });

  const v1 = await world("w_hold", "creator-a");
  const v2 = expand(v1, "add a hospital district");
  const newNpc = (v2.npcs || []).find((n) => !(v1.npcs || []).some((x) => x.id === n.id));
  assert.ok(newNpc, "the fixture needs an NPC that exists only at v2");

  const player = { id: "player-sweep" };
  await progress.recordWorldEntry({ principal: player, worldId: "w_hold", manifest: v2 });
  await progress.recordNpcDialogueServed({
    principal: player, worldId: "w_hold", npcId: newNpc.id, manifest: v2, lines: { npc: { id: newNpc.id } },
  });

  const determined = await liveState.liveStateFor("w_hold");
  assert.ok(determined.live_state.known_npc_ids.includes(newNpc.id));
  assert.equal(determined.nothing_held, false);
  assert.equal(determined.complete, false, "these sources are PARTIAL, so the guarantee is never reported as complete");

  assert.throws(
    () => planRollback(v2, v1, { actorId: "creator-a", toVersion: 1, liveState: determined.live_state }),
    (e) => e.httpStatus === 409 && e.detail.includes(newNpc.id),
    "a rollback that would delete an NPC a player has met must be refused by name"
  );

  // A client cannot clear the hold by sending an empty category.
  const merged = mergeLiveState(determined.live_state, { known_npc_ids: [], visited_zone_ids: [] });
  assert.ok(merged.live_state.known_npc_ids.includes(newNpc.id), "client evidence is additive only; it can never remove a hold");
  // Nor by sending a key nothing reads.
  const withJunk = mergeLiveState(determined.live_state, { totally_made_up: ["x"] });
  assert.deepEqual(withJunk.ignored_keys, ["totally_made_up"]);
});

test("a live-state source that cannot be read never becomes 'nothing is held'", async () => {
  // The load-bearing rule of livestate.mjs. One source answering does not make
  // up for another that did not: the silent one may be holding the house.
  const good = { name: "ok", covers: { known_npc_ids: COVERAGE.AVAILABLE }, status: () => COVERAGE.AVAILABLE, async read() { return { known_npc_ids: [] }; } };
  const broken = { name: "boom", covers: { known_npc_ids: COVERAGE.AVAILABLE }, status: () => COVERAGE.AVAILABLE, async read() { throw new Error("store down"); } };

  const bothOk = await createLiveStateService({ sources: [good] }).liveStateFor("w");
  assert.equal(bothOk.coverage.known_npc_ids.status, COVERAGE.AVAILABLE);

  const degraded = await createLiveStateService({ sources: [good, broken] }).liveStateFor("w");
  assert.notEqual(degraded.coverage.known_npc_ids.status, COVERAGE.AVAILABLE, "a failed source costs the category its AVAILABLE status");
  assert.equal(degraded.nothing_held, false, "an unreadable source is never reported as an empty hold set");
  assert.equal(degraded.complete, false);
  assert.match(degraded.note, /NOT determined/);
});

test("a world deleted and re-created under the same id serves the new card, not the old one", async () => {
  // The sidecar is keyed by world id and survives nothing but a delete. If the
  // delete missed it, discovery would show a dead world's title, owner and
  // thumbnail under a live world's id.
  const { store, repo, worldsDir } = repository();
  await repo.upsert({ worldId: "w_rr", ownerId: "owner-one", manifest: tinyManifest("First"), state: "published" });
  assert.ok(fs.existsSync(path.join(worldsDir, "w_rr.summary.json")), "precondition: the sidecar exists");
  await store.delete("w_rr");
  assert.equal(fs.existsSync(path.join(worldsDir, "w_rr.summary.json")), false, "delete must take the sidecar with the record");

  await repo.upsert({ worldId: "w_rr", ownerId: "owner-two", manifest: tinyManifest("Second"), state: "published" });
  const cards = await store.list({ summary: true });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].owner_id, "owner-two");
  assert.equal(cards[0].title, "Second");
  assert.equal(cards[0].version, 1, "a re-created world starts again at version 1, not at the dead world's version");
});

test("ensure() racing upsert() on the same row produces exactly one row", async () => {
  // The two atomic paths through createCollection, pointed at the same row at
  // the same time. They share the collection's lock key, so neither may see a
  // stale snapshot and no write may erase the other.
  const c = createCollection({ dir: tmp("dcs-sweep-coll-"), name: "race_" + Math.random().toString(36).slice(2), primaryKey: ["k"], env: {} });
  const results = await Promise.all([
    ...Array.from({ length: 32 }, () => c.ensure((r) => r.k === "x", () => ({ k: "x", from: "ensure" }))),
    ...Array.from({ length: 32 }, () => c.upsert((r) => r.k === "x", { k: "x", from: "upsert" })),
  ]);
  const rows = (await c.all()).filter((r) => r.k === "x");
  assert.equal(rows.length, 1, "64 concurrent find-or-writes must leave exactly one row");
  assert.equal(results.filter((r) => r && r.created === true).length, 1, "exactly one caller may be told it created the row");
});

// =============================================================================
// 2. THE LISTING SIDECAR CACHE — FileWorldStore.list({summary:true}).
//    The record is supposed to be the truth and the sidecar only ever a cache
//    of it. Every test here asks whether that actually holds.
// =============================================================================

test("DEFECT, OPEN: a corrupt sidecar deletes a published world from discovery", async () => {
  // DEFECT, OPEN (found by this file). src/core/worldstore.mjs:99-123 wraps the
  // WHOLE per-world body in one `try { ... } catch { /* skip */ }`, and the
  // sidecar read sits inside it:
  //     r = JSON.parse(await fsp.readFile(sp, "utf8"));      // :111
  // A sidecar that will not parse therefore throws past the `else` branch that
  // exists to repair it and lands in the outer catch, whose comment is "a
  // half-written temp file is not a world; skip". The world is skipped. Its
  // record is intact and list({summary:false}) still returns it — only the
  // cached path loses it, which is the path /v3/discover and every dashboard
  // uses (worldstore.mjs:366).
  //
  // This is reachable without touching the disk by hand: the repair on :115 is
  // `await fsp.writeFile(sp, ...)` — NOT the tmp+rename every other write in
  // this file uses (compare :70-72 and :77-80). Two concurrent list() calls
  // repairing the same stale sidecar interleave into a truncated file, and from
  // then on the world is invisible in discovery until something rewrites the
  // record. A cache miss must degrade to the source of truth; here it deletes
  // the row.
  //
  // Fix belongs in src/core/worldstore.mjs:104-116: give the sidecar read its
  // own try/catch that falls through to the record on any failure, and make the
  // repair write on :115 atomic (tmp + rename) like put() on :77-80.
  const { store, repo, worldsDir } = repository();
  await repo.upsert({ worldId: "w_corrupt", ownerId: "o", manifest: tinyManifest("Real World"), state: "published" });
  fs.writeFileSync(path.join(worldsDir, "w_corrupt.summary.json"), '{"world_id":"w_corr');   // truncated, as an interleaved repair leaves it

  const full = await store.list({ state: "published" });
  assert.deepEqual(full.map((r) => r.world_id), ["w_corrupt"], "precondition: the record is intact");

  const cards = await store.list({ state: "published", summary: true });
  assert.deepEqual(
    cards.map((r) => r.world_id), ["w_corrupt"],
    "a corrupt CACHE must fall back to the record, not remove a published world from discovery. " +
    "Fix: src/core/worldstore.mjs:104-116 — isolate the sidecar read and make the repair write atomic."
  );
});

test("DEFECT, OPEN: the state filter trusts the sidecar, so a sidecar can publish a draft", async () => {
  // DEFECT, OPEN (found by this file). src/core/worldstore.mjs:120-121 applies
  // the ownerId and state filters to `r` — which, on the summary path, is the
  // SIDECAR, not the record:
  //     if (ownerId && r.owner_id !== ownerId) continue;
  //     if (state   && r.state    !== state)   continue;
  // listPublished() (worldstore.mjs:366) is the discovery feed and passes
  // state:"published", summary:true. So the question "is this world published?"
  // — a permission question, and the only thing standing between a private
  // draft and the public catalogue — is answered by a cache file, while the
  // record that actually holds the answer is never opened. The same line makes
  // owner_id, which the dashboard filters on, equally cache-controlled.
  //
  // The sidecar is treated as authoritative whenever its mtime is not older
  // than the record's (:110), so nothing detects a sidecar whose CONTENT
  // disagrees with the record: there is no hash, no version and no owner
  // cross-check against the record it claims to summarise.
  //
  // Fix belongs in src/core/worldstore.mjs:104-121 — apply the state and
  // ownerId filters to the record, or make the sidecar carry the record's
  // manifest_hash and verify it before the cached row is trusted.
  const { store, repo, worldsDir } = repository();
  await repo.upsert({ worldId: "w_leak", ownerId: "victim", manifest: tinyManifest("Unfinished Draft"), state: "draft" });
  const sidecarPath = path.join(worldsDir, "w_leak.summary.json");
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  assert.equal(sidecar.state, "draft", "precondition: the cache agrees with the record");
  fs.writeFileSync(sidecarPath, JSON.stringify({ ...sidecar, state: "published" }));

  const published = await store.list({ state: "published", summary: true });
  assert.deepEqual(
    published.map((r) => r.world_id), [],
    "a draft must not reach the published listing because a CACHE file says it is published; " +
    "the record still says draft. Fix: src/core/worldstore.mjs:104-121 — filter on the record, or verify the " +
    "sidecar against the record's manifest_hash."
  );
});

test("DEFECT, OPEN: two writes inside one mtime tick serve the stale card forever", async () => {
  // DEFECT, OPEN (found by this file). The freshness test is
  // src/core/worldstore.mjs:110:
  //     if (rs && ss && ss.mtimeMs >= rs.mtimeMs) { use the sidecar }
  // `>=` means "equal timestamps count as fresh", which is the right call for
  // put()'s own two writes and the wrong one for everybody else's. Filesystem
  // mtime granularity is not guaranteed to be finer than the gap between two
  // writes — 1ms on many ext4 configurations and coarser on some container
  // overlay filesystems — and put() writes the record and the sidecar back to
  // back with nothing in between (:68-81). Any path that updates the record
  // without updating the sidecar in the same call, landing in the same tick,
  // pins a stale card that no later list() will ever repair, because the
  // condition can only be re-triggered by a NEWER record write.
  //
  // Forced deterministically below with utimes rather than left to the host
  // clock, so the assertion tests the comparison rather than the hardware.
  //
  // Fix belongs in src/core/worldstore.mjs:110: compare something that cannot
  // collide — store the record's manifest_hash (or its version) in the sidecar
  // and require it to match — rather than trusting an mtime ordering the
  // filesystem does not promise.
  const { store, repo, worldsDir } = repository();
  await repo.upsert({ worldId: "w_tick", ownerId: "o", manifest: tinyManifest("V1"), state: "published" });
  await sleep(5);
  await repo.upsert({ worldId: "w_tick", ownerId: "o", manifest: tinyManifest("V2"), state: "published" });

  const recordPath = path.join(worldsDir, "w_tick.json");
  const sidecarPath = path.join(worldsDir, "w_tick.summary.json");
  const stale = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
  fs.writeFileSync(sidecarPath, JSON.stringify({ ...stale, title: "V1", version: 1 }));
  const sameTick = new Date(1788700000000);
  fs.utimesSync(recordPath, sameTick, sameTick);
  fs.utimesSync(sidecarPath, sameTick, sameTick);

  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(record.version, 2, "precondition: the record is at version 2");

  const [card] = await store.list({ summary: true });
  assert.equal(
    card.version, 2,
    `the record is at v${record.version} titled ${JSON.stringify(record.title)} and the cache served ` +
    `v${card.version} titled ${JSON.stringify(card.title)}; an equal mtime is not evidence of freshness. ` +
    "Fix: src/core/worldstore.mjs:110 — validate the sidecar against the record's manifest_hash."
  );
});

test("a sidecar with no record behind it never becomes a world", async () => {
  // Two halves of the same question, both of which must hold: an orphaned
  // sidecar left by a partial delete, and a sidecar invented for an id that has
  // never existed. list() enumerates RECORDS and skips *.summary.json, so
  // neither can conjure a discovery row.
  const { store, repo, worldsDir } = repository();
  await repo.upsert({ worldId: "w_orphan", ownerId: "o", manifest: tinyManifest("Deleted"), state: "published" });
  await fsp.rm(path.join(worldsDir, "w_orphan.json"));                       // record gone, sidecar left behind
  fs.writeFileSync(path.join(worldsDir, "ghost.summary.json"), JSON.stringify({
    world_id: "ghost", owner_id: "attacker", state: "published", title: "Ghost", version: 99, _summary: true,
  }));

  assert.deepEqual((await store.list({ summary: true })).map((r) => r.world_id), [],
    "neither an orphaned sidecar nor an invented one may appear in discovery");
  assert.deepEqual((await store.list({})).map((r) => r.world_id), []);
  assert.equal(await store.get("ghost"), null, "and get() must not read a sidecar as a world");
});

test("a sidecar older than its record is repaired from the record", async () => {
  // The case the mtime check was written for: a crash between put()'s two
  // writes. The record is the truth and the cache is rebuilt from it.
  const { store, repo, worldsDir } = repository();
  await repo.upsert({ worldId: "w_stale", ownerId: "o", manifest: tinyManifest("V1"), state: "published" });
  const recordPath = path.join(worldsDir, "w_stale.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  await sleep(15);
  fs.writeFileSync(recordPath, JSON.stringify({ ...record, title: "V2", version: 2 }));   // record only, as a crash leaves it

  const [card] = await store.list({ summary: true });
  assert.equal(card.title, "V2", "a sidecar older than its record must not be served");
  assert.equal(card.version, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(worldsDir, "w_stale.summary.json"), "utf8")).title, "V2",
    "and the cache is repaired from the record rather than left stale");
});

test("DEFECT, OPEN: with a primary store configured, discovery serves whole manifests", async () => {
  // DEFECT, OPEN (found by this file). listPublished's contract is on the tin
  // (src/core/worldstore.mjs:365-366): "Discovery cards only — the manifest is
  // NOT included in full", and it passes summary:true to get them. That option
  // is dropped twice on the deployed path:
  //   * MirroredWorldStore.list (worldstore.mjs:190-194) forwards opts to the
  //     PRIMARY and returns its answer whenever it is non-empty;
  //   * SupabaseWorldStore.list (worldstore.mjs:158) does not accept `summary`
  //     at all — it is `select=*`.
  // So the moment SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set — which is
  // the production configuration, createWorldRepository:375 — every discovery
  // card carries the entire manifest again. The measured cliff the sidecar was
  // built to remove (6ms at 1 world, 908ms at 200, per the comment on :43-50) is
  // untouched in the only deployment that matters, and the local file store is
  // the only place the optimisation exists.
  //
  // Fix belongs in src/core/worldstore.mjs:158 (a `summary` projection —
  // PostgREST supports `select=` column lists — or an explicit refusal) and
  // :190-194 (MirroredWorldStore must not silently drop an option that changes
  // the shape of what it returns).
  const dir = tmp("dcs-sweep-mirror-");
  const shadow = new FileWorldStore(path.join(dir, "worlds"));
  const heavy = { ...tinyManifest("Heavy"), structures: Array.from({ length: 40 }, (_, i) => ({ id: "s" + i, blob: "x".repeat(200) })) };
  const fetchImpl = async (_u, o) => (o?.method === "POST"
    ? { ok: true, status: 200, json: async () => [{}] }
    : {
      ok: true, status: 200, json: async () => [{
        world_id: "w_mir", owner_id: "o", title: "Heavy", state: "published", version: 1,
        manifest: heavy, manifest_hash: "h", manifest_version: "3.1.0",
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
      }],
    });
  const mirrored = new MirroredWorldStore(new SupabaseWorldStore({ url: "https://example.invalid", serviceRoleKey: "k", fetchImpl }), shadow);
  const repo = new WorldRepository(mirrored, new VersionHistoryStore(path.join(dir, "world-versions")));
  await repo.upsert({ worldId: "w_mir", ownerId: "o", manifest: heavy, state: "published" });

  const [card] = await repo.listPublished();
  assert.equal(
    (card.manifest?.structures || []).length, 0,
    `a discovery card carried ${(card.manifest?.structures || []).length} structures and ` +
    `${JSON.stringify(card).length} bytes; the file-backed path returns a ~300 byte summary for the same world. ` +
    "Fix: src/core/worldstore.mjs:158 and :190-194 — the summary option must survive the mirrored/primary path."
  );
});

// =============================================================================
// 3. VERSION VISIBILITY — a retained version is gated on the state it was
//    SAVED IN, so publishing a world does not retroactively publish its drafts.
// =============================================================================

test("DEFECT, OPEN: listVersions hides published versions that getVersion hands out", async () => {
  // DEFECT, OPEN (found by this file). WorldRepository._versionVisible
  // (src/core/worldstore.mjs:338-341) decides on `v.state`:
  //     if (world.owner_id != null && world.owner_id === requesterId) return true;
  //     return v.state === "published";
  // getVersion (:351) reads the whole retained record, which HAS `state`
  // (written by _upsert on :310). listVersions (:344) reads
  // VersionHistoryStore.list, whose projection is:
  //     out.push({ version, manifest_hash, label, created_by, created_at })   // :239
  // `state` is not in it. So every row listVersions filters is `state:
  // undefined`, the check falls through to `undefined === "published"`, and a
  // non-owner is told a published world has NO history at all — while
  // GET /v3/worlds/:id/versions/:n (server.mts:1313) happily returns any of
  // those same versions to the same caller.
  //
  // Two answers to one question, and the deniable one is the listing: version
  // history, provenance and the diff UI are empty for everyone but the owner on
  // a fully published world, and it reads as "this world has no history"
  // rather than as an error.
  //
  // Fix belongs in src/core/worldstore.mjs:239 — carry `state: r.state ?? null`
  // in the projection, so the listing gate reads the same field the single-
  // version gate does.
  const { repo } = repository();
  await repo.upsert({ worldId: "w_vis", ownerId: "o", manifest: tinyManifest("A"), state: "published" });
  await repo.upsert({ worldId: "w_vis", ownerId: "o", manifest: tinyManifest("B"), state: "published" });

  assert.deepEqual((await repo.listVersions("w_vis", { requesterId: "o" })).map((v) => v.version), [1, 2],
    "precondition: the owner sees both");
  const single = await repo.getVersion("w_vis", 1, { requesterId: "stranger" });
  assert.equal(single.state, "published", "precondition: getVersion hands v1 to a stranger, because it was published");

  const listed = (await repo.listVersions("w_vis", { requesterId: "stranger" })).map((v) => v.version);
  assert.deepEqual(
    listed, [1, 2],
    "a stranger who may FETCH each published version must be able to LIST them. listVersions returned " +
    `${JSON.stringify(listed)} because VersionHistoryStore.list drops the state field. ` +
    "Fix: src/core/worldstore.mjs:239 — include `state` in the projection."
  );
});

test("unpublishing a world withdraws its retained versions from strangers", async () => {
  // The permission check runs on the world FIRST (worldstore.mjs:345, :352), so
  // a world taken back to draft takes its history with it — there is no path
  // that keeps answering from the version store after the world stops being
  // readable.
  const { repo } = repository();
  await repo.upsert({ worldId: "w_unpub", ownerId: "o", manifest: tinyManifest("A"), state: "published" });
  await repo.upsert({ worldId: "w_unpub", ownerId: "o", manifest: tinyManifest("B"), state: "published" });
  const v1 = await repo.getVersion("w_unpub", 1, { requesterId: "stranger" });
  assert.equal(v1.version, 1, "precondition: a published world's published version is readable");

  await repo.upsert({ worldId: "w_unpub", ownerId: "o", manifest: tinyManifest("C"), state: "draft" });   // unpublished
  await assert.rejects(() => repo.getVersion("w_unpub", 1, { requesterId: "stranger" }), (e) => e.httpStatus === 404);
  await assert.rejects(() => repo.listVersions("w_unpub", { requesterId: "stranger" }), (e) => e.httpStatus === 404);
  await assert.rejects(() => repo.listVersions("w_unpub", { requesterId: null }), (e) => e.httpStatus === 404);
  assert.equal((await repo.listVersions("w_unpub", { requesterId: "o" })).length, 3, "the owner keeps their whole history");
});

test("a retained version saved before the state field existed is treated as private", async () => {
  // History is append-only, so an old row cannot be amended to say what state it
  // was written in. A version with no provable state must therefore be private,
  // not public-by-default.
  const { dir, repo } = repository();
  const versions = new VersionHistoryStore(path.join(dir, "world-versions"));
  await repo.upsert({ worldId: "w_old", ownerId: "o", manifest: tinyManifest("Now"), state: "published" });
  // A row as an older build wrote it: no `state` key at all.
  await versions.put("w_old", 7, {
    world_id: "w_old", version: 7, manifest: tinyManifest("Ancient"), manifest_hash: "old", created_at: "2026-01-01T00:00:00Z",
  });

  await assert.rejects(() => repo.getVersion("w_old", 7, { requesterId: "stranger" }),
    (e) => e.httpStatus === 404, "no recorded state is not evidence of publication");
  await assert.rejects(() => repo.getVersion("w_old", 7, { requesterId: null }), (e) => e.httpStatus === 404);
  assert.equal((await repo.getVersion("w_old", 7, { requesterId: "o" })).version, 7, "the owner can still reach their own history");
});

test("a draft version of a published world is the owner's alone", async () => {
  // The case the state field was added for: publishing must not retroactively
  // publish the drafts the world passed through.
  const { repo } = repository();
  await repo.upsert({ worldId: "w_mix", ownerId: "o", manifest: tinyManifest("Private draft"), state: "draft" });
  await repo.upsert({ worldId: "w_mix", ownerId: "o", manifest: tinyManifest("Public"), state: "published" });

  assert.equal((await repo.getVersion("w_mix", 1, { requesterId: "o" })).manifest.meta.title, "Private draft");
  await assert.rejects(() => repo.getVersion("w_mix", 1, { requesterId: "stranger" }), (e) => e.httpStatus === 404);
  await assert.rejects(() => repo.getVersion("w_mix", 1, { requesterId: null }), (e) => e.httpStatus === 404);
  assert.equal((await repo.getVersion("w_mix", 2, { requesterId: "stranger" })).version, 2, "the published version stays readable");
});

// =============================================================================
// 4. THE KEYED MUTEX — it now serialises every store write on this estate, so
//    a deadlock in it is a hung server, not a failed request.
// =============================================================================

test("a holder that throws does not deadlock the key", async () => {
  const withLock = createKeyedMutex();
  await assert.rejects(() => withLock("k", async () => { throw new Error("boom"); }));
  const after = await Promise.race([withLock("k", async () => "ok"), sleep(500).then(() => "DEADLOCK")]);
  assert.equal(after, "ok", "the queue must survive a holder that throws");

  // And a long queue of throwers must not poison the ones behind them.
  const settled = await Promise.allSettled(
    Array.from({ length: 100 }, (_, i) => withLock("k", async () => { await sleep(0); if (i % 2) throw new Error("x"); return i; }))
  );
  assert.equal(settled.filter((r) => r.status === "fulfilled").length, 50);
  assert.equal(await Promise.race([withLock("k", async () => "still alive"), sleep(500).then(() => "DEADLOCK")]), "still alive");
});

test("one key hammered by many callers never interleaves and never loses a write", async () => {
  const withLock = createKeyedMutex();
  let shared = 0, inside = 0, maxInside = 0;
  await Promise.all(Array.from({ length: 256 }, () => withLock("k", async () => {
    inside++; maxInside = Math.max(maxInside, inside);
    const seen = shared;
    await sleep(0);                       // the read-modify-write window
    shared = seen + 1;
    inside--;
  })));
  assert.equal(maxInside, 1, "two holders must never be inside the same key at once");
  assert.equal(shared, 256, "256 concurrent read-modify-writes must all land");
});

test("holders on one key run in the order they arrived", async () => {
  const withLock = createKeyedMutex();
  const order = [];
  await Promise.all([1, 2, 3, 4, 5].map((i) => withLock("k", async () => { await sleep(5 * (6 - i)); order.push(i); })));
  assert.deepEqual(order, [1, 2, 3, 4, 5], "the queue is FIFO, so a slow early write cannot be overtaken");
});

test("unrelated keys genuinely do not block each other", async () => {
  const withLock = createKeyedMutex();
  const started = Date.now();
  const slow = withLock("A", async () => { await sleep(250); return "A"; });
  const waited = await withLock("B", async () => Date.now() - started);
  assert.ok(waited < 100, `a write to key B waited ${waited}ms behind a 250ms write to key A; keys must be independent`);
  assert.equal(await slow, "A");

  // Same property through the real collection API: two collections, one slow.
  const dir = tmp("dcs-sweep-keys-");
  const a = createCollection({ dir, name: "slow_" + Math.random().toString(36).slice(2), primaryKey: ["k"], env: {} });
  const b = createCollection({ dir, name: "fast_" + Math.random().toString(36).slice(2), primaryKey: ["k"], env: {} });
  const t0 = Date.now();
  const slowInsert = a.ensure((r) => r.k === "x", async () => { await sleep(200); return { k: "x" }; });
  await b.insert({ k: "y" });
  const bDone = Date.now() - t0;
  await slowInsert;
  assert.ok(bDone < 100, `a write to a second collection waited ${bDone}ms behind a slow write to the first`);
});

test("the lock is NOT reentrant, and every real caller stays outside that hazard", async () => {
  // Documented, deliberate and permanent: collection.mjs:186-188 tells a caller
  // that `build` may READ the collection but must not WRITE to it. Pinning the
  // consequence here so that a future caller who tries it finds this test rather
  // than a hung process. Raced against a timeout so this file can never hang.
  const withLock = createKeyedMutex();
  const nested = await Promise.race([
    withLock("k", async () => await withLock("k", async () => "inner")).then(() => "COMPLETED"),
    sleep(300).then(() => "blocked"),
  ]);
  assert.equal(nested, "blocked", "taking the same key twice deadlocks — no caller may do it");
  assert.equal(
    await Promise.race([withLock("a", async () => await withLock("b", async () => "inner")), sleep(300).then(() => "DEADLOCK")]),
    "inner", "different keys nest freely");

  // The one place the estate actually nests: ensureProfile's build() READS the
  // same collection it is inserting into (src/core/social.mjs:229-235 through
  // buildProfileRow's username-collision check). Reads are unlocked, so this
  // must complete rather than deadlock.
  const social = createSocialService({ DCS_DATA_DIR: tmp("dcs-sweep-prof-") }, { isBlocked: async () => false });
  const profiled = await Promise.race([
    social.ensureProfile({ id: "p_nested", email: "p_nested@example.com" }),
    sleep(2000).then(() => "DEADLOCK"),
  ]);
  assert.equal(profiled.principal_id, "p_nested", "a build() that reads its own collection must not deadlock");
});

test("a build() that throws inside ensure() releases the collection lock", async () => {
  const c = createCollection({ dir: tmp("dcs-sweep-build-"), name: "b_" + Math.random().toString(36).slice(2), primaryKey: ["k"], env: {} });
  await assert.rejects(() => c.ensure((r) => r.k === "x", async () => { throw new Error("build failed"); }));
  const after = await Promise.race([c.ensure((r) => r.k === "x", () => ({ k: "x" })), sleep(1000).then(() => "DEADLOCK")]);
  assert.equal(after.created, true, "a failed build must not wedge the collection");
  assert.equal((await c.all()).length, 1, "and must not leave a half-written row behind");
});

test("128 simultaneous first sign-ins create one profile", async () => {
  // The measured regression createCollection.ensure() exists for. Kept here as
  // a cross-check that the fix survives alongside everything else in this sweep.
  const dir = tmp("dcs-sweep-signin-");
  const social = createSocialService({ DCS_DATA_DIR: dir }, { isBlocked: async () => false });
  await Promise.all(Array.from({ length: 128 }, () => social.ensureProfile({ id: "p1", email: "p1@example.com" })));
  const rows = JSON.parse(fs.readFileSync(path.join(dir, "social", "principals.json"), "utf8"));
  assert.equal(rows.filter((r) => r.principal_id === "p1").length, 1);
});

// =============================================================================
// 5. WHAT THE LOCK DOES NOT COVER — every check-then-write that was left
//    outside it. The lock serialises the WRITE; it does not make a read
//    followed by a write atomic, and three capacity rules depend on exactly
//    that.
// =============================================================================

test("DEFECT, OPEN: a party's size limit is bypassed by joining concurrently", async () => {
  // DEFECT, OPEN (found by this file). src/core/social.mjs:486-509 is
  // check-then-write:
  //     const p = await svc.getParty(partyId);        // unlocked read
  //     ...
  //     if (p.size >= p.max_size) throw ...           // decided on that read
  //     await partyMembers.insert({...});             // the write is locked; the DECISION is not
  // Every concurrent joiner reads the same size and all of them pass the check.
  // createCollection.ensure() exists for precisely this shape and is documented
  // as such (src/core/collection.mjs:176-188) — "the gap between the read and
  // the insert is a window, and every concurrent caller passes through it" —
  // but joinParty does not use it.
  //
  // max_size is a product rule with a real bound (createParty rejects anything
  // over 64, social.mjs:472), and a party is the shared room the block check on
  // :500-508 is trying to police: an over-full party is also a party whose
  // membership was never checked against the size the leader chose.
  //
  // Fix belongs in src/core/social.mjs:486-509: take the membership decision
  // inside one atomic step — partyMembers.ensure() with the capacity test in
  // the build, or a keyed lock on the party id around the read and the insert.
  const social = createSocialService({ DCS_DATA_DIR: tmp("dcs-sweep-party-") }, { isBlocked: async () => false });
  const party = await social.createParty("leader", { maxSize: 2 });
  await Promise.allSettled(Array.from({ length: 8 }, (_, i) => social.joinParty("member-" + i, party.id)));
  const after = await social.getParty(party.id);
  assert.ok(
    after.size <= 2,
    `a party with max_size 2 ended up with ${after.size} members after 8 concurrent joins. ` +
    "Fix: src/core/social.mjs:486-509 — decide capacity inside the same atomic step as the insert."
  );
});

test("DEFECT, OPEN: an org's seat limit is bypassed by adding members concurrently", async () => {
  // DEFECT, OPEN (found by this file). The same shape, one capability along:
  // src/core/social.mjs:668-686
  //     const o = await svc.getOrg(orgId, meId);      // unlocked read
  //     if (o.seats_remaining <= 0) throw ...         // decided on that read
  //     await orgMembers.insert({...});
  // Seats are the only enforced limit an org has — the module says so on :707
  // ("Seats are enforced as a capacity limit") and setOrgSeats refuses to
  // shrink below the member count on :711-714 specifically so members are never
  // silently dropped to fit. Both of those protections are defeated by two
  // concurrent adds: the org lands above its seat count, and the owner then
  // cannot reduce it back without removing people.
  //
  // Fix belongs in src/core/social.mjs:668-686 — the seat check and the
  // membership insert must be one atomic step, as createCollection.ensure()
  // provides (src/core/collection.mjs:189).
  const social = createSocialService({ DCS_DATA_DIR: tmp("dcs-sweep-org-") }, { isBlocked: async () => false });
  const org = await social.createOrg("owner", { name: "Acme Interactive", seats: 2 });
  await Promise.allSettled(Array.from({ length: 8 }, (_, i) => social.addOrgMember("owner", org.id, "u" + i)));
  const after = await social.getOrg(org.id, "owner");
  assert.ok(
    after.seats_used <= 2,
    `an org with 2 seats ended up with ${after.seats_used} members after 8 concurrent adds. ` +
    "Fix: src/core/social.mjs:668-686 — the seat check and the insert must be one atomic step."
  );
});

test("DEFECT, OPEN: concurrent friend requests create many rows for one relationship", async () => {
  // DEFECT, OPEN (found by this file). src/core/social.mjs:398-415 is
  // one()-then-insert():
  //     const existing = await friends.one(...);      // unlocked read
  //     if (existing) { ... }
  //     return await friends.insert({ user_id: meId, friend_id: otherId, ... });
  // The collection's declared primary key for `friends` is
  // ["user_id", "friend_id"] (social.mjs:63), so these rows are duplicates of a
  // key the store believes is unique. Two things follow, and they disagree with
  // each other:
  //   * locally the file keeps all of them, so friendList() (social.mjs:437)
  //     reports one person N times in `outgoing`;
  //   * with Supabase configured, collection.write() upserts on that same
  //     primary key (src/core/collection.mjs:69-77), so N-1 of them vanish on
  //     the next write and the two backings hold different data.
  // acceptFriend then updates only the FIRST matching row (social.mjs:425), so
  // the rest stay "requested" forever and keep appearing as pending.
  //
  // A client that loads several panels at once issues several of these, which
  // is the same traffic pattern that produced 128 profile rows for one
  // principal — the case ensure() was added for.
  //
  // Fix belongs in src/core/social.mjs:398-415 — use friends.ensure() on the
  // pair predicate rather than one() followed by insert().
  const social = createSocialService({ DCS_DATA_DIR: tmp("dcs-sweep-friend-") }, { isBlocked: async () => false });
  await Promise.allSettled(Array.from({ length: 16 }, () => social.requestFriend("alice", "bob")));
  const list = await social.friendList("alice");
  assert.equal(
    list.outgoing.length, 1,
    `16 concurrent friend requests produced ${list.outgoing.length} rows for one relationship, against a declared ` +
    "primary key of (user_id, friend_id). Fix: src/core/social.mjs:398-415 — use friends.ensure()."
  );
});

test("a block stops a friendship forming through every path", async () => {
  // The Round-3 hole, re-attacked from the sequence that opened it: request
  // first, block second, accept third. And the pending row must not survive.
  const blocked = new Set();
  const social = createSocialService(
    { DCS_DATA_DIR: tmp("dcs-sweep-block-") },
    { isBlocked: async (a, b) => blocked.has(a + ">" + b) || blocked.has(b + ">" + a) },
  );
  await social.requestFriend("alice", "bob");
  blocked.add("bob>alice");

  await assert.rejects(() => social.acceptFriend("bob", "alice"), (e) => e.httpStatus === 403);
  await assert.rejects(() => social.acceptFriend("alice", "bob"), (e) => e.httpStatus === 403 || e.httpStatus === 404);
  await assert.rejects(() => social.requestFriend("alice", "bob"), (e) => e.httpStatus === 403);
  assert.equal(await social.areFriends("alice", "bob"), false);
  assert.deepEqual((await social.friendList("alice")).outgoing, [], "the stale request is dropped, not left pending forever");

  // A party is a shared room, so it is closed too.
  const party = await social.createParty("bob");
  await assert.rejects(() => social.joinParty("alice", party.id), (e) => e.httpStatus === 403);

  // A block check cannot be constructed away.
  assert.throws(() => createSocialService({ DCS_DATA_DIR: tmp("dcs-sweep-nocheck-") }, { isBlocked: null }),
    (e) => e.httpStatus === 422, "an explicit non-function block check is a startup error, never a silent skip");
});
