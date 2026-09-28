// Games-B → WorldManifestV3 bridge. Node-side.
//
// The existing /v3 stack (save/return, expand, playtest critic, companion) only
// speaks WorldManifestV3. Rather than teach every one of those lanes a second
// format, a Games-B package is projected into a manifest that references it:
// regions become zones, placements become structures, characters become NPCs,
// objectives become quest steps. The package itself stays the source of truth
// for the playable game; the manifest carries `gamesb.package_sha256` so a
// v3 consumer can always find (and verify) the exact build it describes.
//
// The projection is lossy on purpose (no mesh recipes, no dialogue graphs in
// v3 fields), but everything the v3 validators and critic reason about —
// ids, positions, zones, quest targets — is carried faithfully.

import { MANIFEST_VERSION, MIN_RUNTIME_VERSION } from "../../v3/manifest/schema.mjs";

const ASSET_KIND = { structure: "building", prop: "prop", foliage: "terrain_feature", character: "character", npc: "character", creature: "creature" };
const STEP_KIND = { reach: "reach", collect: "collect", interact: "activate", activate: "activate", talk: "talk", deliver: "deliver", defeat: "defeat", survive: "survive", escort: "escort" };
const BEHAVIOR_KIND = { door: "door", switch: "switch", lever: "switch", pickup: "pickup", container: "container", terminal: "terminal", portal: "teleporter", talk: "quest_trigger", lantern: "quest_trigger", altar: "quest_trigger", sign: "quest_trigger" };
const V3_STATUS = { AVAILABLE: "AVAILABLE", FALLBACK: "FALLBACK", UNAVAILABLE: "UNAVAILABLE", CACHED: "AVAILABLE" };

