// B4 — the AI playtest agent, critic and repair pass.
//
// The playtest agent is deliberately a SIMULATION over the manifest rather than
// a language model: it walks the world the way the runtime will, so its verdict
// is reproducible and cannot be talked out of a failure. The critic then reads
// the simulation plus the validators and decides whether the world ships. The
// repair pass fixes what it can prove it can fix, and re-tests.
//
// The gate must be able to fail, and it does: a world with a trapped spawn, an
// unreachable NPC, a dead quest or no gameplay loop is rejected.
import { runAllValidators, summarize, heightAt, SEVERITY } from "./validators.mjs";
import { validateManifest } from "../manifest/schema.mjs";

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const MAX_STEP_HEIGHT = 2.5;      // what a player can climb without a ramp
const REACH = 3.0;                // interaction range

/**
 * Walk the world. Returns the route the agent actually managed, plus what it
 * could and could not reach.
 *
 * The traversal is a grid-limited A*-style flood over the terrain, using the
 * same slope rule the runtime enforces, so "unreachable" here means unreachable
 * in the game.
 */
export function simulatePlaythrough(m, { maxNodes = 60000 } = {}) {
  const spawn = m.spawn?.player_spawns?.[0];
  if (!spawn) return { ok: false, reason: "no spawn", visited: [], reached: new Set(), steps: 0 };

  const size = m.terrain?.size || { w: 256, h: 256 };
  const STEP = Math.max(3, Math.min(8, Math.round(Math.max(size.w, size.h) / 60)));
  const cols = Math.ceil(size.w / STEP), rows = Math.ceil(size.h / STEP);
  const key = (i, j) => j * cols + i;

  // Solid footprints block movement, exactly as the runtime's collision will.
  const blockers = (m.structures || [])
    .filter((s) => s.transform?.position)
    .map((s) => ({ id: s.id, p: s.transform.position, r: Math.max(s.footprint?.w || 6, s.footprint?.d || 6) / 2 }));
  const blocked = (x, z) => blockers.find((b) => dist({ x, z }, b.p) < b.r * 0.85);

  const start = { i: Math.max(0, Math.min(cols - 1, Math.round(spawn.position.x / STEP))), j: Math.max(0, Math.min(rows - 1, Math.round(spawn.position.z / STEP))) };
  const seen = new Uint8Array(cols * rows);
  const queue = [start];
  seen[key(start.i, start.j)] = 1;
  const visited = [];
  let nodes = 0;

  while (queue.length && nodes < maxNodes) {
    const cur = queue.shift();
    nodes++;
    const cx = cur.i * STEP, cz = cur.j * STEP;
    visited.push({ x: cx, z: cz });
    const cy = heightAt(m.terrain, cx, cz);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const ni = cur.i + di, nj = cur.j + dj;
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const k = key(ni, nj);
      if (seen[k]) continue;
      const nx = ni * STEP, nz = nj * STEP;
      if (blocked(nx, nz)) { seen[k] = 1; continue; }
      if (Math.abs(heightAt(m.terrain, nx, nz) - cy) > MAX_STEP_HEIGHT) { seen[k] = 1; continue; }
      seen[k] = 1;
      queue.push({ i: ni, j: nj });
    }
  }

  /**
   * Could the agent stand close enough to interact with this point?
   *
   * Horizontal distance alone is not enough: an NPC standing on top of an
   * unclimbable plateau is directly above ground the agent can walk on, and a
   * distance-only check called that "reachable". The vertical gap has to be
   * climbable too.
   */
  const canReach = (p, extra = 0) => visited.some((v) => {
    if (dist(v, p) > extra + STEP + REACH) return false;
    const standY = heightAt(m.terrain, v.x, v.z);
    const targetY = typeof p.y === "number" ? p.y : heightAt(m.terrain, p.x, p.z);
    return Math.abs(targetY - standY) <= MAX_STEP_HEIGHT + REACH;
  });

  const reached = new Set();
  const unreachable = [];
  for (const n of m.npcs || []) { if (canReach(n.spawn)) reached.add(n.id); else unreachable.push({ kind: "npc", id: n.id, at: n.spawn }); }
  for (const s of m.structures || []) {
    if (!s.transform?.position) continue;
    // A structure counts as reached if the agent can stand next to it.
    const p = s.transform.position;
    const r = Math.max(s.footprint?.w || 6, s.footprint?.d || 6) / 2;
    if (canReach(p, r)) reached.add(s.id);
    else unreachable.push({ kind: "structure", id: s.id, at: p });
  }
  for (const z of m.zones || []) {
    const [x0, z0, x1, z1] = z.bounds;
    if (visited.some((v) => v.x >= x0 && v.x <= x1 && v.z >= z0 && v.z <= z1)) reached.add(z.id);
    else unreachable.push({ kind: "zone", id: z.id });
  }
  // Items are reached through whatever pickup or container hosts them.
  //
  // The existence check is not belt-and-braces. A behaviour can outlive the item
  // its spec names — the id is not a target_ref, so a prune that only follows
  // target_ref/behavior_ref will not see it — and without this gate the walk
  // would put an id that no longer names anything into `reached`. Everything
  // downstream trusts `reached`, so a quest step pointing at a deleted item was
  // then judged completable: the agent reported it had picked up something that
  // does not exist.
  const itemIds = new Set((m.items || []).map((it) => it.id));
  for (const b of m.behaviors || []) {
    const held = b.kind === "pickup" ? (b.spec?.item ? [b.spec.item] : [])
      : b.kind === "container" && Array.isArray(b.spec?.contains) ? b.spec.contains
      : [];
    if (!held.length) continue;
    const host = (m.interactions || []).find((i) => i.behavior_ref === b.id);
    if (!host || !reached.has(host.target_ref)) continue;
    for (const id of held) if (itemIds.has(id)) reached.add(id);
  }

  const coverage = (visited.length * STEP * STEP) / (size.w * size.h);
  return {
    ok: true,
    spawn: spawn.position,
    step: STEP,
    visited_cells: visited.length,
    coverage: Number(Math.min(1, coverage).toFixed(3)),
    reached,
    unreachable,
    truncated: nodes >= maxNodes,
  };
}

