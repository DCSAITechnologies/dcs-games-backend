// Games-B world: static colliders and capsule push-out. ISOMORPHIC.
//
// The simulation core, the nav baker and the spawn validator all ask "is this
// spot inside something solid?". They share this module so a spawn the world
// stage calls clear is clear in the runtime too.
//
// Colliders are 2.5D: an oriented box or a vertical cylinder, tested on the XZ
// plane, with a vertical extent so a capsule standing on top of a crate is not
// shoved sideways. Collider sizes on placements are in world units and are NOT
// multiplied by `placement.scale` (the world stage keeps solid pieces at scale
// 1); scatter instance radii are already scaled by expandScatter.

import { expandScatter } from "./terrain-sample.mjs";

const SCATTER_HEIGHT = 4;

/**
 * Every solid collider in the world: placements with a solid box/cylinder
 * collider, plus every expanded scatter instance with collider_radius > 0.
 * `bound` (optional extra field) is the XZ bounding radius, used to reject far
 * colliders cheaply.
 */
export function buildColliders(world, _scene, instances) {
  const out = [];
  for (const p of world.placements || []) {
    const c = p.collider;
    if (!c || c.shape === "none" || !c.solid) continue;
    if (c.shape === "box") {
      const half = { x: c.size.x / 2, y: c.size.y / 2, z: c.size.z / 2 };
      out.push({ id: `col_${p.id}`, shape: "box", center: { x: p.position.x, y: p.position.y + half.y, z: p.position.z },
        half, rotation_y: p.rotation_y || 0, solid: true, ref: p.id, bound: Math.hypot(half.x, half.z) });
    } else if (c.shape === "cylinder") {
      out.push({ id: `col_${p.id}`, shape: "cylinder", center: { x: p.position.x, y: p.position.y + c.height / 2, z: p.position.z },
        radius: c.radius, height: c.height, rotation_y: 0, solid: true, ref: p.id, bound: c.radius });
    }
  }
  const inst = instances || expandScatter(world);
  inst.forEach((s, k) => {
    if (!(s.collider_radius > 0)) return;
    const h = SCATTER_HEIGHT * s.scale;
    out.push({ id: `col_${s.scatter_id}_${k}`, shape: "cylinder", center: { x: s.position.x, y: s.position.y + h / 2, z: s.position.z },
      radius: s.collider_radius, height: h, rotation_y: 0, solid: true, ref: s.scatter_id, bound: s.collider_radius });
  });
  return out;
}

const boundOf = (c) => (Number.isFinite(c.bound) ? c.bound : c.shape === "box" ? Math.hypot(c.half.x, c.half.z) : c.radius);

/**
 * Signed penetration of a circle (x, z, r) into one collider, as the push
 * vector that would separate them, or null when they do not overlap.
 */
function pushOut(c, x, z, r) {
  const dx = x - c.center.x, dz = z - c.center.z;
  if (c.shape === "cylinder") {
    const d = Math.hypot(dx, dz), min = c.radius + r;
    if (d >= min) return null;
    if (d < 1e-6) return { x: min, z: 0 };
    return { x: (dx / d) * (min - d), z: (dz / d) * (min - d) };
  }
  // Box: work in the box's local frame. rotation_y turns local +x towards -z
  // (right-handed, y up), so local = R(-θ)·world.
  const cs = Math.cos(c.rotation_y || 0), sn = Math.sin(c.rotation_y || 0);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  const hx = c.half.x, hz = c.half.z;
  let px, pz;
  const inside = Math.abs(lx) < hx && Math.abs(lz) < hz;
  if (inside) {
    // Leave by the nearest face.
    const ex = hx - Math.abs(lx), ez = hz - Math.abs(lz);
    if (ex < ez) { px = Math.sign(lx || 1) * (ex + r); pz = 0; } else { px = 0; pz = Math.sign(lz || 1) * (ez + r); }
  } else {
    const qx = Math.max(-hx, Math.min(hx, lx)), qz = Math.max(-hz, Math.min(hz, lz));
    const ox = lx - qx, oz = lz - qz, d = Math.hypot(ox, oz);
    if (d >= r) return null;
    px = (ox / d) * (r - d); pz = (oz / d) * (r - d);
  }
  // Back to world: world = R(θ)·local.
  return { x: px * cs + pz * sn, z: -px * sn + pz * cs };
}

function verticalOverlap(c, y, height) {
  if (!Number.isFinite(y)) return true;
  const h = c.shape === "box" ? c.half.y * 2 : c.height;
  const bottom = c.center.y - h / 2, top = c.center.y + h / 2;
  return y < top - 0.05 && y + (height || 0) > bottom;
}

/**
 * Push a vertical capsule out of every solid collider on the XZ plane. Each
 * pass sums the separation vectors of every overlapping collider and applies
 * them together: two walls pushing from opposite sides cancel in their shared
 * axis and the capsule slides out along the free one, instead of being
 * bounced back and forth between them.
 */
export function resolveCapsule(colliders, pos, radius, height) {
  let x = pos.x, z = pos.z, hit = false;
  for (let iter = 0; iter < 32; iter++) { // usually 1–2 passes; wedges take more
    let sx = 0, sz = 0, n = 0;
    for (const c of colliders) {
      if (!c.solid) continue;
      const b = boundOf(c) + radius;
      if (Math.abs(x - c.center.x) > b || Math.abs(z - c.center.z) > b) continue;
      if (!verticalOverlap(c, pos.y, height)) continue;
      const p = pushOut(c, x, z, radius);
      if (!p) continue;
      sx += p.x; sz += p.z; n++;
    }
    if (!n) break;
    hit = true;
    if (Math.abs(sx) < 1e-9 && Math.abs(sz) < 1e-9) { sz = radius * 0.25; } // perfectly balanced: pick a side
    x += sx * 1.0001; z += sz * 1.0001;
  }
  return { x, z, hit };
}

/** The first solid collider containing (x, z) grown by `pad`, or null. */
export function pointInCollider(colliders, x, z, pad = 0) {
  for (const c of colliders) {
    if (!c.solid) continue;
    const b = boundOf(c) + pad;
    if (Math.abs(x - c.center.x) > b || Math.abs(z - c.center.z) > b) continue;
    if (containsXZ(c, x, z, pad)) return c;
  }
  return null;
}

/** True when (x, z) lies within `pad` of collider c on the XZ plane. */
export function containsXZ(c, x, z, pad = 0) {
  const dx = x - c.center.x, dz = z - c.center.z;
  if (c.shape === "cylinder") return Math.hypot(dx, dz) < c.radius + pad;
  const cs = Math.cos(c.rotation_y || 0), sn = Math.sin(c.rotation_y || 0);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  const ox = Math.max(0, Math.abs(lx) - c.half.x), oz = Math.max(0, Math.abs(lz) - c.half.z);
  return Math.hypot(ox, oz) < pad || (ox === 0 && oz === 0);
}
