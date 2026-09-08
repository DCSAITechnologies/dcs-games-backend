#!/usr/bin/env node
// The header, signed out and signed in, on every page of the journey.
//
// The public marketing header and the authenticated shell are two different
// components — index.html has its own, and player-chrome.js renders the one the
// other 132 pages use. The founder's requirement is that they hold the same
// quality, so this measures both against the same rules and, for the
// authenticated shell, checks the thing a signed-out screenshot can never show:
// that the header does not MOVE when the profile arrives.
//
//   JWT_PATH=<staging token> node scripts/acceptance-header.mjs
import fs from "node:fs";
import { launchChrome, Page } from "../test/helpers/browser.mjs";

const PREVIEW = process.env.PREVIEW_URL || "https://sprint-preview-07sep2026.dcs-games.pages.dev";
const JWT = fs.readFileSync(process.env.JWT_PATH, "utf8").trim();
const K = "dcsgames.token";

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, d = "") => { if (c) { pass++; out.push(`  PASS  ${n}`); } else { fail++; out.push(`  FAIL  ${n}${d ? " — " + d : ""}`); } };

const browser = await launchChrome({ headless: true });

/** The authenticated shell's top bar, measured. */
const TOPBAR = `
  var top = document.querySelector(".pd-top") || document.querySelector(".v3-hdr");
  if (!top) return JSON.stringify({ absent: true });
  var r = top.getBoundingClientRect();
  var av = document.getElementById("pdAvatar") || document.getElementById("v3Av");
  var burger = document.getElementById("pdBurger");
  var brand = document.querySelector(".v3-brand, .pd-logo");
  var kids = Array.prototype.filter.call(top.children, function (el) {
    return getComputedStyle(el).display !== "none";
  }).map(function (el) {
    var b = el.getBoundingClientRect();
    return { cls: el.className || el.id, h: Math.round(b.height), cy: Math.round(b.top + b.height / 2),
             right: Math.round(b.right) };
  });
  return JSON.stringify({
    h: Math.round(r.height), top: Math.round(r.top),
    kids: kids,
    avatar: av ? (av.textContent || "").trim() : null,
    avatarLabel: av ? av.getAttribute("aria-label") : null,
    burgerVisible: burger ? getComputedStyle(burger).display !== "none" : false,
    kind: top.className.indexOf("v3-hdr") !== -1 ? "v3" : "shell",
    hasBrand: !!brand,
    hasNavHome: !!document.querySelector('.v3-hdr a[href*="index"], .pd-side a[href*="index"], .v3-hdr a[href="/"], .pd-side a[href="/"]'),
    docScrollW: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  });`;

async function signedIn(path, waitMs = 1200, width = 1440, { awaitHeader = true } = {}) {
  const p = await Page.open(browser);
  await p.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await p.goto(PREVIEW + "/", { waitMs: 500 });
  await p.eval(`localStorage.setItem(${JSON.stringify(K)}, ${JSON.stringify(JWT)}); return 1;`);
  await p.goto(PREVIEW + path, { waitMs });
  // Wait for the header to mount rather than sleeping a guessed number of
  // milliseconds. create-v3 is the heaviest page in the journey and mounted its
  // header a few hundred ms after the others, which a fixed 4200ms sleep read
  // as "this page has no header at all". Bounded, so a page that genuinely
  // never mounts one still fails.
  if (awaitHeader) {
    await p.waitFor(`document.querySelector(".pd-top") || document.querySelector(".v3-hdr")`, { timeout: 20000 });
  }
  return p;
}

