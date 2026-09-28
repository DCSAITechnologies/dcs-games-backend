// Games-B expand hook. Node-side.
//
// "Add a flooded chapel to the east." Expansion grows a finished game without
// regenerating it: it finds free, walkable, reachable ground in the requested
// direction, and adds a new region with a landmark, a focal interactable, a
// pickup, a checkpoint, a path from the nearest existing region and two
// OPTIONAL objectives. Optional on purpose — an expansion must never change
// whether the original game can be won, only add to it.
//
// Every existing id is preserved (the tests assert it), new ids are
// `*_exp_<n>`, and the result is deterministic in (package, prompt, direction).
// Only assets already shipped in the package are reused, so an expansion never
// introduces an unresolved asset ref; new geometry is the asset stage's job.

import { seal } from "../runtime/assemble.mjs";
import { validatePackage } from "../runtime/validate-package.mjs";
import { rederive } from "./edit.mjs";
import { hashString } from "../common/rng.mjs";

// +z is south in world space (three.js cameras look down -z, "forward/north").
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], northeast: [0.7, -0.7], northwest: [-0.7, -0.7], southeast: [0.7, 0.7], southwest: [-0.7, 0.7] };
const THEMES = [
  { words: ["shrine", "temple", "chapel", "altar", "sacred"], lib: ["shrine", "altar", "statue", "obelisk"], ix: "altar", kind: "landmark" },
  { words: ["tower", "lookout", "beacon", "lighthouse", "summit"], lib: ["watchtower", "lighthouse", "beacon_brazier"], ix: "lantern", kind: "landmark" },
  { words: ["ruin", "ruins", "crypt", "tomb", "vault", "cave"], lib: ["ruin_arch", "ruin_wall", "ruin_pillar"], ix: "container", kind: "landmark" },
  { words: ["camp", "outpost", "tent", "caravan"], lib: ["tent", "campfire"], ix: "sign", kind: "district" },
  { words: ["village", "hamlet", "house", "cottage", "town"], lib: ["cottage", "stone_hut"], ix: "door", kind: "district" },
  { words: ["dock", "pier", "harbor", "harbour", "boat"], lib: ["dock", "boat"], ix: "sign", kind: "district" },
  { words: ["well", "garden", "grove", "spring"], lib: ["well", "statue"], ix: "altar", kind: "wilderness" },
];

const tryImport = async (p) => { try { return await import(p); } catch { return null; } };

function titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }

