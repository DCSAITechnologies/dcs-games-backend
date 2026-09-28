// Mesh recipe (contract §4.2) → three.js BufferGeometry, browser-only.
//
// A recipe is a list of shaped parts, each naming a material. Drawing every part
// as its own mesh would cost one draw call per part — a cottage alone is ~10 — so
// parts are baked into their asset's local space and merged per material "bucket".
// An asset then costs one draw call per distinct material, and with instancing
// one per material for ALL copies of it.
//
// The r147 global build ships no BufferGeometryUtils, hence the small merge below.
/* global THREE */

import { rng } from "../src/gamesb/common/rng.mjs";

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Seeded, position-keyed value noise: the same point always displaces the same
 *  way, so the duplicated vertices of a non-indexed icosahedron stay welded. */
function lattice(seed) {
  const r = rng(seed || 1);
  const perm = Array.from({ length: 256 }, () => r());
  const h = (x, y, z) => perm[((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) & 255];
  const s = (t) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const tx = s(x - xi), ty = s(y - yi), tz = s(z - zi);
    let acc = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const w = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
      acc += w * h(xi + dx, yi + dy, zi + dz);
    }
    return acc * 2 - 1;
  };
}

function noisyIco(part, defNoise) {
  const radius = num(part.radius, 0.5);
  const g = new THREE.IcosahedronGeometry(radius, Math.min(3, Math.max(0, num(part.detail, 1))));
  const amp = num(part.noise, defNoise);
  if (amp > 0) {
    const n = lattice(num(part.seed, 1));
    const p = g.attributes.position;
    const f = 2.2 / Math.max(0.2, radius);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + amp * (n(x * f, y * f, z * f) * 0.75 + n(x * f * 2.3 + 7, y * f * 2.3, z * f * 2.3) * 0.25);
      p.setXYZ(i, x * k, y * k, z * k);
    }
  }
  return g;
}

