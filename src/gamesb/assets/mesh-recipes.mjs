// Games-B procedural mesh recipes. ISOMORPHIC — loaded by the browser runtime
// and by the texture gallery, so: relative .mjs imports only, no node:*, no
// process/Buffer, and no Math.random (every variation comes from the seed).
//
// A recipe is a list of shaped parts (CONTRACT §4.2) that the runtime turns into
// Three.js geometry. The library below covers every `lib:` name in §4.1a. The
// aim is silhouettes that read at a distance — a lathed, striped, tapering
// lighthouse; trees with several displaced canopy lobes; arches cut as real
// extruded outlines — rather than a grey box per asset.
//
// Part conventions (documented here because §4.2 leaves them implicit):
//   * `position` is the part centre, except `lathe` (position = the profile's
//     origin; profile y is measured up from it) and `extrude` with
//     outline_plane "xz" (position = the base of the extrusion).
//   * cylinder / cone / capsule axes run along local +y. capsule `height` is
//     the straight section (Three.js CapsuleGeometry convention).
//   * torus lies in the local XY plane (Three.js convention); rotate x by π/2
//     to lay it flat.
//   * extrude: `outline_plane: "xy"` → outline is [x,y], extruded along z and
//     centred on the position; "xz" → outline is a footprint [x,z] extruded up
//     by `depth`. Absent means "xz", matching the §4.2 `[[x,z]]` wording.
//   * rotation is Euler XYZ in radians. Optional `scale:{x,y,z}` stretches a
//     part non-uniformly (canopies, pebbles). Optional `color` tints the
//     part's material (multiplied in), e.g. lighthouse stripes.
//   * `name` identifies the part; `joint` (characters) names the rig joint the
//     part rides on.

import { seeded, hashString, clamp } from "../common/rng.mjs";

// ------------------------------------------------------------------ catalog

export const LIB_ROLES = Object.freeze({
  structure: ["lighthouse", "watchtower", "stone_hut", "cottage", "ruin_arch", "ruin_wall", "ruin_pillar", "shrine", "dock", "bridge", "well", "tent", "campfire", "lantern_post", "altar", "beacon_brazier", "gate", "statue", "obelisk"],
  prop: ["crate", "barrel", "chest", "signpost", "fence", "boat", "cart"],
  foliage: ["pine_tree", "broadleaf_tree", "palm_tree", "dead_tree", "bush", "grass_tuft", "rock_small", "rock_large", "cliff_rock", "cactus", "crystal_cluster", "mushroom", "flowers", "reeds"],
  pickup: ["lantern_core", "relic", "gem", "key", "scroll", "herb", "shard"],
});
export const LIB_NAMES = Object.freeze(Object.values(LIB_ROLES).flat());
export const libRole = (name) => Object.keys(LIB_ROLES).find((r) => LIB_ROLES[r].includes(name)) || null;

/** AssetRecord `kind` for a library entry (pickups are props; rocks are props). */
export function libAssetKind(name) {
  const role = libRole(name);
  if (role === "structure") return "structure";
  if (role === "foliage") return /rock|crystal/.test(name) ? "prop" : "foliage";
  return "prop";
}

// Words a world stage (or a model) might use for something the library has.
const ALIASES = {
  tree: "broadleaf_tree", oak: "broadleaf_tree", maple: "broadleaf_tree", birch: "broadleaf_tree", pine: "pine_tree", fir: "pine_tree", spruce: "pine_tree", conifer: "pine_tree",
  palm: "palm_tree", coconut: "palm_tree", deadwood: "dead_tree", snag: "dead_tree", shrub: "bush", hedge: "bush", grass: "grass_tuft",
  rock: "rock_large", boulder: "rock_large", stone: "rock_small", pebble: "rock_small", cliff: "cliff_rock", crag: "cliff_rock",
  crystal: "crystal_cluster", fungus: "mushroom", toadstool: "mushroom", flower: "flowers", reed: "reeds", cattail: "reeds",
  house: "cottage", home: "cottage", cabin: "cottage", hut: "stone_hut", hovel: "stone_hut", tower: "watchtower", lookout: "watchtower",
  temple: "shrine", sanctum: "shrine", arch: "ruin_arch", ruin: "ruin_wall", wall: "ruin_wall", pillar: "ruin_pillar", column: "ruin_pillar",
  pier: "dock", jetty: "dock", wharf: "dock", fire: "campfire", bonfire: "campfire", lamp: "lantern_post", torch: "lantern_post", streetlight: "lantern_post",
  brazier: "beacon_brazier", beacon: "beacon_brazier", door: "gate", portal: "gate", monument: "obelisk", monolith: "obelisk", sculpture: "statue",
  box: "crate", keg: "barrel", cask: "barrel", trunk: "chest", coffer: "chest", sign: "signpost", railing: "fence", canoe: "boat", rowboat: "boat",
  wagon: "cart", wheelbarrow: "cart", orb: "lantern_core", core: "lantern_core", lantern: "lantern_core", artifact: "relic", artefact: "relic", idol: "relic",
  jewel: "gem", coin: "gem", crystal_shard: "shard", fragment: "shard", note: "scroll", map: "scroll", letter: "scroll", plant: "herb", leaf: "herb",
};
const ROLE_DEFAULT = { structure: "stone_hut", prop: "crate", foliage: "bush", pickup: "gem", landmark: "obelisk", decor: "barrel", interactable: "altar" };

/**
 * Nearest library entry for any name. Exact match first, then a known alias
 * for any word in the name, then word overlap, then the default for the role.
 * Never throws: an unknown name must still resolve (§4.1a).
 */
export function nearestLibName(name, { role } = {}) {
  const raw = String(name ?? "").toLowerCase().replace(/^lib:/, "");
  const n = raw.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (LIB_NAMES.includes(n)) return { name: n, exact: true, warning: null };
  const words = n.split("_").filter(Boolean);
  let found = null;
  if (ALIASES[n]) found = ALIASES[n];
  for (let i = words.length - 1; !found && i >= 0; i--) {
    const w = words[i], stem = w.replace(/s$/, "");
    if (ALIASES[w]) found = ALIASES[w]; else if (ALIASES[stem]) found = ALIASES[stem];
  }
  if (!found) {
    let best = null, bestScore = 0;
    const pool = role && LIB_ROLES[role] ? LIB_ROLES[role] : LIB_NAMES;
    for (const k of pool) {
      const kw = k.split("_");
      const score = words.filter((w) => kw.includes(w) || kw.includes(w.replace(/s$/, ""))).length;
      if (score > bestScore) { best = k; bestScore = score; }
    }
    found = best;
  }
  if (!found) {
    const roleKey = role === "landmark" ? "landmark" : role === "decor" ? "decor" : role === "interactable" ? "interactable" : role;
    found = ROLE_DEFAULT[roleKey] || "crate";
  }
  return { name: found, exact: false, warning: `unknown lib name '${raw}' resolved to '${found}'${role ? ` (role ${role})` : ""}` };
}

// ------------------------------------------------------------------ builder

const r3 = (v) => Math.round(v * 1000) / 1000;
const vec = (a = [0, 0, 0]) => ({ x: r3(a[0] || 0), y: r3(a[1] || 0), z: r3(a[2] || 0) });
const MAX_PARTS = 40;

function builder() {
  const parts = [];
  const add = (shape, name, mat, pos, fields, o = {}) => {
    const p = { shape, name, material_ref: mat, position: vec(pos), rotation: vec(o.rot), ...fields };
    if (o.scale) p.scale = vec(o.scale);
    if (o.color) p.color = o.color;
    if (o.emissive || mat === "mat:glow" || mat === "mat:ember") p.emissive = true;
    if (o.cast_shadow === false) p.cast_shadow = false;
    if (o.joint) p.joint = o.joint;
    parts.push(p);
    return p;
  };
  return {
    parts,
    box: (n, m, s, pos, o) => add("box", n, m, pos, { size: vec(s) }, o),
    cyl: (n, m, rt, rb, h, pos, o = {}) => add("cylinder", n, m, pos, { radius_top: r3(rt), radius_bottom: r3(rb), height: r3(h), segments: o.segments || 16 }, o),
    cone: (n, m, r, h, pos, o = {}) => add("cone", n, m, pos, { radius: r3(r), height: r3(h), segments: o.segments || 16 }, o),
    sphere: (n, m, r, pos, o = {}) => add("sphere", n, m, pos, { radius: r3(r), segments: o.segments || 16 }, o),
    capsule: (n, m, r, h, pos, o = {}) => add("capsule", n, m, pos, { radius: r3(r), height: r3(h), segments: o.segments || 10 }, o),
    torus: (n, m, R, t, pos, o = {}) => add("torus", n, m, pos, { radius: r3(R), tube: r3(t), segments: o.segments || 24 }, o),
    lathe: (n, m, profile, pos, o = {}) => add("lathe", n, m, pos, { profile: profile.map(([r, y]) => [r3(r), r3(y)]), segments: o.segments || 20 }, o),
    extrude: (n, m, outline, depth, pos, o = {}) => add("extrude", n, m, pos, { outline: outline.map(([a, b]) => [r3(a), r3(b)]), depth: r3(depth), outline_plane: o.plane || "xy" }, o),
    ico: (n, m, r, pos, o = {}) => add("icosphere", n, m, pos, { radius: r3(r), detail: o.detail ?? 2, noise: r3(o.noise ?? 0.2), seed: (o.seed ?? 1) >>> 0 }, o),
    rock: (n, m, r, pos, o = {}) => add("rock", n, m, pos, { radius: r3(r), detail: o.detail ?? 2, noise: r3(o.noise ?? 0.35), seed: (o.seed ?? 1) >>> 0 }, o),
  };
}

// Rough circle of points, used for rings of posts / stones.
const ring = (n, R, phase = 0) => Array.from({ length: n }, (_, i) => { const a = phase + (i / n) * Math.PI * 2; return [Math.sin(a) * R, Math.cos(a) * R, a]; });
const arc = (cx, cy, r, a0, a1, n) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * (i / n); return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
const lerpProfile = (profile, y) => {
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    if (y >= y0 && y <= y1) return r0 + (r1 - r0) * ((y - y0) / (y1 - y0 || 1));
  }
  return profile[profile.length - 1][0];
};

// ------------------------------------------------------------------ library
//
// Each entry: (b, ctx) → void, adding parts to builder b. ctx = { rnd, seed,
// palette, biome, snowy }. Bases sit on y = 0 and the front faces +z.

const STRIPE = "#b3372b";
const WARM_WINDOW = "#ffcf7a";

