// Games-D sample scoring (CONTRACT §5). Node-side.
//
// scoreSample(buildResult, { browser?, browserCpu?, rebuild? }) turns one buildFromRecipe()
// result into a SampleScore: launch, objective completion, collision, FPS,
// save/reload, a visual signature, a deterministic-rebuild check and the budget
// check. `playable` is the conjunction a player cares about, and `reasons`
// lists every criterion that failed, so a report never has to guess why.
//
// varietyReport(scores) compares the signatures pairwise and counts distinct
// world and gameplay variants, so "no two samples look alike" is a number.

import { buildFromRecipe, makeContext } from "../engine.mjs";
import { checkBudgets } from "../budgets.mjs";
import { visualSignature, signatureDistance } from "./signature.mjs";
import { collisionProbe } from "./collision-probe.mjs";

export const SCORE_VERSION = "1.0.0";
/** Two samples closer than this (signature distance, 0..1) are called near-duplicates. */
export const NEAR_DUPLICATE_D = 0.08;

async function realDeps() {
  return (await import("../../gamesb/runtime/deps.mjs")).realDeps;
}

const r2 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : v ?? null);

/**
 * @param {object} res  buildFromRecipe() result
 * @param {{ browser?: object|null, browserCpu?: object|null, rebuild?: object|boolean, probe?: boolean, maxSimSeconds?: number, perfGate?: boolean }} [o]
 *   browser:    a benchPackage() result (quality/browser-bench.mjs), normally the GPU pass
 *   browserCpu: a benchPackage() result from the SwiftShader pass (cpu_worst_case, advisory)
 *   A result whose renderer is a software rasteriser counts as the CPU pass whichever slot it is in.
 *   Only a hardware-GL result supplies `fps` and can gate on PERF_BUDGET.
 *   rebuild: a second buildFromRecipe() result for the same recipe; true (default) rebuilds here; false skips
 * @returns {Promise<object>} SampleScore
 */
