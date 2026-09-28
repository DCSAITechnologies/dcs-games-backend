// Games-B vector assets: inventory icons, HUD pieces, and the sky recipe.
// Isomorphic-clean (pure string building), so the runtime could regenerate an
// icon client-side if a package ever arrives without one.
//
// Icons share one 64×64 frame — dark rounded plate, accent rim — so an
// inventory row reads as a set however many kinds it mixes. Every colour that
// reaches markup goes through `safeHex`, and every label through `esc`: the
// palette can come from a model, and markup is not the place to find out.

export const ICON_KINDS = Object.freeze(["lantern_core", "relic", "gem", "key", "scroll", "herb", "shard", "generic"]);
export const UI_NAMES = Object.freeze(["hud_frame", "compass", "prompt"]);

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const safeHex = (v, d) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);

// Gradient ids are suffixed per kind so several icons can be inlined in one
// document without their <defs> colliding.
function frame(inner, { accent, title, id }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title>` +
    `<defs><radialGradient id="bg_${id}" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#2a3142"/><stop offset="1" stop-color="#11141c"/></radialGradient>` +
    `<radialGradient id="gl_${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect x="2" y="2" width="60" height="60" rx="12" fill="url(#bg_${id})" stroke="${accent}" stroke-opacity="0.7" stroke-width="2"/>` +
    `<circle cx="32" cy="32" r="24" fill="url(#gl_${id})"/>` + inner + `</svg>`;
}

const ICONS = {
  lantern_core: (a) =>
    `<circle cx="32" cy="33" r="11" fill="${a}"/><circle cx="29" cy="30" r="4" fill="#fff" fill-opacity="0.7"/>` +
    `<ellipse cx="32" cy="33" rx="14" ry="14" fill="none" stroke="#c89a3a" stroke-width="2.2"/>` +
    `<ellipse cx="32" cy="33" rx="5.5" ry="14" fill="none" stroke="#c89a3a" stroke-width="2.2"/>` +
    `<rect x="27" y="16" width="10" height="4" rx="1.5" fill="#d8b25a"/><rect x="27" y="46" width="10" height="4" rx="1.5" fill="#d8b25a"/>` +
    `<circle cx="32" cy="13" r="2.6" fill="none" stroke="#d8b25a" stroke-width="1.6"/>`,
  relic: (a) =>
    `<path d="M24 50 h16 l-2-4 h-12z" fill="#a8812f"/><path d="M27 46 c-6-4-7-12-3-18 l2-3 h12 l2 3 c4 6 3 14-3 18z" fill="#d8b25a" stroke="#7a5a22" stroke-width="1.4"/>` +
    `<path d="M26 25 h12 l1-4 h-14z" fill="#a8812f"/><path d="M22 34 c-4 0-5-6-1-7" fill="none" stroke="#a8812f" stroke-width="2"/><path d="M42 34 c4 0 5-6 1-7" fill="none" stroke="#a8812f" stroke-width="2"/>` +
    `<polygon points="32,29 35,33 32,37 29,33" fill="${a}"/>`,
  gem: (a) =>
    `<polygon points="20,26 26,18 38,18 44,26 32,48" fill="${a}"/>` +
    `<polygon points="20,26 44,26 32,48" fill="#000" fill-opacity="0.18"/><polygon points="26,18 32,26 38,18" fill="#fff" fill-opacity="0.45"/>` +
    `<polygon points="20,26 26,18 32,26" fill="#fff" fill-opacity="0.25"/><polyline points="20,26 44,26" stroke="#fff" stroke-opacity="0.6" stroke-width="1"/>` +
    `<line x1="32" y1="26" x2="32" y2="48" stroke="#000" stroke-opacity="0.2"/>`,
  key: () =>
    `<circle cx="22" cy="24" r="8" fill="none" stroke="#d8b25a" stroke-width="4"/><circle cx="22" cy="24" r="2.5" fill="#7a5a22"/>` +
    `<rect x="27" y="27" width="22" height="4" rx="1.5" transform="rotate(35 27 27)" fill="#d8b25a"/>` +
    `<rect x="38" y="38" width="4" height="7" transform="rotate(35 38 38)" fill="#d8b25a"/><rect x="43" y="41" width="4" height="5" transform="rotate(35 43 41)" fill="#d8b25a"/>`,
  scroll: (a) =>
    `<rect x="18" y="20" width="28" height="24" fill="#efe2c0" stroke="#b8a27a" stroke-width="1.2"/>` +
    `<rect x="14" y="17" width="6" height="30" rx="3" fill="#a07650"/><rect x="44" y="17" width="6" height="30" rx="3" fill="#a07650"/>` +
    `<line x1="23" y1="27" x2="41" y2="27" stroke="#8a7a5a" stroke-width="1.4"/><line x1="23" y1="32" x2="39" y2="32" stroke="#8a7a5a" stroke-width="1.4"/><line x1="23" y1="37" x2="36" y2="37" stroke="#8a7a5a" stroke-width="1.4"/>` +
    `<rect x="30" y="18" width="4" height="28" fill="${a}" fill-opacity="0.85"/>`,
  herb: (a) =>
    `<path d="M32 50 C32 40 31 30 32 18" stroke="#4f7f2c" stroke-width="2.4" fill="none"/>` +
    `<path d="M32 40 C24 40 19 34 18 28 C25 28 30 32 32 40z" fill="#5a8a36"/><path d="M32 34 C40 34 45 28 46 22 C39 22 34 26 32 34z" fill="#7fa845"/>` +
    `<path d="M32 46 C38 46 42 42 44 37 C38 37 34 40 32 46z" fill="#4f7f2c"/><circle cx="32" cy="17" r="4" fill="${a}"/>`,
  shard: (a) =>
    `<polygon points="30,12 38,30 33,52 25,32" fill="${a}"/><polygon points="30,12 33,52 25,32" fill="#000" fill-opacity="0.2"/>` +
    `<polygon points="40,26 46,36 41,48 37,38" fill="${a}" fill-opacity="0.8"/><polygon points="21,34 24,44 19,50 17,40" fill="${a}" fill-opacity="0.7"/>` +
    `<line x1="30" y1="12" x2="31" y2="36" stroke="#fff" stroke-opacity="0.6" stroke-width="1.2"/>`,
  generic: (a) =>
    `<polygon points="32,14 37,27 51,27 40,35 44,49 32,41 20,49 24,35 13,27 27,27" fill="${a}" stroke="#fff" stroke-opacity="0.4"/>`,
};

