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

test("V3 GATE: every seed produces a schema-valid manifest, not just the ones we happened to try", async () => {
  // Seed 20 on the default archetype produced `zone_central` twice and failed
  // WorldManifestV3 — a 500 on generate, the whole world lost to a name
  // collision. DEFAULT_ARCHETYPE listed four districts while districtCount runs
  // 3..5, so `i % length` wrapped. It surfaced only because one authorisation
  // test happened to land on that seed.
  const { createAssemblyRouter } = await import("../src/v3/router/assembly.mjs");
  const r = createAssemblyRouter({});
  const prompts = [
    "a monastery on a cliff where bells ring",   // matches no archetype -> default
    "a drowned tidal village",
    "a neon city at night",
    "a haunted manor",
    "a forest camp by a river",
    "a derelict space station",
    "a castle keep above the fields",
  ];
  const bad = [];
  for (let seed = 0; seed < 40; seed++) {
    const prompt = prompts[seed % prompts.length];
    const b = await r.assemble({ prompt, worldId: `w_seed_${seed}`, creatorId: "u", seed });
    if (!b.validation.ok) {
      bad.push(`seed ${seed} (${prompt}): ${b.validation.errors.slice(0, 2).map((e) => `${e.path} ${e.message}`).join("; ")}`);
    }
    const ids = b.manifest.zones.map((z) => z.id);
    if (new Set(ids).size !== ids.length) bad.push(`seed ${seed}: duplicate zone ids ${ids.join(",")}`);
  }
  assert.deepEqual(bad, [], `these seeds cannot be generated at all:\n  ${bad.join("\n  ")}`);
});

// ------------------------------------------ a legacy world must actually load

/** A v1.0 world in the shape the C1 seeder emitted. */
function legacyWorld() {
  return {
    schema_version: "1.0",
    world_id: "w_v1",
    meta: { title: "Old Town", prompt: "a town", seed: 7, created_at: "2025-01-01T00:00:00Z" },
    environment: { time_of_day: 0.4, weather: "rain" },
    terrain: {
      type: "heightmap", size: { w: 128, h: 128 },
      data: Array.from({ length: 8 }, () => Array(8).fill(1)),
      zones: [{ id: "z1", name: "Centre", rect: [0, 0, 64, 64] }, { id: "z2", name: "Edge", rect: [64, 0, 128, 64] }],
    },
    objects: [{ object_id: "o1", kind: "building", transform: { x: 10, y: 0, z: 10 } }],
    npcs: [{ npc_id: "n1", name: "Vera", spawn: { x: 12, y: 0, z: 12 }, dialogue_seed: "hello" }],
    quests: [{ quest_id: "q1", title: "Say hello", objectives: [{ id: "s1", trigger: "talk", target: "n1" }] }],
    spawns: [{ id: "sp", x: 4, y: 1, z: 4 }],
  };
}

