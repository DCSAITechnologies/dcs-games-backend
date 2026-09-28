// Games-B NPC brain (CONTRACT §6). ISOMORPHIC and pure.
//
// One small state machine per NPC, stepped by the simulation at a fixed rate.
// Everything the brain knows about the world comes in through ctx:
//   ctx = { player:{x,y,z}, heightAt(x,z), isBlocked(x,z), findPath(from,to), rand(),
//           talking?: character_id }   // optional addition: the NPC in conversation plays "talk"
// so the same code runs in the headless playtest (with a seeded rand) and in the
// browser. stepNpc never mutates its inputs and never draws its own randomness, which is
// what makes a replay with the same seed land every NPC on the same metre.
//
// The one hard invariant: an NPC never ENDS a step on a cell ctx.isBlocked
// reports. Every candidate position is checked before it is accepted; if the
// straight step is blocked we slide along one axis, and if both slides are
// blocked we stay put and drop the cached path so the next step re-plans.
//
// Extra state fields beyond §6 (all plain JSON, so a snapshot round-trips):
//   home        the spawn post; guard holds it, chase leashes to it, wander circles it
//   path        cached findPath result for the current goal (null = none)
//   path_goal   the goal that path was planned for
//   repath_t    seconds until the cached path is re-planned
//   patrol_idx  index of the patrol point being walked to
//   returning   true while walking home after a chase gave up; suppresses re-aggro
//   stuck_t     seconds spent wedged short of a goal (only present once wedged); past
//               STUCK_S the goal is treated as unreachable, so nothing freezes for good
//
// Optional behaviour fields beyond §6 (add-only; absent = the Games-B behaviour):
//   home: {x,z}          the NPC's post. createNpcState starts it there instead of at
//                        the spawn point, and guard/leash/wander measure from it.
//   avoid: [{x,z,r}]     keep-out discs (player spawn, checkpoints, objectives). A point
//                        inside a disc counts as blocked, except that an NPC already
//                        inside one may always step outward, so it can never be trapped.
//   sight_los: bool      the player is only noticed along a clear line (walls hide them).
//   chase_max_s: number  a chase lasts at most this long (timed on `timer`), then the NPC
//                        loses interest and walks home like a leash give-up. Stops a
//                        chaser pinning a player that cannot outrun it round a corner.
//   archetype: string    informational label from the preset that built this behaviour.
// A flee entered through on_player_near (a skittish critter) is bounded by
// leash_radius around home, and any wanderer that has strayed beyond its
// wander_radius walks home before picking a new stroll.

export const STATES = ["idle", "patrol", "guard", "wander", "follow_player", "flee", "chase"];

const ARRIVE = 0.6;         // m: close enough to a goal
const WAYPOINT = 0.35;      // m: close enough to an intermediate path node
const REPATH_S = 1.0;       // s: re-plan a cached path this often even if it still looks valid
const GOAL_DRIFT = 1.5;     // m: re-plan at once if the goal moved this far from the planned one
const LINE_STEP = 0.4;      // m: sampling step for the straight-line clearance test
const FOLLOW_GAP = 3;       // m: companion's preferred distance behind the player
const FOLLOW_MIN = 2, FOLLOW_MAX = 4;
const TELEPORT_DIST = 40;   // m: beyond this the companion catches up instantly
const FAR_HYSTERESIS = 1.2; // near→far needs sight_radius × this, so an NPC on the edge doesn't flicker
const CHASE_STOP = 1.2;     // m: a chaser stops at contact range rather than inside the player
const RUN_SPEED = 3.2;      // m/s: above this the anim is "run"
const STUCK_S = 2;          // s: wedged this long short of a goal → treat the goal as unreachable

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const facing = (dx, dz) => Math.atan2(dx, dz); // Three.js: rotation_y 0 faces +z

/** @returns NpcState */
export function createNpcState(character, spawnPos) {
  const post = character.behavior?.home;
  const hasPost = post && Number.isFinite(post.x) && Number.isFinite(post.z);
  const x = hasPost ? post.x : spawnPos?.x ?? 0, z = hasPost ? post.z : spawnPos?.z ?? 0;
  return {
    id: character.id,
    position: { x, y: spawnPos?.y ?? 0, z },
    rotation_y: spawnPos?.rotation_y ?? 0,
    state: character.behavior?.initial ?? "idle",
    target: null, path_idx: 0, timer: 0, anim: "idle",
    home: { x, z }, path: null, path_goal: null, repath_t: 0, patrol_idx: 0, returning: false,
  };
}

/** Force a state (from a set_npc_state action). Clears navigation so the new state starts clean. */
export function setNpcState(npcState, state) {
  if (!STATES.includes(state)) throw new TypeError(`unknown NPC state '${state}'`);
  return { ...npcState, state, target: null, path: null, path_goal: null, path_idx: 0, timer: 0, returning: false };
}

