// B0 exit gate. WorldManifestV3 must be strict enough that the B4 critic has
// something real to stand on, and provider-neutral enough that swapping a vendor
// never changes the contract.
import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest, emptyManifest, MANIFEST_VERSION } from "../src/v3/manifest/schema.mjs";
import { migrateToV3, isV3, ensureV3 } from "../src/v3/manifest/migrate.mjs";
import { generateWorld } from "../src/cw2/generate.mjs";

const base = () => emptyManifest({ worldId: "w_test", title: "Test World", creatorId: "u1" });

function playable() {
  const m = base();
  m.zones = [{ id: "town", name: "Town", kind: "district", bounds: [0, 0, 100, 100] }];
  m.assets = [
    { id: "a_house", kind: "building", format: "glb", uri: "/assets/house.glb", collision: { kind: "mesh", solid: true }, license: { spdx: "CC0-1.0" } },
    { id: "a_villager", kind: "character", format: "glb", uri: "/assets/villager.glb", license: { spdx: "CC0-1.0" } },
  ];
  m.structures = [{ id: "s_house", zone: "town", asset_ref: "a_house", transform: { position: { x: 10, y: 0, z: 10 } } }];
  m.npcs = [{ id: "npc_elder", name: "Elder", zone: "town", spawn: { x: 12, y: 0, z: 12 }, asset_ref: "a_villager" }];
  m.items = [{ id: "item_key", name: "Brass Key", kind: "key", asset_ref: "a_house" }];
  m.quests = [{ id: "q1", title: "Find the key", giver_npc: "npc_elder", steps: [{ id: "s1", kind: "talk", target: "npc_elder" }, { id: "s2", kind: "collect", target: "item_key" }] }];
  m.provenance.generated_by = [{ lane: "world_architect", provider: "test", model: "none", status: "AVAILABLE" }];
  return m;
}

// ------------------------------------------------------------------- basics

test("a minimal manifest is structurally valid and immediately enterable", () => {
  const r = validateManifest(base());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(base().spawn.player_spawns.length, 1, "an empty world still has a spawn");
});

test("a fully populated manifest validates with no errors", () => {
  const r = validateManifest(playable());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("a non-object, or a v1 manifest, is rejected with a usable hint", () => {
  assert.equal(validateManifest(null).ok, false);
  const v1 = { ...base(), manifest_version: "1.0" };
  const r = validateManifest(v1);
  assert.equal(r.ok, false);
  assert.match(r.errors.find((e) => e.path === "manifest_version").hint, /migrateToV3/);
});

// ------------------------------------------------ referential integrity

test("B0 GATE: a structure pointing at a non-existent asset is an error", () => {
  const m = playable();
  m.structures[0].asset_ref = "a_does_not_exist";
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /unknown asset/);
});

test("B0 GATE: an NPC in a non-existent zone is an error", () => {
  const m = playable();
  m.npcs[0].zone = "atlantis";
  assert.equal(validateManifest(m).ok, false);
});

test("B0 GATE: a quest step targeting nothing is an error — a dead quest cannot validate", () => {
  const m = playable();
  m.quests[0].steps[1].target = "item_that_was_never_created";
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.errors.find((e) => /steps\[1\]\.target/.test(e.path)).hint, /real npc, item, zone or structure/);
});

test("B0 GATE: a quest with no steps is an error", () => {
  const m = playable();
  m.quests[0].steps = [];
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.errors.find((e) => /steps/.test(e.path)).hint, /never be completed/);
});

test("B0 GATE: a world with no player spawn is an error", () => {
  const m = playable();
  m.spawn.player_spawns = [];
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.errors.find((e) => /player_spawns/.test(e.path)).hint, /cannot be entered/);
});

test("duplicate ids are caught in every collection", () => {
  for (const [key, dup] of [
    ["zones", { id: "town", kind: "district", bounds: [0, 0, 10, 10] }],
    ["npcs", { id: "npc_elder", name: "Clone", spawn: { x: 0, y: 0, z: 0 } }],
    ["quests", { id: "q1", title: "Dup", steps: [{ id: "s", kind: "reach", target: "town" }] }],
  ]) {
    const m = playable();
    m[key].push(dup);
    const r = validateManifest(m);
    assert.equal(r.ok, false, `${key} duplicate not caught`);
    assert.ok(r.errors.some((e) => /duplicate/.test(e.message)), `${key} duplicate not reported`);
  }
});

test("an interaction pointing at an unknown behavior is an error", () => {
  const m = playable();
  m.interactions = [{ id: "i1", trigger: "interact", target_ref: "s_house", behavior_ref: "b_missing" }];
  assert.equal(validateManifest(m).ok, false);
});

test("a behavior with neither a spec nor a script is an error", () => {
  const m = playable();
  m.behaviors = [{ id: "b_door", kind: "door" }];
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /declarative spec or a script/);
});

test("a functional object carries real behavior and validates", () => {
  const m = playable();
  m.behaviors = [{ id: "b_door", kind: "door", spec: { opens: "outward", locked_by: "item_key", speed: 1.2 } }];
  m.interactions = [{ id: "i_door", trigger: "interact", target_ref: "s_house", behavior_ref: "b_door" }];
  assert.equal(validateManifest(m).ok, true, JSON.stringify(validateManifest(m).errors));
});

// ----------------------------------------------------- enums and ranges

