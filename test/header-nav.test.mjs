// The public header must be one clean row, and every control in it must go
// somewhere.
//
// FOUNDER-OBSERVED, 7 Sep 2026: "Login wraps into two lines, Create With AI is
// oversized, Play is oversized, header controls are vertically misaligned,
// overall desktop header looks unfinished."
//
// Measured before any change, on the deployed staging build, at every desktop
// width from 960px to 1600px:
//
//   1600px header=67  heights 71/94/71/34  wrapped: "Log in"x2 "Create With AI"x3 "Play"x2
//   1180px header=67  heights 71/116/71/34 wrapped: "Log in"x2 "Create With AI"x4 "Play"x2
//
// Three buttons, each taller than the 67px header that contains them, each with
// its label broken across two to four lines. The cause is not the button: it is
// that `.nav-right` had no flex-shrink:0 and its buttons had no white-space:
// nowrap, so the nav links won the space contest and the actions were squeezed
// until their text wrapped. Below 900px the nav is display:none and the same
// buttons render 49px, single line, correctly — the RESPONSIVE path was fine
// and the DESKTOP path was broken, which is the opposite of the usual story.
//
// These tests are geometric rather than visual: they assert the things a
// screenshot would show a human, in numbers a machine can fail on.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { resolveSite } from "./helpers/site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(HERE);
const haveSite = fs.existsSync(path.join(SITE, "index.html"));
const haveChrome = !!findChrome();
const opts = { skip: !haveSite ? "dcs-games-LIVE not found" : (!haveChrome ? "no Chrome binary" : false) };

// The widths a desktop visitor actually has. 1280 and 1440 are the common
// laptop panels; 960 is the narrowest width that still shows the full nav.
const DESKTOP = [1600, 1440, 1366, 1280, 1180, 1100, 1024, 960];

let server, browser;

before(async () => {
  if (opts.skip) return;
  server = await serveStatic(SITE);
  browser = await launchChrome();
}, opts);

after(async () => {
  await browser?.close();
  await server?.close();
});

const MEASURE = `
  var hdr = document.querySelector("header");
  if (!hdr) return JSON.stringify({ error: "no <header>" });
  var right = hdr.querySelector(".nav-right");
  if (!right) return JSON.stringify({ error: "no .nav-right" });
  function lines(el){ var r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; }
  var hb = hdr.getBoundingClientRect();
  var ctrls = Array.prototype.map.call(right.children, function (el) {
    var b = el.getBoundingClientRect();
    return {
      t: (el.textContent || "").trim().slice(0, 24),
      avatar: el.classList.contains("avatar"),
      w: Math.round(b.width), h: Math.round(b.height),
      x: Math.round(b.left), right: Math.round(b.right),
      top: Math.round(b.top), bottom: Math.round(b.bottom),
      cy: Math.round(b.top + b.height / 2),
      lines: lines(el),
      ws: getComputedStyle(el).whiteSpace,
    };
  });
  return JSON.stringify({
    innerWidth: window.innerWidth,
    headerTop: Math.round(hb.top), headerBottom: Math.round(hb.bottom),
    headerH: Math.round(hb.height),
    docScrollW: document.documentElement.scrollWidth,
    controls: ctrls,
    navVisible: !!hdr.querySelector(".navlinks") &&
                getComputedStyle(hdr.querySelector(".navlinks")).display !== "none",
  });`;

async function headerAt(width, { mobile = false } = {}) {
  const p = await Page.open(browser);
  await p.send("Emulation.setDeviceMetricsOverride", {
    width, height: 900, deviceScaleFactor: 1, mobile,
  });
  await p.goto(server.url + "/index.html", { waitMs: 1200 });
  const m = JSON.parse(await p.eval(MEASURE));
  await p.close();
  assert.ok(!m.error, m.error);
  return m;
}

test("HEADER: no control's label wraps onto a second line at any desktop width", opts, async () => {
  const bad = [];
  for (const w of DESKTOP) {
    const m = await headerAt(w);
    for (const c of m.controls) if (c.lines > 1) bad.push(`${w}px "${c.t}" on ${c.lines} lines`);
  }
  assert.deepEqual(bad, [], "header labels broke across lines:\n  " + bad.join("\n  "));
});