/** Can each quest be completed, step by step, by the agent that just walked? */
export function simulateQuests(m, walk) {
  const results = [];
  for (const q of m.quests || []) {
    const steps = [];
    let completable = true;
    for (const st of q.steps || []) {
      let ok = false, why = null;
      if (!st.target) { why = "the step has no target"; }
      else if (!walk.reached.has(st.target)) { why = `'${st.target}' cannot be reached from the spawn`; }
      else ok = true;
      if (!ok) completable = false;
      steps.push({ id: st.id, kind: st.kind, target: st.target, ok, ...(why ? { why } : {}) });
    }
    results.push({ quest: q.id, title: q.title, completable, steps });
  }
  return results;
}

/**
 * The critic. Combines schema validity, the validators and the simulation into
 * one verdict. `passed` is the shipping gate and it is genuinely able to be false.
 */
export function critique(m, { walk, quests } = {}) {
  const schema = validateManifest(m);
  const findings = runAllValidators(m);

  // Simulation findings carry more weight than static ones: they are what a
  // player would actually hit.
  const simFindings = [];
  if (walk) {
    if (!walk.ok) simFindings.push({ id: "no_spawn", severity: SEVERITY.BLOCKER, message: "the world cannot be entered" });
    if (walk.ok && walk.visited_cells <= 1) {
      simFindings.push({ id: "spawn_trapped_sim", severity: SEVERITY.BLOCKER, message: "the playtest agent could not move from the spawn" });
    }
    if (walk.ok && walk.coverage < 0.05 && walk.visited_cells > 1) {
      simFindings.push({ id: "world_mostly_unreachable", severity: SEVERITY.MAJOR, message: `only ${(walk.coverage * 100).toFixed(1)}% of the world is reachable on foot`, data: { coverage: walk.coverage } });
    }
    for (const u of walk.unreachable || []) {
      if (u.kind === "npc") simFindings.push({ id: "npc_unreachable", severity: SEVERITY.MAJOR, message: `NPC '${u.id}' cannot be reached from the spawn`, where: u.id, fix: "relocate_npc" });
      if (u.kind === "zone") simFindings.push({ id: "zone_unreachable_sim", severity: SEVERITY.MAJOR, message: `zone '${u.id}' cannot be walked to`, where: u.id, fix: "link_zone" });
    }
  }
  for (const q of quests || []) {
    if (!q.completable) {
      const blocked = q.steps.filter((s) => !s.ok);
      simFindings.push({
        id: "quest_not_completable", severity: SEVERITY.BLOCKER,
        message: `quest '${q.quest}' cannot be completed: ${blocked.map((s) => s.why).join("; ")}`,
        where: q.quest, fix: "retarget_step",
      });
    }
  }

  const schemaFindings = schema.errors.map((e) => ({ id: "schema_error", severity: SEVERITY.BLOCKER, message: `${e.path}: ${e.message}`, where: e.path }));
  const all = [...schemaFindings, ...findings, ...simFindings];
  const sum = summarize(all);

  return {
    passed: sum.blocker === 0 && sum.major === 0,
    verdict: sum.blocker > 0 ? "REJECTED" : sum.major > 0 ? "NEEDS_WORK" : sum.minor > 0 ? "PASSED_WITH_NOTES" : "PASSED",
    summary: sum,
    findings: all,
    schema_ok: schema.ok,
  };
}

