// Accessibility of the two V3 document pages — create-v3 and explore-v3.
//
// The HUD tests in runtime-perf.test.mjs composite over WHITE, because that HUD
// floats over a sky the world can render at full daylight. These two are
// ordinary documents: nothing renders behind them, so the honest backdrop is
// the page's own paint, walked up to the browser's white canvas in case every
// layer turns out to be transparent. Same arithmetic, different backdrop, and
// the backdrop is the part a CSS review gets wrong.
//
// What is pinned here is what was measured broken on 6 Sep 2026:
//
//   - the shared control-boundary colour sat at 1.42:1 on create-v3 and 1.51:1
//     on explore-v3, so no input, select, ghost button, chip or world card had
//     an edge a low-vision user could find
//   - the browser's default placeholder (#757575) was doing duty as real text
//     at 4.15:1 on four fields across the two pages
//   - fifteen "chips" were divs: unreachable by Tab, 35px tall to a thumb
//   - the sort control announced nothing about which sort was live, and its
//     focus ring was clipped away entirely by an overflow:hidden wrapper
//
// Every assertion below is a property — the WCAG threshold for the size and
// weight the browser actually computed, 44 CSS px, a ring that changes on focus
// — not a colour or a pixel count that will drift the next time the design
// moves.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { resolveSite } from "./helpers/site.mjs";
import { CONTRAST_HELPERS } from "./helpers/a11y-probe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(HERE);   // throws loudly if the frontend is absent
const EVIDENCE = path.resolve(HERE, "../../../DCS_GAMES_SPRINT_SEP2026/evidence/screenshots");

const PAGES = ["create-v3.html", "explore-v3.html"];
const haveSite = PAGES.every((p) => fs.existsSync(path.join(SITE, p)));
const haveChrome = !!findChrome();
const opts = { skip: !haveSite ? "create-v3.html / explore-v3.html not found" : (!haveChrome ? "no Chrome binary" : false) };

// The two worlds the feed is measured against. Both carry real-looking but
// clearly test values; nothing here is rendered as a claim about the service.
const WORLDS = [
  {
    world_id: "w_a11y_1", title: "Nordic Port", genre: "adventure", world_version: 3,
    atlas_signed: true, thumbnail_ref: null, thumbnail_uri: null, thumbnail_is_placeholder: true,
    stats: { plays: 12, rating_avg: 4.2, unique_players: 5 },
  },
  {
    world_id: "w_a11y_2", title: "Neon Block", genre: "scifi", world_version: 1,
    atlas_signed: false, thumbnail_ref: null, thumbnail_uri: null, thumbnail_is_placeholder: false,
    stats: { plays: 0, rating_avg: null, unique_players: 0 },
  },
];

let site, api, browser, page;
let feed = WORLDS;                 // flipped to [] to exercise the real-zero empty state

/**
 * The endpoints these two pages touch on load. Nothing else is stubbed.
 *
 * Anything NOT stubbed is recorded, so a page that grows a new call says so by
 * name. That is not a nicety: when the internal-tester gate moved its predicate
 * from GET /api/worlds/mine to GET /v3/subscriptions/grants, this stub kept
 * answering the old one, the gate closed over every test, and ten tests failed
 * as fifteen-second waitFor timeouts with no indication of why. A stub that has
 * drifted from the product must SAY it has drifted.
 */
let unstubbed = [];
/**
 * Flipped by the gate test alone. Every other test needs the gate OPEN — they
 * are about the surface behind it — and the gate test needs it CLOSED, by the
 * server's own refusal rather than by a fixture that happens to 404.
 */
let grantsRefused = false;
function stubApi() {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const url = (req.url || "").split("?")[0];
    // create-v3 fails CLOSED behind the internal gate. These tests are about
    // the surface behind the gate, so the gate is satisfied honestly: a token
    // is injected and the predicate the gate ACTUALLY uses answers for it.
    // GET /v3/subscriptions/grants goes through mustBeInternalTester() on the
    // server, which is why the gate asks it rather than an endpoint that only
    // proves the caller is signed in.
    if (url === "/v3/subscriptions/grants") {
      return grantsRefused
        ? send(403, { ok: false, error: "not_an_internal_tester", detail: "This account is not on the internal tester list." })
        : send(200, { ok: true, grants: [], note: "Money is dark." });
    }
    if (url === "/api/worlds/mine") return send(200, { ok: true, owner: "u_a11y", worlds: [] });
    if (url === "/v3/discover") return send(200, { ok: true, note: "Ranking uses measured plays only.", worlds: feed });
    if (url === "/v3/providers") return send(200, { ok: true, lanes: [] });
    if (url === "/v3/jobs") return send(200, { ok: true, jobs: [] });
    unstubbed.push(`${req.method} ${url}`);
    return send(404, { ok: false, error: "not_found" });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    const a = server.address();
    r({ url: `http://127.0.0.1:${a.port}`, close: () => new Promise((x) => server.close(x)) });
  }));
}

