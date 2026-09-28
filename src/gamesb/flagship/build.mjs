// Build the flagship package with the real pipeline and write it where the
// browser runtime looks by default (games-b-runtime/games/lanternfall/).
//
//   node src/gamesb/flagship/build.mjs [--out <dir>]
//
// Offline and deterministic: providers are forced to the local path and the
// timestamp is fixed, so two builds of the same tree produce the same bytes.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { flagshipConcept, flagshipWorldPatch, flagshipCharactersPatch, flagshipGameplayPatch, FLAGSHIP_PROMPT, FLAGSHIP_GAME_ID, FLAGSHIP_SEED } from "./lanternfall.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEFAULT_OUT_DIR = path.join(ROOT, "games-b-runtime", "games", FLAGSHIP_GAME_ID);
export const FLAGSHIP_CREATED_AT = "2026-09-28T00:00:00.000Z";

/**
 * @param {{ outDir?: string, write?: boolean, env?: object }} [opts]
 * @returns {Promise<{ ok, pkg, validation, playtest, reachability, timings, file? }>}
 */
export async function buildFlagship({ outDir = DEFAULT_OUT_DIR, write = true, env = { DCS_PROVIDERS_OFFLINE: "1" } } = {}) {
  let pipeline;
  try { pipeline = await import("../pipeline.mjs"); } catch (e) {
    throw new Error(`buildFlagship: src/gamesb/pipeline.mjs is unavailable (${e.message})`);
  }
  const [terrain, nav, collision] = await Promise.all([
    import("../world/terrain-sample.mjs"), import("../world/nav-grid.mjs"), import("../world/collision.mjs"),
  ]);
  const world = (w) => flagshipWorldPatch(w, {
    sampleHeight: terrain.sampleHeight, isWalkable: nav.isWalkable,
    pointInCollider: collision.pointInCollider, colliders: collision.buildColliders(w),
  });
  const res = await pipeline.buildGame(FLAGSHIP_PROMPT, {
    overrides: { concept: flagshipConcept(), world, characters: (c) => flagshipCharactersPatch(c), gameplay: (g) => flagshipGameplayPatch(g) },
    gameId: FLAGSHIP_GAME_ID,
    seed: FLAGSHIP_SEED,
    env,
    createdAt: FLAGSHIP_CREATED_AT,
  });
  if (write && res.pkg) {
    const w = pipeline.writePackage(res.pkg, path.join(outDir, "package.json"));
    res.file = w.file;
    res.bytes = w.bytes;
  }
  return res;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const i = process.argv.indexOf("--out");
  const outDir = i > 0 ? path.resolve(process.argv[i + 1]) : DEFAULT_OUT_DIR;
  const t0 = Date.now();
  buildFlagship({ outDir }).then((r) => {
    const v = r.validation || {};
    const p = r.playtest || {};
    console.log(`lanternfall: ${r.ok ? "OK" : "NOT OK"} in ${Date.now() - t0} ms → ${r.file ?? "(not written)"} (${r.bytes ?? 0} bytes)`);
    console.log(`  validation: ${v.ok ? "ok" : "FAILED"} (${(v.errors || []).length} errors, ${(v.warnings || []).length} warnings)`);
    for (const e of (v.errors || []).slice(0, 10)) console.log(`    ✗ ${e.path}: ${e.message}`);
    console.log(`  playtest: ${p.won ? "won" : "not won"}${p.sim_seconds ? ` in ${p.sim_seconds}s sim` : ""}; reachability ${r.reachability?.ok ? "ok" : "FAILED"}`);
    process.exitCode = r.ok ? 0 : 1;
  }).catch((e) => { console.error(e.message); process.exitCode = 2; });
}
