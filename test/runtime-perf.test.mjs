// Runtime V3 — performance, mobile and accessibility, all measured.
//
// Same shape as runtime-v3.test.mjs: serveStatic + launchChrome + a Page over
// CDP, with a stub API serving a genuinely assembled WorldManifestV3. What is
// different is the world. This one is deliberately large — 240 structures
// packed into a single cluster — because the properties under test only appear
// at scale:
//
//   - the rendered instance count has to FALL with distance, using the lod[]
//     tiers the manifest assets already declare
//   - the per-frame main-thread cost has to stay inside a budget while it does
//   - the draw call count has to stay flat, or the LOD pass has quietly undone
//     the instancing it sits on top of
//
// Nothing here asserts a vibe. Every number comes out of runtime.stats(),
// renderer.info, or a contrast ratio computed in the page from the same
// getComputedStyle values a browser paints with.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "../../../dcs-games-LIVE");
const EVIDENCE = path.resolve(HERE, "../../../DCS_GAMES_SPRINT_SEP2026/evidence/screenshots");

const haveSite = fs.existsSync(path.join(SITE, "play-v3.html"));
const haveChrome = !!findChrome();
const opts = { skip: !haveSite ? "play-v3.html not found" : (!haveChrome ? "no Chrome binary" : false) };

// The cluster every distance measurement is taken against. Keeping the
// structures in one block and the player on one axis makes distance the only
// variable in the experiment.
const CLUSTER = { x0: 40, x1: 220, z0: 20, z1: 100, cols: 20 };
const BIG_COUNT = 240;

let site, api, browser, page, small, big;

/** A stub of the real API, serving the two worlds these tests need. */
function stubApi(worlds) {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const url = (req.url || "").split("?")[0];
    const m = /\/v3\/worlds\/([^/]+)\/manifest$/.exec(url);
    if (m) {
      const w = worlds[decodeURIComponent(m[1])];
      if (!w) return send(404, { ok: false, error: "not_found", detail: "world not found" });
      return send(200, { ok: true, world_id: w.world_id, world_version: w.world_version, state: "draft", owner: "u1", manifest: w });
    }
    // The companion is a signed-in feature and these tests are anonymous.
    if (/\/v3\/worlds\/[^/]+\/companion$/.test(url)) return send(401, { ok: false, error: "unauthenticated" });
    return send(404, { ok: false, error: "not_found" });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, close: () => new Promise((x) => server.close(x)) })));
}

/**
 * A large world, built from the same assembled structures so the assets — and
 * therefore the declared lod[] tiers — are the real ones.
 *
 * render_distance is set wide on purpose: with a short draw distance the hard
 * cap does all the culling and the LOD tiers never get to prove anything. The
 * instance budget is set low on purpose for the same reason in reverse.
 */
function buildBigWorld(base) {
  const w = structuredClone(base);
  w.world_id = "w_perf_big";
  w.runtime_config = Object.assign({}, w.runtime_config, {
    render_distance: 700,
    max_instances: 200,
    mobile: Object.assign({}, w.runtime_config && w.runtime_config.mobile, { max_instances: 200 }),
  });
  const proto = base.structures;
  const rows = Math.ceil(BIG_COUNT / CLUSTER.cols);
  for (let i = 0; i < BIG_COUNT; i++) {
    const c = structuredClone(proto[i % proto.length]);
    c.id = `struct_perf_${i}`;
    c.transform.position = {
      x: CLUSTER.x0 + ((CLUSTER.x1 - CLUSTER.x0) * (i % CLUSTER.cols)) / CLUSTER.cols,
      y: 0,
      z: CLUSTER.z0 + ((CLUSTER.z1 - CLUSTER.z0) * Math.floor(i / CLUSTER.cols)) / rows,
    };
    c.footprint = { w: 5 + (i % 5), d: 5 + (i % 4), h: 5 + (i % 9) };
    w.structures.push(c);
  }
  return w;
}

before(async () => {
  if (opts.skip) return;
  const built = await createAssemblyRouter({ DCS_PROVIDERS_OFFLINE: "1" })
    .assemble({ prompt: "Ashfall Harbour, a rainy nordic port town", worldId: "w_perf", creatorId: "u1" });
  small = built.manifest;
  assert.ok((small.assets || []).some((a) => Array.isArray(a.lod) && a.lod.length >= 3),
    "the fixture's assets must declare the lod[] tiers this suite is about");
  big = buildBigWorld(small);

  site = await serveStatic(SITE);
  api = await stubApi({ w_perf: small, w_perf_big: big });
  browser = await launchChrome();
  page = await Page.open(browser);
  // Headless Chrome does not consider the page focused, so :focus never matches
  // and every focus-ring measurement would read "none" for the wrong reason.
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
}, opts);

