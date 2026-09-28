// Games-B package validation. Node-side.
//
// Two layers:
//   1. the stage validators (world, scene graph, assets, gameplay, characters,
//      dialogues), loaded if their modules exist — each stage owns the rules for
//      its own shape;
//   2. cross-checks that only make sense on the ASSEMBLED package, which no
//      single stage can see: does every asset ref resolve against the records
//      that actually shipped, does every interactable sit on a real placement,
//      does every scripted action name something the rules engine knows and a
//      thing that exists, does the integrity hash match, and will it fit the
//      browser budget.
// Layer 2 always runs, so a missing stage validator weakens the gate but never
// switches it off; which validators ran is reported in `checks`/`skipped`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Issues, isObj, isStr, isInt } from "../common/issues.mjs";
import { computeIntegrity } from "./assemble.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAMESB = path.resolve(HERE, "..");

export const DEFAULT_BUDGETS = Object.freeze({ triangles: 1_500_000, draw_calls: 600, texture_mb: 96 });

// Contract §5 vocabularies, used when the rules engine does not export its own.
export const CONTRACT_ACTION_KINDS = ["message", "give_item", "remove_item", "set_npc_state", "unlock", "set_weather", "set_time", "checkpoint", "damage", "heal", "win", "lose", "reveal", "play_cinematic", "set_flag"];
export const CONTRACT_TRIGGER_KINDS = ["objective_complete", "objective_active", "enter_region", "interact", "talk", "timer", "item_count", "health_below", "game_start"];
const NPC_STATES = ["idle", "patrol", "guard", "wander", "follow_player", "flee", "chase", "talk"];
const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "sandstorm", "ash"];
const COND_KINDS = ["objective_state", "has_item", "flag"];

// ------------------------------------------------------ stage validators

let loaded = null;

/** Import every stage module that exists and collect its exported functions and vocabularies. */
export async function loadStageModules() {
  const files = [];
  for (const dir of ["world", "assets", "gameplay", "characters"]) {
    const abs = path.join(GAMESB, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) if (f.endsWith(".schema.mjs")) files.push(path.join(abs, f));
  }
  for (const rel of ["world/scene-graph.mjs", "world/terrain-sample.mjs", "assets/mesh-recipes.mjs", "gameplay/rules-engine.mjs", "characters/dialogue.mjs", "world/world-spec.mjs"]) {
    const abs = path.join(GAMESB, rel);
    if (fs.existsSync(abs) && !files.includes(abs)) files.push(abs);
  }
  const fns = {};
  const vocab = {};
  const errors = [];
  for (const f of files) {
    try {
      const mod = await import(f);
      for (const [k, v] of Object.entries(mod)) {
        if (typeof v === "function" && !fns[k]) fns[k] = v;
        else if (Array.isArray(v) && /^[A-Z_]+$/.test(k) && !vocab[k]) vocab[k] = v;
      }
    } catch (e) {
      errors.push(`${path.relative(GAMESB, f)}: ${e.message}`);
    }
  }
  loaded = { fns, vocab, errors, files: files.map((f) => path.relative(GAMESB, f)) };
  return loaded;
}

await loadStageModules();

function stageValidators(pkg) {
  const { fns } = loaded;
  const recs = pkg.assets?.records || [];
  const ctxAll = { world: pkg.world, characters: pkg.characters, gameplay: pkg.gameplay, assets: recs, records: recs, concept: pkg.concept };
  // name → [fn names in preference order, args]
  return [
    ["world", ["validateWorldSpec", "validateWorld"], [pkg.world, { concept: pkg.concept }], "world"],
    ["scene", ["validateSceneGraph"], [pkg.scene, ctxAll], "scene"],
    ["assets", ["validateAssetSet", "validateAssetRecords", "validateAssets"], [recs, ctxAll], "assets"],
    ["gameplay", ["validateGameplay"], [pkg.gameplay, ctxAll], "gameplay"],
    ["characters", ["validateCharacters", "validateCharacterSpec"], [pkg.characters, ctxAll], "characters"],
    ["dialogues", ["validateDialogues"], [pkg.characters, ctxAll], "characters"],
  ].map(([name, names, args, prefix]) => {
    const fn = names.map((n) => fns[n]).find(Boolean);
    // No set validator: fall back to validating each record on its own.
    if (!fn && name === "assets" && fns.validateAssetRecord) {
      return { name, prefix, run: () => { const iss = new Issues(); recs.forEach((r, i) => iss.merge(fns.validateAssetRecord(r), `records[${i}]`)); return iss.toJSON(); } };
    }
    return { name, prefix, run: fn ? () => fn(...args) : null };
  });
}

