// Browser compatibility, small-viewport reflow, motion/contrast preferences and
// backend-failure honesty for the five V3 document pages.
//
// a11y-pages.test.mjs asks whether create-v3 and explore-v3 are legible and
// operable in a modern Chrome at a desktop width. This file asks four different
// questions of all five pages:
//
//   1. Does anything here need an engine newer than the estate's floor, or use a
//      CSS feature that silently no-ops rather than failing loudly? A property
//      that no-ops is worse than one that errors: nobody finds out.
//   2. Does the page still work at 320 CSS px — the narrowest realistic phone —
//      and at 200% zoom, without a second scroll axis? (WCAG 1.4.10.)
//   3. Is prefers-reduced-motion honoured, and does the page survive Windows
//      high contrast, where every authored colour is thrown away?
//   4. And the one that matters most: when the backend is empty, unauthorised,
//      broken or simply not there, does the page SAY so — or does it render a
//      confident empty state over a server that actually failed? A page that
//      reports "no worlds yet" when the request 500'd is a lie with a layout.
//
// What is pinned here is what was measured broken on 6 Sep 2026:
//
//   - explore-v3 threw a TypeError reading w.stats.plays off a world record the
//     server sent without a stats block. The throw was inside .map(), so the
//     whole feed died and the grid sat on "Loading…" forever: neither loaded nor
//     failed, and aria-busy already flipped to false
//   - profile-v3 printed "undefined of undefined" as an achievement's progress
//     whenever the server could not compute one
//   - create-v3 painted the verdict pill REJECTED when the playtest request
//     returned 500 — a server outage rendered as a judgement on the world
//   - profile-v3 needed 507px of horizontal scrolling at a 320px viewport, and
//     history-v3 needed 477px
//   - profile-v3, social-v3 and history-v3 never loaded the shared a11y sheet at
//     all: a focused control got the browser's own 1px ring, and there was no
//     forced-colors rule anywhere on those three pages
//   - seventeen controls on social-v3 and eight on history-v3 were under 44px
//
// Every assertion is a property — no horizontal scroll at the viewport the
// browser reports, 44 CSS px, a ring that exists without the shared sheet, a
// failure that names its own status code — not a pixel count or a colour that
// will drift the next time the design moves.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { resolveSite } from "./helpers/site.mjs";
import { CONTRAST_HELPERS, belowContrastMinimum } from "./helpers/a11y-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(HERE);   // throws loudly if the frontend is absent
const WORLD = "w_compat_1";

/** The five V3 document pages, and the query each one needs to reach its work. */
const PAGES = [
  { file: "create-v3.html", qs: "", gated: true },
  { file: "explore-v3.html", qs: "", gated: false },
  { file: "profile-v3.html", qs: "", gated: false },
  { file: "social-v3.html", qs: "", gated: false },
  { file: "history-v3.html", qs: "?world=" + WORLD, gated: true },
];

const haveSite = PAGES.every((p) => fs.existsSync(path.join(SITE, p.file)));
const haveChrome = !!findChrome();
const srcOpts = { skip: !haveSite ? "the V3 pages were not found" : false };
const opts = { skip: srcOpts.skip || (!haveChrome ? "no Chrome binary" : false) };

// ------------------------------------------------------------------ fixtures
//
// Deliberately not uniform. Two of these records are complete and three are
// partial in ways a real server legitimately produces — a world with no stats
// block yet, a version with no label, an achievement whose progress cannot be
// computed. A page that only ever sees a perfect body has not been tested.

const FULL = {
  "/api/worlds/mine": { ok: true, owner: "u_compat", worlds: [] },
  "/v3/discover": {
    ok: true, note: "Ranking uses measured plays only.",
    worlds: [
      { world_id: "w_compat_1", title: "Nordic Port", genre: "adventure", world_version: 3, atlas_signed: true,
        thumbnail_ref: null, thumbnail_uri: null, thumbnail_is_placeholder: true,
        stats: { plays: 12, rating_avg: 4.2, unique_players: 5 } },
      { world_id: "w_compat_2", title: "Neon Block", genre: "scifi", world_version: 1, atlas_signed: false,
        thumbnail_ref: null, thumbnail_uri: null, thumbnail_is_placeholder: false,
        stats: { plays: 0, rating_avg: null, unique_players: 0 } },
      // No stats block at all. This is the record that killed the feed.
      { world_id: "w_compat_3", title: "Sparse", genre: null, world_version: 2, atlas_signed: false },
    ],
  },
  "/v3/providers": { ok: true, lanes: [{ lane: "world", adapters: [{ name: "adapter-a", status: "AVAILABLE", is_fallback: false }] }] },
  // The internal-tester gate's predicate. It moved from GET /api/worlds/mine —
  // which only proves the caller is signed in — to this, which goes through
  // mustBeInternalTester() on the server. A fixture that keeps answering the
  // old one leaves the gate closed over every test behind it.
  "/v3/subscriptions/grants": { ok: true, grants: [], note: "Money is dark; nothing is purchasable." },
  // The creator's own generation-job list, added to create-v3 when GET /v3/jobs
  // stopped being a live route no page called. One job in each of the states a
  // real list contains, including one interrupted by a restart.
  "/v3/jobs": { ok: true, jobs: [
    { job_id: "j_done", state: "done", world_id: "w_compat_1", progress: 1, created_at: "2026-09-01T00:00:00Z", elapsed_ms: 4200 },
    { job_id: "j_run", state: "running", progress: 0.4, created_at: "2026-09-02T00:00:00Z" },
    // No progress and no world: the record a restart leaves behind.
    { job_id: "j_lost", state: "interrupted", created_at: "2026-09-03T00:00:00Z" },
  ] },
  "/v3/subscriptions/plans": { ok: true, purchasable: false, payments_live: false, plans: [] },
  "/v3/subscriptions/assert-dark": { ok: true, payments_live: false, purchasable: false },
  "/v3/marketplace": { ok: true, payments_live: false, purchasable: false, listings: [],
                       note: "The marketplace is dark: nothing is purchasable and no money has moved." },
  "/v3/marketplace/owned": { ok: true, items: [] },
  "/v3/marketplace/ledger": { ok: true, entries: [], note: "No money has moved." },
  "/v3/marketplace/split": { ok: true, splits: [], payments_live: false },
  "/social/orgs": { ok: true, orgs: [] },
  "/social/studios": { ok: true, studios: [] },
  "/safety/reports": { ok: true, reports: [] },
  "/safety/moderation-history": { ok: true, events: [] },
  "/safety/age": { ok: true, age_bracket: null, note: "No age has been recorded for this account." },
  "/safety/consent/parental": { ok: true, consent: null },
  "/safety/consent/media": { ok: true, consent: null },
  "/me/profile": {
    ok: true, principal_id: "u_compat", username: "tester", display_name: "Compat Tester",
    created_at: "2026-01-02T03:04:05Z", avatar_color: "#2563ff", level: "verified_builder", is_internal_tester: true,
    xp: 1200, worlds_created: 3, worlds_published: 1, publish_credits: 5, publish_credits_unlimited: false,
    can_publish: { allowed: true, remaining: 4, unlimited: false, reason: null },
    economy: { payments_live: false, balance_minor: null, dcs_plus: false, note: "Money is disabled." },
    level_signals: { email_verified: true, phone_verified: false, atlas_score: 52, dcs_plus: false, active_players: 11, reports: 0, is_studio: false },
  },
  // GET /profiles/:username — the PUBLIC read of an account, shown on
  // profile-v3 beside "if a field is not here, nobody else can see it".
  // Deliberately narrower than /me/profile: a stranger sees no email and no
  // principal id, and the page's claim is only true if the fixture is too.
  "/profiles/tester": { ok: true, username: "tester", display_name: "Compat Tester", avatar_color: "#2563ff",
                        level: "verified_builder", worlds_published: 1, created_at: "2026-01-02T03:04:05Z" },
  "/verify/status": {
    ok: true, email_verified: true, phone_verified: false, trustworthy: false, dev_mode_verifications: ["email"],
    providers: { channels: { email: { provider: "none", status: "UNAVAILABLE" } }, note: "No delivery provider is configured." },
  },
  "/me/achievements": {
    ok: true, unlocked: 1, total: 3,
    achievements: [
      { key: "a1", name: "First world", description: "Create a world", unlocked: true, progress: 1, target: 1, progress_text: "1 of 1", metric: "worlds_created" },
      { key: "a2", name: "Ten plays", description: "Get ten sessions", unlocked: false, progress: 2, target: 10, progress_text: "2 of 10", metric: "plays" },
      // Neither progress nor target. This is the record that printed "undefined of undefined".
      { key: "a3", name: "Uncounted", description: "Not yet computable", unlocked: false, metric: "unknown" },
    ],
  },
  "/me/streak": { ok: true, current: 2, longest: 5, played_today: true, days: ["2026-09-05", "2026-09-06"], note: "" },
  "/me/dashboard": {
    ok: true,
    worlds: [
      { world_id: WORLD, title: "Nordic Port", state: "published", versions: 3, recommendation: "", stats: { plays: 12, unique_players: 5, rating_avg: 4.2 } },
      { world_id: "w_compat_2", title: "Neon Block", state: "draft" },
    ],
    totals: { plays: 12, players: 5, seconds: 900 }, revenue: null, revenue_note: "No sale can occur.",
  },
  "/me/subscription": {
    ok: true, plan: "dcs_plus", status: "active", active_grant: true, comped: true, test_mode: true, paid: false,
    price_minor: 0, granted_by: "u_founder", granted_at: "2026-09-01T00:00:00Z", expires_at: "2026-09-30T00:00:00Z",
    expired: false, payments_live: false, note: "Comped for internal testing.",
  },
  "/me/entitlements": {
    ok: true, dcs_plus_effective: true, dcs_plus_paid: false, plan: "dcs_plus", plan_name: "DCS Plus",
    entitlements: [
      { key: "worlds.publish", name: "Publish worlds", value: 10, remaining: 9, unlimited: false, enforced_by: "publishGate()" },
      { key: "worlds.slots", name: "World slots", unlimited: true },
    ],
    withheld: [{ key: "marketplace.sell", why: "Money is disabled during controlled internal testing." }],
    list_price_minor: null, price_note: "No price has been set.", note: "",
  },
  "/safety/blocks": { ok: true, blocked: ["u_blocked_1"] },
  "/social/friends": {
    ok: true,
    friends: [{ id: "u_friend_1", since: "2026-08-01T00:00:00Z" }],
    incoming: [{ id: "u_in_1", at: "2026-09-01T00:00:00Z" }],
    outgoing: [{ id: "u_out_1" }],
  },
  "/social/parties": {
    ok: true,
    parties: [
      { id: "p_1", open: true, size: 2, max_size: 4, leader_id: "u_compat", world_id: WORLD, members: ["u_compat", "u_friend_1"] },
      { id: "p_2", open: false, leader_id: "u_compat", members: [] },
    ],
  },
  "/social/teams": {
    ok: true,
    teams: [
      { id: "t_1", name: "Northsiders", owner_id: "u_compat", members: [{ member_id: "u_friend_1", role: "member" }] },
      { id: "t_2", name: "Solo" },
    ],
  },
  [`/v3/worlds/${WORLD}/versions`]: {
    ok: true,
    versions: [
      { version: 1, label: "initial", created_by: "u_compat", created_at: "2026-08-01T00:00:00Z", manifest_hash: "abc123def4567890abcdef" },
      // No label, no author, no hash: retained, but nothing was recorded about it.
      { version: 2, created_at: "2026-08-15T00:00:00Z" },
      { version: 3, label: "hospital district", created_by: "u_compat", created_at: "2026-09-01T00:00:00Z", manifest_hash: "fff111222333444555666" },
    ],
  },
  [`/v3/worlds/${WORLD}/memory`]: {
    ok: true, chronology: [{ world_version: 1 }, { world_version: 3 }],
    timeline: [
      { world_version: 1, events: [{ kind: "created", summary: "World created", at: "2026-08-01T00:00:00Z" }] },
      { world_version: 3, events: [
        { kind: "expanded", summary: "Added a hospital district", at: "2026-09-01T00:00:00Z" },
        { kind: "a_kind_this_page_has_no_label_for", summary: "Something the page does not have a noun for" },
      ] },
    ],
  },
};