after(async () => {
  await page?.close();
  await browser?.close();
  await api?.close();
  await site?.close();
});

async function openWorld(worldId, extra = "") {
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.DCS_API_BASE = "http://127.0.0.1:${api.port}";` });
  await page.goto(`${site.url}/play-v3.html?world=${worldId}&stats=1${extra}`, { waitMs: 2500 });
  const ready = await page.waitFor("window.__rt && document.getElementById('boot').style.display === 'none'", { timeout: 40000 });
  assert.ok(ready, `${worldId} did not finish loading: ` + JSON.stringify(page.realErrors().slice(0, 2)));
}

/** Put the player somewhere, let the runtime settle, and read the numbers. */
async function sampleAt(x, z, { yaw = 0, lodScale = null, settleMs = 1400 } = {}) {
  await page.eval(`
    const rt = window.__rt;
    rt.teleport(${x}, ${z});
    rt.player.yaw = ${yaw};
    rt.setLodScale(${lodScale === null ? "null" : lodScale});
    rt.resetPerf();
    return true;
  `);
  await new Promise((r) => setTimeout(r, settleMs));
  return page.eval("return window.__rt.stats();");
}

// ===================================================================== perf

test("PERF: a 240-structure world builds, and part-type batching still holds", opts, async () => {
  await openWorld("w_perf");
  const s = await page.eval("return window.__rt.stats();");
  await openWorld("w_perf_big");
  const b = await page.eval("return window.__rt.stats();");

  assert.ok(b.structures >= 200, `the stress world must be large, got ${b.structures} structures`);
  assert.ok(b.instances_total > 900, `expected a four-figure instance count, got ${b.instances_total}`);
  assert.equal(b.instances_total, b.instances_by_tier_total.reduce((x, y) => x + y, 0),
    "every instance must belong to exactly one LOD tier");

  // Batching is keyed on part TYPE, so ~35x the buildings must not mean ~35x
  // the batches. If this drifts, the LOD pass has undone the instancing.
  assert.ok(b.instanced_batches <= s.instanced_batches + 2,
    `batch count should track part types, not building count: ${s.instanced_batches} -> ${b.instanced_batches}`);
  // The proof of batching is marginal cost. A tiny world's draw count is
  // dominated by fixed overhead — terrain, sky, NPC limbs — so what matters is
  // what the extra 240 buildings themselves cost.
  const extraStructures = b.structures - s.structures;
  const extraDraws = b.draw_calls - s.draw_calls;
  assert.ok(extraDraws < extraStructures * 0.25,
    `${extraStructures} extra buildings cost ${extraDraws} extra draw calls (${s.draw_calls} -> ${b.draw_calls})`);
});

test("PERF: the rendered instance count falls with distance, using the declared lod[] tiers", opts, async () => {
  await openWorld("w_perf_big");

  const declared = await page.eval("return window.__rt.stats().lod_tier_declared;");
  assert.deepEqual(declared, [60, 140, 320], "the tier distances must come from the manifest, not from a guess");

  // The scale is pinned so distance is the only thing changing. Auto mode —
  // which spends any spare budget by reaching further — is measured separately.
  const cz = (CLUSTER.z0 + CLUSTER.z1) / 2;
  const stops = [cz + 90, cz + 160, cz + 240, cz + 320];
  const seen = [];
  for (const z of stops) {
    const st = await sampleAt(131, z, { lodScale: 1 });
    seen.push({ z, dist: Math.round(z - cz), rendered: st.instances_rendered, tiers: st.instances_by_tier });
    assert.ok(st.instances_rendered <= st.instances_total,
      `cannot render more instances than exist: ${st.instances_rendered}/${st.instances_total}`);
  }
  const line = seen.map((r) => `${r.dist}m:${r.rendered}`).join("  ");

  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].rendered <= seen[i - 1].rendered,
      `rendered instances must not rise as the player retreats — ${line}`);
  }
  assert.ok(seen[seen.length - 1].rendered < seen[0].rendered * 0.5,
    `retreating ${stops[stops.length - 1] - stops[0]}m must at least halve the rendered set — ${line}`);
  assert.ok(seen[0].rendered > 200, `the near sample must actually be drawing the cluster — ${line}`);
});

test("PERF: trim is culled harder than mass — the tiers do different work", opts, async () => {
  await openWorld("w_perf_big");
  const cz = (CLUSTER.z0 + CLUSTER.z1) / 2;
  const st = await sampleAt(131, cz + 150, { lodScale: 1 });

  const dist = st.lod_tier_distances;
  assert.ok(dist[0] < dist[1] && dist[1] < dist[2],
    `the effective tier distances must increase outward, got ${JSON.stringify(dist)}`);

  const totals = st.instances_by_tier_total;
  const shown = st.instances_by_tier;
  const frac = shown.map((v, i) => (totals[i] ? v / totals[i] : 0));
  const pct = frac.map((f) => (f * 100).toFixed(1) + "%").join(" / ");

  assert.ok(totals[0] > 0 && totals[1] > 0 && totals[2] > 0,
    `all three tiers must be populated, totals ${JSON.stringify(totals)}`);
  assert.ok(frac[0] < frac[1], `trim must survive less well than readable detail — tier fractions ${pct}`);
  assert.ok(frac[1] < frac[2], `readable detail must survive less well than mass — tier fractions ${pct}`);
  assert.ok(frac[0] < frac[2] * 0.5, `trim should be culled far harder than mass — tier fractions ${pct}`);
});

test("PERF: the instance budget is held, and draw calls stay flat while it is", opts, async () => {
  await openWorld("w_perf_big");
  const cz = (CLUSTER.z0 + CLUSTER.z1) / 2;
  const samples = [];
  for (const z of [cz + 20, cz + 120, cz + 260]) samples.push(await sampleAt(131, z));

  for (const st of samples) {
    assert.equal(st.lod_auto, true, "the budget controller must be the default");
    assert.ok(st.instances_rendered <= st.instance_budget * 1.25,
      `the world must stay inside its declared instance budget: ${st.instances_rendered} of ${st.instance_budget}`);
    assert.ok(st.instances_rendered < st.instances_total * 0.6,
      `most of a large world must not be drawn at once: ${st.instances_rendered}/${st.instances_total}`);
  }

  // Draw calls are bounded by the SCENE, never by the instance count: every
  // batch is at most one call however many instances survive in it, and a batch
  // with no survivors is not drawn at all. The ceiling is therefore the number
  // of batches plus the handful of objects that are not instanced — terrain,
  // sky, NPC limbs, pickups, weather — and nothing may ever exceed it.
  const scene = await page.eval(`
    let batches = 0, others = 0;
    window.__dcsScene.traverse(function (o) {
      if (o.isInstancedMesh) batches++;
      else if (o.isMesh || o.isPoints || o.isLine) others++;
    });
    return { batches: batches, others: others };
  `);
  const ceiling = scene.batches + scene.others;
  const calls = samples.map((s) => s.draw_calls);
  assert.ok(Math.max(...calls) <= ceiling,
    `draw calls ${JSON.stringify(calls)} exceeded the scene's own ceiling of ${ceiling} (${scene.batches} batches + ${scene.others} single objects)`);
  assert.ok(ceiling < samples[0].structures * 0.3,
    `a ${samples[0].structures}-building world must not need ${ceiling} draw calls`);

  // And the batches really are carrying the world. Measured where the world is
  // densest: far away the surviving instances are spread thinly across every
  // batch, which says nothing about batching either way.
  const dense = samples[0];
  assert.ok(dense.instances_rendered / Math.max(1, dense.draw_calls) > 4,
    `each draw call should carry many instances at close range, got ${dense.instances_rendered} across ${dense.draw_calls} calls`);
  assert.ok(dense.instances_total / ceiling > 15,
    `the whole world is ${dense.instances_total} instances across at most ${ceiling} draw calls`);
});

