// Games-B simulation core (CONTRACT §9). ISOMORPHIC.
//
// The one piece of game logic that runs identically in the browser renderer, in
// the Node headless playtest and in the publish gate. That identity is the
// point: a package the headless agent can finish is a package a player can
// finish, because they drive the same stepSim with the same inputs.
//
// Deliberately imports NOTHING from the other Games-B stages. Terrain,
// collision, navigation, rules, NPC brain and dialogue arrive as `deps`
// (see runtime/deps.mjs for the real set). Two reasons: the unit tests drive
// this with hand-written mocks, and a stage module that fails to load must
// fail loudly at the deps boundary rather than silently inside the sim.
//
// Determinism rules the rest of the file:
//   - fixed step (1/60 s by default), no wall clock, no Math.random;
//   - the only randomness is a serialisable mulberry32 whose state is saved;
//   - every piece of state that influences a future step is in snapshot().

export const SIM_DT = 1 / 60;
export const SAVE_VERSION = "1.0.0";

// Movement tuning that the GameplaySpec does not carry. Accelerations are
// chosen so a walk reaches full speed in ~0.15 s: responsive, but not the
// instant velocity snap that makes a third-person camera jitter.
const GROUND_ACCEL = 42;
const GROUND_DECEL = 55;
const SNAP_DOWN = 0.45;          // metres: stay glued to the ground walking downhill
const DEEP_WATER_DEPTH = 1.2;    // metres below the water line counts as drowning
const SENTINEL_RADIUS = 3;       // metres: a sentinel hurts inside this ring
const FALL_DAMAGE_SPEED = 14;    // m/s impact before fall damage starts
const COLLIDER_CELL = 16;        // metres per bucket of the collider broad-phase
const MELEE_RANGE = 2.5;

let defaultDeps = null;
/** runtime/deps.mjs registers the real modules here, so createSim(pkg) works in the browser. */
export function registerDefaultDeps(deps) { defaultDeps = deps; }

const REQUIRED_DEPS = {
  terrain: ["sampleHeight"],
  collision: ["buildColliders", "resolveCapsule"],
  nav: ["isWalkable", "findPath"],
  rules: ["createGameState", "applyGameEvent", "evaluateEnd"],
  npcBrain: ["createNpcState", "stepNpc", "setNpcState"],
  dialogue: ["openDialogue", "availableChoices", "choose"],
};

function resolveDeps(deps) {
  const d = { ...(defaultDeps || {}), ...(deps || {}) };
  const missing = [];
  for (const [group, fns] of Object.entries(REQUIRED_DEPS)) {
    for (const fn of fns) if (typeof d[group]?.[fn] !== "function") missing.push(`${group}.${fn}`);
  }
  if (missing.length) {
    throw new Error(`sim-core: missing deps ${missing.join(", ")} — pass realDeps from runtime/deps.mjs or import it once to register the defaults`);
  }
  return d;
}

// ------------------------------------------------------------------ helpers

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const v3 = (p) => ({ x: +p?.x || 0, y: +p?.y || 0, z: +p?.z || 0 });
const hyp = (x, z) => Math.sqrt(x * x + z * z);

/** mulberry32 with its state exposed, so a save captures where the stream is. */
function nextRand(sim) {
  let a = (sim.rng + 0x6d2b79f5) | 0;
  sim.rng = a >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function movementOf(gp) {
  const m = gp?.movement || {};
  return {
    walk: m.walk_speed ?? 4.5, run: m.run_speed ?? 8, jump: m.jump_velocity ?? 6.5,
    gravity: m.gravity ?? -20, maxSlope: m.max_slope_deg ?? 42, step: m.step_height ?? 0.45,
    air: m.air_control ?? 0.35, radius: m.player_radius ?? 0.4, height: m.player_height ?? 1.8,
  };
}

function colliderExtent(c) {
  if (c.shape === "cylinder") return c.radius || 0;
  const h = c.half || { x: 0, z: 0 };
  return Math.sqrt(h.x * h.x + h.z * h.z);
}

/**
 * Bucket colliders on a coarse XZ grid. resolveCapsule is linear in the number
 * of colliders it is given, and a medium world has several hundred scatter
 * trunks; handing it only the ~dozen nearby ones keeps a step well under the
 * 0.5 ms budget without the collision module having to know about it.
 */
function buildBroadphase(colliders) {
  const grid = new Map();
  colliders.forEach((c, idx) => {
    const r = colliderExtent(c);
    const x0 = Math.floor((c.center.x - r) / COLLIDER_CELL), x1 = Math.floor((c.center.x + r) / COLLIDER_CELL);
    const z0 = Math.floor((c.center.z - r) / COLLIDER_CELL), z1 = Math.floor((c.center.z + r) / COLLIDER_CELL);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const k = i * 100003 + j;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(idx);
    }
  });
  return grid;
}

