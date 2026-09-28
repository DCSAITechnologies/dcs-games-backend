// Games-B asset stage, end to end: resolveAssets over fixture world /
// characters / gameplay, the content-addressed cache, provider lanes (offline
// and with injected adapters), and baking to files. No network: lanes run with
// DCS_PROVIDERS_OFFLINE=1 or with injected fakes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { resolveAssets, collectRequiredRefs, assetIdFor } from "../src/gamesb/assets/asset-pipeline.mjs";
import { createAssetCache } from "../src/gamesb/assets/cache.mjs";
import { bake } from "../src/gamesb/assets/bake.mjs";
import { encodePng, decodePngHeader } from "../src/gamesb/assets/png.mjs";
import { synthesizeTexture } from "../src/gamesb/assets/texture-synth.mjs";
import { validateAssetRecord, validateAssetSet, REQUIRED_FIELDS } from "../src/gamesb/assets/asset-record.schema.mjs";
import { createImageLane, proceduralImageAdapter, proceduralMeshAdapter, runLane, estimateFluxCost, togetherFluxAdapter } from "../src/gamesb/assets/providers.mjs";
import { STATUS } from "../src/v3/providers/contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "test/fixtures/gamesb/assets");
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), "utf8"));
const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };
const CLOCK = () => "2026-09-28T12:00:00.000Z";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gamesb-assets-"));

const base = () => ({ concept: fixture("concept"), world: fixture("world"), characters: fixture("characters"), gameplay: fixture("gameplay"), gameId: "game_fixture", env: OFFLINE, clock: CLOCK });

test("resolveAssets: every needed ref resolves and the set validates", async () => {
  const out = await resolveAssets(base());
  assert.equal(out.validation.ok, true, JSON.stringify(out.validation.errors.slice(0, 5)));
  assert.deepEqual(out.validation.missing, []);
  for (const ref of ["lib:lighthouse", "lib:cottage", "lib:pine_tree", "lib:gem", "char:keeper_maren", "char:fox", "char:player", "mat:sand", "mat:grass", "mat:water",
    "icon:item_1", "icon:item_4", "sky:main", "ui:hud_frame", "ui:compass", "ui:prompt", "cine:intro", "tex:grass_albedo", "tex:grass_normal", "tex:grass_roughness"]) {
    assert.ok(out.byRef[ref], `byRef has ${ref}`);
  }
  // Every material a mesh part names exists, with its textures.
  const ids = new Set(out.records.map((r) => r.asset_id));
  for (const r of out.records.filter((x) => x.format === "mesh-recipe")) for (const p of r.payload.parts) assert.ok(out.byRef[p.material_ref], `${r.ref} → ${p.material_ref}`);
  for (const m of Object.values(out.materials)) for (const k of ["albedo_texture", "normal_texture", "roughness_texture"]) if (m.payload[k]) assert.ok(ids.has(m.payload[k]), `${m.ref}.${k}`);
  assert.equal(out.materials["mat:glow"].payload.albedo_texture, undefined, "glow is flat, no texture");
  // Icons chosen from what the pickup placement is, then from item kind.
  const icon = (ref) => out.records.find((r) => r.ref === ref).payload.icon_kind;
  assert.equal(icon("icon:item_1"), "gem");
  assert.equal(icon("icon:item_2"), "key");
  assert.equal(icon("icon:item_3"), "lantern_core");
  assert.equal(icon("icon:item_4"), "herb", "consumable with no pickup → herb");
  assert.ok(out.stats.est_triangles > 0 && out.stats.est_scene_triangles > out.stats.est_triangles);
  assert.equal(out.stats.count, out.records.length);
});

test("every record carries every required field and validates on its own", async () => {
  const out = await resolveAssets(base());
  for (const r of out.records) {
    for (const f of REQUIRED_FIELDS) assert.ok(f in r, `${r.ref} lacks ${f}`);
    assert.ok(r.provenance.license?.spdx && r.provenance.license?.commercial_use, `${r.ref} license`);
    const v = validateAssetRecord(r);
    assert.equal(v.ok, true, `${r.ref}: ${JSON.stringify(v.errors.slice(0, 3))}`);
  }
});

