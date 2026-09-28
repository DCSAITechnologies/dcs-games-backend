// Games-D procedural preset matrix. Node-side (reads every preset table).
//
// A fallback game is theme × template × layout × difficulty × lighting × seed.
// presetMatrix() lists every preset in every table as one row, so the bench
// can write DCS_GAMES_PROCEDURAL_PRESET_MATRIX.csv, and compatibility(recipe)
// says whether a combination is buildable and what might look off.
//
// The tables are read through namespace imports and never hard-coded here:
// a table another lane adds or renames shows up in the matrix automatically,
// and a missing export yields no rows instead of a crash.

import * as themesMod from "../world/themes.mjs";
import * as lightingMod from "../world/lighting.mjs";
import * as templatesMod from "../gameplay/templates.mjs";
import * as layoutsMod from "../missions/layouts.mjs";
import * as npcMod from "../npc/behaviours.mjs";
import * as materialsMod from "../materials/material-styles.mjs";
import * as audioMod from "../audio/sfx.mjs";
import { DIFFICULTY, DIFFICULTY_LEVELS } from "../difficulty.mjs";
import { normaliseRecipe, validateRecipe } from "../recipe.mjs";

export const PRESET_MATRIX_COLUMNS = Object.freeze(["kind", "id", "name", "category", "scale", "params", "compatible_with", "keywords", "summary"]);

const tbl = (o) => (o && typeof o === "object" ? o : {});
export const tables = () => ({
  themes: tbl(themesMod.THEMES),
  templates: tbl(templatesMod.TEMPLATES),
  layouts: tbl(layoutsMod.LAYOUTS),
  difficulties: tbl(DIFFICULTY),
  lighting: tbl(lightingMod.LIGHTING),
  archetypes: tbl(npcMod.ARCHETYPES),
  material_styles: tbl(materialsMod.MATERIAL_STYLES),
  audio: tbl(audioMod.AUDIO_PRESETS),
});