function nearbyColliders(sim, x, z, r) {
  const out = [];
  const seen = new Set();
  const x0 = Math.floor((x - r) / COLLIDER_CELL), x1 = Math.floor((x + r) / COLLIDER_CELL);
  const z0 = Math.floor((z - r) / COLLIDER_CELL), z1 = Math.floor((z + r) / COLLIDER_CELL);
  for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
    for (const idx of sim.broadphase.get(i * 100003 + j) || []) {
      if (!seen.has(idx)) { seen.add(idx); out.push(sim.colliders[idx]); }
    }
  }
  // Keep the original order so resolution order never depends on bucket walk.
  return out.sort((a, b) => sim.colliderIndex.get(a) - sim.colliderIndex.get(b));
}

/** Point-in-solid test used for NPC blocking; works on the contract collider shapes. */
function pointBlocked(sim, x, z, pad = 0.2) {
  for (const c of nearbyColliders(sim, x, z, pad + 1)) {
    if (c.solid === false) continue;
    if (c.shape === "cylinder") {
      if (hyp(x - c.center.x, z - c.center.z) < (c.radius || 0) + pad) return true;
    } else if (c.half) {
      const s = Math.sin(-(c.rotation_y || 0)), co = Math.cos(-(c.rotation_y || 0));
      const dx = x - c.center.x, dz = z - c.center.z;
      const lx = dx * co - dz * s, lz = dx * s + dz * co;
      if (Math.abs(lx) < c.half.x + pad && Math.abs(lz) < c.half.z + pad) return true;
    }
  }
  return false;
}

function regionAt(world, x, z) {
  let best = null, bestArea = Infinity;
  for (const r of world.regions || []) {
    const [x0, z0, x1, z1] = r.bounds || [];
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) {
      const area = (x1 - x0) * (z1 - z0);
      // Smallest containing region wins: a shrine inside a wilderness is the shrine.
      if (area < bestArea) { best = r.id; bestArea = area; }
    }
  }
  return best;
}

function spawnById(world, id) {
  return (world.spawn_points || []).find((s) => s.id === id) || null;
}

function playerSpawn(world) {
  return spawnById(world, "spawn_player") || (world.spawn_points || []).find((s) => s.kind === "player") || { position: { x: world.size.w / 2, y: 0, z: world.size.h / 2 }, rotation_y: 0 };
}

function characterById(pkg, id) {
  return (pkg.characters?.characters || []).find((c) => c.id === id) || null;
}

// --------------------------------------------------------------- creation

/**
 * Build a fresh simulation for a package.
 * @param {object} pkg GamePackage (§7)
 * @param {object} [deps] see REQUIRED_DEPS; defaults to whatever deps.mjs registered
 */
export function createSim(pkg, deps) {
  const d = resolveDeps(deps);
  const world = pkg.world;
  const gp = pkg.gameplay;
  const colliders = d.collision.buildColliders(world, pkg.scene) || [];
  const sim = {
    pkg, deps: d, t: 0, step: 0,
    player: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, rotation_y: 0, grounded: true },
    game: d.rules.createGameState(gp),
    npcs: {},
    colliders,
    activeDialogue: null,
    status: "playing",
    stats: { steps: 0, collisions: 0, falls: 0 },
    collected: [], unlocked: [], revealed: [], defeated: [],
    region: null,
    rng: (pkg.concept?.seed ?? world.seed ?? 1) >>> 0,
    dmgAcc: 0,
    latch: { interact: false, jump: false },
    move: movementOf(gp),
  };
  Object.defineProperty(sim, "colliderIndex", { value: new Map(colliders.map((c, i) => [c, i])), enumerable: false });
  Object.defineProperty(sim, "broadphase", { value: buildBroadphase(colliders), enumerable: false });
  Object.defineProperty(sim, "deps", { value: d, enumerable: false });
  Object.defineProperty(sim, "pkg", { value: pkg, enumerable: false });

  const sp = playerSpawn(world);
  placePlayer(sim, sp.position, sp.rotation_y || 0);

  for (const ch of pkg.characters?.characters || []) {
    const s = spawnById(world, ch.spawn_ref);
    const pos = s ? v3(s.position) : { x: world.size.w / 2, y: 0, z: world.size.h / 2 };
    pos.y = heightAt(sim, pos.x, pos.z);
    sim.npcs[ch.id] = d.npcBrain.createNpcState(ch, pos);
  }
  // Deliver start-of-game effects (game_start events the rules engine queued
  // in createGameState) now, with a zero-length tick, so they are realised
  // before the first frame rather than a frame late.
  fire(sim, { kind: "tick", dt: 0 }, { events: [] }, { record: false });
  return sim;
}

