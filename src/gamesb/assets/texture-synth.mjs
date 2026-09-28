// Games-B procedural texture synthesis. ISOMORPHIC — this file is loaded
// straight into the browser runtime (and the texture gallery), so it imports
// only other iso modules and never touches process / Buffer / fs.
//
// Every generator is built from PERIODIC primitives (lattice value noise whose
// lattice wraps, Worley cells whose feature points wrap, sines with an integer
// number of cycles per tile). That is what makes the output tile without seams:
// the right-hand column's neighbour is, by construction, the left-hand column.
//
// A generator produces three fields — colour, height and roughness — and the
// normal map is derived from height with a wrapping Sobel filter, so the
// lighting relief always agrees with the painted detail.

import { hashString, clamp } from "../common/rng.mjs";

export const TEXTURE_GENERATORS = Object.freeze([
  "grass", "sand", "rock", "dirt", "snow", "bricks", "planks", "stone_tiles",
  "roof_tiles", "bark", "leaves", "metal", "plaster", "water", "cloth", "noise",
]);
export const TEXTURE_SIZES = Object.freeze([64, 128, 256, 512]);

// ------------------------------------------------------------------ helpers

const TAU = Math.PI * 2;

/** Integer hash → [0,1). Math.imul keeps it exact on 32 bits in every engine. */
function h2(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const mod = (a, n) => ((a % n) + n) % n;
const smooth = (t) => t * t * (3 - 2 * t);
function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Piecewise-linear ramp through a list of rgb triples, t in [0,1]. */
function ramp(stops, t) {
  const n = stops.length - 1;
  const f = clamp(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const k = f - i, a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Periodic value noise sampled on an N×N grid: `px` lattice cells across and
 * `py` down, both wrapping. Anisotropic periods (px ≠ py) give the streaks
 * used for grass blades, bark fibre and brushed metal.
 */
function valueNoise(N, px, py, seed) {
  px = Math.max(1, px | 0); py = Math.max(1, py | 0);
  const lat = new Float32Array(px * py);
  for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) lat[j * px + i] = h2(i, j, seed);
  const x0 = new Int32Array(N), x1 = new Int32Array(N), wx = new Float32Array(N);
  for (let x = 0; x < N; x++) {
    const f = (x * px) / N, i = Math.floor(f);
    x0[x] = i % px; x1[x] = (i + 1) % px; wx[x] = smooth(f - i);
  }
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const f = (y * py) / N, j = Math.floor(f), wy = smooth(f - j);
    const r0 = (j % py) * px, r1 = ((j + 1) % py) * px;
    const o = y * N;
    for (let x = 0; x < N; x++) {
      const a = lat[r0 + x0[x]], b = lat[r0 + x1[x]], c = lat[r1 + x0[x]], d = lat[r1 + x1[x]];
      const top = a + (b - a) * wx[x], bot = c + (d - c) * wx[x];
      out[o + x] = top + (bot - top) * wy;
    }
  }
  return out;
}

/** Fractal sum of periodic value noise, stretched to span [0,1]. */
function fbm(N, px, py, octaves, seed, gain = 0.5) {
  const out = new Float32Array(N * N);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(N, px << o, py << o, seed + o * 1013);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp; amp *= gain;
  }
  return normalize(out);
}

/** Linear stretch to [0,1]; deterministic, so contrast does not depend on luck. */
function normalize(f) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < f.length; i++) { const v = f[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < f.length; i++) f[i] = (f[i] - lo) * k;
  return f;
}

/**
 * Periodic Worley (cellular) noise with `cells`×`cells` jittered feature
 * points. Neighbour cells are looked up modulo `cells` but positioned
 * unwrapped, so distances are continuous across the tile edge. Distances are
 * in cell units. Returns F1, F2 and the (wrapped) id of the nearest cell.
 */
