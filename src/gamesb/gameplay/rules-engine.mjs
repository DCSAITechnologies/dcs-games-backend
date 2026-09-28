// Games-B rules engine (CONTRACT §5). ISOMORPHIC — runs in the browser runtime.
//
// The whole game logic is a pure reducer: (state, gameplay, event) → (state',
// effects). The simulation turns physical happenings (walked into a region,
// pressed E near a pickup) into events and realises the returned effects
// (move an NPC, respawn the player). Keeping it pure is what lets the solver,
// the headless playtest and save/restore all share one definition of "what
// happens when", and lets a save be a plain JSON copy of the state.
//
// Semantics beyond the contract text (documented in DCS_GAMES_GAMEPLAY_SCHEMA.md):
//  - Objectives start locked; any whose `requires` are all done become active,
//    at creation and after every completion (cascading).
//  - A `collect` objective, when it becomes active, counts items already held:
//    pickups are spread over the map, and a player who grabbed one early must
//    not be soft-locked because the objective was still locked at the time.
//  - Triggers on a condition (timer, item_count, health_below) are edge-triggered:
//    they fire when the condition becomes true, not on every event while true.
//  - Effects of `game_start` events (and of objectives active at start) are
//    produced by createGameState, kept in `state.pending`, and handed out as
//    the effects of the first applyGameEvent call.

// A cascade (completion → event → give_item → completion …) is bounded so a
// malformed spec cannot hang the browser tab.
const MAX_STEPS = 512;

const DEFAULT_SPAWN = "spawn_player";

// ------------------------------------------------------------------ copying

/** Explicit copy of every mutable part of a GameState (no structuredClone needed). */
function copyState(s) {
  return {
    ...s,
    inventory: { ...s.inventory },
    objectives: { ...s.objectives },
    progress: { ...s.progress },
    fired: [...s.fired],
    flags: { ...s.flags },
    messages: s.messages.map((m) => ({ ...m })),
    npc_states: { ...s.npc_states },
    pending: (s.pending || []).map((a) => ({ ...a })),
    unlocked: [...(s.unlocked || [])],
    visited: [...(s.visited || [])],
  };
}

const diff = (g) => g.difficulty || { damage_mult: 1, speed_mult: 1, time_mult: 1 };
const count = (o) => (typeof o.count === "number" && o.count > 0 ? o.count : 1);

export function timeLimit(gameplay) {
  const tl = gameplay.rules?.time_limit_s;
  if (typeof tl !== "number" || !(tl > 0)) return null;
  return tl * (diff(gameplay).time_mult || 1);
}

// ----------------------------------------------------------------- creation

export function createGameState(gameplay) {
  const state = {
    t: 0,
    status: "playing",
    health: gameplay.rules.player_health,
    lives: gameplay.rules.lives,
    xp: 0,
    level: 1,
    inventory: {},
    objectives: {},
    progress: {},
    fired: [],
    flags: {},
    checkpoint: null,
    messages: [],
    npc_states: {},
    weather: gameplay.weather ?? null,
    time_of_day: gameplay.time_of_day ?? null,
    // Optional additions (contract: add-only): effects awaiting delivery,
    // unlocked ids, and regions visited (for reach_region win conditions).
    pending: [],
    unlocked: [],
    visited: [],
  };
  for (const o of gameplay.objectives) { state.objectives[o.id] = "locked"; state.progress[o.id] = 0; }
  const ctx = { gameplay, state, effects: [], steps: 0 };
  for (const e of gameplay.events || []) if (e.trigger?.kind === "game_start") fireEvent(ctx, e);
  refreshActive(ctx);
  settle(ctx);
  state.pending = ctx.effects;
  return state;
}

// ------------------------------------------------------------- the reducer

