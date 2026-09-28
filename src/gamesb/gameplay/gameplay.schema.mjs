// GameplaySpec validator (CONTRACT §5). ISOMORPHIC.
//
// Two layers:
//  - structure, always: shapes, enums, internal references (objective → objective,
//    reward → inventory item), an acyclic `requires` graph, no required objective
//    gated on an optional one, and at least one satisfiable win condition;
//  - world references, when `ctx = { world, characters }` is given: every
//    target/region/character/spawn/item resolves to the RIGHT KIND for the thing
//    pointing at it. "talk to region_harbour" is the class of bug a model makes
//    and a string-exists check would wave through.
import { Issues, isObj, isArr, isStr, isNum, isBool, requireEnum, requireNum, uniqueIds } from "../common/issues.mjs";

export const GAMEPLAY_VERSION = "1.0.0";
export const GAME_TYPES = ["adventure", "exploration", "mission", "puzzle", "survival", "collectathon", "stealth"];
export const OBJECTIVE_KINDS = ["reach", "collect", "interact", "talk", "deliver", "defeat", "survive", "escort", "activate"];
export const TRIGGER_KINDS = ["objective_complete", "objective_active", "enter_region", "interact", "talk", "timer", "item_count", "health_below", "game_start"];
export const ACTION_KINDS = ["message", "give_item", "remove_item", "set_npc_state", "unlock", "set_weather", "set_time", "checkpoint", "damage", "heal", "win", "lose", "reveal", "play_cinematic", "set_flag"];
export const ITEM_KINDS = ["key", "collectible", "consumable", "quest"];
export const HAZARD_KINDS = ["storm_zone", "sentinel", "deep_water", "fire", "fall"];
export const WIN_KINDS = ["all_required_objectives", "objective", "item_count", "reach_region"];
export const LOSE_KINDS = ["health_zero", "lives_zero", "time_expired", "fell_out", "npc_lost"];
export const CAMERA_MODES = ["third_person", "first_person", "top_down"];
export const COMBAT_MODES = ["none", "avoid", "melee"];
export const DIFFICULTY_LEVELS = ["easy", "normal", "hard"];
export const NPC_STATES = ["idle", "patrol", "guard", "wander", "follow_player", "flee", "chase", "talk", "arrived", "lost", "dead", "defeated"];
export const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "sandstorm", "ash"];

// What kind of world entity each objective kind may target. `deliver` goes to a
// person or a thing (a chest, an altar); `survive` may name a region or nothing.
export const OBJECTIVE_TARGETS = {
  reach: ["region"], collect: ["item"], interact: ["interactable"], activate: ["interactable"],
  talk: ["character"], deliver: ["character", "interactable"], defeat: ["character"],
  escort: ["character"], survive: ["region", "none"],
};
const TRIGGER_TARGETS = {
  objective_complete: ["objective"], objective_active: ["objective"], enter_region: ["region"],
  interact: ["interactable"], talk: ["character"], item_count: ["item"],
};
const ACTION_TARGETS = {
  give_item: ["item"], remove_item: ["item"], set_npc_state: ["character"], checkpoint: ["spawn"],
  unlock: ["interactable", "region"], reveal: ["region", "interactable", "character", "objective", "item"],
};

/** Index the ids a gameplay spec may point at, by kind. */
export function refIndex(gameplay, ctx) {
  const ids = (arr) => new Set((isArr(arr) ? arr : []).map((x) => x?.id).filter(isStr));
  const idx = {
    objective: ids(gameplay?.objectives),
    item: ids(gameplay?.inventory?.items),
    region: null, interactable: null, character: null, spawn: null,
  };
  if (ctx?.world) {
    idx.region = ids(ctx.world.regions);
    idx.interactable = ids(ctx.world.interactables);
    idx.spawn = ids(ctx.world.spawn_points);
  }
  if (ctx?.characters) idx.character = ids(ctx.characters.characters ?? ctx.characters);
  return idx;
}

/** Which kinds (of the allowed ones) does `ref` resolve to? null = unknowable without ctx. */
function resolves(idx, ref, kinds) {
  // false only when every allowed kind is known and none has the id: without
  // ctx, a region ref cannot be judged, and must not be called dangling.
  let unknowable = false;
  for (const k of kinds) {
    if (k === "none") continue;
    if (idx[k] === null) { unknowable = true; continue; }
    if (idx[k].has(ref)) return true;
  }
  return unknowable ? null : false;
}

