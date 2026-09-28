// GameConcept generation (CONTRACT §1, first pipeline stage). NODE-ONLY.
//
// Two paths, one result shape:
//  - LLM: a Lane whose first adapter asks Cerebras gpt-oss-120b for strict JSON.
//    The answer is repaired ONTO the deterministic concept — enums coerced, ids
//    slugified, hub forced first, gaps filled — and must validate, or the stage
//    falls back. The model adds flavour; it never gets to break §4.5 ids.
//  - FALLBACK: keyword analysis of the prompt plus a seeded RNG. Same prompt and
//    seed give a byte-identical concept, because every later stage keys its
//    determinism off this one.
import { Lane, STATUS } from "../../v3/providers/contract.mjs";
import { seeded, hashString, clamp } from "../common/rng.mjs";
import { promptHash } from "../common/hash.mjs";
import {
  validateConcept, CONCEPT_VERSION, GENRES, BIOMES, SCALES, WEATHERS, LOCATION_KINDS, CHARACTER_ROLES, PALETTE_KEYS, HOSTILE_ROLES,
} from "./concept.schema.mjs";
import { cerebrasJsonAdapter, localAdapter, stageProvenance, withFallback, slugify } from "./llm.mjs";

export const CONCEPT_LANE = "gamesb_concept";

// ------------------------------------------------------------ keyword tables
//
// Scored rather than first-match: "a haunted lighthouse on a frozen island"
// should pick whichever biome the prompt leans on hardest, not whichever table
// happens to be checked first.

const BIOME_WORDS = {
  island: ["island", "islands", "archipelago", "beach", "coast", "coastal", "tropical", "lagoon", "harbor", "harbour", "lighthouse", "sea", "ocean", "pirate", "pirates", "reef", "shore", "atoll"],
  forest: ["forest", "woods", "woodland", "jungle", "grove", "enchanted", "elven", "swamp", "marsh", "rainforest", "fairy", "mushroom", "mushrooms", "treetop"],
  desert: ["desert", "dune", "dunes", "sand", "sands", "oasis", "pharaoh", "pyramid", "pyramids", "caravan", "nomad", "sahara"],
  snow: ["snow", "snowy", "ice", "icy", "frozen", "arctic", "tundra", "glacier", "winter", "frost", "blizzard", "polar", "yeti"],
  volcanic: ["volcano", "volcanic", "lava", "magma", "obsidian", "inferno", "caldera", "molten", "eruption", "fire"],
  canyon: ["canyon", "mesa", "gorge", "cliff", "cliffs", "ravine", "badlands", "mountain", "mountains", "highlands", "valley", "western", "cowboy"],
  ruins: ["ruins", "ruin", "ancient", "temple", "tomb", "forgotten", "crumbling", "catacomb", "catacombs", "relic", "relics", "archaeology", "labyrinth"],
  city: ["city", "town", "street", "streets", "neon", "urban", "metropolis", "market", "cyberpunk", "rooftop", "rooftops", "downtown", "alley"],
  scifi_base: ["space", "station", "mars", "martian", "alien", "aliens", "planet", "colony", "lab", "laboratory", "scifi", "sci", "robot", "robots", "spaceship", "moon", "lunar", "outpost", "reactor", "android"],
};
const BIOME_ORDER = BIOMES;

const GENRE_WORDS = {
  puzzle: ["puzzle", "puzzles", "riddle", "riddles", "solve", "logic", "cipher", "mechanism"],
  stealth: ["stealth", "sneak", "sneaking", "infiltrate", "heist", "spy", "thief", "unseen", "shadows"],
  survival: ["survive", "survival", "stranded", "hunger", "shipwrecked", "castaway", "endure"],
  collectathon: ["collect", "collecting", "gather", "gems", "coins", "treasure", "scavenger", "hunt"],
  mission: ["mission", "rescue", "deliver", "escort", "operation", "sabotage", "repair", "restore"],
  exploration: ["explore", "exploration", "wander", "discover", "journey", "chart", "expedition"],
  adventure: ["adventure", "quest", "hero", "legend", "saga"],
};
const GENRE_ORDER = ["puzzle", "stealth", "survival", "collectathon", "mission", "exploration", "adventure"];

const WEATHER_WORDS = [
  ["sandstorm", ["sandstorm", "duststorm"]],
  ["storm", ["storm", "stormy", "thunder", "thunderstorm", "hurricane", "tempest", "lightning"]],
  ["rain", ["rain", "rainy", "monsoon", "drizzle", "wet"]],
  ["snow", ["snowfall", "snowing", "blizzard"]],
  ["fog", ["fog", "foggy", "mist", "misty", "haze", "hazy"]],
  ["ash", ["ash", "ashen", "smoke", "smoky"]],
  ["cloudy", ["cloud", "cloudy", "overcast", "grey", "gray"]],
  ["clear", ["sunny", "clear", "bright", "sunlit"]],
];
const BIOME_WEATHER = {
  island: ["clear", "cloudy", "clear", "rain"], forest: ["clear", "fog", "rain", "cloudy"], desert: ["clear", "clear", "sandstorm"],
  snow: ["snow", "clear", "fog"], volcanic: ["ash", "cloudy", "ash"], canyon: ["clear", "cloudy", "clear"],
  ruins: ["fog", "clear", "cloudy"], city: ["clear", "rain", "cloudy", "fog"], scifi_base: ["clear", "fog", "cloudy"],
};

