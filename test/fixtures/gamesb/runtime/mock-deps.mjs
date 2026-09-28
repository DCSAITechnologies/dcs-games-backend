// Hand-written stand-ins for the Games-B stage modules sim-core depends on.
//
// They implement the CONTRACT signatures (§2 terrain/nav/collision, §5 rules
// engine, §6 npc-brain/dialogue) just faithfully enough that sim-core and the
// headless playtest can be exercised end to end without the real modules. The
// point is to test the runtime's own logic in isolation; the integration tests
// re-run the same scenarios against the real modules once they exist.

// ------------------------------------------------------------------ terrain
export function sampleHeight(t, x, z) {
  const fx = Math.max(0, Math.min(t.cols - 1.0001, x / t.cell));
  const fz = Math.max(0, Math.min(t.rows - 1.0001, z / t.cell));
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const h = (a, b) => t.heights[b * t.cols + a];
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}
export function slopeAt(t, x, z) {
  const e = t.cell * 0.5;
  const dx = (sampleHeight(t, x + e, z) - sampleHeight(t, x - e, z)) / (2 * e);
  const dz = (sampleHeight(t, x, z + e) - sampleHeight(t, x, z - e)) / (2 * e);
  return (Math.atan(Math.sqrt(dx * dx + dz * dz)) * 180) / Math.PI;
}
export function expandScatter() { return []; }

// ---------------------------------------------------------------- collision
export function buildColliders(world) {
  const out = [];
  for (const p of world.placements || []) {
    const c = p.collider;
    if (!c || c.shape === "none" || !c.solid) continue;
    if (c.shape === "cylinder") out.push({ id: `col_${p.id}`, shape: "cylinder", center: { ...p.position }, radius: c.radius, height: c.height || 2, rotation_y: 0, solid: true, ref: p.id });
    else out.push({ id: `col_${p.id}`, shape: "box", center: { ...p.position }, half: { x: c.size.x / 2, y: c.size.y / 2, z: c.size.z / 2 }, rotation_y: 0, solid: true, ref: p.id });
  }
  return out;
}
export function resolveCapsule(colliders, pos, radius) {
  let { x, z } = pos, hit = false;
  for (const c of colliders) {
    if (!c.solid) continue;
    if (c.shape === "cylinder") {
      const dx = x - c.center.x, dz = z - c.center.z, d = Math.hypot(dx, dz), min = c.radius + radius;
      if (d < min) { hit = true; const k = d > 1e-6 ? min / d : 1; x = c.center.x + (d > 1e-6 ? dx * k : min); z = c.center.z + (d > 1e-6 ? dz * k : 0); }
    } else {
      const hx = c.half.x + radius, hz = c.half.z + radius;
      const dx = x - c.center.x, dz = z - c.center.z;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        hit = true;
        const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
        if (px < pz) x = c.center.x + Math.sign(dx || 1) * hx; else z = c.center.z + Math.sign(dz || 1) * hz;
      }
    }
  }
  return { x, z, hit };
}
export function pointInCollider(colliders, x, z, pad = 0) {
  return colliders.some((c) => c.shape === "cylinder" ? Math.hypot(x - c.center.x, z - c.center.z) < c.radius + pad
    : Math.abs(x - c.center.x) < c.half.x + pad && Math.abs(z - c.center.z) < c.half.z + pad);
}

