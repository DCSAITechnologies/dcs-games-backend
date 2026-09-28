// GAMES-C patch contract — versioned, diffable, undoable, replayable, validated.
import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { validateManifest, emptyManifest } from "../src/v3/manifest/schema.mjs";
import { applyDelta } from "../src/v3/expansion/delta.mjs";
import { planEdit } from "../src/v3/expansion/planner.mjs";
import {
  PATCH_VERSION, OP_KINDS, SET_PATH_WHITELIST, SET_PATH_SPECS, LIMITS,
  canonicalJSON, hashManifest, validatePatch, applyPatch, invertPatch, replayPatches,
  diffManifests, diffManifestsDetailed, createPatch, createEditHistory,
} from "../src/v3/gamesc/patch/index.mjs";

process.env.DCS_PROVIDERS_OFFLINE = "1";
const T0 = "2026-09-28T00:00:00.000Z";
const author = { kind: "user", id: "u1" };

let FIXTURE;
async function fixture() {
  if (!FIXTURE) {
    const out = await createAssemblyRouter({ DCS_PROVIDERS_OFFLINE: "1" }).assemble({ prompt: "A small nordic port town", worldId: "w_patch", creatorId: "u1" });
    FIXTURE = out.manifest;
    assert.equal(validateManifest(FIXTURE).ok, true, "fixture must be valid");
  }
  return structuredClone(FIXTURE);
}
const mk = (m, ops, extra = {}) => createPatch({ manifest: m, ops, author, created_at: T0, ...extra });
const msgs = (r) => r.errors.map((e) => e.message).join(" | ");

function roundTrip(m, ops, label) {
  const p = mk(m, ops);
  const r = applyPatch(m, p);
  assert.equal(r.ok, true, `${label}: ${msgs(r)}`);
  assert.equal(validateManifest(r.manifest).ok, true, `${label}: result must validate`);
  assert.equal(r.manifest.world_version, m.world_version + 1, `${label}: version bump`);
  assert.notEqual(hashManifest(r.manifest), hashManifest(m), `${label}: must change content`);
  const inv = invertPatch(p, m);
  assert.deepEqual(inv, r.inverse, `${label}: invertPatch == applyPatch().inverse`);
  const back = applyPatch(r.manifest, r.inverse);
  assert.equal(back.ok, true, `${label} inverse: ${msgs(back)}`);
  assert.equal(hashManifest(back.manifest), hashManifest(m), `${label}: inverse restores the hash`);
  assert.equal(back.manifest.world_version, m.world_version + 2);
  return r;
}

// ------------------------------------------------------------- contract shape

test("patch: contract exports and constants", () => {
  assert.equal(PATCH_VERSION, "1");
  for (const k of ["set", "add", "remove", "update", "move", "replace_asset"]) assert.ok(OP_KINDS.includes(k), k);
  assert.ok(SET_PATH_WHITELIST.includes("environment.weather"));
  assert.ok(SET_PATH_WHITELIST.includes("meta.title"));
  assert.ok(!SET_PATH_WHITELIST.includes("meta.maturity"), "maturity is a moderation decision, not an edit");
  assert.ok(!SET_PATH_WHITELIST.includes("world_version"));
  for (const p of SET_PATH_WHITELIST) assert.ok(SET_PATH_SPECS[p].source, p);
});