const TIME_WORDS = [
  [0.27, ["dawn", "sunrise", "daybreak", "morning"]],
  [0.5, ["noon", "midday"]],
  [0.62, ["afternoon"]],
  [0.76, ["dusk", "sunset", "twilight", "evening", "golden"]],
  [0.9, ["night", "nighttime", "midnight", "moonlit", "starlit", "nocturnal"]],
];

const MOOD_WORDS = {
  eerie: ["eerie", "haunted", "creepy", "spooky", "ghost", "ghosts", "ghostly", "cursed", "sinister", "horror", "dread"],
  cozy: ["cozy", "cosy", "warm", "gentle", "peaceful", "cute", "wholesome", "charming", "snug"],
  mysterious: ["mystery", "mysterious", "secret", "secrets", "hidden", "enigma", "strange", "arcane", "unknown"],
  tense: ["tense", "dangerous", "deadly", "hostile", "war", "desperate", "hunted", "chase"],
  serene: ["serene", "calm", "tranquil", "quiet", "relaxing", "dreamy", "meditative", "zen"],
  epic: ["epic", "legendary", "heroic", "grand", "mighty", "titan", "colossal"],
  melancholy: ["lonely", "abandoned", "melancholy", "sad", "lost", "faded", "sorrow"],
  hopeful: ["hope", "hopeful", "rebuild", "revive", "bloom", "light", "lanterns", "renewal"],
};
const MOOD_ORDER = ["eerie", "cozy", "mysterious", "tense", "serene", "epic", "melancholy", "hopeful"];
const BIOME_MOODS = {
  island: ["serene", "hopeful", "mysterious"], forest: ["mysterious", "serene", "cozy"], desert: ["epic", "melancholy", "mysterious"],
  snow: ["serene", "melancholy", "tense"], volcanic: ["tense", "epic"], canyon: ["epic", "hopeful", "melancholy"],
  ruins: ["mysterious", "melancholy", "eerie"], city: ["tense", "mysterious", "hopeful"], scifi_base: ["tense", "mysterious", "eerie"],
};

// Base palettes per biome, then shifted per mood (below), so biome × mood gives
// a coherent look without hand-writing 72 palettes.
const BIOME_PALETTE = {
  island:     { primary: "#2f8f83", secondary: "#e9d8a6", accent: "#ee9b00", ground: "#c9b27c", sky: "#8ecae6", water: "#1f7a99" },
  forest:     { primary: "#3a5a40", secondary: "#a3b18a", accent: "#e9c46a", ground: "#5b4a33", sky: "#a8c5b8", water: "#2e6f6a" },
  desert:     { primary: "#c8793a", secondary: "#e9c893", accent: "#2a9d8f", ground: "#d8b27a", sky: "#f2d6a2", water: "#3a8fa3" },
  snow:       { primary: "#5c7fa3", secondary: "#e8eef4", accent: "#e76f51", ground: "#dfe7ee", sky: "#b9cde0", water: "#3f6f8f" },
  volcanic:   { primary: "#3d2c2e", secondary: "#6b4f4f", accent: "#ff6b1a", ground: "#2b2424", sky: "#7a5a55", water: "#c2410c" },
  canyon:     { primary: "#b5552e", secondary: "#deaa79", accent: "#3d7ea6", ground: "#a86a45", sky: "#9fc3de", water: "#4a8fae" },
  ruins:      { primary: "#7d7461", secondary: "#c9c0a8", accent: "#5aa9a1", ground: "#6e6a4f", sky: "#b4c4c9", water: "#4f7c82" },
  city:       { primary: "#46505e", secondary: "#9aa5b1", accent: "#ff5d8f", ground: "#5d6168", sky: "#8fa3bf", water: "#35607a" },
  scifi_base: { primary: "#2c3e50", secondary: "#bdc7d1", accent: "#29d3c0", ground: "#6b5d52", sky: "#d9a38b", water: "#3a6d8c" },
};
const MOOD_SHIFT = {
  eerie:      { tint: "#4f7a86", amt: 0.35, light: 0.72 },
  cozy:       { tint: "#e8a25c", amt: 0.18, light: 1.04 },
  mysterious: { tint: "#6a5acd", amt: 0.22, light: 0.86 },
  tense:      { tint: "#8b2e2e", amt: 0.18, light: 0.84 },
  serene:     { tint: "#9ec9d6", amt: 0.18, light: 1.06 },
  epic:       { tint: "#d4a53a", amt: 0.15, light: 1.0 },
  melancholy: { tint: "#7a8595", amt: 0.32, light: 0.9 },
  hopeful:    { tint: "#ffd98a", amt: 0.14, light: 1.08 },
};

