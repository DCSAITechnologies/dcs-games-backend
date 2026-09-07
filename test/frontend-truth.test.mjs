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
import { resolveSite, resolvePreview, reachPreview, requirePreview } from "./helpers/site.mjs";

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

// ======================================================== the DEPLOYED estate
//
// Everything above serves the checkout from a local static server. That proves
// the markup and nothing about the deploy. Three things are only true of a real
// deployment, and every one of them is a way to lose live data:
//
//   1. WHICH BACKEND the deployed hostname resolves to. assets/dcs-truth.js
//      decides that from location.hostname before anything else runs, because
//      seed-data.js and auth.js both fall back to the PRODUCTION default. A
//      preview that quietly locked onto the production API and the production
//      Supabase project would read and write live data while looking exactly
//      like a test — the worst possible failure, because it looks fine.
//   2. WHETHER THE API ACCEPTS THAT ORIGIN. CORS is enforced from an allowlist,
//      and only a real browser making a real cross-origin request proves it: a
//      curl with an Origin header does not perform the check, it only observes
//      the header.
//   3. WHICH BUILD ANSWERED. /health reports build.commit and a deployment id,
//      so a green run can name the artifact it was green against instead of
//      assuming.
const PREVIEW = resolvePreview();
const STAGING_API = "https://dcs-games-backend-staging.up.railway.app";
const STAGING_SUPABASE = "nemmayskbjugulrncufd.supabase.co";
// Touching either of these from a preview is the failure this section exists
// to catch.
const PRODUCTION_HOSTS = ["api.games.dcsai.ai", "hznrmbxppcxrrrmyutjn.supabase.co"];

let reach = { ok: false, why: "not attempted" };
let previewLive = false;

before(async () => {
  if (opts.skip) return;
  reach = await reachPreview(PREVIEW);
  previewLive = requirePreview(reach, PREVIEW);   // throws unless DCS_ALLOW_MISSING_SITE=1
}, opts);

const pv = { skip: opts.skip };