const LIB = {
  // ----------------------------------------------------------- structures
  lighthouse(b, { rnd }) {
    b.cyl("plinth", "mat:stone", 3.0, 3.25, 1.0, [0, 0.5, 0], { segments: 20 });
    const prof = [[2.3, 0], [2.2, 2], [2.02, 5], [1.84, 8], [1.64, 11], [1.52, 12]];
    b.lathe("tower", "mat:plaster", prof, [0, 1, 0], { segments: 24 });
    for (const [y0, y1] of [[2.4, 4.0], [6.0, 7.6], [9.6, 11.2]]) {
      b.lathe(`stripe_${y0}`, "mat:plaster", [[lerpProfile(prof, y0) + 0.035, y0], [lerpProfile(prof, y1) + 0.035, y1]], [0, 1, 0], { segments: 24, color: STRIPE });
    }
    b.box("door_frame", "mat:stone", [1.35, 2.25, 0.3], [0, 2.1, 2.2]);
    b.box("door", "mat:wood", [1.0, 1.95, 0.22], [0, 1.98, 2.3]);
    for (const [y, a] of [[5.2, 0.6], [8.6, -0.9]]) {
      const r = lerpProfile(prof, y - 1) + 0.02;
      b.box(`window_${y}`, "mat:glow", [0.42, 0.72, 0.14], [Math.sin(a) * r, y, Math.cos(a) * r], { rot: [0, a, 0], color: WARM_WINDOW });
    }
    b.cyl("gallery_deck", "mat:metal", 2.35, 2.1, 0.3, [0, 13.15, 0], { segments: 24 });
    b.torus("gallery_rail", "mat:metal", 2.25, 0.05, [0, 14.2, 0], { rot: [Math.PI / 2, 0, 0], segments: 32 });
    for (const [x, z, a] of ring(8, 2.25, rnd() * 0.3)) b.cyl(`rail_post_${a.toFixed(2)}`, "mat:metal", 0.04, 0.04, 0.9, [x, 13.75, z], { segments: 6 });
    b.cyl("lamp_base", "mat:metal", 1.3, 1.3, 0.45, [0, 13.52, 0], { segments: 20 });
    b.cyl("lamp_glass", "mat:crystal", 1.15, 1.15, 1.6, [0, 14.55, 0], { segments: 20 });
    b.sphere("lamp", "mat:glow", 0.55, [0, 14.55, 0], { color: "#fff1b8" });
    for (const [x, z, a] of ring(6, 1.16)) b.cyl(`mullion_${a.toFixed(2)}`, "mat:metal", 0.035, 0.035, 1.6, [x, 14.55, z], { segments: 5 });
    b.cone("cap", "mat:metal", 1.5, 1.3, [0, 16.0, 0], { segments: 20 });
    b.sphere("finial", "mat:brass", 0.18, [0, 16.8, 0], { segments: 10 });
  },

  watchtower(b, { rnd }) {
    const H = 7.5, half = 1.5, top = 1.1;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      // Legs lean inward: splay at the base, narrower under the platform.
      const tilt = Math.atan2(half - top, H);
      b.cyl(`leg_${sx}_${sz}`, "mat:wood", 0.14, 0.17, H, [sx * (half + top) / 2, H / 2, sz * (half + top) / 2], { rot: [sz * tilt, 0, -sx * tilt], segments: 8 });
    }
    // X-bracing on two faces, sized to the leg spread at that height.
    for (const [i, y] of [[0, 2.2], [1, 4.8]]) {
      const x = half - (half - top) * (y / H), ang = i ? 0.35 : -0.35, len = (2 * x) / Math.cos(ang);
      b.box(`brace_front_${i}`, "mat:wood", [len, 0.14, 0.12], [0, y, x + 0.1], { rot: [0, 0, ang] });
      b.box(`brace_side_${i}`, "mat:wood", [0.12, 0.14, len], [x + 0.1, y, 0], { rot: [ang, 0, 0] });
    }
    b.box("platform", "mat:planks", [3.0, 0.22, 3.0], [0, H + 0.11, 0]);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.cyl(`post_${sx}_${sz}`, "mat:wood", 0.08, 0.08, 2.4, [sx * 1.4, H + 1.3, sz * 1.4], { segments: 6 });
    b.box("rail_n", "mat:wood", [2.9, 0.1, 0.1], [0, H + 1.0, -1.4]);
    b.box("rail_s", "mat:wood", [2.9, 0.1, 0.1], [0, H + 1.0, 1.4]);
    b.box("rail_e", "mat:wood", [0.1, 0.1, 2.9], [1.4, H + 1.0, 0]);
    b.box("rail_w", "mat:wood", [0.1, 0.1, 2.9], [-1.4, H + 1.0, 0]);
    b.cone("roof", "mat:roof", 2.5, 1.6, [0, H + 3.3, 0], { segments: 4, rot: [0, Math.PI / 4, 0] });
    b.sphere("roof_knob", "mat:brass", 0.12, [0, H + 4.15, 0], { segments: 8 });
    // Ladder up the front.
    b.box("ladder_l", "mat:wood", [0.08, H + 0.4, 0.08], [-0.28, (H + 0.4) / 2, 1.75], { rot: [-0.14, 0, 0] });
    b.box("ladder_r", "mat:wood", [0.08, H + 0.4, 0.08], [0.28, (H + 0.4) / 2, 1.75], { rot: [-0.14, 0, 0] });
    for (let i = 0; i < 6; i++) { const y = 0.6 + i * 1.2; b.box(`rung_${i}`, "mat:wood", [0.56, 0.06, 0.06], [0, y, 1.75 + (H / 2 - y) * 0.14]); }
    if (rnd() > 0.4) b.box("banner", "mat:cloth", [0.05, 1.0, 0.6], [1.45, H + 2.2, 0], { color: "#8a2f2f" });
  },

  stone_hut(b, { rnd, seed }) {
    b.lathe("wall", "mat:stone", [[2.6, 0], [2.55, 0.8], [2.45, 1.8], [2.35, 2.4]], [0, 0, 0], { segments: 18 });
    b.cyl("floor", "mat:dirt", 2.5, 2.5, 0.1, [0, 0.05, 0], { segments: 18 });
    b.cone("roof", "mat:roof", 3.1, 2.4, [0, 3.55, 0], { segments: 18 });
    b.cyl("roof_rim", "mat:roof", 3.1, 3.15, 0.2, [0, 2.4, 0], { segments: 18 });
    b.box("door", "mat:wood", [0.95, 1.7, 0.2], [0, 0.85, 2.5]);
    b.box("lintel", "mat:stone", [1.4, 0.25, 0.4], [0, 1.82, 2.48]);
    b.box("window", "mat:glow", [0.5, 0.4, 0.12], [2.42, 1.4, 0.6], { rot: [0, Math.PI / 2 - 0.25, 0], color: WARM_WINDOW });
    b.cyl("chimney", "mat:stone", 0.3, 0.35, 1.4, [-1.2, 3.5, -0.9], { segments: 8 });
    for (let i = 0; i < 3; i++) b.rock(`stone_${i}`, "mat:rock", 0.25 + rnd() * 0.15, [-1.5 + i * 1.3, 0.12, 2.9 + rnd() * 0.3], { detail: 1, seed: seed + i, scale: [1, 0.6, 1] });
  },

  cottage(b, { rnd }) {
    const W = 6, D = 4.6, wallH = 2.8, ridge = 4.6;
    // Gable walls as one extruded pentagon: the house volume, pointed ends front/back.
    b.box("foundation", "mat:stone", [W + 0.3, 0.4, D + 0.3], [0, 0.2, 0]);
    b.extrude("walls", "mat:plaster", [[-D / 2, 0], [D / 2, 0], [D / 2, wallH], [0, ridge], [-D / 2, wallH]], W, [0, 0.4, 0], { plane: "xy", rot: [0, Math.PI / 2, 0] });
    const pitch = Math.atan2(ridge - wallH, D / 2), slope = Math.hypot(D / 2, ridge - wallH) + 0.45;
    for (const s of [-1, 1]) {
      b.box(`roof_${s < 0 ? "back" : "front"}`, "mat:roof", [W + 0.7, 0.16, slope], [0, 0.4 + (wallH + ridge) / 2 + 0.1, s * D / 4 + s * 0.12], { rot: [s * pitch, 0, 0] });
    }
    b.box("ridge_beam", "mat:wood", [W + 0.8, 0.18, 0.18], [0, 0.4 + ridge + 0.12, 0]);
    for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) b.box(`corner_${x}_${z}`, "mat:wood", [0.22, wallH, 0.22], [x, 0.4 + wallH / 2, z]);
    b.box("beam_front", "mat:wood", [W, 0.18, 0.2], [0, 0.4 + wallH - 0.1, D / 2 + 0.02]);
    b.box("beam_back", "mat:wood", [W, 0.18, 0.2], [0, 0.4 + wallH - 0.1, -D / 2 - 0.02]);
    b.box("door", "mat:planks", [1.0, 2.0, 0.12], [0.6, 1.4, D / 2 + 0.06]);
    b.box("door_frame", "mat:wood", [1.25, 2.15, 0.08], [0.6, 1.45, D / 2 + 0.02]);
    for (const x of [-1.7, 2.1]) {
      if (x === 2.1 && W < 6) continue;
      b.box(`window_${x}`, "mat:glow", [0.8, 0.7, 0.08], [x, 1.9, D / 2 + 0.05], { color: WARM_WINDOW });
      b.box(`shutter_${x}`, "mat:wood", [0.95, 0.85, 0.05], [x, 1.9, D / 2 + 0.03]);
    }
    b.box("window_side", "mat:glow", [0.08, 0.7, 0.8], [W / 2 + 0.05, 1.9, 0], { color: WARM_WINDOW });
    b.box("chimney", "mat:stone", [0.6, 2.4, 0.6], [-W / 2 + 0.9, 0.4 + ridge - 0.2, -0.8]);
    b.box("chimney_cap", "mat:stone", [0.75, 0.15, 0.75], [-W / 2 + 0.9, 0.4 + ridge + 1.05, -0.8]);
    b.box("step", "mat:stone", [1.3, 0.2, 0.5], [0.6, 0.1, D / 2 + 0.4]);
    if (rnd() > 0.3) b.box("flower_box", "mat:wood", [0.9, 0.2, 0.25], [-1.7, 1.45, D / 2 + 0.18]);
  },

  ruin_arch(b, { rnd, seed }) {
    const w = 4.6, h = 5.2, t = 1.0, r = 1.4, spring = 3.0;
    // One simple polygon: outer rectangle with a round-headed opening cut from
    // its base — the silhouette of a real arch, extruded through its thickness.
    // Walk: outer-left foot → inner-left foot → up and over the opening →
    // inner-right foot → outer-right, then a broken, sloping top edge.
    const ordered = [[-w / 2, 0], [-r, 0], ...arc(0, spring, r, Math.PI, 0, 12), [r, 0], [w / 2, 0], [w / 2, h * 0.92], [w / 4, h], [-w / 2, h * 0.85]];
    b.extrude("arch", "mat:stone", ordered, t, [0, 0, 0], { plane: "xy" });
    b.box("keystone", "mat:stone", [0.55, 0.7, t + 0.12], [0, spring + r + 0.25, 0]);
    b.box("impost_l", "mat:stone", [0.7, 0.25, t + 0.15], [-r - 0.3, spring, 0]);
    b.box("impost_r", "mat:stone", [0.7, 0.25, t + 0.15], [r + 0.3, spring, 0]);
    for (let i = 0; i < 4; i++) {
      b.box(`fallen_block_${i}`, "mat:stone", [0.7 + rnd() * 0.4, 0.45, 0.5 + rnd() * 0.3], [(rnd() - 0.5) * 4, 0.22, 1.2 + rnd() * 1.2], { rot: [0, rnd() * 1.5, (rnd() - 0.5) * 0.3] });
    }
    for (let i = 0; i < 3; i++) b.rock(`rubble_${i}`, "mat:rock", 0.3 + rnd() * 0.25, [(rnd() - 0.5) * 5, 0.15, -0.9 - rnd()], { detail: 1, seed: seed + i, scale: [1.2, 0.6, 1] });
  },

  ruin_wall(b, { rnd, seed }) {
    // Courses of blocks, alternate courses offset by half a block, with a
    // broken, stepped top edge: upper courses keep fewer blocks.
    const len = 6, courses = 5, bh = 0.55, n = 4, bw = len / n;
    for (let c = 0; c < courses; c++) {
      const odd = c % 2 === 1;
      const slots = odd ? n - 1 : n;
      const keep = c < 2 ? slots : Math.max(1, Math.round(slots * (1 - (c - 1) * 0.2 - rnd() * 0.3)));
      for (let i = 0; i < keep; i++) {
        const x = -len / 2 + bw / 2 + i * bw + (odd ? bw / 2 : 0);
        b.box(`block_${c}_${i}`, "mat:stone", [bw - 0.06, bh - 0.04, 0.8 - rnd() * 0.08], [x, c * bh + bh / 2, (rnd() - 0.5) * 0.06], { rot: [0, (rnd() - 0.5) * 0.04, 0] });
      }
    }
    for (let i = 0; i < 4; i++) b.rock(`rubble_${i}`, "mat:rock", 0.25 + rnd() * 0.3, [(rnd() - 0.5) * 6, 0.12, 0.8 + rnd() * 0.8], { detail: 1, seed: seed + i, scale: [1.3, 0.6, 1] });
    b.box("moss", "mat:leaves", [2.2, 0.08, 0.84], [-1.2, bh * 2 + 0.02, 0], { color: "#6c8f3a" });
  },

  ruin_pillar(b, { rnd, seed }) {
    const h = 3.4 + rnd() * 1.4;
    b.box("plinth", "mat:stone", [1.4, 0.4, 1.4], [0, 0.2, 0]);
    b.lathe("base", "mat:stone", [[0.62, 0], [0.62, 0.15], [0.52, 0.3], [0.48, 0.4]], [0, 0.4, 0], { segments: 16 });
    // Fluted look from a 12-sided shaft; broken top tilted slightly.
    b.cyl("shaft", "mat:stone", 0.4, 0.46, h, [0, 0.8 + h / 2, 0], { segments: 12 });
    b.cyl("break", "mat:stone", 0.38, 0.4, 0.35, [0.03, 0.8 + h + 0.12, 0], { rot: [0.12, 0, 0.18], segments: 12 });
    b.cyl("drum_fallen", "mat:stone", 0.4, 0.4, 1.1, [1.6, 0.4, 0.6], { rot: [0, 0.6, Math.PI / 2], segments: 12 });
    b.lathe("capital_fallen", "mat:stone", [[0.4, 0], [0.55, 0.25], [0.7, 0.35], [0.7, 0.5]], [-1.3, 0, -0.8], { rot: [0.35, 0, 0.2], segments: 12 });
    b.rock("rubble", "mat:rock", 0.35, [0.9, 0.15, -0.9], { detail: 1, seed, scale: [1.2, 0.6, 1] });
  },

  shrine(b, { rnd, palette }) {
    b.box("step_1", "mat:stone", [5.2, 0.35, 5.2], [0, 0.175, 0]);
    b.box("step_2", "mat:stone", [4.4, 0.35, 4.4], [0, 0.525, 0]);
    const colH = 3.0;
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      b.lathe(`column_${sx}_${sz}`, "mat:stone", [[0.3, 0], [0.3, 0.2], [0.22, 0.35], [0.2, colH - 0.35], [0.26, colH - 0.2], [0.34, colH]], [sx * 1.7, 0.7, sz * 1.7], { segments: 12 });
    }
    b.box("entablature", "mat:stone", [4.3, 0.4, 4.3], [0, 0.7 + colH + 0.2, 0]);
    b.cone("roof", "mat:roof", 3.4, 1.6, [0, 0.7 + colH + 1.2, 0], { segments: 4, rot: [0, Math.PI / 4, 0] });
    b.sphere("roof_orb", "mat:brass", 0.2, [0, 0.7 + colH + 2.1, 0], { segments: 10 });
    b.box("pedestal", "mat:stone", [0.9, 0.9, 0.9], [0, 1.15, 0]);
    b.lathe("bowl", "mat:brass", [[0.05, 0], [0.45, 0.1], [0.55, 0.3], [0.5, 0.32]], [0, 1.6, 0], { segments: 16 });
    b.sphere("spirit_flame", "mat:glow", 0.28, [0, 2.15, 0], { color: palette?.accent || "#8fe3ff" });
    for (const [sx, sz] of [[-1, 1], [1, 1]]) b.cyl(`candle_${sx}`, "mat:plaster", 0.06, 0.06, 0.3 + rnd() * 0.1, [sx * 1.0, 0.85, sz * 1.6], { segments: 6 });
    b.box("offering_cloth", "mat:cloth", [1.2, 0.02, 0.5], [0, 0.71, 1.6], { color: palette?.primary });
  },

  dock(b, { rnd }) {
    const L = 10, W = 2.6, deckY = 1.1;
    b.box("deck", "mat:planks", [W, 0.18, L], [0, deckY, 0]);
    for (const s of [-1, 1]) b.box(`stringer_${s}`, "mat:wood", [0.2, 0.3, L], [s * (W / 2 - 0.1), deckY - 0.22, 0]);
    for (let i = 0; i < 5; i++) {
      for (const s of [-1, 1]) {
        const z = -L / 2 + 0.3 + i * (L - 0.6) / 4;
        b.cyl(`piling_${i}_${s}`, "mat:wood", 0.14, 0.16, deckY + 1.8 + (i === 4 ? 0.8 : 0), [s * (W / 2 + 0.05), (deckY + 1.8) / 2 - 1.5 + (i === 4 ? 0.4 : 0), z], { segments: 8 });
      }
    }
    b.cyl("bollard", "mat:metal", 0.14, 0.18, 0.4, [W / 2 - 0.35, deckY + 0.29, L / 2 - 0.6], { segments: 10 });
    b.torus("rope_coil", "mat:cloth", 0.25, 0.06, [-W / 2 + 0.5, deckY + 0.13, L / 2 - 1.2], { rot: [Math.PI / 2, 0, 0], color: "#b89a6a" });
    b.box("crate", "mat:planks", [0.6, 0.6, 0.6], [-W / 2 + 0.5, deckY + 0.39, -L / 2 + 1.4], { rot: [0, rnd() * 0.5, 0] });
    b.cyl("lantern_pole", "mat:wood", 0.06, 0.06, 1.6, [W / 2 - 0.15, deckY + 0.9, L / 2 - 0.15], { segments: 6 });
    b.sphere("lantern", "mat:glow", 0.14, [W / 2 - 0.15, deckY + 1.75, L / 2 - 0.15], { color: WARM_WINDOW });
  },

  bridge(b, { rnd }) {
    const L = 12, W = 2.4, rise = 0.9, n = 6;
    // Deck as a gentle arch of plank segments.
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n, tm = (t0 + t1) / 2;
      const y = (tt) => rise * Math.sin(Math.PI * tt);
      const z0 = -L / 2 + t0 * L, z1 = -L / 2 + t1 * L;
      const ang = Math.atan2(y(t1) - y(t0), z1 - z0);
      b.box(`deck_${i}`, "mat:planks", [W, 0.2, Math.hypot(z1 - z0, y(t1) - y(t0)) + 0.02], [0, 0.35 + y(tm), -L / 2 + tm * L], { rot: [-ang, 0, 0] });
      for (const s of [-1, 1]) {
        b.cyl(`post_${i}_${s}`, "mat:wood", 0.07, 0.08, 1.0, [s * (W / 2 - 0.05), 0.35 + y(t0) + 0.55, z0], { segments: 6 });
      }
    }
    // Handrails: one straight segment per two deck segments keeps parts ≤ 40.
    for (const s of [-1, 1]) for (let i = 0; i < n; i += 2) {
      const t0 = i / n, t2 = Math.min(1, (i + 2) / n);
      const y0 = rise * Math.sin(Math.PI * t0), y2 = rise * Math.sin(Math.PI * t2);
      const z0 = -L / 2 + t0 * L, z2 = -L / 2 + t2 * L;
      b.box(`rail_${s}_${i}`, "mat:wood", [0.08, 0.08, Math.hypot(z2 - z0, y2 - y0)], [s * (W / 2 - 0.05), 0.35 + (y0 + y2) / 2 + 1.0, (z0 + z2) / 2], { rot: [-Math.atan2(y2 - y0, z2 - z0), 0, 0] });
    }
    for (const s of [-1, 1]) b.box(`abutment_${s}`, "mat:stone", [W + 0.6, 0.8, 1.0], [0, 0.1, s * (L / 2 + 0.3)]);
    for (const s of [-1, 1]) b.cyl(`end_post_${s}`, "mat:wood", 0.08, 0.08, 1.0, [s * (W / 2 - 0.05), 0.9, L / 2], { segments: 6 });
    if (rnd() > 0.5) b.sphere("lantern", "mat:glow", 0.12, [W / 2 - 0.05, 1.5, L / 2], { segments: 8, color: WARM_WINDOW });
  },

  well(b) {
    b.lathe("ring_wall", "mat:stone", [[0.95, 0], [1.0, 0.1], [1.0, 0.85], [0.92, 0.95], [0.72, 0.95], [0.72, 0.1]], [0, 0, 0], { segments: 20 });
    b.cyl("water", "mat:water", 0.72, 0.72, 0.05, [0, 0.45, 0], { segments: 20 });
    for (const s of [-1, 1]) b.box(`post_${s}`, "mat:wood", [0.14, 2.0, 0.14], [s * 0.85, 1.0, 0]);
    b.box("beam", "mat:wood", [1.9, 0.14, 0.14], [0, 1.95, 0]);
    for (const s of [-1, 1]) b.box(`roof_${s}`, "mat:roof", [2.3, 0.08, 1.05], [0, 2.3, s * 0.42], { rot: [s * 0.62, 0, 0] });
    b.cyl("crank", "mat:wood", 0.08, 0.08, 1.7, [0, 1.6, 0], { rot: [0, 0, Math.PI / 2], segments: 8 });
    b.box("handle", "mat:metal", [0.05, 0.35, 0.05], [0.95, 1.45, 0]);
    b.cyl("rope", "mat:cloth", 0.02, 0.02, 1.0, [0, 1.05, 0], { segments: 4, color: "#b89a6a" });
    b.lathe("bucket", "mat:wood", [[0.16, 0], [0.2, 0.3], [0.21, 0.32]], [0, 0.3, 0], { segments: 12 });
  },

  tent(b, { rnd, palette }) {
    const W = 3.0, H = 2.1, L = 3.4;
    b.extrude("canvas", "mat:cloth", [[-W / 2, 0], [W / 2, 0], [0.05, H], [-0.05, H]], L, [0, 0, 0], { plane: "xy", color: palette?.secondary || "#b8a27a" });
    b.cyl("ridge_pole", "mat:wood", 0.04, 0.04, L + 0.5, [0, H + 0.02, 0], { rot: [Math.PI / 2, 0, 0], segments: 6 });
    for (const s of [-1, 1]) b.cyl(`pole_${s}`, "mat:wood", 0.04, 0.04, H + 0.2, [0, (H + 0.2) / 2, s * (L / 2 + 0.2)], { segments: 6 });
    b.extrude("door_flap", "mat:cloth", [[-0.7, 0], [0, 1.5], [0.05, 0]], 0.04, [0.2, 0, L / 2 + 0.05], { plane: "xy", rot: [0, 0.5, 0], color: palette?.accent || "#8a6d4a" });
    for (const [x, z] of [[-W / 2 - 0.3, -L / 2], [W / 2 + 0.3, -L / 2], [-W / 2 - 0.3, L / 2], [W / 2 + 0.3, L / 2]]) b.cone(`peg_${x}_${z}`, "mat:wood", 0.04, 0.3, [x, 0.1, z], { segments: 4, rot: [Math.PI, 0, 0] });
    b.box("bedroll", "mat:cloth", [0.7, 0.15, 1.8], [-0.5, 0.08, -0.2 + rnd() * 0.2], { color: "#6d4f3a" });
  },

  campfire(b, { rnd, seed }) {
    for (const [x, z, a] of ring(9, 0.75, rnd())) b.rock(`ring_stone_${a.toFixed(2)}`, "mat:rock", 0.17 + rnd() * 0.06, [x, 0.1, z], { detail: 1, seed: seed + Math.round(a * 100), scale: [1.2, 0.8, 1] });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.3;
      b.cyl(`log_${i}`, "mat:bark", 0.08, 0.1, 1.0, [Math.sin(a) * 0.2, 0.28, Math.cos(a) * 0.2], { rot: [Math.cos(a) * 1.05, 0, -Math.sin(a) * 1.05], segments: 8 });
    }
    b.ico("embers", "mat:ember", 0.3, [0, 0.12, 0], { detail: 1, noise: 0.3, seed, scale: [1, 0.4, 1] });
    b.cone("flame_outer", "mat:glow", 0.32, 0.9, [0, 0.55, 0], { segments: 8, color: "#ff9a3c" });
    b.cone("flame_inner", "mat:glow", 0.18, 0.6, [0.03, 0.45, 0.02], { segments: 8, color: "#ffe28a" });
  },

  lantern_post(b) {
    b.box("base", "mat:stone", [0.5, 0.3, 0.5], [0, 0.15, 0]);
    b.lathe("post", "mat:metal", [[0.12, 0], [0.09, 0.3], [0.06, 0.5], [0.06, 3.0], [0.09, 3.1]], [0, 0.3, 0], { segments: 10 });
    b.box("arm", "mat:metal", [0.7, 0.06, 0.06], [0.3, 3.3, 0]);
    b.cyl("lantern_frame_top", "mat:metal", 0.1, 0.22, 0.14, [0.6, 3.2, 0], { segments: 6 });
    b.cyl("lantern_glass", "mat:glow", 0.15, 0.13, 0.36, [0.6, 2.95, 0], { segments: 6, color: WARM_WINDOW });
    b.cyl("lantern_frame_bottom", "mat:metal", 0.12, 0.1, 0.06, [0.6, 2.74, 0], { segments: 6 });
    b.cone("lantern_cap", "mat:metal", 0.2, 0.18, [0.6, 3.36, 0], { segments: 6 });
    b.sphere("hook", "mat:brass", 0.04, [0.6, 3.48, 0], { segments: 6 });
  },

  altar(b, { palette }) {
    b.box("step", "mat:stone", [2.6, 0.25, 1.8], [0, 0.125, 0]);
    b.box("body", "mat:stone", [2.0, 0.85, 1.1], [0, 0.675, 0]);
    b.box("slab", "mat:stone", [2.3, 0.18, 1.35], [0, 1.19, 0]);
    b.box("carving", "mat:brass", [1.2, 0.35, 0.04], [0, 0.7, 0.57]);
    b.box("rune_glow", "mat:glow", [0.9, 0.08, 0.02], [0, 0.7, 0.6], { color: palette?.accent || "#7fe0ff" });
    b.cone("gem_top", "mat:crystal", 0.2, 0.3, [0, 1.58, 0], { segments: 6, color: palette?.accent });
    b.cone("gem_bottom", "mat:crystal", 0.2, 0.2, [0, 1.33, 0], { segments: 6, rot: [Math.PI, 0, 0], color: palette?.accent });
    for (const s of [-1, 1]) {
      b.cyl(`candle_${s}`, "mat:plaster", 0.05, 0.05, 0.28, [s * 0.85, 1.42, 0.35], { segments: 6 });
      b.sphere(`flame_${s}`, "mat:glow", 0.04, [s * 0.85, 1.6, 0.35], { segments: 6, color: "#ffd27a" });
    }
    b.box("cloth", "mat:cloth", [0.8, 0.02, 1.36], [0, 1.29, 0], { color: palette?.primary || "#7a2f3a" });
  },

  beacon_brazier(b, { seed }) {
    b.lathe("plinth", "mat:stone", [[0.9, 0], [0.9, 0.3], [0.6, 0.45], [0.55, 0.6]], [0, 0, 0], { segments: 12 });
    for (const [x, z, a] of ring(3, 0.35)) b.cyl(`leg_${a.toFixed(2)}`, "mat:brass", 0.05, 0.07, 1.3, [x * 0.8, 1.2, z * 0.8], { rot: [Math.cos(a) * -0.2, 0, Math.sin(a) * 0.2], segments: 6 });
    b.lathe("bowl", "mat:brass", [[0.1, 0], [0.5, 0.15], [0.75, 0.45], [0.8, 0.55], [0.72, 0.55]], [0, 1.8, 0], { segments: 18 });
    b.torus("rim", "mat:brass", 0.78, 0.04, [0, 2.35, 0], { rot: [Math.PI / 2, 0, 0], segments: 24 });
    b.ico("coals", "mat:ember", 0.55, [0, 2.2, 0], { detail: 1, noise: 0.25, seed, scale: [1, 0.35, 1] });
    b.cone("flame_a", "mat:glow", 0.5, 1.4, [0, 2.95, 0], { segments: 10, color: "#ff8c2a" });
    b.cone("flame_b", "mat:glow", 0.3, 1.0, [0.15, 2.8, 0.1], { segments: 8, color: "#ffd166" });
    b.cone("flame_c", "mat:glow", 0.25, 0.8, [-0.2, 2.7, -0.1], { segments: 8, color: "#ffb347" });
  },

  gate(b) {
    for (const s of [-1, 1]) {
      b.box(`pillar_${s}`, "mat:stone", [0.9, 4.0, 0.9], [s * 2.1, 2.0, 0]);
      b.box(`pillar_cap_${s}`, "mat:stone", [1.1, 0.3, 1.1], [s * 2.1, 4.15, 0]);
      b.sphere(`finial_${s}`, "mat:stone", 0.3, [s * 2.1, 4.55, 0], { segments: 10 });
      b.box(`door_${s}`, "mat:planks", [1.6, 3.0, 0.14], [s * 0.85, 1.5, 0]);
      for (const y of [0.6, 2.4]) b.box(`band_${s}_${y}`, "mat:metal", [1.5, 0.12, 0.04], [s * 0.85, y, 0.09]);
      b.torus(`ring_${s}`, "mat:brass", 0.1, 0.02, [s * 0.25, 1.5, 0.1], { segments: 12 });
    }
    // Lintel with a rounded crest, as one extruded outline.
    b.extrude("crest", "mat:stone", [[-2.6, 0], [2.6, 0], [2.6, 0.5], [1.7, 0.5], ...arc(0, 0.5, 1.7, 0, Math.PI, 8).slice(1, -1), [-1.7, 0.5], [-2.6, 0.5]], 0.9, [0, 3.8, 0], { plane: "xy" });
  },

  statue(b, { palette }) {
    b.box("plinth", "mat:stone", [1.4, 1.0, 1.4], [0, 0.5, 0]);
    b.box("plinth_cap", "mat:stone", [1.55, 0.15, 1.55], [0, 1.07, 0]);
    b.lathe("robe", "mat:stone", [[0.5, 0], [0.42, 0.6], [0.3, 1.2], [0.26, 1.5], [0.12, 1.6]], [0, 1.15, 0], { segments: 14 });
    b.sphere("head", "mat:stone", 0.2, [0, 2.95, 0], { segments: 14 });
    b.capsule("arm_l", "mat:stone", 0.08, 0.6, [-0.33, 2.3, 0.1], { rot: [0.5, 0, 0.3] });
    b.capsule("arm_r", "mat:stone", 0.08, 0.7, [0.34, 2.55, 0], { rot: [0, 0, -0.35] });
    b.cyl("staff", "mat:stone", 0.035, 0.035, 2.2, [0.5, 2.2, 0], { segments: 6 });
    b.sphere("staff_orb", "mat:brass", 0.1, [0.5, 3.32, 0], { segments: 10, color: palette?.accent });
    b.box("plaque", "mat:brass", [0.6, 0.25, 0.03], [0, 0.6, 0.71]);
  },

  obelisk(b, { palette }) {
    b.box("step_1", "mat:stone", [2.2, 0.3, 2.2], [0, 0.15, 0]);
    b.box("step_2", "mat:stone", [1.6, 0.3, 1.6], [0, 0.45, 0]);
    // A 4-sided lathe is a square taper — the obelisk shaft in one part.
    b.lathe("shaft", "mat:stone", [[0.75, 0], [0.5, 6.0]], [0, 0.6, 0], { segments: 4, rot: [0, Math.PI / 4, 0] });
    b.cone("pyramidion", "mat:brass", 0.5, 0.7, [0, 6.95, 0], { segments: 4, rot: [0, Math.PI / 4, 0] });
    for (const [i, y] of [[0, 2.0], [1, 3.2], [2, 4.4]]) b.box(`rune_${i}`, "mat:glow", [0.14, 0.5, 0.02], [0, y, 0.72 - y * 0.042], { color: palette?.accent || "#8fe3ff" });
  },

  // ----------------------------------------------------------------- props
  crate(b, { rnd }) {
    const s = 0.9 + rnd() * 0.2;
    b.box("body", "mat:planks", [s, s, s], [0, s / 2, 0]);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box(`edge_${x}_${z}`, "mat:wood", [0.08, s + 0.02, 0.08], [x * s / 2, s / 2, z * s / 2]);
    for (const y of [0.04, s - 0.04]) {
      b.box(`rim_x_${y}`, "mat:wood", [s + 0.04, 0.08, 0.08], [0, y, s / 2]);
      b.box(`rim_xb_${y}`, "mat:wood", [s + 0.04, 0.08, 0.08], [0, y, -s / 2]);
    }
    b.box("brace", "mat:wood", [0.07, s * 1.3, 0.04], [0, s / 2, s / 2 + 0.02], { rot: [0, 0, 0.78] });
  },

  barrel(b) {
    b.lathe("staves", "mat:wood", [[0.36, 0], [0.43, 0.3], [0.46, 0.55], [0.43, 0.8], [0.36, 1.1]], [0, 0, 0], { segments: 16 });
    b.cyl("lid", "mat:planks", 0.35, 0.35, 0.04, [0, 1.08, 0], { segments: 16 });
    b.cyl("bottom", "mat:planks", 0.35, 0.35, 0.04, [0, 0.02, 0], { segments: 16 });
    for (const y of [0.15, 0.95]) b.torus(`hoop_${y}`, "mat:metal", 0.405, 0.022, [0, y, 0], { rot: [Math.PI / 2, 0, 0], segments: 24 });
    b.torus("hoop_mid", "mat:metal", 0.465, 0.022, [0, 0.55, 0], { rot: [Math.PI / 2, 0, 0], segments: 24 });
  },

  chest(b) {
    b.box("body", "mat:planks", [1.0, 0.55, 0.62], [0, 0.275, 0]);
    // Barrel-vaulted lid: a half-buried horizontal cylinder.
    b.cyl("lid", "mat:planks", 0.31, 0.31, 1.0, [0, 0.55, 0], { rot: [0, 0, Math.PI / 2], segments: 12 });
    for (const x of [-0.38, 0.38]) {
      b.box(`band_${x}`, "mat:metal", [0.07, 0.57, 0.64], [x, 0.285, 0]);
      b.torus(`band_lid_${x}`, "mat:metal", 0.315, 0.025, [x, 0.55, 0], { rot: [0, Math.PI / 2, 0], segments: 16 });
    }
    b.box("lock", "mat:brass", [0.16, 0.2, 0.05], [0, 0.5, 0.33]);
    b.torus("lock_ring", "mat:brass", 0.04, 0.012, [0, 0.38, 0.35], { segments: 10 });
  },

  signpost(b, { rnd }) {
    b.cyl("post", "mat:wood", 0.07, 0.09, 2.4, [0, 1.2, 0], { segments: 8 });
    const arrow = [[-0.6, -0.12], [0.45, -0.12], [0.62, 0], [0.45, 0.12], [-0.6, 0.12]];
    b.extrude("board_a", "mat:planks", arrow, 0.05, [0.4, 2.05, 0], { plane: "xy", rot: [0, 0.2 + rnd() * 0.3, 0] });
    b.extrude("board_b", "mat:planks", arrow.map(([x, y]) => [-x, y]), 0.05, [-0.35, 1.65, 0.02], { plane: "xy", rot: [0, -0.4 - rnd() * 0.3, 0] });
    b.cone("cap", "mat:wood", 0.11, 0.15, [0, 2.47, 0], { segments: 8 });
    b.rock("stone", "mat:rock", 0.18, [0.2, 0.08, 0.15], { detail: 1, seed: 3, scale: [1.2, 0.6, 1] });
  },

  fence(b, { rnd }) {
    const L = 3.0;
    for (let i = 0; i < 3; i++) b.box(`post_${i}`, "mat:wood", [0.12, 1.15, 0.12], [-L / 2 + i * L / 2, 0.575, 0], { rot: [0, 0, (rnd() - 0.5) * 0.06] });
    for (const y of [0.45, 0.9]) b.box(`rail_${y}`, "mat:wood", [L + 0.2, 0.09, 0.06], [0, y, 0.07]);
    for (let i = 0; i < 3; i++) b.cone(`post_top_${i}`, "mat:wood", 0.085, 0.12, [-L / 2 + i * L / 2, 1.21, 0], { segments: 4, rot: [0, Math.PI / 4, 0] });
  },

  boat(b, { palette }) {
    // Hull: a pointed footprint extruded up, with a narrower keel beneath.
    const hull = [[0, -2.0], [0.55, -1.35], [0.7, -0.3], [0.62, 0.9], [0.4, 1.6], [0, 1.75], [-0.4, 1.6], [-0.62, 0.9], [-0.7, -0.3], [-0.55, -1.35]];
    b.extrude("hull", "mat:wood", hull, 0.5, [0, 0.12, 0], { plane: "xz", color: palette?.primary });
    b.extrude("keel", "mat:wood", hull.map(([x, z]) => [x * 0.55, z * 0.92]), 0.14, [0, 0, 0], { plane: "xz" });
    b.box("gunwale_l", "mat:wood", [0.07, 0.07, 3.2], [-0.64, 0.64, 0], { rot: [0, -0.02, 0] });
    b.box("gunwale_r", "mat:wood", [0.07, 0.07, 3.2], [0.64, 0.64, 0], { rot: [0, 0.02, 0] });
    b.box("floor", "mat:planks", [1.0, 0.04, 2.6], [0, 0.28, 0]);
    for (const z of [-0.7, 0.5]) b.box(`seat_${z}`, "mat:planks", [1.2, 0.06, 0.28], [0, 0.48, z]);
    for (const s of [-1, 1]) b.cyl(`oar_${s}`, "mat:wood", 0.03, 0.03, 2.2, [s * 0.5, 0.55, 0.1], { rot: [Math.PI / 2, 0, s * 0.15], segments: 6 });
  },

  cart(b) {
    b.box("bed", "mat:planks", [1.3, 0.1, 2.0], [0, 0.75, 0]);
    for (const s of [-1, 1]) b.box(`side_${s}`, "mat:planks", [0.06, 0.4, 2.0], [s * 0.65, 0.98, 0]);
    b.box("back", "mat:planks", [1.3, 0.4, 0.06], [0, 0.98, -1.0]);
    b.cyl("axle", "mat:metal", 0.04, 0.04, 1.7, [0, 0.45, 0.1], { rot: [0, 0, Math.PI / 2], segments: 6 });
    for (const s of [-1, 1]) {
      b.torus(`wheel_rim_${s}`, "mat:wood", 0.42, 0.05, [s * 0.8, 0.45, 0.1], { rot: [0, Math.PI / 2, 0], segments: 20 });
      b.cyl(`wheel_hub_${s}`, "mat:metal", 0.08, 0.08, 0.14, [s * 0.8, 0.45, 0.1], { rot: [0, 0, Math.PI / 2], segments: 8 });
      for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) b.box(`spoke_${s}_${a.toFixed(1)}`, "mat:wood", [0.04, 0.8, 0.04], [s * 0.8, 0.45, 0.1], { rot: [a, 0, 0] });
      b.box(`handle_${s}`, "mat:wood", [0.07, 0.07, 1.4], [s * 0.4, 0.72, 1.6], { rot: [0.1, 0, 0] });
    }
    b.box("sack", "mat:cloth", [0.5, 0.35, 0.6], [0.2, 0.98, -0.3], { color: "#b8a27a" });
  },

  // --------------------------------------------------------------- foliage
  pine_tree(b, { rnd, snowy }) {
    const H = 7 + rnd() * 3;
    b.cyl("trunk", "mat:bark", 0.14, 0.3, H * 0.45, [0, H * 0.225, 0], { segments: 8 });
    const tiers = 4;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const r = (1.9 - t * 1.25) * (0.9 + rnd() * 0.2);
      const h = 2.6 - t * 0.9;
      const y = H * 0.28 + t * H * 0.55 + h / 2;
      b.cone(`canopy_${i}`, "mat:leaves", r, h, [(rnd() - 0.5) * 0.12, y, (rnd() - 0.5) * 0.12], { segments: 9, rot: [0, rnd() * 3, 0] });
      if (snowy) b.cone(`snow_${i}`, "mat:snow", r * 0.72, h * 0.45, [0, y + h * 0.3, 0], { segments: 9 });
    }
    if (!snowy) b.cone("tip", "mat:leaves", 0.35, 0.9, [0, H * 0.28 + H * 0.55 + 1.9, 0], { segments: 7 });
  },

  broadleaf_tree(b, { rnd, seed }) {
    const H = 4.5 + rnd() * 1.5;
    b.lathe("trunk", "mat:bark", [[0.55, 0], [0.34, 0.35], [0.27, 1.2], [0.22, H * 0.7], [0.15, H * 0.8]], [0, 0, 0], { segments: 10 });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + rnd();
      b.cyl(`branch_${i}`, "mat:bark", 0.07, 0.12, 1.6, [Math.sin(a) * 0.5, H * 0.62, Math.cos(a) * 0.5], { rot: [Math.cos(a) * 0.8, 0, -Math.sin(a) * 0.8], segments: 6 });
    }
    // Several displaced lobes read as one irregular crown, not a lollipop.
    const lobes = 5;
    b.ico("crown_core", "mat:leaves", 2.0, [0, H + 0.6, 0], { detail: 2, noise: 0.22, seed, scale: [1, 0.85, 1] });
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2 + rnd() * 0.6;
      const d = 1.2 + rnd() * 0.5, r = 1.1 + rnd() * 0.5;
      b.ico(`crown_${i}`, "mat:leaves", r, [Math.sin(a) * d, H + 0.1 + rnd() * 1.1, Math.cos(a) * d], { detail: 1, noise: 0.28, seed: seed + i + 1, scale: [1, 0.8, 1] });
    }
  },

  palm_tree(b, { rnd }) {
    // Curved trunk from tilted, offset segments; drooping extruded fronds.
    const segs = 6, segH = 1.15, lean = 0.1 + rnd() * 0.08;
    let x = 0, y = 0;
    for (let i = 0; i < segs; i++) {
      const tilt = lean * (i + 1) * 0.55;
      const cx = x + Math.sin(tilt) * segH / 2, cy = y + Math.cos(tilt) * segH / 2;
      b.cyl(`trunk_${i}`, "mat:bark", 0.17 - i * 0.012, 0.2 - i * 0.012, segH + 0.06, [cx, cy, 0], { rot: [0, 0, -tilt], segments: 8 });
      x += Math.sin(tilt) * segH; y += Math.cos(tilt) * segH;
    }
    const frond = [[0, -0.12], [0.8, -0.28], [1.7, -0.22], [2.5, -0.06], [2.7, 0], [2.5, 0.06], [1.7, 0.22], [0.8, 0.28], [0, 0.12]];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.3;
      b.extrude(`frond_${i}`, "mat:leaves", frond, 0.04, [x, y + 0.05, 0], { plane: "xz", rot: [0, a, -0.35 - rnd() * 0.25], cast_shadow: true });
    }
    for (let i = 0; i < 3; i++) b.sphere(`coconut_${i}`, "mat:wood", 0.14, [x + Math.sin(i * 2.1) * 0.22, y - 0.2, Math.cos(i * 2.1) * 0.22], { segments: 8, color: "#5a3d1f" });
  },

  dead_tree(b, { rnd }) {
    const H = 4 + rnd() * 2;
    b.lathe("trunk", "mat:bark", [[0.45, 0], [0.28, 0.3], [0.22, H * 0.5], [0.1, H]], [0, 0, 0], { segments: 8, color: "#8a8178" });
    for (let i = 0; i < 5; i++) {
      const a = rnd() * Math.PI * 2, y = H * (0.4 + i * 0.12), len = 1.6 - i * 0.2, tilt = 0.7 + rnd() * 0.5;
      b.cyl(`branch_${i}`, "mat:bark", 0.03, 0.09, len, [Math.sin(a) * len * 0.4, y + Math.cos(tilt) * len * 0.4, Math.cos(a) * len * 0.4], { rot: [Math.cos(a) * tilt, 0, -Math.sin(a) * tilt], segments: 6, color: "#8a8178" });
    }
    for (let i = 0; i < 3; i++) { const a = i * 2.1; b.cone(`root_${i}`, "mat:bark", 0.15, 0.9, [Math.sin(a) * 0.45, 0.1, Math.cos(a) * 0.45], { rot: [Math.cos(a) * 1.3, 0, -Math.sin(a) * 1.3], segments: 6, color: "#8a8178" }); }
  },

  bush(b, { rnd, seed, palette }) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rnd();
      const r = 0.55 + rnd() * 0.3;
      b.ico(`lobe_${i}`, "mat:leaves", r, [Math.sin(a) * 0.45, r * 0.8, Math.cos(a) * 0.45], { detail: 1, noise: 0.3, seed: seed + i, scale: [1, 0.8, 1] });
    }
    if (rnd() > 0.5) for (let i = 0; i < 3; i++) b.sphere(`berry_${i}`, "mat:cloth", 0.06, [Math.sin(i * 2) * 0.6, 0.9 + i * 0.1, Math.cos(i * 2) * 0.6], { segments: 6, color: palette?.accent || "#b3263a" });
  },

  grass_tuft(b, { rnd }) {
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 0.18, h = 0.35 + rnd() * 0.35, lean = 0.15 + rnd() * 0.35;
      b.cone(`blade_${i}`, "mat:grass", 0.035, h, [Math.sin(a) * d, h / 2, Math.cos(a) * d], { segments: 3, rot: [Math.cos(a) * lean, rnd(), -Math.sin(a) * lean], cast_shadow: false });
    }
  },

  rock_small(b, { rnd, seed, snowy }) {
    b.rock("rock", "mat:rock", 0.4 + rnd() * 0.15, [0, 0.2, 0], { detail: 2, noise: 0.35, seed, scale: [1.2, 0.7, 1] });
    b.rock("pebble", "mat:rock", 0.14, [0.45, 0.06, 0.2], { detail: 1, noise: 0.3, seed: seed + 1, scale: [1.2, 0.6, 1] });
    if (snowy) b.ico("snow_cap", "mat:snow", 0.32, [0, 0.4, 0], { detail: 1, noise: 0.15, seed, scale: [1.2, 0.35, 1] });
  },

  rock_large(b, { rnd, seed, snowy }) {
    b.rock("boulder", "mat:rock", 1.4 + rnd() * 0.4, [0, 0.9, 0], { detail: 3, noise: 0.32, seed, scale: [1.25, 0.8, 1] });
    b.rock("shoulder", "mat:rock", 0.8, [1.3, 0.45, 0.5], { detail: 2, noise: 0.35, seed: seed + 1, scale: [1, 0.75, 1.1] });
    b.rock("chip", "mat:rock", 0.3, [-1.5, 0.12, 0.9], { detail: 1, noise: 0.3, seed: seed + 2, scale: [1.2, 0.6, 1] });
    if (snowy) b.ico("snow_cap", "mat:snow", 1.3, [0, 1.75, 0], { detail: 2, noise: 0.15, seed, scale: [1.2, 0.3, 1] });
  },

  cliff_rock(b, { rnd, seed }) {
    for (let i = 0; i < 4; i++) {
      const r = 2.2 - i * 0.35;
      b.rock(`slab_${i}`, "mat:rock", r, [(rnd() - 0.5) * 1.2, 1.2 + i * 1.7, (rnd() - 0.5) * 0.8], { detail: 2, noise: 0.28, seed: seed + i, scale: [1.3, 0.75, 0.9] });
    }
    b.rock("scree_a", "mat:rock", 0.6, [2.2, 0.3, 1.2], { detail: 1, noise: 0.35, seed: seed + 9, scale: [1.2, 0.6, 1] });
    b.rock("scree_b", "mat:rock", 0.45, [-2.0, 0.22, 1.5], { detail: 1, noise: 0.35, seed: seed + 10, scale: [1.2, 0.6, 1] });
    b.ico("ledge_moss", "mat:grass", 1.2, [0.3, 3.35, 0.2], { detail: 1, noise: 0.2, seed, scale: [1.2, 0.2, 0.9] });
  },

  cactus(b, { rnd, palette }) {
    const H = 2.2 + rnd() * 1.2, green = "#4f7f3a";
    b.capsule("trunk", "mat:leaves", 0.28, H - 0.56, [0, H / 2, 0], { segments: 10, color: green });
    for (const [s, y, up] of [[-1, H * 0.45, 0.8], [1, H * 0.6, 0.6]]) {
      b.capsule(`arm_out_${s}`, "mat:leaves", 0.18, 0.35, [s * 0.45, y, 0], { rot: [0, 0, Math.PI / 2], segments: 8, color: green });
      b.capsule(`arm_up_${s}`, "mat:leaves", 0.18, up, [s * 0.66, y + up / 2 + 0.05, 0], { segments: 8, color: green });
    }
    b.sphere("flower", "mat:cloth", 0.1, [0, H + 0.02, 0], { segments: 8, color: palette?.accent || "#e8577a" });
  },

  crystal_cluster(b, { rnd, seed, palette }) {
    b.rock("base", "mat:rock", 0.7, [0, 0.2, 0], { detail: 1, noise: 0.3, seed, scale: [1.3, 0.5, 1.1] });
    const col = palette?.accent || "#8fd8ff";
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + rnd(), lean = i === 0 ? 0 : 0.25 + rnd() * 0.45;
      const h = i === 0 ? 2.0 : 0.7 + rnd() * 0.9, r = i === 0 ? 0.28 : 0.12 + rnd() * 0.1;
      const d = i === 0 ? 0 : 0.35;
      b.cone(`crystal_${i}`, "mat:crystal", r, h, [Math.sin(a) * (d + Math.sin(lean) * h / 2), 0.3 + Math.cos(lean) * h / 2, Math.cos(a) * (d + Math.sin(lean) * h / 2)], { segments: 6, rot: [Math.cos(a) * lean, 0, -Math.sin(a) * lean], color: col, emissive: true });
    }
  },

  mushroom(b, { rnd, palette }) {
    const cap = palette?.accent || "#b8322a";
    for (let i = 0; i < 3; i++) {
      const s = i === 0 ? 1 : 0.45 + rnd() * 0.3;
      const x = i === 0 ? 0 : (rnd() - 0.5) * 0.9, z = i === 0 ? 0 : (rnd() - 0.5) * 0.9;
      b.lathe(`stem_${i}`, "mat:plaster", [[0.14 * s, 0], [0.1 * s, 0.25 * s], [0.09 * s, 0.55 * s]], [x, 0, z], { segments: 10 });
      b.lathe(`cap_${i}`, "mat:cloth", [[0.08 * s, 0], [0.42 * s, 0.02 * s], [0.4 * s, 0.12 * s], [0.28 * s, 0.26 * s], [0.02 * s, 0.32 * s]], [x, 0.5 * s, z], { segments: 14, color: cap });
      if (i === 0) for (const [sx, sz, a] of ring(5, 0.25)) b.sphere(`spot_${a.toFixed(2)}`, "mat:plaster", 0.04, [sx, 0.5 + 0.2, sz], { segments: 6 });
    }
  },

  flowers(b, { rnd, palette }) {
    const cols = [palette?.accent || "#f2c14e", "#e86a92", "#f7f4ea", palette?.secondary || "#8a7fe0"];
    for (let i = 0; i < 7; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 0.45, h = 0.25 + rnd() * 0.3;
      const x = Math.sin(a) * d, z = Math.cos(a) * d;
      b.cyl(`stem_${i}`, "mat:leaves", 0.012, 0.015, h, [x, h / 2, z], { segments: 4, cast_shadow: false });
      b.ico(`bloom_${i}`, "mat:cloth", 0.06, [x, h + 0.02, z], { detail: 0, noise: 0.1, seed: i, scale: [1, 0.5, 1], color: cols[i % cols.length] });
    }
    for (let i = 0; i < 3; i++) b.ico(`leaf_${i}`, "mat:leaves", 0.14, [Math.sin(i * 2.1) * 0.2, 0.04, Math.cos(i * 2.1) * 0.2], { detail: 0, noise: 0.1, seed: 9 + i, scale: [1.4, 0.25, 0.7] });
  },

  reeds(b, { rnd }) {
    for (let i = 0; i < 10; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 0.4, h = 1.0 + rnd() * 0.8, lean = rnd() * 0.18;
      const x = Math.sin(a) * d, z = Math.cos(a) * d;
      b.cyl(`reed_${i}`, "mat:grass", 0.012, 0.022, h, [x, h / 2, z], { segments: 4, rot: [Math.cos(a) * lean, 0, -Math.sin(a) * lean], cast_shadow: false });
      if (i % 2 === 0) b.capsule(`cattail_${i}`, "mat:bark", 0.035, 0.16, [x + Math.sin(a) * Math.sin(lean) * h, h + 0.02, z + Math.cos(a) * Math.sin(lean) * h], { rot: [Math.cos(a) * lean, 0, -Math.sin(a) * lean], segments: 6 });
    }
  },

  // --------------------------------------------------------------- pickups
  // ~0.5 m, centred a little above y = 0 so a runtime bob/spin reads well.
  lantern_core(b, { palette }) {
    b.ico("core", "mat:glow", 0.16, [0, 0.35, 0], { detail: 1, noise: 0.05, seed: 1, color: palette?.accent || "#ffd27a" });
    b.torus("cage_a", "mat:brass", 0.22, 0.018, [0, 0.35, 0], { segments: 20 });
    b.torus("cage_b", "mat:brass", 0.22, 0.018, [0, 0.35, 0], { rot: [0, Math.PI / 2, 0], segments: 20 });
    b.cyl("cap_top", "mat:brass", 0.05, 0.08, 0.06, [0, 0.59, 0], { segments: 8 });
    b.cyl("cap_bottom", "mat:brass", 0.08, 0.05, 0.06, [0, 0.11, 0], { segments: 8 });
    b.torus("loop", "mat:brass", 0.04, 0.012, [0, 0.66, 0], { segments: 10 });
  },

  relic(b, { palette }) {
    b.lathe("urn", "mat:brass", [[0.08, 0], [0.12, 0.03], [0.07, 0.08], [0.15, 0.2], [0.17, 0.3], [0.1, 0.42], [0.08, 0.48], [0.11, 0.52]], [0, 0.08, 0], { segments: 16 });
    b.cone("gem", "mat:crystal", 0.05, 0.08, [0, 0.66, 0], { segments: 6, color: palette?.accent || "#6fd3ff", emissive: true });
    b.torus("band", "mat:brass", 0.16, 0.012, [0, 0.33, 0], { rot: [Math.PI / 2, 0, 0], segments: 16 });
  },

  gem(b, { palette }) {
    const col = palette?.accent || "#46d1a0";
    b.cone("crown", "mat:crystal", 0.18, 0.14, [0, 0.42, 0], { segments: 8, color: col, emissive: true });
    b.cone("pavilion", "mat:crystal", 0.18, 0.28, [0, 0.21, 0], { segments: 8, rot: [Math.PI, 0, 0], color: col, emissive: true });
  },

  key(b) {
    b.torus("bow", "mat:brass", 0.08, 0.022, [0, 0.55, 0], { segments: 16 });
    b.cyl("shaft", "mat:brass", 0.018, 0.018, 0.34, [0, 0.3, 0], { segments: 8 });
    b.box("bit_a", "mat:brass", [0.08, 0.035, 0.02], [0.04, 0.17, 0]);
    b.box("bit_b", "mat:brass", [0.06, 0.035, 0.02], [0.03, 0.23, 0]);
    b.sphere("collar", "mat:brass", 0.03, [0, 0.47, 0], { segments: 8 });
  },

  scroll(b, { palette }) {
    b.cyl("paper", "mat:plaster", 0.07, 0.07, 0.42, [0, 0.3, 0], { rot: [0, 0, Math.PI / 2], segments: 12, color: "#efe2c0" });
    for (const s of [-1, 1]) b.cyl(`rod_${s}`, "mat:wood", 0.025, 0.025, 0.08, [s * 0.25, 0.3, 0], { rot: [0, 0, Math.PI / 2], segments: 8 });
    for (const s of [-1, 1]) b.sphere(`knob_${s}`, "mat:brass", 0.035, [s * 0.3, 0.3, 0], { segments: 8 });
    b.torus("ribbon", "mat:cloth", 0.074, 0.012, [0, 0.3, 0], { rot: [0, Math.PI / 2, 0], segments: 14, color: palette?.accent || "#b3263a" });
  },

  herb(b, { palette }) {
    b.cyl("stem", "mat:leaves", 0.012, 0.016, 0.4, [0, 0.3, 0], { segments: 5 });
    for (let i = 0; i < 4; i++) {
      const a = i * 1.6;
      b.ico(`leaf_${i}`, "mat:leaves", 0.08, [Math.sin(a) * 0.07, 0.2 + i * 0.08, Math.cos(a) * 0.07], { detail: 0, noise: 0.05, seed: i, scale: [1.6, 0.3, 0.7], rot: [0, a, 0.4] });
    }
    b.sphere("bud", "mat:glow", 0.04, [0, 0.52, 0], { segments: 8, color: palette?.accent || "#b7f06a" });
  },

  shard(b, { palette, rnd }) {
    const col = palette?.accent || "#9ad8ff";
    b.cone("shard_main", "mat:crystal", 0.09, 0.55, [0, 0.4, 0], { segments: 4, rot: [0.15, 0, 0.1], color: col, emissive: true });
    b.cone("shard_b", "mat:crystal", 0.06, 0.3, [0.08, 0.25, 0.03], { segments: 4, rot: [0, rnd(), -0.5], color: col, emissive: true });
    b.cone("shard_c", "mat:crystal", 0.05, 0.25, [-0.07, 0.22, -0.02], { segments: 4, rot: [0.2, 0, 0.55], color: col, emissive: true });
  },
};