// Location pools per biome. The hub is fixed; the rest are shuffled by seed with
// the most dramatic kinds (tower/summit/shrine/landmark) sorted to the end, so
// the last location is the natural finale for the gameplay stage.
const HUB = {
  island: ["Harbour Village", "the fishing village and its quay"], forest: ["Mossbrook Camp", "a ring of tents around a fire pit"],
  desert: ["Oasis Market", "palms and awnings around a spring"], snow: ["Hearth Lodge", "a timber lodge dug into the drifts"],
  volcanic: ["Basalt Refuge", "a stone shelter cut into cooled lava"], canyon: ["Trailhead Post", "a trading post at the canyon mouth"],
  ruins: ["Expedition Camp", "tents and crates at the edge of the ruins"], city: ["Old Square", "the fountain square at the city's heart"],
  scifi_base: ["Habitat Hub", "the pressurised central habitat ring"],
};
const LOC_POOL = {
  island: [["tower", "Old Lighthouse"], ["dock", "Broken Pier"], ["cave", "Sea Cave"], ["shrine", "Tide Shrine"], ["summit", "Gull Peak"], ["ruin", "Sunken Ruins"], ["grove", "Palm Grove"]],
  forest: [["grove", "Elder Grove"], ["ruin", "Overgrown Keep"], ["cave", "Root Hollow"], ["shrine", "Moon Shrine"], ["tower", "Ranger Tower"], ["village", "Treetop Village"], ["summit", "Crown Hill"]],
  desert: [["ruin", "Buried Palace"], ["camp", "Nomad Camp"], ["cave", "Scorpion Grotto"], ["shrine", "Sun Shrine"], ["landmark", "Great Obelisk"], ["tower", "Watchtower"], ["summit", "Dune Crest"]],
  snow: [["cave", "Ice Cavern"], ["camp", "Trapper Camp"], ["ruin", "Frozen Fort"], ["shrine", "Aurora Shrine"], ["summit", "Frostpeak"], ["tower", "Signal Tower"], ["grove", "Pine Hollow"]],
  volcanic: [["cave", "Magma Tube"], ["ruin", "Scorched Forge"], ["camp", "Miners' Camp"], ["shrine", "Ember Shrine"], ["summit", "Caldera Rim"], ["landmark", "Obsidian Spire"], ["tower", "Ash Beacon"]],
  canyon: [["camp", "Prospector Camp"], ["cave", "Echo Cave"], ["ruin", "Cliff Dwellings"], ["tower", "Rim Watchtower"], ["summit", "Eagle Mesa"], ["landmark", "Stone Arch"], ["dock", "River Landing"]],
  ruins: [["ruin", "Fallen Colonnade"], ["cave", "Catacombs"], ["shrine", "Sunken Shrine"], ["landmark", "Broken Colossus"], ["tower", "Star Tower"], ["grove", "Vine Court"], ["summit", "Temple Summit"]],
  city: [["village", "Lantern Quarter"], ["dock", "Canal Docks"], ["ruin", "Burnt Theatre"], ["tower", "Clock Tower"], ["landmark", "Founders' Statue"], ["camp", "Rooftop Camp"], ["shrine", "Old Chapel"]],
  scifi_base: [["camp", "Rover Depot"], ["cave", "Lava Tube"], ["ruin", "Crashed Lander"], ["tower", "Comms Array"], ["landmark", "Reactor Dome"], ["dock", "Landing Pad"], ["summit", "Ridge Observatory"]],
};
const DRAMA = { hub: 0, camp: 1, dock: 1, village: 1, grove: 2, cave: 2, ruin: 3, landmark: 4, shrine: 4, tower: 5, summit: 5 };

// Nouns in the prompt that should become a named location of the matching kind.
const LOC_NOUNS = [
  [["lighthouse"], "tower", "Lighthouse"], [["tower", "spire"], "tower", "Tower"], [["temple", "shrine", "altar"], "shrine", "Temple"],
  [["cave", "cavern", "grotto"], "cave", "Cavern"], [["mountain", "peak", "summit"], "summit", "Peak"], [["village", "hamlet"], "village", "Village"],
  [["dock", "pier", "harbor", "harbour", "port"], "dock", "Docks"], [["ruins", "ruin"], "ruin", "Ruins"], [["castle", "fortress", "fort"], "ruin", "Fortress"],
  [["grove", "glade"], "grove", "Glade"], [["camp", "outpost"], "camp", "Outpost"], [["observatory"], "summit", "Observatory"],
  [["pyramid", "obelisk", "monument"], "landmark", "Monument"], [["reactor"], "landmark", "Reactor"],
];

const GENERIC_LABELS = new Set(["Tower", "Ruins", "Temple", "Cavern", "Peak", "Village", "Docks", "Glade", "Outpost"]);

