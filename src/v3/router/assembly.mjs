// B1 — the DCS World Assembly Router.
//
// Six lanes, each with a ranked provider list ending in a deterministic
// fallback, composed into one WorldManifestV3. The router is the only thing that
// knows a provider exists; the manifest records which one answered and nothing
// else depends on it.
//
// It is deliberately NOT "replace Cerebras with one expensive LLM":
//   world_architect  premium reasoning designs space and gameplay
//   fast_inference   cheap high-volume classification and metadata
//   spatial          terrain and navigation, provider-neutral
//   asset_3d         curated archetypes now, external provider when one exists
//   gameplay         declarative behaviour specs for doors, lifts, vehicles, AI
//   media            images, voice, video — optional, never blocking
import crypto from "node:crypto";
import { Lane, LANES, STATUS } from "../providers/contract.mjs";
import { architectAdapters, fastAdapters, gameplayAdapters } from "../providers/text.mjs";
import { asset3dAdapters } from "../providers/asset3d.mjs";
import { mediaAdapters } from "../providers/media.mjs";
import { spatialAdapters } from "../providers/spatial.mjs";
import { visionAdapters, VISION_LANE, validateImage, conditionPrompt, readingToConstraints } from "../providers/vision.mjs";
import { emptyManifest, validateManifest, MANIFEST_VERSION } from "../manifest/schema.mjs";
import { hashString } from "../providers/local-planner.mjs";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const slug = (s, fallback) => {
  const t = String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return t || fallback;
};