export function applyGameEvent(state, gameplay, evt) {
  const s = copyState(state);
  const effects = s.pending;
  s.pending = [];
  if (s.status !== "playing" || !evt || typeof evt !== "object") return { state: s, effects };
  const ctx = { gameplay, state: s, effects, steps: 0 };

  switch (evt.kind) {
    case "tick": tick(ctx, Number(evt.dt) || 0); break;
    case "enter_region": enterRegion(ctx, evt.ref); break;
    case "interact": {
      progressMatching(ctx, (o) => (o.kind === "interact" || o.kind === "activate") && o.target_ref === evt.ref, 1);
      // Interacting with a talk interactable is talking to its character.
      if (typeof evt.ref === "string" && evt.ref.startsWith("ix_talk_")) talk(ctx, evt.ref.slice(8));
      fireMatching(ctx, "interact", evt.ref);
      break;
    }
    case "talk": talk(ctx, typeof evt.ref === "string" && evt.ref.startsWith("ix_talk_") ? evt.ref.slice(8) : evt.ref); break;
    case "pickup": acquire(ctx, evt.ref, Math.max(1, Math.floor(Number(evt.count) || 1))); break;
    case "damage": damage(ctx, Number(evt.value) || 0); break;
    case "fell_out":
      if (gameplay.rules.fall_damage) die(ctx, "fell_out");
      else ctx.effects.push({ kind: "respawn", ref: s.checkpoint || DEFAULT_SPAWN, reason: "fell_out" });
      break;
    case "npc_state":
      s.npc_states[evt.ref] = evt.value;
      if (["arrived", "escorted"].includes(evt.value)) progressMatching(ctx, (o) => o.kind === "escort" && o.target_ref === evt.ref, 1);
      break;
    case "deliver": deliver(ctx, evt.ref, evt.item); break;
    case "defeat":
      s.npc_states[evt.ref] = "defeated";
      progressMatching(ctx, (o) => o.kind === "defeat" && o.target_ref === evt.ref, 1);
      break;
    default: break;
  }
  settle(ctx);
  return { state: s, effects: ctx.effects };
}

export function evaluateEnd(state, gameplay) {
  if (state.status === "won" || state.status === "lost") return state.status;
  const lose = gameplay.lose_conditions || [];
  for (const l of lose) {
    if (l.kind === "lives_zero" && state.lives <= 0) return "lost";
    if (l.kind === "health_zero" && state.health <= 0 && state.lives <= 0) return "lost";
    if (l.kind === "time_expired") { const tl = timeLimit(gameplay); if (tl !== null && state.t >= tl) return "lost"; }
    if (l.kind === "npc_lost" && ["lost", "dead"].includes(state.npc_states[l.ref])) return "lost";
    // fell_out is realised through the life system (see die()), never directly here.
  }
  for (const w of gameplay.win_conditions || []) {
    if (w.kind === "all_required_objectives") {
      const req = gameplay.objectives.filter((o) => !o.optional);
      if (req.length && req.every((o) => state.objectives[o.id] === "done")) return "won";
    } else if (w.kind === "objective" && state.objectives[w.ref] === "done") return "won";
    else if (w.kind === "item_count" && (state.inventory[w.ref] || 0) >= (w.value ?? 1)) return "won";
    else if (w.kind === "reach_region" && (state.visited || []).includes(w.ref)) return "won";
  }
  return "playing";
}

// ------------------------------------------------------------ event handlers

function tick(ctx, dt) {
  const s = ctx.state;
  if (!(dt > 0)) return;
  const t0 = s.t;
  s.t = t0 + dt;
  // Survive objectives count seconds while active.
  progressMatching(ctx, (o) => o.kind === "survive", dt);
  for (const e of ctx.gameplay.events || []) {
    if (e.trigger?.kind !== "timer") continue;
    const v = Number(e.trigger.value) || 0;
    if (e.once) { if (t0 < v && s.t >= v) fireEvent(ctx, e); continue; }
    // A repeating timer fires once per `value` seconds crossed.
    if (v > 0) { const n = Math.floor(s.t / v) - Math.floor(t0 / v); for (let i = 0; i < n; i++) fireEvent(ctx, e); }
  }
}

function enterRegion(ctx, ref) {
  const s = ctx.state;
  if (!s.visited.includes(ref)) s.visited.push(ref);
  progressMatching(ctx, (o) => o.kind === "reach" && o.target_ref === ref, 1);
  for (const c of ctx.gameplay.checkpoints || []) if (c.trigger?.kind === "enter_region" && c.trigger.ref === ref) setCheckpoint(ctx, c.spawn_ref);
  fireMatching(ctx, "enter_region", ref);
}

