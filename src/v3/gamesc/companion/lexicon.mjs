// GAMES-C companion — lexicon: synonym tables, number words, directions, limits.
//
// Pure data. Everything the intent parser "knows" about English lives here so it
// can be read, tested and extended without touching the grammar.

export const CATEGORIES = ["scene", "asset_replace", "gameplay_rule", "npc", "lighting_weather", "ui", "objective", "expand_area"];

/** Hard limits. The parser clamps to these; it never emits more. */
export const LIMITS = Object.freeze({
  MAX_INPUT_CHARS: 500,
  MAX_CLAUSES: 6,
  MAX_ENEMIES_PER_REQUEST: 5,
  MAX_NPCS_PER_REQUEST: 5,
  MAX_STRUCTURES_PER_REQUEST: 5,
  MAX_OPS: 64,
  MAX_MOVE_DISTANCE: 200,
  WORLD_COORD_LIMIT: 4096,
  GRAVITY_MIN: -30,
  GRAVITY_MAX: -1,
  MAX_FREE_TEXT: 80,
  CONTEXT_TURNS: 8,
  CONTEXT_ENTITIES: 8,
});

/**
 * Manifest paths the companion emits `set` ops against.
 *
 * environment.* and meta.title are schema-backed (src/v3/manifest/schema.mjs).
 * gameplay.* and ui.* are NOT in WorldManifestV3 today — they are the proposed
 * additive fields; whether they are accepted is decided by the patch module's
 * whitelist (src/v3/gamesc/patch). See DCS_GAMES_COMPANION_SPEC.md.
 */
export const SET_PATHS = Object.freeze({
  weather: "environment.weather",
  time_of_day: "environment.time_of_day",
  gravity: "environment.gravity",
  title: "meta.title",
  description: "meta.description",
  player_speed: "gameplay.player.move_speed",
  player_jump: "gameplay.player.jump_height",
  difficulty: "gameplay.rules.difficulty",
  ui_minimap: "ui.minimap",
  ui_hud: "ui.hud_visible",
  ui_objectives: "ui.show_objectives",
  ui_crosshair: "ui.crosshair",
});

/** Assumed baselines when the manifest has no gameplay.player block yet (no runtime reads these today). */
export const PLAYER_DEFAULTS = Object.freeze({ move_speed: 5, jump_height: 1.5 });
export const PLAYER_BOUNDS = Object.freeze({ move_speed: [0.5, 30], jump_height: [0, 20] });

// Kept in lockstep with src/v3/manifest/schema.mjs WEATHERS (asserted in tests).
export const WEATHER_WORDS = [
  [/\b(rain(y|ing|s)?|drizzl(e|y|ing)|showers?)\b/, "rain"],
  [/\b(storm(y|s)?|thunder(storm)?s?|lightning)\b/, "storm"],
  [/\b(snow(y|ing|s)?|blizzard|wintry)\b/, "snow"],
  [/\b(fog(gy)?|mist(y)?|haz(e|y))\b/, "fog"],
  [/\b(sandstorm|dust ?storm|dusty)\b/, "sandstorm"],
  [/\b(ash(fall|y)?|volcanic)\b/, "ash"],
  [/\b(cloud(y|s)?|overcast|grey|gray)\b/, "cloudy"],
  [/\b(sunny|sun|clear( skies| sky)?|nice weather|stop (the )?(rain|snow|storm)|no (rain|snow|fog))\b/, "clear"],
];

// time_of_day in [0,1]: 0 = midnight, 0.5 = noon (schema.mjs). night matches planner.mjs (0.02).
export const TIME_WORDS = [
  [/\b(midnight)\b/, 0.0, "midnight"],
  [/\b(night(time)?|dark(ness)?|nighttime)\b/, 0.02, "night"],
  [/\b(dawn|sunrise|early morning|daybreak)\b/, 0.27, "dawn"],
  [/\b(morning)\b/, 0.33, "morning"],
  [/\b(noon|midday|mid-day|daytime|day(light)?|bright)\b/, 0.5, "midday"],
  [/\b(afternoon)\b/, 0.65, "afternoon"],
  [/\b(sunset|dusk|evening|twilight|golden hour)\b/, 0.78, "dusk"],
];

export const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, single: 1, another: 1,
  two: 2, pair: 2, couple: 2, both: 2,
  three: 3, few: 3, several: 3, some: 3,
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, hundred: 100, many: 5, lots: 5, bunch: 4,
};