const SYL = ["sal", "mer", "tor", "vel", "ash", "bri", "dun", "kel", "mor", "wyn", "gal", "ren", "thal", "or", "fen", "lor", "cal", "dra", "ess", "vi", "an", "sel"];
const SUFFIX = {
  island: ["mere", "holm", "port", "isle"], forest: ["wood", "glen", "vale", "hollow"], desert: ["sar", "dune", "qadir", "reach"],
  snow: ["frost", "hald", "rime", "gard"], volcanic: ["forge", "cinder", "maw", "pyre"], canyon: ["gulch", "ridge", "mesa", "drop"],
  ruins: ["hallow", "keep", "gate", "dor"], city: ["ton", "borough", "ward", "haven"], scifi_base: [" Station", " Prime", " Outpost", " Colony"],
};
const RELIC = {
  island: "lantern cores", forest: "seed relics", desert: "sun shards", snow: "ember stones", volcanic: "cooling gems",
  canyon: "echo keys", ruins: "glyph tablets", city: "brass keys", scifi_base: "power cells",
};
const TITLE_NOUN = {
  island: ["Lanterns", "Tides", "Beacons"], forest: ["Roots", "Whispers", "Lanterns"], desert: ["Sands", "Suns", "Mirages"],
  snow: ["Embers", "Auroras", "Frost"], volcanic: ["Cinders", "Embers", "Forges"], canyon: ["Echoes", "Winds", "Trails"],
  ruins: ["Glyphs", "Echoes", "Relics"], city: ["Lamps", "Bells", "Keys"], scifi_base: ["Signals", "Reactors", "Stars"],
};
const WEATHER_ADJ = {
  clear: "sunlit", cloudy: "overcast", rain: "rain-soaked", storm: "storm-lashed", snow: "snowbound",
  fog: "fog-bound", sandstorm: "sand-scoured", ash: "ash-choked",
};
const GENRE_VERB = {
  adventure: "set out to", exploration: "wander far to", mission: "race to", puzzle: "unravel the mechanisms to",
  survival: "hold on long enough to", collectathon: "scour every corner to", stealth: "slip past the watchers to",
};

// Character pools. Ids are `<title>_<name>` so they read well in ix_talk_<id>.
const NAMES = ["maren", "tobin", "isla", "corin", "wren", "odo", "lyra", "bram", "sefa", "juno", "hale", "nadia", "piet", "rook", "ember", "kai"];
const COMPANION = {
  island: ["deckhand", "Deckhand"], forest: ["scout", "Scout"], desert: ["guide", "Guide"], snow: ["tracker", "Tracker"],
  volcanic: ["apprentice", "Apprentice"], canyon: ["ranger", "Ranger"], ruins: ["scholar", "Scholar"], city: ["courier", "Courier"],
  scifi_base: ["tech", "Technician"],
};
const GIVER = {
  island: ["keeper", "Keeper"], forest: ["elder", "Elder"], desert: ["caravan_master", "Caravan Master"], snow: ["warden", "Warden"],
  volcanic: ["forgemaster", "Forgemaster"], canyon: ["sheriff", "Sheriff"], ruins: ["professor", "Professor"], city: ["mayor", "Mayor"],
  scifi_base: ["commander", "Commander"],
};
const HOSTILE = {
  island: ["creature", "reef_crab", "Reef Crab", "a crab the size of a cart, snapping at anyone near the rocks"],
  forest: ["creature", "thorn_wolf", "Thorn Wolf", "a bramble-furred wolf that stalks the undergrowth"],
  desert: ["creature", "dune_scorpion", "Dune Scorpion", "a sand-coloured scorpion that bursts from the dunes"],
  snow: ["creature", "frost_wolf", "Frost Wolf", "a pale wolf that hunts along the drifts"],
  volcanic: ["creature", "cinder_imp", "Cinder Imp", "a smouldering imp that guards the hot vents"],
  canyon: ["creature", "rock_stalker", "Rock Stalker", "a lizard-like stalker that clings to the canyon walls"],
  ruins: ["guard", "stone_sentinel", "Stone Sentinel", "an animated statue that patrols the old halls"],
  city: ["guard", "patrol_drone", "Patrol Drone", "a searchlight drone that sweeps the streets"],
  scifi_base: ["guard", "security_drone", "Security Drone", "a malfunctioning security drone on a fixed patrol"],
};
const MERCHANT = ["trader", "Trader"];
const AMBIENT = ["villager", "Villager"];

// ------------------------------------------------------------------ helpers

