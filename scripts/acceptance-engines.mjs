#!/usr/bin/env node
// Acceptance in the two engines that had never run this code: WebKit and Gecko.
//
// Every browser proof on this estate was taken in Chromium. The only
// engine-specific defect found all sprint — `::placeholder` opacity, which
// Firefox dims of its own accord — was REASONED about rather than observed, and
// no WebKit had ever loaded a single page. "Probably fine on Safari" was an
// assumption wearing the clothes of a result.
//
// This drives real WebKit and real Gecko builds through playwright-core.
//
// WHAT THIS IS AND IS NOT:
//   - It IS the genuine WebKit engine (WebCore/JavaScriptCore) and the genuine
//     Gecko engine. CSS, layout and JS API defects show up here.
//   - It is NOT Safari.app, and it is NOT iOS Safari. Safari's own chrome,
//     Intelligent Tracking Prevention, and the iOS on-screen keyboard are not
//     covered by this and remain a human/device item.
//   - `scripts/acceptance-webkit.mjs` drives Safari.app itself via safaridriver
//     and covers that gap, but needs a one-time macOS GUI setting.
//
// playwright-core is deliberately NOT a dependency of this repo: adding it
// would change `npm ci` and the cold-rebuild proof for a check that is not part
// of the build. Point PW_CORE at an install, or run from a directory that has
// one. If it is absent this exits 2 — never 0 — so an absent engine can never
// be mistaken for a passing one.
//
//   PW_CORE=/path/to/node_modules/playwright-core \
//   JWT_PATH=<file with a staging access token> \
//   node scripts/acceptance-engines.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const PREVIEW = process.env.PREVIEW_URL || "https://sprint-preview-07sep2026.dcs-games.pages.dev";
const API = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = process.env.JWT_PATH ? fs.readFileSync(process.env.JWT_PATH, "utf8").trim() : null;
const TOKEN_KEY = "dcsgames.token";

// ------------------------------------------------------------ load the engines
let pw = null;
for (const spec of [process.env.PW_CORE, "playwright-core"].filter(Boolean)) {
  try {
    const req = createRequire(import.meta.url);
    pw = req(spec.startsWith("/") ? path.join(spec, "index.js") : spec);
    break;
  } catch { /* try the next */ }
}
if (!pw) {
  console.error("ENGINE COVERAGE NOT RUN — playwright-core is not resolvable.\n");
  console.error("  npm install --prefix /tmp/pw playwright-core@1.61.0");
  console.error("  PW_CORE=/tmp/pw/node_modules/playwright-core node scripts/acceptance-engines.mjs\n");
  console.error("1.61.0 is not arbitrary: it is the release whose pinned WebKit and Gecko");
  console.error("revisions match the browsers already cached on this machine, so nothing");
  console.error("is downloaded. A different playwright version wants different revisions.");
  process.exit(2);
}

let pass = 0, fail = 0;
const out = [];
const ok = (engine, n, c, d = "") => {
  if (c) { pass++; out.push(`  PASS  [${engine}] ${n}`); }
  else { fail++; out.push(`  FAIL  [${engine}] ${n}${d ? " — " + d : ""}`); }
};

