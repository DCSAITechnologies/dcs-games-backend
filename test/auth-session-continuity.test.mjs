// The session must survive a page that cannot see Supabase.
//
// FOUNDER-OBSERVED DEFECT, 7 Sep 2026: "after login, clicking Play Game can
// sign the user out."
//
// Reproduced deterministically: with an access token the STAGING SERVER
// ACCEPTS (curl -> HTTP 200 on /me/profile), loading /player-home emptied
// localStorage completely. The token was valid; the page deleted it.
//
// The mechanism is in assets/auth.js. Both of these treat "I cannot see a
// Supabase session right now" as "the user has signed out":
//
//   sync():              if (s) setTok(...); else { setTok(null); setUser(null); }
//   onAuthStateChange:   if (s) setTok(...); else { setTok(null); setUser(null); }
//
// getSession() returns no session for reasons that are NOT a sign-out — a
// revoked or expired refresh token, a Supabase hiccup, storage the browser
// evicted, or simply supabase-js firing INITIAL_SESSION with null before it has
// hydrated. Any one of those destroys a working credential.
//
// The user-visible sequence that follows is exactly what was reported:
//   1. /player-home wipes the token (the page still renders; the guard already
//      passed, and the API calls then 401 into "your session has expired")
//   2. the Open / Play control leads to /play-v3, which reads the same key,
//      finds nothing, and says "You need to sign in to open this world"
//   3. returning to /player-home now fails requireAuth() and redirects to
//      /login — signed out, having touched nothing but a play button
//
// Clearing local storage was never the security control. The server validates
// the JWT on every call and answers 401 when it is bad. Deleting a token the
// server accepts protects nothing and loses the session.
//
// These tests are hermetic: supabase-js is stubbed, so they assert the
// behaviour rather than the network, and they check BOTH directions — a real
// SIGNED_OUT must still clear the session, or the fix would just be "never log
// anyone out".
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

const TOKEN = "header.payload.signature-not-a-real-token";
const KEY = "dcsgames.token";

let server, browser;

before(async () => {
  if (opts.skip) return;
  server = await serveStatic(SITE);
  browser = await launchChrome();
}, opts);

after(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * A page with supabase-js stubbed, so the test states the condition instead of
 * depending on a CDN and a live project.
 *
 * `sessionVisible` false is the defect's condition: the app holds a token, and
 * the Supabase client reports no session.
 */
async function pageWithStub({ sessionVisible, fireSignedOut = false }) {
  const p = await Page.open(browser);
  await p.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.DCS_API_BASE = "http://127.0.0.1:1";       // never answers; nothing here needs it to
      window.DCS_SUPABASE_URL = "https://stub.supabase.co";
      window.DCS_SUPABASE_ANON_KEY = "stub-anon-key";
      var SESSION = ${sessionVisible ? `{ access_token: ${JSON.stringify(TOKEN)}, refresh_token: "r" }` : "null"};
      window.__authEvents = [];
      window.supabase = {
        createClient: function () {
          return { auth: {
            getSession: function () { return Promise.resolve({ data: { session: SESSION }, error: null }); },
            onAuthStateChange: function (cb) {
              // supabase-js v2 always emits INITIAL_SESSION, with a null session
              // when it has none. That is not a sign-out.
              setTimeout(function () { cb("INITIAL_SESSION", SESSION); }, 30);
              ${fireSignedOut ? `setTimeout(function () { cb("SIGNED_OUT", null); }, 120);` : ""}
              return { data: { subscription: { unsubscribe: function () {} } } };
            },
            signOut: function () { return Promise.resolve({ error: null }); },
          } };
        },
      };
    `,
  });
  return p;
}

test("REGRESSION: a page that cannot see a Supabase session must not delete a token the server accepts", opts, async () => {
  const p = await pageWithStub({ sessionVisible: false });
  try {
    await p.goto(server.url + "/index.html", { waitMs: 300 });
    await p.eval(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(TOKEN)}); return 1;`);

    await p.goto(server.url + "/player-home.html", { waitMs: 2500 });

    const after = await p.eval(`return localStorage.getItem(${JSON.stringify(KEY)}) || ""`);
    assert.equal(after, TOKEN,
      "player-home destroyed a session the server had not rejected. Only the server " +
      "can say a token is dead, and it says so with a 401.");
  } finally { await p.close(); }
});

test("REGRESSION: the same is true of every page that loads auth.js", opts, async () => {
  const pages = ["/player-home.html", "/login.html", "/signup.html"];
  for (const target of pages) {
    const p = await pageWithStub({ sessionVisible: false });
    try {
      await p.goto(server.url + "/index.html", { waitMs: 250 });
      await p.eval(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(TOKEN)}); return 1;`);
      await p.goto(server.url + target, { waitMs: 2000 });
      const after = await p.eval(`return localStorage.getItem(${JSON.stringify(KEY)}) || ""`);
      assert.equal(after, TOKEN, `${target} cleared the session without the server rejecting it`);
    } finally { await p.close(); }
  }
});

test("the other direction: an explicit SIGNED_OUT event MUST clear the session", opts, async () => {
  // Without this, "stop clearing the token" would be indistinguishable from
  // "the user can never sign out", which is a worse defect than the one being
  // fixed.
  const p = await pageWithStub({ sessionVisible: true, fireSignedOut: true });
  try {
    await p.goto(server.url + "/index.html", { waitMs: 250 });
    await p.eval(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(TOKEN)}); return 1;`);
    await p.goto(server.url + "/player-home.html", { waitMs: 2500 });
    const after = await p.eval(`return localStorage.getItem(${JSON.stringify(KEY)}) || ""`);
    assert.equal(after, "", "a real sign-out must remove the local session");
  } finally { await p.close(); }
});