function words(prompt) {
  return String(prompt ?? "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
}

function score(ws, table, order) {
  let best = null, bestScore = 0;
  for (const k of order) {
    const set = table[k];
    const s = ws.reduce((n, w) => n + (set.includes(w) ? 1 : 0), 0);
    if (s > bestScore) { best = k; bestScore = s; }
  }
  return best;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
}
function shift(hex, tint, amt, light) {
  const a = hexToRgb(hex), t = hexToRgb(tint);
  return rgbToHex(a.map((v, i) => (v + (t[i] - v) * amt) * light));
}

export function paletteFor(biome, mood) {
  const base = BIOME_PALETTE[biome] || BIOME_PALETTE.island;
  const m = MOOD_SHIFT[mood] || { tint: "#808080", amt: 0, light: 1 };
  const out = {};
  for (const k of PALETTE_KEYS) {
    // The accent is what the player's eye follows (pickups, lanterns), so the
    // mood shifts it half as much to keep it readable against the scene.
    const amt = k === "accent" ? m.amt / 2 : m.amt;
    const light = k === "accent" ? Math.max(m.light, 0.95) : m.light;
    out[k] = shift(base[k], m.tint, amt, light);
  }
  return out;
}

function placeName(r, biome) {
  const n = 1 + (r.next() < 0.5 ? 1 : 0);
  let s = "";
  for (let i = 0; i < n; i++) s += r.pick(SYL);
  const suf = r.pick(SUFFIX[biome]);
  return suf.startsWith(" ") ? cap(s) + suf : cap(s + suf);
}

// ------------------------------------------------------- deterministic path

/** Keyword + seeded-RNG concept. Pure function of (prompt, seed). */
export function conceptLocally(prompt, { seed } = {}) {
  const text = String(prompt ?? "").trim();
  // A concept records the prompt it came from (§1 source_prompt); an empty one
  // would be a concept of nothing, so refuse it rather than invent a prompt.
  if (!text) throw new TypeError("generateConcept: prompt must be a non-empty string");
  const s = Number.isInteger(seed) && seed >= 0 ? seed : hashString(text);
  const r = seeded(s);
  const ws = words(text);

  const biome = score(ws, BIOME_WORDS, BIOME_ORDER) || r.pick(["island", "forest", "ruins", "canyon"]);
  const genre = score(ws, GENRE_WORDS, GENRE_ORDER) || "adventure";

  let weather = null;
  for (const [w, list] of WEATHER_WORDS) if (ws.some((x) => list.includes(x))) { weather = w; break; }
  if (weather === "snow" && biome !== "snow" && !ws.includes("blizzard")) weather = "snow";
  weather = weather || r.pick(BIOME_WEATHER[biome]);

  let time = null;
  for (const [t, list] of TIME_WORDS) if (ws.some((x) => list.includes(x))) { time = t; break; }
  const time_of_day = time ?? Math.round(r.range(0.36, 0.64) * 100) / 100;

  const mood = score(ws, MOOD_WORDS, MOOD_ORDER) || r.pick(BIOME_MOODS[biome]);
  const scaleWords = { small: ["small", "tiny", "little", "compact", "cozy", "cosy"], large: ["vast", "huge", "large", "sprawling", "massive", "enormous", "epic", "open"] };
  const scale = ws.some((w) => scaleWords.large.includes(w)) ? "large" : ws.some((w) => scaleWords.small.includes(w)) ? "small" : "medium";

  const place = placeName(r, biome);

  // Locations: hub, then prompt-named places, then the seeded pool.
  const target = { small: 4, medium: 5, large: 6 }[scale];
  const [hubName, hubDesc] = HUB[biome];
  const locs = [{ id: slugify(hubName), name: hubName, kind: "hub", description: `The start: ${hubDesc}.` }];
  const used = new Set([locs[0].id]);
  const usedKinds = new Map();
  const named = new Set();   // ids the prompt asked for: they outrank the pool for the finale
  const add = (kind, name, description, fromPrompt = false) => {
    const id = slugify(name);
    if (used.has(id) || locs.length >= target) return;
    used.add(id); usedKinds.set(kind, (usedKinds.get(kind) || 0) + 1);
    if (fromPrompt) named.add(id);
    locs.push({ id, name, kind, description });
  };
  for (const [nouns, kind, label] of LOC_NOUNS) {
    if (ws.some((w) => nouns.includes(w) || nouns.includes(w.replace(/s$/, "")))) {
      // A generic noun ("a tower") takes the biome's flavoured name for that kind;
      // a specific one ("a lighthouse") keeps its word unless the pool has it.
      const pooled = LOC_POOL[biome].find(([k]) => k === kind);
      const generic = GENERIC_LABELS.has(label);
      const name = pooled && (generic || pooled[1].toLowerCase().includes(label.toLowerCase())) ? pooled[1] : `${place} ${label}`;
      add(kind, name, `The ${name.toLowerCase()} at the heart of the story, standing beyond ${hubName}.`, true);
    }
  }
  const pool = [...LOC_POOL[biome]];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r.next() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  for (const [kind, name] of pool) {
    if ((usedKinds.get(kind) || 0) >= 1) continue;
    add(kind, name, `${name}: a ${kind} of ${place}, reached by the trail from ${hubName}.`);
  }
  // Order by drama (stable), keeping the hub first: the last location is the finale.
  const drama = (l) => DRAMA[l.kind] + (named.has(l.id) ? 10 : 0);
  const rest = locs.slice(1).map((l, i) => ({ l, i })).sort((a, b) => (drama(a.l) - drama(b.l)) || (a.i - b.i)).map((x) => x.l);
  const key_locations = [locs[0], ...rest];
  const finale = key_locations[key_locations.length - 1];

  // Characters.
  const names = [...NAMES];
  const takeName = () => { const i = Math.floor(r.next() * names.length); return names.splice(i, 1)[0]; };
  const characters = [];
  const [gId, gTitle] = GIVER[biome];
  const gName = takeName();
  characters.push({ id: `${gId}_${gName}`, name: `${gTitle} ${cap(gName)}`, role: "quest_giver", description: `Waits in ${hubName} and knows why the ${finale.name} fell silent.` });
  const [cId, cTitle] = COMPANION[biome];
  const cName = takeName();
  characters.push({ id: `${cId}_${cName}`, name: `${cap(cName)} the ${cTitle}`, role: "companion", description: `Follows you from ${hubName} and points out anything glinting nearby.` });
  if (genre !== "puzzle") {
    const [role, hId, hName, hDesc] = HOSTILE[biome];
    characters.push({ id: hId, name: hName, role: genre === "stealth" ? "guard" : role, description: `${cap(hDesc)}. Keep your distance.` });
  }
  if (scale !== "small" || genre === "puzzle") {
    const mName = takeName();
    characters.push({ id: `${MERCHANT[0]}_${mName}`, name: `${cap(mName)} the ${MERCHANT[1]}`, role: "merchant", description: `Trades gossip about ${place} for anything shiny.` });
  }
  if (scale === "large" || characters.length < 3) {
    const aName = takeName();
    characters.push({ id: `${AMBIENT[0]}_${aName}`, name: cap(aName), role: "ambient", description: `A local of ${hubName} going about their day.` });
  }

  const relic = RELIC[biome];
  const nonHub = key_locations.slice(1);
  const noun = r.pick(TITLE_NOUN[biome]);
  const title = r.pick([`The ${noun} of ${place}`, `${place}: The ${finale.name}`, `Beyond the ${finale.name}`, `${noun} over ${place}`]);
  const logline = `On ${WEATHER_ADJ[weather]}, ${mood} ${place}, you ${GENRE_VERB[genre]} recover the ${relic} and restore the ${finale.name}.`;
  const objectives_outline = [
    `Speak with ${characters[0].name} in ${hubName}`,
    `Recover the ${relic} hidden across ${nonHub.length - 1 > 0 ? nonHub.slice(0, -1).map((l) => l.name).join(", ") : finale.name}`,
    ...nonHub.slice(0, -1).map((l) => `Wake the ${l.name}`),
    `Restore the ${finale.name}`,
  ];
  const hazards = [];
  if (["storm", "sandstorm", "ash", "snow"].includes(weather)) hazards.push(`${cap(weather)} sweeping the exposed ground around the ${finale.name}`);
  if (biome === "island") hazards.push("Deep water beyond the shore");
  if (biome === "volcanic") hazards.push("Lava vents that scorch anyone who lingers");
  if (["canyon", "snow"].includes(biome)) hazards.push("Sheer drops off the trail edges");
  for (const ch of characters) if (HOSTILE_ROLES.includes(ch.role)) hazards.push(`${ch.name} patrolling the wilds`);
  if (!hazards.length) hazards.push("Unstable ground near the old structures");

  return {
    concept_version: CONCEPT_VERSION,
    title, logline,
    source_prompt: text,
    prompt_hash: promptHash(text),
    seed: s,
    genre, biome, scale, mood, time_of_day, weather,
    palette: paletteFor(biome, mood),
    player_fantasy: `You are a wanderer who arrives at ${hubName} and becomes the one who brings the ${finale.name} back to life.`,
    key_locations,
    characters,
    objectives_outline,
    hazards,
  };
}

// --------------------------------------------------------------- repair path

const SYN = {
  genre: { action: "adventure", "action-adventure": "adventure", rpg: "adventure", platformer: "exploration", open_world: "exploration", explore: "exploration", sandbox: "exploration", heist: "stealth", infiltration: "stealth", collection: "collectathon", collect: "collectathon", quest: "adventure", escort: "mission", rescue: "mission", horror: "survival", mystery: "puzzle" },
  biome: { jungle: "forest", woods: "forest", swamp: "forest", beach: "island", coast: "island", tropical: "island", ocean: "island", arctic: "snow", tundra: "snow", ice: "snow", glacier: "snow", winter: "snow", volcano: "volcanic", lava: "volcanic", mountain: "canyon", mountains: "canyon", mesa: "canyon", badlands: "canyon", temple: "ruins", ancient_ruins: "ruins", urban: "city", town: "city", cyberpunk: "city", space: "scifi_base", scifi: "scifi_base", sci_fi: "scifi_base", space_station: "scifi_base", station: "scifi_base", mars: "scifi_base", dunes: "desert" },
  weather: { sunny: "clear", overcast: "cloudy", rainy: "rain", thunderstorm: "storm", stormy: "storm", blizzard: "snow", snowy: "snow", mist: "fog", misty: "fog", foggy: "fog", dust: "sandstorm", ashfall: "ash" },
  location: { town: "village", city: "village", settlement: "village", base: "hub", start: "hub", home: "hub", mountain: "summit", peak: "summit", temple: "shrine", altar: "shrine", lighthouse: "tower", pier: "dock", harbor: "dock", harbour: "dock", port: "dock", cavern: "cave", forest: "grove", glade: "grove", ruins: "ruin", monument: "landmark", outpost: "camp" },
  role: { ally: "companion", sidekick: "companion", friend: "companion", questgiver: "quest_giver", "quest giver": "quest_giver", mentor: "quest_giver", elder: "quest_giver", trader: "merchant", vendor: "merchant", shopkeeper: "merchant", monster: "creature", beast: "creature", boss: "enemy", villain: "enemy", hostile: "enemy", sentry: "guard", villager: "ambient", npc: "ambient", civilian: "ambient" },
};

function coerceEnum(v, allowed, syn, fallback) {
  if (typeof v !== "string") return fallback;
  const k = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (allowed.includes(k)) return k;
  const raw = v.trim().toLowerCase();
  if (syn[k] || syn[raw]) return syn[k] || syn[raw];
  // "haunted_forest" → forest: take the first allowed value mentioned in the text.
  for (const a of allowed) if (k.split("_").includes(a)) return a;
  for (const [s, a] of Object.entries(syn)) if (k.split("_").includes(s)) return a;
  return fallback;
}

const str = (v, fallback, max = 240) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : fallback);

