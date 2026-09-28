// Games-D procedural sound placeholders. ISOMORPHIC data + pure builders.
//
// No audio files exist anywhere: every sound is a small WebAudio recipe that
// games-b-runtime/audio.mjs synthesises in the page.
//
// AudioSpec (optional pkg.audio, audio_version "1.0.0"):
//   { audio_version, preset, seed, master: 0..1,
//     ambience: { layers: [Layer] },
//     cues: { <name>: Cue },
//     emitters: [{ id, position: {x,y,z}, cue, radius, interval }] }
//
//   Layer (a looping bed):
//     { id, source: "noise"|"osc", noise?: "white"|"pink"|"brown", wave?: "sine"|"triangle"|"sawtooth"|"square",
//       freq?, detune?, filter?: { type: "lowpass"|"highpass"|"bandpass", freq, q },
//       gain, lfo?: { rate, depth, target: "gain"|"filter"|"freq" },
//       crackle?: { rate /* pops per second */, gain } }
//   Cue (a one-shot):
//     { gain, voices: [{ source: "osc"|"noise", wave?, noise?, freq?, freq_end?, delay?, attack, decay,
//                        gain, filter?: { type, freq, q } }] }
//
// Emitters are placed sounds (a crackling brazier, a humming shrine) that the
// runtime retriggers every `interval` seconds while the player is within
// `radius`, with gain falling off with distance.

import { rng, hashString } from "../../gamesb/common/rng.mjs";

export const AUDIO_VERSION = "1.0.0";
export const CUE_NAMES = Object.freeze(["footstep", "pickup", "objective_done", "interact", "locked", "damage", "win", "lose", "dialogue_open"]);
export const LAYER_SOURCES = Object.freeze(["noise", "osc"]);
export const NOISE_KINDS = Object.freeze(["white", "pink", "brown"]);
export const WAVES = Object.freeze(["sine", "triangle", "sawtooth", "square"]);
export const FILTER_TYPES = Object.freeze(["lowpass", "highpass", "bandpass"]);

// ------------------------------------------------------------ bed layers

const L = Object.freeze({
  wind: (g = 0.22, f = 520) => ({ id: "wind", source: "noise", noise: "pink", filter: { type: "bandpass", freq: f, q: 0.7 }, gain: g, lfo: { rate: 0.08, depth: 0.55, target: "filter" } }),
  gust: (g = 0.12) => ({ id: "gust", source: "noise", noise: "white", filter: { type: "highpass", freq: 2400, q: 0.5 }, gain: g, lfo: { rate: 0.13, depth: 0.8, target: "gain" } }),
  rain: (g = 0.2) => ({ id: "rain", source: "noise", noise: "white", filter: { type: "highpass", freq: 1800, q: 0.4 }, gain: g, lfo: { rate: 0.05, depth: 0.15, target: "gain" } }),
  surf: (g = 0.28) => ({ id: "surf", source: "noise", noise: "brown", filter: { type: "lowpass", freq: 700, q: 0.6 }, gain: g, lfo: { rate: 0.11, depth: 0.7, target: "gain" } }),
  lap: (g = 0.14) => ({ id: "lap", source: "noise", noise: "pink", filter: { type: "lowpass", freq: 420, q: 0.8 }, gain: g, lfo: { rate: 0.32, depth: 0.6, target: "gain" } }),
  hum: (g = 0.08, f = 60) => ({ id: "hum", source: "osc", wave: "sawtooth", freq: f, filter: { type: "lowpass", freq: 240, q: 1 }, gain: g, lfo: { rate: 0.2, depth: 0.15, target: "gain" } }),
  vent: (g = 0.12) => ({ id: "vent", source: "noise", noise: "pink", filter: { type: "lowpass", freq: 900, q: 0.5 }, gain: g }),
  drone: (g = 0.07, f = 55) => ({ id: "drone", source: "osc", wave: "triangle", freq: f, detune: 6, filter: { type: "lowpass", freq: 400, q: 0.7 }, gain: g, lfo: { rate: 0.05, depth: 0.3, target: "gain" } }),
  shimmer: (g = 0.04, f = 880) => ({ id: "shimmer", source: "osc", wave: "sine", freq: f, detune: 9, gain: g, lfo: { rate: 0.21, depth: 0.7, target: "gain" } }),
  rumble: (g = 0.2) => ({ id: "rumble", source: "noise", noise: "brown", filter: { type: "lowpass", freq: 140, q: 0.8 }, gain: g, lfo: { rate: 0.07, depth: 0.4, target: "gain" } }),
  crackle: (g = 0.1, rate = 7) => ({ id: "crackle", source: "noise", noise: "white", filter: { type: "bandpass", freq: 3200, q: 1.2 }, gain: 0, crackle: { rate, gain: g } }),
  insects: (g = 0.05) => ({ id: "insects", source: "noise", noise: "white", filter: { type: "bandpass", freq: 4600, q: 8 }, gain: g, lfo: { rate: 5.5, depth: 0.6, target: "gain" } }),
  leaves: (g = 0.08) => ({ id: "leaves", source: "noise", noise: "pink", filter: { type: "bandpass", freq: 1500, q: 0.9 }, gain: g, lfo: { rate: 0.17, depth: 0.6, target: "gain" } }),
  traffic: (g = 0.06) => ({ id: "distant_city", source: "noise", noise: "brown", filter: { type: "lowpass", freq: 260, q: 0.6 }, gain: g, lfo: { rate: 0.03, depth: 0.3, target: "gain" } }),
});