// -------------------------------------------------------------------- repair
//
// Only repairs it can PROVE are correct. It never invents an entity to satisfy a
// dangling reference — that would hide the defect rather than fix it. Where the
// honest repair is removal, it removes and says so.

/**
 * Does this NPC have anything to say?
 *
 * The canonical v3 shape is `dialogue: { seed, lines: [] }` — and `lines` is
 * EMPTY at generation time on every path (migrate.mjs, assembly.mjs,
 * expansion/planner.mjs all construct it that way); the seed is what carries
 * the intent, with lines realised later at runtime. A first version of this
 * read `Array.isArray(npc.dialogue)`, which is true for no real manifest at
 * all, so every NPC in a generated world counted as mute and the repair wired
 * nothing while reporting success. Judging speech by `lines` alone is the same
 * bug wearing a different hat.
 *
 * The legacy array form is still accepted because older stored manifests use
 * it and this runs over worlds loaded from disk, not only fresh ones.
 */
export function npcHasSpeech(npc) {
  const d = npc?.dialogue;
  if (!d) return false;
  if (Array.isArray(d)) return d.filter(Boolean).length > 0;
  if (typeof d === "string") return d.trim() !== "";
  const lines = Array.isArray(d.lines) ? d.lines.filter(Boolean) : [];
  const seed = typeof d.seed === "string" ? d.seed.trim() : "";
  return lines.length > 0 || seed !== "";
}

/**
 * Findings that are deliberately NOT auto-repaired, and why.
 *
 * These are the cases where a repair would have to invent the world's actual
 * content — characters and buildings that a designer or a model is supposed to
 * author. Fabricating them to clear a validator would defeat the point of the
 * gate: the world would pass while being emptier than it claims. The right
 * outcome is the one that already happens — the world is rejected and
 * regenerated — and this registry exists so that outcome is a stated decision
 * rather than an unnoticed hole. Anything NOT listed here and NOT implemented
 * is a gap, and `test/playtest.test.mjs` fails on it.
 */
export const UNREPAIRABLE = {
  add_npcs: "a world with no NPCs needs characters written, not generated wiring; inventing them would make the world pass while staying empty",
  add_structures: "a world with no structures needs a place built, not a placeholder box dropped in to clear a validator",
};