before(async () => {
  if (opts.skip) return;
  site = await serveStatic(SITE);
  api = await stubApi();
  browser = await launchChrome();
  page = await Page.open(browser);
  // A headless tab is not the focused window, and :focus does NOT match in an
  // unfocused document — el.focus() would move activeElement while the ring
  // stayed off, and every focus assertion below would be measuring nothing.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  // Both must be in place before the page's own scripts run: the truth layer
  // reads DCS_API_BASE at parse time and the gate reads the token immediately.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.DCS_API_BASE=${JSON.stringify(api.url)}; window.DCS_ACCESS_TOKEN="a11y-test-token";`,
  });
});

after(async () => {
  if (page) await page.close();
  if (browser) await browser.close();
  if (site) await site.close();
  if (api) await api.close();
});

// ------------------------------------------------------------ in-page helpers

// The WCAG colour arithmetic itself lives in test/helpers/a11y-probe.mjs and is
// prepended here, because test/browser-compat.test.mjs measures the same thing
// across the other 188 documents and two copies of it is two places for it to
// drift. Two suites disagreeing about what 4.5:1 means would be worse than one
// of them not measuring it.
//
// What stays here is what only this file needs: the control-edge rule, the
// per-element text scan and the descriptions its assertions print. All of it
// still runs against the values the browser says it is PAINTING rather than
// what the stylesheet asks for — a token can be overridden, mistyped or
// shadowed, and only getComputedStyle knows what actually landed.
const HELPERS = CONTRAST_HELPERS + `
  function _visible(el){
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  }
  function _desc(el){
    if (!el) return "(none)";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.className && typeof el.className === "string") s += "." + el.className.trim().split(/\\s+/).join(".");
    const t = (el.textContent || el.value || el.placeholder || "").trim().slice(0, 30);
    return t ? s + ' "' + t + '"' : s;
  }
  // Only the text an element paints ITSELF. Using textContent would measure a
  // wrapper against its children's colours and score the same string twice.
  function _ownText(el){
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.trim();
  }
  function _textRow(el, pseudo){
    const cs = getComputedStyle(el, pseudo || null);
    const bg = _bgOf(el);
    return {
      sel: _desc(el) + (pseudo || ""),
      ratio: _ratio(_over(_parse(cs.color), bg), bg),
      size: parseFloat(cs.fontSize),
      weight: Number(cs.fontWeight) || 400,
      color: cs.color,
    };
  }
  function _scanText(){
    const out = [];
    document.querySelectorAll("*").forEach(function (el) {
      if (/^(SCRIPT|STYLE|TITLE|META|LINK|HEAD|HTML)$/.test(el.tagName)) return;
      if (!_visible(el)) return;
      const own = _ownText(el) || ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") ? (el.value || "") : "");
      if (!own) return;
      out.push(_textRow(el));
    });
    // A placeholder is text a user reads. Left alone the browser paints it
    // #757575, which is why it gets measured separately from the field.
    document.querySelectorAll("input,textarea").forEach(function (el) {
      if (_visible(el) && el.placeholder) out.push(_textRow(el, "::placeholder"));
    });
    return out;
  }
  // WCAG 1.4.11: the part of a control that tells you it IS a control needs
  // 3:1. That is normally its own border or fill — but a segmented control
  // draws one boundary around the group, so a segment with neither is allowed
  // to inherit the boundary of the labelled group it sits in.
  function _edge(el){
    const outside = _bgOf(el.parentElement || document.body);
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bc = _parse(cs.borderTopColor);
    let best = bw > 0 && bc[3] > 0 ? _ratio(_over(bc, outside), outside) : 0;
    best = Math.max(best, _ratio(_bgOf(el), outside));
    if (best >= 3) return { sel: _desc(el), ratio: best, from: "self" };
    const group = el.closest('[role="group"], .seg');
    if (group && group !== el) {
      const go = _bgOf(group.parentElement || document.body);
      const gcs = getComputedStyle(group);
      const gw = parseFloat(gcs.borderTopWidth) || 0;
      const gc = _parse(gcs.borderTopColor);
      if (gw > 0 && gc[3] > 0) {
        const g = _ratio(_over(gc, go), go);
        if (g > best) return { sel: _desc(el), ratio: g, from: "group " + _desc(group) };
      }
    }
    return { sel: _desc(el), ratio: best, from: "self" };
  }
`;

const CONTROLS = 'a[href],button,input,select,textarea,[role="button"]';