/** A real, successful, genuinely empty backend. Not a failure. */
const EMPTY = {
  "/api/worlds/mine": { ok: true, owner: "u_compat", worlds: [] },
  "/v3/discover": { ok: true, worlds: [] },
  "/v3/providers": { ok: true, lanes: [] },
  "/v3/subscriptions/grants": { ok: true, grants: [] },
  "/v3/jobs": { ok: true, jobs: [] },
  "/v3/subscriptions/plans": { ok: true, purchasable: false, payments_live: false, plans: [] },
  "/v3/subscriptions/assert-dark": { ok: true, payments_live: false, purchasable: false },
  "/v3/marketplace": { ok: true, payments_live: false, purchasable: false, listings: [] },
  "/v3/marketplace/owned": { ok: true, items: [] },
  "/v3/marketplace/ledger": { ok: true, entries: [] },
  "/v3/marketplace/split": { ok: true, splits: [], payments_live: false },
  "/social/orgs": { ok: true, orgs: [] },
  "/social/studios": { ok: true, studios: [] },
  "/safety/reports": { ok: true, reports: [] },
  "/safety/moderation-history": { ok: true, events: [] },
  "/safety/age": { ok: true, age_bracket: null },
  "/safety/consent/parental": { ok: true, consent: null },
  "/safety/consent/media": { ok: true, consent: null },
  "/me/profile": { ok: true, principal_id: "u_compat", username: "tester", level: "free", level_signals: {}, can_publish: {}, economy: {} },
  "/verify/status": { ok: true, providers: {} },
  "/me/achievements": { ok: true, achievements: [] },
  "/me/streak": { ok: true, days: [] },
  "/me/dashboard": { ok: true, worlds: [], totals: {} },
  "/me/subscription": { ok: true, status: "none" },
  "/me/entitlements": { ok: true, entitlements: [], withheld: [] },
  "/safety/blocks": { ok: true, blocked: [] },
  "/social/friends": { ok: true, friends: [], incoming: [], outgoing: [] },
  "/social/parties": { ok: true, parties: [] },
  "/social/teams": { ok: true, teams: [] },
  "/profiles/tester": { ok: true, username: "tester", display_name: null, level: "free", worlds_published: 0 },
  [`/v3/worlds/${WORLD}/versions`]: { ok: true, versions: [] },
  [`/v3/worlds/${WORLD}/memory`]: { ok: true, chronology: [], timeline: [] },
};

let site, api, browser, page, deadPort;
let MODE = "data";
/** Paths a page asked for that the fixtures above do not define. See stubApi. */
let unstubbed = [];

function stubApi() {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "*",
      });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const url = (req.url || "").split("?")[0];
    // "Everything 401" and "everything 500" mean everything, the internal gate
    // included. A gate that stays open when its own check fails is not a gate.
    if (MODE === "401") return send(401, { ok: false, error: "unauthorized", detail: "Your session has expired." });
    if (MODE === "500") return send(500, { ok: false, error: "internal_error", detail: "The database is unreachable." });
    // gate-open mode: the ownership check succeeds and everything else 500s, so
    // the surfaces BEHIND the gate get their failure paths exercised too.
    if (MODE === "gate-open-500") {
      // Whatever the gate's predicate is, THIS is the endpoint that has to
      // succeed — everything else 500s. It was /api/worlds/mine alone; the gate
      // then moved to /v3/subscriptions/grants, this mode kept opening the old
      // one, the gate closed, and two tests failed reporting that create-v3 had
      // no #verdict element — which it does, behind a gate that had shut.
      if (url === "/v3/subscriptions/grants") return send(200, FULL["/v3/subscriptions/grants"]);
      if (url === "/api/worlds/mine") return send(200, FULL["/api/worlds/mine"]);
      return send(500, { ok: false, error: "internal_error", detail: "The database is unreachable." });
    }
    const table = MODE === "empty" ? EMPTY : FULL;
    if (Object.prototype.hasOwnProperty.call(table, url)) return send(200, table[url]);
    // A path the fixture does not define is recorded BY NAME. In the "data" and
    // "empty" modes the whole premise is a backend that answered, so a 404 here
    // means the page grew a call the fixture never followed — and the page then
    // renders a failure the test reads as the page's own fault. Drift has to
    // accuse itself; the alternative is a mute timeout, which is how a gate that
    // had moved its predicate cost ten tests and no explanation.
    if (MODE === "data" || MODE === "empty") unstubbed.push(`${req.method} ${url}`);
    return send(404, { ok: false, error: "not_found", detail: "No such endpoint." });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    r({ url: `http://127.0.0.1:${a.port}`, close: () => new Promise((x) => server.close(x)) });
  }));
}