/** North is -z (the runtime camera looks down -z at spawn); east is +x. */
export const DIRECTIONS = {
  north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 },
  northeast: { x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 }, northwest: { x: -Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 },
  southeast: { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }, southwest: { x: -Math.SQRT1_2, y: 0, z: Math.SQRT1_2 },
  left: { x: -1, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: -1 }, ahead: { x: 0, y: 0, z: -1 }, forwards: { x: 0, y: 0, z: -1 },
  back: { x: 0, y: 0, z: 1 }, backward: { x: 0, y: 0, z: 1 }, backwards: { x: 0, y: 0, z: 1 }, behind: { x: 0, y: 0, z: 1 },
  up: { x: 0, y: 1, z: 0 }, higher: { x: 0, y: 1, z: 0 }, down: { x: 0, y: -1, z: 0 }, lower: { x: 0, y: -1, z: 0 },
};
export const DIRECTION_ALIASES = { northward: "north", southward: "south", eastward: "east", westward: "west", "north-east": "northeast", "north-west": "northwest", "south-east": "southeast", "south-west": "southwest", "north east": "northeast", "north west": "northwest", "south east": "southeast", "south west": "southwest" };

export const DEFAULT_STEP = 10;
export const STEP_WORDS = [
  [/\b(a (little|tiny) bit|a little|slightly|a bit|a touch|nudge)\b/, 4],
  [/\b(a lot|far|way|much|significantly|a long way)\b/, 30],
];

/** Buildings / props the companion can add, mapped to curated archetypes (providers/asset3d.mjs). */
export const STRUCTURE_WORDS = {
  castle: "keep_hall", fortress: "keep_hall", fort: "keep_hall", keep: "keep_hall", citadel: "keep_hall", stronghold: "keep_hall", hall: "keep_hall",
  tower: "tower", skyscraper: "tower", spire: "tower",
  watchtower: "watchtower", lookout: "watchtower", outpost: "watchtower",
  church: "chapel", chapel: "chapel", temple: "chapel", shrine: "chapel", cathedral: "chapel",
  house: "cottage", home: "cottage", cottage: "cottage", hut: "cottage", cabin: "cottage",
  inn: "tavern", tavern: "tavern", pub: "tavern", bar: "tavern",
  shop: "shop", store: "shop", market: "shop", stall: "shop",
  warehouse: "warehouse", barn: "warehouse", depot: "warehouse",
  smithy: "smithy", blacksmith: "smithy", forge: "smithy",
  manor: "manor_wing", mansion: "manor_wing", palace: "manor_wing",
  apartment: "apartment_block", apartments: "apartment_block", flats: "apartment_block",
  office: "office", diner: "diner", cafe: "diner", restaurant: "diner",
  boathouse: "boathouse", shelter: "shelter", tent: "shelter",
  greenhouse: "greenhouse_dome", dome: "greenhouse_dome", habitat: "habitat_pod", pod: "habitat_pod",
  well: "well", campfire: "campfire_ring", fire: "campfire_ring", crane: "crane",
  bridge: "bridge", ruin: "ruin_arch", ruins: "ruin_arch", arch: "ruin_arch",
  car: "runabout", vehicle: "runabout", truck: "runabout", boat: "small_boat", ship: "small_boat",
};

/** Hostile characters. Creature words get the quadruped archetype, the rest a humanoid. */
export const ENEMY_WORDS = {
  enemy: "humanoid", enemies: "humanoid", foe: "humanoid", foes: "humanoid", hostile: "humanoid", hostiles: "humanoid",
  bandit: "humanoid", bandits: "humanoid", goblin: "humanoid", goblins: "humanoid", orc: "humanoid", orcs: "humanoid",
  zombie: "humanoid", zombies: "humanoid", skeleton: "humanoid", skeletons: "humanoid", raider: "humanoid", raiders: "humanoid",
  soldier: "humanoid", soldiers: "humanoid", pirate: "humanoid", pirates: "humanoid", robot: "humanoid", robots: "humanoid",
  monster: "creature_quadruped", monsters: "creature_quadruped", wolf: "creature_quadruped", wolves: "creature_quadruped",
  beast: "creature_quadruped", beasts: "creature_quadruped", creature: "creature_quadruped", creatures: "creature_quadruped",
  spider: "creature_quadruped", spiders: "creature_quadruped", bear: "creature_quadruped", bears: "creature_quadruped",
  dragon: "creature_quadruped", dragons: "creature_quadruped",
};

