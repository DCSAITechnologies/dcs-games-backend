// B6 / B8 — turn a creator's sentence into a WorldDelta.
//
// Two entry points, one mechanism:
//   planExpansion()  "add a hospital district"  -> a whole new zone with content
//   planEdit()       "make it rain", "enlarge the hospital", "add a boss quest"
//
// Both produce a delta, never a regeneration, which is the whole point of B6:
// V1 town -> V2 hospital -> V3 airport, with players, inventory, ownership and
// completed quests intact across every step.
//
// The intent parse is deterministic and local. A model can supply the CONTENT of
// a new district (through the assembly router) but never the decision about what
// the delta is allowed to touch — that stays in code, where it is testable.
import { newDelta } from "./delta.mjs";
import { rng, hashString } from "../providers/local-planner.mjs";
import { buildAsset } from "../providers/asset3d.mjs";
import { Errors } from "../../core/errors.mjs";

const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "sandstorm", "ash"];

/** District blueprints for the common "add an X district" request. */
const DISTRICT_BLUEPRINTS = {
  hospital: { kind: "district", buildings: ["clinic", "office", "shop"], npcRoles: ["medic", "receptionist", "porter"], items: ["medkit", "access_chip"] },
  airport: { kind: "transit", buildings: ["office", "warehouse", "tower", "parking_structure"], npcRoles: ["controller", "engineer", "officer"], items: ["transit_pass", "toolkit"] },
  university: { kind: "district", buildings: ["office", "apartment_block", "shop", "clinic"], npcRoles: ["professor", "student", "librarian"], items: ["keycard", "journal_page"] },
  industrial: { kind: "district", buildings: ["warehouse", "substation", "crane", "office"], npcRoles: ["engineer", "foreman", "dockhand"], items: ["toolkit", "fuse"] },
  island: { kind: "wilderness", buildings: ["shelter", "boathouse", "ruin_arch", "watch_platform"], npcRoles: ["hermit", "ranger"], items: ["flint", "map_fragment"] },
  market: { kind: "district", buildings: ["shop", "fish_market", "diner", "tavern"], npcRoles: ["merchant", "vendor", "courier"], items: ["coffee", "salt_cod"] },
  residential: { kind: "district", buildings: ["apartment_block", "cottage", "shop"], npcRoles: ["resident", "courier"], items: ["keycard"] },
  park: { kind: "wilderness", buildings: ["shelter", "campfire_ring", "bridge"], npcRoles: ["ranger", "resident"], items: ["waterskin"] },
  docks: { kind: "district", buildings: ["warehouse", "boathouse", "crane", "fish_market"], npcRoles: ["dockhand", "harbourmaster"], items: ["rope_coil"] },
  military: { kind: "district", buildings: ["watchtower", "warehouse", "office"], npcRoles: ["officer", "security"], items: ["access_chip"] },
};