/** WCAG 1.4.3 thresholds, from the size and weight the browser computed. */
function needed(row) {
  const large = row.size >= 24 || (row.size >= 18.66 && row.weight >= 700);
  return large ? 3 : 4.5;
}
function belowMinimum(rows) {
  return rows.filter((r) => r.ratio < needed(r)).map((r) => `${r.sel} ${r.color} = ${r.ratio}:1 at ${r.size}px/${r.weight} (needs ${needed(r)})`);
}

/** A real key press through the browser, not a synthetic DOM event. */
async function pressKey(key, code, text) {
  const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await page.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await new Promise((r) => setTimeout(r, 70));
}
const tab = () => pressKey("Tab", 9);
// Enter has to carry its text, or Chrome delivers a raw key event with no
// keypress behind it and a real button never activates.
const enter = () => pressKey("Enter", 13, "\r");

// Every panel on the builder is behind a state the page only reaches after a
// real job runs. Colour does not depend on how a panel got shown, so the panels
// are shown directly and filled with the kind of text the server sends.
const SHOW_ALL_CREATE = `
  const $ = function (id) { return document.getElementById(id); };
  $("prompt").value = "A rainy nordic port town";
  $("editReq").value = "make it rain";
  $("expandReq").value = "add a hospital district";
  document.querySelectorAll(".st")[0].className = "st done";
  document.querySelectorAll(".st")[1].className = "st on";
  $("prog").style.display = "block";
  $("bar").style.width = "40%";
  $("lanes").innerHTML =
    '<div class="l"><span class="nm">world</span><span class="ok">done</span></div>' +
    '<div class="l"><span class="nm">quests</span><span class="fb">working…</span></div>' +
    '<div class="l"><span class="nm">audio</span><span class="no">skipped — no adapter configured</span></div>';
  $("result").classList.remove("hidden");
  $("editCard").classList.remove("hidden");
  $("expandCard").classList.remove("hidden");
  $("verdict").innerHTML =
    '<span class="verdict PASSED">PASSED</span> ' +
    '<span class="verdict PASSED_WITH_NOTES">PASSED WITH NOTES</span> ' +
    '<span class="verdict REJECTED">REJECTED</span> ' +
    '<span style="color:var(--muted);font-size:13px">2 automatic repairs applied</span>';
  $("verdict").insertAdjacentHTML("beforeend",
    '<div class="finding"><div class="id">warning · F1</div>A quest step has no reachable target</div>' +
    '<div class="finding blocker"><div class="id">blocker · F2</div>The spawn point is inside a wall</div>');
  $("counts").innerHTML = '<div class="stat"><div class="v">42</div><div class="k">structures</div></div>';
  $("provenance").innerHTML =
    "<div>world &rarr; <span class='ok'>adapter-a</span> [AVAILABLE] 120ms</div>" +
    "<div>audio &rarr; <span class='fb'>fallback-b</span> [DEGRADED] 40ms</div>";
  $("provPanel").textContent = "Provider status unavailable (no response).";
  $("genMsg").className = "msg err"; $("genMsg").textContent = "Describe the world you want first.";
  $("resultMsg").className = "msg ok"; $("resultMsg").textContent = "Saved as world version 3.";
  $("editMsg").className = "msg warn"; $("editMsg").textContent = "That edit was only partly applied.";
  $("expandMsg").className = "msg err"; $("expandMsg").textContent = "The expansion was refused.";
  $("history").innerHTML =
    "<h2 style='margin-top:20px'>World history</h2>" +
    '<div class="h"><div class="v">v3</div><div>Added a hospital district' +
    '<div style="color:var(--muted);font-size:12px">expand · 2026-09-06 12:00:00</div></div></div>';
  return true;
`;

async function openCreate({ showAll = true } = {}) {
  unstubbed = [];
  await page.goto(site.url + "/create-v3.html", { waitMs: 700 });
  // The gate replaces the whole body when it closes, so the builder is only
  // really open once its own controls are in the document.
  const open = await page.waitFor('document.getElementById("gen") && !document.querySelector(".dcs-gate")');
  if (!open) {
    // Say WHY. This used to be a bare "the gate did not accept the test token",
    // which is the one thing it could not have been — the token is injected —
    // and it left ten tests failing on a silent fifteen-second wait.
    const gateText = await page.eval("const g = document.querySelector('.dcs-gate'); return g ? g.innerText.slice(0, 240) : null;").catch(() => null);
    assert.fail(
      "the builder never opened.\n" +
      `  gate on screen: ${JSON.stringify(gateText)}\n` +
      `  endpoints this page asked for that the fixture does not stub: ${JSON.stringify(unstubbed)}\n` +
      "  if the gate's predicate moved, stubApi() has to move with it.",
    );
  }
  if (showAll) await page.eval(SHOW_ALL_CREATE);
  await new Promise((r) => setTimeout(r, 150));
}

