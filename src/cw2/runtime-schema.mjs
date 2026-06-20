// src/runtime-schema.mjs
// Manager ruling: emit the FULL C1 runtime schema CW3's parseWorld/buildScene consumes, so worlds
// render with ZERO runtime-side patches. This AUGMENTS the C1 world additively — the data-contract
// C1 fields (validator/CW8 fixtures) stay intact; we add the render fields CW3 needs.
// Zero-dep.

// Genre-appropriate render look (environment + material tints).
const RENDER = {
  horror: {
    sky: "#0a0e14", fog: { color: "#0a0e14", near: 5, far: 40 },
    ambient: { color: "#334155", intensity: 0.3 }, dir: { color: "#7f1d1d", intensity: 0.6 },
    terrainMat: { color: "#1f2933", roughness: 0.95 }, objMat: "#3b3b3b", npcMat: "#6b7280",
  },
  cyberpunk: {
    sky: "#0d1b2a", fog: { color: "#0d2b3b", near: 8, far: 60 },
    ambient: { color: "#1e3a5f", intensity: 0.5 }, dir: { color: "#22d3ee", intensity: 0.8 },
    terrainMat: { color: "#16213a", roughness: 0.4 }, objMat: "#22d3ee", npcMat: "#a78bfa",
  },
  fantasy: {
    sky: "#1a1033", fog: { color: "#241046", near: 10, far: 70 },
    ambient: { color: "#4c1d95", intensity: 0.5 }, dir: { color: "#a78bfa", intensity: 0.9 },
    terrainMat: { color: "#3b2f1a", roughness: 0.8 }, objMat: "#a78bfa", npcMat: "#16a34a",
  },
  pirate: {
    sky: "#1e3a5f", fog: { color: "#0d2436", near: 12, far: 80 },
    ambient: { color: "#1e3a5f", intensity: 0.6 }, dir: { color: "#f59e0b", intensity: 1.0 },
    terrainMat: { color: "#2d3a1a", roughness: 0.85 }, objMat: "#b45309", npcMat: "#78350f",
  },
  adventure: {
    sky: "#1e3a2f", fog: { color: "#13311b", near: 12, far: 80 },
    ambient: { color: "#1e3a2f", intensity: 0.6 }, dir: { color: "#22c55e", intensity: 0.9 },
    terrainMat: { color: "#1f3a1f", roughness: 0.8 }, objMat: "#22c55e", npcMat: "#15803d",
  },
  scifi: {
    sky: "#05060f", fog: { color: "#0a0a1a", near: 10, far: 90 },
    ambient: { color: "#1e293b", intensity: 0.5 }, dir: { color: "#38bdf8", intensity: 0.9 },
    terrainMat: { color: "#1e293b", roughness: 0.3 }, objMat: "#38bdf8", npcMat: "#e2e8f0",
  },
  western: {
    sky: "#d8a861", fog: { color: "#c8a070", near: 20, far: 120 },
    ambient: { color: "#a87b4a", intensity: 0.8 }, dir: { color: "#fcd34d", intensity: 1.1 },
    terrainMat: { color: "#8a6a3a", roughness: 0.95 }, objMat: "#7c4a1e", npcMat: "#5a3a1a",
  },
  underwater: {
    sky: "#0a2a40", fog: { color: "#0d3a55", near: 4, far: 35 },
    ambient: { color: "#0e4a6b", intensity: 0.7 }, dir: { color: "#22d3ee", intensity: 0.5 },
    terrainMat: { color: "#0d3a4a", roughness: 0.6 }, objMat: "#2dd4bf", npcMat: "#0e7490",
  },
  jungle: {
    sky: "#1a3a1a", fog: { color: "#16301a", near: 6, far: 45 },
    ambient: { color: "#1a4a2a", intensity: 0.6 }, dir: { color: "#84cc16", intensity: 0.8 },
    terrainMat: { color: "#234d1f", roughness: 0.9 }, objMat: "#65a30d", npcMat: "#3f6212",
  },
  apocalypse: {
    sky: "#3a3528", fog: { color: "#2e2a20", near: 10, far: 70 },
    ambient: { color: "#44403c", intensity: 0.5 }, dir: { color: "#a8a29e", intensity: 0.7 },
    terrainMat: { color: "#3a352a", roughness: 0.95 }, objMat: "#78716c", npcMat: "#57534e",
  },
  medieval: {
    sky: "#5a7a9a", fog: { color: "#4a6a8a", near: 15, far: 100 },
    ambient: { color: "#4a5a6a", intensity: 0.7 }, dir: { color: "#fde68a", intensity: 1.0 },
    terrainMat: { color: "#3a4a2a", roughness: 0.85 }, objMat: "#92400e", npcMat: "#78350f",
  },
};