function worley(N, cells, seed, jitter = 0.85) {
  cells = Math.max(1, cells | 0);
  const fx = new Float32Array(cells * cells), fy = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    fx[j * cells + i] = 0.5 + (h2(i, j, seed) - 0.5) * jitter;
    fy[j * cells + i] = 0.5 + (h2(i, j, seed + 7) - 0.5) * jitter;
  }
  const f1 = new Float32Array(N * N), f2 = new Float32Array(N * N), id = new Int32Array(N * N);
  const k = cells / N;
  for (let y = 0; y < N; y++) {
    const v = y * k, cy = Math.floor(v);
    for (let x = 0; x < N; x++) {
      const u = x * k, cx = Math.floor(u);
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy, wy = mod(ny, cells);
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, wx = mod(nx, cells), c = wy * cells + wx;
          const ddx = nx + fx[c] - u, ddy = ny + fy[c] - v;
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d < d1) { d2 = d1; d1 = d; best = c; } else if (d < d2) d2 = d;
        }
      }
      const i = y * N + x;
      f1[i] = d1; f2[i] = d2; id[i] = best;
    }
  }
  return { f1, f2, id };
}

/** Normal map from a height field: wrapping Sobel, OpenGL (+Y up) convention. */
function heightToNormal(H, N, strength) {
  const out = new Uint8ClampedArray(N * N * 4);
  const s = strength * (N / 256);
  for (let y = 0; y < N; y++) {
    const ym = ((y - 1 + N) % N) * N, y0 = y * N, yp = ((y + 1) % N) * N;
    for (let x = 0; x < N; x++) {
      const xm = (x - 1 + N) % N, xp = (x + 1) % N;
      const dx = (H[ym + xp] + 2 * H[y0 + xp] + H[yp + xp]) - (H[ym + xm] + 2 * H[y0 + xm] + H[yp + xm]);
      const dy = (H[yp + xm] + 2 * H[yp + x] + H[yp + xp]) - (H[ym + xm] + 2 * H[ym + x] + H[ym + xp]);
      let nx = -dx * s, ny = dy * s, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (y0 + x) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255; out[o + 1] = (ny * 0.5 + 0.5) * 255; out[o + 2] = (nz * 0.5 + 0.5) * 255; out[o + 3] = 255;
    }
  }
  return out;
}

// --------------------------------------------------------------- generators
//
// Each receives (N, seed, stops[rgb], params, sc) and writes into
// ctx.rgb (0..255 floats), ctx.H (0..1) and ctx.R (0..1).

const DEFAULT_COLORS = {
  grass:       ["#34591f", "#4f7f2c", "#7fa845", "#a39352"],
  sand:        ["#b8925a", "#d6b882", "#efdcae", "#9c7a4a"],
  rock:        ["#4a4743", "#6f6b64", "#958f84", "#2e2c29"],
  dirt:        ["#4c3727", "#6e5139", "#8d6c4b", "#8a8378"],
  snow:        ["#b7c6d8", "#dfe8f1", "#f7fafd", "#ffffff"],
  bricks:      ["#7c3f2e", "#9c563e", "#b8765a", "#c9c0b0"],
  planks:      ["#5e4029", "#80593a", "#a07650", "#20160d"],
  stone_tiles: ["#625d56", "#817b71", "#a29b8e", "#3f3b35"],
  roof_tiles:  ["#6e3324", "#8c4630", "#ab5f40", "#2c140d"],
  bark:        ["#2a1d13", "#4b3524", "#6c4f36", "#140d08"],
  leaves:      ["#1f3d17", "#355f25", "#5a8a36", "#11220c"],
  metal:       ["#5c6268", "#7d848b", "#a7aeb4", "#3c4145"],
  plaster:     ["#c2b59b", "#d7cdb7", "#ebe4d3", "#9c8f77"],
  water:       ["#153f5a", "#23617f", "#3f8aa8", "#d4ecf2"],
  cloth:       ["#553a63", "#6f4e80", "#8d6ba0", "#2f2038"],
  noise:       ["#404040", "#808080", "#c0c0c0"],
};
const DEFAULT_ROUGHNESS = {
  grass: 0.92, sand: 0.9, rock: 0.85, dirt: 0.95, snow: 0.75, bricks: 0.82, planks: 0.72, stone_tiles: 0.8,
  roof_tiles: 0.7, bark: 0.95, leaves: 0.8, metal: 0.38, plaster: 0.9, water: 0.08, cloth: 0.95, noise: 0.8,
};
const DEFAULT_NORMAL_STRENGTH = {
  grass: 2.2, sand: 1.6, rock: 3.2, dirt: 2.4, snow: 1.0, bricks: 3.0, planks: 2.2, stone_tiles: 3.0,
  roof_tiles: 3.2, bark: 3.4, leaves: 2.6, metal: 1.2, plaster: 1.2, water: 1.6, cloth: 1.8, noise: 2.0,
};