function talk(ctx, charId) {
  progressMatching(ctx, (o) => o.kind === "talk" && o.target_ref === charId, 1);
  fireMatching(ctx, "talk", charId);
}

function deliver(ctx, target, item) {
  const s = ctx.state;
  for (const o of ctx.gameplay.objectives) {
    if (o.kind !== "deliver" || o.target_ref !== target || s.objectives[o.id] !== "active") continue;
    const want = o.item_ref ?? item;
    if (!want || (o.item_ref && item && item !== o.item_ref)) continue;
    if ((s.inventory[want] || 0) < 1) continue;
    changeItem(ctx, want, -1);
    advance(ctx, o, 1);
    return;
  }
}

function damage(ctx, value) {
  const s = ctx.state;
  if (!(value > 0)) return;
  const before = s.health;
  s.health = Math.max(0, s.health - value * (diff(ctx.gameplay).damage_mult ?? 1));
  healthEdges(ctx, before);
  if (s.health <= 0) die(ctx, "health_zero");
}

/** A death: costs a life; respawns at the checkpoint while lives remain. */
function die(ctx, reason) {
  const s = ctx.state;
  s.health = 0;
  s.lives = Math.max(0, s.lives - 1);
  if (s.lives > 0) {
    s.health = ctx.gameplay.rules.player_health;
    ctx.effects.push({ kind: "respawn", ref: s.checkpoint || DEFAULT_SPAWN, reason });
  }
  // lives == 0 is picked up by settle() → evaluateEnd (lives_zero / health_zero).
  // A spec with neither condition still cannot continue with no lives, so
  // settle() treats that as lost too.
}

// ------------------------------------------------------------ core mechanics

function acquire(ctx, item, n) {
  if (typeof item !== "string" || !(n > 0)) return;
  changeItem(ctx, item, n);
  progressMatching(ctx, (o) => o.kind === "collect" && o.target_ref === item, n);
}

function changeItem(ctx, item, delta) {
  const s = ctx.state;
  const before = s.inventory[item] || 0;
  const def = (ctx.gameplay.inventory?.items || []).find((i) => i.id === item);
  // Unknown items are allowed (a runtime may grant flavour items) and uncapped.
  const max = def && def.max_stack > 0 ? def.max_stack : Infinity;
  const after = Math.max(0, Math.min(before + delta, Math.max(max, before)));
  if (after === 0) delete s.inventory[item]; else s.inventory[item] = after;
  // item_count triggers fire on the rising edge.
  for (const e of ctx.gameplay.events || []) {
    if (e.trigger?.kind === "item_count" && e.trigger.ref === item && before < e.trigger.value && after >= e.trigger.value) fireEvent(ctx, e);
  }
}

function progressMatching(ctx, pred, amount) {
  for (const o of ctx.gameplay.objectives) {
    if (ctx.state.objectives[o.id] === "active" && pred(o)) advance(ctx, o, amount);
  }
}

function advance(ctx, o, amount) {
  const s = ctx.state;
  if (s.objectives[o.id] !== "active") return;
  s.progress[o.id] = (s.progress[o.id] || 0) + amount;
  if (s.progress[o.id] >= count(o)) complete(ctx, o);
}

function complete(ctx, o) {
  const s = ctx.state;
  if (++ctx.steps > MAX_STEPS) return;
  s.objectives[o.id] = "done";
  s.progress[o.id] = Math.max(s.progress[o.id] || 0, count(o));
  const xp = o.reward?.xp || 0;
  if (xp > 0) {
    s.xp += xp;
    const p = ctx.gameplay.progression || { xp_per_level: 100, max_level: 10 };
    const lvl = Math.min(p.max_level, 1 + Math.floor(s.xp / p.xp_per_level));
    if (lvl > s.level) { s.level = lvl; ctx.effects.push({ kind: "level_up", value: lvl }); }
  }
  ctx.effects.push({ kind: "objective_complete", ref: o.id });
  if (o.reward?.item_ref) acquire(ctx, o.reward.item_ref, 1);
  for (const c of ctx.gameplay.checkpoints || []) if (c.trigger?.kind === "objective_complete" && c.trigger.ref === o.id) setCheckpoint(ctx, c.spawn_ref);
  fireMatching(ctx, "objective_complete", o.id);
  refreshActive(ctx);
}

