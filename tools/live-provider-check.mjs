#!/usr/bin/env node
// Exercise the REAL provider lanes. Kept out of `npm test` on purpose: it costs
// money and needs network, so CI runs the offline suite and this is run by hand
// when provider behaviour needs re-checking.
//
//   node tools/live-provider-check.mjs                 # status only, free
//   node tools/live-provider-check.mjs --assemble      # one full live assembly
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";

const env = { ...process.env, DCS_PROVIDERS_ONLINE: "1" };
delete env.DCS_PROVIDERS_OFFLINE;

const router = createAssemblyRouter(env);
const d = await router.describe();

console.log("DCS Games — provider lanes\n");
let usableVendors = 0;
for (const lane of d.lanes) {
  const live = lane.adapters.filter((a) => a.status === "AVAILABLE");
  usableVendors += live.length;
  console.log(`  ${lane.lane.padEnd(16)} ${live.length} vendor(s) available`);
  for (const a of lane.adapters) console.log(`      ${a.status.padEnd(12)} ${a.name}${a.is_fallback ? "  (fallback)" : ""}`);
}
console.log(`\n${usableVendors} vendor adapter(s) reachable. Every lane also has a deterministic fallback.`);

if (!process.argv.includes("--assemble")) {
  console.log("\n(pass --assemble to run one real generation)");
  process.exit(0);
}

const prompt = process.argv[process.argv.indexOf("--assemble") + 1] || "Ashfall Harbour, a rainy nordic port town where the tide has stopped";
console.log(`\nassembling: "${prompt}"`);
const t0 = Date.now();
const out = await router.assemble({ prompt, worldId: "w_live_check", creatorId: "live-check" });
console.log(`\nelapsed ${((Date.now() - t0) / 1000).toFixed(1)}s · valid=${out.validation.ok} errors=${out.validation.errors.length}`);
const m = out.manifest;
console.log(`title    ${m.meta.title}`);
console.log(`counts   zones=${m.zones.length} structures=${m.structures.length} npcs=${m.npcs.length} items=${m.items.length} quests=${m.quests.length} behaviors=${m.behaviors.length} interactions=${m.interactions.length}`);
console.log(`kinds    ${[...new Set(m.behaviors.map((b) => b.kind))].join(", ")}`);
console.log("\nprovenance:");
for (const p of out.provenance) console.log(`  ${p.lane.padEnd(16)} ${String(p.provider).padEnd(38)} ${p.status.padEnd(10)} ${p.latency_ms}ms`);
if (out.degraded.length) {
  console.log("\ndegraded (recorded, not hidden):");
  for (const x of out.degraded) console.log(`  ${x.lane}: ${x.provider} — ${x.reason}`);
}
if (!out.validation.ok) { console.log(JSON.stringify(out.validation.errors, null, 2)); process.exit(1); }
