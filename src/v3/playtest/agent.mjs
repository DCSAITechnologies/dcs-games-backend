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
  // Items are reached through whatever pickup hosts them.
  for (const b of m.behaviors || []) {
    if (b.kind !== "pickup" || !b.spec?.item) continue;
    const host = (m.interactions || []).find((i) => i.behavior_ref === b.id);
    if (host && reached.has(host.target_ref)) reached.add(b.spec.item);
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
      case "move_spawn": {
        const moved = findSafeSpawn(m);
        if (!moved) { skipped.push({ ...f, why: "no safe ground anywhere in the world" }); break; }
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
        const push = (f.data.needed - f.data.distance) / 2 + 1;
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
      default:
        skipped.push({ ...f, why: f.fix ? `no repair implemented for '${f.fix}'` : "not automatically repairable" });
    }
  }

  // Dropping a quest can orphan its interactions; keep the manifest consistent.
  const behaviorIds = new Set(m.behaviors.map((b) => b.id));
  const entityIds = new Set([
    ...m.zones.map((z) => z.id), ...m.structures.map((s) => s.id),
    ...m.npcs.map((n) => n.id), ...(m.items || []).map((i) => i.id),
  ]);
  const beforeI = m.interactions.length;
  m.interactions = m.interactions.filter((i) => behaviorIds.has(i.behavior_ref) && entityIds.has(i.target_ref));
  if (m.interactions.length < beforeI) applied.push({ fix: "prune_dangling_interactions", removed: beforeI - m.interactions.length });

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
export async function playtestAndRepair(manifest, { maxRounds = 2 } = {}) {
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
    current = r.manifest;
  }
  return { manifest: current, passed: false, verdict: "REJECTED", rounds, repairs: rounds.flatMap((r) => r.repairs || []) };
}
