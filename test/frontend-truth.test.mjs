// A5 + A6 exit gate, verified in a real browser rather than by reading source.
//
// Serves the canonical frontend (dcs-games-LIVE) with the same _redirects rules
// Cloudflare Pages applies, drives Chrome over CDP, and asserts that the fixes
// the Round-2 audit demanded are actually visible to a user.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { resolveSite } from "./helpers/site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(HERE);   // throws loudly if the frontend is absent
const EVIDENCE = path.resolve(HERE, "../../../DCS_GAMES_SPRINT_SEP2026/evidence/screenshots");

const haveSite = fs.existsSync(path.join(SITE, "index.html"));   // false only under DCS_ALLOW_MISSING_SITE=1
const haveChrome = !!findChrome();
const opts = { skip: !haveSite ? "dcs-games-LIVE not found" : (!haveChrome ? "no Chrome binary" : false) };

let server, browser, page;

before(async () => {
  if (opts.skip) return;
  server = await serveStatic(SITE);
  browser = await launchChrome();
  page = await Page.open(browser);
}, opts);

after(async () => {
  await page?.close();
  await browser?.close();
  await server?.close();
});

test("A6 GATE: /terms is a real terms page, not the marketing homepage", opts, async () => {
  await page.goto(server.url + "/terms");
  const t = await page.text();
  assert.match(t, /Terms of Use/i);
  assert.doesNotMatch(t, /Create Worlds With AI/i, "the homepage must not stand in for a legal page");
  assert.match(t, /controlled internal testing/i, "the page must state the product's real status");
});

test("A6: /privacy names the actual data flows, including AI providers", opts, async () => {
  await page.goto(server.url + "/privacy");
  const t = await page.text();
  assert.match(t, /Privacy Notice/i);
  assert.match(t, /Supabase/);
  assert.match(t, /AI providers?/i);
  assert.match(t, /payment or card details/i);
});

test("A6: /dmca and /legal resolve to real documents", opts, async () => {
  await page.goto(server.url + "/dmca");
  assert.match(await page.text(), /Copyright and DMCA/i);
  await page.goto(server.url + "/legal");
  assert.match(await page.text(), /Legal and policy/i);
});

test("A6 GATE: an unknown route 404s instead of serving the homepage with HTTP 200", opts, async () => {
  await page.goto(server.url + "/definitely-not-a-real-route-zzz");
  const t = await page.text();
  assert.match(t, /404|does not exist/i);
  assert.doesNotMatch(t, /Create Worlds With AI/i);
  const main = page.responses.find((r) => r.url.endsWith("/definitely-not-a-real-route-zzz"));
  assert.equal(main?.status, 404, "the status code itself must be 404");
});

test("A6 GATE: the legal index explicitly disclaims every fabricated claim", opts, async () => {
  await page.goto(server.url + "/legal");
  const t = await page.text();
  for (const claim of [/No amount has been paid to creators/i, /no marketplace revenue/i,
                       /No automated moderation/i, /No child has earned money/i]) {
    assert.match(t, claim);
  }
});

test("A6 GATE: the marketplace shows no sales figures at all", opts, async () => {
  // The marketplace is now an internal-tester surface, so an unauthenticated
  // visitor sees the gate. Either way, no sales figure may reach the page.
  await page.goto(server.url + "/games-marketplace.html", { waitMs: 1800 });
  const t = await page.text();
  for (const n of ["842,000", "842000", "1,240,000", "190,000", "$1.24"]) {
    assert.ok(!t.includes(n), `fabricated figure still rendered: ${n}`);
  }
  assert.match(t, /limited to internal testers/i, "the economy surface must be gated");
  await page.screenshot(path.join(EVIDENCE, "a6-marketplace-gated-no-metrics.png"));
});

test("A6 GATE: an ungated page renders unmeasured metrics as an em dash", opts, async () => {
  await page.goto(server.url + "/player-play.html", { waitMs: 2500 });
  const t = await page.text();
  for (const n of ["12,400,000", "87,000", "190,000", "2,431"]) {
    assert.ok(!t.includes(n), `fabricated figure still rendered: ${n}`);
  }
  assert.match(t, /\u2014/, "unmeasured metrics must render as an em dash, not a number");
  assert.match(t, /not measured|unavailable/i, "and must say why they are blank");
  await page.screenshot(path.join(EVIDENCE, "a6-unmeasured-renders-as-dash.png"));
});

test("A6 GATE: the homepage renders no fabricated headline figures", opts, async () => {
  await page.goto(server.url + "/games-home.html", { waitMs: 2200 });
  const t = await page.text();
  for (const n of ["12,400,000", "12.4M", "$1,500,000", "1,500,000", "190,000", "87,000"]) {
    assert.ok(!t.includes(n), `fabricated figure still rendered: ${n}`);
  }
  await page.screenshot(path.join(EVIDENCE, "a6-home-no-fabricated-metrics.png"));
});

test("A5/A6: every page carries the controlled-internal-testing banner", opts, async () => {
  for (const p of ["/index.html", "/games-home.html", "/games-explore.html", "/play.html"]) {
    await page.goto(server.url + p, { waitMs: 900 });
    const t = await page.text();
    assert.match(t, /Controlled internal testing/i, `${p} does not declare its status`);
    assert.match(t, /30 September 2026/, `${p} does not state the window`);
  }
});

test("A6: pages built from the bundled sample set say so", opts, async () => {
  await page.goto(server.url + "/games-explore.html", { waitMs: 1200 });
  const t = await page.text();
  assert.match(t, /Sample content/i);
  assert.match(t, /not real users, real worlds or measured activity/i);
});

test("A5 GATE: builder and economy surfaces are gated to internal testers", opts, async () => {
  for (const p of ["/cr-world.html", "/mk-worlds.html", "/games-create.html"]) {
    await page.goto(server.url + p, { waitMs: 2500 });
    const t = await page.text();
    assert.match(t, /limited to internal testers/i, `${p} is not gated`);
    assert.match(t, /30 September 2026/, `${p} does not state the window`);
  }
  await page.screenshot(path.join(EVIDENCE, "a5-builder-gated.png"));
});

test("no page throws a script error after the truth layer was added", opts, async () => {
  const pages = ["/index.html", "/games-home.html", "/games-explore.html", "/games-marketplace.html",
                 "/games-atlas.html", "/play.html", "/player-play.html", "/legal/terms.html"];
  const broken = [];
  for (const p of pages) {
    await page.goto(server.url + p, { waitMs: 1200 });
    const errs = page.realErrors([/Failed to fetch/i, /api\.games\.dcsai\.ai/i, /NetworkError/i]);
    if (errs.length) broken.push(`${p}: ${errs[0]}`);
  }
  assert.deepEqual(broken, [], "the truth layer must not break any page");
});
