// Games-B edit hook. Node-side.
//
// Creator edits after generation ("move the lighthouse", "make it night", "call
// the keeper Ada"). Each op is validated on its own terms first (does the thing
// exist, is the value in range), then applied to a deep copy, then the whole
// package is re-validated: an edit that leaves the package with MORE errors
// than it had is rejected with the reason, and the caller keeps the original.
// That is what stops "remove the chest" from silently producing a game whose
// final objective has nothing to open.
//
// Derived data is recomputed, never patched by hand where a stage function
// exists: nav grid via world-spec bakeNavigation, environment via
// buildEnvironment, scene via compileSceneGraph. When one of those modules is
// missing the edit falls back to a minimal patch and says so in `notes`.

import { seal } from "../runtime/assemble.mjs";
import { sha256Json } from "../common/hash.mjs";
import { validatePackage } from "../runtime/validate-package.mjs";

const tryImport = async (p) => { try { return await import(p); } catch { return null; } };
const terrainMod = await tryImport("../world/terrain-sample.mjs");
const worldMod = await tryImport("../world/world-spec.mjs");
const collisionMod = await tryImport("../world/collision.mjs");
const sceneMod = await tryImport("../world/scene-graph.mjs");

export const EDIT_OPS = ["move_placement", "add_placement", "remove_placement", "recolor_material", "set_time_of_day", "set_weather",
  "rename_character", "set_character_behavior", "set_objective_text", "add_optional_objective", "set_difficulty"];

const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "sandstorm", "ash"];
const ROLES = ["structure", "prop", "landmark", "foliage", "interactable", "pickup", "decor"];
const NPC_STATES = ["idle", "patrol", "guard", "wander", "follow_player", "flee", "chase"];
const OBJ_KINDS = ["reach", "collect", "interact", "talk", "deliver", "defeat", "survive", "escort", "activate"];
const DIFFICULTY = {
  easy: { level: "easy", damage_mult: 0.5, speed_mult: 0.85, time_mult: 1.5 },
  normal: { level: "normal", damage_mult: 1, speed_mult: 1, time_mult: 1 },
  hard: { level: "hard", damage_mult: 1.6, speed_mult: 1.15, time_mult: 0.75 },
};
const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export class EditRejected extends Error {
  constructor(reason, details) { super(reason); this.name = "EditRejected"; this.reason = reason; this.details = details; }
}
const reject = (reason, details) => { throw new EditRejected(reason, details); };

const clone = (v) => JSON.parse(JSON.stringify(v));
const resolves = (pkg, ref) => (pkg.assets?.records || []).some((r) => r.ref === ref || r.asset_id === ref);

/** Everything that names a placement: interactables, objectives, events. */
function placementDependents(pkg, id) {
  const out = [];
  const ixs = (pkg.world.interactables || []).filter((i) => i.placement_ref === id);
  for (const ix of ixs) out.push(`interactable '${ix.id}'`);
  const targets = new Set([id, ...ixs.map((i) => i.id), ...ixs.map((i) => i.item_ref).filter(Boolean)]);
  for (const o of pkg.gameplay.objectives || []) if (targets.has(o.target_ref)) out.push(`objective '${o.id}'`);
  for (const e of pkg.gameplay.events || []) if (targets.has(e.trigger?.ref) || (e.actions || []).some((a) => targets.has(a.ref))) out.push(`event '${e.id}'`);
  return out;
}

function groundY(world, x, z) {
  return terrainMod?.sampleHeight ? Math.round(terrainMod.sampleHeight(world.terrain, x, z) * 1000) / 1000 : 0;
}

function regionAt(world, x, z) {
  let best = null, area = Infinity;
  for (const r of world.regions || []) {
    const [x0, z0, x1, z1] = r.bounds;
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1 && (x1 - x0) * (z1 - z0) < area) { best = r.id; area = (x1 - x0) * (z1 - z0); }
  }
  return best;
}

