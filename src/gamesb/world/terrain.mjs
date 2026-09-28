// Games-B world: heightfield generation.
//
// Everything here is deterministic in the seed and uses only arithmetic, so
// the same concept + seed always yields the same bytes. Kept free of node:
// imports (it is not on the isomorphic list, but nothing stops a future
// in-browser regenerate).
//
// Shapes:
//   island  — radial falloff with a noisy coastline dropping below the water,
//             sandy beaches, rolling hills, a raised summit, terraced cliffs
//             inland and a stretch of sea cliff on one side.
//   valley  — a meandering floor between raised walls (forest, snow, canyon).
//   plateau — a raised central tableland with steep rims (ruins, volcanic).
//   open    — gentle dunes / nearly flat ground (desert, city, scifi_base).
// Pads and path corridors are flattened into the result by `flattenPad` and
// `flattenCorridor` after the layout is known.

import { clamp, lerp } from "../common/rng.mjs";
import { distToPolyline } from "./terrain-sample.mjs";

export const MAX_TERRAIN_CELLS = 160;

/** Integer lattice hash → [0,1). */
function lattice(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Value noise in [0,1) at (x, y). */
export function valueNoise(seed) {
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const u = smooth(x - xi), v = smooth(y - yi);
    const a = lattice(xi, yi, seed), b = lattice(xi + 1, yi, seed);
    const c = lattice(xi, yi + 1, seed), d = lattice(xi + 1, yi + 1, seed);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/** Fractal sum of value noise, normalised to [0,1). */
export function fbm(seed, octaves = 4) {
  const n = valueNoise(seed);
  return (x, y) => {
    let s = 0, amp = 1, f = 1, tot = 0;
    for (let o = 0; o < octaves; o++) { s += n(x * f + o * 17.3, y * f - o * 9.1) * amp; tot += amp; amp *= 0.5; f *= 2.03; }
    return s / tot;
  };
}

/** Terrace a height into steps of `step`, sharpening the risers into cliffs. */
function terrace(h, step, sharp) {
  const k = Math.floor(h / step), f = h / step - k;
  const e = smoothstep(0.5 - sharp, 0.5 + sharp, f);
  return (k + e) * step;
}

export const SHAPE_BY_BIOME = {
  island: "island", forest: "valley", desert: "open", snow: "valley", volcanic: "plateau",
  canyon: "valley", ruins: "plateau", city: "open", scifi_base: "open",
};

/** Grid dimensions for a world size: ≤160 vertices per side. */
export function terrainGrid(size) {
  const edge = Math.max(size.w, size.h);
  const cell = edge <= 240 ? 2 : 2.5;
  const cols = Math.min(MAX_TERRAIN_CELLS, Math.round(size.w / cell) + 1);
  const rows = Math.min(MAX_TERRAIN_CELLS, Math.round(size.h / cell) + 1);
  return { cell, cols, rows };
}

/**
 * Base heightfield before pads and paths. Returns Float64Array heights plus
 * the grid, and a few shape facts (`summit`) the layout wants to know.
 */
export function generateBaseTerrain({ size, biome, seed, waterLevel = 0 }) {
  const shape = SHAPE_BY_BIOME[biome] || "open";
  const { cell, cols, rows } = terrainGrid(size);
  const heights = new Float64Array(cols * rows);
  const n1 = fbm(seed ^ 0x51ed, 5), n2 = fbm(seed ^ 0x2b7a, 4), n3 = fbm(seed ^ 0x9c3f, 3), ang = fbm(seed ^ 0x77aa, 3);
  const k = Math.sqrt(Math.max(size.w, size.h) / 240); // relief grows gently with world size
  const r0 = lattice(1, 2, seed), r1 = lattice(3, 4, seed), r2 = lattice(5, 6, seed);
  // Summit sits off-centre so the hub (near centre) is not on a peak.
  const sa = r0 * Math.PI * 2, sd = 0.14 + 0.08 * r1;
  const summit = { u: 0.5 + Math.cos(sa) * sd, v: 0.5 + Math.sin(sa) * sd };
  const cliffAng = sa + Math.PI * (0.6 + 0.4 * r2); // sea cliffs roughly facing away from the summit
  const meander = { a: 0.12 + 0.06 * r1, f: 1.2 + r2 * 1.3, p: r0 * 6.28 };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * cell, z = j * cell;
      const u = x / size.w, v = z / size.h;
      let h;
      if (shape === "island") {
        const dx = u - 0.5, dz = v - 0.5, d = Math.hypot(dx, dz) / 0.5;
        const th = Math.atan2(dz, dx);
        // Coastline radius wobbles with angle (sampled on a circle so it is
        // seamless) plus fine detail for coves and spits.
        const R = 0.74 + 0.22 * (ang(Math.cos(th) * 1.6 + 5, Math.sin(th) * 1.6 + 5) - 0.5) * 2 + 0.07 * (n3(u * 7, v * 7) - 0.5) * 2;
        const land = 1 - d / R;
        if (land < 0) {
          h = waterLevel - 0.8 + land * 16;
          h = Math.max(h, waterLevel - 7 - 1.5 * n3(u * 4, v * 4));
        } else {
          const beach = smoothstep(0.0, 0.14, land);
          const sideCliff = smoothstep(0.55, 0.9, Math.cos(th - cliffAng)) * smoothstep(0.15, 0.3, n2(u * 3, v * 3) + 0.2);
          h = waterLevel + 0.35 + beach * 1.6 + land * 6 * k;
          h += sideCliff * 7 * k * smoothstep(0, 0.07, land);
          h += (n1(u * 5, v * 5) - 0.45) * 7 * k * beach * smoothstep(0.05, 0.35, land);
          const sdist = Math.hypot(u - summit.u, v - summit.v);
          h += 16 * k * Math.exp(-(sdist * sdist) / (2 * 0.12 * 0.12)) * beach;
          // Inland terraces where a noise mask says so: rock bands and cliffs.
          const cm = smoothstep(0.56, 0.66, n2(u * 2.5 + 3, v * 2.5 - 1)) * smoothstep(0.2, 0.35, land);
          if (cm > 0) h = lerp(h, terrace(h, 4.5, 0.08), cm);
        }
      } else if (shape === "valley") {
        const centre = 0.5 + meander.a * Math.sin(u * Math.PI * meander.f + meander.p) + 0.06 * (n3(u * 3, 1.7) - 0.5);
        const dist = Math.abs(v - centre);
        const canyon = biome === "canyon";
        const wallH = (canyon ? 20 : biome === "snow" ? 18 : 12) * k;
        const wall = canyon ? smoothstep(0.2, 0.27, dist) : smoothstep(0.16, 0.42, dist);
        h = wall * wallH + (n1(u * 4, v * 4) - 0.5) * (canyon ? 3 : 6) * k + wall * (n2(u * 6, v * 6) - 0.5) * 8 * k;
        if (canyon) h = lerp(h, terrace(h, 5, 0.1), wall);
        if (biome === "snow") h += Math.pow(n3(u * 3.3, v * 3.3), 3) * 16 * k * wall;
      } else if (shape === "plateau") {
        const dx = u - 0.5, dz = v - 0.5, d = Math.hypot(dx, dz) / 0.5;
        const rim = 0.46 + 0.1 * (n2(u * 3, v * 3) - 0.5) * 2;
        const mesa = smoothstep(rim + 0.06, rim - 0.02, d);
        h = mesa * 9 * k + (n1(u * 4, v * 4) - 0.5) * 5 * k + smoothstep(0.75, 1.0, d) * 5 * k;
        if (biome === "volcanic") {
          const sd = Math.hypot(u - summit.u, v - summit.v);
          h += 14 * k * Math.exp(-(sd * sd) / (2 * 0.09 * 0.09)) - 6 * k * Math.exp(-(sd * sd) / (2 * 0.03 * 0.03));
        }
      } else {
        const flat = biome === "city" || biome === "scifi_base";
        const dunes = biome === "desert" ? Math.pow(Math.abs(Math.sin((u * 5 + n2(u * 2, v * 2) * 1.5) * Math.PI)), 2) * 2.2 * k : 0;
        h = (n1(u * 3.5, v * 3.5) - 0.5) * (flat ? 2 : 7) * k + dunes;
      }
      // Frame non-island worlds with a gentle rim so the edge reads as land.
      if (shape !== "island") {
        const e = Math.min(u, v, 1 - u, 1 - v);
        h += smoothstep(0.06, 0, e) * 6 * k;
      }
      heights[j * cols + i] = h;
    }
  }
  return { shape, cell, cols, rows, heights, summit: { x: summit.u * size.w, z: summit.v * size.h } };
}