test("PERF: per-frame work is capped — a large world does not stall the main thread", opts, async () => {
  await openWorld("w_perf_big");
  const cz = (CLUSTER.z0 + CLUSTER.z1) / 2;

  // The worst case for the cull pass is a teleport straight into the densest
  // part of the world: every instance in every batch has to be re-evaluated.
  const st = await sampleAt(131, cz + 15, { settleMs: 2200 });

  assert.ok(st.samples > 30, `not enough frames to measure, got ${st.samples}`);
  assert.ok(st.cull_processed_last_frame <= st.cull_budget * 2,
    `a single frame re-evaluated ${st.cull_processed_last_frame} instances against a budget of ${st.cull_budget}`);
  assert.ok(st.cpu_ms_max < 12,
    `no frame may spend more than 12ms of main thread, worst was ${st.cpu_ms_max}ms`);
  assert.ok(st.cpu_ms_avg < 4,
    `average main-thread cost per frame was ${st.cpu_ms_avg}ms over ${st.samples} frames`);
  assert.ok(st.frame_ms_avg < 50,
    `the frame period must stay playable, measured ${st.frame_ms_avg}ms (${st.fps_avg} fps) over ${st.samples} frames`);
  await page.screenshot(path.join(EVIDENCE, "b-perf-large-world-lod.png"));
});