test("HEADER: every control sits inside the header, not overflowing it", opts, async () => {
  const bad = [];
  for (const w of DESKTOP) {
    const m = await headerAt(w);
    for (const c of m.controls) {
      // 1px of tolerance for sub-pixel rounding, and no more.
      if (c.bottom > m.headerBottom + 1 || c.top < m.headerTop - 1) {
        bad.push(`${w}px "${c.t}" ${c.top}..${c.bottom} outside header ${m.headerTop}..${m.headerBottom}`);
      }
    }
  }
  assert.deepEqual(bad, [], "controls escaped the header box:\n  " + bad.join("\n  "));
});

test("HEADER: the buttons share one height and one vertical centre line", opts, async () => {
  const bad = [];
  for (const w of DESKTOP) {
    const m = await headerAt(w);
    // The avatar is a circle and is allowed its own size; the BUTTONS must match.
    // Identified by its class: it used to read "OV" for everyone (fake initials),
    // and now carries the signed-in person's own initials or a neutral glyph.
    const btns = m.controls.filter((c) => !c.avatar && c.w > 0);
    const hs = btns.map((c) => c.h);
    const cys = btns.map((c) => c.cy);
    const hSpread = Math.max(...hs) - Math.min(...hs);
    const cSpread = Math.max(...cys) - Math.min(...cys);
    if (hSpread > 2) bad.push(`${w}px heights ${hs.join("/")} differ by ${hSpread}px`);
    if (cSpread > 2) bad.push(`${w}px centres ${cys.join("/")} differ by ${cSpread}px`);
    // A header button taller than the header is the reported defect.
    for (const c of btns) {
      if (c.h > m.headerH) bad.push(`${w}px "${c.t}" is ${c.h}px in a ${m.headerH}px header`);
    }
  }
  assert.deepEqual(bad, [], "header controls are not on one line:\n  " + bad.join("\n  "));
});

test("HEADER: the page never scrolls sideways because of the header", opts, async () => {
  // Phones included, and measured against the width we ASKED for rather than
  // window.innerWidth. Under mobile emulation Chrome zooms the visual viewport
  // out to fit an over-wide page, so innerWidth grows to match the content and
  // an overflow of 97px reports itself as no overflow at all. That is exactly
  // how a clipped phone header passed a scroll-width check.
  const bad = [];
  for (const w of [...DESKTOP, 834, 768, 430, 390, 360]) {
    const m = await headerAt(w);
    if (m.docScrollW > w + 1) bad.push(`${w}px viewport needs ${m.docScrollW}px`);
  }
  assert.deepEqual(bad, [], "horizontal overflow:\n  " + bad.join("\n  "));
});

test("HEADER: no control is clipped by the viewport edge at any width", opts, async () => {
  // The overflow test above does not catch this. At 390px the action buttons
  // ran past the right edge while `document.scrollWidth` stayed equal to the
  // viewport, because something up the tree clips rather than scrolls — so the
  // page looked fine to a scroll-width check and the Play button was simply not
  // on screen. Clipped is worse than overflowing: there is no way to reach it.
  const bad = [];
  for (const w of [1600, 1440, 1280, 1180, 1024, 834, 768, 430, 390, 360]) {
    const m = await headerAt(w);
    for (const c of m.controls) {
      if (c.w === 0) continue;                       // display:none is a decision, not a defect
      const right = c.top !== undefined ? null : null;
      if (c.x !== undefined && c.x < -1) bad.push(`${w}px "${c.t}" starts at ${c.x}`);
      if (c.right !== undefined && c.right > w + 1) {
        bad.push(`${w}px "${c.t}" ends at ${c.right} in a ${w}px viewport`);
      }
    }
  }
  assert.deepEqual(bad, [], "header controls clipped off-screen:\n  " + bad.join("\n  "));
});

