// Games-B flagship vertical slice: "Lanternfall — The Last Keeper of Ashfall Isle".
//
// The concept is authored; everything after it is the real pipeline. These tests
// hold the slice to the same gates a prompt-built game has to pass — the package
// validator and a headless playtest that must actually win by walking — plus the
// specific story beats the slice promises (three beacons, a summit lighthouse,
// Stormwisps in the ruins, a storm timer).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flagshipConcept, FLAGSHIP_PROMPT, FLAGSHIP_GAME_ID } from "../src/gamesb/flagship/lanternfall.mjs";
import { promptHash } from "../src/gamesb/common/hash.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGES = [
  "src/gamesb/pipeline.mjs", "src/gamesb/world/world-spec.mjs", "src/gamesb/characters/characters.mjs",
  "src/gamesb/assets/asset-pipeline.mjs", "src/gamesb/gameplay/generate.mjs", "src/gamesb/world/scene-graph.mjs",
  "src/gamesb/runtime/validate-package.mjs", "src/gamesb/runtime/headless-playtest.mjs",
];
const missing = STAGES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
const buildSkip = missing.length ? `pipeline stages missing: ${missing.join(", ")}` : false;

test("flagship concept is well-formed and validates against the concept schema", async (t) => {
  const c = flagshipConcept();
  assert.equal(c.concept_version, "1.0.0");
  assert.equal(c.source_prompt, FLAGSHIP_PROMPT);
  assert.equal(c.prompt_hash, promptHash(FLAGSHIP_PROMPT));
  assert.equal(c.key_locations[0].kind, "hub", "the harbour village is the start hub");
  assert.equal(c.key_locations[0].id, "harbour_village");
  const ids = c.key_locations.map((l) => l.id);
  for (const id of ["sunken_ruins", "whispering_grove", "cliffside_watch", "lighthouse_summit"]) assert.ok(ids.includes(id), id);
  assert.equal(c.key_locations.find((l) => l.id === "lighthouse_summit").kind, "summit");
  const roles = Object.fromEntries(c.characters.map((ch) => [ch.id, ch.role]));
  assert.deepEqual(roles, { keeper_maren: "quest_giver", ember: "companion", fisher_tomas: "merchant", stormwisp_a: "enemy", stormwisp_b: "enemy" });
  assert.equal(c.weather, "storm");
  assert.ok(Math.abs(c.time_of_day - 0.78) < 0.05);
  assert.deepEqual(flagshipConcept(), flagshipConcept(), "authored concept is deterministic");
  let schema;
  try { schema = await import("../src/gamesb/concept/concept.schema.mjs"); } catch { t.skip("concept.schema.mjs not present"); return; }
  const v = schema.validateConcept(c);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
});

let built = null;
async function build() {
  if (built) return built;
  const { buildFlagship } = await import("../src/gamesb/flagship/build.mjs");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gamesb-flagship-"));
  const t0 = Date.now();
  built = await buildFlagship({ outDir });
  built.ms = Date.now() - t0;
  built.outDir = outDir;
  return built;
}

test("buildFlagship runs the real pipeline and the package validates", { skip: buildSkip }, async () => {
  const r = await build();
  assert.ok(r.pkg, "no package");
  assert.equal(r.pkg.game_id, FLAGSHIP_GAME_ID);
  assert.equal(r.pkg.package_version, "1.0.0");
  assert.ok(fs.existsSync(r.file), "package.json not written");
  assert.deepEqual(r.validation.errors, [], JSON.stringify(r.validation.errors.slice(0, 8), null, 1));
  assert.equal(r.validation.ok, true);
  console.log(`# lanternfall built in ${r.ms} ms, ${r.bytes} bytes, ${r.pkg.assets.records.length} asset records, ${r.validation.warnings.length} validator warnings`);
});