function coerceTime(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v >= 0 && v <= 1) return Math.round(v * 1000) / 1000;
    if (v > 1 && v <= 24) return Math.round((v / 24) * 1000) / 1000;   // model answered in hours
    return fallback;
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return coerceTime(n, fallback);
    const w = v.toLowerCase();
    for (const [t, list] of TIME_WORDS) if (list.some((x) => w.includes(x))) return t;
  }
  return fallback;
}

/**
 * Repair an arbitrary model object onto the deterministic concept `base`.
 * Identity fields (version, prompt, hash, seed) always come from `base` — the
 * model never gets to change what prompt a concept claims to come from.
 */
export function repairConcept(raw, base) {
  const j = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw.concept && typeof raw.concept === "object" ? raw.concept : raw) : {};
  const out = {
    concept_version: CONCEPT_VERSION,
    title: str(j.title, base.title, 80),
    logline: str(j.logline, base.logline, 400),
    source_prompt: base.source_prompt,
    prompt_hash: base.prompt_hash,
    seed: base.seed,
    genre: coerceEnum(j.genre, GENRES, SYN.genre, base.genre),
    biome: coerceEnum(j.biome, BIOMES, SYN.biome, base.biome),
    scale: coerceEnum(j.scale, SCALES, {}, base.scale),
    mood: str(j.mood, base.mood, 40).toLowerCase(),
    time_of_day: coerceTime(j.time_of_day, base.time_of_day),
    weather: coerceEnum(j.weather, WEATHERS, SYN.weather, base.weather),
    palette: {},
    player_fantasy: str(j.player_fantasy, base.player_fantasy, 400),
    key_locations: [],
    characters: [],
    objectives_outline: [],
    hazards: [],
  };
  // A biome change invalidates the base palette's intent; derive a fresh one
  // for the repaired biome × mood, then let valid model hexes override it.
  const pal = out.biome === base.biome && out.mood === base.mood ? base.palette : paletteFor(out.biome, MOOD_SHIFT[out.mood] ? out.mood : base.mood);
  for (const k of PALETTE_KEYS) {
    const v = j.palette?.[k];
    out.palette[k] = typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : pal[k];
  }

  // Locations: keep usable rows, slug + dedupe ids, coerce kinds, force hub first.
  const seen = new Set();
  const locs = [];
  for (const l of Array.isArray(j.key_locations) ? j.key_locations : []) {
    if (typeof l === "string") { if (l.trim()) locs.push({ id: slugify(l, "loc"), name: str(l, "Place", 60), kind: "landmark", description: `${l.trim()}.` }); continue; }
    if (!l || typeof l !== "object") continue;
    const name = str(l.name, null, 60) || str(l.id, null, 60);
    if (!name) continue;
    locs.push({ id: slugify(l.id || name, "loc"), name, kind: coerceEnum(l.kind, LOCATION_KINDS, SYN.location, "landmark"), description: str(l.description, `${name}.`, 300) });
  }
  let hubIdx = locs.findIndex((l) => l.kind === "hub");
  const hub = hubIdx >= 0 ? locs.splice(hubIdx, 1)[0] : { ...base.key_locations[0] };
  for (const l of locs) if (l.kind === "hub") l.kind = "village";   // only one hub
  for (const l of [hub, ...locs]) {
    let id = l.id, n = 2;
    while (seen.has(id)) id = `${l.id}_${n++}`;
    seen.add(id);
    if (out.key_locations.length < 6) out.key_locations.push({ ...l, id });
  }
  for (const l of base.key_locations.slice(1)) {
    if (out.key_locations.length >= 4) break;
    if (seen.has(l.id)) continue;
    seen.add(l.id); out.key_locations.push({ ...l });
  }

  // Characters: same treatment, then guarantee the roles the gameplay stage needs.
  const cseen = new Set(out.key_locations.map((l) => l.id));
  const chars = [];
  for (const c of Array.isArray(j.characters) ? j.characters : []) {
    if (!c || typeof c !== "object") continue;
    const name = str(c.name, null, 60) || str(c.id, null, 60);
    if (!name) continue;
    let id = slugify(c.id || name, "npc"), n = 2;
    const stem = id;
    while (cseen.has(id)) id = `${stem}_${n++}`;
    cseen.add(id);
    chars.push({ id, name, role: coerceEnum(c.role, CHARACTER_ROLES, SYN.role, "ambient"), description: str(c.description, `${name}.`, 300) });
  }
  const need = ["quest_giver", "companion"];
  if (out.genre !== "puzzle") need.push("hostile");
  const has = (role) => chars.some((c) => (role === "hostile" ? HOSTILE_ROLES.includes(c.role) : c.role === role));
  const missing = need.filter((r) => !has(r));
  // Trim to leave room for the fills, never dropping a role that is needed.
  while (chars.length + missing.length > 5) {
    const i = chars.map((c) => c.role).lastIndexOf("ambient");
    const drop = i >= 0 ? i : chars.findLastIndex((c) => !need.includes(c.role) && !(need.includes("hostile") && HOSTILE_ROLES.includes(c.role) && chars.filter((x) => HOSTILE_ROLES.includes(x.role)).length === 1));
    if (drop < 0) break;
    chars.splice(drop, 1);
  }
  for (const role of missing) {
    const pick = base.characters.find((c) => (role === "hostile" ? HOSTILE_ROLES.includes(c.role) : c.role === role))
      || (role === "hostile" ? { id: HOSTILE[out.biome][1], name: HOSTILE[out.biome][2], role: HOSTILE[out.biome][0], description: HOSTILE[out.biome][3] + "." } : null);
    if (!pick) continue;
    let id = pick.id, n = 2;
    while (cseen.has(id)) id = `${pick.id}_${n++}`;
    cseen.add(id);
    chars.push({ ...pick, id });
  }
  for (const c of base.characters) {
    if (chars.length >= 3) break;
    if (cseen.has(c.id)) continue;
    cseen.add(c.id); chars.push({ ...c });
  }
  // The quest giver leads the list so readers find them first.
  chars.sort((a, b) => (a.role === "quest_giver" ? -1 : 0) - (b.role === "quest_giver" ? -1 : 0));
  out.characters = chars.slice(0, 5);

  const strList = (v, fb) => {
    const xs = (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.text || x.description || x.title || x.name : null))
      .filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, 12);
    return xs.length ? xs : [...fb];
  };
  out.objectives_outline = strList(j.objectives_outline ?? j.objectives, base.objectives_outline);
  out.hazards = strList(j.hazards, base.hazards);
  return out;
}