test("PERF: collision and proximity queries do not scale with world size", opts, async () => {
  // Both used to walk every structure and every door in the world on every
  // frame. The grid makes them local, so a 35x larger world must not cost 35x.
  const bench = `
    const rt = window.__rt;
    const p = rt.player;
    const N = 20000;
    let t = performance.now();
    for (let i = 0; i < N; i++) rt._blocked(p.x + (i % 17), p.z + (i % 13));
    const blockedUs = ((performance.now() - t) * 1000) / N;
    t = performance.now();
    for (let i = 0; i < 4000; i++) rt.nearest();
    const nearestUs = ((performance.now() - t) * 1000) / 4000;
    return { blockedUs, nearestUs, structures: rt.structureIndex.length, doors: rt.doors.length };
  `;
  await openWorld("w_perf");
  const s = await page.eval(bench);
  await openWorld("w_perf_big");
  await page.eval(`window.__rt.teleport(131, ${(CLUSTER.z0 + CLUSTER.z1) / 2}); return true;`);
  const b = await page.eval(bench);

  assert.ok(b.structures > s.structures * 10, `the big world must really be bigger: ${s.structures} -> ${b.structures}`);
  const growth = b.structures / s.structures;
  const blockedGrowth = b.blockedUs / Math.max(s.blockedUs, 0.001);
  assert.ok(blockedGrowth < growth / 4,
    `collision cost grew ${blockedGrowth.toFixed(1)}x for a ${growth.toFixed(1)}x world (${s.blockedUs.toFixed(3)}us -> ${b.blockedUs.toFixed(3)}us)`);
  assert.ok(b.nearestUs < 40,
    `nearest() runs every frame and cost ${b.nearestUs.toFixed(1)}us with ${b.doors} doors`);
});

// =================================================================== mobile

const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };

async function withPhone(fn) {
  await page.send("Emulation.setDeviceMetricsOverride", PHONE);
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    return await fn();
  } finally {
    await page.send("Emulation.clearDeviceMetricsOverride");
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
}

test("MOBILE: a phone gets the low tier, no horizontal scroll, and 44px targets", opts, async () => {
  await withPhone(async () => {
    await openWorld("w_perf_big");
    const r = await page.eval(`
      const rt = window.__rt;
      const vis = function (el) {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };
      // Everything a thumb is expected to hit.
      const controls = Array.from(document.querySelectorAll('button, input, select, textarea, a[href], [role="button"]'))
        .filter(vis)
        .map(function (el) {
          const b = el.getBoundingClientRect();
          return { id: el.id || el.className || el.tagName, w: Math.round(b.width), h: Math.round(b.height) };
        });
      return {
        quality: rt.qualityTier,
        mobile: rt.isMobile,
        touchLayer: getComputedStyle(document.getElementById("touch")).display !== "none",
        hasTouchClass: document.body.classList.contains("has-touch"),
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        controls: controls,
      };
    `);

    assert.equal(r.quality, "low", "a phone must get the low quality tier automatically");
    assert.equal(r.touchLayer, true, "the on-screen controls must be present");
    assert.equal(r.hasTouchClass, true, "the page must know the control strip is occupied");
    assert.ok(r.scrollWidth <= r.innerWidth + 1, `the page scrolls horizontally: ${r.scrollWidth} > ${r.innerWidth}`);
    assert.ok(r.scrollHeight <= r.innerHeight + 1, `the page scrolls vertically: ${r.scrollHeight} > ${r.innerHeight}`);

    assert.ok(r.controls.length >= 2, `expected on-screen controls, found ${JSON.stringify(r.controls)}`);
    const small = r.controls.filter((c) => c.w < 44 || c.h < 44);
    assert.deepEqual(small, [], `tap targets under 44px: ${JSON.stringify(small)}`);
  });
});

