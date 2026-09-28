// GAMES-C companion — the intent grammar.
//
// Each handler looks at ONE clause and returns one of:
//   { ops, category, summary, confidence, entities? }   — understood
//   { clarify: "question", options? }                  — understood the shape, not the target
//   null                                                 — not mine; try the next handler
//
// Handlers read the manifest and a small parse state (entities added earlier in
// the same utterance, positions already moved) — they never mutate either input.
// Nothing here executes text: every value is built by code from a closed
// vocabulary, and the only free text that reaches an op goes through
// cleanFreeText().
import {
  SET_PATHS, WEATHER_WORDS, TIME_WORDS, NUMBER_WORDS, DIRECTIONS, DIRECTION_ALIASES, DEFAULT_STEP, STEP_WORDS,
  STRUCTURE_WORDS, ENEMY_WORDS, NPC_WORDS, AREA_WORDS, WILDERNESS_AREAS, LOOK_WORDS, UI_WORDS, LIMITS,
  PLAYER_DEFAULTS, PLAYER_BOUNDS,
} from "./lexicon.mjs";
import { cleanFreeText, clamp, round2 } from "./safety.mjs";
import { resolveEntity, positionOf, spawnPosition, zoneAt, describeWorld, tokens } from "./resolve.mjs";
import { buildAsset } from "../../providers/asset3d.mjs";
import { planExpansion } from "../../expansion/planner.mjs";

