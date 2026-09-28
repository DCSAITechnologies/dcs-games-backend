// Games-D sample catalogue: hand-picked recipes the bench builds and scores.
// Node-side (validates against the live preset tables).
//
// Together the samples cover every theme, every gameplay template, every
// layout, all three difficulties and every lighting preset. SAMPLE_RECIPES is
// the raw list; sampleRecipes() returns them normalised and validated against
// whatever tables exist right now, substituting the nearest valid preset (and
// saying so in `notes`) if one has been renamed or removed.

import { THEMES } from "../world/themes.mjs";
import { LIGHTING } from "../world/lighting.mjs";
import { TEMPLATES } from "../gameplay/templates.mjs";
import { LAYOUTS } from "../missions/layouts.mjs";
import { DIFFICULTY_LEVELS } from "../difficulty.mjs";
import { normaliseRecipe, validateRecipe, recipeId } from "../recipe.mjs";

const S = (id, title, theme, template, layout, difficulty, lighting, seed, extra = {}) =>
  Object.freeze({ id, title, theme, template, layout, difficulty, lighting, seed, ...extra });

export const SAMPLE_RECIPES = Object.freeze([
  S("s01_storm_lighthouse", "Lighthouse at the Edge of the Storm", "storm_isle", "classic_chain", "classic", "normal", "storm_dark", 101),
  S("s02_cove_relics", "Relics of the Turquoise Cove", "tropical_cove", "relic_hunt", "archipelago_hop", "easy", "golden_hour", 202),
  S("s03_pine_tour", "Dawn Walk Round Pine Valley", "pine_valley", "grand_tour", "grand_loop", "easy", "dawn", 303),
  S("s04_fen_hunt", "Hunt in the Drowned Fen", "swamp_fen", "hunt", "outpost_cluster", "hard", "overcast", 404),
  S("s05_dune_courier", "Courier Across the Dune Sea", "dune_sea", "courier_run", "gauntlet", "normal", "noon", 505),
  S("s06_oasis_rush", "Oasis Sundown Rush", "oasis_flats", "timed_rush", "compact_trail", "easy", "golden_hour", 606),
  S("s07_frost_beacons", "Beacons over Frost Peaks", "frost_peaks", "beacon_circuit", "hub_spoke", "normal", "night", 707),
  S("s08_glacier_keys", "Keys of the Glacier Steps", "glacier_steps", "lock_and_key", "gauntlet", "hard", "dawn", 808),
  S("s09_caldera_stand", "Last Stand at the Ember Caldera", "ember_caldera", "last_stand", "outpost_cluster", "normal", "dusk", 909),
  S("s10_obsidian_heist", "Night Heist on Obsidian Mesa", "obsidian_mesa", "stealth_infiltration", "hub_spoke", "hard", "night", 1010),
  S("s11_canyon_rush", "Red Canyon Race Against the Sun", "red_canyon", "timed_rush", "gauntlet", "hard", "golden_hour", 1111),
  S("s12_sandstone_relics", "Sandstone Steps Treasure Trail", "sandstone_steps", "relic_hunt", "compact_trail", "normal", "noon", 1212),
  S("s13_ruins_seals", "The Sealed Vaults of the Sunken Ruins", "sunken_ruins", "lock_and_key", "hub_spoke", "normal", "overcast", 1313),
  S("s14_temple_beacons", "Temple Lights at Dusk", "overgrown_temple", "beacon_circuit", "grand_loop", "easy", "dusk", 1414),
  S("s15_fog_infiltration", "Neon Fog Infiltration", "fog_city", "stealth_infiltration", "outpost_cluster", "normal", "neon_night", 1515),
  S("s16_hillside_tour", "A Sunny Day in Hillside Town", "hillside_town", "grand_tour", "classic", "easy", "noon", 1616),
  S("s17_orbital_stand", "Hold the Orbital Base", "orbital_base", "last_stand", "compact_trail", "hard", "neon_night", 1717),
  S("s18_crystal_hunt", "Crystal Hollow Night Hunt", "crystal_hollow", "hunt", "grand_loop", "normal", "night", 1818),
]);

// ------------------------------------------------------------ substitution