const list = (a) => (Array.isArray(a) ? a.join(" ") : "");
const kv = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : v}`).join("; ");
const locMin = (t) => t?.needs?.locations_min || 0;

/** Layout ids a template can run on (enough locations). */
function layoutsFor(template, T) {
  return Object.values(T.layouts).filter((l) => l.locations >= locMin(template)).map((l) => l.id);
}
/** Template ids a layout can host. */
function templatesFor(layout, T) {
  return Object.values(T.templates).filter((t) => layout.locations >= locMin(t)).map((t) => t.id);
}

/**
 * Every preset of every table as one row. Values are plain strings/numbers so
 * the rows go straight into a CSV.
 * @returns {Array<{kind,id,name,category,scale,params,compatible_with,keywords,summary}>}
 */
export function presetMatrix() {
  const T = tables();
  const rows = [];
  const row = (r) => rows.push(Object.fromEntries(PRESET_MATRIX_COLUMNS.map((c) => [c, r[c] ?? ""])));

  for (const t of Object.values(T.themes)) {
    const layouts = Object.values(T.layouts).filter((l) => !l.biomes || l.biomes.includes(t.biome)).map((l) => l.id);
    row({ kind: "theme", id: t.id, name: t.name, category: t.biome,
      params: kv({ terrain: t.terrain_shape, weathers: t.weathers, mood: t.mood, scatter_density: t.scatter_density, pickup: t.pickup_lib, material_style: t.material_style, audio: t.audio }),
      compatible_with: `lighting:${list(t.lightings)} | layouts:${layouts.join(" ")}`, keywords: list(t.keywords), summary: list(t.tags) });
  }
  for (const g of Object.values(T.templates)) {
    row({ kind: "template", id: g.id, name: g.name, category: g.genre,
      params: kv({ timed: g.timed ? "yes" : "no", locations_min: g.needs?.locations_min, hostiles_min: g.needs?.hostiles_min, hostiles_max: g.needs?.hostiles_max, companion: g.needs?.companion, objective_kinds: g.kinds }),
      compatible_with: `layouts:${layoutsFor(g, T).join(" ")}`, keywords: list(g.keywords), summary: g.summary });
  }
  for (const l of Object.values(T.layouts)) {
    row({ kind: "layout", id: l.id, name: l.name, category: l.ordering, scale: l.scale,
      params: kv({ locations: l.locations, ordering: l.ordering, kinds: l.kinds, finale: l.finale_kinds, biomes: l.biomes }),
      compatible_with: `templates:${templatesFor(l, T).join(" ")}${l.biomes ? ` | biomes:${l.biomes.join(" ")}` : ""}`, keywords: list(l.keywords), summary: l.summary });
  }
  for (const id of DIFFICULTY_LEVELS) {
    const d = T.difficulties[id];
    if (!d) continue;
    row({ kind: "difficulty", id, name: id[0].toUpperCase() + id.slice(1), category: "difficulty",
      params: kv({ damage_mult: d.damage_mult, time_mult: d.time_mult, lives: d.lives, player_health: d.player_health, hostile_bonus: d.hostile_bonus, npc_speed_mult: d.npc_speed_mult, sight_mult: d.sight_mult }),
      compatible_with: "all", keywords: "", summary: "" });
  }
  for (const p of Object.values(T.lighting)) {
    const themes = Object.values(T.themes).filter((t) => (t.lightings || []).includes(p.id)).map((t) => t.id);
    row({ kind: "lighting", id: p.id, name: p.name, category: "lighting",
      params: kv({ time_of_day: p.time_of_day, sun_elevation: p.sun?.elevation_deg, sun_intensity: p.sun?.intensity, exposure: p.exposure, lamp_boost: p.lamp_boost }),
      compatible_with: `default_for:${themes.join(" ") || "-"} | any theme`, keywords: list(p.keywords), summary: p.summary || "" });
  }
  for (const a of Object.values(T.archetypes)) {
    const b = a.behavior || {};
    row({ kind: "npc_archetype", id: a.id, name: a.name || a.id, category: a.hostile ? "hostile" : "friendly",
      params: kv({ initial: b.initial, near: b.on_player_near, far: b.on_player_far, speed: b.speed, sight: b.sight_radius, leash: b.leash_radius, route: a.route }),
      compatible_with: "all", keywords: list(a.keywords), summary: a.summary || "" });
  }
  for (const m of Object.values(T.material_styles)) {
    row({ kind: "material_style", id: m.id, name: m.name || m.id, category: "materials",
      params: kv({ tint: Array.isArray(m.tint) ? m.tint[0] : m.tint, tile_mult: m.tile_mult, materials: m.materials ? Object.keys(m.materials) : null }),
      compatible_with: "all", keywords: list(m.keywords), summary: m.summary || "" });
  }
  for (const [id, a] of Object.entries(T.audio)) {
    row({ kind: "audio", id: a?.id || id, name: a?.name || id, category: "audio",
      params: kv({ master: a?.master, layers: Array.isArray(a?.layers) ? a.layers.map((x) => x?.id).filter(Boolean) : null }),
      compatible_with: "all", keywords: list(a?.keywords), summary: a?.summary || "" });
  }
  return rows;
}

/** CSV text for rows (RFC 4180 quoting). */
export function matrixCsv(rows = presetMatrix()) {
  const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [PRESET_MATRIX_COLUMNS.join(","), ...rows.map((r) => PRESET_MATRIX_COLUMNS.map((c) => q(r[c])).join(","))].join("\n") + "\n";
}

/**
 * Is this recipe buildable, and what might look off?
 * `ok` is false only for hard errors (validateRecipe); soft mismatches go to
 * `warnings`. `reasons` lists both, hard first.
 * @returns {{ ok: boolean, reasons: string[], warnings: string[] }}
 */
export function compatibility(recipeIn) {
  const T = tables();
  const r = normaliseRecipe(recipeIn || {});
  const v = validateRecipe(r);
  const hard = v.errors.map((e) => `${e.path}: ${e.message}`);
  const warnings = [];
  const theme = T.themes[r.theme], template = T.templates[r.template], layout = T.layouts[r.layout];
  if (theme && layout?.biomes && !layout.biomes.includes(theme.biome)) warnings.push(`layout '${layout.id}' is tuned for ${layout.biomes.join("/")}; theme '${theme.id}' is ${theme.biome}`);
  if (theme && r.lighting && Array.isArray(theme.lightings) && theme.lightings.length && !theme.lightings.includes(r.lighting)) warnings.push(`lighting '${r.lighting}' is not one of theme '${theme.id}' defaults (${theme.lightings.join(", ")})`);
  const scale = r.scale || layout?.scale;
  if (template?.timed && scale === "large") warnings.push(`timed template '${template.id}' on a large map: expect a generous clock`);
  if (template?.needs?.hostiles_min && r.difficulty === "easy") warnings.push(`template '${template.id}' needs hostiles; easy adds none beyond the base roster`);
  if (r.lighting === "neon_night" && theme && !["city", "scifi_base"].includes(theme.biome)) warnings.push(`neon_night lighting on a ${theme.biome} theme`);
  return { ok: hard.length === 0, reasons: [...hard, ...warnings], warnings };
}
