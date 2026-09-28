// Games-B world: terrain sampling and scatter expansion. ISOMORPHIC.
//
// The runtime, the collision builder, the navigation baker and the validators
// all need to agree on two things: how high the ground is at an arbitrary
// (x, z), and where every scattered tree/rock actually stands. Both answers
// live here, in one browser-safe module, so there is exactly one definition of
// each and no stage can drift from another.

import { rng, clamp } from "../common/rng.mjs";

const DEG = 180 / Math.PI;

/** Height at vertex (i, j), clamped to the grid. */
function hAt(t, i, j) {
  const ii = i < 0 ? 0 : i >= t.cols ? t.cols - 1 : i;
  const jj = j < 0 ? 0 : j >= t.rows ? t.rows - 1 : j;
  return t.heights[jj * t.cols + ii];
}

/**
 * Bilinear height at world (x, z). Positions outside the grid are clamped to
 * its edge rather than extrapolated, so a player who strays past the rim sees
 * the rim height instead of a NaN or a cliff to infinity.
 */
export function sampleHeight(terrain, x, z) {
  const fx = clamp(x / terrain.cell, 0, terrain.cols - 1);
  const fz = clamp(z / terrain.cell, 0, terrain.rows - 1);
  const i0 = Math.floor(fx), j0 = Math.floor(fz);
  const tx = fx - i0, tz = fz - j0;
  const a = hAt(terrain, i0, j0), b = hAt(terrain, i0 + 1, j0);
  const c = hAt(terrain, i0, j0 + 1), d = hAt(terrain, i0 + 1, j0 + 1);
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** Height gradient by central differences one cell wide. */
function gradient(terrain, x, z) {
  const e = terrain.cell * 0.5;
  const dx = (sampleHeight(terrain, x + e, z) - sampleHeight(terrain, x - e, z)) / (2 * e);
  const dz = (sampleHeight(terrain, x, z + e) - sampleHeight(terrain, x, z - e)) / (2 * e);
  return { dx, dz };
}

/** Ground slope at (x, z) in degrees (0 = flat, 90 = vertical). */
export function slopeAt(terrain, x, z) {
  const g = gradient(terrain, x, z);
  return Math.atan(Math.hypot(g.dx, g.dz)) * DEG;
}

/** Unit surface normal at (x, z), y up. */
export function normalAt(terrain, x, z) {
  const g = gradient(terrain, x, z);
  const nx = -g.dx, ny = 1, nz = -g.dz;
  const len = Math.hypot(nx, ny, nz);
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Horizontal radius a placement occupies on the ground. Solid pieces use their
 * collider; decor without one still claims a metre so foliage does not grow
 * through a signpost.
 */
export function footprintRadius(p) {
  const c = p?.collider;
  if (c?.shape === "box" && c.size) return Math.hypot(c.size.x, c.size.z) / 2;
  if (c?.shape === "cylinder" && Number.isFinite(c.radius)) return c.radius;
  return 1;
}

/** Radius around a region centre that is kept as open, flat ground. */
export function regionCoreRadius(r) {
  if (Number.isFinite(r?.pad_radius)) return r.pad_radius;
  const [x0, z0, x1, z1] = r.bounds;
  return Math.min(x1 - x0, z1 - z0) * 0.3;
}

/** Distance from (x, z) to a polyline of {x,z} points. */
export function distToPolyline(points, x, z) {
  let best = Infinity;
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k], b = points[k + 1];
    const vx = b.x - a.x, vz = b.z - a.z;
    const L2 = vx * vx + vz * vz;
    let t = L2 > 0 ? ((x - a.x) * vx + (z - a.z) * vz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(a.x + vx * t - x, a.z + vz * t - z);
    if (d < best) best = d;
  }
  return best;
}

// Tries per instance before it is dropped. Each instance draws from its own
// stream, so dropping or moving one never reshuffles the rest of the forest.
const TRIES = 10;

/**
 * Expand every `scatter` entry into concrete instances. Deterministic in the
 * world alone, which is what lets the runtime, the nav baker and the collision
 * builder each call it and get the same trees.
 *
 * Rejection rules: inside the world with a margin; not under water unless the
 * entry is `zone: "shore"`; inside optional `min_h`/`max_h` and under
 * `max_slope_deg`; clear of path corridors when `avoid_paths`; clear of every
 * non-pickup placement's footprint; and clear of every region's core pad.
 */
export function expandScatter(world) {
  const out = [];
  const t = world.terrain;
  const W = world.size.w, H = world.size.h;
  const water = world.environment?.water;
  const wl = water?.enabled ? water.level : -Infinity;
  const solids = (world.placements || []).filter((p) => p.role !== "pickup")
    .map((p) => ({ x: p.position.x, z: p.position.z, r: footprintRadius(p) }));
  const cores = (world.regions || []).map((r) => ({ x: r.center.x, z: r.center.z, r: regionCoreRadius(r) }));
  const paths = world.paths || [];
  for (const s of world.scatter || []) {
    const reg = s.region ? (world.regions || []).find((r) => r.id === s.region) : null;
    const [bx0, bz0, bx1, bz1] = reg ? reg.bounds : [0, 0, W, H];
    const margin = 1.5;
    const x0 = Math.max(bx0, margin), z0 = Math.max(bz0, margin);
    const x1 = Math.min(bx1, W - margin), z1 = Math.min(bz1, H - margin);
    const maxSlope = Number.isFinite(s.max_slope_deg) ? s.max_slope_deg : 32;
    const minH = Number.isFinite(s.min_h) ? s.min_h : -Infinity;
    const maxH = Number.isFinite(s.max_h) ? s.max_h : Infinity;
    const shore = s.zone === "shore";
    const self = Math.max(s.collider_radius || 0, 0.5);
    for (let k = 0; k < s.count; k++) {
      const r = rng(((s.seed >>> 0) + Math.imul(k + 1, 0x9e3779b1)) >>> 0);
      for (let tr = 0; tr < TRIES; tr++) {
        // Fixed draw count per try keeps the stream aligned regardless of
        // which rule rejected the previous try.
        const x = x0 + (x1 - x0) * r(), z = z0 + (z1 - z0) * r();
        const rot = r() * Math.PI * 2, sc = s.min_scale + (s.max_scale - s.min_scale) * r();
        if (x1 <= x0 || z1 <= z0) break;
        const y = sampleHeight(t, x, z);
        if (!shore && y < wl + 0.4) continue;
        if (y < minH || y > maxH) continue;
        if (slopeAt(t, x, z) > maxSlope) continue;
        if (s.avoid_paths && paths.some((p) => distToPolyline(p.points, x, z) < p.width / 2 + 1 + self)) continue;
        if (solids.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + 0.8 + self)) continue;
        if (cores.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + self)) continue;
        out.push({
          scatter_id: s.id, asset_ref: s.asset_ref,
          position: { x: r2(x), y: r2(y), z: r2(z) },
          rotation_y: r2(rot), scale: r2(sc),
          collider_radius: r2((s.collider_radius || 0) * sc),
        });
        break;
      }
    }
  }
  return out;
}

const r2 = (v) => Math.round(v * 100) / 100;