test("MOBILE: nothing interactive sits on top of the touch controls", opts, async () => {
  await withPhone(async () => {
    await openWorld("w_perf_big");
    // Open a dialogue as well: the panel that used to sit at 112px from the
    // bottom landed straight across the top of the stick and the USE button.
    const overlaps = await page.eval(`
      const rt = window.__rt;
      const n = rt.npcs[0];
      rt.teleport(n.x + 1.2, n.z);
      rt.interact();
      await new Promise(function (r) { setTimeout(r, 250); });

      const box = function (id) { const e = document.getElementById(id); return e ? e.getBoundingClientRect() : null; };
      const controls = ["stick", "btnE", "btnJump"].map(function (id) { return { id: id, r: box(id) }; }).filter(function (c) { return c.r; });
      const hit = [];
      Array.from(document.querySelectorAll("body > div")).forEach(function (el) {
        if (el.id === "view" || el.id === "touch") return;
        const cs = getComputedStyle(el);
        // Only a panel that can actually receive a tap can steal one.
        if (cs.display === "none" || cs.pointerEvents === "none") return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        controls.forEach(function (c) {
          const over = !(r.right <= c.r.left || r.left >= c.r.right || r.bottom <= c.r.top || r.top >= c.r.bottom);
          if (over) hit.push((el.id || el.className) + " over " + c.id);
        });
      });
      return { hit: hit, dialogueOpen: document.getElementById("dlg").style.display === "block", controls: controls.map(function (c) { return { id: c.id, top: Math.round(c.r.top), h: Math.round(c.r.height) }; }) };
    `);
    assert.equal(overlaps.dialogueOpen, true, "the dialogue must have opened for this to mean anything");
    assert.deepEqual(overlaps.hit, [], `a HUD panel is covering the touch controls: ${overlaps.hit.join("; ")}`);
    await page.screenshot(path.join(EVIDENCE, "b-mobile-hud-clear-of-controls.png"));
  });
});

test("MOBILE: safe-area insets are respected on all four edges", opts, async () => {
  await withPhone(async () => {
    await openWorld("w_perf_big");
    // A notch inset cannot be emulated over CDP, so the check is on the rules
    // the browser would apply if there were one, read out of the page's own
    // stylesheet rather than out of a comment.
    const r = await page.eval(`
      let css = "";
      for (const sheet of Array.from(document.styleSheets)) {
        try { for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + "\\n"; } catch (e) { /* cross-origin */ }
      }
      const need = ["safe-area-inset-top", "safe-area-inset-bottom", "safe-area-inset-left", "safe-area-inset-right"];
      const missing = need.filter(function (n) { return css.indexOf(n) < 0; });
      const meta = document.querySelector('meta[name="viewport"]');
      const stick = getComputedStyle(document.getElementById("stick"));
      const hud = getComputedStyle(document.getElementById("hud"));
      return {
        missing: missing,
        viewportFit: (meta && meta.content || "").indexOf("viewport-fit=cover") >= 0,
        stickLeft: parseFloat(stick.left), stickBottom: parseFloat(stick.bottom),
        hudTop: parseFloat(hud.top), hudLeft: parseFloat(hud.left),
      };
    `);
    assert.deepEqual(r.missing, [], `these safe-area insets are never used: ${r.missing.join(", ")}`);
    assert.equal(r.viewportFit, true, "viewport-fit=cover is what makes the insets non-zero in the first place");
    assert.ok(r.stickLeft >= 26 && r.stickBottom >= 26, `the stick must clear the edge: ${r.stickLeft}/${r.stickBottom}`);
    assert.ok(r.hudTop >= 12 && r.hudLeft >= 12, `the HUD must clear the edge: ${r.hudTop}/${r.hudLeft}`);
  });
});

