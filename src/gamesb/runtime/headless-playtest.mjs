// Games-B headless playtest. Node-side (uses the hash helpers).
//
// The last pipeline gate, and the one that answers the only question a player
// cares about: can this game actually be finished? An autonomous agent drives
// the SAME sim-core the browser runs, with the same kind of input a player
// produces (a wish direction, run, jump, interact, a dialogue choice) — it never
// teleports and never pokes the rules engine directly. If it wins, the package
// is winnable by walking; if it cannot, the failure says where it got stuck.
//
// Midway it also proves save/reload: snapshot, restore into a brand-new sim,
// check the restored snapshot is identical, check that two restored copies
// stay identical under the same inputs, then finish the game on the restored
// sim. A save system that only round-trips its own JSON is not tested by that.

import { createSim, stepSim, snapshot, restoreSim, nearestInteractable, currentDialogue, interactablePosition, SIM_DT } from "./sim-core.mjs";
import { canonicalJson } from "../common/hash.mjs";

const SAVE_NOW = "1970-01-01T00:00:00.000Z"; // fixed saved_at so saves compare byte-for-byte
const TIMELINE_KINDS = new Set(["enter_region", "interact", "talk", "pickup", "deliver", "defeat", "objective_done", "fell_out", "locked", "status", "dialogue_choice"]);

async function defaultDeps() {
  const mod = await import("./deps.mjs");
  return mod.realDeps;
}

// ------------------------------------------------------------ nav helpers

/** Nearest walkable nav-cell centre to (x, z), searching outward ring by ring. */
export function nearestWalkable(nav, isWalkable, x, z, maxRings = 12) {
  const c = nav.cell;
  const ci = Math.floor(x / c), cj = Math.floor(z / c);
  let best = null, bestD = Infinity;
  for (let r = 0; r <= maxRings; r++) {
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= nav.cols || j >= nav.rows) continue;
      const px = (i + 0.5) * c, pz = (j + 0.5) * c;
      if (!isWalkable(nav, px, pz)) continue;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bestD) { bestD = d; best = { x: px, z: pz }; }
    }
    if (best) return best;
  }
  return null;
}

function regionGoal(world, nav, deps, regionId) {
  const r = (world.regions || []).find((x) => x.id === regionId);
  if (!r) return null;
  const [x0, z0, x1, z1] = r.bounds;
  let p = nearestWalkable(nav, deps.nav.isWalkable, r.center?.x ?? (x0 + x1) / 2, r.center?.z ?? (z0 + z1) / 2, 30);
  // The walkable cell nearest the centre can fall outside a thin region.
  if (p && !(p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1)) {
    p = null;
    for (let z = z0 + nav.cell / 2; z < z1 && !p; z += nav.cell) for (let x = x0 + nav.cell / 2; x < x1 && !p; x += nav.cell) {
      if (deps.nav.isWalkable(nav, x, z)) p = { x, z };
    }
  }
  return p;
}

/** Characters whose dialogue can hand out `itemId` (a give_item action). */
function giversOf(pkg, itemId) {
  const out = [];
  for (const d of pkg.characters?.dialogues || []) {
    for (const n of d.nodes || []) for (const c of n.choices || []) {
      if ((c.actions || []).some((a) => a.kind === "give_item" && a.ref === itemId)) out.push(d.character_ref);
    }
  }
  return [...new Set(out)];
}

function talkIxFor(world, cid) {
  return (world.interactables || []).find((i) => i.kind === "talk" && i.character_ref === cid) || null;
}

/**
 * What the agent must do for an objective right now:
 * { kind: "reach", pos } | { kind: "interact", ix } | { kind: "wait" } | null (no way found).
 * Items locked behind other items resolve recursively to the prerequisite.
 */
