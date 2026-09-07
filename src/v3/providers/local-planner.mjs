// B1 — the deterministic local planner. This is the FALLBACK every text lane
// ends in, and it is also what CI runs, so it has to produce a genuinely
// playable world rather than a placeholder.
//
// It is seeded, so the same prompt always yields the same world — which is what
// makes the B4 playtest and the B14 end-to-end proof reproducible.
//
// Deliberately NOT a fixed skeleton with flavour text bolted on. That was the
// Round-2 finding about the old generator: the model was never asked to build
// geometry, so every world came out the same shape. Here the prompt drives the
// archetype, the district plan, the building mix, the NPC roles and the quest
// chain, and the layout is grown from a road network rather than a grid.

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ------------------------------------------------------------------ archetypes
//
// Each archetype changes the district plan, the building mix, the NPC roles and
// the quest chain, so two different prompts produce two different worlds.

const ARCHETYPES = {
  port: {
    // Word-boundary anchored on purpose: an unanchored /sea/ matched "research",
    // which classified an orbital research station as a fishing port.
    match: /\b(ports?|harbou?rs?|docks?|fishing|fisher|nordic|coastal|sea|seas|marina|bay|quay|wharf)\b/i,
    genre: "adventure", weather: "rain", time: 0.68,
    districts: ["docks", "old_town", "market", "lighthouse_point", "warehouses"],
    buildings: ["warehouse", "fish_market", "tavern", "harbourmaster_office", "cottage", "boathouse", "chapel", "crane"],
    npcRoles: ["harbourmaster", "fisher", "merchant", "dockhand", "smuggler", "sailor"],
    items: ["brass_hook", "salt_cod", "harbour_ledger", "rope_coil", "lantern"],
    palette: { ground: "#3a4550", accent: "#6b8ba4" },
  },
  city: {
    match: /\b(city|cities|urban|metropolis|downtown|streets?|districts?|neon|cyber(punk)?)\b/i,
    genre: "openworld", weather: "cloudy", time: 0.82,
    districts: ["downtown", "residential", "industrial", "transit_hub", "park", "rooftops"],
    buildings: ["tower", "apartment_block", "office", "shop", "diner", "parking_structure", "clinic", "substation"],
    npcRoles: ["courier", "vendor", "officer", "engineer", "broker", "medic"],
    items: ["keycard", "transit_pass", "toolkit", "data_shard", "coffee"],
    palette: { ground: "#2b2f3a", accent: "#22d3ee" },
  },
  fantasy: {
    match: /\b(fantasy|dragons?|castles?|kingdoms?|magic|magical|elves|elf|dwarf|dwarves|realms?|myth|mythic)\b/i,
    genre: "fantasy", weather: "fog", time: 0.35,
    districts: ["keep", "lower_ward", "market_square", "shrine_grounds", "outer_fields"],
    buildings: ["keep_hall", "smithy", "apothecary", "shrine", "longhouse", "watchtower", "granary", "stable"],
    npcRoles: ["captain", "smith", "herbalist", "priest", "farmer", "wanderer"],
    items: ["iron_key", "healing_draught", "sigil_stone", "banner", "grain_sack"],
    palette: { ground: "#3b2f1a", accent: "#a78bfa" },
  },
  horror: {
    match: /\b(horror|haunted|zombies?|blackout|dead|undead|nightmares?|asylum|manor|cursed)\b/i,
    genre: "horror", weather: "fog", time: 0.02,
    districts: ["entrance_hall", "east_wing", "basement", "grounds", "chapel_ruin"],
    buildings: ["manor_wing", "shed", "mausoleum", "greenhouse", "generator_room", "well", "gatehouse"],
    npcRoles: ["survivor", "caretaker", "stalker", "radio_voice", "lost_child_synthetic"],
    items: ["fuse", "old_key", "flashlight", "journal_page", "medkit"],
    palette: { ground: "#1f2933", accent: "#7f1d1d" },
  },
  scifi: {
    match: /\b(space|sci-?fi|stations?|mars|orbital|orbit|colony|colonies|quantum|aliens?|starship)\b/i,
    genre: "scifi", weather: "clear", time: 0.5,
    districts: ["command_deck", "habitation_ring", "hydroponics", "engineering", "docking_bay"],
    buildings: ["command_module", "habitat_pod", "greenhouse_dome", "reactor_housing", "airlock", "comms_array", "cargo_rack"],
    npcRoles: ["commander", "botanist", "engineer", "medic", "security", "drone"],
    items: ["access_chip", "oxygen_cell", "repair_kit", "sample_vial", "ration"],
    palette: { ground: "#1e293b", accent: "#38bdf8" },
  },
  wilderness: {
    match: /\b(forests?|jungles?|islands?|mountains?|deserts?|survival|frontier|wilds?|wilderness|expeditions?)\b/i,
    genre: "survival", weather: "clear", time: 0.45,
    districts: ["camp", "riverbank", "deep_woods", "ridge", "ruins"],
    buildings: ["shelter", "watch_platform", "cache", "ruin_arch", "bridge", "campfire_ring", "trapper_hut"],
    npcRoles: ["guide", "trapper", "ranger", "hermit", "scavenger"],
    items: ["flint", "waterskin", "map_fragment", "snare", "dried_meat"],
    palette: { ground: "#2f3d24", accent: "#22c55e" },
  },
};