/** Friendly NPC roles. */
export const NPC_WORDS = {
  npc: "villager", npcs: "villager", villager: "villager", villagers: "villager", person: "villager", people: "villager",
  merchant: "merchant", merchants: "merchant", trader: "merchant", vendor: "merchant", shopkeeper: "merchant",
  guard: "guard", guards: "guard", knight: "knight", knights: "knight", wizard: "wizard", mage: "wizard",
  healer: "healer", medic: "healer", doctor: "healer", farmer: "farmer", farmers: "farmer", child: "child", kid: "child",
  blacksmith_npc: "blacksmith", innkeeper: "innkeeper", bard: "bard", priest: "priest", scientist: "scientist", ranger: "ranger",
  companion: "companion", friend: "companion", ally: "ally", allies: "ally",
};

/** "add another area / a forest / a zone" → a planner blueprint key (expansion/planner.mjs). */
export const AREA_WORDS = {
  area: null, zone: null, region: null, district: null, quarter: null, level: null, section: null,
  forest: "park", woods: "park", wood: "park", jungle: "park", meadow: "park", field: "park", fields: "park", garden: "park", park: "park", grove: "park", swamp: "park", marsh: "park",
  island: "island", lake: "island", beach: "island", coast: "island", desert: null, mountain: null, mountains: null, cave: null, caves: null, canyon: null, valley: null,
  village: "residential", town: "residential", neighbourhood: "residential", neighborhood: "residential", suburb: "residential",
  marketplace: "market", bazaar: "market", docks: "docks", harbor: "docks", harbour: "docks", port: "docks",
  hospital: "hospital", airport: "airport", university: "university", campus: "university", factory: "industrial", industrial: "industrial",
  base: "military", barracks: "military",
};
export const WILDERNESS_AREAS = new Set(["forest", "woods", "wood", "jungle", "meadow", "field", "fields", "garden", "park", "grove", "swamp", "marsh", "island", "lake", "beach", "coast", "desert", "mountain", "mountains", "cave", "caves", "canyon", "valley"]);

/** Character look replacements ("replace character with a knight"). */
export const LOOK_WORDS = new Set(["knight", "wizard", "mage", "robot", "astronaut", "pirate", "ninja", "samurai", "soldier", "viking", "elf", "dwarf", "orc", "zombie", "skeleton", "cowboy", "explorer", "detective", "princess", "prince", "king", "queen", "warrior", "archer", "monk", "alien", "cat", "dog", "fox", "wolf", "bear", "dragon"]);

export const UI_WORDS = [
  [/\b(mini ?-?map|map)\b/, "ui_minimap", "minimap"],
  [/\b(hud|heads[- ]up display|interface|ui)\b/, "ui_hud", "HUD"],
  [/\b(crosshairs?|reticle)\b/, "ui_crosshair", "crosshair"],
  [/\b(quest (tracker|log)|objectives?( tracker| markers?)?|tracker)\b/, "ui_objectives", "objective tracker"],
];

/** Verbs that may begin a new clause in a multi-intent utterance. */
export const CLAUSE_VERBS = ["make", "add", "move", "remove", "delete", "destroy", "change", "set", "rename", "call", "name", "replace", "swap", "hide", "show", "turn", "put", "place", "spawn", "give", "let", "create", "build", "increase", "decrease", "raise", "lower", "reduce", "shift", "push", "pull", "bring", "drop", "get", "enable", "disable", "expand", "extend", "double", "halve", "speed", "slow", "stop", "start", "clear",
  // not supported, but recognising them as verbs lets "make it night and do my taxes" split, so the unknown part is reported instead of silently swallowed
  "do", "fly", "write", "send", "tell", "buy", "sell", "order", "book", "play", "open", "teach", "email", "bake", "cook", "sing", "draw", "delete"];

/** What the companion can do — returned verbatim on an unsupported request. */
export const CAPABILITIES = [
  { category: "lighting_weather", examples: ["make it night", "make it rain", "make it foggy", "make it sunny", "set it to dusk"] },
  { category: "scene", examples: ["add a tower near the castle", "move the castle north", "move it to 40, 60", "remove the tower", "rename the world to Emberfall", "make the tavern bigger"] },
  { category: "npc", examples: ["add two enemies", "add an enemy near the castle", "add a merchant", "rename the merchant to Tomas"] },
  { category: "gameplay_rule", examples: ["make the player faster", "make the player jump higher", "lower the gravity", "make enemies harder"] },
  { category: "asset_replace", examples: ["replace the character with a knight", "replace the tower with a castle"] },
  { category: "ui", examples: ["hide the minimap", "show the crosshair"] },
  { category: "objective", examples: ["change the mission to rescue the miller"] },
  { category: "expand_area", examples: ["add another area", "add a forest", "add a market district"] },
];
