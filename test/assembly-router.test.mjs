// B1 exit gate. The router must produce a valid, materially richer world with
// every vendor down, must fail over between vendors, must never hard-depend on
// one of them, and must record honestly which one answered.
//
// These tests run OFFLINE by default so CI is free and deterministic. The live
// multi-vendor path is exercised separately by tools/live-provider-check.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { Lane, LANES, STATUS, parseJsonLoose, salvageTruncatedJson } from "../src/v3/providers/contract.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";
import { planWorldLocally, archetypeFor, rng } from "../src/v3/providers/local-planner.mjs";
import { generateTerrainLocally } from "../src/v3/providers/spatial.mjs";
import { resolveArchetype, buildAsset, ARCHETYPE_LIBRARY } from "../src/v3/providers/asset3d.mjs";
import { mediaAdapters } from "../src/v3/providers/media.mjs";
import { gameplayAdapters } from "../src/v3/providers/text.mjs";
import { generateWorld } from "../src/cw2/generate.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };
const router = () => createAssemblyRouter(OFFLINE);

// ------------------------------------------------------------ lane contract

test("B1 GATE: every lane has a fallback — no lane can hard-depend on a vendor", async () => {
  const d = await router().describe();
  // Assert the lanes by NAME rather than by count: adding a lane (vision, for
  // 9.1 multimodal) is expected, silently losing one is not.
  const names = d.lanes.map((l) => l.lane);
  for (const required of ["world_architect", "fast_inference", "spatial", "asset_3d", "gameplay", "media"]) {
    assert.ok(names.includes(required), `lane '${required}' is missing`);
  }
  for (const lane of d.lanes) {
    assert.ok(lane.adapters.some((a) => a.is_fallback && a.status === STATUS.FALLBACK),
      `lane ${lane.lane} has no working fallback`);
  }
});

test("constructing a lane with no fallback is refused outright", () => {
  assert.throws(
    () => new Lane("bad", [{ name: "only-vendor", rank: 1, isFallback: false, status: async () => STATUS.AVAILABLE, invoke: async () => ({}) }]),
    /every lane must work with all vendors down/
  );
});

test("a lane tries adapters in rank order and reports which one answered", async () => {
  const calls = [];
  const mk = (name, rank, fail, isFallback = false) => ({
    name, rank, isFallback, model: name,
    status: async () => (isFallback ? STATUS.FALLBACK : STATUS.AVAILABLE),
    invoke: async () => { calls.push(name); if (fail) throw new Error("boom"); return { ok: true }; },
  });
  const lane = new Lane("t", [mk("second", 20, false), mk("first", 10, true), mk("fb", 99, false, true)]);
  const r = await lane.run({});
  assert.deepEqual(calls, ["first", "second"], "rank order, stopping at the first success");
  assert.equal(r.provenance.provider, "second");
  assert.equal(r.provenance.status, STATUS.AVAILABLE);
  assert.deepEqual(r.provenance.after_failed, ["first"], "the failure is recorded, not hidden");
});

test("B1 GATE: when every vendor fails, the deterministic fallback still delivers", async () => {
  const mk = (name, rank) => ({
    name, rank, isFallback: false,
    status: async () => STATUS.AVAILABLE,
    invoke: async () => { throw new Error("vendor down"); },
  });
  const lane = new Lane("t", [
    mk("v1", 10), mk("v2", 20),
    { name: "fb", rank: 99, isFallback: true, model: "deterministic", status: async () => STATUS.FALLBACK, invoke: async () => ({ built: true }) },
  ]);
  const r = await lane.run({});
  assert.equal(r.value.built, true);
  assert.equal(r.provenance.status, STATUS.FALLBACK, "a fallback result is labelled FALLBACK, never AVAILABLE");
  assert.equal(r.attempts.length, 2);
});

// ------------------------------------------------------- JSON robustness

