// Games-B world: navigation grid queries. ISOMORPHIC.
//
// The world stage bakes walkability into `world.navigation.walkable`, a string
// of '1'/'0' per cell (row-major, z-major, like the heightfield). Nav cell
// (i, j) covers x ∈ [i*cell, (i+1)*cell), z ∈ [j*cell, (j+1)*cell). NPC brains,
// the headless playtest and the world validator all path over this one grid,
// so "reachable" means the same thing everywhere.

const SQRT2 = Math.SQRT2;

/** Cell index for world (x, z), or -1 outside the grid. */
export function navIndex(nav, x, z) {
  const i = Math.floor(x / nav.cell), j = Math.floor(z / nav.cell);
  if (i < 0 || j < 0 || i >= nav.cols || j >= nav.rows) return -1;
  return j * nav.cols + i;
}

const cellWalk = (nav, idx) => idx >= 0 && nav.walkable.charCodeAt(idx) === 49; // '1'

export function isWalkable(nav, x, z) {
  return cellWalk(nav, navIndex(nav, x, z));
}

/** World-space centre of a cell index. */
export function cellCenter(nav, idx) {
  const i = idx % nav.cols, j = (idx - i) / nav.cols;
  return { x: (i + 0.5) * nav.cell, z: (j + 0.5) * nav.cell };
}

/**
 * Nearest walkable cell to (x, z) within maxDist metres (ring search), as its
 * index, or -1. Optional `accept(idx)` narrows the choice (e.g. "reachable").
 */
export function nearestWalkable(nav, x, z, maxDist = nav.cell * 2, accept) {
  const ci = Math.floor(x / nav.cell), cj = Math.floor(z / nav.cell);
  const R = Math.ceil(maxDist / nav.cell);
  let best = -1, bestD = Infinity;
  for (let j = cj - R; j <= cj + R; j++) {
    if (j < 0 || j >= nav.rows) continue;
    for (let i = ci - R; i <= ci + R; i++) {
      if (i < 0 || i >= nav.cols) continue;
      const idx = j * nav.cols + i;
      if (!cellWalk(nav, idx) || (accept && !accept(idx))) continue;
      const d = Math.hypot((i + 0.5) * nav.cell - x, (j + 0.5) * nav.cell - z);
      if (d <= maxDist && d < bestD) { bestD = d; best = idx; }
    }
  }
  return best;
}

// 8-neighbourhood as [di, dj, cost].
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2]];

/**
 * Walk the 8-neighbours of `idx` that can be entered. A diagonal step is only
 * allowed when both orthogonal cells it squeezes between are walkable, so a
 * path never cuts the corner of a wall.
 */
function forNeighbours(nav, idx, fn) {
  const cols = nav.cols, i = idx % cols, j = (idx - i) / cols;
  for (const [di, dj, cost] of NB) {
    const ni = i + di, nj = j + dj;
    if (ni < 0 || nj < 0 || ni >= cols || nj >= nav.rows) continue;
    const n = nj * cols + ni;
    if (!cellWalk(nav, n)) continue;
    if (di && dj && (!cellWalk(nav, j * cols + ni) || !cellWalk(nav, nj * cols + i))) continue;
    fn(n, cost);
  }
}

/** Binary min-heap keyed by a Float64Array of scores. */
class Heap {
  constructor(score) { this.a = []; this.s = score; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a, s = this.s; a.push(v);
    let k = a.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (s[a[p]] <= s[a[k]]) break; [a[p], a[k]] = [a[k], a[p]]; k = p; }
  }
  pop() {
    const a = this.a, s = this.s, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < a.length && s[a[l]] < s[a[m]]) m = l;
        if (r < a.length && s[a[r]] < s[a[m]]) m = r;
        if (m === k) break;
        [a[m], a[k]] = [a[k], a[m]]; k = m;
      }
    }
    return top;
  }
}

/**
 * True when the straight segment a→b only crosses walkable cells. A supercover
 * traversal visits every cell the segment touches, and a segment through an
 * exact cell corner must have both side cells walkable — the same no
 * corner-cutting rule as the A* expansion.
 */