export async function scoreSample(res, { browser = null, browserCpu = null, rebuild = true, probe = true, maxSimSeconds, perfGate = true } = {}) {
  const passes = [browser, browserCpu].filter(Boolean);
  const gpuRun = passes.find((p) => p.gpu === true) || null;
  const cpuRun = passes.find((p) => p !== gpuRun) || null;
  const errors = [];
  const reasons = [];
  const pkg = res?.pkg || null;
  const recipe = res?.recipe || pkg?.concept?.fallback_recipe || null;
  const deps = await realDeps();

  // ---- launch (headless): a valid package the sim can start
  let headless_ok = !!(pkg && res.ok !== false);
  if (res?.validation && res.validation.ok === false) {
    headless_ok = false;
    for (const e of (res.validation.errors || []).slice(0, 5)) errors.push(`validation: ${e.path || ""} ${e.message || e}`.trim());
  }
  let headless_load_ms = null;
  if (pkg) {
    try {
      const { createSim } = await import("../../gamesb/runtime/sim-core.mjs");
      const t0 = performance.now();
      createSim(pkg, deps);
      headless_load_ms = Math.round(performance.now() - t0);
    } catch (e) { headless_ok = false; errors.push(`createSim: ${e.message}`); }
  }
  const browserOk = passes.length ? passes.every((p) => p.ok) : null;
  for (const p of passes) for (const e of p.errors || []) errors.push(`browser${p === gpuRun ? " (gpu)" : " (cpu)"}: ${e}`);
  const launch = {
    headless_ok, browser_ok: browserOk, load_ms: gpuRun?.load_ms ?? null, cpu_load_ms: cpuRun?.load_ms ?? null, headless_load_ms,
    renderer: gpuRun?.renderer ?? null, cpu_renderer: cpuRun?.renderer ?? null,
  };

  // ---- objective completion (from the build's own playtest)
  const pt = res?.playtest || null;
  const required = (pkg?.gameplay?.objectives || []).filter((o) => !o.optional);
  const doneSet = new Set(pt?.objectives_done || []);
  const done = required.filter((o) => doneSet.has(o.id)).length;
  const objective_completion = {
    required: required.length, done, pct: required.length ? Math.round((done / required.length) * 1000) / 10 : 0,
    won: !!pt?.won, sim_seconds: pt?.sim_seconds ?? null,
    ...(pt && !pt.won ? { reason: pt.reason || pt.status, pending: pt.pending || [] } : {}),
  };

  // ---- collision: re-run the playtest with the collision dependency observed
  let collision = { stuck_recoveries: pt?.stuck_recoveries ?? null, falls: pt?.falls ?? null, player_inside_solid_samples: null, samples: 0, steps: pt?.steps ?? null };
  if (pkg && probe) {
    try {
      const pr = await collisionProbe(pkg, { deps, maxSimSeconds });
      collision = {
        stuck_recoveries: pt?.stuck_recoveries ?? pr.playtest.stuck_recoveries,
        falls: pt?.falls ?? pr.playtest.falls,
        player_inside_solid_samples: pr.inside,
        samples: pr.samples,
        steps: pr.steps,
        examples: pr.examples,
        // The probe re-runs the same deterministic playtest; if it did not end the same way, say so.
        replay_matches: !pt || (pr.playtest.won === pt.won && pr.playtest.sim_seconds === pt.sim_seconds),
      };
    } catch (e) { errors.push(`collision probe: ${e.message}`); }
  }

  // ---- fps (browser only)
  const fpsOf = (run) => run?.fps ? {
    fps: r2(run.fps.fps), frame_ms_p50: r2(run.fps.frame_ms_p50), frame_ms_p95: r2(run.fps.frame_ms_p95),
    draw_calls: run.fps.draw_calls ?? null, triangles: run.fps.triangles ?? null, frames: run.fps.frames ?? null, renderer: run.renderer ?? null,
  } : null;
  // fps: hardware GL only. fps_cpu_worst_case: SwiftShader, advisory.
  const fps = fpsOf(gpuRun);
  const fps_cpu_worst_case = fpsOf(cpuRun);

  // ---- save/reload
  let saveHeadless = pt?.save_reload?.ok === true;
  let saveHow = pt?.save_reload?.skipped ? "skipped" : "playtest-midpoint";
  if (pkg && pt?.save_reload?.skipped) {
    // Too few required objectives for a midpoint save: prove it on a fresh sim a few seconds in.
    try {
      const { createSim, stepSim } = await import("../../gamesb/runtime/sim-core.mjs");
      const { verifySaveReload } = await import("../../gamesb/runtime/headless-playtest.mjs");
      const sim = createSim(pkg, deps);
      for (let i = 0; i < 180; i++) stepSim(sim, { move: { x: Math.cos(i / 40), z: Math.sin(i / 40) }, run: true, jump: false, interact: false });
      saveHeadless = verifySaveReload(pkg, sim, deps).ok === true;
      saveHow = "fresh-sim-3s";
    } catch (e) { errors.push(`save/reload: ${e.message}`); saveHeadless = false; }
  }
  const save_reload = { headless_ok: saveHeadless, browser_ok: passes.length ? passes.every((p) => p.save_reload?.ok === true) : null, headless_method: saveHow };

  // ---- deterministic rebuild
  let rb = rebuild;
  if (rb === true && recipe) {
    try { rb = await buildFromRecipe(recipe, { playtest: false }); } catch (e) { errors.push(`rebuild: ${e.message}`); rb = null; }
  }
  const sha = pkg?.integrity?.sha256 || null;
  const deterministic = { rebuild_sha_equal: rb && typeof rb === "object" ? !!sha && rb.pkg?.integrity?.sha256 === sha : null, sha256: sha };

  // ---- budgets
  // The GPU pass gates against PERF_BUDGET (the playability floor). The CPU
  // (SwiftShader) pass only feeds `cpu_advisory`. perfGate=false (the bench sets
  // it when the host is overloaded) keeps the GPU frame-time limits out of `ok`
  // and reports them as `perf_advisory`; draw calls and triangles do not depend
  // on host load, so they always gate.
  const perf = fps ? { fps: fps.fps, frame_ms_p95: fps.frame_ms_p95, draw_calls: fps.draw_calls, triangles: fps.triangles, load_ms: launch.load_ms, renderer: fps.renderer } : null;
  const geom = perf || fps_cpu_worst_case;
  const loadFree = geom ? { draw_calls: geom.draw_calls, triangles: geom.triangles } : null;
  const cpuPerf = fps_cpu_worst_case && perfGate ? { ...fps_cpu_worst_case, load_ms: launch.cpu_load_ms } : null;
  const budgets = pkg ? checkBudgets(pkg, { perf: perfGate && perf ? perf : loadFree, cpuPerf, build_ms: perfGate ? res.build_ms ?? null : null, expandScatter: deps.expandScatter })
    : { ok: false, over: [{ key: "package", value: null, limit: null }] };
  if (pkg) {
    budgets.perf_gate = perf ? (perfGate ? budgets.perf_gate : "host_overloaded_not_gated") : "not_measured_on_gpu";
    if (!perfGate) {
      const full = checkBudgets(pkg, { perf, cpuPerf: fps_cpu_worst_case ? { ...fps_cpu_worst_case, load_ms: launch.cpu_load_ms } : null, build_ms: res.build_ms ?? null, expandScatter: deps.expandScatter });
      budgets.perf_advisory = full.over.filter((o) => !budgets.over.some((b) => b.key === o.key));
      budgets.cpu_advisory = full.cpu_advisory || [];
    }
  }

  // ---- visual signature
  let lightingId = null;
  try { lightingId = recipe ? makeContext(recipe).lighting?.id ?? null : null; } catch { /* recipe tables changed */ }
  const visual_signature = pkg ? visualSignature(pkg, { screen: (cpuRun || gpuRun)?.screen_hist, lighting_id: lightingId, theme: recipe?.theme }) : null;

  // ---- verdict
  if (!launch.headless_ok) reasons.push("headless launch failed");
  for (const p of passes) if (!p.ok) reasons.push(`browser${p === gpuRun ? " (gpu)" : " (cpu)"} launch/play failed${p.reason ? `: ${p.reason}` : ""}`);
  if (!objective_completion.won) reasons.push(`headless playtest did not win (${objective_completion.reason || "unknown"}; ${done}/${required.length} objectives)`);
  if (!save_reload.headless_ok) reasons.push("headless save/reload failed");
  for (const p of passes) if (p.save_reload && !p.save_reload.ok) reasons.push(`browser save/reload failed: ${p.save_reload.reason}`);
  if (deterministic.rebuild_sha_equal === false) reasons.push("rebuild produced different bytes");
  if (deterministic.rebuild_sha_equal == null && rebuild !== false) reasons.push("rebuild not checked");
  // A GPU pass was run and measured, but a real playability floor was missed.
  if (!budgets.ok) reasons.push(`over budget: ${budgets.over.map((o) => `${o.key} ${o.value} > ${o.limit}`).join(", ")}`);
  if (collision.player_inside_solid_samples > 0) reasons.push(`player ended ${collision.player_inside_solid_samples} step(s) inside a solid`);
  if (errors.length) reasons.push(`${errors.length} error(s): ${errors.slice(0, 2).join("; ")}`);

  return {
    score_version: SCORE_VERSION,
    game_id: pkg?.game_id ?? null,
    recipe, recipe_id: res?.recipe_id ?? null,
    title: pkg?.title ?? null,
    scale: pkg?.concept?.scale ?? null,
    lighting: lightingId,
    template: recipe?.template ?? null,
    objective_kinds: (pkg?.gameplay?.objectives || []).filter((o) => !o.optional).map((o) => o.kind),
    build_ms: res?.build_ms ?? null,
    notes: res?.notes || [],
    launch, objective_completion, collision, fps, fps_cpu_worst_case, save_reload, visual_signature, deterministic, budgets,
    errors,
    playable: reasons.length === 0,
    reasons,
  };
}