// ---------------------------------------------------------------------- nav
export function navIndex(nav, x, z) {
  const i = Math.floor(x / nav.cell), j = Math.floor(z / nav.cell);
  if (i < 0 || j < 0 || i >= nav.cols || j >= nav.rows) return -1;
  return j * nav.cols + i;
}
export function isWalkable(nav, x, z) { const k = navIndex(nav, x, z); return k >= 0 && nav.walkable[k] === "1"; }
export function findPath(nav, from, to) {
  const s = navIndex(nav, from.x, from.z), g = navIndex(nav, to.x, to.z);
  if (s < 0 || g < 0 || nav.walkable[g] !== "1") return null;
  const cols = nav.cols, N = nav.cols * nav.rows;
  const gs = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const hx = (k) => Math.hypot((k % cols) - (g % cols), Math.floor(k / cols) - Math.floor(g / cols));
  gs[s] = 0; const open = [[hx(s), s]];
  while (open.length) {
    open.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const [, k] = open.shift();
    if (closed[k]) continue; closed[k] = 1;
    if (k === g) break;
    const ci = k % cols, cj = Math.floor(k / cols);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= nav.rows) continue;
      const nk = nj * cols + ni;
      if (nav.walkable[nk] !== "1" || closed[nk]) continue;
      if (di && dj && (nav.walkable[cj * cols + ni] !== "1" || nav.walkable[nj * cols + ci] !== "1")) continue;
      const ng = gs[k] + (di && dj ? Math.SQRT2 : 1);
      if (ng < gs[nk]) { gs[nk] = ng; came[nk] = k; open.push([ng + hx(nk), nk]); }
    }
  }
  if (s !== g && came[g] < 0) return null;
  const path = [];
  for (let k = g; k >= 0; k = k === s ? -1 : came[k]) path.push({ x: (k % cols + 0.5) * nav.cell, z: (Math.floor(k / cols) + 0.5) * nav.cell });
  return path.reverse();
}
export function reachableSet(nav, from) {
  const s = navIndex(nav, from.x, from.z); const seen = new Set();
  if (s < 0 || nav.walkable[s] !== "1") return seen;
  const q = [s]; seen.add(s);
  while (q.length) {
    const k = q.pop(), ci = k % nav.cols, cj = Math.floor(k / nav.cols);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nav.cols || nj >= nav.rows) continue;
      const nk = nj * nav.cols + ni;
      if (nav.walkable[nk] === "1" && !seen.has(nk)) { seen.add(nk); q.push(nk); }
    }
  }
  return seen;
}

// -------------------------------------------------------------------- rules
export const ACTION_KINDS = ["message", "give_item", "remove_item", "set_npc_state", "unlock", "set_weather", "set_time", "checkpoint", "damage", "heal", "win", "lose", "reveal", "play_cinematic", "set_flag"];

export function createGameState(gp) {
  const objectives = {};
  for (const o of gp.objectives) objectives[o.id] = (o.requires || []).length ? "locked" : "active";
  return { t: 0, status: "playing", health: gp.rules.player_health, lives: gp.rules.lives, xp: 0, level: 1, inventory: {}, objectives, progress: {}, fired: [], flags: {}, checkpoint: null, messages: [], npc_states: {}, weather: null, time_of_day: null };
}

function completeObjectives(s, gp, pred, effects) {
  let changed = true;
  for (const o of gp.objectives) if (s.objectives[o.id] === "active" && pred(o)) { s.objectives[o.id] = "done"; s.xp += o.reward?.xp || 0; runTriggers(s, gp, { kind: "objective_complete", ref: o.id }, effects); }
  while (changed) {
    changed = false;
    for (const o of gp.objectives) if (s.objectives[o.id] === "locked" && o.requires.every((r) => s.objectives[r] === "done")) { s.objectives[o.id] = "active"; changed = true; }
  }
}
function runTriggers(s, gp, trig, effects) {
  for (const cp of gp.checkpoints || []) if (cp.trigger.kind === trig.kind && cp.trigger.ref === trig.ref) s.checkpoint = cp.spawn_ref;
  for (const e of gp.events || []) {
    if (e.trigger.kind !== trig.kind || (e.trigger.ref && e.trigger.ref !== trig.ref)) continue;
    if (e.once && s.fired.includes(e.id)) continue;
    s.fired.push(e.id);
    for (const a of e.actions) {
      if (a.kind === "give_item") s.inventory[a.ref] = (s.inventory[a.ref] || 0) + (a.value || 1);
      if (a.kind === "message") s.messages.push({ t: s.t, text: String(a.value) });
      if (a.kind === "checkpoint") s.checkpoint = a.ref;
      if (a.kind === "set_flag") s.flags[a.ref] = a.value ?? true;
      if (a.kind === "win") s.status = "won";
      if (a.kind === "lose") s.status = "lost";
      effects.push(a);
    }
  }
}
export function applyGameEvent(state, gp, evt) {
  const s = JSON.parse(JSON.stringify(state));
  const effects = [];
  switch (evt.kind) {
    case "tick": s.t += evt.dt; if (gp.rules.time_limit_s && s.t > gp.rules.time_limit_s) s.status = "lost"; break;
    case "enter_region": runTriggers(s, gp, evt, effects); completeObjectives(s, gp, (o) => o.kind === "reach" && o.target_ref === evt.ref, effects); break;
    case "interact": runTriggers(s, gp, evt, effects); completeObjectives(s, gp, (o) => (o.kind === "interact" || o.kind === "activate") && o.target_ref === evt.ref, effects); break;
    case "talk": runTriggers(s, gp, evt, effects); completeObjectives(s, gp, (o) => o.kind === "talk" && o.target_ref === evt.ref, effects); break;
    case "pickup": s.inventory[evt.ref] = (s.inventory[evt.ref] || 0) + (evt.count || 1); completeObjectives(s, gp, (o) => o.kind === "collect" && o.target_ref === evt.ref && s.inventory[evt.ref] >= (o.count || 1), effects); break;
    case "damage": s.health -= evt.value; break;
    case "fell_out": if ((gp.lose_conditions || []).some((l) => l.kind === "fell_out")) s.status = "lost"; else s.health = 0; break;
    default: break;
  }
  if (s.health <= 0 && s.status === "playing") {
    s.lives -= 1;
    if (s.lives > 0) { s.health = gp.rules.player_health; effects.push({ kind: "respawn" }); } else s.status = "lost";
  }
  return { state: s, effects };
}
export function evaluateEnd(s, gp) {
  if (s.status !== "playing") return s.status;
  for (const w of gp.win_conditions) {
    if (w.kind === "all_required_objectives" && gp.objectives.filter((o) => !o.optional).every((o) => s.objectives[o.id] === "done")) return "won";
  }
  return "playing";
}