function heightAt(sim, x, z) {
  return sim.deps.terrain.sampleHeight(sim.pkg.world.terrain, x, z);
}

function placePlayer(sim, pos, rot) {
  const p = sim.player;
  p.position = { x: pos.x, y: heightAt(sim, pos.x, pos.z), z: pos.z };
  p.velocity = { x: 0, y: 0, z: 0 };
  p.rotation_y = rot ?? p.rotation_y;
  p.grounded = true;
}

function respawn(sim, ref) {
  const world = sim.pkg.world;
  const sp = (ref && spawnById(world, ref)) || (sim.game.checkpoint && spawnById(world, sim.game.checkpoint)) || playerSpawn(world);
  placePlayer(sim, sp.position, sp.rotation_y || 0);
  sim.activeDialogue = null;
}

// ------------------------------------------------------------ interactables

/** Where an interactable is right now: its placement, or the NPC it follows. */
export function interactablePosition(sim, ix) {
  if (ix.kind === "talk" || (!ix.placement_ref && ix.character_ref)) {
    const npc = sim.npcs[ix.character_ref];
    return npc && !sim.defeated.includes(ix.character_ref) ? npc.position : null;
  }
  const pl = (sim.pkg.world.placements || []).find((p) => p.id === ix.placement_ref);
  return pl ? pl.position : null;
}

function interactableCatalogue(sim) {
  if (!sim._ixCache) {
    Object.defineProperty(sim, "_ixCache", { value: (sim.pkg.world.interactables || []).slice(), enumerable: false, writable: true });
  }
  return sim._ixCache;
}

/**
 * Nearest usable interactable within its radius (§9). Collected pickups are
 * gone; an opened container stays usable (it grants its item only once), so an
 * objective that targets it can still complete after it was opened early.
 */
export function nearestInteractable(sim) {
  const p = sim.player.position;
  const baseR = sim.pkg.gameplay?.interaction?.radius ?? 2.5;
  let best = null;
  for (const ix of interactableCatalogue(sim)) {
    if (ix.kind !== "container" && sim.collected.includes(ix.id)) continue;
    const pos = interactablePosition(sim, ix);
    if (!pos) continue;
    const dist = hyp(pos.x - p.x, pos.z - p.z);
    const r = Math.max(ix.radius || 0, baseR);
    if (dist <= r && Math.abs((pos.y ?? p.y) - p.y) < 4 && (!best || dist < best.distance)) {
      best = { id: ix.id, kind: ix.kind, prompt: ix.prompt, distance: Math.round(dist * 1000) / 1000 };
    }
  }
  return best;
}

// ------------------------------------------------------ rules integration

function note(sim, out, text) {
  const msg = { t: sim.t, text };
  sim.game = { ...sim.game, messages: [...(sim.game.messages || []), msg] };
  out.events.push({ kind: "message", text });
}

/**
 * Feed one event to the rules engine and realise whatever it fires. Life loss is
 * detected from the state diff rather than trusted to an effect, so a rules
 * engine that only decrements `lives` still gets the player respawned.
 */
