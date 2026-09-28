// Games-D level layouts (CONTRACT §3, owned by the mission/level-variety lane). ISOMORPHIC.
//
// A layout decides how many key locations a game has, which kinds they lean
// towards, and how the world stage arranges them (concept.layout_ordering,
// read by layoutRegions() in src/gamesb/world/world-spec.mjs):
//
//   linear    — the historic Games-B placement (hub central, sites spread out)
//   hub_spoke — hub at the centre, every site on a ring round it (a star of paths)
//   loop      — hub and sites on one ring, and the ring is closed by an extra path
//   gauntlet  — a long zig-zag chain; the finale sits at the far end of the map
//   cluster   — every site packed tightly round the hub
//
// Linear layouts set no layout_ordering, so their worlds are laid out exactly
// as a plain Games-B world with the same concept.
//
// layoutConceptPatch(concept, ctx) rewrites concept.key_locations: the hub
// first, the most dramatic site (the finale) last, unique slug ids, kinds from
// the Games-B §1 enum and names flavoured by the theme. Pure and deterministic.

export const LOCATION_KINDS = Object.freeze(["hub", "landmark", "ruin", "shrine", "camp", "cave", "tower", "village", "dock", "summit", "grove"]);
export const ORDERINGS = Object.freeze(["linear", "hub_spoke", "loop", "gauntlet", "cluster"]);

// Same ranking as the Games-B local concept generator: higher = later.
const DRAMA = { hub: 0, camp: 1, dock: 1, village: 1, grove: 2, cave: 2, ruin: 3, landmark: 4, shrine: 4, tower: 5, summit: 5 };

const L = (o) => Object.freeze({ ...o, kinds: Object.freeze(o.kinds), finale_kinds: Object.freeze(o.finale_kinds), keywords: Object.freeze(o.keywords) });

export const LAYOUTS = Object.freeze({
  compact_trail: L({
    id: "compact_trail", name: "Compact trail", scale: "small", locations: 4, ordering: "linear",
    summary: "A short hop: hub, two stops and a nearby finale. Good for quick sessions.",
    kinds: ["camp", "grove", "cave", "ruin", "tower"], finale_kinds: ["tower", "shrine", "ruin"],
    keywords: ["compact", "short", "quick", "tiny", "trail", "bite sized", "brief"],
  }),
  classic: L({
    id: "classic", name: "Classic hub and trail", scale: "medium", locations: 5, ordering: "linear",
    summary: "The Games-B default: a central hub and four sites spread across the map.",
    kinds: ["camp", "cave", "ruin", "shrine", "grove", "landmark"], finale_kinds: ["tower", "summit", "shrine"],
    keywords: ["classic", "standard", "journey", "traditional"],
  }),
  hub_spoke: L({
    id: "hub_spoke", name: "Hub and spokes", scale: "medium", locations: 6, ordering: "hub_spoke",
    summary: "Five sites on a ring round a central hub; every trail starts at home.",
    kinds: ["camp", "cave", "ruin", "shrine", "grove", "tower"], finale_kinds: ["landmark", "shrine", "tower"],
    keywords: ["hub", "spoke", "spokes", "central", "radial", "star", "base camp", "wheel"],
  }),
  grand_loop: L({
    id: "grand_loop", name: "Grand loop", scale: "large", locations: 6, ordering: "loop",
    summary: "A wide circuit: set out from the hub, visit every site round the ring, and the finale leads back home.",
    kinds: ["camp", "dock", "grove", "cave", "ruin", "landmark"], finale_kinds: ["summit", "tower", "shrine"],
    keywords: ["loop", "circuit", "round trip", "ring", "grand", "circle", "tour", "lap", "roundabout"],
  }),
  gauntlet: L({
    id: "gauntlet", name: "Gauntlet run", scale: "medium", locations: 5, ordering: "gauntlet",
    summary: "One long zig-zag chain across the map; the finale waits at the far end.",
    kinds: ["camp", "cave", "ruin", "grove", "landmark"], finale_kinds: ["summit", "tower"],
    keywords: ["gauntlet", "chain", "long", "march", "trek", "expedition", "corridor", "far", "pilgrimage"],
  }),
  outpost_cluster: L({
    id: "outpost_cluster", name: "Outpost cluster", scale: "small", locations: 5, ordering: "cluster",
    summary: "A tight knot of sites round the hub: short walks, dense action.",
    kinds: ["camp", "ruin", "cave", "grove", "dock"], finale_kinds: ["tower", "landmark"],
    keywords: ["outpost", "cluster", "compound", "settlement", "fort", "town", "dense", "arena", "siege"],
  }),
  archipelago_hop: L({
    id: "archipelago_hop", name: "Archipelago hop", scale: "large", locations: 6, ordering: "hub_spoke",
    summary: "Far-flung sites spread round a central harbour; best on water themes.",
    kinds: ["dock", "grove", "cave", "ruin", "camp", "landmark"], finale_kinds: ["shrine", "summit", "tower"],
    biomes: ["island"],
    keywords: ["archipelago", "islands", "island hopping", "hop", "hopping", "harbour", "harbor", "sail", "sailing"],
  }),
});