test("out-of-range and unknown enum values are rejected", () => {
  const cases = [
    (m) => { m.environment.time_of_day = 4; },
    (m) => { m.environment.weather = "meteor_shower"; },
    (m) => { m.terrain.kind = "voxel"; },
    (m) => { m.terrain.size = { w: -1, h: 10 }; },
    (m) => { m.zones[0].bounds = [10, 10, 5, 5]; },
    (m) => { m.assets[0].format = "fbx"; },
    (m) => { m.quests[0].steps[0].kind = "vibe"; },
    (m) => { m.multiplayer.max_players = 0; },
    (m) => { m.provenance.generated_by[0].status = "PROBABLY"; },
  ];
  for (const [i, mutate] of cases.entries()) {
    const m = playable();
    mutate(m);
    assert.equal(validateManifest(m).ok, false, `case ${i} should have failed`);
  }
});

// -------------------------------------------------- provider neutrality

test("B0 GATE: a provider-specific field in the canonical schema is rejected", () => {
  for (const key of ["cerebras_model", "kinix_voice_id", "meshy_task_id", "openai_response"]) {
    const m = playable();
    m.meta[key] = "x";
    const r = validateManifest(m);
    assert.equal(r.ok, false, `${key} was allowed into the canonical schema`);
    assert.match(r.errors.find((e) => e.path.endsWith(key)).hint, /provenance\.generated_by/);
  }
});

test("provenance is the ONE place a provider may be named", () => {
  const m = playable();
  m.provenance.generated_by.push({ lane: "media", provider: "kinix", model: "kynex-voice-1", status: "FALLBACK" });
  assert.equal(validateManifest(m).ok, true);
});

test("B0 GATE: the manifest shape is unchanged when every media provider is absent", () => {
  const withMedia = playable();
  withMedia.media = { thumbnail_ref: "a_house", trailer_ref: "x", intro_ref: "y", portraits: { npc_elder: "p1" }, captions: { en: "c1" } };
  const withoutMedia = playable();   // media stays all-null from emptyManifest
  assert.equal(validateManifest(withMedia).ok, true);
  assert.equal(validateManifest(withoutMedia).ok, true);
  assert.deepEqual(Object.keys(withMedia).sort(), Object.keys(withoutMedia).sort(),
    "an unavailable media provider must not change the set of manifest fields");
});

// ------------------------------------------------------------ migration

test("B0 GATE: a real v1 world from the deployed generator migrates and validates", async () => {
  const v1 = await generateWorld("A rainy nordic port town");
  assert.equal(v1.schema_version, "1.0", "the fixture must be a genuine v1 world");

  const m = migrateToV3(v1, { creatorId: "u1" });
  assert.equal(m.manifest_version, MANIFEST_VERSION);
  const r = validateManifest(m);
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));

  // nothing is lost
  assert.equal(m.structures.length, (v1.objects || []).length);
  assert.equal(m.npcs.length, (v1.npcs || []).length);
  assert.equal(m.quests.length, (v1.quests || []).length);
  assert.equal(m.meta.title, v1.meta.title);
  // and nothing is invented
  assert.equal(m.expansion.compatibility.migrated_from, "1.0");
  assert.equal(m.provenance.generated_by[0].lane, "world_architect");
});

test("migration records that v1 geometry really was primitives", async () => {
  const v1 = await generateWorld("Pirate Island");
  const m = migrateToV3(v1);
  assert.ok(m.assets.length > 0);
  assert.ok(m.assets.every((a) => a.format === "primitive"),
    "a migrated v1 world must not claim assets it never had");
  assert.match(m.assets[0].provenance.migrated_from, /c1-v1\.0-primitive/);
});

test("migration drops a dangling quest target rather than inventing one", () => {
  const v1 = {
    world_id: "w1", schema_version: "1.0",
    meta: { title: "T", prompt: "p", creator_id: "u", created_at: new Date().toISOString() },
    terrain: { type: "tilegrid", size: { w: 10, h: 10 }, data: [] },
    spawns: [{ id: "s", x: 0, y: 0, z: 0, role: "player" }],
    objects: [], npcs: [], items: [],
    quests: [{ quest_id: "q1", title: "Ghost quest", objectives: [{ id: "o1", text: "find it", trigger: "collect", target: "item_that_never_existed" }] }],
  };
  const m = migrateToV3(v1);
  assert.equal(m.quests[0].steps[0].target, null, "a dangling target becomes null, not a fabrication");
  assert.equal(validateManifest(m).ok, true);
});

test("migrating twice is a no-op", async () => {
  const v1 = await generateWorld("Desert outpost");
  const once = migrateToV3(v1);
  const twice = migrateToV3(once);
  assert.equal(twice, once, "an already-v3 manifest is returned unchanged");
  assert.equal(isV3(once), true);
});

test("ensureV3 reports whether it migrated, and validates the result", async () => {
  const v1 = await generateWorld("Sky temple");
  const a = ensureV3(v1);
  assert.equal(a.migrated, true);
  assert.equal(a.validation.ok, true, JSON.stringify(a.validation.errors));
  const b = ensureV3(a.manifest);
  assert.equal(b.migrated, false);
});

test("an unlicensed asset warns but does not fail — licensing is a launch blocker, not a build blocker", () => {
  const m = playable();
  delete m.assets[0].license;
  const r = validateManifest(m);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /licence/.test(w.message)));
  assert.match(r.warnings.find((w) => /licence/.test(w.message)).hint, /public-launch blocker/);
});