export function createAssemblyRouter(env = process.env) {
  const lanes = {
    [LANES.WORLD_ARCHITECT]: new Lane(LANES.WORLD_ARCHITECT, architectAdapters(env)),
    [LANES.FAST_INFERENCE]: new Lane(LANES.FAST_INFERENCE, fastAdapters(env)),
    [LANES.SPATIAL]: new Lane(LANES.SPATIAL, spatialAdapters(env)),
    [LANES.ASSET_3D]: new Lane(LANES.ASSET_3D, asset3dAdapters(env)),
    [LANES.GAMEPLAY]: new Lane(LANES.GAMEPLAY, gameplayAdapters(env)),
    [LANES.MEDIA]: new Lane(LANES.MEDIA, mediaAdapters(env)),
    // 9.1 multimodal: a reference image is READ into a description, and the
    // description conditions generation. No image bytes ever enter the manifest.
    [VISION_LANE]: new Lane(VISION_LANE, visionAdapters(env)),
  };

  return {
    lanes,

    /** Provider status for every lane, without invoking anything. */
    async describe() {
      const out = [];
      for (const lane of Object.values(lanes)) out.push(await lane.describe());
      return { manifest_version: MANIFEST_VERSION, lanes: out };
    },

    /**
     * Assemble a complete WorldManifestV3 from a prompt.
     *
     * @param {{prompt:string, worldId:string, creatorId?:string, seed?:number, style?:string, media?:boolean}} req
     * @returns {Promise<{manifest:object, validation:object, provenance:Array, degraded:Array}>}
     */
    async assemble(req) {
      const prompt = String(req.prompt || "").trim();
      if (!prompt) throw new TypeError("assemble() needs a prompt");
      const seed = req.seed ?? hashString(prompt);
      const provenance = [];
      const degraded = [];
      let visualReading = null;
      let conditioning = { conditioned: false, reason: "no reference image was supplied" };

      // Optional progress callback. It reports the lane that ACTUALLY finished
      // and which provider answered — never a timer.
      const onLane = typeof req.onLane === "function" ? req.onLane : null;
      const announce = async (phase, lane, detail) => { if (onLane) await onLane(phase, lane, detail); };

      const record = (r) => {
        provenance.push(r.provenance);
        for (const a of r.attempts || []) degraded.push({ lane: r.provenance.lane, provider: a.provider, reason: a.reason });
        return r.value;
      };

      /** Run a lane with start/finish progress reporting around it. */
      const runLane = async (laneName, request) => {
        await announce("start", laneName);
        const r = await lanes[laneName].run(request);
        await announce("finish", laneName, `${r.provenance.provider} (${r.provenance.status}) ${r.provenance.latency_ms}ms`);
        return record(r);
      };

      // ---- 0. vision (9.1): read a reference image into a description ----
      let effectivePrompt = prompt;
      let constraints = req.constraints || null;
      if (req.image) {
        validateImage(req.image);                       // throws before a byte is sent
        await announce("start", VISION_LANE);
        const v = await lanes[VISION_LANE].run({ dataUrl: req.image.dataUrl, prompt });
        await announce("finish", VISION_LANE, `${v.provenance.provider} (${v.provenance.status})`);
        provenance.push(v.provenance);
        visualReading = v.value;
        conditioning = conditionPrompt(prompt, visualReading);
        effectivePrompt = conditioning.prompt;
        const fromImage = readingToConstraints(visualReading);
        if (conditioning.conditioned && fromImage) constraints = { ...(constraints || {}), ...fromImage };
      }

      // ---- 1. world architect ------------------------------------------
      const plan = await runLane(LANES.WORLD_ARCHITECT, { prompt: effectivePrompt, seed, style: req.style, constraints });

      // ---- 2. fast inference: metadata -----------------------------------
      const meta = await runLane(LANES.FAST_INFERENCE, { prompt, title: plan.title, zones: plan.zones });

      // ---- 3. spatial: terrain + navigation ------------------------------
      const spatial = await runLane(LANES.SPATIAL, { seed, size: plan.size, zones: plan.zones, roads: plan.roads, structures: plan.structures, style: plan.style });

      // ---- 4. assets: one entry per archetype, referenced many times ------
      const assetReq = {
        style: plan.style || meta.mood,
        seed,
        requests: [
          ...(plan.structures || []).map((s) => ({ archetype: s.archetype, kindHint: "building", footprint: s.footprint })),
          ...(plan.npcs || []).map(() => ({ archetype: "humanoid", kindHint: "character" })),
          ...(plan.items || []).map((i) => ({ archetype: i.kind, kindHint: "prop" })),
        ],
      };
      const assetResult = await runLane(LANES.ASSET_3D, assetReq);

      // ---- 5. gameplay behaviour -----------------------------------------
      const gameplay = await runLane(LANES.GAMEPLAY, {
        seed, genre: meta.genre || plan.genre,
        zones: plan.zones, structures: plan.structures, npcs: plan.npcs, items: plan.items,
      });

      // ---- compose ------------------------------------------------------
      const manifest = compose({ req, plan, meta, spatial, assets: assetResult.assets, gameplay, seed, provenance, degraded });

      // ---- 6. media (optional, never blocking) ---------------------------
      if (req.media) {
        await announce("start", LANES.MEDIA);
        const m = await lanes[LANES.MEDIA].run({
          kind: "image",
          label: manifest.meta.title,
          prompt: `Key art for a game world: ${manifest.meta.title}. ${manifest.meta.style || ""} ${plan.gameplay_loop || ""}`.slice(0, 400),
          width: 1024, height: 576,
        });
        provenance.push(m.provenance);
        await announce("finish", LANES.MEDIA, `${m.provenance.provider} (${m.provenance.status})`);
        if (m.value?.uri) {
          manifest.assets.push({
            id: "asset_thumbnail",
            kind: "effect",
            format: "external",
            uri: m.value.uri,
            license: { source: m.provenance.provider, commercial_use: "internal-testing-only" },
            provenance: { lane: "media", provider: m.provenance.provider, placeholder: !!m.value.placeholder },
          });
          manifest.media.thumbnail_ref = "asset_thumbnail";
          manifest.media.thumbnail_is_placeholder = !!m.value.placeholder;
        }
      }

      manifest.provenance.generated_by = provenance;
      manifest.provenance.source_prompt_hash = crypto.createHash("sha256").update(prompt).digest("hex");

      // The reading is reported so a creator can see exactly what the system
      // thought their picture showed, and whether it was used.
      if (visualReading) {
        manifest.meta.reference_image = {
          conditioned: conditioning.conditioned,
          ...(conditioning.conditioned ? {} : { not_used_because: conditioning.reason }),
          reading: { kind: visualReading.kind, setting: visualReading.setting, style: visualReading.style, confidence: visualReading.confidence, not_visible: visualReading.not_visible },
        };
      }

      const validation = validateManifest(manifest);
      return { manifest, validation, provenance, degraded, visual_reading: visualReading, conditioning };
    },
  };
}

// ------------------------------------------------------------------- compose
//
// Turns lane outputs into a valid WorldManifestV3. It is defensive on purpose:
// a model's output is untrusted input, so ids are re-slugged, positions are
// clamped into their zone, and any reference that does not resolve is DROPPED
// rather than guessed at — a dangling reference must reach the B4 critic as a
// missing feature, never as an invented one.