function kindOf(idx, ref) {
  for (const k of ["objective", "item", "region", "interactable", "character", "spawn"]) if (idx[k]?.has(ref)) return k;
  return null;
}

function checkRef(iss, idx, ref, kinds, path, what) {
  const r = resolves(idx, ref, kinds);
  if (r === false) {
    const actual = kindOf(idx, ref);
    iss.err(path, actual
      ? `'${ref}' is a ${actual}, but ${what} needs a ${kinds.filter((k) => k !== "none").join(" or ")}`
      : `'${ref}' does not resolve to any ${kinds.filter((k) => k !== "none").join(" or ")}`);
  }
}

/** Find one cycle in the requires graph, as an id path [a, b, …, a], or null. */
export function findRequiresCycle(objectives) {
  const byId = new Map((objectives || []).filter((o) => isStr(o?.id)).map((o) => [o.id, o]));
  const state = new Map();   // 1 = on stack, 2 = done
  const stack = [];
  const visit = (id) => {
    state.set(id, 1); stack.push(id);
    for (const dep of byId.get(id)?.requires || []) {
      if (!byId.has(dep)) continue;
      if (state.get(dep) === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.get(dep)) { const c = visit(dep); if (c) return c; }
    }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const id of byId.keys()) if (!state.get(id)) { const c = visit(id); if (c) return c; }
  return null;
}