test("DEPLOY: the preview is reachable, and every deployment assertion below ran against it", pv, async () => {
  // First, so a network that is simply down says so once instead of five times.
  assert.ok(previewLive, reach.why);
  assert.match(PREVIEW, /^https:\/\//, "the preview must be served over HTTPS");
});

test("DEPLOY: the preview resolves the STAGING estate and never touches production", pv, async () => {
  if (!previewLive) assert.fail(reach.why);
  await page.goto(PREVIEW + "/index.html", { waitMs: 2500 });
  const env = await page.eval("return window.DCS_ENV || null;");
  assert.ok(env, "assets/dcs-truth.js did not run, so nothing decided which backend this page talks to");
  assert.equal(env.name, "staging", `a *.pages.dev preview must resolve staging, got ${JSON.stringify(env)}`);
  assert.equal(env.api, STAGING_API, `the API base must be the staging service, got ${env.api}`);
  assert.ok(String(env.supabase).includes(STAGING_SUPABASE),
    `the Supabase project must move with the API — a token minted by one project is rejected by the other; got ${env.supabase}`);

  // And not merely CONFIGURED away from production: nothing the page actually
  // requested may have gone there. Requests are read from what was asked for,
  // not from what answered, so a blocked or refused call still counts.
  const asked = page.requestedUrls();
  assert.ok(asked.length > 3, `expected the page to make real requests, saw ${asked.length}`);
  const leaked = asked.filter((u) => PRODUCTION_HOSTS.some((h) => u.includes(h)));
  assert.deepEqual(leaked, [], "a preview reached a PRODUCTION host: it is reading or writing live data");
});

test("DEPLOY: the staging API accepts the preview origin, checked by a real browser", pv, async () => {
  if (!previewLive) assert.fail(reach.why);
  await page.goto(PREVIEW + "/index.html", { waitMs: 1200 });
  // Issued from the preview document, so the browser performs the actual
  // cross-origin check. A CORS refusal surfaces as a rejected fetch here, which
  // is the only way to tell "allowed" from "the header happened to be echoed".
  const r = await page.eval(`
    try {
      const res = await fetch(window.DCS_API_BASE + "/health", { headers: { accept: "application/json" } });
      const body = await res.json();
      return { ok: true, status: res.status, cors: body.cors || null, build: body.build || null,
               payments_live: body.payments_live, routeGroups: Object.keys(body.routes || {}).length };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  `);
  assert.ok(r.ok, `the preview origin could not read the staging API from the browser: ${r.error}`);
  assert.equal(r.status, 200);
  assert.equal(r.cors && r.cors.mode, "allowlist",
    `CORS must be an allowlist, not open: ${JSON.stringify(r.cors)}`);
  assert.ok(Array.isArray(r.cors.allowed) && r.cors.allowed.length > 0, "the allowlist must name its origins");

  // Name the artifact this run was green against.
  assert.ok(r.build && /^[0-9a-f]{40}$/.test(String(r.build.commit)),
    `/health must report the commit that is serving, got ${JSON.stringify(r.build)}`);
  assert.ok(r.build.deployment_id, "/health must report which deployment answered");
  assert.equal(r.payments_live, false, "money must be dark on staging");
  assert.ok(r.routeGroups >= 8, `the advertised surface must not have collapsed, got ${r.routeGroups} groups`);
});

test("DEPLOY: an origin outside the allowlist is refused by the staging API", pv, async () => {
  if (!previewLive) assert.fail(reach.why);
  // The complement of the test above. An allowlist that lets anything through
  // is not an allowlist, and a wildcard entry is easy to write too broadly.
  const hostile = "https://not-dcs-games.example.com";
  const res = await fetch(STAGING_API + "/health", {
    headers: { Origin: hostile, accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  const allow = res.headers.get("access-control-allow-origin");
  assert.notEqual(allow, hostile, `the staging API echoed an unlisted origin back as allowed: ${allow}`);
  assert.notEqual(allow, "*", "the staging API answered an unlisted origin with a wildcard, which allows anyone");
});

test("DEPLOY: an anonymous visitor is gated on the preview WITHOUT waiting for a server", pv, async () => {
  if (!previewLive) assert.fail(reach.why);
  await page.goto(PREVIEW + "/games-create.html", { waitMs: 4000 });
  const t = await page.text();
  assert.match(t, /limited to internal testers/i, "an anonymous visitor must not get the builder on the deployed preview");
  assert.match(t, /30 September 2026/, "the gate must state the testing window");
  // No credential means gated immediately, with no round trip. A gate that
  // waits for a server to say "no" is OPEN whenever the server is unreachable,
  // misconfigured, or still running an older build — so the absence of the
  // request is the property, not an accident of timing.
  const asked = page.requestedUrls();
  assert.deepEqual(asked.filter((u) => u.startsWith(STAGING_API)), [],
    "a gate with no credential to check must fail closed locally, not ask the server for permission");
});

test("DEPLOY: a credential the allowlist does not hold is refused by the deployed backend", pv, async () => {
  if (!previewLive) assert.fail(reach.why);
  // The other half. With a token present the gate stops guessing and asks the
  // server, and THAT answer — from the deployed staging backend, over a real
  // cross-origin request, against the real internal-tester allowlist — is what
  // decides. A token that is not on the allowlist must be refused; if this ever
  // opens, the builder is open to anyone who can produce any string.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: 'window.DCS_ACCESS_TOKEN = "deploy-probe-not-a-real-token";',
  });
  await page.goto(PREVIEW + "/games-create.html", { waitMs: 6000 });
  const t = await page.text();
  assert.match(t, /limited to internal testers/i,
    "a token the allowlist does not hold must not open the builder on the deployed preview");

  const asked = page.requestedUrls();
  const grants = asked.filter((u) => u.startsWith(STAGING_API) && u.includes("/v3/subscriptions/grants"));
  assert.ok(grants.length >= 1,
    `with a token present the gate must ask the SERVER: requests were ${JSON.stringify(asked.filter((u) => u.startsWith(STAGING_API)))}`);
  // And the refusal shown is the one the server actually gave, not an invented
  // one: the gate prints the status it received.
  const answered = page.responses.filter((r) => r.url.includes("/v3/subscriptions/grants")).map((r) => r.status);
  assert.ok(answered.length >= 1, "the grants check must have been answered by the deployed backend");
  // A cross-origin GET with an Authorization header is preflighted, so the 204
  // for the OPTIONS is part of the exchange and not an answer to the question.
  // What matters is that the GET itself was refused and never succeeded.
  const real = answered.filter((sc) => sc !== 204);
  assert.ok(real.some((sc) => sc === 401 || sc === 403),
    `an unknown credential must be refused with 401 or 403, got ${JSON.stringify(answered)}`);
  assert.ok(!real.includes(200),
    `the allowlist admitted a credential nobody issued: ${JSON.stringify(answered)}`);
  assert.ok(new RegExp("Server response").test(t) || /4\d\d/.test(t),
    "the gate must show the status the server returned, so a refusal is distinguishable from an outage");
});