// ----------------------------------------------------------- cross-checks

function assetResolver(records) {
  const keys = new Set();
  for (const r of records) { if (r?.ref) keys.add(r.ref); if (r?.asset_id) keys.add(r.asset_id); }
  return (ref) => keys.has(ref);
}

function checkShape(pkg, iss) {
  if (pkg.package_version !== "1.0.0") iss.err("package_version", `expected '1.0.0', got '${pkg.package_version}'`);
  if (!isStr(pkg.game_id)) iss.err("game_id", "is required");
  if (!isInt(pkg.version) || pkg.version < 1) iss.err("version", "must be an integer >= 1");
  for (const k of ["concept", "world", "scene", "gameplay", "characters", "hooks", "provenance", "integrity"]) {
    if (!isObj(pkg[k])) iss.err(k, "is required");
  }
  if (!Array.isArray(pkg.assets?.records)) iss.err("assets.records", "must be an array");
}

function checkIntegrity(pkg, iss) {
  const want = pkg.integrity?.sha256;
  if (!isStr(want)) { iss.err("integrity.sha256", "is missing"); return; }
  const got = computeIntegrity(pkg);
  if (got !== want) iss.err("integrity.sha256", "does not match the package content", "the package was modified after sealing; re-run assemble/seal");
}

function checkAssetRefs(pkg, iss) {
  const records = pkg.assets?.records || [];
  const has = assetResolver(records);
  const world = pkg.world || {};
  const miss = (p, ref, what) => iss.err(p, `${what} '${ref}' does not resolve to any AssetRecord`, "the asset stage must emit a record whose ref or asset_id matches");
  (pkg.scene?.nodes || []).forEach((n, i) => { if (n.asset_ref && !has(n.asset_ref)) miss(`scene.nodes[${i}].asset_ref`, n.asset_ref, "scene asset_ref"); });
  (world.placements || []).forEach((p, i) => { if (!has(p.asset_ref)) miss(`world.placements[${i}].asset_ref`, p.asset_ref, "placement asset_ref"); });
  (world.scatter || []).forEach((s, i) => { if (!has(s.asset_ref)) miss(`world.scatter[${i}].asset_ref`, s.asset_ref, "scatter asset_ref"); });
  (world.terrain?.material_layers || []).forEach((l, i) => { if (!has(l.material_ref)) miss(`world.terrain.material_layers[${i}].material_ref`, l.material_ref, "terrain material"); });
  (pkg.characters?.characters || []).forEach((c, i) => { if (c.asset_ref && !has(c.asset_ref)) miss(`characters.characters[${i}].asset_ref`, c.asset_ref, "character asset_ref"); });
  (pkg.gameplay?.inventory?.items || []).forEach((it, i) => { if (it.icon_ref && !has(it.icon_ref)) miss(`gameplay.inventory.items[${i}].icon_ref`, it.icon_ref, "item icon"); });
  records.forEach((r, i) => {
    if (r.format === "mesh-recipe") {
      if (!isObj(r.payload) || !Array.isArray(r.payload.parts)) { iss.err(`assets.records[${i}].payload`, `mesh recipe '${r.ref || r.asset_id}' has no parts`); return; }
      r.payload.parts.forEach((pt, j) => { if (pt.material_ref && !has(pt.material_ref)) miss(`assets.records[${i}].payload.parts[${j}].material_ref`, pt.material_ref, "part material"); });
    }
    if (r.format === "material" && isObj(r.payload)) {
      for (const k of ["albedo_texture", "normal_texture", "roughness_texture"]) {
        if (r.payload[k] && !has(r.payload[k])) miss(`assets.records[${i}].payload.${k}`, r.payload[k], "material texture");
      }
    }
    if (r.provenance?.license?.commercial_use === "unknown") iss.warn(`assets.records[${i}].provenance.license`, `licence of '${r.ref || r.asset_id}' is unknown`);
  });
}

function ids(arr) { return new Set((arr || []).map((x) => x?.id).filter(Boolean)); }