/** Level a disc to `target`, blending smoothly back to the terrain over `blend` metres. */
export function flattenPad(t, cx, cz, radius, target, blend = 8) {
  const R = radius + blend;
  const i0 = Math.max(0, Math.floor((cx - R) / t.cell)), i1 = Math.min(t.cols - 1, Math.ceil((cx + R) / t.cell));
  const j0 = Math.max(0, Math.floor((cz - R) / t.cell)), j1 = Math.min(t.rows - 1, Math.ceil((cz + R) / t.cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i * t.cell - cx, j * t.cell - cz);
      if (d > R) continue;
      const w = d <= radius ? 1 : 1 - smoothstep(radius, R, d);
      const idx = j * t.cols + i;
      t.heights[idx] = lerp(t.heights[idx], target, w);
    }
  }
}

/**
 * Longitudinal profile of a corridor: the terrain under the path, smoothed and
 * grade-limited in both directions so it never exceeds `maxGradeDeg`.
 *   pins  region pads {x,z,r,h}: samples inside take the pad height and are
 *         held fixed, so a corridor leaves every plaza at plaza level.
 *   keep  earlier corridors ({points,width,samp,prof}): where this one crosses
 *         or runs along them it takes their height, so crossings meet level.
 */
export function corridorProfile(t, points, width, { maxGradeDeg = 16, minH = -Infinity, pins = [], keep = [] } = {}) {
  // Resample the polyline at one-cell steps with cumulative arc length.
  const step = t.cell;
  const samp = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k], b = points[k + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / step));
    for (let s = 0; s < n; s++) samp.push({ x: lerp(a.x, b.x, s / n), z: lerp(a.z, b.z, s / n) });
  }
  samp.push({ ...points[points.length - 1] });
  let prof = samp.map((p) => Math.max(minH, sampleGrid(t, p.x, p.z)));
  const W = 3; // moving average half-window, in samples
  prof = prof.map((_, q) => {
    let s = 0, c = 0;
    for (let o = -W; o <= W; o++) { const v = prof[q + o]; if (v !== undefined) { s += v; c++; } }
    return s / c;
  });
  const fixed = new Uint8Array(samp.length);
  samp.forEach((p, q) => {
    for (const pin of pins) if (Math.hypot(p.x - pin.x, p.z - pin.z) <= pin.r) { prof[q] = pin.h; fixed[q] = 1; break; }
    if (fixed[q]) return;
    for (const k of keep) {
      // Within reach of both level bands the two should agree or a seam
      // forms: take the earlier corridor's height. Only a true crossing or
      // overlap is held fixed; the wider zone is a soft start the grade
      // passes may still bend, because a hard hold there can leave the
      // diverging stretch too short to climb.
      const d = distToPolyline(k.points, p.x, p.z);
      if (d > (k.width + width) / 2 + t.cell * 3 + 1) continue;
      let best = 0, bd = Infinity;
      k.samp.forEach((s, m) => { const dd = (s.x - p.x) ** 2 + (s.z - p.z) ** 2; if (dd < bd) { bd = dd; best = m; } });
      prof[q] = k.prof[best];
      if (d <= k.width / 2 + t.cell) fixed[q] = 1;
      break;
    }
  });
  const arc = [0];
  for (let q = 1; q < samp.length; q++) arc.push(arc[q - 1] + Math.hypot(samp[q].x - samp[q - 1].x, samp[q].z - samp[q - 1].z));
  const g = Math.tan((maxGradeDeg * Math.PI) / 180);
  for (let pass = 0; pass < 2; pass++) {
    for (let q = 1; q < prof.length; q++) { if (fixed[q]) continue; const dl = (arc[q] - arc[q - 1]) * g; prof[q] = clamp(prof[q], prof[q - 1] - dl, prof[q - 1] + dl); }
    for (let q = prof.length - 2; q >= 0; q--) { if (fixed[q]) continue; const dl = (arc[q + 1] - arc[q]) * g; prof[q] = clamp(prof[q], prof[q + 1] - dl, prof[q + 1] + dl); }
  }
  prof = prof.map((v, q) => (fixed[q] ? v : Math.max(minH, v)));
  return { points, width, samp, prof };
}

