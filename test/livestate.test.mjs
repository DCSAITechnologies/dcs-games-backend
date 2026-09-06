// B2 — reading player-held state from the stores that actually exist.
//
// The claim under test is narrow and load-bearing: this service may report
// "nothing is held" ONLY when it genuinely looked at every category and found
// nothing. Everywhere else it must say "I could not tell", because a rollback
// acts on the difference and the wrong answer deletes a player's things.
//
// So the tests below fall into four groups:
//   1. real holds come out of real stored rows
//   2. an unavailable or failing source reports UNKNOWN, never empty
//   3. a world with no activity is DISTINGUISHABLE from a world it could not read
//   4. client-supplied state can only ever ADD
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CATEGORIES,
  COVERAGE,
  createLiveStateService,
  cw5RuntimeStateSource,
  companionMemorySource,
  nullQuestProgressSource,
  nullNpcAcquaintanceSource,
  mergeLiveState,
} from "../src/core/livestate.mjs";
import { emptyLiveState } from "../src/v3/expansion/delta.mjs";
import { createCompanionService } from "../src/v3/companion/companion.mjs";

const tmpEnv = () => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-ls-")) });

/**
 * A stand-in for the CW5 persistence engine.
 *
 * Injected rather than imported because `src/cw5/*.ts` uses TypeScript
 * parameter properties, which Node's strip-only type support refuses; the real
 * engine is exercised separately below when tsx is loaded.
 */
function fakePersistence(snapshotsByWorld) {
  return {
    async load(worldId) {
      if (!(worldId in snapshotsByWorld)) throw new Error(`load: base world ${worldId} not found`);
      const s = snapshotsByWorld[worldId];
      if (s instanceof Error) throw s;
      return s;
    },
  };
}

const snapshot = ({ objects = [], inventories = {} } = {}) => ({
  world_id: "w", base_world_id: "w", as_of_seq: 1, ts: new Date().toISOString(),
  objects, inventories, npc_states: {}, economy: {}, vars: {},
});

// ============================================================ shape contract

test("B2 livestate: live_state is exactly the shape planRollback reads", async () => {
  const svc = createLiveStateService({ persistence: fakePersistence({ w1: snapshot() }), companions: null });
  const r = await svc.liveStateFor("w1");
  assert.deepEqual(Object.keys(r.live_state).sort(), Object.keys(emptyLiveState()).sort());
  for (const c of CATEGORIES) assert.ok(Array.isArray(r.live_state[c]), `${c} must be an array`);
  // The category list is derived from emptyLiveState, so the two cannot drift.
  assert.deepEqual(CATEGORIES.slice().sort(), Object.keys(emptyLiveState()).sort());
});

// ============================================ 1. real holds from real rows

test("B2 livestate: an owned object and an inventory item are found from stored runtime rows", async () => {
  const persistence = fakePersistence({
    w1: snapshot({
      objects: [
        { object_id: "struct_house", kind: "house", transform: {}, owner_id: "u_player" },
        { object_id: "struct_townhall", kind: "hall", transform: {}, owner_id: null },
      ],
      inventories: { u_player: [{ item_id: "it_key", qty: 1 }, { item_id: "it_1", qty: 3 }] },
    }),
  });
  const svc = createLiveStateService({ persistence, companions: null });
  const r = await svc.liveStateFor("w1");

  assert.deepEqual(r.live_state.owned_entity_ids, ["struct_house"]);
  assert.deepEqual(r.live_state.inventory_item_ids.sort(), ["it_1", "it_key"]);
  assert.equal(r.coverage.owned_entity_ids.status, COVERAGE.AVAILABLE);
  assert.equal(r.coverage.inventory_item_ids.status, COVERAGE.AVAILABLE);
  assert.deepEqual(r.coverage.owned_entity_ids.sources, ["cw5-runtime-state"]);
  assert.ok(r.determined.includes("owned_entity_ids"));
  assert.ok(r.determined.includes("inventory_item_ids"));
  assert.equal(r.held_total, 3);
});

