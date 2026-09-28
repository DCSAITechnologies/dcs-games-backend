#!/usr/bin/env node
// Games-B CLI: prompt → package (→ published static folder).
//
//   node scripts/gamesb-build.mjs --prompt "a storm-lashed lighthouse island" --out out/lighthouse [--seed 42] [--publish] [--offline]
//
// Writes <out>/game.package.json and <out>/BUILD_REPORT.json; with --publish
// also writes the playable static folder to <out>/site. Exits non-zero when a
// gate fails, so it can sit in CI. Never prints environment values.

import path from "node:path";
import fs from "node:fs";
import { buildGame, writePackage } from "../src/gamesb/pipeline.mjs";

function parseArgs(argv) {
  const a = { publish: false, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--prompt") a.prompt = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--seed") a.seed = Number.parseInt(argv[++i], 10);
    else if (k === "--game-id") a.gameId = argv[++i];
    else if (k === "--publish") a.publish = true;
    else if (k === "--offline") a.offline = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`unknown argument '${k}'`);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.prompt || !args.out) {
  console.log('usage: node scripts/gamesb-build.mjs --prompt "..." --out <dir> [--seed n] [--game-id id] [--publish] [--offline]');
  process.exit(args.help ? 0 : 2);
}

const env = args.offline ? { ...process.env, DCS_PROVIDERS_OFFLINE: "1" } : process.env;
const res = await buildGame(args.prompt, { seed: Number.isInteger(args.seed) ? args.seed : undefined, env, gameId: args.gameId });
fs.mkdirSync(args.out, { recursive: true });
const written = writePackage(res.pkg, path.join(args.out, "game.package.json"));

const report = {
  game_id: res.pkg.game_id, title: res.pkg.title, version: res.pkg.version, package_sha256: res.pkg.integrity.sha256, bytes: written.bytes,
  ok: res.ok,
  validation: { ok: res.validation.ok, errors: res.validation.errors, warnings: res.validation.warnings.length, budgets: res.validation.budgets, skipped: res.validation.skipped },
  reachability: res.reachability,
  playtest: res.playtest && { ...res.playtest, timeline: res.playtest.timeline.slice(0, 80) },
  timings: res.timings,
  provenance: res.pkg.provenance.stages.map((s) => ({ stage: s.stage, provider: s.provider, model: s.model, status: s.status, latency_ms: s.latency_ms, cost_usd: s.cost_usd })),
};

if (args.publish) {
  const { publishPackage, PublishRefused } = await import("../src/gamesb/hooks/publish.mjs");
  try {
    const pub = await publishPackage(res.pkg, { outDir: path.join(args.out, "site"), validation: res.validation, playtest: res.playtest });
    report.publish = { ok: true, dir: pub.outDir, files: pub.manifest.totals.files, bytes: pub.manifest.totals.bytes, entry: pub.manifest.entry };
  } catch (e) {
    report.publish = { ok: false, reason: e.message, gates: e instanceof PublishRefused ? e.gates : undefined };
  }
}
fs.writeFileSync(path.join(args.out, "BUILD_REPORT.json"), JSON.stringify(report, null, 2));

const pt = res.playtest;
console.log(`${res.pkg.title} [${res.pkg.game_id} v${res.pkg.version}] sha256 ${res.pkg.integrity.sha256.slice(0, 12)}…`);
console.log(`  validate: ${res.validation.ok ? "ok" : `FAIL (${res.validation.errors.length} errors)`}; budgets tri=${res.validation.budgets?.triangles} draws=${res.validation.budgets?.draw_calls} tex=${res.validation.budgets?.texture_mb}MB`);
if (pt) console.log(`  playtest: ${pt.won ? "WON" : `NOT WON (${pt.reason || pt.status})`} in ${pt.sim_seconds}s sim, ${pt.steps} steps, save/reload ${pt.save_reload.ok ? "ok" : "FAIL"}`);
if (report.publish) console.log(`  publish: ${report.publish.ok ? `${report.publish.files} files → ${report.publish.dir}` : `REFUSED (${report.publish.reason})`}`);
console.log(`  total ${res.timings.total} ms; report ${path.join(args.out, "BUILD_REPORT.json")}`);
process.exit(res.ok && (!report.publish || report.publish.ok) ? 0 : 1);