/** Re-bake nav (colliders changed) and recompile the scene; returns notes about fallbacks. */
export function rederive(pkg, { nav = false } = {}) {
  const notes = [];
  if (nav) {
    if (worldMod?.bakeNavigation && collisionMod?.buildColliders) {
      pkg.world.navigation = worldMod.bakeNavigation(pkg.world, collisionMod.buildColliders(pkg.world, pkg.scene));
    } else notes.push("nav grid not re-baked (world modules unavailable)");
  }
  if (sceneMod?.compileSceneGraph) {
    pkg.scene = sceneMod.compileSceneGraph(pkg.world, { assets: pkg.assets.records, characters: pkg.characters });
  } else {
    patchScene(pkg);
    notes.push("scene patched in place (scene-graph module unavailable)");
  }
  return notes;
}

/** Minimal scene sync without compileSceneGraph: one mesh_instance per placement. */
function patchScene(pkg) {
  const nodes = pkg.scene?.nodes || [];
  const root = nodes.find((n) => n.type === "root")?.id || "root";
  const placements = new Map((pkg.world.placements || []).map((p) => [p.id, p]));
  const kept = nodes.filter((n) => !(n.type === "mesh_instance" && n.placement_ref && !placements.has(n.placement_ref))
    && !(n.type === "interactable" && !(pkg.world.interactables || []).some((i) => i.id === n.interactable_ref)));
  const have = new Set(kept.filter((n) => n.type === "mesh_instance").map((n) => n.placement_ref));
  for (const n of kept) {
    if (n.type === "mesh_instance" && placements.has(n.placement_ref)) {
      const p = placements.get(n.placement_ref);
      n.asset_ref = p.asset_ref;
      n.transform = { position: { ...p.position }, rotation_y: p.rotation_y || 0, scale: p.scale ?? 1 };
    }
  }
  for (const p of placements.values()) {
    if (!have.has(p.id)) kept.push({ id: `mi_${p.id}`, type: "mesh_instance", parent: root, asset_ref: p.asset_ref, placement_ref: p.id, transform: { position: { ...p.position }, rotation_y: p.rotation_y || 0, scale: p.scale ?? 1 } });
  }
  const haveIx = new Set(kept.filter((n) => n.type === "interactable").map((n) => n.interactable_ref));
  for (const ix of pkg.world.interactables || []) {
    if (!haveIx.has(ix.id)) kept.push({ id: `in_${ix.id}`, type: "interactable", parent: root, interactable_ref: ix.id, placement_ref: ix.placement_ref, radius: ix.radius, prompt: ix.prompt });
  }
  pkg.scene = { ...pkg.scene, nodes: kept };
}

function rebuildEnvironment(pkg) {
  if (!worldMod?.buildEnvironment) return;
  const water = pkg.world.environment.water;
  const env = worldMod.buildEnvironment({ ...pkg.concept, time_of_day: pkg.world.environment.time_of_day, weather: pkg.world.environment.weather }, pkg.world.size.w, { enabled: water.enabled, level: water.level });
  pkg.world.environment = { ...env, water: { ...env.water, ...water }, time_of_day: pkg.world.environment.time_of_day, weather: pkg.world.environment.weather };
}