/** A port nothing is listening on, so a fetch to it is refused rather than hung. */
function reservedDeadPort() {
  return new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

before(async () => {
  if (opts.skip) return;
  site = await serveStatic(SITE);
  api = await stubApi();
  deadPort = await reservedDeadPort();
  browser = await launchChrome();
  page = await Page.open(browser);
  // A headless tab is not the focused window, and :focus does NOT match in an
  // unfocused document — el.focus() would move activeElement while the ring
  // stayed off, and every focus assertion below would be measuring nothing.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
});

after(async () => {
  if (page) await page.close();
  if (browser) await browser.close();
  if (site) await site.close();
  if (api) await api.close();
});

// ------------------------------------------------------------ page mechanics

const COLLECTORS = `
  window.__rejections = []; window.__windowErrors = []; window.__consoleErrors = [];
  addEventListener("unhandledrejection", function (e) {
    window.__rejections.push(String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
  });
  addEventListener("error", function (e) { window.__windowErrors.push(String(e.message)); });
  (function (orig) {
    console.error = function () {
      window.__consoleErrors.push(Array.prototype.map.call(arguments, String).join(" "));
      return orig.apply(console, arguments);
    };
  })(console.error);
`;

/** Point the next navigation at a backend, and install the collectors. */
async function useBackend(mode) {
  MODE = mode;
  unstubbed = [];
  const base = mode === "refused" ? `http://127.0.0.1:${deadPort}` : api.url;
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.DCS_API_BASE=${JSON.stringify(base)}; window.DCS_ACCESS_TOKEN="compat-test-token";` + COLLECTORS,
  });
}

async function open(p, { waitMs = 1400 } = {}) {
  await page.goto(site.url + "/" + p.file + p.qs, { waitMs });
}

const HELPERS = `
  function _vis(el){
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    var b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }
  function _desc(el){
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.className && typeof el.className === "string") s += "." + el.className.trim().split(/\\s+/).join(".");
    var t = (el.textContent || el.value || el.placeholder || "").trim().slice(0, 30);
    return t ? s + ' "' + t + '"' : s;
  }
  function _ownText(el){
    var t = "";
    for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].nodeValue;
    return t;
  }
  var _CONTROLS = 'a[href],button,input,select,textarea,[role="button"]';
  function _controls(){
    var out = [];
    document.querySelectorAll(_CONTROLS).forEach(function (el) {
      if (!_vis(el)) return;
      if (el.closest(".dcs-banner")) return;   // the truth banner is not this page's markup
      out.push(el);
    });
    return out;
  }
`;

/** What every page must be able to say about itself, in every backend mode. */
const REPORT = `
  ${HELPERS}
  var text = document.body ? document.body.innerText : "";
  // A placeholder on these pages is the literal string "Loading…" at the start
  // of an element's own text. Matching "loading" anywhere would also catch the
  // page copy — "That is a real zero, not a loading state" — and pass forever.
  var stillLoading = [];
  document.querySelectorAll("*").forEach(function (el) {
    if (!_vis(el)) return;
    if (/^\\s*Loading/.test(_ownText(el))) stillLoading.push(_desc(el));
  });
  var busy = [];
  document.querySelectorAll('[aria-busy="true"]').forEach(function (el) { busy.push(_desc(el)); });
  return {
    text: text,
    length: text.length,
    gated: !!document.querySelector(".dcs-gate"),
    stillLoading: stillLoading,
    ariaBusy: busy,
    rejections: window.__rejections || [],
    windowErrors: window.__windowErrors || [],
    consoleErrors: window.__consoleErrors || [],
  };
`;

/** The three strings that mean a template reached the screen with a hole in it. */
function placeholderLeaks(text) {
  const bad = [];
  if (/\bundefined\b/.test(text)) bad.push("the word 'undefined'");
  if (/\bNaN\b/.test(text)) bad.push("the word 'NaN'");
  if (text.indexOf("[object Object]") >= 0) bad.push("'[object Object]'");
  if (/\bnull\b/.test(text)) bad.push("the word 'null'");
  return bad;
}

/** Errors this page is responsible for, ignoring the offline calls we caused. */
function pageFaults(r) {
  return {
    thrown: page.realErrors(),
    rejected: r.rejections,
    onerror: r.windowErrors,
    consoled: r.consoleErrors,
  };
}
function faultSummary(f) {
  return [...f.thrown, ...f.rejected, ...f.onerror, ...f.consoled];
}

// ============================================================ source-level compat
//
// These do not need a browser. They are the features that would throw a
// SyntaxError on parse — which takes the whole inline script with it, so the
// page renders its skeleton and nothing else, with no error a user can see.

const SOURCES = () => PAGES.map((p) => ({ name: p.file, src: fs.readFileSync(path.join(SITE, p.file), "utf8") }));

/** Comments on these pages discuss the very syntax being banned, by name. */
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

const BANNED_SYNTAX = [
  ["optional chaining (?.)", /(?<![?\w])\?\.(?!\d)/],
  ["nullish coalescing (??)", /[^?]\?\?[^?]/],
  ["logical assignment (??= ||= &&=)", /(\?\?=|\|\|=|&&=)/],
  ["Array.prototype.at()", /\.at\s*\(\s*-?\d/],
  ["structuredClone()", /\bstructuredClone\s*\(/],
  ["Object.hasOwn()", /\bObject\.hasOwn\s*\(/],
  ["String.prototype.replaceAll()", /\.replaceAll\s*\(/],
  ["Array.prototype.flat/flatMap()", /\.(flat|flatMap)\s*\(/],
  ["Promise.allSettled/any()", /\bPromise\.(allSettled|any)\s*\(/],
  ["String.prototype.padStart/padEnd()", /\.(padStart|padEnd)\s*\(/],
  ["class private fields (#x)", /^\s*#[A-Za-z_$][\w$]*\s*[=;(]/m],
];

test("COMPAT: no V3 page needs a JavaScript engine newer than the one the rest of the file assumes", srcOpts, () => {
  // These files are hand-written ES5 with `var`, `function`, and IIFEs. A single
  // ES2020 operator in that context is not a style inconsistency: it is a parse
  // error that silently takes the entire inline <script> with it, leaving a page
  // that renders its markup and then does nothing, with no visible failure.
  const found = [];
  for (const { name, src } of SOURCES()) {
    const code = stripComments(src);
    for (const [feature, re] of BANNED_SYNTAX) {
      code.split("\n").forEach((line, i) => {
        if (re.test(line)) found.push(`${name}:${i + 1} uses ${feature} — ${line.trim().slice(0, 90)}`);
      });
    }
  }
  assert.deepEqual(found, [], "syntax newer than the file's own baseline");
});

test("COMPAT: no V3 page is served as a module, so nothing in it can be a top-level await", srcOpts, () => {
  // Top-level await only exists in a module, and every script on these pages is
  // a classic <script>. This is the check that keeps it that way: making one a
  // module would also defer it, and the truth layer must not be deferred.
  const problems = [];
  for (const { name, src } of SOURCES()) {
    if (/<script[^>]*type\s*=\s*["']module["']/i.test(src)) problems.push(`${name} loads a script as type="module"`);
    if (/<script[^>]*\bdefer\b[^>]*dcs-truth\.js/i.test(src) || /dcs-truth\.js[^>]*\bdefer\b/i.test(src)) {
      problems.push(`${name} loads the truth layer with defer — it must be parsed before the page's own script runs`);
    }
    if (!/<script src="\/assets\/dcs-truth\.js"><\/script>/.test(src)) {
      problems.push(`${name} does not load the truth layer as a plain, blocking script`);
    }
  }
  assert.deepEqual(problems, []);
});

