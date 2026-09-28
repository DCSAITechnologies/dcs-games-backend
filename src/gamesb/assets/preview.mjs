// Games-B mesh recipe preview: orthographic silhouettes of a recipe, as SVG.
// Isomorphic-clean. Used by games-b-runtime/tools/texture-gallery.html and by
// humans checking a recipe without booting Three.js. It is a QA drawing, not a
// renderer: each part becomes the convex hull of sample points on its surface
// (lathes are drawn ring-pair by ring-pair so waists survive; "xy" extrusions
// draw their true outline so an arch keeps its opening), painted back to front.

import { buildMaterialSpec } from "./materials.mjs";

function rotate([x, y, z], r) {
  let c = Math.cos(r.z), s = Math.sin(r.z);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(r.y); s = Math.sin(r.y);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(r.x); s = Math.sin(r.x);
  [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y, z];
}

const ringPts = (r, y, n = 14) => Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
const spherePts = (r) => [...ringPts(r, 0), ...ringPts(r * 0.7, r * 0.7), ...ringPts(r * 0.7, -r * 0.7), [0, r, 0], [0, -r, 0]];

/** Groups of local points; each group is hulled separately. */
function localGroups(p) {
  switch (p.shape) {
    case "box": { const { x, y, z } = p.size; const g = []; for (let k = 0; k < 8; k++) g.push([(k & 1 ? 0.5 : -0.5) * x, (k & 2 ? 0.5 : -0.5) * y, (k & 4 ? 0.5 : -0.5) * z]); return [{ pts: g }]; }
    case "cylinder": return [{ pts: [...ringPts(p.radius_bottom ?? p.radius, -p.height / 2), ...ringPts(p.radius_top ?? p.radius, p.height / 2)] }];
    case "cone": return [{ pts: [...ringPts(p.radius, -p.height / 2, p.segments && p.segments < 8 ? p.segments : 14), [0, p.height / 2, 0]] }];
    case "sphere": return [{ pts: spherePts(p.radius) }];
    case "rock": case "icosphere": return [{ pts: spherePts(p.radius * (1 + (p.noise || 0) * 0.4)) }];
    case "capsule": { const h = p.height / 2; return [{ pts: [...ringPts(p.radius, -h), ...ringPts(p.radius, h), [0, h + p.radius, 0], [0, -h - p.radius, 0]] }]; }
    case "torus": { const pts = []; for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; for (let j = 0; j < 6; j++) { const b = (j / 6) * Math.PI * 2; const R = p.radius + p.tube * Math.cos(b); pts.push([Math.cos(a) * R, Math.sin(a) * R, p.tube * Math.sin(b)]); } } return [{ pts, ring: true }]; }
    case "lathe": { const segs = p.segments && p.segments <= 6 ? p.segments : 14; const g = []; for (let i = 0; i < p.profile.length - 1; i++) g.push({ pts: [...ringPts(p.profile[i][0], p.profile[i][1], segs), ...ringPts(p.profile[i + 1][0], p.profile[i + 1][1], segs)] }); return g; }
    case "extrude": {
      if (p.outline_plane === "xy") return [-p.depth / 2, p.depth / 2].map((z) => ({ poly: true, pts: p.outline.map(([a, b]) => [a, b, z]) }));
      return [{ pts: [...p.outline.map(([a, b]) => [a, 0, b]), ...p.outline.map(([a, b]) => [a, p.depth, b])] }];
    }
    default: return [{ pts: spherePts(0.5) }];
  }
}

function hull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

const matColorCache = new Map();
function materialColor(ref, palette) {
  const k = ref + JSON.stringify(palette || {});
  if (!matColorCache.has(k)) matColorCache.set(k, buildMaterialSpec(ref, { palette })?.material.color || "#999999");
  return matColorCache.get(k);
}
function mulHex(a, b) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round((((pa >> s) & 255) * ((pb >> s) & 255)) / 255);
  // Tints are applied at 60% so a red stripe on plaster stays readable.
  const mix = (s) => Math.round(((pa >> s) & 255) * 0.4 + ch(s) * 0.6 + (((pb >> s) & 255) - ((pa >> s) & 255)) * 0.35);
  return "#" + [16, 8, 0].map((s) => Math.max(0, Math.min(255, mix(s))).toString(16).padStart(2, "0")).join("");
}

/**
 * Project a recipe: view "front" looks down -z (x right, y up), "side" looks
 * down -x (z right). Returns shapes sorted back to front.
 */
export function projectRecipe(recipe, { view = "front", palette = null } = {}) {
  const shapes = [];
  for (const p of recipe?.parts || []) {
    const sc = p.scale ? [p.scale.x, p.scale.y, p.scale.z] : [1, 1, 1];
    const rot = p.rotation || { x: 0, y: 0, z: 0 };
    let color = materialColor(p.material_ref, palette);
    if (p.color) color = mulHex(color, p.color);
    for (const g of localGroups(p)) {
      const world = g.pts.map(([x, y, z]) => { const w = rotate([x * sc[0], y * sc[1], z * sc[2]], rot); return [w[0] + p.position.x, w[1] + p.position.y, w[2] + p.position.z]; });
      const two = world.map(([x, y, z]) => (view === "side" ? [z, y, x] : [x, y, z]));
      const depth = two.reduce((n, q) => n + q[2], 0) / two.length;
      shapes.push({ ring: !!g.ring, tube: p.tube || 0, name: p.name, material_ref: p.material_ref, color, emissive: !!p.emissive, depth, points: g.poly ? two.map(([a, b]) => [a, b]) : hull(two.map(([a, b]) => [a, b])) });
    }
  }
  return shapes.sort((a, b) => a.depth - b.depth);
}

/** Standalone SVG of the front and side silhouettes, with a 1 m grid. */
export function recipeToSvg(recipe, { palette = null, size = 240, title = "" } = {}) {
  const views = ["front", "side"].map((v) => projectRecipe(recipe, { view: v, palette }));
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const s of views.flat()) for (const [x, y] of s.points) { lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)]; }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], 0.5) * 1.1;
  const k = size / span, pad = 8;
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  const tx = (x, off) => (off + size / 2 + (x - cx) * k).toFixed(1), ty = (y) => (pad + size / 2 - (y - cy) * k).toFixed(1);
  let body = "";
  views.forEach((shapes, vi) => {
    const off = pad + vi * (size + pad);
    const gy = ty(0);
    body += `<line x1="${off}" x2="${off + size}" y1="${gy}" y2="${gy}" stroke="#7a8190" stroke-width="1"/>`;
    for (const s of shapes) {
      const d = s.points.map(([x, y], i) => `${i ? "L" : "M"}${tx(x, off)} ${ty(y)}`).join("") + "Z";
      // Tori are drawn as outlines so they do not hide what they encircle.
      if (s.ring) { body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${Math.max(1, s.tube * k * 2).toFixed(1)}"/>`; continue; }
      body += `<path d="${d}" fill="${s.color}" stroke="${s.emissive ? "#fff6c0" : "#1a1d24"}" stroke-opacity="${s.emissive ? 0.9 : 0.35}" stroke-width="0.8"/>`;
    }
  });
  const W = pad * 3 + size * 2, H = pad * 2 + size + 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#e9edf2"/>${body}` +
    `<text x="${pad}" y="${H - 6}" font-family="system-ui,sans-serif" font-size="11" fill="#333">${String(title).replace(/[<>&]/g, "")}  front | side</text></svg>`;
}