test("B2 livestate: a world-owned object and an emptied inventory slot are NOT holds", async () => {
  // Inventing a hold is as damaging as missing one: it refuses a rollback the
  // creator is entitled to.
  const persistence = fakePersistence({
    w1: snapshot({
      objects: [{ object_id: "struct_townhall", kind: "hall", transform: {}, owner_id: null }],
      inventories: { u_player: [{ item_id: "it_gone", qty: 0 }] },
    }),
  });
  const r = await createLiveStateService({ persistence }).liveStateFor("w1");
  assert.deepEqual(r.live_state.owned_entity_ids, []);
  assert.deepEqual(r.live_state.inventory_item_ids, []);
  assert.equal(r.coverage.owned_entity_ids.status, COVERAGE.AVAILABLE, "it looked, and found nothing");
});

test("B2 livestate: companion memory refs come out of the real companion store", async () => {
  const env = tmpEnv();
  const companions = createCompanionService({ env });
  await companions.adopt("u_player", "w_real", { persona: "scout" });
  await companions.remember("u_player", "w_real", { text: "the smith gave me this", refs: ["npc_smith", "it_key"] });
  await companions.updateContext("u_player", "w_real", { zone: "zone_harbour" });

  // A companion in a DIFFERENT world must not leak into this world's holds.
  await companions.adopt("u_other", "w_elsewhere", {});
  await companions.remember("u_other", "w_elsewhere", { text: "not this world", refs: ["npc_stranger"] });

  const r = await createLiveStateService({ companions }).liveStateFor("w_real");
  assert.deepEqual(r.live_state.companion_memory_refs.sort(), ["it_key", "npc_smith"]);
  assert.ok(!r.live_state.companion_memory_refs.includes("npc_stranger"));
  assert.deepEqual(r.live_state.visited_zone_ids, ["zone_harbour"]);
  assert.equal(r.coverage.companion_memory_refs.status, COVERAGE.AVAILABLE);
});

test("B2 livestate: several players' companions in one world are all read", async () => {
  const env = tmpEnv();
  const companions = createCompanionService({ env });
  for (const [who, ref] of [["u_a", "npc_a"], ["u_b", "npc_b"], ["u_c", "npc_c"]]) {
    await companions.adopt(who, "w_many", {});
    await companions.remember(who, "w_many", { text: "met them", refs: [ref] });
  }
  const r = await createLiveStateService({ companions }).liveStateFor("w_many");
  assert.deepEqual(r.live_state.companion_memory_refs.sort(), ["npc_a", "npc_b", "npc_c"]);
});

test("B2 livestate: a leftover temp file in the companion store is ignored, not parsed", async () => {
  const env = tmpEnv();
  const companions = createCompanionService({ env });
  await companions.adopt("u_player", "w_tmp", {});
  await companions.remember("u_player", "w_tmp", { text: "real", refs: ["npc_real"] });
  // The store writes `<key>.json.tmp-xxxx` and renames; a crash leaves one behind.
  fs.writeFileSync(path.join(companions.dir, "junk.json.tmp-dead"), "{not json");

  const r = await createLiveStateService({ companions }).liveStateFor("w_tmp");
  assert.deepEqual(r.live_state.companion_memory_refs, ["npc_real"]);
  assert.equal(r.coverage.companion_memory_refs.status, COVERAGE.AVAILABLE);
});

