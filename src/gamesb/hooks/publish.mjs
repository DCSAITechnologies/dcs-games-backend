// Games-B publish hook. Node-side.
//
// Produces a self-contained static folder that plays with no server logic:
//
//   <outDir>/
//     index.html                         → redirects to the player
//     package.json                       the GamePackage (the game)
//     games-b-runtime/…                  renderer files, copied verbatim
//     src/gamesb/…                       the ISOMORPHIC modules the renderer
//                                        imports, at the SAME relative paths, so
//                                        play.html's `../src/gamesb/...` imports
//                                        resolve unchanged
//     textures/…                         baked PNGs, when assets/bake.mjs exists
//     PUBLISH_MANIFEST.json              every file with sha256 + bytes, the
//                                        package sha and the gates it passed
//
// Publishing is gated: validatePackage must be ok AND the headless playtest
// must win. A package that cannot be finished by walking is never published,
// however good it looks.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../common/hash.mjs";
import { validatePackage } from "../runtime/validate-package.mjs";
import { headlessPlaytest } from "../runtime/headless-playtest.mjs";
import { computeIntegrity } from "../runtime/assemble.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
export const DEFAULT_RUNTIME_DIR = path.join(REPO, "games-b-runtime");

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

export class PublishRefused extends Error {
  constructor(reason, gates) { super(reason); this.name = "PublishRefused"; this.gates = gates; }
}

/** Relative-import closure of a set of .mjs entry files (repo-relative paths). */
export function importClosure(entries) {
  const seen = new Set();
  const walk = (abs) => {
    const rel = path.relative(REPO, abs);
    if (seen.has(rel) || !fs.existsSync(abs)) return;
    seen.add(rel);
    const src = fs.readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] || m[2] || m[3];
      if (!spec || !spec.startsWith(".")) continue;
      walk(path.resolve(path.dirname(abs), spec));
    }
  };
  for (const e of entries) walk(path.resolve(REPO, e));
  return [...seen].sort();
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p) : [p];
  }).sort();
}

function writeFile(outDir, rel, data, files) {
  const abs = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  files.push({ path: rel.split(path.sep).join("/"), bytes: buf.length, sha256: sha256(buf) });
}

/**
 * @param {object} pkg sealed GamePackage
 * @param {{outDir: string, runtimeDir?: string, deps?: object, playtest?: object, validation?: object, now?: string}} opts
 *   `playtest`/`validation` may be passed in when the caller already ran them on this exact package.
 * @returns {Promise<{outDir, manifest}>}
 * @throws {PublishRefused}
 */