function fire(sim, evt, out, { record = true } = {}) {
  const { rules } = sim.deps;
  const before = sim.game;
  const r = rules.applyGameEvent(sim.game, sim.pkg.gameplay, evt);
  sim.game = r.state;
  if (record) out.events.push(evt);
  for (const obj of Object.keys(sim.game.objectives || {})) {
    if (sim.game.objectives[obj] === "done" && before.objectives?.[obj] !== "done") {
      out.events.push({ kind: "objective_done", ref: obj });
    }
  }
  const effects = r.effects || [];
  realiseEffects(sim, effects, out);
  if ((sim.game.lives ?? 0) < (before.lives ?? 0) && sim.game.status !== "lost" && !effects.some((e) => e.kind === "respawn")) respawn(sim);
  // The rules engine only completes a reach objective on an enter_region seen
  // while it is active. If one becomes active while the player already stands
  // in its region, re-announce the region so it can complete.
  if (sim.region && effects.some((e) => e.kind === "objective_active")) {
    const activated = new Set(effects.filter((e) => e.kind === "objective_active").map((e) => e.ref));
    const hit = (sim.pkg.gameplay?.objectives || []).some((o) => activated.has(o.id) && o.kind === "reach" && o.target_ref === sim.region);
    if (hit) fire(sim, { kind: "enter_region", ref: sim.region }, out);
  }
}

function realiseEffects(sim, effects, out) {
  for (const a of effects) {
    out.events.push({ kind: "effect", action: a });
    switch (a.kind) {
      case "set_npc_state": {
        const npc = sim.npcs[a.ref];
        // An unknown state is a content bug the validator reports; at runtime
        // the NPC simply keeps its current state rather than crashing the tab.
        if (npc) { try { sim.npcs[a.ref] = sim.deps.npcBrain.setNpcState(npc, a.value); } catch { out.events.push({ kind: "warning", text: `bad npc state '${a.value}'` }); } }
        break;
      }
      case "reveal": if (a.ref && !sim.revealed.includes(a.ref)) sim.revealed.push(a.ref); break;
      case "unlock":
        if (a.ref && !sim.unlocked.includes(a.ref)) sim.unlocked.push(a.ref);
        if (a.ref && !(sim.game.unlocked || []).includes(a.ref)) sim.game = { ...sim.game, unlocked: [...(sim.game.unlocked || []), a.ref] };
        break;
      case "respawn": respawn(sim, a.ref); break;
      case "checkpoint":
        if (a.ref && sim.game.checkpoint !== a.ref) sim.game = { ...sim.game, checkpoint: a.ref };
        break;
      case "win": sim.status = "won"; sim.game = { ...sim.game, status: "won" }; break;
      case "lose": sim.status = "lost"; sim.game = { ...sim.game, status: "lost" }; break;
      default: break; // message/damage/heal/set_* live in GameState already
    }
  }
}

/**
 * Apply dialogue actions. The rules engine has events, not arbitrary actions,
 * so each action becomes the event that means the same thing (give_item is a
 * pickup), and the few with no event (remove_item, set_flag, heal…) are applied
 * to GameState directly and then realised like effects.
 */
export function applyActions(sim, actions, out = { events: [] }) {
  for (const a of actions || []) {
    switch (a.kind) {
      case "give_item": fire(sim, { kind: "pickup", ref: a.ref, count: a.value ?? 1 }, out); break;
      case "damage": fire(sim, { kind: "damage", value: a.value ?? 1 }, out); break;
      case "set_npc_state":
        realiseEffects(sim, [a], out);
        fire(sim, { kind: "npc_state", ref: a.ref, value: a.value }, out);
        break;
      case "remove_item": {
        const inv = { ...(sim.game.inventory || {}) };
        inv[a.ref] = Math.max(0, (inv[a.ref] || 0) - (a.value ?? 1));
        if (!inv[a.ref]) delete inv[a.ref];
        sim.game = { ...sim.game, inventory: inv };
        out.events.push({ kind: "effect", action: a });
        break;
      }
      case "heal": {
        const max = sim.pkg.gameplay?.rules?.player_health ?? 100;
        sim.game = { ...sim.game, health: Math.min(max, (sim.game.health ?? max) + (a.value ?? 10)) };
        out.events.push({ kind: "effect", action: a });
        break;
      }
      case "set_flag": sim.game = { ...sim.game, flags: { ...(sim.game.flags || {}), [a.ref]: a.value ?? true } }; out.events.push({ kind: "effect", action: a }); break;
      case "set_weather": sim.game = { ...sim.game, weather: a.value }; out.events.push({ kind: "effect", action: a }); break;
      case "set_time": sim.game = { ...sim.game, time_of_day: a.value }; out.events.push({ kind: "effect", action: a }); break;
      case "message": note(sim, out, String(a.value ?? a.ref ?? "")); break;
      default: realiseEffects(sim, [a], out); // unlock, reveal, checkpoint, win, lose, play_cinematic
    }
  }
  return out;
}

