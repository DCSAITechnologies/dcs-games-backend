// Flagship vertical slice: "Lanternfall — The Last Keeper of Ashfall Isle".
//
// An AUTHORED GameConcept (contract §1). Everything downstream of the concept —
// terrain, placements, characters, assets, gameplay, scene, package — is made by
// the same pipeline stages a typed prompt goes through. Authoring only the
// concept is deliberate: the slice then proves the generator, not a hand-built
// level that happens to share its file format.
//
// Node-side (it hashes the prompt with node:crypto); the browser never imports it.

import { promptHash } from "../common/hash.mjs";

export const FLAGSHIP_GAME_ID = "lanternfall";
export const FLAGSHIP_SEED = 1147;

export const FLAGSHIP_PROMPT = [
  "Lanternfall — The Last Keeper of Ashfall Isle.",
  "A stormy dusk island adventure. You arrive by boat at a small harbour village as a storm gathers on the horizon.",
  "Keeper Maren, the old lighthouse keeper, asks you to relight the island's three beacon lanterns before the storm makes landfall.",
  "Ember, a small fox-spirit made of warm light, follows you everywhere.",
  "The lantern cores that feed the beacons are hidden in the Sunken Ruins, at the Whispering Grove shrine and at the Cliffside Watch;",
  "hovering Stormwisp sentinels patrol the ruins and sting anyone who strays too close.",
  "Relight the three beacons, then climb to the Great Lighthouse on the summit and light it to drive the storm back.",
  "Dusk amber light against storm blue, rain, wind, the sea all around.",
].join(" ");

/** The authored concept. Pure data: a fresh object each call, so callers may mutate their copy. */
export function flagshipConcept() {
  return {
    concept_version: "1.0.0",
    title: "Lanternfall — The Last Keeper of Ashfall Isle",
    logline: "Relight Ashfall Isle's three beacons and the Great Lighthouse before the storm makes landfall.",
    source_prompt: FLAGSHIP_PROMPT,
    prompt_hash: promptHash(FLAGSHIP_PROMPT),
    seed: FLAGSHIP_SEED,
    genre: "adventure",
    biome: "island",
    scale: "medium",
    mood: "stormy dusk, lonely but hopeful — warm lantern light holding out against a blue-black storm",
    time_of_day: 0.78,
    weather: "storm",
    palette: {
      primary: "#e8913a",     // lantern amber
      secondary: "#2f4a6d",   // storm blue
      accent: "#ffd27a",      // flame gold
      ground: "#5f6e3c",      // wet moss
      sky: "#27324f",         // bruised dusk
      water: "#1f4b63",       // cold sea
    },
    player_fantasy: "The last traveller willing to carry fire up a drowning island, with a fox made of light at your heels.",
    key_locations: [
      { id: "harbour_village", name: "Ashfall Harbour", kind: "hub",
        description: "A cluster of stone cottages and lantern posts around the harbour where your boat ties up; Keeper Maren waits by the quay." },
      { id: "sunken_ruins", name: "Sunken Ruins", kind: "ruin",
        description: "Half-drowned arches and broken walls of the old keepers' hall, patrolled by Stormwisps. A lantern core lies in the rubble." },
      { id: "whispering_grove", name: "Whispering Grove", kind: "grove",
        description: "A ring of wind-bent pines around a moss-covered shrine where the first lantern core was hidden." },
      { id: "cliffside_watch", name: "Cliffside Watch", kind: "tower",
        description: "A lonely watchtower on the sea cliffs with its beacon brazier gone cold; the third core is kept there." },
      { id: "lighthouse_summit", name: "Great Lighthouse", kind: "summit",
        description: "The island's tall striped lighthouse on the summit. Light it last, once the three beacons burn, to turn the storm." },
      { id: "old_dock", name: "Old Dock", kind: "dock",
        description: "A weathered jetty on the far shore where Fisher Tomas mends his nets and trades rumours." },
    ],
    characters: [
      { id: "keeper_maren", name: "Keeper Maren", role: "quest_giver",
        description: "The island's last lighthouse keeper: grey-haired, hooded, a brass lantern always in hand. Gives the quest to relight the beacons." },
      { id: "ember", name: "Ember", role: "companion",
        description: "A small fox-spirit of warm amber light who follows the player and glows brighter near lantern cores." },
      { id: "fisher_tomas", name: "Fisher Tomas", role: "merchant",
        description: "A weathered fisherman at the old dock who trades herbs and knows where the Stormwisps roam." },
      { id: "stormwisp_a", name: "Stormwisp", role: "enemy",
        description: "A hovering storm spirit of blue lightning that patrols the Sunken Ruins and stings intruders." },
      { id: "stormwisp_b", name: "Stormwisp", role: "enemy",
        description: "A second hovering storm spirit of blue lightning circling the ruins' far wall." },
    ],
    objectives_outline: [
      "Speak with Keeper Maren at Ashfall Harbour",
      "Recover the lantern cores from the Sunken Ruins, the Whispering Grove and the Cliffside Watch",
      "Relight the three beacons",
      "Climb to the Great Lighthouse on the summit and light it",
    ],
    hazards: [
      "Stormwisp sentinels patrol the Sunken Ruins",
      "The storm makes landfall when the timer runs out",
      "Deep water around the island",
    ],
  };
}