export const LAYOUT_IDS = Object.freeze(Object.keys(LAYOUTS));

// ----------------------------------------------------------------- naming

// Biome-flavoured names per kind (after the Games-B LOC_POOL), two per kind
// where possible so repeated kinds still get distinct names.
const NAMES = {
  island: { tower: ["Old Lighthouse", "Gull Beacon"], dock: ["Broken Pier", "Driftwood Quay"], cave: ["Sea Cave", "Blowhole Grotto"], shrine: ["Tide Shrine", "Shell Altar"], summit: ["Gull Peak", "Storm Crest"], ruin: ["Sunken Ruins", "Wreck of the Heron"], grove: ["Palm Grove", "Mangrove Tangle"], camp: ["Castaway Camp", "Beachcomber Camp"], village: ["Stilt Village"], landmark: ["Whale Arch", "Kelp Stones"] },
  forest: { grove: ["Elder Grove", "Fern Glade"], ruin: ["Overgrown Keep", "Mossy Mill"], cave: ["Root Hollow", "Badger Den"], shrine: ["Moon Shrine", "Antler Altar"], tower: ["Ranger Tower", "Owl Lookout"], village: ["Treetop Village"], summit: ["Crown Hill", "Hawk Tor"], camp: ["Woodcutter Camp", "Hunter's Lodge"], dock: ["Mill Pond Jetty"], landmark: ["Great Stump", "Standing Stones"] },
  desert: { ruin: ["Buried Palace", "Sunken Caravanserai"], camp: ["Nomad Camp", "Salt Traders' Camp"], cave: ["Scorpion Grotto", "Wind Cave"], shrine: ["Sun Shrine", "Mirage Altar"], landmark: ["Great Obelisk", "Sphinx Head"], tower: ["Watchtower", "Signal Minaret"], summit: ["Dune Crest", "Glass Ridge"], grove: ["Date Palm Oasis"], village: ["Mud-brick Village"], dock: ["Dry Wharf"] },
  snow: { cave: ["Ice Cavern", "Frost Grotto"], camp: ["Trapper Camp", "Sled Camp"], ruin: ["Frozen Fort", "Buried Chapel"], shrine: ["Aurora Shrine", "Rune Cairn"], summit: ["Frostpeak", "Wind Saddle"], tower: ["Signal Tower", "Bell Tower"], grove: ["Pine Hollow", "Rime Wood"], village: ["Snowbound Hamlet"], dock: ["Ice Jetty"], landmark: ["Mammoth Bones", "Glacier Gate"] },
  volcanic: { cave: ["Magma Tube", "Sulphur Grotto"], ruin: ["Scorched Forge", "Molten Hall"], camp: ["Miners' Camp", "Ash Camp"], shrine: ["Ember Shrine", "Cinder Altar"], summit: ["Caldera Rim", "Smoke Crown"], landmark: ["Obsidian Spire", "Basalt Columns"], tower: ["Ash Beacon", "Vent Watch"], grove: ["Fire Fern Grove"], village: ["Pumice Village"], dock: ["Lava Quay"] },
  canyon: { camp: ["Prospector Camp", "Cattle Camp"], cave: ["Echo Cave", "Rattler Den"], ruin: ["Cliff Dwellings", "Ghost Mine"], tower: ["Rim Watchtower", "Mesa Lookout"], summit: ["Eagle Mesa", "Red Butte"], landmark: ["Stone Arch", "Hoodoo Garden"], dock: ["River Landing", "Ferry Rope"], grove: ["Cottonwood Wash"], village: ["Adobe Village"], shrine: ["Painted Shrine"] },
  ruins: { ruin: ["Fallen Colonnade", "Broken Aqueduct"], cave: ["Catacombs", "Crypt Stair"], shrine: ["Sunken Shrine", "Oracle Altar"], landmark: ["Broken Colossus", "Serpent Gate"], tower: ["Star Tower", "Bell Spire"], grove: ["Vine Court", "Root Garden"], summit: ["Temple Summit", "Ziggurat Top"], camp: ["Dig Site", "Scholars' Camp"], village: ["Squatters' Row"], dock: ["Flooded Stair"] },
  city: { village: ["Lantern Quarter", "Market Row"], dock: ["Canal Docks", "Ferry Steps"], ruin: ["Burnt Theatre", "Gutted Bank"], tower: ["Clock Tower", "Radio Mast"], landmark: ["Founders' Statue", "Grand Arcade"], camp: ["Rooftop Camp", "Night Market"], shrine: ["Old Chapel", "Street Shrine"], cave: ["Metro Tunnel", "Old Sewer"], grove: ["Botanic Garden"], summit: ["Skyline Roof"] },
  scifi_base: { camp: ["Rover Depot", "Supply Cache"], cave: ["Lava Tube", "Ice Mine"], ruin: ["Crashed Lander", "Derelict Module"], tower: ["Comms Array", "Radar Mast"], landmark: ["Reactor Dome", "Monolith"], dock: ["Landing Pad", "Cargo Lock"], summit: ["Ridge Observatory", "Crater Rim"], grove: ["Hydroponics Dome"], village: ["Crew Quarters"], shrine: ["Signal Relay"] },
};
const KIND_LABEL = { landmark: "Monument", ruin: "Ruins", shrine: "Shrine", camp: "Camp", cave: "Cavern", tower: "Tower", village: "Village", dock: "Docks", summit: "Peak", grove: "Grove", hub: "Hub" };