test("MOBILE: the on-screen stick and buttons drive the runtime", opts, async () => {
  await withPhone(async () => {
    await openWorld("w_perf_big");
    const r = await page.eval(`
      const rt = window.__rt;
      const before = { x: rt.player.x, z: rt.player.z };
      rt.touch.moveVec = { x: 0, y: -1 };
      await new Promise(function (r) { setTimeout(r, 800); });
      rt.touch.moveVec = { x: 0, y: 0 };
      const moved = Math.hypot(rt.player.x - before.x, rt.player.z - before.z);

      const y0 = rt.player.y, vy0 = rt.player.vy;
      document.getElementById("btnJump").click();
      return { moved: moved, jumped: rt.player.vy > vy0 || rt.player.y > y0, grounded0: rt.player.grounded };
    `);
    assert.ok(r.moved > 0.5, `the stick must move the player, travelled ${r.moved.toFixed(2)}m`);
    assert.equal(r.jumped, true, "the JUMP button must actually jump");
  });
});

// ============================================================ accessibility

// The HUD floats over a 3D sky that can be full daylight, so the honest
// backdrop for a contrast check is the brightest one the world can produce.
// Compositing over white and requiring 4.5:1 there means the HUD is legible in
// every world, not just in the dark one the fixture happens to render.
const CONTRAST_HELPERS = `
  function _srgb(c){ c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function _lum(c){ return 0.2126 * _srgb(c[0]) + 0.7152 * _srgb(c[1]) + 0.0722 * _srgb(c[2]); }
  function _parse(s){
    const m = /rgba?\\(([^)]+)\\)/.exec(s || "");
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  function _over(fg, bg){ const a = fg[3]; return [a*fg[0]+(1-a)*bg[0], a*fg[1]+(1-a)*bg[1], a*fg[2]+(1-a)*bg[2], 1]; }
  function _bgOf(el, backdrop){
    const chain = [];
    // Stop at body: the canvas paints the sky over the body background, so the
    // body's colour is not what a HUD panel actually sits on.
    for (let n = el; n && n !== document.body && n.nodeType === 1; n = n.parentElement) {
      chain.push(_parse(getComputedStyle(n).backgroundColor));
    }
    let bg = backdrop.slice();
    for (let i = chain.length - 1; i >= 0; i--) if (chain[i][3] > 0) bg = _over(chain[i], bg);
    return bg;
  }
  function _ratio(a, b){ const l1 = _lum(a), l2 = _lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  function _contrast(el, backdrop, pseudo){
    const cs = getComputedStyle(el, pseudo || null);
    const bg = _bgOf(el, backdrop);
    const fg = _over(_parse(cs.color), bg);
    return {
      ratio: Math.round(_ratio(fg, bg) * 100) / 100,
      size: parseFloat(cs.fontSize),
      weight: Number(cs.fontWeight) || 400,
      color: cs.color,
    };
  }
  // Put every panel on screen with real text in it. Colour is what is being
  // measured, so forcing visibility changes nothing about the answer.
  function _showAll(){
    document.getElementById("dlg").style.display = "block";
    document.getElementById("dwho").textContent = "Harbourmaster · quest giver";
    document.getElementById("dline").textContent = "The tide is turning. Bring me the ledger before dusk.";
    document.getElementById("companion").style.display = "block";
    document.getElementById("ccap").textContent = "You are on the docks";
    document.getElementById("csay").textContent = "Ask me about this place.";
    document.getElementById("csrc").textContent = "from world manifest";
    document.getElementById("prompt").style.display = "block";
    document.getElementById("ptext").textContent = "Talk to the harbourmaster";
    document.getElementById("stats").style.display = "block";
    document.getElementById("toast").textContent = "Objective complete";
    document.getElementById("toast").classList.add("show");
    document.getElementById("touch").style.display = "block";
  }
`;

const TEXT_TARGETS = [
  "#hud .t", "#hud .z", "#hud .v",
  "#quest h3", "#quest .qt", "#qsteps .step",
  "#pkey", "#ptext",
  "#dlg .who", "#dlg .line", "#dlg .x",
  "#companion .nm", "#companion .cap", "#companion .say", "#companion .src",
  "#cask", "#cgo",
  "#stats", "#hint", "#toast",
  "#btnE", "#btnJump",
];