test("COMPAT: every CSS feature that would silently no-op on an older engine has a fallback beside it", srcOpts, () => {
  // A CSS property an engine does not know is DROPPED, not reported. That is
  // worse than a JS error: there is no console entry, no failed request and no
  // visible symptom on the machine of whoever shipped it — only a layout that
  // is quietly wrong for somebody else.
  const problems = [];
  for (const { name, src } of SOURCES()) {
    const css = src.replace(/\/\*[\s\S]*?\*\//g, " ");
    // :has() and container queries invalidate or drop whole rules on any engine
    // before 2023. Neither belongs in a page that has to work on a two-year-old
    // phone, and neither is needed by any layout here.
    if (/:has\s*\(/.test(css)) problems.push(`${name} uses :has()`);
    if (/@container|container-type\s*:/.test(css)) problems.push(`${name} uses container queries`);
    // aspect-ratio was ignored before Chrome 88 / Safari 15. Ignored, a box with
    // no other height source collapses to nothing.
    if (/aspect-ratio\s*:/.test(css) && !/@supports\s+not\s*\(\s*aspect-ratio/.test(css)) {
      problems.push(`${name} uses aspect-ratio with no @supports fallback`);
    }
    // The inset shorthand landed with aspect-ratio; the longhands are universal.
    if (/(^|[;{\s])inset\s*:/.test(css)) problems.push(`${name} uses the inset shorthand instead of top/right/bottom/left`);
  }
  assert.deepEqual(problems, []);
});

test("COMPAT: each page defines its own focus ring in a rule no unknown pseudo-class can invalidate", srcOpts, () => {
  // A CSS selector LIST is invalid in full if any one selector in it is not
  // understood. The shared sheet groups ":focus" and ":focus-visible" into one
  // list, so an engine that predates :focus-visible (Safari 15.3 and earlier)
  // drops the whole rule and paints no ring at all. Each page therefore carries
  // its own :focus-only rule, which cannot be taken down with it.
  const problems = [];
  for (const { name, src } of SOURCES()) {
    const styles = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    const rules = styles.split("}");
    const ok = rules.some((r) => {
      const sel = r.split("{")[0] || "";
      return /:focus\b/.test(sel) && !/:focus-visible/.test(sel) && /outline\s*:/.test(r);
    });
    if (!ok) problems.push(`${name} has no :focus-only rule that paints an outline`);
  }
  assert.deepEqual(problems, [], "a page whose only focus ring is in a selector list containing :focus-visible");
});

// ================================================== the ring without the sheet

test("A ring is painted on every page even if the shared accessibility sheet never arrives", opts, async () => {
  // This is the old-engine outcome, measured without an old engine: an engine
  // that does not know :focus-visible drops the shared sheet's grouped rule
  // exactly as if the sheet had not loaded. Disabling the sheet reproduces that
  // and nothing else. Before this lane, three of these five pages fell back to
  // the browser's own 1px default here — and under forced colors, to nothing.
  for (const p of PAGES.filter((x) => !x.gated)) {
    await useBackend("data");
    await open(p);
    const r = await page.eval(`
      ${HELPERS}
      // Take the shared sheet out of the cascade, exactly as an engine that
      // cannot parse its selector list would.
      Array.prototype.forEach.call(document.styleSheets, function (s) {
        if (s.href && /dcs-a11y\\.css/.test(s.href)) s.disabled = true;
      });
      // The first FOCUSABLE control, not the first visible one. profile-v3's
      // first visible control is a disabled "Send a code" button, which cannot
      // take focus by design — focusing it left activeElement on <body> and the
      // test measured the body's outline while reporting a missing ring.
      var all = _controls();
      var el = null;
      for (var i = 0; i < all.length; i++) {
        if (all[i].disabled === true) continue;
        all[i].focus();
        if (document.activeElement === all[i]) { el = all[i]; break; }
      }
      if (!el) {
        return { none: true, tried: all.length, first: all.length ? _desc(all[0]) : null };
      }
      var cs = getComputedStyle(el);
      return {
        sel: _desc(el),
        skipped: all.indexOf(el),
        width: parseFloat(cs.outlineWidth) || 0,
        style: cs.outlineStyle,
        color: cs.outlineColor,
        isActive: document.activeElement === el,
      };
    `);
    assert.ok(!r.none,
      `${p.file}: not one of its ${r.tried} visible controls could take focus (first was ${r.first}) — a page a keyboard cannot enter at all`);
    assert.equal(r.isActive, true, `${p.file}: ${r.sel} reported focus and did not hold it`);
    assert.ok(r.width >= 2 && r.style !== "none",
      `${p.file}: with the shared sheet gone, ${r.sel} focuses with only a ${r.width}px ${r.style} outline — the page has no ring of its own`);
  }
});

// ================================================================ small screens

const PHONE_320 = { width: 320, height: 640, deviceScaleFactor: 1, mobile: true };
// 200% browser zoom on a 1280px window leaves 640 CSS px of layout. WCAG 1.4.10
// is written in CSS pixels, so emulating the width IS emulating the zoom.
const ZOOM_200 = { width: 640, height: 450, deviceScaleFactor: 1, mobile: false };

async function atViewport(metrics, p, fn) {
  await page.send("Emulation.setDeviceMetricsOverride", metrics);
  try {
    await open(p);
    // The override has to be reasserted after navigation or the page lays out at
    // the window size and every measurement below is of the wrong document.
    await page.send("Emulation.setDeviceMetricsOverride", metrics);
    await new Promise((r) => setTimeout(r, 250));
    return await fn();
  } finally {
    await page.send("Emulation.clearDeviceMetricsOverride");
  }
}

const REFLOW = `
  ${HELPERS}
  var root = document.scrollingElement || document.documentElement;
  var vw = root.clientWidth;
  var clipped = [];
  document.querySelectorAll("body *").forEach(function (el) {
    if (!_vis(el)) return;
    var b = el.getBoundingClientRect();
    // Only leaf-ish content counts: a wrapper wider than the viewport is the
    // same fact as its child, reported twice.
    if (el.children.length === 0 && (b.right > vw + 1 || b.left < -1)) {
      clipped.push(_desc(el) + " spans " + Math.round(b.left) + "→" + Math.round(b.right) + " of " + vw);
    }
  });
  var boxes = _controls().map(function (el) {
    var b = el.getBoundingClientRect();
    return { sel: _desc(el), x: b.left, y: b.top, w: b.width, h: b.height };
  });
  var overlaps = [];
  for (var i = 0; i < boxes.length; i++) for (var j = i + 1; j < boxes.length; j++) {
    var a = boxes[i], c = boxes[j];
    var ox = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x);
    var oy = Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y);
    if (ox > 2 && oy > 2) overlaps.push(a.sel + " overlaps " + c.sel);
  }
  var small = boxes
    .filter(function (b) { return b.w < 44 || b.h < 44; })
    .map(function (b) { return b.sel + " is " + Math.round(b.w) + "x" + Math.round(b.h); });
  return {
    viewport: vw, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
    clipped: clipped, overlaps: overlaps, small: small, controls: boxes.length,
  };
`;

test("REFLOW: nothing on any V3 page needs a second scroll axis at 320 CSS px", opts, async () => {
  // WCAG 1.4.10. Measured before this lane: profile-v3 wanted 507px of width
  // for a 320px viewport and history-v3 wanted 477px, both because a principal
  // id and a manifest hash are single unbreakable tokens inside a table that
  // will not shrink below its min-content width.
  for (const p of PAGES) {
    await useBackend("data");
    const r = await atViewport(PHONE_320, p, () => page.eval(REFLOW));
    assert.equal(r.viewport, 320, `${p.file}: the emulated viewport did not take, so nothing was measured`);
    assert.ok(r.controls >= 1, `${p.file}: no controls were found to measure`);
    assert.ok(r.scrollWidth <= r.clientWidth + 1,
      `${p.file}: needs ${r.scrollWidth}px of horizontal scrolling in a ${r.clientWidth}px viewport`);
    assert.deepEqual(r.clipped, [], `${p.file}: content outside the 320px viewport`);
    assert.deepEqual(r.overlaps, [], `${p.file}: controls sitting on top of each other at 320px`);
  }
});

test("REFLOW: nothing on any V3 page needs a second scroll axis at 200% zoom", opts, async () => {
  for (const p of PAGES) {
    await useBackend("data");
    const r = await atViewport(ZOOM_200, p, () => page.eval(REFLOW));
    assert.equal(r.viewport, 640, `${p.file}: the emulated viewport did not take`);
    assert.ok(r.scrollWidth <= r.clientWidth + 1,
      `${p.file}: needs ${r.scrollWidth}px of horizontal scrolling at 200% zoom (${r.clientWidth}px of layout)`);
    assert.deepEqual(r.clipped, [], `${p.file}: content outside the viewport at 200% zoom`);
    assert.deepEqual(r.overlaps, [], `${p.file}: controls sitting on top of each other at 200% zoom`);
  }
});

test("TOUCH: every control on every V3 page is a 44px target on the narrowest phone", opts, async () => {
  // WCAG 2.5.5, and the size the rest of this estate already holds itself to in
  // dcs-a11y.css. Measured before this lane: seventeen controls on social-v3 at
  // 37x—, eight on history-v3 including the two links that are the only way off
  // the page, both 24px tall.
  for (const p of PAGES) {
    await useBackend("data");
    const r = await atViewport(PHONE_320, p, () => page.eval(REFLOW));
    assert.ok(r.controls >= 1, `${p.file}: no controls were found to measure`);
    assert.deepEqual(r.small, [], `${p.file}: controls under 44 CSS px at a 320px viewport`);
  }
});

// ============================================================== preferences

test("MOTION: nothing on a V3 page still moves for a reader who asked their system for less of it", opts, async () => {
  // WCAG 2.3.3. Not "no animations exist" — "nothing takes a perceptible time to
  // change", which is the property the user actually asked for. The build bar on
  // create-v3 and the card lift on explore-v3 were the two that moved.
  for (const p of PAGES) {
    await useBackend("data");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await open(p);
    const r = await page.eval(`
      ${HELPERS}
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) return { emulated: false };
      var moving = [];
      document.querySelectorAll("body *").forEach(function (el) {
        var cs = getComputedStyle(el);
        // A duration under a frame is a state change, not a movement.
        var td = parseFloat(cs.transitionDuration) || 0;
        var ad = parseFloat(cs.animationDuration) || 0;
        var iter = cs.animationIterationCount;
        if (td > 0.016 || (ad > 0.016 && cs.animationName !== "none")) {
          moving.push(_desc(el) + " transition " + cs.transitionDuration + " animation " + cs.animationName + " " + cs.animationDuration + " x" + iter);
        }
      });
      return { emulated: true, moving: moving };
    `);
    await page.send("Emulation.setEmulatedMedia", {});
    assert.equal(r.emulated, true, `${p.file}: prefers-reduced-motion was not emulated, so nothing was measured`);
    assert.deepEqual(r.moving, [], `${p.file}: still animates under prefers-reduced-motion: reduce`);
  }
});

test("CONTRAST MODE: every V3 page keeps its words and its control edges under Windows high contrast", opts, async () => {
  // forced-colors: active throws every authored colour away and substitutes the
  // user's system palette — but it does NOT throw away background-image. A
  // gradient therefore survives with system-coloured text painted over it, which
  // is how an avatar or a progress bar becomes unreadable in exactly the mode
  // that exists to make things readable.
  for (const p of PAGES) {
    await useBackend("data");
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "active" }] });
    await open(p);
    const r = await page.eval(`
      ${HELPERS}
      if (!matchMedia("(forced-colors: active)").matches) return { emulated: false };
      var invisible = [], gradients = [];
      document.querySelectorAll("body *").forEach(function (el) {
        if (!_vis(el)) return;
        var cs = getComputedStyle(el);
        // A gradient that survives the mode has to opt out of it deliberately,
        // by saying so with forced-color-adjust. Anything else is an accident.
        if (cs.backgroundImage && cs.backgroundImage !== "none" && /gradient/.test(cs.backgroundImage) && cs.forcedColorAdjust !== "none") {
          gradients.push(_desc(el) + " keeps " + cs.backgroundImage.slice(0, 40));
        }
        if (!_ownText(el).trim()) return;
        if (cs.color === cs.backgroundColor) invisible.push(_desc(el) + " paints " + cs.color + " on " + cs.backgroundColor);
      });
      // The first FOCUSABLE control. A disabled button is visible and cannot
      // take focus, and focusing it silently measured <body>'s outline instead.
      var all = _controls(), el = null;
      for (var i = 0; i < all.length; i++) {
        if (all[i].disabled === true) continue;
        all[i].focus();
        if (document.activeElement === all[i]) { el = all[i]; break; }
      }
      var fcs = el ? getComputedStyle(el) : null;
      return {
        emulated: true, invisible: invisible, gradients: gradients,
        textLength: document.body.innerText.length,
        focusSel: el ? _desc(el) : null,
        focusWidth: fcs ? (parseFloat(fcs.outlineWidth) || 0) : 0,
        focusStyle: fcs ? fcs.outlineStyle : "none",
        focused: !!el,
        tried: all.length,
      };
    `);
    await page.send("Emulation.setEmulatedMedia", {});
    assert.equal(r.emulated, true, `${p.file}: forced-colors was not emulated, so nothing was measured`);
    assert.ok(r.textLength > 200, `${p.file}: only ${r.textLength} characters survive forced colours`);
    assert.deepEqual(r.invisible, [], `${p.file}: text painted the same colour as what is behind it under forced colours`);
    assert.deepEqual(r.gradients, [], `${p.file}: a gradient survives forced colours without opting out of the mode`);
    assert.equal(r.focused, true,
      `${p.file}: not one of its ${r.tried} visible controls could take focus under forced colours`);
    assert.ok(r.focusWidth >= 2 && r.focusStyle !== "none",
      `${p.file}: ${r.focusSel} focuses with a ${r.focusWidth}px ${r.focusStyle} ring under forced colours`);
  }
});