// ---------------------------------------------------------------- geometry

function rotate([x, y, z], r) {
  // Euler XYZ as Three.js applies it: v' = Rx · Ry · Rz · v
  let c = Math.cos(r.z), s = Math.sin(r.z);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(r.y); s = Math.sin(r.y);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(r.x); s = Math.sin(r.x);
  [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y, z];
}

/** Local AABB of a part before its own transform: { c:[x,y,z], h:[hx,hy,hz] }. */
function localBox(p) {
  switch (p.shape) {
    case "box": return { c: [0, 0, 0], h: [p.size.x / 2, p.size.y / 2, p.size.z / 2] };
    case "cylinder": { const r = Math.max(p.radius_top ?? 0, p.radius_bottom ?? 0, p.radius ?? 0); return { c: [0, 0, 0], h: [r, p.height / 2, r] }; }
    case "cone": return { c: [0, 0, 0], h: [p.radius, p.height / 2, p.radius] };
    case "sphere": return { c: [0, 0, 0], h: [p.radius, p.radius, p.radius] };
    case "capsule": return { c: [0, 0, 0], h: [p.radius, p.height / 2 + p.radius, p.radius] };
    case "torus": return { c: [0, 0, 0], h: [p.radius + p.tube, p.radius + p.tube, p.tube] };
    case "lathe": {
      let rmax = 0, y0 = Infinity, y1 = -Infinity;
      for (const [r, y] of p.profile) { rmax = Math.max(rmax, r); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      return { c: [0, (y0 + y1) / 2, 0], h: [rmax, (y1 - y0) / 2, rmax] };
    }
    case "extrude": {
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [a, bb] of p.outline) { a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, bb); b1 = Math.max(b1, bb); }
      return p.outline_plane === "xy"
        ? { c: [(a0 + a1) / 2, (b0 + b1) / 2, 0], h: [(a1 - a0) / 2, (b1 - b0) / 2, p.depth / 2] }
        : { c: [(a0 + a1) / 2, p.depth / 2, (b0 + b1) / 2], h: [(a1 - a0) / 2, p.depth / 2, (b1 - b0) / 2] };
    }
    case "rock": case "icosphere": { const r = p.radius * (1 + (p.noise || 0)); return { c: [0, 0, 0], h: [r, r, r] }; }
    default: return { c: [0, 0, 0], h: [0.5, 0.5, 0.5] };
  }
}

