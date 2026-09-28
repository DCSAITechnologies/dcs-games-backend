// Games-D generation recipes (CONTRACT §1). Node-side (hashing).
//
// A recipe is the whole input of a fallback game: seed, theme, gameplay
// template, layout, difficulty, lighting, scale. Nothing else feeds the build,
// so a recipe is also a replay file: the same recipe rebuilds the same bytes.

import { sha256Json } from "../gamesb/common/hash.mjs";
import { hashString, seeded } from "../gamesb/common/rng.mjs";
import { THEMES } from "./world/themes.mjs";
import { LIGHTING } from "./world/lighting.mjs";
import { LAYOUTS } from "./missions/layouts.mjs";
import { TEMPLATES } from "./gameplay/templates.mjs";
import { DIFFICULTY, DIFFICULTY_LEVELS } from "./difficulty.mjs";

export const RECIPE_VERSION = "1.0.0";
const SCALES = ["small", "medium", "large"];
const FIELDS = ["recipe_version", "seed", "theme", "template", "layout", "difficulty", "lighting", "scale", "title", "prompt"];

/** Fill defaults and drop unknown keys. Does not validate. */
export function normaliseRecipe(r = {}) {
  const out = {
    recipe_version: RECIPE_VERSION,
    seed: Number.isInteger(r.seed) && r.seed >= 0 ? r.seed : 1,
    theme: r.theme,
    template: r.template,
    layout: r.layout,
    difficulty: r.difficulty || "normal",
    lighting: r.lighting ?? null,
    scale: r.scale ?? null,
  };
  if (typeof r.title === "string" && r.title.trim()) out.title = r.title.trim().slice(0, 80);
  if (typeof r.prompt === "string" && r.prompt.trim()) out.prompt = r.prompt.trim().slice(0, 600);
  return out;
}

/** @returns {{ ok, errors: [{path, message}], warnings: [string] }} */
export function validateRecipe(r) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  if (!r || typeof r !== "object") return { ok: false, errors: [{ path: "$", message: "recipe must be an object" }], warnings };
  if (r.recipe_version !== RECIPE_VERSION) err("recipe_version", `must be "${RECIPE_VERSION}"`);
  if (!Number.isInteger(r.seed) || r.seed < 0 || r.seed > 0xffffffff) err("seed", "must be an integer in [0, 2^32)");
  if (!THEMES[r.theme]) err("theme", `unknown theme '${r.theme}' (have ${Object.keys(THEMES).join(", ")})`);
  if (!TEMPLATES[r.template]) err("template", `unknown template '${r.template}' (have ${Object.keys(TEMPLATES).join(", ")})`);
  if (!LAYOUTS[r.layout]) err("layout", `unknown layout '${r.layout}' (have ${Object.keys(LAYOUTS).join(", ")})`);
  if (!DIFFICULTY_LEVELS.includes(r.difficulty)) err("difficulty", `must be one of ${DIFFICULTY_LEVELS.join("|")}`);
  if (r.lighting !== null && r.lighting !== undefined && !LIGHTING[r.lighting]) err("lighting", `unknown lighting '${r.lighting}'`);
  if (r.scale !== null && r.scale !== undefined && !SCALES.includes(r.scale)) err("scale", `must be one of ${SCALES.join("|")} or null`);
  for (const k of Object.keys(r)) if (!FIELDS.includes(k)) warnings.push(`unknown field '${k}' is ignored`);
  // Compatibility: a template's needs against the layout it runs on.
  const t = TEMPLATES[r.template], l = LAYOUTS[r.layout];
  if (t && l && t.needs?.locations_min && l.locations < t.needs.locations_min) {
    err("layout", `template '${t.id}' needs ${t.needs.locations_min} locations; layout '${l.id}' has ${l.locations}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export const recipeId = (r) => "rcp_" + sha256Json(normaliseRecipe(r)).slice(0, 12);
export const gameIdFor = (r) => `fb_${r.theme}_${r.template}_${r.difficulty}_${r.seed}`;

// ---------------------------------------------------------- prompt → recipe

const words = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const stem = (w) => w.replace(/(ies)$/, "y").replace(/([^s])s$/, "$1");

function best(table, ws, fallbackId) {
  const bag = new Set([...ws, ...ws.map(stem)]);
  let top = null, topScore = 0;
  for (const [id, def] of Object.entries(table)) {
    let s = 0;
    for (const k of def.keywords || []) {
      const parts = k.split(" ");
      if (parts.every((p) => bag.has(p) || bag.has(stem(p)))) s += parts.length;
    }
    if (s > topScore) { top = id; topScore = s; }
  }
  return { id: top || fallbackId, score: topScore };
}

/**
 * Map free text onto a recipe with keyword scoring only. Deterministic: the
 * same prompt and seed always give the same recipe. Unmatched parts fall back
 * to a seeded choice among compatible options, never to an error.
 */
export function recipeFromPrompt(prompt, { seed } = {}) {
  const text = String(prompt || "").trim();
  const ws = words(text);
  const s = Number.isInteger(seed) && seed >= 0 ? seed : hashString(text || "dcs");
  const R = seeded(hashString(`recipe|${s}|${text}`));
  const ids = (o) => Object.keys(o);

  const theme = best(THEMES, ws, null).id || R.pick(ids(THEMES));
  const template = best(TEMPLATES, ws, null).id || R.pick(ids(TEMPLATES));
  const difficulty = ws.some((w) => ["easy", "relaxing", "cozy", "cosy", "gentle", "casual", "kids"].includes(w)) ? "easy"
    : ws.some((w) => ["hard", "brutal", "punishing", "difficult", "hardcore", "deadly"].includes(w)) ? "hard" : "normal";
  const lighting = best(LIGHTING, ws, null).id || null;
  const scale = ws.some((w) => ["tiny", "small", "short", "quick", "little"].includes(w)) ? "small"
    : ws.some((w) => ["vast", "huge", "large", "epic", "sprawling", "open"].includes(w)) ? "large" : null;
  // Layout: keyword match first; otherwise the first layout the template accepts.
  let layout = best(LAYOUTS, ws, null).id;
  const need = TEMPLATES[template]?.needs?.locations_min || 0;
  if (!layout || LAYOUTS[layout].locations < need) {
    const ok = ids(LAYOUTS).filter((id) => LAYOUTS[id].locations >= need && (!scale || LAYOUTS[id].scale === scale));
    layout = ok.length ? R.pick(ok) : ids(LAYOUTS).find((id) => LAYOUTS[id].locations >= need) || ids(LAYOUTS)[0];
  }
  return normaliseRecipe({ seed: s, theme, template, layout, difficulty, lighting, scale, ...(text ? { prompt: text } : {}) });
}

export { DIFFICULTY };