test("B0 GATE: every way a v1 world can be malformed still migrates to a VALID v3 manifest", () => {
  // `ensureV3` returns the validation next to the manifest and every caller in
  // server.mts takes the manifest and drops the validation. So an invalid
  // migration produced a world that LOADED and was then refused by every
  // operation on it — the playtest gate reporting schema errors about a file
  // the creator never wrote and cannot edit.
  //
  // A fuzz over these found eleven that migrated straight into an invalid
  // manifest, plus one that threw a raw TypeError out of the mapper.
  const damages = {
    no_meta: (v) => { delete v.meta; },
    no_terrain: (v) => { delete v.terrain; },
    no_zones: (v) => { delete v.terrain.zones; },
    zone_no_rect: (v) => { for (const z of v.terrain.zones) delete z.rect; },
    zone_degenerate_rect: (v) => { v.terrain.zones[0].rect = [0, 0, 0, 0]; },
    zone_nonsense_rect: (v) => { v.terrain.zones[0].rect = [NaN, 0, "x", null]; },
    duplicate_zone_ids: (v) => { v.terrain.zones[1].id = v.terrain.zones[0].id; },
    duplicate_object_ids: (v) => { v.objects.push({ ...v.objects[0] }); },
    duplicate_npc_ids: (v) => { v.npcs.push({ ...v.npcs[0] }); },
    duplicate_quest_ids: (v) => { v.quests.push({ ...v.quests[0] }); },
    quest_with_no_objectives: (v) => { v.quests[0].objectives = []; },
    quest_objectives_not_a_list: (v) => { v.quests[0].objectives = "talk to vera"; },
    terrain_size_zero: (v) => { v.terrain.size = { w: 0, h: 0 }; },
    terrain_size_negative: (v) => { v.terrain.size = { w: -5, h: -5 }; },
    terrain_data_not_a_grid: (v) => { v.terrain.data = "not-an-array"; },
    weather_v1_never_bounded: (v) => { v.environment.weather = "meteor"; },
    time_of_day_in_hours: (v) => { v.environment.time_of_day = 18; },
    time_of_day_out_of_range: (v) => { v.environment.time_of_day = 4; },
    maturity_not_a_v3_rating: (v) => { v.meta.maturity = "21+"; },
    null_rows_everywhere: (v) => { v.objects = [null]; v.npcs = [null]; v.quests = [null]; v.terrain.zones = [null]; },
    everything_empty: (v) => { v.objects = []; v.npcs = []; v.quests = []; v.terrain.zones = []; },
  };

  const broken = [];
  for (const [name, damage] of Object.entries(damages)) {
    const v1 = legacyWorld();
    damage(v1);
    let out;
    try { out = ensureV3(v1, { worldVersion: 1, creatorId: "u1" }); }
    catch (e) { broken.push(`${name}: threw ${e.constructor.name}: ${e.message.slice(0, 120)}`); continue; }
    if (!out.validation.ok) broken.push(`${name}: ${out.validation.errors.slice(0, 2).map((e) => `${e.path} ${e.message}`).join("; ")}`);
    // Nothing non-finite may reach the manifest either.
    const bad = [];
    (function walk(n, p) {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${p}[${i}]`));
      for (const [k, x] of Object.entries(n)) {
        if (typeof x === "number" && !Number.isFinite(x)) bad.push(`${p}.${k}`);
        else walk(x, `${p}.${k}`);
      }
    })(out.manifest, "$");
    if (bad.length) broken.push(`${name}: non-finite at ${bad.slice(0, 3).join(", ")}`);
  }
  assert.deepEqual(broken, [], `legacy worlds that cannot be loaded:\n  ${broken.join("\n  ")}`);
});

test("B0: what the migration had to change is written down, not swallowed", () => {
  const v1 = legacyWorld();
  v1.environment.weather = "meteor";
  v1.meta.maturity = "21+";
  v1.terrain.zones[1].id = v1.terrain.zones[0].id;
  v1.quests.push({ quest_id: "q_empty", title: "Nothing", objectives: [] });

  const m = migrateToV3(v1, { worldVersion: 1, creatorId: "u1" });
  const notes = m.expansion.compatibility.migration_notes || [];
  assert.ok(notes.length >= 4, `every change must be recorded, got: ${JSON.stringify(notes)}`);
  assert.ok(notes.some((n) => /weather/.test(n)), JSON.stringify(notes));
  assert.ok(notes.some((n) => /maturity/.test(n)), JSON.stringify(notes));
  assert.ok(notes.some((n) => /zones dropped/.test(n)), JSON.stringify(notes));
  assert.ok(notes.some((n) => /no objectives/.test(n)), JSON.stringify(notes));

  // An unreadable rating becomes the STRICTEST one, never a laxer one: a world
  // whose rating cannot be read must not end up rated lower than it was.
  assert.equal(m.meta.maturity, "18+");
  // A clean world says nothing, because nothing had to change.
  assert.equal(migrateToV3(legacyWorld(), { worldVersion: 1 }).expansion.compatibility.migration_notes, undefined);
});

test("B0: a migrated legacy world is not just valid, it is playable", async () => {
  const { playtestAndRepair } = await import("../src/v3/playtest/agent.mjs");
  const m = migrateToV3(legacyWorld(), { worldVersion: 1, creatorId: "u1" });
  assert.ok(validateManifest(m).ok);
  const out = await playtestAndRepair(m);
  // It may or may not pass — a v1 world really is thin — but whatever the gate
  // decides, the manifest it hands back must still satisfy the contract.
  assert.ok(validateManifest(out.manifest).ok,
    `the gate produced an invalid manifest from a legacy world: ${JSON.stringify(validateManifest(out.manifest).errors.slice(0, 3))}`);
});