// ---------------------------------------------------------------------------
// Story patches. The generic stages make a sound island adventure from the
// concept; these pure functions bend it to the slice's authored beats. They go
// through the pipeline's own `overrides` hook, so every later stage (characters,
// assets, gameplay, scene, validation, playtest) runs on the patched data, and a
// patch that breaks the world is caught by the same gates as any other build.

const clone = (v) => JSON.parse(JSON.stringify(v));
const BEACONS = ["ix_sunken_ruins", "ix_whispering_grove", "ix_cliffside_watch"];
const CORE_REGIONS = ["region_sunken_ruins", "region_whispering_grove", "region_cliffside_watch"];

/**
 * World: three lantern cores (one per beacon site, none at the summit or dock),
 * the ruins' focal point becomes a beacon brazier, and both Stormwisps patrol
 * the Sunken Ruins.
 * @param {object} world WorldSpec from generateWorldSpec
 * @param {{ sampleHeight?: Function, isWalkable?: Function, pointInCollider?: Function }} [tools]
 */
export function flagshipWorldPatch(world, tools = {}) {
  const w = clone(world);
  const byId = (arr, id) => arr.find((x) => x.id === id);

  // Cores: keep the pickups that sit in the three beacon regions, drop the rest.
  const pickups = w.interactables.filter((ix) => ix.kind === "pickup");
  const regionOf = (ix) => byId(w.placements, ix.placement_ref)?.region;
  const keep = new Set(pickups.filter((ix) => CORE_REGIONS.includes(regionOf(ix))).map((ix) => ix.id));
  if (keep.size >= 3) {
    const drop = pickups.filter((ix) => !keep.has(ix.id));
    const dropPl = new Set(drop.map((ix) => ix.placement_ref));
    w.interactables = w.interactables.filter((ix) => !drop.includes(ix));
    w.placements = w.placements.filter((p) => !dropPl.has(p.id));
  }

  // Beacon sites and the lighthouse, with prompts that say what the player is doing.
  const prompts = {
    ix_sunken_ruins: "Relight the ruin beacon",
    ix_whispering_grove: "Rekindle the grove shrine",
    ix_cliffside_watch: "Relight the watch beacon",
    ix_lighthouse_summit: "Light the Great Lighthouse",
    ix_harbour_village: "Read the harbour notice board",
    ix_old_dock: "Read Tomas's tide chart",
  };
  for (const [id, prompt] of Object.entries(prompts)) { const ix = byId(w.interactables, id); if (ix) ix.prompt = prompt; }
  const ruins = byId(w.interactables, "ix_sunken_ruins");
  const ruinsPl = ruins && byId(w.placements, ruins.placement_ref);
  if (ruins && ruinsPl) {
    ruins.kind = "lantern";
    ruinsPl.asset_ref = "lib:beacon_brazier";
    ruinsPl.collider = { shape: "cylinder", radius: 0.9, height: 1.6, solid: true };
    ruinsPl.tags = [...new Set([...(ruinsPl.tags || []), "beacon"])];
    // The brazier is wider than the chest it replaces: block the nav cells it now
    // covers (grown by the player radius, as the world stage's bake does) so the
    // grid never plans a path through it.
    const nav = w.navigation;
    const reach = 0.9 + 0.5;
    const cells = nav.walkable.split("");
    const i0 = Math.max(0, Math.floor((ruinsPl.position.x - reach) / nav.cell)), i1 = Math.min(nav.cols - 1, Math.floor((ruinsPl.position.x + reach) / nav.cell));
    const j0 = Math.max(0, Math.floor((ruinsPl.position.z - reach) / nav.cell)), j1 = Math.min(nav.rows - 1, Math.floor((ruinsPl.position.z + reach) / nav.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = (i + 0.5) * nav.cell, cz = (j + 0.5) * nav.cell;
      if (Math.hypot(cx - ruinsPl.position.x, cz - ruinsPl.position.z) < reach) cells[j * nav.cols + i] = "0";
    }
    nav.walkable = cells.join("");
  }

  // Stormwisps: move their spawns into the ruins so their patrol loops circle it.
  const region = byId(w.regions, "region_sunken_ruins");
  if (region) {
    const [x0, z0, x1, z1] = region.bounds;
    const cx = region.center.x, cz = region.center.z;
    const ok = (x, z) => {
      if (tools.isWalkable && !tools.isWalkable(w.navigation, x, z)) return false;
      if (tools.pointInCollider && tools.pointInCollider(tools.colliders || [], x, z, 1)) return false;
      return x > x0 + 3 && x < x1 - 3 && z > z0 + 3 && z < z1 - 3;
    };
    const spots = [];
    for (let r = 6; r <= 14 && spots.length < 8; r += 2) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const x = Math.round((cx + Math.cos(a) * r) * 100) / 100, z = Math.round((cz + Math.sin(a) * r) * 100) / 100;
        if (ok(x, z)) spots.push({ x, z });
      }
    }
    const wisps = w.spawn_points.filter((s) => /^spawn_npc_stormwisp/.test(s.id));
    wisps.forEach((s, i) => {
      const p = spots[(i * Math.max(1, Math.floor(spots.length / 2))) % Math.max(1, spots.length)];
      if (!p) return;
      s.position = { x: p.x, y: tools.sampleHeight ? Math.round(tools.sampleHeight(w.terrain, p.x, p.z) * 100) / 100 : s.position.y, z: p.z };
      s.region = "region_sunken_ruins";
    });
  }
  return w;
}