const vec3 = (x, y, z) => ({ x, y, z });

// Build the environment block CW3 expects.
function environmentFor(r) {
  return {
    sky_color: r.sky,
    fog: { color: r.fog.color, near: r.fog.near, far: r.fog.far },
    ambient_light: { color: r.ambient.color, intensity: r.ambient.intensity },
    directional_light: { color: r.dir.color, intensity: r.dir.intensity, position: vec3(50, 100, 50) },
  };
}

// Augment a C1 world with the runtime render schema (additive — keeps all C1 fields).
export function toRuntimeWorld(world) {
  const r = RENDER[world.meta.genre] || RENDER.adventure;
  const w = JSON.parse(JSON.stringify(world)); // copy; don't mutate the C1 source

  // environment (was missing entirely)
  w.environment = environmentFor(r);

  // terrain: add material + size as {x,z} (keep {w,h} for C1 consumers)
  const sw = w.terrain.size?.w ?? 16, sh = w.terrain.size?.h ?? 16;
  w.terrain.material = { color: r.terrainMat.color, roughness: r.terrainMat.roughness };
  w.terrain.size = { w: sw, h: sh, x: sw, z: sh }; // both shapes; runtime reads x/z, C1 reads w/h

  // objects: nested position + vec3 scale + material + collider/interaction (keep flat x/y/z for C1)
  w.objects = (w.objects || []).map((o) => {
    const t = o.transform || {};
    const px = t.x ?? 0, py = t.y ?? 0, pz = t.z ?? 0;
    return {
      ...o,
      transform: {
        x: px, y: py, z: pz, rot: t.rot ?? 0, scale: t.scale ?? 1, // C1 flat fields kept
        position: vec3(px, py, pz),                                 // runtime nested
        rotation: vec3(0, (t.rot ?? 0) * Math.PI / 180, 0),
        scale_v: vec3(t.scale ?? 1, t.scale ?? 1, t.scale ?? 1),    // runtime vec3 scale
      },
      material: { color: r.objMat, emissive: world.meta.genre === "cyberpunk" ? r.objMat : undefined },
      collider: { type: "box", size: vec3(1, 1, 1) },
      interaction: o.interactable ? { type: "use", prompt: `Use ${o.kind}` } : null,
    };
  });

  // npcs: transform.position (keep spawn for C1) + material
  w.npcs = (w.npcs || []).map((n) => {
    const s = n.spawn || { x: 0, y: 0, z: 0 };
    return {
      ...n,
      transform: { position: vec3(s.x, s.y ?? 0, s.z), rotation: vec3(0, 0, 0), scale_v: vec3(1, 1, 1) },
      material: { color: r.npcMat },
    };
  });

  // top-level player spawn (runtime reads world.spawn; keep spawns[] for C1)
  const ps = (world.spawns || []).find((s) => s.role === "player") || world.spawns?.[0] || { x: 2, y: 0, z: 2 };
  w.spawn = vec3(ps.x, ps.y ?? 0, ps.z);

  return w;
}

// The DB row shape for dcsgames_base_worlds — includes world_name + genre so pickers show real names.
export function toBaseWorldRow(world) {
  return {
    world_id: world.world_id,
    world_name: world.meta.title,   // picker shows "Pirate Island", not the hash
    title: world.meta.title,
    genre: world.meta.genre,
    schema_version: world.schema_version,
    creator_id: world.meta.creator_id,
    state: world.state || "draft",
    manifest: toRuntimeWorld(world),  // store the runtime-ready world so the runtime needs no patch
    created_at: world.meta.created_at,
  };
}
