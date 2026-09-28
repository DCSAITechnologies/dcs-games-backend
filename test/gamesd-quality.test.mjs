// Games-D quality: scoring, variety, budgets, the collision probe and a browser
// smoke of the bench. Real builds through buildFromRecipe (offline, zero API).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFromRecipe } from "../src/gamesd/engine.mjs";
import { normaliseRecipe, validateRecipe } from "../src/gamesd/recipe.mjs";
import { THEMES } from "../src/gamesd/world/themes.mjs";
import { TEMPLATES } from "../src/gamesd/gameplay/templates.mjs";
import { LAYOUTS } from "../src/gamesd/missions/layouts.mjs";
import { LIGHTING } from "../src/gamesd/world/lighting.mjs";
import { checkBudgets, ASSET_BUDGET, PERF_BUDGET } from "../src/gamesd/budgets.mjs";
import { scoreSample, varietyReport } from "../src/gamesd/quality/score.mjs";
import { visualSignature, signatureDistance, hexToLab } from "../src/gamesd/quality/signature.mjs";
import { collisionProbe, probePositions, insideSolid } from "../src/gamesd/quality/collision-probe.mjs";
import { realDeps } from "../src/gamesb/runtime/deps.mjs";
import { findChrome } from "./helpers/browser.mjs";

process.env.DCS_PROVIDERS_OFFLINE = "1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A valid recipe from the live tables: the i-th theme, template, lighting; the first compatible layout. */
function recipeAt(i, seed) {
  const th = Object.keys(THEMES), tp = Object.keys(TEMPLATES), lt = Object.keys(LIGHTING);
  const template = tp[i % tp.length];
  const need = TEMPLATES[template].needs?.locations_min || 0;
  const layout = Object.keys(LAYOUTS).find((id) => LAYOUTS[id].locations >= need) || Object.keys(LAYOUTS)[0];
  const r = normaliseRecipe({ seed, theme: th[i % th.length], template, layout, difficulty: "normal", lighting: lt[i % lt.length] || null });
  assert.ok(validateRecipe(r).ok, JSON.stringify(validateRecipe(r).errors));
  return r;
}

const builds = new Map();
async function build(r) {
  const k = JSON.stringify(r);
  if (!builds.has(k)) builds.set(k, await buildFromRecipe(r));
  return builds.get(k);
}

test("scoreSample on real builds: every field present, deterministic, won, nothing inside a solid", async () => {
  const lastTheme = Object.keys(THEMES).length - 1;
  for (const r of [recipeAt(0, 11), recipeAt(lastTheme, 12)]) {
    const res = await build(r);
    const s = await scoreSample(res);
    for (const k of ["launch", "objective_completion", "collision", "fps", "save_reload", "visual_signature", "deterministic", "budgets", "playable", "reasons"]) assert.ok(k in s, `missing ${k}`);
    assert.equal(s.launch.headless_ok, true);
    assert.equal(s.launch.browser_ok, null);
    assert.equal(s.fps, null, "no browser → fps null");
    assert.equal(s.deterministic.rebuild_sha_equal, true, "same recipe → same bytes");
    assert.equal(s.objective_completion.required > 0, true);
    assert.equal(s.objective_completion.won, true, `${s.game_id}: ${JSON.stringify(s.objective_completion)}`);
    assert.equal(s.objective_completion.done, s.objective_completion.required);
    assert.equal(s.save_reload.headless_ok, true);
    assert.ok(s.collision.samples > 0, "the probe saw collider-adjacent steps");
    assert.equal(s.collision.replay_matches, true, "the probe replays the build's own playtest");
    assert.equal(s.collision.player_inside_solid_samples, 0, JSON.stringify(s.collision.examples));
    assert.equal(s.playable, s.reasons.length === 0);
    assert.ok(s.visual_signature.groups.palette.length >= 3);
  }
});