function activeDeliverTargets(sim) {
  const out = new Set();
  for (const o of sim.pkg.gameplay?.objectives || []) {
    if (o.kind === "deliver" && sim.game.objectives?.[o.id] === "active") out.add(o.target_ref);
  }
  return out;
}

function doInteract(sim, out) {
  const near = nearestInteractable(sim);
  const { gameplay } = sim.pkg;
  // Melee: interacting next to a hostile NPC is an attack when combat allows it.
  if (gameplay?.combat?.enabled && gameplay.combat.mode === "melee") {
    const p = sim.player.position;
    for (const ch of sim.pkg.characters?.characters || []) {
      if (!ch.behavior?.hostile || ch.invulnerable || sim.defeated.includes(ch.id)) continue;
      const n = sim.npcs[ch.id];
      if (n && hyp(n.position.x - p.x, n.position.z - p.z) <= MELEE_RANGE) {
        sim.defeated.push(ch.id);
        fire(sim, { kind: "defeat", ref: ch.id }, out);
        return;
      }
    }
  }
  if (!near) return;
  const ix = interactableCatalogue(sim).find((i) => i.id === near.id);
  if (ix.locked_by && !sim.unlocked.includes(ix.id) && !(sim.game.unlocked || []).includes(ix.id)) {
    if (!((sim.game.inventory || {})[ix.locked_by] > 0)) {
      const item = (gameplay?.inventory?.items || []).find((i) => i.id === ix.locked_by);
      note(sim, out, `Locked — needs ${item?.name || ix.locked_by}.`);
      out.events.push({ kind: "locked", ref: ix.id, needs: ix.locked_by });
      return;
    }
    sim.unlocked.push(ix.id);
  }
  const deliver = activeDeliverTargets(sim);
  if (ix.kind === "talk") {
    const cid = ix.character_ref;
    const dlg = sim.deps.dialogue.openDialogue(sim.pkg.characters?.dialogues || [], cid, sim.game);
    if (dlg && dlg.node) sim.activeDialogue = { dialogue_id: dlg.dialogue_id, character_ref: cid, node_id: dlg.node.id };
    fire(sim, { kind: "talk", ref: cid }, out);
    if (deliver.has(cid)) fire(sim, { kind: "deliver", ref: cid, item: null }, out);
    return;
  }
  fire(sim, { kind: "interact", ref: ix.id }, out);
  if ((ix.kind === "pickup" || ix.kind === "container") && !sim.collected.includes(ix.id)) {
    sim.collected.push(ix.id);
    if (ix.item_ref) fire(sim, { kind: "pickup", ref: ix.item_ref, count: 1 }, out);
  }
  if (deliver.has(ix.id)) fire(sim, { kind: "deliver", ref: ix.id, item: null }, out);
}

function dialogueFor(sim) {
  const ad = sim.activeDialogue;
  if (!ad) return null;
  const dialogue = (sim.pkg.characters?.dialogues || []).find((x) => x.id === ad.dialogue_id);
  const node = dialogue?.nodes?.find((n) => n.id === ad.node_id);
  return dialogue && node ? { dialogue, node } : null;
}

/** The currently open dialogue node and its available choices, for UIs and agents. */
export function currentDialogue(sim) {
  const d = dialogueFor(sim);
  if (!d) return null;
  return { dialogue_id: d.dialogue.id, character_ref: sim.activeDialogue.character_ref, node: d.node, choices: sim.deps.dialogue.availableChoices(d.node, sim.game, d.dialogue) || [] };
}

/**
 * Pick choice `idx` among the AVAILABLE choices — what the player sees and what
 * the 1–4 keys map to. dialogue.choose indexes that same visible list.
 */
function doChoice(sim, idx, out) {
  const d = dialogueFor(sim);
  if (!d) { sim.activeDialogue = null; return; }
  const avail = sim.deps.dialogue.availableChoices(d.node, sim.game, d.dialogue) || [];
  if (!avail.length) { sim.activeDialogue = null; return; }
  const i = Math.max(0, Math.min(avail.length - 1, idx | 0));
  const res = sim.deps.dialogue.choose(d.dialogue, d.node, i, sim.game) || { node: null, actions: [] };
  if (res.invalid) return;
  const next = res.node && typeof res.node === "object" ? res.node.id : res.node;
  out.events.push({ kind: "dialogue_choice", ref: d.dialogue.id, node: d.node.id, choice: i });
  sim.activeDialogue = next ? { ...sim.activeDialogue, node_id: next } : null;
  applyActions(sim, res.actions || [], out);
}

