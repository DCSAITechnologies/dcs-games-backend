#!/usr/bin/env node
// The founder journey, driven end to end in a real browser against the deployed
// preview and the deployed staging backend.
//
// Written for the defect reported on 7 Sep 2026 — "after login, clicking Play
// Game can sign the user out" — and kept as the guard for it. The failure was
// never in the play button: /player-home destroyed the session, and the click
// was simply the next thing that needed it. So this asserts the token at EVERY
// hop rather than only at the end, because a journey that ends signed in tells
// you nothing about whether it was signed in throughout.
//
//   JWT_PATH=<file with a staging access token> node scripts/acceptance-journey.mjs
import fs from "node:fs";
import { launchChrome, Page } from "../test/helpers/browser.mjs";

const PREVIEW = process.env.PREVIEW_URL || "https://sprint-preview-07sep2026.dcs-games.pages.dev";
const API = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = fs.readFileSync(process.env.JWT_PATH, "utf8").trim();
const K = "dcsgames.token";

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, d = "") => { if (c) { pass++; out.push(`  PASS  ${n}`); } else { fail++; out.push(`  FAIL  ${n}${d ? " — " + d : ""}`); } };

const browser = await launchChrome({ headless: true });
const tok = (p) => p.eval(`return (localStorage.getItem(${JSON.stringify(K)})||"").length`);

try {
  const p = await Page.open(browser);
  await p.goto(PREVIEW + "/", { waitMs: 600 });
  await p.eval(`localStorage.setItem(${JSON.stringify(K)}, ${JSON.stringify(JWT)}); return 1;`);

  // ---------------------------------------------------------- 1. player home
  await p.goto(PREVIEW + "/player-home", { waitMs: 5000 });
  ok("the session survives loading player home", (await tok(p)) > 0,
     "the token was deleted by the page — this is the reported defect");
  ok("player home is player home, not the login page",
     (await p.eval(`return location.pathname`)) === "/player-home");

  const home = await p.eval(`return JSON.stringify({
    expired: /session has expired/i.test(document.body.innerText),
    unreadable: /account could not be read/i.test(document.body.innerText),
    cta: (document.getElementById("heroCta")||{}).textContent || "",
    chars: document.body.innerText.trim().length })`);
  const H = JSON.parse(home);
  ok("player home does not claim the session expired", H.expired === false, home);
  ok("player home could read the account", H.unreadable === false, home);
  ok("player home rendered a call to action", H.cta.trim().length > 0, `cta="${H.cta}"`);

  // An authenticated read from inside the page, with whatever the page still holds.
  const meStatus = await p.eval(`
    return fetch(${JSON.stringify(API)} + "/me/profile", { headers: { Authorization: "Bearer " + (localStorage.getItem(${JSON.stringify(K)})||"") } })
      .then(r => r.status + "").catch(e => "ERR");`);
  ok("the page can still read its own profile from staging", meStatus === "200", `HTTP ${meStatus}`);

  // ------------------------------------------------------------- 2. Play
  const link = await p.eval(`
    var a = document.querySelector('#heroCta a[href*="play-v3"]') || document.querySelector('a[href*="play-v3"]');
    return a ? a.getAttribute("href") : "";`);
  ok("player home offers a way into a world", !!link, "no play link rendered");

  if (link) {
    await p.goto(PREVIEW + link, { waitMs: 1500 });
    // Wait for the world to settle rather than sleeping a guessed number of
    // milliseconds. A fixed sleep here made this assertion flake, and a flaky
    // acceptance check is worse than none: it teaches you to re-run until green.
    // The wait is bounded, so a world that never loads still fails.
    const loaded = await p.waitFor(
      `/world loaded/i.test(document.body.innerText) || /could not load the world|need to sign in/i.test(document.body.innerText)`,
      { timeout: 30000 });
    ok("the play page reached a settled state within 30s", loaded,
       "neither a loaded world nor an error appeared — the page hung");
    ok("the session survives clicking through to play", (await tok(p)) > 0,
       "THE REPORTED DEFECT: the play click ended signed out");
    ok("play did not bounce to the login page",
       !(await p.eval(`return location.pathname`)).startsWith("/login"));

    const play = ((await p.text()) || "");
    ok("the world actually loaded", /world loaded/i.test(play), play.slice(0, 160).replace(/\s+/g, " "));
    ok("play does not ask a signed-in user to sign in",
       !/you need to sign in/i.test(play), play.slice(0, 160).replace(/\s+/g, " "));

    // ------------------------------------------------ 3. back, reload, new tab
    await p.goto(PREVIEW + "/player-home", { waitMs: 4000 });
    ok("the session survives going back to player home", (await tok(p)) > 0);
    ok("and player home still does not claim the session expired",
       !/session has expired/i.test((await p.text()) || ""));

    await p.goto(PREVIEW + link, { waitMs: 1500 });
    await p.waitFor(`/world loaded|could not load/i.test(document.body.innerText)`, { timeout: 30000 });
    ok("the session survives a reload of the world", (await tok(p)) > 0);

    const p2 = await Page.open(browser);
    await p2.goto(PREVIEW + "/player-home", { waitMs: 5000 });
    ok("a NEW TAB is still signed in", (await tok(p2)) > 0);
    ok("and the new tab did not land on login",
       (await p2.eval(`return location.pathname`)) === "/player-home");
    await p2.close();
  }

  // ------------------------------------------------------------ 4. sign out
  await p.goto(PREVIEW + "/player-home", { waitMs: 4000 });
  await p.eval(`return (window.DCSAuth && DCSAuth.logout) ? (DCSAuth.logout("/index.html"), 1) : 0;`);
  await p.waitFor(`!localStorage.getItem(${JSON.stringify(K)})`, { timeout: 15000 });
  ok("an explicit sign-out really does end the session", (await tok(p)) === 0,
     "logout must still clear — the fix must not make sign-out impossible");

  ok("no uncaught console errors across the whole journey", p.realErrors([]).length === 0,
     p.realErrors([]).slice(0, 2).join(" | "));
  await p.close();
} finally {
  await browser.close();
}

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   preview=${PREVIEW}`);
process.exit(fail ? 1 : 0);
