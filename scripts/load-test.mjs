#!/usr/bin/env node
// Lane F — load and scale harness.
//
// There was no load or scale evidence anywhere in this estate, so "it scales"
// was an assertion rather than a measurement. This boots the REAL server.mts in
// a child process against a throwaway data dir and drives concurrent traffic at
// the read paths a public launch actually hits, then probes the write paths for
// CORRECTNESS under the same concurrency.
//
// It is deliberately not just a latency benchmark. The file-backed stores in
// src/core/collection.mjs do read-whole-file -> mutate -> write-whole-file with
// awaits in between, which is a textbook lost-update window in a single-threaded
// event loop. A harness that only reported p95 would have called that healthy.
//
// Run:
//   node scripts/load-test.mjs                       # ~35s default ramp
//   node scripts/load-test.mjs --levels=1,8,32,64,128 --duration=10
//   node scripts/load-test.mjs --json=out.json
//
// Exit code is 0 ONLY when every request succeeded and no write was lost.
// Any non-2xx, any transport error, any lost write => exit 1 and a loud report.

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");

// --------------------------------------------------------------------- args
function parseArgs(argv) {
  const o = {
    levels: [1, 8, 32, 64],
    duration: 6,          // seconds of measured traffic per level
    warmup: 1,            // seconds, discarded
    worlds: 12,           // published worlds seeded into discovery
    writeProbe: 0,        // 0 => use the level's concurrency
    port: 0,              // 0 => pick a free-ish random port
    json: null,
    keepData: false,
    quiet: false,
  };
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case "levels": o.levels = v.split(",").map((x) => parseInt(x, 10)).filter((n) => n > 0); break;
      case "concurrency": o.levels = [parseInt(v, 10)]; break;
      case "duration": o.duration = Number(v); break;
      case "warmup": o.warmup = Number(v); break;
      case "worlds": o.worlds = parseInt(v, 10); break;
      case "write-probe": o.writeProbe = parseInt(v, 10); break;
      case "port": o.port = parseInt(v, 10); break;
      case "json": o.json = v; break;
      case "keep-data": o.keepData = true; break;
      case "quiet": o.quiet = true; break;
      case "help": printHelp(); process.exit(0); break;
      default: break;
    }
  }
  if (!o.levels.length) throw new Error("--levels needs at least one positive integer");
  return o;
}

function printHelp() {
  process.stdout.write(`
DCS Games load and scale harness

  --levels=1,8,32,64     concurrency levels to ramp through (default)
  --concurrency=N        shorthand for --levels=N
  --duration=6           measured seconds per level
  --warmup=1             discarded warmup seconds per level
  --worlds=12            published worlds seeded before the run
  --write-probe=N        concurrent writes in the correctness probe
                         (default: the level's own concurrency)
  --port=8xxx            fixed port instead of a random one
  --json=PATH            write the full result object as JSON
  --keep-data            do not delete the temp DCS_DATA_DIR
  --quiet                only the summary

Exit 0 only when every request was 2xx and no write was lost.
`);
}

const OPT = parseArgs(process.argv.slice(2));
const PORT = OPT.port || 8300 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "load-test-secret-" + crypto.randomBytes(6).toString("hex");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-load-"));
const ATLAS_SEED = crypto.randomBytes(32).toString("base64");

const TESTER = signLocalToken(SECRET, { sub: "load-tester", email: "loadtester@dcsai.ai", roles: ["internal_tester"] }, 7200);
const READER = signLocalToken(SECRET, { sub: "load-reader", email: "reader@example.com" }, 7200);

const log = (...a) => { if (!OPT.quiet) console.log(...a); };

// --------------------------------------------------------------------- boot
function serverEnv() {
  return {
    ...process.env,
    PORT: String(PORT),
    DCS_AUTH_SECRET: SECRET,
    DCS_DATA_DIR: DATA,
    PAYMENTS_LIVE: "0",                 // money stays dark, always
    NODE_ENV: "test",
    DCS_PROVIDERS_OFFLINE: "1",         // deterministic, free, no vendor calls
    DCS_INTERNAL_TESTERS: "loadtester@dcsai.ai",
    ATLAS_PRIVATE_KEY: ATLAS_SEED,      // so publish can genuinely sign
    SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "",
    CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "", CEREBRAS_KEY_2: "",
    DEEPSEEK_API_KEY: "", TOGETHER_API_KEY: "", DATABASE_URL: "",
  };
}