test("content addressing is stable across runs; identical content dedupes", async () => {
  const a = await resolveAssets(base());
  const b = await resolveAssets(base());
  assert.deepEqual(a.byRef, b.byRef, "same inputs → same asset ids");
  assert.deepEqual(a.records, b.records, "byte-identical with a pinned clock");
  for (const r of a.records) assert.equal(r.asset_id, assetIdFor(r.kind, r.payload), `${r.ref} id is content-derived`);
  // Two placements share lib:cottage → one record bound to both.
  const cottage = a.records.filter((r) => r.ref === "lib:cottage");
  assert.equal(cottage.length, 1);
  assert.deepEqual(cottage[0].game_bindings, [{ game_id: "game_fixture", refs: ["pl_cottage_a", "pl_cottage_b"] }]);
  assert.equal(new Set(a.records.map((r) => r.asset_id)).size, a.records.length, "no duplicate asset ids");
  // A different palette changes texture ids; the recipe for a lighthouse is palette-independent.
  const c2 = base(); c2.concept = { ...c2.concept, palette: { ...c2.concept.palette, ground: "#aa2222" } };
  const c = await resolveAssets(c2);
  assert.notEqual(c.byRef["tex:grass_albedo"], a.byRef["tex:grass_albedo"]);
  assert.equal(c.byRef["lib:lighthouse"], a.byRef["lib:lighthouse"]);
});