function checkWorldRefs(pkg, iss) {
  const w = pkg.world || {};
  const placements = ids(w.placements), regions = ids(w.regions), spawns = ids(w.spawn_points);
  const chars = ids(pkg.characters?.characters), items = ids(pkg.gameplay?.inventory?.items), ixs = ids(w.interactables);
  if (!spawns.has("spawn_player") && !(w.spawn_points || []).some((s) => s.kind === "player")) iss.err("world.spawn_points", "no player spawn");
  (w.interactables || []).forEach((ix, i) => {
    const p = `world.interactables[${i}]`;
    if (ix.kind === "talk" || ix.character_ref) {
      if (!chars.has(ix.character_ref)) iss.err(`${p}.character_ref`, `interactable '${ix.id}' follows unknown character '${ix.character_ref}'`);
    } else if (!placements.has(ix.placement_ref)) iss.err(`${p}.placement_ref`, `interactable '${ix.id}' has no placement '${ix.placement_ref}'`, "every interactable needs a placement it sits on");
    if (ix.item_ref && !items.has(ix.item_ref)) iss.err(`${p}.item_ref`, `grants unknown item '${ix.item_ref}'`);
    if (ix.locked_by && !items.has(ix.locked_by)) iss.err(`${p}.locked_by`, `is locked by unknown item '${ix.locked_by}'`);
  });
  (w.placements || []).forEach((pl, i) => { if (pl.region && !regions.has(pl.region)) iss.err(`world.placements[${i}].region`, `unknown region '${pl.region}'`); });
  (pkg.characters?.characters || []).forEach((c, i) => { if (!spawns.has(c.spawn_ref)) iss.err(`characters.characters[${i}].spawn_ref`, `unknown spawn '${c.spawn_ref}'`); });
  const nodes = pkg.scene?.nodes || [];
  const nodeIds = ids(nodes);
  nodes.forEach((n, i) => {
    const p = `scene.nodes[${i}]`;
    if (n.parent && !nodeIds.has(n.parent)) iss.err(`${p}.parent`, `unknown parent '${n.parent}'`);
    if (n.type === "interactable" && !ixs.has(n.interactable_ref)) iss.err(`${p}.interactable_ref`, `unknown interactable '${n.interactable_ref}'`);
    if (n.type === "mesh_instance" && n.placement_ref && !placements.has(n.placement_ref)) iss.err(`${p}.placement_ref`, `unknown placement '${n.placement_ref}'`);
    if (n.type === "character" && !chars.has(n.character_ref)) iss.err(`${p}.character_ref`, `unknown character '${n.character_ref}'`);
    if (n.type === "spawn" && !spawns.has(n.spawn_ref)) iss.err(`${p}.spawn_ref`, `unknown spawn '${n.spawn_ref}'`);
  });
  // Every non-talk interactable must be visible: some scene node must carry its placement.
  const placed = new Set(nodes.filter((n) => n.type === "mesh_instance").map((n) => n.placement_ref));
  (w.interactables || []).forEach((ix, i) => {
    if (ix.placement_ref && nodes.length && !placed.has(ix.placement_ref)) iss.warn(`world.interactables[${i}]`, `interactable '${ix.id}' has no mesh_instance in the scene`);
  });
}

/**
 * Broken-script check: every trigger/action/condition kind is one the rules
 * engine knows, and every thing an action names exists. A script that names a
 * missing NPC does nothing at runtime, silently — which is exactly how a
 * "talk to the keeper" quest ends up unwinnable.
 */
