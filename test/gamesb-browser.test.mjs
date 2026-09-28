// Games-B browser runtime (contract §10), in a real Chrome with a real WebGL
// context (SwiftShader, so no GPU is needed and numbers are CPU-bound).
//
// Serves the WORKTREE ROOT, so play.html's `../src/gamesb/...` imports resolve
// exactly as they do from a deployed copy, and drives the page only through
// window.__DCS_GAMES_B__ — the same hook an external agent would use.
//
// Two packages: the hand-authored mini fixture (always present, so the runtime
// is tested even when the pipeline is broken) and the built flagship, which also
// gets played to a win, benchmarked and photographed for docs/games-b/evidence.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic, launchChrome, Page, findChrome } from "./helpers/browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "docs/games-b/evidence");
const MINI = "/test/fixtures/gamesb/browser/mini.package.json";
const FLAGSHIP = "/games-b-runtime/games/lanternfall/package.json";
const have = (rel) => fs.existsSync(path.join(ROOT, rel));

const missing = ["games-b-runtime/play.html", "src/gamesb/runtime/sim-core.mjs", "src/gamesb/runtime/deps.mjs"].filter((f) => !have(f));
const skip = !findChrome() ? "no Chrome binary (set DCS_CHROME)" : missing.length ? `missing ${missing.join(", ")}` : false;
const flagSkip = skip || (!have(FLAGSHIP.slice(1)) ? "flagship package not built (node src/gamesb/flagship/build.mjs)" : false);

let site, browser;
// Background tabs throttle timers and rendering; these tests drive one tab at a time.
const CHROME_ARGS = ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
before(async () => {
  if (skip) return;
  site = await serveStatic(ROOT);
  browser = await launchChrome({ extraArgs: CHROME_ARGS });
});
after(async () => { await browser?.close(); await site?.close(); });
// A fresh browser per package suite: helpers/browser.mjs reaps any harness Chrome
// older than two minutes whenever another run launches one, so a single browser
// held for the whole file is at the mercy of concurrent test runs.
async function freshBrowser() {
  await browser?.close();
  browser = await launchChrome({ extraArgs: CHROME_ARGS });
}

async function open(page, pkgPath, extra = "") {
  const t0 = Date.now();
  await page.goto(`${site.url}/games-b-runtime/play.html?pkg=${pkgPath}${extra}`, { waitMs: 300 });
  const ready = await page.waitFor("window.__DCS_GAMES_B__ && window.__DCS_GAMES_B__.ready", { timeout: 20000 });
  const why = ready ? "" : JSON.stringify({ errors: await page.eval("return window.__DCS_GAMES_B__ && window.__DCS_GAMES_B__.errors").catch(() => null), page: page.pageErrors.slice(0, 3) });
  assert.ok(ready, `runtime not ready within 20 s: ${why}`);
  return Date.now() - t0;
}

function consoleErrors(page) {
  return page.consoleLogs.filter((l) => l.type === "error" && !/favicon/i.test(l.text));
}

const H = "const H = window.__DCS_GAMES_B__;";

