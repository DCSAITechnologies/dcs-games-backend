// Every test file must be run by something.
//
// Sixteen suites written in one session were in no npm script at all — so CI
// never ran them, and every proof they carried was worthless in the pipeline
// that is supposed to enforce it. A test nobody runs is indistinguishable from
// a test that does not exist, except that it looks like coverage.
//
// This is the same shape as the CI job pinned to a commit that exists on no ref
// and the route inventory that had drifted from the router: a gate that cannot
// fire, sitting where someone expects one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CI GATE: every test file is referenced by an npm script", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(GB, "package.json"), "utf8"));
  const scripts = Object.values(pkg.scripts || {}).join(" ");
  const suites = fs.readdirSync(path.join(GB, "test")).filter((f) => f.endsWith(".test.mjs"));

  assert.ok(suites.length > 20, `expected to find the suites, found ${suites.length}`);

  const orphans = suites.filter((f) => !scripts.includes(f) && !scripts.includes("test/*.test.mjs"));
  assert.deepEqual(orphans.sort(), [],
    "these suites are run by no npm script, so CI never executes them:\n  " + orphans.sort().join("\n  ") +
    "\nAdd them to test:unit (plain node) or test:unit:tsx (needs the TypeScript loader).");
});

test("CI GATE: every script's named suites actually exist", () => {
  // The opposite drift: a script naming a file that has been renamed or deleted
  // fails the whole job for a reason that has nothing to do with the code.
  const pkg = JSON.parse(fs.readFileSync(path.join(GB, "package.json"), "utf8"));
  const named = new Set();
  for (const v of Object.values(pkg.scripts || {})) {
    for (const m of String(v).matchAll(/test\/[A-Za-z0-9._-]+\.test\.mjs/g)) named.add(m[0]);
  }
  const missing = [...named].filter((f) => !fs.existsSync(path.join(GB, f)));
  assert.deepEqual(missing.sort(), [], `these scripts name files that do not exist: ${missing.join(", ")}`);
});
