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
import path from "node:path";
import { fileURLToPath } from "node:url";

const GB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(GB, "server.mts"), "utf8");

/** Every path the dispatcher can actually match, read from the routing itself. */
function routesInSource() {
  const found = new Set();
  // `url === "/thing"`
  for (const m of SRC.matchAll(/url === "(\/[^"]*)"/g)) found.add(m[1]);
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

/** Every path /health advertises, read from the literal the handler returns. */
function routesAdvertised() {
  const start = SRC.indexOf("routes:");
  assert.ok(start > 0, "the /health handler must still advertise a routes block");
  const slice = SRC.slice(start, start + 12000);
  const found = new Set();
  for (const m of slice.matchAll(/"([A-Z]+) (\/[^"\s]*)/g)) found.add(m[2]);
  return found;
}

/** Paths that are deliberately not advertised, and why. */
const NOT_ADVERTISED = {
  "/": "the root is not an API surface",
  "/favicon.ico": "browser noise, not a capability",
};

test("HEALTH GATE: every routable path is either advertised or explicitly exempt", () => {
  const inSource = routesInSource();
  const advertised = routesAdvertised();

  const missing = [];
  for (const p of inSource) {
    if (NOT_ADVERTISED[p]) continue;
    // A path is advertised if it appears, or if a parameterised form of it does.
    const shown = [...advertised].some((a) => a === p || a.replace(/:[a-z]+/g, ":id") === p.replace(/:[a-z]+/g, ":id"));
    if (!shown) missing.push(p);
  }
  assert.deepEqual(missing.sort(), [],
    `these routes answer but /health does not list them, so the inventory is lying:\n  ${missing.sort().join("\n  ")}`);
});

test("HEALTH GATE: nothing is advertised that no longer exists", () => {
  // The opposite drift: a route removed from the dispatcher but left in the
  // inventory promises a capability that is gone.
  const inSource = routesInSource();
  const advertised = routesAdvertised();
  // The retired list also carries prose entries describing groups of gone
  // routes ("{start,confirm} on the legacy identity slice"), which name no
  // single path and must not be read as a promise of one.
  const RETIRED_ON_PURPOSE = /410|marketplace|payouts|revenue|[{}]/;

  const phantom = [];
  for (const a of advertised) {
    if (RETIRED_ON_PURPOSE.test(a)) continue;
    const exists = [...inSource].some((p) => p === a || p.replace(/:[a-z]+/g, ":id") === a.replace(/:[a-z]+/g, ":id"));
    if (!exists) phantom.push(a);
  }
  assert.deepEqual(phantom.sort(), [],
    `these are advertised but nothing routes them:\n  ${phantom.sort().join("\n  ")}`);
});