/**
 * Gameplay: talk to Maren → recover three cores → relight three beacons → light
 * the Great Lighthouse → win. A 20-minute storm timer is the other way to lose.
 * The Old Dock and the side characters stay as optional content.
 */
export function flagshipGameplayPatch(gameplay) {
  const g = clone(gameplay);
  g.rules.time_limit_s = 1200;
  if (!g.lose_conditions.some((l) => l.kind === "time_expired")) g.lose_conditions.push({ kind: "time_expired" });
  const objs = new Map(g.objectives.map((o) => [o.id, o]));
  const itemFor = (ixId) => (g.objectives.find((o) => o.id === `activate_${ixId.replace(/^ix_/, "")}`)?.requires || []).find((r) => r.startsWith("collect_"));

  const titles = {
    talk_keeper_maren: ["Speak with Keeper Maren", "She waits on the harbour quay with her lantern."],
    activate_sunken_ruins: ["Relight the Sunken Ruins beacon", "Bring its core to the brazier among the drowned arches. Mind the Stormwisps."],
    activate_whispering_grove: ["Rekindle the Whispering Grove shrine", "Set the grove's core on the mossy altar."],
    activate_cliffside_watch: ["Relight the Cliffside Watch beacon", "Climb the sea cliffs to the old watchtower."],
    activate_lighthouse_summit: ["Light the Great Lighthouse", "With all three beacons burning, climb to the summit and light the lamp."],
  };
  for (const [id, [title, description]] of Object.entries(titles)) if (objs.has(id)) Object.assign(objs.get(id), { title, description });

  // Cores for the three beacons stay required; any other core objective is dropped.
  const coreObjs = BEACONS.map(itemFor).filter(Boolean);
  const coreNames = ["Sunken Ruins", "Whispering Grove", "Cliffside Watch"];
  coreObjs.forEach((id, i) => { const o = objs.get(id); if (o) Object.assign(o, { title: `Recover the ${coreNames[i]} lantern core`, optional: false }); });
  const lighthouse = objs.get("activate_lighthouse_summit");
  if (lighthouse) lighthouse.requires = BEACONS.map((ix) => `activate_${ix.replace(/^ix_/, "")}`).filter((id) => objs.has(id));
  for (const o of g.objectives) {
    if (o.kind === "collect" && !coreObjs.includes(o.id)) o.optional = true;
    if (/old_dock/.test(o.id)) { o.optional = true; o.requires = (o.requires || []).filter((r) => objs.has(r) && !/lighthouse|collect_/.test(r)); }
  }
  // Objectives whose target no longer exists (a dropped core) are removed with anything that required only them.
  const items = new Set(g.inventory.items.map((i) => i.id));
  g.objectives = g.objectives.filter((o) => o.kind !== "collect" || items.has(o.target_ref));
  const alive = new Set(g.objectives.map((o) => o.id));
  for (const o of g.objectives) o.requires = (o.requires || []).filter((r) => alive.has(r));
  g.events = g.events.filter((e) => !(e.trigger?.kind?.startsWith("objective") && e.trigger.ref && !alive.has(e.trigger.ref)));

  // Story beats.
  const say = (id, ref, text, extra = []) => {
    g.events = g.events.filter((e) => e.id !== id);
    g.events.push({ id, once: true, trigger: { kind: "objective_complete", ref }, actions: [{ kind: "message", value: text }, ...extra] });
  };
  if (alive.has("talk_keeper_maren")) say("ev_briefed", "talk_keeper_maren",
    "Keeper Maren: \"Three beacons, three cores — the ruins, the grove, the cliffs. Then the Great Lighthouse. Hurry, the storm won't wait.\"",
    CORE_REGIONS.map((ref) => ({ kind: "reveal", ref })).concat([{ kind: "reveal", ref: "region_lighthouse_summit" }]));
  const beaconsLit = BEACONS.map((ix) => `activate_${ix.replace(/^ix_/, "")}`).filter((id) => alive.has(id));
  beaconsLit.forEach((id, i) => {
    const prev = g.events.find((e) => e.trigger?.ref === id);
    const extra = (prev?.actions || []).filter((a) => a.kind === "checkpoint" || a.kind === "set_flag");
    say(`ev_lit_${i + 1}`, id, `A beacon flares to life — ${i + 1} of 3 burning.`, extra);
  });
  if (alive.has("activate_lighthouse_summit")) {
    say("ev_finale", "activate_lighthouse_summit", "The Great Lighthouse blazes across the water. The storm breaks against the light — Ashfall Isle is saved.",
      [{ kind: "set_weather", value: "rain" }, { kind: "set_flag", ref: "finale_complete", value: true }]);
  }
  g.events.push({ id: "ev_storm_warning", once: true, trigger: { kind: "timer", value: 900 }, actions: [{ kind: "message", value: "Thunder rolls closer. Five minutes until the storm makes landfall." }] });
  g.win_conditions = [{ kind: "all_required_objectives" }];
  return g;
}

/**
 * Characters: Ember is a fox (a quadruped creature glowing amber), not the
 * generic hovering spirit the word "spirit" selects; the Stormwisps are cold
 * blue hovering spirits, so the two read as opposites at a glance.
 */
export function flagshipCharactersPatch(characters) {
  const c = clone(characters);
  for (const ch of c.characters) {
    if (ch.id === "ember") {
      ch.kind = "creature";
      ch.body = { ...ch.body, height: 0.55, build: "slim", locomotion: "quadruped", glow: "#ffb347",
        palette: { skin: "#ffe2b0", primary: "#e8822c", secondary: "#fff0d8", accent: "#ffd27a" }, accessories: ["scarf"] };
    } else if (/^stormwisp/.test(ch.id)) {
      ch.kind = "spirit";
      ch.body = { ...ch.body, locomotion: "hover", glow: "#7fd0ff", accessories: [],
        palette: { skin: "#dff4ff", primary: "#4a7fb8", secondary: "#18263a", accent: "#9fe0ff" } };
    }
  }
  return c;
}