const P = (sc, base) => Math.max(1, Math.round(base * sc));

const GEN = {
  noise(N, s, c, p, sc, ctx) {
    const n = fbm(N, P(sc, 4), P(sc, 4), 5, s);
    for (let i = 0; i < N * N; i++) { ctx.set(i, ramp(c, n[i])); ctx.H[i] = n[i]; ctx.R[i] = ctx.r0 + (n[i] - 0.5) * 0.1; }
  },

  grass(N, s, c, p, sc, ctx) {
    const patch = fbm(N, P(sc, 3), P(sc, 3), 4, s);
    const bladeA = fbm(N, P(sc, 48), P(sc, 6), 2, s + 11);     // long vertical strokes
    const bladeB = fbm(N, P(sc, 7), P(sc, 40), 2, s + 23);     // crossing strokes
    const fine = valueNoise(N, P(sc, 96), P(sc, 96), s + 31);
    const dry = c[3] || c[2];
    for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i++) {
      const blades = Math.max(bladeA[i], bladeB[i] * 0.9) * 0.75 + fine[i] * 0.25;
      let col = ramp([c[0], c[1], c[2]], clamp(0.62 * blades + 0.38 * patch[i], 0, 1));
      const dryAmt = smoothstep(0.62, 0.9, patch[i]) * 0.45;
      col = mix3(col, dry, dryAmt);
      const speck = h2(x, y, s + 5);
      if (speck > 0.992) col = mix3(col, [230, 220, 150], 0.6);              // seed heads
      ctx.set(i, col);
      ctx.H[i] = blades * 0.8 + patch[i] * 0.2;
      ctx.R[i] = ctx.r0 - blades * 0.12;
    }
  },

  sand(N, s, c, p, sc, ctx) {
    const warp = fbm(N, P(sc, 3), P(sc, 3), 3, s);
    const base = fbm(N, P(sc, 5), P(sc, 5), 3, s + 3);
    const k = P(sc, p.ripples ?? 11);
    for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i++) {
      const v = y / N;
      const ph = k * v + 1.4 * (warp[i] - 0.5);
      let r = 0.5 + 0.5 * Math.sin(TAU * ph);
      r = Math.pow(r, 1.6);                                        // sharp crests, wide troughs
      const g = h2(x, y, s + 9);
      let col = ramp([c[0], c[1], c[2]], clamp(0.45 * r + 0.35 * base[i] + 0.2 * g, 0, 1));
      if (g > 0.975) col = mix3(col, c[3] || c[0], 0.7);           // dark grains
      else if (g < 0.012) col = mix3(col, [255, 250, 235], 0.6);    // bright quartz grains
      ctx.set(i, col);
      ctx.H[i] = r * 0.8 + g * 0.2;
      ctx.R[i] = ctx.r0 - r * 0.05;
    }
  },

  rock(N, s, c, p, sc, ctx) {
    const warp = fbm(N, P(sc, 3), P(sc, 3), 3, s);
    const det = fbm(N, P(sc, 8), P(sc, 8), 4, s + 5);
    const cells = worley(N, P(sc, p.cells ?? 4), s + 17);
    const crackMask = fbm(N, P(sc, 3), P(sc, 3), 2, s + 23);
    const k = P(sc, p.strata ?? 7);
    for (let i = 0; i < N * N; i++) {
      const y = Math.floor(i / N), v = y / N;
      const strata = 0.5 + 0.5 * Math.sin(TAU * (k * v + 0.9 * (warp[i] - 0.5)));
      const edge = cells.f2[i] - cells.f1[i];
      // Cracks only where the mask allows, so the face reads as rock, not paving.
      const crack = Math.max(smoothstep(0.01, 0.06, edge), 1 - smoothstep(0.3, 0.55, crackMask[i]));
      const cellTone = h2(cells.id[i], 3, s);
      const tone = 0.4 * strata + 0.4 * det[i] + 0.2 * cellTone;
      let col = ramp([c[3] || c[0], c[0], c[1], c[2]], clamp(0.15 + tone * 0.85, 0, 1));
      col = mix3(c[3] || [30, 30, 30], col, 0.35 + 0.65 * crack);
      ctx.set(i, col);
      ctx.H[i] = (0.55 * det[i] + 0.3 * strata + 0.15 * cellTone) * (0.3 + 0.7 * crack);
      ctx.R[i] = ctx.r0 + (1 - crack) * 0.1 - det[i] * 0.08;
    }
  },

  dirt(N, s, c, p, sc, ctx) {
    const base = fbm(N, P(sc, 4), P(sc, 4), 5, s);
    const peb = worley(N, P(sc, p.pebbles ?? 9), s + 3, 0.9);
    const clump = fbm(N, P(sc, 16), P(sc, 16), 2, s + 9);
    for (let i = 0; i < N * N; i++) {
      const size = 0.2 + 0.25 * h2(peb.id[i], 1, s);
      const stone = h2(peb.id[i], 2, s) > 0.55 ? smoothstep(size, size * 0.55, peb.f1[i]) : 0;
      let col = ramp([c[0], c[1], c[2]], clamp(0.6 * base[i] + 0.4 * clump[i], 0, 1));
      col = mix3(col, mix3(c[3] || [140, 130, 120], col, 0.3 * h2(peb.id[i], 4, s)), stone * 0.85);
      ctx.set(i, col);
      ctx.H[i] = 0.5 * base[i] + 0.2 * clump[i] + 0.5 * stone;
      ctx.R[i] = ctx.r0 - stone * 0.15;
    }
  },

  snow(N, s, c, p, sc, ctx) {
    const drift = fbm(N, P(sc, 3), P(sc, 3), 4, s);
    const fine = fbm(N, P(sc, 24), P(sc, 24), 2, s + 4);
    for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i++) {
      const t = 0.75 * drift[i] + 0.25 * fine[i];
      let col = ramp([c[0], c[1], c[2]], clamp(0.25 + t * 0.75, 0, 1));
      const sp = h2(x, y, s + 13);
      if (sp > 0.996) col = [255, 255, 255];                         // sparkle
      ctx.set(i, col);
      ctx.H[i] = t;
      ctx.R[i] = ctx.r0 - (sp > 0.996 ? 0.4 : 0);
    }
  },

  bricks(N, s, c, p, sc, ctx) {
    let rows = P(sc, p.rows ?? 8); if (rows % 2) rows++;            // even, so the half-offset wraps
    const cols = P(sc, p.cols ?? 4);
    const mortarPx = Math.max(1, (p.mortar ?? 0.07) * (N / rows));
    const bevelPx = mortarPx * 1.4;
    const surf = fbm(N, P(sc, 16), P(sc, 16), 3, s);
    const chip = valueNoise(N, P(sc, 32), P(sc, 32), s + 3);
    const mortarCol = c[3] || [200, 195, 185];
    for (let y = 0, i = 0; y < N; y++) {
      const v = (y / N) * rows, row = Math.floor(v), fy = v - row;
      const dyPx = Math.min(fy, 1 - fy) * (N / rows);
      for (let x = 0; x < N; x++, i++) {
        const u = (x / N) * cols + (row % 2) * 0.5, col = Math.floor(u), fx = u - col;
        const dxPx = Math.min(fx, 1 - fx) * (N / cols);
        const edge = Math.min(dxPx, dyPx) - chip[i] * mortarPx * 0.9;
        const brickId = mod(col, cols) + row * 131;
        const tint = h2(brickId, 7, s);
        const burnt = h2(brickId, 9, s) > 0.86;
        if (edge < mortarPx) {
          ctx.set(i, mix3(mortarCol, [mortarCol[0] * 0.8, mortarCol[1] * 0.8, mortarCol[2] * 0.8], surf[i]));
          ctx.H[i] = 0.1 * surf[i];
          ctx.R[i] = 0.95;
        } else {
          let colr = ramp([c[0], c[1], c[2]], clamp(0.3 + 0.5 * tint + 0.3 * (surf[i] - 0.5), 0, 1));
          if (burnt) colr = mix3(colr, c[0], 0.6);
          ctx.set(i, colr);
          ctx.H[i] = smoothstep(mortarPx, mortarPx + bevelPx, edge) * (0.8 + 0.2 * surf[i]);
          ctx.R[i] = ctx.r0 + (surf[i] - 0.5) * 0.1;
        }
      }
    }
  },

  planks(N, s, c, p, sc, ctx) {
    const boards = P(sc, p.boards ?? 6);
    const gap = p.gap ?? 0.035;
    const warp = fbm(N, P(sc, 2), P(sc, 3), 3, s);
    const fibre = fbm(N, P(sc, boards * 10), P(sc, 3), 3, s + 5);
    const gapCol = c[3] || [30, 20, 12];
    for (let y = 0, i = 0; y < N; y++) {
      const v = y / N;
      for (let x = 0; x < N; x++, i++) {
        const u = (x / N) * boards + 0.5, b = Math.floor(u), fx = u - b, bw = mod(b, boards);
        const seamOff = h2(bw, 1, s);
        const fv = mod(v - seamOff, 1);
        const seamDist = Math.min(fv, 1 - fv) * N;                 // px to this board's butt joint
        const sideDist = Math.min(fx, 1 - fx) * (N / boards);
        const tint = h2(bw, 3, s);
        const rings = 0.5 + 0.5 * Math.sin(TAU * (fx * (2 + tint * 2) + 2.2 * warp[i] + tint));
        const grain = 0.55 * rings + 0.45 * fibre[i];
        const gapPx = Math.max(1, gap * (N / boards));
        if (sideDist < gapPx || seamDist < gapPx * 0.8) {
          ctx.set(i, gapCol); ctx.H[i] = 0; ctx.R[i] = 1;
          continue;
        }
        let col = ramp([c[0], c[1], c[2]], clamp(0.2 + 0.45 * tint + 0.45 * (grain - 0.3), 0, 1));
        // nail heads near each butt joint
        const nx = Math.abs(fx - 0.5) - 0.3, ny = seamDist / (N / boards) - 0.12;
        const nail = nx * nx + ny * ny < 0.0016;
        if (nail) col = [70, 70, 72];
        ctx.set(i, col);
        ctx.H[i] = nail ? 0.9 : smoothstep(gapPx, gapPx * 3, Math.min(sideDist, seamDist)) * (0.75 + 0.25 * grain);
        ctx.R[i] = nail ? 0.35 : ctx.r0 + (grain - 0.5) * 0.12;
      }
    }
  },

  stone_tiles(N, s, c, p, sc, ctx) {
    const cells = worley(N, P(sc, p.cells ?? 5), s, 0.7);
    const surf = fbm(N, P(sc, 12), P(sc, 12), 4, s + 3);
    const chip = valueNoise(N, P(sc, 40), P(sc, 40), s + 5);
    const mortar = p.mortar ?? 0.07;
    const mortarCol = c[3] || [60, 58, 54];
    for (let i = 0; i < N * N; i++) {
      const edge = cells.f2[i] - cells.f1[i] - chip[i] * 0.04;
      const tint = h2(cells.id[i], 5, s);
      if (edge < mortar) {
        ctx.set(i, mix3(mortarCol, [mortarCol[0] * 0.7, mortarCol[1] * 0.7, mortarCol[2] * 0.7], surf[i]));
        ctx.H[i] = 0.05; ctx.R[i] = 0.97;
      } else {
        const col = ramp([c[0], c[1], c[2]], clamp(0.2 + 0.55 * tint + 0.4 * (surf[i] - 0.5), 0, 1));
        ctx.set(i, col);
        ctx.H[i] = smoothstep(mortar, mortar + 0.14, edge) * (0.8 + 0.2 * surf[i]);
        ctx.R[i] = ctx.r0 + (surf[i] - 0.5) * 0.12;
      }
    }
  },

  roof_tiles(N, s, c, p, sc, ctx) {
    let rows = P(sc, p.rows ?? 8); if (rows % 2) rows++;
    const cols = P(sc, p.cols ?? 8);
    const surf = fbm(N, P(sc, 16), P(sc, 16), 3, s);
    const shadow = c[3] || [30, 15, 10];
    for (let y = 0, i = 0; y < N; y++) {
      // Half-row phase shift keeps a tile boundary off the texture edge.
      const v = (y / N) * rows + 0.5, row = Math.floor(v), fy = v - row;
      for (let x = 0; x < N; x++, i++) {
        const u = (x / N) * cols + (row % 2) * 0.5 + 0.25, col = Math.floor(u), fx = u - col;
        const cx = 2 * fx - 1;
        const bottom = 0.78 + 0.22 * Math.sqrt(Math.max(0, 1 - cx * cx));   // rounded lower edge
        const tint = h2(mod(col, cols) + row * 97, 3, s);
        const side = Math.min(fx, 1 - fx) * (N / cols);
        if (fy > bottom || side < 1) {
          // Showing through: the top of the tile in the row below, in shadow.
          ctx.set(i, mix3(shadow, ramp([c[0], c[1]], tint), 0.35));
          ctx.H[i] = 0.05; ctx.R[i] = 0.9;
        } else {
          const shade = 0.55 + 0.45 * fy;                         // darker where the row above overlaps
          let colr = ramp([c[0], c[1], c[2]], clamp(0.25 + 0.5 * tint + 0.25 * (surf[i] - 0.5), 0, 1));
          colr = [colr[0] * shade, colr[1] * shade, colr[2] * shade];
          ctx.set(i, colr);
          ctx.H[i] = 0.25 + 0.75 * fy * (1 - 0.25 * cx * cx) + 0.05 * surf[i];
          ctx.R[i] = ctx.r0 + (surf[i] - 0.5) * 0.15;
        }
      }
    }
  },

  bark(N, s, c, p, sc, ctx) {
    const warp = fbm(N, P(sc, 3), P(sc, 2), 3, s);
    const fibre = fbm(N, P(sc, 40), P(sc, 4), 3, s + 7);
    const plates = worley(N, P(sc, 6), s + 3, 0.9);
    const k = P(sc, p.ridges ?? 9);
    for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i++) {
      const u = x / N;
      let r = Math.abs(Math.sin(Math.PI * (k * u + 1.6 * (warp[i] - 0.5))));
      r = Math.pow(r, 0.55);
      const hcrack = smoothstep(0.0, 0.12, plates.f2[i] - plates.f1[i]);
      const hgt = r * (0.55 + 0.45 * hcrack) * (0.7 + 0.3 * fibre[i]);
      const col = ramp([c[3] || c[0], c[0], c[1], c[2]], clamp(hgt * 1.05, 0, 1));
      ctx.set(i, col);
      ctx.H[i] = hgt;
      ctx.R[i] = ctx.r0 - hgt * 0.05;
    }
  },

  leaves(N, s, c, p, sc, ctx) {
    const a = worley(N, P(sc, p.cells ?? 9), s, 0.95);
    const b = worley(N, P(sc, p.cells ?? 9), s + 101, 0.95);
    const vein = fbm(N, P(sc, 24), P(sc, 24), 2, s + 5);
    const gapCol = c[3] || [15, 30, 10];
    for (let i = 0; i < N * N; i++) {
      const la = 1 - a.f1[i] / 0.62, lb = 1 - b.f1[i] / 0.62;
      let col, hgt;
      if (la > 0.02) {
        const t = h2(a.id[i], 1, s);
        col = ramp([c[0], c[1], c[2]], clamp(0.3 + 0.5 * t + 0.3 * la, 0, 1));
        hgt = 0.5 + 0.5 * la;
      } else if (lb > 0.02) {
        const t = h2(b.id[i], 1, s + 1);
        col = mix3(ramp([c[0], c[1]], t), gapCol, 0.35);
        hgt = 0.2 + 0.3 * lb;
      } else { col = gapCol; hgt = 0; }
      col = mix3(col, [col[0] * 0.8, col[1] * 0.9, col[2] * 0.8], vein[i] * 0.4);
      ctx.set(i, col);
      ctx.H[i] = hgt;
      ctx.R[i] = ctx.r0 - hgt * 0.15;
    }
  },

  metal(N, s, c, p, sc, ctx) {
    const brush = fbm(N, P(sc, 2), P(sc, 96), 3, s);              // long horizontal streaks
    const blot = fbm(N, P(sc, 4), P(sc, 4), 3, s + 3);
    const panels = Math.max(1, (p.panels ?? 2) | 0);
    const rivets = p.rivets ?? true;
    for (let y = 0, i = 0; y < N; y++) {
      const fy = ((y / N) * panels) % 1, dyPx = Math.min(fy, 1 - fy) * (N / panels);
      for (let x = 0; x < N; x++, i++) {
        const fx = ((x / N) * panels) % 1, dxPx = Math.min(fx, 1 - fx) * (N / panels);
        const seam = Math.min(dxPx, dyPx) < 1.2;
        const scratch = h2(y, Math.floor(x / 23), s + 9) > 0.985 ? 0.25 : 0;
        const rx = dxPx - N / panels * 0.06, ry = dyPx - N / panels * 0.06;
        const rivet = rivets && rx * rx + ry * ry < Math.pow(N / 256 * 3, 2);
        let col = ramp([c[0], c[1], c[2]], clamp(0.35 + 0.35 * brush[i] + 0.25 * (blot[i] - 0.5) + scratch, 0, 1));
        if (seam) col = mix3(col, c[3] || [40, 40, 40], 0.8);
        if (rivet) col = mix3(col, c[2], 0.5);
        ctx.set(i, col);
        ctx.H[i] = seam ? 0 : rivet ? 1 : 0.5 + 0.1 * brush[i];
        ctx.R[i] = ctx.r0 + 0.18 * blot[i] - 0.1 * brush[i] - scratch * 0.3;
      }
    }
  },

  plaster(N, s, c, p, sc, ctx) {
    const base = fbm(N, P(sc, 6), P(sc, 6), 5, s);
    const stain = fbm(N, P(sc, 2), P(sc, 2), 3, s + 3);
    const cr = worley(N, P(sc, 4), s + 7, 0.9);
    const crackMask = fbm(N, P(sc, 3), P(sc, 3), 2, s + 11);
    for (let i = 0; i < N * N; i++) {
      const crack = crackMask[i] > 0.7 && cr.f2[i] - cr.f1[i] < 0.025;
      let col = ramp([c[0], c[1], c[2]], clamp(0.35 + 0.4 * (base[i] - 0.5) + 0.35 * stain[i], 0, 1));
      col = mix3(col, c[3] || c[0], smoothstep(0.6, 0.95, 1 - stain[i]) * 0.35);
      if (crack) col = mix3(col, [60, 55, 50], 0.6);
      ctx.set(i, col);
      ctx.H[i] = crack ? 0.1 : 0.45 + 0.35 * base[i];
      ctx.R[i] = ctx.r0 - stain[i] * 0.05;
    }
  },

  water(N, s, c, p, sc, ctx) {
    // Integer wave vectors keep every sine periodic over the tile.
    const waves = [];
    for (let w = 0; w < 6; w++) {
      waves.push({ kx: 1 + Math.floor(h2(w, 1, s) * 5 * sc), ky: Math.floor((h2(w, 2, s) - 0.5) * 6 * sc), ph: h2(w, 3, s) * TAU, a: 1 / (1 + w * 0.6) });
    }
    const chop = fbm(N, P(sc, 8), P(sc, 8), 3, s + 5);
    const tmp = new Float32Array(N * N);
    for (let y = 0, i = 0; y < N; y++) for (let x = 0; x < N; x++, i++) {
      const u = x / N, v = y / N;
      let hgt = 0;
      for (const w of waves) hgt += w.a * Math.sin(TAU * (w.kx * u + w.ky * v) + w.ph);
      tmp[i] = hgt + 1.3 * (chop[i] - 0.5);
    }
    normalize(tmp);
    for (let i = 0; i < N * N; i++) {
      let col = ramp([c[0], c[1], c[2]], tmp[i]);
      col = mix3(col, c[3] || [230, 245, 250], smoothstep(0.9, 1.0, tmp[i]) * 0.45);
      ctx.set(i, col);
      ctx.H[i] = tmp[i];
      ctx.R[i] = ctx.r0 + tmp[i] * 0.04;
    }
  },

  cloth(N, s, c, p, sc, ctx) {
    const t = P(sc, p.threads ?? 48);
    const fib = fbm(N, P(sc, 64), P(sc, 64), 2, s);
    const stain = fbm(N, P(sc, 3), P(sc, 3), 3, s + 3);
    for (let y = 0, i = 0; y < N; y++) {
      const fv = (y / N) * t + 0.5, jv = Math.floor(fv);   // half-thread phase: no seam on the edge
      for (let x = 0; x < N; x++, i++) {
        const fu = (x / N) * t + 0.5, ju = Math.floor(fu);
        const warpUp = (ju + jv) % 2 === 0;                        // plain weave: over, under
        const hgt = warpUp ? Math.sin(Math.PI * (fv - jv)) : Math.sin(Math.PI * (fu - ju));
        const base = warpUp ? c[1] : c[0];
        let col = mix3(base, c[2], 0.35 * hgt + 0.2 * (fib[i] - 0.5));
        col = mix3(col, c[3] || c[0], smoothstep(0.65, 0.95, stain[i]) * 0.3);
        ctx.set(i, col);
        ctx.H[i] = 0.6 * hgt + 0.2 * fib[i];
        ctx.R[i] = ctx.r0;
      }
    }
  },
};