export async function publishPackage(pkg, { outDir, runtimeDir = DEFAULT_RUNTIME_DIR, deps, playtest, validation, now } = {}) {
  if (!outDir) throw new Error("publishPackage: outDir is required");
  const validationRes = validation && validation.package_sha256 === pkg.integrity?.sha256 ? validation : validatePackage(pkg);
  const gates = { validate: { ok: validationRes.ok, errors: validationRes.errors.length, warnings: validationRes.warnings.length, checks: validationRes.checks } };
  if (!validationRes.ok) throw new PublishRefused(`validation failed: ${validationRes.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")}`, gates);
  const pt = playtest && playtest.package_sha256 === pkg.integrity?.sha256 ? playtest : await headlessPlaytest(pkg, { deps });
  gates.playtest = { won: pt.won, status: pt.status, sim_seconds: pt.sim_seconds, steps: pt.steps, save_reload_ok: !!pt.save_reload?.ok, stuck_recoveries: pt.stuck_recoveries };
  if (!pt.won) throw new PublishRefused(`headless playtest did not win (${pt.reason || pt.status})`, gates);
  if (!pt.save_reload?.ok && !pt.save_reload?.skipped) throw new PublishRefused("save/reload verification failed", gates);
  if (computeIntegrity(pkg) !== pkg.integrity?.sha256) throw new PublishRefused("integrity hash mismatch", gates);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];

  // Game data.
  writeFile(outDir, "package.json", JSON.stringify(pkg), files);

  // Renderer files, verbatim, under games-b-runtime/.
  // Not tools/ (a QA gallery) and not games/ (other built packages): a
  // published bundle carries its own package.json and nothing else's.
  const runtimeFiles = listFiles(runtimeDir).filter((f) => !/^(tools|games)[\\/]/.test(path.relative(runtimeDir, f)));
  const runtimeRelBase = path.relative(REPO, runtimeDir).startsWith("..") ? null : path.relative(REPO, runtimeDir);
  for (const f of runtimeFiles) {
    const rel = path.join("games-b-runtime", path.relative(runtimeDir, f));
    writeFile(outDir, rel, fs.readFileSync(f), files);
  }

  // ISO modules: everything the renderer (and sim-core + deps) import, at the
  // same repo-relative paths. The renderer's own files are already copied.
  const entries = [
    "src/gamesb/runtime/sim-core.mjs", "src/gamesb/runtime/deps.mjs",
    ...(runtimeRelBase ? runtimeFiles.filter((f) => f.endsWith(".mjs")).map((f) => path.relative(REPO, f)) : []),
  ];
  const html = runtimeFiles.filter((f) => f.endsWith(".html"));
  for (const h of html) {
    // Modules loaded straight from <script type="module"> tags too.
    const src = fs.readFileSync(h, "utf8");
    for (const m of src.matchAll(/(?:import\s[^;]*?from\s+|import\(\s*|src=)["']([^"']+\.mjs)["']/g)) {
      const abs = path.resolve(path.dirname(h), m[1]);
      if (abs.startsWith(REPO)) entries.push(path.relative(REPO, abs));
    }
  }
  for (const rel of importClosure(entries)) {
    if (runtimeRelBase && rel.startsWith(runtimeRelBase + path.sep)) continue;
    writeFile(outDir, rel, fs.readFileSync(path.join(REPO, rel)), files);
  }

  // Baked textures/SVGs, when the asset stage provides a baker. The package
  // itself is shipped unmodified (its sha must match the gates); the baked
  // files sit beside it and the manifest maps asset_id → uri, so a renderer may
  // load a PNG instead of synthesising the recipe.
  let baked = { status: "unavailable", count: 0, map: {} };
  let bakeMod = null;
  try { bakeMod = await import("../assets/bake.mjs"); } catch { bakeMod = null; }
  if (typeof bakeMod?.bake === "function") {
    try {
      const res = await bakeMod.bake({ records: pkg.assets.records, outDir });
      for (const f of res.files || []) {
        files.push({ path: f.uri.split(path.sep).join("/"), bytes: f.bytes, sha256: f.sha256 });
        baked.map[f.asset_id] = f.uri;
      }
      baked = { status: "baked", count: (res.files || []).length, map: baked.map };
    } catch (e) {
      baked = { status: `failed: ${e.message}`, count: 0, map: {} };
    }
  }

  const playPath = runtimeFiles.some((f) => path.basename(f) === "play.html") ? "games-b-runtime/play.html" : null;
  if (playPath) {
    writeFile(outDir, "index.html", `<!doctype html><meta charset="utf-8"><title>${escapeHtml(pkg.title)}</title>` +
      `<meta http-equiv="refresh" content="0;url=${playPath}?pkg=../package.json"><a href="${playPath}?pkg=../package.json">Play ${escapeHtml(pkg.title)}</a>\n`, files);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = {
    publish_version: "1.0.0",
    game_id: pkg.game_id, version: pkg.version, title: pkg.title,
    package_sha256: pkg.integrity.sha256,
    entry: playPath ? `${playPath}?pkg=../package.json` : null,
    published_at: now || new Date().toISOString(),
    gates,
    baked,
    files,
    totals: { files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0) },
  };
  fs.writeFileSync(path.join(outDir, "PUBLISH_MANIFEST.json"), JSON.stringify(manifest, null, 2));
  return { outDir, manifest };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