// ------------------------------------------------------------ one-shot cues

const tone = (freq, o = {}) => ({ source: "osc", wave: o.wave || "sine", freq, ...(o.freq_end ? { freq_end: o.freq_end } : {}), delay: o.delay || 0, attack: o.attack ?? 0.005, decay: o.decay ?? 0.2, gain: o.gain ?? 0.5, ...(o.filter ? { filter: o.filter } : {}) });
const hiss = (o = {}) => ({ source: "noise", noise: o.noise || "white", delay: o.delay || 0, attack: o.attack ?? 0.002, decay: o.decay ?? 0.08, gain: o.gain ?? 0.4, filter: o.filter || { type: "bandpass", freq: 900, q: 1 } });
const arp = (notes, step, o = {}) => notes.map((f, i) => tone(f, { ...o, delay: i * step }));

/** Base cues; a preset may re-voice some of them (footsteps on sand vs metal). */
export const BASE_CUES = Object.freeze({
  footstep: { gain: 0.35, voices: [hiss({ noise: "brown", decay: 0.07, gain: 0.7, filter: { type: "lowpass", freq: 600, q: 0.8 } })] },
  pickup: { gain: 0.45, voices: arp([660, 880, 1320], 0.06, { wave: "triangle", decay: 0.18, gain: 0.5 }) },
  objective_done: { gain: 0.5, voices: arp([523.25, 659.25, 783.99, 1046.5], 0.1, { wave: "triangle", decay: 0.5, gain: 0.45 }) },
  interact: { gain: 0.35, voices: [tone(440, { wave: "square", decay: 0.06, gain: 0.25, filter: { type: "lowpass", freq: 1800, q: 0.7 } }), hiss({ decay: 0.04, gain: 0.2, filter: { type: "highpass", freq: 3000, q: 0.5 } })] },
  locked: { gain: 0.4, voices: [tone(180, { wave: "square", decay: 0.12, gain: 0.35, filter: { type: "lowpass", freq: 900, q: 1 } }), tone(150, { wave: "square", delay: 0.14, decay: 0.16, gain: 0.35, filter: { type: "lowpass", freq: 900, q: 1 } })] },
  damage: { gain: 0.5, voices: [tone(220, { wave: "sawtooth", freq_end: 90, decay: 0.25, gain: 0.45, filter: { type: "lowpass", freq: 1200, q: 1 } }), hiss({ noise: "brown", decay: 0.15, gain: 0.5, filter: { type: "lowpass", freq: 500, q: 0.7 } })] },
  win: { gain: 0.55, voices: [...arp([523.25, 659.25, 783.99, 1046.5, 1318.5], 0.12, { wave: "triangle", decay: 0.7, gain: 0.4 }), tone(261.63, { wave: "sine", delay: 0.48, decay: 1.4, gain: 0.35 })] },
  lose: { gain: 0.5, voices: arp([392, 349.23, 311.13, 261.63], 0.22, { wave: "sawtooth", decay: 0.45, gain: 0.3, filter: { type: "lowpass", freq: 900, q: 0.8 } }) },
  dialogue_open: { gain: 0.3, voices: [tone(740, { wave: "sine", decay: 0.12, gain: 0.35 }), tone(988, { wave: "sine", delay: 0.07, decay: 0.16, gain: 0.3 })] },
  // Emitter voices.
  fire_pop: { gain: 0.3, voices: [hiss({ decay: 0.03, gain: 0.6, filter: { type: "bandpass", freq: 2600, q: 1.5 } }), hiss({ noise: "brown", delay: 0.02, decay: 0.12, gain: 0.35, filter: { type: "lowpass", freq: 400, q: 0.7 } })] },
  shrine_chime: { gain: 0.22, voices: [tone(1046.5, { decay: 1.2, gain: 0.3 }), tone(1568, { delay: 0.02, decay: 0.9, gain: 0.18 })] },
  machine_hum: { gain: 0.2, voices: [tone(110, { wave: "sawtooth", attack: 0.2, decay: 1.6, gain: 0.3, filter: { type: "lowpass", freq: 360, q: 1 } })] },
  water_drip: { gain: 0.22, voices: [tone(1400, { freq_end: 700, decay: 0.09, gain: 0.4 })] },
});