async function boot() {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB, env: serverEnv(), stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => {
    stderr.push(String(d));
    if (process.env.DCS_LOAD_VERBOSE) process.stderr.write(d);
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return { proc: p, stderr }; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy on " + BASE + "\n" + stderr.join(""));
}

const call = async (p, { method = "GET", token = null, body } = {}) => {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
};

// ------------------------------------------------------------------ metrics
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}
const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

class Recorder {
  constructor() {
    this.samples = [];              // { route, ms, status }
    this.byStatus = new Map();
    this.transportErrors = [];      // { route, error }
  }
  add(route, ms, status) {
    this.samples.push({ route, ms, status });
    this.byStatus.set(status, (this.byStatus.get(status) || 0) + 1);
  }
  fail(route, err) {
    this.transportErrors.push({ route, error: String(err && err.message || err) });
    this.byStatus.set("transport_error", (this.byStatus.get("transport_error") || 0) + 1);
  }
  summarize(wallSeconds) {
    const all = this.samples.map((s) => s.ms).sort((a, b) => a - b);
    const routes = {};
    for (const s of this.samples) (routes[s.route] ||= []).push(s.ms);
    const perRoute = {};
    for (const [r, arr] of Object.entries(routes)) {
      arr.sort((a, b) => a - b);
      perRoute[r] = { n: arr.length, p50: round(percentile(arr, 0.5)), p95: round(percentile(arr, 0.95)), p99: round(percentile(arr, 0.99)), max: round(arr[arr.length - 1]) };
    }
    const statuses = {};
    for (const [k, v] of this.byStatus) statuses[k] = v;
    const nonOk = Object.entries(statuses)
      .filter(([k]) => k === "transport_error" || !(Number(k) >= 200 && Number(k) < 300))
      .reduce((a, [, v]) => a + v, 0);
    return {
      requests: this.samples.length + this.transportErrors.length,
      ok: this.samples.filter((s) => s.status >= 200 && s.status < 300).length,
      non_ok: nonOk,
      throughput_rps: round((this.samples.length + this.transportErrors.length) / wallSeconds),
      latency_ms: {
        p50: round(percentile(all, 0.5)), p95: round(percentile(all, 0.95)),
        p99: round(percentile(all, 0.99)), max: round(all[all.length - 1]),
        mean: round(all.reduce((a, b) => a + b, 0) / (all.length || 1)),
      },
      by_status: statuses,
      by_route: perRoute,
      transport_errors: this.transportErrors.slice(0, 10),
    };
  }
}

// ------------------------------------------------------------------- setup
/**
 * Generate one real world through the real pipeline, publish it, then clone the
 * stored record N-1 times so discovery has a realistic corpus without paying for
 * N generations. Cloning happens through the file store the server already owns,
 * so the records are exactly the shape the server wrote.
 */