test("A11Y: every piece of HUD text clears 4.5:1 against its own panel", opts, async () => {
  await openWorld("w_perf");
  const report = await page.eval(`
    ${CONTRAST_HELPERS}
    _showAll();
    const sel = ${JSON.stringify(TEXT_TARGETS)};
    const WHITE = [255, 255, 255, 1];
    const out = [];
    sel.forEach(function (s) {
      const el = document.querySelector(s);
      if (!el) { out.push({ sel: s, missing: true }); return; }
      const txt = (el.value || el.textContent || "").trim();
      if (!txt) { out.push({ sel: s, empty: true }); return; }
      const c = _contrast(el, WHITE);
      out.push({ sel: s, ratio: c.ratio, size: c.size, weight: c.weight, color: c.color });
    });
    // The companion placeholder is text too, and it had no colour of its own.
    const ph = _contrast(document.getElementById("cask"), WHITE, "::placeholder");
    out.push({ sel: "#cask::placeholder", ratio: ph.ratio, size: ph.size, weight: ph.weight, color: ph.color });
    return out;
  `);

  const missing = report.filter((r) => r.missing);
  assert.deepEqual(missing.map((r) => r.sel), [], "a HUD element the contrast check names has disappeared");
  const measured = report.filter((r) => typeof r.ratio === "number");
  assert.ok(measured.length >= 18, `expected the whole HUD measured, got ${measured.length}`);

  // WCAG 1.4.3: 4.5:1 for body text, 3:1 for large text (>=24px, or >=18.66px
  // bold). Nothing in this HUD is large, so effectively everything needs 4.5.
  const fails = measured.filter((r) => {
    const large = r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);
    return r.ratio < (large ? 3 : 4.5);
  });
  assert.deepEqual(
    fails.map((f) => `${f.sel} ${f.color} = ${f.ratio}:1 at ${f.size}px`),
    [],
    "HUD text below the WCAG minimum against the brightest sky the world can render",
  );
});

test("A11Y: every interactive control shows a visible focus indicator", opts, async () => {
  await openWorld("w_perf");
  const r = await page.eval(`
    ${CONTRAST_HELPERS}
    _showAll();
    const ids = ["scene", "dclose", "btnE", "btnJump", "cask", "cgo", "dlg"];
    // Nothing may hold focus while the unfocused state is read, or the ring
    // would look permanent when it is not.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const before = {};
    ids.forEach(function (id) {
      const el = document.getElementById(id);
      before[id] = el ? getComputedStyle(el).outlineStyle : "missing";
    });
    return ids.map(function (id) {
      const el = document.getElementById(id);
      if (!el) return { id: id, missing: true };
      el.focus();
      const cs = getComputedStyle(el);
      return {
        id: id,
        focused: document.activeElement === el,
        style: cs.outlineStyle,
        width: parseFloat(cs.outlineWidth) || 0,
        color: cs.outlineColor,
        before: before[id],
      };
    });
  `);
  const bad = r.filter((c) => c.missing || !c.focused || c.style === "none" || c.width < 2);
  assert.deepEqual(bad, [], `controls with no visible focus ring: ${JSON.stringify(bad)}`);
  // And the ring must be a change of state, not something painted permanently.
  const permanent = r.filter((c) => c.before !== "none");
  assert.deepEqual(permanent.map((c) => c.id), [], "the focus ring must only appear on focus, never permanently");
});

test("A11Y: the dialogue is reachable and dismissible by keyboard alone", opts, async () => {
  await openWorld("w_perf");

  const opened = await page.eval(`
    const rt = window.__rt;
    document.getElementById("scene").focus();
    // An NPC the quest does not name: talking to a quest target also fires an
    // objective toast, and the toast would be the last thing in the live region.
    const targets = ((rt.state.quest && rt.state.quest.steps) || []).map(function (s) { return s.target; });
    const n = rt.npcs.filter(function (x) { return targets.indexOf(x.id) < 0; })[0] || rt.npcs[0];
    rt.teleport(n.x + 1.2, n.z);
    rt.interact();
    // Read the announcement before yielding: the next frame may cross a zone
    // boundary and the live region only ever holds the latest thing said.
    const spoken = document.getElementById("live").textContent;
    await new Promise(function (r) { setTimeout(r, 200); });
    const dlg = document.getElementById("dlg");
    return {
      visible: dlg.style.display === "block",
      focused: document.activeElement === dlg,
      spoken: spoken,
      role: dlg.getAttribute("role"),
      labelledby: dlg.getAttribute("aria-labelledby"),
      closeLabel: document.getElementById("dclose").getAttribute("aria-label"),
      closeTag: document.getElementById("dclose").tagName,
      live: document.getElementById("live").textContent,
    };
  `);
  assert.equal(opened.visible, true, "a dialogue must open");
  assert.equal(opened.focused, true, "and must take focus, or a screen reader never hears it");
  assert.equal(opened.role, "dialog");
  assert.equal(opened.labelledby, "dwho");
  assert.equal(opened.closeTag, "BUTTON", "the close affordance must be a real button");
  assert.match(opened.closeLabel, /close/i);
  assert.match(opened.spoken, /says/i, "the line must reach the live region");

  // A real Tab, not a synthetic event: the runtime used to swallow every one.
  await pressKey("Tab", 9);
  const tabbed = await page.eval("return document.activeElement && document.activeElement.id;");
  assert.equal(tabbed, "dclose", "Tab inside the dialogue must reach its close button");

  await pressKey("Escape", 27);
  const closed = await page.eval(`
    return {
      visible: document.getElementById("dlg").style.display === "block",
      focus: document.activeElement && document.activeElement.id,
      live: document.getElementById("live").textContent,
    };
  `);
  assert.equal(closed.visible, false, "Escape must close the dialogue");
  assert.equal(closed.focus, "scene", "and must hand focus back to the world, never strand it");
  assert.match(closed.live, /closed/i);
});

