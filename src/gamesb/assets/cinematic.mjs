// Games-B intro cinematic: a camera path (`cine:intro`, format "camera-path")
// that opens wide over the start hub, sweeps past each landmark, and lands
// behind the player's shoulder at spawn so the hand-off to gameplay has no cut.
// Isomorphic-clean. It samples terrain height itself (bilinear, same indexing
// as §2) rather than importing the world module, so the asset stage has no
// dependency on another stage's code.

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function groundAt(terrain, x, z) {
  if (!terrain?.heights?.length || !terrain.cols || !terrain.rows) return 0;
  const { cols, rows, cell = 1, heights } = terrain;
  const fx = clamp(x / cell, 0, cols - 1), fz = clamp(z / cell, 0, rows - 1);
  const i = Math.min(cols - 2, Math.floor(fx)), j = Math.min(rows - 2, Math.floor(fz));
  const tx = fx - i, tz = fz - j;
  const h = (ii, jj) => heights[jj * cols + ii] ?? 0;
  if (cols < 2 || rows < 2) return heights[0] ?? 0;
  return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz;
}

const centerOf = (r) => r.center && Number.isFinite(r.center.x)
  ? r.center
  : { x: (r.bounds[0] + r.bounds[2]) / 2, y: 0, z: (r.bounds[1] + r.bounds[3]) / 2 };
const radiusOf = (r) => Array.isArray(r.bounds) ? Math.max(r.bounds[2] - r.bounds[0], r.bounds[3] - r.bounds[1]) / 2 : 20;

/**
 * @returns camera-path payload:
 *   { duration_s, skippable, points: [{ t_s, position, look_at, duration_s, ease, label, region_ref }], end }
 */
export function buildIntroCinematic(world, { maxLandmarks = 5 } = {}) {
  const W = world?.size?.w || 200, D = world?.size?.h || 200;
  const terrain = world?.terrain;
  const regions = Array.isArray(world?.regions) ? world.regions : [];
  const spawn = (world?.spawn_points || []).find((s) => s.kind === "player") || null;

  const inRegion = (r, p) => p && Array.isArray(r.bounds) && p.x >= r.bounds[0] && p.x <= r.bounds[2] && p.z >= r.bounds[1] && p.z <= r.bounds[3];
  const hub = regions.find((r) => spawn && (r.id === spawn.region || inRegion(r, spawn.position))) || regions[0] || null;
  const hubC = hub ? centerOf(hub) : { x: W / 2, y: 0, z: D / 2 };

  // Landmarks first, then any other named location, visited nearest-first.
  const rank = (r) => (r.kind === "landmark" ? 0 : r.location_ref ? 1 : 2);
  let pool = regions.filter((r) => r !== hub && rank(r) < 2);
  if (!pool.length) pool = regions.filter((r) => r !== hub);
  const tour = [];
  let at = hubC;
  while (pool.length && tour.length < maxLandmarks) {
    pool.sort((a, b) => rank(a) - rank(b) || Math.hypot(centerOf(a).x - at.x, centerOf(a).z - at.z) - Math.hypot(centerOf(b).x - at.x, centerOf(b).z - at.z) || String(a.id).localeCompare(String(b.id)));
    const next = pool.shift();
    tour.push(next); at = centerOf(next);
  }

  const inside = (p) => ({ x: clamp(p.x, 2, W - 2), z: clamp(p.z, 2, D - 2) });
  const peak = Number.isFinite(terrain?.max_y) ? terrain.max_y : 20;
  const points = [];
  const push = (pos, look, dur, label, ref, ease = "inOutSine") => {
    const p = inside(pos);
    points.push({ position: { x: r2(p.x), y: r2(pos.y), z: r2(p.z) }, look_at: { x: r2(look.x), y: r2(look.y), z: r2(look.z) }, duration_s: dur, ease, label, region_ref: ref });
  };

  // 1. Establishing shot: high, from the world centre side of the hub.
  const toCentre = Math.atan2(W / 2 - hubC.x, D / 2 - hubC.z);
  const openDist = Math.max(50, Math.min(W, D) * 0.35);
  push({ x: hubC.x - Math.sin(toCentre) * openDist * 0.3 + Math.cos(toCentre) * openDist * 0.2, y: peak + 45, z: hubC.z - Math.cos(toCentre) * openDist * 0.3 - Math.sin(toCentre) * openDist * 0.2 },
    { x: hubC.x, y: groundAt(terrain, hubC.x, hubC.z) + 2, z: hubC.z }, 4, hub?.name || "Start", hub?.id || null, "outSine");

  // 2. Each landmark: approach along the travel direction, offset to one side
  //    so the subject is framed rather than flown through.
  let prev = hubC;
  tour.forEach((r, i) => {
    const c = centerOf(r);
    const dir = Math.atan2(c.x - prev.x, c.z - prev.z);
    const d = clamp(radiusOf(r) * 1.3, 22, 60);
    const side = i % 2 ? 1 : -1;
    const cam = { x: c.x - Math.sin(dir) * d + Math.cos(dir) * side * d * 0.45, z: c.z - Math.cos(dir) * d - Math.sin(dir) * side * d * 0.45 };
    const g = Math.max(groundAt(terrain, cam.x, cam.z), groundAt(terrain, c.x, c.z), Number.isFinite(c.y) ? c.y : 0);
    push({ ...cam, y: g + 16 + (i % 2) * 6 }, { x: c.x, y: groundAt(terrain, c.x, c.z) + 4, z: c.z }, 3.5, r.name || r.id, r.id);
    prev = c;
  });

  // 3. Land behind the player's shoulder, matching the gameplay camera.
  const cam = world?.camera || {};
  const sp = spawn?.position || { x: hubC.x, y: groundAt(terrain, hubC.x, hubC.z), z: hubC.z };
  const yaw = Number.isFinite(spawn?.rotation_y) ? spawn.rotation_y : 0;
  const dist = Number.isFinite(cam.distance) ? cam.distance : 6, hgt = Number.isFinite(cam.height) ? cam.height : 2.5;
  push({ x: sp.x - Math.sin(yaw) * dist, y: (sp.y ?? 0) + hgt, z: sp.z - Math.cos(yaw) * dist }, { x: sp.x + Math.sin(yaw) * 4, y: (sp.y ?? 0) + 1.6, z: sp.z + Math.cos(yaw) * 4 }, 3, "Begin", spawn?.id || null, "inOutCubic");

  // Keep every shot clear of terrain along its incoming leg.
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1].position, b = points[i].position;
    let need = 0;
    for (let k = 1; k <= 6; k++) {
      const t = k / 6, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
      need = Math.max(need, groundAt(terrain, x, z) + 10 - y);
    }
    if (need > 0) b.y = r2(b.y + need);
  }

  // t_s: when the camera reaches the point. duration_s: time from this point
  // to the next (for the last point, the settle before control hands over).
  let t = 0;
  for (const p of points) { p.t_s = r2(t); t += p.duration_s; }
  return { duration_s: r2(t), skippable: true, points, end: { mode: "handoff", spawn_ref: spawn?.id || null } };
}