function goalFor(sim, obj, depth = 0, agent = null) {
  const { pkg } = sim;
  const world = pkg.world;
  const nav = world.navigation;
  const ixById = (id) => (world.interactables || []).find((i) => i.id === id);
  const inv = sim.game.inventory || {};
  const needKey = (ix) => {
    if (ix?.locked_by && !sim.unlocked.includes(ix.id) && !(inv[ix.locked_by] > 0) && depth < 4) {
      return goalFor(sim, { kind: "collect", target_ref: ix.locked_by }, depth + 1);
    }
    return null;
  };
  const viaIx = (ix) => ix ? (needKey(ix) || { kind: "interact", ix }) : null;
  const t = obj.target_ref;
  switch (obj.kind) {
    case "reach": case "escort": {
      if ((world.regions || []).some((r) => r.id === t)) { const pos = regionGoal(world, nav, sim.deps, t); return pos ? { kind: "reach", pos, region: t } : null; }
      if (sim.npcs[t]) return { kind: "reach", pos: sim.npcs[t].position };
      const ix = ixById(t);
      return ix ? viaIx(ix) : null;
    }
    case "collect": {
      const cands = (world.interactables || []).filter((i) => i.item_ref === t && !sim.collected.includes(i.id));
      if (cands.length) {
        const p = sim.player.position;
        cands.sort((a, b) => dist(interactablePosition(sim, a), p) - dist(interactablePosition(sim, b), p) || (a.id < b.id ? -1 : 1));
        return viaIx(cands.find((c) => interactablePosition(sim, c)));
      }
      for (const cid of giversOf(pkg, t)) { const ix = talkIxFor(world, cid); if (ix) return viaIx(ix); }
      return { kind: "wait" };
    }
    case "deliver": {
      // Fetch the item first when the objective names one and it is not held.
      if (obj.item_ref && !(inv[obj.item_ref] > 0) && depth < 4) return goalFor(sim, { kind: "collect", target_ref: obj.item_ref }, depth + 1);
      if (sim.npcs[t]) return viaIx(talkIxFor(world, t)) || { kind: "reach", pos: sim.npcs[t].position };
      return viaIx(ixById(t) || (world.interactables || []).find((i) => i.placement_ref === t));
    }
    case "talk": case "interact": case "activate": {
      if (sim.npcs[t]) return viaIx(talkIxFor(world, t)) || { kind: "reach", pos: sim.npcs[t].position };
      const ix = ixById(t) || (world.interactables || []).find((i) => i.placement_ref === t);
      return viaIx(ix);
    }
    case "defeat": return sim.npcs[t] ? { kind: "defeat", pos: sim.npcs[t].position, ref: t } : null;
    case "survive": {
      // Survive-at-a-location: go there and hold it. When a damaging zone
      // (storm/fire) has worn the agent down, fall back to the nearest safe
      // region until healed, as a player would; the seconds keep counting.
      if (!t || !(world.regions || []).some((r) => r.id === t)) return { kind: "wait" };
      if (agent) {
        const max = pkg.gameplay?.rules?.player_health || 100;
        const hp = sim.game.health ?? max;
        if (agent.retreat && hp >= max * 0.75) agent.retreat = null;
        if (!agent.retreat && hp < max * 0.4 && zoneHurts(sim, sim.region)) agent.retreat = safeRegion(sim, sim.region);
        if (agent.retreat) return { kind: "reach", pos: agent.retreat.pos, region: agent.retreat.id };
      }
      if (sim.region !== t) { const pos = regionGoal(world, nav, sim.deps, t); return pos ? { kind: "reach", pos, region: t } : { kind: "wait" }; }
      return { kind: "hold" };
    }
    default: return null;
  }
}

const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity);

/** Does an active storm/fire zone hurt in this region right now? */
function zoneHurts(sim, region) {
  if (!region) return false;
  return (sim.pkg.gameplay?.hazards || []).some((h) => (h.kind === "storm_zone" || h.kind === "fire") && h.region === region
    && (h.damage_per_s ?? 1) > 0 && (!h.active_after || sim.game.objectives?.[h.active_after] === "done"));
}

/** Nearest region (by walkable goal point) where no zone hurts, other than `except`. */
function safeRegion(sim, except) {
  const world = sim.pkg.world;
  const p = sim.player.position;
  let best = null, bestD = Infinity;
  for (const r of world.regions || []) {
    if (r.id === except || zoneHurts(sim, r.id)) continue;
    const pos = regionGoal(world, world.navigation, sim.deps, r.id);
    const d = dist(pos, p);
    if (pos && (d < bestD || (d === bestD && best && r.id < best.id))) { best = { id: r.id, pos }; bestD = d; }
  }
  return best;
}

