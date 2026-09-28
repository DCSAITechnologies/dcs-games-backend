#!/usr/bin/env node
// Games-D bench: build the sample catalogue with the zero-API fallback engine,
// score every sample headless and in a real browser, and write the lane's
// evidence into docs/games-d/.
//
//   node tools/gamesd-bench.mjs [--only <game_id>] [--no-browser] [--out <dir>] [--limit N] [--fps-seconds S]
//
// Writes
//   <out>/DCS_GAMES_LOCAL_SAMPLE_REPORT.md       per-sample table, totals, variety
//   <out>/DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv  presetMatrix() (samples/matrix.mjs) or a minimal one
//   <out>/evidence/bench.json                     everything, machine-readable
//   <out>/evidence/<game_id>.png                  one screenshot per sample (browser)
//   games-b-runtime/games/fallback/<game_id>/package.json
//
// Exit code is 0 whenever the bench ran; the numbers say how good the result is.

import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DCS_PROVIDERS_OFFLINE = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const OUT = path.resolve(ROOT, opt("--out", "docs/games-d"));
const ONLY = opt("--only");
const LIMIT = opt("--limit") ? Number(opt("--limit")) : null;
const NO_BROWSER = flag("--no-browser");
const FPS_SECONDS = Number(opt("--fps-seconds", "4"));
const EVIDENCE = path.join(OUT, "evidence");
const GAMES_DIR = path.join(ROOT, "games-b-runtime/games/fallback");
const log = (...a) => console.log("[gamesd-bench]", ...a);

const { buildFromRecipe } = await import("../src/gamesd/engine.mjs");
const { normaliseRecipe, validateRecipe, gameIdFor } = await import("../src/gamesd/recipe.mjs");
const { THEMES } = await import("../src/gamesd/world/themes.mjs");
const { TEMPLATES } = await import("../src/gamesd/gameplay/templates.mjs");
const { LAYOUTS } = await import("../src/gamesd/missions/layouts.mjs");
const { LIGHTING } = await import("../src/gamesd/world/lighting.mjs");
const { DIFFICULTY_LEVELS } = await import("../src/gamesd/difficulty.mjs");
const { scoreSample, varietyReport } = await import("../src/gamesd/quality/score.mjs");
const { ASSET_BUDGET, PERF_BUDGET } = await import("../src/gamesd/budgets.mjs");

// ------------------------------------------------------------ recipes