const OPS = {
  move_placement(pkg, op) {
    const p = pkg.world.placements.find((x) => x.id === op.id) || reject(`no placement '${op.id}'`);
    const { x, z } = op.position || {};
    if (!isNum(x) || !isNum(z)) reject("position {x, z} is required");
    if (x < 0 || z < 0 || x > pkg.world.size.w || z > pkg.world.size.h) reject(`(${x}, ${z}) is outside the ${pkg.world.size.w}×${pkg.world.size.h} world`);
    p.position = { x, y: isNum(op.position.y) ? op.position.y : groundY(pkg.world, x, z), z };
    if (isNum(op.rotation_y)) p.rotation_y = op.rotation_y;
    p.region = regionAt(pkg.world, x, z) || p.region;
    return { nav: !!p.collider?.solid };
  },
  add_placement(pkg, op) {
    if (!op.asset_ref) reject("asset_ref is required");
    if (!resolves(pkg, op.asset_ref)) reject(`asset '${op.asset_ref}' is not in this package's asset records`, { hint: "add_placement can only reuse shipped assets" });
    const { x, z } = op.position || {};
    if (!isNum(x) || !isNum(z)) reject("position {x, z} is required");
    if (x < 0 || z < 0 || x > pkg.world.size.w || z > pkg.world.size.h) reject(`(${x}, ${z}) is outside the world`);
    const role = op.role || "prop";
    if (!ROLES.includes(role)) reject(`role '${role}' is not permitted`);
    let n = pkg.world.placements.length + 1, id = op.id || `pl_edit_${n}`;
    while (pkg.world.placements.some((p) => p.id === id)) id = `pl_edit_${++n}`;
    const scale = isNum(op.scale) ? op.scale : 1;
    const collider = op.collider || (role === "structure" || role === "landmark" ? { shape: "cylinder", radius: 1.5 * scale, height: 3 * scale, solid: true } : { shape: "none", solid: false });
    pkg.world.placements.push({ id, asset_ref: op.asset_ref, region: op.region || regionAt(pkg.world, x, z), position: { x, y: groundY(pkg.world, x, z), z },
      rotation_y: isNum(op.rotation_y) ? op.rotation_y : 0, scale, role, collider, tags: ["edit", ...(op.tags || [])] });
    return { nav: !!collider.solid, created: id };
  },
  remove_placement(pkg, op) {
    const idx = pkg.world.placements.findIndex((x) => x.id === op.id);
    if (idx < 0) reject(`no placement '${op.id}'`);
    const deps = placementDependents(pkg, op.id);
    if (deps.length) reject(`placement '${op.id}' is used by ${deps.join(", ")}`, { dependents: deps });
    const [p] = pkg.world.placements.splice(idx, 1);
    return { nav: !!p.collider?.solid };
  },
  recolor_material(pkg, op) {
    if (!isHex(op.color)) reject("color must be #rrggbb");
    const rec = pkg.assets.records.find((r) => r.format === "material" && (r.ref === op.material || r.asset_id === op.material || r.payload?.material_id === op.material));
    if (!rec) reject(`no material '${op.material}'`);
    // asset_id stays stable (things reference it); version and sha256 record the change.
    rec.payload = { ...rec.payload, color: op.color.toLowerCase() };
    rec.version = (rec.version || 1) + 1;
    rec.sha256 = sha256Json(rec.payload);
    return {};
  },
  set_time_of_day(pkg, op) {
    if (!isNum(op.value) || op.value < 0 || op.value > 1) reject("value must be in [0, 1]");
    pkg.world.environment.time_of_day = op.value;
    pkg.concept.time_of_day = op.value;
    rebuildEnvironment(pkg);
    return {};
  },
  set_weather(pkg, op) {
    if (!WEATHERS.includes(op.value)) reject(`weather must be one of ${WEATHERS.join(", ")}`);
    pkg.world.environment.weather = op.value;
    pkg.concept.weather = op.value;
    rebuildEnvironment(pkg);
    return {};
  },
  rename_character(pkg, op) {
    const ch = pkg.characters.characters.find((c) => c.id === op.id) || reject(`no character '${op.id}'`);
    const name = String(op.name || "").trim();
    if (!name || name.length > 60) reject("name must be 1–60 characters");
    const old = ch.name;
    ch.name = name;
    // Prompts and dialogue text that spell the old name follow it.
    for (const ix of pkg.world.interactables || []) if (ix.character_ref === ch.id && ix.prompt) ix.prompt = ix.prompt.split(old).join(name);
    for (const d of pkg.characters.dialogues || []) for (const n of d.nodes || []) { if (n.text) n.text = n.text.split(old).join(name); }
    const cc = (pkg.concept.characters || []).find((c) => c.id === ch.id);
    if (cc) cc.name = name;
    return {};
  },
  set_character_behavior(pkg, op) {
    const ch = pkg.characters.characters.find((c) => c.id === op.id) || reject(`no character '${op.id}'`);
    const b = op.behavior || {};
    for (const k of ["initial", "on_player_near", "on_player_far"]) if (b[k] !== undefined && !NPC_STATES.includes(b[k])) reject(`behavior.${k} '${b[k]}' is not an NPC state`);
    for (const k of ["speed", "wander_radius", "sight_radius", "leash_radius"]) if (b[k] !== undefined && (!isNum(b[k]) || b[k] < 0)) reject(`behavior.${k} must be a non-negative number`);
    if (b.patrol !== undefined && (!Array.isArray(b.patrol) || !b.patrol.every((p) => isNum(p?.x) && isNum(p?.z)))) reject("behavior.patrol must be [{x, z}]");
    ch.behavior = { ...ch.behavior, ...b };
    return {};
  },
  set_objective_text(pkg, op) {
    const o = pkg.gameplay.objectives.find((x) => x.id === op.id) || reject(`no objective '${op.id}'`);
    if (op.title === undefined && op.description === undefined) reject("title or description is required");
    if (op.title !== undefined) { if (!String(op.title).trim()) reject("title cannot be empty"); o.title = String(op.title); }
    if (op.description !== undefined) o.description = String(op.description);
    return {};
  },
  add_optional_objective(pkg, op) {
    if (!OBJ_KINDS.includes(op.kind)) reject(`kind must be one of ${OBJ_KINDS.join(", ")}`);
    if (!op.title) reject("title is required");
    const w = pkg.world;
    const targets = new Set([...(w.regions || []), ...(w.interactables || []), ...(pkg.characters.characters || []), ...(pkg.gameplay.inventory.items || []), ...(w.placements || [])].map((x) => x.id));
    if (op.kind !== "survive" && !targets.has(op.target_ref)) reject(`target '${op.target_ref}' does not exist`);
    for (const r of op.requires || []) if (!pkg.gameplay.objectives.some((o) => o.id === r)) reject(`requires unknown objective '${r}'`);
    let n = 1; while (pkg.gameplay.objectives.some((o) => o.id === `obj_opt_${n}`)) n++;
    const id = `obj_opt_${n}`;
    pkg.gameplay.objectives.push({ id, title: String(op.title), description: String(op.description || ""), kind: op.kind, target_ref: op.target_ref ?? null,
      count: op.count ?? 1, requires: [...(op.requires || [])], optional: true, reward: { xp: op.xp ?? 25 } });
    return { created: id };
  },
  set_difficulty(pkg, op) {
    const d = DIFFICULTY[op.level] || reject("level must be easy, normal or hard");
    pkg.gameplay.difficulty = { ...d };
    return {};
  },
};