// ====================================================== degradation, measured

test("COMPAT: an engine that ignores flexbox gap loses spacing on these pages and nothing else", opts, async () => {
  // Flex `gap` is ignored by Safari 14.0 and earlier — silently, as CSS always
  // is. There is no honest feature query for it (grid gap and flex gap share the
  // property name and shipped a release apart), so rather than guess at a
  // detection hack this measures the actual consequence: with every gap removed,
  // do controls collide, disappear or leave the page? If the answer is no, the
  // loss is cosmetic and the pages are safe on that engine.
  for (const p of PAGES) {
    await useBackend("data");
    const r = await atViewport(PHONE_320, p, async () => {
      await page.eval(`
        var st = document.createElement("style");
        st.textContent = "*{gap:0!important;row-gap:0!important;column-gap:0!important}";
        document.head.appendChild(st);
        return true;
      `);
      await new Promise((res) => setTimeout(res, 150));
      return page.eval(REFLOW);
    });
    assert.ok(r.controls >= 1, `${p.file}: nothing measured with gap removed`);
    assert.deepEqual(r.overlaps, [], `${p.file}: without flexbox gap, controls collide`);
    assert.deepEqual(r.clipped, [], `${p.file}: without flexbox gap, content leaves the viewport`);
  }
});

test("COMPAT: explore-v3's thumbnail would collapse without aspect-ratio, which is why it carries a fallback", opts, async () => {
  // Proving the hazard is real rather than asserting it from a spec table. With
  // aspect-ratio neutralised the thumbnail has no other height source at all, so
  // every card in the feed loses its image area. The @supports block that puts a
  // padding-box back is pinned by the source-level test above; this one pins the
  // reason it has to exist.
  await useBackend("data");
  await open(PAGES[1]);
  const r = await page.eval(`
    ${HELPERS}
    var t = document.querySelector(".thumb");
    if (!t) return { none: true };
    var before = t.getBoundingClientRect().height;
    var st = document.createElement("style");
    st.textContent = ".thumb{aspect-ratio:auto!important}";
    document.head.appendChild(st);
    var after = t.getBoundingClientRect().height;
    return { before: before, after: after };
  `);
  assert.ok(!r.none, "no world card was rendered, so the thumbnail was never measured");
  assert.ok(r.before > 40, `the thumbnail is only ${r.before}px tall even with aspect-ratio applied`);
  assert.ok(r.after < r.before / 2,
    `aspect-ratio is not what gives the thumbnail its height (${r.before}px → ${r.after}px), so this test is no longer measuring the hazard it names`);
});

// ========================================== the five backends, the five pages

/**
 * The shape of an honest answer, whatever the backend did.
 * Every page, in every mode, must satisfy all of this.
 */
async function assertHonest(p, mode) {
  const r = await page.eval(REPORT);
  const faults = faultSummary(pageFaults(r));

  assert.deepEqual(faults, [], `[${mode}] ${p.file}: the page faulted`);
  assert.deepEqual(r.stillLoading, [],
    `[${mode}] ${p.file}: left on a loading placeholder — neither loaded nor failed is the one state a reader cannot act on`);
  assert.deepEqual(r.ariaBusy, [],
    `[${mode}] ${p.file}: a region is still announcing aria-busy="true"`);
  assert.deepEqual(placeholderLeaks(r.text), [],
    `[${mode}] ${p.file}: a template hole reached the screen`);
  assert.ok(r.length > 120, `[${mode}] ${p.file}: rendered only ${r.length} characters`);
  return r;
}

/**
 * Text a page only prints when IT could not draw what the server sent — a
 * render fault, not a backend fault. It is caught separately because it is the
 * one failure the backend cannot be blamed for, and because a page that catches
 * its own exception and then says nothing about it is back where it started.
 */
const SELF_INFLICTED = [/could not be drawn/i];

/** Text a page is only entitled to show when the server really answered. */
const REAL_ZERO_CLAIMS = [
  /real zero/i, /real empty/i, /Nothing published yet/i,
  /No accepted friends/i, /You are in no party/i, /You are in no team/i,
  /You have blocked nobody/i, /no requests outstanding/i,
  /No achievements are defined/i, /No days to show/i,
];

test("BACKEND 200 with data: every page renders what the server sent and faults on none of it", opts, async () => {
  for (const p of PAGES) {
    await useBackend("data");
    await open(p);
    const r = await assertHonest(p, "data");
    assert.equal(r.gated, false, `[data] ${p.file}: the gate closed on a backend that authorised the request`);
    assert.deepEqual([...new Set(unstubbed)], [],
      `[data] ${p.file}: the page called endpoints this fixture does not stub, so it was answered 404 and what follows measures a broken page rather than a working one`);
    const broke = SELF_INFLICTED.filter((re) => re.test(r.text)).map(String);
    assert.deepEqual(broke, [],
      `[data] ${p.file}: the server answered and the page could not render the answer — a record with an optional field absent is a record, not an outage`);
  }
});

test("BACKEND 200 but empty: an empty list is stated as a real zero, not left blank", opts, async () => {
  // The mirror of the failure case. A genuinely empty backend must produce
  // words, not an absence — a blank section is indistinguishable from a broken
  // one, and a reader has no way to tell which they are looking at.
  for (const p of PAGES) {
    await useBackend("empty");
    await open(p);
    const r = await assertHonest(p, "empty");
    assert.equal(r.gated, false, `[empty] ${p.file}: the gate closed on an authorised request`);
    assert.deepEqual([...new Set(unstubbed)], [],
      `[empty] ${p.file}: the page called endpoints this fixture does not stub, so it was answered 404 and what follows measures a broken page rather than a working one`);
    const broke = SELF_INFLICTED.filter((re) => re.test(r.text)).map(String);
    assert.deepEqual(broke, [], `[empty] ${p.file}: the page could not render an empty but valid response`);
    if (p.file === "create-v3.html") continue;   // the builder has nothing to list on load
    assert.ok(REAL_ZERO_CLAIMS.some((re) => re.test(r.text)),
      `[empty] ${p.file}: a genuinely empty backend produced no statement that the zero is real`);
  }
});

