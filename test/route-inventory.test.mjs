// /health's route inventory must describe the routes that actually exist.
//
// The inventory is what a reader trusts to know what this service can do — it
// is the closest thing the API has to documentation, and it is served by the
// running process, so it reads as authoritative. It had drifted: the
// route-to-UI coverage map found four paths the frontend calls every day
// (/api/public/worlds, /api/worlds/mine, /safety/blocks, /api/auth/ensure)
// answering normally while absent from the list. Nothing forced the two to
// agree, so nothing noticed.
//
// This is the same structural fix that closed the playtest finding/repair gap:
// derive both sides from the source of truth and fail on any disagreement,
// rather than correcting today's four entries and waiting for the next four.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// server.mts is not the whole dispatcher. It hands some paths to slice handlers
// in src/cw1, and those routes were invisible to this test — which is how
// /ts/reports and the payout-KYC shell stayed out of the inventory while
// answering requests. A gate that only looks where the routes usually are will
// eventually miss the ones that moved.
const SLICES = fs.readdirSync(path.join(GB, "src", "cw1"))
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => fs.readFileSync(path.join(GB, "src", "cw1", f), "utf8"));
const SRC = fs.readFileSync(path.join(GB, "server.mts"), "utf8");

/** Every path the dispatcher can actually match, read from the routing itself. */
function routesInSource() {
  const found = new Set();
  // `url === "/thing"`
  for (const m of SRC.matchAll(/url === "(\/[^"]*)"/g)) found.add(m[1]);
  // Slice handlers match on `path === "/thing"` instead.
  for (const src of SLICES) {
    for (const m of src.matchAll(/path === "(\/[^"]*)"/g)) found.add(m[1]);
  }
  // `url.match(/^\/a\/([^/]+)\/b$/)` -> /a/:id/b
  //
  // Anchored on the closing `$/)` rather than "up to the first )", because
  // `([^/]+)` contains a `)` — a non-greedy stop truncated every parameterised
  // route, which made all eighteen of them look like phantoms advertised by a
  // dispatcher that did not serve them. The failure pointed at the wrong side.
  for (const m of SRC.matchAll(/url\.match\(\/\^(.*?)\$\/\)/g)) {
    const pattern = m[1]
      // An optional legacy prefix — `(?:\/api)?\/atlas\/receipt\/...` — is one
      // route reachable at two paths, not an unparseable pattern. The canonical
      // form is the one without the prefix.
      .replace(/\(\?:[^)]*\)\?/g, "")
      .replace(/\\\//g, "/")
      .replace(/\(\[\^\/\]\+\)/g, ":id")
      .replace(/\(\\d\+\)/g, ":n");
    if (pattern.startsWith("/") && !/[[\](){}|*+?\\]/.test(pattern)) found.add(pattern);
  }
  return found;
}

/**
 * Every path /health advertises — read from a RUNNING server, not from source.
 *
 * The retired list is built by calling retiredSocialRoutes(), so a source scan
 * cannot see what it returns and reported six correctly-retired routes as
 * unadvertised. Asking the server is also simply the more truthful question:
 * what this test is about is what a caller reading /health is told.
 */
async function routesAdvertised() {
  const port = 8700 + Math.floor(Math.random() * 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-inv-"));
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB,
    env: {
      ...process.env, PORT: String(port), DCS_DATA_DIR: dir,
      DCS_AUTH_SECRET: "route-inventory-test-secret",
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PROVIDERS_OFFLINE: "1",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", () => {});
  try {
    let health = null;
    for (let i = 0; i < 200; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) { health = await r.json(); break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(health, "the server must come up so its advertisement can be read");
    const found = new Set();
    const retired = new Set();
    for (const [group, list] of Object.entries(health.routes || {})) {
      if (group === "retired") for (const e of list) {
        const m = /^[A-Z]+ (\S+)/.exec(String(e));
        if (m) retired.add(m[1]);
      }
    }
    for (const list of Object.values(health.routes || {})) {
      for (const entry of list) {
        const m = /^[A-Z]+ (\S+)/.exec(String(entry));
        if (m) found.add(m[1]);
      }
      // Prose entries in the retired list describe groups of gone routes and
      // name no single path; the brace form is expanded so both spellings match.
      for (const entry of list) {
        const braces = /^[A-Z]+ (\S*)\{([^}]+)\}(\S*)/.exec(String(entry));
        if (braces) for (const alt of braces[2].split(",")) found.add(braces[1] + alt.trim() + braces[3]);
      }
    }
    return { all: found, retired };
  } finally {
    try { p.kill("SIGKILL"); } catch { /* gone */ }
  }
}

/** Paths that are deliberately not advertised, and why. */
const NOT_ADVERTISED = {
  "/": "the root is not an API surface",
  "/favicon.ico": "browser noise, not a capability",
};

test("HEALTH GATE: every routable path is either advertised or explicitly exempt", async () => {
  const inSource = routesInSource();
  const { all: advertised } = await routesAdvertised();

  const missing = [];
  for (const p of inSource) {
    if (NOT_ADVERTISED[p]) continue;
    // A path is advertised if it appears, or if a parameterised form of it does.
    // A retired entry may cover a whole prefix — "ALL /friends/* on the legacy
    // identity slice" retires /friends and everything under it, and demanding
    // an exact match reported six correctly-retired routes as unadvertised.
    const norm = (x) => x.replace(/:[a-z]+/g, ":id");
    const shown = [...advertised].some((a) =>
      a === p ||
      norm(a) === norm(p) ||
      (a.endsWith("/*") && (p === a.slice(0, -2) || p.startsWith(a.slice(0, -1))))
    );
    if (!shown) missing.push(p);
  }
  assert.deepEqual(missing.sort(), [],
    `these routes answer but /health does not list them, so the inventory is lying:\n  ${missing.sort().join("\n  ")}`);
});

test("HEALTH GATE: nothing is advertised that no longer exists", async () => {
  // The opposite drift: a route removed from the dispatcher but left in the
  // inventory promises a capability that is gone.
  const inSource = routesInSource();
  const { all: advertised, retired } = await routesAdvertised();
  // The retired list also carries prose entries describing groups of gone
  // routes ("{start,confirm} on the legacy identity slice"), which name no
  // single path and must not be read as a promise of one.
  const RETIRED_ON_PURPOSE = /410|marketplace|payouts|revenue|[{}]/;

  // Routes the dispatcher matches by SEGMENT rather than by a whole-path
  // comparison — `seg[0]==="ts" && seg[1]==="reports" && seg[3]==="action"` —
  // which no static scan of string equality can see. Listed by name so the
  // exemption is a decision rather than a hole, and each was probed live.
  const MATCHED_BY_SEGMENT = new Set([
    "/ts/reports/:id/action",
    "/ts/reports/:id/appeal/decide",
  ]);

  const phantom = [];
  for (const a of advertised) {
    if (RETIRED_ON_PURPOSE.test(a)) continue;
    // A retirement is not a promise of a live route, and a `/prefix/*` entry
    // names a group rather than a path.
    if (retired.has(a) || a.includes("*")) continue;
    if (MATCHED_BY_SEGMENT.has(a)) continue;
    const exists = [...inSource].some((p) => p === a || p.replace(/:[a-z]+/g, ":id") === a.replace(/:[a-z]+/g, ":id"));
    if (!exists) phantom.push(a);
  }
  assert.deepEqual(phantom.sort(), [],
    `these are advertised but nothing routes them:\n  ${phantom.sort().join("\n  ")}`);
});
