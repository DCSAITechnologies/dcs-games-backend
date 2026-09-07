#!/usr/bin/env node
// COLD REBUILD PROOF.
//
// Answers one question: can this estate be rebuilt, from what is banked, by
// somebody who is not us, on a machine that is not this one?
//
// It clones the banked SHAs into a fresh temporary directory, installs
// dependencies as a new machine would, builds the database from the migration
// chain into a scratch database it creates and drops, and runs every test suite
// package.json declares — then reports, per step, what happened and how long it
// took.
//
// It reads NOTHING from the working tree. Not the checkout it lives in, not its
// node_modules, not its .dcs-data, not its .env. That is the entire point: a
// green run here is only meaningful if none of this machine's accumulated state
// could have contributed to it.
//
// Usage:
//   node scripts/reproduce.mjs                    full cold rebuild
//   node scripts/reproduce.mjs --keep             leave the temp tree in place
//   node scripts/reproduce.mjs --skip-browser     skip the Chrome-dependent suites
//   node scripts/reproduce.mjs --only test:unit   run one declared suite
//
// Environment variables it will use, BY NAME (all optional; defaults shown):
//   DCS_PG_ADMIN_DSN   postgresql://127.0.0.1:5432/postgres
//                      A superuser-ish DSN on a LOCAL Postgres. The script
//                      creates and drops one scratch database through it.
//                      It refuses a non-local DSN.
//   PSQL_BIN           psql found on PATH (src/core/schema.mjs also probes
//                      /opt/homebrew/opt/{postgresql@16,libpq}/bin/psql)
//   DCS_CHROME         path to a Chrome binary; otherwise test/helpers/browser.mjs
//                      probes ~/.cache/puppeteer and /Applications
//   DCS_REPRO_TMPDIR   where to build (default: OS temp dir)
//   GH_TOKEN / GITHUB_TOKEN
//                      only if `gh` is not already authenticated on the machine;
//                      the banked repositories are PRIVATE.
//
// Exit code is non-zero if any step fails.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --------------------------------------------------------------- what is banked

const BANKED = {
  backend: {
    name: "backend",
    url: "https://github.com/DCSAITechnologies/dcs-games-backend-sprint-sep2026.git",
    branch: "sprint/2026-09-canonical",
    sha: "04f9e610515dd1c18165a36652e7e0ed883f3c48",
    // Relative to the temp root. The browser suites resolve the frontend as
    // path.resolve(<repo>/test, "../../../dcs-games-LIVE") — i.e. two levels
    // ABOVE the backend repo root — so the backend has to sit one directory
    // deep for that to land inside the temp tree.
    into: path.join("dcs-games-6month-deploy", "gb"),
  },
  frontend: {
    name: "frontend",
    url: "https://github.com/DCSAITechnologies/dcs-games-frontend.git",
    branch: "main",
    sha: "03e8e1f843bf1d3cee690dda29097567badc0ca7",
    // The suites hard-code this directory NAME. It is not configurable.
    into: "dcs-games-LIVE",
  },
};

// The browser suites also write screenshots to
// <tmp>/DCS_GAMES_SPRINT_SEP2026/evidence[/screenshots]; browser.mjs mkdirs it,
// but we create it so nothing is tempted to look outside the temp tree.
const EVIDENCE_REL = path.join("DCS_GAMES_SPRINT_SEP2026", "evidence", "screenshots");

// ------------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? (argv[i + 1] ?? d) : d; };
const KEEP = has("--keep");
const SKIP_BROWSER = has("--skip-browser");
const ONLY = val("--only");

const ADMIN_DSN = process.env.DCS_PG_ADMIN_DSN || "postgresql://127.0.0.1:5432/postgres";
const SCRATCH_DB = "dcs_repro_" + Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------------- plumbing

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", grn: "", yel: "", bold: "", off: "" };

const STARTED = new Date();
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-repro-logs-"));
const steps = [];
let currentTmp = null;

const say = (s = "") => process.stdout.write(s + "\n");
const hhmmss = (ms) => {
  const s = ms / 1000;
  if (s < 90) return s.toFixed(1) + "s";
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
};

/**
 * Child processes get a DELIBERATELY NARROW environment. Anything this machine
 * happens to have exported — credentials, DSNs, data directories, provider keys
 * — is withheld, because a fresh machine would not have it. If a step needs a
 * variable, it has to be named here.
 */
