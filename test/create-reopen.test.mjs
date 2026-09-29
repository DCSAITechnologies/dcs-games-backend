// A saved world can be reopened in the editor. (29 Sep 2026.)
//
// QA SWEEP GF-01 (HIGH): create-v3 ignored ?world= and kept the world id only
// in a variable in page memory. Edit, Expand, Playtest and Publish all key off
// that variable, so they worked in the tab that generated the world and nowhere
// else — reload, come back tomorrow, or follow a link from history, and the
// world could not be touched again from the UI. The server always had it.
//
// These tests drive the real pages against a stubbed API so they need no
// backend: the contract under test is the page's, and every stubbed answer has
// the shape server.mts returns (GET /v3/worlds/:id/manifest ->
// { ok, world_id, world_version, state, owner, manifest }; GET /me/profile ->
// { ok, principal_id }). The live round trip — generate, reload with ?world=,
// edit, expand, playtest, publish, open as another account — was run by hand
// against `tsx server.mts` with DCS_PROVIDERS_OFFLINE=1 on 29 Sep 2026.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { resolveSite } from "./helpers/site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(HERE);
const haveSite = fs.existsSync(path.join(SITE, "create-v3.html"));
const haveChrome = !!findChrome();
const opts = { skip: !haveSite ? "dcs-games-LIVE not found" : (!haveChrome ? "no Chrome binary" : false) };

const WID = "w3_0123456789abcdef";
const OWNER = "tester-owner";
const MANIFEST = {
  world_version: 3,
  meta: { title: "Tide Town", prompt: "A rainy nordic port town where the tide has stopped" },
  zones: [{}, {}], structures: [{}, {}, {}], npcs: [{}], items: [], quests: [{}], behaviors: [], interactions: [], assets: [],
};

let server, browser;
before(async () => {
  if (opts.skip) return;
  server = await serveStatic(SITE);
  browser = await launchChrome();
}, opts);
after(async () => { await browser?.close(); await server?.close(); });

/**
 * A signed-in internal tester, and an API that answers like server.mts.
 * `cfg.manifest` is { status, body } for GET /v3/worlds/:id/manifest;
 * `cfg.me` is the principal /me/profile names. Every stubbed request is logged
 * to window.__asked so a test can prove what was — and was not — sent.
 */
function stub(cfg) {
  return `
  window.DCS_API_BASE = "https://stub.api.invalid";
  window.DCS_SUPABASE_URL = "https://stub.supabase.co";
  try { localStorage.setItem("dcsgames.token", "h.eyJleHAiOjQxMDI0NDQ4MDB9.s"); sessionStorage.setItem("dcs_beta_ok", "1"); } catch (e) {}
  window.__asked = [];
  var CFG = ${JSON.stringify(cfg)};
  var real = window.fetch;
  function json(status, body) { return Promise.resolve(new Response(JSON.stringify(body), { status: status, headers: { "Content-Type": "application/json" } })); }
  window.fetch = function (u, init) {
    var url = String(u);
    if (url.indexOf("https://stub.api.invalid") !== 0) return real.apply(this, arguments);
    var p = url.slice("https://stub.api.invalid".length), m = (init && init.method) || "GET";
    window.__asked.push(m + " " + p);
    if (p === "/v3/subscriptions/grants") return json(200, { ok: true, grants: [] });
    if (p === "/me/profile") return json(200, { ok: true, principal_id: CFG.me, username: "owner" });
    if (/^\\/v3\\/worlds\\/[^/]+\\/manifest$/.test(p)) return json(CFG.manifest.status, CFG.manifest.body);
    if (/\\/edit$/.test(p) && m === "POST") return json(200, { ok: true, world_version: 4, summary: "weather set to rain", playtest: "PASSED" });
    if (/\\/memory$/.test(p)) return json(200, { ok: true, chronology: [] });
    if (p === "/v3/worlds/generate/async") return json(202, { ok: true, job_id: "job1", world_id: CFG.newWorld, stages: [] });
    if (p === "/v3/jobs/job1") return json(200, { ok: true, job: { state: "succeeded", stages: [], progress: { fraction: 1 }, elapsed_ms: 1000,
      result: { world_id: CFG.newWorld, world_version: 1, title: "Fresh", counts: { zones: 1 }, playtest: { verdict: "PASSED" } } } });
    if (p === "/v3/jobs") return json(200, { ok: true, jobs: [] });
    if (p === "/me/dashboard") return json(200, { ok: true, worlds: [{ world_id: ${JSON.stringify(WID)}, title: "Tide Town", state: "draft", versions: 3 }] });
    return json(200, { ok: true });
  };`;
}

