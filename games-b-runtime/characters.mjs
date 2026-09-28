// Rigged characters from mesh recipes (contract §4.2 `rig`), browser-only.
//
// A character recipe is the same parts list as a prop plus
// `rig: { kind: "biped"|"quadruped"|"hover", joints }`. Each joint becomes a pivot
// Object3D; a part hangs from the joint it names (`part.joint`, or `bone`), or —
// when a recipe does not say — from the nearest joint, so a recipe from another
// generator still animates rather than sliding around rigid.
//
// Animation is procedural and driven only by NpcState.anim ("idle" | "walk" |
// "run" | "talk") plus ground speed. No clips, no skinning: limb pivots swing,
// the spine bobs, heads nod when talking, hover rigs float.
/* global THREE */

import { bakeRecipe } from "./geometry.mjs";

const vec = (p) => {
  if (!p) return new THREE.Vector3();
  if (Array.isArray(p)) return new THREE.Vector3(+p[0] || 0, +p[1] || 0, +p[2] || 0);
  const q = p.position || p.pivot || p.origin || p;
  if (Array.isArray(q)) return new THREE.Vector3(+q[0] || 0, +q[1] || 0, +q[2] || 0);
  return new THREE.Vector3(+q.x || 0, +q.y || 0, +q.z || 0);
};

/** Normalise any plausible joints encoding to [{ name, parent, pos }]. */
function readJoints(rig) {
  const j = rig?.joints;
  const out = [];
  if (Array.isArray(j)) {
    for (const e of j) if (e && (e.name || e.id)) out.push({ name: e.name || e.id, parent: e.parent || null, pos: vec(e), axis: e.axis, swing: e.swing });
  } else if (j && typeof j === "object") {
    for (const [name, e] of Object.entries(j)) {
      const o = e && typeof e === "object" && !Array.isArray(e) ? e : {};
      out.push({ name, parent: o.parent || null, pos: vec(e), axis: o.axis, swing: o.swing });
    }
  }
  return out;
}

function classify(name, pos) {
  const n = name.toLowerCase();
  const side = /(^|[_\-.])(l|left)($|[_\-.])|left|_l$/.test(n) ? -1 : /(^|[_\-.])(r|right)($|[_\-.])|right|_r$/.test(n) ? 1 : Math.sign(pos.x) || 0;
  const front = /front|fore|_f[lr]?$|^f[lr]_/.test(n) ? 1 : /back|hind|rear|_b[lr]?$|^b[lr]_|^h[lr]_/.test(n) ? -1 : 0;
  let role = "other";
  if (/head|neck|skull/.test(n)) role = "head";
  else if (/tail/.test(n)) role = "tail";
  else if (/wing/.test(n)) role = "wing";
  else if (/leg|hip|thigh|knee|foot|paw/.test(n)) role = "leg";
  else if (/arm|shoulder|hand|elbow/.test(n)) role = "arm";
  else if (/spine|torso|body|chest|root|pelvis|core/.test(n)) role = "spine";
  return { role, side, front };
}

/**
 * Build a character Group. Returns { root, animate(dt, anim, speed), height, glow }.
 * `lib` is the MaterialLibrary; `opts.tint` optionally recolours cloth-like parts.
 */