// ---------------------------------------------------------------- npc brain
export function createNpcState(ch, pos) {
  return { id: ch.id, position: { ...pos }, rotation_y: 0, state: ch.behavior.initial, target: null, path_idx: 0, timer: 0, anim: "idle" };
}
export function setNpcState(n, state) { return { ...n, state, path_idx: 0, target: null }; }
export function stepNpc(n, ch, ctx, dt) {
  const next = { ...n, position: { ...n.position }, timer: n.timer + dt };
  if (n.state !== "patrol" || !ch.behavior.patrol?.length) return { ...next, anim: "idle" };
  const tgt = ch.behavior.patrol[n.path_idx % ch.behavior.patrol.length];
  const dx = tgt.x - n.position.x, dz = tgt.z - n.position.z, d = Math.hypot(dx, dz);
  if (d < 0.3) return { ...next, path_idx: (n.path_idx + 1) % ch.behavior.patrol.length, timer: ctx.rand() };
  const step = Math.min(d, ch.behavior.speed * dt);
  const nx = n.position.x + (dx / d) * step, nz = n.position.z + (dz / d) * step;
  if (ctx.isBlocked(nx, nz)) return { ...next, anim: "idle" };
  next.position = { x: nx, y: ctx.heightAt(nx, nz), z: nz };
  next.rotation_y = Math.atan2(dx, dz);
  next.anim = "walk";
  return next;
}

// ------------------------------------------------------------------ dialogue
function cond(c, s) {
  if (c.kind === "objective_state") return s.objectives[c.ref] === c.value;
  if (c.kind === "has_item") return (s.inventory[c.ref] || 0) >= (c.value ?? 1);
  if (c.kind === "flag") return s.flags[c.ref] === c.value;
  return false;
}
export function openDialogue(dialogues, cid, s) {
  const d = dialogues.find((x) => x.character_ref === cid);
  if (!d) return null;
  const e = d.entry.find((en) => (en.conditions || []).every((c) => cond(c, s)));
  if (!e) return null;
  return { dialogue_id: d.id, node: d.nodes.find((n) => n.id === e.node) };
}
export function availableChoices(node, s) { return node.choices.filter((c) => (c.conditions || []).every((x) => cond(x, s))); }
// Like the real runner, idx indexes the VISIBLE choices.
export function choose(dialogue, node, idx, s) {
  const c = availableChoices(node, s)[idx];
  if (!c) return { node, actions: [], invalid: true };
  return { node: c.next ? dialogue.nodes.find((n) => n.id === c.next) : null, actions: c.actions || [] };
}

export const mockDeps = {
  terrain: { sampleHeight, slopeAt },
  collision: { buildColliders, resolveCapsule, pointInCollider },
  nav: { isWalkable, findPath, reachableSet, navIndex },
  rules: { createGameState, applyGameEvent, evaluateEnd },
  npcBrain: { createNpcState, stepNpc, setNpcState },
  dialogue: { openDialogue, availableChoices, choose },
  expandScatter,
};
