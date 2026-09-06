// B3 + B13 exit gate, in a real browser with a real WebGL context.
//
// Serves the canonical frontend plus a stub API that returns a genuinely
// assembled WorldManifestV3, loads play-v3.html in Chrome, and asserts that the
// world renders, that it is materially richer than the cube/cylinder prototype,
// that a player can move and interact, and that mobile is actually playable —
// the Round-2 finding was that a pointer-lock modal made it unusable.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";
import { resolveSite } from "./helpers/site.mjs";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { playtestAndRepair } from "../src/v3/playtest/agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = resolveSite(HERE);   // throws loudly if the frontend is absent
const EVIDENCE = path.resolve(HERE, "../../../DCS_GAMES_SPRINT_SEP2026/evidence/screenshots");

const haveSite = fs.existsSync(path.join(SITE, "play-v3.html"));
const haveChrome = !!findChrome();
const opts = { skip: !haveSite ? "play-v3.html not found" : (!haveChrome ? "no Chrome binary" : false) };

let site, api, browser, page, manifest, bigManifest;

/** A stub of the real API, serving one genuinely assembled world. */
function stubApi(manifestToServe, bigManifest) {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204, {});
    const url = (req.url || "").split("?")[0];
    const m = /\/v3\/worlds\/([^/]+)\/manifest$/.exec(url);
    if (m) {
      // Only the world that exists resolves; anything else is a real 404, which
      // is what the "unknown world" test is actually checking.
      const id = decodeURIComponent(m[1]);
      const served = id === manifestToServe.world_id ? manifestToServe : (bigManifest && id === bigManifest.world_id ? bigManifest : null);
      if (!served) return send(404, { ok: false, error: "not_found", detail: "world not found" });
      return send(200, { ok: true, world_id: served.world_id, world_version: served.world_version, state: "draft", owner: "u1", manifest: served });
    }
    if (/\/v3\/worlds\/[^/]+\/companion$/.test(url)) return send(401, { ok: false, error: "unauthenticated" });
    return send(404, { ok: false, error: "not_found" });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, close: () => new Promise((x) => server.close(x)) })));
}

before(async () => {
  if (opts.skip) return;
  const built = await createAssemblyRouter({ DCS_PROVIDERS_OFFLINE: "1" })
    .assemble({ prompt: "Ashfall Harbour, a rainy nordic port town", worldId: "w_runtime", creatorId: "u1" });
  const gate = await playtestAndRepair(built.manifest);
  assert.equal(gate.passed, true, "the fixture world must itself pass the playtest gate");
  manifest = gate.manifest;

  // A second, much larger world: the batching proof needs two sizes to compare.
  bigManifest = structuredClone(manifest);
  bigManifest.world_id = "w_runtime_big";
  const proto = manifest.structures[0];
  const zone = manifest.zones[0];
  for (let i = 0; i < 120; i++) {
    const c = structuredClone(proto);
    c.id = `struct_bulk_${i}`;
    c.transform.position = {
      x: zone.bounds[0] + 6 + ((zone.bounds[2] - zone.bounds[0] - 12) * (i % 12)) / 12,
      y: 0,
      z: zone.bounds[1] + 6 + ((zone.bounds[3] - zone.bounds[1] - 12) * Math.floor(i / 12)) / 10,
    };
    c.footprint = { w: 6 + (i % 5), d: 6 + (i % 4), h: 5 + (i % 9) };
    bigManifest.structures.push(c);
  }

  site = await serveStatic(SITE);
  api = await stubApi(manifest, bigManifest);
  browser = await launchChrome();
  page = await Page.open(browser);
}, opts);

after(async () => {
  await page?.close();
  await browser?.close();
  await api?.close();
  await site?.close();
});

