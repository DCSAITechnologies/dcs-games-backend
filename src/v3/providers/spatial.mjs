// B1 — spatial lane: terrain, physics and navigation.
//
// Provider-neutral by construction. No spatial/world-generation vendor is
// configured on this estate, so the working implementation is local and
// deterministic; the seam below lets one drop in without any caller changing.
//
// The terrain is a real heightmap grown from layered value noise with roads
// flattened into it and building pads levelled, plus a navigation graph derived
// from the same data. That is what makes "walk from the spawn to the quest NPC"
// a question the B4 validator can actually answer.
import { STATUS, LANES, ProviderError, offline } from "./contract.mjs";
import { rng, hashString } from "./local-planner.mjs";

/** External spatial provider seam. Set DCS_SPATIAL_URL + DCS_SPATIAL_KEY to use one. */
export function externalSpatialAdapter(env = process.env) {
  const base = (env.DCS_SPATIAL_URL || "").replace(/\/$/, "");
  const key = env.DCS_SPATIAL_KEY || "";
  return {
    name: env.DCS_SPATIAL_NAME || "external-spatial",
    lane: LANES.SPATIAL,
    rank: 10,
    isFallback: false,
    async status() {
      if (offline(env)) return STATUS.UNAVAILABLE;
      return base && key ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
    },
    async invoke(req) {
      const r = await fetch(base + "/terrain", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ seed: req.seed, size: req.size, zones: req.zones, style: req.style }),
        signal: AbortSignal.timeout(180000),
      }).catch((e) => { throw new ProviderError("external-spatial", String(e?.message || e)); });
      if (!r.ok) throw new ProviderError("external-spatial", `HTTP ${r.status}`, { status: r.status });
      const j = await r.json();
      if (!j?.terrain?.data) throw new ProviderError("external-spatial", "response carried no terrain data");
      return { terrain: j.terrain, navigation: j.navigation || { walkable_zones: [], links: [], navmesh_ref: null }, physics: j.physics || {}, spawn_hint: j.spawn_hint || null, _model: j.model || "external-spatial" };
    },
  };
}

// ------------------------------------------------------------- local terrain

const RES = 2;                    // metres per heightmap cell
const MAX_CELLS = 200;            // cap the grid so a huge world stays a sane payload