/** One part → a geometry in the part's own frame (before its position/rotation). */
export function partGeometry(part, warn = () => {}) {
  const seg = Math.max(3, Math.min(48, Math.round(num(part.segments, 12))));
  const size = part.size || null;
  let g;
  switch (part.shape) {
    case "box":
      g = new THREE.BoxGeometry(num(size?.x, 1), num(size?.y, 1), num(size?.z, 1));
      break;
    case "cylinder": {
      const r = num(part.radius, 0.5);
      g = new THREE.CylinderGeometry(num(part.radius_top, r), num(part.radius_bottom, r), num(part.height, num(size?.y, 1)), seg);
      break;
    }
    case "cone":
      g = new THREE.CylinderGeometry(num(part.radius_top, 0), num(part.radius_bottom, num(part.radius, 0.5)), num(part.height, num(size?.y, 1)), seg);
      break;
    case "sphere":
      g = new THREE.SphereGeometry(num(part.radius, 0.5), seg, Math.max(3, Math.round(seg * 0.6)));
      break;
    case "capsule": {
      const r = num(part.radius, 0.25), h = num(part.height, 1);
      g = THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(r, Math.max(0.001, h), 3, Math.min(seg, 12))
        : new THREE.CylinderGeometry(r, r, h + 2 * r, seg);
      break;
    }
    case "torus":
      g = new THREE.TorusGeometry(num(part.radius, 0.5), num(part.tube, 0.1), 6, seg);
      break;
    case "lathe": {
      const prof = Array.isArray(part.profile) && part.profile.length >= 2 ? part.profile : [[0.5, 0], [0.5, 1]];
      g = new THREE.LatheGeometry(prof.map(([rr, y]) => new THREE.Vector2(Math.max(0, num(rr, 0)), num(y, 0))), seg);
      break;
    }
    case "extrude": {
      const out = Array.isArray(part.outline) && part.outline.length >= 3 ? part.outline : [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      const depth = num(part.depth, 1);
      if (part.outline_plane === "xy") {
        // A profile standing up (an arch, a gable): outline is [x,y], extruded along z, centred.
        const shape = new THREE.Shape(out.map(([x, y]) => new THREE.Vector2(num(x, 0), num(y, 0))));
        g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
        g.translate(0, 0, -depth / 2);
      } else {
        // A footprint on the XZ plane, extruded UP by `depth` from the position.
        // Shapes live on XY and extrude along +Z, so draw at (x, -z) and tip onto y.
        const shape = new THREE.Shape(out.map(([x, z]) => new THREE.Vector2(num(x, 0), -num(z, 0))));
        g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
      }
      break;
    }
    case "rock":
      g = noisyIco(part, 0.3);
      break;
    case "icosphere":
      g = noisyIco(part, 0);
      break;
    default:
      warn(`unknown part shape '${part.shape}', drawn as a box`);
      g = new THREE.BoxGeometry(num(size?.x, 0.5), num(size?.y, 0.5), num(size?.z, 0.5));
  }
  // `size` on a round shape reads as a per-axis scale (an ellipsoid rock, a squat sphere).
  if (size && (part.shape === "rock" || part.shape === "icosphere" || part.shape === "sphere")) {
    g.scale(num(size.x, 1), num(size.y, 1), num(size.z, 1));
  }
  // Optional non-uniform `scale:{x,y,z}` (canopy lobes, pebbles) — applied in the part's own frame.
  const sc = part.scale;
  if (sc && typeof sc === "object") g.scale(num(sc.x, 1), num(sc.y, 1), num(sc.z, 1));
  else if (typeof sc === "number" && sc > 0) g.scale(sc, sc, sc);
  if (!g.index) {
    const n = g.attributes.position.count;
    g.setIndex(Array.from({ length: n }, (_, i) => i));
  }
  if (part.shape === "rock" || part.shape === "icosphere") g.computeVertexNormals();
  return g;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();

export function partMatrix(part, out = new THREE.Matrix4()) {
  const r = part.rotation || {}, p = part.position || {};
  _e.set(num(r.x, 0), num(r.y, 0), num(r.z, 0), "XYZ");
  _q.setFromEuler(_e);
  _p.set(num(p.x, 0), num(p.y, 0), num(p.z, 0));
  return out.compose(_p, _q, _s);
}

/** Merge indexed geometries with position/normal/uv into one. */
export function mergeGeometries(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, t = g.attributes.uv;
    pos.set(p.array.subarray ? p.array.subarray(0, p.count * 3) : p.array, vo * 3);
    if (n) nor.set(n.array.subarray(0, n.count * 3), vo * 3);
    if (t) uv.set(t.array.subarray(0, t.count * 2), vo * 2);
    const tint = g.userData.tint;
    for (let i = 0; i < p.count; i++) {
      col[(vo + i) * 3] = tint ? tint.r : 1; col[(vo + i) * 3 + 1] = tint ? tint.g : 1; col[(vo + i) * 3 + 2] = tint ? tint.b : 1;
    }
    const ia = g.index.array;
    for (let i = 0; i < g.index.count; i++) idx[io + i] = ia[i] + vo;
    vo += p.count; io += g.index.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * Bake a recipe into buckets keyed by material + emissive (+ glow colour) + shadow flag.
 * `select(part)` optionally filters parts (a rig bakes one bucket set per joint).
 * `transform(part)` may return a matrix to pre-multiply (joint-local offset).
 * Returns [{ key, material_ref, emissive, castShadow, geometry }] plus the local
 * positions of emissive parts, which become candidate point-light sources.
 */
export function bakeRecipe(recipe, { select = () => true, pre = null, warn } = {}) {
  const buckets = new Map();
  const glow = [];
  const m = new THREE.Matrix4();
  for (const part of recipe?.parts || []) {
    if (!select(part)) continue;
    const g = partGeometry(part, warn);
    partMatrix(part, m);
    if (pre) m.premultiply(pre);
    g.applyMatrix4(m);
    const emissive = !!part.emissive;
    const cast = part.cast_shadow !== false && !emissive;
    const ref = part.material_ref || "mat:default";
    // A part `color` tints its material. Lit parts carry it as a vertex colour, so
    // a striped lighthouse is still one draw call per material; glowing parts
    // need it as their emissive colour, so it splits their bucket instead.
    const tintHex = typeof part.color === "string" && /^#[0-9a-f]{6}$/i.test(part.color) ? part.color : null;
    if (tintHex && !emissive) g.userData.tint = new THREE.Color(tintHex);
    const glowHex = emissive ? tintHex : null;
    const key = `${ref}|${emissive ? 1 : 0}|${cast ? 1 : 0}|${glowHex || ""}`;
    if (!buckets.has(key)) buckets.set(key, { key, material_ref: ref, emissive, glowColor: glowHex, castShadow: cast, parts: [] });
    buckets.get(key).parts.push(g);
    if (emissive) glow.push(Object.assign(new THREE.Vector3().setFromMatrixPosition(m), { color: glowHex }));
  }
  const out = [];
  for (const b of buckets.values()) {
    const geometry = mergeGeometries(b.parts);
    for (const g of b.parts) g.dispose();
    out.push({ key: b.key, material_ref: b.material_ref, emissive: b.emissive, glowColor: b.glowColor, castShadow: b.castShadow, geometry });
  }
  return { buckets: out, glow };
}