const DEFAULT_ACCENT = { lantern_core: "#ffd27a", relic: "#6fd3ff", gem: "#46d1a0", key: "#d8b25a", scroll: "#b3263a", herb: "#b7f06a", shard: "#9ad8ff", generic: "#f2c14e" };

/** Inventory icon SVG for an item kind (unknown kinds get the generic star). */
export function iconSvg(kind, { palette = null, title = null } = {}) {
  const k = ICON_KINDS.includes(kind) ? kind : "generic";
  const accent = safeHex(palette?.accent, DEFAULT_ACCENT[k]);
  return frame(ICONS[k](accent), { accent, title: title || k.replace(/_/g, " "), id: k });
}

/** HUD SVGs. Text is set by the runtime; these are frames, dials and key caps. */
export function uiSvg(name, { palette = null } = {}) {
  const accent = safeHex(palette?.accent, "#f2c14e");
  const ink = "#e8ecf5";
  if (name === "hud_frame") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 128" width="512" height="128" role="img" aria-label="HUD frame"><title>HUD frame</title>` +
      `<defs><linearGradient id="hud_p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2030" stop-opacity="0.82"/><stop offset="1" stop-color="#0c0f16" stop-opacity="0.9"/></linearGradient></defs>` +
      `<path d="M16 4 H496 L508 16 V112 L496 124 H16 L4 112 V16 Z" fill="url(#hud_p)" stroke="${accent}" stroke-opacity="0.75" stroke-width="2"/>` +
      `<path d="M4 34 V16 L16 4 H40" fill="none" stroke="${accent}" stroke-width="4"/><path d="M508 94 V112 L496 124 H472" fill="none" stroke="${accent}" stroke-width="4"/>` +
      `<line x1="24" y1="64" x2="488" y2="64" stroke="${ink}" stroke-opacity="0.08"/></svg>`;
  }
  if (name === "compass") {
    const ticks = Array.from({ length: 36 }, (_, i) => {
      const a = (i * 10 * Math.PI) / 180, major = i % 9 === 0, r0 = major ? 96 : 104;
      const f = (v) => v.toFixed(1);
      return `<line x1="${f(128 + Math.sin(a) * r0)}" y1="${f(128 - Math.cos(a) * r0)}" x2="${f(128 + Math.sin(a) * 114)}" y2="${f(128 - Math.cos(a) * 114)}" stroke="${ink}" stroke-opacity="${major ? 0.9 : 0.45}" stroke-width="${major ? 3 : 1.5}"/>`;
    }).join("");
    const letter = (t, x, y, fill) => `<text x="${x}" y="${y}" fill="${fill}" font-family="system-ui,sans-serif" font-size="24" font-weight="700" text-anchor="middle" dominant-baseline="central">${t}</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="Compass"><title>Compass</title>` +
      `<circle cx="128" cy="128" r="122" fill="#0c0f16" fill-opacity="0.7" stroke="${accent}" stroke-width="3"/>` + ticks +
      letter("N", 128, 70, accent) + letter("E", 186, 128, ink) + letter("S", 128, 186, ink) + letter("W", 70, 128, ink) +
      `<polygon points="128,92 136,128 128,122 120,128" fill="${accent}"/><polygon points="128,164 136,128 128,134 120,128" fill="${ink}" fill-opacity="0.5"/></svg>`;
  }
  if (name === "prompt") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 64" width="256" height="64" role="img" aria-label="Interaction prompt"><title>Interaction prompt</title>` +
      `<rect x="2" y="6" width="252" height="52" rx="26" fill="#0c0f16" fill-opacity="0.78" stroke="${accent}" stroke-opacity="0.8" stroke-width="2"/>` +
      `<rect x="12" y="14" width="36" height="36" rx="8" fill="${ink}"/><rect x="12" y="44" width="36" height="6" rx="3" fill="#000" fill-opacity="0.25"/>` +
      `<text x="30" y="33" fill="#11141c" font-family="system-ui,sans-serif" font-size="22" font-weight="800" text-anchor="middle" dominant-baseline="central">E</text></svg>`;
  }
  return null;
}

