#!/usr/bin/env node
// Prove the Cloudflare PREVIEW frontend is actually wired to the STAGING
// backend, in a real browser.
//
// "It deployed" and "the page rendered" are not the claim. The claim is:
// a UI action becomes a request to the staging API, authenticated, answered,
// and reflected in what the page shows — and that no production endpoint is
// contacted anywhere along the way. A preview quietly talking to production
// would look identical from the outside, which is exactly why this exists.
//
//   PREVIEW_URL=https://sprint-preview-07sep2026.dcs-games.pages.dev \
//   node scripts/preview-integration-proof.mjs
import { launchChrome, Page } from "../test/helpers/browser.mjs";
import { REQUIRED_SCHEMA_VERSION } from "../src/core/schema.mjs";

const PREVIEW = process.env.PREVIEW_URL || "https://sprint-preview-07sep2026.dcs-games.pages.dev";
const STAGING_API = "https://dcs-games-backend-staging.up.railway.app";
const PROD_HOSTS = ["api.games.dcsai.ai", "hznrmbxppcxrrrmyutjn.supabase.co"];

let pass = 0, fail = 0;
const lines = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; lines.push(`  PASS  ${name}`); }
  else { fail++; lines.push(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const browser = await launchChrome({ headless: true });
try {
  const pages = ["/", "/create-v3.html", "/worlds.html", "/login.html"];
  for (const path of pages) {
    const page = await Page.open(browser);
    // Record every request the page makes, so "which backend" is observed
    // rather than asserted from configuration.
    const requests = [];
    page.ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === "Network.requestWillBeSent") requests.push(m.params.request.url);
      } catch { /* not a frame we care about */ }
    });
    await page.send("Network.enable");

    try {
      await page.goto(PREVIEW + path, { waitMs: 2500 });

      const env = await page.eval("return JSON.stringify(window.DCS_ENV || null)");
      const e = env ? JSON.parse(env) : null;
      ok(`${path}: the page knows which environment it is in`, !!e, "window.DCS_ENV is absent");
      if (e) {
        ok(`${path}: it resolved to staging`, e.name === "staging", `resolved to '${e.name}'`);
        ok(`${path}: the API base is the staging backend`, e.api === STAGING_API, e.api);
        ok(`${path}: Supabase is the staging project`, /nemmayskbjugulrncufd/.test(e.supabase || ""), e.supabase);
      }

      // The observed truth: nothing may reach a production host.
      const leaked = requests.filter((u) => PROD_HOSTS.some((h) => u.includes(h)));
      ok(`${path}: no request reached a production host`, leaked.length === 0, leaked.slice(0, 3).join(", "));

      const errs = page.realErrors([]);
      ok(`${path}: no uncaught console errors`, errs.length === 0, errs.slice(0, 2).join(" | "));

      const body = await page.text();
      ok(`${path}: the page rendered something`, (body || "").trim().length > 40, `${(body || "").length} chars`);
      ok(`${path}: it is not stuck on a loading state`, !/^\s*(loading|please wait)\W*$/i.test((body || "").trim()));

      // "It rendered something" passes on the 404 page, which is how
      // /worlds.html sat green in this proof while being a dead link. Cloudflare
      // Pages serves 404.html with a 200 for an unknown path, so the status code
      // does not catch it either — the page has to be recognised by what it
      // says.
      const title = await page.eval("return document.title || ''");
      const looks404 = /\b(404|not found|page not found)\b/i.test(title) ||
                       /\b(404|page not found)\b/i.test((body || "").slice(0, 400));
      ok(`${path}: is a real page, not the 404 fallback`, !looks404,
         `title "${title}" — Pages serves 404.html with a 200, so this must be caught by content`);
    } finally {
      await page.close();
    }
  }

  // The one that matters most: a real call to the staging API, from the
  // browser, on the preview origin — which also proves CORS actually permits
  // this origin rather than only appearing to.
  const page = await Page.open(browser);
  try {
    await page.goto(PREVIEW + "/", { waitMs: 1500 });
    const health = await page.eval(`
      return fetch(window.DCS_API_BASE + "/health")
        .then(r => r.json())
        .then(h => JSON.stringify({ ok: h.ok, payments_live: h.payments_live, schema: h.schema_assertion?.version, deployment: h.build?.deployment_id }))
        .catch(e => JSON.stringify({ error: String(e) }));
    `);
    const h = JSON.parse(health);
    ok("the browser can call the staging API from the preview origin", h.ok === true, health);
    ok("and the staging backend still reports payments dark", h.payments_live === false, String(h.payments_live));
    // Read from the source of truth: a hardcoded number makes every migration
  // look like a broken deployment.
  ok(`and the schema it asserts is the one this code requires (v${REQUIRED_SCHEMA_VERSION})`,
     h.schema === REQUIRED_SCHEMA_VERSION, `deployment reports v${h.schema}`);
    ok("and it names the deployment serving it", !!h.deployment, "no deployment id");

    const pub = await page.eval(`
      return fetch(window.DCS_API_BASE + "/api/public/worlds")
        .then(r => r.json()).then(j => JSON.stringify({ ok: j.ok, count: j.count ?? (j.worlds || []).length }))
        .catch(e => JSON.stringify({ error: String(e) }));
    `);
    const p = JSON.parse(pub);
    ok("published worlds load from staging without a login", p.ok === true, pub);
    ok("and there is at least one, so this is real data rather than an empty pass", (p.count ?? 0) > 0, `count=${p.count}`);
  } finally {
    await page.close();
  }
} finally {
  try { browser.kill(); } catch { /* already gone */ }
}

console.log(lines.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   preview=${PREVIEW}`);
process.exit(fail ? 1 : 0);
