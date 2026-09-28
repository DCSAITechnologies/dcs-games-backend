// The session must survive TIME, not just a page load. (28 Sep 2026 recovery.)
//
// FOUNDER-OBSERVED: "user enters login/dashboard, then gets bounced/logged back
// out." test/auth-session-continuity.test.mjs pinned the 7 Sep half of this (a
// page must not delete a token the server accepts). This file pins the half it
// could not see, because every token in that suite is timeless:
//
//   1. `dcsgames.token` is a COPY of a Supabase access token that lives ~1h.
//      supabase-js — the only thing that can refresh it — was loaded on 5 of
//      191 pages, and even there AFTER the page had sent its requests. Come back
//      after the hour and the dashboard said "Your session has expired".
//   2. Its "Sign in again" link went to /login, which tested only "is there a
//      token in storage?" and sent the person straight back. A loop.
//   3. The marketing header decided "signed in?" from window.DCSAuth, absent on
//      68 of 73 marketing pages, so it read "Log in" to a signed-in person.
//   4. Sign-out used supabase-js's default GLOBAL scope (every device), and the
//      V3 header's sign-out left the Supabase session behind entirely.
//
// Hermetic: supabase-js and the API are stubbed in the page. Tokens carry a real
// `exp`, the stub API accepts only unexpired tokens it minted, and the stub
// refresh/sign-out behave as supabase-js v2 does (a rejected refresh token ends
// the session and emits SIGNED_OUT).
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { resolveSite } from "./helpers/site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(HERE);
const haveSite = fs.existsSync(path.join(SITE, "player-home.html"));
const haveChrome = !!findChrome();
const opts = { skip: !haveSite ? "dcs-games-LIVE not found" : (!haveChrome ? "no Chrome binary" : false) };

let server, browser;
before(async () => {
  if (opts.skip) return;
  server = await serveStatic(SITE);
  browser = await launchChrome();
}, opts);
after(async () => { await browser?.close(); await server?.close(); });

/**
 * @param refresh  "ok" — the refresh token works; "rejected" — Supabase refuses it
 * @param server   "ok" — the API accepts unexpired minted tokens; "rejects" — it
 *                 accepts none (a token from the wrong project, a deleted user)
 */
