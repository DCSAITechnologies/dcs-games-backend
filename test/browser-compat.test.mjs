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
  "/me/profile": {
    ok: true, principal_id: "u_compat", username: "tester", display_name: "Compat Tester",
    created_at: "2026-01-02T03:04:05Z", avatar_color: "#2563ff", level: "verified_builder", is_internal_tester: true,
    xp: 1200, worlds_created: 3, worlds_published: 1, publish_credits: 5, publish_credits_unlimited: false,
    can_publish: { allowed: true, remaining: 4, unlimited: false, reason: null },
    economy: { payments_live: false, balance_minor: null, dcs_plus: false, note: "Money is disabled." },
    level_signals: { email_verified: true, phone_verified: false, atlas_score: 52, dcs_plus: false, active_players: 11, reports: 0, is_studio: false },
  },
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
  [`/v3/worlds/${WORLD}/versions`]: { ok: true, versions: [] },
  [`/v3/worlds/${WORLD}/memory`]: { ok: true, chronology: [], timeline: [] },
};

let site, api, browser, page, deadPort;
let MODE = "data";

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
      if (url === "/api/worlds/mine") return send(200, FULL["/api/worlds/mine"]);
      return send(500, { ok: false, error: "internal_error", detail: "The database is unreachable." });
    }
    const table = MODE === "empty" ? EMPTY : FULL;
    if (Object.prototype.hasOwnProperty.call(table, url)) return send(200, table[url]);
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
      var el = _controls()[0];
      if (!el) return { none: true };
      el.focus();
      var cs = getComputedStyle(el);
      return {
        sel: _desc(el),
        width: parseFloat(cs.outlineWidth) || 0,
        style: cs.outlineStyle,
        color: cs.outlineColor,
        isActive: document.activeElement === el,
      };
    `);
    assert.ok(!r.none, `${p.file}: no control to focus`);
    assert.equal(r.isActive, true, `${p.file}: the control never took focus, so nothing was measured`);
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
      var el = _controls()[0];
      el.focus();
      var fcs = getComputedStyle(el);
      return {
        emulated: true, invisible: invisible, gradients: gradients,
        textLength: document.body.innerText.length,
        focusWidth: parseFloat(fcs.outlineWidth) || 0,
        focusStyle: fcs.outlineStyle,
        focused: document.activeElement === el,
      };
    `);
    await page.send("Emulation.setEmulatedMedia", {});
    assert.equal(r.emulated, true, `${p.file}: forced-colors was not emulated, so nothing was measured`);
    assert.ok(r.textLength > 200, `${p.file}: only ${r.textLength} characters survive forced colours`);
    assert.deepEqual(r.invisible, [], `${p.file}: text painted the same colour as what is behind it under forced colours`);
    assert.deepEqual(r.gradients, [], `${p.file}: a gradient survives forced colours without opting out of the mode`);
    assert.equal(r.focused, true, `${p.file}: the control never took focus`);
    assert.ok(r.focusWidth >= 2 && r.focusStyle !== "none",
      `${p.file}: the focus ring is ${r.focusWidth}px ${r.focusStyle} under forced colours`);
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