// A pure yaw of a body of revolution leaves its AABB unchanged; skipping it
// stops a 45°-turned square roof from inflating the footprint by √2.
const Y_SYMMETRIC = new Set(["cylinder", "cone", "sphere", "capsule", "lathe", "rock", "icosphere"]);
const ySymmetric = (p) => Y_SYMMETRIC.has(p.shape) && !p.rotation?.x && !p.rotation?.z && (!p.scale || p.scale.x === p.scale.z);

/** World-space AABB of a whole recipe: { w, h, d, min, max }. */
export function computeBounds(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const { c, h } = localBox(p);
    const s = p.scale ? [p.scale.x, p.scale.y, p.scale.z] : [1, 1, 1];
    for (let k = 0; k < 8; k++) {
      const corner = [(c[0] + (k & 1 ? h[0] : -h[0])) * s[0], (c[1] + (k & 2 ? h[1] : -h[1])) * s[1], (c[2] + (k & 4 ? h[2] : -h[2])) * s[2]];
      const w = rotate(corner, ySymmetric(p) ? { x: 0, y: 0, z: 0 } : p.rotation || { x: 0, y: 0, z: 0 });
      const q = [w[0] + p.position.x, w[1] + p.position.y, w[2] + p.position.z];
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], q[i]); hi[i] = Math.max(hi[i], q[i]); }
    }
  }
  if (!parts.length) return { w: 0, h: 0, d: 0, min: vec(), max: vec() };
  return { w: r3(hi[0] - lo[0]), h: r3(hi[1] - lo[1]), d: r3(hi[2] - lo[2]), min: vec(lo), max: vec(hi) };
}

