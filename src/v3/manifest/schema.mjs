// B0 — WorldManifestV3. PARENT-OWNED CHOKEPOINT.
//
// The canonical, versioned, provider-neutral description of a DCS Games world.
// Every lane reads and writes this and nothing else, which is what lets the
// provider router, the runtime, the expansion engine and the media adapters
// change independently.
//
// HARD RULE: no provider-specific field appears anywhere in this schema. Which
// model or vendor produced a part of the world is a recorded FACT in
// `provenance.generated_by`, never a structural dependency. If KINIX, Cerebras,
// DeepSeek or any 3D provider is unavailable, the manifest shape does not change
// — the optional refs are simply absent.
//
// Validation is hand-written rather than ajv-based: the deployed service is
// intentionally zero-dependency, and the validator needs to return actionable,
// human-readable issues that the B4 critic and repair pass can act on.

export const MANIFEST_VERSION = "3.0.0";
export const MIN_RUNTIME_VERSION = "3.0.0";

export const TERRAIN_KINDS = ["heightmap", "tilegrid", "mesh", "flat"];
export const ZONE_KINDS = ["district", "interior", "landmark", "wilderness", "transit", "arena", "instance"];
export const ASSET_FORMATS = ["glb", "gltf", "primitive", "instanced", "external"];
export const ASSET_KINDS = ["building", "prop", "character", "creature", "vehicle", "weapon", "furniture", "terrain_feature", "effect", "audio"];
export const BEHAVIOR_KINDS = ["door", "elevator", "vehicle", "enemy_ai", "npc_ai", "combat", "quest_trigger", "switch", "container", "terminal", "platform", "hazard", "pickup", "teleporter"];
export const QUEST_STEP_KINDS = ["reach", "talk", "collect", "deliver", "defeat", "activate", "survive", "escort", "solve"];
export const TRIGGERS = ["proximity", "interact", "enter_zone", "exit_zone", "timer", "quest_state", "damage", "collision"];
export const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "sandstorm", "ash"];
export const MATURITY = ["13+", "16+", "18+"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isArr = Array.isArray;
const isStr = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => typeof v === "number" && isFinite(v);

class Issues {
  constructor() { this.errors = []; this.warnings = []; }
  err(path, message, hint) { this.errors.push({ path, message, ...(hint ? { hint } : {}) }); }
  warn(path, message, hint) { this.warnings.push({ path, message, ...(hint ? { hint } : {}) }); }
  get ok() { return this.errors.length === 0; }
  toJSON() { return { ok: this.ok, errors: this.errors, warnings: this.warnings }; }
}

function requireFields(o, path, fields, iss) {
  for (const [name, pred, why] of fields) {
    if (!pred(o?.[name])) iss.err(`${path}.${name}`, why || `${name} is required and must be valid`);
  }
}

function requireEnum(v, allowed, path, iss, { optional = false } = {}) {
  if (v === undefined || v === null) {
    if (!optional) iss.err(path, `is required (one of: ${allowed.join(", ")})`);
    return;
  }
  if (!allowed.includes(v)) iss.err(path, `'${v}' is not permitted`, `use one of: ${allowed.join(", ")}`);
}

function isVec3(v) {
  return isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);
}

/**
 * Validate a WorldManifestV3.
 *
 * Structural validity only — that the manifest is well-formed and internally
 * consistent (every reference resolves). Whether the world is actually PLAYABLE
 * is a separate question answered by the B4 playtest/critic pass, which can and
 * must be able to fail a structurally valid world.
 *
 * @returns {{ok:boolean, errors:Array, warnings:Array}}
 */
