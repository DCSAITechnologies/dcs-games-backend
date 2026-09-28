// Games-B pipeline: prompt → playable, validated, playtested GamePackage.
//
// Runs the §4.5 stages in order, timing each and collecting its
// ProvenanceStage, then assembles, validates and headless-plays the result.
// The pipeline never "passes" a game on its own say-so: the caller gets the
// validation report and the playtest report next to the package, and
// `ok` is true only when both gates pass.
//
// Stage modules are imported lazily so the error for a missing stage names the
// stage, and so tooling that only needs writePackage never loads them.

import fs from "node:fs";
import path from "node:path";
import { assemblePackage } from "./runtime/assemble.mjs";
import { validatePackage } from "./runtime/validate-package.mjs";
import { headlessPlaytest, checkObjectiveReachability } from "./runtime/headless-playtest.mjs";

async function stageModule(rel, fn, stage) {
  let mod;
  try { mod = await import(rel); } catch (e) { throw new Error(`pipeline: stage '${stage}' is unavailable (${rel}: ${e.message})`); }
  if (typeof mod[fn] !== "function") throw new Error(`pipeline: ${rel} does not export ${fn}()`);
  return mod[fn];
}

const nowIso = () => new Date().toISOString();

function localStage(stage, latency_ms, at) {
  return { stage, lane: "local", provider: "local:deterministic", model: "deterministic", status: "AVAILABLE", latency_ms, cost_usd: 0, at };
}

function slug(s) {
  return String(s || "game").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "game";
}

/**
 * Build a game from a prompt.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @param {object} [opts.env]       provider environment; `{ DCS_PROVIDERS_OFFLINE: "1" }` forces the local path
 * @param {string} [opts.gameId]
 * @param {object} [opts.cache]     passed to resolveAssets
 * @param {string} [opts.createdAt] fixed timestamp for byte-identical rebuilds: provenance `at` is pinned to it
 *                                  and provenance `latency_ms` is zeroed (real timings stay in the returned `timings`)
 * @param {object} [opts.overrides] { concept: object|fn, world|characters|assets|gameplay|scene: fn(value, ctx) → value }
 *                                  — an object `concept` replaces generation (flagship authoring); functions patch a stage's output.
 *                                  `extras: fn({concept, world, characters, gameplay}) → object` adds optional top-level package fields.
 * @param {boolean} [opts.playtest=true]
 * @param {object} [opts.deps]      sim deps for the playtest (defaults to runtime/deps.mjs)
 * @returns {Promise<{ok, pkg, validation, playtest, reachability, timings}>}
 */