/** Triangle estimate per part, matching the Three.js geometry the runtime builds. */
export function partTriangles(p) {
  const seg = p.segments || 16;
  switch (p.shape) {
    case "box": return 12;
    case "cylinder": return seg * 4;
    case "cone": return seg * 3;
    case "sphere": return seg * Math.max(3, Math.round(seg * 0.6)) * 2;
    case "capsule": return Math.min(seg, 12) * 14;             // 3 cap rings each end + body
    case "torus": return seg * 6 * 2;                           // 6 tube segments
    case "lathe": return Math.max(1, p.profile.length - 1) * seg * 2;
    case "extrude": { const n = p.outline.length; return 2 * n + 2 * Math.max(0, n - 2); }
    case "rock": case "icosphere": return 20 * Math.pow(4, clamp(p.detail ?? 1, 0, 4));
    default: return 12;
  }
}

export function estimateTriangles(recipe) {
  return (recipe?.parts || []).reduce((n, p) => n + partTriangles(p), 0);
}

// ------------------------------------------------------------------- public

function finish(parts, extra) {
  if (parts.length > MAX_PARTS) parts.length = MAX_PARTS;     // hard cap: perf budget beats one more rivet
  const recipe = { builder: "parts", bounds: computeBounds(parts), parts, ...extra };
  recipe.est_triangles = estimateTriangles(recipe);
  return recipe;
}

