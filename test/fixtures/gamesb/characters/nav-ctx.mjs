// Test-only stand-ins for world/nav-grid.mjs and world/terrain-sample.mjs, so
// the character tests do not depend on another agent's in-progress modules.
// Same indexing as CONTRACT §2: cell (i,j) covers x∈[i*cell,(i+1)*cell), z likewise.

export function isBlockedNav(nav, x, z) {
  const i = Math.floor(x / nav.cell), j = Math.floor(z / nav.cell);
  if (i < 0 || j < 0 || i >= nav.cols || j >= nav.rows) return true;
  return nav.walkable[j * nav.cols + i] !== "1";
}

export function heightAtTerrain(t, x, z) {
  const fx = Math.max(0, Math.min(t.cols - 1.0001, x / t.cell)), fz = Math.max(0, Math.min(t.rows - 1.0001, z / t.cell));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const h = (a, b) => t.heights[b * t.cols + a];
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}

/** 8-connected A* over walkable cells, no corner cutting; returns cell centres, or null. */
export function findPathNav(nav, from, to) {
  const c = nav.cell, W = nav.cols, H = nav.rows;
  const si = Math.floor(from.x / c), sj = Math.floor(from.z / c), gi = Math.floor(to.x / c), gj = Math.floor(to.z / c);
  const ok = (i, j) => i >= 0 && j >= 0 && i < W && j < H && nav.walkable[j * W + i] === "1";
  if (!ok(gi, gj)) return null;
  const start = sj * W + si, goal = gj * W + gi;
  const g = new Map([[start, 0]]), came = new Map(), open = [[0, start]], closed = new Set();
  const hf = (k) => { const i = k % W, j = (k - i) / W; const dx = Math.abs(i - gi), dz = Math.abs(j - gj); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
  while (open.length) {
    let bi = 0; for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === goal) {
      const out = []; let k = cur;
      while (k !== undefined) { const i = k % W, j = (k - i) / W; out.push({ x: (i + 0.5) * c, z: (j + 0.5) * c }); k = came.get(k); }
      return out.reverse();
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const ci = cur % W, cj = (cur - ci) / W;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (!ok(ni, nj)) continue;
      if (di && dj && (!ok(ci + di, cj) || !ok(ci, cj + dj))) continue;
      const nk = nj * W + ni, ng = g.get(cur) + (di && dj ? 1.414 : 1);
      if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); came.set(nk, cur); open.push([ng + hf(nk), nk]); }
    }
  }
  return null;
}

/** A brain ctx over a fixture world. `rand` is supplied by the caller (seeded). */
export function makeCtx(world, player, rand, extra = {}) {
  return {
    player,
    heightAt: (x, z) => heightAtTerrain(world.terrain, x, z),
    isBlocked: (x, z) => isBlockedNav(world.navigation, x, z),
    findPath: (a, b) => findPathNav(world.navigation, a, b),
    rand,
    ...extra,
  };
}
