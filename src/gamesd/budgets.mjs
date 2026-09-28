// Games-D asset and performance budgets. Node-side.
//
// Budgets are keyed by world scale. A fallback game over budget is reported
// but not counted as playable: the point of the fallback is that it runs on a
// weak laptop with no GPU (the browser bench uses SwiftShader, CPU only).

export const ASSET_BUDGET = Object.freeze({
  small:  Object.freeze({ package_bytes: 450_000, records: 160, placements: 70,  scatter_instances: 900,  characters: 8,  texture_px: 256, materials: 19 }),
  medium: Object.freeze({ package_bytes: 650_000, records: 200, placements: 90,  scatter_instances: 1400, characters: 10, texture_px: 256, materials: 19 }),
  large:  Object.freeze({ package_bytes: 900_000, records: 240, placements: 120, scatter_instances: 2000, characters: 12, texture_px: 256, materials: 19 }),
});

// Browser numbers are measured under SwiftShader at the runtime's "low" quality.
export const PERF_BUDGET = Object.freeze({
  small:  Object.freeze({ min_fps: 20, max_frame_ms_p95: 80,  max_draw_calls: 450, max_triangles: 900_000,   max_load_ms: 20_000, max_build_ms: 15_000 }),
  medium: Object.freeze({ min_fps: 15, max_frame_ms_p95: 100, max_draw_calls: 550, max_triangles: 1_200_000, max_load_ms: 25_000, max_build_ms: 20_000 }),
  large:  Object.freeze({ min_fps: 12, max_frame_ms_p95: 120, max_draw_calls: 650, max_triangles: 1_600_000, max_load_ms: 30_000, max_build_ms: 30_000 }),
});

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
 * @param {{ perf?: {fps, frame_ms_p95, draw_calls, triangles, load_ms}, build_ms?: number, expandScatter?: Function }} [o]
 */
export function checkBudgets(pkg, { perf = null, build_ms = null, expandScatter } = {}) {
  const scale = ASSET_BUDGET[pkg.concept?.scale] ? pkg.concept.scale : "medium";
  const over = [];
  const figures = assetFigures(pkg, { expandScatter });
  for (const [k, limit] of Object.entries(ASSET_BUDGET[scale])) {
    if (figures[k] > limit) over.push({ key: k, value: figures[k], limit });
  }
  const P = PERF_BUDGET[scale];
  if (perf) {
    if (typeof perf.fps === "number" && perf.fps < P.min_fps) over.push({ key: "fps", value: perf.fps, limit: P.min_fps });
    if (typeof perf.frame_ms_p95 === "number" && perf.frame_ms_p95 > P.max_frame_ms_p95) over.push({ key: "frame_ms_p95", value: perf.frame_ms_p95, limit: P.max_frame_ms_p95 });
    if (typeof perf.draw_calls === "number" && perf.draw_calls > P.max_draw_calls) over.push({ key: "draw_calls", value: perf.draw_calls, limit: P.max_draw_calls });
    if (typeof perf.triangles === "number" && perf.triangles > P.max_triangles) over.push({ key: "triangles", value: perf.triangles, limit: P.max_triangles });
    if (typeof perf.load_ms === "number" && perf.load_ms > P.max_load_ms) over.push({ key: "load_ms", value: perf.load_ms, limit: P.max_load_ms });
  }
  if (typeof build_ms === "number" && build_ms > P.max_build_ms) over.push({ key: "build_ms", value: build_ms, limit: P.max_build_ms });
  return { ok: over.length === 0, scale, figures, over };
}