const DEFAULT_ARCHETYPE = {
  genre: "adventure", weather: "clear", time: 0.5,
  // Five, because districtCount runs 3..5. Every named archetype already has at
  // least five; this one had four, so any world that fell back to the default
  // and rolled a 5-district layout wrapped round to "central" a second time.
  districts: ["central", "north_quarter", "south_quarter", "outskirts", "riverside"],
  buildings: ["hall", "house", "workshop", "store", "tower", "shed"],
  npcRoles: ["guide", "merchant", "guard", "resident"],
  items: ["key", "satchel", "note", "tool"],
  palette: { ground: "#33383f", accent: "#8b93a7" },
};

export function archetypeFor(prompt) {
  for (const [name, a] of Object.entries(ARCHETYPES)) {
    if (a.match.test(prompt || "")) return { name, ...a };
  }
  return { name: "generic", ...DEFAULT_ARCHETYPE };
}

const titleCase = (s) => String(s).split(/[_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/**
 * Grow a world plan from a prompt.
 * Returns the same shape the architect lane's system prompt specifies, so the
 * router treats a model result and this result identically.
 */
export function planWorldLocally(req = {}) {
  const prompt = req.prompt || "an unnamed place";
  const seed = req.seed ?? hashString(prompt);
  const r = rng(seed);
  const A = archetypeFor(prompt);

  const districtCount = 3 + Math.floor(r() * 3);          // 3..5
  const size = { w: 220 + Math.floor(r() * 200), h: 220 + Math.floor(r() * 200) };

  // --- districts: irregular strips off a spine, not an even grid ------------
  const zones = [];
  let cursorX = 12;
  // Uniqueness is enforced here rather than trusted from the archetype lists:
  // `i % length` wraps, and a duplicate zone id fails WorldManifestV3, which is
  // a 500 on generate — the whole world lost to a name collision. Seed 20 on
  // the default archetype produced `zone_central` twice, deterministically.
  const usedZoneIds = new Set();
  for (let i = 0; i < districtCount; i++) {
    const base = A.districts[i % A.districts.length];
    let name = base, n = 1;
    while (usedZoneIds.has(`zone_${name}`)) name = `${base}_${++n}`;
    usedZoneIds.add(`zone_${name}`);
    const w = Math.floor((size.w - 24) / districtCount * (0.72 + r() * 0.55));
    const depth = Math.floor(size.h * (0.42 + r() * 0.45));
    const zTop = Math.floor(r() * (size.h - depth - 10)) + 5;
    const maxX = Math.min(cursorX + w, size.w - 6);
    if (maxX - cursorX < 40) break;
    zones.push({
      id: `zone_${name}`,
      name: titleCase(name),
      kind: i === 0 ? "district" : (name.includes("point") || name.includes("ruin") ? "landmark" : "district"),
      bounds: [cursorX, zTop, maxX, Math.min(zTop + depth, size.h - 4)],
      description: `${titleCase(name)} of ${titleCase(A.name)}`,
      density: Number((0.4 + r() * 0.6).toFixed(2)),
    });
    cursorX = maxX + 6 + Math.floor(r() * 10);
  }
  if (!zones.length) {
    zones.push({ id: "zone_central", name: "Central", kind: "district", bounds: [8, 8, size.w - 8, size.h - 8], description: "Central area", density: 0.6 });
  }

  // --- structures: laid along a road running through each district ----------
  const structures = [];
  const roads = [];
  let sIdx = 0;
  for (const z of zones) {
    const [x0, z0, x1, z1] = z.bounds;
    const midZ = (z0 + z1) / 2;
    roads.push({ id: `road_${z.id}`, zone: z.id, from: { x: x0 + 4, z: midZ }, to: { x: x1 - 4, z: midZ }, width: 6 });
    const count = Math.max(2, Math.round(((x1 - x0) / 26) * z.density));
    for (let i = 0; i < count; i++) {
      const along = x0 + 8 + ((x1 - x0 - 16) * (i + 0.5)) / count + (r() - 0.5) * 6;
      const side = r() < 0.5 ? -1 : 1;
      const off = 8 + r() * ((z1 - z0) / 2 - 12);
      const pz = midZ + side * Math.max(7, off);
      if (pz < z0 + 3 || pz > z1 - 3) continue;
      const archetype = A.buildings[Math.floor(r() * A.buildings.length)];
      const bw = 6 + r() * 10, bd = 6 + r() * 10, bh = 4 + r() * (archetype.includes("tower") || archetype.includes("keep") ? 22 : 8);
      structures.push({
        id: `struct_${archetype}_${sIdx++}`,
        zone: z.id,
        archetype,
        position: { x: Number(along.toFixed(2)), y: 0, z: Number(pz.toFixed(2)) },
        footprint: { w: Number(bw.toFixed(2)), d: Number(bd.toFixed(2)), h: Number(bh.toFixed(2)) },
        rotation_y: Number((r() * Math.PI * 2).toFixed(3)),
        enterable: r() < 0.45,
        purpose: titleCase(archetype),
      });
    }
  }

  // --- npcs: one per role, placed inside a district -------------------------
  const npcs = [];
  const npcCount = Math.min(A.npcRoles.length, 4 + Math.floor(r() * 3));
  for (let i = 0; i < npcCount; i++) {
    const role = A.npcRoles[i % A.npcRoles.length];
    const z = zones[i % zones.length];
    const [x0, z0, x1, z1] = z.bounds;
    npcs.push({
      id: `npc_${role}`,
      name: titleCase(role),
      role,
      zone: z.id,
      position: {
        x: Number((x0 + 10 + r() * Math.max(1, x1 - x0 - 20)).toFixed(2)),
        y: 0,
        z: Number((z0 + 10 + r() * Math.max(1, z1 - z0 - 20)).toFixed(2)),
      },
      behavior: ["idle", "patrol", "vendor", "guard", "wander"][Math.floor(r() * 5)],
      dialogue_seed: `${titleCase(role)} of ${z.name}`,
    });
  }

  // --- items ----------------------------------------------------------------
  const items = A.items.slice(0, 3 + Math.floor(r() * 3)).map((k) => ({ id: `item_${k}`, name: titleCase(k), kind: k }));

  // --- quests: every step targets something that exists ---------------------
  const quests = [];
  const enterable = structures.filter((s) => s.enterable);
  if (npcs.length && items.length) {
    quests.push({
      id: "quest_arrival",
      title: `Arrival at ${titleCase(A.districts[0] || "the town")}`,
      giver_npc: npcs[0].id,
      difficulty: "easy",
      steps: [
        { id: "step_meet", kind: "talk", target: npcs[0].id, description: `Speak to ${npcs[0].name}.` },
        { id: "step_explore", kind: "reach", target: zones[Math.min(1, zones.length - 1)].id, description: `Reach ${zones[Math.min(1, zones.length - 1)].name}.` },
        { id: "step_find", kind: "collect", target: items[0].id, description: `Recover the ${items[0].name}.` },
      ],
    });
  }
  if (npcs.length > 1 && (enterable.length || structures.length)) {
    const target = (enterable[0] || structures[0]);
    quests.push({
      id: "quest_errand",
      title: `${npcs[1].name}'s Errand`,
      giver_npc: npcs[1].id,
      difficulty: "normal",
      steps: [
        { id: "step_brief", kind: "talk", target: npcs[1].id, description: `Ask ${npcs[1].name} what they need.` },
        { id: "step_enter", kind: "activate", target: target.id, description: `Get inside the ${titleCase(target.archetype)}.` },
        { id: "step_return", kind: "deliver", target: npcs[0].id, description: `Bring word back to ${npcs[0].name}.` },
      ],
    });
  }

  return {
    title: req.title || titleCase(prompt.split(/[,.]/)[0].slice(0, 48).trim() || "New World"),
    genre: A.genre,
    style: A.name,
    maturity: A.genre === "horror" ? "16+" : "13+",
    size,
    environment: { weather: A.weather, time_of_day: A.time },
    palette: A.palette,
    zones,
    roads,
    structures,
    npcs,
    items,
    quests,
    gameplay_loop: `Explore ${zones.length} districts, talk to ${npcs.length} inhabitants, complete ${quests.length} quests, and recover key items.`,
    expansion_hooks: (ARCHETYPES[A.name]?.districts || DEFAULT_ARCHETYPE.districts).slice(districtCount, districtCount + 3).map(titleCase),
    _model: "deterministic",
  };
}

// ------------------------------------------------------------- classification

// Word-boundary anchored for the same reason as the archetype matchers above.
const GENRE_WORDS = {
  horror: /\b(horror|haunted|zombies?|dead|undead|nightmares?|blood|asylum|scary)\b/i,
  survival: /\b(survival|forests?|islands?|scavenge|hunger|frontier|wilds?|wilderness)\b/i,
  scifi: /\b(space|sci-?fi|stations?|mars|orbital|orbit|aliens?|robots?|quantum)\b/i,
  fantasy: /\b(fantasy|dragons?|castles?|magic|magical|kingdoms?|elf|elves|myth|swords?)\b/i,
  racing: /\b(racing|race|drift|circuit|rally|speed)\b/i,
  puzzle: /\b(puzzles?|maze|riddles?|logic)\b/i,
  openworld: /\b(city|cities|urban|open world|sandbox|metropolis)\b/i,
  adventure: /\b(adventures?|quests?|explore|journey|expeditions?|ports?|harbou?rs?)\b/i,
};

export function classifyLocally(req = {}) {
  const text = `${req.title || ""} ${req.prompt || ""} ${(req.zones || []).map((z) => z.name || "").join(" ")}`;
  let genre = "adventure";
  for (const [g, re] of Object.entries(GENRE_WORDS)) {
    if (re.test(text)) { genre = g; break; }
  }
  const tags = Array.from(new Set(
    String(text).toLowerCase().match(/[a-z]{4,}/g) || []
  )).filter((w) => !["this", "that", "with", "from", "have", "will", "your", "world", "game"].includes(w)).slice(0, 8);
  return {
    genre,
    tags,
    maturity: genre === "horror" ? "16+" : "13+",
    mood: genre === "horror" ? "tense" : genre === "scifi" ? "clinical" : "open",
    summary: (req.prompt || "").slice(0, 140),
    _model: "deterministic",
  };
}

// ------------------------------------------------------------------ behaviours

/**
 * Give a world real interactive behaviour without a model.
 * Everything produced here is a declarative spec the runtime interprets — no
 * generated code is ever executed in a player's browser.
 */
export function behaviorsLocally(req = {}) {
  // This is the FALLBACK — the lane's last adapter, and the reason
  // "no lane may hard-depend on any single vendor" is true. If it throws there
  // is nothing behind it: Lane.run reports "every adapter failed" and the whole
  // generation returns a 500.
  //
  // It threw. `n.position.x` assumed every NPC carries a position, which is
  // what the architect's declared schema promises — and a model omitting it on
  // one character out of six is an entirely ordinary thing for a model to do.
  // The upstream adapters check only that `zones` and `structures` are arrays,
  // so nothing between the model and here would have caught it.
  //
  // Rows that are not objects with an id are dropped, and coordinates that are
  // not numbers are read as zero. The point of a deterministic fallback is that
  // it always produces something; being strict about its input defeats it.
  const isRow = (x) => x !== null && typeof x === "object" && typeof x.id === "string" && x.id !== "";
  const at = (q) => ({
    x: typeof q?.x === "number" && Number.isFinite(q.x) ? q.x : 0,
    z: typeof q?.z === "number" && Number.isFinite(q.z) ? q.z : 0,
  });
  const structures = (Array.isArray(req.structures) ? req.structures : []).filter(isRow);
  const npcs = (Array.isArray(req.npcs) ? req.npcs : []).filter(isRow);
  const items = (Array.isArray(req.items) ? req.items : []).filter(isRow);
  const zones = (Array.isArray(req.zones) ? req.zones : []).filter(isRow);

  const r = rng(req.seed ?? hashString(JSON.stringify(structures.map((x) => x.id))));
  const behaviors = [];
  const interactions = [];

  const enterable = structures.filter((s) => s.enterable);
  const lockItem = items[0]?.id || null;

  // Doors on everything enterable — the single most noticeable interaction.
  enterable.forEach((s, i) => {
    const id = `behavior_door_${i}`;
    behaviors.push({
      id, kind: "door",
      spec: { opens: r() < 0.5 ? "inward" : "outward", speed: Number((1 + r()).toFixed(2)), locked_by: i === 0 && lockItem ? lockItem : null, auto_close_s: 6 },
    });
    interactions.push({ id: `interaction_door_${i}`, trigger: "interact", target_ref: s.id, behavior_ref: id, params: { prompt: "Open" } });
  });

  // A working lift wherever a tall structure exists.
  const tall = structures.filter((s) => Number.isFinite(s.footprint?.h) && s.footprint.h > 12);
  if (tall.length) {
    behaviors.push({ id: "behavior_elevator_main", kind: "elevator", spec: { floors: [0, 6, 12, Math.round(tall[0].footprint.h)], speed: 2.2, call_from: zones.slice(0, 2).map((z) => z.id) } });
    interactions.push({ id: "interaction_elevator_main", trigger: "interact", target_ref: tall[0].id, behavior_ref: "behavior_elevator_main", params: { prompt: "Call lift" } });
  }

  // A driveable vehicle, parked on a road.
  if (structures.length > 3) {
    behaviors.push({ id: "behavior_vehicle_runabout", kind: "vehicle", spec: { seats: 2, max_speed: 22, acceleration: 6.5, handling: 0.72, enterable: true } });
    interactions.push({ id: "interaction_vehicle_runabout", trigger: "interact", target_ref: structures[2].id, behavior_ref: "behavior_vehicle_runabout", params: { prompt: "Drive" } });
  }

  // NPC routines, and hostiles where the genre calls for it.
  npcs.forEach((n, i) => {
    const hostile = n.behavior === "hostile" || /stalker|scavenger|smuggler/.test(n.role || "");
    const id = `behavior_npc_${n.id}`;
    // Where the character stands, when the model said so. An NPC with no
    // position is still a character worth wiring up; its routine simply starts
    // at the origin rather than taking the whole generation down.
    const p = at(n.position || n.spawn);
    if (hostile) {
      behaviors.push({
        id, kind: "enemy_ai",
        spec: {
          aggro_radius: 14 + Math.round(r() * 8), damage: 6 + Math.round(r() * 6), health: 60 + Math.round(r() * 40), flee_below: 0.2,
          patrol: [
            { x: p.x, z: p.z },
            { x: Number((p.x + 12 - r() * 24).toFixed(2)), z: Number((p.z + 12 - r() * 24).toFixed(2)) },
          ],
        },
      });
    } else {
      behaviors.push({
        id, kind: "npc_ai",
        spec: {
          routine: n.behavior || "idle",
          waypoints: [{ x: p.x, z: p.z }, { x: Number((p.x + 8).toFixed(2)), z: Number((p.z + 6).toFixed(2)) }],
          dialogue_topics: [n.role || "greeting", "directions", "the world"],
        },
      });
    }
    interactions.push({ id: `interaction_npc_${n.id}`, trigger: hostile ? "proximity" : "interact", target_ref: n.id, behavior_ref: id, params: hostile ? { radius: 14 } : { prompt: "Talk" } });
  });

  // Pickups for every item, so a collect step is actually completable.
  items.forEach((it, i) => {
    const host = structures[(i * 3 + 1) % Math.max(1, structures.length)];
    behaviors.push({ id: `behavior_pickup_${it.id}`, kind: "pickup", spec: { item: it.id, respawn_s: null } });
    if (host) interactions.push({ id: `interaction_pickup_${it.id}`, trigger: "proximity", target_ref: host.id, behavior_ref: `behavior_pickup_${it.id}`, params: { radius: 3 } });
  });

  return { behaviors, interactions, _model: "deterministic" };
}