// ------------------------------------------------------------ variety

/**
 * @param {object[]} scores SampleScore[]
 * @returns {{ n, pairs, distances, min_pairwise, mean_pairwise, closest_pair, near_duplicates, world_variants, gameplay_variants, distinct }}
 */
export function varietyReport(scores, { nearDuplicate = NEAR_DUPLICATE_D } = {}) {
  const s = scores.filter((x) => x?.visual_signature);
  const ids = s.map((x) => x.game_id);
  const distances = [];
  let min = Infinity, sum = 0, closest = null;
  const near = [];
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
    const { d, parts } = signatureDistance(s[i].visual_signature, s[j].visual_signature);
    distances.push({ a: ids[i], b: ids[j], d, parts });
    sum += d;
    if (d < min) { min = d; closest = { a: ids[i], b: ids[j], d, parts }; }
    if (d < nearDuplicate) near.push({ a: ids[i], b: ids[j], d });
  }
  const L = (x) => x.visual_signature.labels || {};
  const distinct = (f) => new Set(s.map(f)).size;
  const worldKey = (x) => [L(x).theme, L(x).biome, L(x).shape, L(x).lighting].join("|");
  const gameplayKey = (x) => (x.objective_kinds || []).join(">");
  const nn = s.map((x, i) => {
    let best = null;
    for (const e of distances) if (e.a === ids[i] || e.b === ids[i]) if (!best || e.d < best.d) best = { other: e.a === ids[i] ? e.b : e.a, d: e.d };
    return { game_id: ids[i], nearest: best?.other ?? null, d: best?.d ?? null };
  });
  return {
    n: s.length,
    pairs: distances.length,
    min_pairwise: distances.length ? min : null,
    mean_pairwise: distances.length ? Math.round((sum / distances.length) * 1000) / 1000 : null,
    closest_pair: closest,
    near_duplicate_threshold: nearDuplicate,
    near_duplicates: near,
    no_two_alike: near.length === 0,
    world_variants: distinct(worldKey),
    gameplay_variants: distinct(gameplayKey),
    distinct: {
      themes: distinct((x) => L(x).theme), biomes: distinct((x) => L(x).biome), terrain_shapes: distinct((x) => L(x).shape),
      lightings: distinct((x) => L(x).lighting), weathers: distinct((x) => L(x).weather), material_styles: distinct((x) => L(x).material_style),
      templates: distinct((x) => x.template), objective_sequences: distinct(gameplayKey),
      objective_kinds: new Set(s.flatMap((x) => x.objective_kinds || [])).size,
    },
    nearest_neighbour: nn,
    distances,
  };
}
