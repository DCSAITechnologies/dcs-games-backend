// Games-D lighting presets. ISOMORPHIC data + a pure world patch.
//
// A preset fixes the time of day and the look of the light: sun (or moon)
// direction, colour, intensity and shadows; the hemisphere ambient; the sky
// gradient; fog colour and distance; and an optional tone-mapping exposure and
// lamp boost. applyLighting rewrites ONLY world.environment.
//
// The world stage has already built an environment from the concept (whose
// time_of_day the engine set from the preset) with the theme palette and the
// weather folded in. A preset does not throw that away: sky and fog colours
// are blended with it, so a storm still reads as a storm and a red-canyon noon
// still has a warm sky, and fog distances are multiplied rather than replaced,
// so the weather's visibility and the world's size still count.
//
// Legibility. The runtime renderer (games-b-runtime/renderer.mjs) floors the
// key light at 0.55 and the hemisphere at 0.45, adds a lamp on the player and
// point lights on every glowing part, and reads the two optional fields this
// module adds: `exposure` (tone-mapping exposure, default 1.05) and
// `lamp_boost` (multiplier on the player lamp and the lamp point lights,
// default 1). Night presets use a bright, high, blue-white moon, a lifted
// exposure and a lamp boost, so the path and the lanterns stay readable.

export const LIGHTING_VERSION = "1.0.0";

const P = (o) => Object.freeze(o);