test("B2 livestate: the real CW5 persistence engine, when it can be loaded", async (t) => {
  // The engine is TypeScript with parameter properties, so plain `node --test`
  // cannot import it. Under `node --import tsx --test` it loads and this runs
  // against the genuine append-only delta path rather than a stand-in.
  let cw5 = null;
  try { cw5 = await import("../src/cw5/cw5_persistence.ts"); } catch { /* strip-only mode */ }
  if (!cw5) return t.skip("CW5 engine needs tsx (TypeScript parameter properties)");

  const engine = new cw5.PersistenceEngine(new cw5.InMemoryPersistenceStore());
  await engine.registerBaseWorld({
    world_id: "w_cw5",
    objects: [{ object_id: "struct_1", kind: "hall", transform: {}, owner_id: null }],
  });
  await engine.save({
    world_id: "w_cw5", session_id: "s1", seq: 1, ts: new Date().toISOString(), actor_id: "u_player",
    ops: [
      { op: "place_object", object_id: "struct_shack", kind: "shack", transform: { x: 1, y: 0, z: 1 }, owner_id: "u_player" },
      { op: "set_inventory", player_id: "u_player", inventory: [{ item_id: "it_key", qty: 1 }] },
    ],
  });

  const r = await createLiveStateService({ persistence: engine }).liveStateFor("w_cw5");
  assert.deepEqual(r.live_state.owned_entity_ids, ["struct_shack"]);
  assert.deepEqual(r.live_state.inventory_item_ids, ["it_key"]);
  assert.ok(r.determined.includes("owned_entity_ids"));
});

// ================================ 2. an unavailable source is UNKNOWN, not empty

test("B2 livestate: with no persistence engine, ownership and inventory are UNKNOWN", async () => {
  const svc = createLiveStateService({ persistence: null, companions: null });
  const r = await svc.liveStateFor("w1");

  for (const c of ["owned_entity_ids", "inventory_item_ids"]) {
    assert.equal(r.coverage[c].status, COVERAGE.UNAVAILABLE);
    assert.ok(!r.determined.includes(c));
    const u = r.undetermined.find((x) => x.category === c);
    assert.ok(u, `${c} must be listed as undetermined`);
    assert.match(u.reason, /CW5 persistence engine/);
  }
  assert.equal(r.complete, false);
  assert.equal(r.nothing_held, false, "an unread source must never be reported as 'nothing is held'");
  assert.match(r.note, /not determined/i);
});

test("B2 livestate: a world the runtime store has never heard of is UNKNOWN, not empty", async () => {
  // Only POST /worlds/generate registers a base world, so a v3-created world
  // makes persistence.load() throw. That MUST NOT read as "nothing is held".
  const svc = createLiveStateService({ persistence: fakePersistence({ w_known: snapshot() }) });
  const r = await svc.liveStateFor("w_never_registered");

  assert.deepEqual(r.live_state.owned_entity_ids, []);
  assert.equal(r.coverage.owned_entity_ids.status, COVERAGE.UNAVAILABLE);
  assert.match(r.coverage.owned_entity_ids.reason, /base world w_never_registered not found/);
  assert.equal(r.nothing_held, false);
});

test("B2 livestate: a store outage is UNKNOWN, not empty", async () => {
  const svc = createLiveStateService({ persistence: fakePersistence({ w1: new Error("ECONNREFUSED supabase") }) });
  const r = await svc.liveStateFor("w1");
  assert.equal(r.coverage.inventory_item_ids.status, COVERAGE.UNAVAILABLE);
  assert.match(r.coverage.inventory_item_ids.reason, /ECONNREFUSED/);
  assert.equal(r.nothing_held, false);
});

test("B2 livestate: an unreadable companion file is UNKNOWN, not silently skipped", async () => {
  const env = tmpEnv();
  const companions = createCompanionService({ env });
  await companions.adopt("u_player", "w_bad", {});
  // A file that exists and cannot be parsed is a hold we cannot see.
  fs.writeFileSync(path.join(companions.dir, encodeURIComponent("u_broken::w_bad") + ".json"), "{ truncated");

  const r = await createLiveStateService({ companions }).liveStateFor("w_bad");
  assert.equal(r.coverage.companion_memory_refs.status, COVERAGE.UNAVAILABLE);
  assert.match(r.coverage.companion_memory_refs.reason, /companion-store/);
  assert.equal(r.nothing_held, false);
});

