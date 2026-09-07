// Lane G — can a caller influence the cost of the new unauthenticated endpoints?
//
// Not through the request: /api/public/stats, /api/public/events and
// /api/public/worlds read no query string, and their caps are constants. That
// was the first hypothesis and it is disproved in test/lead-review.test.mjs.
//
// They can influence it through the STORE. Every one of them ends in
// `store.list({ state: "published", ... })`, and FileWorldStore.list()
// (src/core/worldstore.mjs:338) readdirs the whole world directory and reads
// every record — or every sidecar — BEFORE it filters on state. So the cost of
// an anonymous request is set by the number of world records that exist, not by
// the number that are published.
//
// And any authenticated account can create world records, in bulk, at will:
// POST /worlds/:id/save on an unclaimed id mints one with no internal-tester
// check and no limit (see the separate defect in test/lead-review.test.mjs).
// They are drafts, so they appear in no public response — the damage is
// invisible in everything a monitor would look at.
//
// Measured on the developer machine this was written on, one account, one loop:
//
//     drafts created   /api/public/stats p50   /api/public/worlds p50   /health p50
//              0                 7.0 ms                   6.5 ms          0.3 ms
//            200                32.6 ms                  33.2 ms          0.3 ms
//           1000               143.9 ms                 141.7 ms          0.2 ms
//           3000               418.9 ms                 600.8 ms          0.5 ms
//
// 3,000 records cost 934 ms to create and are permanent. The landing page's
// figures then take half a second each, for everyone, for ever.
//
// Run: node --import tsx --test test/lead-review-cost.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "lead-review-cost-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-g-cost-"));
const PORT = 9060 + Math.floor(Math.random() * 80);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = crypto.randomBytes(4).toString("hex");
const OWNER = signLocalToken(SECRET, { sub: "user-c-owner", email: "c-owner@dcsai.ai", roles: ["internal_tester"] }, 7200);
const FLOOD = signLocalToken(SECRET, { sub: "user-c-flood", email: "c-flood@example.com" }, 7200);

/** Enough to be unmistakable, few enough to stay a fast test. */
const DRAFTS = 1000;

let proc;
let world;

before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env,
      PORT: String(PORT), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA,
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1",
      ATLAS_PRIVATE_KEY: crypto.randomBytes(32).toString("base64"),
      DCS_INTERNAL_TESTERS: "c-owner@dcsai.ai",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
      DEEPSEEK_API_KEY: "", TOGETHER_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(BASE + "/health")).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const t of [OWNER, FLOOD]) await call(t, "POST", "/safety/age", { date_of_birth: "1990-01-01", method: "synthetic_test" });
  for (let i = 0; i < 12 && !world; i++) {
    const r = await call(OWNER, "POST", "/v3/worlds/generate", { prompt: `a cost world ${RUN} ${i}` });
    if (r.status === 200) world = JSON.parse(r.text).world_id;
  }
  assert.ok(world, "one published world exists, so the endpoints have something real to count");
  assert.equal((await call(OWNER, "POST", `/worlds/${world}/publish`, {})).status, 200);
});

after(() => {
  proc?.kill("SIGKILL");
  fs.rmSync(DATA, { recursive: true, force: true });
});

async function call(token, method, url, body) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}

/** Median wall-clock of n anonymous GETs, after a warm-up. */
async function p50(url, n = 9) {
  await call(null, "GET", url);
  const ts = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    await call(null, "GET", url);
    ts.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return ts.sort((a, b) => a - b)[Math.floor(n / 2)];
}

test("DEFECT, OPEN: one account can multiply the cost of every anonymous public read", async () => {
  const before_ = { stats: await p50("/api/public/stats"), worlds: await p50("/api/public/worlds"), health: await p50("/health") };

  const t0 = Date.now();
  const jobs = [];
  for (let i = 0; i < DRAFTS; i++) {
    jobs.push(() => call(FLOOD, "POST", `/worlds/gflood_${RUN}_${i}/save`, { manifest: { meta: { title: "f" } } }));
  }
  for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map((f) => f()));
  const spent = Date.now() - t0;

  const after_ = { stats: await p50("/api/public/stats"), worlds: await p50("/api/public/worlds"), health: await p50("/health") };

  // Nothing a public caller can see has changed: the drafts are invisible.
  const cards = JSON.parse((await call(null, "GET", "/api/public/worlds")).text);
  assert.equal(cards.count, 1, "the public catalogue is still one world");

  const growth = after_.stats / Math.max(before_.stats, 0.5);
  assert.ok(
    growth < 5,
    `an ordinary account spent ${spent} ms creating ${DRAFTS} invisible draft worlds and the anonymous ` +
    `/api/public/stats went from ${before_.stats.toFixed(1)} ms to ${after_.stats.toFixed(1)} ms ` +
    `(${growth.toFixed(1)}x); /api/public/worlds went ${before_.worlds.toFixed(1)} -> ${after_.worlds.toFixed(1)} ms, ` +
    `while /health stayed at ${after_.health.toFixed(1)} ms, so this is the world listing and not the machine. ` +
    "FileWorldStore.list() reads every record in the directory before filtering on state, so unpublished " +
    "content nobody can see sets the price of every public page load. The store should filter before it " +
    "reads, or these endpoints should not be recomputed per request."
  );
});