// ------------------------------------------------------------------ helpers
const titleCase = (s) => String(s).split(/[_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "thing";
const plural = (w, n) => (n === 1 ? w : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : /(?<!f)f$/.test(w) ? w.slice(0, -1) + "ves" : /(s|x|ch|sh)$/.test(w) ? w + "es" : w + "s");
const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const PRONOUN_ONE = /^(it|that|this|that one|this one|the thing|the same)$/;
const PRONOUN_MANY = /^(them|they|those|these|all of them|both|both of them)$/;
const COORD = LIMITS.WORLD_COORD_LIMIT;
const clampPos = (p) => ({ x: round2(clamp(p.x, -COORD, COORD)), y: round2(clamp(p.y ?? 0, 0, 512)), z: round2(clamp(p.z, -COORD, COORD)) });

function allIds(st) {
  const ids = new Set(st.usedIds);
  for (const c of ["zones", "assets", "structures", "npcs", "items", "quests", "interactions", "behaviors"]) for (const e of st.manifest[c] || []) if (e?.id) ids.add(e.id);
  return ids;
}
function freshId(st, prefix) {
  const ids = allIds(st);
  for (let n = 1; n < 10000; n++) {
    const id = `${prefix}_${n}`;
    if (!ids.has(id)) { st.usedIds.add(id); return id; }
  }
  throw new Error("id space exhausted");
}

/** "two", "3", "a couple of", "a few" → integer, or null. */
export function parseCount(text) {
  const m = /\b(\d{1,4})\b/.exec(text);
  if (m) return Number(m[1]);
  for (const w of tokens(text)) if (w in NUMBER_WORDS) return NUMBER_WORDS[w];
  return null;
}

function parseDirection(text) {
  let t = text;
  for (const [k, v] of Object.entries(DIRECTION_ALIASES)) t = t.replace(new RegExp(`\\b${k}\\b`, "g"), v);
  const w = tokens(t).find((x) => DIRECTIONS[x]);
  return w ? { word: w, vec: DIRECTIONS[w] } : null;
}

function parseStep(text) {
  const by = /\bby\s+(\d+(?:\.\d+)?)\s*(m|meters?|metres?|units?|tiles?|steps?)?\b/.exec(text) || /\b(\d+(?:\.\d+)?)\s*(m|meters?|metres?|units?|tiles?|steps?)\b/.exec(text);
  if (by) return clamp(Number(by[1]), 0, LIMITS.MAX_MOVE_DISTANCE);
  for (const [re, n] of STEP_WORDS) if (re.test(text)) return n;
  return DEFAULT_STEP;
}

/** "10, 20" / "(10 20)" / "x 10 z 20" / "10,2,20" → {x,y?,z} or null. */
export function parseCoords(text) {
  const named = /\bx\s*[=:]?\s*(-?\d+(?:\.\d+)?)\b.*?\b(?:(?:y\s*[=:]?\s*(-?\d+(?:\.\d+)?))\b.*?\b)?z\s*[=:]?\s*(-?\d+(?:\.\d+)?)/.exec(text);
  if (named) return { x: Number(named[1]), y: named[2] !== undefined ? Number(named[2]) : undefined, z: Number(named[3]) };
  const nums = /(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)(?:\s*[, ]\s*(-?\d+(?:\.\d+)?))?/.exec(text);
  if (!nums) return null;
  if (nums[3] !== undefined) return { x: Number(nums[1]), y: Number(nums[2]), z: Number(nums[3]) };
  return { x: Number(nums[1]), y: undefined, z: Number(nums[2]) };
}

/** Deterministic spread around a point: golden-angle ring. */
function ringPoint(center, i, radius) {
  const a = (i * 137.508 * Math.PI) / 180;
  return clampPos({ x: center.x + Math.cos(a) * radius, y: center.y ?? 0, z: center.z + Math.sin(a) * radius });
}

/** Current position, honouring earlier moves/adds in the same utterance. */
function currentPos(st, ref) {
  if (st.positions.has(ref.id)) return { ...st.positions.get(ref.id) };
  const pend = st.pending.find((p) => p.value.id === ref.id);
  return positionOf(ref.collection, pend ? pend.value : ref.entity);
}

/**
 * Resolve a noun phrase to entities. Handles pronouns from context and from
 * earlier clauses of the same utterance.
 * @returns {{refs:Array}|{clarify:string, options?:Array}}
 */
function resolveRefs(phrase, st, { collections = ["structures", "npcs", "zones", "items"], what = "that" } = {}) {
  const p = String(phrase || "").trim().replace(/^(the|a|an)\s+/, "");
  if (PRONOUN_ONE.test(p) || PRONOUN_MANY.test(p)) {
    const pool = st.lastEntities.filter((e) => collections.includes(e.collection));
    if (!pool.length) return { clarify: `What do you mean by "${p}"? Name the thing you want me to ${what}.` };
    const refs = (PRONOUN_MANY.test(p) ? pool : [pool[0]]).map((r) => withEntity(st, r)).filter(Boolean);
    if (!refs.length) return { clarify: `What I last referred to as "${p}" no longer exists in this world. What should I ${what}?` };
    return { refs };
  }
  const last = tokens(p).at(-1) || "";
  const plural = /^(all|every|both)\b/.test(p) || (/s$/.test(last) && !/ss$/.test(last) && last.length > 3);
  const r = resolveEntity(p.replace(/^(all|every|both)\s+(of\s+)?(the\s+)?/, ""), st.manifest, { pending: st.pending, collections, plural });
  if (r.status === "found") return { refs: [r.match], fuzzy: r.fuzzy };
  if (r.status === "found_many") return { refs: r.matches };
  if (r.status === "ambiguous") {
    return { clarify: `Which one do you mean: ${r.candidates.map((c) => `${c.label} (${c.id})`).join(", ")}?`, options: r.candidates.map((c) => ({ collection: c.collection, id: c.id, label: c.label })) };
  }
  const seen = describeWorld(st.manifest);
  return { clarify: `I can't find "${p}" in this world.${seen.length ? ` I can see: ${seen.join(", ")}.` : ""} Which one did you mean?` };
}
function withEntity(st, r) {
  const pend = st.pending.find((p) => p.value.id === r.id);
  const e = pend ? pend.value : (st.manifest[r.collection] || []).find((x) => x.id === r.id);
  return e ? { collection: r.collection, id: r.id, label: r.label, entity: e } : null;
}

/** Ensure a curated asset exists (or is being added in this utterance). Returns {id, ops}. */
function ensureAsset(st, archetype, kindHint) {
  const a = buildAsset(archetype, { kindHint, seed: 1 });
  const exists = (st.manifest.assets || []).some((x) => x.id === a.id) || st.pending.some((p) => p.collection === "assets" && p.value.id === a.id);
  if (exists) return { id: a.id, ops: [] };
  st.pending.push({ collection: "assets", value: a });
  st.usedIds.add(a.id);
  return { id: a.id, ops: [{ op: "add", collection: "assets", value: a }] };
}

/** Where should something go? Parses "near the castle", "at 10, 20", "north of the tower", "in the forest". */
function parsePlacement(text, st) {
  const coordM = /\b(?:at|to)\s+\(?\s*(x\s*[=:]?\s*)?-?\d/.exec(text);
  if (coordM) {
    const c = parseCoords(text.slice(coordM.index));
    if (c) return { pos: clampPos({ x: c.x, y: c.y ?? 0, z: c.z }), label: `(${c.x}, ${c.z})`, exact: true };
  }
  const rel = /\b(north|south|east|west|northeast|northwest|southeast|southwest|left|right|behind|in front)\s+of\s+(.+)$/.exec(text);
  const near = /\b(?:near|next to|beside|by|around|close to|outside|at|in|inside|within|on|in front of)\s+(.+)$/.exec(text);
  const m = rel || near;
  if (!m) return null;
  const phrase = (rel ? m[2] : m[1]).trim();
  const r = resolveRefs(phrase, st, { what: "use as a location" });
  if (r.clarify) return { clarify: r.clarify, options: r.options };
  const ref = r.refs[0];
  let base = currentPos(st, ref) || spawnPosition(st.manifest);
  if (rel) {
    const d = DIRECTIONS[rel[1] === "in front" ? "forward" : rel[1]];
    base = { x: base.x + d.x * 15, y: base.y ?? 0, z: base.z + d.z * 15 };
    return { pos: clampPos(base), label: `${rel[1]} of ${ref.label}`, anchor: ref, exact: true };
  }
  return { pos: clampPos({ x: base.x, y: ref.collection === "zones" ? 0 : base.y ?? 0, z: base.z }), label: `near ${ref.label}`, anchor: ref, exact: false };
}

function stripPlacement(text) {
  return text.replace(/\b(north|south|east|west|northeast|northwest|southeast|southwest|left|right|behind|in front)\s+of\s+.+$/, "")
    .replace(/\b(near|next to|beside|by|around|close to|outside|at|in|inside|within|on|in front of)\s+.+$/, "").trim();
}

// ================================================================ handlers

// ---- UI ------------------------------------------------------------------
function uiHandler(c) {
  const t = c.lc;
  const hide = /\b(hide|remove|disable|turn off|switch off|get rid of|no more|without)\b/.test(t);
  const show = /\b(show|enable|turn on|switch on|display|bring back|unhide|add)\b/.test(t);
  if (!hide && !show) return null;
  const ops = [], names = [];
  for (const [re, key, name] of UI_WORDS) {
    if (!re.test(t)) continue;
    // "remove the map" in a world with a structure literally called map is a scene edit, not UI.
    if (key === "ui_minimap" && /\bmap\b/.test(t) && !/\bmini ?-?map\b/.test(t) && !/\b(hide|show)\b/.test(t)) continue;
    ops.push({ op: "set", path: SET_PATHS[key], value: !hide });
    names.push(name);
  }
  if (!ops.length) return null;
  return { ops, category: "ui", summary: `${hide ? "hid" : "showed"} the ${names.join(" and ")}`, confidence: 0.9 };
}

// ---- lighting / weather --------------------------------------------------
const LIGHT_TRIGGER = /^(make|set|turn|change|switch|let|have|go|start|stop|it'?s|its|i want|can it be|could it be|bring|cause)\b|\b(weather|sky|time of day|lighting)\b|^(clear|remove|end|get rid of|no more)\b.*\b(rain|snow|fog|mist|storm|clouds?|sandstorm|ash)\b/;
function lightingHandler(c, st) {
  const t = c.lc;
  const addWeather = /^(add|bring|start)\s+(some\s+)?(rain|fog|mist|snow|clouds?|a storm|storms?|thunder|sandstorm|ash)\b/.test(t);
  if (!LIGHT_TRIGGER.test(t) && !addWeather) return null;
  const ops = [], parts = [];
  // Weather
  if (/\b(stop|end|no more|remove|clear)\b.*\b(rain|snow|fog|storm|clouds?|sandstorm|ash)\b/.test(t) || /\bclear (the )?(sky|skies|weather)\b/.test(t)) {
    ops.push({ op: "set", path: SET_PATHS.weather, value: "clear" }); parts.push("weather cleared");
  } else {
    for (const [re, w] of WEATHER_WORDS) {
      if (re.test(t)) { ops.push({ op: "set", path: SET_PATHS.weather, value: w }); parts.push(`weather set to ${w}`); break; }
    }
  }
  // Time of day
  let time = null;
  const objectLit = /^make\s+(?!it\b|everything\b|things\b|the (world|scene|sky|map|level|game)\b)(.+?)\s+(brighter|darker|lighter|dimmer)\b/.exec(t);
  if (objectLit && !ops.length) return { clarify: `Lighting is world-wide for now — I can't light just ${objectLit[2]}. Should I make the whole world ${objectLit[3]}?` };
  if (/\b(darker|dim(mer)?|gloomier)\b/.test(t)) {
    const now = st.manifest.environment?.time_of_day ?? 0.5;
    time = now >= 0.7 || now < 0.2 ? [0.02, "night"] : [0.78, "dusk"];
  } else if (/\b(brighter|lighter|sunnier)\b/.test(t)) time = [0.5, "midday"];
  else for (const [re, v, name] of TIME_WORDS) {
    // "sunny" already set clear weather; "bright" alone shouldn't double as time unless stated.
    if (re.test(t)) { time = [v, name]; break; }
  }
  if (time) { ops.push({ op: "set", path: SET_PATHS.time_of_day, value: time[0] }); parts.push(`time of day set to ${time[1]}`); }
  if (!ops.length) return null;
  return { ops, category: "lighting_weather", summary: parts.join(", "), confidence: 0.95 };
}

// ---- gameplay rules --------------------------------------------------------
function gameplayHandler(c, st) {
  const t = c.lc;
  const player = st.manifest.gameplay?.player || {};

  // player speed
  const speedWords = /\b(faster|quicker|speedier|slower|speed|run faster|walk faster|move faster|move slower)\b/;
  if (speedWords.test(t) && /\b(player|me|i|my|character|hero|movement|walk(ing)?|run(ning)?|avatar|us)\b/.test(t) && !/\benem(y|ies)\b/.test(t)) {
    const cur = typeof player.move_speed === "number" ? player.move_speed : PLAYER_DEFAULTS.move_speed;
    const setTo = /\b(to|=)\s*(\d+(?:\.\d+)?)/.exec(t);
    let factor = /\b(much|a lot|way|twice|double)\b/.test(t) ? 1.5 : /\b(a (little )?bit|slightly|a little)\b/.test(t) ? 1.1 : 1.25;
    let value;
    if (setTo) value = Number(setTo[2]);
    else if (/\b(slower|slow down|reduce)\b/.test(t)) value = cur / factor;
    else if (/\b(faster|quicker|speedier|speed up|increase)\b/.test(t)) value = cur * factor;
    else return { clarify: "Should the player be faster or slower (or give a speed, e.g. 'set player speed to 8')?" };
    const [lo, hi] = PLAYER_BOUNDS.move_speed;
    const v = round2(clamp(value, lo, hi));
    return { ops: [{ op: "set", path: SET_PATHS.player_speed, value: v }], category: "gameplay_rule", summary: `player move speed ${cur} → ${v}${v !== round2(value) ? " (clamped)" : ""}`, confidence: 0.9 };
  }

  // jump
  if (/\bjump(s|ing)?\b/.test(t)) {
    const cur = typeof player.jump_height === "number" ? player.jump_height : PLAYER_DEFAULTS.jump_height;
    const setTo = /\b(to|=)\s*(\d+(?:\.\d+)?)/.exec(t);
    const factor = /\b(much|a lot|way|twice|double)\b/.test(t) ? 1.6 : 1.3;
    let value;
    if (setTo) value = Number(setTo[2]);
    else if (/\b(higher|further|farther|more|better|bigger|super)\b/.test(t)) value = cur * factor;
    else if (/\b(lower|less|shorter|smaller|weaker)\b/.test(t)) value = cur / factor;
    else if (/\b(can'?t|cannot|no|disable)\b/.test(t)) value = 0;
    else return { clarify: "Should the player jump higher or lower?" };
    const [lo, hi] = PLAYER_BOUNDS.jump_height;
    const v = round2(clamp(value, lo, hi));
    return { ops: [{ op: "set", path: SET_PATHS.player_jump, value: v }], category: "gameplay_rule", summary: `player jump height ${cur} → ${v}${v !== round2(value) ? " (clamped)" : ""}`, confidence: 0.9 };
  }

  // gravity
  if (/\bgravity\b/.test(t) || /\bmoon ?(gravity|physics)\b/.test(t)) {
    const cur = typeof st.manifest.environment?.gravity === "number" ? st.manifest.environment.gravity : -9.81;
    let v;
    if (/\b(normal|earth|default|reset)\b/.test(t)) v = -9.81;
    else if (/\bmoon\b/.test(t)) v = -1.62;
    else if (/\b(no|zero|off)\b/.test(t)) v = LIMITS.GRAVITY_MAX;
    else if (/\b(lower|less|weaker|reduce|decrease|floaty|lighter)\b/.test(t)) v = cur * 0.5;
    else if (/\b(higher|more|stronger|increase|heavier)\b/.test(t)) v = cur * 1.5;
    else return { clarify: "Should gravity be lower, higher, or back to normal?" };
    v = round2(clamp(v, LIMITS.GRAVITY_MIN, LIMITS.GRAVITY_MAX));
    return { ops: [{ op: "set", path: SET_PATHS.gravity, value: v }], category: "gameplay_rule", summary: `gravity ${cur} → ${v}`, confidence: 0.9 };
  }

  // enemies stronger/weaker (reuses planner.mjs enemy_density semantics as per-behavior spec updates)
  const enemyTune = /\benem(y|ies)|monsters?|hostiles?\b/.test(t) && /\b(harder|stronger|tougher|more dangerous|deadlier|easier|weaker|less dangerous)\b/.test(t);
  if (enemyTune) {
    const up = /\b(harder|stronger|tougher|more dangerous|deadlier)\b/.test(t);
    const enemies = (st.manifest.behaviors || []).filter((b) => b.kind === "enemy_ai");
    if (!enemies.length) return { clarify: "This world has no enemies yet. Want me to add some first (e.g. 'add two enemies')?" };
    const ops = enemies.slice(0, LIMITS.MAX_OPS - 1).map((b) => ({
      op: "update", collection: "behaviors", id: b.id,
      set: { spec: { ...b.spec, health: Math.max(20, Math.round((b.spec?.health || 60) * (up ? 1.3 : 0.75))), damage: Math.max(1, Math.round((b.spec?.damage || 8) * (up ? 1.25 : 0.75))) } },
    }));
    return { ops, category: "gameplay_rule", summary: `made ${enemies.length} enem${enemies.length === 1 ? "y" : "ies"} ${up ? "stronger" : "weaker"}`, confidence: 0.85 };
  }

  // overall difficulty
  const diff = /\b(make|set|change)\b.*\b(harder|easier|difficulty|difficult|challenging)\b/.exec(t) || /\bdifficulty\b/.exec(t);
  if (diff) {
    const cur = st.manifest.gameplay?.rules?.difficulty || "normal";
    let v = /\beasy\b/.test(t) ? "easy" : /\bhard\b/.test(t) ? "hard" : /\bnormal|medium\b/.test(t) ? "normal"
      : /\b(harder|more difficult|more challenging|challenging)\b/.test(t) ? (cur === "easy" ? "normal" : "hard")
      : /\beasier\b/.test(t) ? (cur === "hard" ? "normal" : "easy") : null;
    if (!v) return { clarify: "Which difficulty: easy, normal or hard?" };
    return { ops: [{ op: "set", path: SET_PATHS.difficulty, value: v }], category: "gameplay_rule", summary: `difficulty ${cur} → ${v}`, confidence: 0.85 };
  }
  return null;
}

// ---- objective -------------------------------------------------------------
function objectiveHandler(c, st) {
  const m = /\b(?:change|set|make|update|switch|replace)\s+(?:the\s+|my\s+|our\s+)?(?:main\s+)?(mission|objective|goal|quest|task)\s*(?:to|into|as|so (?:that )?(?:it'?s|it is)|:|=)?\s*(.*)$/.exec(c.lc)
    || /\bnew\s+(mission|objective|goal|quest)\s*:?\s*(.*)$/.exec(c.lc)
    || /\bthe\s+(mission|objective|goal)\s+(?:should be|is now|is)\s+(.*)$/.exec(c.lc);
  if (!m) return null;
  const rawText = c.orig.slice(c.orig.length - m[2].length).replace(/^(to|:)\s+/i, "");
  const text = cleanFreeText(rawText, LIMITS.MAX_FREE_TEXT);
  if (!text || text.length < 3) return { clarify: `What should the new ${m[1]} be? For example: "change the ${m[1]} to rescue the miller".` };
  const title = capFirst(text);
  const quests = st.manifest.quests || [];
  if (quests.length) {
    const q = quests[0];
    return {
      ops: [{ op: "update", collection: "quests", id: q.id, set: { title, description: title } }],
      category: "objective", summary: `main mission '${q.title}' → '${title}'`, confidence: 0.85,
      entities: [{ collection: "quests", id: q.id, label: title }],
    };
  }
  const zone = (st.manifest.zones || [])[0];
  const id = freshId(st, "quest_main");
  const value = {
    id, title, description: title, giver_npc: null, zone: zone?.id ?? null, difficulty: "normal",
    steps: [zone ? { id: "step_1", kind: "reach", target: zone.id, description: title } : { id: "step_1", kind: "survive", description: title }],
    rewards: [], prerequisites: [],
  };
  st.pending.push({ collection: "quests", value });
  return { ops: [{ op: "add", collection: "quests", value }], category: "objective", summary: `new main mission '${title}'`, confidence: 0.8, entities: [{ collection: "quests", id, label: title }] };
}

// ---- rename ----------------------------------------------------------------
function renameHandler(c, st) {
  const t = c.lc;
  const world = /^(?:rename|call|name|retitle|title)\s+(?:the\s+|this\s+|my\s+)?(world|game|map|level|place)\b\s*(?:to|as|:)?\s*(.*)$/.exec(t)
    || /^(?:change|set)\s+(?:the\s+)?(world|game|level)(?:'s)?\s+(?:name|title)\s*(?:to|as|:)?\s*(.*)$/.exec(t);
  if (world) {
    const name = cleanFreeText(c.orig.slice(c.orig.length - world[2].length), LIMITS.MAX_FREE_TEXT);
    if (!name) return { clarify: `What should the ${world[1]} be called?` };
    return { ops: [{ op: "set", path: SET_PATHS.title, value: name }], category: "scene", summary: `world renamed '${st.manifest.meta?.title ?? ""}' → '${name}'`, confidence: 0.95 };
  }
  const ent = /^(?:rename|call)\s+(.+?)\s+(?:to|as)\s+(.+)$/.exec(t);
  if (!ent) {
    if (/^rename\b/.test(t)) return { clarify: "What should I rename, and to what? For example: 'rename the world to Emberfall'." };
    return null;
  }
  const r = resolveRefs(ent[1], st, { collections: ["npcs", "zones", "structures", "items"], what: "rename" });
  if (r.clarify) return r;
  const name = cleanFreeText(c.orig.slice(c.orig.length - ent[2].length), 60);
  if (!name) return { clarify: "What should the new name be?" };
  const ref = r.refs[0];
  const field = ref.collection === "structures" ? "purpose" : "name";
  return {
    ops: [{ op: "update", collection: ref.collection, id: ref.id, set: { [field]: name } }],
    category: ref.collection === "npcs" ? "npc" : "scene", summary: `renamed ${ref.label} → ${name}`, confidence: r.fuzzy ? 0.75 : 0.9,
    entities: [{ collection: ref.collection, id: ref.id, label: name }],
  };
}

// ---- asset replace -----------------------------------------------------------
const CHARACTER_TARGET = /^(the\s+)?(main\s+)?(character|player|hero|avatar|protagonist|me|my character|player character|characters|all characters|everyone|people)$/;
function replaceHandler(c, st) {
  const t = c.lc;
  const m = /^(?:replace|swap|switch)\s+(.+?)\s+(?:with|for|to)\s+(?:an?\s+|some\s+)?(.+)$/.exec(t)
    || /^(?:turn|change|transform|convert)\s+(.+?)\s+(?:into|to)\s+(?:an?\s+|some\s+)?(.+)$/.exec(t)
    || /^make\s+(the\s+(?:main\s+)?(?:character|player|hero|avatar)|me)\s+(?:look\s+like\s+|into\s+)?(?:an?\s+)(.+)$/.exec(t);
  if (!m) return null;
  const target = m[1].trim();
  const wanted = m[2].trim().replace(/\s+(model|skin|look|character)$/, "");
  const wantedWord = tokens(wanted).at(-1) || "";

  if (CHARACTER_TARGET.test(target)) {
    if (!LOOK_WORDS.has(wantedWord) && !(wantedWord in NPC_WORDS) && !(wantedWord in ENEMY_WORDS)) {
      return { clarify: `I can change the character's look to a known style (for example: ${[...LOOK_WORDS].slice(0, 8).join(", ")}). Which one?` };
    }
    const chars = (st.manifest.assets || []).filter((a) => a.kind === "character");
    if (!chars.length) return { clarify: "This world has no character model to replace yet. Want me to add a character first?" };
    const all = /\b(all|characters|everyone|people)\b/.test(target);
    if (chars.length > 1 && !all) {
      return { clarify: `There are ${chars.length} character models (${chars.map((a) => a.id).join(", ")}). Replace all of them, or which one?`, options: chars.map((a) => ({ collection: "assets", id: a.id, label: a.id })) };
    }
    const ops = chars.map((a) => {
      const built = buildAsset(wantedWord, { kindHint: "character", style: wantedWord, seed: 1 });
      const value = { ...built, id: a.id, composition: { ...built.composition, style: wantedWord }, provenance: { ...built.provenance, requested: wantedWord } };
      return { op: "replace_asset", asset_id: a.id, value };
    });
    return { ops, category: "asset_replace", summary: `character model → ${wantedWord}`, confidence: 0.85, entities: chars.map((a) => ({ collection: "assets", id: a.id, label: a.id })) };
  }

  // A named structure / npc gets a different curated asset.
  const arch = STRUCTURE_WORDS[wantedWord];
  const isChar = LOOK_WORDS.has(wantedWord) || wantedWord in NPC_WORDS || wantedWord in ENEMY_WORDS;
  if (!arch && !isChar) {
    // "change the mission to X", "change the weather to rain" are handled earlier; anything else is unknown.
    return { clarify: `I don't have a "${wanted}" model. I can use: ${Object.keys(STRUCTURE_WORDS).slice(0, 10).join(", ")}, or a character style like knight or robot.` };
  }
  const r = resolveRefs(target, st, { collections: arch ? ["structures"] : ["npcs"], what: "replace" });
  if (r.clarify) return r;
  const ops = [], ents = [];
  for (const ref of r.refs) {
    const asset = arch ? ensureAsset(st, arch, "building") : ensureAsset(st, ENEMY_WORDS[wantedWord] || "humanoid", "character");
    ops.push(...asset.ops);
    const set = { asset_ref: asset.id };
    if (arch) set.purpose = titleCase(wantedWord);
    ops.push({ op: "update", collection: ref.collection, id: ref.id, set });
    ents.push({ collection: ref.collection, id: ref.id, label: ref.label });
  }
  return { ops, category: "asset_replace", summary: `replaced ${r.refs.map((x) => x.label).join(", ")} with ${wantedWord}`, confidence: r.fuzzy ? 0.7 : 0.85, entities: ents };
}

// ---- remove ------------------------------------------------------------------
function removeHandler(c, st) {
  const m = /^(?:remove|delete|destroy|get rid of|take away|take out|demolish|despawn|kill|erase|clear)\s+(?:all\s+(?:of\s+)?)?(.+)$/.exec(c.lc);
  if (!m) return null;
  const phrase = m[1].trim();
  const r = resolveRefs(phrase, st, { collections: ["structures", "npcs", "items", "zones"], what: "remove" });
  if (r.clarify) return r;
  const ops = [], labels = [];
  const removedInteractions = new Set();
  for (const ref of r.refs) {
    if (ref.collection === "zones") return { clarify: `Removing a whole area (${ref.label}) isn't supported — it would strand everything inside it. Remove specific things in it instead?` };
    const e = ref.entity;
    if (e.owner_id) return { clarify: `${ref.label} belongs to a player, so I won't remove it.` };
    const dependents = (st.manifest.quests || []).filter((q) => q.giver_npc === ref.id || (q.steps || []).some((s) => s.target === ref.id));
    if (dependents.length) return { clarify: `The quest "${dependents[0].title}" depends on ${ref.label}. Change or remove that quest first — or pick something else to remove.` };
    // Dependents first so every intermediate state still validates.
    const pickupBehaviors = ref.collection === "items" ? (st.manifest.behaviors || []).filter((b) => b.kind === "pickup" && b.spec?.item === ref.id).map((b) => b.id) : [];
    for (const x of st.manifest.interactions || []) {
      if ((x.target_ref === ref.id || pickupBehaviors.includes(x.behavior_ref)) && !removedInteractions.has(x.id)) {
        removedInteractions.add(x.id);
        ops.push({ op: "remove", collection: "interactions", id: x.id });
      }
    }
    ops.push({ op: "remove", collection: ref.collection, id: ref.id });
    const orphan = [...pickupBehaviors];
    if (ref.collection === "npcs" && e.behavior_ref) orphan.push(e.behavior_ref);
    for (const bid of orphan) {
      const stillUsed = (st.manifest.interactions || []).some((x) => x.behavior_ref === bid && !removedInteractions.has(x.id))
        || (st.manifest.npcs || []).some((n) => n.id !== ref.id && n.behavior_ref === bid);
      if (!stillUsed && (st.manifest.behaviors || []).some((b) => b.id === bid)) ops.push({ op: "remove", collection: "behaviors", id: bid });
    }
    labels.push(ref.label);
  }
  return { ops, category: r.refs.every((x) => x.collection === "npcs") ? "npc" : "scene", summary: `removed ${labels.join(", ")}`, confidence: r.fuzzy ? 0.7 : 0.9, entities: [] };
}

// ---- move ----------------------------------------------------------------------
function moveHandler(c, st) {
  const t = c.lc;
  const m = /^(?:move|shift|push|pull|bring|put|place|relocate|slide|drag|nudge)\s+(.+?)\s+((?:a (?:little |tiny )?bit |slightly |a little |a lot |far |way |much )?(?:further |farther )?(?:north|south|east|west|northeast|northwest|southeast|southwest|north-east|north-west|south-east|south-west|left|right|forwards?|ahead|backwards?|back|up|down|higher|lower|northward|southward|eastward|westward)\b.*|(?:by\s+\d.*)|to\b.*|towards?\b.*|closer\b.*|nearer\b.*|away\b.*|(?:further|farther)\b.*|next to\b.*|near\b.*|beside\b.*)$/.exec(t);
  if (!m) {
    const bare = /^(?:move|shift|relocate|drag)\s+(.+)$/.exec(t);
    if (!bare) return null;
    return { clarify: `Where should I move ${bare[1].replace(/^the\s+/, "the ")}? Try a direction ("north"), coordinates ("to 40, 60") or a landmark ("next to the tavern").` };
  }
  let subject = m[1].trim(), rest = m[2].trim();
  if (/^(an?|another|one|two|three|four|five|some|\d+)\s/.test(subject)) return null;          // "put a tower near…" is an add
  const r = resolveRefs(subject, st, { collections: ["structures", "npcs", "zones"], what: "move" });
  if (r.clarify) return r;

  const ops = [], parts = [], ents = [];
  for (const [i, ref] of r.refs.entries()) {
    const from = currentPos(st, ref);
    if (!from) return { clarify: `${ref.label} has no position I can move.` };
    let to;
    const dir = parseDirection(rest);
    const toCoords = /^(?:to|at)\s+\(?\s*(x\s*[=:]?\s*)?-?\d/.test(rest) ? parseCoords(rest) : null;
    if (toCoords) {
      to = { x: toCoords.x, y: toCoords.y ?? from.y ?? 0, z: toCoords.z };
      parts.push(`${ref.label} → (${to.x}, ${to.z})`);
    } else if (/^(closer|nearer|towards?)\b/.test(rest) || /^(away|further|farther)\b(?!\s+(north|south|east|west))/.test(rest)) {
      const away = /^(away|further|farther)\b/.test(rest);
      const tgtPhrase = /\b(?:to|from|towards?|of)\s+(.+)$/.exec(rest.replace(/^(closer|nearer|towards?|away|further|farther)\s*/, "$1 "))?.[1];
      let target, tlabel;
      if (!tgtPhrase || /^(me|us|the player|player|spawn|the spawn|start|the start)$/.test(tgtPhrase.trim())) { target = spawnPosition(st.manifest); tlabel = "the player spawn"; }
      else {
        const rt = resolveRefs(tgtPhrase, st, { what: "move towards" });
        if (rt.clarify) return rt;
        target = currentPos(st, rt.refs[0]) || spawnPosition(st.manifest); tlabel = rt.refs[0].label;
      }
      const dx = target.x - from.x, dz = target.z - from.z, d = Math.hypot(dx, dz) || 1;
      const step = away ? parseStep(rest) : Math.min(parseStep(rest) === DEFAULT_STEP ? d * 0.5 : parseStep(rest), Math.max(0, d - 4));
      const sgn = away ? -1 : 1;
      to = { x: from.x + sgn * (dx / d) * step, y: from.y ?? 0, z: from.z + sgn * (dz / d) * step };
      parts.push(`${ref.label} ${away ? "away from" : "closer to"} ${tlabel}`);
    } else if (/^(to|next to|near|beside)\b/.test(rest)) {
      const phrase = rest.replace(/^(to|next to|near|beside)\s+(the\s+(?:side|front|edge)\s+of\s+)?/, "");
      if (/^(the\s+)?(north|south|east|west|left|right)$/.test(phrase)) {
        const dd = parseDirection(phrase), step = parseStep(rest);
        to = { x: from.x + dd.vec.x * step, y: from.y ?? 0, z: from.z + dd.vec.z * step };
        parts.push(`${ref.label} ${dd.word} by ${step}`);
      } else if (/^(the\s+)?(north|south|east|west)(ern)?(\s+(side|edge|part))?$/.test(phrase)) {
        const dd = parseDirection(phrase);
        const size = st.manifest.terrain?.size || { w: 128, h: 128 };
        to = { x: dd.vec.x ? (dd.vec.x > 0 ? size.w * 0.9 : size.w * 0.1) : from.x, y: from.y ?? 0, z: dd.vec.z ? (dd.vec.z > 0 ? size.h * 0.9 : size.h * 0.1) : from.z };
        parts.push(`${ref.label} → ${dd.word} edge`);
      } else {
        const rt = resolveRefs(phrase, st, { what: "move next to" });
        if (rt.clarify) return rt;
        if (rt.refs[0].id === ref.id) return { clarify: "Move it next to what?" };
        const anchor = currentPos(st, rt.refs[0]);
        to = ringPoint(anchor, i + 1, 8);
        parts.push(`${ref.label} → next to ${rt.refs[0].label}`);
      }
    } else if (dir) {
      const step = parseStep(rest);
      to = { x: from.x + dir.vec.x * step, y: Math.max(0, (from.y ?? 0) + dir.vec.y * step), z: from.z + dir.vec.z * step };
      parts.push(`${ref.label} ${dir.word} by ${step}`);
    } else {
      return { clarify: `Where should ${ref.label} go? Try a direction ("north"), coordinates ("to 40, 60") or a landmark ("next to the tavern").` };
    }
    to = clampPos(to);
    if (ref.collection === "zones") {
      const [x0, z0, x1, z1] = ref.entity.bounds;
      const dx = round2(to.x - from.x), dz = round2(to.z - from.z);
      ops.push({ op: "update", collection: "zones", id: ref.id, set: { bounds: [round2(x0 + dx), round2(z0 + dz), round2(x1 + dx), round2(z1 + dz)] } });
    } else {
      ops.push({ op: "move", collection: ref.collection, id: ref.id, position: to });
    }
    st.positions.set(ref.id, to);
    ents.push({ collection: ref.collection, id: ref.id, label: ref.label });
  }
  return { ops, category: r.refs.every((x) => x.collection === "npcs") ? "npc" : "scene", summary: `moved ${parts.join("; ")}`, confidence: r.fuzzy ? 0.7 : 0.9, entities: ents };
}

// ---- resize ------------------------------------------------------------------
function resizeHandler(c, st) {
  const t = c.lc;
  const m = /^(?:make|scale)\s+(.+?)\s+(much\s+|a (?:little )?bit\s+|slightly\s+)?(bigger|larger|huge|giant|smaller|tiny|taller|shorter|twice as big|half the size)$/.exec(t)
    || /^(enlarge|grow|shrink|expand)\s+(.+)$/.exec(t);
  if (!m) return null;
  const subject = m.length === 4 ? m[1] : m[2];
  const how = m.length === 4 ? `${m[2] || ""}${m[3]}` : m[1];
  if (/^(the\s+)?(world|map|game|level)$/.test(subject.trim())) return null;           // "expand the world" = expand_area
  const r = resolveRefs(subject, st, { collections: ["structures"], what: "resize" });
  if (r.clarify) return r;
  const shrink = /smaller|tiny|shorter|shrink|half/.test(how);
  const f = /much|huge|giant|twice/.test(how) ? (shrink ? 0.5 : 2) : /bit|slightly/.test(how) ? (shrink ? 0.9 : 1.15) : (shrink ? 0.7 : 1.5);
  const ops = [], ents = [];
  for (const ref of r.refs) {
    const fp = ref.entity.footprint || { w: 8, d: 8, h: 6 };
    const heightOnly = /taller|shorter/.test(how);
    const s = (v, on = true) => round2(clamp((v || 1) * (on ? f : 1), 1, 200));
    ops.push({ op: "update", collection: "structures", id: ref.id, set: { footprint: { w: s(fp.w, !heightOnly), d: s(fp.d, !heightOnly), h: s(fp.h) } } });
    ents.push({ collection: ref.collection, id: ref.id, label: ref.label });
  }
  return { ops, category: "scene", summary: `${shrink ? "shrank" : "enlarged"} ${r.refs.map((x) => x.label).join(", ")} (×${f})`, confidence: r.fuzzy ? 0.7 : 0.85, entities: ents };
}

// ---- add (enemies, npcs, structures, areas) -------------------------------
const ADD_VERB = /^(?:add|spawn|create|build|place|put|give me|give us|i want|i'd like|we need|there should be|let there be|make|construct|erect|drop|summon|include|generate|insert)\s+(.+)$/;
function addHandler(c, st) {
  let m = ADD_VERB.exec(c.lc);
  let more = null;
  if (!m) {
    more = /^(more|extra|additional)\s+(.+)$/.exec(c.lc);
    if (!more) return null;
    m = [c.lc, `${more[1]} ${more[2]}`];
  }
  let body = m[1].replace(/^(me|us)\s+/, "");
  const placement = parsePlacement(body, st);
  if (placement?.clarify) return placement;
  const nounPhrase = (placement ? stripPlacement(body) : body).replace(/\s+with\s+.*$/, "");
  const moreish = /\b(more|extra|additional)\b/.test(nounPhrase);
  const named = /\b(?:named|called)\s+(.+)$/.exec(nounPhrase);
  const head = named ? nounPhrase.slice(0, named.index) : nounPhrase;
  let count = parseCount(head);
  const nounWords = tokens(head);
  const noun = [...nounWords].reverse().find((w) => w in ENEMY_WORDS || w in NPC_WORDS || w in STRUCTURE_WORDS || w in AREA_WORDS);

  if (!noun) {
    // "make" alone is too common a verb to own an unknown noun; let the unsupported path answer.
    if (/^make\b/.test(c.lc)) return null;
    const thing = cleanFreeText(nounPhrase.replace(/^(an?|the|some|another|\d+)\s+/, ""), 40) || "that";
    return { clarify: `I don't know how to add "${thing}" yet. I can add enemies (e.g. goblins, wolves), characters (merchant, guard), buildings (${Object.keys(STRUCTURE_WORDS).slice(0, 8).join(", ")}…) or a new area (forest, village, market).` };
  }
  if (/^make\b/.test(c.lc) && !(noun in AREA_WORDS) && !/\b(an?|another|\d+|two|three|some)\b/.test(nounPhrase)) return null;

  // ---- expand_area
  if (noun in AREA_WORDS && !(noun in STRUCTURE_WORDS && !/\b(area|zone|district|region)\b/.test(nounPhrase))) {
    return expandArea(noun, nounPhrase, c, st);
  }

  if (count == null) count = moreish || (/s$/.test(noun) && !/ss$/.test(noun)) ? 2 : 1;
  const kind = noun in ENEMY_WORDS ? "enemy" : noun in NPC_WORDS ? "npc" : "structure";
  const cap = kind === "enemy" ? LIMITS.MAX_ENEMIES_PER_REQUEST : kind === "npc" ? LIMITS.MAX_NPCS_PER_REQUEST : LIMITS.MAX_STRUCTURES_PER_REQUEST;
  if (count < 1) return { clarify: `How many ${noun} should I add?` };
  const clamped = count > cap;
  const n = Math.min(count, cap);
  const center = placement?.pos || (() => { const s = spawnPosition(st.manifest); return { x: s.x, y: 0, z: s.z - 15 }; })();
  const radius = placement ? (placement.exact && n === 1 ? 0 : kind === "structure" ? 16 : 6) : kind === "structure" ? 18 : 10;
  const ops = [], ents = [];
  const displayName = named ? cleanFreeText(c.orig.slice(c.orig.length - named[1].length), 40) : null;

  if (kind === "enemy") {
    const archetype = ENEMY_WORDS[noun];
    const asset = ensureAsset(st, archetype, archetype === "humanoid" ? "character" : "creature");
    ops.push(...asset.ops);
    const label = /^(enem|foe|hostile)/.test(noun) ? "Enemy" : titleCase(noun.replace(/(ies)$/, "y").replace(/(ves)$/, "f").replace(/s$/, ""));
    for (let i = 0; i < n; i++) {
      const pos = radius === 0 ? center : ringPoint(center, i, radius);
      const npcId = freshId(st, `npc_${slug(label)}`);
      const bid = `behavior_enemy_${npcId}`; st.usedIds.add(bid);
      const iid = `interaction_enemy_${npcId}`; st.usedIds.add(iid);
      const behavior = { id: bid, kind: "enemy_ai", spec: { aggro_radius: 14, damage: 8, health: 60, flee_below: 0, patrol: [{ x: pos.x, z: pos.z }, { x: round2(pos.x + 4), z: round2(pos.z + 4) }] } };
      const npc = {
        id: npcId, name: displayName && n === 1 ? displayName : `${label} ${npcId.split("_").at(-1)}`, role: "enemy",
        zone: zoneAt(st.manifest, pos, st.pending), spawn: pos, asset_ref: asset.id, behavior_ref: bid,
        dialogue: { seed: "A hostile presence.", lines: [] }, schedule: [], faction: "hostile", stats: { health: 60 },
      };
      const inter = { id: iid, trigger: "proximity", target_ref: npcId, behavior_ref: bid, params: { radius: 14 } };
      ops.push({ op: "add", collection: "behaviors", value: behavior }, { op: "add", collection: "npcs", value: npc }, { op: "add", collection: "interactions", value: inter });
      st.pending.push({ collection: "behaviors", value: behavior }, { collection: "npcs", value: npc, labelParts: [npc.name, "enemy", noun] }, { collection: "interactions", value: inter });
      st.positions.set(npcId, pos);
      ents.push({ collection: "npcs", id: npcId, label: npc.name });
    }
    return { ops, category: "npc", summary: `added ${n} ${plural(label.toLowerCase(), n)}${placement ? ` ${placement.label}` : ""}${clamped ? ` (capped at ${cap}; you asked for ${count})` : ""}`, confidence: placement?.anchor && !placement.exact ? 0.85 : 0.9, entities: ents, clamped };
  }

  if (kind === "npc") {
    const role = NPC_WORDS[noun];
    const asset = ensureAsset(st, "humanoid", "character");
    ops.push(...asset.ops);
    for (let i = 0; i < n; i++) {
      const pos = radius === 0 ? center : ringPoint(center, i, radius);
      const npcId = freshId(st, `npc_${slug(role)}`);
      const bid = `behavior_npc_${npcId}`; st.usedIds.add(bid);
      const iid = `interaction_npc_${npcId}`; st.usedIds.add(iid);
      const name = displayName && n === 1 ? displayName : `${titleCase(role)} ${npcId.split("_").at(-1)}`;
      const behavior = { id: bid, kind: "npc_ai", spec: { routine: "idle", waypoints: [{ x: pos.x, z: pos.z }], dialogue_topics: [role] } };
      const npc = { id: npcId, name, role, zone: zoneAt(st.manifest, pos, st.pending), spawn: pos, asset_ref: asset.id, behavior_ref: bid, dialogue: { seed: `${titleCase(role)}.`, lines: [] }, schedule: [], faction: null, stats: null };
      const inter = { id: iid, trigger: "interact", target_ref: npcId, behavior_ref: bid, params: { prompt: "Talk" } };
      ops.push({ op: "add", collection: "behaviors", value: behavior }, { op: "add", collection: "npcs", value: npc }, { op: "add", collection: "interactions", value: inter });
      st.pending.push({ collection: "behaviors", value: behavior }, { collection: "npcs", value: npc, labelParts: [name, role, noun] }, { collection: "interactions", value: inter });
      st.positions.set(npcId, pos);
      ents.push({ collection: "npcs", id: npcId, label: name });
    }
    return { ops, category: "npc", summary: `added ${n} ${plural(role, n)}${placement ? ` ${placement.label}` : ""}${clamped ? ` (capped at ${cap})` : ""}`, confidence: 0.9, entities: ents, clamped };
  }

  // structure
  const archetype = STRUCTURE_WORDS[noun];
  const asset = ensureAsset(st, archetype, "building");
  ops.push(...asset.ops);
  const fp = archetype === "keep_hall" ? { w: 24, d: 24, h: 14 } : /tower|watchtower/.test(archetype) ? { w: 6, d: 6, h: 18 } : { w: 8, d: 8, h: 6 };
  const label = titleCase(noun);
  for (let i = 0; i < n; i++) {
    const pos = radius === 0 ? { ...center, y: 0 } : ringPoint({ ...center, y: 0 }, i + (placement?.anchor ? 1 : 0), radius);
    const id = freshId(st, `struct_${slug(noun)}`);
    const value = {
      id, zone: zoneAt(st.manifest, pos, st.pending), asset_ref: asset.id,
      transform: { position: pos, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      footprint: fp, enterable: false, interactable: false, purpose: displayName && n === 1 ? displayName : label, portals: [],
    };
    ops.push({ op: "add", collection: "structures", value });
    st.pending.push({ collection: "structures", value, labelParts: [value.purpose, noun, archetype] });
    st.positions.set(id, pos);
    ents.push({ collection: "structures", id, label: value.purpose });
  }
  return { ops, category: "scene", summary: `added ${n} ${plural(noun.replace(/s$/, ""), n)}${placement ? ` ${placement.label}` : ""}${clamped ? ` (capped at ${cap})` : ""}`, confidence: 0.9, entities: ents, clamped };
}

/** Reuses expansion/planner.mjs planExpansion() and flattens its delta into add ops. */
function expandArea(noun, nounPhrase, c, st) {
  if (st.expandedOnce) return { clarify: "One new area per request, please — add the second one in a follow-up." };
  const blueprint = AREA_WORDS[noun];
  const generic = blueprint === null;
  const named = /\b(?:named|called)\s+(.+)$/.exec(nounPhrase);
  let label = named ? cleanFreeText(c.orig.slice(c.orig.length - named[1].length), 40) : (generic && /^(area|zone|region|district|quarter|level|section)$/.test(noun) ? "New Area" : titleCase(noun));
  if (!label) label = "New Area";
  const existing = new Set((st.manifest.zones || []).map((z) => z.id));
  const request = blueprint ? `add a ${blueprint} area` : `add a ${slug(label).replace(/_/g, " ")} area`;
  let delta;
  for (let k = 0; k < 20; k++) {
    const tryLabel = k === 0 ? label : `${label} ${k + 1}`;
    delta = planExpansion(st.manifest, { request, label: tryLabel, seed: 7 + k });
    if (!existing.has(delta.add.zones[0]?.id)) { label = tryLabel; break; }
    delta = null;
  }
  if (!delta) return { clarify: "I couldn't find a free name for another area. Try naming it: 'add a forest called Greenhollow'." };
  const zone = delta.add.zones[0];
  if (WILDERNESS_AREAS.has(noun)) zone.kind = "wilderness";
  const order = ["zones", "assets", "items", "structures", "behaviors", "npcs", "interactions", "quests"];
  const ops = [];
  for (const coll of order) for (const raw of delta.add[coll] || []) {
    const { owner_id, ...value } = raw; void owner_id;           // ownership is never set by an edit
    if (coll === "assets" && ((st.manifest.assets || []).some((a) => a.id === value.id) || st.pending.some((p) => p.value.id === value.id))) continue;
    ops.push({ op: "add", collection: coll, value });
    st.pending.push({ collection: coll, value });
    st.usedIds.add(value.id);
  }
  st.expandedOnce = true;
  const notes = [];
  if (delta.navigation_links?.length) notes.push(`navigation link ${delta.navigation_links.map((l) => `${l.from}→${l.to}`).join(", ")} is not expressible as a patch op and was not included`);
  if (delta.terrain_extend) notes.push(`zone lies outside the current terrain (${st.manifest.terrain?.size?.w}×${st.manifest.terrain?.size?.h}); terrain.size is not patchable, so the terrain was not extended`);
  return { ops, category: "expand_area", summary: `added a new area '${label}' (${zone.kind}) with ${delta.add.structures.length} structures and ${delta.add.npcs.length} characters`, confidence: 0.85, entities: [{ collection: "zones", id: zone.id, label }], notes };
}

/** Ordered: the first handler that claims a clause owns it. */
export const HANDLERS = [
  ["objective", objectiveHandler],
  ["rename", renameHandler],
  ["ui", uiHandler],
  ["lighting_weather", lightingHandler],
  ["gameplay_rule", gameplayHandler],
  ["asset_replace", replaceHandler],
  ["remove", removeHandler],
  ["move", moveHandler],
  ["resize", resizeHandler],
  ["add", addHandler],
];
