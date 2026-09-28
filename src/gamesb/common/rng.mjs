// Games-B shared deterministic randomness. ISOMORPHIC: runs in Node and in the
// browser runtime, so it must never import a node: module.
//
// Same mulberry32 / FNV-1a pair as src/v3/providers/local-planner.mjs, copied
// rather than imported because that module is Node-side and the Games-B runtime
// loads this file straight into the browser.

/** mulberry32: returns a function yielding floats in [0,1). */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string. */
export function hashString(s) {
  const str = String(s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded helpers bundled together, so callers do not re-implement ranges. */
export function seeded(seed) {
  const r = rng(seed);
  return {
    next: r,
    range: (lo, hi) => lo + (hi - lo) * r(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * r()),
    pick: (arr) => arr[Math.floor(r() * arr.length)],
    chance: (p) => r() < p,
  };
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const round2 = (v) => Math.round(v * 100) / 100;