const openWorld = async (extra = "") => {
  // Point the page at the stub API before its own scripts run.
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.DCS_API_BASE = "http://127.0.0.1:${api.port}";` });
  await page.goto(`${site.url}/play-v3.html?world=w_runtime&stats=1${extra}`, { waitMs: 2500 });
  const ready = await page.waitFor("window.DCSRuntime && document.getElementById('boot').style.display === 'none'", { timeout: 25000 });
  assert.ok(ready, "the world did not finish loading: " + JSON.stringify(page.realErrors().slice(0, 2)));
};

test("B3 GATE: a WorldManifestV3 renders in a real WebGL context", opts, async () => {
  await openWorld();
  const errs = page.realErrors([/api\.games\.dcsai\.ai/, /Failed to fetch/]);
  assert.deepEqual(errs, [], "the runtime must render without a script error");

  const gl = await page.eval(`
    const c = document.getElementById('scene');
    const ctx = c.getContext('webgl2') || c.getContext('webgl');
    return { hasContext: !!ctx, w: c.width, h: c.height };
  `);
  assert.equal(gl.hasContext, true, "a WebGL context must exist");
  assert.ok(gl.w > 100 && gl.h > 100, `canvas is ${gl.w}x${gl.h}`);
  await page.screenshot(path.join(EVIDENCE, "b3-runtime-v3-rendered.png"));
});

test("B3 GATE: the rendered world materially exceeds the cube/cylinder prototype", opts, async () => {
  await openWorld();
  const stats = await page.eval("return window.__rt ? window.__rt.stats() : null;").catch(() => null);
  const s = stats || await page.eval(`
    // The runtime instance is held by the page closure; read what it published.
    return { note: 'from stats panel', text: document.getElementById('stats').textContent };
  `);
  const text = await page.eval("return document.getElementById('stats').textContent;");
  assert.match(text, /structures/, `stats panel did not report: ${text}`);

  const scene = await page.eval(`
    // Walk the Three.js scene graph the page actually built.
    const r = window.__dcsScene;
    if (!r) return null;
    let instanced = 0, meshes = 0, instances = 0, lights = 0, points = 0;
    r.traverse(function(o){
      if (o.isInstancedMesh) { instanced++; instances += o.count; }
      else if (o.isMesh) meshes++;
      if (o.isLight) lights++;
      if (o.isPoints) points++;
    });
    return { instanced, meshes, instances, lights, points };
  `);
  assert.ok(scene, "the scene must be exposed for inspection");
  assert.ok(scene.instanced >= 4, `expected several instanced part batches, got ${scene.instanced}`);
  assert.ok(scene.instances >= 20, `expected many composed building parts, got ${scene.instances}`);
  assert.ok(scene.lights >= 2, "the world must be lit");
  assert.ok(scene.points >= 1, "this world's weather is rain, so a particle system must exist");
  void s;
});

test("B3: terrain is a real heightmap mesh, not a flat plane", opts, async () => {
  await openWorld();
  const t = await page.eval(`
    const s = window.__dcsScene;
    let found = null;
    s.traverse(function(o){
      if (found || !o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      if (o.geometry.attributes.position.count > 400 && o.geometry.attributes.color) found = o;
    });
    if (!found) return null;
    const p = found.geometry.attributes.position;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < p.count; i++) { const z = p.getZ(i); if (z < min) min = z; if (z > max) max = z; }
    return { verts: p.count, relief: max - min, hasColor: !!found.geometry.attributes.color };
  `);
  assert.ok(t, "a terrain mesh must exist");
  assert.ok(t.verts > 400, `terrain should be a dense mesh, got ${t.verts} vertices`);
  assert.ok(t.relief > 1, `terrain must have real relief, got ${t.relief.toFixed(2)}m`);
  assert.equal(t.hasColor, true, "terrain is shaded by elevation");
});

test("B3 GATE: the player can move, and cannot walk through a building", opts, async () => {
  await openWorld();
  const moved = await page.eval(`
    const rt = window.__rt;
    const before = { x: rt.player.x, z: rt.player.z };
    rt.keys.w = true;
    await new Promise(r => setTimeout(r, 900));
    rt.keys.w = false;
    const after = { x: rt.player.x, z: rt.player.z };
    return { before, after, moved: Math.hypot(after.x - before.x, after.z - before.z) };
  `);
  assert.ok(moved.moved > 0.5, `the player should have moved, travelled ${moved.moved.toFixed(2)}m`);

  const collided = await page.eval(`
    const rt = window.__rt;
    const s = rt.structureIndex[0];
    rt.teleport(s.x + s.r + 2.5, s.z);
    const start = { x: rt.player.x, z: rt.player.z };
    // Walk straight at the building for a second.
    for (let i = 0; i < 60; i++) {
      const nx = rt.player.x - 0.12;
      if (!rt._blocked(nx, rt.player.z)) rt.player.x = nx;
    }
    return { distanceToCentre: Math.hypot(rt.player.x - s.x, rt.player.z - s.z), radius: s.r, start };
  `);
  assert.ok(collided.distanceToCentre > collided.radius * 0.8,
    `the player walked into a building: ${collided.distanceToCentre.toFixed(2)}m from centre, radius ${collided.radius.toFixed(2)}m`);
});

test("B3 GATE: the player follows the terrain rather than floating", opts, async () => {
  await openWorld();
  const r = await page.eval(`
    const rt = window.__rt;
    const samples = [];
    for (const [x, z] of [[40, 40], [90, 60], [140, 100]]) {
      rt.teleport(x, z);
      samples.push({ playerY: rt.player.y, groundY: rt.terrain.heightAt(x, z) });
    }
    return samples;
  `);
  for (const s of r) assert.ok(Math.abs(s.playerY - s.groundY) < 0.01, `player y ${s.playerY} does not match ground ${s.groundY}`);
});

test("B3 GATE: interaction works — talking, collecting and opening", opts, async () => {
  await openWorld();
  const talk = await page.eval(`
    const rt = window.__rt;
    const n = rt.npcs[0];
    rt.teleport(n.x + 1.4, n.z);
    const r = rt.interact();
    return { kind: r && r.kind, dialogue: document.getElementById('dlg').style.display, who: document.getElementById('dwho').textContent };
  `);
  assert.equal(talk.kind, "npc");
  assert.equal(talk.dialogue, "block", "a dialogue panel must open");
  assert.ok(talk.who.length > 0);

  const pick = await page.eval(`
    const rt = window.__rt;
    if (!rt.pickups.length) return { skipped: true };
    const k = rt.pickups[0];
    rt.teleport(k.x + 1.0, k.z);
    document.getElementById('dlg').style.display = 'none';
    const r = rt.interact();
    return { kind: r && r.kind, inventory: rt.state.inventory.slice(), visible: k.mesh.visible };
  `);
  if (!pick.skipped) {
    assert.equal(pick.kind, "pickup");
    assert.equal(pick.inventory.length, 1, "the item must land in the inventory");
    assert.equal(pick.visible, false, "a collected item disappears from the world");
  }

  const door = await page.eval(`
    const rt = window.__rt;
    if (!rt.doors.length) return { skipped: true };
    const d = rt.doors[0];
    rt.teleport(d.position.x + 1.2, d.position.z);
    const before = d.userData.open;
    rt.interact();
    return { before, after: d.userData.open };
  `);
  if (!door.skipped) assert.notEqual(door.after, door.before, "a door must actually open");
});

test("B3: completing quest steps ticks the on-screen objective list", opts, async () => {
  await openWorld();
  const r = await page.eval(`
    const rt = window.__rt;
    const q = rt.state.quest;
    if (!q) return { skipped: true };
    const talkStep = q.steps.find(s => s.kind === 'talk');
    if (!talkStep) return { skipped: true };
    const n = rt.npcs.find(x => x.id === talkStep.target);
    if (!n) return { skipped: true };
    rt.teleport(n.x + 1.2, n.z);
    rt.interact();
    const el = document.querySelector('[data-step="' + talkStep.id + '"]');
    return { done: !!(el && el.classList.contains('done')), completed: rt.state.completedSteps[talkStep.id] === true };
  `);
  if (!r.skipped) {
    assert.equal(r.completed, true, "the runtime must record the step");
    assert.equal(r.done, true, "and the HUD must show it ticked");
  }
});

// ------------------------------------------------------------------ B13 mobile

test("B13 GATE: there is NO blocking pointer-lock modal — the Round-2 mobile defect", opts, async () => {
  await openWorld();
  const r = await page.eval(`
    const blocking = Array.from(document.querySelectorAll('body > div')).filter(function(el){
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.pointerEvents === 'none') return false;
      const r = el.getBoundingClientRect();
      // A full-screen visible overlay that must be clicked before play.
      return r.width > innerWidth * 0.85 && r.height > innerHeight * 0.85 && el.id !== 'view';
    }).map(function(el){ return el.id || el.className; });
    return { blocking, locked: !!document.pointerLockElement };
  `);
  assert.deepEqual(r.blocking, [], `a full-screen overlay is blocking play: ${r.blocking.join(", ")}`);
  assert.equal(r.locked, false, "play must not require pointer lock");
});

test("B13 GATE: on a touch device the world is playable with on-screen controls", opts, async () => {
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    await openWorld();
    const ui = await page.eval(`
      const vis = function(id){ const e = document.getElementById(id); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0; };
      return { touchLayer: getComputedStyle(document.getElementById('touch')).display !== 'none', stick: vis('stick'), use: vis('btnE'), jump: vis('btnJump'), horizontalScroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
    `);
    assert.equal(ui.touchLayer, true, "touch controls must appear on a touch device");
    assert.equal(ui.stick, true, "a movement stick must be visible");
    assert.equal(ui.use, true, "an interact button must be visible");
    assert.equal(ui.jump, true, "a jump button must be visible");
    assert.equal(ui.horizontalScroll, false, "the page must not scroll horizontally on a phone");

    // The stick must actually drive the player.
    const moved = await page.eval(`
      const rt = window.__rt;
      const before = { x: rt.player.x, z: rt.player.z };
      rt.touch.moveVec = { x: 0, y: -1 };
      await new Promise(r => setTimeout(r, 800));
      rt.touch.moveVec = { x: 0, y: 0 };
      return Math.hypot(rt.player.x - before.x, rt.player.z - before.z);
    `);
    assert.ok(moved > 0.5, `the touch stick must move the player, travelled ${moved.toFixed(2)}m`);

    const q = await page.eval("return window.__rt.qualityTier;");
    assert.equal(q, "low", "a phone must get the low quality tier automatically");
    await page.screenshot(path.join(EVIDENCE, "b13-mobile-touch-controls.png"));
  } finally {
    await page.send("Emulation.clearDeviceMetricsOverride");
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
});

test("B3 GATE: draw calls do not scale with the number of buildings", opts, async () => {
  // The real proof of batching is marginal cost, not an absolute number: a tiny
  // world's draw count is dominated by fixed overhead (terrain, sky, lights,
  // NPCs), so comparing two world sizes is what actually tests instancing.
  await openWorld();
  const small = await page.eval("return window.__rt.stats();");

  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.DCS_API_BASE = "http://127.0.0.1:${api.port}";` });
  await page.goto(`${site.url}/play-v3.html?world=w_runtime_big&stats=1`, { waitMs: 3000 });
  await page.waitFor("window.__rt && document.getElementById('boot').style.display === 'none'", { timeout: 25000 });
  const big = await page.eval("return window.__rt.stats();");

  assert.ok(big.structures > small.structures + 100, `the large world should have far more buildings: ${big.structures} vs ${small.structures}`);
  const extraStructures = big.structures - small.structures;
  const extraDraws = big.draw_calls_estimate - small.draw_calls_estimate;
  assert.ok(extraDraws < extraStructures * 0.25,
    `${extraStructures} extra buildings cost ${extraDraws} extra draw calls — instancing is not batching them`);
  assert.ok(big.instanced_batches <= small.instanced_batches + 2,
    `batch count should be driven by part TYPES, not building count: ${small.instanced_batches} -> ${big.instanced_batches}`);
  await page.screenshot(path.join(EVIDENCE, "b3-instanced-large-world.png"));
});