/**
 * Carve corridors into the heightfield together. Each vertex takes the
 * profile height of the NEAREST centreline sample over all corridors, level
 * inside the band and blended outside it — carving them one at a time would
 * let a later corridor overwrite an earlier one's band where they cross.
 * The level band is wider than the drawn path by 1.5 cells each side: nav
 * cells are judged at their centres, which can sit a cell off the centre
 * line, and bilinear slope reads the neighbouring vertices too.
 */
export function carveCorridors(t, corridors, { blend = 5 } = {}) {
  const N = t.cols * t.rows;
  const bestD = new Float64Array(N).fill(Infinity), bestH = new Float64Array(N), bestHalf = new Float64Array(N);
  for (const c of corridors) {
    const half = c.width / 2 + t.cell * 1.5, R = half + blend;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of c.samp) { x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z); }
    const i0 = Math.max(0, Math.floor((x0 - R) / t.cell)), i1 = Math.min(t.cols - 1, Math.ceil((x1 + R) / t.cell));
    const j0 = Math.max(0, Math.floor((z0 - R) / t.cell)), j1 = Math.min(t.rows - 1, Math.ceil((z1 + R) / t.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i * t.cell, z = j * t.cell, idx = j * t.cols + i;
        if (distToPolyline(c.points, x, z) > R) continue;
        let best = 0, bd = Infinity;
        for (let q = 0; q < c.samp.length; q++) {
          const d = (c.samp[q].x - x) ** 2 + (c.samp[q].z - z) ** 2;
          if (d < bd) { bd = d; best = q; }
        }
        const d = Math.sqrt(bd);
        // Compare by distance beyond each corridor's own level band, so a
        // wide corridor is not stolen from by a narrow neighbour.
        if (d > R || d - half >= bestD[idx]) continue;
        bestD[idx] = d - half; bestH[idx] = c.prof[best]; bestHalf[idx] = half;
      }
    }
  }
  for (let idx = 0; idx < N; idx++) {
    if (bestD[idx] === Infinity) continue;
    const w = bestD[idx] <= 0 ? 1 : 1 - smoothstep(0, blend, bestD[idx]);
    t.heights[idx] = lerp(t.heights[idx], bestH[idx], w);
  }
}

