#!/usr/bin/env node
// GAMES-C QA — run the gate runner on an offline-assembled world (or a manifest file)
// and print the JSON report. Offline: forces DCS_PROVIDERS_OFFLINE=1.
//   node src/v3/gamesc/qa/cli.mjs [--manifest path.json] [--prompt "..."] [--out report.json]
import fs from "node:fs";
import { runGates } from "./gates.mjs";
import { createAssemblyRouter } from "../../router/assembly.mjs";

process.env.DCS_PROVIDERS_OFFLINE = "1";
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
let manifest;
if (arg("--manifest")) manifest = JSON.parse(fs.readFileSync(arg("--manifest"), "utf8"));
else manifest = (await createAssemblyRouter({ DCS_PROVIDERS_OFFLINE: "1" }).assemble({ prompt: arg("--prompt") || "Ashfall Harbour, a rainy nordic port town", worldId: "w_qa_cli", creatorId: "qa" })).manifest;
const report = await runGates(manifest);
const text = JSON.stringify(report, null, 2);
if (arg("--out")) fs.writeFileSync(arg("--out"), text + "\n");
console.log(text);
process.exitCode = report.overall === "FAIL" ? 1 : 0;