const titleCase = (s) => String(s).split(/[_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Find room for a new district beside the existing world, without moving anything. */
function findFreeRegion(manifest, { w = 120, h = 120 } = {}) {
  const size = manifest.terrain?.size || { w: 256, h: 256 };
  const zones = manifest.zones || [];
  const overlaps = (b) => zones.some((z) => !(b[2] <= z.bounds[0] || b[0] >= z.bounds[2] || b[3] <= z.bounds[1] || b[1] >= z.bounds[3]));

  // Prefer a gap inside the existing terrain so navigation links stay short.
  for (let x = 0; x + w <= size.w; x += 20) {
    for (let z = 0; z + h <= size.h; z += 20) {
      const b = [x, z, x + w, z + h];
      if (!overlaps(b)) return { bounds: b, extended: false };
    }
  }
  // Otherwise grow the world eastward. Existing content keeps its coordinates,
  // which is what makes this a delta rather than a relayout.
  const maxX = Math.max(size.w, ...zones.map((z) => z.bounds[2]));
  return { bounds: [maxX + 10, 0, maxX + 10 + w, Math.min(h, size.h)], extended: true, new_size: { w: maxX + 10 + w + 10, h: size.h } };
}

function nearestZone(manifest, bounds) {
  const c = { x: (bounds[0] + bounds[2]) / 2, z: (bounds[1] + bounds[3]) / 2 };
  let best = null;
  for (const z of manifest.zones || []) {
    const zc = { x: (z.bounds[0] + z.bounds[2]) / 2, z: (z.bounds[1] + z.bounds[3]) / 2 };
    const d = Math.hypot(c.x - zc.x, c.z - zc.z);
    if (!best || d < best.d) best = { id: z.id, d };
  }
  return best;
}

/**
 * Plan a district-scale expansion.
 *
 * @param {object} manifest the current world
 * @param {{request:string, label?:string, author?:string, seed?:number}} opts
 */
export function planExpansion(manifest, { request, label = null, author = null, seed = null } = {}) {
  if (!request || typeof request !== "string") throw Errors.validation("an expansion needs a request");
  const text = request.toLowerCase();
  const s = seed ?? hashString(request + String(manifest.world_version));
  const r = rng(s);

  // Which blueprint does the creator mean?
  let key = Object.keys(DISTRICT_BLUEPRINTS).find((k) => new RegExp(`\\b${k}\\b`).test(text));
  if (!key) {
    const alias = { hospital: /\b(medical|infirmary|clinic)\b/, airport: /\b(airfield|airstrip|terminal)\b/, university: /\b(campus|college|school|academy)\b/, industrial: /\b(factory|refinery|plant|works)\b/, island: /\b(isle|atoll)\b/, market: /\b(bazaar|shops?|trading)\b/, military: /\b(barracks|garrison|fort)\b/ };
    key = Object.keys(alias).find((k) => alias[k].test(text));
  }
  if (!key) {
    // No blueprint matched. Name the district after the request rather than
    // guessing at a type — an honest generic district beats a wrong specific one.
    key = "generic";
  }
  const bp = DISTRICT_BLUEPRINTS[key] || { kind: "district", buildings: ["hall", "shop", "office", "house"], npcRoles: ["resident", "merchant"], items: ["key"] };

  const named = /(?:add|build|create)\s+(?:an?\s+)?([a-z][a-z\s]{2,30}?)\s*(?:district|area|zone|quarter|wing|region)?\s*$/.exec(text);
  const districtName = label || titleCase(named?.[1]?.trim() || key);
  const zoneId = `zone_${slug(districtName)}_v${Number(manifest.world_version) + 1}`;

  const size = { w: 110 + Math.floor(r() * 60), h: 100 + Math.floor(r() * 60) };
  const region = findFreeRegion(manifest, size);
  const [x0, z0, x1, z1] = region.bounds;

  const delta = newDelta({ label: `${districtName} district`, author, reason: request });

  // ---- zone ---------------------------------------------------------------
  delta.add.zones.push({
    id: zoneId, name: districtName, kind: bp.kind, bounds: region.bounds,
    parent_zone: null, tags: [key], ambience: `${districtName} district, added in version ${Number(manifest.world_version) + 1}`,
    density: 0.6,
  });

  // ---- assets: reuse what the world already has, add only what is new -----
  const existingAssets = new Set((manifest.assets || []).map((a) => a.id));
  const wantAssets = new Map();
  for (const b of bp.buildings) {
    const a = buildAsset(b, { kindHint: "building", seed: s + hashString(b) });
    if (!existingAssets.has(a.id) && !wantAssets.has(a.id)) wantAssets.set(a.id, a);
  }
  const npcAsset = buildAsset("humanoid", { kindHint: "character", seed: s });
  if (!existingAssets.has(npcAsset.id) && !wantAssets.has(npcAsset.id)) wantAssets.set(npcAsset.id, npcAsset);
  const propAsset = buildAsset("well", { kindHint: "prop", seed: s });
  if (!existingAssets.has(propAsset.id) && !wantAssets.has(propAsset.id)) wantAssets.set(propAsset.id, propAsset);
  delta.add.assets.push(...wantAssets.values());

  const assetIdFor = (name, kindHint) => {
    const id = buildAsset(name, { kindHint, seed: s }).id;
    return existingAssets.has(id) || wantAssets.has(id) ? id
      : (manifest.assets || []).find((a) => a.kind === (kindHint === "character" ? "character" : "building"))?.id ?? null;
  };

  // ---- structures ---------------------------------------------------------
  const count = 4 + Math.floor(r() * 4);
  for (let i = 0; i < count; i++) {
    const archetype = bp.buildings[i % bp.buildings.length];
    const ref = assetIdFor(archetype, "building");
    if (!ref) continue;
    const w = 8 + r() * 10, d = 8 + r() * 10, h = 5 + r() * 12;
    delta.add.structures.push({
      id: `struct_${slug(districtName)}_${archetype}_${i}`,
      zone: zoneId,
      asset_ref: ref,
      transform: {
        position: {
          x: Number((x0 + 10 + ((x1 - x0 - 20) * (i + 0.5)) / count).toFixed(2)),
          y: 0,
          z: Number((z0 + 12 + r() * Math.max(1, z1 - z0 - 24)).toFixed(2)),
        },
        rotation: { x: 0, y: Number((r() * Math.PI * 2).toFixed(3)), z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      footprint: { w: Number(w.toFixed(2)), d: Number(d.toFixed(2)), h: Number(h.toFixed(2)) },
      enterable: i % 2 === 0,
      interactable: i % 2 === 0,
      purpose: titleCase(archetype),
      portals: [],
      owner_id: null,
    });
  }

  // ---- npcs ---------------------------------------------------------------
  const npcRef = assetIdFor("humanoid", "character");
  bp.npcRoles.forEach((role, i) => {
    if (!npcRef) return;
    delta.add.npcs.push({
      id: `npc_${slug(districtName)}_${slug(role)}`,
      name: titleCase(role),
      role,
      zone: zoneId,
      spawn: {
        x: Number((x0 + 14 + r() * Math.max(1, x1 - x0 - 28)).toFixed(2)),
        y: 0,
        z: Number((z0 + 14 + r() * Math.max(1, z1 - z0 - 28)).toFixed(2)),
      },
      asset_ref: npcRef,
      behavior_ref: null,
      dialogue: { seed: `${titleCase(role)} of the ${districtName} district`, lines: [] },
      schedule: [], faction: null, stats: null,
    });
  });

  // ---- items + pickups ----------------------------------------------------
  const propRef = assetIdFor("well", "prop");
  for (const it of bp.items) {
    delta.add.items.push({ id: `item_${slug(districtName)}_${slug(it)}`, name: titleCase(it), kind: it, asset_ref: propRef, stackable: false, effects: [] });
  }

  // ---- behaviours + interactions -----------------------------------------
  delta.add.structures.filter((st) => st.enterable).forEach((st, i) => {
    const bid = `behavior_door_${st.id}`;
    delta.add.behaviors.push({ id: bid, kind: "door", spec: { opens: "inward", speed: 1.2, locked_by: null, auto_close_s: 6 } });
    delta.add.interactions.push({ id: `interaction_door_${st.id}`, trigger: "interact", target_ref: st.id, behavior_ref: bid, params: { prompt: "Open" } });
    void i;
  });
  delta.add.npcs.forEach((n) => {
    const bid = `behavior_npc_${n.id}`;
    delta.add.behaviors.push({ id: bid, kind: "npc_ai", spec: { routine: "idle", waypoints: [{ x: n.spawn.x, z: n.spawn.z }], dialogue_topics: [n.role, districtName] } });
    delta.add.interactions.push({ id: `interaction_npc_${n.id}`, trigger: "interact", target_ref: n.id, behavior_ref: bid, params: { prompt: "Talk" } });
  });
  delta.add.items.forEach((it, i) => {
    const host = delta.add.structures[i % Math.max(1, delta.add.structures.length)];
    if (!host) return;
    const bid = `behavior_pickup_${it.id}`;
    delta.add.behaviors.push({ id: bid, kind: "pickup", spec: { item: it.id, respawn_s: null } });
    delta.add.interactions.push({ id: `interaction_pickup_${it.id}`, trigger: "proximity", target_ref: host.id, behavior_ref: bid, params: { radius: 3 } });
  });

  // ---- a quest that uses the new district --------------------------------
  if (delta.add.npcs.length && delta.add.items.length) {
    delta.add.quests.push({
      id: `quest_${slug(districtName)}_opening`,
      title: `Opening of the ${districtName} District`,
      giver_npc: delta.add.npcs[0].id,
      zone: zoneId,
      difficulty: "normal",
      steps: [
        { id: "step_arrive", kind: "reach", target: zoneId, description: `Reach the new ${districtName} district.` },
        { id: "step_meet", kind: "talk", target: delta.add.npcs[0].id, description: `Speak to ${delta.add.npcs[0].name}.` },
        { id: "step_collect", kind: "collect", target: delta.add.items[0].id, description: `Recover the ${delta.add.items[0].name}.` },
      ],
      rewards: [], prerequisites: [],
    });
  }

  // ---- navigation: connect the new district to its nearest neighbour ------
  const neighbour = nearestZone(manifest, region.bounds);
  delta.navigation_links = neighbour ? [{ from: neighbour.id, to: zoneId, kind: "path", cost: Number(neighbour.d.toFixed(1)) }] : [];
  delta.terrain_extend = region.extended ? region.new_size : null;

  return delta;
}

// ------------------------------------------------------------- B8 chat edits
//
// Surgical edits. Each recognised intent produces the smallest delta that does
// the job — a weather change is one environment field, not a new world.

const EDIT_INTENTS = [
  {
    id: "set_weather",
    match: /\b(make it|set (the )?weather( to)?|turn on|add)\s+(rain(y|ing)?|storm(y)?|snow(y|ing)?|fog(gy)?|clear|sunny|cloudy|sandstorm|ash)\b/i,
    apply(manifest, m) {
      const word = m[4].toLowerCase();
      const weather = word.startsWith("rain") ? "rain" : word.startsWith("storm") ? "storm"
        : word.startsWith("snow") ? "snow" : word.startsWith("fog") ? "fog"
        : word === "sunny" ? "clear" : WEATHERS.includes(word) ? word : "clear";
      return { environment: { weather }, summary: `weather set to ${weather}` };
    },
  },
  {
    id: "night_mode",
    match: /\b(night ?mode|make it night|set (it )?to night|after dark)\b/i,
    apply: () => ({ environment: { time_of_day: 0.02 }, summary: "time of day set to night" }),
  },
  {
    id: "day_mode",
    match: /\b(day ?mode|make it day(time)?|set (it )?to day|daylight)\b/i,
    apply: () => ({ environment: { time_of_day: 0.5 }, summary: "time of day set to midday" }),
  },
  {
    id: "resize_structure",
    match: /\b(enlarge|make .* (bigger|larger)|expand|shrink|make .* smaller)\b.*?\b([a-z_]{3,})\b/i,
    apply(manifest, m, text) {
      const shrink = /shrink|smaller/i.test(text);
      const factor = shrink ? 0.7 : 1.5;
      // Match on the structure's purpose or archetype, not on a raw id guess.
      const needle = text.toLowerCase();
      const target = (manifest.structures || []).find((s) =>
        needle.includes(String(s.purpose || "").toLowerCase()) ||
        needle.includes(String(s.id).replace(/^struct_/, "").split("_")[0]));
      if (!target) return { error: "no structure in this world matches that description" };
      return {
        modify: [{
          collection: "structures", id: target.id,
          changes: { footprint: { w: Number((target.footprint.w * factor).toFixed(2)), d: Number((target.footprint.d * factor).toFixed(2)), h: Number((target.footprint.h * factor).toFixed(2)) } },
        }],
        summary: `${shrink ? "shrank" : "enlarged"} '${target.purpose || target.id}'`,
      };
    },
  },
  {
    id: "enemy_density",
    match: /\b(more|increase|fewer|less|decrease|reduce)\s+(enem(y|ies)|monsters?|hostiles?)\b/i,
    apply(manifest, m, text) {
      const up = /more|increase/i.test(text);
      const enemies = (manifest.behaviors || []).filter((b) => b.kind === "enemy_ai");
      if (!enemies.length) return { error: "this world has no enemies to adjust" };
      return {
        modify: enemies.map((b) => ({
          collection: "behaviors", id: b.id,
          changes: { spec: { ...b.spec, aggro_radius: Math.max(4, Math.round((b.spec.aggro_radius || 12) * (up ? 1.6 : 0.6))), health: Math.max(20, Math.round((b.spec.health || 60) * (up ? 1.3 : 0.75))) } },
        })),
        summary: `${up ? "increased" : "reduced"} enemy pressure across ${enemies.length} enemies`,
      };
    },
  },
  {
    id: "add_boss_quest",
    match: /\b(add|create)\s+(a\s+)?boss\s*(quest|fight|battle)?\b/i,
    apply(manifest, m, text, seed) {
      const zone = (manifest.zones || []).at(-1);
      const npcAsset = (manifest.assets || []).find((a) => a.kind === "character");
      if (!zone || !npcAsset) return { error: "this world has nowhere to put a boss" };
      const r = rng(seed);
      const cx = (zone.bounds[0] + zone.bounds[2]) / 2, cz = (zone.bounds[1] + zone.bounds[3]) / 2;
      const bossId = `npc_boss_v${Number(manifest.world_version) + 1}`;
      return {
        add: {
          npcs: [{ id: bossId, name: "The Warden", role: "boss", zone: zone.id, spawn: { x: Number(cx.toFixed(2)), y: 0, z: Number(cz.toFixed(2)) }, asset_ref: npcAsset.id, behavior_ref: null, dialogue: { seed: "You should not have come here.", lines: [] }, schedule: [], faction: "hostile", stats: { health: 400 } }],
          behaviors: [{ id: `behavior_boss_${bossId}`, kind: "enemy_ai", spec: { aggro_radius: 26, damage: 22, health: 400, flee_below: 0, patrol: [{ x: Number(cx.toFixed(2)), z: Number(cz.toFixed(2)) }, { x: Number((cx + 10 * r()).toFixed(2)), z: Number((cz + 10 * r()).toFixed(2)) }] } }],
          interactions: [{ id: `interaction_boss_${bossId}`, trigger: "proximity", target_ref: bossId, behavior_ref: `behavior_boss_${bossId}`, params: { radius: 26 } }],
          quests: [{ id: `quest_boss_v${Number(manifest.world_version) + 1}`, title: "The Warden", giver_npc: null, zone: zone.id, difficulty: "hard", steps: [{ id: "step_find", kind: "reach", target: zone.id, description: `Enter ${zone.name}.` }, { id: "step_defeat", kind: "defeat", target: bossId, description: "Defeat the Warden." }], rewards: [], prerequisites: [] }],
        },
        summary: `added a boss encounter in ${zone.name}`,
      };
    },
  },
  {
    id: "add_road",
    match: /\b(add|build)\s+(a\s+)?(road|path|street|bridge)\b/i,
    apply(manifest) {
      if ((manifest.zones || []).length < 2) return { error: "a road needs two zones to connect" };
      const [a, b] = manifest.zones;
      return { navigation_links: [{ from: a.id, to: b.id, kind: "path", cost: 5 }], summary: `connected ${a.name} to ${b.name}` };
    },
  },
];

/**
 * Parse a chat edit into a delta. Returns { delta, summary } or { error }.
 * Anything not understood is reported as unrecognised rather than guessed at.
 */
export function planEdit(manifest, { request, author = null, seed = null } = {}) {
  if (!request || typeof request !== "string") throw Errors.validation("an edit needs a request");
  const text = request.trim();
  const s = seed ?? hashString(text);

  for (const intent of EDIT_INTENTS) {
    const m = intent.match.exec(text);
    if (!m) continue;
    const result = intent.apply(manifest, m, text, s);
    if (result.error) return { error: result.error, intent: intent.id };
    const delta = newDelta({ label: result.summary, author, reason: request });
    if (result.environment) delta.environment = result.environment;
    if (result.modify) delta.modify = result.modify;
    if (result.add) for (const [k, v] of Object.entries(result.add)) delta.add[k] = v;
    if (result.navigation_links) delta.navigation_links = result.navigation_links;
    return { delta, summary: result.summary, intent: intent.id };
  }

  return {
    error: "that edit was not understood",
    supported: EDIT_INTENTS.map((i) => i.id),
    hint: "try: make it rain, night mode, enlarge the tavern, more enemies, add a boss quest, add a road",
  };
}

export { DISTRICT_BLUEPRINTS, EDIT_INTENTS };