export function validateManifest(m) {
  const iss = new Issues();
  if (!isObj(m)) { iss.err("$", "manifest must be an object"); return iss.toJSON(); }

  // ------------------------------------------------------------- identity
  if (!isStr(m.manifest_version)) iss.err("manifest_version", "is required, e.g. '3.0.0'");
  else if (!/^3\.\d+\.\d+$/.test(m.manifest_version)) iss.err("manifest_version", `'${m.manifest_version}' is not a v3 manifest`, "run migrateToV3() on a v1 world");
  if (!isStr(m.world_id)) iss.err("world_id", "is required");
  if (!Number.isInteger(m.world_version) || m.world_version < 1) iss.err("world_version", "must be an integer >= 1");

  // ----------------------------------------------------------------- meta
  if (!isObj(m.meta)) iss.err("meta", "is required");
  else {
    requireFields(m.meta, "meta", [
      ["title", isStr, "a world needs a title"],
      ["created_at", isStr, "created_at (ISO 8601) is required"],
    ], iss);
    requireEnum(m.meta.maturity, MATURITY, "meta.maturity", iss, { optional: true });
    if (m.meta.seed !== undefined && !isNum(m.meta.seed)) iss.err("meta.seed", "must be a number when present");
    if (m.meta.tags !== undefined && !isArr(m.meta.tags)) iss.err("meta.tags", "must be an array when present");
  }

  // ---------------------------------------------------------- environment
  if (!isObj(m.environment)) iss.err("environment", "is required");
  else {
    requireEnum(m.environment.weather, WEATHERS, "environment.weather", iss, { optional: true });
    if (m.environment.time_of_day !== undefined && (!isNum(m.environment.time_of_day) || m.environment.time_of_day < 0 || m.environment.time_of_day > 1)) {
      iss.err("environment.time_of_day", "must be a number in [0,1] (0 = midnight, 0.5 = noon)");
    }
    if (m.environment.gravity !== undefined && !isNum(m.environment.gravity)) iss.err("environment.gravity", "must be a number");
  }

  // -------------------------------------------------------------- terrain
  if (!isObj(m.terrain)) iss.err("terrain", "is required");
  else {
    requireEnum(m.terrain.kind, TERRAIN_KINDS, "terrain.kind", iss);
    if (!isObj(m.terrain.size) || !isNum(m.terrain.size.w) || !isNum(m.terrain.size.h)) {
      iss.err("terrain.size", "must be { w:number, h:number }");
    } else if (m.terrain.size.w <= 0 || m.terrain.size.h <= 0) {
      iss.err("terrain.size", "must have positive dimensions");
    }
    if (m.terrain.kind !== "flat" && !isArr(m.terrain.data) && !isStr(m.terrain.data_ref)) {
      iss.err("terrain.data", "a non-flat terrain needs inline data or a data_ref");
    }
  }

  // ---------------------------------------------------------------- zones
  const zoneIds = new Set();
  if (!isArr(m.zones)) iss.err("zones", "must be an array (may be empty only for a flat single-space world)");
  else {
    m.zones.forEach((z, i) => {
      const p = `zones[${i}]`;
      if (!isStr(z?.id)) { iss.err(`${p}.id`, "is required"); return; }
      if (zoneIds.has(z.id)) iss.err(`${p}.id`, `duplicate zone id '${z.id}'`);
      zoneIds.add(z.id);
      requireEnum(z.kind, ZONE_KINDS, `${p}.kind`, iss);
      if (!isArr(z.bounds) || z.bounds.length !== 4 || !z.bounds.every(isNum)) {
        iss.err(`${p}.bounds`, "must be [minX, minZ, maxX, maxZ]");
      } else if (z.bounds[2] <= z.bounds[0] || z.bounds[3] <= z.bounds[1]) {
        iss.err(`${p}.bounds`, "max must exceed min on both axes");
      }
    });
    m.zones.forEach((z, i) => {
      if (z?.parent_zone && !zoneIds.has(z.parent_zone)) iss.err(`zones[${i}].parent_zone`, `references unknown zone '${z.parent_zone}'`);
    });
  }

  // --------------------------------------------------------------- assets
  const assetIds = new Set();
  if (!isArr(m.assets)) iss.err("assets", "must be an array");
  else {
    m.assets.forEach((a, i) => {
      const p = `assets[${i}]`;
      if (!isStr(a?.id)) { iss.err(`${p}.id`, "is required"); return; }
      if (assetIds.has(a.id)) iss.err(`${p}.id`, `duplicate asset id '${a.id}'`);
      assetIds.add(a.id);
      requireEnum(a.kind, ASSET_KINDS, `${p}.kind`, iss);
      requireEnum(a.format, ASSET_FORMATS, `${p}.format`, iss);
      if (a.format === "glb" || a.format === "gltf") {
        if (!isStr(a.uri)) iss.err(`${p}.uri`, "a glb/gltf asset needs a uri");
      } else if (a.format === "primitive" && !isObj(a.primitive)) {
        iss.err(`${p}.primitive`, "a primitive asset needs a primitive spec");
      }
      if (a.collision !== undefined && !isObj(a.collision)) iss.err(`${p}.collision`, "must be an object when present");
      if (a.lod !== undefined && !isArr(a.lod)) iss.err(`${p}.lod`, "must be an array when present");
      // Licensing is a launch-blocker concern, so its absence is loud but not fatal.
      if (!isObj(a.license)) iss.warn(`${p}.license`, "no licence recorded", "commercial redistribution rights are a public-launch blocker");
    });
  }

  const assetRef = (ref, path) => {
    if (ref === undefined || ref === null) return;
    if (!assetIds.has(ref)) iss.err(path, `references unknown asset '${ref}'`, "every asset_ref must resolve inside assets[]");
  };
  const zoneRef = (ref, path) => {
    if (ref === undefined || ref === null) return;
    if (!zoneIds.has(ref)) iss.err(path, `references unknown zone '${ref}'`);
  };

  // ----------------------------------------------------------- behaviors
  const behaviorIds = new Set();
  if (m.behaviors !== undefined) {
    if (!isArr(m.behaviors)) iss.err("behaviors", "must be an array when present");
    else m.behaviors.forEach((b, i) => {
      const p = `behaviors[${i}]`;
      if (!isStr(b?.id)) { iss.err(`${p}.id`, "is required"); return; }
      if (behaviorIds.has(b.id)) iss.err(`${p}.id`, `duplicate behavior id '${b.id}'`);
      behaviorIds.add(b.id);
      requireEnum(b.kind, BEHAVIOR_KINDS, `${p}.kind`, iss);
      if (!isObj(b.spec) && !isStr(b.script)) iss.err(`${p}.spec`, "a behavior needs a declarative spec or a script");
    });
  }
  const behaviorRef = (ref, path) => {
    if (ref === undefined || ref === null) return;
    if (!behaviorIds.has(ref)) iss.err(path, `references unknown behavior '${ref}'`);
  };

  // ---------------------------------------------------------- structures
  const structureIds = new Set();
  if (!isArr(m.structures)) iss.err("structures", "must be an array");
  else m.structures.forEach((s, i) => {
    const p = `structures[${i}]`;
    if (!isStr(s?.id)) { iss.err(`${p}.id`, "is required"); return; }
    if (structureIds.has(s.id)) iss.err(`${p}.id`, `duplicate structure id '${s.id}'`);
    structureIds.add(s.id);
    assetRef(s.asset_ref, `${p}.asset_ref`);
    zoneRef(s.zone, `${p}.zone`);
    if (!isObj(s.transform) || !isVec3(s.transform.position)) iss.err(`${p}.transform.position`, "must be { x, y, z }");
  });

  // ----------------------------------------------------------------- npcs
  const npcIds = new Set();
  if (!isArr(m.npcs)) iss.err("npcs", "must be an array");
  else m.npcs.forEach((n, i) => {
    const p = `npcs[${i}]`;
    if (!isStr(n?.id)) { iss.err(`${p}.id`, "is required"); return; }
    if (npcIds.has(n.id)) iss.err(`${p}.id`, `duplicate npc id '${n.id}'`);
    npcIds.add(n.id);
    if (!isStr(n.name)) iss.warn(`${p}.name`, "npc has no name");
    if (!isVec3(n.spawn)) iss.err(`${p}.spawn`, "must be { x, y, z }");
    zoneRef(n.zone, `${p}.zone`);
    assetRef(n.asset_ref, `${p}.asset_ref`);
    behaviorRef(n.behavior_ref, `${p}.behavior_ref`);
  });

  // ---------------------------------------------------------------- items
  const itemIds = new Set();
  if (m.items !== undefined) {
    if (!isArr(m.items)) iss.err("items", "must be an array when present");
    else m.items.forEach((it, i) => {
      const p = `items[${i}]`;
      if (!isStr(it?.id)) { iss.err(`${p}.id`, "is required"); return; }
      if (itemIds.has(it.id)) iss.err(`${p}.id`, `duplicate item id '${it.id}'`);
      itemIds.add(it.id);
      assetRef(it.asset_ref, `${p}.asset_ref`);
    });
  }

  // --------------------------------------------------------------- quests
  const questIds = new Set();
  if (!isArr(m.quests)) iss.err("quests", "must be an array");
  else m.quests.forEach((q, i) => {
    const p = `quests[${i}]`;
    if (!isStr(q?.id)) { iss.err(`${p}.id`, "is required"); return; }
    if (questIds.has(q.id)) iss.err(`${p}.id`, `duplicate quest id '${q.id}'`);
    questIds.add(q.id);
    if (!isStr(q.title)) iss.err(`${p}.title`, "is required");
    if (q.giver_npc && !npcIds.has(q.giver_npc)) iss.err(`${p}.giver_npc`, `references unknown npc '${q.giver_npc}'`);
    if (!isArr(q.steps) || q.steps.length === 0) {
      iss.err(`${p}.steps`, "a quest needs at least one step", "a quest with no steps can never be completed");
    } else {
      const stepIds = new Set();
      q.steps.forEach((st, j) => {
        const sp = `${p}.steps[${j}]`;
        if (!isStr(st?.id)) iss.err(`${sp}.id`, "is required");
        else if (stepIds.has(st.id)) iss.err(`${sp}.id`, `duplicate step id '${st.id}'`);
        else stepIds.add(st.id);
        requireEnum(st?.kind, QUEST_STEP_KINDS, `${sp}.kind`, iss);
        // A step whose target does not exist is a dead quest — the exact failure
        // the B4 critic must be able to detect.
        const t = st?.target;
        if (isStr(t) && !npcIds.has(t) && !itemIds.has(t) && !zoneIds.has(t) && !structureIds.has(t)) {
          iss.err(`${sp}.target`, `references unknown target '${t}'`, "a quest step must target a real npc, item, zone or structure");
        }
      });
    }
    (q.prerequisites || []).forEach((pr, j) => {
      if (!questIds.has(pr) && !(m.quests || []).some((qq) => qq.id === pr)) {
        iss.err(`${p}.prerequisites[${j}]`, `references unknown quest '${pr}'`);
      }
    });
  });

  // --------------------------------------------------------- interactions
  const interactionIds = new Set();
  if (m.interactions !== undefined) {
    if (!isArr(m.interactions)) iss.err("interactions", "must be an array when present");
    else m.interactions.forEach((x, i) => {
      const p = `interactions[${i}]`;
      if (!isStr(x?.id)) iss.err(`${p}.id`, "is required");
      // Interactions were the one id-bearing collection with no duplicate
      // check, and the omission was load-bearing: two repair cases both built
      // `interaction_pickup_<item>` from the item id, produced two interactions
      // with that id aimed at different targets, and nothing anywhere noticed.
      // The runtime keys interactions by id, so a duplicate is one object
      // shadowing another — a prompt that opens the wrong thing.
      else if (interactionIds.has(x.id)) iss.err(`${p}.id`, `duplicate interaction id '${x.id}'`);
      else interactionIds.add(x.id);
      requireEnum(x?.trigger, TRIGGERS, `${p}.trigger`, iss);
      behaviorRef(x?.behavior_ref, `${p}.behavior_ref`);
      const t = x?.target_ref;
      if (isStr(t) && !structureIds.has(t) && !npcIds.has(t) && !itemIds.has(t) && !zoneIds.has(t)) {
        iss.err(`${p}.target_ref`, `references unknown target '${t}'`);
      }
    });
  }

  // ---------------------------------------------------------------- spawn
  if (!isObj(m.spawn)) iss.err("spawn", "is required");
  else {
    if (!isArr(m.spawn.player_spawns) || m.spawn.player_spawns.length === 0) {
      iss.err("spawn.player_spawns", "at least one player spawn is required", "a world with no spawn cannot be entered");
    } else {
      m.spawn.player_spawns.forEach((s, i) => {
        if (!isVec3(s?.position)) iss.err(`spawn.player_spawns[${i}].position`, "must be { x, y, z }");
        zoneRef(s?.zone, `spawn.player_spawns[${i}].zone`);
      });
    }
  }

  // ----------------------------------------------------------- navigation
  if (m.navigation !== undefined && !isObj(m.navigation)) iss.err("navigation", "must be an object when present");
  else if (isObj(m.navigation)) {
    (m.navigation.links || []).forEach((l, i) => {
      zoneRef(l?.from, `navigation.links[${i}].from`);
      zoneRef(l?.to, `navigation.links[${i}].to`);
    });
  }

  // ---------------------------------------------------------- multiplayer
  if (m.multiplayer !== undefined) {
    if (!isObj(m.multiplayer)) iss.err("multiplayer", "must be an object when present");
    else if (m.multiplayer.max_players !== undefined && (!Number.isInteger(m.multiplayer.max_players) || m.multiplayer.max_players < 1)) {
      iss.err("multiplayer.max_players", "must be a positive integer");
    }
  }

  // ------------------------------------------------------------ provenance
  if (!isObj(m.provenance)) {
    iss.err("provenance", "is required", "a world must record what produced it");
  } else {
    if (!isArr(m.provenance.generated_by)) iss.err("provenance.generated_by", "must be an array of lane records");
    else m.provenance.generated_by.forEach((g, i) => {
      const p = `provenance.generated_by[${i}]`;
      if (!isStr(g?.lane)) iss.err(`${p}.lane`, "is required");
      if (!isStr(g?.provider)) iss.err(`${p}.provider`, "is required");
      if (g?.status && !["AVAILABLE", "UNAVAILABLE", "FALLBACK"].includes(g.status)) {
        iss.err(`${p}.status`, `'${g.status}' is not a provider status`, "use AVAILABLE, UNAVAILABLE or FALLBACK");
      }
    });
  }

  // ------------------------------------------------------------- expansion
  if (m.expansion !== undefined) {
    if (!isObj(m.expansion)) iss.err("expansion", "must be an object when present");
    else if (m.expansion.history !== undefined && !isArr(m.expansion.history)) {
      iss.err("expansion.history", "must be an array when present");
    }
  }

  // --------------------------------------------- provider-neutrality guard
  // The single rule that keeps this contract portable.
  const BANNED = /^(cerebras|deepseek|openai|anthropic|together|kinix|kynex|meshy|tripo|luma|stability|elevenlabs|replicate)_/i;
  (function scan(node, path) {
    if (!isObj(node)) { if (isArr(node)) node.forEach((v, i) => scan(v, `${path}[${i}]`)); return; }
    for (const k of Object.keys(node)) {
      if (BANNED.test(k) && !path.startsWith("provenance")) {
        iss.err(`${path}.${k}`, "provider-specific field in the canonical schema",
          "record the provider in provenance.generated_by instead; the manifest must not change when a vendor does");
      }
      scan(node[k], `${path}.${k}`);
    }
  })(m, "$");

  return iss.toJSON();
}

