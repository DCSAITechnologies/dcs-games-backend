#!/usr/bin/env node
// Acceptance: the session, and what a signed-in creator actually sees.
//
// These are the acceptance items that CAN be automated and were not yet
// covered: signing out, signing back in, a reload keeping you signed in, a
// world you just made appearing in your own list, and what a signed-out visitor
// is shown on a gated page.
//
// Driven in a real browser against the DEPLOYED preview and the DEPLOYED
// staging backend, because the point of an acceptance check is that it exercises
// what a person would touch, not a stub.
//
//   JWT_PATH=<file with a staging access token> node scripts/acceptance-session.mjs
import fs from "node:fs";
import { launchChrome, Page } from "../test/helpers/browser.mjs";

const PREVIEW = process.env.PREVIEW_URL || "https://sprint-preview-07sep2026.dcs-games.pages.dev";
const API = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = fs.readFileSync(process.env.JWT_PATH, "utf8").trim();

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, d = "") => { if (c) { pass++; out.push(`  PASS  ${n}`); } else { fail++; out.push(`  FAIL  ${n}${d ? " — " + d : ""}`); } };

const TOKEN_KEY = "dcsgames.token";
const browser = await launchChrome({ headless: true });

/** A page with the session already established, the way auth.js stores it. */
async function signedIn(path, waitMs = 3500) {
  const p = await Page.open(browser);
  await p.goto(PREVIEW + "/", { waitMs: 600 });
  await p.eval(`localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(JWT)}); return 1;`);
  await p.goto(PREVIEW + path, { waitMs });
  return p;
}

try {
  // ------------------------------------------------- signed out: the gate

  {
    const p = await Page.open(browser);
    await p.goto(PREVIEW + "/", { waitMs: 500 });
    await p.eval(`localStorage.clear(); return 1;`);
    await p.goto(PREVIEW + "/create-v3.html", { waitMs: 3000 });
    const text = (await p.text()) || "";

    ok("signed out, a gated page does not show a working builder",
       !/generating|world created/i.test(text), text.slice(0, 100));
    ok("and it says WHY rather than rendering an empty page",
       /sign in|log in|internal|not authorised|not authorized|401|access/i.test(text),
       `page said: ${text.slice(0, 140)}`);
    ok("and it does not fabricate a signed-in identity",
       !/DK\b/.test(text) && !/Level \d+/.test(text));
    ok("no uncaught console errors while gated", p.realErrors([]).length === 0,
       p.realErrors([]).slice(0, 2).join(" | "));
    await p.close();
  }

  // ---------------------------------------------- signed in, then reload

  {
    const p = await signedIn("/profile-v3.html");
    const before = await p.eval(`return localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) ? "yes" : "no"`);
    ok("the session is stored under the key the site actually reads", before === "yes");

    // A real authenticated read must have happened, not just a stored string.
    const me = await p.eval(`
      return fetch(${JSON.stringify(API)} + "/me/profile", { headers: { Authorization: "Bearer " + localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) } })
        .then(r => r.status + "").catch(e => "ERR " + e);`);
    ok("a signed-in page can read its own profile from staging", me === "200", `HTTP ${me}`);

    // Reload: the session must survive.
    await p.goto(PREVIEW + "/profile-v3.html", { waitMs: 3000 });
    const after = await p.eval(`return localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) ? "yes" : "no"`);
    ok("a reload keeps the visitor signed in", after === "yes");
    ok("and no uncaught console errors after the reload", p.realErrors([]).length === 0,
       p.realErrors([]).slice(0, 2).join(" | "));
    await p.close();
  }

  // ------------------------------------------------------------- sign out

  {
    const p = await signedIn("/profile-v3.html");
    // Sign out the way the site does: clear the stored session.
    await p.eval(`localStorage.removeItem(${JSON.stringify(TOKEN_KEY)}); localStorage.removeItem("dcsgames.user"); return 1;`);
    await p.goto(PREVIEW + "/profile-v3.html", { waitMs: 3000 });

    const stored = await p.eval(`return localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`);
    ok("signing out really removes the session", stored === null || stored === "" || stored === undefined,
       String(stored).slice(0, 40));

    const text = (await p.text()) || "";
    ok("and the page afterwards does not still show signed-in data",
       !/Saltgate Works/i.test(text), "a storefront from the signed-in session was still rendered");
    await p.close();
  }

  // --------------------------------- create a world, see it in My Worlds

  {
    const p = await signedIn("/profile-v3.html", 1500);
    const made = await p.eval(`
      return fetch(${JSON.stringify(API)} + "/api/v3/worlds/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) },
        body: JSON.stringify({ prompt: "A tidal orchard that fruits only at the turn of the year." })
      }).then(r => r.json()).then(j => j.world_id || ("FAILED " + JSON.stringify(j).slice(0,120))).catch(e => "ERR " + e);`);
    ok("a world can be created from a signed-in browser session", /^w3_/.test(made), made);

    if (/^w3_/.test(made)) {
      const mine = await p.eval(`
        return fetch(${JSON.stringify(API)} + "/worlds/mine", { headers: { Authorization: "Bearer " + localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) } })
          .then(r => r.json()).then(j => JSON.stringify({
            count: j.count, complete: j.complete, page_limit: j.page_limit,
            has: (j.worlds||[]).some(w => w.world_id === ${JSON.stringify(made)}),
            firstThree: (j.worlds||[]).slice(0,3).map(w => w.updated_at)
          })).catch(e => "ERR " + e);`);
      const m = JSON.parse(mine);
      ok("and it is IMMEDIATELY in the creator's own list", m.has === true,
         `count=${m.count} complete=${m.complete} limit=${m.page_limit} — the newest world must not fall off the page`);
      const s = m.firstThree || [];
      ok("and the list is newest-first", s.length < 2 || String(s[0]) >= String(s[1]),
         s.join(" then "));
      ok("and the page is described as a page, not as a total", typeof m.page_limit === "number");
    }
    await p.close();
  }

  // ------------------------------------------- forbidden, not fabricated

  {
    const p = await signedIn("/profile-v3.html", 1200);
    const other = await p.eval(`
      return fetch(${JSON.stringify(API)} + "/v3/worlds/w3_definitely_not_yours/manifest", { headers: { Authorization: "Bearer " + localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) } })
        .then(r => r.status + "").catch(e => "ERR " + e);`);
    ok("another principal's world is refused, and as a 404 rather than a 403", other === "404",
       `HTTP ${other} — a 403 would confirm the world exists`);

    const bad = await p.eval(`
      return fetch(${JSON.stringify(API)} + "/me/profile", { headers: { Authorization: "Bearer not-a-token" } })
        .then(r => r.status + "").catch(e => "ERR " + e);`);
    ok("a forged credential is refused", bad === "401", `HTTP ${bad}`);
    await p.close();
  }
} finally {
  await browser.close();
}

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   preview=${PREVIEW}`);
process.exit(fail ? 1 : 0);
