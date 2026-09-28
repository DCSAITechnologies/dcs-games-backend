// Games-D materials, lighting and audio (CONTRACT §3: material-styles.mjs,
// lighting.mjs, sfx.mjs) plus the Games-B hooks they rely on: the optional
// concept.material_style in buildMaterialSpec/resolveAssets, the texture
// surface passes, and the runtime's audio module.
//
// The baseline digests below were computed from base commit 63c5763 (before
// any of this existed). They pin the promise that nothing changes for a
// package without a material style.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMaterialSpec, MATERIAL_NAMES } from "../src/gamesb/assets/materials.mjs";
import { synthesizeTexture, TEXTURE_GENERATORS, SURFACE_PASSES } from "../src/gamesb/assets/texture-synth.mjs";
import { validateWorldSpec } from "../src/gamesb/world/world-spec.schema.mjs";
import { MATERIAL_STYLES, DEFAULT_STYLE_ID, styleIdFor, resolveStyle, materialConceptPatch } from "../src/gamesd/materials/material-styles.mjs";
import { LIGHTING, applyLighting, lightingFromText } from "../src/gamesd/world/lighting.mjs";
import { AUDIO_PRESETS, CUE_NAMES, audioFor, validateAudioSpec } from "../src/gamesd/audio/sfx.mjs";
import { THEMES } from "../src/gamesd/world/themes.mjs";
import { TEMPLATES } from "../src/gamesd/gameplay/templates.mjs";
import { LAYOUTS } from "../src/gamesd/missions/layouts.mjs";
import { buildFromRecipe } from "../src/gamesd/engine.mjs";
import { serveStatic, launchChrome, findChrome, Page } from "./helpers/browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMED_THEMES = ["storm_isle", "tropical_cove", "pine_valley", "swamp_fen", "dune_sea", "frost_peaks", "ember_caldera", "red_canyon", "sunken_ruins", "fog_city", "orbital_base", "crystal_hollow"];
const LIGHTING_IDS = ["dawn", "noon", "golden_hour", "dusk", "night", "overcast", "storm_dark", "neon_night"];
const sha = (x) => crypto.createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const firstKey = (o) => Object.keys(o)[0];

// ------------------------------------------------------------ baseline identity

const BASELINE_MATERIALS = "4a1a5f557b2e46ada3344ecb228d02ec27c9e79712d21e5f007ffb701c5b13c5";
const BASELINE_TEXTURES = "79cf780ed319d4d90f41666e4868ef2266ad935003f7502594ab14b199d8ebe9";
const PALS = [null, { primary: "#aa3322", secondary: "#224488", accent: "#ffcc00", ground: "#557733", sky: "#88bbee", water: "#2266aa" }];
const BIOMES = [null, "desert", "canyon", "snow", "volcanic", "forest", "island", "ruins", "city", "scifi_base"];

function allSpecs(extra = {}) {
  const out = [];
  for (const n of MATERIAL_NAMES) for (const palette of PALS) for (const biome of BIOMES) for (const textureSize of [128, 256]) out.push(buildMaterialSpec(n, { palette, biome, seed: 7, textureSize, ...extra }));
  return out;
}

test("baseline: without a style, buildMaterialSpec is byte-identical to Games-B at 63c5763", () => {
  assert.equal(sha(allSpecs()), BASELINE_MATERIALS);
  assert.equal(sha(allSpecs({ style: null })), BASELINE_MATERIALS, "style: null is the same as absent");
  assert.equal(sha(allSpecs({ style: undefined })), BASELINE_MATERIALS);
});

test("baseline: without surface params, texture synthesis is byte-identical to Games-B at 63c5763", () => {
  const h = crypto.createHash("sha256");
  for (const g of TEXTURE_GENERATORS) {
    const t = synthesizeTexture({ generator: g, size: 64, seed: 5, params: g === "metal" ? { panels: 3 } : {} });
    for (const k of ["albedo", "normal", "roughness"]) h.update(Buffer.from(t[k].buffer));
  }
  assert.equal(h.digest("hex"), BASELINE_TEXTURES);
});