export function repair(manifest, findings) {
  const m = structuredClone(manifest);
  const applied = [];
  const skipped = [];

  const byId = (arr, id) => (arr || []).find((x) => x.id === id);

  for (const f of findings) {
    switch (f.fix) {
      case "reseat_on_ground": {
        const s = byId(m.structures, f.where);
        if (!s) { skipped.push({ ...f, why: "structure gone" }); break; }
        s.transform.position.y = heightAt(m.terrain, s.transform.position.x, s.transform.position.z);
        applied.push({ fix: "reseat_on_ground", target: f.where });
        break;
      }
      case "clamp_into_zone": {
        const s = byId(m.structures, f.where);
        const z = byId(m.zones, s?.zone) || m.zones?.[0];
        if (!s || !z) { skipped.push({ ...f, why: "no zone to clamp into" }); break; }
        const [x0, z0, x1, z1] = z.bounds;
        s.transform.position.x = Math.max(x0 + 2, Math.min(x1 - 2, s.transform.position.x));
        s.transform.position.z = Math.max(z0 + 2, Math.min(z1 - 2, s.transform.position.z));
        s.transform.position.y = heightAt(m.terrain, s.transform.position.x, s.transform.position.z);
        applied.push({ fix: "clamp_into_zone", target: f.where });
        break;
      }
      case "move_spawn":
      case "add_spawn": {
        // Both findings want the same thing: a player standing somewhere they
        // can actually stand. `move_spawn` used to index player_spawns[0]
        // unconditionally and threw a TypeError on a world that had no spawn at
        // all — which does not skip one repair, it aborts the whole repair pass
        // and fails the generation outright.
        const moved = findSafeSpawn(m);
        if (!moved) { skipped.push({ ...f, why: "no safe ground anywhere in the world" }); break; }
        m.spawn = m.spawn || {};
        m.spawn.player_spawns = m.spawn.player_spawns || [];
        if (!m.spawn.player_spawns.length) {
          m.spawn.player_spawns.push({ id: "spawn_default", position: moved.position, zone: moved.zone, facing: 0 });
          applied.push({ fix: "add_spawn", at: moved.position, zone: moved.zone });
          break;
        }
        m.spawn.player_spawns[0].position = moved.position;
        m.spawn.player_spawns[0].zone = moved.zone;
        applied.push({ fix: "move_spawn", target: f.where, to: moved.position });
        break;
      }
      case "separate": {
        const a = byId(m.structures, f.where);
        const b = byId(m.structures, f.data?.other);
        if (!a || !b) { skipped.push({ ...f, why: "structure gone" }); break; }
        const dx = a.transform.position.x - b.transform.position.x;
        const dz = a.transform.position.z - b.transform.position.z;
        const len = Math.hypot(dx, dz) || 1;
        // A finding that arrives without its measurements would compute NaN
        // here and write NaN into the structure's position — silent geometry
        // corruption that only surfaces much later, as a crash somewhere else.
        const needed = Number(f.data?.needed), distance = Number(f.data?.distance);
        if (!Number.isFinite(needed) || !Number.isFinite(distance)) {
          skipped.push({ ...f, why: "the overlap finding carries no measurements, and guessing a distance would move a building at random" });
          break;
        }
        const push = (needed - distance) / 2 + 1;
        a.transform.position.x += (dx / len) * push;
        a.transform.position.z += (dz / len) * push;
        a.transform.position.y = heightAt(m.terrain, a.transform.position.x, a.transform.position.z);
        applied.push({ fix: "separate", target: f.where });
        break;
      }
      case "add_collision": {
        const a = byId(m.assets, f.where);
        if (!a) { skipped.push({ ...f, why: "asset gone" }); break; }
        a.collision = { kind: "box", solid: true, height: a.composition?.dimensions?.h || 4 };
        applied.push({ fix: "add_collision", target: f.where });
        break;
      }
      case "link_zone": {
        // Link the orphan to its nearest neighbour by centre distance. This is a
        // real navigation link, not a claim that one already existed.
        const z = byId(m.zones, f.where);
        if (!z || m.zones.length < 2) { skipped.push({ ...f, why: "nothing to link to" }); break; }
        const c = (zz) => ({ x: (zz.bounds[0] + zz.bounds[2]) / 2, z: (zz.bounds[1] + zz.bounds[3]) / 2 });
        let best = null;
        for (const other of m.zones) {
          if (other.id === z.id) continue;
          const d = dist(c(z), c(other));
          if (!best || d < best.d) best = { id: other.id, d };
        }
        if (!best) { skipped.push({ ...f, why: "no neighbour" }); break; }
        m.navigation = m.navigation || { links: [] };
        m.navigation.links = m.navigation.links || [];
        m.navigation.links.push({ from: best.id, to: z.id, kind: "path", cost: Number(best.d.toFixed(1)), added_by: "repair" });
        applied.push({ fix: "link_zone", target: f.where, linked_to: best.id });
        break;
      }
      case "relocate_npc": {
        const id = String(f.where).split(".")[0];
        const npc = byId(m.npcs, f.where) || byId(m.npcs, id);
        if (!npc) { skipped.push({ ...f, why: "npc gone" }); break; }
        const spawn = m.spawn?.player_spawns?.[0];
        const z = byId(m.zones, spawn?.zone) || m.zones?.[0];
        if (!z || !spawn) { skipped.push({ ...f, why: "no reachable zone" }); break; }
        // Put them somewhere the agent has already proven it can stand.
        npc.zone = z.id;
        npc.spawn = { x: spawn.position.x + 6, y: heightAt(m.terrain, spawn.position.x + 6, spawn.position.z + 4), z: spawn.position.z + 4 };
        applied.push({ fix: "relocate_npc", target: npc.id });
        break;
      }
      case "place_item": {
        // The item exists but nothing holds it. Attach a pickup to a structure
        // the agent can reach, which is a real fix, not a paper one.
        const itemId = String(f.where).split(".").pop() && f.data?.item ? f.data.item : null;
        const step = f.where ? String(f.where) : "";
        const target = (m.quests || []).flatMap((q) => q.steps).find((s) => `${s.id}` && step.endsWith(s.id))?.target;
        const item = target || itemId;
        const host = (m.structures || [])[0];
        if (!item || !host) { skipped.push({ ...f, why: "no host structure for the item" }); break; }
        const bid = `behavior_pickup_${item}`;
        if (!byId(m.behaviors, bid)) m.behaviors.push({ id: bid, kind: "pickup", spec: { item, respawn_s: null } });
        m.interactions.push({ id: `interaction_pickup_${item}`, trigger: "proximity", target_ref: host.id, behavior_ref: bid, params: { radius: 3, added_by: "repair" } });
        applied.push({ fix: "place_item", target: item, host: host.id });
        break;
      }
      case "add_interactions": {
        // Two validators ask for this fix — `no_interactions` and
        // `npcs_not_interactive` — and NOTHING implemented it, so the finding
        // was raised, skipped, and then failed the world. It never showed up
        // locally because the offline planner always emits interactions; the
        // first real provider run on staging hit it immediately.
        //
        // What is repaired here is WIRING, not content. An NPC that already has
        // dialogue is one the world intends you to talk to; what is missing is
        // the interaction that lets you. An NPC with nothing to say is left
        // alone and reported — inventing speech for it would be exactly the
        // fabrication this gate exists to catch.
        m.behaviors = m.behaviors || [];
        m.interactions = m.interactions || [];
        const wired = new Set(m.interactions.map((i) => i.target_ref));
        const mute = [];
        let added = 0;
        for (const npc of m.npcs || []) {
          if (wired.has(npc.id)) continue;
          if (!npcHasSpeech(npc)) { mute.push(npc.id); continue; }
          const bid = `behavior_talk_${npc.id}`;
          if (!byId(m.behaviors, bid)) {
            m.behaviors.push({ id: bid, kind: "npc_ai", spec: { npc: npc.id, mode: "dialogue" } });
          }
          m.interactions.push({
            id: `interaction_talk_${npc.id}`,
            trigger: "interact",
            target_ref: npc.id,
            behavior_ref: bid,
            params: { prompt: `Talk to ${npc.name || npc.id}`, added_by: "repair" },
          });
          added++;
        }
        if (!added) { skipped.push({ ...f, why: mute.length ? `every NPC is mute (${mute.length}); dialogue cannot be invented` : "no NPC to wire" }); break; }
        applied.push({ fix: "add_interactions", wired: added, left_mute: mute.length });
        break;
      }
      case "drop_quest":
      case "retarget_step": {
        // Honest repair: a quest that cannot be completed is REMOVED, not
        // patched with an invented target. A world with fewer real quests beats
        // a world with a quest that lies.
        const qid = String(f.where).split(".")[0];
        const before = m.quests.length;
        m.quests = m.quests.filter((q) => q.id !== qid);
        if (m.quests.length < before) applied.push({ fix: "drop_quest", target: qid, note: "removed rather than fabricating a target" });
        else skipped.push({ ...f, why: "quest already gone" });
        break;
      }
      case "drop_or_substitute": {
        const id = f.where;
        const beforeS = m.structures.length, beforeN = m.npcs.length;
        m.structures = m.structures.filter((s) => s.id !== id);
        m.npcs = m.npcs.filter((n) => n.id !== id);
        if (m.structures.length < beforeS || m.npcs.length < beforeN) applied.push({ fix: "drop_broken_reference", target: id });
        else skipped.push({ ...f, why: "entity already gone" });
        break;
      }
      case "wire_or_drop": {
        m.behaviors = m.behaviors.filter((b) => b.id !== f.where);
        applied.push({ fix: "drop_orphan_behavior", target: f.where });
        break;
      }
      case "scrub_spec_ref": {
        // A behaviour that names an entity the world no longer has, in a field
        // it can survive losing. The reference is removed, not redirected: the
        // door simply is not locked any more, the container simply does not hold
        // that item. Substituting a different entity would be a fabrication.
        const b = byId(m.behaviors, f.where);
        const field = f.data?.field;
        if (!b || !field || !b.spec || !(field in b.spec)) { skipped.push({ ...f, why: "behaviour or field gone" }); break; }
        if (Array.isArray(b.spec[field])) b.spec[field] = b.spec[field].filter((x) => x !== f.data.ref);
        else b.spec[field] = null;
        applied.push({ fix: "scrub_spec_ref", target: f.where, field, dropped: f.data.ref });
        break;
      }
      case "add_doors": {
        // Wiring, not content: a structure already declared `enterable` is one
        // the world says you can go into. What is missing is the door that
        // lets you.
        m.behaviors = m.behaviors || [];
        m.interactions = m.interactions || [];
        const wired = new Set(m.interactions.map((i) => i.target_ref));
        let doors = 0;
        for (const st of (m.structures || []).filter((x) => x.enterable)) {
          if (wired.has(st.id)) continue;
          const bid = `behavior_door_${st.id}`;
          if (!byId(m.behaviors, bid)) {
            m.behaviors.push({ id: bid, kind: "door", spec: { opens: "inward", speed: 2, auto_close_s: 30 } });
          }
          m.interactions.push({
            id: `interaction_door_${st.id}`, trigger: "interact",
            target_ref: st.id, behavior_ref: bid,
            params: { prompt: `Enter ${st.name || st.id}`, added_by: "repair" },
          });
          doors++;
        }
        if (!doors) { skipped.push({ ...f, why: "no enterable structure is missing a door" }); break; }
        applied.push({ fix: "add_doors", doors });
        break;
      }

      case "add_behaviors": {
        // Derived entirely from entities that already exist. Every NPC gets an
        // ai routine, every enterable structure a door, every item a pickup.
        // Nothing is invented; what was missing was the layer that makes the
        // existing cast do anything.
        m.behaviors = m.behaviors || [];
        m.interactions = m.interactions || [];
        const wired = new Set(m.interactions.map((i) => i.target_ref));
        const have = new Set(m.behaviors.map((b) => b.kind));
        const made = [];
        const wire = (target, bid, kind, spec, prompt) => {
          if (!byId(m.behaviors, bid)) { m.behaviors.push({ id: bid, kind, spec }); made.push(kind); }
          if (!wired.has(target)) {
            m.interactions.push({ id: `interaction_${kind}_${target}`, trigger: "interact", target_ref: target, behavior_ref: bid, params: { prompt, added_by: "repair" } });
            wired.add(target);
          }
        };
        for (const n of m.npcs || []) {
          if (!npcHasSpeech(n)) continue;
          wire(n.id, `behavior_talk_${n.id}`, "npc_ai", { npc: n.id, mode: "dialogue" }, `Talk to ${n.name || n.id}`);
        }
        for (const st of (m.structures || []).filter((x) => x.enterable)) {
          wire(st.id, `behavior_door_${st.id}`, "door", { opens: "inward", speed: 2, auto_close_s: 30 }, `Enter ${st.name || st.id}`);
        }
        for (const it of m.items || []) {
          wire(it.id, `behavior_pickup_${it.id}`, "pickup", { item: it.id }, `Take ${it.name || it.id}`);
        }
        if (!made.length) {
          skipped.push({ ...f, why: `nothing to derive behaviours from (${(m.npcs || []).length} npcs, ${(m.structures || []).length} structures, ${(m.items || []).length} items); behaviour cannot be invented from an empty world` });
          break;
        }
        applied.push({ fix: "add_behaviors", added: made.length, kinds: [...new Set(made)], kinds_before: [...have] });
        break;
      }

      case "add_quest": {
        // A quest built ONLY from what the world already contains. If there are
        // zones to visit, the objective is to visit them; if there is an item
        // and someone to bring it to, it is a delivery. What this must never do
        // is invent a story goal the world has no entities for — a quest whose
        // steps reference things that do not exist is worse than no quest, and
        // validateQuests would rightly reject it a moment later.
        m.quests = m.quests || [];
        const zones = m.zones || [];
        const items = m.items || [];
        const talkers = (m.npcs || []).filter(npcHasSpeech);
        let quest = null;

        // The shape here is the schema's, not a plausible-looking approximation
        // of it: `title` (not name), `steps[].target` (not target_ref), and a
        // kind from QUEST_STEP_KINDS. A quest built to the wrong shape fails
        // WorldManifestV3 validation and takes the whole generation down with
        // it, which is a worse outcome than the missing quest it was meant to
        // fix.
        if (items.length && talkers.length) {
          const item = items[0], giver = talkers[0];
          quest = {
            id: "quest_recovered_delivery",
            title: `Return the ${item.name || item.id}`,
            giver_npc: giver.id,
            zone: giver.zone || null,
            difficulty: "easy",
            steps: [
              { id: "step_find", kind: "collect", target: item.id, description: `Find the ${item.name || item.id}.` },
              { id: "step_return", kind: "talk", target: giver.id, description: `Bring it to ${giver.name || giver.id}.` },
            ],
            rewards: [], prerequisites: [],
          };
        } else if (zones.length >= 2) {
          quest = {
            id: "quest_recovered_survey",
            title: "Walk the ground",
            giver_npc: talkers[0]?.id || null,
            zone: null,
            difficulty: "easy",
            steps: zones.slice(0, 4).map((z) => ({
              id: `step_reach_${z.id}`, kind: "reach", target: z.id,
              description: `Reach ${z.name || z.id}.`,
            })),
            rewards: [], prerequisites: [],
          };
        } else if (talkers.length) {
          const giver = talkers[0];
          quest = {
            id: "quest_recovered_word",
            title: `Speak with ${giver.name || giver.id}`,
            giver_npc: giver.id,
            zone: giver.zone || null,
            difficulty: "easy",
            steps: [{ id: "step_talk", kind: "talk", target: giver.id, description: `Find ${giver.name || giver.id} and hear them out.` }],
            rewards: [], prerequisites: [],
          };
        }

        if (!quest) {
          skipped.push({ ...f, why: `nothing to build an objective from (${zones.length} zones, ${items.length} items, ${talkers.length} speaking npcs)` });
          break;
        }
        quest.added_by = "repair";
        m.quests.push(quest);
        applied.push({ fix: "add_quest", quest: quest.id, steps: quest.steps.length });
        break;
      }

      case "reassign_giver": {
        // The quest points at an NPC that does not exist. Prefer an NPC in the
        // same zone as the quest's own steps, so the reassignment is at least
        // geographically coherent; failing that, clear the giver rather than
        // silently attaching the quest to an unrelated stranger across the map.
        const q = byId(m.quests, f.where);
        if (!q) { skipped.push({ ...f, why: "quest gone" }); break; }
        const stepZones = new Set(
          (q.steps || [])
            .map((st) => byId(m.zones, st.target) || byId(m.structures, st.target) || byId(m.npcs, st.target))
            .map((e) => e?.zone || e?.id)
            .filter(Boolean)
        );
        const local = (m.npcs || []).find((n) => stepZones.has(n.zone) && npcHasSpeech(n));
        if (local) {
          q.giver_npc = local.id;
          applied.push({ fix: "reassign_giver", quest: q.id, to: local.id, why: "an NPC in the quest's own ground" });
          break;
        }
        const missing = q.giver_npc;
        q.giver_npc = null;
        applied.push({ fix: "reassign_giver", quest: q.id, to: null, dropped: missing, why: "no NPC in the quest's zones; a quest with no giver beats one attributed to a stranger" });
        break;
      }

      case "flatten_zone": {
        // Geometry, not content. A zone that is only a few percent walkable is
        // not a place you can be, so the terrain under it is eased toward its
        // own median height. The heightmap is the same data the runtime walks
        // on, so this is a real change, not a relabelling of the finding.
        const z = byId(m.zones, f.where);
        const hm = m.terrain?.heightmap;
        if (!z || !Array.isArray(hm) || !hm.length) {
          skipped.push({ ...f, why: !z ? "zone gone" : "this world has no heightmap to flatten" });
          break;
        }
        const size = m.terrain.size || { w: hm[0].length, h: hm.length };
        const [x0, z0, x1, z1] = z.bounds;
        const cols = hm[0].length, rows = hm.length;
        const cx0 = Math.max(0, Math.floor((x0 / size.w) * cols)), cx1 = Math.min(cols - 1, Math.ceil((x1 / size.w) * cols));
        const cz0 = Math.max(0, Math.floor((z0 / size.h) * rows)), cz1 = Math.min(rows - 1, Math.ceil((z1 / size.h) * rows));
        const vals = [];
        for (let r = cz0; r <= cz1; r++) for (let c = cx0; c <= cx1; c++) vals.push(hm[r][c]);
        if (!vals.length) { skipped.push({ ...f, why: "the zone covers no heightmap cells" }); break; }
        vals.sort((a, b) => a - b);
        const median = vals[Math.floor(vals.length / 2)];
        // Eased, not levelled: a billiard-table zone reads as broken terrain.
        const EASE = 0.75;
        let touched = 0;
        for (let r = cz0; r <= cz1; r++) {
          for (let c = cx0; c <= cx1; c++) {
            hm[r][c] = hm[r][c] + (median - hm[r][c]) * EASE;
            touched++;
          }
        }
        applied.push({ fix: "flatten_zone", zone: z.id, cells: touched, toward: Number(median.toFixed(3)), ease: EASE });
        break;
      }

      default:
        if (UNREPAIRABLE[f.fix]) { skipped.push({ ...f, why: UNREPAIRABLE[f.fix], declined: true }); break; }
        skipped.push({ ...f, why: f.fix ? `no repair implemented for '${f.fix}'` : "not automatically repairable" });
    }
  }

  // Repairs that REMOVE things can orphan the things that pointed at them.
  // Keeping the manifest internally consistent is part of the repair, not an
  // optional tidy-up: a dangling reference fails WorldManifestV3 validation,
  // which turns a world the gate could have fixed into a hard generation
  // failure. `drop_or_substitute` removed a structure and left quest steps
  // aimed at it, and that is exactly what happened.
  const behaviorIds = new Set(m.behaviors.map((b) => b.id));
  const entityIds = new Set([
    ...m.zones.map((z) => z.id), ...m.structures.map((s) => s.id),
    ...m.npcs.map((n) => n.id), ...(m.items || []).map((i) => i.id),
  ]);
  const beforeI = m.interactions.length;
  m.interactions = m.interactions.filter((i) => behaviorIds.has(i.behavior_ref) && entityIds.has(i.target_ref));
  if (m.interactions.length < beforeI) applied.push({ fix: "prune_dangling_interactions", removed: beforeI - m.interactions.length });

  const npcIds = new Set(m.npcs.map((n) => n.id));
  let prunedSteps = 0;
  const droppedQuests = [];
  m.quests = (m.quests || []).filter((q) => {
    const before = (q.steps || []).length;
    q.steps = (q.steps || []).filter((st) => !st?.target || entityIds.has(st.target));
    prunedSteps += before - q.steps.length;
    // A giver who no longer exists is a schema error too; clearing it keeps the
    // quest playable rather than deleting work over a missing name.
    if (q.giver_npc && !npcIds.has(q.giver_npc)) q.giver_npc = null;
    if (!q.steps.length) { droppedQuests.push(q.id); return false; }
    return true;
  });
  if (prunedSteps) applied.push({ fix: "prune_dangling_quest_steps", removed: prunedSteps });
  // A quest left with no steps can never be completed, so it goes the same way
  // drop_quest sends one: removed, not patched with an invented target.
  if (droppedQuests.length) applied.push({ fix: "drop_emptied_quests", quests: droppedQuests });

  return { manifest: m, applied, skipped };
}

