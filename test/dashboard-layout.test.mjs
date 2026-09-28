// The dashboard must scroll, at every size a person uses it. (28 Sep 2026.)
//
// FOUNDER-OBSERVED: "dashboard has broken scrolling / cannot properly scroll
// upward/downward."
//
// Production served `body:has(.pd){height:100vh;overflow:hidden}` — body
// overflow propagates to the viewport, so every player page was one screen tall.
// The compat fix moved the same lock onto `.pd`, with no scroll container
// inside it, so the page clipped instead. Measured before this fix, content was
// unreachable on 56 of 56 player pages at 1440x900 and 1280x800 and on 55 of 56
// at 390x844 and 320x700. The Creator Studio shell had the sibling defect: a
// flat 100vh grid under banners inserted above it, in a body that cannot scroll.
//
// These tests do not look at CSS text. They put content taller than the window
// on the page and ask the browser whether a person can reach the end of it.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { resolveSite } from "./helpers/site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(HERE);
const haveSite = fs.existsSync(path.join(SITE, "player-home.html"));
const haveChrome = !!findChrome();
const opts = { skip: !haveSite ? "dcs-games-LIVE not found" : (!haveChrome ? "no Chrome binary" : false) };

const VIEWPORTS = [[1920, 1080], [1440, 900], [1280, 800], [390, 844], [320, 700]];

let server, browser;
before(async () => {
  if (opts.skip) return;
  server = await serveStatic(SITE);
  browser = await launchChrome();
}, opts);
after(async () => { await browser?.close(); await server?.close(); });

/** A signed-in internal tester whose API answers are stubbed and empty. */
const STUB = `
  window.DCS_API_BASE = "https://stub.api.invalid";
  window.DCS_SUPABASE_URL = "https://stub.supabase.co";
  try { localStorage.setItem("dcsgames.token", "h.eyJleHAiOjQxMDI0NDQ4MDB9.s"); sessionStorage.setItem("dcs_beta_ok", "1"); } catch (e) {}
  var real = window.fetch;
  window.fetch = function (u) {
    if (String(u).indexOf("https://stub.api.invalid") !== 0) return real.apply(this, arguments);
    return Promise.resolve(new Response(JSON.stringify({ ok: true, grants: [], items: [], worlds: [], friends: [], incoming: [] }),
      { status: 200, headers: { "Content-Type": "application/json" } }));
  };`;

async function openAt(w, h, route) {
  const p = await Page.open(browser);
  await p.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 });
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
  await p.goto(server.url + route, { waitMs: 1200 });
  return p;
}

/** Can a person bring `sel` into view by scrolling `scroller` (the window if null) and hit it? */
const REACH = `
  function reach(el, scroller) {
    // instant: html{scroll-behavior:smooth} would otherwise animate, and we would measure mid-flight.
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "instant" }); else window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: "instant" });
    var r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + Math.min(r.height, 20) / 2;
    if (!(y >= 0 && y < innerHeight && x >= 0 && x < innerWidth)) return "off-screen at y=" + Math.round(r.top);
    var hit = document.elementFromPoint(x, y);
    return hit && (hit === el || el.contains(hit)) ? "ok" : "covered by " + (hit ? hit.tagName + "." + hit.className : "nothing");
  }`;