test("A11Y: the world still owns Tab, but a text field does not lose its keys", opts, async () => {
  await openWorld("w_perf");

  // From the canvas, Tab is the world's: it cycles the nearby target.
  await page.eval(`document.getElementById("scene").focus(); window.__rt.teleport(window.__rt.npcs[0].x + 6, window.__rt.npcs[0].z + 4); return true;`);
  await pressKey("Tab", 9);
  const fromWorld = await page.eval(`
    return { focus: document.activeElement && document.activeElement.id, live: document.getElementById("live").textContent };
  `);
  assert.equal(fromWorld.focus, "scene", "Tab from the world must not move focus away from play");
  assert.match(fromWorld.live, /press e to interact|nothing within reach/i, "Tab from the world cycles the nearby target");

  // From a text field, the keys belong to the field. Typing "e" used to open a
  // conversation and "m" used to mute the game.
  const typed = await page.eval(`
    const rt = window.__rt;
    document.getElementById("companion").style.display = "block";
    const box = document.getElementById("cask");
    box.focus();
    rt._muted = false;
    const before = { muted: !!rt._muted, e: !!rt.keys.e };
    return { before: before, focused: document.activeElement === box };
  `);
  assert.equal(typed.focused, true);
  for (const [key, code] of [["e", 69], ["m", 77], ["w", 87]]) await pressKey(key, code, key);
  const after = await page.eval(`
    const rt = window.__rt;
    return { value: document.getElementById("cask").value, muted: !!rt._muted, walking: !!rt.keys.w };
  `);
  assert.equal(after.value, "emw", "the field must receive the keystrokes");
  assert.equal(after.muted, false, "typing must not mute the game");
  assert.equal(after.walking, false, "typing must not walk the player");
});

test("A11Y: the touch buttons are labelled for a screen reader", opts, async () => {
  await withPhone(async () => {
    await openWorld("w_perf");
    const r = await page.eval(`
      const pick = function (id) {
        const el = document.getElementById(id);
        return el ? { tag: el.tagName, label: el.getAttribute("aria-label"), type: el.getAttribute("type"), text: el.textContent.trim() } : null;
      };
      return {
        use: pick("btnE"),
        jump: pick("btnJump"),
        stickHidden: document.getElementById("stick").getAttribute("aria-hidden"),
        canvasLabel: document.getElementById("scene").getAttribute("aria-label"),
      };
    `);
    for (const [name, b] of [["USE", r.use], ["JUMP", r.jump]]) {
      assert.ok(b, `${name} button is missing`);
      assert.equal(b.tag, "BUTTON", `${name} must be a real button, not a div`);
      assert.equal(b.type, "button", `${name} must not submit anything`);
      assert.ok(b.label && b.label.trim().length >= 4, `${name} needs a real aria-label, got ${JSON.stringify(b.label)}`);
    }
    assert.match(r.use.label, /interact/i);
    assert.match(r.jump.label, /jump/i);
    // The stick is a drag affordance with no keyboard equivalent of its own,
    // and the canvas label already documents the arrow keys.
    assert.equal(r.stickHidden, "true", "the stick must not be announced as if it were operable");
    assert.match(r.canvasLabel, /arrow keys/i);
  });
});

/** A real key press through the browser, not a synthetic DOM event. */
async function pressKey(key, code, text) {
  const base = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await page.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await new Promise((r) => setTimeout(r, 120));
}