function stub({ refresh = "ok", api = "ok" } = {}) {
  return `
  (function () {
    window.DCS_SUPABASE_URL = "https://stub.supabase.co";
    window.DCS_SUPABASE_ANON_KEY = "stub-anon-key";
    window.DCS_API_BASE = "https://stub.api.invalid";
    try { sessionStorage.setItem("dcs_beta_ok", "1"); } catch (e) {}   // the beta overlay is not under test
    var SK = "sb-stub-auth-token", REFRESH = ${JSON.stringify(refresh)}, API_OK = ${JSON.stringify(api)} === "ok";
    function b64u(o) { return btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\\+/g, "-").replace(/\\//g, "_"); }
    function mint(ttl) { var n = Number(localStorage.getItem("__mint") || 0) + 1; localStorage.setItem("__mint", n);
      return "h." + b64u({ exp: Math.floor(Date.now() / 1000) + ttl, n: n }) + ".s"; }
    window.__mint = mint;
    function exp(t) { try { var p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); while (p.length % 4) p += "=";
      return JSON.parse(atob(p)).exp * 1000; } catch (e) { return 0; } }
    function load() { try { return JSON.parse(localStorage.getItem(SK) || "null"); } catch (e) { return null; } }
    function save(s) { s ? localStorage.setItem(SK, JSON.stringify(s)) : localStorage.removeItem(SK); }
    function log(k, v) { var a = JSON.parse(localStorage.getItem(k) || "[]"); a.push(v); localStorage.setItem(k, JSON.stringify(a)); }
    function later(fn) { return new Promise(function (res) { setTimeout(function () { res(fn()); }, 150); }); }
    var listeners = [];
    function emit(e, s) { setTimeout(function () { listeners.forEach(function (cb) { cb(e, s); }); }, 0); }
    function doRefresh() {
      var s = load();
      if (!s) return { data: { session: null }, error: null };
      if (REFRESH === "rejected") { save(null); log("__authlog", "refresh-rejected"); emit("SIGNED_OUT", null);
        return { data: { session: null }, error: { message: "Invalid Refresh Token: Refresh Token Not Found" } }; }
      s = { access_token: mint(3600), refresh_token: "r" + Date.now() }; save(s); log("__authlog", "refreshed"); emit("TOKEN_REFRESHED", s);
      return { data: { session: s }, error: null };
    }
    window.supabase = { createClient: function () { return { auth: {
      // A refresh is a network round trip in real supabase-js; answering it in
      // the same microtask would let a page that races it win by accident.
      getSession: function () { var s = load();
        if (s && exp(s.access_token) <= Date.now() + 10000) return later(doRefresh);
        return Promise.resolve({ data: { session: s }, error: null }); },
      refreshSession: function () { return later(doRefresh); },
      signInWithPassword: function () { var s = { access_token: mint(3600), refresh_token: "r1" }; save(s); log("__authlog", "signin"); emit("SIGNED_IN", s);
        return Promise.resolve({ data: { session: s }, error: null }); },
      signOut: function (o) { log("__authlog", "signout:" + ((o && o.scope) || "global")); save(null); emit("SIGNED_OUT", null);
        return Promise.resolve({ error: null }); },
      onAuthStateChange: function (cb) { listeners.push(cb); setTimeout(function () { cb("INITIAL_SESSION", load()); }, 20);
        return { data: { subscription: { unsubscribe: function () {} } } }; },
    } }; } };
    var real = window.fetch;
    window.fetch = function (url, o) {
      var u = String(url);
      if (u.indexOf("https://stub.api.invalid") !== 0) return real.apply(this, arguments);
      var h = (o && o.headers) || {}, t = String(h.Authorization || h.authorization || "").replace(/^Bearer /, "");
      var p = u.slice("https://stub.api.invalid".length).split("?")[0];
      var valid = API_OK && /^h\\./.test(t) && exp(t) > Date.now();
      log("__apilog", p + " " + (t ? (valid ? "valid" : "rejected") : "anon"));
      function json(st, b) { return Promise.resolve(new Response(JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json" } })); }
      if (!valid && /^\\/(me|social)\\//.test(p)) return json(401, { ok: false, error: "invalid_session" });
      if (p === "/me/profile") return json(200, { ok: true, principal_id: "p_1", username: "founder", display_name: "Founder", level: "explorer" });
      if (p === "/me/home") return json(200, { ok: true, profile: { level: "explorer", xp: 0 }, worlds: { counted: 0, published: 0, complete: true }, recent: [] });
      if (p === "/me/streak") return json(200, { ok: true, current: 0 });
      if (p === "/me/achievements") return json(200, { ok: true, unlocked: 0, total: 0, achievements: [] });
      if (p === "/social/friends") return json(200, { ok: true, friends: [], incoming: [] });
      return json(200, { ok: true, items: [], worlds: [] });
    };
  })();`;
}

async function open(cfg) {
  const p = await Page.open(browser);
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: stub(cfg) });
  // Start every test from an empty origin.
  await p.goto(server.url + "/404.html", { waitMs: 200 });
  await p.eval(`localStorage.clear(); return 1;`);
  return p;
}
const where = (p) => p.eval(`return location.pathname`);
const apilog = (p) => p.eval(`return JSON.parse(localStorage.getItem("__apilog") || "[]")`);
const authlog = (p) => p.eval(`return JSON.parse(localStorage.getItem("__authlog") || "[]")`);
const tok = (p) => p.eval(`return localStorage.getItem("dcsgames.token") || ""`);
const clearApiLog = (p) => p.eval(`localStorage.removeItem("__apilog"); return 1;`);

/** Plant a session whose access token expired `agoSec` seconds ago. */
async function plantExpired(p, agoSec = 120) {
  return p.eval(`var t = window.__mint(-${agoSec});
    localStorage.setItem("sb-stub-auth-token", JSON.stringify({ access_token: t, refresh_token: "r0" }));
    localStorage.setItem("dcsgames.token", t); return t;`);
}