/**
 * Build the mesh recipe for a library name. Unknown names resolve to the
 * nearest entry and carry a warning (never a throw).
 * @returns {{builder:"parts", bounds, parts, lib, role, est_triangles, warnings?, requested?}}
 */
export function buildMeshRecipe(libName, { seed = 0, palette = null, biome = null, role = null } = {}) {
  const resolved = nearestLibName(libName, { role });
  const name = resolved.name;
  const s = ((seed | 0) ^ hashString(name)) >>> 0;
  const rr = seeded(s);
  const ctx = { rnd: rr.next, seed: s % 100000, palette: palette || null, biome: biome || null, snowy: biome === "snow" };
  const b = builder();
  LIB[name](b, ctx);
  const extra = { lib: name, role: libRole(name) };
  if (!resolved.exact) { extra.requested = String(libName); extra.warnings = [resolved.warning]; }
  return finish(b.parts, extra);
}

// ---------------------------------------------------------------- characters

const BUILD_WIDTH = { slim: 0.86, average: 1, broad: 1.2 };
const clampH = (h, lo, hi, d) => (Number.isFinite(h) ? clamp(h, lo, hi) : d);

function joint(pivot, parent, axis = "x", swing = 0.5) { return { pivot: vec(pivot), parent, axis, swing: r3(swing) }; }

