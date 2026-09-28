// Games-B world stage: navigation grid, collision and terrain sampling.
import test from "node:test";
import assert from "node:assert/strict";
import { findPath, reachableSet, isWalkable, navIndex, segmentWalkable, resolveCapsule, pointInCollider, buildColliders,
  sampleHeight, slopeAt, normalAt, generateWorldSpec } from "../src/gamesb/world/index.mjs";

/** Build a nav grid from ASCII rows ('#' blocked, '.' open), 1 m cells. */
function gridNav(rows, cell = 1) {
  return { cell, cols: rows[0].length, rows: rows.length, max_slope_deg: 38, step_height: 0.45, walkable: rows.join("").replace(/#/g, "0").replace(/\./g, "1") };
}

function assertWalkablePolyline(nav, pts) {
  for (let q = 0; q + 1 < pts.length; q++) {
    const a = pts[q], b = pts[q + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (nav.cell / 8)));
    for (let s = 0; s <= n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n, z = a.z + ((b.z - a.z) * s) / n;
      assert.ok(isWalkable(nav, x, z), `(${x.toFixed(2)}, ${z.toFixed(2)}) is blocked`);
    }
  }
}

test("navIndex / isWalkable index row-major, z-major and reject out-of-grid points", () => {
  const nav = gridNav(["..#", "#.."]);
  assert.equal(navIndex(nav, 0.5, 0.5), 0);
  assert.equal(navIndex(nav, 2.5, 0.5), 2);
  assert.equal(navIndex(nav, 0.5, 1.5), 3);
  assert.equal(navIndex(nav, -0.1, 0.5), -1);
  assert.equal(navIndex(nav, 3.1, 0.5), -1);
  assert.equal(isWalkable(nav, 2.5, 0.5), false);
  assert.equal(isWalkable(nav, 1.5, 1.5), true);
});

test("findPath routes around a wall and every segment stays on walkable cells", () => {
  const nav = gridNav([
    "..........",
    "..........",
    "#######...",
    "..........",
    "...#######",
    "..........",
  ]);
  const p = findPath(nav, { x: 0.5, z: 0.5 }, { x: 0.5, z: 5.5 });
  assert.ok(p, "a route exists");
  assert.deepEqual(p[0], { x: 0.5, z: 0.5 });
  assert.deepEqual(p[p.length - 1], { x: 0.5, z: 5.5 });
  assertWalkablePolyline(nav, p);
  assert.ok(p.length <= 6, `simplified to ${p.length} points`);
});

test("findPath never cuts a blocked diagonal corner", () => {
  // The only diagonal link between the two open cells squeezes between two
  // blocked cells; that is not a passage.
  const nav = gridNav([
    ".#",
    "#.",
  ]);
  assert.equal(findPath(nav, { x: 0.5, z: 0.5 }, { x: 1.5, z: 1.5 }), null);
  assert.equal(reachableSet(nav, { x: 0.5, z: 0.5 }).size, 1);
  // Line of sight through the exact corner is refused too.
  assert.equal(segmentWalkable(nav, { x: 0.5, z: 0.5 }, { x: 1.5, z: 1.5 }), false);
  // With one side open, the diagonal is allowed.
  const open = gridNav(["..", "#."]);
  const p = findPath(open, { x: 0.5, z: 0.5 }, { x: 1.5, z: 1.5 });
  assert.ok(p);
  assertWalkablePolyline(open, p);
});

test("findPath returns null for a sealed room and snaps endpoints that sit on a blocked cell", () => {
  const nav = gridNav([
    ".....",
    ".###.",
    ".#.#.",
    ".###.",
    ".....",
  ]);
  assert.equal(findPath(nav, { x: 0.5, z: 0.5 }, { x: 2.5, z: 2.5 }), null);
  const snapped = findPath(nav, { x: 0.5, z: 0.5 }, { x: 1.5, z: 1.5 }); // goal on a wall cell next to open ground
  assert.ok(snapped);
  assertWalkablePolyline(nav, snapped);
  const r = reachableSet(nav, { x: 0.5, z: 0.5 });
  assert.equal(r.size, 16);
  assert.ok(!r.has(navIndex(nav, 2.5, 2.5)));
});

test("findPath on a generated world is walkable end to end", () => {
  const w = generateWorldSpec({ title: "Nav probe", biome: "forest", scale: "small", key_locations: [
    { id: "a", name: "A", kind: "hub" }, { id: "b", name: "B", kind: "ruin" }, { id: "c", name: "C", kind: "camp" }] }, { seed: 5 });
  const nav = w.navigation;
  const from = w.spawn_points.find((s) => s.id === "spawn_player").position;
  for (const r of w.regions.slice(1)) {
    const p = findPath(nav, from, r.center);
    assert.ok(p, r.id);
    assertWalkablePolyline(nav, p);
  }
});

// ---------------------------------------------------------------- collision

test("cylinder push-out: a capsule overlapping a cylinder is pushed to exactly r1 + r2", () => {
  const cols = [{ id: "c", shape: "cylinder", center: { x: 10, y: 1, z: 10 }, radius: 1, height: 2, rotation_y: 0, solid: true, ref: "c" }];
  const r = resolveCapsule(cols, { x: 10.5, y: 0, z: 10 }, 0.5, 1.8);
  assert.equal(r.hit, true);
  assert.ok(Math.abs(Math.hypot(r.x - 10, r.z - 10) - 1.5) < 1e-3, `distance ${Math.hypot(r.x - 10, r.z - 10)}`);
  assert.ok(Math.abs(r.z - 10) < 1e-9, "pushed straight out along +x");
  const miss = resolveCapsule(cols, { x: 12, y: 0, z: 10 }, 0.5, 1.8);
  assert.deepEqual(miss, { x: 12, z: 10, hit: false });
  // Standing above the top: no sideways shove.
  assert.equal(resolveCapsule(cols, { x: 10.5, y: 2.5, z: 10 }, 0.5, 1.8).hit, false);
});

test("rotated box push-out respects the box orientation", () => {
  // A 4 × 1 wall rotated 90°: its long axis now runs along z.
  const wall = { id: "w", shape: "box", center: { x: 0, y: 1, z: 0 }, half: { x: 2, y: 1, z: 0.5 }, rotation_y: Math.PI / 2, solid: true, ref: "w" };
  // (0.9, 0, 1.5) would be outside the unrotated wall, but is inside the
  // rotated one's reach (|x| < 0.5 + 0.5 radius).
  const r = resolveCapsule([wall], { x: 0.9, y: 0, z: 1.5 }, 0.5, 1.8);
  assert.equal(r.hit, true);
  assert.ok(Math.abs(r.x - 1.0) < 1e-3 && Math.abs(r.z - 1.5) < 1e-3, `got ${r.x}, ${r.z}`);
  // Deep inside: leaves by the nearest face (the thin one, along x).
  const deep = resolveCapsule([wall], { x: 0.1, y: 0, z: 0.2 }, 0.4, 1.8);
  assert.ok(Math.abs(deep.x - 0.9) < 1e-3 && Math.abs(deep.z - 0.2) < 1e-3, `got ${deep.x}, ${deep.z}`);
  // Point test agrees with the rotation.
  assert.ok(pointInCollider([wall], 0, 1.8));
  assert.equal(pointInCollider([wall], 1.8, 0), null);
  assert.ok(pointInCollider([wall], 0.7, 0, 0.3), "pad grows the box");
  // 45°: the corner region.
  const diag = { ...wall, rotation_y: Math.PI / 4 };
  const out = resolveCapsule([diag], { x: 0.3, y: 0, z: 0.3 }, 0.3, 1.8);
  assert.ok(out.hit);
  assert.equal(pointInCollider([diag], out.x, out.z, 0.29), null, "pushed fully clear");
});

test("resolveCapsule settles a capsule wedged between two colliders", () => {
  const a = { id: "a", shape: "cylinder", center: { x: 0, y: 1, z: 0 }, radius: 1, height: 2, solid: true, ref: "a" };
  const b = { id: "b", shape: "cylinder", center: { x: 2.6, y: 1, z: 0 }, radius: 1, height: 2, solid: true, ref: "b" };
  const r = resolveCapsule([a, b], { x: 1.3, y: 0, z: 0.1 }, 0.4, 1.8);
  assert.ok(r.hit);
  assert.equal(pointInCollider([a, b], r.x, r.z, 0.39), null);
});

test("buildColliders covers solid placements and collidable scatter, skipping non-solids", () => {
  const w = generateWorldSpec({ title: "Colliders", biome: "forest", scale: "small", key_locations: [{ id: "h", name: "H", kind: "hub" }, { id: "d", name: "D", kind: "dock" }] }, { seed: 11 });
  const cols = buildColliders(w);
  const solidPl = w.placements.filter((p) => p.collider.solid && p.collider.shape !== "none");
  for (const p of solidPl) assert.ok(cols.some((c) => c.ref === p.id), p.id);
  for (const p of w.placements.filter((x) => !x.collider.solid)) assert.ok(!cols.some((c) => c.ref === p.id), p.id);
  assert.ok(cols.some((c) => c.ref.startsWith("sc_")), "trees collide");
  for (const c of cols) assert.ok(c.solid && (c.shape === "box" ? c.half.x > 0 : c.radius > 0));
});

// ---------------------------------------------------------------- terrain sampling

test("sampleHeight is bilinear and clamped; slopeAt and normalAt agree with a plane", () => {
  // Plane h = 0.5 x on a 3 × 3 grid, 2 m cells.
  const t = { cell: 2, cols: 3, rows: 3, heights: [0, 1, 2, 0, 1, 2, 0, 1, 2] };
  assert.equal(sampleHeight(t, 1, 1), 0.5);
  assert.equal(sampleHeight(t, 3, 3.3), 1.5);
  assert.equal(sampleHeight(t, -10, 0), 0, "clamped at the low edge");
  assert.equal(sampleHeight(t, 99, 99), 2, "clamped at the high edge");
  const slope = slopeAt(t, 2, 2);
  assert.ok(Math.abs(slope - (Math.atan(0.5) * 180) / Math.PI) < 1e-9);
  const n = normalAt(t, 2, 2);
  assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-12);
  assert.ok(n.x < 0 && n.y > 0 && Math.abs(n.z) < 1e-12, "normal leans away from the uphill side");
});
