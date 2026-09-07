// The test harness must not outlive the test.
//
// One long session leaked 196 Chrome processes and 8.2 GB, and orphaned a test
// server that held port 8429 — inside the range two suites pick from — for six
// hours. A suite booting there finds /health already answering, from a server
// with a different secret and a different data directory, and proceeds against
// the wrong one. The result looks exactly like a real one.
//
// Two causes, both closed here:
//   - scripts/preview-integration-proof.mjs called browser.kill(), which did not
//     exist. The throw was swallowed by its own `catch {}` and Chrome survived
//     every run.
//   - spawn() children outlive their parent, so a suite that times out or is
//     killed leaves Chrome behind with nothing to reap it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchChrome, reapStaleChrome } from "./helpers/browser.mjs";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const harnessChromePids = () => {
  let out = "";
  try { out = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", maxBuffer: 1 << 24 }); } catch { return []; }
  return out.split("\n")
    .filter((l) => l.includes("dcs-chrome-") && l.includes("--user-data-dir="))
    .map((l) => Number(/^\s*(\d+)/.exec(l)?.[1]))
    .filter(Boolean);
};

test("HARNESS GATE: close() actually leaves nothing running", async () => {
  const before = new Set(harnessChromePids());
  const b = await launchChrome({ headless: true });
  assert.ok(harnessChromePids().some((p) => !before.has(p)), "a browser really did start");

  await b.close();
  await new Promise((r) => setTimeout(r, 800));
  const after = harnessChromePids().filter((p) => !before.has(p));
  assert.deepEqual(after, [], `close() left ${after.length} process(es) running: ${after.join(", ")}`);
});

test("HARNESS GATE: kill() is an alias, not a silent no-op", async () => {
  // The exact defect: a caller reaching for the wrong name inside a bare catch
  // gets silence, and silence here costs gigabytes.
  const before = new Set(harnessChromePids());
  const b = await launchChrome({ headless: true });
  assert.equal(typeof b.kill, "function", "a caller using kill() must not be silently ignored");

  await b.kill();
  await new Promise((r) => setTimeout(r, 800));
  assert.deepEqual(harnessChromePids().filter((p) => !before.has(p)), [], "kill() must reap like close()");
});

test("HARNESS GATE: no committed caller reaches for a method the harness lacks", () => {
  // The static half. A method that does not exist fails silently inside the
  // `try { } catch {}` these call sites all use, so it cannot be caught at
  // runtime by the code that leaks.
  const surface = new Set(["close", "kill", "proc", "wsUrl"]);
  const roots = [path.join(GB, "scripts"), path.join(GB, "test")];
  const offenders = [];
  for (const root of roots) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.mjs$/.test(e.name)) continue;
        const src = fs.readFileSync(p, "utf8");
        if (!src.includes("launchChrome")) continue;
        for (const m of src.matchAll(/\bbrowser\.([a-zA-Z_]+)\s*\(/g)) {
          if (!surface.has(m[1])) offenders.push(`${path.relative(GB, p)} calls browser.${m[1]}()`);
        }
      }
    };
    if (fs.existsSync(root)) walk(root);
  }
  assert.deepEqual(offenders, [],
    "these call a method the harness does not expose, which fails silently:\n  " + offenders.join("\n  "));
});

test("HARNESS: the stale reaper leaves a live browser alone", async () => {
  // It must only take processes older than its threshold, or a parallel run
  // would kill the browser another suite is using.
  const b = await launchChrome({ headless: true });
  try {
    // Asserted on the process the harness OWNS, not on the full pid set:
    // Chrome starts and stops renderer and GPU helpers of its own accord, so
    // comparing sets would fail for reasons that have nothing to do with the
    // reaper.
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.ok(alive(b.proc.pid), "the browser is running before the reaper");

    reapStaleChrome({ olderThanMs: 120000 });
    await new Promise((r) => setTimeout(r, 400));

    assert.ok(alive(b.proc.pid),
      "a browser that has just started must survive the reaper — otherwise a parallel suite kills the one another is using");
  } finally { await b.close(); }
});
