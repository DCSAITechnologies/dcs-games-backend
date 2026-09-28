// Games-B asset stage, pure parts: record schema, mesh recipes, characters,
// materials, texture synthesis, PNG encoding. No network, no cache.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

import { validateAssetRecord, validateAssetSet, REQUIRED_FIELDS } from "../src/gamesb/assets/asset-record.schema.mjs";
import { buildMeshRecipe, buildCharacterRecipe, nearestLibName, estimateTriangles, LIB_NAMES, LIB_ROLES } from "../src/gamesb/assets/mesh-recipes.mjs";
import { synthesizeTexture, TEXTURE_GENERATORS } from "../src/gamesb/assets/texture-synth.mjs";
import { buildMaterialSpec, MATERIAL_NAMES, MATERIAL_REFS } from "../src/gamesb/assets/materials.mjs";
import { encodePng, decodePngHeader, extractIdat, crc32 } from "../src/gamesb/assets/png.mjs";
import { iconSvg, uiSvg, skyRecipe, ICON_KINDS } from "../src/gamesb/assets/svg.mjs";
import { buildIntroCinematic } from "../src/gamesb/assets/cinematic.mjs";
import { recipeToSvg } from "../src/gamesb/assets/preview.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "test/fixtures/gamesb/assets");
const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), "utf8"));

const CONTRACT_LIB = {
  structure: "lighthouse watchtower stone_hut cottage ruin_arch ruin_wall ruin_pillar shrine dock bridge well tent campfire lantern_post altar beacon_brazier gate statue obelisk",
  prop: "crate barrel chest signpost fence boat cart",
  foliage: "pine_tree broadleaf_tree palm_tree dead_tree bush grass_tuft rock_small rock_large cliff_rock cactus crystal_cluster mushroom flowers reeds",
  pickup: "lantern_core relic gem key scroll herb shard",
};
const CONTRACT_MATS = "grass sand rock dirt snow stone wood planks roof metal plaster leaves bark water cloth glow crystal brass ember".split(" ");

function goodRecord(over = {}) {
  return {
    asset_record_version: "1.0.0", asset_id: "ast_0123456789abcdef", ref: "lib:crate", kind: "prop", name: "crate",
    provider: "local:procedural", model: "deterministic", prompt: null, prompt_hash: "a".repeat(64), version: 1, source: "procedural",
    cost_usd: 0, latency_ms: 0, format: "mesh-recipe", dimensions: { w: 1, h: 1, d: 1 }, bytes: 10, sha256: "b".repeat(64),
    game_bindings: [{ game_id: "g", refs: ["pl_1"] }],
    provenance: { generated_at: "2026-09-28T00:00:00.000Z", lane: "local", adapter: "local:procedural", status: "FALLBACK", after_failed: [], license: { spdx: "CC0-1.0", commercial_use: "cleared" } },
    payload: buildMeshRecipe("crate"), uri: null, ...over,
  };
}

// ------------------------------------------------------------------ schema