/** Profile and carve one corridor (convenience wrapper). Returns the profile. */
export function flattenCorridor(t, points, width, opts = {}) {
  const c = corridorProfile(t, points, width, opts);
  carveCorridors(t, [c], opts);
  return c.prof;
}

/** Bilinear sample on a raw {cell, cols, rows, heights} grid. */
export function sampleGrid(t, x, z) {
  const fx = clamp(x / t.cell, 0, t.cols - 1), fz = clamp(z / t.cell, 0, t.rows - 1);
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const i1 = Math.min(i0 + 1, t.cols - 1), j1 = Math.min(j0 + 1, t.rows - 1);
  const tx = fx - i0, tz = fz - j0, H = t.heights, c = t.cols;
  return (H[j0 * c + i0] * (1 - tx) + H[j0 * c + i1] * tx) * (1 - tz) + (H[j1 * c + i0] * (1 - tx) + H[j1 * c + i1] * tx) * tz;
}

/** Slope in degrees on a raw grid. */
export function slopeGrid(t, x, z) {
  const e = t.cell * 0.5;
  const dx = (sampleGrid(t, x + e, z) - sampleGrid(t, x - e, z)) / (2 * e);
  const dz = (sampleGrid(t, x, z + e) - sampleGrid(t, x, z - e)) / (2 * e);
  return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
}

/**
 * Last-resort seam repair along path centrelines. Where two corridors or a
 * corridor and a cliff still meet steeply enough that a walker would be
 * stopped (slope above `maxSlopeDeg` on or just beside the centre line), the
 * vertices around that spot are relaxed towards their neighbours' average
 * until the slope drops. Returns the number of spots still too steep.
 */
export function relaxPathSeams(t, paths, { maxSlopeDeg = 30, iterations = 8, pinned = () => false } = {}) {
  let bad = 0;
  for (let it = 0; it < iterations; it++) {
    const mark = new Set();
    bad = 0;
    for (const p of paths) {
      for (let k = 0; k + 1 < p.points.length; k++) {
        const a = p.points[k], b = p.points[k + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L));
        const nx = -(b.z - a.z) / (L || 1), nz = (b.x - a.x) / (L || 1);
        for (let s = 0; s <= n; s++) {
          for (const off of [-t.cell, 0, t.cell]) {
            const x = lerp(a.x, b.x, s / n) + nx * off, z = lerp(a.z, b.z, s / n) + nz * off;
            if (slopeGrid(t, x, z) <= maxSlopeDeg) continue;
            bad++;
            const ci = Math.round(x / t.cell), cj = Math.round(z / t.cell);
            for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
              const i = ci + di, j = cj + dj;
              if (i > 0 && j > 0 && i < t.cols - 1 && j < t.rows - 1 && !pinned(i * t.cell, j * t.cell)) mark.add(j * t.cols + i);
            }
          }
        }
      }
    }
    if (!mark.size) return 0;
    for (let sweep = 0; sweep < 3; sweep++) {
      const next = new Map();
      for (const idx of mark) {
        const H = t.heights, c = t.cols;
        next.set(idx, (H[idx] * 2 + H[idx - 1] + H[idx + 1] + H[idx - c] + H[idx + c]) / 6);
      }
      for (const [idx, v] of next) t.heights[idx] = v;
    }
  }
  return bad;
}