function checkScripts(pkg, iss, vocab) {
  const gp = pkg.gameplay || {};
  const w = pkg.world || {};
  const actionKinds = new Set(vocab.ACTION_KINDS || CONTRACT_ACTION_KINDS);
  const triggerKinds = new Set(vocab.TRIGGER_KINDS || vocab.EVENT_TRIGGER_KINDS || CONTRACT_TRIGGER_KINDS);
  const items = ids(gp.inventory?.items), chars = ids(pkg.characters?.characters), spawns = ids(w.spawn_points);
  const objectives = ids(gp.objectives), regions = ids(w.regions), ixs = ids(w.interactables), placements = ids(w.placements);
  const anyId = new Set([...items, ...chars, ...spawns, ...objectives, ...regions, ...ixs, ...placements]);

  const checkAction = (a, p) => {
    if (!actionKinds.has(a?.kind)) { iss.err(`${p}.kind`, `unknown action kind '${a?.kind}'`, `the rules engine knows: ${[...actionKinds].join(", ")}`); return; }
    switch (a.kind) {
      case "give_item": case "remove_item": if (!items.has(a.ref)) iss.err(`${p}.ref`, `${a.kind} names unknown item '${a.ref}'`); break;
      case "set_npc_state":
        if (!chars.has(a.ref)) iss.err(`${p}.ref`, `set_npc_state names unknown character '${a.ref}'`);
        if (!NPC_STATES.includes(a.value)) iss.err(`${p}.value`, `unknown npc state '${a.value}'`);
        break;
      case "checkpoint": if (!spawns.has(a.ref)) iss.err(`${p}.ref`, `checkpoint names unknown spawn '${a.ref}'`); break;
      case "unlock": case "reveal": if (a.ref && !anyId.has(a.ref)) iss.err(`${p}.ref`, `${a.kind} names unknown id '${a.ref}'`); break;
      case "set_weather": if (!WEATHERS.includes(a.value)) iss.err(`${p}.value`, `unknown weather '${a.value}'`); break;
      case "set_time": if (typeof a.value !== "number" || a.value < 0 || a.value > 1) iss.err(`${p}.value`, "set_time needs a value in [0,1]"); break;
      default: break;
    }
  };
  (gp.events || []).forEach((e, i) => {
    const p = `gameplay.events[${i}]`;
    if (!triggerKinds.has(e?.trigger?.kind)) iss.err(`${p}.trigger.kind`, `unknown trigger kind '${e?.trigger?.kind}'`);
    else {
      const r = e.trigger.ref;
      const k = e.trigger.kind;
      if ((k === "objective_complete" || k === "objective_active") && !objectives.has(r)) iss.err(`${p}.trigger.ref`, `unknown objective '${r}'`);
      if (k === "enter_region" && !regions.has(r)) iss.err(`${p}.trigger.ref`, `unknown region '${r}'`);
      if (k === "interact" && r && !ixs.has(r)) iss.err(`${p}.trigger.ref`, `unknown interactable '${r}'`);
      if (k === "talk" && r && !chars.has(r)) iss.err(`${p}.trigger.ref`, `unknown character '${r}'`);
      if (k === "item_count" && !items.has(r)) iss.err(`${p}.trigger.ref`, `unknown item '${r}'`);
    }
    (e.actions || []).forEach((a, j) => checkAction(a, `${p}.actions[${j}]`));
  });
  (pkg.characters?.dialogues || []).forEach((d, i) => {
    const p = `characters.dialogues[${i}]`;
    if (!chars.has(d.character_ref)) iss.err(`${p}.character_ref`, `unknown character '${d.character_ref}'`);
    const nodeIds = ids(d.nodes);
    const checkCond = (c, cp) => {
      if (!COND_KINDS.includes(c?.kind)) { iss.err(`${cp}.kind`, `unknown condition kind '${c?.kind}'`); return; }
      if (c.kind === "objective_state" && !objectives.has(c.ref)) iss.err(`${cp}.ref`, `unknown objective '${c.ref}'`);
      if (c.kind === "has_item" && !items.has(c.ref)) iss.err(`${cp}.ref`, `unknown item '${c.ref}'`);
    };
    (d.entry || []).forEach((en, j) => {
      if (!nodeIds.has(en.node)) iss.err(`${p}.entry[${j}].node`, `unknown node '${en.node}'`);
      (en.conditions || []).forEach((c, k) => checkCond(c, `${p}.entry[${j}].conditions[${k}]`));
    });
    (d.nodes || []).forEach((n, j) => (n.choices || []).forEach((c, k) => {
      const cp = `${p}.nodes[${j}].choices[${k}]`;
      if (c.next && !nodeIds.has(c.next)) iss.err(`${cp}.next`, `unknown node '${c.next}'`);
      (c.conditions || []).forEach((x, m) => checkCond(x, `${cp}.conditions[${m}]`));
      (c.actions || []).forEach((a, m) => checkAction(a, `${cp}.actions[${m}]`));
    }));
  });
  // Objective and hazard references, re-checked here because they are what the
  // headless agent will try to walk to.
  const targetable = new Set([...regions, ...ixs, ...chars, ...items, ...placements]);
  (gp.objectives || []).forEach((o, i) => {
    if (!targetable.has(o.target_ref) && o.kind !== "survive") iss.err(`gameplay.objectives[${i}].target_ref`, `objective '${o.id}' targets unknown '${o.target_ref}'`);
    (o.requires || []).forEach((r, j) => { if (!objectives.has(r)) iss.err(`gameplay.objectives[${i}].requires[${j}]`, `unknown objective '${r}'`); });
    if (o.reward?.item_ref && !items.has(o.reward.item_ref)) iss.err(`gameplay.objectives[${i}].reward.item_ref`, `unknown item '${o.reward.item_ref}'`);
  });
  (gp.hazards || []).forEach((h, i) => {
    if (h.region && !regions.has(h.region)) iss.err(`gameplay.hazards[${i}].region`, `unknown region '${h.region}'`);
    if (h.character_ref && !chars.has(h.character_ref)) iss.err(`gameplay.hazards[${i}].character_ref`, `unknown character '${h.character_ref}'`);
    if (h.active_after && !objectives.has(h.active_after)) iss.err(`gameplay.hazards[${i}].active_after`, `unknown objective '${h.active_after}'`);
  });
  (gp.checkpoints || []).forEach((c, i) => { if (!spawns.has(c.spawn_ref)) iss.err(`gameplay.checkpoints[${i}].spawn_ref`, `unknown spawn '${c.spawn_ref}'`); });
  // requires graph must be acyclic.
  const byId = new Map((gp.objectives || []).map((o) => [o.id, o]));
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { iss.err("gameplay.objectives", `requires cycle: ${[...trail, id].join(" -> ")}`); return; }
    state.set(id, 1);
    for (const r of byId.get(id)?.requires || []) if (byId.has(r)) visit(r, [...trail, id]);
    state.set(id, 2);
  };
  for (const id of byId.keys()) visit(id, []);
}

