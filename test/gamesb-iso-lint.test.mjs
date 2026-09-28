// Games-B: the isomorphic modules load straight into the browser runtime, so
// they must not reach for anything Node-only. This walks each one's import
// graph and fails on a node: import, a bare package specifier, a path into
// src/v3, or a use of process / Buffer / require.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ISO = [
  "src/gamesb/common/rng.mjs",
  "src/gamesb/common/issues.mjs",
  "src/gamesb/world/terrain-sample.mjs",
  "src/gamesb/world/nav-grid.mjs",
  "src/gamesb/world/collision.mjs",
  "src/gamesb/assets/texture-synth.mjs",
  "src/gamesb/assets/mesh-recipes.mjs",
  "src/gamesb/gameplay/rules-engine.mjs",
  "src/gamesb/gameplay/solver.mjs",
  "src/gamesb/concept/concept.schema.mjs",
  "src/gamesb/characters/npc-brain.mjs",
  "src/gamesb/characters/dialogue.mjs",
  "src/gamesb/runtime/sim-core.mjs",
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function lint(rel, seen, problems) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { problems.push(`${rel}: missing`); return; }
  const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (!spec.startsWith(".")) { problems.push(`${rel}: imports '${spec}' (only relative iso imports allowed)`); continue; }
    if (!spec.endsWith(".mjs")) problems.push(`${rel}: import '${spec}' lacks the .mjs extension a browser needs`);
    const target = path.relative(ROOT, path.resolve(path.dirname(file), spec));
    if (target.startsWith("src/v3")) problems.push(`${rel}: imports ${target} (src/v3 is Node-side)`);
    else lint(target, seen, problems);
  }
  for (const [re, what] of [[/\bprocess\./, "process"], [/\bBuffer\b/, "Buffer"], [/\brequire\(/, "require"], [/\bMath\.random\(/, "Math.random (non-deterministic)"]]) {
    if (re.test(src)) problems.push(`${rel}: uses ${what}`);
  }
}

test("isomorphic Games-B modules import only other browser-safe modules", () => {
  const problems = [];
  const seen = new Set();
  for (const f of ISO) lint(f, seen, problems);
  // Every *.schema.mjs is isomorphic too.
  const walk = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  for (const f of walk(path.join(ROOT, "src/gamesb")).filter((f) => f.endsWith(".schema.mjs"))) lint(path.relative(ROOT, f), seen, problems);
  assert.deepEqual(problems, []);
});