for (const [w, h] of VIEWPORTS) {
  test(`player dashboard at ${w}x${h}: the end of the page can be reached, by the one scroll there is`, opts, async () => {
    const p = await openAt(w, h, "/player-settings.html");
    try {
      const r = await p.eval(`${REACH}
        var v = document.getElementById("pd-view");
        var tall = document.createElement("div"); tall.style.height = "2600px"; v.appendChild(tall);
        var b = document.createElement("button"); b.id = "probeBottom"; b.textContent = "the last control on the page"; v.appendChild(b);
        await new Promise(function (res) { requestAnimationFrame(function () { requestAnimationFrame(res); }); });
        var de = document.documentElement, cs = getComputedStyle;
        // Any element other than the sidebar, a card row, or the document that is
        // a vertical scroller as tall as half the window is a second primary scroll.
        var nested = [].filter.call(document.querySelectorAll(".pd *"), function (e) {
          var o = cs(e).overflowY; if (!/(auto|scroll)/.test(o)) return false;
          if (e.closest(".pd-side") || e.closest(".row")) return false;
          return e.scrollHeight > e.clientHeight + 4 && e.clientHeight > innerHeight / 2;
        }).map(function (e) { return e.className || e.tagName; });
        return {
          htmlOv: cs(de).overflowY, bodyOv: cs(document.body).overflowY,
          docTaller: document.scrollingElement.scrollHeight > innerHeight + 100,
          reachBottom: reach(b, null),
          hOverflow: de.scrollWidth - innerWidth,
          nested: nested,
        };`);
      assert.notEqual(r.htmlOv, "hidden", "html must not lock the page");
      assert.notEqual(r.bodyOv, "hidden", "body must not lock the page (it propagates to the viewport)");
      assert.ok(r.docTaller, "the document itself must be what scrolls");
      assert.equal(r.reachBottom, "ok", "the last control on a tall dashboard page must be reachable: " + r.reachBottom);
      assert.deepEqual(r.nested, [], "exactly one primary scroll per screen; found nested: " + r.nested.join(", "));
      assert.ok(r.hOverflow <= 0, `no sideways scroll at ${w}px (document is ${r.hOverflow}px too wide)`);
    } finally { await p.close(); }
  });
}

for (const [w, h] of VIEWPORTS.filter(([vw]) => vw > 900)) {
  test(`player sidebar at ${w}x${h}: stays in view and its last link is reachable`, opts, async () => {
    const p = await openAt(w, h, "/player-settings.html");
    try {
      const r = await p.eval(`${REACH}
        var v = document.getElementById("pd-view"), tall = document.createElement("div"); tall.style.height = "3000px"; v.appendChild(tall);
        window.scrollTo({ top: 2000, behavior: "instant" });
        var side = document.getElementById("pdSide"), sr = side.getBoundingClientRect();
        var links = side.querySelectorAll(".side-link:not([hidden])"), last = links[links.length - 1];
        return { sideTop: Math.round(sr.top), sideVisible: sr.bottom > 100, last: reach(last, side), label: last.textContent.trim() };`);
      assert.ok(r.sideVisible && r.sideTop <= 1, `the sidebar must stay in view while the page scrolls (top=${r.sideTop})`);
      assert.equal(r.last, "ok", `the last sidebar link (${r.label}) must be reachable: ${r.last}`);
    } finally { await p.close(); }
  });
}

for (const [w, h] of VIEWPORTS.filter(([vw]) => vw < 800)) {
  test(`player drawer at ${w}x${h}: opens, locks the page behind it, scrolls itself, and closes`, opts, async () => {
    const p = await openAt(w, h, "/player-settings.html");
    try {
      const r = await p.eval(`${REACH}
        document.getElementById("pdBurger").click();
        await new Promise(function (res) { setTimeout(res, 400); });
        var side = document.getElementById("pdSide"), links = side.querySelectorAll(".side-link:not([hidden])");
        var open = { cls: document.body.classList.contains("pd-drawer-open"), last: reach(links[links.length - 1], side) };
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await new Promise(function (res) { setTimeout(res, 50); });
        return { open: open, closedCls: document.body.classList.contains("pd-drawer-open"), expanded: document.getElementById("pdBurger").getAttribute("aria-expanded") };`);
      assert.equal(r.open.cls, true, "the page behind an open drawer must not scroll under the thumb");
      assert.equal(r.open.last, "ok", "the drawer's last link must be reachable: " + r.open.last);
      assert.equal(r.closedCls, false, "closing the drawer must give the page its scroll back");
      assert.equal(r.expanded, "false");
    } finally { await p.close(); }
  });

  test(`player header at ${w}x${h}: search keeps a usable width and nothing is pushed off-screen`, opts, async () => {
    const p = await openAt(w, h, "/player-home.html");
    try {
      const r = await p.eval(`var s = document.getElementById("pdSearch").getBoundingClientRect(), a = document.getElementById("pdAvatar").getBoundingClientRect();
        return { searchW: Math.round(s.width), avRight: Math.round(a.right), avW: Math.round(a.width), avH: Math.round(a.height) };`);
      assert.ok(r.searchW >= 100, `search input is ${r.searchW}px wide — too narrow to type in`);
      assert.ok(r.avRight <= w, `avatar ends at ${r.avRight}px, past the ${w}px edge`);
      assert.equal(r.avW, r.avH, "avatar must stay a circle, not be squeezed");
    } finally { await p.close(); }
  });
}