// The local generator's per-biome hubs (Games-B concept.mjs HUB).
const HUB = { island: "Harbour Village", forest: "Mossbrook Camp", desert: "Oasis Market", snow: "Hearth Lodge", volcanic: "Basalt Refuge",
  canyon: "Trailhead Post", ruins: "Expedition Camp", city: "Old Square", scifi_base: "Habitat Hub" };
const STOCK_HUBS = new Set(Object.values(HUB));
// name → biomes whose stock pools contain it
const STOCK_NAMES = new Map();
for (const [b, byKind] of Object.entries(NAMES)) for (const names of Object.values(byKind)) for (const nm of names) {
  if (!STOCK_NAMES.has(nm)) STOCK_NAMES.set(nm, new Set());
  STOCK_NAMES.get(nm).add(b);
}

// Signature names per theme (Games-D theme ids). Themes not listed use the
// biome pools; unknown kinds fall through to the biome pools too.
const THEME_NAMES = {
  storm_isle: { hub: "Gale Harbour", tower: "Storm Lighthouse", shrine: "Thunder Shrine", ruin: "Shipwreck Cove", summit: "Lightning Crag" },
  tropical_cove: { hub: "Coral Landing", grove: "Coconut Grove", cave: "Turquoise Grotto", summit: "Parrot Peak", landmark: "Coral Arch", shrine: "Pearl Shrine" },
  pine_valley: { hub: "Mossbrook Camp", grove: "Tall Pine Grove", tower: "Fire Lookout", dock: "Beaver Dam Jetty" },
  swamp_fen: { hub: "Reedwater Camp", grove: "Drowned Grove", ruin: "Sunken Mill", cave: "Bog Hollow", shrine: "Wisp Shrine", dock: "Heron Jetty", tower: "Stilt Lookout", landmark: "Hanging Moss Oak" },
  dune_sea: { hub: "Oasis Market", summit: "Great Dune", landmark: "Sand-buried Colossus", cave: "Wind-carved Grotto" },
  oasis_flats: { hub: "Palm Spring Bazaar", grove: "Date Palm Oasis", camp: "Caravan Rest", dock: "Spring Wharf", shrine: "Well Shrine", tower: "Minaret of the Flats" },
  frost_peaks: { hub: "Hearth Lodge", summit: "Frostpeak", tower: "Avalanche Watch" },
  glacier_steps: { hub: "Icefall Station", cave: "Blue Ice Cave", landmark: "Glacier Terraces", summit: "Serac Crest", camp: "Crampon Camp", tower: "Ice Beacon" },
  ember_caldera: { hub: "Basalt Refuge", summit: "Caldera Rim", shrine: "Fire Shrine" },
  obsidian_mesa: { hub: "Glassrock Post", landmark: "Obsidian Spire", ruin: "Blackglass Quarry", summit: "Mesa Top", tower: "Cinder Watch", cave: "Glass Cave" },
  red_canyon: { hub: "Trailhead Post", summit: "Eagle Mesa", ruin: "Red Cliff Dwellings" },
  sandstone_steps: { hub: "Terrace Market", ruin: "Carved Stairway", landmark: "Sandstone Arches", shrine: "Cliff Temple", camp: "Quarry Camp", tower: "Terrace Tower" },
  sunken_ruins: { hub: "Expedition Camp", dock: "Flooded Stair", shrine: "Sunken Shrine", ruin: "Drowned Forum" },
  overgrown_temple: { hub: "Jungle Dig Camp", grove: "Strangler Fig Court", shrine: "Temple of Vines", landmark: "Serpent Stairs", tower: "Moss Pagoda", ruin: "Root-split Hall" },
  fog_city: { hub: "Old Square", dock: "Fog Wharf", tower: "Gaslamp Clock Tower", camp: "Night Market", ruin: "Burnt Warehouse" },
  hillside_town: { hub: "Hilltop Piazza", grove: "Olive Terraces", shrine: "Hill Chapel", tower: "Campanile", dock: "Harbour Steps", camp: "Market Stalls", landmark: "Fountain of the Steps" },
  orbital_base: { hub: "Habitat Hub", tower: "Uplink Mast", landmark: "Reactor Dome" },
  crystal_hollow: { hub: "Prospector Dome", cave: "Crystal Grotto", landmark: "Geode Cathedral", ruin: "Abandoned Drill Rig", summit: "Shard Spire", grove: "Glowcap Garden", shrine: "Resonance Stone" },
};