test("patch: canonicalJSON is key-order independent; hashManifest ignores volatile fields", async () => {
  assert.equal(canonicalJSON({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJSON({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.equal(canonicalJSON({ a: undefined, b: 1 }), '{"b":1}');
  const cyc = {}; cyc.self = cyc;
  assert.throws(() => canonicalJSON(cyc), /cycle/);
  const m = await fixture();
  const h = hashManifest(m);
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  const shuffled = JSON.parse(JSON.stringify(m, Object.keys(m).reverse()));
  assert.equal(hashManifest(JSON.parse(JSON.stringify(m))), h);
  assert.equal(hashManifest({ ...m, world_version: 99, meta: { ...m.meta, updated_at: "x" } }), h);
  assert.notEqual(hashManifest({ ...m, environment: { ...m.environment, weather: "snow" } }), h);
  assert.ok(shuffled);
});

// ---------------------------------------------------- every op kind round-trips

test("patch: set (existing path) apply -> inverse -> original hash", async () => {
  const m = await fixture();
  roundTrip(m, [{ op: "set", path: "environment.weather", value: "storm" }], "set weather");
  roundTrip(m, [{ op: "set", path: "environment.time_of_day", value: 0.1 }], "set time");
  roundTrip(m, [{ op: "set", path: "meta.title", value: "Wharf Town" }], "set title");
  roundTrip(m, [{ op: "set", path: "environment.fog", value: { density: 0.3, color: "#aabbcc" } }], "set fog");
  roundTrip(m, [{ op: "set", path: "multiplayer.max_players", value: 16 }], "set max players");
});

test("patch: set on a new nested path creates it and the inverse prunes it", async () => {
  const m = await fixture();
  const r = roundTrip(m, [{ op: "set", path: "gameplay.player.move_speed", value: 7.5 }, { op: "set", path: "ui.minimap", value: false }], "set added paths");
  assert.equal(r.manifest.gameplay.player.move_speed, 7.5);
  assert.deepEqual(r.inverse.ops[1], { op: "unset", path: "gameplay.player.move_speed", prune: 2 });
});

test("patch: unset apply -> inverse", async () => {
  const m = await fixture();
  m.ui = { minimap: true, theme: "dark" };
  roundTrip(m, [{ op: "unset", path: "ui.theme" }], "unset");
});

test("patch: add / remove / update / move / replace_asset round-trip", async () => {
  const m = await fixture();
  const zone = m.zones[0], asset = m.assets.find((a) => a.kind === "character") || m.assets[0];
  roundTrip(m, [{ op: "add", collection: "npcs", value: { id: "npc_gen_fisher", name: "Fisher", role: "fisher", zone: zone.id, spawn: { x: 20, y: 0, z: 200 }, asset_ref: asset.id, behavior_ref: null, dialogue: { seed: "Fresh cod!", lines: [] }, schedule: [], faction: null, stats: null } }], "add npc");
  roundTrip(m, [{ op: "add", collection: "zones", value: { id: "zone_pier", name: "Pier", kind: "landmark", bounds: [0, 0, 10, 10], parent_zone: null, tags: [], ambience: "gulls", density: 0.2 }, index: 0 }], "add zone at index");
  // remove a leaf entity nothing references: add one first then remove it from that state
  const withItem = applyPatch(m, mk(m, [{ op: "add", collection: "items", value: { id: "item_coin", name: "Coin", kind: "coin", asset_ref: asset.id, stackable: true, effects: [] } }])).manifest;
  const r = roundTrip(withItem, [{ op: "remove", collection: "items", id: "item_coin" }], "remove item");
  assert.equal(r.inverse.ops[0].op, "add");
  assert.equal(typeof r.inverse.ops[0].index, "number");
  roundTrip(m, [{ op: "update", collection: "zones", id: zone.id, set: { name: "Wharf", density: 0.9, ambience: "foghorns" } }], "update zone");
  roundTrip(m, [{ op: "update", collection: "structures", id: m.structures[0].id, set: { purpose: "Net Shed", interactable: false } }], "update structure");
  roundTrip(m, [{ op: "update", collection: "quests", id: m.quests[0].id, set: { title: "A New Arrival", difficulty: "hard" } }], "update quest");
  roundTrip(m, [{ op: "update", collection: "zones", id: zone.id, set: { density: 0.1 }, unset: ["tags"] }], "update with unset");
  roundTrip(m, [{ op: "move", collection: "structures", id: m.structures[0].id, position: { x: 40, y: 0, z: 300 } }], "move structure");
  roundTrip(m, [{ op: "move", collection: "npcs", id: m.npcs[0].id, position: { x: 30, y: 0, z: 250 } }], "move npc");
  roundTrip(m, [{ op: "move", collection: "player_spawns", id: m.spawn.player_spawns[0].id, position: { x: 26, y: 2, z: 239 } }], "move spawn");
  const a0 = m.assets[0];
  roundTrip(m, [{ op: "replace_asset", asset_id: a0.id, value: { ...a0, format: "glb", uri: "/assets/models/boathouse_v2.glb", license: { spdx: "CC0-1.0" } } }], "replace asset");
});

test("patch: a multi-op patch inverts in reverse order", async () => {
  const m = await fixture();
  roundTrip(m, [
    { op: "set", path: "environment.weather", value: "snow" },
    { op: "add", collection: "items", value: { id: "item_a", name: "A", kind: "a", asset_ref: m.assets[0].id, stackable: false, effects: [] } },
    { op: "update", collection: "items", id: "item_a", set: { name: "A2" } },
    { op: "remove", collection: "items", id: "item_a" },
    { op: "set", path: "environment.weather", value: "fog" },
  ], "multi-op");
});

// ------------------------------------------------------------- replay / stale

test("patch: replay is deterministic (same base + patches => same hash)", async () => {
  const m = await fixture();
  const p1 = mk(m, [{ op: "set", path: "environment.weather", value: "storm" }]);
  const m1 = applyPatch(m, p1).manifest;
  const p2 = mk(m1, [{ op: "move", collection: "npcs", id: m.npcs[1].id, position: { x: 1, y: 2, z: 3 } }]);
  const m2 = applyPatch(m1, p2).manifest;
  const p3 = mk(m2, [{ op: "update", collection: "zones", id: m.zones[1].id, set: { name: "Old Harbour" } }]);
  const a = replayPatches(m, [p1, p2, p3]);
  const b = replayPatches(JSON.parse(JSON.stringify(m)), JSON.parse(JSON.stringify([p1, p2, p3])));
  assert.equal(a.ok, true, msgs(a));
  assert.equal(a.applied, 3);
  assert.equal(hashManifest(a.manifest), hashManifest(b.manifest));
  assert.equal(a.manifest.world_version, m.world_version + 3);
  // out-of-order replay is refused at the first stale patch
  const bad = replayPatches(m, [p1, p3]);
  assert.equal(bad.ok, false);
  assert.equal(bad.applied, 1);
  assert.equal(bad.errors[0].patch_index, 1);
});

test("patch: stale base_hash / base_version / world_id rejected", async () => {
  const m = await fixture();
  const p = mk(m, [{ op: "set", path: "environment.weather", value: "storm" }]);
  const m1 = applyPatch(m, p).manifest;
  const again = applyPatch(m1, p);
  assert.equal(again.ok, false);
  assert.equal(again.errors[0].code, "stale_base");
  assert.match(msgs(again), /stale edit/);
  // same content hash but wrong version
  const wrongVer = { ...p, base_version: p.base_version + 5 };
  assert.equal(applyPatch(m, wrongVer).ok, false);
  // concurrent edit changed content without us knowing
  const other = structuredClone(m); other.meta.title = "Someone else";
  assert.equal(validatePatch(p, other).ok, false);
  assert.match(msgs(validatePatch({ ...p, world_id: "w_other" }, m)), /targets 'w_other'/);
});

// ------------------------------------------------------------- rejection rules

function rejects(m, ops, re, label) {
  const r = applyPatch(m, mk(m, ops));
  assert.equal(r.ok, false, `${label} should be rejected`);
  assert.equal(r.manifest, null);
  if (re) assert.match(msgs(r), re, label);
  assert.equal(validatePatch(mk(m, ops), m).ok, false, `${label}: validatePatch agrees`);
}

test("patch: invalid enums rejected (values from schema.mjs)", async () => {
  const m = await fixture();
  rejects(m, [{ op: "set", path: "environment.weather", value: "hurricane" }], /not permitted/, "weather");
  rejects(m, [{ op: "update", collection: "zones", id: m.zones[0].id, set: { kind: "castle" } }], /not a permitted zones.kind/, "zone kind");
  rejects(m, [{ op: "update", collection: "interactions", id: m.interactions[0].id, set: { trigger: "telepathy" } }], /trigger/, "trigger");
  rejects(m, [{ op: "update", collection: "behaviors", id: m.behaviors[0].id, set: { kind: "nuke" } }], /behaviors.kind/, "behavior kind");
  rejects(m, [{ op: "update", collection: "quests", id: m.quests[0].id, set: { steps: [{ id: "s", kind: "dance" }] } }], /steps\[0\]\.kind/, "step kind");
  rejects(m, [{ op: "replace_asset", asset_id: m.assets[0].id, value: { ...m.assets[0], kind: "spaceship" } }], /assets.kind/, "asset kind");
  rejects(m, [{ op: "set", path: "gameplay.rules.difficulty", value: "nightmare" }], /not permitted/, "rule difficulty");
});

test("patch: unknown ids, duplicate ids, unknown collections and paths rejected", async () => {
  const m = await fixture();
  rejects(m, [{ op: "update", collection: "npcs", id: "npc_ghost", set: { name: "x" } }], /no npcs entry/, "update ghost");
  rejects(m, [{ op: "remove", collection: "zones", id: "zone_ghost" }], /no zones entry/, "remove ghost");
  rejects(m, [{ op: "move", collection: "structures", id: "struct_ghost", position: { x: 0, y: 0, z: 0 } }], /no structures entry/, "move ghost");
  rejects(m, [{ op: "replace_asset", asset_id: "asset_ghost", value: { kind: "prop", format: "instanced" } }], /no asset/, "replace ghost");
  rejects(m, [{ op: "add", collection: "zones", value: { ...m.zones[0] } }], /already exists/, "duplicate id");
  rejects(m, [{ op: "add", collection: "entities", value: { id: "e1" } }], /not a manifest collection/, "entities");
  rejects(m, [{ op: "move", collection: "zones", id: m.zones[0].id, position: { x: 0, y: 0, z: 0 } }], /not movable/, "move zone");
  rejects(m, [{ op: "set", path: "terrain.kind", value: "flat" }], /not settable/, "terrain");
  rejects(m, [{ op: "set", path: "world_version", value: 99 }], /not settable/, "world_version");
  rejects(m, [{ op: "set", path: "meta.maturity", value: "18+" }], /not settable/, "maturity");
  rejects(m, [{ op: "frobnicate", path: "x" }], /unknown op/, "unknown op");
  rejects(m, [{ op: "set", path: "environment.weather", value: "rain", extra: 1 }], /unexpected key/, "extra op key");
  rejects(m, [{ op: "update", collection: "structures", id: m.structures[0].id, set: { owner_id: "u_evil" } }], /may not be written/, "owner_id");
  rejects(m, [{ op: "update", collection: "structures", id: m.structures[0].id, set: { id: "struct_x" } }], /may not be written/, "rename id");
  rejects(m, [{ op: "update", collection: "npcs", id: m.npcs[0].id, set: { secret_field: 1 } }], /not editable/, "non-whitelisted field");
});

test("patch: numbers must be finite and within bounds; op/patch size limits", async () => {
  const m = await fixture();
  rejects(m, [{ op: "set", path: "environment.time_of_day", value: 2 }], /within/, "tod>1");
  rejects(m, [{ op: "set", path: "environment.time_of_day", value: NaN }], /finite/, "NaN");
  rejects(m, [{ op: "set", path: "environment.gravity", value: -Infinity }], /finite/, "-Inf");
  rejects(m, [{ op: "set", path: "multiplayer.max_players", value: 1.5 }], /integer/, "int");
  rejects(m, [{ op: "set", path: "multiplayer.max_players", value: 0 }], /within/, "max_players 0");
  rejects(m, [{ op: "move", collection: "npcs", id: m.npcs[0].id, position: { x: 1e9, y: 0, z: 0 } }], /position/, "coord bound");
  rejects(m, [{ op: "move", collection: "npcs", id: m.npcs[0].id, position: { x: 1, y: 0 } }], /position/, "missing z");
  rejects(m, [{ op: "update", collection: "zones", id: m.zones[0].id, set: { bounds: [10, 10, 0, 0] } }], /bounds/, "inverted bounds");
  rejects(m, [{ op: "update", collection: "structures", id: m.structures[0].id, set: { footprint: { w: -1, d: 1, h: 1 } } }], /footprint/, "negative footprint");
  const many = Array.from({ length: LIMITS.MAX_OPS_PER_PATCH + 1 }, () => ({ op: "set", path: "environment.weather", value: "rain" }));
  rejects(m, many, /at most/, "too many ops");
  rejects(m, [{ op: "set", path: "environment.fog", value: { blob: "x".repeat(40000) } }], /larger than/, "big value");
});

test("patch: prototype-pollution keys rejected anywhere; Object.prototype untouched", async () => {
  const m = await fixture();
  const evil = JSON.parse('{"id":"item_evil","name":"E","kind":"k","asset_ref":null,"__proto__":{"polluted":true}}');
  rejects(m, [{ op: "add", collection: "items", value: evil }], /prototype pollution/, "__proto__ in add");
  const evilSet = JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');
  rejects(m, [{ op: "update", collection: "zones", id: m.zones[0].id, set: evilSet }], /forbidden key 'constructor'/, "constructor in update");
  rejects(m, [{ op: "set", path: "environment.fog", value: { a: { prototype: { x: 1 } } } }], /forbidden key 'prototype'/, "nested prototype");
  rejects(m, [{ op: "update", collection: "zones", id: m.zones[0].id, unset: ["__proto__"] }], /forbidden key/, "unset __proto__");
  const p = JSON.parse(JSON.stringify(mk(m, [{ op: "set", path: "environment.weather", value: "rain" }])).replace('"ops"', '"__proto__":{"x":1},"ops"'));
  assert.equal(applyPatch(m, p).ok, false, "top-level __proto__");
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test("patch: code, script and URL strings rejected outside the asset-uri allowlist", async () => {
  const m = await fixture();
  rejects(m, [{ op: "set", path: "meta.title", value: "<script>alert(1)</script>" }], /code/, "script tag");
  rejects(m, [{ op: "set", path: "meta.description", value: "javascript:alert(1)" }], /URL/, "js url");
  rejects(m, [{ op: "set", path: "meta.description", value: "visit https://evil.example.com now" }], /URL/, "http url");
  rejects(m, [{ op: "update", collection: "npcs", id: m.npcs[0].id, set: { dialogue: { seed: "hi", lines: ["() => fetch('/x')"] } } }], /code/, "arrow fn");
  rejects(m, [{ op: "update", collection: "npcs", id: m.npcs[0].id, set: { name: "eval(atob('x'))" } }], /code/, "eval");
  rejects(m, [{ op: "set", path: "meta.title", value: "${process.env.SECRET}" }], /code/, "template");
  rejects(m, [{ op: "add", collection: "behaviors", value: { id: "behavior_x", kind: "switch", spec: {}, script: "while(1){}" } }], /may not be written/, "behavior script");
  rejects(m, [{ op: "replace_asset", asset_id: m.assets[0].id, value: { ...m.assets[0], format: "glb", uri: "https://evil.example.com/x.glb" } }], /allowlist/, "bad uri");
  rejects(m, [{ op: "replace_asset", asset_id: m.assets[0].id, value: { ...m.assets[0], format: "glb", uri: "/assets/../../etc/passwd.glb" } }], /allowlist/, "traversal uri");
  rejects(m, [{ op: "update", collection: "assets", id: m.assets[0].id, set: { uri: "/assets/x.glb" } }], /may not be written/, "uri via update");
  // allowlisted uri accepted
  const ok = applyPatch(m, mk(m, [{ op: "replace_asset", asset_id: m.assets[0].id, value: { ...m.assets[0], format: "glb", uri: "https://assets.dcsai.ai/models/boat.glb" } }]));
  assert.equal(ok.ok, true, msgs(ok));
  // ordinary prose passes
  const prose = applyPatch(m, mk(m, [{ op: "set", path: "meta.description", value: "A windswept port; e.g. fish, nets & gulls. Don't miss the 3:00 ferry!" }]));
  assert.equal(prose.ok, true, msgs(prose));
});

test("patch: result must pass validateManifest and not leave dangling references", async () => {
  const m = await fixture();
  const usedAsset = m.structures[0].asset_ref;
  rejects(m, [{ op: "remove", collection: "assets", id: usedAsset }], /validateManifest/, "remove referenced asset");
  rejects(m, [{ op: "remove", collection: "zones", id: m.npcs[0].zone }], /validateManifest|dangling/, "remove referenced zone");
  rejects(m, [{ op: "set", path: "meta.title", value: "" }], null, "empty title");
  rejects(m, [{ op: "unset", path: "meta.title" }], /not settable|validateManifest/, "unset title");
  rejects(m, [{ op: "add", collection: "behaviors", value: { id: "behavior_pick", kind: "pickup", spec: { item: "item_nope" } } }], /dangling/, "spec ref");
  rejects(m, [{ op: "update", collection: "npcs", id: m.npcs[0].id, set: { asset_ref: "asset_nope" } }], /validateManifest/, "bad asset_ref");
});

test("patch: player-owned entities cannot be removed by an edit", async () => {
  const m = await fixture();
  m.structures[0].owner_id = "player_1";
  const r = applyPatch(m, mk(m, [{ op: "remove", collection: "structures", id: m.structures[0].id }]));
  assert.equal(r.ok, false);
  assert.match(msgs(r), /owned by a player/);
});

test("patch: applyPatch is pure (inputs unchanged on success and on failure)", async () => {
  const m = await fixture();
  const snap = canonicalJSON(m);
  const p = mk(m, [{ op: "set", path: "environment.weather", value: "storm" }, { op: "move", collection: "npcs", id: m.npcs[0].id, position: { x: 0, y: 0, z: 0 } }]);
  const psnap = canonicalJSON(p);
  const r = applyPatch(m, p);
  assert.equal(r.ok, true);
  r.manifest.npcs[0].spawn.x = 12345;
  assert.equal(canonicalJSON(m), snap);
  assert.equal(canonicalJSON(p), psnap);
  applyPatch(m, mk(m, [{ op: "remove", collection: "assets", id: m.structures[0].asset_ref }]));
  assert.equal(canonicalJSON(m), snap);
});

test("patch: validatePatch never throws on garbage", async () => {
  const m = await fixture();
  const cyc = { op: "set", path: "environment.fog" }; cyc.value = { cyc };
  const getter = { op: "set", path: "environment.fog", value: {} };
  Object.defineProperty(getter.value, "boom", { enumerable: true, get() { throw new Error("boom"); } });
  const good = mk(m, [{ op: "set", path: "environment.weather", value: "rain" }]);
  const withOps = (ops) => ({ ...good, ops });
  assert.throws(() => mk(m, [cyc]), /cycle/, "createPatch refuses cyclic data outright");
  const inputs = [null, undefined, 42, "patch", [], {}, { ops: null }, withOps([cyc]), withOps([getter]), withOps([null]), withOps(["set"]), withOps([])];
  for (const x of inputs) {
    const v = validatePatch(x, m);
    assert.equal(v.ok, false);
    assert.ok(Array.isArray(v.errors) && v.errors.length > 0);
    assert.equal(applyPatch(m, x).ok, false);
  }
  // a Proxy cannot present one value to the validator and another to the applier
  assert.equal(applyPatch(m, withOps([new Proxy({ op: "set", path: "environment.weather", value: "rain" }, {})])).ok, false);
  const sparse = withOps([]); sparse.ops.length = 2; sparse.ops[1] = { op: "set", path: "environment.weather", value: "rain" };
  assert.equal(applyPatch(m, sparse).ok, false, "sparse ops array");
  assert.equal(validatePatch(mk(m, [{ op: "set", path: "environment.weather", value: "rain" }]), "not a manifest").ok, false);
  assert.equal(validatePatch(mk(m, [{ op: "set", path: "environment.weather", value: "rain" }])).ok, true, "shape-only validation without a manifest");
});

// ------------------------------------------------------------------- diffing

test("patch: diffManifests yields ops that reproduce the target exactly", async () => {
  const m = await fixture();
  assert.deepEqual(diffManifests(m, structuredClone(m)), []);
  const p = mk(m, [
    { op: "set", path: "environment.weather", value: "snow" },
    { op: "set", path: "ui.theme", value: "dark" },
    { op: "add", collection: "items", value: { id: "item_z", name: "Z", kind: "z", asset_ref: m.assets[0].id, stackable: false, effects: [] }, index: 0 },
    { op: "update", collection: "zones", id: m.zones[0].id, set: { name: "Z" }, unset: ["tags"] },
    { op: "move", collection: "structures", id: m.structures[1].id, position: { x: 5, y: 0, z: 5 } },
    { op: "move", collection: "player_spawns", id: m.spawn.player_spawns[0].id, position: { x: 1, y: 1, z: 1 } },
    { op: "replace_asset", asset_id: m.assets[1].id, value: { ...m.assets[1], name: "renamed" } },
  ]);
  const after = applyPatch(m, p).manifest;
  const d = diffManifestsDetailed(m, after);
  assert.equal(d.exact, true, d.uncovered.join(","));
  assert.deepEqual(d.ops.map((o) => o.op).sort(), ["add", "move", "move", "replace_asset", "set", "set", "update"]);
  const replayed = applyPatch(m, mk(m, d.ops));
  assert.equal(replayed.ok, true, msgs(replayed));
  assert.equal(hashManifest(replayed.manifest), hashManifest(after));
  // and the reverse diff undoes it
  const rev = applyPatch(after, mk(after, diffManifests(after, m)), { trusted: true });
  assert.equal(hashManifest(rev.manifest), hashManifest(m));
});

test("patch: diff reports what planner edits changed and what ops cannot express", async () => {
  const m = await fixture();
  const plan = planEdit(m, { request: "make it snow", author: "u1" });
  assert.ok(plan.delta, JSON.stringify(plan));
  const applied = applyDelta(m, plan.delta).manifest;
  const d = diffManifestsDetailed(m, applied);
  assert.deepEqual(d.ops.filter((o) => o.op === "set").map((o) => o.path), ["environment.weather"]);
  assert.ok(d.uncovered.includes("expansion"), "delta history is outside the patch surface and is reported, not hidden");
});

// ------------------------------------------------------------------- history

test("history: apply / undo / redo with redo truncation", async () => {
  const m = await fixture();
  const h = createEditHistory(m);
  const h0 = h.currentHash();
  assert.equal(h.undo().ok, false);
  assert.equal(h.redo().ok, false);
  const a = h.apply(mk(h.current(), [{ op: "set", path: "environment.weather", value: "storm" }]));
  assert.equal(a.ok, true);
  const h1 = h.currentHash();
  assert.equal(h.apply(mk(h.current(), [{ op: "set", path: "environment.time_of_day", value: 0.9 }])).ok, true);
  const h2 = h.currentHash();
  assert.equal(h.undo().ok, true); assert.equal(h.currentHash(), h1);
  assert.equal(h.undo().ok, true); assert.equal(h.currentHash(), h0);
  assert.equal(h.canUndo(), false);
  assert.equal(h.redo().ok, true); assert.equal(h.currentHash(), h1);
  assert.equal(h.redo().ok, true); assert.equal(h.currentHash(), h2);
  assert.equal(h.current().world_version, m.world_version + 6, "every apply/undo/redo is a new version");
  h.undo();
  assert.deepEqual(h.list().map((e) => e.status), ["applied", "undone"]);
  // a new edit after undo truncates the redo tail
  assert.equal(h.apply(mk(h.current(), [{ op: "set", path: "ui.minimap", value: true }])).ok, true);
  assert.equal(h.size, 2);
  assert.equal(h.canRedo(), false);
  // rejected patches do not enter the history
  assert.equal(h.apply(mk(h.current(), [{ op: "set", path: "environment.weather", value: "lava" }])).ok, false);
  assert.equal(h.size, 2);
  // handed-out manifests are copies: mutating them cannot corrupt the history
  const before = h.currentHash();
  const leaked = h.current(); leaked.meta.title = "tampered";
  const res = h.undo(); res.manifest && (res.manifest.meta.title = "tampered too");
  assert.equal(hashManifest(h.current()), h.currentHash());
  assert.equal(h.redo().ok, true);
  assert.equal(h.currentHash(), before);
  // stale patches are rejected by the history too
  assert.equal(h.apply(mk(m, [{ op: "set", path: "environment.weather", value: "snow" }])).ok, false);
});

// -------------------------------------------------------- property-style loop

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function randomSetValue(path, r) {
  const s = SET_PATH_SPECS[path];
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  switch (s.type) {
    case "enum": return pick(s.values);
    case "number": return Number((s.min + r() * (s.max - s.min)).toFixed(3));
    case "int": return Math.floor(s.min + r() * Math.min(1000, s.max - s.min));
    case "boolean": return r() < 0.5;
    case "string": return `Edit ${Math.floor(r() * 1e6)}`;
    case "tags": return ["a", "b", "c"].slice(0, 1 + Math.floor(r() * 3));
    case "palette": return { ground: "#112233", accent: `#${Math.floor(r() * 0xffffff).toString(16).padStart(6, "0")}` };
    case "data": return r() < 0.3 ? null : { level: Number(r().toFixed(3)) };
  }
}

function randomOps(m, r, counter) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const n = 1 + Math.floor(r() * 4);
  const ops = [];
  const added = (c) => (m[c] || []).filter((x) => x.id.startsWith("gen_"));
  for (let i = 0; i < n; i++) {
    const k = Math.floor(r() * 9);
    const pos = () => ({ x: Number((r() * 300).toFixed(2)), y: 0, z: Number((r() * 400).toFixed(2)) });
    if (k === 0 || k === 1) { const p = pick(SET_PATH_WHITELIST); ops.push({ op: "set", path: p, value: randomSetValue(p, r) }); }
    else if (k === 2) {
      const id = `gen_${counter.n++}`;
      if (r() < 0.5) ops.push({ op: "add", collection: "items", value: { id, name: `Item ${id}`, kind: "trinket", asset_ref: pick(m.assets).id, stackable: r() < 0.5, effects: [] } });
      else ops.push({ op: "add", collection: "npcs", value: { id, name: `Npc ${id}`, role: "villager", zone: pick(m.zones).id, spawn: pos(), asset_ref: pick(m.assets).id, behavior_ref: null, dialogue: { seed: "Hello", lines: [] }, schedule: [], faction: null, stats: null } });
    } else if (k === 3) {
      const cands = [...added("items").map((x) => ["items", x.id]), ...added("npcs").map((x) => ["npcs", x.id])];
      if (cands.length) { const [c, id] = pick(cands); ops.push({ op: "remove", collection: c, id }); }
    } else if (k === 4) ops.push({ op: "update", collection: "zones", id: pick(m.zones).id, set: { name: `Zone ${Math.floor(r() * 1000)}`, density: Number(r().toFixed(2)) } });
    else if (k === 5) ops.push({ op: "update", collection: "structures", id: pick(m.structures).id, set: { purpose: `P${Math.floor(r() * 99)}`, interactable: r() < 0.5 } });
    else if (k === 6) {
      const c = pick(["structures", "npcs", "player_spawns"]);
      const arr = c === "player_spawns" ? m.spawn.player_spawns : m[c];
      ops.push({ op: "move", collection: c, id: pick(arr).id, position: pos() });
    } else if (k === 7) {
      const a = pick(m.assets);
      ops.push({ op: "replace_asset", asset_id: a.id, value: { ...a, lod: [{ level: 0, max_distance: 10 + Math.floor(r() * 500) }] } });
    } else {
      const set = SET_PATH_WHITELIST.filter((p) => SET_PATH_SPECS[p].source === "added" && p.split(".").reduce((o, s) => (o == null ? undefined : o[s]), m) !== undefined);
      if (set.length) ops.push({ op: "unset", path: pick(set) });
      else ops.push({ op: "set", path: "ui.hud_visible", value: true });
    }
    // later ops in the same patch see earlier ones only via the engine; keep ops independent by re-picking from m
  }
  return ops.length ? ops : [{ op: "set", path: "environment.weather", value: "clear" }];
}

test("property: 200 random valid patches, then full undo restores the hash, full redo and replay reproduce the end", async () => {
  const base = await fixture();
  for (const seed of [1, 42]) {
    const r = rng(seed);
    const h = createEditHistory(base);
    const counter = { n: 0 };
    const hashes = [h.currentHash()];
    const applied = [];
    let rejected = 0;
    while (applied.length < 200) {
      const cur = h.current();
      const p = mk(cur, randomOps(cur, r, counter));
      const res = h.apply(p);
      if (!res.ok) {
        // ops within one random patch can conflict (e.g. remove then update same id); that must be a clean rejection
        rejected++;
        assert.ok(rejected < 200, "generator should mostly produce valid patches: " + msgs(res));
        assert.equal(h.currentHash(), hashes.at(-1), "a rejected patch changes nothing");
        continue;
      }
      assert.equal(validateManifest(res.manifest).ok, true, "validateManifest after every apply");
      applied.push(p);
      hashes.push(h.currentHash());
      if (applied.length % 25 === 0) assert.equal(hashManifest(h.current()), h.currentHash(), "cached hash == recomputed hash");
    }
    const endHash = h.currentHash();
    // replay determinism
    const rp = replayPatches(base, applied);
    assert.equal(rp.ok, true, msgs(rp));
    assert.equal(hashManifest(rp.manifest), endHash);
    // full undo, checking every intermediate state
    for (let i = hashes.length - 2; i >= 0; i--) {
      const u = h.undo();
      assert.equal(u.ok, true, msgs(u));
      assert.equal(h.currentHash(), hashes[i], `undo step to ${i}`);
      assert.equal(validateManifest(u.manifest).ok, true);
    }
    assert.equal(h.currentHash(), hashManifest(base));
    assert.equal(hashManifest(h.current()), hashManifest(base), "recomputed: full undo restores the original content hash");
    assert.equal(h.current().world_version, base.world_version + 2 * applied.length);
    // full redo
    while (h.canRedo()) assert.equal(h.redo().ok, true);
    assert.equal(h.currentHash(), endHash);
    assert.equal(hashManifest(h.current()), endHash);
    // random interleaving of undo/redo against a model cursor
    let cursor = hashes.length - 1;
    for (let i = 0; i < 300; i++) {
      if (r() < 0.5 && cursor > 0) { assert.equal(h.undo().ok, true); cursor--; }
      else if (cursor < hashes.length - 1) { assert.equal(h.redo().ok, true); cursor++; }
      assert.equal(h.currentHash(), hashes[cursor]);
    }
  }
});

test("patch: works on a minimal emptyManifest world too", () => {
  const m = emptyManifest({ worldId: "w_empty", title: "Empty" });
  const p = mk(m, [{ op: "set", path: "environment.weather", value: "ash" }, { op: "move", collection: "player_spawns", id: "spawn_default", position: { x: 3, y: 1, z: 3 } }]);
  const r = applyPatch(m, p);
  assert.equal(r.ok, true, msgs(r));
  assert.equal(hashManifest(applyPatch(r.manifest, r.inverse).manifest), hashManifest(m));
});