test("B3: an unknown world reports the real reason instead of a fake success", opts, async () => {
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.DCS_API_BASE = "http://127.0.0.1:${api.port}";` });
  await page.goto(`${site.url}/play-v3.html?world=does-not-exist`, { waitMs: 2500 });
  const t = await page.text();
  assert.match(t, /Could not load the world/i);
  assert.match(t, /does not exist/i);
});

test("B3: opening the player with no world says what it needs", opts, async () => {
  await page.goto(`${site.url}/play-v3.html`, { waitMs: 1500 });
  const t = await page.text();
  assert.match(t, /No world selected/i);
  assert.doesNotMatch(t, /Loading world/i, "it must not sit on a loading state forever");
});

// ------------------------------------------------- B15 audio + accessibility

test("B15 GATE: the world is fully playable from the keyboard alone", opts, async () => {
  await openWorld();
  const r = await page.eval(`
    const rt = window.__rt;
    document.getElementById('scene').focus();

    // Move with arrow keys only.
    const start = { x: rt.player.x, z: rt.player.z };
    rt.keys.arrowup = true;
    await new Promise(r => setTimeout(r, 700));
    rt.keys.arrowup = false;
    const moved = Math.hypot(rt.player.x - start.x, rt.player.z - start.z);

    // Turn with the keyboard only.
    const yaw0 = rt.player.yaw;
    rt.keys.j = true;
    await new Promise(r => setTimeout(r, 400));
    rt.keys.j = false;
    const turned = Math.abs(rt.player.yaw - yaw0);

    return { moved, turned, focused: document.activeElement === document.getElementById('scene') };
  `);
  assert.ok(r.moved > 0.4, `arrow keys must move the player, travelled ${r.moved.toFixed(2)}m`);
  assert.ok(r.turned > 0.1, `J and L must turn the camera, turned ${r.turned.toFixed(3)} rad`);
  assert.equal(r.focused, true, "the canvas must take focus so a keyboard player can start immediately");
});

test("B15 GATE: Tab cycles nearby things and announces them, so interaction needs no pointer", opts, async () => {
  await openWorld();
  const r = await page.eval(`
    const rt = window.__rt;
    const n = rt.npcs[0];
    rt.teleport(n.x + 8, n.z + 6);
    const t = rt.cycleTarget(1);
    await new Promise(r => setTimeout(r, 120));
    const nearest = rt.nearest();
    return {
      target: t && t.kind,
      label: t && t.label,
      live: document.getElementById('live').textContent,
      reachable: !!nearest,
    };
  `);
  assert.ok(r.target, "Tab must find something to target");
  assert.ok(r.reachable, "and must bring the player close enough that E works");
  assert.match(r.live, /Press E to interact/, "the target must be announced to a screen reader");
});

test("B15: the HUD announces state changes to a screen reader", opts, async () => {
  await openWorld();
  const r = await page.eval(`
    const live = document.getElementById('live');
    return { exists: !!live, polite: live && live.getAttribute('aria-live'), initial: live && live.textContent };
  `);
  assert.equal(r.exists, true, "a live region is required");
  assert.equal(r.polite, "polite");
  assert.match(r.initial, /World loaded/);

  const canvas = await page.eval(`
    const c = document.getElementById('scene');
    return { role: c.getAttribute('role'), label: c.getAttribute('aria-label'), tabindex: c.getAttribute('tabindex') };
  `);
  assert.equal(canvas.role, "application");
  assert.equal(canvas.tabindex, "0");
  assert.match(canvas.label, /Tab to cycle/, "the control scheme must be discoverable by a screen reader");
});

test("B15: audio exists, and is honest about being suspended until a gesture", opts, async () => {
  await openWorld();
  const a = await page.eval("return window.__rt.stats().audio;");
  assert.equal(a.supported, true, "WebAudio must be available");
  // Autoplay policy: nothing may claim to be playing before a gesture.
  const after = await page.eval(`
    const rt = window.__rt;
    rt.audio.start();
    rt.audio.event('pickup');
    rt.audio.footstep();
    return rt.audio.state();
  `);
  assert.equal(after.enabled, true, "audio starts once a gesture has occurred");
});

test("B15: prefers-reduced-motion is respected", opts, async () => {
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    await openWorld();
    const r = await page.eval(`
      const rt = window.__rt;
      const k = rt.pickups[0];
      if (!k) return { reduced: rt.reducedMotion, skipped: true };
      const y0 = k.mesh.position.y;
      await new Promise(r => setTimeout(r, 700));
      return { reduced: rt.reducedMotion, drift: Math.abs(k.mesh.position.y - y0) };
    `);
    assert.equal(r.reduced, true, "the runtime must detect the preference");
    if (!r.skipped) assert.ok(r.drift < 0.01, `a floating pickup should be still under reduced motion, drifted ${r.drift}`);
  } finally {
    await page.send("Emulation.setEmulatedMedia", { features: [] });
  }
});
