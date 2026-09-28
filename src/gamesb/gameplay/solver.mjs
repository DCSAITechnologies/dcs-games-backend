// Games-B objective solver. ISOMORPHIC.
//
// A logical proof that the objectives can be finished: it drives the REAL rules
// engine with the event each objective needs, so "solvable" means solvable
// under the same semantics the game runs, not under a second opinion of them.
// Physical reachability is delegated: `reachable(targetRef)` is supplied by the
// caller (the runtime/playtest combines it with nav-grid pathfinding). The
// default treats every target as reachable, which makes this a pure logic check.
//
// Search: objectives only ever move locked → active → done and completing one
// never re-locks another, so progress is monotonic and greedy is complete for
// the "can every required objective be finished" question — there is no
// ordering the greedy pass could get wrong that a BFS would get right. The
// one non-monotonic action is `deliver` (consumes an item); it is attempted
// only when the item is held.
import { createGameState, applyGameEvent } from "./rules-engine.mjs";

const MAX_ROUNDS = 1000;

/** The event (or events) that complete one objective, given the current state. */
function eventsFor(o, state) {
  const need = Math.max(1, (typeof o.count === "number" ? o.count : 1) - (state.progress[o.id] || 0));
  switch (o.kind) {
    case "reach": return [{ kind: "enter_region", ref: o.target_ref }];
    case "talk": return [{ kind: "talk", ref: o.target_ref }];
    case "interact": case "activate": return Array.from({ length: Math.ceil(need) }, () => ({ kind: "interact", ref: o.target_ref }));
    case "collect": return [{ kind: "pickup", ref: o.target_ref, count: Math.ceil(need) }];
    case "defeat": return [{ kind: "defeat", ref: o.target_ref }];
    case "escort": return [{ kind: "npc_state", ref: o.target_ref, value: "arrived" }];
    case "survive": return [{ kind: "tick", dt: need }];
    case "deliver": {
      const item = o.item_ref || Object.keys(state.inventory).find((k) => state.inventory[k] > 0);
      return item ? Array.from({ length: Math.ceil(need) }, () => ({ kind: "deliver", ref: o.target_ref, item })) : [];
    }
    default: return [];
  }
}

/**
 * @param {object} gameplay  a GameplaySpec
 * @param {{ reachable?: (ref: string) => boolean, locks?: Record<string,string> }} opts
 *   `locks` maps interactable id → item id needed (WorldSpec `locked_by`), so an
 *   activate on a locked altar waits until the key is held.
 * @returns {{ solvable: boolean, plan: {objective_id, kind, target_ref}[], reason?: string, blocked?: object[] }}
 */
export function solveGameplay(gameplay, { reachable = () => true, locks = {} } = {}) {
  let state = createGameState(gameplay);
  ({ state } = applyGameEvent(state, gameplay, { kind: "tick", dt: 0 }));   // drain start effects
  const plan = [];
  const tried = new Set();

  const canAttempt = (o) => {
    if (o.kind === "survive") return o.target_ref ? reachable(o.target_ref) : true;
    if (!reachable(o.target_ref)) return false;
    const lock = locks[o.target_ref];
    if ((o.kind === "activate" || o.kind === "interact") && lock && !(state.inventory[lock] > 0)) return false;
    if (o.kind === "deliver") {
      const item = o.item_ref;
      if (item ? !(state.inventory[item] > 0) : !Object.values(state.inventory).some((n) => n > 0)) return false;
    }
    return true;
  };

  for (let round = 0; round < MAX_ROUNDS && state.status === "playing"; round++) {
    const active = gameplay.objectives.filter((o) => state.objectives[o.id] === "active");
    // Required objectives first, then optional ones (they may unlock rewards a
    // win condition needs); array order breaks ties so the plan is stable.
    const order = [...active.filter((o) => !o.optional), ...active.filter((o) => o.optional)];
    const next = order.find((o) => canAttempt(o) && !tried.has(`${o.id}@${state.progress[o.id] || 0}`));
    if (!next) break;
    tried.add(`${next.id}@${state.progress[next.id] || 0}`);
    for (const evt of eventsFor(next, state)) ({ state } = applyGameEvent(state, gameplay, evt));
    if (state.objectives[next.id] === "done") plan.push({ objective_id: next.id, kind: next.kind, target_ref: next.target_ref ?? null });
  }

  if (state.status === "won") return { solvable: true, plan };
  const blocked = gameplay.objectives.filter((o) => !o.optional && state.objectives[o.id] !== "done").map((o) => {
    const st = state.objectives[o.id];
    let why;
    if (st === "locked") why = `waiting on ${(o.requires || []).filter((r) => state.objectives[r] !== "done").join(", ")}`;
    else if (o.target_ref && !reachable(o.target_ref)) why = `target '${o.target_ref}' is unreachable`;
    else if (locks[o.target_ref] && !(state.inventory[locks[o.target_ref]] > 0)) why = `'${o.target_ref}' is locked by '${locks[o.target_ref]}', which is never obtained`;
    else why = "no event completes it";
    return { objective_id: o.id, state: st, why };
  });
  const reason = state.status === "lost"
    ? `the game is lost before it can be won (t=${state.t}s)`
    : blocked.length
      ? `stuck: ${blocked.map((b) => `${b.objective_id} (${b.why})`).join("; ")}`
      : "every required objective is done but no win condition is met";
  return { solvable: false, plan, reason, blocked };
}

/** Locks map from a WorldSpec, for `solveGameplay(g, { locks: locksFromWorld(world) })`. */
export function locksFromWorld(world) {
  const out = {};
  for (const x of world?.interactables || []) if (typeof x?.locked_by === "string" && x.locked_by) out[x.id] = x.locked_by;
  return out;
}