// ------------------------------------------------------------ material styles

test("styles: every named theme and every theme in THEMES has a style; unknown ids get the default", () => {
  for (const id of NAMED_THEMES) assert.ok(MATERIAL_STYLES[id], `no style for ${id}`);
  for (const t of Object.values(THEMES)) {
    const sid = styleIdFor(t);
    assert.ok(MATERIAL_STYLES[sid], `theme ${t.id} → ${sid}`);
    assert.ok(MATERIAL_STYLES[t.material_style || t.id], `theme ${t.id} has no dedicated material style`);
    assert.notEqual(sid, DEFAULT_STYLE_ID);
  }
  assert.equal(styleIdFor({ id: "no_such_theme" }), DEFAULT_STYLE_ID);
  assert.equal(styleIdFor(null), DEFAULT_STYLE_ID);
  const notes = [];
  const c = materialConceptPatch({ title: "x" }, { theme: { id: "no_such_theme" }, recipe: { seed: 1 }, notes });
  assert.equal(c.material_style.id, DEFAULT_STYLE_ID);
  assert.equal(notes.length, 1);
  assert.equal(c.title, "x", "the patch only adds");
});

test("styles: each style gives the library materials a distinct look", () => {
  const sigs = new Map();
  for (const [id, preset] of Object.entries(MATERIAL_STYLES)) {
    const style = resolveStyle(preset, { seed: 0 });
    const specs = MATERIAL_NAMES.map((n) => buildMaterialSpec(n, { palette: null, biome: null, style }));
    for (const s of specs) {
      assert.ok(s, `${id}: a material vanished`);
      assert.equal(s.material.style, id);
      assert.match(s.material.color, /^#[0-9a-f]{6}$/);
      for (const t of s.textures) assert.ok(t.recipe.size <= 256, `${id}/${s.name}: texture ${t.recipe.size}px over budget`);
    }
    const sig = specs.map((s) => s.material.color + (s.material.emissive || "")).join("");
    assert.ok(!sigs.has(sig), `${id} has the same colours as ${sigs.get(sig)}`);
    sigs.set(sig, id);
  }
  // Ground materials differ between every pair of themed styles.
  const ground = (id) => ["grass", "rock", "sand", "dirt", "stone"].map((n) => buildMaterialSpec(n, { style: resolveStyle(MATERIAL_STYLES[id]) }).material.color).join();
  const ids = Object.keys(MATERIAL_STYLES).filter((i) => i !== DEFAULT_STYLE_ID);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) assert.notEqual(ground(ids[i]), ground(ids[j]), `${ids[i]} vs ${ids[j]}`);
  // And a style changes something against the unstyled baseline.
  assert.notDeepEqual(buildMaterialSpec("rock", { style: resolveStyle(MATERIAL_STYLES.ember_caldera) }), buildMaterialSpec("rock", {}));
});

test("styles: the per-recipe variant changes texture seeds, deterministically", () => {
  const a = resolveStyle(MATERIAL_STYLES.storm_isle, { seed: 1 }), b = resolveStyle(MATERIAL_STYLES.storm_isle, { seed: 1 }), c = resolveStyle(MATERIAL_STYLES.storm_isle, { seed: 2 });
  assert.deepEqual(a, b);
  assert.notEqual(a.seed_offset, c.seed_offset);
  assert.equal(resolveStyle(MATERIAL_STYLES.storm_isle, { seed: 5 }).seed_offset, a.seed_offset, "seed % 4 variants");
  const ra = buildMaterialSpec("rock", { style: a }).textures[0].recipe.seed, rc = buildMaterialSpec("rock", { style: c }).textures[0].recipe.seed;
  assert.notEqual(ra, rc);
});