const first = (o) => Object.keys(o)[0];
function nearestTheme(id) {
  // Same biome by name heuristics, else the first theme.
  const hint = { isle: "island", cove: "island", pine: "forest", fen: "forest", dune: "desert", oasis: "desert", frost: "snow", glacier: "snow",
    ember: "volcanic", obsidian: "volcanic", canyon: "canyon", sandstone: "canyon", ruins: "ruins", temple: "ruins", city: "city", town: "city",
    orbital: "scifi_base", crystal: "scifi_base" };
  const biome = Object.entries(hint).find(([k]) => String(id).includes(k))?.[1];
  return Object.values(THEMES).find((t) => t.biome === biome)?.id || first(THEMES);
}
function nearestTemplate(id, layout) {
  const want = { relic: "collectathon", courier: "mission", timed: "mission", stealth: "stealth", hunt: "adventure", stand: "survival", beacon: "puzzle", lock: "puzzle", tour: "exploration" };
  const genre = Object.entries(want).find(([k]) => String(id).includes(k))?.[1];
  const fits = (t) => !LAYOUTS[layout] || (t.needs?.locations_min || 0) <= LAYOUTS[layout].locations;
  return Object.values(TEMPLATES).find((t) => t.genre === genre && fits(t))?.id || (TEMPLATES.classic_chain ? "classic_chain" : first(TEMPLATES));
}
function nearestLayout(id) {
  const order = ["classic", "hub_spoke", "compact_trail", "grand_loop", "gauntlet", "outpost_cluster"];
  return order.find((l) => LAYOUTS[l]) || first(LAYOUTS);
}
function nearestLighting(id) {
  const tod = { dawn: 0.27, noon: 0.5, golden_hour: 0.7, dusk: 0.76, night: 0.95, overcast: 0.5, storm_dark: 0.6, neon_night: 0.95 }[id];
  if (tod === undefined) return null;
  let best = null, bd = Infinity;
  for (const p of Object.values(LIGHTING)) {
    const d = Math.abs((p.time_of_day ?? 0.5) - tod);
    if (d < bd) { bd = d; best = p.id; }
  }
  return best;
}

/**
 * The catalogue, normalised and valid against the live tables.
 * @returns {Array<{ id, title, recipe, recipe_id, notes: string[] }>}
 */
export function sampleRecipes() {
  return SAMPLE_RECIPES.map((s) => {
    const notes = [];
    let { theme, template, layout, difficulty, lighting } = s;
    if (!THEMES[theme]) { const t = nearestTheme(theme); notes.push(`theme '${theme}' missing → '${t}'`); theme = t; }
    if (!LAYOUTS[layout]) { const l = nearestLayout(layout); notes.push(`layout '${layout}' missing → '${l}'`); layout = l; }
    if (!TEMPLATES[template]) { const g = nearestTemplate(template, layout); notes.push(`template '${template}' missing → '${g}'`); template = g; }
    if (!DIFFICULTY_LEVELS.includes(difficulty)) { notes.push(`difficulty '${difficulty}' missing → 'normal'`); difficulty = "normal"; }
    if (lighting && !LIGHTING[lighting]) { const p = nearestLighting(lighting); notes.push(`lighting '${lighting}' missing → '${p ?? "theme default"}'`); lighting = p; }
    let recipe = normaliseRecipe({ seed: s.seed, theme, template, layout, difficulty, lighting, title: s.title });
    let v = validateRecipe(recipe);
    if (!v.ok && v.errors.some((e) => e.path === "layout")) {
      // Template needs more locations than the layout has: take the smallest layout that fits.
      const need = TEMPLATES[template]?.needs?.locations_min || 0;
      const l = Object.values(LAYOUTS).filter((x) => x.locations >= need).sort((a, b) => a.locations - b.locations)[0];
      if (l) { notes.push(`layout '${layout}' too small for '${template}' → '${l.id}'`); recipe = normaliseRecipe({ ...recipe, layout: l.id }); v = validateRecipe(recipe); }
    }
    if (!v.ok) notes.push(`still invalid: ${v.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    return { id: s.id, title: s.title, recipe, recipe_id: recipeId(recipe), valid: v.ok, notes };
  });
}

/** Coverage of the catalogue against the live tables (for the bench report). */
export function catalogueCoverage(samples = sampleRecipes()) {
  const cov = (key, table) => {
    const used = new Set(samples.map((x) => x.recipe[key]).filter(Boolean));
    const all = Array.isArray(table) ? table : Object.keys(table);
    return { used: all.filter((k) => used.has(k)), missing: all.filter((k) => !used.has(k)) };
  };
  return { themes: cov("theme", THEMES), templates: cov("template", TEMPLATES), layouts: cov("layout", LAYOUTS), difficulties: cov("difficulty", DIFFICULTY_LEVELS), lighting: cov("lighting", LIGHTING) };
}