// ------------------------------------------------------------------ public

/**
 * Synthesize a texture recipe into RGBA arrays:
 *   { width, height, albedo, normal, roughness } (Uint8ClampedArray each).
 * Deterministic in (generator, size, seed, colors, scale, params).
 */
export function synthesizeTexture(recipe) {
  const gen = TEXTURE_GENERATORS.includes(recipe?.generator) ? recipe.generator : "noise";
  const N = TEXTURE_SIZES.includes(recipe?.size) ? recipe.size : 256;
  const seed = (Number.isInteger(recipe?.seed) ? recipe.seed : hashString(gen)) | 0;
  const sc = clamp(Number(recipe?.scale) || 1, 0.25, 8);
  const params = recipe?.params && typeof recipe.params === "object" ? recipe.params : {};
  const colors = (Array.isArray(recipe?.colors) && recipe.colors.length ? recipe.colors : DEFAULT_COLORS[gen]).map(hexToRgb);
  const defaults = DEFAULT_COLORS[gen].map(hexToRgb);
  while (colors.length < defaults.length) colors.push(defaults[colors.length]);

  const rgb = new Float32Array(N * N * 3);
  const ctx = {
    H: new Float32Array(N * N),
    R: new Float32Array(N * N),
    r0: Number.isFinite(params.roughness) ? params.roughness : DEFAULT_ROUGHNESS[gen],
    set(i, col) { const o = i * 3; rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2]; },
  };
  GEN[gen](N, seed, colors, params, sc, ctx);

  const albedo = new Uint8ClampedArray(N * N * 4), roughness = new Uint8ClampedArray(N * N * 4);
  for (let i = 0, o = 0; i < N * N; i++, o += 4) {
    albedo[o] = rgb[i * 3]; albedo[o + 1] = rgb[i * 3 + 1]; albedo[o + 2] = rgb[i * 3 + 2]; albedo[o + 3] = 255;
    const r = clamp(ctx.R[i], 0.02, 1) * 255;
    roughness[o] = r; roughness[o + 1] = r; roughness[o + 2] = r; roughness[o + 3] = 255;
  }
  const strength = Number.isFinite(params.normal_strength) ? params.normal_strength : DEFAULT_NORMAL_STRENGTH[gen];
  const normal = heightToNormal(ctx.H, N, strength);
  return { width: N, height: N, generator: gen, albedo, normal, roughness };
}

/** One channel of a recipe that carries `channel` (albedo|normal|roughness). */
export function synthesizeChannel(recipe) {
  const t = synthesizeTexture(recipe);
  const ch = ["albedo", "normal", "roughness"].includes(recipe?.channel) ? recipe.channel : "albedo";
  return { width: t.width, height: t.height, data: t[ch], channel: ch };
}

export const textureDefaults = (gen) => ({ colors: [...(DEFAULT_COLORS[gen] || DEFAULT_COLORS.noise)], roughness: DEFAULT_ROUGHNESS[gen] ?? 0.8 });
