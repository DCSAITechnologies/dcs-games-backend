#!/usr/bin/env node
// Route-to-UI coverage map (governing order, section 8).
//
// Two questions, both of which have a wrong answer that is invisible from
// either side alone:
//
//   1. Which backend capabilities does no UI ever call?  A route nobody can
//      reach is work that shipped to nobody.
//   2. Which paths does the UI call that the backend does not serve?  That is
//      a dead button — it looks live, and it fails only when a user presses it.
//
// Backend routes come from the deployed service's own /health advertisement,
// which carries methods, rather than from a regex over server.mts: the point is
// to check what is RUNNING, not what the source appears to say.
//
//   STAGE_URL=... SITE_DIR=... node scripts/route-ui-coverage.mjs
import fs from "node:fs";
import path from "node:path";

const STAGE = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const SITE = process.env.SITE_DIR || "/Users/NEWUSER/Desktop/Project DCSAI/dcs-games-LIVE";

const health = await (await fetch(STAGE + "/health")).json();

/** Every advertised route, as {method, path, group, retired}. */
const routes = [];
for (const [group, list] of Object.entries(health.routes || {})) {
  for (const entry of list) {
    const m = /^([A-Z]+)\s+(\S+)(.*)$/.exec(String(entry));
    if (!m) continue;
    routes.push({ method: m[1], path: m[2], group, retired: group === "retired" || /410/.test(m[3] || "") });
  }
}

// ------------------------------------------------------ what the UI asks for

/** Read every file the site could issue a request from. */
function siteFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...siteFiles(p));
    else if (/\.(html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Paths appear as string literals next to an API base or a helper. Rather than
// try to parse every call shape, collect every string literal that looks like
// an API path and let the matcher decide — a false positive shows up as an
// "unmatched" line a human can dismiss, while a missed call would silently
// under-report coverage, which is the more dangerous error.
const PATH_LITERAL = /["'`](\/(?:api\/|v3\/|worlds\/|me\/|social\/|safety\/|atlas\/|verify|profiles\/|health)[^"'`\s]*)["'`]/g;

const asked = new Map();        // path-shape -> Set(files)
/**
 * Strip comments before looking for paths.
 *
 * Without this the map reports paths that appear only in prose. `/atlas/verify`
 * showed up as a dead button when in fact dcs-truth.js had already REPLACED it
 * and the string survived only in the comment explaining why — "the previous
 * implementation posted to /atlas/verify, which has never existed". Reporting
 * a fixed defect as an open one is its own kind of dishonest map.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments, and HTML comments below
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")        // whole-line // comments
    .replace(/([^:"'`])\/\/[^\n"'`]*$/gm, "$1"); // trailing // comments, but not "https://"
}

for (const file of siteFiles(SITE)) {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  for (const m of src.matchAll(PATH_LITERAL)) {
    const raw = m[1].split("?")[0].replace(/\$\{[^}]*\}/g, ":id");
    if (!asked.has(raw)) asked.set(raw, new Set());
    asked.get(raw).add(path.relative(SITE, file));
  }
}

/** Does an advertised route pattern match a concrete path the UI asks for? */
function matches(routePath, askedPath) {
  // server.mts rewrites /api/* to /* for everything except /api/public/*, so
  // `/api/worlds/mine` and `/worlds/mine` are the same route reached two ways.
  const asked = askedPath.startsWith("/api/") && !askedPath.startsWith("/api/public/")
    ? askedPath.slice(4)
    : askedPath;
  const rp = routePath.split("/").filter(Boolean);
  const ap = asked.split("/").filter(Boolean);
  if (rp.length !== ap.length) return false;
  return rp.every((seg, i) => seg.startsWith(":") || ap[i] === ":id" || seg === ap[i]);
}

const live = routes.filter((r) => !r.retired);

// A path the UI builds by concatenation — `API + "/v3/worlds/" + id + "/edit"`
// — arrives here as the bare prefix `/v3/worlds/`. Treating that as a dead
// button would be an artefact of how the literal was written, not a finding.
const isPrefix = (p) => p.endsWith("/");
const reachedBy = new Map(live.map((r) => [`${r.method} ${r.path}`, new Set()]));
const unmatched = [];