// In-page helpers: a free standing spot near a target, and a driver that plays the
// objective chain by teleport + interact + first dialogue choice. It uses only the
// hook and the sim's own collision/terrain deps, so it cannot cheat past the rules.
const DRIVER = `
${H}
const pkg = H.pkg, W = pkg.world;
const S = () => H.sim;
const water = W.environment && W.environment.water && W.environment.water.enabled ? W.environment.water.level : -1e9;
function freeSpot(tx, tz, minD) {
  const d = S().deps;
  for (let r = minD || 0; r < 10; r += 0.5) for (let a = 0; a < 24; a++) {
    const x = tx + Math.cos(a / 24 * 6.2832) * r, z = tz + Math.sin(a / 24 * 6.2832) * r;
    if (x < 1 || z < 1 || x > W.size.w - 1 || z > W.size.h - 1) continue;
    if (d.terrain.sampleHeight(W.terrain, x, z) < water + 0.3) continue;
    if (d.collision.pointInCollider(S().colliders, x, z, 0.55)) continue;
    return { x, z };
  }
  return { x: tx, z: tz };
}
function ixPos(ix) {
  if (ix.placement_ref) { const p = W.placements.find((q) => q.id === ix.placement_ref); return p && p.position; }
  const n = S().npcs[ix.character_ref]; return n && n.position;
}
function targetOf(o) {
  const ref = o.target_ref;
  const reg = W.regions.find((r) => r.id === ref); if (reg) return { pos: reg.center, walk: true };
  const ix = W.interactables.find((i) => i.id === ref); if (ix) return { pos: ixPos(ix), ix };
  if (S().npcs[ref]) { const ix2 = W.interactables.find((i) => i.character_ref === ref); return { pos: S().npcs[ref].position, ix: ix2 }; }
  const pick = W.interactables.find((i) => i.item_ref === ref && !S().collected.includes(i.id));
  if (pick) return { pos: ixPos(pick), ix: pick };
  return null;
}
window.__goNear = function (x, z) { const p = freeSpot(x, z, 0.8); H.teleport(p.x, p.z); H.stepFrames(2); return p; };
// Walk a dialogue to its end: take the first choice leading somewhere new (so
// quest-accepting branches are taken), never revisit a node, end when stuck.
window.__finishDialogue = function () {
  const seen = new Set();
  for (let g = 0; g < 24 && H.dialogue(); g++) {
    const d = H.dialogue();
    seen.add(d.node.id);
    let i = d.choices.findIndex((c) => c.next && !seen.has(c.next));
    if (i < 0) i = d.choices.findIndex((c) => !c.next);
    if (i < 0) i = 0;
    H.input({ choice: i }); H.stepFrames(3);
  }
  return !H.dialogue();
};
window.__interact = function () {
  H.input({ interact: true }); H.stepFrames(3);
  window.__finishDialogue();
};
window.__drive = function (maxActs) {
  const log = [];
  for (let i = 0; i < (maxActs || 60); i++) {
    if (S().status !== "playing") break;
    const o = pkg.gameplay.objectives.find((x) => S().game.objectives[x.id] === "active" && !x.optional);
    if (!o) { H.stepFrames(5); continue; }
    const t = targetOf(o);
    if (!t || !t.pos) { log.push("no target for " + o.id); break; }
    window.__goNear(t.pos.x, t.pos.z);
    if (!t.walk) window.__interact();
    else H.stepFrames(10);
    log.push(o.id + ":" + S().game.objectives[o.id]);
  }
  return { status: S().status, log, t: S().t };
};
`;