function childEnv(extra = {}) {
  const pass = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "TERM",
                "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "PSQL_BIN", "DCS_CHROME",
                "GH_TOKEN", "GITHUB_TOKEN", "XDG_CACHE_HOME"];
  const env = {};
  for (const k of pass) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.CI = "1";
  env.NPM_CONFIG_FUND = "false";
  env.NPM_CONFIG_AUDIT = "false";
  env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  return { ...env, ...extra };
}

function run(cmd, args, { cwd, env = {}, timeout = 25 * 60 * 1000, logName } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd, env: childEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", killed = false;
    const to = setTimeout(() => { killed = true; try { p.kill("SIGKILL"); } catch {} }, timeout);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(to);
      resolve({ code: -1, out, err: err + "\n" + e.message, ms: Date.now() - t0, spawnError: e.message });
    });
    p.on("close", (code) => {
      clearTimeout(to);
      if (logName) {
        fs.writeFileSync(path.join(LOG_DIR, logName + ".log"),
          `$ ${cmd} ${args.join(" ")}\n(cwd: ${cwd})\n\n--- stdout ---\n${out}\n--- stderr ---\n${err}\n`);
      }
      resolve({ code: killed ? 124 : code, out, err, ms: Date.now() - t0, timedOut: killed });
    });
  });
}

const tail = (s, n = 40) => s.split("\n").filter(Boolean).slice(-n).join("\n");

async function step(name, detail, fn) {
  const t0 = Date.now();
  say(`\n${C.bold}▸ ${name}${C.off}${detail ? `  ${C.dim}${detail}${C.off}` : ""}`);
  let rec;
  try {
    const r = await fn();
    rec = { name, detail, ok: r?.ok !== false, ms: Date.now() - t0, note: r?.note || "", error: r?.error || "" };
  } catch (e) {
    rec = { name, detail, ok: false, ms: Date.now() - t0, note: "", error: e?.stack || String(e) };
  }
  steps.push(rec);
  const badge = rec.ok ? `${C.grn}PASS${C.off}` : `${C.red}FAIL${C.off}`;
  say(`  ${badge}  ${hhmmss(rec.ms)}${rec.note ? `  ${C.dim}${rec.note}${C.off}` : ""}`);
  if (!rec.ok && rec.error) say(`${C.red}${rec.error.split("\n").slice(0, 60).join("\n")}${C.off}`);
  return rec.ok;
}

// ------------------------------------------------------------------ db helpers

function psqlBin() {
  for (const p of [process.env.PSQL_BIN, "/opt/homebrew/opt/postgresql@16/bin/psql",
                   "/opt/homebrew/opt/libpq/bin/psql", "/usr/local/opt/libpq/bin/psql"]) {
    if (p && fs.existsSync(p)) return p;
  }
  return "psql";
}

async function psql(dsn, sql) {
  return run(psqlBin(), ["-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t", "-d", dsn, "-c", sql], { timeout: 120000 });
}