function switchTo(n, state) {
  return { ...n, state, target: null, path: null, path_goal: null, path_idx: 0, timer: 0, returning: false };
}

/**
 * Advance one NPC by dt seconds. Pure: returns a new state object.
 */
export function stepNpc(npcState, character, ctx, dt) {
  const b = character.behavior || {};
  let n = { ...npcState, position: { ...npcState.position } };
  if (!n.home) n.home = { x: n.position.x, z: n.position.z };
  if (!(dt > 0)) return n;
  n.repath_t = Math.max(0, (n.repath_t || 0) - dt);
  const player = ctx.player || null;
  const dP = player ? dist(n.position, player) : Infinity;
  const sight = b.sight_radius || 0;
  const leash = b.leash_radius || 0;
  const base = ctx;
  ctx = withAvoid(ctx, b.avoid, n.position);
  const sees = (d) => d <= sight && (!b.sight_los || lineClear(base, n.position, player));

  // --- transitions -------------------------------------------------------
  if (n.returning) {
    if (dist(n.position, n.home) <= ARRIVE * 2) n.returning = false;
  } else if (player) {
    const near = b.on_player_near, far = b.on_player_far;
    // Only the NPC's "resting" states react to the player. A state forced by
    // gameplay (say, flee) stays until gameplay changes it again.
    const resting = n.state === b.initial || n.state === far;
    if (near && n.state !== near && resting && sees(dP)) {
      const leashOk = near !== "chase" || leash <= 0 || dist(n.home, player) <= leash;
      if (leashOk) n = switchTo(n, near);
    } else if (far && n.state === near && n.state !== far && dP > sight * FAR_HYSTERESIS) {
      n = switchTo(n, far);
    }
  }
  if (n.state === "chase" && leash > 0 && player &&
      (dist(n.position, n.home) > leash || dist(n.home, player) > leash)) {
    n = giveUp(n, b);
  }
  if (n.state === "chase" && b.chase_max_s > 0) {
    n.timer = (n.timer || 0) + dt;
    if (n.timer >= b.chase_max_s) n = giveUp(n, b);
  }

  // --- goal for this state -----------------------------------------------
  const start = { x: n.position.x, z: n.position.z };
  let goal = null, speed = b.speed || 0, stopAt = ARRIVE, faceTo = null, direct = false;
  const talking = ctx.talking != null && ctx.talking === n.id;

  if (talking) {
    faceTo = player;
  } else if (n.returning) {
    goal = n.home;
  } else {
    switch (n.state) {
      case "idle":
        if (dP <= sight) faceTo = player;
        break;
      case "guard":
        if (dist(n.position, n.home) > 1) goal = n.home;
        else if (dP <= sight) faceTo = player;
        break;
      case "patrol": {
        const pts = b.patrol || [];
        if (pts.length === 0) { if (dist(n.position, n.home) > 1) goal = n.home; break; }
        let idx = (n.patrol_idx || 0) % pts.length;
        if (dist(n.position, pts[idx]) <= ARRIVE) {
          idx = (idx + 1) % pts.length;
          n.path = null; n.path_goal = null;
        }
        n.patrol_idx = idx;
        goal = pts[idx];
        break;
      }
      case "wander": {
        const wr = b.wander_radius || 0;
        if (wr > 0 && dist(n.position, n.home) > wr + 2 && !(n.target && dist(n.target, n.home) <= 1)) {
          n.target = { x: n.home.x, z: n.home.z }; n.timer = 0; // strayed (after a flee): walk home first
        }
        if (n.target && dist(n.position, n.target) <= ARRIVE) {
          n.target = null;
          n.timer = 1 + ctx.rand() * 2; // linger before the next stroll
        }
        if (n.timer > 0) { n.timer = Math.max(0, n.timer - dt); break; }
        if (!n.target) n.target = pickWanderTarget(n, b, ctx);
        if (!n.target) { n.timer = 1; break; }
        goal = n.target;
        break;
      }
      case "follow_player": {
        if (!player) break;
        if (dP > TELEPORT_DIST) {
          const spot = catchUpSpot(n, player, ctx);
          if (spot) {
            n.position = { x: spot.x, y: n.position.y, z: spot.z };
            n.path = null; n.path_goal = null;
          }
          break;
        }
        if (dP > FOLLOW_GAP + 0.25 || dP < FOLLOW_MIN) {
          const ux = dP > 1e-6 ? (n.position.x - player.x) / dP : 0, uz = dP > 1e-6 ? (n.position.z - player.z) / dP : 1;
          goal = { x: player.x + ux * FOLLOW_GAP, z: player.z + uz * FOLLOW_GAP };
          stopAt = 0.25;
          // Close the gap faster when far behind so the band holds while the player runs.
          if (dP > FOLLOW_MAX * 2) speed *= 1.5;
          direct = dP < FOLLOW_MIN; // backing off a step never needs a path
        } else faceTo = player;
        break;
      }
      case "flee": {
        if (!player) break;
        if (dP > Math.max(sight * 2, 20)) { faceTo = null; break; }
        // A skittish critter bolts, but only as far as its leash: then it turns to watch.
        if (b.on_player_near === "flee" && leash > 0 && dist(n.position, n.home) >= leash &&
            (n.position.x - n.home.x) * (n.position.x - player.x) + (n.position.z - n.home.z) * (n.position.z - player.z) > 0) {
          faceTo = player; break;
        }
        const ux = dP > 1e-6 ? (n.position.x - player.x) / dP : 1, uz = dP > 1e-6 ? (n.position.z - player.z) / dP : 0;
        goal = { x: n.position.x + ux * 5, z: n.position.z + uz * 5 };
        speed *= 1.25;
        direct = true;
        break;
      }
      case "chase":
        if (!player) break;
        goal = { x: player.x, z: player.z };
        stopAt = CHASE_STOP;
        break;
      default:
        break;
    }
  }

  // --- movement ----------------------------------------------------------
  if (goal && speed > 0) {
    const r = direct ? moveDirect(n, goal, speed, dt, ctx) : moveToward(n, goal, speed, dt, ctx, stopAt);
    n = r.n;
    const stepped = dist(n.position, start) > 1e-6;
    if (r.unreachable) n = onUnreachable(n, b);
    else if (!stepped && dist(n.position, goal) > stopAt + 1e-6) {
      // Wedged short of the goal (a wall the path cannot see, a keep-out disc).
      n.stuck_t = (n.stuck_t || 0) + dt;
      if (n.stuck_t >= STUCK_S) { n = onUnreachable(n, b); n.stuck_t = 0; }
    } else if (n.stuck_t) n.stuck_t = 0;
  }
  n.target = n.state === "wander" && !n.returning ? n.target : (goal ? { x: goal.x, z: goal.z } : null);

  // --- facing, height, anim ----------------------------------------------
  const mx = n.position.x - start.x, mz = n.position.z - start.z;
  const moved = Math.hypot(mx, mz);
  if (moved > 1e-6) n.rotation_y = facing(mx, mz);
  else if (faceTo) {
    const fx = faceTo.x - n.position.x, fz = faceTo.z - n.position.z;
    if (Math.hypot(fx, fz) > 1e-6) n.rotation_y = facing(fx, fz);
  }
  if (typeof ctx.heightAt === "function") n.position.y = ctx.heightAt(n.position.x, n.position.z);
  const v = moved / dt;
  n.anim = talking ? "talk" : v > RUN_SPEED ? "run" : moved > 1e-6 ? "walk" : "idle";
  return n;
}