try {
  // ------------------------------------------- the authenticated shell, page by page
  const PAGES = ["/player-home", "/create-v3", "/profile-v3", "/history-v3", "/explore-v3"];
  const shapes = [];
  for (const path of PAGES) {
    const p = await signedIn(path);
    // The initials arrive from GET /me/profile. Bounded: a page that never
    // fills them still fails, but a page that takes 900ms does not.
    await p.waitFor(`(function(){ var a = document.getElementById("pdAvatar") || document.getElementById("v3Av");
                                  return a && a.textContent.trim() && a.textContent.trim() !== "\u00b7"; })()`,
                    { timeout: 15000 });
    const m = JSON.parse(await p.eval(TOPBAR));
    ok(`${path} renders a header`, !m.absent, "no .pd-top and no .v3-hdr");
    if (!m.absent) {
      shapes.push({ path, h: m.h, kind: m.kind });
      const cys = m.kids.map((k) => k.cy);
      const spread = Math.max(...cys) - Math.min(...cys);
      ok(`${path} top bar controls share a vertical centre line`, spread <= 3, `spread ${spread}px`);
      ok(`${path} does not scroll sideways`, m.docScrollW <= m.innerWidth + 1,
         `${m.docScrollW} in ${m.innerWidth}`);
      ok(`${path} carries the brand and a route home`, m.hasBrand && m.hasNavHome,
         `brand=${m.hasBrand} home=${m.hasNavHome}`);
      ok(`${path} shows the signed-in visitor's own initials, not a placeholder`,
         !!m.avatar && m.avatar !== "·" && m.avatar !== "DK",
         `avatar="${m.avatar}" label="${m.avatarLabel}"`);
    }
    ok(`${path} no uncaught console errors`, p.realErrors([]).length === 0,
       p.realErrors([]).slice(0, 2).join(" | "));
    await p.close();
  }

  // Same geometry everywhere: a header that changes height between pages of one
  // journey reads as a different site each time.
  for (const kind of ["shell", "v3"]) {
    const group = shapes.filter((s) => s.kind === kind);
    if (!group.length) continue;
    const hs = group.map((s) => s.h);
    ok(`the ${kind} header is the same height on every page that uses it`,
       Math.max(...hs) - Math.min(...hs) <= 2,
       group.map((s) => `${s.path}=${s.h}`).join(" "));
  }

  // --------------------------------------------- no layout shift on hydration
  {
    // The avatar starts as a neutral glyph and is filled in from /me/profile.
    // If that changes the bar's height, the whole page jumps under the pointer
    // a second after it loads.
    const p = await signedIn("/player-home", 700, 1440, { awaitHeader: false });
    const before = JSON.parse(await p.eval(TOPBAR));
    await new Promise((r) => setTimeout(r, 5000));
    const after = JSON.parse(await p.eval(TOPBAR));
    ok("the header does not change height when the profile arrives",
       !before.absent && !after.absent && Math.abs(before.h - after.h) <= 1,
       `${before.h}px -> ${after.h}px`);
    ok("and the avatar did fill in, so this is not a vacuous pass",
       after.avatar && after.avatar !== "·", `avatar="${after.avatar}"`);
    await p.close();
  }

  // --------------------------------------------------- signed OUT vs signed IN
  {
    const p = await Page.open(browser);
    await p.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await p.goto(PREVIEW + "/", { waitMs: 500 });
    await p.eval(`localStorage.clear(); return 1;`);
    await p.goto(PREVIEW + "/", { waitMs: 2500 });
    const signedOut = JSON.parse(await p.eval(`
      var right = document.querySelector("header .nav-right");
      var labels = Array.prototype.map.call(right.querySelectorAll("a"), function (a) {
        return getComputedStyle(a).display === "none" ? null : (a.textContent || "").trim();
      }).filter(Boolean);
      return JSON.stringify({ labels: labels, h: Math.round(document.querySelector("header").getBoundingClientRect().height) });`));
    ok("signed out, the public header offers a way to log in",
       signedOut.labels.some((l) => /log in/i.test(l)), signedOut.labels.join(", "));
    await p.close();
  }

  // ------------------------------------------------- back button and new tab
  {
    const p = await signedIn("/player-home");
    await p.goto(PREVIEW + "/explore-v3", { waitMs: 3000 });
    await p.eval(`history.back(); return 1;`);
    await new Promise((r) => setTimeout(r, 2500));
    const path = await p.eval(`return location.pathname`);
    const tok = await p.eval(`return (localStorage.getItem(${JSON.stringify(K)})||"").length`);
    ok("browser BACK returns to the previous page", /player-home/.test(path), path);
    ok("and the session survives it", tok > 0);
    await p.close();
  }

  // ------------------------------------------------------- narrow: the burger
  {
    const p = await signedIn("/player-home", 4000, 480);
    const m = JSON.parse(await p.eval(TOPBAR));
    ok("at 480px the authenticated shell shows its menu control", m.burgerVisible);
    const opened = await p.eval(`
      document.getElementById("pdBurger").click();
      return new Promise(function (r) { setTimeout(function () {
        var side = document.querySelector(".pd-side");
        r(JSON.stringify({ open: side.classList.contains("open"),
                           expanded: document.getElementById("pdBurger").getAttribute("aria-expanded") }));
      }, 300); });`);
    const o = JSON.parse(opened);
    ok("and it opens the sidebar", o.open === true);
    ok("and it reports its state to assistive technology", o.expanded === "true");
    ok("at 480px the shell does not scroll sideways", m.docScrollW <= m.innerWidth + 1,
       `${m.docScrollW} in ${m.innerWidth}`);
    await p.close();
  }
} finally {
  await browser.close();
}

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   preview=${PREVIEW}`);
process.exit(fail ? 1 : 0);