test("record schema: a complete record validates", () => {
  const r = validateAssetRecord(goodRecord());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("record schema: every required field is enforced", () => {
  for (const f of REQUIRED_FIELDS) {
    const rec = goodRecord();
    delete rec[f];
    const r = validateAssetRecord(rec);
    assert.equal(r.ok, false, `missing ${f} should fail`);
    assert.ok(r.errors.some((e) => e.path === f || e.path.startsWith(f)), `error path for ${f}`);
  }
});

test("record schema: bad values are rejected with paths", () => {
  const cases = [
    [{ asset_id: "xyz" }, "asset_id"], [{ kind: "vehicle" }, "kind"], [{ format: "fbx" }, "format"], [{ cost_usd: -1 }, "cost_usd"],
    [{ sha256: "nothex" }, "sha256"], [{ dimensions: { w: 1 } }, "dimensions"], [{ version: 0 }, "version"],
    [{ provenance: { ...goodRecord().provenance, license: { spdx: "x", commercial_use: "maybe" } } }, "provenance.license.commercial_use"],
    [{ source: "cached" }, "provenance.status"],
    [{ payload: { builder: "parts", bounds: { w: 1, h: 1, d: 1 }, parts: [{ shape: "blob", material_ref: "wood", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }] } }, "payload.parts[0].shape"],
  ];
  for (const [over, p] of cases) {
    const r = validateAssetRecord(goodRecord(over));
    assert.equal(r.ok, false, `${JSON.stringify(over).slice(0, 60)} should fail`);
    assert.ok(r.errors.some((e) => e.path === p), `expected an error at ${p}, got ${JSON.stringify(r.errors.map((e) => e.path))}`);
  }
});

test("asset set: duplicate ids, unresolved material/texture refs and missing required refs are reported", () => {
  const mesh = goodRecord();
  const dup = goodRecord({ ref: "lib:crate2" });
  const mat = goodRecord({ asset_id: "ast_1111111111111111", ref: "mat:planks", kind: "material", format: "material", dimensions: null, payload: { material_id: "mat:planks", albedo_texture: "ast_ffffffffffffffff" } });
  const r = validateAssetSet([mesh, dup, mat], { requiredRefs: ["lib:crate", "lib:lighthouse"] });
  assert.equal(r.ok, false);
  const msgs = r.errors.map((e) => e.message).join("\n");
  assert.match(msgs, /duplicate asset_id/);
  assert.match(msgs, /texture 'ast_ffffffffffffffff' does not resolve/);
  assert.match(msgs, /material 'mat:wood' does not resolve/);
  assert.deepEqual(r.missing, ["lib:lighthouse"]);
});

// ------------------------------------------------------------ mesh recipes

test("the library covers exactly the §4.1a lib: names", () => {
  for (const [role, names] of Object.entries(CONTRACT_LIB)) assert.deepEqual([...LIB_ROLES[role]].sort(), names.split(" ").sort(), role);
  assert.equal(LIB_NAMES.length, 47);
});

test("every lib name builds a valid recipe: bounds, parts ≤ 40, known materials, triangles", () => {
  for (const name of LIB_NAMES) {
    for (const opts of [{ seed: 0 }, { seed: 99, biome: "snow", palette: fixture("concept").palette }]) {
      const r = buildMeshRecipe(name, opts);
      assert.equal(r.builder, "parts", name);
      assert.equal(r.lib, name);
      assert.ok(!r.warnings, `${name} should resolve exactly`);
      assert.ok(r.parts.length >= 1 && r.parts.length <= 40, `${name}: ${r.parts.length} parts`);
      for (const k of ["w", "h", "d"]) assert.ok(Number.isFinite(r.bounds[k]) && r.bounds[k] > 0, `${name} bounds.${k}`);
      assert.ok(r.bounds.max.y > 0.1, `${name} stands above ground`);
      assert.ok(r.bounds.min.y > -2, `${name} is not buried`);
      for (const p of r.parts) assert.ok(MATERIAL_REFS.includes(p.material_ref), `${name}.${p.name}: ${p.material_ref} not in material library`);
      assert.ok(estimateTriangles(r) > 0 && estimateTriangles(r) < 5000, `${name} triangle budget: ${estimateTriangles(r)}`);
      const v = validateAssetRecord(goodRecord({ payload: r }));
      assert.equal(v.ok, true, `${name}: ${JSON.stringify(v.errors.slice(0, 3))}`);
    }
  }
});

test("flagship silhouettes use shaped parts, not boxes", () => {
  const lh = buildMeshRecipe("lighthouse");
  assert.ok(lh.parts.some((p) => p.shape === "lathe" && p.name === "tower"), "lathed tower");
  assert.ok(lh.parts.filter((p) => p.name.startsWith("stripe")).length >= 2, "stripes");
  assert.ok(lh.parts.some((p) => p.material_ref === "mat:glow" && p.emissive), "emissive lamp");
  assert.ok(lh.parts.some((p) => p.shape === "torus"), "gallery railing");
  assert.ok(lh.bounds.h > 14, "tall");
  const tree = buildMeshRecipe("broadleaf_tree");
  assert.ok(tree.parts.filter((p) => p.shape === "icosphere" && p.noise > 0).length >= 3, "several displaced canopy lobes");
  assert.equal(buildMeshRecipe("rock_large").parts[0].shape, "rock");
  assert.ok(buildMeshRecipe("ruin_arch").parts.some((p) => p.shape === "extrude" && p.outline_plane === "xy" && p.outline.length > 10), "arch outline");
  assert.ok(buildMeshRecipe("cottage").parts.some((p) => p.shape === "extrude" && p.outline.length === 5), "gable walls");
});

test("recipes are deterministic and seed-varied", () => {
  assert.deepEqual(buildMeshRecipe("pine_tree", { seed: 5 }), buildMeshRecipe("pine_tree", { seed: 5 }));
  assert.notDeepEqual(buildMeshRecipe("pine_tree", { seed: 5 }), buildMeshRecipe("pine_tree", { seed: 6 }));
  const snowy = buildMeshRecipe("pine_tree", { seed: 5, biome: "snow" });
  assert.ok(snowy.parts.some((p) => p.material_ref === "mat:snow"), "snow biome caps the pines");
});

test("unknown lib names fall back to the nearest entry with a warning, never a throw", () => {
  const cases = [["lib:tree", "broadleaf_tree"], ["lib:old_oak", "broadleaf_tree"], ["lib:stone_tower", "watchtower"], ["lib:ancient_monolith", "obelisk"], ["lib:treasure_coffer", "chest"]];
  for (const [ref, want] of cases) {
    const r = buildMeshRecipe(ref);
    assert.equal(r.lib, want, ref);
    assert.equal(r.requested, ref);
    assert.match(r.warnings[0], /unknown lib name/);
  }
  assert.equal(nearestLibName("zzqx", { role: "pickup" }).name, "gem");
  assert.equal(nearestLibName("zzqx", { role: "structure" }).name, "stone_hut");
  assert.equal(nearestLibName(undefined).exact, false);
  assert.equal(nearestLibName("lib:lighthouse").exact, true);
});

// -------------------------------------------------------------- characters

test("character recipes carry a rig whose joints every part rides on", () => {
  const { characters } = fixture("characters");
  const all = [...characters, { id: "bot", kind: "robot", body: { height: 2, build: "broad", accessories: ["backpack", "goggles"] } }, { id: "wisp", kind: "spirit", body: { height: 1.4 } }];
  const expect = { humanoid: ["hip_l", "hip_r", "shoulder_l", "shoulder_r", "neck", "spine"], robot: ["hip_l", "hip_r", "shoulder_l", "shoulder_r"], creature: ["hip_fl", "hip_fr", "hip_bl", "hip_br", "neck", "tail"], spirit: ["core", "arm_l", "arm_r"] };
  for (const c of all) {
    const r = buildCharacterRecipe(c);
    assert.ok(r.rig && ["biped", "quadruped", "hover"].includes(r.rig.kind), c.id);
    for (const j of expect[c.kind]) {
      assert.ok(r.rig.joints[j], `${c.id} joint ${j}`);
      assert.ok(Number.isFinite(r.rig.joints[j].pivot.y), `${c.id} ${j} pivot`);
    }
    for (const p of r.parts) {
      assert.ok(p.joint && r.rig.joints[p.joint], `${c.id}.${p.name} rides joint '${p.joint}'`);
      assert.ok(MATERIAL_REFS.includes(p.material_ref), `${c.id}.${p.name} material`);
    }
    assert.ok(r.parts.length <= 40);
    const v = validateAssetRecord(goodRecord({ kind: "npc", payload: r }));
    assert.equal(v.ok, true, JSON.stringify(v.errors.slice(0, 3)));
  }
  const maren = buildCharacterRecipe(characters[0]);
  for (const n of ["leg_l", "leg_r", "arm_l", "arm_r", "head", "torso", "hat_crown", "lantern", "scarf"]) assert.ok(maren.parts.some((p) => p.name === n), `maren has ${n}`);
  assert.ok(Math.abs(maren.bounds.h - 1.7) < 0.25, `height honoured: ${maren.bounds.h}`);
  assert.ok(buildCharacterRecipe({ ...characters[0], body: { ...characters[0].body, build: "broad" } }).bounds.w > maren.bounds.w, "build widens");
});

// --------------------------------------------------------------- materials

test("every §4.1a mat: name has a material and its textures", () => {
  assert.deepEqual([...MATERIAL_NAMES].sort(), [...CONTRACT_MATS].sort());
  for (const n of MATERIAL_NAMES) {
    const s = buildMaterialSpec(`mat:${n}`, { palette: fixture("concept").palette, biome: "island" });
    assert.equal(s.material.material_id, `mat:${n}`);
    assert.match(s.material.color, /^#[0-9a-f]{6}$/);
    for (const t of s.textures) {
      assert.equal(t.ref, `tex:${n}_${t.channel}`);
      assert.ok(TEXTURE_GENERATORS.includes(t.recipe.generator));
    }
  }
  assert.ok(buildMaterialSpec("glow").material.emissive, "glow is emissive");
  assert.ok(buildMaterialSpec("water").material.transparent);
  assert.equal(buildMaterialSpec("nope"), null);
  assert.notEqual(buildMaterialSpec("roof", { palette: { primary: "#00ff00" } }).material.color, buildMaterialSpec("roof").material.color, "palette tints");
});

// ------------------------------------------------------------------ textures

function meanAbs(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
function column(t, x) { const N = t.width, out = []; for (let y = 0; y < N; y++) for (let c = 0; c < 3; c++) out.push(t.albedo[(y * N + x) * 4 + c]); return out; }
function row(t, y) { const N = t.width, out = []; for (let x = 0; x < N; x++) for (let c = 0; c < 3; c++) out.push(t.albedo[(y * N + x) * 4 + c]); return out; }

test("texture synthesis: every generator is deterministic, sized and seed-sensitive", () => {
  for (const g of TEXTURE_GENERATORS) {
    const a = synthesizeTexture({ generator: g, size: 64, seed: 11 });
    const b = synthesizeTexture({ generator: g, size: 64, seed: 11 });
    assert.equal(a.width, 64);
    for (const k of ["albedo", "normal", "roughness"]) {
      assert.equal(a[k].length, 64 * 64 * 4, `${g}.${k} length`);
      assert.deepEqual(a[k], b[k], `${g}.${k} deterministic`);
    }
    const c = synthesizeTexture({ generator: g, size: 64, seed: 12 });
    assert.notDeepEqual(a.albedo, c.albedo, `${g} seed changes output`);
  }
});

test("texture synthesis: tileable — the wrap seam is no rougher than an interior seam", () => {
  for (const g of TEXTURE_GENERATORS) {
    const t = synthesizeTexture({ generator: g, size: 128, seed: 3 });
    const N = t.width;
    const wrapH = meanAbs(column(t, 0), column(t, N - 1)), innerH = (meanAbs(column(t, 0), column(t, 1)) + meanAbs(column(t, N / 2), column(t, N / 2 + 1))) / 2;
    const wrapV = meanAbs(row(t, 0), row(t, N - 1)), innerV = (meanAbs(row(t, 0), row(t, 1)) + meanAbs(row(t, N / 2), row(t, N / 2 + 1))) / 2;
    assert.ok(wrapH <= innerH * 2.5 + 4, `${g} horizontal seam ${wrapH.toFixed(1)} vs interior ${innerH.toFixed(1)}`);
    assert.ok(wrapV <= innerV * 2.5 + 4, `${g} vertical seam ${wrapV.toFixed(1)} vs interior ${innerV.toFixed(1)}`);
  }
});

// The design budget is 50 ms per 256² texture (2–19 ms measured on an idle
// host). The assertion sits at 3× that: a bare 50 ms gate failed under a
// loaded CI host with no code change, and a flaky gate teaches people to
// ignore it. 150 ms still catches a real algorithmic regression.
const TEXTURE_BUDGET_MS = 50, TEXTURE_GATE_MS = 3 * TEXTURE_BUDGET_MS;

test("texture synthesis: 256² within budget per generator (best of 5)", () => {
  const timings = {};
  for (const g of TEXTURE_GENERATORS) {
    let best = Infinity;
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); synthesizeTexture({ generator: g, size: 256, seed: i }); best = Math.min(best, performance.now() - t0); }
    timings[g] = +best.toFixed(1);
    assert.ok(best < TEXTURE_GATE_MS, `${g} took ${best.toFixed(1)} ms (budget ${TEXTURE_BUDGET_MS}, gate ${TEXTURE_GATE_MS})`);
  }
  test.diagnostic?.(JSON.stringify(timings));
});

test("normal maps point outward and roughness is opaque grey", () => {
  const t = synthesizeTexture({ generator: "bricks", size: 64, seed: 1 });
  for (let i = 0; i < t.normal.length; i += 4) assert.ok(t.normal[i + 2] >= 128, "z ≥ 0");
  for (let i = 0; i < t.roughness.length; i += 4) { assert.equal(t.roughness[i], t.roughness[i + 1]); assert.equal(t.roughness[i + 3], 255); }
});

// ----------------------------------------------------------------------- PNG

function unfilter(raw, w, h) {
  const stride = w * 4, out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[dst + i - 4] : 0, b = y ? out[dst - stride + i] : 0, c = i >= 4 && y ? out[dst - stride + i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[dst + i] = (raw[src + i] + pred) & 255;
    }
  }
  return out;
}

test("PNG: signature, IHDR, CRCs, inflatable IDAT, pixels round-trip", () => {
  const t = synthesizeTexture({ generator: "roof_tiles", size: 64, seed: 2 });
  const png = encodePng({ width: 64, height: 64, data: t.albedo });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const h = decodePngHeader(png);
  assert.equal(h.width, 64); assert.equal(h.height, 64); assert.equal(h.bit_depth, 8); assert.equal(h.color_type, 6);
  assert.equal(h.crc_ok, true);
  assert.deepEqual(h.chunks, ["IHDR", "IDAT", "IEND"]);
  const raw = zlib.inflateSync(extractIdat(png));
  assert.equal(raw.length, 64 * (1 + 64 * 4));
  assert.deepEqual(unfilter(raw, 64, 64), Buffer.from(t.albedo));
  const bad = Buffer.from(png); bad[20] ^= 0xff;
  assert.equal(decodePngHeader(bad).crc_ok, false, "a flipped IHDR byte breaks its CRC");
  assert.equal(crc32(Buffer.from("IEND")), 0xae426082);
  assert.throws(() => decodePngHeader(Buffer.from("not a png at all, clearly not")), /signature/);
});

// ------------------------------------------------------- svg, sky, cinematic

test("icons, HUD and sky recipes", () => {
  for (const k of ICON_KINDS) {
    const s = iconSvg(k, { palette: { accent: "#123456" } });
    assert.match(s, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.ok(s.includes("#123456"));
  }
  assert.ok(iconSvg("unknown_thing").includes("generic"));
  assert.ok(!iconSvg("gem", { palette: { accent: '"><script>' }, title: "<b>" }).includes("<script>"), "palette and title are escaped");
  for (const n of ["hud_frame", "compass", "prompt"]) assert.match(uiSvg(n), /<svg/);
  assert.equal(uiSvg("nope"), null);
  const sky = skyRecipe(fixture("world").environment, { seed: 1 });
  assert.equal(sky.sun.elevation_deg, 28);
  assert.ok(sky.clouds.coverage > 0.5, "cloudy weather → cloud cover");
  assert.equal(skyRecipe({ time_of_day: 0.05 }).stars.enabled, true);
});

test("intro cinematic flies hub → landmarks → player spawn, above terrain", () => {
  const world = fixture("world");
  const c = buildIntroCinematic(world);
  assert.ok(c.points.length >= 3);
  assert.equal(c.points[0].region_ref, "region_harbour");
  assert.equal(c.points.at(-1).region_ref, "spawn_player");
  assert.ok(c.points.some((p) => p.region_ref === "region_lighthouse"));
  for (const p of c.points) {
    assert.ok(p.position.x >= 0 && p.position.x <= 160 && p.position.z >= 0 && p.position.z <= 160);
    assert.ok(Number.isFinite(p.look_at.y) && p.duration_s > 0);
  }
  assert.equal(c.duration_s, c.points.reduce((n, p) => n + p.duration_s, 0));
  assert.deepEqual(buildIntroCinematic(world), c, "deterministic");
  assert.ok(buildIntroCinematic({ size: { w: 50, h: 50 } }).points.length >= 2, "degrades on a bare world");
});

test("preview SVG renders every recipe", () => {
  for (const n of LIB_NAMES) assert.match(recipeToSvg(buildMeshRecipe(n)), /<path d="M/);
});

// The repo-wide lint covers the contract's iso list; these files are also meant
// to run in the browser (gallery, runtime) so hold them to the same rule.
test("browser-safe asset modules import nothing Node-side", () => {
  for (const f of ["texture-synth", "mesh-recipes", "asset-record.schema", "materials", "svg", "cinematic", "preview"]) {
    const src = fs.readFileSync(path.join(ROOT, "src/gamesb/assets", `${f}.mjs`), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) assert.ok(m[1].startsWith(".") && m[1].endsWith(".mjs") && !m[1].includes("v3/"), `${f}: ${m[1]}`);
    assert.doesNotMatch(src, /\bprocess\.|\bBuffer\b|\brequire\(|Math\.random\(/, f);
  }
});
