// Test-only: a minimal WorldSpec (§2) and CharactersSpec (§6) for a concept,
// following the §4.5 id rules. It stands in for the world/characters stages,
// which other agents own, so gameplay tests do not import their modules.
// Terrain is a tiny flat grid; only ids and relationships matter here.

export function buildFixtureWorld(concept, { pickupsPerRegion = 1, lockFinal = true, cell = 40 } = {}) {
  const edge = { small: 160, medium: 240, large: 320 }[concept.scale] || 240;
  const locs = concept.key_locations;
  const regions = locs.map((l, i) => {
    const x0 = (i % 3) * (edge / 3), z0 = Math.floor(i / 3) * (edge / 2);
    const b = [x0, z0, x0 + edge / 3, z0 + edge / 2];
    return { id: `region_${l.id}`, name: l.name, kind: i === 0 ? "district" : "landmark", bounds: b, center: { x: (b[0] + b[2]) / 2, y: 0, z: (b[1] + b[3]) / 2 }, location_ref: l.id };
  });
  const center = (rid) => regions.find((r) => r.id === rid).center;
  const IXKIND = { shrine: "altar", tower: "lantern", summit: "lantern", ruin: "container", dock: "sign", camp: "sign", cave: "container", grove: "altar", village: "door", hub: "sign", landmark: "lever" };

  const placements = [], interactables = [], spawn_points = [];
  spawn_points.push({ id: "spawn_player", kind: "player", position: { ...center(regions[0].id) }, rotation_y: 0, region: regions[0].id });
  locs.forEach((l, i) => {
    const r = regions[i];
    placements.push({ id: `pl_${l.id}`, asset_ref: "lib:shrine", region: r.id, position: { ...r.center }, rotation_y: 0, scale: 1, role: "interactable", collider: { shape: "box", size: { x: 2, y: 2, z: 2 }, solid: true }, tags: [] });
    interactables.push({ id: `ix_${l.id}`, placement_ref: `pl_${l.id}`, kind: IXKIND[l.kind], radius: 2, prompt: `Use ${l.name}` });
    if (i > 0) spawn_points.push({ id: `spawn_cp_${r.id}`, kind: "checkpoint", position: { x: r.center.x + 3, y: 0, z: r.center.z }, rotation_y: 0, region: r.id });
  });
  let n = 0;
  const libs = ["lantern_core", "gem", "relic", "shard", "scroll"];
  locs.slice(1).forEach((l, i) => {
    for (let k = 0; k < pickupsPerRegion; k++) {
      n++;
      const r = regions[i + 1];
      placements.push({ id: `pl_pickup_${n}`, asset_ref: `lib:${libs[n % libs.length]}`, region: r.id, position: { x: r.center.x - 4 - k, y: 0, z: r.center.z }, rotation_y: 0, scale: 1, role: "pickup", collider: { shape: "none", solid: false }, tags: [] });
      interactables.push({ id: `pickup_${n}`, placement_ref: `pl_pickup_${n}`, kind: "pickup", radius: 1.5, prompt: "Pick up", item_ref: `item_${n}` });
    }
  });
  // Guarantee §4.5's "at least three pickups" even for tiny concepts.
  while (n < 3) {
    n++;
    const r = regions[1 + (n % (regions.length - 1))];
    placements.push({ id: `pl_pickup_${n}`, asset_ref: "lib:gem", region: r.id, position: { ...r.center }, rotation_y: 0, scale: 1, role: "pickup", collider: { shape: "none", solid: false }, tags: [] });
    interactables.push({ id: `pickup_${n}`, placement_ref: `pl_pickup_${n}`, kind: "pickup", radius: 1.5, prompt: "Pick up", item_ref: `item_${n}` });
  }
  // The finale's focal interactable is locked by the first item.
  if (lockFinal) interactables.find((x) => x.id === `ix_${locs[locs.length - 1].id}`).locked_by = "item_1";

  const hostileRoles = new Set(["guard", "enemy", "creature"]);
  concept.characters.forEach((c) => {
    const r = c.role === "quest_giver" || c.role === "companion" || c.role === "merchant" || c.role === "ambient" ? regions[0] : regions[regions.length - 2] || regions[0];
    spawn_points.push({ id: `spawn_npc_${c.id}`, kind: "npc", position: { x: r.center.x + 2, y: 0, z: r.center.z + 2 }, rotation_y: 0, region: r.id });
    if (!hostileRoles.has(c.role)) interactables.push({ id: `ix_talk_${c.id}`, placement_ref: null, kind: "talk", radius: 2.5, prompt: `Talk to ${c.name}`, character_ref: c.id });
  });

  const cols = Math.round(edge / cell) + 1;
  return {
    world_spec_version: "1.0.0", id: `w_${concept.seed}`, title: concept.title, seed: concept.seed,
    size: { w: edge, h: edge }, biome: concept.biome,
    environment: {
      time_of_day: concept.time_of_day, weather: concept.weather,
      sky: { top: concept.palette.sky, horizon: concept.palette.sky, bottom: concept.palette.ground },
      fog: { color: concept.palette.sky, near: 40, far: 300 },
      sun: { azimuth_deg: 120, elevation_deg: 40, color: "#ffffff", intensity: 1, shadows: true },
      ambient: { color: "#ffffff", ground_color: concept.palette.ground, intensity: 0.5 },
      water: { enabled: concept.biome === "island", level: -1, color: concept.palette.water, opacity: 0.8 },
    },
    terrain: { kind: "heightfield", shape: "open", cols, rows: cols, cell, heights: new Array(cols * cols).fill(0), min_y: 0, max_y: 0, material_layers: [{ material_ref: "mat:grass", min_h: -10, max_h: 10, max_slope_deg: 90 }] },
    regions,
    paths: [],
    placements,
    scatter: [],
    spawn_points,
    camera: { mode: "third_person", distance: 6, height: 2.5, fov: 60, min_pitch: -0.4, max_pitch: 1.2, collide: true },
    interactables,
    navigation: { cell, cols, rows: cols, max_slope_deg: 40, step_height: 0.45, walkable: "1".repeat(cols * cols) },
  };
}

export function buildFixtureCharacters(concept) {
  const hostileRoles = new Set(["guard", "enemy", "creature"]);
  return {
    character_spec_version: "1.0.0",
    characters: concept.characters.map((c) => {
      const hostile = hostileRoles.has(c.role);
      return {
        id: c.id, name: c.name, role: c.role, kind: c.role === "creature" ? "creature" : "humanoid",
        body: { height: 1.7, build: "average", palette: { skin: "#c68642", primary: concept.palette.primary, secondary: concept.palette.secondary, accent: concept.palette.accent }, accessories: [] },
        asset_ref: `char:${c.id}`, spawn_ref: `spawn_npc_${c.id}`,
        behavior: { initial: hostile ? "patrol" : c.role === "companion" ? "idle" : "idle", patrol: [], wander_radius: 4, speed: 2, sight_radius: 10, hostile, leash_radius: 20 },
        dialogue_ref: hostile ? null : `dlg_${c.id}`, interaction_radius: 2.5, companion: c.role === "companion", invulnerable: !hostile,
      };
    }),
    dialogues: [],
  };
}
