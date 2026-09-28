// DCS Games route audit crawler.
//   node audit.mjs <label> <mode:anon|tester> <viewports:comma list e.g. 1920x1080,390x844> [routeFilterRegex]
// Serves nothing itself — expects pages-server.mjs on BASE.
// API calls to the staging backend are proxied server-side (route.fetch) so CORS
// does not mask what the server really answers. In `tester` mode a fake bearer
// token is planted and ONLY /v3/subscriptions/grants is stubbed to ok:true, so
// internal-gated layouts can be seen; every other call still goes to staging
// (and will 401 on the fake token — recorded, not hidden).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [label = "baseline", mode = "anon", vpArg = "1440x900", filter = ""] = process.argv.slice(2);
const BASE = process.env.BASE || "http://127.0.0.1:8788";
const SITE = process.env.SITE;
const STAGE = "https://dcs-games-backend-staging.up.railway.app";
const SUPA_STAGE = "https://nemmayskbjugulrncufd.supabase.co";
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), `audit-${label}.json`);
const CONC = Number(process.env.CONC || 6);
const VPS = vpArg.split(",").map(s => { const [w, h] = s.split("x").map(Number); return { w, h }; });

function listRoutes(dir, rel = "") {
  let out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "tools") continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) out = out.concat(listRoutes(dir, r));
    else if (e.name.endsWith(".html")) out.push("/" + r.replace(/\.html$/, "").replace(/(^|\/)index$/, "$1"));
  }
  return out;
}
let routes = listRoutes(SITE).sort();
if (filter) routes = routes.filter(r => new RegExp(filter).test(r));

process.on("unhandledRejection", e => console.error("unhandled:", String(e && e.message || e).slice(0, 200)));
process.on("uncaughtException", e => console.error("uncaught:", String(e && e.message || e).slice(0, 200)));
const browser = await chromium.launch();
const results = [];
const jobs = [];
for (const r of routes) for (const vp of VPS) jobs.push({ route: r, vp });