/** Unlock every locked objective whose requires are all done; cascades. */
function refreshActive(ctx) {
  const s = ctx.state;
  let changed = true;
  while (changed && ctx.steps <= MAX_STEPS) {
    changed = false;
    for (const o of ctx.gameplay.objectives) {
      if (s.objectives[o.id] !== "locked") continue;
      if (!(o.requires || []).every((r) => s.objectives[r] === "done")) continue;
      s.objectives[o.id] = "active";
      changed = true;
      ctx.effects.push({ kind: "objective_active", ref: o.id });
      fireMatching(ctx, "objective_active", o.id);
      if (o.kind === "collect") {
        const held = s.inventory[o.target_ref] || 0;
        if (held > (s.progress[o.id] || 0)) { s.progress[o.id] = 0; advance(ctx, o, held); }
      }
    }
  }
}

function setCheckpoint(ctx, spawn) {
  if (ctx.state.checkpoint === spawn) return;
  ctx.state.checkpoint = spawn;
  ctx.effects.push({ kind: "checkpoint", ref: spawn });
}

function healthEdges(ctx, before) {
  const s = ctx.state;
  for (const e of ctx.gameplay.events || []) {
    if (e.trigger?.kind === "health_below" && before >= e.trigger.value && s.health < e.trigger.value) fireEvent(ctx, e);
  }
}

// ------------------------------------------------------------------ events

function fireMatching(ctx, kind, ref) {
  for (const e of ctx.gameplay.events || []) if (e.trigger?.kind === kind && e.trigger.ref === ref) fireEvent(ctx, e);
}

function fireEvent(ctx, e) {
  const s = ctx.state;
  if (e.once && s.fired.includes(e.id)) return;
  if (++ctx.steps > MAX_STEPS) return;
  if (!s.fired.includes(e.id)) s.fired.push(e.id);
  for (const a of e.actions || []) runAction(ctx, a);
}

function runAction(ctx, a) {
  const s = ctx.state;
  const g = ctx.gameplay;
  const fx = { ...a };
  switch (a.kind) {
    case "message": s.messages.push({ t: s.t, text: String(a.value ?? "") }); break;
    case "give_item": acquire(ctx, a.ref, Math.max(1, Math.floor(Number(a.value) || 1))); break;
    case "remove_item": changeItem(ctx, a.ref, -Math.max(1, Math.floor(Number(a.value) || 1))); break;
    case "set_npc_state": s.npc_states[a.ref] = a.value; break;
    case "unlock": if (!s.unlocked.includes(a.ref)) s.unlocked.push(a.ref); break;
    case "set_weather": s.weather = a.value; break;
    case "set_time": s.time_of_day = a.value; break;
    case "checkpoint": if (s.checkpoint === a.ref) return; s.checkpoint = a.ref; break;
    case "damage": {
      // Emit first, so the effect list reads cause → consequence (damage, respawn).
      ctx.effects.push(fx);
      damage(ctx, Number(a.value) || 0);
      return;
    }
    case "heal": {
      const before = s.health;
      s.health = Math.min(g.rules.player_health, s.health + (Number(a.value) || 0));
      if (s.health < before) healthEdges(ctx, before);
      break;
    }
    case "win": if (s.status === "playing") s.status = "won"; break;
    case "lose": if (s.status === "playing") s.status = "lost"; break;
    case "reveal": s.flags[`revealed:${a.ref}`] = true; break;
    case "set_flag": s.flags[a.ref] = a.value === undefined ? true : a.value; break;
    case "play_cinematic": break;
    default: return;
  }
  ctx.effects.push(fx);
}

/** After an event: resolve win/lose once, and make terminal status stick. */
function settle(ctx) {
  const s = ctx.state;
  if (s.status === "playing") {
    let st = evaluateEnd(s, ctx.gameplay);
    if (st === "playing" && s.lives <= 0) st = "lost";   // no lives left is never playable
    if (st !== "playing") s.status = st;
  }
  if (s.status !== "playing" && !ctx.effects.some((e) => e.kind === (s.status === "won" ? "win" : "lose"))) {
    ctx.effects.push({ kind: s.status === "won" ? "win" : "lose" });
  }
}