async function openExplore({ worlds = WORLDS } = {}) {
  feed = worlds;
  await page.goto(site.url + "/explore-v3.html", { waitMs: 700 });
  const loaded = await page.waitFor(`document.getElementById("grid").getAttribute("aria-busy") === "false"`);
  assert.ok(loaded, "the feed never finished loading");
}

const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
async function withPhone(fn) {
  await page.send("Emulation.setDeviceMetricsOverride", PHONE);
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try { return await fn(); } finally {
    await page.send("Emulation.clearDeviceMetricsOverride");
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
}

// ==================================================================== contrast

test("A11Y: every word the world builder paints clears the WCAG minimum for its own size", opts, async () => {
  await openCreate();
  const rows = await page.eval(`${HELPERS} return _scanText();`);
  // If the walk stops finding text the check has quietly stopped checking.
  assert.ok(rows.length >= 60, `expected the whole builder measured, got ${rows.length} pieces of text`);
  assert.ok(rows.some((r) => r.sel.includes("::placeholder")), "the placeholders must be measured — they were the worst offenders");
  assert.deepEqual(belowMinimum(rows), [], "text on create-v3 below the WCAG minimum against what is painted behind it");
});

test("A11Y: every word the explore feed paints clears the WCAG minimum, cards and all", opts, async () => {
  await openExplore();
  const rows = await page.eval(`${HELPERS} return _scanText();`);
  assert.ok(rows.length >= 25, `expected the whole feed measured, got ${rows.length} pieces of text`);
  assert.ok(rows.some((r) => r.sel.includes("::placeholder")), "the search placeholder must be measured");
  assert.deepEqual(belowMinimum(rows), [], "text on explore-v3 below the WCAG minimum");
});

test("A11Y: the empty feed is a readable statement of a real zero, not faint grey", opts, async () => {
  // A published-nothing feed is the state a first-time visitor sees, and its
  // only action is one link. That link was the fill purple: 3.45:1.
  await openExplore({ worlds: [] });
  const r = await page.eval(`${HELPERS}
    const empty = document.getElementById("empty");
    if (getComputedStyle(empty).display === "none") return { shown: false };
    const rows = [];
    empty.querySelectorAll("h2, p, a").forEach(function (el) { if (_ownText(el)) rows.push(_textRow(el)); });
    const link = empty.querySelector("a");
    const box = link.getBoundingClientRect();
    return { shown: true, rows: rows, linkBox: { w: Math.round(box.width), h: Math.round(box.height) }, linkHref: link.getAttribute("href") };
  `);
  assert.equal(r.shown, true, "an empty feed must show the empty state");
  assert.ok(r.rows.length >= 3, `expected the empty state measured, got ${r.rows.length} rows`);
  assert.deepEqual(belowMinimum(r.rows), [], "empty-state text below the WCAG minimum");
  // It is the only thing to do on the page, so it is a target, not a word.
  assert.ok(r.linkBox.h >= 44, `the only action in the empty state is ${r.linkBox.h}px tall`);
});

test("A11Y: every control on both pages has an edge that can be found at 3:1", opts, async () => {
  // WCAG 1.4.11. Before the fix the shared border token put every input,
  // select, ghost button, chip and world card between 1.42:1 and 1.51:1 — a
  // boundary that is there in the CSS and not there to a reader.
  for (const open of [openCreate, openExplore]) {
    await open();
    const r = await page.eval(`${HELPERS}
      const out = [];
      document.querySelectorAll(${JSON.stringify(CONTROLS)}).forEach(function (el) {
        if (!_visible(el)) return;
        if (el.closest(".dcs-banner")) return;   // the truth banner is not this page's markup
        out.push(_edge(el));
      });
      return { url: location.pathname, rows: out };
    `);
    assert.ok(r.rows.length >= 5, `${r.url}: expected controls to measure, found ${r.rows.length}`);
    const weak = r.rows.filter((x) => x.ratio < 3).map((x) => `${x.sel} = ${x.ratio}:1 (boundary from ${x.from})`);
    assert.deepEqual(weak, [], `${r.url}: controls with no findable boundary`);
  }
});

test("A11Y: the sort control says which sort is live, in colour and in words", opts, async () => {
  await openExplore();
  const r = await page.eval(`${HELPERS}
    const btns = Array.from(document.querySelectorAll('#sort button'));
    const on = btns.find(function (b) { return b.classList.contains("on"); });
    const off = btns.find(function (b) { return !b.classList.contains("on"); });
    // The selected state has to be visible as more than a tint. Whatever paints
    // it — a shadow, a border, a fill — is measured against the segment next to
    // it, which is the comparison an eye actually makes.
    const cs = getComputedStyle(on);
    const shadow = /rgba?\\([^)]+\\)/.exec(cs.boxShadow || "");
    const neighbour = _bgOf(off);
    const indicator = shadow ? _ratio(_over(_parse(shadow[0]), neighbour), neighbour) : 0;
    const fill = _ratio(_bgOf(on), neighbour);
    return {
      pressed: btns.map(function (b) { return b.getAttribute("aria-pressed"); }),
      types: btns.map(function (b) { return b.getAttribute("type"); }),
      groupRole: document.getElementById("sort").getAttribute("role"),
      groupLabel: document.getElementById("sort").getAttribute("aria-label"),
      indicator: indicator, fill: fill,
    };
  `);
  assert.deepEqual(r.pressed, ["true", "false", "false"], "exactly one sort is pressed, and a screen reader can tell which");
  assert.deepEqual(r.types, ["button", "button", "button"], "a sort button must not submit anything");
  assert.equal(r.groupRole, "group");
  assert.ok(r.groupLabel && r.groupLabel.trim(), "the sort group needs a name of its own");
  assert.ok(Math.max(r.indicator, r.fill) >= 3,
    `the selected sort is only ${Math.max(r.indicator, r.fill)}:1 against its neighbours — a tint alone is not a state indicator`);

  // And pressing another one moves the state rather than adding a second.
  await page.eval(`document.querySelectorAll('#sort button')[2].click(); return true;`);
  await page.waitFor(`document.getElementById("grid").getAttribute("aria-busy") === "false"`);
  const after = await page.eval(`return Array.from(document.querySelectorAll('#sort button')).map(function (b) { return b.getAttribute("aria-pressed"); });`);
  assert.deepEqual(after, ["false", "false", "true"], "choosing a sort must move aria-pressed, not accumulate it");
});

// ==================================================================== keyboard

test("A11Y: nothing on either page is clickable without also being reachable by Tab", opts, async () => {
  for (const open of [openCreate, openExplore]) {
    await open();
    const orphans = await page.eval(`${HELPERS}
      const out = [];
      document.querySelectorAll("*").forEach(function (el) {
        if (!_visible(el)) return;
        // A child of a control inherits its pointer cursor; the control is the
        // ancestor, and it is the ancestor that has to be focusable.
        if (el.closest('a[href],button,[tabindex]:not([tabindex="-1"])')) return;
        const cs = getComputedStyle(el);
        const clickable = cs.cursor === "pointer" || el.dataset.edit || el.dataset.expand || el.dataset.sort;
        if (clickable) out.push(_desc(el));
      });
      return { url: location.pathname, out: out };
    `);
    assert.deepEqual(orphans.out, [], `${orphans.url}: clickable, but a keyboard cannot get to it`);
  }
});

test("A11Y: an idea chip can be chosen with the keyboard alone", opts, async () => {
  // The chips were divs with a delegated click handler. A pointer worked; Tab
  // walked straight past all fifteen of them.
  await openCreate();
  const start = await page.eval(`
    document.getElementById("prompt").value = "";
    document.getElementById("prompt").focus();
    return document.activeElement.id;
  `);
  assert.equal(start, "prompt");

  // Tab off the field and onto the first chip, whatever its position ends up
  // being — the assertion is that the chips are IN the sequence, not where.
  let reached = null;
  for (let i = 0; i < 8 && !reached; i++) {
    await tab();
    const cur = await page.eval(`
      const el = document.activeElement;
      return el && el.classList && el.classList.contains("chip")
        ? { tag: el.tagName, text: el.textContent.trim() } : null;
    `);
    if (cur) reached = cur;
  }
  assert.ok(reached, "Tab from the description box never reaches an idea chip");
  assert.equal(reached.tag, "BUTTON", "a chip must be a real button, not a div with a click handler");

  await enter();
  const after = await page.eval(`
    return { value: document.getElementById("prompt").value, focus: document.activeElement && document.activeElement.id };
  `);
  assert.equal(after.value, reached.text, "Enter on a chip must fill the description box");
  // The text landed somewhere else on the page; the caret has to follow it or a
  // keyboard user has no way of knowing the press did anything.
  assert.equal(after.focus, "prompt", "choosing a chip must take the caret to the field it filled");
});

test("A11Y: every control paints a focus ring, and only while it holds focus", opts, async () => {
  for (const open of [openCreate, openExplore]) {
    await open();
    const rows = await page.eval(`${HELPERS}
      const els = Array.from(document.querySelectorAll(${JSON.stringify(CONTROLS)})).filter(_visible)
        .filter(function (el) { return !el.closest(".dcs-banner"); });
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      return { url: location.pathname, rows: els.map(function (el) {
        const idle = getComputedStyle(el).outlineStyle;
        el.focus();
        const cs = getComputedStyle(el);
        // Read into plain values NOW: a CSSStyleDeclaration is live and would
        // report the next element's state by the time this array is returned.
        return { sel: _desc(el), idle: idle, focused: document.activeElement === el,
                 style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0 };
      }) };
    `);
    assert.ok(rows.rows.length >= 5, `${rows.url}: expected controls to focus, found ${rows.rows.length}`);
    const noRing = rows.rows.filter((c) => !c.focused || c.style === "none" || c.width < 2)
      .map((c) => `${c.sel} focused=${c.focused} outline=${c.width}px ${c.style}`);
    assert.deepEqual(noRing, [], `${rows.url}: controls with no visible focus ring`);
    // A ring that is always on is not an indicator of anything.
    const permanent = rows.rows.filter((c) => c.idle !== "none").map((c) => c.sel);
    assert.deepEqual(permanent, [], `${rows.url}: the ring must appear on focus, never permanently`);
  }
});

test("A11Y: a focus ring inside a clipping container is drawn on the inside, where it survives", opts, async () => {
  // An outline is painted outside the border box, so an ancestor with hidden
  // overflow erases it. Measured: all three sort buttons sit in a `.seg` with
  // overflow:hidden and their ring was cut away completely.
  for (const open of [openCreate, openExplore]) {
    await open();
    const rows = await page.eval(`${HELPERS}
      const out = [];
      Array.from(document.querySelectorAll(${JSON.stringify(CONTROLS)})).filter(_visible).forEach(function (el) {
        let clipper = null;
        for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
          const p = getComputedStyle(n);
          if (p.overflow !== "visible" || p.overflowX !== "visible" || p.overflowY !== "visible") { clipper = n; break; }
        }
        if (!clipper) return;
        el.focus();
        const cs = getComputedStyle(el);
        out.push({ sel: _desc(el), clipper: _desc(clipper), offset: parseFloat(cs.outlineOffset) || 0,
                   style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0 });
      });
      return { url: location.pathname, out: out };
    `);
    const clipped = rows.out.filter((c) => c.style === "none" || c.width < 2 || c.offset >= 0)
      .map((c) => `${c.sel} inside ${c.clipper}: outline ${c.width}px ${c.style} at offset ${c.offset}`);
    assert.deepEqual(clipped, [], `${rows.url}: a focus ring that its own container clips away`);
  }
});

test("A11Y: every field on both pages has a name a screen reader can read out", opts, async () => {
  for (const open of [openCreate, openExplore]) {
    await open();
    const rows = await page.eval(`${HELPERS}
      return { url: location.pathname, rows: Array.from(document.querySelectorAll("input,select,textarea")).filter(_visible).map(function (el) {
        const label = el.labels && el.labels.length ? el.labels[0].textContent.trim() : "";
        return { sel: _desc(el), name: (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || label || "").trim() };
      }) };
    `);
    assert.ok(rows.rows.length >= 2, `${rows.url}: expected fields, found ${rows.rows.length}`);
    // A placeholder is not a name: it disappears the moment anything is typed.
    const unnamed = rows.rows.filter((f) => !f.name).map((f) => f.sel);
    assert.deepEqual(unnamed, [], `${rows.url}: fields whose only label is a placeholder`);
  }
});

test("A11Y: typing in a field types, and Tab still moves focus", opts, async () => {
  // The class of bug the runtime had: a global key handler that ate Tab, and
  // single-letter shortcuts that fired while the user was in a text box.
  await openCreate();
  await page.eval(`
    const p = document.getElementById("prompt");
    p.value = ""; p.focus();
    return true;
  `);
  for (const [k, c] of [["e", 69], ["m", 77], ["w", 87]]) await pressKey(k, c, k);
  const typed = await page.eval(`return { value: document.getElementById("prompt").value, focus: document.activeElement.id };`);
  assert.equal(typed.value, "emw", "the field must receive every keystroke");
  assert.equal(typed.focus, "prompt", "typing must not move focus");

  await tab();
  const moved = await page.eval(`return document.activeElement && (document.activeElement.id || document.activeElement.tagName);`);
  assert.notEqual(moved, "prompt", "Tab must move focus off the field — nothing may swallow it");

  // And no page-level handler is sitting on the document waiting to.
  const listeners = await page.send("DOMDebugger.getEventListeners", {
    objectId: (await page.send("Runtime.evaluate", { expression: "document" })).result.objectId,
  }).catch(() => ({ listeners: [] }));
  const keydown = (listeners.listeners || []).filter((l) => l.type === "keydown" || l.type === "keypress");
  assert.deepEqual(keydown.map((l) => l.type), [], "the builder registers no document-level key handler, so none can swallow a key");
});

// ======================================================================= touch

test("TOUCH: every control on both pages is at least 44x44 on a phone", opts, async () => {
  await withPhone(async () => {
    for (const open of [openCreate, openExplore]) {
      await open();
      const r = await page.eval(`${HELPERS}
        const els = Array.from(document.querySelectorAll(${JSON.stringify(CONTROLS)} + ',.chip')).filter(_visible)
          .filter(function (el) { return !el.closest(".dcs-banner"); });
        return {
          url: location.pathname,
          controls: els.map(function (el) { const b = el.getBoundingClientRect(); return { sel: _desc(el), w: Math.round(b.width), h: Math.round(b.height) }; }),
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      `);
      assert.ok(r.controls.length >= 5, `${r.url}: expected controls on a phone, found ${r.controls.length}`);
      const small = r.controls.filter((c) => c.w < 44 || c.h < 44).map((c) => `${c.sel} is ${c.w}x${c.h}`);
      assert.deepEqual(small, [], `${r.url}: tap targets under 44px`);
      // A page that scrolls sideways puts controls off the edge of the phone.
      assert.ok(r.scrollWidth <= r.innerWidth + 1, `${r.url}: scrolls horizontally, ${r.scrollWidth} > ${r.innerWidth}`);
    }
    await page.screenshot(path.join(EVIDENCE, "g-explore-v3-phone-targets.png"));
  });
});

test("TOUCH: no panel is sitting on top of a control, stealing its taps", opts, async () => {
  await withPhone(async () => {
    for (const open of [openCreate, openExplore]) {
      await open();
      const r = await page.eval(`${HELPERS}
        const stolen = [];
        Array.from(document.querySelectorAll(${JSON.stringify(CONTROLS)} + ',.chip')).filter(_visible).forEach(function (el) {
          const b = el.getBoundingClientRect();
          // Only a control the viewport can currently reach can be tapped.
          if (b.top < 0 || b.bottom > window.innerHeight) return;
          // The point a thumb aims at. Whatever answers there has to be the
          // control itself, or something inside it.
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          if (hit && hit !== el && !el.contains(hit)) stolen.push(_desc(el) + " is covered by " + _desc(hit));
        });
        return { url: location.pathname, stolen: stolen };
      `);
      assert.deepEqual(r.stolen, [], `${r.url}: a panel is intercepting taps meant for a control`);
    }
  });
});

// ================================================================== structural

test("A11Y: both pages actually load the shared accessibility stylesheet", opts, async () => {
  // Every ring, the .sr helper and the 44px target class live in one file so a
  // page cannot quietly ship without them. A page that forgets the link loses
  // all three silently, which is exactly how these two pages got here.
  for (const open of [openCreate, openExplore]) {
    await open();
    const r = await page.eval(`
      const sheets = Array.from(document.styleSheets).map(function (s) {
        let n = 0; try { n = s.cssRules.length; } catch (e) { n = -1; }
        return { href: s.href || "", rules: n };
      });
      const a11y = sheets.filter(function (s) { return /dcs-a11y\\.css$/.test(s.href); });
      // The truth layer is depended on by inline scripts on these pages, so it
      // must not be deferred out from under them.
      const truth = Array.from(document.querySelectorAll('script[src*="dcs-truth.js"]'))
        .map(function (s) { return { defer: s.defer, async: s.async }; });
      return { url: location.pathname, a11y: a11y, truth: truth };
    `);
    assert.equal(r.a11y.length, 1, `${r.url}: the shared accessibility stylesheet is not linked`);
    assert.ok(r.a11y[0].rules > 0, `${r.url}: the shared stylesheet linked but parsed to nothing`);
    assert.equal(r.truth.length, 1, `${r.url}: the truth layer must be on the page exactly once`);
    assert.equal(r.truth[0].defer, false, `${r.url}: dcs-truth.js must not be deferred — inline scripts depend on it`);
    assert.equal(r.truth[0].async, false, `${r.url}: dcs-truth.js must not be async for the same reason`);
  }
});

test("A11Y: a result the user cannot see happening is announced instead", opts, async () => {
  // Generating, editing and expanding all report into panels far from the
  // button that started them, and sorting replaces the whole feed. Without a
  // live region a keyboard or screen-reader user gets no signal at all.
  await openCreate({ showAll: false });
  const create = await page.eval(`
    return ["genMsg", "resultMsg", "editMsg", "expandMsg", "provPanel", "lanes"].map(function (id) {
      const el = document.getElementById(id);
      return { id: id, role: el && el.getAttribute("role"), live: el && el.getAttribute("aria-live") };
    });
  `);
  const silent = create.filter((m) => m.role !== "status" && m.live !== "polite").map((m) => m.id);
  assert.deepEqual(silent, [], "these panels change without announcing themselves");

  const bar = await page.eval(`
    const b = document.getElementById("barTrack");
    return { role: b.getAttribute("role"), now: b.getAttribute("aria-valuenow"), label: b.getAttribute("aria-label") };
  `);
  assert.equal(bar.role, "progressbar");
  assert.ok(bar.label && bar.label.trim(), "the progress bar needs a name");
  assert.equal(bar.now, "0", "progress starts at zero, and it moves with the job rather than a timer");

  await openExplore();
  const feedStatus = await page.eval(`
    const s = document.getElementById("status");
    return { role: s.getAttribute("role"), text: s.textContent.trim(), busy: document.getElementById("grid").getAttribute("aria-busy") };
  `);
  assert.equal(feedStatus.role, "status");
  assert.equal(feedStatus.busy, "false");
  // The number announced is the length of what the server sent, never a
  // decorated or rounded figure.
  assert.equal(feedStatus.text, `${WORLDS.length} worlds`, "the feed announces the count it actually received");
});

// ------------------------------------------- the pages this lane did not own
//
// profile-v3, social-v3 and history-v3 all set link text to --purple (#7c3aed),
// which measures 3.45:1 on their background — under the 4.5:1 minimum. They were
// reported by reading the CSS and then fixed on that basis, which is exactly the
// kind of change that should not be trusted until something measures it. This
// does. --purple is still correct for fills and borders; only TEXT moved.

for (const page_ of ["profile-v3.html", "social-v3.html", "history-v3.html"]) {
  test(`A11Y: every word ${page_} paints clears the WCAG minimum for its own size`, opts, async () => {
    await page.goto(site.url + "/" + page_, { waitMs: 700 });
    const rows = await page.eval(`${HELPERS} return _scanText();`);
    assert.ok(rows.length >= 5, `expected ${page_} measured, got ${rows.length} pieces of text`);
    assert.deepEqual(belowMinimum(rows), [], `text on ${page_} below the WCAG minimum against what is painted behind it`);
  });
}

test("A11Y: the way out of a locked page is readable and hittable", opts, async () => {
  // The internal gate replaces the whole document and offers exactly one action.
  // It measured 3.14:1 at 14px and was 145x17 — a person who cannot read or hit
  // the way out of a locked page has been locked out twice.
  //
  // THIS TEST USED TO ASSERT NOTHING AT ALL, for two compounding reasons, both
  // measured on 7 Sep 2026:
  //
  //   - it called `DCSTruth.renderInternalGate`, which has never existed. The
  //     gate is rendered by a private showGate() reached through the exported
  //     DCSTruth.requireInternalTester(), so the ternary took its null branch
  //     and no gate was ever put on the page.
  //   - and the evaluated snippet ended in a bare expression rather than a
  //     `return`, so Page.eval — which wraps the source in an async function —
  //     handed back `undefined` whatever happened. `if (!gate) return;` then
  //     bailed out on EVERY run, and a test that had never once reached an
  //     assertion reported green for as long as it had existed.
  //
  // So it now drives the real entry point against the real refusal: the stub
  // answers /v3/subscriptions/grants with a 404, which is what
  // requireInternalTester() treats as "not an internal tester", and the gate
  // that appears is the one a locked-out person actually sees. No conditional
  // is left in the test: if the gate does not render, that is a failure.
  // The refusal has to come from the SERVER's answer to the predicate the gate
  // actually asks — not from a fixture that forgot to stub it, which would
  // prove only that a 404 closes the gate.
  grantsRefused = true;
  try {
  await page.goto(site.url + "/create-v3.html", { waitMs: 300 });
  const gate = await page.eval(`
    if (!window.DCSTruth || typeof DCSTruth.requireInternalTester !== "function") {
      return { error: "DCSTruth.requireInternalTester is not exported; the gate has no entry point" };
    }
    const allowed = await DCSTruth.requireInternalTester("The world builder");
    const panel = document.querySelector(".dcs-gate");
    const exits = Array.prototype.map.call(document.querySelectorAll(".dcs-gate a"), function (a) {
      const r = a.getBoundingClientRect();
      return { href: a.getAttribute("href"), text: (a.innerText || "").trim(), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return { error: null, allowed: allowed, rendered: !!panel, heading: panel ? (panel.querySelector("h1") || {}).innerText : null, exits: exits };
  `);
  assert.equal(gate.error, null, gate.error || "");
  assert.equal(gate.allowed, false, "a refused grants check must not report the caller as an internal tester");
  assert.ok(gate.rendered, "a refused internal-tester check must render the gate, not leave the surface open");
  assert.match(String(gate.heading), /internal tester/i, `the gate must say why it is closed, got ${JSON.stringify(gate.heading)}`);

  const rows = await page.eval(`${HELPERS} return _scanText();`);
  assert.ok(rows.length >= 4, `the gate's own text must be measurable, got ${rows.length} pieces`);
  assert.deepEqual(belowMinimum(rows), [], "the gate's own text must be readable");

  assert.ok(gate.exits.length >= 1, "a locked page must offer at least one way out");
  const small = gate.exits.filter((e) => e.h < 44);
  assert.deepEqual(small, [], `the gate's only action must be hittable: ${JSON.stringify(gate.exits)}`);
  } finally { grantsRefused = false; }
});