export const LIGHTING = Object.freeze({
  dawn: P({
    id: "dawn", name: "Dawn", time_of_day: 0.27,
    keywords: ["dawn", "sunrise", "daybreak", "morning", "first light", "early"],
    sun: { azimuth_deg: 100, elevation_deg: 9, color: "#ffb48a", intensity: 1.35, shadows: true },
    ambient: { color: "#c9b8d8", ground_color: "#5a4a50", intensity: 0.5 },
    sky: { top: "#5a78b0", horizon: "#f4b894", bottom: "#6a5a60" },
    fog: { color: "#e8b8a4", near_mult: 0.7, far_mult: 0.85 },
    exposure: 1.1,
  }),
  noon: P({
    id: "noon", name: "Noon", time_of_day: 0.5,
    keywords: ["noon", "midday", "day", "daytime", "sunny", "bright", "sunlit", "clear"],
    sun: { azimuth_deg: 175, elevation_deg: 68, color: "#fff4e0", intensity: 2.1, shadows: true },
    ambient: { color: "#cfe0f0", ground_color: "#6a6a55", intensity: 0.62 },
    sky: { top: "#3f7fcf", horizon: "#b8d8f0", bottom: "#8a9a8a" },
    fog: { color: null, near_mult: 1, far_mult: 1.15 },
    exposure: 1.0,
  }),
  golden_hour: P({
    id: "golden_hour", name: "Golden hour", time_of_day: 0.7,
    keywords: ["golden", "golden hour", "afternoon", "warm", "late afternoon", "amber"],
    sun: { azimuth_deg: 250, elevation_deg: 16, color: "#ffc27a", intensity: 1.75, shadows: true },
    ambient: { color: "#e8c8a0", ground_color: "#6a5238", intensity: 0.55 },
    sky: { top: "#4a6aa8", horizon: "#ffd09a", bottom: "#7a6048" },
    fog: { color: "#f0c890", near_mult: 0.9, far_mult: 1.0 },
    exposure: 1.05,
  }),
  dusk: P({
    id: "dusk", name: "Dusk", time_of_day: 0.76,
    keywords: ["dusk", "sunset", "evening", "twilight", "gloaming"],
    sun: { azimuth_deg: 268, elevation_deg: 6, color: "#ff8a5a", intensity: 1.1, shadows: true },
    ambient: { color: "#8a7aa8", ground_color: "#3a3040", intensity: 0.5 },
    sky: { top: "#2a3a6a", horizon: "#e88a6a", bottom: "#3a3040" },
    fog: { color: "#a07a88", near_mult: 0.8, far_mult: 0.85 },
    exposure: 1.12, lamp_boost: 1.25,
  }),
  night: P({
    id: "night", name: "Moonlit night", time_of_day: 0.95,
    keywords: ["night", "midnight", "moon", "moonlit", "dark", "stars", "nocturnal"],
    // A high, cool moon as the key light: enough to read the path and terrain,
    // with the lanterns (boosted) as the warm accents.
    sun: { azimuth_deg: 210, elevation_deg: 48, color: "#a8c0ff", intensity: 0.8, shadows: true },
    ambient: { color: "#5a6ea8", ground_color: "#1e2230", intensity: 0.55 },
    sky: { top: "#070c22", horizon: "#24345e", bottom: "#101420" },
    fog: { color: "#1c2848", near_mult: 0.8, far_mult: 0.75 },
    exposure: 1.25, lamp_boost: 1.5,
  }),
  overcast: P({
    id: "overcast", name: "Overcast", time_of_day: 0.55,
    keywords: ["overcast", "grey", "gray", "cloudy", "dull", "muted", "bleak"],
    sun: { azimuth_deg: 190, elevation_deg: 50, color: "#e4e8ec", intensity: 1.05, shadows: false },
    ambient: { color: "#b8c0c8", ground_color: "#5a5c58", intensity: 0.8 },
    sky: { top: "#7a848e", horizon: "#b4bac0", bottom: "#6a6e6a" },
    fog: { color: "#aab0b6", near_mult: 0.7, far_mult: 0.8 },
    exposure: 1.1,
  }),
  storm_dark: P({
    id: "storm_dark", name: "Storm dark", time_of_day: 0.62,
    keywords: ["storm", "stormy", "thunder", "lightning", "tempest", "gale", "ominous", "dark clouds"],
    sun: { azimuth_deg: 230, elevation_deg: 35, color: "#9aa8b8", intensity: 0.75, shadows: true },
    ambient: { color: "#6a7888", ground_color: "#2a2e32", intensity: 0.6 },
    sky: { top: "#1e2630", horizon: "#4a5664", bottom: "#23282c" },
    fog: { color: "#3e4854", near_mult: 0.6, far_mult: 0.65 },
    exposure: 1.25, lamp_boost: 1.5,
  }),
  neon_night: P({
    id: "neon_night", name: "Neon night", time_of_day: 0.92,
    keywords: ["neon", "cyber", "cyberpunk", "city night", "synth", "signs", "electric", "futuristic"],
    sun: { azimuth_deg: 150, elevation_deg: 55, color: "#b890ff", intensity: 0.75, shadows: true },
    ambient: { color: "#5a4aa8", ground_color: "#1a1030", intensity: 0.6 },
    sky: { top: "#0a0620", horizon: "#4a1a5a", bottom: "#140a24" },
    fog: { color: "#2a1440", near_mult: 0.7, far_mult: 0.7 },
    exposure: 1.3, lamp_boost: 1.7,
  }),
});

export const LIGHTING_IDS = Object.freeze(Object.keys(LIGHTING));

// Weather dims the key light and pulls the preset toward the weather-tinted
// environment the world stage built. Values in [0, 1].
const WEATHER_DIM = { clear: 1, cloudy: 0.85, rain: 0.72, storm: 0.62, snow: 0.8, fog: 0.75, sandstorm: 0.7, ash: 0.65 };
const WEATHER_KEEP = { clear: 0.2, cloudy: 0.3, rain: 0.35, storm: 0.4, snow: 0.3, fog: 0.4, sandstorm: 0.45, ash: 0.4 };
const MIN_SUN = 0.6, MIN_AMBIENT = 0.45;

