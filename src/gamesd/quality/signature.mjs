// Games-D visual signature: a compact, comparable description of how a
// package LOOKS, read from the package alone (plus, optionally, a colour
// histogram of a real browser screenshot). Node-side.
//
// A signature is a set of named groups, each with its own bounded distance in
// [0, 1], so "how different are these two games" is a weighted mean of
// understandable parts rather than one opaque vector:
//
//   palette    concept palette colours in CIE Lab            mean ΔE76 / 100
//   sky        sky top/horizon/bottom, fog and water colour   mean ΔE76 / 100
//   lighting   sun elevation/azimuth/intensity, ambient,
//              time of day, fog near/far                      mean |Δ| of [0,1] features
//   terrain_abs  height histogram on a fixed -10..40 m scale  total variation
//   terrain_rel  height histogram normalised to min..max      total variation
//   terrain_form relief, roughness, water fraction            mean |Δ|
//   scatter    scatter asset mix (instances per asset)        total variation
//   placement  placement asset mix                            total variation
//   footprint  4×4 grid of where placements sit on the map    total variation
//   labels     biome, terrain shape, weather, material style  fraction that differ
//   screen     (optional) 64-bin RGB histogram of a frame     total variation
//
// Groups present on only one side are skipped and the weights renormalised.

export const SIGNATURE_WEIGHTS = Object.freeze({
  palette: 0.16, sky: 0.14, lighting: 0.1,
  terrain_abs: 0.08, terrain_rel: 0.07, terrain_form: 0.06,
  scatter: 0.1, placement: 0.08, footprint: 0.06,
  labels: 0.05, screen: 0.1,
});

// ------------------------------------------------------------ colour

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** sRGB (0..255) → CIE Lab (D65). */
export function rgbToLab([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)].map((v) => Math.round(v * 100) / 100);
}

export const hexToLab = (hex) => { const c = hexToRgb(hex); return c ? rgbToLab(c) : null; };
const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// ------------------------------------------------------------ helpers

const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function histogram(values, lo, hi, bins) {
  const h = new Array(bins).fill(0);
  if (!values.length) return h;
  for (const v of values) {
    const i = Math.max(0, Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo || 1)) * bins)));
    h[i]++;
  }
  return h.map((c) => r3(c / values.length));
}

function mix(entries) {
  const total = entries.reduce((a, [, n]) => a + n, 0) || 1;
  const out = {};
  for (const [k, n] of entries) out[k] = (out[k] || 0) + n;
  for (const k of Object.keys(out)) out[k] = r3(out[k] / total);
  return out;
}

/** Total variation distance between two histograms (arrays or {key: fraction} maps), in [0, 1]. */
export function totalVariation(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    let s = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) s += Math.abs((a[i] || 0) - (b[i] || 0));
    return clamp01(s / 2);
  }
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let s = 0;
  for (const k of keys) s += Math.abs((a?.[k] || 0) - (b?.[k] || 0));
  return clamp01(s / 2);
}

// ------------------------------------------------------------ signature

const PALETTE_KEYS = ["primary", "secondary", "accent", "ground", "sky", "water"];

/**
 * @param {object} pkg GamePackage
 * @param {{ screen?: number[], lighting_id?: string|null, theme?: string|null }} [extra]
 */
