// Games-D local fallback engine: recipe → playable, validated, playtested GamePackage.
// Node-side. Zero API: providers are forced offline, and the timestamp is pinned
// so the same recipe always rebuilds the same bytes.
//
// The engine owns no generation of its own. It builds a stage context from the
// recipe and composes the module hooks (CONTRACT §3) into Games-B `overrides`,
// so every fallback game passes through the same validators, reachability check
// and headless playtest as any other Games-B game.

import { buildGame } from "../gamesb/pipeline.mjs";
import { hashString, seeded } from "../gamesb/common/rng.mjs";
import { normaliseRecipe, validateRecipe, recipeId, gameIdFor } from "./recipe.mjs";
import { DIFFICULTY } from "./difficulty.mjs";
import { THEMES, themeConceptPatch, themeWorldPatch } from "./world/themes.mjs";
import { LIGHTING, applyLighting } from "./world/lighting.mjs";
import { LAYOUTS, layoutConceptPatch } from "./missions/layouts.mjs";
import { npcConceptPatch, applyNpcPresets } from "./npc/behaviours.mjs";
import { TEMPLATES, templateConceptPatch, applyTemplate } from "./gameplay/templates.mjs";
import { materialConceptPatch } from "./materials/material-styles.mjs";
import { audioFor } from "./audio/sfx.mjs";
import { resolveEngineExternal, LOCAL_FALLBACK_PROVIDER } from "./engine-flags.mjs";

export const ENGINE_VERSION = "gamesd-1.0.0";
export const OFFLINE_ENV = Object.freeze({ DCS_PROVIDERS_OFFLINE: "1" });
export const FALLBACK_CREATED_AT = "2026-09-29T00:00:00.000Z";

/**
 * The package-level statement of how a fallback game was made (top-level
 * `pkg.generation`, add-only). It is the same for every build, so it never
 * disturbs byte-identical rebuilds, and it is true by construction: the build
 * runs with OFFLINE_ENV, where every provider adapter reports UNAVAILABLE from
 * its status check and is never invoked (test/gamesd-outbound-trap.test.mjs).
 */
export const GENERATION = Object.freeze({
  provider: LOCAL_FALLBACK_PROVIDER,
  engine: ENGINE_VERSION,
  method: "procedural",
  external_generation: false,
  engine_external: false,
  external_calls: 0,
  cost_usd: 0,
  note: "Built by the Games-D local fallback engine from a recipe, with no AI model or external provider. " +
    "Stage provenance 'after_failed' entries name provider adapters that were skipped as unavailable (providers offline); none was called.",
});

/** Stage context for a (normalised, valid) recipe. */
export function makeContext(recipe) {
  const theme = THEMES[recipe.theme];
  const lightingId = recipe.lighting || theme.lightings?.[recipe.seed % Math.max(1, theme.lightings?.length || 1)] || null;
  const layout = LAYOUTS[recipe.layout];
  return {
    recipe,
    theme,
    template: TEMPLATES[recipe.template],
    layout,
    lighting: lightingId ? LIGHTING[lightingId] || null : null,
    difficulty: DIFFICULTY[recipe.difficulty],
    scale: recipe.scale || layout.scale || "medium",
    notes: [],
    rand: (stage) => seeded(hashString(`${stage}|${recipe.seed}|${recipe.theme}|${recipe.template}|${recipe.layout}`)),
  };
}

/** Text fed to the local concept generator, so its names and locations match the theme. */
export function conceptPromptFor(recipe, ctx) {
  const t = ctx.theme, g = ctx.template;
  return [recipe.prompt, `${t.name}.`, (t.keywords || []).slice(0, 4).join(" "), g.genre, g.name].filter(Boolean).join(" ");
}

/** The Games-B overrides for a recipe. Exposed for tests and tooling. */
export function overridesFor(recipe, ctx) {
  return {
    concept: (c0) => {
      // nav_edge_guard: keep cliff-rim cells off the nav grid (world-spec bakeNavigation).
      let c = { ...c0, scale: ctx.scale, nav_edge_guard: true };
      c = themeConceptPatch(c, ctx);
      c = layoutConceptPatch(c, ctx);
      c = npcConceptPatch(c, ctx);
      c = templateConceptPatch(c, ctx);
      c = materialConceptPatch(c, ctx);
      if (ctx.lighting && typeof ctx.lighting.time_of_day === "number") c = { ...c, time_of_day: ctx.lighting.time_of_day };
      if (recipe.title) c = { ...c, title: recipe.title };
      return { ...c, fallback_recipe: { ...recipe, recipe_id: recipeId(recipe), engine: ENGINE_VERSION } };
    },
    world: (w, { concept }) => applyLighting(themeWorldPatch(w, { ...ctx, concept }), { ...ctx, concept }),
    characters: (ch, { concept, world }) => applyNpcPresets(ch, { ...ctx, concept, world }),
    gameplay: (g, { concept, world, characters }) => applyTemplate(g, { ...ctx, concept, world, characters }),
    extras: ({ concept, world, characters, gameplay }) => {
      const audio = audioFor({ ...ctx, concept, world, characters, gameplay });
      return { generation: { ...GENERATION }, ...(audio ? { audio } : {}) };
    },
  };
}

/**
 * Build a fallback game from a recipe.
 * @param {object} recipeIn
 * @param {{ playtest?: boolean, createdAt?: string, deps?: object, maxSimSeconds?: number, env?: object }} [opts]
 *   `env` is read only for DCS_GAMES_ENGINE_EXTERNAL; provider calls always get OFFLINE_ENV.
 * @returns {Promise<{ ok, provider, engine_external, recipe, recipe_id, notes, pkg, validation, playtest, reachability, timings, build_ms }>}
 */
export async function buildFromRecipe(recipeIn, { playtest = true, createdAt = FALLBACK_CREATED_AT, deps, maxSimSeconds, env = process.env } = {}) {
  // Fail closed: a request to go external is refused and reported, and the
  // build carries on locally. The refusal stays out of the package so the
  // package bytes never depend on the environment.
  const engineExternal = resolveEngineExternal(env);
  const recipe = normaliseRecipe(recipeIn);
  const v = validateRecipe(recipe);
  if (!v.ok) {
    const e = new Error(`invalid recipe: ${v.errors.map((x) => `${x.path}: ${x.message}`).join("; ")}`);
    e.validation = v;
    throw e;
  }
  const ctx = makeContext(recipe);
  if (engineExternal.requested) ctx.notes.push(engineExternal.reason);
  const t0 = performance.now();
  const prompt = conceptPromptFor(recipe, ctx);
  const ov = overridesFor(recipe, ctx);
  // The concept stage runs the real local generator (offline env) and the
  // recipe patches its output, so provenance says what actually happened.
  const res = await buildGame(prompt, {
    seed: recipe.seed,
    env: OFFLINE_ENV,
    gameId: gameIdFor(recipe),
    createdAt,
    playtest,
    deps,
    maxSimSeconds,
    overrides: ov,
  });
  return { ...res, provider: LOCAL_FALLBACK_PROVIDER, engine_external: engineExternal, recipe, recipe_id: recipeId(recipe), notes: ctx.notes, build_ms: Math.round(performance.now() - t0) };
}