export function buildCharacter(recipe, lib, { warn } = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();      // bobbing/hover offset lives here, so root stays on the ground
  root.add(body);
  const joints = readJoints(recipe?.rig);
  const kind = recipe?.rig?.kind || "biped";
  const pivots = new Map();
  const meta = [];
  // Pivot hierarchy. Joints are given in recipe space; a child's local position
  // is its recipe position minus its parent's.
  const world = new Map(joints.map((j) => [j.name, j.pos]));
  const pending = joints.slice();
  let guard = 0;
  while (pending.length && guard++ < 64) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const j = pending[i];
      const parentReady = !j.parent || pivots.has(j.parent) || !world.has(j.parent);
      if (!parentReady) continue;
      const pv = new THREE.Group();
      pv.name = j.name;
      const parent = j.parent && pivots.has(j.parent) ? pivots.get(j.parent) : body;
      const base = j.parent && world.has(j.parent) ? world.get(j.parent) : new THREE.Vector3();
      pv.position.copy(j.pos).sub(base);
      parent.add(pv);
      pivots.set(j.name, pv);
      const gaitPhase = recipe?.rig?.gait?.phase?.[j.name];
      meta.push({ pivot: pv, ...classify(j.name, j.pos), rest: pv.rotation.clone(), restPos: pv.position.clone(),
        axis: ["x", "y", "z"].includes(j.axis) ? j.axis : null, swing: Number.isFinite(j.swing) ? j.swing : null,
        gait: Number.isFinite(gaitPhase) ? gaitPhase : null });
      pending.splice(i, 1);
    }
  }
  const nearest = (p) => {
    let best = null, bd = Infinity;
    for (const j of joints) { const d = j.pos.distanceToSquared(p); if (d < bd) { bd = d; best = j.name; } }
    return best;
  };
  const owner = (part) => {
    const named = part.joint || part.bone || part.attach || null;
    if (named && pivots.has(named)) return named;
    if (!joints.length) return null;
    return nearest(vec(part.position));
  };
  const groups = new Map();
  for (const part of recipe?.parts || []) {
    const o = owner(part);
    if (!groups.has(o)) groups.set(o, []);
    groups.get(o).push(part);
  }
  const glow = [];
  for (const [jname, parts] of groups) {
    const jpos = jname ? world.get(jname) : new THREE.Vector3();
    const pre = new THREE.Matrix4().makeTranslation(-jpos.x, -jpos.y, -jpos.z);
    const { buckets, glow: g } = bakeRecipe({ parts }, { pre, warn });
    const holder = jname ? pivots.get(jname) : body;
    for (const b of buckets) {
      const mesh = new THREE.Mesh(b.geometry, lib.material(b.material_ref, { emissive: b.emissive, glowColor: b.glowColor }));
      mesh.castShadow = b.castShadow;
      mesh.receiveShadow = false;
      holder.add(mesh);
    }
    for (const p of g) glow.push({ holder, local: p });
  }
  const bounds = new THREE.Box3().setFromObject(root);
  const height = Math.max(0.3, bounds.max.y - Math.min(0, bounds.min.y));

  let phase = 0, t = 0, talkT = 0;
  function animate(dt, anim = "idle", speed = 0) {
    t += dt;
    const moving = anim === "walk" || anim === "run";
    const freq = moving ? Math.max(1.4, Math.min(3.2, speed * 0.55 + 0.9)) : 0;
    phase += dt * freq * Math.PI * 2 * (moving ? 1 : 0);
    const amp = anim === "run" ? 0.75 : anim === "walk" ? 0.5 : 0;
    const k = 1 - Math.exp(-dt * 12);       // ease into / out of a gait
    if (anim === "talk") talkT += dt; else talkT = 0;
    for (const m of meta) {
      const tgt = { x: m.rest.x, y: m.rest.y, z: m.rest.z };
      // A recipe's gait phase and swing (rig.gait.phase, joint.swing) win over the name heuristics.
      const s = m.gait !== null ? Math.sin(phase + m.gait * Math.PI * 2)
        : Math.sin(phase + (m.side < 0 ? 0 : Math.PI) + (kind === "quadruped" && m.front < 0 ? Math.PI : 0));
      const limbAmp = m.swing !== null ? m.swing * (anim === "run" ? 1.35 : anim === "walk" ? 0.9 : 0) : amp;
      const ax = m.axis || "x";
      switch (m.role) {
        case "leg": tgt[ax] += s * limbAmp; break;
        case "arm": tgt[ax] += (m.gait !== null ? s : -s) * limbAmp * 0.8 + (moving ? 0 : Math.sin(t * 1.3 + m.side) * 0.04); tgt.z += m.side * (anim === "talk" ? 0.15 + Math.sin(talkT * 3) * 0.12 : 0.05); break;
        case "head":
          if (anim === "talk") { tgt.x += Math.sin(talkT * 5.2) * 0.08; tgt.y += Math.sin(talkT * 1.7) * 0.18; }
          else tgt.y += Math.sin(t * 0.6) * 0.12;
          break;
        case "tail": tgt.y += Math.sin(t * (moving ? 9 : 2.5)) * (moving ? 0.5 : 0.3); break;
        case "wing": tgt.z += m.side * Math.sin(t * 7) * 0.6; break;
        case "spine": tgt.x += moving ? 0.06 * amp : 0; tgt.z += moving ? Math.sin(phase) * 0.03 : 0; break;
        default: break;
      }
      m.pivot.rotation.x += (tgt.x - m.pivot.rotation.x) * k;
      m.pivot.rotation.y += (tgt.y - m.pivot.rotation.y) * k;
      m.pivot.rotation.z += (tgt.z - m.pivot.rotation.z) * k;
    }
    if (kind === "hover") {
      // Recipes that model the hover gap themselves say so in rig.hover; only bob then.
      const hv = recipe?.rig?.hover;
      const bob = Number.isFinite(hv?.bob_m) ? Math.max(0.05, hv.bob_m) : 0.18;
      const per = Number.isFinite(hv?.period_s) && hv.period_s > 0 ? hv.period_s : 3;
      body.position.y = (hv ? 0 : 0.35) + Math.sin((t * Math.PI * 2) / per) * bob;
      body.rotation.z = Math.sin(t * 1.3) * 0.08;
    } else {
      const bob = moving ? Math.abs(Math.sin(phase)) * (anim === "run" ? 0.09 : 0.05) : Math.sin(t * 2) * 0.012;
      body.position.y += (bob - body.position.y) * k;
    }
  }
  return { root, body, animate, height, glow, kind };
}