/**
 * Apply one edit op. Returns a NEW sealed package (version + 1).
 * @throws {EditRejected} when the op is malformed or would break validation
 * @returns {{ pkg, op, notes, created? }}
 */
export function applyEdit(pkg, op) {
  if (!op || !OPS[op.op]) reject(`unknown edit op '${op?.op}'`, { ops: EDIT_OPS });
  const before = validatePackage(pkg);
  const next = clone(pkg);
  const res = OPS[op.op](next, op);
  const notes = rederive(next, { nav: !!res.nav });
  next.version = (pkg.version || 1) + 1;
  const sealed = seal(next);
  const after = validatePackage(sealed);
  const beforeKeys = new Set(before.errors.map((e) => `${e.path}|${e.message}`));
  const introduced = after.errors.filter((e) => !beforeKeys.has(`${e.path}|${e.message}`));
  if (introduced.length) reject(`edit '${op.op}' would break the package: ${introduced.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")}`, { errors: introduced });
  return { pkg: sealed, op, notes, ...(res.created ? { created: res.created } : {}) };
}

/** Apply several ops in order; stops at the first rejection. */
export function applyEdits(pkg, ops) {
  let cur = pkg;
  const applied = [];
  for (const op of ops) { const r = applyEdit(cur, op); cur = r.pkg; applied.push(r.op.op); }
  return { pkg: cur, applied };
}
