// Games-D asset and performance budgets. Node-side.
//
// Budgets are keyed by world scale. A fallback game over budget is reported
// but not counted as playable. Asset limits and draw calls/triangles always
// gate; frame-rate limits gate only on a GPU-backed measurement (PERF_BUDGET);
// SwiftShader numbers are the advisory cpu_worst_case (CPU_PERF_BUDGET).

export const ASSET_BUDGET = Object.freeze({
  small:  Object.freeze({ package_bytes: 450_000, records: 160, placements: 70,  scatter_instances: 900,  characters: 8,  texture_px: 256, materials: 19 }),
  medium: Object.freeze({ package_bytes: 650_000, records: 200, placements: 90,  scatter_instances: 1400, characters: 10, texture_px: 256, materials: 19 }),
  large:  Object.freeze({ package_bytes: 900_000, records: 240, placements: 120, scatter_instances: 2000, characters: 12, texture_px: 256, materials: 19 }),
});

// PERF_BUDGET is the PLAYABILITY floor and applies to a GPU-backed measurement
// only (the bench's --gpu pass: headless Chrome on hardware GL, renderer string
// checked not to be SwiftShader). These are the original limits and are
// deliberately unchanged: 2–3 fps is not playable, whatever the renderer.
export const PERF_BUDGET = Object.freeze({
  small:  Object.freeze({ min_fps: 20, max_frame_ms_p95: 80,  max_draw_calls: 450, max_triangles: 900_000,   max_load_ms: 20_000, max_build_ms: 15_000 }),
  medium: Object.freeze({ min_fps: 15, max_frame_ms_p95: 100, max_draw_calls: 550, max_triangles: 1_200_000, max_load_ms: 25_000, max_build_ms: 20_000 }),
  large:  Object.freeze({ min_fps: 12, max_frame_ms_p95: 120, max_draw_calls: 650, max_triangles: 1_600_000, max_load_ms: 30_000, max_build_ms: 30_000 }),
});

// CPU_PERF_BUDGET: SwiftShader (CPU-only WebGL) "cpu_worst_case" limits. ADVISORY
// ONLY — never part of `ok`/playable — and used for regression detection: a
// sample far outside them has got heavier, not merely run on a slow host.
// Calibrated 29 Sep 2026 (Games-D quality agent) from measurements:
//   - Lanternfall flagship, docs/games-b/evidence/lanternfall-perf.json:
//     p50 331 ms, p95 743 ms (3.0 fps), 258 draw calls, 167k triangles.
//   - Games-D samples, first bench runs: 150k–295k triangles, 190–336 draw
//     calls, 4.4 fps / p95 ~400 ms on SwiftShader — the flagship's weight class.
//     (The same samples run at the 60 fps vsync cap on hardware GL.)
// So the frame limits sit just past the flagship's CPU figure; load allows for
// headless Chrome compiling every shader and synthesising every texture on the CPU.
// Wall-clock numbers taken on an overloaded host (load > 1.5 per core) are
// recorded but not compared, since they measure the queue rather than the game.
export const CPU_PERF_BUDGET = Object.freeze({
  small:  Object.freeze({ min_fps: 2.5, max_frame_ms_p95: 1000, max_load_ms: 30_000 }),
  medium: Object.freeze({ min_fps: 2,   max_frame_ms_p95: 1200, max_load_ms: 40_000 }),
  large:  Object.freeze({ min_fps: 1.5, max_frame_ms_p95: 1500, max_load_ms: 50_000 }),
});

/** True when a renderer string is a software rasteriser (SwiftShader, llvmpipe, …). */
export const isSoftwareRenderer = (r) => /swiftshader|llvmpipe|softpipe|software|basic render/i.test(String(r || ""));