const FOOT = Object.freeze({
  soft: BASE_CUES.footstep,
  sand: { gain: 0.3, voices: [hiss({ noise: "pink", decay: 0.1, gain: 0.6, filter: { type: "bandpass", freq: 1400, q: 0.6 } })] },
  snow: { gain: 0.32, voices: [hiss({ noise: "pink", decay: 0.13, gain: 0.55, filter: { type: "bandpass", freq: 2200, q: 0.9 } }), hiss({ noise: "brown", delay: 0.02, decay: 0.08, gain: 0.3, filter: { type: "lowpass", freq: 500, q: 0.6 } })] },
  wet: { gain: 0.32, voices: [hiss({ noise: "pink", decay: 0.09, gain: 0.55, filter: { type: "lowpass", freq: 900, q: 1.4 } }), tone(260, { freq_end: 140, decay: 0.06, gain: 0.12 })] },
  stone: { gain: 0.3, voices: [hiss({ decay: 0.04, gain: 0.5, filter: { type: "bandpass", freq: 2000, q: 1.1 } }), tone(120, { decay: 0.05, gain: 0.2 })] },
  metal: { gain: 0.28, voices: [tone(320, { wave: "triangle", decay: 0.09, gain: 0.3 }), tone(860, { wave: "sine", decay: 0.12, gain: 0.12 }), hiss({ decay: 0.03, gain: 0.25, filter: { type: "highpass", freq: 2500, q: 0.5 } })] },
});

// ------------------------------------------------------------ presets

const A = (o) => Object.freeze(o);