export async function buildGame(prompt, { seed, env = process.env, gameId, cache, createdAt, overrides = {}, playtest = true, deps, maxSimSeconds } = {}) {
  const timings = {};
  const stages = [];
  const time = async (name, fn) => {
    const t0 = performance.now();
    const v = await fn();
    timings[name] = Math.round((performance.now() - t0) * 100) / 100;
    return v;
  };
  const patch = (name, value, ctx) => (typeof overrides[name] === "function" ? overrides[name](value, ctx) : value);

  // 1. concept
  const concept = await time("concept", async () => {
    if (overrides.concept && typeof overrides.concept === "object") {
      stages.push({ ...localStage("concept", 0, nowIso()), provider: "authored", model: "human" });
      return overrides.concept;
    }
    const generateConcept = await stageModule("./concept/concept.mjs", "generateConcept", "concept");
    const r = await generateConcept(prompt, { seed, env });
    stages.push(r.provenance);
    return patch("concept", r.concept, {});
  });

  // 2. world
  const world = await time("world", async () => {
    const generateWorldSpec = await stageModule("./world/world-spec.mjs", "generateWorldSpec", "world");
    const t0 = performance.now();
    const w = generateWorldSpec(concept, { seed: Number.isInteger(seed) ? seed : concept.seed });
    stages.push(localStage("world", Math.round(performance.now() - t0), nowIso()));
    return patch("world", w, { concept });
  });

  // 3. characters
  const characters = await time("characters", async () => {
    const generateCharacters = await stageModule("./characters/characters.mjs", "generateCharacters", "characters");
    const t0 = performance.now();
    const c = generateCharacters({ concept, world });
    stages.push(localStage("characters", Math.round(performance.now() - t0), nowIso()));
    return patch("characters", c, { concept, world });
  });

  const id = gameId || `${slug(concept.title)}_${String(concept.prompt_hash || "").slice(0, 8) || "local"}`;

  // 4. gameplay — run before assets (a deliberate swap of §4.5 steps 4/5):
  // gameplay reads only concept/world/characters, and resolveAssets accepts the
  // optional `gameplay` so it can emit an icon:<item_id> for every inventory
  // item. Running assets first would leave those icon refs unresolved.
  const gameplay = await time("gameplay", async () => {
    const generateGameplay = await stageModule("./gameplay/generate.mjs", "generateGameplay", "gameplay");
    const r = await generateGameplay({ concept, world, characters, env });
    stages.push(r.provenance);
    return patch("gameplay", r.gameplay, { concept, world, characters });
  });

  // 5. assets
  const assets = await time("assets", async () => {
    const resolveAssets = await stageModule("./assets/asset-pipeline.mjs", "resolveAssets", "assets");
    const r = await resolveAssets({ concept, world, characters, gameplay, gameId: id, cache, env, ...(createdAt ? { clock: () => createdAt } : {}) });
    for (const p of r.provenance || []) stages.push(p);
    return patch("assets", r, { concept, world, characters, gameplay });
  });

  // 6. scene
  const scene = await time("scene", async () => {
    const compileSceneGraph = await stageModule("./world/scene-graph.mjs", "compileSceneGraph", "scene");
    const t0 = performance.now();
    const s = compileSceneGraph(world, { assets: assets.records, characters });
    stages.push(localStage("scene", Math.round(performance.now() - t0), nowIso()));
    return patch("scene", s, { concept, world, characters, assets });
  });

  // 7. assemble. With a pinned createdAt the provenance carries no wall-clock
  // values, otherwise two builds of the same input differ in `at`/`latency_ms`.
  const provenance = stages.filter(Boolean).map((s) => (createdAt ? { ...s, at: createdAt, latency_ms: 0 } : s));
  const extras = typeof overrides.extras === "function" ? overrides.extras({ concept, world, characters, gameplay }) : null;
  const pkg = await time("assemble", async () => assemblePackage({
    gameId: id, version: 1, concept, world, scene, assets: assets.records, gameplay, characters, provenance, createdAt, extras,
  }));

  // 8. validate
  const validation = await time("validate", async () => validatePackage(pkg));

  // 9. playtest (+ static reachability)
  let reach = null, pt = null;
  if (playtest) {
    reach = await time("reachability", () => checkObjectiveReachability(pkg, { deps }));
    pt = await time("playtest", () => headlessPlaytest(pkg, { deps, ...(maxSimSeconds ? { maxSimSeconds } : {}) }));
  }
  timings.total = Math.round(Object.values(timings).reduce((a, b) => a + b, 0) * 100) / 100;
  const ok = validation.ok && (!playtest || (pt.won && reach.ok && (pt.save_reload.ok || pt.save_reload.skipped)));
  return { ok, pkg, validation, playtest: pt, reachability: reach, timings };
}

/** Write a package as compact JSON (terrain arrays make pretty-printing ~3× larger). */
export function writePackage(pkg, file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const text = JSON.stringify(pkg);
  fs.writeFileSync(file, text);
  return { file, bytes: Buffer.byteLength(text), sha256: pkg.integrity?.sha256 ?? null };
}

/** Read a package back and check it is one. */
export function readPackage(file) {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (pkg?.package_version !== "1.0.0") throw new Error(`${file} is not a Games-B package`);
  return pkg;
}