export function validateGameplay(g, ctx) {
  const iss = new Issues();
  if (!isObj(g)) { iss.err("", "gameplay must be an object"); return iss.toJSON(); }
  if (g.gameplay_version !== GAMEPLAY_VERSION) iss.err("gameplay_version", `must be "${GAMEPLAY_VERSION}"`);
  requireEnum(iss, g.game_type, GAME_TYPES, "game_type");

  // --- rules / movement / camera / interaction
  const R = g.rules;
  if (!isObj(R)) iss.err("rules", "is required");
  else {
    requireNum(iss, R.player_health, "rules.player_health", { min: 1 });
    requireNum(iss, R.lives, "rules.lives", { min: 1, integer: true });
    if (!isBool(R.fall_damage)) iss.err("rules.fall_damage", "must be a boolean");
    requireNum(iss, R.fall_y, "rules.fall_y");
    if (R.time_limit_s !== null) requireNum(iss, R.time_limit_s, "rules.time_limit_s", { min: 1 });
  }
  const M = g.movement;
  if (!isObj(M)) iss.err("movement", "is required");
  else {
    for (const k of ["walk_speed", "run_speed", "jump_velocity", "player_radius", "player_height"]) requireNum(iss, M[k], `movement.${k}`, { min: 0.01 });
    requireNum(iss, M.gravity, "movement.gravity", { max: -0.01 });
    requireNum(iss, M.max_slope_deg, "movement.max_slope_deg", { min: 1, max: 89 });
    requireNum(iss, M.step_height, "movement.step_height", { min: 0, max: 5 });
    requireNum(iss, M.air_control, "movement.air_control", { min: 0, max: 1 });
    if (isNum(M.run_speed) && isNum(M.walk_speed) && M.run_speed < M.walk_speed) iss.warn("movement.run_speed", "is slower than walk_speed");
  }
  const C = g.camera;
  if (!isObj(C)) iss.err("camera", "is required");
  else {
    requireEnum(iss, C.mode, CAMERA_MODES, "camera.mode");
    requireNum(iss, C.distance, "camera.distance", { min: 0 });
    requireNum(iss, C.height, "camera.height");
    requireNum(iss, C.fov, "camera.fov", { min: 20, max: 120 });
    requireNum(iss, C.sensitivity, "camera.sensitivity", { min: 0.01 });
  }
  const I = g.interaction;
  if (!isObj(I)) iss.err("interaction", "is required");
  else {
    requireNum(iss, I.radius, "interaction.radius", { min: 0.1 });
    if (!isStr(I.key)) iss.err("interaction.key", "is required");
    requireNum(iss, I.hold_ms, "interaction.hold_ms", { min: 0 });
  }

  // --- inventory
  const inv = g.inventory;
  if (!isObj(inv)) iss.err("inventory", "is required");
  else {
    requireNum(iss, inv.slots, "inventory.slots", { min: 1, integer: true });
    uniqueIds(iss, inv.items, "inventory.items");
    (isArr(inv.items) ? inv.items : []).forEach((it, i) => {
      const p = `inventory.items[${i}]`;
      if (!isObj(it)) return;
      if (!isStr(it.name)) iss.err(`${p}.name`, "is required");
      requireEnum(iss, it.kind, ITEM_KINDS, `${p}.kind`);
      if (!isBool(it.stackable)) iss.err(`${p}.stackable`, "must be a boolean");
      requireNum(iss, it.max_stack, `${p}.max_stack`, { min: 1, integer: true });
      if (!(it.icon_ref === null || isStr(it.icon_ref))) iss.err(`${p}.icon_ref`, "must be a string or null");
      if (it.effect !== undefined) {
        if (!isObj(it.effect)) iss.err(`${p}.effect`, "must be an object");
        else if (it.effect.heal !== undefined) requireNum(iss, it.effect.heal, `${p}.effect.heal`, { min: 0 });
      }
    });
    if (isArr(inv.items) && isNum(inv.slots) && inv.items.length > inv.slots) iss.warn("inventory.slots", "fewer slots than distinct items");
  }

  const idx = refIndex(g, ctx);

  // --- objectives
  const objs = isArr(g.objectives) ? g.objectives : [];
  if (!isArr(g.objectives) || !objs.length) iss.err("objectives", "needs at least one objective");
  else uniqueIds(iss, objs, "objectives");
  const byId = new Map(objs.filter((o) => isStr(o?.id)).map((o) => [o.id, o]));
  objs.forEach((o, i) => {
    const p = `objectives[${i}]`;
    if (!isObj(o)) { iss.err(p, "must be an object"); return; }
    if (!isStr(o.title)) iss.err(`${p}.title`, "is required");
    if (typeof o.description !== "string") iss.err(`${p}.description`, "must be a string");
    const kindOk = requireEnum(iss, o.kind, OBJECTIVE_KINDS, `${p}.kind`);
    if (o.count !== undefined) requireNum(iss, o.count, `${p}.count`, { min: 1 });
    if (!isBool(o.optional)) iss.err(`${p}.optional`, "must be a boolean");
    if (!isArr(o.requires)) iss.err(`${p}.requires`, "must be an array of objective ids");
    else o.requires.forEach((r, k) => {
      if (!byId.has(r)) iss.err(`${p}.requires[${k}]`, `'${r}' is not an objective`);
      else if (r === o.id) iss.err(`${p}.requires[${k}]`, "an objective cannot require itself");
      else if (o.optional !== true && byId.get(r).optional === true) {
        iss.err(`${p}.requires[${k}]`, `required objective '${o.id}' depends on optional '${r}'`, "make the dependency required or drop it");
      }
    });
    if (!isObj(o.reward)) iss.err(`${p}.reward`, "is required ({ xp })");
    else {
      requireNum(iss, o.reward.xp, `${p}.reward.xp`, { min: 0 });
      if (o.reward.item_ref !== undefined && !idx.item.has(o.reward.item_ref)) iss.err(`${p}.reward.item_ref`, `'${o.reward.item_ref}' is not an inventory item`);
    }
    if (o.item_ref !== undefined && !idx.item.has(o.item_ref)) iss.err(`${p}.item_ref`, `'${o.item_ref}' is not an inventory item`);
    if (!kindOk) return;
    const allowed = OBJECTIVE_TARGETS[o.kind];
    if (o.target_ref === null || o.target_ref === undefined || o.target_ref === "") {
      if (!allowed.includes("none")) iss.err(`${p}.target_ref`, `is required for a ${o.kind} objective`);
    } else if (!isStr(o.target_ref)) iss.err(`${p}.target_ref`, "must be a string");
    else {
      checkRef(iss, idx, o.target_ref, allowed, `${p}.target_ref`, `a ${o.kind} objective`);
      // §4.5: a character is talkable only through its ix_talk_<id> interactable.
      if (o.kind === "talk" && idx.interactable && idx.character?.has(o.target_ref) && !idx.interactable.has(`ix_talk_${o.target_ref}`)) {
        iss.err(`${p}.target_ref`, `'${o.target_ref}' has no ix_talk_${o.target_ref} interactable, so it cannot be talked to`);
      }
    }
  });
  const cycle = findRequiresCycle(objs);
  if (cycle) iss.err("objectives", `requires graph has a cycle: ${cycle.join(" → ")}`, "remove one of the requires edges");
  const required = objs.filter((o) => o?.optional === false);
  if (objs.length && !required.length) iss.warn("objectives", "every objective is optional");

  // --- events
  const events = isArr(g.events) ? g.events : [];
  if (!isArr(g.events)) iss.err("events", "must be an array");
  else uniqueIds(iss, events, "events");
  events.forEach((e, i) => {
    const p = `events[${i}]`;
    if (!isObj(e)) { iss.err(p, "must be an object"); return; }
    if (!isBool(e.once)) iss.err(`${p}.once`, "must be a boolean");
    const t = e.trigger;
    if (!isObj(t)) iss.err(`${p}.trigger`, "is required");
    else if (requireEnum(iss, t.kind, TRIGGER_KINDS, `${p}.trigger.kind`)) {
      if (TRIGGER_TARGETS[t.kind]) {
        if (!isStr(t.ref)) iss.err(`${p}.trigger.ref`, `is required for a ${t.kind} trigger`);
        else checkRef(iss, idx, t.ref, TRIGGER_TARGETS[t.kind], `${p}.trigger.ref`, `a ${t.kind} trigger`);
      }
      if (["timer", "item_count", "health_below"].includes(t.kind)) requireNum(iss, t.value, `${p}.trigger.value`, { min: t.kind === "timer" ? 0 : 1 });
    }
    if (!isArr(e.actions) || !e.actions.length) iss.err(`${p}.actions`, "needs at least one action");
    else e.actions.forEach((a, k) => validateAction(iss, idx, a, `${p}.actions[${k}]`));
  });

  // --- combat / hazards
  const cb = g.combat;
  if (!isObj(cb)) iss.err("combat", "is required");
  else {
    if (!isBool(cb.enabled)) iss.err("combat.enabled", "must be a boolean");
    requireEnum(iss, cb.mode, COMBAT_MODES, "combat.mode");
    requireNum(iss, cb.player_damage, "combat.player_damage", { min: 0 });
    requireNum(iss, cb.hazard_damage_per_s, "combat.hazard_damage_per_s", { min: 0 });
    if (cb.enabled === false && cb.mode === "melee") iss.warn("combat.mode", "melee with combat disabled");
  }
  const hz = isArr(g.hazards) ? g.hazards : [];
  if (!isArr(g.hazards)) iss.err("hazards", "must be an array");
  else uniqueIds(iss, hz, "hazards");
  hz.forEach((h, i) => {
    const p = `hazards[${i}]`;
    if (!isObj(h)) return;
    requireEnum(iss, h.kind, HAZARD_KINDS, `${p}.kind`);
    requireNum(iss, h.damage_per_s, `${p}.damage_per_s`, { min: 0 });
    if (h.region !== undefined && h.region !== null) {
      if (!isStr(h.region)) iss.err(`${p}.region`, "must be a region id");
      else checkRef(iss, idx, h.region, ["region"], `${p}.region`, "a hazard region");
    }
    if (h.character_ref !== undefined && h.character_ref !== null) {
      if (!isStr(h.character_ref)) iss.err(`${p}.character_ref`, "must be a character id");
      else checkRef(iss, idx, h.character_ref, ["character"], `${p}.character_ref`, "a hazard");
    }
    if (h.kind === "sentinel" && !isStr(h.character_ref)) iss.err(`${p}.character_ref`, "a sentinel hazard follows a character");
    if (["storm_zone", "fire", "deep_water"].includes(h.kind) && !isStr(h.region)) iss.warn(`${p}.region`, `${h.kind} without a region applies everywhere`);
    if (h.active_after !== undefined && h.active_after !== null && !byId.has(h.active_after)) iss.err(`${p}.active_after`, `'${h.active_after}' is not an objective`);
    if (h.kind === "sentinel" && isStr(h.character_ref) && ctx?.characters) {
      const ch = (ctx.characters.characters ?? []).find((c) => c.id === h.character_ref);
      if (ch && ch.behavior && ch.behavior.hostile === false) iss.warn(`${p}.character_ref`, `sentinel '${ch.id}' is not hostile`);
    }
  });

  // --- progression / difficulty
  const pr = g.progression;
  if (!isObj(pr)) iss.err("progression", "is required");
  else {
    requireNum(iss, pr.xp_per_level, "progression.xp_per_level", { min: 1 });
    requireNum(iss, pr.max_level, "progression.max_level", { min: 1, integer: true });
  }
  const d = g.difficulty;
  if (!isObj(d)) iss.err("difficulty", "is required");
  else {
    requireEnum(iss, d.level, DIFFICULTY_LEVELS, "difficulty.level");
    for (const k of ["damage_mult", "speed_mult", "time_mult"]) requireNum(iss, d[k], `difficulty.${k}`, { min: 0.01, max: 10 });
  }

  // --- checkpoints
  const cps = isArr(g.checkpoints) ? g.checkpoints : [];
  if (!isArr(g.checkpoints)) iss.err("checkpoints", "must be an array");
  else uniqueIds(iss, cps, "checkpoints");
  cps.forEach((c, i) => {
    const p = `checkpoints[${i}]`;
    if (!isObj(c)) return;
    if (!isStr(c.spawn_ref)) iss.err(`${p}.spawn_ref`, "is required");
    else checkRef(iss, idx, c.spawn_ref, ["spawn"], `${p}.spawn_ref`, "a checkpoint");
    if (!isObj(c.trigger)) { iss.err(`${p}.trigger`, "is required"); return; }
    if (!requireEnum(iss, c.trigger.kind, ["objective_complete", "enter_region"], `${p}.trigger.kind`)) return;
    if (!isStr(c.trigger.ref)) iss.err(`${p}.trigger.ref`, "is required");
    else checkRef(iss, idx, c.trigger.ref, c.trigger.kind === "enter_region" ? ["region"] : ["objective"], `${p}.trigger.ref`, `a ${c.trigger.kind} checkpoint trigger`);
  });
  if (ctx?.world && idx.spawn && idx.spawn.size && !(ctx.world.spawn_points || []).some((s) => s?.kind === "player")) iss.err("ctx.world.spawn_points", "the world has no player spawn to respawn at");

  // --- win / lose
  const wins = isArr(g.win_conditions) ? g.win_conditions : [];
  if (!wins.length) iss.err("win_conditions", "needs at least one win condition");
  let satisfiable = false;
  wins.forEach((w, i) => {
    const p = `win_conditions[${i}]`;
    if (!isObj(w) || !requireEnum(iss, w.kind, WIN_KINDS, `${p}.kind`)) return;
    if (w.kind === "all_required_objectives") {
      if (required.length && !cycle) satisfiable = true;
      else if (!required.length) iss.warn(p, "there are no required objectives, so this can never be the condition that wins");
    } else if (w.kind === "objective") {
      if (!byId.has(w.ref)) iss.err(`${p}.ref`, `'${w.ref}' is not an objective`);
      else if (!cycle) satisfiable = true;
    } else if (w.kind === "item_count") {
      if (!idx.item.has(w.ref)) iss.err(`${p}.ref`, `'${w.ref}' is not an inventory item`);
      else if (!requireNum(iss, w.value, `${p}.value`, { min: 1 })) { /* reported */ }
      else if (ctx?.world) {
        const supply = itemSupply(g, ctx.world)[w.ref] || 0;
        if (supply < w.value) iss.err(p, `needs ${w.value} × '${w.ref}' but the world and rewards supply only ${supply}`);
        else satisfiable = true;
      } else satisfiable = true;
    } else if (w.kind === "reach_region") {
      if (!isStr(w.ref)) iss.err(`${p}.ref`, "is required");
      else {
        const r = resolves(idx, w.ref, ["region"]);
        if (r === false) iss.err(`${p}.ref`, `'${w.ref}' is not a region`);
        else satisfiable = true;
      }
    }
  });
  if (wins.length && !satisfiable) iss.err("win_conditions", "no win condition is satisfiable");

  const loses = isArr(g.lose_conditions) ? g.lose_conditions : null;
  if (!loses) iss.err("lose_conditions", "must be an array");
  (loses || []).forEach((l, i) => {
    const p = `lose_conditions[${i}]`;
    if (!isObj(l) || !requireEnum(iss, l.kind, LOSE_KINDS, `${p}.kind`)) return;
    if (l.kind === "time_expired" && !(isObj(R) && isNum(R.time_limit_s))) iss.err(p, "time_expired needs rules.time_limit_s");
    if (l.kind === "npc_lost") {
      if (!isStr(l.ref)) iss.err(`${p}.ref`, "npc_lost needs a character ref");
      else checkRef(iss, idx, l.ref, ["character"], `${p}.ref`, "npc_lost");
    }
  });
  if (isObj(R) && isNum(R.time_limit_s) && loses && !loses.some((l) => l?.kind === "time_expired")) iss.warn("rules.time_limit_s", "a time limit with no time_expired lose condition never ends the game");

  // --- world-level collect supply: a collect objective the world cannot feed is a softlock.
  if (ctx?.world) {
    const supply = itemSupply(g, ctx.world);
    const demand = {};
    objs.forEach((o, i) => {
      if (o?.kind !== "collect" || !isStr(o.target_ref) || !idx.item.has(o.target_ref)) return;
      const need = isNum(o.count) ? o.count : 1;
      if (!supply[o.target_ref]) iss.err(`objectives[${i}].target_ref`, `nothing in the world grants '${o.target_ref}'`, "add a pickup/container with this item_ref, or a reward/give_item");
      else if (o.optional === false) demand[o.target_ref] = Math.max(demand[o.target_ref] || 0, need);
    });
    for (const [item, need] of Object.entries(demand)) {
      if ((supply[item] || 0) < need) iss.err("objectives", `required objectives need ${need} × '${item}' but only ${supply[item]} exist`);
    }
    // Every item a world interactable grants must be defined in the inventory.
    (ctx.world.interactables || []).forEach((x, i) => {
      if (isStr(x?.item_ref) && !idx.item.has(x.item_ref)) iss.err(`ctx.world.interactables[${i}].item_ref`, `'${x.item_ref}' has no inventory.items entry`);
    });
  }

  return iss.toJSON();
}