const OWN = { me: OWNER, newWorld: "w3_fedcba9876543210",
  manifest: { status: 200, body: { ok: true, world_id: WID, world_version: 3, state: "draft", owner: OWNER, manifest: MANIFEST } } };

async function open(route, cfg) {
  const p = await Page.open(browser);
  await p.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // play-v3 pulls three.js from cdnjs; the editor link does not depend on it.
  await p.send("Network.setBlockedURLs", { urls: ["*cdnjs.cloudflare.com*"] }).catch(() => {});
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: stub(cfg) });
  await p.goto(server.url + route, { waitMs: 900 });
  return p;
}

const STATE = `return {
  search: location.search,
  gen: document.getElementById("genMsg").textContent, genCls: document.getElementById("genMsg").className,
  result: document.getElementById("resultMsg").textContent, resultCls: document.getElementById("resultMsg").className,
  resultShown: !document.getElementById("result").classList.contains("hidden"),
  editShown: !document.getElementById("editCard").classList.contains("hidden"),
  expandShown: !document.getElementById("expandCard").classList.contains("hidden"),
  publishDisabled: document.getElementById("publish").disabled,
  counts: document.getElementById("counts").innerText.replace(/\\s+/g, " "),
  prompt: document.getElementById("prompt").value,
  asked: window.__asked.slice() };`;

test("REOPEN: create-v3?world=<id> loads the saved world into the same state a fresh generation leaves", opts, async () => {
  const p = await open("/create-v3.html?world=" + WID, OWN);
  try {
    assert.ok(await p.waitFor(`/Opened/.test(document.getElementById("resultMsg").textContent)`), "the world was never reported as opened");
    const s = await p.eval(STATE);
    assert.ok(s.asked.includes("GET /v3/worlds/" + WID + "/manifest"), "the manifest was fetched: " + s.asked.join(", "));
    assert.equal(s.resultShown, true, "the result card is shown");
    assert.equal(s.editShown, true, "Edit is available on a reopened world");
    assert.equal(s.expandShown, true, "Expand is available on a reopened world");
    assert.equal(s.publishDisabled, false, "Publish is available to the owner");
    assert.match(s.result, /world version 3/);
    assert.match(s.counts, /2 zones/i);
    assert.match(s.counts, /3 structures/i);
    assert.equal(s.prompt, MANIFEST.meta.prompt, "the prompt the world was built from is shown");
    assert.deepEqual(p.realErrors(), [], p.realErrors().join(" | "));
  } finally { await p.close(); }
});

test("REOPEN: Edit on a reopened world is sent for THAT world — the whole point of GF-01", opts, async () => {
  const p = await open("/create-v3.html?world=" + WID, OWN);
  try {
    assert.ok(await p.waitFor(`/Opened/.test(document.getElementById("resultMsg").textContent)`));
    await p.eval(`document.getElementById("editReq").value = "make it rain"; document.getElementById("doEdit").click();`);
    assert.ok(await p.waitFor(`document.getElementById("editMsg").textContent.length > 0`), "the edit never answered");
    const r = await p.eval(`return { msg: document.getElementById("editMsg").textContent, cls: document.getElementById("editMsg").className, asked: window.__asked.slice() };`);
    assert.ok(r.asked.includes("POST /v3/worlds/" + WID + "/edit"), "the edit went to the reopened world: " + r.asked.join(", "));
    assert.match(r.cls, /\bok\b/);
    assert.match(r.msg, /world version 4/);
  } finally { await p.close(); }
});

test("REOPEN: a fresh generation writes ?world=<id> into the URL, and a reload of that URL reopens it", opts, async () => {
  const cfg = { ...OWN, manifest: { status: 200, body: { ...OWN.manifest.body, world_id: OWN.newWorld, world_version: 1, manifest: { ...MANIFEST, world_version: 1 } } } };
  const p = await open("/create-v3.html?prompt=" + encodeURIComponent("a harbour"), cfg);
  try {
    await p.eval(`document.getElementById("gen").click();`);
    assert.ok(await p.waitFor(`/is saved/.test(document.getElementById("resultMsg").textContent)`), "generation never finished");
    const after = await p.eval(`return location.search`);
    assert.equal(after, "?world=" + OWN.newWorld, "the saved world is in the URL (and the carried prompt is not)");
    await p.goto(server.url + "/create-v3.html" + after, { waitMs: 900 });
    assert.ok(await p.waitFor(`/Opened/.test(document.getElementById("resultMsg").textContent)`), "the reload did not reopen the world");
    const s = await p.eval(STATE);
    assert.equal(s.editShown, true);
    assert.ok(!s.asked.includes("POST /v3/worlds/generate/async"), "a reload must never start a generation");
  } finally { await p.close(); }
});