function suite(label, pkgPath, suiteSkip, { flagship = false } = {}) {
  const opts = { skip: suiteSkip };
  let page;
  const shot = (name) => page.screenshot(path.join(EVIDENCE, flagship ? `${name}.png` : `mini-${name}.png`));

  test(`${label}: loads, renders terrain/water/sky, zero errors`, opts, async () => {
    await freshBrowser();
    page = await Page.open(browser);
    const ms = await open(page, pkgPath);
    await page.eval(DRIVER);
    const s = await page.eval(`${H} return { scene: H.scene(), stats: H.stats(), errors: H.errors, status: H.status(), mode: H.mode }`);
    assert.equal(s.mode, "play", "sim-core must load — view-only mode means a module failed");
    assert.equal(s.status, "playing");
    assert.ok(s.scene.terrain && s.scene.water && s.scene.sky, `terrain/water/sky: ${JSON.stringify(s.scene)}`);
    assert.ok(s.stats.draw_calls > 0 && s.stats.triangles > 0, `stats: ${JSON.stringify(s.stats)}`);
    assert.deepEqual(s.scene.missingRefs, [], "every asset ref resolves to a recipe");
    assert.deepEqual(s.errors, []);
    assert.deepEqual(page.realErrors(), []);
    assert.deepEqual(consoleErrors(page), []);
    test.diagnostic?.(`${label}: ready in ${ms} ms`);
    console.log(`# ${label}: ready in ${ms} ms, ${s.stats.draw_calls} draw calls, ${s.stats.triangles} triangles, ${s.scene.instanced} instances in ${s.scene.chunks} instanced meshes`);
    if (flagship) {
      await page.eval(`${H} H.view({ pitch: 0.34, dist: 9 })`);
      await shot("lanternfall-harbour");
      await page.eval(`${H} H.view({ pitch: 0.62, dist: 55 })`);
      await shot("lanternfall-dusk-overview");
      await page.eval(`${H} H.view({ pitch: 0.32, dist: 8 })`);
    } else await shot("start");
  });

  test(`${label}: camera-relative movement moves the player and the camera follows`, opts, async () => {
    const r = await page.eval(`${H}
      const sp = H.sim.player.position; const s0 = { x: sp.x, z: sp.z };
      window.__goNear(s0.x, s0.z);
      const a = { ...H.sim.player.position }, c0 = H.camera();
      H.input({ move: { x: 0.7071, z: 0.7071 } }); H.stepFrames(90); H.input({ move: { x: 0, z: 0 } }); H.stepFrames(30);
      const b = { ...H.sim.player.position }; H.view({}); const c1 = H.camera();
      return { a, b, c0, c1, moved: Math.hypot(b.x - a.x, b.z - a.z), camDist: Math.hypot(c1.x - b.x, c1.z - b.z), camMoved: Math.hypot(c1.x - c0.x, c1.z - c0.z) };`);
    assert.ok(r.moved > 2, `player moved only ${r.moved.toFixed(2)} m in 1.5 s`);
    assert.ok(r.camDist < 20, `camera ${r.camDist.toFixed(1)} m from the player`);
    assert.ok(r.camMoved > 1, "camera did not follow");
  });

  test(`${label}: walking into a solid structure stops at its collider`, opts, async () => {
    const r = await page.eval(`${H}
      const S = H.sim, W = H.pkg.world, d = S.deps;
      const water = W.environment.water && W.environment.water.enabled ? W.environment.water.level : -1e9;
      const boxes = W.placements.filter((p) => p.collider && p.collider.solid && p.collider.shape === "box" && p.collider.size.x >= 1.5 && p.collider.size.z >= 1.5);
      for (const p of boxes) {
        const hx = p.collider.size.x / 2, hz = p.collider.size.z / 2, th = p.rotation_y || 0;
        // local -z face, approached along local +z. Local→world: x = lx cosθ + lz sinθ, z = -lx sinθ + lz cosθ.
        const toW = (lx, lz) => ({ x: p.position.x + lx * Math.cos(th) + lz * Math.sin(th), z: p.position.z - lx * Math.sin(th) + lz * Math.cos(th) });
        for (const side of [-1, 1]) {
          const st = toW(0, side * (hz + 3.5));
          if (d.terrain.sampleHeight(W.terrain, st.x, st.z) < water + 0.3) continue;
          if (d.collision.pointInCollider(S.colliders, st.x, st.z, 0.6)) continue;
          if (Math.abs(d.terrain.sampleHeight(W.terrain, st.x, st.z) - p.position.y) > 1.5) continue;
          H.teleport(st.x, st.z); H.stepFrames(2);
          const before = S.stats.collisions;
          const dir = { x: -side * Math.sin(th), z: -side * Math.cos(th) };
          H.input({ move: dir }); H.stepFrames(150); H.input({ move: { x: 0, z: 0 } }); H.stepFrames(2);
          const q = S.player.position;
          const dx = q.x - p.position.x, dz = q.z - p.position.z;
          const lz = dx * Math.sin(th) + dz * Math.cos(th), lx = dx * Math.cos(th) - dz * Math.sin(th);
          return { id: p.id, hz, hx, lz, lx, hits: S.stats.collisions - before, start: st };
        }
      }
      return null;`);
    assert.ok(r, "no solid box placement with a walkable approach");
    assert.ok(r.hits > 0, `never touched ${r.id}`);
    const inside = Math.abs(r.lz) < r.hz - 0.05 && Math.abs(r.lx) < r.hx - 0.05;
    assert.ok(!inside, `player ended INSIDE ${r.id}: local (${r.lx.toFixed(2)}, ${r.lz.toFixed(2)}) vs half (${r.hx}, ${r.hz})`);
    assert.ok(Math.abs(r.lz) >= r.hz, `player at |lz|=${Math.abs(r.lz).toFixed(2)} crossed the face at ${r.hz}`);
  });

  test(`${label}: talking opens the dialogue panel`, opts, async () => {
    const r = await page.eval(`${H}
      const giver = H.pkg.characters.characters.find((c) => c.role === "quest_giver");
      const n = H.sim.npcs[giver.id];
      window.__goNear(n.position.x, n.position.z);
      H.input({ interact: true }); H.stepFrames(3);
      return { dlg: H.dialogue(), hud: H.hud(), id: giver.id };`);
    assert.ok(r.dlg, "no dialogue opened");
    assert.equal(r.dlg.character_ref, r.id);
    assert.equal(r.hud.dialogue, true, "dialogue panel hidden");
    if (flagship) {
      // A side-on two-shot of player and speaker, from whichever side has a clear line.
      await page.eval(`${H} const n = H.sim.npcs[${JSON.stringify(r.id)}].position, p = H.sim.player.position, d = H.sim.deps;
        const mx = (n.x + p.x) / 2, mz = (n.z + p.z) / 2, len = Math.hypot(n.x - p.x, n.z - p.z) || 1;
        const px = -(n.z - p.z) / len, pz = (n.x - p.x) / len;
        const clear = (sx, sz) => { for (let k = 1; k < 10; k++) { const x = sx + (mx - sx) * k / 10, z = sz + (mz - sz) * k / 10; if (d.collision.pointInCollider(H.sim.colliders, x, z, 0.3)) return false; } return true; };
        let best = null;
        for (const dist of [4, 5.5, 3]) for (const side of [1, -1]) { const x = mx + px * side * dist, z = mz + pz * side * dist; if (!best && clear(x, z)) best = { x, z }; }
        best = best || { x: mx + px * 4, z: mz + pz * 4 };
        const gy = d.terrain.sampleHeight(H.pkg.world.terrain, mx, mz);
        H.photo({ x: best.x, y: Math.max(gy, d.terrain.sampleHeight(H.pkg.world.terrain, best.x, best.z)) + 1.8, z: best.z }, { x: mx, y: gy + 1.2, z: mz });`);
      await shot("lanternfall-dialogue");
    } else await shot("dialogue");
    await page.eval(`${H} window.__finishDialogue(); H.view({ pitch: 0.32, dist: 8 });`);
    assert.equal(await page.eval(`${H} return !!H.dialogue()`), false, "dialogue did not close");
  });

  test(`${label}: interacting with a pickup adds it to the inventory and hides its mesh`, opts, async () => {
    const r = await page.eval(`${H}
      const ix = H.pkg.world.interactables.find((i) => i.kind === "pickup" && !H.sim.collected.includes(i.id));
      const pl = H.pkg.world.placements.find((p) => p.id === ix.placement_ref);
      const before = (H.sim.game.inventory || {})[ix.item_ref] || 0;
      window.__goNear(pl.position.x, pl.position.z);
      const visBefore = H.placementVisible(pl.id);
      H.input({ interact: true }); H.stepFrames(3);
      return { ix: ix.id, item: ix.item_ref, before, after: (H.sim.game.inventory || {})[ix.item_ref] || 0, visBefore, visAfter: H.placementVisible(pl.id), hud: H.hud() };`);
    assert.equal(r.visBefore, true);
    assert.equal(r.after, r.before + 1, `inventory ${r.item}: ${r.before} → ${r.after}`);
    assert.equal(r.visAfter, false, "collected pickup still visible");
    assert.ok(r.hud.inventory >= 1, "inventory HUD empty");
    if (flagship) await shot("lanternfall-hud");
  });

  test(`${label}: save → reload the page → load restores position and inventory`, opts, async () => {
    const saved = await page.eval(`${H} H.stepFrames(5); const s = H.save(); return { pos: s.player.position, inv: s.game.inventory, t: s.t, key: Object.keys(localStorage).find((k) => k.startsWith("dcs-gamesb:")) }`);
    assert.ok(saved.key, "save not written to localStorage");
    await open(page, pkgPath);
    await page.eval(DRIVER);
    const loaded = await page.eval(`${H} H.load(); H.stepFrames(1); return { pos: { ...H.sim.player.position }, inv: H.sim.game.inventory, hud: H.hud() }`);
    assert.ok(Math.hypot(loaded.pos.x - saved.pos.x, loaded.pos.z - saved.pos.z) < 0.25, `position ${JSON.stringify(loaded.pos)} vs saved ${JSON.stringify(saved.pos)}`);
    assert.deepEqual(loaded.inv, saved.inv);
    assert.ok(loaded.hud.inventory >= 1);
  });

  test(`${label}: playing the objective chain to the end shows the win overlay`, opts, async () => {
    if (flagship) {
      // Location shots on the way: the Stormwisps' ruins and the unlit lighthouse.
      for (const [reg, name, v] of [["region_sunken_ruins", "lanternfall-ruins", { pitch: 0.3, dist: 11 }], ["region_lighthouse_summit", "lanternfall-lighthouse", { pitch: 0.22, dist: 15 }]]) {
        await page.eval(`${H} const r = H.pkg.world.regions.find((x) => x.id === ${JSON.stringify(reg)}); window.__goNear(r.center.x, r.center.z); H.stepFrames(20); H.view(${JSON.stringify(v)});`);
        await shot(name);
      }
      await page.eval(`${H} const s = H.pkg.world.spawn_points.find((x) => x.id === "spawn_player"); H.teleport(s.position.x, s.position.z); H.stepFrames(2); H.view({ pitch: 0.32, dist: 8 });`);
    }
    const r = await page.eval(`${H} return window.__drive(80)`);
    const w = await page.eval(`${H} H.stepFrames(2); return { status: H.status(), hud: H.hud() }`);
    assert.equal(w.status, "won", `chain did not finish: ${JSON.stringify(r).slice(0, 600)}`);
    assert.equal(w.hud.overlay, "Victory");
    const lit = await page.eval(`${H} return H.pkg.world.interactables.filter((i) => ["lantern", "altar"].includes(i.kind)).map((i) => i.id).filter((id) => !!H.renderer.objects.placements.get(H.pkg.world.interactables.find((x) => x.id === id).placement_ref)?.lit)`);
    assert.ok(lit.length >= (flagship ? 4 : 1), `lit lights: ${lit}`);
    await shot(flagship ? "lanternfall-win" : "win");
    if (flagship) {
      // Stand well back from the lighthouse and look up at its lamp and beams.
      await page.eval(`${H} document.getElementById("overlay").hidden = true;
        const lh = H.pkg.world.placements.find((p) => /lighthouse/.test(p.asset_ref)), W = H.pkg.world, t = W.terrain;
        const cx = W.size.w / 2, cz = W.size.h / 2, l = Math.hypot(cx - lh.position.x, cz - lh.position.z) || 1;
        const fx = lh.position.x + (cx - lh.position.x) / l * 38, fz = lh.position.z + (cz - lh.position.z) / l * 38;
        const fy = Math.max(H.sim.deps.terrain.sampleHeight(t, fx, fz), lh.position.y) + 9;
        H.stepFrames(1);
        H.photo({ x: fx, y: fy, z: fz }, { x: lh.position.x, y: lh.position.y + 10, z: lh.position.z });`);
      await shot("lanternfall-lighthouse-lit");
      await page.eval(`${H} document.getElementById("overlay").hidden = false;`);
    }
  });

  test(`${label}: running out of time shows the defeat overlay; restart resets`, opts, async () => {
    const r = await page.eval(`${H}
      document.getElementById("btn-restart").click();
      H.stepFrames(2);
      const afterRestart = H.status();
      const gp = H.pkg.gameplay, limit = gp.rules.time_limit_s * ((gp.difficulty && gp.difficulty.time_mult) || 1);
      if (!limit) return { afterRestart, skipped: true };
      H.sim.game = { ...H.sim.game, t: limit - 0.2 };
      H.stepFrames(30);
      return { afterRestart, status: H.status(), hud: H.hud() };`);
    assert.equal(r.afterRestart, "playing");
    if (r.skipped) return;
    assert.equal(r.status, "lost");
    assert.equal(r.hud.overlay, "Defeat");
    if (flagship) await shot("lanternfall-defeat");
  });

  test(`${label}: frame-time budget (SwiftShader, CPU-rendered)`, opts, async () => {
    await page.eval(`${H} document.getElementById("btn-restart").click(); H.stepFrames(2); H.view({ pitch: 0.32, dist: 8 });`);
    // 300 SwiftShader frames can outlast one CDP call on a busy machine, so the
    // page times them on its own timers and the test polls for the result.
    const N = flagship ? 300 : 120;
    // Capped at 4 min of wall clock: on an overloaded host the sample shrinks (and is reported) rather than hanging.
    await page.eval(`${H} return H.startBenchmark(${N}, 240000)`);
    assert.ok(await page.waitFor("window.__DCS_GAMES_B__.benchmarkResult", { timeout: 6 * 60 * 1000, interval: 1000 }), "benchmark did not finish");
    const b = await page.eval(`${H} return H.benchmarkResult`);
    assert.ok(b.frames >= 20, `only ${b.frames} frames measured — host too loaded to say anything`);
    console.log(`# ${label} perf over ${b.frames}/${b.requested} frames: p50 ${b.frame_ms_p50.toFixed(1)} ms, p95 ${b.frame_ms_p95.toFixed(1)} ms (${b.fps.toFixed(1)} fps SwiftShader), ${b.draw_calls} draw calls, ${b.triangles} triangles, ${b.textures} textures, ${b.geometries} geometries`);
    if (flagship) fs.writeFileSync(path.join(EVIDENCE, "lanternfall-perf.json"), JSON.stringify({ renderer: "SwiftShader (headless Chrome, CPU)", ...b }, null, 2) + "\n");
    assert.ok(b.draw_calls > 0 && b.draw_calls < 600, `draw calls ${b.draw_calls}`);
    assert.ok(b.triangles > 0 && b.triangles < 1_500_000, `triangles ${b.triangles}`);
    assert.ok(b.frame_ms_p95 < 2000, `p95 frame ${b.frame_ms_p95} ms is unusable even for SwiftShader`);
    assert.deepEqual(await page.eval(`${H} return H.errors`), []);
    assert.deepEqual(page.realErrors(), []);
    assert.deepEqual(consoleErrors(page), []);
    await page.close();
  });
}