/** Count what the asset budget limits. `expandScatter` is passed in to keep this file free of world imports. */
export function assetFigures(pkg, { expandScatter } = {}) {
  const records = pkg.assets?.records || [];
  const tex = records.filter((r) => r.format === "texture-recipe").map((r) => r.payload?.size || 0);
  return {
    package_bytes: Buffer.byteLength(JSON.stringify(pkg)),
    records: records.length,
    placements: (pkg.world?.placements || []).length,
    scatter_instances: expandScatter ? expandScatter(pkg.world).length : (pkg.world?.scatter || []).reduce((a, s) => a + (s.count || 0), 0),
    characters: (pkg.characters?.characters || []).length,
    texture_px: tex.length ? Math.max(...tex) : 0,
    materials: records.filter((r) => r.format === "material").length,
  };
}

/**
 * @param {object} pkg
 * @param {{ perf?: {fps, frame_ms_p95, draw_calls, triangles, load_ms, renderer?}, cpuPerf?: object, build_ms?: number, expandScatter?: Function }} [o]
 *   perf     a GPU-backed browser measurement: gates `ok` against PERF_BUDGET. If its
 *            `renderer` is a software rasteriser the frame limits are NOT applied
 *            (only draw calls and triangles, which do not depend on the renderer).
 *   cpuPerf  a SwiftShader measurement: compared with CPU_PERF_BUDGET into
 *            `cpu_advisory`; never affects `ok`.
 */
export function checkBudgets(pkg, { perf = null, cpuPerf = null, build_ms = null, expandScatter } = {}) {
  const scale = ASSET_BUDGET[pkg.concept?.scale] ? pkg.concept.scale : "medium";
  const over = [];
  const figures = assetFigures(pkg, { expandScatter });
  for (const [k, limit] of Object.entries(ASSET_BUDGET[scale])) {
    if (figures[k] > limit) over.push({ key: k, value: figures[k], limit });
  }
  const P = PERF_BUDGET[scale];
  const geometry = (m) => {
    if (typeof m.draw_calls === "number" && m.draw_calls > P.max_draw_calls) over.push({ key: "draw_calls", value: m.draw_calls, limit: P.max_draw_calls });
    if (typeof m.triangles === "number" && m.triangles > P.max_triangles) over.push({ key: "triangles", value: m.triangles, limit: P.max_triangles });
  };
  let perf_gate = "not_measured";
  if (perf) {
    geometry(perf);
    if (perf.renderer && isSoftwareRenderer(perf.renderer)) perf_gate = "software_renderer_not_gated";
    else {
      perf_gate = "gpu";
      if (typeof perf.fps === "number" && perf.fps < P.min_fps) over.push({ key: "fps", value: perf.fps, limit: P.min_fps });
      if (typeof perf.frame_ms_p95 === "number" && perf.frame_ms_p95 > P.max_frame_ms_p95) over.push({ key: "frame_ms_p95", value: perf.frame_ms_p95, limit: P.max_frame_ms_p95 });
      if (typeof perf.load_ms === "number" && perf.load_ms > P.max_load_ms) over.push({ key: "load_ms", value: perf.load_ms, limit: P.max_load_ms });
    }
  }
  if (typeof build_ms === "number" && build_ms > P.max_build_ms) over.push({ key: "build_ms", value: build_ms, limit: P.max_build_ms });
  const out = { ok: over.length === 0, scale, figures, over, perf_gate };
  if (cpuPerf) {
    const C = CPU_PERF_BUDGET[scale];
    const adv = [];
    if (typeof cpuPerf.fps === "number" && cpuPerf.fps < C.min_fps) adv.push({ key: "cpu_fps", value: cpuPerf.fps, limit: C.min_fps });
    if (typeof cpuPerf.frame_ms_p95 === "number" && cpuPerf.frame_ms_p95 > C.max_frame_ms_p95) adv.push({ key: "cpu_frame_ms_p95", value: cpuPerf.frame_ms_p95, limit: C.max_frame_ms_p95 });
    if (typeof cpuPerf.load_ms === "number" && cpuPerf.load_ms > C.max_load_ms) adv.push({ key: "cpu_load_ms", value: cpuPerf.load_ms, limit: C.max_load_ms });
    out.cpu_advisory = adv;
  }
  return out;
}
