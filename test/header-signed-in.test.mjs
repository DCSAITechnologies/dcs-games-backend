// The signed-in header must fit its viewport whatever the username is. (29 Sep 2026.)
//
// QA SWEEP A1-04 (NEW_REGRESSION in the recovery branch): signed in as
// "@qasweep29sepa1local" on the homepage at 768x1024 the header row laid out
// 835px — 67px past the edge — and the avatar sat at x=835, clipped by
// body{overflow-x:hidden}, so the account control could not be reached. A
// 53-character name took the row to 1095px and put Create and Play off-screen
// up to 1024px. The shared marketing header (assets/site-chrome.js) had the
// same defect over a wider band: one row down to 821px, so from 821 to 1240 the
// actions ran past the edge even signed out (1252px of header at 821).
//
// header-nav.test.mjs covers the signed-OUT homepage. This covers the state the
// sweep found broken: a session, a real username, and one that is absurdly
// long — the only width in the row a user chooses. It also puts markup in the
// name, because the name is user input and is written into the header.
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

// The six the sweep measures, plus the edges of every breakpoint the two
// headers have (640/641, 820/821, 1023/1024, 1240/1241).
const WIDTHS = [320, 390, 641, 768, 821, 1023, 1024, 1240, 1241, 1280, 1440];
const NAMES = {
  sweep: "qasweep29sepa1local",
  long: "an_extremely_long_username_that_never_ends_1234567890_abcdefgh",
  markup: "<img src=x onerror=window.__pwned=1>averyveryverylongname",
};
// index.html carries its own header; the games-*, cm-*, ev-* and at-* pages
// share site-chrome.js.
const ROUTES = ["/index.html", "/games-explore.html", "/games-home.html"];

let server, browser;
before(async () => {
  if (opts.skip) return;
  server = await serveStatic(SITE);
  browser = await launchChrome();
}, opts);
after(async () => { await browser?.close(); await server?.close(); });

function session(name) {
  return `
    window.DCS_API_BASE = "https://stub.api.invalid";
    window.DCS_SUPABASE_URL = "https://stub.supabase.co";
    try {
      localStorage.setItem("dcsgames.token", "h.eyJleHAiOjQxMDI0NDQ4MDB9.s");
      localStorage.setItem("dcsgames.user", ${JSON.stringify(JSON.stringify({ username: name, display_name: name }))});
    } catch (e) {}
    var real = window.fetch;
    window.fetch = function (u) {
      if (String(u).indexOf("https://stub.") !== 0) return real.apply(this, arguments);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, username: ${JSON.stringify(name)}, display_name: ${JSON.stringify(name)}, grants: [], items: [], worlds: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }));
    };`;
}

async function openAt(w, route, name) {
  const p = await Page.open(browser);
  await p.send("Emulation.setDeviceMetricsOverride", { width: w, height: 1024, deviceScaleFactor: 1, mobile: w < 800 });
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: session(name) });
  await p.goto(server.url + route, { waitMs: 700 });
  return p;
}

const MEASURE = `
  var hdr = document.querySelector("header");
  var row = hdr.querySelector(".nav, .mtop-in") || hdr;
  var off = [];
  hdr.querySelectorAll("a, button, .avatar").forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (!r.width || el.closest(".mega, .flyout")) return;          // hover menus are positioned by design
    if (r.right > innerWidth + 0.5 || r.left < -0.5) off.push((el.id || el.textContent.trim().slice(0, 16)) + " " + Math.round(r.left) + "-" + Math.round(r.right));
  });
  // Nav links and actions must not paint over one another either: an overflow
  // the row absorbs by overlapping is not visible to scrollWidth.
  var links = hdr.querySelector(".navlinks, .mnav"), acts = hdr.querySelector(".nav-right, .mtop-cta");
  var linkR = 0;
  if (links) Array.prototype.forEach.call(links.children, function (c) { var r = c.getBoundingClientRect(); if (r.width) linkR = Math.max(linkR, r.right); });
  var actL = acts && acts.getBoundingClientRect().width ? acts.getBoundingClientRect().left : Infinity;
  var av = document.getElementById("mAvatar"), avr = av && av.getBoundingClientRect();
  var acct = document.getElementById("mAuthLink"), span = acct && acct.querySelector("span");
  return {
    hdrSW: hdr.scrollWidth, hdrCW: hdr.clientWidth, rowSW: row.scrollWidth, rowCW: row.clientWidth,
    docSW: document.documentElement.scrollWidth, iw: innerWidth, off: off,
    overlap: linkR > actL + 0.5 ? Math.round(linkR - actL) : 0,
    avatar: av ? { shown: avr.width > 0, left: Math.round(avr.left), right: Math.round(avr.right), label: av.getAttribute("aria-label") } : null,
    acctText: span ? span.textContent : (acct ? acct.textContent : ""),
    acctLines: acct && acct.getBoundingClientRect().width ? (function () { var r = document.createRange(); r.selectNodeContents(span || acct); return new Set(Array.prototype.map.call(r.getClientRects(), function (x) { return Math.round(x.top); })).size; })() : 0,
    injected: !!window.__pwned || !!hdr.querySelector("img"),
  };`;