// No browser needed: the fixture the runtime is developed against must itself
// be a valid, winnable package, or runtime failures could be fixture bugs.
test("mini fixture is a valid package that the headless playtest wins", { skip: !have("src/gamesb/runtime/validate-package.mjs") || !have("src/gamesb/runtime/headless-playtest.mjs") ? "runtime gates missing" : false }, async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, MINI.slice(1)), "utf8"));
  const { validatePackage } = await import("../src/gamesb/runtime/validate-package.mjs");
  const { headlessPlaytest } = await import("../src/gamesb/runtime/headless-playtest.mjs");
  const v = await validatePackage(pkg);
  assert.deepEqual(v.errors, []);
  const p = await headlessPlaytest(pkg, {});
  assert.equal(p.won, true, JSON.stringify(p).slice(0, 400));
});

test("an invalid package shows the error screen, not a blank page", { skip }, async () => {
  const page = await Page.open(browser);
  try {
    await page.goto(`${site.url}/games-b-runtime/play.html?pkg=/games-b-runtime/runtime.css`, { waitMs: 1500 });
    const ok = await page.waitFor("!document.getElementById('error').hidden", { timeout: 10000 });
    assert.ok(ok, "error screen not shown");
    const t = await page.eval("return document.getElementById('error-title').textContent");
    assert.match(t, /could not load|invalid/i);
    await page.goto(`${site.url}/games-b-runtime/play.html?pkg=/nope/package.json`, { waitMs: 1000 });
    assert.ok(await page.waitFor("!document.getElementById('error').hidden", { timeout: 10000 }));
  } finally { await page.close(); }
});