// ----------------------------------------------------------------- physics

function stepPlayer(sim, input, dt, out) {
  const m = sim.move;
  const p = sim.player;
  const world = sim.pkg.world;
  let mx = +input?.move?.x || 0, mz = +input?.move?.z || 0;
  const ml = hyp(mx, mz);
  if (ml > 1) { mx /= ml; mz /= ml; }
  if (sim.activeDialogue) { mx = 0; mz = 0; } // talking roots the player
  const speed = input?.run ? m.run : m.walk;
  const tx = mx * speed, tz = mz * speed;

  // Horizontal velocity chases the wish velocity at a bounded rate.
  const control = p.grounded ? 1 : m.air;
  const accel = (ml > 0.01 ? GROUND_ACCEL : GROUND_DECEL) * control;
  const dvx = tx - p.velocity.x, dvz = tz - p.velocity.z;
  const dl = hyp(dvx, dvz);
  const maxDv = accel * dt;
  if (dl <= maxDv) { p.velocity.x = tx; p.velocity.z = tz; }
  else { p.velocity.x += (dvx / dl) * maxDv; p.velocity.z += (dvz / dl) * maxDv; }
  if (ml > 0.01) p.rotation_y = Math.atan2(mx, mz);

  // Jump on the press, not while held, so holding Space does not bunny-hop.
  const jumpPressed = !!input?.jump && !sim.latch.jump;
  sim.latch.jump = !!input?.jump;
  if (jumpPressed && p.grounded && !sim.activeDialogue) {
    p.velocity.y = m.jump; p.grounded = false;
    out.events.push({ kind: "jump" });
  }

  // XZ move with a slope limit: moving uphill steeper than max_slope_deg is
  // refused per axis, which lets the player slide along a cliff face instead of
  // sticking to it.
  const tanMax = Math.tan((m.maxSlope * Math.PI) / 180);
  const x0 = p.position.x, z0 = p.position.z;
  const g0 = heightAt(sim, x0, z0);
  const tryMove = (nx, nz) => {
    if (!p.grounded) return true;
    const run = hyp(nx - x0, nz - z0);
    if (run < 1e-6) return true;
    const rise = heightAt(sim, nx, nz) - g0;
    return !(rise > 0 && rise / run > tanMax && rise > 1e-3);
  };
  let nx = x0 + p.velocity.x * dt, nz = z0 + p.velocity.z * dt;
  if (!tryMove(nx, nz)) {
    if (tryMove(nx, z0)) { nz = z0; p.velocity.z = 0; }
    else if (tryMove(x0, nz)) { nx = x0; p.velocity.x = 0; }
    else { nx = x0; nz = z0; p.velocity.x = 0; p.velocity.z = 0; }
    out.events.push({ kind: "slope_blocked" });
  }
  // Keep the player on the map.
  nx = Math.max(m.radius, Math.min(world.size.w - m.radius, nx));
  nz = Math.max(m.radius, Math.min(world.size.h - m.radius, nz));

  const near = nearbyColliders(sim, nx, nz, m.radius + 2);
  if (near.length) {
    const r = sim.deps.collision.resolveCapsule(near, { x: nx, y: p.position.y, z: nz }, m.radius, m.height);
    if (r?.hit) { sim.stats.collisions++; nx = r.x; nz = r.z; }
  }
  p.position.x = nx; p.position.z = nz;

  // Vertical: gravity, landing and downhill snap.
  const ground = heightAt(sim, nx, nz);
  if (p.grounded && p.velocity.y <= 0 && p.position.y - ground <= SNAP_DOWN + m.step) {
    p.position.y = ground; p.velocity.y = 0;
  } else {
    p.velocity.y += m.gravity * dt;
    p.position.y += p.velocity.y * dt;
    if (p.position.y <= ground) {
      const impact = -p.velocity.y;
      p.position.y = ground; p.velocity.y = 0;
      if (!p.grounded) {
        out.events.push({ kind: "land", impact: Math.round(impact * 100) / 100 });
        if (sim.pkg.gameplay?.rules?.fall_damage && impact > FALL_DAMAGE_SPEED) {
          fire(sim, { kind: "damage", value: Math.round((impact - FALL_DAMAGE_SPEED) * 4) }, out);
        }
      }
      p.grounded = true;
    } else {
      p.grounded = false;
    }
  }
}

