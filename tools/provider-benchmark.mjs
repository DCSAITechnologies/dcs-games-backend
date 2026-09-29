#!/usr/bin/env node
// GAMES-A provider benchmark. Kept out of `npm test`: live mode costs money.
//
//   node tools/provider-benchmark.mjs                       # plan only: no network, no spend
//   DCS_BENCH_CONFIRM=1 node tools/provider-benchmark.mjs --live [--max-usd 5] [--calls 1]
//        [--tasks WORLD_DESIGN,TEXTURE] [--providers google,cerebras] [--out results.csv]
//
// Credentials are read from the environment the command runs in, by NAME only.
// Nothing here prints a value: configuration is reported as yes/no.
import fs from "node:fs";
import { createAdapters } from "../src/v3/engine/index.mjs";
import { planBenchmark, runBenchmark } from "../src/v3/engine/benchmark.mjs";
import { redact } from "../src/v3/engine/redact.mjs";

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const live = process.argv.includes("--live");
if (live && process.env.DCS_BENCH_CONFIRM !== "1") {
  console.error("refusing: --live needs DCS_BENCH_CONFIRM=1 in the environment (real API calls cost money)");
  process.exit(2);
}
const env = { ...process.env, DCS_PROVIDERS_ONLINE: "1" };
delete env.DCS_PROVIDERS_OFFLINE;
if (env.NODE_ENV === "test") delete env.NODE_ENV;

const adapters = createAdapters();
const plan = planBenchmark({
  adapters, env, calls: arg("calls", 1),
  tasks: arg("tasks") ? arg("tasks").split(",") : undefined,
  providers: arg("providers") ? arg("providers").split(",") : null,
});
const maxUsd = Math.min(Number(arg("max-usd", 5)) || 5, 25);
const planned = plan.reduce((s, p) => s + p.est_usd_per_call * p.calls, 0);
console.log(`GAMES-A benchmark — ${live ? "LIVE" : "PLAN ONLY (no calls)"} · ${plan.length} provider/task pairs · planned ≤ $${planned.toFixed(2)} · cap $${maxUsd}`);
for (const p of plan) console.log(`  ${p.task.padEnd(16)} ${`${p.provider}:${p.model}`.padEnd(46)} configured=${p.configured.padEnd(3)} ~$${p.est_usd_per_call}`);

const rows = await runBenchmark({
  adapters, env, plan, live, maxUsd,
  logger: { log() {}, warn() {}, error() {} },
  onRow: (r) => console.log(`  → ${r.task} ${r.provider}:${r.model} #${r.call} ${r.success} ${r.latency_ms}ms ${r.quality} $${r.cost_usd} ${r.failure}`),
});

const HEAD = ["PROVIDER", "MODEL", "TASK", "LATENCY_MS", "QUALITY", "COST_ESTIMATE_USD", "SUCCESS", "RECOMMENDED_ROLE", "FAILURE_CLASS", "NOTES", "RUN_AT"];
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const at = new Date().toISOString();
const csv = [HEAD.join(","), ...rows.map((r) => [r.provider, r.model, r.task, r.latency_ms, r.quality, r.cost_usd !== "" ? r.cost_usd : r.est_usd_per_call, r.success, "", r.failure, redact(r.notes, env), live ? at : ""].map(q).join(","))].join("\n") + "\n";
const out = arg("out");
if (out) { fs.writeFileSync(out, csv); console.log(`wrote ${out}`); } else process.stdout.write("\n" + csv);