test("varietyReport: two different recipes are further apart than two seeds of one recipe", async () => {
  const a1 = recipeAt(0, 21), a2 = { ...a1, seed: 22 };
  const b = recipeAt(Math.floor(Object.keys(THEMES).length / 2) || 1, 23);
  assert.notEqual(a1.theme, b.theme);
  const sc = [];
  for (const r of [a1, a2, b]) sc.push(await scoreSample(await build(r), { rebuild: false, probe: false }));
  const v = varietyReport(sc);
  const d = (x, y) => v.distances.find((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x)).d;
  const same = d(sc[0].game_id, sc[1].game_id);
  const diff = Math.min(d(sc[0].game_id, sc[2].game_id), d(sc[1].game_id, sc[2].game_id));
  assert.ok(diff > same, `different recipes ${diff} must be further apart than two seeds of one recipe ${same}`);
  assert.equal(v.n, 3);
  assert.equal(v.pairs, 3);
  assert.ok(v.world_variants >= 2);
  assert.equal(v.min_pairwise, Math.min(...v.distances.map((e) => e.d)));
  // A package against itself is at distance 0.
  const sig = visualSignature((await build(a1)).pkg);
  assert.equal(signatureDistance(sig, sig).d, 0);
  assert.deepEqual(hexToLab("#ffffff").map((v) => Math.round(v) + 0), [100, 0, 0]);
});

test("checkBudgets flags an oversized package", async () => {
  const res = await build(recipeAt(0, 11));
  const ok = checkBudgets(res.pkg, { expandScatter: realDeps.expandScatter });
  assert.equal(ok.ok, true, JSON.stringify(ok.over));
  const big = structuredClone(res.pkg);
  const lim = ASSET_BUDGET[ok.scale];
  const p0 = big.world.placements[0];
  while (big.world.placements.length <= lim.placements) big.world.placements.push({ ...p0, id: `${p0.id}_dup${big.world.placements.length}` });
  big.world.padding = "x".repeat(lim.package_bytes);
  const over = checkBudgets(big, { perf: { fps: 0.5, draw_calls: 99999, triangles: 1e9 }, expandScatter: realDeps.expandScatter });
  assert.equal(over.ok, false);
  const keys = over.over.map((o) => o.key);
  for (const k of ["package_bytes", "placements", "fps", "draw_calls", "triangles"]) assert.ok(keys.includes(k), `expected ${k} in ${keys}`);
});