test("cache: second run is all hits at zero cost; versions stable; files are atomic JSON", async () => {
  const dir = tmp();
  try {
    const cache = createAssetCache(dir);
    const first = await resolveAssets({ ...base(), cache });
    assert.equal(first.stats.cache_hits, 0);
    assert.equal(first.stats.cache_misses, first.records.length);
    const again = createAssetCache(dir);                 // fresh handle: reads what is on disk
    const second = await resolveAssets({ ...base(), cache: again });
    assert.equal(second.stats.cache_misses, 0);
    assert.equal(second.stats.cache_hits, first.records.length);
    assert.equal(second.stats.cost_usd, 0);
    assert.deepEqual(second.byRef, first.byRef);
    for (const r of second.records) {
      assert.equal(r.source, "cached", r.ref);
      assert.equal(r.provenance.status, "CACHED", r.ref);
      assert.equal(r.cost_usd, 0);
      assert.equal(validateAssetRecord(r).ok, true, r.ref);
    }
    assert.ok(second.provenance.some((s) => s.status === "CACHED" && s.calls === first.records.length));
    assert.ok(second.records.every((r) => r.version === 1));
    const st = again.stats();
    assert.equal(st.entries, first.records.length);
    assert.equal(fs.readdirSync(path.join(dir, "records")).filter((f) => f.endsWith(".tmp")).length, 0, "no temp files left behind");
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")).refs["lib:lighthouse"]);
    // Changed content under the same ref bumps its version.
    const w = base(); w.world = { ...w.world, environment: { ...w.world.environment, weather: "storm" } };
    const third = await resolveAssets({ ...w, cache: createAssetCache(dir) });
    assert.equal(third.records.find((r) => r.ref === "sky:main").version, 2);
    assert.throws(() => again.get("../etc/passwd"), /invalid key/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("missing refs are detected", async () => {
  const out = await resolveAssets(base());
  const without = out.records.filter((r) => r.ref !== "lib:lighthouse" && r.ref !== "mat:roof");
  const v = validateAssetSet(without, { requiredRefs: Object.keys(out.byRef) });
  assert.equal(v.ok, false);
  assert.ok(v.missing.includes("lib:lighthouse") && v.missing.includes("mat:roof"));
  assert.ok(v.errors.some((e) => /material 'mat:roof' does not resolve/.test(e.message)), "cottage roof now dangles");
  const refs = collectRequiredRefs(base());
  assert.ok(refs.uses.get("lib:pine_tree").has("sc_pines"));
  assert.equal(refs.instances.get("lib:grass_tuft"), 120);
});

test("unknown lib and material refs still resolve, with warnings", async () => {
  const b = base();
  b.world = structuredClone(b.world);
  b.world.placements.push({ ...b.world.placements[1], id: "pl_odd", asset_ref: "lib:giant_seashell", role: "decor" });
  b.world.terrain.material_layers.push({ material_ref: "mat:lava", min_h: 50, max_h: 60, max_slope_deg: 90 });
  const out = await resolveAssets(b);
  assert.equal(out.validation.ok, true, JSON.stringify(out.validation.errors.slice(0, 3)));
  assert.ok(out.byRef["lib:giant_seashell"] && out.byRef["mat:lava"] && out.byRef["tex:lava_albedo"]);
  assert.ok(out.warnings.some((w) => /giant_seashell/.test(w)));
  assert.ok(out.warnings.some((w) => /mat:lava/.test(w) && /ember/.test(w)));
});

test("provider lanes offline → FALLBACK provenance naming the adapters that were skipped", async () => {
  const out = await resolveAssets(base());
  const tex = out.provenance.find((s) => s.stage === "textures");
  assert.equal(tex.status, "FALLBACK");
  assert.equal(tex.provider, "local:procedural");
  assert.deepEqual(tex.after_failed, ["together"]);
  const mesh = out.provenance.find((s) => s.stage === "assets" && s.lane === "gamesb_mesh");
  assert.equal(mesh.status, "FALLBACK");
  assert.deepEqual(mesh.after_failed, ["external-3d"]);
  for (const s of out.provenance) for (const k of ["stage", "lane", "provider", "model", "status", "latency_ms", "cost_usd", "at"]) assert.ok(k in s, `stage field ${k}`);
  const albedo = out.records.find((r) => r.ref === "tex:grass_albedo");
  assert.equal(albedo.provenance.status, "FALLBACK");
  assert.equal(albedo.provenance.lane, "gamesb_image");
  assert.deepEqual(albedo.provenance.after_failed, ["together"]);
  assert.equal(out.stats.cost_usd, 0);
  // The real Together adapter never reports AVAILABLE offline, key or not.
  assert.equal(await togetherFluxAdapter({ ...OFFLINE, TOGETHER_API_KEY: "x" }).status(), STATUS.UNAVAILABLE);
  assert.equal(await togetherFluxAdapter({}).status(), STATUS.UNAVAILABLE);
});

function fakeImageAdapter({ cost = 0.0007, delayMs = 15, calls }) {
  const png = encodePng({ width: 64, height: 64, data: synthesizeTexture({ generator: "noise", size: 64, seed: 1 }).albedo });
  return {
    name: "fake-flux", rank: 1, isFallback: false, model: "fake/flux-test",
    async status() { return STATUS.AVAILABLE; },
    async invoke(req) {
      calls.push(req.prompt);
      await new Promise((r) => setTimeout(r, delayMs));
      return { kind: "image", bytes: png, mime: "image/png", px_w: 64, px_h: 64, cost_usd: cost, _model: "fake/flux-test" };
    },
  };
}

test("an injected AVAILABLE image adapter is used; its cost and latency are recorded; cache makes the rerun free", async () => {
  const dir = tmp();
  try {
    const calls = [];
    const adapters = { image: [fakeImageAdapter({ calls }), proceduralImageAdapter()] };
    const out = await resolveAssets({ ...base(), adapters, cache: createAssetCache(dir) });
    const gen = out.records.filter((r) => r.source === "generated");
    const albedoCount = out.records.filter((r) => r.ref.endsWith("_albedo")).length;
    assert.equal(gen.length, albedoCount, "every albedo went through the provider");
    assert.equal(calls.length, albedoCount);
    for (const r of gen) {
      assert.equal(r.provider, "fake-flux");
      assert.equal(r.model, "fake/flux-test");
      assert.equal(r.format, "png");
      assert.equal(r.cost_usd, 0.0007);
      assert.ok(r.latency_ms >= 10, `latency recorded: ${r.latency_ms}`);
      assert.equal(r.provenance.status, "AVAILABLE");
      assert.match(r.prompt, /seamless tileable/);
      assert.equal(r.prompt_hash.length, 64);
      assert.ok(out.blobs[r.sha256], "bytes kept for baking");
      assert.equal(validateAssetRecord(r).ok, true);
    }
    assert.ok(Math.abs(out.stats.cost_usd - 0.0007 * albedoCount) < 1e-9);
    const stage = out.provenance.find((s) => s.stage === "textures" && s.status === "AVAILABLE");
    assert.equal(stage.provider, "fake-flux");
    assert.equal(stage.calls, albedoCount);
    assert.ok(stage.latency_ms >= 10 * albedoCount);
    assert.equal(out.validation.ok, true, JSON.stringify(out.validation.errors.slice(0, 3)));

    const calls2 = [];
    const again = await resolveAssets({ ...base(), adapters: { image: [fakeImageAdapter({ calls: calls2 }), proceduralImageAdapter()] }, cache: createAssetCache(dir) });
    assert.equal(calls2.length, 0, "cached: provider not called again");
    assert.equal(again.stats.cost_usd, 0);
    assert.ok(again.records.filter((r) => r.format === "png").every((r) => again.blobs[r.sha256]), "bytes come back from the cache");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a failing adapter degrades to the fallback and is named in after_failed", async () => {
  const broken = { name: "broken-3d", rank: 1, isFallback: false, model: "x", async status() { return STATUS.AVAILABLE; }, async invoke() { throw new Error("boom"); } };
  const warn = console.warn; console.warn = () => {};
  try {
    const out = await resolveAssets({ ...base(), adapters: { mesh: [broken, proceduralMeshAdapter()] } });
    const lh = out.records.find((r) => r.ref === "lib:lighthouse");
    assert.equal(lh.provenance.status, "FALLBACK");
    assert.deepEqual(lh.provenance.after_failed, ["broken-3d"]);
    assert.equal(lh.format, "mesh-recipe");
  } finally { console.warn = warn; }
});

test("an injected external-3D result becomes a glb record that keeps its recipe", async () => {
  const glb = { name: "fake-3d", rank: 1, isFallback: false, model: "fake-3d", async status() { return STATUS.AVAILABLE; },
    async invoke() { return { kind: "glb", uri: "https://example.invalid/a.glb", polycount: 1234, license: { spdx: "CC-BY-4.0" }, cost_usd: 0.05, _model: "fake-3d" }; } };
  const out = await resolveAssets({ ...base(), adapters: { mesh: [glb, proceduralMeshAdapter()] } });
  const lh = out.records.find((r) => r.ref === "lib:lighthouse");
  assert.equal(lh.format, "glb");
  assert.equal(lh.uri, "https://example.invalid/a.glb");
  assert.equal(lh.payload.builder, "parts", "procedural recipe kept as fallback geometry");
  assert.equal(lh.provenance.license.spdx, "CC-BY-4.0");
  assert.equal(lh.provenance.license.commercial_use, "unknown");
  assert.equal(lh.cost_usd, 0.05);
});

test("runLane shapes a §8 stage; cost estimate constant is per megapixel", async () => {
  const lane = createImageLane({ env: OFFLINE });
  const { value, stage } = await runLane(lane, { prompt: "x", recipe: { generator: "grass" } }, "textures");
  assert.equal(value.kind, "procedural");
  assert.equal(stage.status, "FALLBACK");
  assert.equal(stage.stage, "textures");
  assert.ok(estimateFluxCost(1024, 1024) > 0.002 && estimateFluxCost(1024, 1024) < 0.003);
});

test("bake: texture PNGs and SVGs written with file sha256, bytes and uri", async () => {
  const dir = tmp();
  try {
    const out = await resolveAssets(base());
    const subset = out.records.filter((r) => ["tex:grass_albedo", "tex:grass_normal", "tex:bark_roughness", "icon:item_1", "ui:compass", "lib:crate", "lib:cottage"].includes(r.ref));
    const { records, files } = await bake({ records: subset, outDir: dir });
    assert.equal(files.length, 5);
    for (const f of files) {
      const buf = fs.readFileSync(f.path);
      assert.equal(buf.length, f.bytes);
      assert.equal(crypto.createHash("sha256").update(buf).digest("hex"), f.sha256);
      const rec = records.find((r) => r.asset_id === f.asset_id);
      assert.equal(rec.uri, f.uri);
      assert.equal(rec.sha256, f.sha256);
      assert.equal(validateAssetRecord(rec).ok, true, JSON.stringify(validateAssetRecord(rec).errors));
      if (f.uri.endsWith(".png")) { const h = decodePngHeader(buf); assert.equal(h.width, 256); assert.equal(h.crc_ok, true); }
      else assert.match(buf.toString("utf8"), /^<svg/);
    }
    assert.equal(records.find((r) => r.ref === "lib:cottage").uri, null, "meshes are not files");
    // Deterministic: baking twice gives the same bytes.
    const again = await bake({ records: subset, outDir: dir });
    assert.deepEqual(again.files.map((f) => f.sha256), files.map((f) => f.sha256));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