/** A structurally valid, minimal, immediately playable world. Used as a base and in tests. */
export function emptyManifest({ worldId, title = "Untitled World", creatorId = null, seed = 0 } = {}) {
  const now = new Date().toISOString();
  return {
    manifest_version: MANIFEST_VERSION,
    world_id: worldId,
    world_version: 1,
    meta: { title, prompt: null, genre: null, style: null, seed, creator_id: creatorId, created_at: now, updated_at: now, description: null, tags: [], maturity: "13+" },
    environment: { time_of_day: 0.5, weather: "clear", gravity: -9.81, sky: null, fog: null, ambient_light: null, directional_light: null, wind: null },
    terrain: { kind: "flat", size: { w: 128, h: 128 }, data: null, materials: [] },
    zones: [],
    assets: [],
    structures: [],
    npcs: [],
    items: [],
    quests: [],
    interactions: [],
    behaviors: [],
    physics: { engine_hint: "browser-builtin", gravity: -9.81, materials: [] },
    navigation: { walkable_zones: [], links: [], navmesh_ref: null },
    animation: { clips: [], rigs: [] },
    audio: { ambient: [], music: [], sfx: [], narration: [] },
    spawn: { player_spawns: [{ id: "spawn_default", position: { x: 0, y: 1, z: 0 }, zone: null }], respawn_policy: "nearest", safe_radius: 6 },
    multiplayer: { enabled: false, max_players: 1, authoritative: "server", replicated_refs: [], shared_zones: [] },
    companion: { enabled: false, persona_ref: null, knowledge_scope: "world", memory_refs: [] },
    media: { thumbnail_ref: null, trailer_ref: null, intro_ref: null, portraits: {}, captions: {} },
    provenance: { generated_by: [], source_prompt_hash: null, manifest_hash: null },
    expansion: { history: [], compatibility: { min_runtime: MIN_RUNTIME_VERSION, migrated_from: null } },
    runtime_config: { render_distance: 220, streaming: true, quality_tiers: ["low", "medium", "high"], mobile: { touch_controls: true, max_instances: 400 } },
  };
}