test("NAV: no header control is a dead link", opts, async () => {
  // href="#" and a fragment with no matching element are both a control that
  // renders, invites a click, and does nothing.
  const p = await Page.open(browser);
  await p.goto(server.url + "/index.html", { waitMs: 1000 });
  const dead = JSON.parse(await p.eval(`
    var out = [];
    var as = document.querySelectorAll("header a[href]");
    for (var i = 0; i < as.length; i++) {
      var h = as[i].getAttribute("href");
      var label = (as[i].textContent || "").trim().slice(0, 28) || as[i].className;
      if (h === "#" || h === "") { out.push({ label: label, href: h, why: "goes nowhere" }); continue; }
      if (h.charAt(0) === "#") {
        if (!document.getElementById(h.slice(1))) out.push({ label: label, href: h, why: "no such element on this page" });
      }
    }
    return JSON.stringify(out);`));
  await p.close();
  assert.deepEqual(dead, [],
    "dead header controls:\n  " + dead.map((d) => `"${d.label}" -> ${d.href} (${d.why})`).join("\n  "));
});

test("NAV: navigation is reachable at mobile width, not merely hidden", opts, async () => {
  // `@media(max-width:900px){.navlinks{display:none}}` removed the entire site
  // navigation below 900px and put nothing in its place, so a phone had no way
  // to reach Explore, Events, Community, Rewards, Marketplace, Create or Atlas.
  const p = await Page.open(browser);
  await p.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await p.goto(server.url + "/index.html", { waitMs: 1200 });
  const state = JSON.parse(await p.eval(`
    var hdr = document.querySelector("header");
    var links = hdr.querySelector(".navlinks");
    var toggle = hdr.querySelector("[data-nav-toggle]");
    return JSON.stringify({
      navDisplay: links ? getComputedStyle(links).display : "absent",
      hasToggle: !!toggle,
      toggleVisible: toggle ? getComputedStyle(toggle).display !== "none" : false,
    });`));
  assert.ok(state.hasToggle && state.toggleVisible,
    `at 390px the nav is ${state.navDisplay} and there is no visible menu control: ` +
    "a phone cannot reach Explore, Events, Community, Rewards, Marketplace, Create or Atlas");

  // And it must actually open, with the real destinations inside it.
  const opened = JSON.parse(await p.eval(`
    document.querySelector("[data-nav-toggle]").click();
    return new Promise(function (res) { setTimeout(function () {
      var panel = document.querySelector("[data-nav-panel]");
      var as = panel ? panel.querySelectorAll("a[href]") : [];
      res(JSON.stringify({
        open: !!panel && getComputedStyle(panel).display !== "none" &&
              panel.getBoundingClientRect().height > 0,
        links: Array.prototype.map.call(as, function (a) { return (a.textContent || "").trim(); }).slice(0, 12),
      }));
    }, 250); });`));
  await p.close();
  assert.ok(opened.open, "the menu control did not open a visible panel");
  for (const want of ["Home", "Explore", "Events", "Community", "Rewards", "Marketplace", "Create", "Atlas"]) {
    assert.ok(opened.links.some((l) => l === want),
      `the mobile menu is missing "${want}" — it has: ${opened.links.join(", ")}`);
  }
});

test("RESPONSIVE: nothing overlaps the hero prompt at phone width", opts, async () => {
  // The floating .worldchip decorations are positioned at percentages of the
  // hero, and on a 390px screen those percentages put "Zombie Apocalypse"
  // across the prompt input and "Alien Planet" across the Generate button —
  // the first thing the product asks a visitor to do, with a label sitting on
  // top of it.
  const p = await Page.open(browser);
  await p.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await p.goto(server.url + "/index.html", { waitMs: 1400 });
  const hits = JSON.parse(await p.eval(`
    function rect(el){ var r = el.getBoundingClientRect(); return { l:r.left, t:r.top, r:r.right, b:r.bottom, w:r.width, h:r.height }; }
    function overlaps(a, b){ return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t; }
    var input = document.querySelector(".hero input, .hero textarea");
    if (!input) return JSON.stringify([{ why: "no hero input found" }]);
    var ir = rect(input);
    var out = [];
    var decos = document.querySelectorAll(".worldchip");
    for (var i = 0; i < decos.length; i++) {
      var d = decos[i];
      if (getComputedStyle(d).display === "none") continue;
      var dr = rect(d);
      if (dr.w === 0 || dr.h === 0) continue;
      if (overlaps(dr, ir)) out.push({ text: (d.textContent || "").trim().slice(0, 24) });
    }
    return JSON.stringify(out);`));
  await p.close();
  assert.deepEqual(hits, [],
    "decoration is sitting on top of the hero prompt: " + hits.map((h) => h.text || h.why).join(", "));
});