async function seedWorlds(n) {
  // The safety service refuses 'create' for an unknown age tier, so the tester
  // records an age assurance exactly as a real creator would. No check weakened.
  const age = await call("/safety/age", { method: "POST", token: TESTER, body: { date_of_birth: "1988-03-14" } });
  if (age.status !== 200) throw new Error("age assurance failed for setup: " + age.status + " " + age.text.slice(0, 300));

  const g = await call("/v3/worlds/generate", { method: "POST", token: TESTER, body: { prompt: "Ashfall Harbour, a rainy nordic port town" } });
  if (g.status !== 200 || !g.body?.world_id) throw new Error("world generation failed for setup: " + g.status + " " + g.text.slice(0, 400));
  const id = g.body.world_id;

  const pub = await call(`/worlds/${id}/publish`, { method: "POST", token: TESTER, body: {} });
  if (pub.status !== 200 || pub.body?.published !== true) {
    throw new Error("publish failed for setup: " + pub.status + " " + pub.text.slice(0, 400));
  }

  const worldsDir = path.join(DATA, "worlds");
  const file = path.join(worldsDir, encodeURIComponent(id) + ".json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  const clones = [];
  for (let i = 1; i < n; i++) {
    const cid = `${id}_c${i}`;
    const clone = { ...record, world_id: cid, title: `${record.title || "World"} #${i}`, state: "published" };
    fs.writeFileSync(path.join(worldsDir, encodeURIComponent(cid) + ".json"), JSON.stringify(clone));
    clones.push(cid);
  }
  return { primary: id, all: [id, ...clones] };
}

// ------------------------------------------------------------- read workload
function buildMix(worldIds) {
  // Weighted to look like a public launch: mostly discovery and manifest loads,
  // a health probe from the platform, and an authenticated profile fetch.
  const w = (id) => worldIds[Math.floor(Math.random() * worldIds.length)];
  return [
    { weight: 1, route: "GET /health", make: () => ({ path: "/health" }) },
    { weight: 4, route: "GET /v3/discover", make: () => ({ path: "/v3/discover?limit=24" }) },
    { weight: 4, route: "GET /v3/worlds/:id/manifest", make: () => ({ path: `/v3/worlds/${w()}/manifest` }) },
    { weight: 3, route: "GET /v3/worlds/:id/stats", make: () => ({ path: `/v3/worlds/${w()}/stats` }) },
    { weight: 2, route: "GET /me/profile", make: () => ({ path: "/me/profile", token: READER }) },
  ];
}

function pick(mix) {
  const total = mix.reduce((a, m) => a + m.weight, 0);
  let r = Math.random() * total;
  for (const m of mix) { r -= m.weight; if (r <= 0) return m; }
  return mix[mix.length - 1];
}

async function driveReads({ mix, concurrency, seconds, recorder, pid = null, rssSamples = null }) {
  const deadline = Date.now() + seconds * 1000;
  const sampler = pid && rssSamples
    ? setInterval(() => { const v = rssMb(pid); if (v != null) rssSamples.push(v); }, 500)
    : null;
  const worker = async () => {
    while (Date.now() < deadline) {
      const m = pick(mix);
      const spec = m.make();
      const headers = spec.token ? { Authorization: "Bearer " + spec.token } : undefined;
      const t0 = performance.now();
      try {
        const r = await fetch(BASE + spec.path, { headers });
        await r.arrayBuffer();                       // pay the full body cost
        recorder.add(m.route, performance.now() - t0, r.status);
      } catch (e) {
        recorder.fail(m.route, e);
      }
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (sampler) clearInterval(sampler);
  return (performance.now() - t0) / 1000;
}

// --------------------------------------------------- write correctness probe
/**
 * Fire `n` concurrent plays at one world and check the store kept every one.
 *
 * The play path is: social.recordPlay -> collection.insert -> all() (read whole
 * file) -> push -> write() (write whole file). Every await in there is a yield
 * point. If two requests interleave between the read and the write, the second
 * write is computed from a stale snapshot and the first play is gone. The
 * endpoint returns 201 for both, so the API tells the caller nothing broke.
 */
async function playLostUpdateProbe(worldId, n) {
  const playsFile = path.join(DATA, "social", "world_plays.json");
  const readRows = () => { try { return JSON.parse(fs.readFileSync(playsFile, "utf8")); } catch { return []; } };
  const before = readRows().length;

  const results = await Promise.all(Array.from({ length: n }, (_, i) =>
    call(`/v3/worlds/${worldId}/play`, { method: "POST", token: READER, body: { seconds: 30 + i } })
      .then((r) => r.status).catch((e) => "transport:" + e.message)));

  const accepted = results.filter((s) => s === 201 || s === 200).length;
  const rejected = results.filter((s) => s !== 201 && s !== 200);

  // Let any in-flight rename settle before counting the file.
  await new Promise((r) => setTimeout(r, 250));
  const rows = readRows();
  const after = rows.length;
  const stats = await call(`/v3/worlds/${worldId}/stats`);

  return {
    concurrent_writes: n,
    accepted_2xx: accepted,
    rejected: rejected.length ? rejected : null,
    rows_before: before,
    rows_after: after,
    rows_persisted: after - before,
    lost_writes: accepted - (after - before),
    stats_endpoint_plays: stats.body?.stats?.plays ?? null,
    file_corrupted: rows === null,
  };
}

/**
 * A brand-new principal hits GET /me/profile `n` times at once. ensureProfile()
 * reads the principals collection, finds nothing, and inserts — read-modify-write
 * again, but this one is on an UNAUTHENTICATED-adjacent read path that any first
 * login hits. Duplicate profile rows for one principal_id is a correctness bug,
 * not a performance one.
 */
async function firstLoginProbe(n, tag) {
  const sub = `fresh-${tag}-${crypto.randomBytes(3).toString("hex")}`;
  const token = signLocalToken(SECRET, { sub, email: `${sub}@example.com` }, 3600);
  const statuses = await Promise.all(Array.from({ length: n }, () =>
    call("/me/profile", { token }).then((r) => r.status).catch((e) => "transport:" + e.message)));
  await new Promise((r) => setTimeout(r, 250));
  const file = path.join(DATA, "social", "principals.json");
  let rows = [];
  let parseError = null;
  try { rows = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { parseError = String(e.message); }
  const mine = rows.filter((r) => r.principal_id === sub);
  return {
    concurrent_first_reads: n,
    statuses_non_2xx: statuses.filter((s) => !(s >= 200 && s < 300)),
    profile_rows_for_one_principal: mine.length,
    duplicate_profiles: Math.max(0, mine.length - 1),
    store_parse_error: parseError,
  };
}

/**
 * The launch-day shape of the same bug: `n` DIFFERENT new principals sign in at
 * once. Each GET /me/profile inserts its own row through the same
 * read-whole-file/write-whole-file path, so the writes overwrite each other and
 * most of the new profiles never reach disk — while every caller is told 200.
 */
async function distinctFirstLoginProbe(n, tag) {
  const file = path.join(DATA, "social", "principals.json");
  const readRows = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
  const before = readRows() || [];
  const beforeIds = new Set(before.map((r) => r.principal_id));

  const subs = Array.from({ length: n }, (_, i) => `burst-${tag}-${i}-${crypto.randomBytes(2).toString("hex")}`);
  const statuses = await Promise.all(subs.map((sub) =>
    call("/me/profile", { token: signLocalToken(SECRET, { sub, email: `${sub}@example.com` }, 3600) })
      .then((r) => r.status).catch((e) => "transport:" + e.message)));

  await new Promise((r) => setTimeout(r, 250));
  const after = readRows();
  const parseError = after === null ? "principals.json did not parse" : null;
  const afterIds = new Set((after || []).map((r) => r.principal_id));
  const accepted = statuses.filter((s) => s >= 200 && s < 300).length;
  const persisted = subs.filter((s) => afterIds.has(s)).length;
  const preExistingLost = [...beforeIds].filter((id) => !afterIds.has(id)).length;

  return {
    concurrent_distinct_signins: n,
    accepted_2xx: accepted,
    profiles_persisted: persisted,
    lost_profiles: accepted - persisted,
    pre_existing_rows_lost: preExistingLost,
    store_parse_error: parseError,
  };
}

/**
 * FileWorldStore / WorldRepository.upsert under concurrency.
 *
 * upsert() reads the existing record, derives version = existing.version + 1,
 * then writes. It supports optimistic concurrency via `expected_version`, but
 * POST /worlds/:id/save defaults that to null, so nothing forces a caller to use
 * it. `n` concurrent saves therefore all read the same version and all write
 * version+1: n-1 edits vanish and the retained version history has holes.
 *
 * The per-world file itself is written tmp+rename, so this is a lost UPDATE, not
 * a corrupted file — which is exactly why it is invisible without this check.
 */
let SAVE_PROBE_RUN = 0;

async function worldSaveProbe(worldId, n) {
  // Every burst must write titles NO EARLIER BURST HAS WRITTEN.
  //
  // The titles used to be `concurrent edit ${i}`, reused verbatim at every
  // concurrency level against the same world. POST /worlds/:id/save is
  // idempotent by design: a save whose manifest hash, state and title all match
  // what is stored returns 200 with `idempotent: true` and does NOT cut a new
  // version, which is correct. So at every level after the first, save #0 was a
  // genuine no-op — and this probe, which infers loss from
  // accepted - versions_advanced, counted that no-op as a LOST EDIT.
  //
  // It reported "LOST WORLD EDIT — 8 saves returned 200, the world advanced
  // only 7 version(s)" on four runs out of four, deterministically, against a
  // repository that had already been fixed with a per-world lock. A harness
  // that manufactures a data-loss report is worse than no harness.
  const burst = ++SAVE_PROBE_RUN;
  const before = await call(`/v3/worlds/${worldId}/manifest`, { token: TESTER });
  const baseVersion = Number(before.body?.world_version ?? 0);
  const manifest = before.body?.manifest;
  if (!manifest) return { skipped: "could not load the world manifest", status: before.status, body: before.text.slice(0, 200) };

  const statuses = await Promise.all(Array.from({ length: n }, (_, i) =>
    call(`/worlds/${worldId}/save`, {
      method: "POST", token: TESTER,
      // No `state`. A save can no longer set a world's state at all — that was
      // an authorization bypass producing published, discoverable worlds past
      // the internal-tester check, ownership, the playtest gate and the Atlas
      // signing key — and the server answers 422 to a save that carries it.
      // While it was here every save in this probe came back 422 and the
      // lost-update question, which is the whole reason this probe exists
      // beyond latency, was never asked: it reported "LOST 0 edits" from a
      // burst in which nothing was ever written.
      body: { manifest: { ...manifest, meta: { ...(manifest.meta || {}), title: `concurrent edit b${burst}-${i}` } } },
    }).then((r) => ({ status: r.status, version: r.body?.world_version, idempotent: r.body?.idempotent === true }))
      .catch((e) => ({ status: "transport:" + e.message }))));

  await new Promise((r) => setTimeout(r, 250));
  const after = await call(`/v3/worlds/${worldId}/manifest`, { token: TESTER });
  const finalVersion = Number(after.body?.world_version ?? 0);
  const accepted = statuses.filter((s) => s.status === 200).length;
  const conflicts = statuses.filter((s) => s.status === 409).length;
  // A 200 that changed nothing is not an accepted edit and must never be
  // counted as one. With unique titles this should be zero; it is measured
  // rather than assumed, so the metric cannot quietly become wrong again.
  const idempotent = statuses.filter((s) => s.status === 200 && s.idempotent).length;
  const wrote = accepted - idempotent;

  const versionsDir = path.join(DATA, "world-versions");
  const retained = fs.readdirSync(versionsDir).filter((f) => f.startsWith(encodeURIComponent(worldId) + "@")).length;

  return {
    concurrent_saves: n,
    accepted_200: accepted,
    idempotent_200: idempotent,
    edits_written: wrote,
    rejected_409_conflict: conflicts,
    other_statuses: statuses.filter((s) => s.status !== 200 && s.status !== 409).map((s) => s.status),
    version_before: baseVersion,
    version_after: finalVersion,
    versions_advanced: finalVersion - baseVersion,
    // Every accepted, NON-IDEMPOTENT save should have produced its own version.
    lost_versions: Math.max(0, wrote - (finalVersion - baseVersion)),
    // A burst in which nothing was accepted AND nothing conflicted did not
    // measure concurrency at all, and "LOST 0" from it is vacuous. Reported
    // explicitly so a probe that stopped working can never again read as a
    // healthy result.
    probe_ran: accepted + conflicts > 0,
    retained_version_files: retained,
    final_title: after.body?.manifest?.meta?.title ?? null,
  };
}

// ----------------------------------------------------------------- resident
function rssMb(pid) {
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return out ? round(Number(out) / 1024, 1) : null;
  } catch { return null; }
}

// --------------------------------------------------------------------- main
async function main() {
  const started = new Date().toISOString();
  log(`# DCS Games load and scale harness`);
  log(`  host        : ${os.type()} ${os.release()} ${os.arch()}, ${os.cpus().length} logical CPUs, ${round(os.totalmem() / 1024 ** 3, 1)} GiB RAM`);
  log(`  node        : ${process.version}`);
  log(`  base        : ${BASE}`);
  log(`  data dir    : ${DATA}`);
  log(`  levels      : ${OPT.levels.join(", ")}  duration ${OPT.duration}s each (+${OPT.warmup}s warmup)`);
  log("");

  const { proc, stderr } = await boot();
  const result = {
    started_at: started,
    host: {
      platform: `${os.type()} ${os.release()}`, arch: os.arch(),
      cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null,
      total_mem_gib: round(os.totalmem() / 1024 ** 3, 1), node: process.version,
    },
    config: { levels: OPT.levels, duration_s: OPT.duration, warmup_s: OPT.warmup, seeded_worlds: OPT.worlds },
    setup: null, levels: [], failures: [],
  };

  try {
    const health = await call("/health");
    if (health.body?.payments_live !== false) throw new Error("refusing to run: PAYMENTS_LIVE is not false");
    result.setup = { health_status: health.status, persistence: health.body?.persistence, auth: health.body?.auth, payments_live: health.body?.payments_live };

    const t0 = performance.now();
    const worlds = await seedWorlds(OPT.worlds);
    result.setup.seed_ms = round(performance.now() - t0);
    result.setup.world_ids = worlds.all.length;
    result.setup.primary_world = worlds.primary;
    log(`  setup       : ${worlds.all.length} published worlds in ${result.setup.seed_ms} ms (1 generated, ${worlds.all.length - 1} cloned)`);
    log("");

    const mix = buildMix(worlds.all);

    for (const level of OPT.levels) {
      const rssBefore = rssMb(proc.pid);
      if (OPT.warmup > 0) await driveReads({ mix, concurrency: level, seconds: OPT.warmup, recorder: new Recorder() });

      const rec = new Recorder();
      const rssSamples = [];
      const wall = await driveReads({ mix, concurrency: level, seconds: OPT.duration, recorder: rec, pid: proc.pid, rssSamples });
      const reads = rec.summarize(wall);
      const rssAfterReads = rssMb(proc.pid);

      const probeN = OPT.writeProbe || level;
      const plays = await playLostUpdateProbe(worlds.primary, probeN);
      const firstLogin = await firstLoginProbe(probeN, `l${level}`);
      const burst = await distinctFirstLoginProbe(probeN, `l${level}`);
      const saves = await worldSaveProbe(worlds.primary, probeN);
      const rssAfter = rssMb(proc.pid);

      const entry = {
        concurrency: level, wall_seconds: round(wall), reads,
        write_probe_plays: plays, write_probe_first_login: firstLogin, write_probe_signin_burst: burst,
        write_probe_world_save: saves,
        server_rss_mb: { before: rssBefore, after_reads: rssAfterReads, after_writes: rssAfter, samples_during_reads: rssSamples },
      };
      result.levels.push(entry);

      if (reads.non_ok > 0) result.failures.push(`concurrency ${level}: ${reads.non_ok} non-2xx/transport responses on the read mix — ${JSON.stringify(reads.by_status)}`);
      if (plays.lost_writes > 0) result.failures.push(`concurrency ${level}: LOST WRITE — ${plays.accepted_2xx} plays accepted with 2xx, only ${plays.rows_persisted} persisted (${plays.lost_writes} lost)`);
      if (plays.rejected) result.failures.push(`concurrency ${level}: ${plays.rejected.length} play writes were rejected: ${JSON.stringify(plays.rejected.slice(0, 5))}`);
      if (firstLogin.duplicate_profiles > 0) result.failures.push(`concurrency ${level}: DUPLICATE PROFILE — ${firstLogin.profile_rows_for_one_principal} rows written for one principal_id by concurrent GET /me/profile`);
      if (firstLogin.statuses_non_2xx.length) result.failures.push(`concurrency ${level}: GET /me/profile returned ${JSON.stringify(firstLogin.statuses_non_2xx.slice(0, 5))}`);
      if (firstLogin.store_parse_error) result.failures.push(`concurrency ${level}: principals.json did not parse — ${firstLogin.store_parse_error}`);
      if (burst.lost_profiles > 0) result.failures.push(`concurrency ${level}: LOST PROFILE — ${burst.accepted_2xx} distinct first sign-ins returned 2xx, only ${burst.profiles_persisted} profiles persisted (${burst.lost_profiles} lost)`);
      if (burst.pre_existing_rows_lost > 0) result.failures.push(`concurrency ${level}: STORE DESTRUCTION — ${burst.pre_existing_rows_lost} pre-existing principal rows disappeared during a concurrent sign-in burst`);
      if (burst.store_parse_error) result.failures.push(`concurrency ${level}: ${burst.store_parse_error}`);
      if (saves.skipped) result.failures.push(`concurrency ${level}: world-save probe could not run — ${saves.skipped} (status ${saves.status})`);
      if (saves.lost_versions > 0) result.failures.push(`concurrency ${level}: LOST WORLD EDIT — ${saves.edits_written} saves returned 200 with a real change, the world advanced only ${saves.versions_advanced} version(s) (${saves.lost_versions} edits lost)`);
      // Titles are unique per burst, so nothing in this probe should ever be a
      // no-op. One that is means the probe is repeating itself again and the
      // loss figure below it is not trustworthy.
      if (saves.idempotent_200 > 0) result.failures.push(`concurrency ${level}: the world-save probe wrote ${saves.idempotent_200} save(s) that changed nothing — it is repeating a title, so its lost-edit count cannot be believed`);
      if (saves.other_statuses?.length) result.failures.push(`concurrency ${level}: /worlds/:id/save returned ${JSON.stringify(saves.other_statuses.slice(0, 5))}`);
      // "LOST 0 edits" out of a burst where nothing was written says nothing
      // about lost updates. A probe that did not run is a failure of the probe,
      // reported as such, so it can never be read as a healthy result.
      if (!saves.skipped && !saves.probe_ran) result.failures.push(`concurrency ${level}: the world-save probe measured NOTHING — ${saves.concurrent_saves} concurrent saves produced 0 accepted and 0 conflicted, so the lost-update question was never asked`);

      log(`## concurrency ${level}`);
      log(`   reads      ${reads.requests} req in ${round(wall)}s -> ${reads.throughput_rps} rps | p50 ${reads.latency_ms.p50}ms  p95 ${reads.latency_ms.p95}ms  p99 ${reads.latency_ms.p99}ms  max ${reads.latency_ms.max}ms`);
      log(`   statuses   ${JSON.stringify(reads.by_status)}`);
      for (const [r, s] of Object.entries(reads.by_route)) {
        log(`     ${r.padEnd(30)} n=${String(s.n).padStart(6)}  p50 ${String(s.p50).padStart(8)}  p95 ${String(s.p95).padStart(8)}  p99 ${String(s.p99).padStart(8)}`);
      }
      log(`   plays      ${probeN} concurrent POSTs: ${plays.accepted_2xx} accepted, ${plays.rows_persisted} persisted, LOST ${plays.lost_writes} (stats says ${plays.stats_endpoint_plays})`);
      log(`   first login ${probeN} concurrent GET /me/profile for a NEW principal: ${firstLogin.profile_rows_for_one_principal} profile rows written (expected 1)`);
      log(`   signin burst ${probeN} distinct new principals at once: ${burst.accepted_2xx} got 2xx, ${burst.profiles_persisted} persisted, LOST ${burst.lost_profiles}, pre-existing rows lost ${burst.pre_existing_rows_lost}`);
      log(`   world save ${probeN} concurrent POST /worlds/:id/save: ${saves.accepted_200} accepted 200 (${saves.edits_written} real, ${saves.idempotent_200} no-op), ${saves.rejected_409_conflict} conflicted, version ${saves.version_before} -> ${saves.version_after}, LOST ${saves.lost_versions} edits, ${saves.retained_version_files} version files`);
      log(`   rss        ${entry.server_rss_mb.before} -> ${entry.server_rss_mb.after_reads} -> ${entry.server_rss_mb.after_writes} MB`);
      log("");
    }
  } catch (e) {
    result.failures.push("harness aborted: " + (e && e.stack || e));
  } finally {
    proc.kill("SIGKILL");
  }

  result.finished_at = new Date().toISOString();
  result.passed = result.failures.length === 0;
  if (stderr.length) result.server_stderr_tail = stderr.join("").split("\n").slice(-15).join("\n");

  if (OPT.json) fs.writeFileSync(OPT.json, JSON.stringify(result, null, 2));
  if (!OPT.keepData) fs.rmSync(DATA, { recursive: true, force: true });

  console.log("=".repeat(72));
  if (result.passed) {
    console.log("LOAD TEST PASSED — every request 2xx, no lost writes, no duplicate rows.");
  } else {
    console.log(`LOAD TEST FAILED — ${result.failures.length} problem(s):`);
    for (const f of result.failures) console.log("  ! " + f);
  }
  console.log("=".repeat(72));
  process.exit(result.passed ? 0 : 1);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(2);
});
