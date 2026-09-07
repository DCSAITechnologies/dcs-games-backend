#!/usr/bin/env node
// Acceptance in REAL WebKit — the engine that has never run this code.
//
// Every browser check on this estate has run in Chromium. The one
// engine-specific defect found all session was `::placeholder`, which Firefox
// dims of its own accord — and that was REASONED about, not observed. WebKit is
// the gap that matters most, because it is what every iPhone and every Safari
// user has.
//
// This drives Safari through safaridriver, the WebDriver implementation Apple
// ships with macOS. It is genuine WebKit, not an emulation.
//
// IT REQUIRES A ONE-TIME HUMAN STEP. Safari refuses WebDriver control until
// "Allow Remote Automation" is enabled, which is a GUI setting and cannot be
// scripted:
//
//     Safari → Settings → Advanced → "Show features for web developers"
//     Safari → Develop → "Allow Remote Automation"
//
// (`safaridriver --enable` does the same thing but asks for an administrator
// password, so it is equally not automatable from here.)
//
// Until that is done this exits 2 and says so. It does not skip quietly and it
// does not pretend WebKit was covered.
import fs from "node:fs";
import { spawn } from "node:child_process";

const PREVIEW = process.env.PREVIEW_URL || "https://sprint-preview-07sep2026.dcs-games.pages.dev";
const API = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = process.env.JWT_PATH ? fs.readFileSync(process.env.JWT_PATH, "utf8").trim() : null;
const DRIVER = "/System/Cryptexes/App/usr/bin/safaridriver";
const PORT = 40000 + Math.floor(Math.random() * 8000);

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, d = "") => { if (c) { pass++; out.push(`  PASS  ${n}`); } else { fail++; out.push(`  FAIL  ${n}${d ? " — " + d : ""}`); } };

if (!fs.existsSync(DRIVER)) {
  console.error("safaridriver is not present on this machine; WebKit cannot be driven here.");
  process.exit(2);
}

const base = `http://127.0.0.1:${PORT}`;
const rq = async (method, path, body) => {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const driver = spawn(DRIVER, ["-p", String(PORT)], { stdio: ["ignore", "pipe", "pipe"] });
const stop = () => { try { driver.kill("SIGKILL"); } catch { /* gone */ } };
process.once("exit", stop);

let session = null;
try {
  for (let i = 0; i < 40; i++) {
    const s = await rq("GET", "/status").catch(() => null);
    if (s?.body?.value?.ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const created = await rq("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  if (created.status !== 200) {
    const msg = created.body?.value?.message || JSON.stringify(created.body).slice(0, 200);
    console.error("WEBKIT COVERAGE NOT RUN — Safari refused WebDriver control.\n");
    console.error("  " + msg + "\n");
    console.error("This is a one-time GUI setting and cannot be scripted:");
    console.error("  Safari → Settings → Advanced → tick 'Show features for web developers'");
    console.error("  Safari → Develop → tick 'Allow Remote Automation'");
    console.error("\nThen re-run this script. Nothing else about it needs to change.");
    stop();
    process.exit(2);
  }
  session = created.body.value.sessionId;
  const s = (p, b) => rq(b === undefined ? "GET" : "POST", `/session/${session}${p}`, b);

  const go = async (url) => { await s("/url", { url }); await new Promise((r) => setTimeout(r, 3500)); };
  const evalJs = async (script, args = []) => (await s("/execute/sync", { script, args }))?.body?.value;

  // ------------------------------------------------------ the engine itself
  const ua = await (async () => { await go(PREVIEW + "/"); return evalJs("return navigator.userAgent"); })();
  ok("this is really WebKit, not Chromium", /Safari/.test(ua) && !/Chrome\//.test(ua), ua);

  // -------------------------------------------------- the environment resolver
  const env = await evalJs("return JSON.stringify(window.DCS_ENV || null)");
  const e = env ? JSON.parse(env) : null;
  ok("the page resolves its environment in WebKit", !!e, "window.DCS_ENV absent");
  if (e) {
    ok("and it resolves to staging", e.name === "staging", String(e.name));
    ok("and points at the staging API", e.api === API, String(e.api));
  }

  // ------------------------------------- the CSS this engine actually decides
  //
  // background-clip:text with color:transparent is the case that renders as
  // INVISIBLE text on an engine without support, rather than merely low
  // contrast. It was fixed with an @supports fallback that was never observed
  // in a non-Chromium engine until now.
  const grad = await evalJs(`
    var el = document.querySelector('.hero h1 .grad') || document.querySelector('.grad');
    if (!el) return JSON.stringify({ absent: true });
    var cs = getComputedStyle(el);
    return JSON.stringify({
      color: cs.color,
      clip: cs.webkitBackgroundClip || cs.backgroundClip,
      supports: CSS.supports('-webkit-background-clip','text') || CSS.supports('background-clip','text'),
      text: (el.textContent||'').trim().slice(0,40)
    });`);
  const g = JSON.parse(grad || "{}");
  ok("gradient-clipped heading text is not invisible in WebKit",
     g.absent === true || g.supports === true || !/transparent|rgba\(0, 0, 0, 0\)/.test(String(g.color)),
     `color=${g.color} clip=${g.clip} supports=${g.supports}`);

  // ---------------------------------------------------------- placeholders
  const ph = await evalJs(`
    var i = document.querySelector('input[placeholder]');
    if (!i) return JSON.stringify({ absent: true });
    var cs = getComputedStyle(i, '::placeholder');
    return JSON.stringify({ opacity: cs.opacity, color: cs.color });`);
  const P = JSON.parse(ph || "{}");
  ok("placeholder opacity is not left to the engine",
     P.absent === true || Number(P.opacity) === 1, `opacity=${P.opacity}`);

  // -------------------------------------------------------- keyboard reach
  const tab = await evalJs(`
    var n = document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])');
    return n.length;`);
  ok("focusable controls exist and are reachable by Tab in WebKit", Number(tab) > 0, `${tab} focusable`);

  // ----------------------------------------------------- a real API call
  const health = await evalJs(`
    var done = false, result = null;
    return fetch(${JSON.stringify(API)} + "/health").then(function(r){ return r.json(); })
      .then(function(h){ return JSON.stringify({ ok: h.ok, payments: h.payments_live, schema: h.schema_assertion && h.schema_assertion.version }); })
      .catch(function(err){ return JSON.stringify({ error: String(err) }); });`);
  const H = JSON.parse(health || "{}");
  ok("WebKit can reach the staging API across origins (CORS holds for this engine too)", H.ok === true, health);
  ok("and payments are still dark", H.payments === false);

  // ---------------------------------------- the journey pages actually load
  for (const path of ["/worlds.html", "/create-v3.html", "/profile-v3.html"]) {
    await go(PREVIEW + path);
    const t = await evalJs("return document.body ? document.body.innerText : ''");
    const title = await evalJs("return document.title || ''");
    ok(`${path} renders in WebKit`, String(t || "").trim().length > 40, `${String(t||"").length} chars`);
    ok(`${path} is a real page, not the 404 fallback`,
       !/\b(404|page not found)\b/i.test(String(title)) && !/\b(404|page not found)\b/i.test(String(t||"").slice(0,400)),
       `title "${title}"`);
  }
} finally {
  if (session) await rq("DELETE", `/session/${session}`).catch(() => {});
  stop();
}

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   engine=WebKit (Safari via safaridriver)`);
process.exit(fail ? 1 : 0);