test("checkBudgets: 3 fps is below the playability floor on a GPU; SwiftShader numbers are advisory only", async () => {
  const res = await build(recipeAt(0, 11));
  const P = PERF_BUDGET[res.pkg.concept.scale] || PERF_BUDGET.medium;
  assert.ok(P.min_fps >= 12, "the GPU playability floor is a real frame rate");
  const slow = { fps: 3, frame_ms_p95: 700, draw_calls: 200, triangles: 150000, load_ms: 1000 };
  const gpu = checkBudgets(res.pkg, { perf: { ...slow, renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro)" }, expandScatter: realDeps.expandScatter });
  assert.equal(gpu.ok, false);
  assert.equal(gpu.perf_gate, "gpu");
  assert.ok(gpu.over.some((o) => o.key === "fps"));
  const sw = checkBudgets(res.pkg, { perf: { ...slow, renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)" }, expandScatter: realDeps.expandScatter });
  assert.equal(sw.ok, true, "a software renderer's frame rate never gates");
  assert.equal(sw.perf_gate, "software_renderer_not_gated");
  const adv = checkBudgets(res.pkg, { cpuPerf: { fps: 0.2, frame_ms_p95: 9000, load_ms: 1e6 }, expandScatter: realDeps.expandScatter });
  assert.equal(adv.ok, true);
  assert.deepEqual(adv.cpu_advisory.map((o) => o.key).sort(), ["cpu_fps", "cpu_frame_ms_p95", "cpu_load_ms"]);
});

test("collision probe detects a planted inside-solid position and a broken resolver", async () => {
  const res = await build(recipeAt(0, 11));
  const cols = realDeps.collision.buildColliders(res.pkg.world, res.pkg.scene);
  const solid = cols.find((c) => c.solid);
  assert.ok(solid, "package has a solid collider");
  const h = solid.shape === "box" ? solid.half.y * 2 : solid.height;
  const inside = { x: solid.center.x, y: solid.center.y - h / 2, z: solid.center.z };
  const onTop = { ...inside, y: solid.center.y + h / 2 + 0.01 };
  const far = { x: -1000, y: 0, z: -1000 };
  const pr = probePositions(cols, [inside, onTop, far]);
  assert.equal(pr.samples, 3);
  assert.equal(pr.inside, 1, "only the planted position is inside");
  assert.ok(insideSolid(cols, inside));
  assert.equal(insideSolid(cols, onTop), null, "standing on top is not inside");

  // A resolver that drags the player into the nearest solid must be caught by the full probe.
  const broken = {
    ...realDeps,
    collision: {
      ...realDeps.collision,
      resolveCapsule(near, pos) {
        const c = near.find((x) => x.solid);
        return c ? { x: c.center.x, z: c.center.z, hit: true } : { x: pos.x, z: pos.z, hit: false };
      },
    },
  };
  const bad = await collisionProbe(res.pkg, { deps: broken, maxSimSeconds: 20 });
  assert.ok(bad.inside > 0, `sabotaged resolver not detected: ${JSON.stringify({ samples: bad.samples, inside: bad.inside })}`);
  const good = await collisionProbe(res.pkg, { maxSimSeconds: 20 });
  assert.equal(good.inside, 0, JSON.stringify(good.examples));
});

const chromeSkip = !findChrome() ? "no Chrome binary (set DCS_CHROME)" : false;
test("browser bench smoke: one package loads, renders, plays, saves and reloads", { skip: chromeSkip, timeout: 240000 }, async () => {
  const { benchPackages } = await import("../src/gamesd/quality/browser-bench.mjs");
  const res = await build(recipeAt(0, 11));
  const id = `${res.pkg.game_id}__qtest`;
  const dir = path.join(ROOT, "games-b-runtime/games/fallback", id);
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), "gamesd-ev-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(res.pkg));
  try {
    const run = await benchPackages([{ game_id: id, pkgPath: `/games-b-runtime/games/fallback/${id}/package.json` }], { fpsSeconds: 1, minFrames: 3, evidenceDir: ev });
    const r = run.results[id];
    assert.equal(r.ok, true, `${r.reason}: ${JSON.stringify(r.errors).slice(0, 600)}`);
    assert.equal(r.mode, "play");
    assert.ok(r.renderer, "renderer string recorded");
    assert.equal(r.gpu, false, `the default pass is SwiftShader: ${r.renderer}`);
    assert.ok(r.fps.frames >= 3 && r.fps.fps > 0, JSON.stringify(r.fps));
    assert.ok(r.fps.draw_calls > 0 && r.fps.triangles > 0);
    assert.equal(r.save_reload.ok, true, JSON.stringify(r.save_reload));
    assert.equal(r.play.threw, null);
    assert.ok(fs.statSync(r.screenshot).size > 1000, "screenshot written");
    assert.equal(r.screen_hist.length, 64);
    const s = await scoreSample(res, { browserCpu: r, rebuild: false, probe: false });
    assert.equal(s.launch.browser_ok, true);
    assert.equal(s.fps, null, "SwiftShader never supplies the gating fps");
    assert.ok(s.fps_cpu_worst_case.fps > 0);
    assert.equal(s.budgets.perf_gate, "not_measured_on_gpu");
    assert.equal(s.save_reload.browser_ok, true);
    assert.ok(s.visual_signature.groups.screen, "screen histogram in the signature");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ev, { recursive: true, force: true });
  }
});