test("BACKEND 401: gated surfaces close and open ones name the status rather than showing an empty list", opts, async () => {
  for (const p of PAGES) {
    await useBackend("401");
    await open(p);
    const r = await assertHonest(p, "401");
    if (p.gated) {
      // FAIL CLOSED. The gate is the whole point: an unauthorised request must
      // leave the surface locked, not merely empty.
      assert.equal(r.gated, true, `[401] ${p.file}: an internal surface stayed open on a 401`);
      assert.match(r.text, /401/, `[401] ${p.file}: the gate does not report the status it was refused with`);
      continue;
    }
    assert.match(r.text, /401|expired|Sign in/i, `[401] ${p.file}: the page does not say it was refused`);
    const claims = REAL_ZERO_CLAIMS.filter((re) => re.test(r.text)).map(String);
    assert.deepEqual(claims, [],
      `[401] ${p.file}: claims a real zero over a request that was refused — a page that says "nobody has asked to be your friend" when it was never told is a lie`);
  }
});

test("BACKEND 500: every page reports the server's own status and shows nothing in its place", opts, async () => {
  for (const p of PAGES) {
    await useBackend("500");
    await open(p);
    const r = await assertHonest(p, "500");
    if (p.gated) {
      assert.equal(r.gated, true, `[500] ${p.file}: an internal surface stayed open when its own gate check failed`);
      assert.match(r.text, /500/, `[500] ${p.file}: the gate does not report the status it was refused with`);
      continue;
    }
    assert.match(r.text, /500|could not be loaded|Could not reach|unreachable/i,
      `[500] ${p.file}: a 500 produced no statement of failure`);
    const claims = REAL_ZERO_CLAIMS.filter((re) => re.test(r.text)).map(String);
    assert.deepEqual(claims, [], `[500] ${p.file}: claims a real zero over a server error`);
  }
});

test("BACKEND unreachable: a refused connection reads as a refused connection, not as an empty account", opts, async () => {
  // The mode most likely to be mistaken for success, because there is no status
  // code to print and every list is legitimately []. It is also the mode a real
  // user hits most often: a phone that lost signal mid-page.
  for (const p of PAGES) {
    await useBackend("refused");
    await open(p);
    const r = await assertHonest(p, "refused");
    if (p.gated) {
      assert.equal(r.gated, true, `[refused] ${p.file}: an internal surface stayed open when the backend was unreachable`);
      assert.match(r.text, /network error|Failed to fetch|no response/i,
        `[refused] ${p.file}: the gate does not say the backend could not be reached`);
      continue;
    }
    assert.match(r.text, /no response|Failed to fetch|could not be loaded|Could not reach/i,
      `[refused] ${p.file}: an unreachable backend produced no statement of failure`);
    const claims = REAL_ZERO_CLAIMS.filter((re) => re.test(r.text)).map(String);
    assert.deepEqual(claims, [],
      `[refused] ${p.file}: claims a real zero when nothing ever answered — the emptiest and most convincing lie on this list`);
  }
});

test("BACKEND behind an open gate: the builder and the history surface fail in their own words", opts, async () => {
  // The four modes above close the gate on create-v3 and history-v3, which is
  // correct and is also why their own failure paths never run. Here the gate's
  // ownership check succeeds and everything else 500s, so the surfaces are open
  // and the sections inside them have to report for themselves.
  for (const p of PAGES.filter((x) => x.gated)) {
    await useBackend("gate-open-500");
    await open(p);
    const r = await assertHonest(p, "gate-open-500");
    assert.equal(r.gated, false, `[gate-open-500] ${p.file}: the gate closed on a successful ownership check`);
    if (p.file === "history-v3.html") {
      assert.match(r.text, /could not be loaded/i, "history-v3 does not report the sections it failed to load");
      assert.match(r.text, /500/, "history-v3 does not quote the status it got");
    }
  }
});

test("BACKEND: a failed playtest request is never painted as a playtest verdict", opts, async () => {
  // Measured before this lane: create-v3 painted the pill REJECTED whenever the
  // playtest POST failed, and said "The world no longer passes the gate" — a
  // server outage rendered as a judgement about the creator's world. It is the
  // same class of lie as a fabricated pass, pointing the other way.
  await useBackend("gate-open-500");
  await open(PAGES[0]);
  const r = await page.eval(`
    var el = document.getElementById("verdict");
    if (!el) return { missing: true };
    // Reach the result card the way a finished build does, then ask for a
    // re-playtest against a backend that is answering 500 to everything.
    document.getElementById("result").classList.remove("hidden");
    return { ready: true };
  `);
  assert.ok(!r.missing, "create-v3 has no verdict element");
  // The page keeps worldId in closure scope and rePlaytest is a no-op without
  // one, so what is asserted here is the source contract rather than a click.
  const src = fs.readFileSync(path.join(SITE, "create-v3.html"), "utf8");
  const handler = src.slice(src.indexOf('$("rePlaytest").onclick'), src.indexOf('$("publish").onclick'));
  assert.ok(/if\s*\(\s*!r\.ok\s*\)/.test(handler),
    "the re-playtest handler does not branch on the request having failed before it paints anything");
  assert.ok(!/paintVerdict\([^)]*\|\|\s*"REJECTED"/.test(handler),
    "the re-playtest handler still defaults a missing verdict to REJECTED, which asserts a gate result the gate never produced");
  assert.ok(/says nothing about whether the world passes/.test(handler),
    "the re-playtest failure message does not separate 'the check did not run' from 'the check failed'");
});

// =========================================================== the whole estate
//
// Everything above this line asks its questions of the five V3 document pages.
// That was never the whole product: the frontend ships 190 HTML documents, and
// the other 185 — the marketing site, the player dashboard, the genre and
// marketplace pages, the studio — had never been opened by a test at all.
//
// The four properties below are the ones a person actually notices on a phone
// or with a keyboard, and each was MEASURED broken across the estate on
// 7 Sep 2026 before it was written down here:
//
//   - 52 pages laid out 557 CSS px of content inside a 320 px viewport, so a
//     third of the site had to be scrolled sideways to be read (WCAG 1.4.10).
//     Cause: .mtop-cta in assets/dcsgames.css kept all four header actions at
//     full size below the breakpoint where .mnav collapses into the burger.
//   - the burger that was supposed to replace that nav was squeezed to 21 px
//     wide by the same overflow — below any target minimum, and below the 36 px
//     the stylesheet itself asks for.
//   - 58 pages needed 19 Tab presses to reach <main> and 48 needed 6, on every
//     single navigation, because no page in the estate has a skip link
//     (WCAG 2.4.1).
//   - the dashboard search field and the homepage's primary "describe a world"
//     field had a placeholder and no accessible name (WCAG 4.1.2 / 3.3.2), and
//     the marketing burger announced itself as "☰".
//
// One navigation per page, one measurement pass, many properties. Re-visiting
// 190 pages per assertion would cost eight minutes a test and measure the same
// documents over and over.
const ESTATE = (() => {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, rel + "/" + e.name);
      else if (e.name.endsWith(".html")) out.push(rel + "/" + e.name);
    }
  };
  if (haveSite) walk(SITE, "");
  return out;
})();

// A viewport smaller than this is not a phone anyone ships. 320 CSS px is the
// width WCAG 1.4.10 names, and it is what a 320x568 iPhone SE reports.
const NARROW = { width: 320, height: 720, deviceScaleFactor: 2, mobile: true };