function findSafeSpawn(m) {
  const size = m.terrain?.size || { w: 128, h: 128 };
  const blockers = (m.structures || []).filter((s) => s.transform?.position)
    .map((s) => ({ p: s.transform.position, r: Math.max(s.footprint?.w || 6, s.footprint?.d || 6) / 2 }));
  let best = null;
  for (const z of m.zones?.length ? m.zones : [{ id: null, bounds: [0, 0, size.w, size.h] }]) {
    const [x0, z0, x1, z1] = z.bounds;
    for (let x = x0 + 4; x < x1 - 4; x += Math.max(4, (x1 - x0) / 12)) {
      for (let zz = z0 + 4; zz < z1 - 4; zz += Math.max(4, (z1 - z0) / 12)) {
        if (blockers.some((b) => dist({ x, z: zz }, b.p) < b.r + 3)) continue;
        const y = heightAt(m.terrain, x, zz);
        const slope = Math.abs(y - heightAt(m.terrain, x + 4, zz)) + Math.abs(y - heightAt(m.terrain, x, zz + 4));
        if (!best || slope < best.slope) best = { slope, position: { x: Number(x.toFixed(2)), y: Number((y + 1).toFixed(2)), z: Number(zz.toFixed(2)) }, zone: z.id };
      }
    }
  }
  return best;
}