// --------------------------------------------------------------------- LLM

const CONCEPT_SYSTEM = `You are the game designer for DCS Games, turning a player's prompt into a small playable 3D game concept.
Return ONE JSON object and nothing else, with exactly these keys:
{
  "title": string (max 60 chars), "logline": string (one sentence),
  "genre": ${GENRES.map((g) => `"${g}"`).join("|")},
  "biome": ${BIOMES.map((g) => `"${g}"`).join("|")},
  "scale": "small"|"medium"|"large",
  "mood": one lowercase word, "time_of_day": number 0..1 (0.5 = noon, 0.76 = dusk),
  "weather": ${WEATHERS.map((g) => `"${g}"`).join("|")},
  "palette": { "primary","secondary","accent","ground","sky","water": "#rrggbb" },
  "player_fantasy": string,
  "key_locations": [ { "id": snake_case, "name": string, "kind": ${LOCATION_KINDS.map((g) => `"${g}"`).join("|")}, "description": string } ],
  "characters": [ { "id": snake_case, "name": string, "role": ${CHARACTER_ROLES.map((g) => `"${g}"`).join("|")}, "description": string } ],
  "objectives_outline": [string], "hazards": [string]
}
Rules: 4-6 key_locations, the FIRST is the start "hub" and it is the only hub; the most dramatic location goes LAST.
3-5 characters: exactly one "companion", one "quest_giver", and at least one guard/enemy/creature unless the genre is puzzle.
Make it specific to the prompt. JSON only.`;