test("a JSON response wrapped in prose or a code fence is parsed", () => {
  assert.deepEqual(parseJsonLoose('Sure!\n```json\n{"a":1}\n```\nHope that helps'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go: {"a":[1,2]} — done'), { a: [1, 2] });
});

test("B1: a response truncated at the token limit is salvaged, not discarded", () => {
  const full = JSON.stringify({ behaviors: [{ id: "a", kind: "door", spec: { opens: "inward" } }, { id: "b", kind: "elevator", spec: { floors: [0, 3] } }], interactions: [{ id: "i1" }] });
  const cut = full.slice(0, full.indexOf("interactions") - 5);
  const r = parseJsonLoose(cut);
  assert.equal(r.behaviors.length, 2, "the complete prefix survives");
  assert.equal(r.behaviors[1].kind, "elevator");
});

test("salvage never invents a value out of unusable input", () => {
  assert.equal(salvageTruncatedJson('{"a": "unterminated'), null);
  assert.equal(salvageTruncatedJson("not json at all"), null);
  assert.equal(parseJsonLoose("the model refused"), null);
});

// -------------------------------------------------- deterministic planner

test("B1 GATE: the same prompt and seed always produce the same world", () => {
  const a = planWorldLocally({ prompt: "A rainy nordic port", seed: 42 });
  const b = planWorldLocally({ prompt: "A rainy nordic port", seed: 42 });
  assert.deepEqual(a, b, "generation must be reproducible for the playtest and E2E proofs");
});

test("B1 GATE: different prompts produce materially different worlds, not one skeleton", () => {
  const port = planWorldLocally({ prompt: "A rainy nordic port town" });
  const station = planWorldLocally({ prompt: "An orbital research station above Mars" });
  const manor = planWorldLocally({ prompt: "A haunted manor with a blackout" });

  assert.notDeepEqual(port.zones.map((z) => z.name), station.zones.map((z) => z.name));
  assert.notDeepEqual(station.zones.map((z) => z.name), manor.zones.map((z) => z.name));
  assert.notEqual(port.genre, station.genre);
  assert.notEqual(port.environment.weather, station.environment.weather);
  // and the building vocabulary differs, which is what the old generator failed at
  const arche = (p) => new Set(p.structures.map((s) => s.archetype));
  const shared = [...arche(port)].filter((a) => arche(station).has(a));
  assert.equal(shared.length, 0, "a port and a space station must not share a building set");
});

test("archetype selection is driven by the prompt", () => {
  assert.equal(archetypeFor("a rainy harbour").name, "port");
  assert.equal(archetypeFor("neon cyber city downtown").name, "city");
  assert.equal(archetypeFor("dragon castle kingdom").name, "fantasy");
  assert.equal(archetypeFor("haunted asylum").name, "horror");
  assert.equal(archetypeFor("orbital colony on mars").name, "scifi");
  assert.equal(archetypeFor("something entirely unclassifiable").name, "generic");
});

test("B1 GATE: structures are not laid out on a grid or stacked at the origin", () => {
  const p = planWorldLocally({ prompt: "A rainy nordic port town", seed: 7 });
  const xs = p.structures.map((s) => s.position.x);
  const zs = p.structures.map((s) => s.position.z);
  assert.ok(p.structures.length >= 6, `expected a populated world, got ${p.structures.length} structures`);
  assert.equal(new Set(xs.map((x) => x.toFixed(1))).size, xs.length, "no two structures share an x");
  assert.ok(Math.max(...zs) - Math.min(...zs) > 20, "structures must spread across the world");
  assert.ok(p.structures.every((s) => s.position.x !== 0 || s.position.z !== 0), "nothing sits at the origin");
  const heights = new Set(p.structures.map((s) => Math.round(s.footprint.h)));
  assert.ok(heights.size > 2, "buildings must vary in height, not be uniform boxes");
});

test("every locally planned quest step targets something that exists", () => {
  for (const prompt of ["A rainy nordic port", "A neon city", "A haunted manor", "An orbital station", "A jungle expedition"]) {
    const p = planWorldLocally({ prompt });
    const ids = new Set([...p.zones.map((z) => z.id), ...p.structures.map((s) => s.id), ...p.npcs.map((n) => n.id), ...p.items.map((i) => i.id)]);
    for (const q of p.quests) {
      assert.ok(q.steps.length >= 2, `${prompt}: quest ${q.id} needs multiple steps`);
      for (const st of q.steps) assert.ok(ids.has(st.target), `${prompt}: step ${st.id} targets missing '${st.target}'`);
    }
  }
});

// ------------------------------------------------------------- spatial lane

test("terrain is a real heightmap with roads and building pads levelled into it", () => {
  const plan = planWorldLocally({ prompt: "A rainy nordic port town", seed: 3 });
  const t = generateTerrainLocally({ seed: 3, size: plan.size, zones: plan.zones, roads: plan.roads, structures: plan.structures });
  assert.equal(t.terrain.kind, "heightmap");
  assert.ok(t.terrain.data.length > 20 && t.terrain.data[0].length > 20);
  const flat = t.terrain.data.flat();
  assert.ok(Math.max(...flat) - Math.min(...flat) > 1, "the terrain must actually have relief");
  assert.equal(t.terrain.pads.length, plan.structures.length, "every structure gets a levelled pad");
  assert.ok(t.navigation.walkable_zones.every((w) => w.walkable_fraction > 0), "every zone must have somewhere to stand");
});

test("the spawn point avoids buildings and picks flat ground", () => {
  const plan = planWorldLocally({ prompt: "A neon city downtown", seed: 11 });
  const t = generateTerrainLocally({ seed: 11, size: plan.size, zones: plan.zones, roads: plan.roads, structures: plan.structures });
  assert.ok(t.spawn_hint, "a spawn hint is required");
  for (const s of plan.structures) {
    const d = Math.hypot(s.position.x - t.spawn_hint.x, s.position.z - t.spawn_hint.z);
    assert.ok(d >= Math.max(s.footprint.w, s.footprint.d) * 0.8, `spawn is inside structure ${s.id}`);
  }
});

// -------------------------------------------------------------- asset lane

test("B2: an unknown archetype resolves to the nearest curated asset, never to a bare cube", () => {
  assert.equal(resolveArchetype("warehouse"), "warehouse");
  assert.equal(resolveArchetype("fish_market"), "fish_market");
  assert.ok(ARCHETYPE_LIBRARY[resolveArchetype("something_never_seen", "building")]);
  assert.equal(resolveArchetype("anything", "character"), "humanoid");
  assert.equal(resolveArchetype("anything", "vehicle"), "runabout");
});

test("B2 GATE: assets carry collision, LOD tiers, PBR and licence metadata", () => {
  const a = buildAsset("tavern", { footprint: { w: 10, d: 8, h: 7 } });
  assert.equal(a.kind, "building");
  assert.ok(a.composition.parts.length >= 3, "an asset is composed of real parts, not one primitive");
  assert.equal(a.collision.solid, true);
  assert.equal(a.lod.length, 3);
  assert.ok(a.lod[0].polycount > a.lod[1].polycount && a.lod[1].polycount > a.lod[2].polycount, "LOD must actually reduce");
  assert.ok(a.pbr.roughness > 0);
  assert.equal(a.license.commercial_use, "internal-testing-only");
});

test("a character asset carries the animations the runtime needs", () => {
  const a = buildAsset("humanoid", { kindHint: "character" });
  for (const clip of ["idle", "walk", "run", "talk"]) assert.ok(a.animations.includes(clip), `missing ${clip}`);
  assert.equal(a.collision.kind, "capsule");
});

// ------------------------------------------------------- full assembly

test("B1 GATE: a complete world assembles and validates with every vendor down", async () => {
  const out = await router().assemble({ prompt: "Ashfall Harbour, a rainy nordic port town", worldId: "w1", creatorId: "u1" });
  assert.equal(out.validation.ok, true, JSON.stringify(out.validation.errors, null, 2));
  const m = out.manifest;
  assert.ok(m.zones.length >= 3, `zones: ${m.zones.length}`);
  assert.ok(m.structures.length >= 5, `structures: ${m.structures.length}`);
  assert.ok(m.npcs.length >= 4, `npcs: ${m.npcs.length}`);
  assert.ok(m.quests.length >= 1, `quests: ${m.quests.length}`);
  assert.ok(m.behaviors.length >= 5, `behaviors: ${m.behaviors.length}`);
  assert.ok(m.interactions.length >= 5, `interactions: ${m.interactions.length}`);
  assert.equal(m.terrain.kind, "heightmap");
});

test("B1 GATE: provenance records every lane, its provider and its status", async () => {
  const out = await router().assemble({ prompt: "A neon city", worldId: "w2" });
  const lanes = out.provenance.map((p) => p.lane);
  for (const l of [LANES.WORLD_ARCHITECT, LANES.FAST_INFERENCE, LANES.SPATIAL, LANES.ASSET_3D, LANES.GAMEPLAY]) {
    assert.ok(lanes.includes(l), `provenance is missing lane ${l}`);
  }
  assert.ok(out.provenance.every((p) => p.provider && p.status), "every record names a provider and a status");
  assert.ok(out.provenance.every((p) => p.status === STATUS.FALLBACK), "offline, every lane must honestly report FALLBACK");
});

test("B1 GATE: the assembled world materially exceeds the cube/cylinder prototype", async () => {
  const legacy = await generateWorld("Ashfall Harbour, a rainy nordic port town");
  const out = await router().assemble({ prompt: "Ashfall Harbour, a rainy nordic port town", worldId: "w3" });
  const m = out.manifest;

  // The old generator emitted flat objects with no behaviour, no zones, no
  // collision and no LOD. Compare on the things a player would actually notice.
  assert.ok(m.structures.length >= (legacy.objects || []).length, `structures ${m.structures.length} vs legacy ${(legacy.objects || []).length}`);
  assert.equal((legacy.behaviors || []).length, 0, "the legacy world had no behaviours at all");
  assert.ok(m.behaviors.length >= 10, `V3 must ship real interactive behaviour, got ${m.behaviors.length}`);
  assert.ok(new Set(m.behaviors.map((b) => b.kind)).size >= 4, "several kinds of interaction, not one repeated");
  assert.equal(legacy.terrain.type, "tilegrid");
  assert.equal(m.terrain.kind, "heightmap", "V3 terrain has real relief");
  assert.ok(m.zones.length >= 3, "V3 has districts; the legacy world had none");
  assert.ok(m.assets.every((a) => a.lod && a.collision), "every V3 asset carries LOD and collision");
});

test("B1: media is optional — a world assembles identically without it", async () => {
  const a = await router().assemble({ prompt: "A jungle expedition", worldId: "w4" });
  const b = await router().assemble({ prompt: "A jungle expedition", worldId: "w4", media: true });
  assert.equal(a.validation.ok, true);
  assert.equal(b.validation.ok, true);
  assert.equal(a.manifest.media.thumbnail_ref, null, "no media requested, no ref");
  assert.equal(b.manifest.media.thumbnail_is_placeholder, true, "offline, the placeholder is labelled as one");
  assert.deepEqual(Object.keys(a.manifest).sort(), Object.keys(b.manifest).sort(), "the manifest SHAPE must not depend on media availability");
});

test("B1: a dangling model reference is dropped, never invented", async () => {
  const lane = new Lane(LANES.GAMEPLAY, [{
    name: "hallucinating-vendor", rank: 1, isFallback: false,
    status: async () => STATUS.AVAILABLE,
    invoke: async () => ({ behaviors: [{ id: "b_ok", kind: "door", spec: { opens: "inward" } }], interactions: [{ id: "i_bad", trigger: "interact", target_ref: "structure_that_does_not_exist", behavior_ref: "b_ok" }] }),
  }, { name: "fb", rank: 99, isFallback: true, status: async () => STATUS.FALLBACK, invoke: async () => ({ behaviors: [], interactions: [] }) }]);
  const r = createAssemblyRouter(OFFLINE);
  r.lanes[LANES.GAMEPLAY] = lane;
  const out = await r.assemble({ prompt: "A test town", worldId: "w5" });
  assert.equal(out.validation.ok, true);
  assert.equal(out.manifest.interactions.length, 0, "an interaction on a non-existent target is dropped");
  assert.ok(out.manifest.behaviors.some((b) => b.id === "b_ok"), "the valid behaviour survives");
});

test("B1: a model returning out-of-range geometry is clamped into the world", async () => {
  const lane = new Lane(LANES.WORLD_ARCHITECT, [{
    name: "sloppy-vendor", rank: 1, isFallback: false,
    status: async () => STATUS.AVAILABLE,
    invoke: async () => ({
      title: "Sloppy", size: { w: 200, h: 200 },
      zones: [{ id: "z1", name: "Z", kind: "district", bounds: [-500, -500, 9999, 9999] }],
      structures: [{ id: "s1", zone: "z1", archetype: "shop", position: { x: 100000, y: 0, z: -4000 }, footprint: { w: 6, d: 6, h: 5 } }],
      npcs: [{ id: "n1", name: "N", zone: "nowhere", position: { x: 5, y: 0, z: 5 } }],
      items: [], quests: [],
    }),
  }, { name: "fb", rank: 99, isFallback: true, status: async () => STATUS.FALLBACK, invoke: async () => planWorldLocally({ prompt: "x" }) }]);
  const r = createAssemblyRouter(OFFLINE);
  r.lanes[LANES.WORLD_ARCHITECT] = lane;
  const out = await r.assemble({ prompt: "x", worldId: "w6" });
  assert.equal(out.validation.ok, true, JSON.stringify(out.validation.errors));
  const z = out.manifest.zones[0];
  assert.ok(z.bounds[0] >= 0 && z.bounds[2] <= 200, `zone bounds not clamped: ${z.bounds}`);
  const s = out.manifest.structures[0];
  assert.ok(s.transform.position.x >= z.bounds[0] && s.transform.position.x <= z.bounds[2], "structure clamped into its zone");
  assert.ok(out.manifest.npcs[0].zone, "an npc in an unknown zone is reassigned to a real one");
});

test("B1 GATE: no provider name leaks into the canonical manifest outside provenance", async () => {
  const out = await router().assemble({ prompt: "A neon city", worldId: "w7", media: true });
  const { provenance, ...rest } = out.manifest;
  const json = JSON.stringify(rest).toLowerCase();
  for (const vendor of ["cerebras", "deepseek", "openai", "anthropic", "kinix", "kynex"]) {
    assert.ok(!json.includes(`"${vendor}`), `vendor '${vendor}' leaked into the canonical manifest`);
  }
  assert.equal(validateManifest(out.manifest).ok, true);
});

// --------------------------------------------- the placeholder is not a hole

test("B1 GATE: the placeholder image cannot be made to carry markup a caller supplied", async () => {
  // The dimensions are interpolated into MARKUP, and they arrive from the
  // request body — server.mts passes `width: b.width, height: b.height`
  // straight through to this adapter. `width="${req.width || 1024}"` therefore
  // let a caller close the attribute and write their own, and the result was
  // base64'd into a data: URI and stored in the manifest as the world's key
  // art. The label beside it was already escaped; the numbers were assumed to
  // be numbers.
  const placeholder = mediaAdapters(OFFLINE).find((a) => a.isFallback);
  assert.ok(placeholder, "the media lane must have a deterministic fallback");

  const attacks = [
    '1024" onload="alert(1)',
    '600"><script>fetch("//evil")</script><rect x="',
    '1024"/><foreignObject><body onload="alert(1)"></body></foreignObject><rect width="',
    "javascript:alert(1)",
  ];
  for (const width of attacks) {
    const out = await placeholder.invoke({ kind: "image", label: "World", prompt: "x", width, height: 576 });
    const svg = Buffer.from(out.uri.split(",")[1], "base64").toString();
    assert.doesNotMatch(svg, /<script/i, `script injected via width=${JSON.stringify(width)}`);
    assert.doesNotMatch(svg, /onload=/i, `event handler injected via width=${JSON.stringify(width)}`);
    assert.doesNotMatch(svg, /foreignObject/i, `foreign content injected via width=${JSON.stringify(width)}`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+"/, svg.slice(0, 90));
  }

  // A real dimension is still honoured, and a nonsensical one falls back rather
  // than reaching the document at all.
  const good = await placeholder.invoke({ kind: "image", label: "World", prompt: "x", width: 800, height: 400 });
  assert.match(Buffer.from(good.uri.split(",")[1], "base64").toString(), /width="800" height="400"/);
  for (const bad of [-5, 0, 1e9, NaN, null, undefined, {}, ["x"], "eight hundred"]) {
    const out = await placeholder.invoke({ kind: "image", label: "World", prompt: "x", width: bad, height: bad });
    assert.match(Buffer.from(out.uri.split(",")[1], "base64").toString(), /width="1024" height="576"/, `width=${JSON.stringify(bad)}`);
  }

  // The label was already escaped and must stay that way.
  const labelled = await placeholder.invoke({ kind: "image", label: '</text><script>alert(1)</script>', prompt: "x" });
  assert.doesNotMatch(Buffer.from(labelled.uri.split(",")[1], "base64").toString(), /<script/i);
});

test("B1 GATE: the deterministic gameplay fallback cannot be made to throw", async () => {
  // The fallback is the lane's LAST adapter and the reason "no lane may
  // hard-depend on any single vendor" is true. If it throws there is nothing
  // behind it: Lane.run reports "every adapter failed" and the generation
  // returns a 500 rather than a plainer world.
  //
  // It threw. `n.position.x` assumed every NPC carries a position — which the
  // architect's declared schema promises, and which a live model omitting it on
  // one character out of six would break. The upstream adapters check only that
  // `zones` and `structures` are arrays, so nothing between the model and here
  // would have caught it.
  const fallback = gameplayAdapters(OFFLINE).find((a) => a.isFallback);
  assert.ok(fallback, "the gameplay lane must have a deterministic fallback");

  const inputs = {
    "an NPC with no position at all": { structures: [{ id: "s", enterable: true }], npcs: [{ id: "n" }], items: [], zones: [{ id: "z" }] },
    "coordinates that are not numbers": { structures: [], npcs: [{ id: "n", position: { x: NaN, y: NaN, z: "over there" } }], items: [], zones: [] },
    "a position under another name": { structures: [], npcs: [{ id: "n", spawn: { x: 5, y: 0, z: 7 } }], items: [], zones: [] },
    "null rows in every list": { structures: [null], npcs: [null, { id: "n" }], items: [null], zones: [null] },
    "collections that are not arrays": { structures: "x", npcs: 42, items: null, zones: {} },
    "rows with no id": { structures: [{}], npcs: [{}], items: [{}], zones: [{}] },
    "a footprint height that is not a height": { structures: [{ id: "s", footprint: { h: NaN } }, { id: "t", footprint: { h: "tall" } }], npcs: [], items: [], zones: [] },
    "nothing at all": {},
  };

  for (const [label, req] of Object.entries(inputs)) {
    const out = await fallback.invoke(req);
    assert.ok(Array.isArray(out.behaviors) && Array.isArray(out.interactions), `${label}: no result`);
    // And whatever it produces must be usable, not merely non-throwing.
    const json = JSON.stringify(out);
    assert.doesNotMatch(json, /NaN|Infinity/, `${label}: non-finite geometry reached the behaviours`);
    for (const b of out.behaviors) assert.ok(typeof b.id === "string" && b.id, `${label}: a behaviour with no id`);
    for (const i of out.interactions) {
      assert.ok(typeof i.target_ref === "string" && i.target_ref, `${label}: an interaction targeting nothing`);
      assert.ok(out.behaviors.some((b) => b.id === i.behavior_ref), `${label}: an interaction triggering a behaviour it did not make`);
    }
  }
});