// ----------------------------------------------------------------- budgets

/** Triangle count for one recipe part when mesh-recipes.mjs does not provide an estimator. */
function partTriangles(pt) {
  const s = Math.max(3, pt.segments || 12);
  switch (pt.shape) {
    case "box": return 12;
    case "cylinder": return 4 * s;
    case "cone": return 2 * s;
    case "sphere": return s * s;
    case "capsule": return s * s + 4 * s;
    case "torus": return 2 * s * Math.max(6, Math.round(s / 2));
    case "lathe": return 2 * s * Math.max(1, (pt.profile?.length || 2) - 1);
    case "extrude": { const n = pt.outline?.length || 4; return 2 * n + 2 * Math.max(0, n - 2); }
    case "rock": case "icosphere": return 20 * 4 ** Math.min(4, pt.detail ?? 1);
    default: return 12;
  }
}

function recipeTriangles(payload, estimate) {
  if (!payload?.parts) return 0;
  if (estimate) { try { const n = estimate(payload); if (Number.isFinite(n)) return n; } catch { /* fall back */ } }
  return payload.parts.reduce((a, pt) => a + partTriangles(pt), 0);
}

function recipeMaterials(payload) {
  return new Set((payload?.parts || []).map((p) => p.material_ref || "default")).size || 1;
}

/**
 * Static render-cost estimate. It is an estimate of what games-b-runtime will
 * submit (merged per material per placement, InstancedMesh per scatter entry),
 * not a measurement — the browser test hook reports the real numbers.
 */