test("a visible Supabase session is still copied into the local token", opts, async () => {
  const p = await pageWithStub({ sessionVisible: true });
  try {
    await p.goto(server.url + "/index.html", { waitMs: 250 });
    await p.eval(`localStorage.removeItem(${JSON.stringify(KEY)}); return 1;`);
    await p.goto(server.url + "/player-home.html", { waitMs: 2500 });
    const after = await p.eval(`return localStorage.getItem(${JSON.stringify(KEY)}) || ""`);
    assert.equal(after, TOKEN, "sync() must still adopt the live Supabase access token");
  } finally { await p.close(); }
});

// ---------------------------------------------------------------------------
// loadProfile and the difference between "you are not signed in" and
// "the server fell over for a moment".
//
// Carried open as a P3 from the 7 Sep closure report. `loadProfile` ended with:
//
//   if (!r.ok) { setUser(null); return null; }
//
// `r.ok` is false for 500, 502, 503 and 504 exactly as it is for 401. So a
// transient upstream blip cleared the cached identity and the account menu
// dropped back to a neutral glyph for a visitor whose session was never in
// question — the UI reporting "we do not know who you are" because one request
// out of many did not come back.
//
// The session itself survived (that is a separate defect, fixed above), so this
// is cosmetic in the sense that nothing is lost. It is not cosmetic in the
// sense that matters: the surface said something untrue about the visitor's
// state.
//
// A real 401 or 403 must still clear it. That is the server saying this token
// does not identify anyone, and continuing to show a name for it would be the
// opposite failure.
const USER_KEY = "dcsgames.user";

async function pageWithProfileStatus(status) {
  const p = await Page.open(browser);
  await p.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.DCS_SUPABASE_URL = "https://stub.supabase.co";
      window.DCS_SUPABASE_ANON_KEY = "stub-anon-key";
      window.DCS_API_BASE = "https://stub.api.invalid";
      window.supabase = { createClient: function () { return { auth: {
        getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
        onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
        signOut: function () { return Promise.resolve({ error: null }); } } }; } };
      // Every /me/profile call answers with the status under test.
      var realFetch = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).indexOf("/me/profile") !== -1) {
          return Promise.resolve(new Response(
            ${JSON.stringify(status)} === 200 ? JSON.stringify({ ok: true, principal_id: "p_1", username: "realname", display_name: "Real Name", level: 3 }) : "server error",
            { status: ${JSON.stringify(status)}, headers: { "Content-Type": "application/json" } }));
        }
        return realFetch.apply(this, arguments);
      };`,
  });
  return p;
}

test("REGRESSION: a transient 5xx must not erase who the visitor is", opts, async () => {
  const p = await pageWithProfileStatus(503);
  try {
    await p.goto(server.url + "/index.html", { waitMs: 300 });
    // A visitor with a known identity already cached.
    await p.eval(`localStorage.setItem(${JSON.stringify(USER_KEY)}, JSON.stringify({ id: "p_1", username: "realname", display_name: "Real Name", level: 3 })); return 1;`);
    await p.goto(server.url + "/player-home.html", { waitMs: 300 });
    const status = await p.eval(`
      return (async function () {
        await DCSAuth.loadProfile("some-token");
        return localStorage.getItem(${JSON.stringify(USER_KEY)}) || "";
      })();`);
    assert.notEqual(status, "",
      "a 503 on /me/profile cleared the cached identity: the surface now says it does not know " +
      "who the visitor is, because one request did not come back");
    assert.match(status, /Real Name/, "the cached identity should be untouched by a server error");
  } finally { await p.close(); }
});

test("the other direction: a 401 MUST clear the cached identity", opts, async () => {
  const p = await pageWithProfileStatus(401);
  try {
    await p.goto(server.url + "/index.html", { waitMs: 300 });
    await p.eval(`localStorage.setItem(${JSON.stringify(USER_KEY)}, JSON.stringify({ id: "p_1", display_name: "Real Name" })); return 1;`);
    await p.goto(server.url + "/player-home.html", { waitMs: 300 });
    const after = await p.eval(`
      return (async function () {
        await DCSAuth.loadProfile("a-token-the-server-rejects");
        return localStorage.getItem(${JSON.stringify(USER_KEY)}) || "";
      })();`);
    assert.equal(after, "",
      "the server said this token identifies nobody; continuing to show a name for it would be worse " +
      "than the defect being fixed");
  } finally { await p.close(); }
});