function nameFrom(prompt, fallback) {
  const words = String(prompt || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter((w) => w && !["a", "an", "the", "add", "to", "of", "in", "on", "with", "and", "new", "some", "please", "make", "build", "create", "north", "south", "east", "west"].includes(w));
  return words.length ? titleCase(words.slice(0, 3).join(" ")) : fallback;
}

function overlaps(a, b, gap) {
  return !(a[2] + gap <= b[0] || b[2] + gap <= a[0] || a[3] + gap <= b[1] || b[3] + gap <= a[1]);
}

/**
 * @param {object} pkg sealed GamePackage
 * @param {{prompt?: string, direction?: string, deps?: object}} opts
 * @returns {Promise<{pkg, added: {region, placements, interactables, items, objectives, spawns, paths}}>}
 */
export async function expandWorld(pkg, { prompt = "", direction, deps } = {}) {
  deps = deps || (await tryImport("../runtime/deps.mjs"))?.realDeps;
  if (!deps) throw new Error("expandWorld: world/nav modules are unavailable");
  const next = JSON.parse(JSON.stringify(pkg));
  const w = next.world;
  const nav = w.navigation;
  const records = next.assets.records;
  const has = (ref) => records.some((r) => r.ref === ref);

  let n = 1;
  while (w.regions.some((r) => r.id === `region_exp_${n}`)) n++;
  const tag = `exp_${n}`;
  const lower = String(prompt).toLowerCase();
  const theme = THEMES.find((t) => t.words.some((x) => lower.includes(x))) || THEMES[0];
  const dirKey = direction && DIRS[direction] ? direction : Object.keys(DIRS).find((d) => lower.includes(d)) || Object.keys(DIRS)[hashString(`${pkg.game_id}|${prompt}|${n}`) % 4];
  const [dx, dz] = DIRS[dirKey];

  // Landmark asset: a themed lib ref the package already ships, else any
  // structure it already places.
  const structRef = theme.lib.map((l) => `lib:${l}`).find(has)
    || w.placements.find((p) => (p.role === "landmark" || p.role === "structure") && has(p.asset_ref))?.asset_ref;
  const pickupRef = w.placements.find((p) => p.role === "pickup" && has(p.asset_ref))?.asset_ref
    || ["gem", "relic", "shard", "scroll", "key", "herb", "lantern_core"].map((l) => `lib:${l}`).find(has);
  if (!structRef || !pickupRef) throw new Error("expandWorld: the package ships no reusable structure/pickup asset");
  const structRec = records.find((r) => r.ref === structRef);
  const colR = Math.max(1, Math.min(4, Math.max(structRec?.dimensions?.w || 2, structRec?.dimensions?.d || 2) * 0.45));

  // ---- choose ground: free of other regions, mostly walkable, reachable.
  const side = Math.max(20, Math.min(40, Math.round(w.size.w * 0.14)));
  const spawn = w.spawn_points.find((s) => s.id === "spawn_player") || w.spawn_points.find((s) => s.kind === "player");
  const start = deps.nav.isWalkable(nav, spawn.position.x, spawn.position.z) ? spawn.position : cellNear(nav, deps, spawn.position.x, spawn.position.z, 4);
  const cx0 = w.size.w / 2, cz0 = w.size.h / 2;
  const cands = [];
  for (let z = side / 2 + nav.cell * 2; z <= w.size.h - side / 2 - nav.cell * 2; z += nav.cell * 2) {
    for (let x = side / 2 + nav.cell * 2; x <= w.size.w - side / 2 - nav.cell * 2; x += nav.cell * 2) {
      const b = [x - side / 2, z - side / 2, x + side / 2, z + side / 2];
      if (w.regions.some((r) => overlaps(b, r.bounds, 4))) continue;
      let walk = 0, tot = 0;
      for (let zz = b[1] + nav.cell / 2; zz < b[3]; zz += nav.cell) for (let xx = b[0] + nav.cell / 2; xx < b[2]; xx += nav.cell) { tot++; if (deps.nav.isWalkable(nav, xx, zz)) walk++; }
      if (walk / tot < 0.55) continue;
      cands.push({ x, z, b, score: (x - cx0) * dx + (z - cz0) * dz + (walk / tot) * 4 });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.z - b.z || a.x - b.x);

  for (const c of cands.slice(0, 40)) {
    const centre = cellNear(nav, deps, c.x, c.z, 6);
    if (!centre || !inside(c.b, centre) || !deps.nav.findPath(nav, start, centre)) continue;
    // Pickup ≥ 7 m from the landmark, inside the region, reachable.
    let pick = null;
    for (const [ox, oz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
      const q = cellNear(nav, deps, centre.x + ox * 8, centre.z + oz * 8, 2);
      if (q && inside(c.b, q) && Math.hypot(q.x - centre.x, q.z - centre.z) >= 7 && deps.nav.findPath(nav, start, q)) { pick = q; break; }
    }
    if (!pick) continue;
    const cp = cellNear(nav, deps, (centre.x + pick.x) / 2 + (pick.z - centre.z) * 0.4, (centre.z + pick.z) / 2 - (pick.x - centre.x) * 0.4, 4) || pick;
    const attempt = build(next, { tag, n, theme, dirKey, prompt, c, centre, pick, cp, structRef, pickupRef, colR, deps });
    // Re-derive (nav is re-baked around the new solid landmark) and check the
    // new things are still reachable before accepting this spot.
    const trial = JSON.parse(JSON.stringify(attempt.pkg));
    rederive(trial, { nav: true });
    const tn = trial.world.navigation;
    const tStart = deps.nav.isWalkable(tn, start.x, start.z) ? start : cellNear(tn, deps, start.x, start.z, 4);
    const ok = [pick, cellNear(tn, deps, centre.x + colR + 1.2, centre.z, 3)].every((p) => p && tStart && deps.nav.findPath(tn, tStart, cellNear(tn, deps, p.x, p.z, 2) || p));
    if (!ok) continue;
    // The landmark now occupies the region's centre cell; the centre a player
    // walks to (and the world validator checks) is the nearest free cell.
    const reg = trial.world.regions.find((r) => r.id === attempt.added.region);
    const walkC = [cellNear(tn, deps, centre.x, centre.z, 5), cp].find((q) => q && inside(c.b, q) && deps.nav.findPath(tn, tStart, q));
    if (!walkC) continue;
    reg.center = { x: walkC.x, y: Math.round(deps.terrain.sampleHeight(trial.world.terrain, walkC.x, walkC.z) * 1000) / 1000, z: walkC.z };
    trial.version = (pkg.version || 1) + 1;
    const sealed = seal(trial);
    const v = validatePackage(sealed);
    const before = new Set(validatePackage(pkg).errors.map((e) => `${e.path}|${e.message}`));
    const introduced = v.errors.filter((e) => !before.has(`${e.path}|${e.message}`));
    if (introduced.length) throw new Error(`expandWorld: expansion would break the package: ${introduced.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return { pkg: sealed, added: attempt.added, direction: dirKey };
  }
  throw new Error(`expandWorld: no free, walkable, reachable ground left in this world (preferred direction ${dirKey})`);
}

function inside(b, p) { return p.x >= b[0] && p.x <= b[2] && p.z >= b[1] && p.z <= b[3]; }

function cellNear(nav, deps, x, z, rings) {
  const c = nav.cell, ci = Math.floor(x / c), cj = Math.floor(z / c);
  for (let r = 0; r <= rings; r++) {
    let best = null, bd = Infinity;
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const px = (ci + di + 0.5) * c, pz = (cj + dj + 0.5) * c;
      if (!deps.nav.isWalkable(nav, px, pz)) continue;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bd) { bd = d; best = { x: px, z: pz }; }
    }
    if (best) return best;
  }
  return null;
}

function build(src, { tag, n, theme, dirKey, prompt, c, centre, pick, cp, structRef, pickupRef, colR, deps }) {
  const pkg = JSON.parse(JSON.stringify(src));
  const w = pkg.world;
  const y = (x, z) => Math.round(deps.terrain.sampleHeight(w.terrain, x, z) * 1000) / 1000;
  const regionId = `region_${tag}`;
  const name = nameFrom(prompt, `Frontier ${n}`);
  w.regions.push({ id: regionId, name, kind: theme.kind, bounds: c.b, center: { x: centre.x, y: y(centre.x, centre.z), z: centre.z } });

  // Path from the nearest existing region centre.
  const from = w.regions.filter((r) => r.id !== regionId)
    .map((r) => ({ r, d: Math.hypot(r.center.x - centre.x, r.center.z - centre.z) })).sort((a, b) => a.d - b.d || (a.r.id < b.r.id ? -1 : 1))[0].r;
  const fromCell = cellNear(w.navigation, deps, from.center.x, from.center.z, 6);
  const raw = fromCell ? deps.nav.findPath(w.navigation, fromCell, centre) : null;
  const pts = raw && raw.length > 1 ? raw.filter((_, i) => i % 4 === 0 || i === raw.length - 1) : [{ x: from.center.x, z: from.center.z }, { x: centre.x, z: centre.z }];
  w.paths.push({ id: `path_${tag}`, from_region: from.id, to_region: regionId, width: 3, points: pts.map((p) => ({ x: p.x, z: p.z })) });

  const landmarkId = `pl_${tag}_landmark`, pickupPl = `pl_${tag}_pickup`;
  w.placements.push(
    { id: landmarkId, asset_ref: structRef, region: regionId, position: { x: centre.x, y: y(centre.x, centre.z), z: centre.z }, rotation_y: 0, scale: 1, role: "landmark",
      collider: { shape: "cylinder", radius: colR, height: 4, solid: true }, tags: ["expansion", tag] },
    { id: pickupPl, asset_ref: pickupRef, region: regionId, position: { x: pick.x, y: y(pick.x, pick.z), z: pick.z }, rotation_y: 0, scale: 1, role: "pickup",
      collider: { shape: "none", solid: false }, tags: ["expansion", tag] },
  );
  const itemId = `item_${tag}`, focalId = `ix_${tag}`, pickupId = `pickup_${tag}`;
  w.interactables.push(
    { id: focalId, placement_ref: landmarkId, kind: theme.ix, radius: Math.round((colR + 2.2) * 10) / 10, prompt: `Examine the ${name}` },
    { id: pickupId, placement_ref: pickupPl, kind: "pickup", radius: 2, prompt: `Take the ${name} relic`, item_ref: itemId },
  );
  const spawnId = `spawn_cp_${regionId}`;
  w.spawn_points.push({ id: spawnId, kind: "checkpoint", position: { x: cp.x, y: y(cp.x, cp.z), z: cp.z }, rotation_y: 0, region: regionId });

  const gp = pkg.gameplay;
  gp.inventory.items.push({ id: itemId, name: `${name} Relic`, kind: "collectible", stackable: false, max_stack: 1, icon_ref: null });
  const oCollect = `obj_${tag}_collect`, oActivate = `obj_${tag}_activate`;
  gp.objectives.push(
    { id: oCollect, title: `Find the ${name} relic`, description: `Something was left behind at the ${name}.`, kind: "collect", target_ref: itemId, count: 1, requires: [], optional: true, reward: { xp: 30 } },
    { id: oActivate, title: `Awaken the ${name}`, description: `Bring the relic to the ${name}.`, kind: "interact", target_ref: focalId, count: 1, requires: [oCollect], optional: true, reward: { xp: 60 } },
  );
  gp.events.push({ id: `ev_${tag}_done`, once: true, trigger: { kind: "objective_complete", ref: oActivate }, actions: [{ kind: "message", value: `The ${name} stirs awake.` }] });
  gp.checkpoints = gp.checkpoints || [];
  gp.checkpoints.push({ id: `cp_${tag}`, spawn_ref: spawnId, trigger: { kind: "enter_region", ref: regionId } });

  const added = { region: regionId, placements: [landmarkId, pickupPl], interactables: [focalId, pickupId], items: [itemId], objectives: [oCollect, oActivate], spawns: [spawnId], paths: [`path_${tag}`] };
  pkg.hooks.expand = { ...pkg.hooks.expand, history: [...(pkg.hooks.expand?.history || []), { n, prompt: String(prompt), direction: dirKey, from_version: src.version, added }] };
  return { pkg, added };
}
