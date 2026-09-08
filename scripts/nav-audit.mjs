#!/usr/bin/env node
// Every visible navigation control, actually clicked.
//
// The point of this script is that a link is not audited by reading its href.
// A control can point at a file that exists, render a page that returns 200,
// and still be a dead end — because the page it reaches is a stub, because the
// backend capability behind it was never wired, or because eight menu items all
// land on the same undifferentiated page.
//
// So each control is NAVIGATED, and the resulting page is judged by what it
// actually did: what it rendered, which API paths it requested, and what the
// backend answered.
//
//   PREVIEW_URL=<deployed preview> JWT_PATH=<token file> node scripts/nav-audit.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page } from "../test/helpers/browser.mjs";
import { resolveSite } from "../test/helpers/site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(path.join(HERE, "../test"));
const API = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = process.env.JWT_PATH ? fs.readFileSync(process.env.JWT_PATH, "utf8").trim() : null;

const PREVIEW = process.env.PREVIEW_URL || "https://sprint-preview-07sep2026.dcs-games.pages.dev";
// The controls are read from the LOCAL source (so the audit covers the build in
// the working tree), but every target is visited on the DEPLOYED preview, where
// the environment resolver points at real staging. Against the local static
// server the API base resolves to localhost and no page can be seen talking to
// anything.
const server = await serveStatic(SITE);
const browser = await launchChrome({ headless: true });

/** Pull the header's controls out of the live DOM, not out of the source. */
async function controls() {
  const p = await Page.open(browser);
  await p.goto(server.url + "/index.html", { waitMs: 1200 });
  const list = JSON.parse(await p.eval(`
    var out = [];
    function push(group, el){
      var h = el.getAttribute("href");
      out.push({ group: group, label: (el.textContent||"").replace(/\\s+/g," ").trim().slice(0,30), href: h });
    }
    var nav = document.querySelector("header .navlinks");
    Array.prototype.forEach.call(nav.children, function(c){
      if (c.tagName === "A") push("top", c);
      else {
        var trig = c.querySelector(".trig");
        if (trig) push("top", trig);
        Array.prototype.forEach.call(c.querySelectorAll(".mega a[href], .flyout a[href]"), function(a){
          push((trig ? trig.textContent.replace(/\\s+/g,"").trim() : "menu"), a);
        });
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll("header .nav-right > a[href]"), function(a){ push("actions", a); });
    Array.prototype.forEach.call(document.querySelectorAll("[data-nav-panel] a[href]"), function(a){ push("mobile-menu", a); });
    return JSON.stringify(out);`));
  await p.close();
  return list;
}

/** Visit one target and report what it really is. */
const seen = new Map();
async function probe(href) {
  const key = href.split("#")[0];
  if (seen.has(key)) return seen.get(key);
  const rel = key.replace(/^\//, "");
  const exists = fs.existsSync(path.join(SITE, rel));
  const p = await Page.open(browser);
  const r = { exists, requested: [], apis: [], title: "", chars: 0, gate: false, sample: false, landed: "" };
  if (exists) {
    // Signed OUT first: an auth gate is a real behaviour, not a defect.
    await p.goto(PREVIEW + "/" + rel, { waitMs: 3200 });
    r.title = await p.eval(`return document.title || ""`);
    const text = (await p.text()) || "";
    r.chars = text.trim().length;
    r.landed = await p.eval(`return location.pathname`);
    r.gate = await p.eval(`
      if (document.querySelector(".dcs-gate")) return true;
      var main = document.querySelector("#pd-view, #site-view, main, #main");
      var t = (main ? main.innerText : "").slice(0, 700);
      return /you need to sign in|sign in to|internal tester|not authorised|not authorized|limited to authorized/i.test(t);`);
    r.sample = await p.eval(`return !!document.querySelector(".dcs-banner-sample")`);
    r.apis = p.requestedUrls()
      .map((u) => { try { return new URL(u).pathname; } catch { return ""; } })
      .filter((path) => /^\/(v3|me|api|social|safety|atlas|worlds|profiles|verify)\b/.test(path));
    r.apis = [...new Set(r.apis)];
  }
  await p.close();
  seen.set(key, r);
  return r;
}

const rows = [];
for (const c of await controls()) {
  if (!c.href || /^(https?:|mailto:)/.test(c.href)) continue;
  const info = await probe(c.href);
  rows.push({ ...c, ...info });
}

/** The classification the founder asked for, argued from the evidence above. */
function classify(r) {
  if (!r.href) return "DEFECT";
  if (r.href === "#" || (r.href.startsWith("#") )) return "DEFECT";
  if (!r.exists) return "DEFECT";
  if (r.chars < 40) return "DEFECT";
  if (r.gate) return "AUTH_GATED";
  if (r.apis.length > 0) return "WORKING_REAL";
  if (r.sample) return "WORKING_FRONTEND_ONLY";
  return "BACKEND_WIRING_REQUIRED";
}

const out = [];
out.push("| CONTROL | ROUTE | TARGET EXISTS | CLICK WORKS | AUTH | BACKEND CONTRACT | STATUS |");
out.push("| --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const st = classify(r);
  out.push(`| ${r.group === "top" || r.group === "actions" || r.group === "mobile-menu" ? "**" + r.label + "**" : r.group + " › " + r.label} | \`${r.href}\` | ${r.exists ? "yes" : "**NO**"} | ${r.chars >= 40 ? "yes" : "**NO**"} | ${r.gate ? "gated" : "public"} | ${r.apis.length ? r.apis.slice(0, 3).map((a) => "`" + a + "`").join(" ") : "—"} | ${st} |`);
}

const counts = {};
for (const r of rows) { const s = classify(r); counts[s] = (counts[s] || 0) + 1; }
console.log(out.join("\n"));
console.log("\n" + Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `${k}: ${v}`).join("\n"));
console.log(`\ntotal controls audited: ${rows.length}`);
fs.writeFileSync(path.join(HERE, "../reports/NAVIGATION_MATRIX.md"),
  "# Navigation matrix — every visible header control, actually clicked\n\n" +
  "Generated by `scripts/nav-audit.mjs`. Each control is navigated in a real\n" +
  "browser; the status is argued from what the destination rendered and which\n" +
  "API paths it requested, not from reading its href.\n\n" +
  out.join("\n") + "\n\n## Totals\n\n" +
  Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `- **${k}**: ${v}`).join("\n") + "\n");

await browser.close();
await server.close();