test("B2 livestate: the two categories with no store report UNAVAILABLE and refuse to answer", async () => {
  for (const src of [nullQuestProgressSource(), nullNpcAcquaintanceSource()]) {
    assert.equal(src.status(), COVERAGE.UNAVAILABLE);
    // It REFUSES rather than returning an empty set, exactly as
    // verification.mjs refuses with no delivery provider configured.
    await assert.rejects(() => src.read("w1"), (e) => {
      assert.equal(e.httpStatus, 503);
      assert.equal(e.code, "not_configured");
      return true;
    });
  }

  const r = await createLiveStateService({ persistence: fakePersistence({ w1: snapshot() }) }).liveStateFor("w1");
  assert.equal(r.coverage.completed_quest_ids.status, COVERAGE.UNAVAILABLE);
  assert.equal(r.coverage.known_npc_ids.status, COVERAGE.UNAVAILABLE);
  assert.match(r.coverage.completed_quest_ids.reason, /records a quest completion/);
  assert.match(r.coverage.known_npc_ids.reason, /met an NPC/);
  assert.deepEqual(r.live_state.completed_quest_ids, []);
  assert.deepEqual(r.live_state.known_npc_ids, []);
  assert.equal(r.complete, false, "two categories have no source, so nothing here is complete");
});

test("B2 livestate: a partial source contributes real ids but never claims the category", async () => {
  const env = tmpEnv();
  const companions = createCompanionService({ env });
  await companions.adopt("u_player", "w_p", {});
  await companions.updateContext("u_player", "w_p", { zone: "zone_docks" });

  const r = await createLiveStateService({ companions }).liveStateFor("w_p");
  assert.deepEqual(r.live_state.visited_zone_ids, ["zone_docks"], "the id is real and is reported");
  assert.equal(r.coverage.visited_zone_ids.status, COVERAGE.PARTIAL);
  assert.ok(!r.determined.includes("visited_zone_ids"), "one last_zone is not the set of zones visited");
  assert.match(r.undetermined.find((u) => u.category === "visited_zone_ids").reason, /not the whole set/);
});

// ======================= 3. no activity is DISTINGUISHABLE from cannot-tell

/** Every category covered completely, so `complete` can actually be reached. */
const completeSources = (rows = {}) => [{
  name: "test-complete-store",
  covers: Object.fromEntries(CATEGORIES.map((c) => [c, COVERAGE.AVAILABLE])),
  status: () => COVERAGE.AVAILABLE,
  async read() { return rows; },
}];

const brokenSources = () => [{
  name: "test-broken-store",
  covers: Object.fromEntries(CATEGORIES.map((c) => [c, COVERAGE.AVAILABLE])),
  status: () => COVERAGE.AVAILABLE,
  async read() { throw new Error("the store did not answer"); },
}];

test("B2 livestate: a world with no activity reports nothing_held, and a world it could not read does not", async () => {
  const quiet = await createLiveStateService({ sources: completeSources({}) }).liveStateFor("w_quiet");
  const unreadable = await createLiveStateService({ sources: brokenSources() }).liveStateFor("w_dark");

  // The live_state itself is IDENTICAL — six empty arrays. That is exactly why
  // a caller must not be left to judge safety from it.
  assert.deepEqual(quiet.live_state, unreadable.live_state);
  assert.deepEqual(quiet.live_state, emptyLiveState());

  assert.equal(quiet.nothing_held, true);
  assert.equal(quiet.complete, true);
  assert.deepEqual(quiet.determined.sort(), CATEGORIES.slice().sort());
  assert.match(quiet.note, /nothing is held/);

  assert.equal(unreadable.nothing_held, false);
  assert.equal(unreadable.complete, false);
  assert.deepEqual(unreadable.determined, []);
  assert.equal(unreadable.undetermined.length, CATEGORIES.length);
  assert.match(unreadable.note, /not evidence that nothing is held/);
});