test("mobile: touch joystick moves the player on a phone-sized screen, HUD fits", { skip }, async () => {
  const page = await Page.open(browser);
  try {
    await page.send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
    await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await open(page, MINI);
    const ui = await page.eval(`return { touch: document.body.classList.contains("touch"),
      stick: getComputedStyle(document.getElementById("touch-ui")).display !== "none",
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      w: window.innerWidth }`);
    assert.equal(ui.touch, true, "touch UI not enabled on a coarse pointer");
    assert.equal(ui.stick, true);
    assert.equal(ui.overflowX, false, "HUD overflows a phone screen");
    const before = await page.eval("return { ...window.__DCS_GAMES_B__.sim.player.position }");
    // Hold the left-hand stick pushed up (forward) for a while, in real time.
    const pt = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
    await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(160, 260) });
    for (let i = 1; i <= 6; i++) await page.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(160, 260 - i * 10) });
    await new Promise((r) => setTimeout(r, 2500));
    await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const after = await page.eval("return { ...window.__DCS_GAMES_B__.sim.player.position }");
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    assert.ok(moved > 0.5, `touch stick moved the player ${moved.toFixed(2)} m`);
    await page.screenshot(path.join(EVIDENCE, "mini-mobile.png"));
    assert.deepEqual(page.realErrors(), []);
  } finally { await page.close(); }
});