export function visualSignature(pkg, extra = {}) {
  const w = pkg.world || {};
  const env = w.environment || {};
  const t = w.terrain || {};
  const pal = pkg.concept?.palette || {};

  const palette = PALETTE_KEYS.map((k) => hexToLab(pal[k])).filter(Boolean);
  const sky = [env.sky?.top, env.sky?.horizon, env.sky?.bottom, env.fog?.color, env.water?.enabled ? env.water?.color : null].map((h) => hexToLab(h) || [0, 0, 0]);

  const az = ((env.sun?.azimuth_deg || 0) * Math.PI) / 180;
  const lighting = [
    clamp01(((env.sun?.elevation_deg ?? 45) + 10) / 100),
    r3((Math.sin(az) + 1) / 2), r3((Math.cos(az) + 1) / 2),
    clamp01((env.sun?.intensity ?? 1) / 2),
    clamp01((env.ambient?.intensity ?? 0.5) / 1.5),
    clamp01(env.time_of_day ?? 0.5),
    clamp01((env.fog?.near ?? 0) / 200),
    clamp01((env.fog?.far ?? 400) / 600),
  ].map(r3);

  const heights = Array.isArray(t.heights) ? t.heights : [];
  const minY = heights.length ? Math.min(...heights) : 0, maxY = heights.length ? Math.max(...heights) : 0;
  const waterLevel = env.water?.enabled ? env.water.level ?? 0 : -Infinity;
  let rough = 0, rn = 0;
  const cols = t.cols || 0, rows = t.rows || 0;
  for (let j = 0; j < rows; j += 2) for (let i = 0; i + 1 < cols; i += 2) {
    rough += Math.abs(heights[j * cols + i + 1] - heights[j * cols + i]); rn++;
  }
  const terrain_form = [
    clamp01((maxY - minY) / 60),
    clamp01(rn ? rough / rn / (t.cell || 2) : 0),
    r3(heights.length ? heights.filter((h) => h < waterLevel).length / heights.length : 0),
  ].map(r3);

  const scatterCounts = (w.scatter || []).map((s) => [s.asset_ref, s.count || 0]);
  const placements = w.placements || [];
  const W = w.size?.w || 1, H = w.size?.h || 1;
  const foot = new Array(16).fill(0);
  for (const p of placements) {
    const gx = Math.max(0, Math.min(3, Math.floor((p.position.x / W) * 4)));
    const gz = Math.max(0, Math.min(3, Math.floor((p.position.z / H) * 4)));
    foot[gz * 4 + gx]++;
  }

  const labels = {
    theme: extra.theme ?? pkg.concept?.fallback_recipe?.theme ?? null,
    biome: w.biome ?? pkg.concept?.biome ?? null,
    shape: t.shape ?? null,
    weather: env.weather ?? null,
    lighting: extra.lighting_id ?? pkg.concept?.fallback_recipe?.lighting ?? null,
    material_style: pkg.concept?.material_style ?? null,
  };

  const sig = {
    labels,
    groups: {
      palette,
      sky,
      lighting,
      terrain_abs: histogram(heights, -10, 40, 10),
      terrain_rel: histogram(heights, minY, maxY, 8),
      terrain_form,
      scatter: mix(scatterCounts),
      placement: mix(placements.map((p) => [p.asset_ref, 1])),
      footprint: foot.map((c) => r3(c / (placements.length || 1))),
      labels: [labels.biome, labels.shape, labels.weather, labels.material_style],
    },
  };
  if (Array.isArray(extra.screen) && extra.screen.length) sig.groups.screen = extra.screen;
  return sig;
}

function groupDistance(k, a, b) {
  switch (k) {
    case "palette":
    case "sky": {
      const n = Math.min(a.length, b.length);
      if (!n) return null;
      let s = 0;
      for (let i = 0; i < n; i++) s += Math.min(1, deltaE(a[i], b[i]) / 100);
      return s / n;
    }
    case "lighting":
    case "terrain_form": {
      const n = Math.min(a.length, b.length);
      let s = 0;
      for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
      return n ? s / n : null;
    }
    case "labels": {
      const n = Math.max(a.length, b.length);
      let s = 0;
      for (let i = 0; i < n; i++) if ((a[i] ?? null) !== (b[i] ?? null)) s++;
      return n ? s / n : null;
    }
    default:
      return totalVariation(a, b);
  }
}

/** Weighted distance between two signatures, in [0, 1]. Returns { d, parts }. */
export function signatureDistance(a, b, weights = SIGNATURE_WEIGHTS) {
  let sw = 0, s = 0;
  const parts = {};
  for (const [k, wt] of Object.entries(weights)) {
    const ga = a?.groups?.[k], gb = b?.groups?.[k];
    if (ga == null || gb == null) continue;
    const d = groupDistance(k, ga, gb);
    if (d == null) continue;
    parts[k] = r3(d);
    s += wt * d; sw += wt;
  }
  return { d: sw ? r3(s / sw) : 0, parts };
}