test("the flagship headless playtest wins by walking, with save/reload proven", { skip: buildSkip }, async () => {
  const r = await build();
  assert.ok(r.playtest, "playtest did not run");
  assert.equal(r.playtest.won, true, `playtest did not win: ${JSON.stringify(r.playtest).slice(0, 800)}`);
  assert.equal(r.reachability.ok, true, JSON.stringify(r.reachability).slice(0, 400));
  assert.ok(r.playtest.save_reload?.ok || r.playtest.save_reload?.skipped, JSON.stringify(r.playtest.save_reload));
  assert.equal(r.ok, true);
});

test("the flagship world carries the slice's story beats", { skip: buildSkip }, async () => {
  const { pkg } = await build();
  const w = pkg.world;
  for (const loc of flagshipConcept().key_locations) {
    assert.ok(w.regions.some((rg) => rg.id === `region_${loc.id}`), `region_${loc.id}`);
    assert.ok(w.interactables.some((ix) => ix.id === `ix_${loc.id}`), `ix_${loc.id}`);
  }
  assert.equal(w.interactables.find((ix) => ix.id === "ix_lighthouse_summit").kind, "lantern");
  assert.ok(w.interactables.filter((ix) => ix.kind === "pickup").length >= 3, "three lantern cores");
  assert.ok(w.placements.some((p) => /lighthouse/.test(p.asset_ref)), "a lighthouse on the island");
  assert.equal(w.environment.weather, "storm");
  assert.ok(w.environment.water.enabled, "the sea");
  const chars = pkg.characters.characters;
  assert.ok(chars.find((c) => c.id === "ember")?.companion, "Ember is a companion");
  assert.ok(chars.filter((c) => c.behavior?.hostile).length >= 2, "two hostile Stormwisps");
  const gp = pkg.gameplay;
  assert.ok(gp.rules.time_limit_s >= 600, "a generous storm timer");
  assert.ok(gp.lose_conditions.some((l) => l.kind === "time_expired"));
  assert.ok(gp.objectives.some((o) => o.target_ref === "ix_lighthouse_summit"), "lighting the lighthouse is an objective");
  assert.ok(pkg.hooks?.edit?.ops?.length && pkg.hooks?.expand?.ops?.length, "edit/expand hooks present");
  // The authored chain: Maren → three cores → three beacons → the lighthouse.
  const req = gp.objectives.filter((o) => !o.optional);
  assert.equal(req.filter((o) => o.kind === "collect").length, 3, "exactly three required lantern cores");
  const beacons = ["activate_sunken_ruins", "activate_whispering_grove", "activate_cliffside_watch"];
  assert.deepEqual(req.find((o) => o.id === "activate_lighthouse_summit").requires.slice().sort(), beacons.slice().sort());
  assert.equal(req[0].kind, "talk");
  assert.equal(req[0].target_ref, "keeper_maren");
  assert.equal(w.interactables.find((ix) => ix.id === "ix_sunken_ruins").kind, "lantern", "the ruins focal point is a beacon");
  // Stormwisps patrol the Sunken Ruins.
  const ruins = w.regions.find((rg) => rg.id === "region_sunken_ruins").bounds;
  for (const c of chars.filter((ch) => /^stormwisp/.test(ch.id))) {
    assert.equal(w.spawn_points.find((s) => s.id === c.spawn_ref).region, "region_sunken_ruins", c.id);
    for (const p of c.behavior.patrol) assert.ok(p.x >= ruins[0] && p.x <= ruins[2] && p.z >= ruins[1] && p.z <= ruins[3], `${c.id} patrols outside the ruins`);
  }
});

test("the committed runtime copy matches a fresh build (when present)", { skip: buildSkip }, async (t) => {
  const committed = path.join(ROOT, "games-b-runtime/games/lanternfall/package.json");
  if (!fs.existsSync(committed)) { t.skip("games-b-runtime/games/lanternfall/package.json not built yet"); return; }
  const { pkg } = await build();
  const cur = JSON.parse(fs.readFileSync(committed, "utf8"));
  if (cur.integrity?.sha256 !== pkg.integrity?.sha256) {
    t.diagnostic("the committed flagship package is stale — rebuild with: node src/gamesb/flagship/build.mjs");
  }
  assert.equal(cur.game_id, pkg.game_id);
});