function checkOutOfWorld(sim, out) {
  const p = sim.player.position;
  const w = sim.pkg.world.environment?.water;
  const fallY = sim.pkg.gameplay?.rules?.fall_y ?? -50;
  const drowned = w?.enabled && p.y < (w.level ?? 0) - DEEP_WATER_DEPTH;
  if (drowned || p.y < fallY) {
    sim.stats.falls++;
    const livesBefore = sim.game.lives;
    fire(sim, { kind: "fell_out", reason: drowned ? "deep_water" : "fall" }, out);
    // The rules engine may or may not charge a life; the player is moved back
    // either way — standing in deep water must never be a stable state.
    if (sim.game.lives === livesBefore && sim.status === "playing") respawn(sim);
  }
}

function hazardDamage(sim, dt) {
  const gp = sim.pkg.gameplay;
  // difficulty.damage_mult is applied once, by the rules engine's damage
  // handler; multiplying here too made the effective rate dps × mult².
  const p = sim.player.position;
  let dmg = 0;
  for (const h of gp?.hazards || []) {
    if (h.active_after && sim.game.objectives?.[h.active_after] !== "done") continue;
    const dps = h.damage_per_s ?? gp?.combat?.hazard_damage_per_s ?? 5;
    if (h.kind === "sentinel") {
      const n = sim.npcs[h.character_ref];
      if (n && !sim.defeated.includes(h.character_ref) && hyp(n.position.x - p.x, n.position.z - p.z) <= SENTINEL_RADIUS) dmg += dps * dt;
    } else if ((h.kind === "storm_zone" || h.kind === "fire") && h.region && sim.region === h.region) {
      dmg += dps * dt;
    }
  }
  return dmg;
}

function stepNpcs(sim, dt) {
  const { nav, npcBrain } = sim.deps;
  const world = sim.pkg.world;
  const ctx = {
    player: sim.player.position,
    heightAt: (x, z) => heightAt(sim, x, z),
    isBlocked: (x, z) => !nav.isWalkable(world.navigation, x, z) || pointBlocked(sim, x, z),
    findPath: (from, to) => nav.findPath(world.navigation, from, to),
    rand: () => nextRand(sim),
    // The NPC in conversation stands and faces the player (npc-brain optional ctx field).
    talking: sim.activeDialogue?.character_ref ?? null,
  };
  for (const ch of sim.pkg.characters?.characters || []) {
    const n = sim.npcs[ch.id];
    if (!n || sim.defeated.includes(ch.id)) continue;
    sim.npcs[ch.id] = npcBrain.stepNpc(n, ch, ctx, dt);
  }
}

// -------------------------------------------------------------------- step

/**
 * Advance the simulation by one fixed step.
 * @returns {{events: object[]}} everything that happened except the per-step tick
 */
export function stepSim(sim, input = {}, dt = SIM_DT) {
  const out = { events: [] };
  if (sim.status !== "playing") return out;
  sim.step++;
  sim.stats.steps++;
  sim.t += dt;

  if (sim.activeDialogue && Number.isInteger(input.choice)) doChoice(sim, input.choice, out);

  // Optional input.unstuck (add-only): a player trapped where the terrain has
  // no way out (a pit below a cliff) returns to the current checkpoint, as in
  // most 3D games. Game state is untouched; only the player is moved.
  if (input.unstuck && !sim.activeDialogue) { respawn(sim); out.events.push({ kind: "unstuck", ref: sim.game.checkpoint || null }); }
  stepPlayer(sim, input, dt, out);
  checkOutOfWorld(sim, out);

  const region = regionAt(sim.pkg.world, sim.player.position.x, sim.player.position.z);
  if (region && region !== sim.region) fire(sim, { kind: "enter_region", ref: region }, out);
  sim.region = region;

  const interactPressed = !!input.interact && !sim.latch.interact;
  sim.latch.interact = !!input.interact;
  if (interactPressed && !sim.activeDialogue) doInteract(sim, out);

  stepNpcs(sim, dt);

  sim.dmgAcc += hazardDamage(sim, dt);
  if (sim.dmgAcc >= 1) {
    const whole = Math.floor(sim.dmgAcc);
    sim.dmgAcc -= whole;
    fire(sim, { kind: "damage", value: whole, source: "hazard" }, out);
  }

  fire(sim, { kind: "tick", dt }, out, { record: false });

  if (sim.status === "playing") {
    const end = sim.deps.rules.evaluateEnd(sim.game, sim.pkg.gameplay);
    if (end && end !== "playing") sim.status = end;
  }
  if (sim.status !== "playing") out.events.push({ kind: "status", value: sim.status });
  return out;
}