test("LOGIN → DASHBOARD → PAGE REFRESH → NAVIGATE → RETURN: the session remains valid", opts, async () => {
  const p = await open();
  try {
    await p.goto(server.url + "/login.html?next=%2Fplayer-home.html", { waitMs: 800 });
    assert.equal(await where(p), "/login.html", "signed out, /login must stay put");

    const r = await p.eval(`return DCSAuth.login("founder@example.com", "correct horse battery")`);
    assert.equal(r.ok, true, "the stubbed sign-in succeeded");
    const signedInToken = await tok(p);
    assert.ok(signedInToken, "sign-in stored the access token");

    await p.goto(server.url + "/player-home.html", { waitMs: 1500 });
    assert.equal(await where(p), "/player-home.html", "DASHBOARD: not bounced to /login");
    assert.doesNotMatch(await p.text(), /session has expired|Signed out/i);
    assert.ok((await apilog(p)).includes("/me/home valid"), "the dashboard read the account with a valid token");

    await p.send("Page.reload");
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(await where(p), "/player-home.html", "PAGE REFRESH: still on the dashboard");
    assert.doesNotMatch(await p.text(), /session has expired/i);

    await clearApiLog(p);
    await p.goto(server.url + "/player-settings.html", { waitMs: 1200 });
    assert.equal(await where(p), "/player-settings.html", "NAVIGATE: a dashboard page without auth.js");
    assert.ok((await apilog(p)).includes("/me/profile valid"), "its chrome read /me/profile with the session");

    await p.goto(server.url + "/index.html", { waitMs: 1000 });
    const hdr = await p.eval(`var a = document.getElementById("mAuthLink"); return a ? a.textContent : ""`);
    assert.notEqual(hdr, "Log in", "NAVIGATE: the marketing header must not tell a signed-in person to log in");
    assert.ok(await p.eval(`return !!document.getElementById("mLogout")`), "and it offers a way out");

    await p.goto(server.url + "/player-home.html", { waitMs: 1500 });
    assert.equal(await where(p), "/player-home.html", "RETURN: back on the dashboard");
    assert.equal(await tok(p), signedInToken, "SESSION REMAINS VALID: the same token, never cleared");
    assert.doesNotMatch(await p.text(), /session has expired/i);
    assert.equal(p.realErrors().length, 0, p.realErrors().join(" | "));
  } finally { await p.close(); }
});

test("REGRESSION: an EXPIRED access token with a good refresh token is refreshed, not bounced", opts, async () => {
  const p = await open({ refresh: "ok" });
  try {
    const expired = await plantExpired(p);
    await p.goto(server.url + "/player-home.html", { waitMs: 2000 });
    assert.equal(await where(p), "/player-home.html", "the dashboard must not redirect a refreshable session to /login");
    assert.doesNotMatch(await p.text(), /session has expired/i,
      "the dashboard said the session expired while supabase-js held a refresh token that works");
    const log = await apilog(p);
    assert.ok(!log.some((l) => / rejected$/.test(l)), "no request went out with the expired copy: " + log.join(", "));
    assert.ok(log.includes("/me/home valid"));
    assert.notEqual(await tok(p), expired, "the local copy was replaced by the refreshed token");
    assert.ok((await authlog(p)).includes("refreshed"));
  } finally { await p.close(); }
});

test("REGRESSION: a page that never loaded auth.js still refreshes the session before using it", opts, async () => {
  const p = await open({ refresh: "ok" });
  try {
    await plantExpired(p);
    const hasTag = fs.readFileSync(path.join(SITE, "player-settings.html"), "utf8").includes("assets/auth.js");
    assert.equal(hasTag, false, "precondition: player-settings does not include auth.js itself");
    await p.goto(server.url + "/player-settings.html", { waitMs: 2000 });
    const log = await apilog(p);
    assert.ok(log.includes("/me/profile valid"), "the chrome's /me/profile went out refreshed: " + log.join(", "));
    assert.ok(!log.some((l) => / rejected$/.test(l)), "and nothing went out with the expired copy");
  } finally { await p.close(); }
});

test("REGRESSION (the loop): a DEAD session goes to /login once, and /login does not send it back", opts, async () => {
  const p = await open({ refresh: "rejected" });
  try {
    await plantExpired(p);
    await p.goto(server.url + "/player-home.html", { waitMs: 300 });
    assert.ok(await p.waitFor(`location.pathname === "/login.html"`, { timeout: 6000 }),
      "a session Supabase refuses to refresh must end at /login, not at a dashboard that cannot read it");
    assert.match(await p.eval(`return location.search`), /reason=expired/);
    await new Promise((res) => setTimeout(res, 2500));
    assert.equal(await where(p), "/login.html", "/login bounced a dead session back to the dashboard — the loop");
    assert.equal(await tok(p), "", "the expired copy was cleared, so the form can replace it");
    assert.match(await p.text(), /session has ended/i, "and the page says why the person is here");
  } finally { await p.close(); }
});