async function dropScratch() {
  await psql(ADMIN_DSN,
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${SCRATCH_DB}' and pid <> pg_backend_pid();`);
  return psql(ADMIN_DSN, `drop database if exists ${SCRATCH_DB};`);
}

// ---------------------------------------------------------------------- main

async function main() {
  say(`${C.bold}DCS Games — cold rebuild from banked SHAs${C.off}`);
  say(`${C.dim}started ${STARTED.toISOString()}${C.off}`);

  // ---- 0. the machine, on the record ------------------------------------
  const probe = async (cmd, args) => {
    const r = await run(cmd, args, { timeout: 20000 });
    return r.code === 0 ? (r.out + r.err).trim().split("\n")[0] : `MISSING (${r.spawnError || "exit " + r.code})`;
  };
  const machine = {
    host: os.hostname(),
    platform: `${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
    cpu: os.cpus()[0]?.model || "?",
    cores: os.cpus().length,
    memGB: (os.totalmem() / 1024 ** 3).toFixed(1),
    node: process.version,
    npm: await probe("npm", ["-v"]),
    git: await probe("git", ["--version"]),
    psql: await probe(psqlBin(), ["--version"]),
    gh: await probe("gh", ["--version"]),
  };
  const sw = await run("sw_vers", [], { timeout: 10000 });
  if (sw.code === 0) machine.os = sw.out.trim().replace(/\s*\n\s*/g, "; ");
  say("");
  for (const [k, v] of Object.entries(machine)) say(`  ${C.dim}${k.padEnd(9)}${C.off} ${v}`);

  // ---- 0b. prerequisites -------------------------------------------------
  let ok = await step("preflight", "tools and a local Postgres", async () => {
    const missing = [];
    for (const [k, v] of Object.entries(machine)) if (String(v).startsWith("MISSING")) missing.push(k);
    // gh is only needed for credentials; git may already be configured.
    const fatal = missing.filter((m) => m !== "gh");
    if (fatal.length) return { ok: false, error: `required tools missing: ${fatal.join(", ")}` };

    if (!/(?:@|\/\/)(127\.0\.0\.1|localhost)[:/]/.test(ADMIN_DSN)) {
      return { ok: false, error: `DCS_PG_ADMIN_DSN is not local (${ADMIN_DSN.replace(/:[^:@/]*@/, ":***@")}). This script creates and drops a database; it refuses anything but a local server.` };
    }
    const r = await psql(ADMIN_DSN, "select version();");
    if (r.code !== 0) return { ok: false, error: `cannot reach Postgres at DCS_PG_ADMIN_DSN:\n${tail(r.err, 10)}` };
    return { note: r.out.trim().split(",")[0] };
  });
  if (!ok) return finish();

  // ---- 1. a temporary tree ----------------------------------------------
  const tmpBase = process.env.DCS_REPRO_TMPDIR || os.tmpdir();
  currentTmp = fs.mkdtempSync(path.join(tmpBase, "dcs-cold-rebuild-"));
  const GB = path.join(currentTmp, BANKED.backend.into);
  const SITE = path.join(currentTmp, BANKED.frontend.into);
  say(`\n${C.dim}temp tree: ${currentTmp}${C.off}`);
  say(`${C.dim}logs:      ${LOG_DIR}${C.off}`);
  fs.mkdirSync(path.join(currentTmp, EVIDENCE_REL), { recursive: true });

  // ---- 2. clone the banked SHAs ------------------------------------------
  const clone = async (spec, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // gh's credential helper is how a private HTTPS clone authenticates on a
    // machine where `gh auth login` has been run. -c keeps it out of any config.
    const gitArgs = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"];
    let r = await run("git", [...gitArgs, "clone", "--quiet", "--branch", spec.branch, spec.url, dest],
      { timeout: 10 * 60 * 1000, logName: `clone-${spec.name}` });
    if (r.code !== 0) return { ok: false, error: `git clone ${spec.name} failed:\n${tail(r.err, 25)}` };

    const head = await run("git", ["rev-parse", "HEAD"], { cwd: dest });
    let at = head.out.trim();
    if (at !== spec.sha) {
      const co = await run("git", ["checkout", "--quiet", "--detach", spec.sha], { cwd: dest, timeout: 120000 });
      if (co.code !== 0) return { ok: false, error: `banked SHA ${spec.sha} not reachable on ${spec.branch} (branch head is ${at}):\n${tail(co.err, 15)}` };
      at = (await run("git", ["rev-parse", "HEAD"], { cwd: dest })).out.trim();
    }
    if (at !== spec.sha) return { ok: false, error: `checkout landed on ${at}, not the banked ${spec.sha}` };
    const branchHead = (await run("git", ["rev-parse", "origin/" + spec.branch], { cwd: dest })).out.trim();
    const files = (await run("git", ["ls-files"], { cwd: dest })).out.trim().split("\n").length;

    // A green run against a SUPERSEDED commit is the most misleading result
    // this script can produce: it says "the estate rebuilds" while describing
    // code nobody is running any more. It happened — the pins sat at a commit
    // 60-odd commits behind, the run passed 11/11, and the only trace was the
    // words "branch head moved to" inside a PASS line.
    //
    // Now it fails, and says which SHA to update the pin to. --allow-stale is
    // there for the legitimate case of re-verifying an older checkpoint on
    // purpose, and has to be asked for.
    if (branchHead && branchHead !== spec.sha && !process.argv.includes("--allow-stale")) {
      // How far behind, not merely "behind".
      //
      // A pin can never equal the branch head at the moment it is written: the
      // commit that updates the pin is itself a commit, so the pin is one
      // behind the instant it lands. Refusing on any difference would make the
      // guard unsatisfiable and it would be turned off, which is worse than not
      // having it. What it must catch is the case that actually happened — a
      // pin sixty commits behind, passing 11/11, describing code nobody runs.
      const behind = Number((await run("git", ["rev-list", "--count", `${spec.sha}..${branchHead}`], { cwd: dest })).out.trim() || "0");
      const reachable = (await run("git", ["merge-base", "--is-ancestor", spec.sha, branchHead], { cwd: dest })).code === 0;
      const TOLERANCE = 3;
      if (!reachable || behind > TOLERANCE) {
        return {
          ok: false,
          error: `the banked ${spec.name} SHA is superseded: pinned ${spec.sha.slice(0, 12)}, branch ${spec.branch} is now at ${branchHead.slice(0, 12)}` +
                 (reachable ? ` (${behind} commits ahead of the pin).` : `, and the pin is not even an ancestor of it.`) + `\n` +
                 `A cold rebuild of a commit nobody is running does not prove today's estate rebuilds.\n` +
                 `Update BANKED.${spec.name}.sha in scripts/reproduce.mjs to ${branchHead}, or pass --allow-stale to verify the older checkpoint deliberately.`,
        };
      }
    }
    return { note: `${at.slice(0, 12)} · ${files} tracked files · branch head ${branchHead === spec.sha ? "is the banked SHA" : "moved to " + branchHead.slice(0, 12)}` };
  };

  ok = await step("clone backend", `${BANKED.backend.branch} @ ${BANKED.backend.sha.slice(0, 12)}`,
    () => clone(BANKED.backend, GB)) && ok;
  ok = await step("clone frontend", `${BANKED.frontend.branch} @ ${BANKED.frontend.sha.slice(0, 12)} → ${BANKED.frontend.into}/`,
    () => clone(BANKED.frontend, SITE)) && ok;
  if (!ok) return finish();

  // ---- 3. install dependencies -------------------------------------------
  await step("npm install", "as a fresh machine would", async () => {
    const hasLock = fs.existsSync(path.join(GB, "package-lock.json"));
    let r = await run("npm", [hasLock ? "ci" : "install", "--no-fund", "--no-audit"],
      { cwd: GB, timeout: 15 * 60 * 1000, logName: "npm-install" });
    let how = hasLock ? "npm ci" : "npm install";
    if (r.code !== 0 && hasLock) {
      const first = tail(r.err, 6);
      r = await run("npm", ["install", "--no-fund", "--no-audit"],
        { cwd: GB, timeout: 15 * 60 * 1000, logName: "npm-install-fallback" });
      how = `npm ci FAILED (${first.split("\n")[0]}) → npm install`;
    }
    if (r.code !== 0) return { ok: false, error: `${how} failed:\n${tail(r.err, 30)}` };
    const mods = fs.existsSync(path.join(GB, "node_modules"))
      ? fs.readdirSync(path.join(GB, "node_modules")).filter((d) => !d.startsWith(".")).length : 0;
    return { note: `${how} · ${mods} top-level packages in node_modules` };
  });

  // ---- 4. build the database from the chain ------------------------------
  const scratchDsn = ADMIN_DSN.replace(/\/[^/?]*(\?.*)?$/, `/${SCRATCH_DB}$1`);
  await step("database from migrations", `scratch db ${SCRATCH_DB}`, async () => {
    await dropScratch();
    const cr = await psql(ADMIN_DSN, `create database ${SCRATCH_DB};`);
    if (cr.code !== 0) return { ok: false, error: `create database failed:\n${tail(cr.err, 10)}` };

    const st = await run("node", ["scripts/migrate.mjs", "status", "--dsn", scratchDsn],
      { cwd: GB, timeout: 180000, logName: "migrate-status" });
    if (st.code !== 0) return { ok: false, error: `migrate status failed:\n${tail(st.err || st.out, 20)}` };
    const linear = /chain linear:\s*(\S+)/.exec(st.out)?.[1];

    const up = await run("node", ["scripts/migrate.mjs", "up", "--dsn", scratchDsn],
      { cwd: GB, timeout: 300000, logName: "migrate-up" });
    if (up.code !== 0) return { ok: false, error: `migrate up failed:\n${tail(up.err || up.out, 30)}` };

    // Re-running must be a no-op: the chain is append-only or it is not.
    const again = await run("node", ["scripts/migrate.mjs", "up", "--dsn", scratchDsn],
      { cwd: GB, timeout: 300000, logName: "migrate-up-again" });
    if (again.code !== 0) return { ok: false, error: `re-running migrate up failed (chain is not idempotent):\n${tail(again.err || again.out, 20)}` };
    const reapplied = /\((\d+) applied this run\)/.exec(again.out)?.[1];
    if (reapplied && reapplied !== "0") return { ok: false, error: `re-running the chain applied ${reapplied} migrations again; it should have been a no-op` };

    // Prove the schema version, out of the database, not out of the log.
    const vr = await run("node", ["scripts/migrate.mjs", "verify", "--dsn", scratchDsn],
      { cwd: GB, timeout: 180000, logName: "migrate-verify" });
    if (vr.code !== 0) return { ok: false, error: `schema verification failed:\n${tail(vr.err || vr.out, 20)}` };
    let report;
    try { report = JSON.parse(vr.out); } catch { return { ok: false, error: `migrate verify did not return JSON:\n${tail(vr.out, 10)}` }; }
    if (!report.ok) return { ok: false, error: `schema not acceptable: ${JSON.stringify(report)}` };
    if (report.version !== report.required) {
      return { ok: false, error: `schema is at v${report.version} but the code requires v${report.required}` };
    }
    const cnt = await psql(scratchDsn, "select count(*) from information_schema.tables where table_schema='public';");
    const rows = await psql(scratchDsn, "select count(*) from public.dcsgames_schema_migrations;");
    return { note: `chain linear: ${linear} · migrations recorded: ${rows.out.trim()} · schema v${report.version} (code requires v${report.required}) · ${cnt.out.trim()} public tables` };
  });

  // ---- 5. every test suite package.json declares --------------------------
  const pkg = JSON.parse(fs.readFileSync(path.join(GB, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  // "test" and "test:ci" are aggregates of the leaves below; running the leaves
  // covers them and keeps the per-suite timings honest.
  const AGGREGATES = new Set(["test", "test:ci"]);
  const declared = Object.keys(scripts).filter((k) => k === "test" || k.startsWith("test:"));
  const leaves = declared.filter((k) => !AGGREGATES.has(k));
  const covered = new Set();
  for (const a of AGGREGATES) if (scripts[a]) for (const m of scripts[a].matchAll(/npm run (test[:\w]*)/g)) covered.add(m[1]);
  say(`\n${C.dim}package.json declares: ${declared.join(", ")}${C.off}`);
  say(`${C.dim}aggregates (${[...AGGREGATES].filter((a) => scripts[a]).join(", ")}) compose: ${[...covered].join(", ")}${C.off}`);
  const uncovered = leaves.filter((l) => !covered.has(l));
  if (uncovered.length) say(`${C.yel}note: ${uncovered.join(", ")} ${uncovered.length > 1 ? "are" : "is"} declared but not part of any aggregate${C.off}`);

  const suiteEnv = {
    DCS_PG_ADMIN_DSN: ADMIN_DSN,   // the DB-backed suites build their own scratch DBs through this
    PAYMENTS_LIVE: "0",
    NODE_ENV: "test",
    DCS_PROVIDERS_OFFLINE: "1",
  };

  for (const suite of leaves) {
    if (ONLY && suite !== ONLY) continue;
    const isBrowser = /browser|e2e/.test(suite);
    if (SKIP_BROWSER && isBrowser) { say(`\n${C.dim}▸ ${suite} — skipped (--skip-browser)${C.off}`); continue; }
    await step(suite, scripts[suite].slice(0, 110) + (scripts[suite].length > 110 ? "…" : ""), async () => {
      const r = await run("npm", ["run", "--silent", suite], {
        cwd: GB, env: suiteEnv, timeout: 30 * 60 * 1000, logName: "suite-" + suite.replace(/:/g, "-"),
      });
      const text = r.out + "\n" + r.err;
      // node --test summarises as "\u2139 tests 12" with the default spec reporter and
      // "# tests 12" under the TAP reporter. Accept both, and sum across processes.
      const grab = (k) => {
        const re = new RegExp(`^(?:\u2139|#)\\s+${k}\\s+(\\d+)$`);
        let total = 0, seen = false;
        for (const l of text.split("\n")) {
          const m = re.exec(l.trim());
          if (m) { total += Number(m[1]); seen = true; }
        }
        return seen ? total : null;
      };
      const counts = { tests: grab("tests"), pass: grab("pass"), fail: grab("fail"), skipped: grab("skipped") };
      const note = counts.tests === null
        ? "NO TEST SUMMARY FOUND IN OUTPUT"
        : `tests ${counts.tests} \u00b7 pass ${counts.pass} \u00b7 fail ${counts.fail} \u00b7 skipped ${counts.skipped}`;
      // A suite that exits 0 having run nothing is not a pass, it is a silent hole.
      // The browser suites skip themselves when the sibling frontend checkout or
      // Chrome is absent and then exit 0, so "green" can mean "proved nothing".
      // A cold rebuild that cannot tell those apart is worthless.
      if (r.code === 0 && counts.tests === 0) {
        return { ok: false, note, error: `${suite} exited 0 but ran zero tests` };
      }
      if (r.code === 0 && counts.tests > 0 && counts.pass === 0) {
        const why = [...new Set([...text.matchAll(/#\s*SKIP\s*(.*)$/gm)].map((m) => m[1].trim()).filter(Boolean))];
        return { ok: false, note, error: `${suite} exited 0 but every one of its ${counts.tests} tests skipped — it proved nothing.\n  reasons given: ${why.join(" | ") || "(none)"}` };
      }
      if (r.code === 0 && counts.skipped > 0) {
        const why = [...new Set([...text.matchAll(/#\s*SKIP\s*(.*)$/gm)].map((m) => m[1].trim()).filter(Boolean))];
        say(`  ${C.yel}WARNING: ${counts.skipped}/${counts.tests} tests skipped — ${why.join(" | ") || "(no reason given)"}${C.off}`);
      }
      if (r.code !== 0) {
        const fails = text.split("\n").filter((l) => /^not ok |^\s*# Subtest|error:|Error:|AssertionError/.test(l)).slice(0, 25).join("\n");
        return { ok: false, note, error: `${suite} exited ${r.code}${r.timedOut ? " (TIMED OUT)" : ""}\n${fails}\n…full log: ${path.join(LOG_DIR, "suite-" + suite.replace(/:/g, "-") + ".log")}` };
      }
      return { note };
    });
  }

  return finish();
}

// ----------------------------------------------------------------- teardown

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;

  const dr = await dropScratch();
  const dbNote = dr.code === 0 ? `dropped ${SCRATCH_DB}` : `COULD NOT DROP ${SCRATCH_DB}: ${tail(dr.err, 3)}`;
  let treeNote = "kept (--keep)";
  if (currentTmp && !KEEP) {
    try { fs.rmSync(currentTmp, { recursive: true, force: true }); treeNote = `removed ${currentTmp}`; }
    catch (e) { treeNote = `COULD NOT REMOVE ${currentTmp}: ${e.message}`; }
  } else if (currentTmp) {
    treeNote = `kept at ${currentTmp}`;
  } else {
    treeNote = "nothing to remove";
  }

  const total = Date.now() - STARTED.getTime();
  const failed = steps.filter((s) => !s.ok);

  say(`\n${C.bold}${"═".repeat(72)}${C.off}`);
  say(`${C.bold}SUMMARY${C.off}`);
  for (const s of steps) {
    say(`  ${(s.ok ? C.grn + "PASS" : C.red + "FAIL") + C.off}  ${hhmmss(s.ms).padStart(7)}  ${s.name}${s.note ? `  ${C.dim}${s.note}${C.off}` : ""}`);
  }
  say(`  ${C.dim}${"─".repeat(60)}${C.off}`);
  say(`  total ${hhmmss(total)} · ${steps.length - failed.length}/${steps.length} steps passed`);
  say(`  cleanup: ${dbNote}; temp tree ${treeNote}`);
  say(`  logs kept at ${LOG_DIR}`);
  say(`${C.bold}${"═".repeat(72)}${C.off}`);

  if (failed.length) {
    say(`\n${C.red}${C.bold}COLD REBUILD FAILED${C.off} — ${failed.length} step(s): ${failed.map((f) => f.name).join(", ")}`);
    process.exitCode = 1;
  } else {
    say(`\n${C.grn}${C.bold}COLD REBUILD SUCCEEDED${C.off} — the estate rebuilds from what is banked.`);
    process.exitCode = 0;
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { say(`\n${C.yel}interrupted — cleaning up${C.off}`); await finish(); process.exit(130); });
}

main().catch(async (e) => {
  say(`${C.red}unhandled: ${e?.stack || e}${C.off}`);
  steps.push({ name: "script", ok: false, ms: 0, error: String(e?.stack || e) });
  await finish();
  process.exitCode = 1;
});