/** Every assertion, run once per engine. */
async function runEngine(name, browserType) {
  const exe = browserType.executablePath();
  if (!fs.existsSync(exe)) {
    console.error(`ENGINE COVERAGE NOT RUN — ${name} build absent at ${exe}`);
    process.exit(2);
  }
  const browser = await browserType.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  const go = (p) => page.goto(PREVIEW + p, { waitUntil: "load", timeout: 45000 });

  try {
    // ------------------------------------------------------- the engine itself
    await go("/");
    const ua = await page.evaluate(() => navigator.userAgent);
    if (name === "webkit") {
      ok(name, "this is really WebKit, not Chromium", /AppleWebKit/.test(ua) && !/Chrome\//.test(ua), ua);
    } else {
      ok(name, "this is really Gecko, not Chromium", /Gecko\//.test(ua) && !/Chrome\//.test(ua), ua);
    }

    // ------------------------------------------- the environment resolver runs
    const env = await page.evaluate(() => (window.DCS_ENV ? JSON.parse(JSON.stringify(window.DCS_ENV)) : null));
    ok(name, "the page resolves its environment in this engine", !!env, "window.DCS_ENV absent");
    ok(name, "and it resolves to staging, not production", env?.name === "staging", String(env?.name));
    ok(name, "and points at the staging API", env?.api === API, String(env?.api));

    // --------------------------------- CSS this engine decides for itself
    //
    // background-clip:text with color:transparent renders as INVISIBLE text on
    // an engine without support — not merely low contrast. The @supports
    // fallback for it had never been observed outside Chromium until now.
    const grad = await page.evaluate(() => {
      const el = document.querySelector(".grad, .hero h1 span, h1 span");
      if (!el) return { absent: true };
      const cs = getComputedStyle(el);
      return {
        color: cs.color,
        supports: CSS.supports("-webkit-background-clip", "text") || CSS.supports("background-clip", "text"),
        visible: el.getClientRects().length > 0,
        text: (el.textContent || "").trim().slice(0, 40),
      };
    });
    ok(name, "gradient-clipped heading text is not invisible in this engine",
       grad.absent === true || grad.supports === true ||
       !/transparent|rgba\(0, 0, 0, 0\)/.test(String(grad.color)),
       `color=${grad.color} supports=${grad.supports} text="${grad.text}"`);

    // The placeholder defect Firefox was only ever REASONED about.
    const ph = await page.evaluate(() => {
      const i = document.querySelector("input[placeholder]");
      if (!i) return { absent: true };
      const cs = getComputedStyle(i, "::placeholder");
      return { opacity: cs.opacity, color: cs.color };
    });
    ok(name, "placeholder opacity is pinned, not left to the engine",
       ph.absent === true || Number(ph.opacity) === 1, `opacity=${ph.opacity}`);

    // ----------------------------------------------- CORS, from this engine
    const health = await page.evaluate(async (api) => {
      try {
        const r = await fetch(api + "/health");
        const h = await r.json();
        return { ok: h.ok, payments: h.payments_live, schema: h.schema_assertion?.version };
      } catch (e) { return { error: String(e) }; }
    }, API);
    ok(name, "this engine can reach the staging API cross-origin", health.ok === true, JSON.stringify(health));
    ok(name, "and payments are still dark", health.payments === false, JSON.stringify(health));

    // ------------------------------------------------- the pages actually load
    for (const p of ["/player-home", "/create-v3", "/profile-v3", "/history-v3"]) {
      await go(p);
      const [title, text] = await page.evaluate(() => [document.title || "", document.body ? document.body.innerText : ""]);
      ok(name, `${p} renders`, String(text).trim().length > 40, `${String(text).length} chars`);
      ok(name, `${p} is a real page, not the 404 fallback`,
         !/page not found/i.test(title), `title "${title}"`);
    }

    // ------------------------------------------------- keyboard reachability
    await go("/player-home");
    const focusable = await page.evaluate(() =>
      document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])').length);
    ok(name, "focusable controls exist for keyboard navigation", Number(focusable) > 0, `${focusable} focusable`);

    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const a = document.activeElement;
      return a && a !== document.body ? { tag: a.tagName, label: (a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 40) } : null;
    });
    ok(name, "Tab moves focus off the body in this engine", !!focused, "focus stayed on <body>");

    // --------------------------------------------- the session, in this engine
    if (JWT) {
      await go("/");
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [TOKEN_KEY, JWT]);
      await go("/profile-v3");
      const stored = await page.evaluate((k) => !!localStorage.getItem(k), TOKEN_KEY);
      ok(name, "the session is stored under the key the site reads", stored === true);

      const status = await page.evaluate(async ([api, k]) => {
        const r = await fetch(api + "/me/profile", { headers: { Authorization: "Bearer " + localStorage.getItem(k) } });
        return r.status;
      }, [API, TOKEN_KEY]);
      ok(name, "a signed-in page reads its own profile from staging", status === 200, `HTTP ${status}`);

      await go("/profile-v3");
      const after = await page.evaluate((k) => !!localStorage.getItem(k), TOKEN_KEY);
      ok(name, "a reload keeps the visitor signed in", after === true);
    } else {
      console.error(`  NOTE  [${name}] JWT_PATH unset — the signed-in assertions did not run.`);
    }

    ok(name, "no uncaught page errors across the whole sweep",
       consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * WebKit at phone size, with touch — the closest thing to iOS Safari that does
 * not require a handset. The 320px sweep this estate already has was taken in
 * Chromium, so "narrow" was proven and "narrow AND WebKit" was not. This is
 * emulation: it catches layout and touch-API defects, not GPU behaviour, not
 * the on-screen keyboard, and not ITP. Those stay on the device checklist.
 */
async function runMobileWebKit() {
  const name = "webkit@iPhone";
  const device = pw.devices["iPhone 14"] || pw.devices["iPhone 13"] || pw.devices["iPhone 12"];
  const browser = await pw.webkit.launch({ headless: true });
  const ctx = await browser.newContext({ ...device });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    ok(name, "a phone-shaped WebKit context reports touch support",
       await page.evaluate(() => "ontouchstart" in window || navigator.maxTouchPoints > 0));

    for (const p of ["/", "/player-home", "/create-v3"]) {
      await page.goto(PREVIEW + p, { waitUntil: "load", timeout: 45000 });
      const m = await page.evaluate(() => ({
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
        text: (document.body ? document.body.innerText : "").trim().length,
      }));
      ok(name, `${p} renders at phone width`, m.text > 40, `${m.text} chars`);
      // A horizontal scrollbar on a phone is the classic mobile defect: some
      // element is wider than the viewport and the page slides sideways.
      ok(name, `${p} does not scroll sideways at ${m.winW}px`,
         m.docW <= m.winW + 1, `content ${m.docW}px in a ${m.winW}px viewport`);
    }

    ok(name, "no uncaught page errors at phone size", errors.length === 0, errors.slice(0, 2).join(" | "));
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

const only = process.env.ENGINE;
for (const [name, type] of [["webkit", pw.webkit], ["firefox", pw.firefox]]) {
  if (only && only !== name) continue;
  await runEngine(name, type);
}

if (!only || only === "webkit") await runMobileWebKit();

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   engines=${only || "webkit + firefox"}`);
process.exit(fail ? 1 : 0);