/** Keyed by theme id (plus `default`). `emit` maps an emitter source kind → cue. */
export const AUDIO_PRESETS = Object.freeze({
  default: A({ id: "default", name: "Open air", master: 0.55, layers: [L.wind(0.16, 480), L.leaves(0.05)], footstep: "soft" }),
  storm_isle: A({ id: "storm_isle", name: "Gale and breakers", master: 0.6, layers: [L.wind(0.26, 420), L.gust(0.12), L.surf(0.3)], footstep: "wet", rain_boost: 1.3 }),
  tropical_cove: A({ id: "tropical_cove", name: "Warm surf", master: 0.55, layers: [L.surf(0.24), L.lap(0.1), L.leaves(0.06), L.insects(0.03)], footstep: "sand" }),
  pine_valley: A({ id: "pine_valley", name: "Pine wind", master: 0.55, layers: [L.wind(0.14, 380), L.leaves(0.09), L.insects(0.02)], footstep: "soft" }),
  swamp_fen: A({ id: "swamp_fen", name: "Fen chorus", master: 0.55, layers: [L.drone(0.05, 49), L.insects(0.07), L.lap(0.08)], footstep: "wet" }),
  dune_sea: A({ id: "dune_sea", name: "Singing sand", master: 0.55, layers: [L.wind(0.22, 700), L.gust(0.08), L.drone(0.03, 73.4)], footstep: "sand" }),
  frost_peaks: A({ id: "frost_peaks", name: "High wind", master: 0.55, layers: [L.wind(0.26, 900), L.gust(0.14)], footstep: "snow" }),
  ember_caldera: A({ id: "ember_caldera", name: "Magma breath", master: 0.6, layers: [L.rumble(0.26), L.crackle(0.12, 9), L.drone(0.04, 41.2)], footstep: "stone" }),
  red_canyon: A({ id: "red_canyon", name: "Canyon wind", master: 0.55, layers: [L.wind(0.2, 560), L.drone(0.03, 65.4)], footstep: "sand" }),
  sunken_ruins: A({ id: "sunken_ruins", name: "Drowned halls", master: 0.55, layers: [L.lap(0.14), L.drone(0.05, 55), L.shimmer(0.015, 659.25)], footstep: "wet" }),
  fog_city: A({ id: "fog_city", name: "Foghorn streets", master: 0.55, layers: [L.traffic(0.08), L.rain(0.06), L.hum(0.03, 50), L.wind(0.08, 300)], footstep: "stone" }),
  orbital_base: A({ id: "orbital_base", name: "Station hum", master: 0.5, layers: [L.hum(0.07, 60), L.vent(0.1), L.shimmer(0.01, 1760)], footstep: "metal" }),
  crystal_hollow: A({ id: "crystal_hollow", name: "Geode resonance", master: 0.5, layers: [L.drone(0.05, 65.4), L.shimmer(0.035, 1046.5), L.shimmer(0.02, 1567.98)], footstep: "stone" }),
  oasis_flats: A({ id: "oasis_flats", name: "Oasis breeze", master: 0.55, layers: [L.wind(0.12, 640), L.leaves(0.06), L.lap(0.06), L.insects(0.025)], footstep: "sand" }),
  glacier_steps: A({ id: "glacier_steps", name: "Groaning ice", master: 0.55, layers: [L.wind(0.22, 1000), L.drone(0.04, 36.7), L.shimmer(0.012, 1318.5)], footstep: "snow" }),
  obsidian_mesa: A({ id: "obsidian_mesa", name: "Cinder wind", master: 0.6, layers: [L.rumble(0.2), L.wind(0.16, 360), L.crackle(0.08, 5)], footstep: "stone" }),
  sandstone_steps: A({ id: "sandstone_steps", name: "Mesa echo", master: 0.55, layers: [L.wind(0.18, 600), L.drone(0.025, 82.4)], footstep: "sand" }),
  overgrown_temple: A({ id: "overgrown_temple", name: "Jungle canopy", master: 0.55, layers: [L.leaves(0.1), L.insects(0.06), L.drone(0.03, 55)], footstep: "soft" }),
  hillside_town: A({ id: "hillside_town", name: "Village afternoon", master: 0.5, layers: [L.wind(0.1, 420), L.leaves(0.05), L.traffic(0.03)], footstep: "stone" }),
});

// Which placed things make a sound, and which cue they use.
const EMIT_BY_LIB = { campfire: "fire_pop", beacon_brazier: "fire_pop", lantern_post: "fire_pop", shrine: "shrine_chime", altar: "shrine_chime", obelisk: "shrine_chime", crystal_cluster: "shrine_chime", well: "water_drip" };
const EMIT_BY_IX = { lantern: "fire_pop", altar: "shrine_chime", portal: "machine_hum", terminal: "machine_hum", switch: "machine_hum", lever: "machine_hum" };
const EMIT_INTERVAL = { fire_pop: 0.45, shrine_chime: 3.2, machine_hum: 1.6, water_drip: 1.4 };
const EMIT_RADIUS = { fire_pop: 12, shrine_chime: 16, machine_hum: 10, water_drip: 9 };
export const MAX_EMITTERS = 24;