// ---------------------------------------------------------------- save/load

/**
 * SaveState (§9). The contract fields carry what a player-facing save needs;
 * the optional `runtime` block carries the rest of the hidden state (velocity,
 * RNG position, full NPC brain state, open dialogue, latches) so that
 * restore-then-continue is bit-identical to never having saved.
 */
export function snapshot(sim, { now } = {}) {
  const npcs = {};
  const npcFull = {};
  for (const [id, n] of Object.entries(sim.npcs)) {
    npcs[id] = { position: clone(n.position), state: n.state };
    npcFull[id] = clone(n);
  }
  return {
    save_version: SAVE_VERSION,
    game_id: sim.pkg.game_id,
    package_version: sim.pkg.version,
    package_sha256: sim.pkg.integrity?.sha256 ?? null,
    saved_at: now || new Date().toISOString(),
    t: sim.t,
    player: { position: clone(sim.player.position), rotation_y: sim.player.rotation_y, health: sim.game.health, lives: sim.game.lives },
    game: clone(sim.game),
    npcs,
    collected: sim.collected.slice(),
    unlocked: sim.unlocked.slice(),
    runtime: {
      step: sim.step,
      velocity: clone(sim.player.velocity),
      grounded: sim.player.grounded,
      status: sim.status,
      region: sim.region,
      rng: sim.rng,
      dmg_acc: sim.dmgAcc,
      latch: { ...sim.latch },
      active_dialogue: clone(sim.activeDialogue),
      revealed: sim.revealed.slice(),
      defeated: sim.defeated.slice(),
      stats: { ...sim.stats },
      npcs: npcFull,
    },
  };
}

/** Rebuild a sim from a SaveState. A save from a different package is refused. */
export function restoreSim(pkg, save, deps) {
  if (!save || save.save_version !== SAVE_VERSION) throw new Error("restoreSim: unsupported save_version");
  if (save.game_id !== pkg.game_id) throw new Error(`restoreSim: save is for '${save.game_id}', not '${pkg.game_id}'`);
  if (save.package_sha256 && pkg.integrity?.sha256 && save.package_sha256 !== pkg.integrity.sha256) {
    throw new Error("restoreSim: save was made against a different package build (sha256 mismatch)");
  }
  const sim = createSim(pkg, deps);
  const rt = save.runtime || {};
  sim.t = save.t;
  sim.game = clone(save.game);
  sim.player.position = clone(save.player.position);
  sim.player.rotation_y = save.player.rotation_y;
  sim.player.velocity = rt.velocity ? clone(rt.velocity) : { x: 0, y: 0, z: 0 };
  sim.player.grounded = rt.grounded ?? true;
  sim.collected = (save.collected || []).slice();
  sim.unlocked = (save.unlocked || []).slice();
  sim.step = rt.step ?? Math.round(save.t / SIM_DT);
  sim.status = rt.status || sim.game.status || "playing";
  sim.region = rt.region ?? null;
  if (Number.isInteger(rt.rng)) sim.rng = rt.rng;
  sim.dmgAcc = rt.dmg_acc ?? 0;
  sim.latch = { interact: false, jump: false, ...(rt.latch || {}) };
  sim.activeDialogue = clone(rt.active_dialogue ?? null);
  sim.revealed = (rt.revealed || []).slice();
  sim.defeated = (rt.defeated || []).slice();
  if (rt.stats) sim.stats = { ...rt.stats };
  for (const [id, n] of Object.entries(save.npcs || {})) {
    if (rt.npcs?.[id]) sim.npcs[id] = clone(rt.npcs[id]);
    else if (sim.npcs[id]) sim.npcs[id] = { ...sim.deps.npcBrain.setNpcState(sim.npcs[id], n.state), position: clone(n.position) };
  }
  return sim;
}

/** Teleport for tests and the renderer hook; keeps the player on the ground. */
export function teleport(sim, x, z) {
  placePlayer(sim, { x, z }, sim.player.rotation_y);
}