/** Everything measured on one page, in one visit. */
const ESTATE_PROBE = CONTRAST_HELPERS + `
  function vis(el) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    var b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }
  var CTRL = 'button,[role="button"],a[href],input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"])';
  function label(el) {
    var n = (el.getAttribute("aria-label") || "").trim();
    if (n) return n;
    var lb = el.getAttribute("aria-labelledby");
    if (lb) { var t = document.getElementById(lb); if (t && (t.innerText || "").trim()) return t.innerText.trim(); }
    if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && (l.innerText || "").trim()) return l.innerText.trim(); }
    var w = el.closest("label");
    if (w && (w.innerText || "").trim()) return w.innerText.trim();
    var ti = (el.getAttribute("title") || "").trim();
    if (ti) return ti;
    return "";
  }
  function describe(el) {
    return el.tagName.toLowerCase()
      + (el.id ? "#" + el.id : "")
      + (el.className && String(el.className).trim() ? "." + String(el.className).trim().split(/\\s+/).slice(0, 2).join(".") : "");
  }

  var doc = document.documentElement;
  var R = {
    lang: (doc.getAttribute("lang") || "").trim(),
    viewportMeta: (function () { var m = document.querySelector('meta[name="viewport"]'); return m ? m.getAttribute("content") : null; })(),
    scrollW: doc.scrollWidth,
    clientW: doc.clientWidth,
    overflowing: [],
    tiny: [],
    unlabelledFields: [],
    tabsToMain: null,
    hasMain: false,
    skipTarget: null,
    burgers: [],
  };

  // Which element is actually pushing the document wide? Report the outermost
  // one whose own parent fits, so the answer names a cause and not a symptom.
  for (var i = 0, els = document.querySelectorAll("body *"); i < els.length; i++) {
    var el = els[i];
    if (!vis(el)) continue;
    var b = el.getBoundingClientRect();
    if (b.right <= R.clientW + 1) continue;
    var pel = el.parentElement;
    if (pel && pel !== document.body) {
      var pb = pel.getBoundingClientRect();
      if (pb.right > R.clientW + 1) continue;     // the parent is the real cause
    }
    // A container that scrolls sideways on purpose is not a reflow failure;
    // only what escapes the DOCUMENT is.
    var clipped = false;
    for (var a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      var ox = getComputedStyle(a).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden") { clipped = true; break; }
    }
    if (clipped) continue;
    R.overflowing.push({ el: describe(el), w: Math.round(b.width), right: Math.round(b.right) });
    if (R.overflowing.length >= 6) break;
  }

  var controls = Array.prototype.filter.call(document.querySelectorAll(CTRL), vis);
  for (var j = 0; j < controls.length; j++) {
    var c = controls[j], cb = c.getBoundingClientRect();
    // A link inside a run of prose is sized by its text and is exempt from the
    // target minimum by WCAG's own "inline" exception. Anything laid out as a
    // block, a flex/grid item or a button is not.
    if (c.tagName === "A" && getComputedStyle(c).display === "inline") continue;
    if (cb.width < 24 || cb.height < 24) {
      R.tiny.push({ el: describe(c), w: Math.round(cb.width), h: Math.round(cb.height), text: (c.innerText || label(c) || "").trim().slice(0, 24) });
    }
  }

  var fields = Array.prototype.filter.call(document.querySelectorAll('input:not([type=hidden]),select,textarea'), vis);
  for (var k = 0; k < fields.length; k++) {
    if (!label(fields[k])) {
      R.unlabelledFields.push({ el: describe(fields[k]), placeholder: fields[k].getAttribute("placeholder") || null, type: fields[k].type || null });
    }
  }

  var main = document.querySelector("main, [role=main]");
  R.hasMain = !!main;
  if (main) {
    var n = 0;
    for (var m = 0; m < controls.length; m++) { if (main.contains(controls[m])) break; n++; }
    R.tabsToMain = n;
    // A skip link is the FIRST thing Tab reaches and it points into the content.
    var first = controls[0];
    if (first && first.tagName === "A") {
      var href = first.getAttribute("href") || "";
      if (href.charAt(0) === "#" && href.length > 1) {
        var dest = document.getElementById(href.slice(1));
        if (dest && (dest === main || main.contains(dest) || dest.contains(main))) {
          first.focus();
          // A skip link is normally parked off-screen and slid in on :focus.
          // Measuring the instant focus lands reads the START of that
          // transition and calls a perfectly visible link hidden.
          await new Promise(function (r) { setTimeout(r, 200); });
          var fb = first.getBoundingClientRect();
          R.skipTarget = { href: href, text: (first.innerText || label(first) || "").trim(), visibleOnFocus: fb.width > 0 && fb.height > 0 && fb.top > -fb.height && getComputedStyle(first).visibility !== "hidden" };
          first.blur();
        }
      }
    }
  }

  // WCAG 1.4.3, measured on the same visit. Reading the estate is the whole
  // point of it, and only two of its 190 documents had ever had their contrast
  // measured. Text is scanned at the DESKTOP width the pages were designed at,
  // reasserted below, because a 320px reflow can wrap a heading into a
  // different colour context and the question here is the colour, not the wrap.
  R.contrast = _scanContrast();

  var bs = document.querySelectorAll('.pd-burger, #mBurger, #pdBurger, [class*="burger"]');
  for (var q = 0; q < bs.length; q++) {
    if (!vis(bs[q])) continue;
    R.burgers.push({
      el: describe(bs[q]),
      name: label(bs[q]) || (bs[q].innerText || "").trim(),
      hasTextName: !!label(bs[q]),
      expanded: bs[q].getAttribute("aria-expanded"),
      controls: bs[q].getAttribute("aria-controls"),
    });
  }
  return R;
`;

let _estate = null;

/**
 * One pass over every document in the frontend, at a 320 px phone with touch on.
 * Memoised: the first test that needs it pays for it, the rest read the result.
 */
async function estateSweep() {
  if (_estate) return _estate;
  const rows = [];
  await page.send("Emulation.setDeviceMetricsOverride", NARROW);
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    for (const p of ESTATE) {
      await page.goto(site.url + p, { waitMs: 600 });
      const r = await page.eval(ESTATE_PROBE);
      r.page = p;
      r.errors = page.realErrors().slice(0, 2);
      rows.push(r);
    }
  } finally {
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await page.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
  _estate = rows;
  return rows;
}

function report(rows, fmt, limit = 12) {
  const lines = rows.slice(0, limit).map(fmt);
  if (rows.length > limit) lines.push(`  …and ${rows.length - limit} more`);
  return "\n" + lines.join("\n");
}

test("ESTATE: every HTML document in the frontend is reachable and enumerated", opts, async () => {
  // If this number collapses, the four tests below are silently measuring a
  // handful of pages instead of the estate, and would still be green.
  assert.ok(ESTATE.length >= 150,
    `the frontend ships far more than ${ESTATE.length} documents — the enumeration has broken`);
  const rows = await estateSweep();
  assert.equal(rows.length, ESTATE.length, "every enumerated document must have been visited");
  const broken = rows.filter((r) => r.errors.length);
  assert.deepEqual(broken.map((r) => `${r.page}: ${r.errors[0]}`), [],
    "no page in the estate may throw on load");
});

test("ESTATE REFLOW: no page in the frontend needs a second scroll axis at 320 CSS px", opts, async () => {
  const rows = await estateSweep();
  const bad = rows.filter((r) => r.scrollW > r.clientW + 1);
  assert.deepEqual(
    bad.map((r) => `${r.page} lays out ${r.scrollW}px inside ${r.clientW}px (+${r.scrollW - r.clientW}) — ${r.overflowing.map((o) => o.el + "@" + o.right).join(", ") || "cause not isolated"}`),
    [],
    `pages that must be scrolled sideways to be read (WCAG 1.4.10):${report(bad, (r) => "  " + r.page)}`,
  );
});

test("ESTATE TOUCH: no control anywhere is smaller than a 24px target", opts, async () => {
  // WCAG 2.2 SC 2.5.8 (AA). The V3 pages are held to 44 above; this is the floor
  // the whole estate has to clear, and the marketing burger was at 21x36.
  const rows = await estateSweep();
  const bad = rows.filter((r) => r.tiny.length);
  assert.deepEqual(
    bad.map((r) => `${r.page}: ${r.tiny.map((t) => `${t.el} ${t.w}x${t.h} "${t.text}"`).join("; ")}`),
    [],
    `controls below the 24px minimum target size on a phone:${report(bad, (r) => `  ${r.page} ${r.tiny.length}`)}`,
  );
});

test("ESTATE KEYBOARD: no page makes a keyboard user tab through the navigation to reach its content", opts, async () => {
  // WCAG 2.4.1 Bypass Blocks. The threshold is not a style preference: a
  // dashboard page put 19 controls in front of <main>, on every navigation.
  const rows = await estateSweep().then((r) => r.filter((x) => x.hasMain));
  assert.ok(rows.length > 100, `expected most of the estate to expose a main landmark, got ${rows.length}`);
  const bad = rows.filter((r) => r.tabsToMain > 3 && !r.skipTarget);
  assert.deepEqual(
    bad.map((r) => `${r.page} needs ${r.tabsToMain} Tab presses to reach <main> and offers no skip link`),
    [],
    `pages with no way to bypass the navigation:${report(bad, (r) => `  ${r.page} (${r.tabsToMain} tabs)`)}`,
  );
  // And where a skip link exists it has to be usable: a skip link a sighted
  // keyboard user cannot see when it takes focus is worse than none.
  const hidden = rows.filter((r) => r.skipTarget && !r.skipTarget.visibleOnFocus);
  assert.deepEqual(hidden.map((r) => r.page), [], "a skip link must become visible when it takes focus");
  const unnamed = rows.filter((r) => r.skipTarget && !r.skipTarget.text);
  assert.deepEqual(unnamed.map((r) => r.page), [], "a skip link must say what it does");
});