// ------------------------------------------------------------------- sky

const CLOUD_COVER = { clear: 0.15, cloudy: 0.6, rain: 0.8, storm: 0.95, snow: 0.75, fog: 0.5, sandstorm: 0.45, ash: 0.7 };
const CLOUD_TINT = { clear: "#ffffff", cloudy: "#e8ecf0", rain: "#9aa4ae", storm: "#6a7078", snow: "#eef2f6", fog: "#d8dde2", sandstorm: "#d8b88a", ash: "#6a625c" };

/**
 * `sky:main` recipe from the world environment: gradient, sun disc and glow,
 * procedural cloud layer, stars at night. The runtime builds a sky dome from
 * it; nothing here is an image.
 */
export function skyRecipe(environment = {}, { seed = 0 } = {}) {
  const sky = environment.sky || {};
  const sun = environment.sun || {};
  const weather = environment.weather || "clear";
  const tod = Number.isFinite(environment.time_of_day) ? environment.time_of_day : 0.5;
  const night = tod < 0.22 || tod > 0.8;
  const elev = Number.isFinite(sun.elevation_deg) ? sun.elevation_deg : 45;
  return {
    type: "gradient-dome",
    top: safeHex(sky.top, "#3f7fc8"), horizon: safeHex(sky.horizon, "#bcd8ee"), bottom: safeHex(sky.bottom, "#8aa4b8"),
    sun: {
      azimuth_deg: Number.isFinite(sun.azimuth_deg) ? sun.azimuth_deg : 135, elevation_deg: elev,
      color: safeHex(sun.color, "#fff4d6"), intensity: Number.isFinite(sun.intensity) ? sun.intensity : 1,
      disc_deg: elev < 12 ? 3.2 : 2.2,                          // low sun looks larger
      glow: Math.round((elev < 12 ? 0.8 : 0.45) * 100) / 100,
      visible: !night && !["storm", "fog", "ash"].includes(weather),
    },
    clouds: {
      coverage: CLOUD_COVER[weather] ?? 0.3, color: CLOUD_TINT[weather] ?? "#ffffff",
      scale: 1, speed: weather === "storm" ? 3 : weather === "sandstorm" ? 4 : 0.6, altitude_m: 180, seed: seed >>> 0,
    },
    stars: { enabled: night, density: night ? 0.6 : 0 },
    fog: environment.fog ? { color: safeHex(environment.fog.color, "#c8d0d8"), near: environment.fog.near, far: environment.fog.far } : null,
    weather, time_of_day: tod,
  };
}