/** Unit vector away from nearby live hostiles (zero when none is close). */
function evadeVector(sim, radius = 5.5) {
  const p = sim.player.position;
  let dx = 0, dz = 0;
  for (const ch of sim.pkg.characters?.characters || []) {
    if (!ch.behavior?.hostile || sim.defeated.includes(ch.id)) continue;
    const n = sim.npcs[ch.id];
    const nd = n ? dist(n.position, p) : Infinity;
    if (nd < radius && nd > 0.01) { dx += (p.x - n.position.x) / nd; dz += (p.z - n.position.z) / nd; }
  }
  const l = Math.hypot(dx, dz);
  return l > 0.01 ? { x: dx / l, z: dz / l } : { x: 0, z: 0 };
}

/**
 * Objective order from gameplay/solver.mjs when it is present: it replays the
 * real rules engine, so its order respects every requires/lock/give_item chain.
 * Physical reachability stays the agent's problem — that is what this test is for.
 */
async function loadPlan(pkg) {
  let mod;
  try { mod = await import("../gameplay/solver.mjs"); } catch { return { source: "greedy", order: null }; }
  if (typeof mod.solveGameplay !== "function") return { source: "greedy", order: null };
  try {
    const locks = typeof mod.locksFromWorld === "function" ? mod.locksFromWorld(pkg.world) : {};
    const res = mod.solveGameplay(pkg.gameplay, { locks });
    const order = (res?.plan || []).map((s) => s.objective_id).filter(Boolean);
    return { source: order.length ? "solver" : "greedy", order: order.length ? order : null, solvable: !!res?.solvable, reason: res?.reason };
  } catch (e) {
    return { source: "greedy", order: null, error: String(e?.message || e) };
  }
}

function pickObjective(sim, plan, agent = null) {
  const objs = sim.pkg.gameplay.objectives || [];
  const state = sim.game.objectives || {};
  const active = objs.filter((o) => state[o.id] === "active" && !o.optional);
  if (!active.length) return null;
  if (plan.order) {
    for (const id of plan.order) { const o = active.find((a) => a.id === id); if (o && goalFor(sim, o, 0, agent)?.kind !== "wait") return o; }
  }
  // Greedy: the nearest reachable required objective; ties break on id so the
  // run is deterministic.
  const p = sim.player.position;
  let best = null, bestD = Infinity;
  for (const o of active) {
    const g = goalFor(sim, o, 0, agent);
    if (!g) continue;
    const pos = g.pos || (g.ix && interactablePosition(sim, g.ix));
    const d = g.kind === "wait" ? 1e9 : g.kind === "hold" ? 0 : dist(pos, p);
    if (d < bestD || (d === bestD && best && o.id < best.id)) { best = o; bestD = d; }
  }
  return best || active[0];
}

// ------------------------------------------------------------------ agent

/**
 * Drive a package to its end with an autonomous agent.
 * @returns {Promise<{won, status, sim_seconds, steps, objectives_done, events, stuck_recoveries, save_reload, timeline, plan_source, reason?}>}
 */