/**
 * The player's avatar when the package has no player character: a hooded
 * lantern-bearer, built from the same parts vocabulary so it shares materials
 * (and the texture look) with the rest of the world.
 */
export function defaultPlayerRecipe() {
  const V = (x, y, z) => ({ x, y, z });
  const p = (shape, material_ref, position, o = {}) => ({ shape, material_ref, position, rotation: V(0, 0, 0), ...o });
  return {
    builder: "parts", bounds: { w: 0.7, h: 1.8, d: 0.5 },
    parts: [
      p("lathe", "mat:cloth", V(0, 0.55, 0), { profile: [[0.34, 0], [0.3, 0.3], [0.22, 0.75], [0.2, 0.95], [0.01, 1.0]], segments: 10, joint: "spine" }),
      p("sphere", "mat:plaster", V(0, 1.64, 0.02), { radius: 0.14, joint: "head" }),
      p("cone", "mat:cloth", V(0, 1.72, -0.02), { radius: 0.2, height: 0.42, segments: 10, joint: "head" }),
      p("box", "mat:wood", V(0, 1.25, -0.22), { size: V(0.3, 0.4, 0.14), joint: "spine" }),
      p("capsule", "mat:cloth", V(-0.27, 1.2, 0), { radius: 0.065, height: 0.4, joint: "arm_l" }),
      p("capsule", "mat:cloth", V(0.27, 1.2, 0), { radius: 0.065, height: 0.4, joint: "arm_r" }),
      p("cylinder", "mat:brass", V(0.3, 0.86, 0.08), { radius: 0.07, height: 0.16, segments: 8, joint: "arm_r" }),
      p("sphere", "mat:glow", V(0.3, 0.86, 0.08), { radius: 0.06, emissive: true, cast_shadow: false, joint: "arm_r" }),
      p("capsule", "mat:dirt", V(-0.1, 0.4, 0), { radius: 0.085, height: 0.52, joint: "leg_l" }),
      p("capsule", "mat:dirt", V(0.1, 0.4, 0), { radius: 0.085, height: 0.52, joint: "leg_r" }),
    ],
    rig: { kind: "biped", joints: {
      spine: { parent: null, pivot: V(0, 0.9, 0) }, head: { parent: "spine", pivot: V(0, 1.5, 0) },
      arm_l: { parent: "spine", pivot: V(-0.27, 1.42, 0) }, arm_r: { parent: "spine", pivot: V(0.27, 1.42, 0) },
      leg_l: { parent: null, pivot: V(-0.1, 0.78, 0) }, leg_r: { parent: null, pivot: V(0.1, 0.78, 0) },
    } },
  };
}