const WET_WEATHER = { rain: 0.18, storm: 0.24 };
const r3 = (v) => Math.round(v * 1000) / 1000;
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * The AudioSpec for a game (CONTRACT §3). Pure and deterministic in ctx.
 * Returns null only when there is nothing to describe (never throws).
 * @param {object} ctx  { theme, recipe, rand?, world?, concept?, notes? }
 */
export function audioFor(ctx = {}) {
  try {
    const theme = ctx.theme || null;
    const want = theme?.audio || theme?.id || null;
    const preset = (want && AUDIO_PRESETS[want]) || AUDIO_PRESETS.default;
    if (want && !AUDIO_PRESETS[want]) ctx.notes?.push?.(`audio preset '${want}' unknown; used 'default'`);
    const seed = (hashString(`audio|${preset.id}|${ctx.recipe?.seed ?? 0}`) >>> 0) % 1000003;
    const r = rng(seed);

    // Beds: the preset's layers, each nudged a little per game so two games of
    // one theme do not sound identical, plus rain when the weather is wet.
    const layers = preset.layers.map((l) => {
      const x = clone(l);
      if (x.filter) x.filter.freq = Math.round(x.filter.freq * (0.9 + 0.2 * r()));
      if (x.lfo) x.lfo.rate = r3(x.lfo.rate * (0.85 + 0.3 * r()));
      if (x.freq) x.freq = r3(x.freq);
      return x;
    });
    const weather = ctx.world?.environment?.weather || ctx.concept?.weather || null;
    if (WET_WEATHER[weather] && !layers.some((l) => l.id === "rain")) layers.push(L.rain(r3(WET_WEATHER[weather] * (preset.rain_boost || 1))));
    if (weather === "storm" && !layers.some((l) => l.id === "gust")) layers.push(L.gust(0.1));

    const cues = {};
    for (const n of CUE_NAMES) cues[n] = clone(BASE_CUES[n]);
    cues.footstep = clone(FOOT[preset.footstep] || FOOT.soft);
    for (const n of ["fire_pop", "shrine_chime", "machine_hum", "water_drip"]) cues[n] = clone(BASE_CUES[n]);

    return {
      audio_version: AUDIO_VERSION,
      preset: preset.id,
      seed,
      master: preset.master,
      ambience: { name: preset.name, layers },
      cues,
      emitters: emittersFor(ctx.world),
    };
  } catch (e) {
    ctx.notes?.push?.(`audio skipped: ${e.message}`);
    return null;
  }
}

/** Placed sound sources from the world: lamps, fires, shrines, machines. Sorted, capped. */
export function emittersFor(world) {
  if (!world || typeof world !== "object") return [];
  const out = [];
  const byPlacement = new Map((world.placements || []).map((p) => [p.id, p]));
  const seen = new Set();
  for (const ix of world.interactables || []) {
    const cue = EMIT_BY_IX[ix.kind];
    const p = ix.placement_ref ? byPlacement.get(ix.placement_ref) : null;
    if (!cue || !p?.position) continue;
    seen.add(p.id);
    out.push(emitter(`em_${ix.id}`, p.position, cue));
  }
  for (const p of world.placements || []) {
    if (seen.has(p.id) || !p?.position) continue;
    const name = String(p.asset_ref || "").replace(/^lib:/, "");
    const cue = EMIT_BY_LIB[name];
    if (cue) out.push(emitter(`em_${p.id}`, p.position, cue));
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, MAX_EMITTERS);
}

function emitter(id, pos, cue) {
  return { id, position: { x: r3(+pos.x || 0), y: r3(+pos.y || 0), z: r3(+pos.z || 0) }, cue, radius: EMIT_RADIUS[cue], interval: EMIT_INTERVAL[cue] };
}