export async function headlessPlaytest(pkg, { deps, maxSimSeconds = 1800, saveReloadAt = 0.5 } = {}) {
  deps = deps || await defaultDeps();
  const plan = await loadPlan(pkg);
  let sim = createSim(pkg, deps);
  const nav = pkg.world.navigation;
  const maxSteps = Math.ceil(maxSimSeconds / SIM_DT);
  const required = (pkg.gameplay.objectives || []).filter((o) => !o.optional);
  const saveAtCount = saveReloadAt > 0 ? Math.max(1, Math.ceil(required.length * saveReloadAt)) : Infinity;
  const timeline = [];
  let events = 0, stuck = 0, saveReload = { ok: false, skipped: true };
  const agent = { retreat: null, key: null, path: null, wp: 0, repathAt: 0, checkAt: 0, checkPos: null, recoverUntil: 0, recoverDir: null, pressed: false, lastProgress: 0, convo: null, convoStart: 0, seen: new Set() };

  const log = (e) => { if (timeline.length < 600) timeline.push({ t: Math.round(sim.t * 100) / 100, ...e }); };

  const repath = (goalPos) => {
    const p = sim.player.position;
    const g = nearestWalkable(nav, deps.nav.isWalkable, goalPos.x, goalPos.z, 6) || goalPos;
    const s = deps.nav.isWalkable(nav, p.x, p.z) ? p : (nearestWalkable(nav, deps.nav.isWalkable, p.x, p.z, 4) || p);
    const path = deps.nav.findPath(nav, { x: s.x, z: s.z }, { x: g.x, z: g.z });
    agent.path = path ? [...path, { x: goalPos.x, z: goalPos.z }] : [{ x: goalPos.x, z: goalPos.z }];
    agent.wp = 0;
    agent.repathAt = sim.t + 3;
  };

  for (let i = 0; i < maxSteps && sim.status === "playing"; i++) {
    const input = { move: { x: 0, z: 0 }, run: true, jump: false, interact: false };
    const dlg = currentDialogue(sim);
    if (dlg) {
      // First available choice, as a player skimming dialogue would — except
      // one that loops back to a node already seen in this conversation
      // ("tell me more" → … → back to the greeting), which a real player
      // would stop picking.
      const convo = `${dlg.dialogue_id}@${agent.convoStart}`;
      if (agent.convo !== convo) { agent.convo = convo; agent.seen = new Set(); }
      agent.seen.add(dlg.node.id);
      if (i % 2 === 0) {
        const fresh = dlg.choices.findIndex((c) => c.next && !agent.seen.has(c.next));
        const ends = dlg.choices.findIndex((c) => !c.next);
        input.choice = agent.seen.size > 12 && ends >= 0 ? ends : fresh >= 0 ? fresh : ends >= 0 ? ends : 0;
      }
    } else {
      agent.convoStart = sim.t;
      const obj = pickObjective(sim, plan, agent);
      const goal = obj ? goalFor(sim, obj, 0, agent) : null;
      const key = obj ? `${obj.id}:${goal?.kind}:${goal?.ix?.id || goal?.region || goal?.ref || ""}` : null;
      if (key !== agent.key) { agent.key = key; agent.path = null; }
      if (goal?.kind === "hold") {
        // Holding a position: stand, stepping away from any hostile that closes in.
        agent.pressed = false;
        const v = evadeVector(sim);
        input.move = v;
        input.run = !!(v.x || v.z);
      } else if (goal && goal.kind !== "wait") {
        const target = goal.pos || interactablePosition(sim, goal.ix);
        if (target) {
          if (!agent.path || sim.t >= agent.repathAt) repath(target);
          const near = nearestInteractable(sim);
          const p = sim.player.position;
          if (goal.kind === "interact" && near?.id === goal.ix.id) {
            input.interact = !agent.pressed; // edge: press, release, press…
            agent.pressed = input.interact;
          } else if (goal.kind === "defeat" && dist(target, p) < 2.2) {
            input.interact = !agent.pressed; agent.pressed = input.interact;
          } else {
            agent.pressed = false;
            // Follow the path; the final waypoint is the target itself.
            while (agent.wp < agent.path.length - 1 && dist(agent.path[agent.wp], p) < 0.8) agent.wp++;
            const wp = agent.path[agent.wp];
            let dx = wp.x - p.x, dz = wp.z - p.z;
            const d = Math.hypot(dx, dz);
            if (d > 0.05) { dx /= d; dz /= d; }
            // Keep clear of hostile NPCs the agent is not after.
            for (const ch of pkg.characters?.characters || []) {
              if (!ch.behavior?.hostile || goal.ref === ch.id || goal.ix?.character_ref === ch.id) continue;
              const n = sim.npcs[ch.id];
              const nd = n ? dist(n.position, p) : Infinity;
              if (nd < 5.5 && nd > 0.01) { dx += ((p.x - n.position.x) / nd) * 1.2; dz += ((p.z - n.position.z) / nd) * 1.2; }
            }
            // Slow down on the last approach so the agent does not orbit the target.
            const scale = agent.wp === agent.path.length - 1 && d < 1.5 ? 0.5 : 1;
            const l = Math.hypot(dx, dz) || 1;
            input.move = { x: (dx / l) * scale, z: (dz / l) * scale };
            input.run = scale === 1;
          }
          // Stuck detection: a second of wanting to move without covering ground.
          if (sim.t >= agent.checkAt) {
            if (agent.checkPos && dist(agent.checkPos, p) < 0.35 && !input.interact && (input.move.x || input.move.z)) {
              stuck++;
              agent.recoverUntil = sim.t + 0.6;
              const side = stuck % 2 ? 1 : -1;
              agent.recoverDir = { x: -input.move.z * side, z: input.move.x * side };
              log({ kind: "stuck", pos: { x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 } });
              agent.path = null;
            }
            agent.checkPos = { x: p.x, z: p.z };
            agent.checkAt = sim.t + 1;
          }
          if (sim.t < agent.recoverUntil && agent.recoverDir) {
            input.move = agent.recoverDir;
            input.jump = true;
          }
        }
      }
    }

    const res = stepSim(sim, input);
    for (const e of res.events) {
      events++;
      if (TIMELINE_KINDS.has(e.kind)) log(e.kind === "objective_done" || e.kind === "status" ? e : { kind: e.kind, ref: e.ref ?? e.value ?? null });
      if (e.kind === "objective_done") agent.lastProgress = sim.t;
    }

    // Save/reload at the midpoint of the required objectives.
    const doneReq = required.filter((o) => sim.game.objectives?.[o.id] === "done").length;
    if (saveReload.skipped && sim.status === "playing" && doneReq >= saveAtCount && doneReq < required.length) {
      saveReload = verifySaveReload(pkg, sim, deps);
      log({ kind: "save_reload", ok: saveReload.ok });
      if (saveReload.ok) sim = saveReload.sim;
      delete saveReload.sim;
    }
    if (sim.t - agent.lastProgress > 600) {
      return finish(sim, { stuck, events, timeline, saveReload, plan, reason: "no objective progress for 600 simulated seconds" });
    }
  }
  return finish(sim, { stuck, events, timeline, saveReload, plan, reason: sim.status === "playing" ? `time budget of ${maxSimSeconds}s exhausted` : sim.status === "lost" ? "lost" : null });
}