for (const [askedPath, files] of asked) {
  let hit = false;
  for (const r of live) {
    const m = isPrefix(askedPath)
      ? (r.path.startsWith(askedPath) || r.path.startsWith(askedPath.replace(/^\/api/, "")))
      : matches(r.path, askedPath);
    if (m) { hit = true; for (const f of files) reachedBy.get(`${r.method} ${r.path}`).add(f); }
  }
  if (!hit) unmatched.push({ askedPath, files: [...files] });
}

// Advertisement is not the same as existence. Probe every apparently-dead path
// against the running service before calling it dead: a route that answers but
// is missing from /health's inventory is a DIFFERENT defect — the inventory is
// lying — and reporting it as a dead button would send someone to fix the UI
// for a backend documentation bug.
for (const u of unmatched) {
  if (isPrefix(u.askedPath)) { u.verdict = "prefix"; continue; }
  try {
    const r = await fetch(STAGE + u.askedPath, { method: "GET" });
    const body = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* html or empty */ }
    // The catch-all 404 names the path it could not route; a handler's 404 does
    // not. That is how "no such route" is told apart from "no such object".
    const unrouted = r.status === 404 && parsed && typeof parsed.path === "string";
    u.status = r.status;
    u.verdict = unrouted ? "absent" : (r.status === 401 || r.status === 403) ? "exists (auth required)" : "exists (unadvertised)";
  } catch (e) {
    u.verdict = "probe failed: " + String(e.message).slice(0, 60);
  }
}

const unreached = live.filter((r) => reachedBy.get(`${r.method} ${r.path}`).size === 0);

// ------------------------------------------------------------------- report

console.log(`# Route-to-UI coverage\n`);
console.log(`Backend: ${STAGE}`);
console.log(`Build:   ${health.build?.commit?.slice(0, 12) || "unstamped"} (deployment ${health.build?.deployment_id || "?"})`);
console.log(`Site:    ${SITE}`);
console.log(`\n${live.length} live routes, ${routes.length - live.length} retired, ${asked.size} distinct paths requested by the UI.\n`);

const prefixes = unmatched.filter((u) => u.verdict === "prefix");
const absent = unmatched.filter((u) => u.verdict === "absent");
const unadvertised = unmatched.filter((u) => String(u.verdict).startsWith("exists"));

console.log(`## Dead buttons — the UI calls a path the backend genuinely does not serve (${absent.length})\n`);
if (!absent.length) console.log("None.\n");
for (const u of absent.sort((a, b) => a.askedPath.localeCompare(b.askedPath))) {
  console.log(`- \`${u.askedPath}\` (HTTP ${u.status}) — ${u.files.slice(0, 4).join(", ")}${u.files.length > 4 ? ` (+${u.files.length - 4} more)` : ""}`);
}

console.log(`\n## Unadvertised — the route answers, but /health does not list it (${unadvertised.length})\n`);
if (!unadvertised.length) console.log("None.\n");
else console.log("The route inventory is what a reader trusts to know what exists. These work and are absent from it.\n");
for (const u of unadvertised.sort((a, b) => a.askedPath.localeCompare(b.askedPath))) {
  console.log(`- \`${u.askedPath}\` — ${u.verdict}, HTTP ${u.status} — ${u.files.slice(0, 3).join(", ")}`);
}

if (prefixes.length) {
  console.log(`\n<!-- ${prefixes.length} path prefixes built by concatenation, matched by prefix: ${prefixes.map((p) => p.askedPath).join(", ")} -->`);
}

console.log(`\n## Unreached capability — a live route no page ever calls (${unreached.length})\n`);
if (!unreached.length) console.log("None.\n");
const byGroup = {};
for (const r of unreached) (byGroup[r.group] ||= []).push(`${r.method} ${r.path}`);
for (const [g, rs] of Object.entries(byGroup)) {
  console.log(`### ${g} (${rs.length})`);
  for (const r of rs.sort()) console.log(`- \`${r}\``);
  console.log("");
}

console.log(`## Reached (${live.length - unreached.length})\n`);
for (const r of live) {
  const files = reachedBy.get(`${r.method} ${r.path}`);
  if (files.size) console.log(`- \`${r.method} ${r.path}\` <- ${[...files].slice(0, 3).join(", ")}${files.size > 3 ? ` (+${files.size - 3})` : ""}`);
}