// ------------------------------------------------------------ validation

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Hand-written validator, the Games-B way: { ok, errors: [{path, message}], warnings }. */
export function validateAudioSpec(spec) {
  const errors = [], warnings = [];
  const err = (path, message) => errors.push({ path, message });
  if (!spec || typeof spec !== "object") { err("audio", "must be an object"); return { ok: false, errors, warnings }; }
  if (spec.audio_version !== AUDIO_VERSION) err("audio.audio_version", `must be "${AUDIO_VERSION}"`);
  if (!isNum(spec.master) || spec.master < 0 || spec.master > 1) err("audio.master", "must be a number in [0,1]");
  const checkFilter = (f, p) => {
    if (f === undefined) return;
    if (!f || !FILTER_TYPES.includes(f.type)) err(`${p}.type`, `must be one of ${FILTER_TYPES.join("|")}`);
    if (!isNum(f?.freq) || f.freq <= 0 || f.freq > 20000) err(`${p}.freq`, "must be in (0, 20000]");
    if (f?.q !== undefined && (!isNum(f.q) || f.q <= 0)) err(`${p}.q`, "must be > 0");
  };
  const layers = spec.ambience?.layers;
  if (!Array.isArray(layers)) err("audio.ambience.layers", "must be an array");
  else layers.forEach((l, i) => {
    const p = `audio.ambience.layers[${i}]`;
    if (typeof l?.id !== "string") err(`${p}.id`, "must be a string");
    if (!LAYER_SOURCES.includes(l?.source)) err(`${p}.source`, "must be noise|osc");
    if (l?.source === "noise" && !NOISE_KINDS.includes(l.noise)) err(`${p}.noise`, "must be white|pink|brown");
    if (l?.source === "osc" && (!WAVES.includes(l.wave) || !isNum(l.freq) || l.freq <= 0)) err(`${p}`, "osc needs a wave and freq > 0");
    if (!isNum(l?.gain) || l.gain < 0 || l.gain > 1) err(`${p}.gain`, "must be in [0,1]");
    checkFilter(l?.filter, `${p}.filter`);
    if (l?.lfo && (!isNum(l.lfo.rate) || !isNum(l.lfo.depth) || !["gain", "filter", "freq"].includes(l.lfo.target))) err(`${p}.lfo`, "needs rate, depth and target gain|filter|freq");
  });
  const cues = spec.cues;
  if (!cues || typeof cues !== "object") err("audio.cues", "must be an object");
  else {
    for (const n of CUE_NAMES) if (!cues[n]) err(`audio.cues.${n}`, "is required");
    for (const [n, c] of Object.entries(cues)) {
      const p = `audio.cues.${n}`;
      if (!isNum(c?.gain) || c.gain < 0 || c.gain > 1) err(`${p}.gain`, "must be in [0,1]");
      if (!Array.isArray(c?.voices) || !c.voices.length) { err(`${p}.voices`, "must be a non-empty array"); continue; }
      c.voices.forEach((v, i) => {
        const q = `${p}.voices[${i}]`;
        if (!LAYER_SOURCES.includes(v?.source)) err(`${q}.source`, "must be noise|osc");
        if (v?.source === "osc" && (!WAVES.includes(v.wave) || !isNum(v.freq) || v.freq <= 0)) err(q, "osc needs a wave and freq > 0");
        if (v?.source === "noise" && !NOISE_KINDS.includes(v.noise)) err(`${q}.noise`, "must be white|pink|brown");
        for (const k of ["attack", "decay"]) if (!isNum(v?.[k]) || v[k] < 0 || v[k] > 5) err(`${q}.${k}`, "must be in [0,5] s");
        if (!isNum(v?.gain) || v.gain < 0 || v.gain > 1) err(`${q}.gain`, "must be in [0,1]");
        checkFilter(v?.filter, `${q}.filter`);
      });
    }
  }
  if (!Array.isArray(spec.emitters)) err("audio.emitters", "must be an array");
  else {
    if (spec.emitters.length > MAX_EMITTERS) warnings.push({ path: "audio.emitters", message: `more than ${MAX_EMITTERS} emitters` });
    spec.emitters.forEach((e, i) => {
      const p = `audio.emitters[${i}]`;
      if (typeof e?.id !== "string") err(`${p}.id`, "must be a string");
      if (!e?.position || !["x", "y", "z"].every((k) => isNum(e.position[k]))) err(`${p}.position`, "must be {x,y,z}");
      if (!cues?.[e?.cue]) err(`${p}.cue`, `names no cue ('${e?.cue}')`);
      if (!isNum(e?.radius) || e.radius <= 0) err(`${p}.radius`, "must be > 0");
    });
  }
  return { ok: errors.length === 0, errors, warnings };
}