function meanAbs(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
function column(t, x) { const N = t.width, out = []; for (let y = 0; y < N; y++) for (let c = 0; c < 3; c++) out.push(t.albedo[(y * N + x) * 4 + c]); return out; }
function row(t, y) { const N = t.width, out = []; for (let x = 0; x < N; x++) for (let c = 0; c < 3; c++) out.push(t.albedo[(y * N + x) * 4 + c]); return out; }
// The wrap seam (last column → first) must be no rougher than the roughest
// interior seam. Mean-vs-mean (the Games-B check) misfires on plank butt joints
// that happen to land on the tile edge, which are real features, not seams.
function assertTileable(t, label) {
  const N = t.width;
  let maxH = 0, maxV = 0;
  for (let i = 0; i < N - 1; i++) { maxH = Math.max(maxH, meanAbs(column(t, i), column(t, i + 1))); maxV = Math.max(maxV, meanAbs(row(t, i), row(t, i + 1))); }
  const wrapH = meanAbs(column(t, 0), column(t, N - 1)), wrapV = meanAbs(row(t, 0), row(t, N - 1));
  assert.ok(wrapH <= maxH * 1.25 + 3, `${label} horizontal seam ${wrapH.toFixed(1)} vs roughest interior ${maxH.toFixed(1)}`);
  assert.ok(wrapV <= maxV * 1.25 + 3, `${label} vertical seam ${wrapV.toFixed(1)} vs roughest interior ${maxV.toFixed(1)}`);
}

test("styles: every styled texture is deterministic and tileable", () => {
  for (const [id, preset] of Object.entries(MATERIAL_STYLES)) {
    const style = resolveStyle(preset, { seed: 3 });
    const names = [...new Set([...Object.keys(preset.materials || {}), "grass", "rock"])].filter((n) => MATERIAL_NAMES.includes(n));
    for (const n of names) {
      const spec = buildMaterialSpec(n, { style });
      if (!spec.textures.length) continue;
      const recipe = { ...spec.textures[0].recipe, size: 64 };
      const a = synthesizeTexture(recipe), b = synthesizeTexture(recipe);
      assert.deepEqual(a.albedo, b.albedo, `${id}/${n} albedo deterministic`);
      assert.deepEqual(a.normal, b.normal, `${id}/${n} normal deterministic`);
      assertTileable(a, `${id}/${n}`);
    }
  }
});

test("surface passes: each one changes the texture, stays tileable, and is deterministic", () => {
  const base = synthesizeTexture({ generator: "rock", size: 128, seed: 9 });
  for (const pass of SURFACE_PASSES) {
    const params = pass === "tint" ? { tint: "#ff0000", tint_amount: 0.3 } : { [pass]: 0.8 };
    const r = { generator: pass === "rust" || pass === "wear" ? "metal" : "rock", size: 128, seed: 9, params };
    const t = synthesizeTexture(r);
    const ref = r.generator === "rock" ? base : synthesizeTexture({ ...r, params: {} });
    assert.notDeepEqual(t.albedo, ref.albedo, `${pass} changed nothing`);
    assert.deepEqual(synthesizeTexture(r).albedo, t.albedo, `${pass} deterministic`);
    assertTileable(t, pass);
  }
});

// ------------------------------------------------------------ lighting

const BASE_ENV = {
  time_of_day: 0.45, weather: "clear",
  sky: { top: "#5a8ab0", horizon: "#b8d4ec", bottom: "#6a7a5a" },
  fog: { color: "#b8d4ec", near: 70, far: 350 },
  sun: { azimuth_deg: 160, elevation_deg: 55, color: "#fff3de", intensity: 1.4, shadows: true },
  ambient: { color: "#c8dcf0", ground_color: "#44552e", intensity: 0.55 },
  water: { enabled: true, level: 1.2, color: "#2f7fa6", opacity: 0.82 },
};

test("lighting: exactly the eight preset ids, each with name, time and keywords", () => {
  assert.deepEqual(Object.keys(LIGHTING).sort(), [...LIGHTING_IDS].sort());
  for (const p of Object.values(LIGHTING)) {
    assert.equal(typeof p.name, "string");
    assert.ok(p.time_of_day >= 0 && p.time_of_day <= 1);
    assert.ok(Array.isArray(p.keywords) && p.keywords.length >= 3);
  }
  for (const t of Object.values(THEMES)) for (const l of t.lightings || []) assert.ok(LIGHTING[l], `theme ${t.id} names unknown lighting '${l}'`);
  assert.equal(lightingFromText("a moonlit night in the woods"), "night");
  assert.equal(lightingFromText("neon cyberpunk alleys"), "neon_night");
  assert.equal(lightingFromText("xyzzy"), null);
});

test("lighting: applyLighting rewrites only the environment, and presets differ", () => {
  const world = { id: "w", title: "t", placements: [{ id: "p" }], environment: BASE_ENV };
  const envs = new Map();
  for (const id of LIGHTING_IDS) {
    for (const weather of ["clear", "storm", "fog"]) {
      const w = applyLighting({ ...world, environment: { ...BASE_ENV, weather } }, { lighting: LIGHTING[id], notes: [] });
      assert.equal(w.placements, world.placements, "only environment changes");
      const e = w.environment;
      assert.equal(e.lighting, id);
      assert.equal(e.weather, weather);
      assert.ok(e.fog.near < e.fog.far && e.fog.near >= 0);
      assert.deepEqual({ ...e.water, color: null }, { ...BASE_ENV.water, color: null }, "water level/opacity kept");
      // Legibility floors: never darker than the renderer can read.
      assert.ok(e.sun.intensity >= 0.6, `${id}/${weather} sun ${e.sun.intensity}`);
      assert.ok(e.ambient.intensity >= 0.45);
      if (weather === "clear") envs.set(id, JSON.stringify(e));
    }
  }
  assert.equal(new Set(envs.values()).size, LIGHTING_IDS.length, "every preset gives a different environment");
  assert.equal(applyLighting(world, { lighting: null }), world, "no preset → untouched");
  for (const id of ["night", "neon_night"]) {
    const e = applyLighting(world, { lighting: LIGHTING[id] }).environment;
    assert.ok(e.exposure >= 1.2 && e.lamp_boost > 1, `${id} lifts exposure and lamps`);
    assert.ok(e.sun.elevation_deg >= 30, `${id} has a high moon so the path is lit`);
  }
});

// ------------------------------------------------------------ audio

const fakeWorld = {
  environment: { weather: "rain" },
  placements: [
    { id: "pl_fire", asset_ref: "lib:campfire", position: { x: 10, y: 1, z: 12 } },
    { id: "pl_lamp", asset_ref: "lib:lantern_post", position: { x: 20, y: 1, z: 22 } },
    { id: "pl_tree", asset_ref: "lib:pine_tree", position: { x: 5, y: 1, z: 5 } },
  ],
  interactables: [{ id: "ix_lamp", kind: "lantern", placement_ref: "pl_lamp" }],
};

test("audio: every theme has a preset; audioFor is deterministic, valid and theme-specific", () => {
  for (const id of NAMED_THEMES) assert.ok(AUDIO_PRESETS[id], `no audio preset for ${id}`);
  for (const t of Object.values(THEMES)) assert.ok(AUDIO_PRESETS[t.audio || t.id], `theme ${t.id} has no dedicated audio preset`);
  const beds = new Map();
  for (const t of [...Object.values(THEMES), { id: "no_such_theme" }]) {
    const ctx = { theme: t, recipe: { seed: 4 }, world: fakeWorld, notes: [] };
    const a = audioFor(ctx), b = audioFor({ ...ctx, notes: [] });
    assert.deepEqual(a, b, `${t.id} deterministic`);
    const v = validateAudioSpec(a);
    assert.ok(v.ok, `${t.id}: ${JSON.stringify(v.errors)}`);
    assert.equal(a.audio_version, "1.0.0");
    for (const n of CUE_NAMES) assert.ok(a.cues[n], `${t.id} cue ${n}`);
    assert.ok(a.ambience.layers.some((l) => l.id === "rain"), "wet weather adds rain");
    if (t.id === "no_such_theme") { assert.equal(a.preset, "default"); assert.equal(ctx.notes.length, 1); }
    else beds.set(t.id, JSON.stringify(a.ambience));
  }
  assert.equal(new Set(beds.values()).size, beds.size, "each theme has its own ambience");
  const a = audioFor({ theme: THEMES[firstKey(THEMES)], recipe: { seed: 4 }, world: fakeWorld });
  assert.deepEqual(a.emitters.map((e) => [e.id, e.cue]), [["em_ix_lamp", "fire_pop"], ["em_pl_fire", "fire_pop"]]);
  assert.notDeepEqual(audioFor({ theme: THEMES[firstKey(THEMES)], recipe: { seed: 5 }, world: fakeWorld }).ambience, a.ambience, "seed varies the bed");
  assert.equal(validateAudioSpec({ audio_version: "1.0.0" }).ok, false);
});

test("audio runtime: inert without WebAudio or without pkg.audio, and never throws", async () => {
  const { createAudio, noAudio } = await import("../games-b-runtime/audio.mjs");
  const spec = audioFor({ theme: THEMES[firstKey(THEMES)], recipe: { seed: 1 }, world: fakeWorld });
  const a = createAudio(spec, { win: {} });
  assert.equal(a.state.present, true);
  assert.equal(a.state.available, false);
  assert.equal(a.start(), false);
  a.onEvents([{ kind: "pickup", ref: "item_1" }, { kind: "interact", ref: "ix" }, { kind: "status", value: "won" }], 1);
  a.onEvents([{ kind: "status", value: "won" }], 1.1);
  a.step({ player: { position: { x: 10, y: 1, z: 12 }, velocity: { x: 3, z: 0 }, grounded: true } }, 1);
  assert.deepEqual(a.state.cue_counts, { pickup: 1, win: 1, footstep: 1 }, "pickup suppresses interact; win only once");
  assert.equal(a.state.cues_sounded, 0);
  assert.equal(a.state.enabled, false);
  const b = createAudio(null, { win: { AudioContext: function () { throw new Error("nope"); } } });
  assert.equal(b.state.present, false);
  const c = createAudio(spec, { win: { AudioContext: function () { throw new Error("blocked"); } } });
  assert.equal(c.start(), false);
  assert.equal(c.state.available, false);
  assert.match(c.state.errors[0], /blocked/);
  assert.equal(noAudio().state.enabled, false);
});

// ------------------------------------------------------------ end to end

let fallbackPkg = null;

test("end to end: buildFromRecipe with a lighting override, style and audio", async () => {
  const theme = NAMED_THEMES.find((t) => THEMES[t]) || firstKey(THEMES);
  const recipe = { seed: 11, theme, template: firstKey(TEMPLATES), layout: firstKey(LAYOUTS), difficulty: "normal", lighting: "night" };
  const r = await buildFromRecipe(recipe);
  assert.ok(r.ok, JSON.stringify(r.validation?.errors?.slice(0, 3)));
  const pkg = r.pkg;
  assert.equal(pkg.world.environment.lighting, "night");
  assert.equal(pkg.world.environment.time_of_day, LIGHTING.night.time_of_day);
  const wv = validateWorldSpec(pkg.world, { concept: pkg.concept });
  assert.ok(wv.ok, JSON.stringify(wv.errors.slice(0, 3)));
  assert.equal(pkg.concept.material_style.id, styleIdFor(THEMES[theme]));
  const mats = pkg.assets.records.filter((x) => x.kind === "material");
  assert.ok(mats.length && mats.every((m) => m.payload.style === pkg.concept.material_style.id), "materials carry the style");
  assert.ok(validateAudioSpec(pkg.audio).ok);
  assert.equal(pkg.audio.preset, THEMES[theme].audio || theme);
  // Every lighting preset yields a valid world on the real pipeline.
  for (const lighting of LIGHTING_IDS) {
    const q = await buildFromRecipe({ ...recipe, lighting }, { playtest: false });
    const v = validateWorldSpec(q.pkg.world, { concept: q.pkg.concept });
    assert.ok(v.ok, `${lighting}: ${JSON.stringify(v.errors.slice(0, 3))}`);
    assert.equal(q.pkg.world.environment.lighting, lighting);
  }
  // Same recipe → same bytes.
  const again = await buildFromRecipe(recipe, { playtest: false });
  assert.equal(sha(again.pkg.audio), sha(pkg.audio));
  assert.equal(sha(again.pkg.world.environment), sha(pkg.world.environment));
  fallbackPkg = pkg;
});

// ------------------------------------------------------------ browser

const chrome = findChrome();
const browserSkip = !chrome ? "no Chrome binary (set DCS_CHROME)" : false;
let site, browser;
const TMP = path.join(ROOT, ".cache", "gamesd-audio-test");
after(async () => { await browser?.close(); await site?.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test("browser: a fallback package loads, audio initialises on a gesture, no console errors", { skip: browserSkip, timeout: 300000 }, async () => {
  assert.ok(fallbackPkg, "the end-to-end build ran first");
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, "package.json"), JSON.stringify(fallbackPkg));
  site = await serveStatic(ROOT);
  // Chrome can be slow to report its endpoint on a loaded machine: retry the launch.
  for (let i = 0; i < 3 && !browser; i++) {
    try { browser = await launchChrome({ extraArgs: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--autoplay-policy=no-user-gesture-required"] }); } catch (e) { if (i === 2) throw e; }
  }
  const page = await Page.open(browser);
  await page.goto(`${site.url}/games-b-runtime/play.html?pkg=/.cache/gamesd-audio-test/package.json&quality=low`, { waitMs: 300 });
  const ready = await page.waitFor("window.__DCS_GAMES_B__ && window.__DCS_GAMES_B__.ready", { timeout: 60000 });
  assert.ok(ready, `not ready: ${JSON.stringify(await page.eval("return window.__DCS_GAMES_B__ && window.__DCS_GAMES_B__.errors").catch(() => null))}`);
  const before = await page.eval("const a = window.__DCS_GAMES_B__.audio; return { present: a.present, started: a.started, muteHidden: document.getElementById('btn-mute').hidden };");
  assert.deepEqual(before, { present: true, started: false, muteHidden: false }, "nothing starts before a gesture");
  // A synthetic key press: the gesture listener runs start(). Chrome may keep
  // the context suspended (no real activation); it must still not error.
  const after1 = await page.eval(`
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyQ", key: "q" }));
    const H = window.__DCS_GAMES_B__;
    H.audio.cue("pickup");
    H.input({ move: { x: 1, z: 0 }, run: true });
    H.stepFrames(120);
    H.input({ clear: true });
    const a = H.audio;
    return { started: a.started, available: a.available, errors: a.errors, cues: a.cues_played, footsteps: a.cue_counts.footstep || 0, hookErrors: H.errors };`);
  assert.deepEqual(after1.errors, []);
  assert.deepEqual(after1.hookErrors, []);
  assert.ok(after1.cues >= 1);
  if (after1.available) assert.equal(after1.started, true);
  const muted = await page.eval("window.__DCS_GAMES_B__.audio.toggleMute(); return window.__DCS_GAMES_B__.audio.muted;");
  assert.equal(muted, true);
  const errs = page.consoleLogs.filter((l) => l.type === "error" && !/favicon/i.test(l.text));
  assert.deepEqual(errs, [], JSON.stringify(errs.slice(0, 3)));
  assert.deepEqual(page.pageErrors, []);
  await page.close();
});