export function segmentWalkable(nav, a, b) {
  const c = nav.cell;
  let i = Math.floor(a.x / c), j = Math.floor(a.z / c);
  const ie = Math.floor(b.x / c), je = Math.floor(b.z / c);
  const dx = b.x - a.x, dz = b.z - a.z;
  const si = Math.sign(dx), sj = Math.sign(dz);
  const tdx = si ? Math.abs(c / dx) : Infinity, tdz = sj ? Math.abs(c / dz) : Infinity;
  let tmx = si ? ((si > 0 ? (i + 1) * c : i * c) - a.x) / dx : Infinity;
  let tmz = sj ? ((sj > 0 ? (j + 1) * c : j * c) - a.z) / dz : Infinity;
  const ok = (ii, jj) => ii >= 0 && jj >= 0 && ii < nav.cols && jj < nav.rows && cellWalk(nav, jj * nav.cols + ii);
  if (!ok(i, j)) return false;
  let guard = nav.cols + nav.rows + 4;
  while ((i !== ie || j !== je) && guard-- > 0) {
    if (Math.abs(tmx - tmz) < 1e-9) {
      if (!ok(i + si, j) || !ok(i, j + sj)) return false;
      i += si; j += sj; tmx += tdx; tmz += tdz;
    } else if (tmx < tmz) { i += si; tmx += tdx; } else { j += sj; tmz += tdz; }
    if (!ok(i, j)) return false;
  }
  return true;
}

/**
 * 8-connected A* from `from` to `to` (world {x,z}). Endpoints that land on a
 * blocked cell snap to the nearest walkable cell within two cells, because a
 * character standing against a wall is often a hair inside the padded border.
 * Returns simplified world-space waypoints, or null when unreachable.
 */
export function findPath(nav, from, to) {
  const s0 = navIndex(nav, from.x, from.z), g0 = navIndex(nav, to.x, to.z);
  const s = cellWalk(nav, s0) ? s0 : nearestWalkable(nav, from.x, from.z, nav.cell * 2);
  const g = cellWalk(nav, g0) ? g0 : nearestWalkable(nav, to.x, to.z, nav.cell * 2);
  if (s < 0 || g < 0) return null;
  const N = nav.cols * nav.rows;
  const gScore = new Float64Array(N).fill(Infinity);
  const fScore = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const gi = g % nav.cols, gj = (g - gi) / nav.cols;
  const hFn = (idx) => {
    const i = idx % nav.cols, j = (idx - i) / nav.cols;
    const dx = Math.abs(i - gi), dz = Math.abs(j - gj);
    return (dx + dz) + (SQRT2 - 2) * Math.min(dx, dz);
  };
  gScore[s] = 0; fScore[s] = hFn(s);
  const open = new Heap(fScore); open.push(s);
  let found = false;
  while (open.size) {
    const cur = open.pop();
    if (closed[cur]) continue;
    if (cur === g) { found = true; break; }
    closed[cur] = 1;
    forNeighbours(nav, cur, (n, cost) => {
      if (closed[n]) return;
      const t = gScore[cur] + cost;
      if (t < gScore[n]) { gScore[n] = t; came[n] = cur; fScore[n] = t + hFn(n); open.push(n); }
    });
  }
  if (!found) return null;
  const cells = [];
  for (let c = g; c !== -1; c = came[c]) cells.push(c);
  cells.reverse();
  const pts = cells.map((c) => cellCenter(nav, c));
  if (s === s0) pts[0] = { x: from.x, z: from.z };
  if (g === g0 && pts.length > 1) pts[pts.length - 1] = { x: to.x, z: to.z };
  else if (g === g0) pts.push({ x: to.x, z: to.z });
  return simplify(nav, pts);
}

/** Drop waypoints while the shortcut stays on walkable cells (string pulling). */
function simplify(nav, pts) {
  if (pts.length <= 2) return pts.map(round);
  const out = [pts[0]];
  let k = 0;
  while (k < pts.length - 1) {
    // Extend the shortcut until it first fails: linear in path length for
    // the common case, where a full backwards search would be quadratic.
    let far = k + 1;
    while (far + 1 < pts.length && segmentWalkable(nav, pts[k], pts[far + 1])) far++;
    out.push(pts[far]);
    k = far;
  }
  return out.map(round);
}

const round = (p) => ({ x: Math.round(p.x * 1000) / 1000, z: Math.round(p.z * 1000) / 1000 });

/**
 * Every cell index reachable from `from` over the same 8-connectivity A* uses
 * (flood fill). Returns a Set of indices; empty when `from` is blocked.
 */
export function reachableSet(nav, from) {
  const out = new Set();
  let s = navIndex(nav, from.x, from.z);
  if (!cellWalk(nav, s)) s = nearestWalkable(nav, from.x, from.z, nav.cell * 2);
  if (s < 0) return out;
  const stack = [s]; out.add(s);
  while (stack.length) {
    forNeighbours(nav, stack.pop(), (n) => { if (!out.has(n)) { out.add(n); stack.push(n); } });
  }
  return out;
}