function accessories(b, list, d, warn) {
  const { H, shoulderY, headY, headR, torsoW, pal, handY, armX } = d;
  for (const acc of list || []) {
    switch (acc) {
      case "hat":
        b.cyl("hat_brim", "mat:cloth", headR * 1.9, headR * 1.9, 0.02 * H, [0, headY + headR * 0.55, 0], { segments: 16, color: pal.accent, joint: "neck" });
        b.cyl("hat_crown", "mat:cloth", headR * 0.8, headR * 1.0, headR * 1.1, [0, headY + headR * 1.05, 0], { segments: 12, color: pal.accent, joint: "neck" });
        break;
      case "hood":
        b.ico("hood", "mat:cloth", headR * 1.28, [0, headY + headR * 0.1, -headR * 0.18], { detail: 1, noise: 0.04, seed: 5, scale: [1, 1.05, 1.05], color: pal.secondary, joint: "neck" });
        break;
      case "cape":
        b.box("cape", "mat:cloth", [torsoW * 2.1, (shoulderY - 0.12 * H), 0.03 * H], [0, shoulderY - (shoulderY - 0.12 * H) / 2, -torsoW * 0.75], { rot: [0.08, 0, 0], color: pal.accent, joint: "spine" });
        break;
      case "lantern":
        b.cyl("lantern_handle", "mat:metal", 0.006 * H, 0.006 * H, 0.08 * H, [armX, handY - 0.05 * H, 0.03 * H], { segments: 4, joint: "shoulder_r" });
        b.cyl("lantern", "mat:glow", 0.035 * H, 0.03 * H, 0.07 * H, [armX, handY - 0.12 * H, 0.03 * H], { segments: 6, color: "#ffd27a", joint: "shoulder_r" });
        break;
      case "backpack":
        b.box("backpack", "mat:cloth", [torsoW * 1.3, 0.2 * H, 0.1 * H], [0, shoulderY - 0.13 * H, -torsoW * 0.9], { color: "#6d4f3a", joint: "spine" });
        b.cyl("bedroll", "mat:cloth", 0.035 * H, 0.035 * H, torsoW * 1.5, [0, shoulderY - 0.01 * H, -torsoW * 0.9], { rot: [0, 0, Math.PI / 2], segments: 8, color: pal.secondary, joint: "spine" });
        break;
      case "staff":
        b.cyl("staff", "mat:wood", 0.012 * H, 0.014 * H, 1.05 * H, [-armX - 0.02 * H, handY + 0.2 * H, 0.04 * H], { segments: 6, joint: "shoulder_l" });
        b.sphere("staff_orb", "mat:glow", 0.03 * H, [-armX - 0.02 * H, handY + 0.74 * H, 0.04 * H], { segments: 8, color: pal.accent, joint: "shoulder_l" });
        break;
      case "goggles":
        for (const s of [-1, 1]) b.torus(`goggle_${s}`, "mat:brass", headR * 0.28, headR * 0.07, [s * headR * 0.38, headY + headR * 0.25, headR * 0.88], { segments: 12, joint: "neck" });
        break;
      case "scarf":
        b.torus("scarf", "mat:cloth", torsoW * 0.62, 0.025 * H, [0, shoulderY + 0.005 * H, 0], { rot: [Math.PI / 2, 0, 0], segments: 16, color: pal.accent, joint: "spine" });
        break;
      case "satchel":
        b.box("satchel", "mat:cloth", [0.1 * H, 0.08 * H, 0.04 * H], [torsoW * 1.05, shoulderY - 0.24 * H, 0.02 * H], { color: "#7a5a3a", joint: "spine" });
        b.box("satchel_strap", "mat:cloth", [0.015 * H, 0.32 * H, torsoW * 1.2], [0, shoulderY - 0.1 * H, 0], { rot: [0, 0, 0.7], color: "#5a3f28", joint: "spine" });
        break;
      default: warn(`unsupported accessory '${acc}' ignored`);
    }
  }
}