function giveUp(n, b) {
  const back = b.on_player_far && b.on_player_far !== "chase" ? b.on_player_far
    : b.initial && b.initial !== "chase" ? b.initial : "guard";
  return { ...switchTo(n, back), returning: true };
}

function onUnreachable(n, b) {
  if (n.returning) return { ...n, returning: false }; // cannot get home: resume where we are
  switch (n.state) {
    case "patrol": {
      const len = (b.patrol || []).length || 1;
      return { ...n, patrol_idx: ((n.patrol_idx || 0) + 1) % len, path: null, path_goal: null };
    }
    case "wander": return { ...n, target: null, timer: 0.5 };
    case "chase": return giveUp(n, b);
    default: return n;
  }
}

const blocked = (ctx, x, z) => (typeof ctx.isBlocked === "function" ? !!ctx.isBlocked(x, z) : false);

/** ctx whose isBlocked also honours the behaviour's keep-out discs (see header). */
function withAvoid(ctx, zones, from) {
  if (!Array.isArray(zones) || zones.length === 0) return ctx;
  const fx = from.x, fz = from.z;
  return {
    ...ctx,
    isBlocked: (x, z) => {
      if (blocked(ctx, x, z)) return true;
      for (const q of zones) {
        const r = q.r || 0, d = Math.hypot(x - q.x, z - q.z);
        if (d >= r) continue;
        const d0 = Math.hypot(fx - q.x, fz - q.z);
        if (!(d0 < r && d >= d0 - 1e-9)) return true; // entering, or going deeper
      }
      return false;
    },
  };
}