function finish(sim, { stuck, events, timeline, saveReload, plan, reason }) {
  const objectives_done = Object.entries(sim.game.objectives || {}).filter(([, s]) => s === "done").map(([id]) => id);
  const out = {
    won: sim.status === "won", status: sim.status, package_sha256: sim.pkg.integrity?.sha256 ?? null, sim_seconds: Math.round(sim.t * 100) / 100, steps: sim.stats.steps,
    objectives_done, events, stuck_recoveries: stuck, save_reload: saveReload, timeline, plan_source: plan.source,
    health: sim.game.health, lives: sim.game.lives, falls: sim.stats.falls,
  };
  if (!out.won && reason) out.reason = reason;
  if (!out.won) {
    const pending = (sim.pkg.gameplay.objectives || []).filter((o) => !o.optional && sim.game.objectives?.[o.id] !== "done").map((o) => `${o.id}(${sim.game.objectives?.[o.id]})`);
    out.pending = pending;
  }
  return out;
}

/** Snapshot → restore → snapshot must be identical, and restored copies must evolve identically. */
export function verifySaveReload(pkg, sim, deps, { steps = 180 } = {}) {
  const save = snapshot(sim, { now: SAVE_NOW });
  const restored = restoreSim(pkg, JSON.parse(JSON.stringify(save)), deps);
  const again = snapshot(restored, { now: SAVE_NOW });
  const a = canonicalJson(save), b = canonicalJson(again);
  if (a !== b) return { ok: false, t: save.t, diff: diffKeys(save, again), sim: null };
  // Continuation: two independent restores fed the same inputs must agree.
  const s1 = restoreSim(pkg, save, deps), s2 = restoreSim(pkg, save, deps);
  for (let i = 0; i < steps; i++) {
    const input = { move: { x: Math.sin(i / 20), z: Math.cos(i / 25) }, run: i % 90 < 45, jump: i % 60 === 0, interact: false };
    stepSim(s1, input); stepSim(s2, input);
  }
  const c1 = canonicalJson(snapshot(s1, { now: SAVE_NOW })), c2 = canonicalJson(snapshot(s2, { now: SAVE_NOW }));
  if (c1 !== c2) return { ok: false, t: save.t, diff: ["continuation diverged"], sim: null };
  return { ok: true, t: Math.round(save.t * 100) / 100, bytes: a.length, continuation_steps: steps, sim: restored };
}