function valueNoise2D(seed) {
  const r = rng(seed);
  const table = new Float32Array(256 * 256);
  for (let i = 0; i < table.length; i++) table[i] = r();
  const at = (x, y) => table[((y & 255) << 8) | (x & 255)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/**
 * Build a heightmap, flatten the roads and building pads into it, and derive a
 * navigation graph. Everything is deterministic in `seed`.
 */
export function generateTerrainLocally(req = {}) {
  // Belt and braces at the fallback itself. `Math.round("large")` is NaN and
  // `Math.max(64, NaN)` is NaN, which reached `new Array(NaN)` as a RangeError —
  // thrown by the one adapter in this lane that has nothing behind it.
  const dim = (v, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.max(64, n) : d;
  };
  const size = { w: dim(req.size?.w, 260), h: dim(req.size?.h, 260) };
  const seed = req.seed ?? hashString(JSON.stringify(size));
  const noise = valueNoise2D(seed);

  const cols = Math.min(MAX_CELLS, Math.ceil(size.w / RES));
  const rows = Math.min(MAX_CELLS, Math.ceil(size.h / RES));
  const cellW = size.w / cols, cellH = size.h / rows;

  // Layered noise: broad landform, then medium relief, then fine detail.
  const relief = req.style === "scifi" || req.style === "city" ? 3.5 : 9;
  const data = [];
  for (let j = 0; j < rows; j++) {
    const row = new Array(cols);
    for (let i = 0; i < cols; i++) {
      const x = i / cols, y = j / rows;
      let hgt = 0;
      hgt += noise(x * 3, y * 3) * 1.0;
      hgt += noise(x * 7, y * 7) * 0.45;
      hgt += noise(x * 17, y * 17) * 0.18;
      hgt = (hgt / 1.63 - 0.5) * relief;
      row[i] = Number(hgt.toFixed(2));
    }
    data.push(row);
  }

  const toCell = (x, z) => [clampI(Math.round(x / cellW), 0, cols - 1), clampI(Math.round(z / cellH), 0, rows - 1)];
  const flatten = (cx, cz, radius, target) => {
    const rx = Math.max(1, Math.round(radius / cellW)), rz = Math.max(1, Math.round(radius / cellH));
    for (let j = cz - rz; j <= cz + rz; j++) {
      for (let i = cx - rx; i <= cx + rx; i++) {
        if (j < 0 || j >= rows || i < 0 || i >= cols) continue;
        const d = Math.hypot((i - cx) / rx, (j - cz) / rz);
        if (d > 1) continue;
        const blend = 1 - d * d;
        data[j][i] = Number((data[j][i] * (1 - blend) + target * blend).toFixed(2));
      }
    }
  };

  // Roads: level a corridor so a player can actually walk the district spine.
  for (const road of req.roads || []) {
    const steps = 40;
    const [sx, sz] = [num(road.from?.x), num(road.from?.z)];
    const [ex, ez] = [num(road.to?.x), num(road.to?.z)];
    const [c0x, c0z] = toCell(sx, sz);
    const target = data[c0z][c0x];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const [cx, cz] = toCell(sx + (ex - sx) * t, sz + (ez - sz) * t);
      flatten(cx, cz, (road.width || 6) / 2 + 1, target);
    }
  }

  // Building pads: level the ground under each structure so nothing floats.
  const pads = [];
  for (const s of req.structures || []) {
    const [cx, cz] = toCell(num(s.position?.x), num(s.position?.z));
    const ground = data[cz][cx];
    flatten(cx, cz, Math.max(num(s.footprint?.w, 8), num(s.footprint?.d, 8)) / 2 + 2, ground);
    pads.push({ id: s.id, ground_y: ground });
  }

  const heightAt = (x, z) => {
    const [cx, cz] = toCell(x, z);
    return data[cz][cx];
  };

  // ---- navigation: zone graph plus a walkability sample per zone ----------
  const zones = req.zones || [];
  const walkable = zones.map((z) => {
    const [x0, z0, x1, z1] = z.bounds;
    let walkableSamples = 0, total = 0, sumY = 0;
    for (let sx = x0 + 2; sx < x1 - 2; sx += Math.max(4, (x1 - x0) / 12)) {
      for (let sz = z0 + 2; sz < z1 - 2; sz += Math.max(4, (z1 - z0) / 12)) {
        total++;
        const y = heightAt(sx, sz);
        // A cell is walkable when the local slope is gentle enough to climb.
        const slope = Math.max(
          Math.abs(y - heightAt(Math.min(sx + 4, x1 - 1), sz)),
          Math.abs(y - heightAt(sx, Math.min(sz + 4, z1 - 1)))
        );
        if (slope < 2.2) { walkableSamples++; sumY += y; }
      }
    }
    return {
      zone: z.id,
      walkable_fraction: total ? Number((walkableSamples / total).toFixed(3)) : 0,
      mean_ground_y: total && walkableSamples ? Number((sumY / walkableSamples).toFixed(2)) : 0,
    };
  });

  // Link adjacent or overlapping zones so cross-district travel is expressible.
  const links = [];
  for (let a = 0; a < zones.length; a++) {
    for (let b = a + 1; b < zones.length; b++) {
      const A = zones[a].bounds, B = zones[b].bounds;
      const gapX = Math.max(0, Math.max(A[0], B[0]) - Math.min(A[2], B[2]));
      const gapZ = Math.max(0, Math.max(A[1], B[1]) - Math.min(A[3], B[3]));
      if (gapX <= 14 && gapZ <= 14) {
        links.push({ from: zones[a].id, to: zones[b].id, kind: gapX === 0 && gapZ === 0 ? "adjacent" : "path", cost: Number((gapX + gapZ + 1).toFixed(1)) });
      }
    }
  }

  // Spawn on the flattest walkable spot in the first zone.
  let spawn_hint = null;
  if (zones.length) {
    const [x0, z0, x1, z1] = zones[0].bounds;
    let best = null;
    for (let sx = x0 + 4; sx < x1 - 4; sx += Math.max(4, (x1 - x0) / 10)) {
      for (let sz = z0 + 4; sz < z1 - 4; sz += Math.max(4, (z1 - z0) / 10)) {
        const y = heightAt(sx, sz);
        const slope = Math.abs(y - heightAt(sx + 3, sz)) + Math.abs(y - heightAt(sx, sz + 3));
        // Keep clear of buildings so the player never spawns inside geometry.
        const clash = (req.structures || []).some((s) => Math.hypot(num(s.position?.x) - sx, num(s.position?.z) - sz) < Math.max(num(s.footprint?.w, 8), num(s.footprint?.d, 8)) * 0.8);
        if (clash) continue;
        if (!best || slope < best.slope) best = { x: sx, y, z: sz, slope };
      }
    }
    if (best) spawn_hint = { x: Number(best.x.toFixed(2)), y: Number(best.y.toFixed(2)), z: Number(best.z.toFixed(2)) };
  }

  return {
    terrain: {
      kind: "heightmap",
      size,
      resolution: { cols, rows, cell_w: Number(cellW.toFixed(3)), cell_h: Number(cellH.toFixed(3)) },
      data,
      materials: [{ id: "ground", roughness: 0.9, tint: req.palette?.ground || null }],
      pads,
    },
    navigation: {
      navmesh_ref: null,
      walkable_zones: walkable,
      links,
      method: "heightmap-slope-sampling",
    },
    physics: { engine_hint: "browser-builtin", gravity: -9.81, ground_friction: 0.82 },
    spawn_hint,
    _model: "deterministic",
  };
}

const num = (v, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);
const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));

export function localSpatialAdapter() {
  return {
    name: "local:heightmap-generator",
    lane: LANES.SPATIAL,
    rank: 99,
    isFallback: true,
    model: "deterministic",
    async status() { return STATUS.FALLBACK; },
    async invoke(req) { return generateTerrainLocally(req); },
  };
}

export function spatialAdapters(env = process.env) {
  return [externalSpatialAdapter(env), localSpatialAdapter()];
}