function validateAction(iss, idx, a, p) {
  if (!isObj(a)) { iss.err(p, "must be an object"); return; }
  if (!requireEnum(iss, a.kind, ACTION_KINDS, `${p}.kind`)) return;
  if (ACTION_TARGETS[a.kind]) {
    if (!isStr(a.ref)) iss.err(`${p}.ref`, `is required for ${a.kind}`);
    else checkRef(iss, idx, a.ref, ACTION_TARGETS[a.kind], `${p}.ref`, a.kind);
  }
  switch (a.kind) {
    case "message": if (!isStr(a.value)) iss.err(`${p}.value`, "message text is required"); break;
    case "set_npc_state": requireEnum(iss, a.value, NPC_STATES, `${p}.value`); break;
    case "set_weather": requireEnum(iss, a.value, WEATHERS, `${p}.value`); break;
    case "set_time": requireNum(iss, a.value, `${p}.value`, { min: 0, max: 1 }); break;
    case "damage": case "heal": requireNum(iss, a.value, `${p}.value`, { min: 0 }); break;
    case "give_item": case "remove_item": requireNum(iss, a.value, `${p}.value`, { min: 1, integer: true, optional: true }); break;
    case "set_flag": case "play_cinematic": if (!isStr(a.ref)) iss.err(`${p}.ref`, `is required for ${a.kind}`); break;
    default: break;
  }
}

/** How many of each item the world (pickups/containers) plus rewards and give_item actions can provide. */
export function itemSupply(gameplay, world) {
  const s = {};
  for (const x of world?.interactables || []) if (isStr(x?.item_ref)) s[x.item_ref] = (s[x.item_ref] || 0) + 1;
  for (const o of gameplay?.objectives || []) if (isStr(o?.reward?.item_ref)) s[o.reward.item_ref] = (s[o.reward.item_ref] || 0) + 1;
  for (const e of gameplay?.events || []) for (const a of e?.actions || []) {
    if (a?.kind === "give_item" && isStr(a.ref)) s[a.ref] = (s[a.ref] || 0) + (isNum(a.value) ? a.value : 1);
  }
  return s;
}