/** ≥10 recipes spread over the live tables, used only when samples/catalogue.mjs is missing. */
function builtInRecipes(n = 12) {
  const th = Object.keys(THEMES), tp = Object.keys(TEMPLATES), ly = Object.keys(LAYOUTS), lt = Object.keys(LIGHTING);
  const out = [];
  const seen = new Set();
  for (let i = 0; out.length < n && i < n * 20; i++) {
    const template = tp[i % tp.length];
    const need = TEMPLATES[template].needs?.locations_min || 0;
    const layouts = ly.filter((id) => LAYOUTS[id].locations >= need);
    const r = normaliseRecipe({
      seed: 101 + i * 7,
      theme: th[i % th.length],
      template,
      layout: layouts.length ? layouts[(i + Math.floor(i / tp.length)) % layouts.length] : ly[0],
      difficulty: DIFFICULTY_LEVELS[i % DIFFICULTY_LEVELS.length],
      lighting: lt.length ? lt[(i * 3) % lt.length] : null,
    });
    const id = gameIdFor(r);
    if (seen.has(id) || !validateRecipe(r).ok) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

async function loadRecipes() {
  try {
    const mod = await import("../src/gamesd/samples/catalogue.mjs");
    const s = mod.sampleRecipes;
    const list = typeof s === "function" ? await s() : s;
    if (Array.isArray(list) && list.length) return { source: "src/gamesd/samples/catalogue.mjs", recipes: list.map((x) => x.recipe || x) };
    log("catalogue.mjs has no sampleRecipes list; using the built-in list");
  } catch (e) {
    log(`catalogue.mjs unavailable (${e.code || e.message}); using the built-in list`);
  }
  return { source: "built-in (tools/gamesd-bench.mjs, from the live THEMES/TEMPLATES/LAYOUTS keys)", recipes: builtInRecipes() };
}

// ------------------------------------------------------------ matrix

const csvCell = (v) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(rows) {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

async function presetMatrixCsv() {
  try {
    const mod = await import("../src/gamesd/samples/matrix.mjs");
    if (typeof mod.matrixCsv === "function" && typeof mod.presetMatrix === "function") {
      const csv = await mod.matrixCsv(await mod.presetMatrix());
      if (typeof csv === "string" && csv.trim()) return { source: "src/gamesd/samples/matrix.mjs (presetMatrix + matrixCsv)", csv: csv.endsWith("\n") ? csv : csv + "\n" };
    }
    const m = typeof mod.presetMatrix === "function" ? await mod.presetMatrix() : null;
    if (typeof m === "string" && m.trim()) return { source: "src/gamesd/samples/matrix.mjs", csv: m.endsWith("\n") ? m : m + "\n" };
    if (Array.isArray(m) && m.length) {
      if (Array.isArray(m[0])) return { source: "src/gamesd/samples/matrix.mjs", csv: m.map((r) => r.map(csvCell).join(",")).join("\n") + "\n" };
      return { source: "src/gamesd/samples/matrix.mjs", csv: toCsv(m) };
    }
    if (m && typeof m === "object") {
      if (typeof m.csv === "string") return { source: "src/gamesd/samples/matrix.mjs", csv: m.csv };
      if (Array.isArray(m.rows)) {
        const rows = m.rows;
        if (Array.isArray(rows[0]) && Array.isArray(m.header || m.columns)) return { source: "src/gamesd/samples/matrix.mjs", csv: [(m.header || m.columns).map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n" };
        return { source: "src/gamesd/samples/matrix.mjs", csv: toCsv(rows) };
      }
    }
    log("presetMatrix() returned an unknown shape; writing the minimal matrix");
  } catch (e) {
    log(`matrix.mjs unavailable (${e.code || e.message}); writing the minimal matrix`);
  }
  const rows = [];
  for (const [id, t] of Object.entries(THEMES)) rows.push({ kind: "theme", id, name: t.name, detail: `biome=${t.biome}; shape=${t.terrain_shape || ""}; weathers=${(t.weathers || []).join("|")}; lightings=${(t.lightings || []).join("|")}; mood=${t.mood || ""}` });
  for (const [id, t] of Object.entries(TEMPLATES)) rows.push({ kind: "template", id, name: t.name, detail: `genre=${t.genre || ""}; timed=${!!t.timed}; needs=${JSON.stringify(t.needs || {})}` });
  for (const [id, l] of Object.entries(LAYOUTS)) rows.push({ kind: "layout", id, name: l.name, detail: `scale=${l.scale}; locations=${l.locations}; ordering=${l.ordering || ""}` });
  for (const [id, l] of Object.entries(LIGHTING)) rows.push({ kind: "lighting", id, name: l.name, detail: `time_of_day=${l.time_of_day ?? ""}` });
  for (const d of DIFFICULTY_LEVELS) rows.push({ kind: "difficulty", id: d, name: d, detail: "" });
  // Compatible (template, layout) pairs: the combinations a recipe may use.
  for (const tp of Object.keys(TEMPLATES)) for (const ly of Object.keys(LAYOUTS)) {
    const ok = validateRecipe(normaliseRecipe({ seed: 1, theme: Object.keys(THEMES)[0], template: tp, layout: ly })).ok;
    rows.push({ kind: "template×layout", id: `${tp}×${ly}`, name: ok ? "compatible" : "incompatible", detail: "" });
  }
  return { source: "minimal (tools/gamesd-bench.mjs, from the live tables)", csv: toCsv(rows) };
}

// ------------------------------------------------------------ run

function hostLoad() {
  const [l1, l5] = os.loadavg();
  const ncpu = os.cpus().length;
  return { loadavg_1m: Math.round(l1 * 10) / 10, loadavg_5m: Math.round(l5 * 10) / 10, ncpu, ratio: Math.round((l1 / ncpu) * 100) / 100 };
}
// Above this load per core, wall-clock frame times measure the queue, not the game.
const OVERLOADED_RATIO = 1.5;

const t0 = Date.now();
const { source: recipeSource, recipes: allRecipes } = await loadRecipes();
let recipes = allRecipes.map((r) => normaliseRecipe(r));
if (ONLY) recipes = recipes.filter((r) => gameIdFor(r) === ONLY);
if (LIMIT) recipes = recipes.slice(0, LIMIT);
log(`${recipes.length} recipe(s) from ${recipeSource}`);
fs.mkdirSync(EVIDENCE, { recursive: true });

const samples = [];
for (const recipe of recipes) {
  const game_id = gameIdFor(recipe);
  const s = { game_id, recipe, build: null, rebuild: null, error: null, pkgPath: null };
  try {
    const v = validateRecipe(recipe);
    if (!v.ok) throw new Error(`invalid recipe: ${v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    s.build = await buildFromRecipe(recipe);
    s.rebuild = await buildFromRecipe(recipe);
    const dir = path.join(GAMES_DIR, s.build.pkg.game_id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(s.build.pkg));
    s.pkgPath = `/games-b-runtime/games/fallback/${s.build.pkg.game_id}/package.json`;
    log(`built ${game_id} in ${s.build.build_ms} ms: ${s.build.playtest?.won ? "won" : "NOT won"} in ${s.build.playtest?.sim_seconds}s sim, sha equal ${s.build.pkg.integrity.sha256 === s.rebuild.pkg.integrity.sha256}`);
  } catch (e) {
    s.error = e.message;
    log(`build FAILED ${game_id}: ${e.message}`);
  }
  samples.push(s);
}

// A full run owns games-b-runtime/games/fallback/: drop packages from earlier runs whose recipe is gone.
if (!ONLY && !LIMIT && fs.existsSync(GAMES_DIR)) {
  const keep = new Set(samples.filter((s) => s.build).map((s) => s.build.pkg.game_id));
  for (const d of fs.readdirSync(GAMES_DIR)) if (!keep.has(d) && d.startsWith("fb_")) fs.rmSync(path.join(GAMES_DIR, d), { recursive: true, force: true });
}

let browserRun = { available: false, reason: NO_BROWSER ? "--no-browser" : null, results: {} };
const loadBefore = hostLoad();
if (!NO_BROWSER) {
  const { benchPackages } = await import("../src/gamesd/quality/browser-bench.mjs");
  const entries = samples.filter((s) => s.pkgPath).map((s) => ({ game_id: s.build.pkg.game_id, pkgPath: s.pkgPath }));
  browserRun = await benchPackages(entries, { evidenceDir: EVIDENCE, fpsSeconds: FPS_SECONDS, log: (m) => log(m) });
  if (!browserRun.available) log(`browser skipped: ${browserRun.reason}`);
}
const loadAfter = hostLoad();
const overloaded = Math.max(loadBefore.ratio, loadAfter.ratio) > OVERLOADED_RATIO;
if (overloaded && browserRun.available) log(`host overloaded (load ${loadBefore.loadavg_1m}→${loadAfter.loadavg_1m} on ${loadAfter.ncpu} cores): frame-time budgets reported but not gated`);

const scores = [];
for (const s of samples) {
  if (!s.build) {
    scores.push({ game_id: s.game_id, recipe: s.recipe, playable: false, reasons: [`build failed: ${s.error}`], errors: [s.error] });
    continue;
  }
  const browser = browserRun.available ? browserRun.results[s.build.pkg.game_id] || { ok: false, reason: "not benched", errors: ["not benched"] } : null;
  const sc = await scoreSample(s.build, { browser, rebuild: s.rebuild, perfGate: !overloaded });
  sc.browser = browser ? { ok: browser.ok, reason: browser.reason, load_ms: browser.load_ms, fps: browser.fps, save_reload: browser.save_reload, play: browser.play, screenshot: browser.screenshot ? path.relative(OUT, browser.screenshot) : null, audio: browser.audio, console_errors: browser.console_errors } : null;
  sc.headless_playtest = { won: s.build.playtest?.won, sim_seconds: s.build.playtest?.sim_seconds, plan_source: s.build.playtest?.plan_source, reason: s.build.playtest?.reason ?? null };
  scores.push(sc);
  log(`scored ${sc.game_id}: ${sc.playable ? "PLAYABLE" : "not playable: " + sc.reasons.join(" | ")}`);
}

// ------------------------------------------------------------ totals

const ok = scores.filter((s) => s.visual_signature);
const variety = varietyReport(ok);
const fpsVals = ok.map((s) => s.fps?.fps).filter((v) => typeof v === "number");
const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null);
const totals = {
  SAMPLES_CREATED: ok.length,
  SAMPLES_ATTEMPTED: scores.length,
  SAMPLES_PLAYABLE: scores.filter((s) => s.playable).length,
  WORLD_VARIANTS: variety.world_variants,
  GAMEPLAY_VARIANTS: variety.gameplay_variants,
  AVG_FPS: mean(fpsVals),
  SAVE_RELOAD_PASS: `${ok.filter((s) => s.save_reload.headless_ok && s.save_reload.browser_ok !== false).length}/${ok.length}`,
  SAVE_RELOAD_BROWSER_PASS: browserRun.available ? `${ok.filter((s) => s.save_reload.browser_ok === true).length}/${ok.length}` : "not run",
  DETERMINISTIC_REBUILD: `${ok.filter((s) => s.deterministic.rebuild_sha_equal === true).length}/${ok.length}`,
  WON_HEADLESS: `${ok.filter((s) => s.objective_completion.won).length}/${ok.length}`,
  BROWSER_LAUNCH_OK: browserRun.available ? `${ok.filter((s) => s.launch.browser_ok === true).length}/${ok.length}` : "not run",
  BUDGET_OK: `${ok.filter((s) => s.budgets.ok).length}/${ok.length}`,
  INSIDE_SOLID_SAMPLES: ok.reduce((a, s) => a + (s.collision.player_inside_solid_samples || 0), 0),
  MIN_PAIRWISE_VISUAL_DISTANCE: variety.min_pairwise,
  MEAN_PAIRWISE_VISUAL_DISTANCE: variety.mean_pairwise,
  NEAR_DUPLICATE_PAIRS: variety.near_duplicates.length,
};
const fpsSummary = fpsVals.length ? {
  min_fps: Math.min(...fpsVals), max_fps: Math.max(...fpsVals), avg_fps: mean(fpsVals),
  avg_p95_ms: mean(ok.map((s) => s.fps?.frame_ms_p95).filter((v) => typeof v === "number")),
  avg_load_ms: mean(ok.map((s) => s.launch.load_ms).filter((v) => typeof v === "number")),
  avg_draw_calls: mean(ok.map((s) => s.fps?.draw_calls).filter((v) => typeof v === "number")),
  max_draw_calls: Math.max(...ok.map((s) => s.fps?.draw_calls || 0)),
  max_triangles: Math.max(...ok.map((s) => s.fps?.triangles || 0)),
} : null;

const bench = {
  bench_version: "1.0.0",
  generated_at: new Date().toISOString(),
  wall_seconds: Math.round((Date.now() - t0) / 1000),
  git: (() => { try { const g = (a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim(); return { head: g(["rev-parse", "--short", "HEAD"]), branch: g(["rev-parse", "--abbrev-ref", "HEAD"]), dirty: g(["status", "--porcelain"]).split("\n").filter(Boolean).length }; } catch { return null; } })(),
  recipe_source: recipeSource,
  options: { only: ONLY, limit: LIMIT, no_browser: NO_BROWSER, fps_seconds: FPS_SECONDS },
  host: { platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus()[0]?.model, ncpu: os.cpus().length, load_before: loadBefore, load_after: loadAfter, overloaded, overloaded_ratio: OVERLOADED_RATIO, renderer: "SwiftShader (headless Chrome, CPU)" },
  browser: { available: browserRun.available, reason: browserRun.reason || null },
  budgets: { ASSET_BUDGET, PERF_BUDGET, perf_gated: !overloaded },
  totals, fps: fpsSummary,
  variety: { ...variety, distances: variety.distances.map(({ a, b, d }) => ({ a, b, d })) },
  samples: scores.map((s) => ({ ...s, visual_signature: s.visual_signature ? { labels: s.visual_signature.labels, groups: { ...s.visual_signature.groups } } : null })),
};
fs.writeFileSync(path.join(EVIDENCE, "bench.json"), JSON.stringify(bench, null, 1) + "\n");

// ------------------------------------------------------------ markdown

const yn = (v) => (v === true ? "yes" : v === false ? "**no**" : "–");
const num = (v, d = 1) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : "–");
const md = [];
md.push("# DCS Games local fallback: sample report", "");
md.push(`Generated ${bench.generated_at} by \`node tools/gamesd-bench.mjs${args.length ? " " + args.join(" ") : ""}\` in ${bench.wall_seconds} s. Zero paid APIs: every build ran with \`DCS_PROVIDERS_OFFLINE=1\` through \`buildFromRecipe()\`.`, "");
md.push(`Recipes: ${recipeSource}. Preset matrix: see \`DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv\`. Raw data: \`evidence/bench.json\`.`, "");
md.push("## Totals", "", "| metric | value |", "|---|---|");
for (const [k, v] of Object.entries(totals)) md.push(`| ${k} | ${v ?? "–"} |`);
md.push("");
md.push(`Host: ${bench.host.platform}, ${bench.host.ncpu} cores, load average ${loadBefore.loadavg_1m} before and ${loadAfter.loadavg_1m} after the browser pass. Renderer: ${bench.host.renderer}.`);
if (!browserRun.available) md.push("", `**Browser pass not run** (${browserRun.reason}); FPS, browser launch and browser save/reload are blank.`);
else if (overloaded) md.push("", `**The host was overloaded** (load per core above ${OVERLOADED_RATIO}), so wall-clock frame times measure the machine's queue as much as the game. FPS, p95 frame time, load time and build time were measured and are reported, but they were **not** used to decide \`playable\`; draw calls and triangles (load-independent) still were. The per-sample \`budgets.perf_advisory\` in bench.json lists what would have failed. Rerun on a quiet machine for FPS that can gate.`);
md.push("");

md.push("## Per-sample results", "");
md.push("| game_id | theme | template | layout | diff | light | scale | playable | won | obj | sim s | stuck | falls | in-solid | save H/B | det | fps | p95 ms | draws | tris | load ms | build ms | budget |");
md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const s of scores) {
  const r = s.recipe || {};
  if (!s.visual_signature) { md.push(`| ${s.game_id} | ${r.theme} | ${r.template} | ${r.layout} | ${r.difficulty} | ${r.lighting ?? "–"} | ${r.scale ?? "–"} | **no** | – | – | – | – | – | – | – | – | – | – | – | – | – | – | – |`); continue; }
  const oc = s.objective_completion, c = s.collision, f = s.fps;
  md.push(`| ${s.game_id} | ${r.theme} | ${r.template} | ${r.layout} | ${r.difficulty} | ${s.lighting ?? "–"} | ${s.scale} | ${s.playable ? "yes" : "**no**"} | ${yn(oc.won)} | ${oc.done}/${oc.required} | ${num(oc.sim_seconds)} | ${c.stuck_recoveries ?? "–"} | ${c.falls ?? "–"} | ${c.player_inside_solid_samples ?? "–"}/${c.samples} | ${yn(s.save_reload.headless_ok)}/${yn(s.save_reload.browser_ok)} | ${yn(s.deterministic.rebuild_sha_equal)} | ${num(f?.fps, 2)} | ${num(f?.frame_ms_p95, 0)} | ${f?.draw_calls ?? "–"} | ${f?.triangles ?? "–"} | ${s.launch.load_ms ?? "–"} | ${s.build_ms ?? "–"} | ${s.budgets.ok ? "ok" : "**over**"} |`);
}
md.push("");
md.push("Columns: *obj* required objectives done by the headless playtest agent; *in-solid* steps the player ended inside a solid collider / steps with a collider nearby (collision probe); *save H/B* headless / browser save-reload; *det* a second build of the same recipe has the same `integrity.sha256`; *fps*, *p95 ms* real `requestAnimationFrame` rendering in headless Chrome (SwiftShader) while the player walks; *load ms* page navigation to runtime ready.", "");

const failed = scores.filter((s) => !s.playable);
md.push("## Samples that are not playable", "");
if (!failed.length) md.push("None: every sample met every criterion.");
else for (const s of failed) md.push(`- **${s.game_id}**: ${s.reasons.join("; ")}`);
md.push("");

md.push("## Variety", "");
md.push(`- ${variety.n} samples, ${variety.pairs} pairs compared on the visual signature (palette and sky/fog colours in CIE Lab, lighting, terrain height histograms and relief, scatter and placement asset mix, placement footprint, biome/shape/weather/material labels${ok.some((s) => s.visual_signature.groups.screen) ? ", and a 64-bin colour histogram of a real rendered frame" : ""}); distance is 0 (identical) to 1.`);
md.push(`- Minimum pairwise distance **${variety.min_pairwise ?? "–"}**${variety.closest_pair ? ` (${variety.closest_pair.a} vs ${variety.closest_pair.b})` : ""}; mean **${variety.mean_pairwise ?? "–"}**.`);
md.push(`- Near-duplicate threshold ${variety.near_duplicate_threshold}: ${variety.near_duplicates.length ? `**${variety.near_duplicates.length} pair(s) below it**: ${variety.near_duplicates.map((p) => `${p.a}~${p.b} (${p.d})`).join(", ")}` : "no pair is below it, so no two samples look alike by this measure"}.`);
md.push(`- World variants (distinct theme × biome × terrain shape × lighting): **${variety.world_variants}**. Gameplay variants (distinct required-objective kind sequences): **${variety.gameplay_variants}**.`);
md.push(`- Distinct: ${Object.entries(variety.distinct).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
md.push("");
if (fpsSummary) {
  md.push("## Browser performance (SwiftShader, CPU)", "");
  md.push(`FPS min ${num(fpsSummary.min_fps, 2)}, avg ${num(fpsSummary.avg_fps, 2)}, max ${num(fpsSummary.max_fps, 2)}; average p95 frame ${num(fpsSummary.avg_p95_ms, 0)} ms; average load ${num(fpsSummary.avg_load_ms, 0)} ms; draw calls avg ${num(fpsSummary.avg_draw_calls, 0)} / max ${fpsSummary.max_draw_calls}; max triangles ${fpsSummary.max_triangles}.`, "");
}
md.push("## Metric definitions", "");
md.push("- **playable** = headless launch ok, browser launch ok (when run), headless playtest won, save/reload ok headless and in the browser (when run), rebuild byte-identical, within budget (`src/gamesd/budgets.mjs`), no player step inside a solid, and no errors.");
md.push("- **launch**: headless = the package validated and `createSim` started; browser = `play.html` reached `ready` in play mode with no page, hook or console errors.");
md.push("- **objective completion**: the Games-B headless playtest agent (walks, never teleports) against the required objectives.");
md.push("- **collision**: the playtest is re-run with `resolveCapsule` observed; every settled player position with a collider nearby is checked against the solid colliders (XZ containment plus vertical overlap). *stuck* is the agent's stuck recoveries, *falls* the sim's fall-outs.");
md.push("- **save/reload**: headless = snapshot → restore → identical snapshot and identical continuation (the playtest's midpoint save, or a fresh sim after 3 s when there are too few objectives); browser = `save()` → walk away → `load()` from localStorage → position within 0.25 m and re-saved snapshot equal apart from `saved_at`.");
md.push("- **fps**: frames per second of real rAF rendering over at least " + FPS_SECONDS + " s and 12 frames (capped at 45 s) while W is held; p50/p95 frame intervals from the same frames.");
md.push("- **variety**: see *Variety*; world and gameplay variants are counts of distinct label tuples.");
md.push("");
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "DCS_GAMES_LOCAL_SAMPLE_REPORT.md"), md.join("\n"));

const matrix = await presetMatrixCsv();
fs.writeFileSync(path.join(OUT, "DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv"), matrix.csv);
bench.matrix_source = matrix.source;
fs.writeFileSync(path.join(EVIDENCE, "bench.json"), JSON.stringify(bench, null, 1) + "\n");

log("totals", JSON.stringify(totals));
if (fpsSummary) log("fps", JSON.stringify(fpsSummary));
log(`wrote ${path.relative(ROOT, OUT)}/DCS_GAMES_LOCAL_SAMPLE_REPORT.md, DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv (${matrix.source}), evidence/bench.json`);