test("a published flagship bundle plays standalone from its own directory", { skip: flagSkip || (!have("src/gamesb/hooks/publish.mjs") ? "publish hook missing" : false) }, async () => {
  const { publishPackage } = await import("../src/gamesb/hooks/publish.mjs");
  const os = await import("node:os");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, FLAGSHIP.slice(1)), "utf8"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gamesb-publish-"));
  const { manifest } = await publishPackage(pkg, { outDir });
  for (const f of ["games-b-runtime/play.html", "games-b-runtime/main.mjs", "src/gamesb/runtime/sim-core.mjs", "src/gamesb/assets/texture-synth.mjs", "src/gamesb/world/terrain-sample.mjs"]) {
    assert.ok(manifest.files.some((x) => x.path === f), `published bundle lacks ${f}`);
  }
  const pub = await serveStatic(outDir);
  const page = await Page.open(browser);
  try {
    await page.goto(`${pub.url}/games-b-runtime/play.html?pkg=../package.json`, { waitMs: 300 });
    assert.ok(await page.waitFor("window.__DCS_GAMES_B__ && window.__DCS_GAMES_B__.ready", { timeout: 20000 }), "published bundle did not start");
    const s = await page.eval(`${H} return { mode: H.mode, errors: H.errors, notes: H.notes, tex: H.scene().textureStats }`);
    assert.equal(s.mode, "play");
    assert.deepEqual(s.notes, [], "every runtime module resolved inside the bundle");
    assert.equal(s.tex.fallback, 0, "textures came from texture-synth, not the fallback");
    assert.deepEqual(s.errors, []);
    assert.deepEqual(page.realErrors(), []);
    assert.deepEqual(page.responses.filter((r) => r.status >= 400).map((r) => r.url), []);
  } finally { await page.close(); await pub.close(); fs.rmSync(outDir, { recursive: true, force: true }); }
});

suite("mini fixture", MINI, skip);
suite("flagship Lanternfall", FLAGSHIP, flagSkip, { flagship: true });