test("REGRESSION (the loop): a token the SERVER refuses is ended at /login, locally", opts, async () => {
  const p = await open({ refresh: "ok", api: "rejects" });
  try {
    await p.eval(`var t = window.__mint(3600);
      localStorage.setItem("sb-stub-auth-token", JSON.stringify({ access_token: t, refresh_token: "r0" }));
      localStorage.setItem("dcsgames.token", t); return 1;`);
    await p.goto(server.url + "/login.html?next=%2Fplayer-home.html", { waitMs: 3000 });
    assert.equal(await where(p), "/login.html", "/login sent a session the server refuses back to the dashboard");
    assert.equal(await tok(p), "");
    const a = await authlog(p);
    assert.ok(a.includes("refreshed"), "one forced refresh was tried before giving up: " + a.join(", "));
    assert.ok(a.includes("signout:local"), "the dead session was ended in THIS browser only: " + a.join(", "));
  } finally { await p.close(); }
});

test("the other direction: an unexpired token the server ACCEPTS is sent on from /login", opts, async () => {
  const p = await open();
  try {
    await p.eval(`var t = window.__mint(3600);
      localStorage.setItem("sb-stub-auth-token", JSON.stringify({ access_token: t, refresh_token: "r0" }));
      localStorage.setItem("dcsgames.token", t); return 1;`);
    await p.goto(server.url + "/login.html?next=%2Fplayer-settings.html", { waitMs: 300 });
    assert.ok(await p.waitFor(`location.pathname === "/player-settings.html"`, { timeout: 6000 }),
      "a signed-in person visiting /login is sent to where they were going");
  } finally { await p.close(); }
});

test("SECURITY: ?next= only ever leads to a same-origin path", opts, async () => {
  const p = await open();
  try {
    await p.goto(server.url + "/login.html", { waitMs: 600 });
    const out = await p.eval(`return [
      "https://evil.example/x", "//evil.example/x", "/\\\\evil.example", "javascript:alert(1)", "", null,
      "/player-settings.html?tab=a#b"
    ].map(function (n) { return DCSAuth.safeNext(n); })`);
    assert.deepEqual(out, ["/player-home.html", "/player-home.html", "/player-home.html", "/player-home.html",
      "/player-home.html", "/player-home.html", "/player-settings.html?tab=a#b"]);
  } finally { await p.close(); }
});

test("sign-out from the marketing header ends the session locally, and it stays ended", opts, async () => {
  const p = await open();
  try {
    await p.goto(server.url + "/login.html", { waitMs: 600 });
    await p.eval(`return DCSAuth.login("founder@example.com", "correct horse battery")`);
    await p.goto(server.url + "/index.html", { waitMs: 1000 });
    await p.eval(`document.getElementById("mLogout").click(); return 1;`);
    await new Promise((res) => setTimeout(res, 1500));
    assert.ok((await authlog(p)).includes("signout:local"),
      "sign-out must be local: the global default signs the person out of every other device");
    assert.equal(await p.eval(`return localStorage.getItem("sb-stub-auth-token")`), null, "the refreshable session is gone");
    assert.equal(await tok(p), "");
    await p.goto(server.url + "/player-home.html", { waitMs: 300 });
    assert.ok(await p.waitFor(`location.pathname === "/login.html"`, { timeout: 5000 }), "and the dashboard is closed again");
  } finally { await p.close(); }
});

test("sign-out from the V3 header ends the Supabase session too, not only the local copy", opts, async () => {
  const p = await open();
  try {
    await p.goto(server.url + "/login.html", { waitMs: 600 });
    await p.eval(`return DCSAuth.login("founder@example.com", "correct horse battery")`);
    await p.goto(server.url + "/explore-v3.html", { waitMs: 1000 });
    assert.ok(await p.eval(`return !!document.getElementById("v3Out")`), "precondition: the V3 header shows Sign out");
    await p.eval(`document.getElementById("v3Out").click(); return 1;`);
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal(await p.eval(`return localStorage.getItem("sb-stub-auth-token")`), null,
      "the Supabase session survived sign-out, so the next page would have refreshed it straight back");
  } finally { await p.close(); }
});