const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "site";
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The theme word used to flavour generic names ("Storm Isle" → "Storm"). */
function themeWord(ctx) {
  const n = String(ctx?.theme?.name || "").trim();
  return n ? n.split(/\s+/)[0] : "Old";
}

/**
 * Pick the non-hub kinds for a layout of n locations: seeded, the finale kind
 * last, the others ordered by drama (stable).
 */
export function pickKinds(layout, n, R) {
  const fin = layout.finale_kinds[Math.floor(R.next() * layout.finale_kinds.length)];
  let pool = layout.kinds.filter((k) => k !== fin && DRAMA[k] <= DRAMA[fin]);
  if (pool.length < n - 2) pool = layout.kinds.filter((k) => k !== fin);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(R.next() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  while (pool.length < n - 2) pool.push(...pool.slice(0, n - 2 - pool.length));
  const mids = pool.slice(0, Math.max(0, n - 2)).map((k, i) => ({ k, i })).sort((a, b) => (DRAMA[a.k] - DRAMA[b.k]) || (a.i - b.i)).map((x) => x.k);
  return [...mids, fin];
}

/**
 * Rewrite concept.key_locations for the recipe's layout. Existing locations
 * are reused where their kind fits (so prompt-named places survive); missing
 * ones take a biome-flavoured name, or "<Theme> <Kind>". Never throws.
 */
export function layoutConceptPatch(concept, ctx) {
  const layout = ctx?.layout || LAYOUTS.classic;
  const R = typeof ctx?.rand === "function" ? ctx.rand("layout") : null;
  if (!R || !concept) return concept;
  const notes = Array.isArray(ctx.notes) ? ctx.notes : null;
  const n = Math.max(3, Math.min(6, layout.locations | 0));
  const biome = NAMES[concept.biome] ? concept.biome : "island";
  if (layout.biomes && !layout.biomes.includes(concept.biome) && notes) {
    notes.push(`layout '${layout.id}' is tuned for ${layout.biomes.join("/")} themes; running it on ${concept.biome}`);
  }
  const flavour = THEME_NAMES[ctx.theme?.id] || {};
  const place = themeWord(ctx);
  const old = Array.isArray(concept.key_locations) ? concept.key_locations.filter((l) => l && typeof l.id === "string" && l.id) : [];
  const oldHub = old.find((l) => l.kind === "hub") || old[0];
  // A stock hub (the local generator's per-biome default) gives way to the
  // theme's own; a prompt- or provider-named hub is kept.
  const stockHub = !oldHub || STOCK_HUBS.has(oldHub.name);
  const hubName = stockHub ? (flavour.hub || HUB[biome]) : oldHub.name;
  const hub = stockHub
    ? { id: slugify(hubName), name: hubName, kind: "hub", description: `The start: ${hubName}, where every trail of the ${layout.name.toLowerCase()} begins.` }
    : { id: oldHub.id, name: oldHub.name, kind: "hub", description: oldHub.description || `The start: ${oldHub.name}.` };
  const out = [hub];
  const used = new Set([hub.id]);
  const usedNames = new Set([hub.name]);
  // Only prompt- or provider-named sites are carried over; stock pool names are
  // re-picked below so the theme's signature names come first (and a base
  // concept generated for another biome never leaks its names in).
  const spare = old.filter((l) => l !== oldHub && !STOCK_NAMES.has(l.name));
  const kinds = pickKinds(layout, n, R);
  kinds.forEach((kind, i) => {
    const isFinale = i === kinds.length - 1;
    let loc = null;
    // 1. an existing (prompt-derived) location of this kind
    const si = spare.findIndex((l) => l.kind === kind && !used.has(l.id) && !usedNames.has(l.name));
    if (si >= 0) { const l = spare.splice(si, 1)[0]; loc = { id: l.id, name: l.name, kind, description: l.description || `${l.name}.` }; }
    // 2. a theme signature name, 3. a biome-flavoured one, 4. "<Theme> <Kind>"
    if (!loc) {
      const cand = [...(flavour[kind] ? [flavour[kind]] : []), ...(NAMES[biome][kind] || []), `${place} ${KIND_LABEL[kind]}`];
      const name = cand.find((c) => !usedNames.has(c) && !used.has(slugify(c))) || `${place} ${KIND_LABEL[kind]} ${i + 2}`;
      loc = { id: slugify(name), name, kind,
        description: isFinale ? `${name}: the far end of the ${layout.name.toLowerCase()}, where the story ends.` : `${name}: a ${kind} on the way out from ${hub.name}.` };
    }
    let id = loc.id;
    for (let k = 2; used.has(id); k++) id = `${loc.id}_${k}`;
    used.add(id); usedNames.add(loc.name);
    out.push({ ...loc, id });
  });

  // Keep the story text pointing at the new hub and finale.
  const finale = out[out.length - 1];
  const oldFinale = old.length > 1 ? old[old.length - 1] : null;
  const renames = [[oldHub?.name, hub.name], [oldFinale?.name, finale.name]].filter(([a, b]) => a && b && a !== b);
  const swap = (s) => (typeof s === "string" ? renames.reduce((acc, [a, b]) => acc.replace(new RegExp(esc(a), "g"), b), s) : s);
  const outline = Array.isArray(concept.objectives_outline) ? concept.objectives_outline : [];
  const objectives_outline = [
    ...(outline.length ? [swap(outline[0])] : [`Set out from ${hub.name}`]),
    ...out.slice(1, -1).map((l) => `Reach the ${l.name}`),
    `Restore the ${finale.name}`,
  ];
  const next = {
    ...concept,
    key_locations: out,
    title: swap(concept.title),
    logline: swap(concept.logline),
    player_fantasy: swap(concept.player_fantasy),
    objectives_outline,
    hazards: Array.isArray(concept.hazards) ? concept.hazards.map(swap) : concept.hazards,
    characters: Array.isArray(concept.characters) ? concept.characters.map((c) => (c && typeof c.description === "string" ? { ...c, description: swap(c.description) } : c)) : concept.characters,
    scale: ctx.recipe?.scale || layout.scale || concept.scale,
  };
  if (layout.ordering && layout.ordering !== "linear") next.layout_ordering = layout.ordering;
  else delete next.layout_ordering;
  return next;
}