const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
const rgb = (h) => [1, 3, 5].map((k) => parseInt(String(h).slice(k, k + 2), 16) || 0);
const hex = (c) => "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
export function mixHex(a, b, t) {
  if (!isHex(a)) return isHex(b) ? b : "#808080";
  if (!isHex(b) || !t) return a.toLowerCase();
  const x = rgb(a), y = rgb(b);
  return hex(x.map((v, k) => v + (y[k] - v) * t));
}
const r2 = (v) => Math.round(v * 100) / 100;
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** The environment a preset produces on top of a base environment. Pure. */
export function lightingEnvironment(preset, base = {}) {
  const weather = typeof base.weather === "string" ? base.weather : "clear";
  const keep = WEATHER_KEEP[weather] ?? 0.3;
  const dim = WEATHER_DIM[weather] ?? 1;
  const bsky = base.sky || {};
  const sky = {
    top: mixHex(preset.sky.top, bsky.top, keep),
    horizon: mixHex(preset.sky.horizon, bsky.horizon, keep),
    bottom: mixHex(preset.sky.bottom, bsky.bottom, keep),
  };
  const bfog = base.fog || {};
  const baseFar = Number.isFinite(bfog.far) && bfog.far > 0 ? bfog.far : 400;
  const baseNear = Number.isFinite(bfog.near) && bfog.near >= 0 ? bfog.near : baseFar * 0.2;
  const far = Math.max(60, Math.round(baseFar * (preset.fog.far_mult ?? 1)));
  let near = Math.round(baseNear * (preset.fog.near_mult ?? 1));
  if (!(near < far)) near = Math.round(far * 0.2);
  const fogColor = mixHex(preset.fog.color || sky.horizon, bfog.color, keep);
  const sunI = r2(Math.max(MIN_SUN, preset.sun.intensity * dim));
  const bamb = base.ambient || {};
  const ambient = {
    color: mixHex(preset.ambient.color, bamb.color, keep * 0.5),
    ground_color: mixHex(preset.ambient.ground_color, bamb.ground_color, 0.4),
    intensity: r2(Math.max(MIN_AMBIENT, preset.ambient.intensity)),
  };
  const bw = base.water || { enabled: false, level: 0, color: "#2f7fa6", opacity: 0.82 };
  // Water reflects the sky: darken it toward the sky top at night.
  const dark = preset.time_of_day < 0.22 || preset.time_of_day > 0.8;
  const water = { ...bw, color: dark ? mixHex(bw.color, sky.top, 0.35) : bw.color };
  const env = {
    ...base,
    time_of_day: r2(clampN(preset.time_of_day, 0, 1)),
    weather,
    sky,
    fog: { color: fogColor, near, far },
    sun: {
      azimuth_deg: r2(preset.sun.azimuth_deg), elevation_deg: r2(clampN(preset.sun.elevation_deg, -90, 90)),
      color: preset.sun.color, intensity: sunI, shadows: !!preset.sun.shadows && sunI >= 0.6,
    },
    ambient,
    water,
    lighting: preset.id,
  };
  if (Number.isFinite(preset.exposure)) env.exposure = r2(clampN(preset.exposure, 0.5, 2));
  if (Number.isFinite(preset.lamp_boost)) env.lamp_boost = r2(clampN(preset.lamp_boost, 0.5, 3));
  return env;
}

/** World patch (CONTRACT §3): rewrites world.environment only. Never throws. */
export function applyLighting(world, ctx) {
  const preset = ctx?.lighting;
  if (!world || typeof world !== "object" || !preset || !preset.sun || !preset.sky) return world;
  try {
    return { ...world, environment: lightingEnvironment(preset, world.environment || {}) };
  } catch (e) {
    ctx?.notes?.push?.(`lighting '${preset.id}' skipped: ${e.message}`);
    return world;
  }
}

/** Best preset for free text (keyword hits; ties → first in LIGHTING order). null when nothing matches. */
export function lightingFromText(text) {
  const t = ` ${String(text || "").toLowerCase()} `;
  let best = null, score = 0;
  for (const p of Object.values(LIGHTING)) {
    let s = 0;
    for (const k of p.keywords) if (t.includes(` ${k} `) || t.includes(` ${k}`)) s += k.includes(" ") ? 2 : 1;
    if (s > score) { score = s; best = p.id; }
  }
  return best;
}