async function run(job) {
  const ctx = await browser.newContext({ viewport: { width: job.vp.w, height: job.vp.h }, hasTouch: job.vp.w < 800, isMobile: job.vp.w < 800, deviceScaleFactor: 1 });
  await ctx.addInitScript(({ mode, STAGE, SUPA_STAGE }) => {
    window.DCS_API_BASE = STAGE; window.DCS_SUPABASE_URL = SUPA_STAGE;
    if (mode === "tester") { try { localStorage.setItem("dcsgames.token", "h.eyJleHAiOjQxMDI0NDQ4MDB9.s"); localStorage.setItem("dcsgames.user", JSON.stringify({ username: "audit" })); sessionStorage.setItem("dcs_beta_ok", "1"); } catch (e) {} }
  }, { mode, STAGE, SUPA_STAGE });
  const api = [];
  await ctx.route(STAGE + "/**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    if (mode === "tester") {
      // A signed-in internal tester with an empty account: identity routes are stubbed
      // (no staging credentials exist); everything public is proxied WITHOUT the fake token.
      const P = u.pathname, J = (b) => { api.push({ m: req.method(), p: P, s: "STUB200" }); return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(b) }); };
      if (P === "/v3/subscriptions/grants") return J({ ok: true, grants: [] });
      if (P === "/me/profile") return J({ ok: true, principal_id: "p_1", username: "founder", display_name: "Founder", level: "explorer" });
      if (P === "/me/home") return J({ ok: true, profile: { level: "explorer", xp: 0 }, worlds: { counted: 0, published: 0, complete: true }, recent: [] });
      if (P === "/me/streak") return J({ ok: true, current: 0, played_today: false });
      if (P === "/me/achievements") return J({ ok: true, unlocked: 0, total: 12, achievements: [] });
      if (P === "/social/friends") return J({ ok: true, friends: [], incoming: [] });
      if (/^\/(me|social|v3\/jobs|safety|verify|api\/worlds\/mine|v3\/marketplace\/(owned|ledger|storefronts))(\/|$)/.test(P)) return J({ ok: true, items: [], worlds: [], parties: [], teams: [], orgs: [], blocks: [] });
    }
    // Never let the audit write to staging.
    if (req.method() !== "GET") { api.push({ m: req.method(), p: u.pathname, s: "BLOCKED_WRITE" }); return route.fulfill({ status: 599, headers: cors, body: "{}" }); }
    try {
      const hdr = { ...req.headers() }; if (mode === "tester") delete hdr.authorization;
      const resp = await route.fetch({ timeout: 20000, headers: hdr });
      api.push({ m: "GET", p: u.pathname, s: resp.status() });
      return route.fulfill({ response: resp, headers: { ...resp.headers(), ...cors } });
    } catch (e) { api.push({ m: "GET", p: u.pathname, s: "NETERR" }); return route.abort(); }
  });
  const page = await ctx.newPage();
  const errors = [], consoleErr = [], failed = [];
  page.on("pageerror", e => errors.push(String(e.message).slice(0, 200)));
  page.on("console", m => { if (m.type() === "error") consoleErr.push(m.text().slice(0, 200)); });
  page.on("requestfailed", r => { const f = r.failure(); if (f && !/ABORTED/.test(f.errorText)) failed.push(r.url().slice(0, 120) + " " + f.errorText); });
  page.on("response", r => { const u = r.url(); if (r.status() >= 400 && !u.startsWith(STAGE)) failed.push(r.status() + " " + u.slice(0, 120)); });
  const res = { route: job.route, vp: `${job.vp.w}x${job.vp.h}`, mode };
  try {
    const resp = await page.goto(BASE + job.route, { waitUntil: "load", timeout: 30000 });
    res.status = resp ? resp.status() : null;
    await page.waitForTimeout(Number(process.env.SETTLE || 4000));
    res.finalPath = new URL(page.url()).pathname + new URL(page.url()).search;
    res.redirected = res.finalPath.replace(/\?.*$/, "") !== job.route;
    Object.assign(res, await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight, de = document.documentElement, b = document.body;
      const cs = el => getComputedStyle(el);
      const vis = el => { const r = el.getBoundingClientRect(); const s = cs(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
      const inFixed = el => { for (let e = el; e && e !== b; e = e.parentElement) { const p = cs(e).position; if (p === "fixed") return true; } return false; };
      const desc = el => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "") + " '" + (el.textContent || el.value || "").trim().slice(0, 30) + "'";
      // scroll containers
      const scrollers = [];
      for (const el of document.querySelectorAll("*")) {
        const s = cs(el); if (!/(auto|scroll)/.test(s.overflowY)) continue;
        if (el.scrollHeight > el.clientHeight + 4 && el.clientHeight >= 150 && el !== de && el !== b) scrollers.push(desc(el) + ` ${el.clientHeight}/${el.scrollHeight}`);
      }
      const docScrollable = document.scrollingElement.scrollHeight > vh + 4;
      const htmlOv = cs(de).overflowY, bodyOv = cs(b).overflowY;
      const htmlOv0 = cs(de).overflowY; const docLocked = /hidden|clip/.test(htmlOv) || (/hidden|clip/.test(bodyOv) && !/hidden|clip/.test(htmlOv) ? true : false);
      // reachability of the last and evenly-sampled interactive elements
      const cand = [...document.querySelectorAll("a[href],button,input,select,textarea,h1,h2,h3,[role=button]")]
        .filter(vis).filter(el => !inFixed(el) && !el.closest("#dcs-beta-lock") && !el.matches(".skip-link,.sr") && !el.closest(".row"));
      const pick = new Set(cand.slice(-6));
      for (let i = 0; i < cand.length; i += Math.max(1, Math.floor(cand.length / 8))) pick.add(cand[i]);
      const unreachable = [];
      for (const el of pick) {
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
        // A box with overflow:hidden can be scrolled by script but never by a person.
        let clippedBy = null;
        for (let a = el.parentElement; a && a !== de; a = a.parentElement) {
          if (/hidden|clip/.test(cs(a).overflowY) && a.scrollTop > 0) { clippedBy = clippedBy || desc(a).slice(0, 40); a.scrollTop = 0; }
        }
        if ((/hidden|clip/.test(htmlOv) || (htmlOv === "visible" && /hidden|clip/.test(bodyOv))) && document.scrollingElement.scrollTop > 0) clippedBy = clippedBy || "viewport locked (html/body overflow:hidden)";
        if (clippedBy) { unreachable.push(desc(el) + " (clipped by " + clippedBy + ")"); continue; }
        const r = el.getBoundingClientRect();
        const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = r.top + r.height / 2;
        let ok = r.bottom > 0 && r.top < vh && cy >= 0 && cy < vh;
        if (ok) { const hit = document.elementFromPoint(cx, cy); ok = !!hit && (hit === el || el.contains(hit) || hit.contains(el)); if (!ok && hit) { el.__hit = desc(hit); } }
        if (!ok) unreachable.push(desc(el) + (el.__hit ? " (covered by " + el.__hit + ")" : ` (rect top ${Math.round(r.top)} vh ${vh})`));
      }
      window.scrollTo({ top: 0, behavior: "instant" });
      const text = b.innerText || "";
      return {
        title: document.title,
        hOverflow: de.scrollWidth > vw + 1 ? de.scrollWidth - vw : 0,
        docScrollable, docLocked, htmlOv, bodyOv, scrollers,
        contentH: Math.max(document.scrollingElement.scrollHeight, ...[...document.querySelectorAll(".pd,.pd-main,.pd-view,main")].map(e => e.scrollHeight)),
        unreachable, candidates: cand.length,
        hasSiteHeader: !!document.querySelector(".mtop"), hasPdTop: !!document.querySelector(".pd-top"), hasSidebar: !!document.querySelector(".pd-side"),
        hasAnyHeader: !!document.querySelector("header,.mtop,.pd-top,nav"),
        gated: !!document.querySelector(".dcs-gate"), betaLock: !!document.querySelector("#dcs-beta-lock"),
        sampleBanner: !!document.querySelector(".dcs-banner-sample"),
        soonBlocks: document.querySelectorAll(".soon-block,.soon-tag").length,
        deadLinks: [...document.querySelectorAll('a[href="#"],a[href=""],a:not([href])')].filter(vis).length,
        placeholderText: [].concat(text.match(/lorem ipsum|coming soon|\bTODO\b/gi) || [], text.match(/\bundefined\b|\bNaN\b|\[object Object\]/g) || []).slice(0, 5),
        loadingStuck: (text.match(/loading…|Loading\.\.\.|Loading…/g) || []).length,
        authLink: (document.getElementById("mAuthLink") || {}).textContent || null,
        textLen: text.length,
      };
    }));
  } catch (e) { res.navError = String(e.message).slice(0, 200); }
  res.jsErrors = errors; res.consoleErrors = consoleErr.filter(t => !/favicon|cdn-cgi/.test(t)); res.failed = failed; res.api = api;
  await ctx.close();
  return res;
}

let i = 0, done = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (i < jobs.length) { const j = jobs[i++]; try { results.push(await run(j)); } catch (e) { results.push({ route: j.route, vp: `${j.vp.w}x${j.vp.h}`, mode, navError: "CRAWLER: " + String(e.message).slice(0, 160) }); } if (++done % 25 === 0) console.error(`${done}/${jobs.length}`); }
}));
await browser.close();
results.sort((a, b) => a.route.localeCompare(b.route) || a.vp.localeCompare(b.vp));
fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
console.log(`wrote ${OUT} (${results.length} rows, ${routes.length} routes)`);