/**
 * The full B4 pass: playtest, critique, repair what is provably fixable, re-test.
 * Returns the (possibly repaired) manifest and both verdicts, so a caller can
 * see exactly what the repair changed.
 */
/**
 * Validate, repair, re-validate — until the world passes or nothing more can be
 * done.
 *
 * This used to allow two rounds, which is exactly one repair opportunity: round
 * 2 could only validate. That is not enough, because a repair can legitimately
 * create a new fixable finding. Staging showed the sequence plainly: two quests
 * were uncompletable, `drop_quest` correctly removed both rather than
 * fabricating targets for them, and the world was then rejected for `no_quests`
 * — a finding that `add_quest` handles and never got the chance to. The repair
 * pass was failing worlds for the consequences of its own correct decisions.
 *
 * A third round is the smallest change that lets a repair-induced finding be
 * repaired, and the loop now stops as soon as a round applies nothing, so the
 * extra round costs nothing on worlds that do not need it.
 */
export async function playtestAndRepair(manifest, { maxRounds = 3 } = {}) {
  const rounds = [];
  let current = manifest;

  for (let i = 0; i < maxRounds; i++) {
    const walk = simulatePlaythrough(current);
    const quests = simulateQuests(current, walk);
    const verdict = critique(current, { walk, quests });
    rounds.push({
      round: i + 1,
      verdict: verdict.verdict,
      passed: verdict.passed,
      summary: verdict.summary,
      findings: verdict.findings,
      coverage: walk.coverage,
      quests_completable: quests.filter((q) => q.completable).length,
      quests_total: quests.length,
    });
    if (verdict.passed || i === maxRounds - 1) {
      return { manifest: current, passed: verdict.passed, verdict: verdict.verdict, rounds, repairs: rounds.flatMap((r) => r.repairs || []) };
    }
    const fixable = verdict.findings.filter((f) => f.fix);
    if (!fixable.length) {
      return { manifest: current, passed: false, verdict: verdict.verdict, rounds, repairs: [], note: "no automatic repair applies to these findings" };
    }
    const r = repair(current, fixable);
    rounds[rounds.length - 1].repairs = r.applied;
    rounds[rounds.length - 1].skipped_repairs = r.skipped;
    if (!r.applied.length) {
      // Nothing changed, so re-validating would produce the same findings.
      return {
        // REJECTED rather than the critic's own verdict: we are giving up, and
        // "NEEDS_WORK" would imply another round might help when none will.
        manifest: current, passed: false, verdict: "REJECTED", rounds,
        repairs: rounds.flatMap((x) => x.repairs || []),
        note: "no repair could be applied to the remaining findings",
      };
    }
    current = r.manifest;
  }
  return { manifest: current, passed: false, verdict: "REJECTED", rounds, repairs: rounds.flatMap((r) => r.repairs || []) };
}