/** @returns {object} a WorldManifestV3 that passes validateManifest */
export function toManifestV3(pkg) {
  const w = pkg.world, gp = pkg.gameplay, concept = pkg.concept || {};
  const records = pkg.assets?.records || [];
  const byKey = new Map();
  for (const r of records) { if (r.ref) byKey.set(r.ref, r); byKey.set(r.asset_id, r); }

  // ------------------------------------------------------------ assets
  // Keyed by the string the package uses (logical ref or asset_id), so every
  // structure/npc asset_ref resolves verbatim. Only meshes are v3 assets.
  const scatterRefs = new Set((w.scatter || []).map((s) => s.asset_ref));
  const assets = [];
  const assetIds = new Set();
  const addAsset = (ref) => {
    if (!ref || assetIds.has(ref)) return assetIds.has(ref);
    const r = byKey.get(ref);
    if (!r) return false;
    assetIds.add(ref);
    assets.push({
      id: ref,
      kind: ASSET_KIND[r.kind] || "prop",
      format: scatterRefs.has(ref) ? "instanced" : "external",
      name: r.name,
      composition_ref: { package: pkg.game_id, package_sha256: pkg.integrity?.sha256 ?? null, asset_id: r.asset_id, ref: r.ref ?? null, format: r.format },
      bounds: r.dimensions ?? null,
      license: r.provenance?.license ? { ...r.provenance.license } : { spdx: "NOASSERTION", commercial_use: "unknown" },
      sha256: r.sha256,
    });
    return true;
  };

  // ------------------------------------------------------------- zones
  const zones = (w.regions || []).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, bounds: [...r.bounds], center: r.center ? { ...r.center } : null, location_ref: r.location_ref ?? null,
  }));
  const zoneIds = new Set(zones.map((z) => z.id));

  // -------------------------------------------------------- structures
  const structures = [];
  for (const p of w.placements || []) {
    addAsset(p.asset_ref);
    const c = p.collider || {};
    const fw = c.size?.x ?? (c.radius ? c.radius * 2 : 2), fd = c.size?.z ?? (c.radius ? c.radius * 2 : 2);
    structures.push({
      id: p.id,
      ...(assetIds.has(p.asset_ref) ? { asset_ref: p.asset_ref } : {}),
      zone: zoneIds.has(p.region) ? p.region : null,
      role: p.role,
      transform: { position: { ...p.position }, rotation: { x: 0, y: p.rotation_y || 0, z: 0 }, scale: p.scale ?? 1 },
      footprint: { w: fw * (p.scale ?? 1), d: fd * (p.scale ?? 1) },
      collision: { shape: c.shape || "none", solid: !!c.solid },
      tags: [...(p.tags || [])],
    });
  }
  const structureIds = new Set(structures.map((s) => s.id));

  // -------------------------------------------------------------- npcs
  const spawnOf = (id) => (w.spawn_points || []).find((s) => s.id === id);
  const behaviors = [];
  const npcs = (pkg.characters?.characters || []).map((ch) => {
    const sp = spawnOf(ch.spawn_ref);
    addAsset(ch.asset_ref);
    const bid = `bh_npc_${ch.id}`;
    behaviors.push({ id: bid, kind: ch.behavior?.hostile ? "enemy_ai" : "npc_ai", spec: { ...(ch.behavior || {}), source: "gamesb.characters" } });
    return {
      id: ch.id, name: ch.name, role: ch.role,
      spawn: sp ? { ...sp.position } : { x: w.size.w / 2, y: 0, z: w.size.h / 2 },
      zone: sp && zoneIds.has(sp.region) ? sp.region : null,
      ...(assetIds.has(ch.asset_ref) ? { asset_ref: ch.asset_ref } : {}),
      behavior_ref: bid,
      dialogue_ref: ch.dialogue_ref ?? null,
      companion: !!ch.companion,
    };
  });
  const npcIds = new Set(npcs.map((n) => n.id));

  // ------------------------------------------------------------- items
  const items = (gp.inventory?.items || []).map((it) => ({ id: it.id, name: it.name, kind: it.kind, stackable: !!it.stackable, icon_ref: it.icon_ref ?? null }));
  const itemIds = new Set(items.map((i) => i.id));

  // ------------------------------------------------------------ quests
  // A v3 quest step target must be an npc, item, zone or structure; an
  // interactable target is projected onto the placement it sits on.
  const ixById = new Map((w.interactables || []).map((i) => [i.id, i]));
  const v3Target = (ref) => {
    if (zoneIds.has(ref) || npcIds.has(ref) || itemIds.has(ref) || structureIds.has(ref)) return ref;
    const ix = ixById.get(ref);
    if (ix?.placement_ref && structureIds.has(ix.placement_ref)) return ix.placement_ref;
    if (ix?.character_ref && npcIds.has(ix.character_ref)) return ix.character_ref;
    return undefined;
  };
  const step = (o) => ({
    id: o.id, kind: STEP_KIND[o.kind] || "solve", title: o.title, description: o.description,
    ...(v3Target(o.target_ref) !== undefined ? { target: v3Target(o.target_ref) } : {}),
    gamesb_target_ref: o.target_ref, count: o.count ?? 1, requires: [...(o.requires || [])],
  });
  const required = (gp.objectives || []).filter((o) => !o.optional);
  const giver = (pkg.characters?.characters || []).find((c) => c.role === "quest_giver" && npcIds.has(c.id));
  const quests = [];
  if (required.length) quests.push({ id: "quest_main", title: concept.title || pkg.title, giver_npc: giver?.id, steps: required.map(step), prerequisites: [], reward: { xp: required.reduce((a, o) => a + (o.reward?.xp || 0), 0) } });
  for (const o of (gp.objectives || []).filter((x) => x.optional)) {
    quests.push({ id: `quest_${o.id}`, title: o.title, optional: true, steps: [step(o)], prerequisites: [], reward: { ...o.reward } });
  }

  // ------------------------------------------------------ interactions
  const interactions = [];
  for (const ix of w.interactables || []) {
    const bid = `bh_ix_${ix.id}`;
    behaviors.push({ id: bid, kind: BEHAVIOR_KIND[ix.kind] || "quest_trigger", spec: { interactable: { ...ix }, source: "gamesb.world" } });
    const target = ix.character_ref && npcIds.has(ix.character_ref) ? ix.character_ref : structureIds.has(ix.placement_ref) ? ix.placement_ref : undefined;
    interactions.push({ id: ix.id, trigger: "interact", ...(target ? { target_ref: target } : {}), behavior_ref: bid, prompt: ix.prompt, radius: ix.radius, kind: ix.kind, item_ref: ix.item_ref ?? null, locked_by: ix.locked_by ?? null });
  }
  for (const h of gp.hazards || []) {
    const bid = `bh_hz_${h.id}`;
    behaviors.push({ id: bid, kind: "hazard", spec: { ...h } });
    if (h.region && zoneIds.has(h.region)) interactions.push({ id: `hz_${h.id}`, trigger: "enter_zone", target_ref: h.region, behavior_ref: bid });
  }

  // ------------------------------------------------------------ spawn
  const players = (w.spawn_points || []).filter((s) => s.kind === "player" || s.kind === "respawn" || s.kind === "checkpoint")
    .sort((a, b) => (a.kind === "player" ? -1 : 0) - (b.kind === "player" ? -1 : 0));
  const player_spawns = players.map((s) => ({ id: s.id, kind: s.kind, position: { ...s.position }, rotation_y: s.rotation_y || 0, zone: zoneIds.has(s.region) ? s.region : null }));

  // ----------------------------------------------------------- terrain
  const t = w.terrain;
  const data = [];
  for (let j = 0; j < t.rows; j++) data.push(t.heights.slice(j * t.cols, (j + 1) * t.cols));

  const now = pkg.created_at;
  const env = w.environment || {};
  return {
    manifest_version: MANIFEST_VERSION,
    world_id: pkg.game_id,
    world_version: pkg.version,
    meta: {
      title: pkg.title, prompt: concept.source_prompt ?? null, genre: concept.genre ?? null, style: concept.biome ?? null, seed: concept.seed ?? w.seed ?? 0,
      creator_id: null, created_at: now, updated_at: now, description: concept.logline ?? null, tags: ["games-b", concept.genre, concept.biome].filter(Boolean), maturity: "13+",
    },
    environment: {
      time_of_day: env.time_of_day, weather: env.weather, gravity: gp.movement?.gravity ?? -9.81,
      sky: env.sky ?? null, fog: env.fog ?? null, ambient_light: env.ambient ?? null, directional_light: env.sun ?? null, wind: null, water: env.water ?? null,
    },
    terrain: {
      kind: "heightmap", size: { w: w.size.w, h: w.size.h }, data, resolution: { cell_w: t.cell, cell_h: t.cell },
      materials: (t.material_layers || []).map((l) => ({ ...l })), min_y: t.min_y, max_y: t.max_y,
      scatter: (w.scatter || []).map((s) => ({ id: s.id, asset_ref: s.asset_ref, zone: s.region, count: s.count })),
    },
    zones, assets, structures, npcs, items, quests, interactions, behaviors,
    physics: { engine_hint: "gamesb-sim-core", gravity: gp.movement?.gravity ?? -9.81, materials: [] },
    navigation: {
      walkable_zones: zones.map((z) => z.id),
      links: (w.paths || []).filter((p) => zoneIds.has(p.from_region) && zoneIds.has(p.to_region)).map((p) => ({ id: p.id, from: p.from_region, to: p.to_region, width: p.width })),
      navmesh_ref: "gamesb:world.navigation",
      grid: { cell: w.navigation?.cell, cols: w.navigation?.cols, rows: w.navigation?.rows, max_slope_deg: w.navigation?.max_slope_deg },
    },
    animation: { clips: [], rigs: [] },
    audio: { ambient: [], music: [], sfx: [], narration: [] },
    spawn: { player_spawns, respawn_policy: "checkpoint", safe_radius: 6 },
    multiplayer: { enabled: false, max_players: 1, authoritative: "server", replicated_refs: [], shared_zones: [] },
    companion: {
      enabled: !!pkg.hooks?.companion?.character_ref, persona_ref: pkg.hooks?.companion?.character_ref ?? null,
      knowledge_scope: "world", memory_refs: [], knowledge: [...(pkg.hooks?.companion?.knowledge || [])],
    },
    media: { thumbnail_ref: null, trailer_ref: null, intro_ref: null, portraits: {}, captions: {} },
    provenance: {
      generated_by: (pkg.provenance?.stages || []).map((s) => ({
        lane: s.lane || s.stage, stage: s.stage, provider: s.provider || "local", model: s.model ?? null,
        status: V3_STATUS[s.status] || "FALLBACK", cached: s.status === "CACHED", latency_ms: s.latency_ms ?? 0, cost_usd: s.cost_usd ?? 0, at: s.at ?? null,
      })),
      source_prompt_hash: pkg.provenance?.prompt_hash ?? null,
      manifest_hash: null,
    },
    expansion: { history: [...(pkg.hooks?.expand?.history || [])], compatibility: { min_runtime: MIN_RUNTIME_VERSION, migrated_from: null } },
    runtime_config: { render_distance: Math.max(w.size.w, w.size.h), streaming: false, quality_tiers: ["low", "medium", "high"], mobile: { touch_controls: true, max_instances: 400 }, runtime: "games-b" },
    gamesb: {
      package_version: pkg.package_version, game_id: pkg.game_id, version: pkg.version, package_sha256: pkg.integrity?.sha256 ?? null,
      play: "games-b-runtime/play.html", pipeline_version: pkg.provenance?.pipeline_version ?? null,
    },
  };
}