test("ESTATE LABELS: every field in the frontend has a name that is not just its placeholder", opts, async () => {
  // A placeholder is not an accessible name — it is not exposed as one by every
  // engine, and it disappears the moment the user types.
  const rows = await estateSweep();
  const bad = rows.filter((r) => r.unlabelledFields.length);
  assert.deepEqual(
    bad.map((r) => `${r.page}: ${r.unlabelledFields.map((f) => `${f.el}[${f.type}] placeholder=${JSON.stringify(f.placeholder)}`).join("; ")}`),
    [],
    `form fields with no accessible name (WCAG 4.1.2):${report(bad, (r) => "  " + r.page)}`,
  );
});

test("ESTATE MENU: the mobile menu button is named in words and reports whether it is open", opts, async () => {
  const rows = await estateSweep();
  const withBurger = rows.filter((r) => r.burgers.length);
  assert.ok(withBurger.length > 50, `the burger should be on most of the estate at 320px, found ${withBurger.length}`);
  const unnamed = withBurger.filter((r) => r.burgers.some((b) => !b.hasTextName));
  assert.deepEqual(
    unnamed.map((r) => `${r.page}: ${r.burgers.filter((b) => !b.hasTextName).map((b) => `${b.el} announces ${JSON.stringify(b.name)}`).join("; ")}`),
    [],
    "a menu button whose only name is its glyph is read out as that glyph",
  );
  const unstated = withBurger.filter((r) => r.burgers.some((b) => b.expanded !== "true" && b.expanded !== "false"));
  assert.deepEqual(
    unstated.map((r) => `${r.page}: ${r.burgers.filter((b) => b.expanded !== "true" && b.expanded !== "false").map((b) => b.el).join("; ")}`),
    [],
    "a disclosure button must carry aria-expanded, or nothing announces that the menu opened",
  );
});

test("ESTATE MOBILE: every page declares a language and a viewport a phone can use", opts, async () => {
  const rows = await estateSweep();
  const noLang = rows.filter((r) => !r.lang);
  assert.deepEqual(noLang.map((r) => r.page), [],
    "a page with no lang is read out by a screen reader in the wrong voice (WCAG 3.1.1)");

  const noViewport = rows.filter((r) => !r.viewportMeta || !/width\s*=\s*device-width/.test(r.viewportMeta));
  assert.deepEqual(noViewport.map((r) => `${r.page}: ${JSON.stringify(r.viewportMeta)}`), [],
    "a page without width=device-width is laid out at 980px and zoomed out on every phone");

  // WCAG 1.4.4: a page may not stop a user enlarging it. play-v3 shipped
  // user-scalable=no even though its canvas already scopes touch-action.
  const locked = rows.filter((r) => r.viewportMeta && /user-scalable\s*=\s*no|maximum-scale\s*=\s*(1(\.0+)?)\b/.test(r.viewportMeta));
  assert.deepEqual(locked.map((r) => `${r.page}: ${r.viewportMeta}`), [],
    "a page may not disable pinch zoom (WCAG 1.4.4) — scope touch-action to the surface that needs it instead");
});

// A menu button that carries aria-expanded is not the same as a menu that
// OPENS. The estate has exactly two shells — assets/site-chrome.js behind the
// 145 marketing pages and assets/player-chrome.js behind the dashboard — so one
// page of each is the whole of it, and driving them with real key events is the
// only way to know a keyboard user can get past the burger to the navigation
// it hides.
async function key(k, vk) {
  // CDP's `code` is the physical key NAME, a string — passing the virtual key
  // number there is rejected outright ("string value expected"). Enter also has
  // to carry its text, or Chrome delivers a raw key event that activates
  // nothing.
  const base = { key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k === "Enter" ? { text: "\r" } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await new Promise((r) => setTimeout(r, 70));
}

test("ESTATE MENU: the mobile menu opens from the keyboard, and the navigation it hides is reachable", opts, async () => {
  // One page per shell. Which page is arbitrary — the markup comes from the
  // shell, not the document — so each is chosen for being representative of the
  // ~60 pages behind it and for mounting the shell it is here to exercise.
  const shells = [
    { page: "/games-explore.html", burger: "#mBurger", nav: "#mnav a" },        // assets/site-chrome.js
    { page: "/player-friends.html", burger: "#pdBurger", nav: ".pd-side a" },   // assets/player-chrome.js
  ];
  const problems = [];
  await page.send("Emulation.setDeviceMetricsOverride", NARROW);
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    for (const s of shells) {
      await page.goto(site.url + s.page, { waitMs: 900 });
      const before = await page.eval(`
        var b = document.querySelector(${JSON.stringify(s.burger)});
        if (!b) return { missing: true };
        // A menu that is merely moved off screen — display kept, transform
        // applied — leaves every link inside it in the tab order. A keyboard
        // user then tabs into a menu they cannot see and cannot tell they are
        // in. So the question is not "is it visible" but "can it take focus
        // while it is off screen", which is the failure a sighted keyboard user
        // actually experiences.
        var offscreenFocusable = [];
        var links = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(s.nav)}));
        for (var i = 0; i < links.length; i++) {
          var el = links[i], cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          el.focus();
          if (document.activeElement !== el) continue;
          var r = el.getBoundingClientRect();
          var inView = r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
          if (!inView) offscreenFocusable.push((el.innerText || "").trim().slice(0, 20) + " at x=" + Math.round(r.left));
        }
        b.focus();
        return { missing: false, focused: document.activeElement === b, expanded: b.getAttribute("aria-expanded"),
                 offscreenFocusable: offscreenFocusable.slice(0, 4), offscreenCount: offscreenFocusable.length };
      `);
      if (before.missing) { problems.push(`${s.page}: no ${s.burger} at a 320px viewport, so there is no menu to open`); continue; }
      if (!before.focused) { problems.push(`${s.page}: ${s.burger} could not take keyboard focus`); continue; }
      if (before.expanded !== "false") problems.push(`${s.page}: a closed menu reports aria-expanded=${JSON.stringify(before.expanded)}`);
      if (before.offscreenCount) {
        problems.push(`${s.page}: ${before.offscreenCount} links in the SHUT menu still take focus while off screen (${before.offscreenFocusable.join(", ")}) — a keyboard user tabs into a menu nobody can see`);
      }

      await key("Enter", 13);
      await new Promise((r) => setTimeout(r, 400));
      const after = await page.eval(`
        var b = document.querySelector(${JSON.stringify(s.burger)});
        var links = Array.prototype.filter.call(document.querySelectorAll(${JSON.stringify(s.nav)}), function (el) {
          var r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
        });
        var first = links[0];
        if (first) first.focus();
        return {
          expanded: b.getAttribute("aria-expanded"),
          visibleLinks: links.length,
          firstReachable: !!(first && document.activeElement === first),
          firstText: first ? (first.innerText || "").trim().slice(0, 24) : null,
          firstInView: first ? (function () { var r = first.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; })() : false,
        };
      `);
      if (after.expanded !== "true") problems.push(`${s.page}: pressing Enter on the menu button left aria-expanded=${JSON.stringify(after.expanded)}, so nothing announced that it opened`);
      if (after.visibleLinks < 3) problems.push(`${s.page}: the menu opened but exposes only ${after.visibleLinks} navigation links`);
      if (!after.firstReachable) problems.push(`${s.page}: the first link in the opened menu (${JSON.stringify(after.firstText)}) cannot take focus`);
      if (!after.firstInView) problems.push(`${s.page}: the first link in the opened menu is laid out off screen at 320px`);
    }
  } finally {
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await page.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  }
  assert.deepEqual(problems, [], "the navigation behind the burger is not operable from a keyboard");
});

test("ESTATE CONTRAST: every word the frontend paints clears the WCAG minimum for its own size", opts, async () => {
  // WCAG 1.4.3 (AA): 4.5:1, or 3:1 for large text — 24px, or 18.66px bold. The
  // threshold is a function of the text's own size and weight, so it is
  // computed per piece of text rather than applied as one number, and every
  // colour comes from getComputedStyle rather than from the stylesheet's
  // intent: a token can be overridden, mistyped or shadowed by a media query,
  // and only the computed value knows which of those happened.
  //
  // Two of the estate's 190 documents had ever had this measured.
  const rows = await estateSweep();
  const scanned = rows.reduce((n, r) => n + (r.contrast ? r.contrast.length : 0), 0);
  assert.ok(scanned > 2000,
    `expected the estate's text to be measured, scanned only ${scanned} pieces across ${rows.length} pages`);

  const bad = [];
  for (const r of rows) {
    const fails = belowContrastMinimum(r.contrast || []);
    if (fails.length) bad.push({ page: r.page, worst: fails[0], n: fails.length });
  }
  assert.deepEqual(
    bad.map((b) => `${b.page}: ${b.n} unreadable, worst is ${b.worst}`),
    [],
    `text below the WCAG 1.4.3 minimum against what is painted behind it, on ${bad.length} of ${rows.length} pages:${report(bad, (b) => `  ${b.page} (${b.n})`)}`,
  );
});