for (const [w, h] of VIEWPORTS) {
  test(`creator studio at ${w}x${h}: the banners do not push the panes off a page that cannot scroll`, opts, async () => {
    const p = await openAt(w, h, "/studio/pages/npcs.html");
    try {
      const r = await p.eval(`${REACH}
        await new Promise(function (res) { setTimeout(res, 600); });
        var st = document.querySelector(".studio"), rail = document.getElementById("rail"), main = document.querySelector(".main");
        var links = rail.querySelectorAll("a"), last = links[links.length - 1];
        var probe = document.createElement("button"); probe.textContent = "end of main"; var pad = document.createElement("div"); pad.style.height = "2600px";
        main.appendChild(pad); main.appendChild(probe);
        return { gated: !!document.querySelector(".dcs-gate"), bottom: Math.round(st.getBoundingClientRect().bottom), rail: reach(last, rail), main: reach(probe, main),
                 hOverflow: document.documentElement.scrollWidth - innerWidth };`);
      assert.equal(r.gated, false, "precondition: the tester gate opened");
      assert.ok(r.bottom <= h + 1, `the studio grid ends at ${r.bottom}px, below the ${h}px window it cannot scroll`);
      assert.equal(r.rail, "ok", "the last studio rail link must be reachable: " + r.rail);
      assert.equal(r.main, "ok", "the end of the main pane must be reachable: " + r.main);
      assert.ok(r.hOverflow <= 0, `no sideways scroll at ${w}px`);
    } finally { await p.close(); }
  });
}

test("critical create page: loads for a signed-in tester with its prompt, and throws nothing", opts, async () => {
  const p = await openAt(1440, 900, "/create-v3.html");
  try {
    const r = await p.eval(`await new Promise(function (res) { setTimeout(res, 500); });
      return { gated: !!document.querySelector(".dcs-gate"), prompt: !!document.getElementById("prompt") };`);
    assert.equal(r.gated, false);
    assert.equal(r.prompt, true, "the prompt box is the whole point of the page");
    assert.deepEqual(p.realErrors(), [], p.realErrors().join(" | "));
  } finally { await p.close(); }
});

test("route navigation: every dashboard sidebar and site-header link points at a page that exists", opts, async () => {
  const exists = (href) => {
    const clean = href.replace(/^\//, "").split(/[?#]/)[0];
    if (!clean) return true;
    return [clean, clean + ".html", path.join(clean, "index.html")].some((c) => fs.existsSync(path.join(SITE, c)));
  };
  const hrefs = [];
  const pc = fs.readFileSync(path.join(SITE, "assets/player-chrome.js"), "utf8");
  const side = pc.slice(pc.indexOf("const SIDE"), pc.indexOf("];", pc.indexOf("const SIDE")));
  for (const m of side.matchAll(/\['([a-z-]+)','[^']*','[^']*','[^']*'(?:,'([^']+)')?\]/g)) hrefs.push(m[2] || `player-${m[1]}.html`);
  const sc = fs.readFileSync(path.join(SITE, "assets/site-chrome.js"), "utf8");
  for (const m of sc.matchAll(/href="([^"#$]+)"/g)) if (!/^https?:/.test(m[1])) hrefs.push(m[1]);
  for (const m of sc.matchAll(/\['([^']+\.html)','/g)) hrefs.push(m[1]);
  assert.ok(hrefs.length > 30, "precondition: the link lists were read");
  const missing = hrefs.filter((h) => !exists(h));
  assert.deepEqual(missing, [], "navigation points at pages that do not exist: " + missing.join(", "));
});