for (const route of ROUTES) {
  for (const [kind, name] of Object.entries(NAMES)) {
    test(`SIGNED-IN HEADER ${route} as a ${kind} username: fits at every width, nothing off-screen or overlapped`, opts, async () => {
      const bad = [];
      for (const w of WIDTHS) {
        const p = await openAt(w, route, name);
        try {
          const m = await p.eval(MEASURE);
          if (m.hdrSW > m.hdrCW) bad.push(`${w}px: header scrollWidth ${m.hdrSW} > clientWidth ${m.hdrCW}`);
          if (m.rowSW > m.rowCW) bad.push(`${w}px: header row lays out ${m.rowSW}px in ${m.rowCW}px`);
          if (m.docSW > m.iw) bad.push(`${w}px: the page scrolls sideways (${m.docSW}px)`);
          if (m.off.length) bad.push(`${w}px: off-screen: ${m.off.join(", ")}`);
          if (m.overlap) bad.push(`${w}px: nav links run ${m.overlap}px under the actions`);
          if (m.acctLines > 1) bad.push(`${w}px: the username wraps onto ${m.acctLines} lines`);
          if (m.injected) bad.push(`${w}px: the username was parsed as markup`);
          // The avatar is the account control on the homepage; the sweep found
          // it at x=835 in a 768px window. Below 641px it is in the menu panel.
          if (route === "/index.html" && w > 640) {
            if (!m.avatar || !m.avatar.shown) bad.push(`${w}px: the account avatar is not shown`);
            else if (m.avatar.right > w || m.avatar.left < 0) bad.push(`${w}px: avatar at ${m.avatar.left}-${m.avatar.right}`);
            else if (!/^Signed in as /.test(m.avatar.label || "")) bad.push(`${w}px: avatar does not say whose account it is`);
          }
        } finally { await p.close(); }
      }
      assert.deepEqual(bad, [], bad.join("\n"));
    });
  }

  test(`SIGNED-IN HEADER ${route}: the full username is still available, as text, where it is truncated`, opts, async () => {
    const p = await openAt(1100, route, NAMES.long);
    try {
      const r = await p.eval(`var a = document.getElementById("mAuthLink"); var s = a.querySelector("span");
        return { text: (s || a).textContent, title: a.title, clipped: s ? s.scrollWidth > s.clientWidth : false };`);
      assert.equal(r.text, "@" + NAMES.long, "the name is written in full and clipped by CSS, not cut in the DOM");
      assert.equal(r.title, "@" + NAMES.long, "a clipped name carries the full one as its title");
    } finally { await p.close(); }
  });
}

test("SIGNED-IN HEADER: at phone and tablet widths the menu panel carries Dashboard and Log out", opts, async () => {
  const bad = [];
  for (const route of ROUTES) for (const w of [320, 390, 768]) {
    const p = await openAt(w, route, NAMES.long);
    try {
      const r = await p.eval(`
        var t = document.getElementById("mBurger") || document.querySelector("[data-nav-toggle]"); t.click();
        await new Promise(function (res) { setTimeout(res, 150); });
        var panel = document.getElementById("mPanel") || document.getElementById("navPanel");
        var shown = Array.prototype.filter.call(panel.querySelectorAll("a"), function (a) { return a.getBoundingClientRect().width > 0; });
        var off = shown.filter(function (a) { var b = a.getBoundingClientRect(); return b.right > innerWidth + 0.5 || b.left < -0.5; }).map(function (a) { return a.textContent.trim().slice(0, 20); });
        return { dash: shown.some(function (a) { return /player-home/.test(a.getAttribute("href")); }),
                 out: shown.some(function (a) { return /log ?out/i.test(a.textContent); }),
                 off: off, docSW: document.documentElement.scrollWidth, iw: innerWidth };`);
      if (!r.dash) bad.push(`${route} ${w}px: no Dashboard link in the open menu`);
      if (!r.out) bad.push(`${route} ${w}px: no Log out in the open menu`);
      if (r.off.length) bad.push(`${route} ${w}px: menu items off-screen: ${r.off.join(", ")}`);
      if (r.docSW > r.iw) bad.push(`${route} ${w}px: open menu makes the page scroll sideways`);
    } finally { await p.close(); }
  }
  assert.deepEqual(bad, [], bad.join("\n"));
});