function diffKeys(a, b, path = "$", out = []) {
  if (out.length > 20) return out;
  if (canonicalJson(a) === canonicalJson(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffKeys(a[k], b[k], `${path}.${k}`, out);
  } else out.push(path);
  return out;
}

// --------------------------------------------------------- reachability

/**
 * Every objective target must be physically reachable from the player spawn on
 * the nav grid: a walkable cell within interaction range of it must be in the
 * spawn's connected component. Pure grid check — no simulation.
 */
export async function checkObjectiveReachability(pkg, { deps } = {}) {
  deps = deps || await defaultDeps();
  const world = pkg.world;
  const nav = world.navigation;
  const sp = (world.spawn_points || []).find((s) => s.id === "spawn_player") || (world.spawn_points || []).find((s) => s.kind === "player");
  const results = [];
  if (!sp) return { ok: false, results: [{ objective_id: null, reachable: false, reason: "no player spawn" }] };
  const start = nearestWalkable(nav, deps.nav.isWalkable, sp.position.x, sp.position.z, 3);
  if (!start) return { ok: false, results: [{ objective_id: null, reachable: false, reason: "player spawn is not on walkable ground" }] };

  const spawnPos = (cid) => {
    const ch = (pkg.characters?.characters || []).find((c) => c.id === cid);
    return (world.spawn_points || []).find((s) => s.id === ch?.spawn_ref)?.position || null;
  };
  const ixPos = (ix) => ix.placement_ref ? (world.placements || []).find((p) => p.id === ix.placement_ref)?.position : spawnPos(ix.character_ref);
  const targetsFor = (o) => {
    const t = o.target_ref;
    const region = (world.regions || []).find((r) => r.id === t);
    if (region) return [{ pos: regionGoal(world, nav, deps, t), radius: 0 }];
    const ix = (world.interactables || []).find((i) => i.id === t || i.placement_ref === t);
    if (ix) return [{ pos: ixPos(ix), radius: Math.max(ix.radius || 0, pkg.gameplay?.interaction?.radius ?? 2) }];
    if (spawnPos(t)) return [{ pos: spawnPos(t), radius: 2.5 }];
    const holders = (world.interactables || []).filter((i) => i.item_ref === t);
    if (holders.length) return holders.map((h) => ({ pos: ixPos(h), radius: Math.max(h.radius || 0, 2) }));
    return giversOf(pkg, t).map((cid) => ({ pos: spawnPos(cid), radius: 2.5 }));
  };

  for (const o of pkg.gameplay?.objectives || []) {
    if (o.kind === "survive") { results.push({ objective_id: o.id, target_ref: o.target_ref, reachable: true, reason: "survive needs no target" }); continue; }
    const targets = targetsFor(o).filter((x) => x.pos);
    let ok = false, reason = targets.length ? "no walkable approach connected to the spawn" : "target has no position";
    for (const { pos, radius } of targets) {
      const approach = nearestWalkable(nav, deps.nav.isWalkable, pos.x, pos.z, Math.max(1, Math.ceil((radius + nav.cell) / nav.cell)));
      if (!approach || Math.hypot(approach.x - pos.x, approach.z - pos.z) > radius + nav.cell * 0.75 + 0.5) continue;
      if (deps.nav.findPath(nav, start, approach)) { ok = true; reason = null; break; }
    }
    results.push({ objective_id: o.id, target_ref: o.target_ref, optional: !!o.optional, reachable: ok, ...(reason ? { reason } : {}) });
  }
  return { ok: results.every((r) => r.reachable || r.optional), results };
}