export function conceptAdapters({ env = process.env, chat = null } = {}) {
  return [
    cerebrasJsonAdapter({
      lane: CONCEPT_LANE, system: CONCEPT_SYSTEM, env, chat, maxTokens: 2500, temperature: 0.7,
      build: (req) => `Prompt: "${req.prompt}"\nSeed: ${req.seed}. Design the concept.`,
    }),
    localAdapter({ lane: CONCEPT_LANE, name: "local:keyword-concept", produce: (req) => conceptLocally(req.prompt, { seed: req.seed }) }),
  ];
}

/**
 * CONTRACT §4.5 stage 1.
 * @param {string} prompt
 * @param {{ seed?: number, env?: object, adapters?: object[] }} opts
 *   `adapters` replaces the default adapter list (tests inject fakes); a
 *   deterministic fallback is appended if the list lacks one.
 */
export async function generateConcept(prompt, { seed, env = process.env, adapters } = {}) {
  const text = String(prompt ?? "").trim();
  const s = Number.isInteger(seed) && seed >= 0 ? seed : hashString(text);
  const base = conceptLocally(text, { seed: s });
  const fallback = localAdapter({ lane: CONCEPT_LANE, name: "local:keyword-concept", produce: () => base });
  const lane = new Lane(CONCEPT_LANE, adapters ? withFallback(adapters, fallback) : conceptAdapters({ env }));

  const { value, provenance } = await lane.run({ prompt: text, seed: s });
  if (provenance.status === STATUS.FALLBACK) {
    return { concept: base, provenance: stageProvenance("concept", provenance) };
  }
  const { _model, _usage, ...raw } = value;
  const concept = repairConcept(raw, base);
  const v = validateConcept(concept);
  if (!v.ok) {
    // Repair should make this unreachable; if it happens, the honest outcome
    // is the deterministic concept labelled FALLBACK, not a half-valid one.
    return {
      concept: base,
      provenance: {
        ...stageProvenance("concept", { ...provenance, provider: "local:keyword-concept", model: _model || provenance.model },
          { usage: _usage, statusOverride: STATUS.FALLBACK, extraFailed: [provenance.provider], billed: true }),
        model: "deterministic",
      },
    };
  }
  return { concept, provenance: stageProvenance("concept", provenance, { usage: _usage, model: _model }) };
}