export function estimateBudgets(pkg, { expandScatter } = {}) {
  const records = pkg.assets?.records || [];
  const byKey = new Map();
  for (const r of records) { if (r.ref) byKey.set(r.ref, r); if (r.asset_id) byKey.set(r.asset_id, r); }
  const est = loaded?.fns?.estimateTriangles;
  const tri = (ref) => recipeTriangles(byKey.get(ref)?.payload, est);
  const mats = (ref) => recipeMaterials(byKey.get(ref)?.payload);
  const w = pkg.world || {};
  let triangles = 0, drawCalls = 0, instances = 0;

  const t = w.terrain;
  if (t?.cols && t?.rows) { triangles += (t.cols - 1) * (t.rows - 1) * 2; drawCalls += 1; }
  if (w.environment?.water?.enabled) { triangles += 2; drawCalls += 1; }
  drawCalls += 1; // sky dome
  triangles += 960;

  for (const p of w.placements || []) { triangles += tri(p.asset_ref); drawCalls += mats(p.asset_ref); instances++; }
  let scatterInstances = null;
  const exp = expandScatter || loaded?.fns?.expandScatter;
  if (exp) { try { scatterInstances = exp(w); } catch { scatterInstances = null; } }
  const counts = new Map();
  if (Array.isArray(scatterInstances)) for (const s of scatterInstances) counts.set(s.scatter_id, (counts.get(s.scatter_id) || 0) + 1);
  for (const s of w.scatter || []) {
    const n = counts.size ? counts.get(s.id) || 0 : s.count || 0;
    triangles += tri(s.asset_ref) * n;
    drawCalls += mats(s.asset_ref); // one InstancedMesh per material
    instances += n;
  }
  for (const c of pkg.characters?.characters || []) { triangles += tri(c.asset_ref); drawCalls += mats(c.asset_ref); instances++; }

  let texBytes = 0;
  for (const r of records) {
    if (r.format === "texture-recipe" && r.payload?.size) texBytes += r.payload.size ** 2 * 4 * 3 * (4 / 3); // albedo+normal+roughness, mips
    else if (r.format === "png" && r.dimensions?.px_w) texBytes += r.dimensions.px_w * r.dimensions.px_h * 4 * (4 / 3);
  }
  return { triangles: Math.round(triangles), draw_calls: drawCalls, texture_mb: Math.round((texBytes / (1024 * 1024)) * 100) / 100, instances, estimator: est ? "mesh-recipes.estimateTriangles" : "fallback" };
}

// ------------------------------------------------------------------- entry

/**
 * @param {object} pkg GamePackage
 * @param {{budgets?: object}} [opts]
 * @returns {{ok, errors, warnings, budgets, checks, skipped}}
 */
export function validatePackage(pkg, { budgets } = {}) {
  const iss = new Issues();
  const checks = [], skipped = [];
  if (!isObj(pkg)) { iss.err("$", "package must be an object"); return { ...iss.toJSON(), budgets: null, checks, skipped }; }

  const run = (name, fn) => {
    try { fn(); checks.push(name); } catch (e) { iss.err(name, `check threw: ${e.message}`); }
  };
  run("shape", () => checkShape(pkg, iss));
  run("integrity", () => checkIntegrity(pkg, iss));

  for (const v of stageValidators(pkg)) {
    if (!v.run) { skipped.push(v.name); iss.warn(`validators.${v.name}`, "stage validator unavailable; only cross-checks ran for this part"); continue; }
    try { iss.merge(v.run(), v.prefix); checks.push(`stage:${v.name}`); } catch (e) { iss.err(`validators.${v.name}`, `validator threw: ${e.message}`); }
  }

  run("asset_refs", () => checkAssetRefs(pkg, iss));
  run("world_refs", () => checkWorldRefs(pkg, iss));
  run("scripts", () => checkScripts(pkg, iss, loaded.vocab));

  const limits = { ...DEFAULT_BUDGETS, ...(budgets || {}) };
  let measured = null;
  run("budgets", () => {
    measured = estimateBudgets(pkg);
    if (measured.triangles > limits.triangles) iss.err("budgets.triangles", `${measured.triangles} triangles exceeds ${limits.triangles}`);
    if (measured.draw_calls > limits.draw_calls) iss.err("budgets.draw_calls", `${measured.draw_calls} draw calls exceeds ${limits.draw_calls}`);
    if (measured.texture_mb > limits.texture_mb) iss.err("budgets.texture_mb", `${measured.texture_mb} MB of textures exceeds ${limits.texture_mb} MB`);
  });

  // Deduplicate: a stage validator and a cross-check often report the same thing.
  const dedupe = (arr) => { const seen = new Set(); return arr.filter((e) => { const k = e.path + "|" + e.message; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const errors = dedupe(iss.errors), warnings = dedupe(iss.warnings);
  return { ok: errors.length === 0, package_sha256: pkg.integrity?.sha256 ?? null, errors, warnings, budgets: measured ? { ...measured, limits } : null, checks, skipped, module_errors: loaded.errors };
}
