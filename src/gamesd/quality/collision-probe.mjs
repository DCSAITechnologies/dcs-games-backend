// Games-D collision probe. Node-side.
//
// Re-runs the Games-B headless playtest (the same agent, the same sim-core, so
// the same path the build's own playtest took) with the collision dependency
// wrapped, and checks every position the sim settles the player at after
// collision resolution. A step "ends inside a solid" when the capsule centre
// lies inside a solid collider on the XZ plane AND the capsule overlaps the
// collider vertically (standing on top of a rock is not inside it).
//
// The sim only calls resolveCapsule when a collider is near (broadphase), and a
// player with no collider near cannot be inside one, so the wrapped call sees
// every step where the answer could be "yes". Spawn and the final position are
// checked as well.

import { headlessPlaytest } from "../../gamesb/runtime/headless-playtest.mjs";
import { containsXZ } from "../../gamesb/world/collision.mjs";

async function realDeps() {
  return (await import("../../gamesb/runtime/deps.mjs")).realDeps;
}

function colliderHeight(c) {
  return c.shape === "box" ? (c.half?.y || 0) * 2 : c.height || 0;
}

/** The solid collider the capsule at (x, y, z) with `height` is inside, or null. Mirrors collision.mjs verticalOverlap. */
export function insideSolid(colliders, pos, height = 1.8, pad = 0) {
  for (const c of colliders || []) {
    if (!c.solid) continue;
    if (Number.isFinite(pos.y)) {
      const h = colliderHeight(c);
      const bottom = c.center.y - h / 2, top = c.center.y + h / 2;
      if (!(pos.y < top - 0.05 && pos.y + height > bottom)) continue;
    }
    if (containsXZ(c, pos.x, pos.z, pad)) return c;
  }
  return null;
}

/** Check a list of sampled positions against colliders. Used by the probe and by tests with planted positions. */
export function probePositions(colliders, positions, { height = 1.8 } = {}) {
  const hits = [];
  for (const p of positions) {
    const c = insideSolid(colliders, p, height);
    if (c) hits.push({ x: round(p.x), y: round(p.y), z: round(p.z), collider: c.ref || c.id });
  }
  return { samples: positions.length, inside: hits.length, examples: hits.slice(0, 5) };
}

const round = (v) => Math.round(v * 100) / 100;

/**
 * @param {object} pkg
 * @param {{ deps?: object, maxSimSeconds?: number }} [o]
 * @returns {Promise<{ samples, inside, examples, steps, playtest }>}
 */
export async function collisionProbe(pkg, { deps, maxSimSeconds = 1800 } = {}) {
  const base = deps || (await realDeps());
  const height = pkg.gameplay?.movement?.player_height ?? 1.8;
  let colliders = [];
  const out = { samples: 0, inside: 0, examples: [] };
  const record = (x, y, z, cs) => {
    out.samples++;
    const c = insideSolid(cs, { x, y, z }, height);
    if (c) {
      out.inside++;
      if (out.examples.length < 5) out.examples.push({ x: round(x), y: round(y), z: round(z), collider: c.ref || c.id });
    }
  };
  const collision = {
    ...base.collision,
    buildColliders(world, scene) {
      colliders = base.collision.buildColliders(world, scene) || [];
      return colliders;
    },
    resolveCapsule(near, pos, radius, h) {
      const r = base.collision.resolveCapsule(near, pos, radius, h);
      const x = r?.hit ? r.x : pos.x, z = r?.hit ? r.z : pos.z;
      record(x, pos.y, z, near);
      return r;
    },
  };
  const probeDeps = { ...base, collision };
  // Spawn position.
  const sp = (pkg.world?.spawn_points || []).find((s) => s.kind === "player");
  const playtest = await headlessPlaytest(pkg, { deps: probeDeps, maxSimSeconds });
  if (sp) {
    const all = base.collision.buildColliders(pkg.world, pkg.scene) || colliders;
    record(sp.position.x, sp.position.y, sp.position.z, all);
  }
  return { ...out, steps: playtest.steps, playtest };
}