test("B2 livestate: a world with no recorded activity at all is safe to ask about", async () => {
  const env = tmpEnv();
  const companions = createCompanionService({ env });          // no companion has ever been adopted
  const persistence = fakePersistence({ w_new: snapshot() });  // registered, no deltas
  const r = await createLiveStateService({ persistence, companions }).liveStateFor("w_new");

  assert.deepEqual(r.live_state, emptyLiveState());
  assert.equal(r.held_total, 0);
  // The categories that DO have a store looked and found nothing; the two with
  // no store are still reported as unknown rather than folded into the silence.
  assert.deepEqual(r.determined.sort(), ["companion_memory_refs", "inventory_item_ids", "owned_entity_ids"]);
  assert.deepEqual(r.undetermined.map((u) => u.category).sort(), ["completed_quest_ids", "known_npc_ids", "visited_zone_ids"]);
  assert.equal(r.nothing_held, false, "three categories were not checked, so 'nothing is held' cannot be claimed");
});

test("B2 livestate: it refuses to be asked about no world at all", async () => {
  const svc = createLiveStateService({});
  await assert.rejects(() => svc.liveStateFor(""), (e) => e.httpStatus === 422);
  await assert.rejects(() => svc.liveStateFor(null), (e) => e.httpStatus === 422);
});

// =================================================================== describe

test("B2 livestate: describe() names what cannot be checked, in words", async () => {
  const env = tmpEnv();
  const d = createLiveStateService({
    persistence: fakePersistence({}),
    companions: createCompanionService({ env }),
  }).describe();

  assert.equal(d.categories.owned_entity_ids.coverage, COVERAGE.AVAILABLE);
  assert.equal(d.categories.companion_memory_refs.coverage, COVERAGE.AVAILABLE);
  assert.equal(d.categories.visited_zone_ids.coverage, COVERAGE.PARTIAL);
  assert.equal(d.categories.completed_quest_ids.coverage, COVERAGE.UNAVAILABLE);
  assert.equal(d.categories.known_npc_ids.coverage, COVERAGE.UNAVAILABLE);
  assert.match(d.note, /completed_quest_ids/);
  assert.match(d.note, /known_npc_ids/);
  assert.match(d.note, /visited_zone_ids/);
  assert.match(d.caveat, /process-memory/);
  assert.equal(d.sources.find((s) => s.name === "quest-progress:none").status, COVERAGE.UNAVAILABLE);
});

test("B2 livestate: describe() with no store at all claims nothing", async () => {
  const d = createLiveStateService({}).describe();
  for (const c of CATEGORIES) assert.equal(d.categories[c].coverage, COVERAGE.UNAVAILABLE, c);
  assert.match(d.note, /cannot be fully guaranteed/);
});

// ======================================= 4. client evidence is ADDITIVE only

test("B2 livestate: mergeLiveState adds client evidence to the server's own", () => {
  const server = { ...emptyLiveState(), owned_entity_ids: ["struct_house"] };
  const { live_state, added } = mergeLiveState(server, { completed_quest_ids: ["q_1"], owned_entity_ids: ["struct_barn"] });

  assert.deepEqual(live_state.owned_entity_ids.sort(), ["struct_barn", "struct_house"]);
  assert.deepEqual(live_state.completed_quest_ids, ["q_1"]);
  assert.deepEqual(added.completed_quest_ids, ["q_1"]);
  assert.deepEqual(added.owned_entity_ids, ["struct_barn"]);
});

test("B2 livestate: a client CANNOT remove a hold the server found", () => {
  const server = { ...emptyLiveState(), owned_entity_ids: ["struct_house"], inventory_item_ids: ["it_key"] };

  // Every shape of "please forget about that" a caller might try.
  for (const attempt of [
    {},
    null,
    undefined,
    { owned_entity_ids: [] },
    { owned_entity_ids: null },
    { owned_entity_ids: "struct_house" },
    { ...emptyLiveState() },
    { owned_entity_ids: ["struct_house"], inventory_item_ids: [] },
  ]) {
    const { live_state } = mergeLiveState(server, attempt);
    assert.ok(live_state.owned_entity_ids.includes("struct_house"), `removed by ${JSON.stringify(attempt)}`);
    assert.ok(live_state.inventory_item_ids.includes("it_key"), `removed by ${JSON.stringify(attempt)}`);
  }
});