test("REOPEN: anything that is not a world id is refused without a request, and never rendered as markup", opts, async () => {
  const bad = ["<img src=x onerror=window.__pwned=1>", "../../me/profile", "w3_ZZZZZZZZZZZZZZZZ", "w3_0123456789abcdef/../x", "world_1234", "W3_0123456789ABCDEF", ""];
  for (const v of bad) {
    const p = await open("/create-v3.html?world=" + encodeURIComponent(v), OWN);
    try {
      const s = await p.eval(STATE);
      const extra = await p.eval(`return { pwned: !!window.__pwned, imgs: document.querySelectorAll(".wrap img").length };`);
      assert.ok(!s.asked.some((a) => /\/v3\/worlds\//.test(a)), `${JSON.stringify(v)} reached the API: ${s.asked.join(", ")}`);
      assert.match(s.genCls, /\berr\b/, `${JSON.stringify(v)}: no error was shown`);
      assert.match(s.gen, /not a world id/);
      assert.equal(extra.pwned, false, "the id was executed");
      assert.equal(extra.imgs, 0, "the id was parsed as markup");
      assert.equal(s.editShown, false, "nothing is editable after a refused id");
    } finally { await p.close(); }
  }
});

for (const [status, re] of [[401, /session has expired/i], [403, /do not have access/i], [404, /no world with this id that you can open/i], [500, /server returned 500/i]]) {
  test(`REOPEN: a ${status} from the manifest says what happened — not a blank page`, opts, async () => {
    const p = await open("/create-v3.html?world=" + WID, { ...OWN, manifest: { status, body: { ok: false, error: "x", detail: "stubbed " + status } } });
    try {
      assert.ok(await p.waitFor(`document.getElementById("genMsg").textContent.length > 20`), "no message was shown");
      const s = await p.eval(STATE);
      assert.match(s.genCls, /\berr\b/);
      assert.match(s.gen, re);
      assert.equal(s.editShown, false, "a world that did not load offers no Edit");
      assert.equal(await p.eval(`return !!document.getElementById("prompt") && !document.getElementById("gen").disabled`), true, "the page is still usable to build a new world");
      if (status === 401) assert.equal(await p.eval(`var a = document.querySelector("#genMsg a"); return a ? a.getAttribute("href") : null`), "/login.html?next=" + encodeURIComponent("/create-v3.html?world=" + WID));
    } finally { await p.close(); }
  });
}

test("REOPEN: someone else's published world opens read-only, and says why", opts, async () => {
  const p = await open("/create-v3.html?world=" + WID, { ...OWN, me: "someone-else",
    manifest: { status: 200, body: { ...OWN.manifest.body, state: "published" } } });
  try {
    assert.ok(await p.waitFor(`/belongs to another creator/.test(document.getElementById("resultMsg").textContent)`), "no ownership message");
    const s = await p.eval(STATE);
    assert.equal(s.editShown, false);
    assert.equal(s.expandShown, false);
    assert.equal(s.publishDisabled, true);
    assert.equal(s.resultShown, true, "it can still be played");
  } finally { await p.close(); }
});

test("LINKS: play-v3 offers 'Open in editor' to the world's owner, and only to the owner", opts, async () => {
  for (const [me, shown] of [[OWNER, true], ["someone-else", false]]) {
    const p = await open("/play-v3.html?world=" + WID, { ...OWN, me, manifest: { status: 200, body: { ...OWN.manifest.body, state: "published" } } });
    try {
      await p.waitFor(`window.__asked.indexOf("GET /me/profile") >= 0`, { timeout: 8000 });
      await new Promise((r) => setTimeout(r, 300));
      const r = await p.eval(`var a = document.getElementById("wedit"), b = a.getBoundingClientRect();
        return { visible: b.width > 0 && getComputedStyle(a).display !== "none", href: a.getAttribute("href"), pe: getComputedStyle(a).pointerEvents };`);
      assert.equal(r.visible, shown, `${me}: link visible=${r.visible}`);
      if (shown) {
        assert.equal(r.href, "/create-v3.html?world=" + WID);
        assert.equal(r.pe, "auto", "the HUD ignores the pointer; its link must not");
      }
    } finally { await p.close(); }
  }
});

test("LINKS: history-v3 (own world list and single world) and profile-v3 link each world back to the editor", opts, async () => {
  const want = "/create-v3.html?world=" + WID;
  for (const route of ["/history-v3.html", "/history-v3.html?world=" + WID, "/profile-v3.html"]) {
    const p = await open(route, OWN);
    try {
      assert.ok(await p.waitFor(`document.querySelector('a[href="${want}"]')`, { timeout: 10000 }), `${route}: no Open in editor link to ${want}`);
    } finally { await p.close(); }
  }
});