function biped(b, c, robot) {
  const H = clampH(c.body?.height, 0.6, 4, 1.75);
  const wf = BUILD_WIDTH[c.body?.build] ?? 1;
  const pal = { skin: "#d9a882", primary: "#5a6f8f", secondary: "#3d3a36", accent: "#c8963e", ...(c.body?.palette || {}) };
  const skinMat = robot ? "mat:metal" : "mat:plaster";
  const clothMat = robot ? "mat:metal" : "mat:cloth";
  const hipY = 0.47 * H, torsoLen = 0.3 * H, shoulderY = hipY + torsoLen;
  const headR = 0.072 * H, headY = shoulderY + 0.035 * H + headR;
  const torsoW = 0.13 * H * wf, legR = 0.05 * H * wf, armR = 0.036 * H * wf;
  const legX = 0.065 * H * wf, armX = torsoW + armR + 0.005 * H;
  const handY = shoulderY - 0.4 * H;

  // Legs: capsule thigh+shin in one, plus a foot, both riding the hip joint.
  for (const [s, side] of [[-1, "l"], [1, "r"]]) {
    const len = hipY - 0.05 * H;
    b.capsule(`leg_${side}`, clothMat, legR, Math.max(0.01, len - 2 * legR), [s * legX, hipY - len / 2, 0], { color: robot ? pal.secondary : pal.secondary, joint: `hip_${side}` });
    b.box(`foot_${side}`, robot ? "mat:metal" : "mat:wood", [legR * 2.2, 0.05 * H, 0.14 * H], [s * legX, 0.025 * H, 0.025 * H], { color: robot ? pal.accent : "#3b2a1d", joint: `hip_${side}` });
  }
  b.box("pelvis", clothMat, [torsoW * 2, 0.08 * H, torsoW * 1.3], [0, hipY, 0], { color: pal.secondary, joint: "root" });
  if (robot) {
    b.box("torso", "mat:metal", [torsoW * 2, torsoLen, torsoW * 1.4], [0, hipY + torsoLen / 2, 0], { color: pal.primary, joint: "spine" });
    b.box("chest_light", "mat:glow", [torsoW * 0.6, torsoW * 0.4, 0.02 * H], [0, hipY + torsoLen * 0.65, torsoW * 0.71], { color: pal.accent, joint: "spine" });
  } else {
    b.lathe("torso", "mat:cloth", [[torsoW * 0.92, 0], [torsoW * 1.0, torsoLen * 0.35], [torsoW * 1.08, torsoLen * 0.75], [torsoW * 0.7, torsoLen], [0.03 * H, torsoLen + 0.01 * H]], [0, hipY - 0.01 * H, 0], { segments: 14, scale: [1, 1, 0.72], color: pal.primary, joint: "spine" });
    b.cyl("belt", "mat:cloth", torsoW * 0.95, torsoW * 0.95, 0.03 * H, [0, hipY + 0.02 * H, 0], { segments: 14, scale: [1, 1, 0.74], color: "#3b2a1d", joint: "spine" });
  }
  for (const [s, side] of [[-1, "l"], [1, "r"]]) {
    const len = shoulderY - handY;
    b.capsule(`arm_${side}`, robot ? "mat:metal" : clothMat, armR, Math.max(0.01, len - 2 * armR), [s * armX, shoulderY - len / 2, 0], { color: pal.primary, joint: `shoulder_${side}` });
    b.sphere(`hand_${side}`, skinMat, armR * 1.15, [s * armX, handY - armR * 0.3, 0], { segments: 10, color: robot ? pal.accent : pal.skin, joint: `shoulder_${side}` });
  }
  b.cyl("neck", skinMat, 0.03 * H, 0.035 * H, 0.05 * H, [0, shoulderY + 0.02 * H, 0], { segments: 8, color: robot ? pal.secondary : pal.skin, joint: "neck" });
  if (robot) {
    b.box("head", "mat:metal", [headR * 2, headR * 1.8, headR * 1.8], [0, headY, 0], { color: pal.primary, joint: "neck" });
    b.box("visor", "mat:glow", [headR * 1.6, headR * 0.4, 0.02 * H], [0, headY + headR * 0.15, headR * 0.91], { color: pal.accent, joint: "neck" });
    b.cyl("antenna", "mat:metal", 0.005 * H, 0.005 * H, 0.1 * H, [headR * 0.5, headY + headR + 0.05 * H, 0], { segments: 4, joint: "neck" });
    b.sphere("antenna_tip", "mat:glow", 0.012 * H, [headR * 0.5, headY + headR + 0.1 * H, 0], { segments: 6, color: pal.accent, joint: "neck" });
  } else {
    b.sphere("head", "mat:plaster", headR, [0, headY, 0], { segments: 16, scale: [0.92, 1.05, 0.98], color: pal.skin, joint: "neck" });
    b.ico("hair", "mat:cloth", headR * 1.04, [0, headY + headR * 0.22, -headR * 0.12], { detail: 1, noise: 0.08, seed: hashString(c.id || "x") % 1000, scale: [1, 0.8, 1], color: pal.secondary, joint: "neck" });
    for (const s of [-1, 1]) b.sphere(`eye_${s < 0 ? "l" : "r"}`, "mat:metal", headR * 0.11, [s * headR * 0.36, headY + headR * 0.12, headR * 0.86], { segments: 6, color: "#1b1b1f", joint: "neck" });
    b.sphere("nose", "mat:plaster", headR * 0.14, [0, headY - headR * 0.08, headR * 0.95], { segments: 6, color: pal.skin, joint: "neck" });
  }
  const d = { H, shoulderY, headY, headR, torsoW, pal, handY, armX };
  const rig = {
    kind: "biped",
    joints: {
      root: joint([0, hipY, 0], null, "y", 0.05),
      spine: joint([0, hipY, 0], "root", "x", 0.08),
      neck: joint([0, shoulderY + 0.02 * H, 0], "spine", "x", 0.15),
      shoulder_l: joint([-armX, shoulderY - armR, 0], "spine", "x", 0.55),
      shoulder_r: joint([armX, shoulderY - armR, 0], "spine", "x", 0.55),
      hip_l: joint([-legX, hipY, 0], "root", "x", 0.6),
      hip_r: joint([legX, hipY, 0], "root", "x", 0.6),
    },
    gait: { stride_m: r3(0.75 * H * 0.47 * 1.6), phase: { hip_l: 0, hip_r: 0.5, shoulder_l: 0.5, shoulder_r: 0 } },
  };
  return { d, rig };
}

function quadruped(b, c) {
  const H = clampH(c.body?.height, 0.3, 3, 0.9);           // shoulder height
  const wf = BUILD_WIDTH[c.body?.build] ?? 1;
  const pal = { skin: "#8a6a4a", primary: "#7a5b3e", secondary: "#4a3a2a", accent: "#e0b050", ...(c.body?.palette || {}) };
  const legLen = 0.55 * H, bodyR = 0.24 * H * wf, bodyLen = 1.0 * H, bodyY = legLen + bodyR * 0.7;
  b.capsule("body", "mat:cloth", bodyR, bodyLen, [0, bodyY, 0], { rot: [Math.PI / 2, 0, 0], color: pal.primary, joint: "root" });
  b.ico("chest", "mat:cloth", bodyR * 1.1, [0, bodyY + bodyR * 0.05, bodyLen * 0.4], { detail: 1, noise: 0.06, seed: 3, color: pal.primary, joint: "root" });
  const legs = [["fl", -1, 1], ["fr", 1, 1], ["bl", -1, -1], ["br", 1, -1]];
  for (const [n, sx, sz] of legs) {
    const x = sx * bodyR * 0.62, z = sz * bodyLen * 0.42;
    b.capsule(`leg_${n}`, "mat:cloth", 0.06 * H * wf, legLen - 0.12 * H, [x, legLen / 2 + 0.02 * H, z], { color: pal.secondary, joint: `hip_${n}` });
    b.sphere(`paw_${n}`, "mat:cloth", 0.075 * H * wf, [x, 0.05 * H, z + 0.03 * H], { segments: 8, scale: [1, 0.6, 1.3], color: pal.secondary, joint: `hip_${n}` });
  }
  const neckZ = bodyLen * 0.62, headY = bodyY + 0.32 * H, headZ = bodyLen * 0.85;
  b.cyl("neck", "mat:cloth", 0.1 * H, 0.14 * H * wf, 0.35 * H, [0, bodyY + 0.16 * H, neckZ], { rot: [0.6, 0, 0], segments: 10, color: pal.primary, joint: "neck" });
  b.sphere("head", "mat:cloth", 0.17 * H, [0, headY, headZ], { segments: 14, color: pal.primary, joint: "neck" });
  b.cone("snout", "mat:cloth", 0.09 * H, 0.22 * H, [0, headY - 0.04 * H, headZ + 0.2 * H], { rot: [Math.PI / 2, 0, 0], segments: 10, color: pal.skin, joint: "neck" });
  b.sphere("nose", "mat:metal", 0.03 * H, [0, headY - 0.04 * H, headZ + 0.31 * H], { segments: 6, color: "#1b1b1f", joint: "neck" });
  for (const s of [-1, 1]) {
    b.cone(`ear_${s < 0 ? "l" : "r"}`, "mat:cloth", 0.05 * H, 0.14 * H, [s * 0.09 * H, headY + 0.17 * H, headZ - 0.02 * H], { rot: [-0.2, 0, -s * 0.3], segments: 6, color: pal.secondary, joint: "neck" });
    b.sphere(`eye_${s < 0 ? "l" : "r"}`, "mat:glow", 0.025 * H, [s * 0.08 * H, headY + 0.05 * H, headZ + 0.14 * H], { segments: 6, color: pal.accent, joint: "neck" });
  }
  b.cone("tail", "mat:cloth", 0.06 * H, 0.5 * H, [0, bodyY + 0.12 * H, -bodyLen * 0.75], { rot: [-2.1, 0, 0], segments: 8, color: pal.secondary, joint: "tail" });
  const rig = {
    kind: "quadruped",
    joints: {
      root: joint([0, bodyY, 0], null, "y", 0.04),
      neck: joint([0, bodyY + 0.1 * H, neckZ - 0.1 * H], "root", "x", 0.15),
      tail: joint([0, bodyY + 0.05 * H, -bodyLen * 0.55], "root", "y", 0.4),
      ...Object.fromEntries(legs.map(([n, sx, sz]) => [`hip_${n}`, joint([sx * bodyR * 0.62, legLen, sz * bodyLen * 0.42], "root", "x", 0.55)])),
    },
    gait: { stride_m: r3(0.9 * H), phase: { hip_fl: 0, hip_br: 0, hip_fr: 0.5, hip_bl: 0.5 } },
  };
  return { rig, pal, H };
}

function spirit(b, c) {
  const H = clampH(c.body?.height, 0.5, 4, 1.6);
  const pal = { skin: "#cfefff", primary: "#7fd6ff", secondary: "#3a6f9f", accent: "#fff2a8", ...(c.body?.palette || {}) };
  const hover = 0.25 * H;
  b.lathe("robe", "mat:crystal", [[0.02 * H, 0], [0.16 * H, 0.1 * H], [0.22 * H, 0.35 * H], [0.16 * H, 0.55 * H], [0.08 * H, 0.62 * H]], [0, hover, 0], { segments: 16, color: pal.primary, joint: "core" });
  b.ico("core", "mat:glow", 0.09 * H, [0, hover + 0.42 * H, 0], { detail: 1, noise: 0.1, seed: 2, color: pal.accent, joint: "core" });
  b.sphere("head", "mat:glow", 0.11 * H, [0, hover + 0.72 * H, 0], { segments: 14, color: pal.skin, joint: "core" });
  for (const s of [-1, 1]) {
    b.capsule(`arm_${s < 0 ? "l" : "r"}`, "mat:crystal", 0.035 * H, 0.22 * H, [s * 0.24 * H, hover + 0.45 * H, 0.02 * H], { rot: [0, 0, s * 0.5], color: pal.primary, joint: s < 0 ? "arm_l" : "arm_r" });
    b.sphere(`eye_${s < 0 ? "l" : "r"}`, "mat:metal", 0.018 * H, [s * 0.04 * H, hover + 0.74 * H, 0.1 * H], { segments: 6, color: "#10202f", joint: "core" });
  }
  b.torus("halo", "mat:glow", 0.12 * H, 0.01 * H, [0, hover + 0.9 * H, 0], { rot: [Math.PI / 2, 0, 0], segments: 24, color: pal.accent, joint: "core" });
  b.torus("wisp_ring", "mat:crystal", 0.24 * H, 0.012 * H, [0, hover + 0.05 * H, 0], { rot: [Math.PI / 2, 0, 0], segments: 24, color: pal.secondary, joint: "core" });
  const rig = {
    kind: "hover",
    joints: {
      core: joint([0, hover + 0.4 * H, 0], null, "y", 0.1),
      arm_l: joint([-0.14 * H, hover + 0.52 * H, 0], "core", "z", 0.35),
      arm_r: joint([0.14 * H, hover + 0.52 * H, 0], "core", "z", 0.35),
    },
    hover: { height_m: r3(hover), bob_m: r3(0.05 * H), period_s: 2.4 },
  };
  return { rig, pal, H };
}

/**
 * Character mesh recipe with a rig (§4.2 "Characters"). Every part names the
 * joint it rides on; joints give pivot, parent, swing axis and amplitude so the
 * runtime can drive a procedural walk cycle without skinning.
 */
export function buildCharacterRecipe(character) {
  const c = character || {};
  const kind = ["humanoid", "creature", "robot", "spirit"].includes(c.kind) ? c.kind : "humanoid";
  const b = builder();
  const warnings = [];
  const warn = (m) => warnings.push(m);
  let rig;
  if (kind === "creature") {
    const q = quadruped(b, c);
    rig = q.rig;
    for (const acc of c.body?.accessories || []) {
      if (acc === "scarf") b.torus("scarf", "mat:cloth", 0.13 * q.H, 0.03 * q.H, [0, q.H * 0.95, q.H * 0.55], { rot: [1.0, 0, 0], color: q.pal.accent, joint: "neck" });
      else if (acc === "backpack" || acc === "satchel") b.box("saddle_bag", "mat:cloth", [0.55 * q.H, 0.2 * q.H, 0.3 * q.H], [0, q.H * 0.9, -0.1 * q.H], { color: "#6d4f3a", joint: "root" });
      else warn(`accessory '${acc}' does not fit a creature and was skipped`);
    }
  } else if (kind === "spirit") {
    rig = spirit(b, c).rig;
    if ((c.body?.accessories || []).length) warn("spirits ignore accessories");
  } else {
    const r = biped(b, c, kind === "robot");
    rig = r.rig;
    accessories(b, c.body?.accessories, r.d, warn);
  }
  const extra = { character_ref: c.id ?? null, character_kind: kind, rig };
  if (warnings.length) extra.warnings = warnings;
  return finish(b.parts, extra);
}