test("B2 livestate: merged output keeps exactly the six categories and ignores anything else", () => {
  const { live_state, ignored_keys } = mergeLiveState(emptyLiveState(), {
    owned_entity_ids: ["a"], not_a_category: ["b"], __proto__: ["c"],
  });
  assert.deepEqual(Object.keys(live_state).sort(), Object.keys(emptyLiveState()).sort());
  assert.ok(ignored_keys.includes("not_a_category"));
  assert.equal(live_state.owned_entity_ids.length, 1);
  // Nothing a caller sends can add a seventh category that nothing reads.
  assert.equal(JSON.stringify(live_state).includes("not_a_category"), false);
});

test("B2 livestate: merge drops non-string ids rather than carrying junk into a refusal", () => {
  const { live_state } = mergeLiveState(emptyLiveState(), { owned_entity_ids: ["ok", "", null, 7, {}, "ok"] });
  assert.deepEqual(live_state.owned_entity_ids, ["ok"]);
});

test("B2 livestate: one store answering does not make up for another that did not", async () => {
  // Two sources both claim owned_entity_ids. One answers with a real hold, the
  // other cannot be read. The category must NOT be reported as determined: the
  // silent store may be holding the house.
  const good = {
    name: "store-a", covers: { owned_entity_ids: COVERAGE.AVAILABLE },
    status: () => COVERAGE.AVAILABLE,
    async read() { return { owned_entity_ids: ["struct_house"] }; },
  };
  const bad = {
    name: "store-b", covers: { owned_entity_ids: COVERAGE.AVAILABLE },
    status: () => COVERAGE.AVAILABLE,
    async read() { throw new Error("store-b is down"); },
  };

  const r = await createLiveStateService({ sources: [good, bad] }).liveStateFor("w1");
  assert.deepEqual(r.live_state.owned_entity_ids, ["struct_house"], "the real hold is still reported");
  assert.equal(r.coverage.owned_entity_ids.status, COVERAGE.PARTIAL);
  assert.ok(!r.determined.includes("owned_entity_ids"));
  assert.match(r.coverage.owned_entity_ids.reason, /store-b is down/);
  assert.equal(r.nothing_held, false);

  // Order must not change the verdict.
  const flipped = await createLiveStateService({ sources: [bad, good] }).liveStateFor("w1");
  assert.equal(flipped.coverage.owned_entity_ids.status, COVERAGE.PARTIAL);
  assert.deepEqual(flipped.live_state.owned_entity_ids, ["struct_house"]);
});

test("B2 livestate: every source honours the seam contract", async () => {
  const env = tmpEnv();
  const built = [
    cw5RuntimeStateSource({ persistence: null }),
    companionMemorySource({ companions: createCompanionService({ env }) }),
    nullQuestProgressSource(),
    nullNpcAcquaintanceSource(),
  ];
  for (const s of built) {
    assert.equal(typeof s.name, "string");
    assert.equal(typeof s.status, "function");
    assert.equal(typeof s.read, "function");
    assert.ok([COVERAGE.AVAILABLE, COVERAGE.UNAVAILABLE].includes(s.status()), `${s.name} status`);
    for (const [c, v] of Object.entries(s.covers)) {
      assert.ok(CATEGORIES.includes(c), `${s.name} claims an unknown category '${c}'`);
      assert.ok(Object.values(COVERAGE).includes(v), `${s.name}.covers.${c}`);
    }
    // An UNAVAILABLE source must refuse, never return an empty hold set.
    if (s.status() === COVERAGE.UNAVAILABLE) {
      await assert.rejects(() => s.read("w1"), `${s.name} returned instead of refusing`);
    }
  }
  // And an available source that is asked about an empty world does answer.
  const cs = companionMemorySource({ companions: createCompanionService(tmpEnv()) });
  assert.equal(cs.status(), COVERAGE.AVAILABLE);
  assert.deepEqual(await cs.read("w_nothing"), { companion_memory_refs: [], visited_zone_ids: [] });
});