function lineClear(ctx, a, b) {
  const d = dist(a, b);
  const steps = Math.max(1, Math.ceil(d / LINE_STEP));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (blocked(ctx, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false;
  }
  return true;
}

/**
 * Take one step of length `step` along (dx,dz) (a unit vector). Tries the full
 * step, then each axis on its own (a slide along a wall). Returns the accepted
 * position or null; never returns a blocked one.
 */
function tryStep(ctx, pos, dx, dz, step) {
  const cands = [[dx, dz], [dx, 0], [0, dz]];
  for (const [cx, cz] of cands) {
    if (Math.abs(cx) + Math.abs(cz) < 1e-9) continue;
    const x = pos.x + cx * step, z = pos.z + cz * step;
    if (!blocked(ctx, x, z)) return { x, z };
  }
  return null;
}

function moveDirect(n, goal, speed, dt, ctx) {
  const d = dist(n.position, goal);
  if (d <= 1e-6) return { n };
  const ux = (goal.x - n.position.x) / d, uz = (goal.z - n.position.z) / d;
  const step = Math.min(speed * dt, d);
  // Fleeing into a wall: fan out ±45°, ±90°, ±135° before giving up.
  for (const a of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, 3 * Math.PI / 4, -3 * Math.PI / 4]) {
    const c = Math.cos(a), s = Math.sin(a);
    const p = tryStep(ctx, n.position, ux * c - uz * s, ux * s + uz * c, step);
    if (p) return { n: { ...n, position: { ...n.position, x: p.x, z: p.z } } };
  }
  return { n };
}

function moveToward(n, goal, speed, dt, ctx, stopAt) {
  const pos = n.position;
  if (dist(pos, goal) <= stopAt) return { n };
  let waypoint = goal;
  if (lineClear(ctx, pos, goal)) {
    if (n.path) n = { ...n, path: null, path_goal: null, path_idx: 0 };
  } else {
    const stale = !n.path || n.repath_t <= 0 || !n.path_goal || dist(n.path_goal, goal) > GOAL_DRIFT;
    if (stale) {
      const p = typeof ctx.findPath === "function" ? ctx.findPath({ x: pos.x, z: pos.z }, { x: goal.x, z: goal.z }) : null;
      if (!Array.isArray(p) || p.length === 0) {
        return { n: { ...n, path: null, path_goal: null, path_idx: 0, repath_t: REPATH_S }, unreachable: true };
      }
      n = { ...n, path: p, path_goal: { x: goal.x, z: goal.z }, path_idx: 0, repath_t: REPATH_S };
    }
    let idx = Math.min(n.path_idx || 0, n.path.length - 1);
    while (idx < n.path.length - 1 && dist(pos, n.path[idx]) < WAYPOINT) idx++;
    // Skip ahead to the furthest of the next few nodes that is in plain sight,
    // which smooths the 8-connected grid staircase into straight walks.
    for (let k = Math.min(n.path.length - 1, idx + 4); k > idx; k--) {
      if (lineClear(ctx, pos, n.path[k])) { idx = k; break; }
    }
    n = { ...n, path_idx: idx };
    waypoint = idx === n.path.length - 1 && dist(pos, n.path[idx]) < WAYPOINT ? goal : n.path[idx];
  }
  const d = dist(pos, waypoint);
  if (d <= 1e-6) return { n };
  const step = Math.min(speed * dt, d);
  const p = tryStep(ctx, pos, (waypoint.x - pos.x) / d, (waypoint.z - pos.z) / d, step);
  if (!p) return { n: { ...n, path: null, path_goal: null, repath_t: 0 } }; // wedged: re-plan next step
  return { n: { ...n, position: { ...pos, x: p.x, z: p.z } } };
}

function pickWanderTarget(n, b, ctx) {
  const r = b.wander_radius || 0;
  if (r <= 0) return null;
  for (let k = 0; k < 8; k++) {
    const ang = ctx.rand() * Math.PI * 2;
    const rad = Math.sqrt(ctx.rand()) * r; // sqrt: uniform over the disc, not bunched at the centre
    const t = { x: n.home.x + Math.cos(ang) * rad, z: n.home.z + Math.sin(ang) * rad };
    if (blocked(ctx, t.x, t.z)) continue;
    if (lineClear(ctx, n.position, t)) return t;
    // A target just behind a wall can be reachable only by a long detour; the
    // wanderer would leave its patch to get there, so reject such paths.
    const p = typeof ctx.findPath === "function" ? ctx.findPath({ x: n.position.x, z: n.position.z }, t) : null;
    if (Array.isArray(p) && p.length && p.every((q) => dist(q, n.home) <= r + 1)) return t;
  }
  return null;
}

/** A free spot FOLLOW_GAP behind the player (on the NPC's side first), for the teleport catch-up. */
function catchUpSpot(n, player, ctx) {
  const base = Math.atan2(n.position.z - player.z, n.position.x - player.x);
  for (let k = 0; k < 16; k++) {
    const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 8);
    for (const r of [FOLLOW_GAP, FOLLOW_MIN + 0.5, FOLLOW_MAX - 0.25]) {
      const x = player.x + Math.cos(a) * r, z = player.z + Math.sin(a) * r;
      if (!blocked(ctx, x, z)) return { x, z };
    }
  }
  return null;
}