function compose({ req, plan, meta, spatial, assets, gameplay, seed, provenance, degraded = [] }) {
  const m = emptyManifest({
    worldId: req.worldId,
    title: plan.title || "Untitled World",
    creatorId: req.creatorId ?? null,
    seed,
  });

  const size = {
    w: clamp(num(plan.size?.w, 260), 80, 2000),
    h: clamp(num(plan.size?.h, 260), 80, 2000),
  };

  m.meta = {
    ...m.meta,
    prompt: req.prompt,
    genre: meta.genre || plan.genre || null,
    style: plan.style || meta.mood || null,
    description: meta.summary || plan.gameplay_loop || null,
    tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 12) : [],
    maturity: ["13+", "16+", "18+"].includes(plan.maturity) ? plan.maturity : (["13+", "16+", "18+"].includes(meta.maturity) ? meta.maturity : "13+"),
    gameplay_loop: plan.gameplay_loop || null,
  };

  m.environment = {
    ...m.environment,
    weather: plan.environment?.weather || "clear",
    time_of_day: clamp(num(plan.environment?.time_of_day, 0.5), 0, 1),
    palette: plan.palette || null,
  };

  // A lane's answer is composed in, never installed wholesale.
  //
  // These three took whatever the spatial lane returned, so a provider that
  // answered without a terrain wrote `undefined` into the manifest and the
  // world came out with no ground at all — invalid, and rejected downstream for
  // "terrain is required" rather than for the provider that caused it. Both
  // spatial adapters do check their own responses today; this is the router
  // holding to its own rule, which is that the manifest does not change shape
  // when a vendor does. The empty manifest's flat default is what a world
  // without terrain data honestly is.
  const usableTerrain = isObj(spatial?.terrain)
    && isObj(spatial.terrain.size)
    && num(spatial.terrain.size.w, 0) > 0
    && num(spatial.terrain.size.h, 0) > 0;
  if (usableTerrain) m.terrain = spatial.terrain;
  else degraded.push({ lane: LANES.SPATIAL, provider: "terrain", reason: "the spatial lane returned no usable terrain; the world keeps its flat default" });
  m.physics = { ...m.physics, ...(isObj(spatial?.physics) ? spatial.physics : {}) };
  if (isObj(spatial?.navigation)) m.navigation = spatial.navigation;

  // ---- zones ---------------------------------------------------------------
  const zoneById = new Map();
  // First entity of each id wins, throughout.
  //
  // Assets, behaviours and quests already dropped a repeat; zones, structures,
  // NPCs, items, interactions and quest steps did not, and a model repeating an
  // id is an ordinary slip. The result was a manifest the schema rejects for
  // `duplicate zone id` — and duplicate-id findings come from the schema, which
  // carries no `fix`, so nothing downstream could repair it and the generation
  // simply failed. Between an ambiguous pair there is no better rule than the
  // first, which is what the collections that already deduped were doing.
  m.zones = (plan.zones || []).map((z, i) => {
    const id = slug(z.id || z.name, `zone_${i}`);
    if (zoneById.has(id)) return null;
    const b = Array.isArray(z.bounds) && z.bounds.length === 4 ? z.bounds.map((n) => num(n)) : [0, 0, size.w, size.h];
    const bounds = [
      clamp(Math.min(b[0], b[2]), 0, size.w - 2),
      clamp(Math.min(b[1], b[3]), 0, size.h - 2),
      clamp(Math.max(b[0], b[2]), 2, size.w),
      clamp(Math.max(b[1], b[3]), 2, size.h),
    ];
    if (bounds[2] - bounds[0] < 8) bounds[2] = clamp(bounds[0] + 8, 0, size.w);
    if (bounds[3] - bounds[1] < 8) bounds[3] = clamp(bounds[1] + 8, 0, size.h);
    const zone = {
      id, name: z.name || id, kind: ZONE_KIND(z.kind), bounds,
      parent_zone: null, tags: [], ambience: z.description || null,
      density: num(z.density, 0.5),
    };
    zoneById.set(id, zone);
    return zone;
  }).filter(Boolean);
  if (!m.zones.length) {
    const zone = { id: "zone_main", name: "Main", kind: "district", bounds: [0, 0, size.w, size.h], parent_zone: null, tags: [], ambience: null, density: 0.5 };
    m.zones = [zone];
    zoneById.set(zone.id, zone);
  }

  const inZone = (pos, zone) => {
    const [x0, z0, x1, z1] = zone.bounds;
    return { x: clamp(num(pos?.x, (x0 + x1) / 2), x0 + 1, x1 - 1), y: num(pos?.y, 0), z: clamp(num(pos?.z, (z0 + z1) / 2), z0 + 1, z1 - 1) };
  };
  const pickZone = (id, i) => zoneById.get(slug(id, "")) || m.zones[i % m.zones.length];

  // ---- assets --------------------------------------------------------------
  // Only rows that are actually assets. `for (const a of assets || [])` iterates
  // a string one CHARACTER at a time, so an asset lane answering
  // `{"assets": "none"}` composed four id-less entries into the manifest and the
  // schema rejected the world for `assets[0].id is required`.
  const assetById = new Map();
  for (const a of Array.isArray(assets) ? assets : []) {
    if (isObj(a) && typeof a.id === "string" && a.id && !assetById.has(a.id)) assetById.set(a.id, a);
  }
  m.assets = Array.from(assetById.values());

  const assetFor = (archetype, kindHint) => {
    const direct = `asset_${slug(archetype, "")}`;
    if (assetById.has(direct)) return direct;
    const byKind = m.assets.find((a) => a.kind === (kindHint === "character" ? "character" : kindHint === "prop" ? "prop" : "building"));
    return byKind ? byKind.id : (m.assets[0]?.id ?? null);
  };

  // ---- structures ----------------------------------------------------------
  const structById = new Map();
  const structIdsSeen = new Set();
  m.structures = (plan.structures || []).map((s, i) => {
    const zone = pickZone(s.zone, i);
    const id = slug(s.id, `struct_${i}`);
    if (structIdsSeen.has(id)) return null;
    structIdsSeen.add(id);
    const fp = s.footprint || { w: 8, d: 8, h: 6 };
    const ref = assetFor(s.archetype, "building");
    const st = {
      id, zone: zone.id, asset_ref: ref,
      transform: {
        position: inZone(s.position, zone),
        rotation: { x: 0, y: num(s.rotation_y, 0), z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      footprint: { w: num(fp.w, 8), d: num(fp.d, 8), h: num(fp.h, 6) },
      interactable: !!s.enterable,
      enterable: !!s.enterable,
      purpose: s.purpose || s.archetype || null,
      portals: [],
      owner_id: null,
    };
    return st;
  }).filter((s) => s && s.asset_ref);
  // Indexed AFTER the filter, not during the map.
  //
  // These maps are what `resolves()` consults to decide whether a quest step or
  // an interaction points at something real, and they used to be filled inside
  // the map — before the `.filter(asset_ref)` on the next line removed every
  // entity the asset lane could not supply a model for. So a partially failing
  // 3D provider dropped an NPC from the manifest while `resolves()` went on
  // saying it existed, and the quests aimed at it survived as dangling
  // references: a manifest the schema rejects, produced by the composer whose
  // stated rule is that an unresolved reference is DROPPED rather than guessed.
  for (const st of m.structures) structById.set(st.id, st);

  // ---- npcs ----------------------------------------------------------------
  const npcById = new Map();
  const npcIdsSeen = new Set();
  m.npcs = (plan.npcs || []).map((n, i) => {
    const zone = pickZone(n.zone, i);
    const id = slug(n.id, `npc_${i}`);
    if (npcIdsSeen.has(id)) return null;
    npcIdsSeen.add(id);
    const npc = {
      id, name: n.name || id, role: n.role || null, zone: zone.id,
      spawn: inZone(n.position || n.spawn, zone),
      asset_ref: assetFor("humanoid", "character"),
      behavior_ref: null,
      dialogue: { seed: n.dialogue_seed || null, lines: [] },
      schedule: [], faction: null, stats: null,
    };
    return npc;
  }).filter((n) => n && n.asset_ref);
  for (const npc of m.npcs) npcById.set(npc.id, npc);

  // ---- items ---------------------------------------------------------------
  const itemById = new Map();
  const itemIdsSeen = new Set();
  m.items = (plan.items || []).map((it, i) => {
    const id = slug(it.id, `item_${i}`);
    if (itemIdsSeen.has(id)) return null;
    itemIdsSeen.add(id);
    const item = { id, name: it.name || id, kind: it.kind || "misc", asset_ref: assetFor(it.kind, "prop"), stackable: false, effects: [] };
    return item;
  }).filter((it) => it && it.asset_ref);
  for (const item of m.items) itemById.set(item.id, item);

  const resolves = (ref) => {
    const r = slug(ref, "");
    return zoneById.has(r) || structById.has(r) || npcById.has(r) || itemById.has(r) ? r : null;
  };

  // ---- behaviours + interactions ------------------------------------------
  const behaviorIds = new Set();
  m.behaviors = (gameplay.behaviors || []).map((b, i) => {
    const id = slug(b.id, `behavior_${i}`);
    if (behaviorIds.has(id) || (!b.spec && !b.script)) return null;
    behaviorIds.add(id);
    return { id, kind: BEHAVIOR_KIND(b.kind), spec: b.spec || null, script: null, inputs: b.inputs || null, outputs: b.outputs || null };
  }).filter(Boolean);

  const interactionIds = new Set();
  m.interactions = (gameplay.interactions || []).map((x, i) => {
    const target = resolves(x.target_ref);
    const beh = slug(x.behavior_ref, "");
    // Drop rather than repair: a dangling interaction is a real gap and B4 must see it.
    if (!target || !behaviorIds.has(beh)) return null;
    const id = slug(x.id, `interaction_${i}`);
    if (interactionIds.has(id)) return null;
    interactionIds.add(id);
    return { id, trigger: TRIGGER(x.trigger), target_ref: target, behavior_ref: beh, params: x.params || null };
  }).filter(Boolean);

  // Attach behaviours to their NPCs so the runtime does not have to search.
  for (const x of m.interactions) {
    const npc = npcById.get(x.target_ref);
    if (npc && !npc.behavior_ref) npc.behavior_ref = x.behavior_ref;
  }

  // ---- quests --------------------------------------------------------------
  const questIds = new Set();
  m.quests = (plan.quests || []).map((q, i) => {
    const id = slug(q.id, `quest_${i}`);
    if (questIds.has(id)) return null;
    questIds.add(id);
    const stepIds = new Set();
    const steps = (q.steps || []).map((st, j) => {
      const sid = slug(st.id, `step_${j}`);
      if (stepIds.has(sid)) return null;
      stepIds.add(sid);
      return { id: sid, kind: STEP_KIND(st.kind), target: resolves(st.target), description: st.description || null };
    }).filter(Boolean);
    return {
      id, title: q.title || `Quest ${i + 1}`,
      giver_npc: npcById.has(slug(q.giver_npc, "")) ? slug(q.giver_npc, "") : null,
      zone: null,
      difficulty: ["easy", "normal", "hard"].includes(q.difficulty) ? q.difficulty : "normal",
      steps,
      rewards: Array.isArray(q.rewards) ? q.rewards : (q.reward ? [q.reward] : []),
      prerequisites: [],
    };
  }).filter((q) => q && q.steps.length > 0);

  // ---- spawn ---------------------------------------------------------------
  const firstZone = m.zones[0];
  const spawnPos = spatial.spawn_hint || inZone({ x: (firstZone.bounds[0] + firstZone.bounds[2]) / 2, y: 0, z: (firstZone.bounds[1] + firstZone.bounds[3]) / 2 }, firstZone);
  m.spawn = {
    player_spawns: [{ id: "spawn_main", position: { ...spawnPos, y: num(spawnPos.y, 0) + 1 }, zone: firstZone.id }],
    respawn_policy: "nearest",
    safe_radius: 8,
  };

  // ---- everything else -----------------------------------------------------
  m.multiplayer = { enabled: false, max_players: 8, authoritative: "server", replicated_refs: [], shared_zones: m.zones.map((z) => z.id) };
  m.companion = { enabled: true, persona_ref: null, knowledge_scope: "world", memory_refs: [] };
  m.expansion = { history: [], compatibility: { min_runtime: "3.0.0", migrated_from: null }, hooks: plan.expansion_hooks || [] };
  m.runtime_config = {
    ...m.runtime_config,
    render_distance: clamp(Math.round(Math.max(size.w, size.h) * 0.9), 120, 600),
    streaming: (m.structures.length + m.npcs.length) > 60,
  };

  return m;
}

// ------------------------------------------------------------------ coercion

const ZONE_KINDS = ["district", "interior", "landmark", "wilderness", "transit", "arena", "instance"];
const BEHAVIOR_KINDS = ["door", "elevator", "vehicle", "enemy_ai", "npc_ai", "combat", "quest_trigger", "switch", "container", "terminal", "platform", "hazard", "pickup", "teleporter"];
const TRIGGERS = ["proximity", "interact", "enter_zone", "exit_zone", "timer", "quest_state", "damage", "collision"];
const STEP_KINDS = ["reach", "talk", "collect", "deliver", "defeat", "activate", "survive", "escort", "solve"];

const ZONE_KIND = (v) => (ZONE_KINDS.includes(v) ? v : "district");
const BEHAVIOR_KIND = (v) => (BEHAVIOR_KINDS.includes(v) ? v : "switch");
const TRIGGER = (v) => (TRIGGERS.includes(v) ? v : "interact");
const STEP_KIND = (v) => (STEP_KINDS.includes(v) ? v : "reach");

export { LANES, STATUS };
