// Games-D browser bench. Node-side (drives a real Chrome over CDP).
//
// For each package: serve the worktree root (so play.html's ../src imports
// resolve exactly as deployed), open games-b-runtime/play.html?pkg=…, wait for
// the runtime hook, then measure:
//   load_ms     navigation start → window.__DCS_GAMES_B__.ready
//   fps         real requestAnimationFrame rendering for `fpsSeconds` while the
//               player walks forward on the keyboard (W held), timed in-page;
//               draw calls and triangles from H.stats() at the end
//   play        a short deterministic session via input()+stepFrames(), checked
//               for thrown errors
//   save_reload save → walk away → load (from localStorage) → position restored
//               and the re-taken snapshot equal to the original apart from saved_at
//   screenshot  docs/games-d/evidence/<game_id>.png, plus a 64-bin RGB histogram
//               of the same frame read back with gl.readPixels
// Console errors and page exceptions are collected. Two renderers:
//   gpu=false  SwiftShader (CPU), like test/gamesb-browser.test.mjs: the
//              advisory cpu_worst_case numbers
//   gpu=true   hardware GL (ANGLE/Metal on macOS): the numbers PERF_BUDGET gates
// Every result records the WebGL renderer string the page actually got.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { serveStatic, Page, findChrome } from "../../../test/helpers/browser.mjs";
import { isSoftwareRenderer } from "../budgets.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Background tabs throttle timers and rendering; the bench drives one tab at a time.
export const CHROME_ARGS = ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
const H = "const H = window.__DCS_GAMES_B__;";

export function browserAvailable() {
  return !!findChrome();
}

const IN_PAGE = `
${H}
window.__gdHist = function () {
  const gl = H.renderer.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const bins = new Array(64).fill(0);
  let n = 0;
  for (let i = 0; i < px.length; i += 4 * 7) {
    const r = px[i] >> 6, g = px[i + 1] >> 6, b = px[i + 2] >> 6;
    bins[r * 16 + g * 4 + b]++; n++;
  }
  return bins.map((c) => Math.round((c / (n || 1)) * 1000) / 1000);
};
// At least \`ms\` of wall clock AND \`minFrames\` frames, capped at \`maxMs\` (a CPU-rendered
// frame on a loaded host can take seconds; the cap keeps one CDP call under its timeout).
// Walk an open dialogue to its end the way a player skimming it would: a choice
// that ends the conversation, else one leading somewhere new (never loop).
window.__gdEndDialogue = function () {
  const seen = new Set();
  for (let g = 0; g < 24 && H.dialogue(); g++) {
    const d = H.dialogue();
    seen.add(d.node.id);
    let i = d.choices.findIndex((c) => !c.next);
    if (i < 0) i = d.choices.findIndex((c) => c.next && !seen.has(c.next));
    if (i < 0) i = 0;
    H.input({ choice: i }); H.stepFrames(3);
  }
  return !H.dialogue();
};
window.__gdRaf = function (ms, minFrames, maxMs) {
  return new Promise((resolve) => {
    const times = [];
    let last = null;
    const t0 = performance.now();
    function f(now) {
      if (last !== null) times.push(now - last);
      last = now;
      const el = now - t0;
      if (el < maxMs && (el < ms || times.length < minFrames)) requestAnimationFrame(f);
      else resolve(times);
    }
    requestAnimationFrame(f);
  });
};
`;

/** Failures of the measuring harness (CDP, a killed browser), not of the game. */
export function isHarnessError(e) {
  return /CDP timeout|fetch failed|WebSocket|ECONNREFUSED|socket hang up|Target closed|Session closed/i.test(String(e?.message || e));
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Bench one package in an open browser.
 * @param {{ url: string }} site     serveStatic() of ROOT
 * @param {object} browser           launchChrome() result
 * @param {{ game_id: string, pkgPath: string }} entry  pkgPath is the URL path under ROOT
 */
export async function benchPackage(site, browser, entry, { evidenceDir = path.join(ROOT, "docs/games-d/evidence"), fpsSeconds = 4, minFrames = 12, readyTimeout = 90000 } = {}) {
  const out = { game_id: entry.game_id, renderer: null, gpu: null, ok: false, load_ms: null, mode: null, fps: null, stats: null, play: null, save_reload: null, screenshot: null, screen_hist: null, errors: [], console_errors: [], reason: null };
  let page;
  try {
    page = await Page.open(browser);
    const t0 = Date.now();
    await page.goto(`${site.url}/games-b-runtime/play.html?pkg=${entry.pkgPath}`, { waitMs: 50 });
    const ready = await page.waitFor("window.__DCS_GAMES_B__ && window.__DCS_GAMES_B__.ready", { timeout: readyTimeout, interval: 100 });
    out.load_ms = Date.now() - t0;
    if (!ready) {
      const errs = await page.eval(`return (window.__DCS_GAMES_B__ && window.__DCS_GAMES_B__.errors) || []`).catch(() => []);
      out.reason = `runtime not ready within ${readyTimeout} ms`;
      out.errors.push(out.reason, ...errs, ...page.realErrors());
      return out;
    }
    await page.eval(IN_PAGE);
    out.mode = await page.eval(`${H} return H.mode`);
    out.renderer = await page.eval(`${H} const gl = H.renderer.renderer.getContext(); const x = gl.getExtension("WEBGL_debug_renderer_info");
      return String(x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));`).catch(() => null);
    out.gpu = !!out.renderer && !isSoftwareRenderer(out.renderer);
    if (out.mode !== "play") { out.reason = `runtime in ${out.mode} mode (a sim module failed to load)`; out.errors.push(out.reason); }

    // Screenshot + histogram from a consistent third-person view.
    await page.eval(`${H} H.stepFrames(2); H.view({ pitch: 0.42, dist: 16 });`);
    out.screen_hist = await page.eval(`${H} H.view({ pitch: 0.42, dist: 16 }); return window.__gdHist()`);
    // The loading card fades out (0.6 s CSS transition) after `ready`; wait so it is not in the picture.
    await page.waitFor(`(() => { const l = document.getElementById("loading"); return !l || l.hidden || getComputedStyle(l).display === "none" || Number(getComputedStyle(l).opacity) < 0.02; })()`, { timeout: 8000, interval: 100 });
    fs.mkdirSync(evidenceDir, { recursive: true });
    out.screenshot = await page.screenshot(path.join(evidenceDir, `${entry.game_id}.png`));

    // Real rAF rendering while the player walks (keyboard, so real-time stepping).
    const p0 = await page.eval(`${H} H.resume(); document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", key: "w", bubbles: true })); return { ...H.sim.player.position }`);
    const times = await page.eval(`return window.__gdRaf(${Math.round(fpsSeconds * 1000)}, ${minFrames}, 45000)`);
    const after = await page.eval(`${H} document.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", key: "w", bubbles: true })); return { pos: { ...H.sim.player.position }, stats: H.stats() }`);
    const wall = times.reduce((a, b) => a + b, 0);
    out.stats = after.stats;
    out.fps = {
      fps: wall ? r2((times.length / wall) * 1000) : 0,
      frame_ms_p50: r2(pct(times, 0.5)), frame_ms_p95: r2(pct(times, 0.95)), frames: times.length, seconds: r2(wall / 1000),
      draw_calls: after.stats?.draw_calls ?? null, triangles: after.stats?.triangles ?? null,
      textures: after.stats?.textures ?? null, geometries: after.stats?.geometries ?? null,
      walked_m: r2(Math.hypot(after.pos.x - p0.x, after.pos.z - p0.z)),
    };

    // Brief deterministic play: walk a square, pressing interact at each corner.
    // One CDP call per leg: a CPU-rendered frame on a loaded host can take
    // seconds, and a single long evaluate would hit the 60 s CDP timeout.
    const errs0 = await page.eval(`${H} return H.errors.length`);
    out.play = { steps: 0, threw: null, status: null, new_errors: [] };
    for (const [x, z] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const leg = await page.eval(`${H}
        let steps = 0;
        try {
          H.input({ move: { x: ${x}, z: ${z} }, run: true }); H.stepFrames(90); steps += 90;
          H.input({ move: { x: 0, z: 0 }, interact: true }); H.stepFrames(3); steps += 3;
          window.__gdEndDialogue(); steps += 3;
          return { steps, threw: null };
        } catch (e) { return { steps, threw: String(e && e.message || e) }; }`);
      out.play.steps += leg.steps;
      if (leg.threw) { out.play.threw = leg.threw; break; }
    }
    Object.assign(out.play, await page.eval(`${H} return { status: H.status(), new_errors: H.errors.slice(${errs0}) }`));
    if (out.play.threw) out.errors.push(`play: ${out.play.threw}`);
    for (const e of out.play.new_errors || []) out.errors.push(`play: ${e}`);

    // Save → walk away → load (from localStorage) → restored.
    out.save_reload = await (async () => {
      try {
        const s = await page.eval(`${H}
          if (H.status() !== "playing") { document.getElementById("btn-restart")?.click(); H.stepFrames(2); }
          window.__gdEndDialogue();
          H.input({ move: { x: 0, z: 0 } }); H.stepFrames(2);
          window.__gdSave = H.save(); return window.__gdSave;`);
        // Walk away; try other directions if the first is blocked.
        let moved_m = 0, blocked = "";
        for (const [x, z] of [[0.7071, 0.7071], [-0.7071, -0.7071], [0.7071, -0.7071], [-0.7071, 0.7071]]) {
          const p = await page.eval(`${H} H.input({ move: { x: ${x}, z: ${z} }, run: true }); H.stepFrames(90); H.input({ move: { x: 0, z: 0 } }); H.stepFrames(2);
            return { ...H.sim.player.position, status: H.status(), dialogue: !!H.dialogue() }`);
          moved_m = Math.hypot(p.x - s.player.position.x, p.z - s.player.position.z);
          blocked = `status ${p.status}, dialogue ${p.dialogue}`;
          if (moved_m > 0.5) break;
        }
        const r = await page.eval(`${H}
          const s = window.__gdSave;
          H.load();
          const back = { ...H.sim.player.position };
          const s2 = H.save();
          const strip = (x) => JSON.stringify({ ...x, saved_at: 0 });
          let diff = null;
          if (strip(s) !== strip(s2)) diff = Object.keys(s).filter((k) => k !== "saved_at" && JSON.stringify(s[k]) !== JSON.stringify(s2[k]));
          return { err_m: Math.hypot(back.x - s.player.position.x, back.z - s.player.position.z), same: !diff, diff };`);
        const ok = r.err_m < 0.25 && r.same && moved_m > 0.5;
        return {
          ok, moved_m: r2(moved_m), restore_err_m: Math.round(r.err_m * 1000) / 1000, snapshot_equal: r.same,
          reason: ok ? null : !(moved_m > 0.5) ? `player moved only ${r2(moved_m)} m between save and load (${blocked})`
            : !r.same ? `re-saved snapshot differs from the original in ${r.diff.join(", ")}` : `position not restored (${r2(r.err_m)} m off)`,
        };
      } catch (e) {
        if (isHarnessError(e)) throw e;
        return { ok: false, reason: String(e.message || e) };
      }
    })();

    out.audio = await page.eval(`${H} return H.audio ? { present: true, keys: Object.keys(H.audio).slice(0, 12) } : { present: false }`).catch(() => null);
    const hookErrors = await page.eval(`${H} return H.errors.slice()`);
    for (const e of hookErrors) if (!out.errors.includes(`play: ${e}`)) out.errors.push(e);
    out.errors.push(...page.realErrors());
    out.console_errors = page.consoleLogs.filter((l) => l.type === "error" && !/favicon/i.test(l.text)).map((l) => l.text.slice(0, 300));
    out.errors.push(...out.console_errors.map((t) => `console: ${t}`));
    out.ok = out.mode === "play" && out.errors.length === 0;
    if (!out.ok && !out.reason) out.reason = out.errors[0] || "unknown";
  } catch (e) {
    out.reason = `bench threw: ${e.message}`;
    out.errors.push(out.reason);
    out.harness_error = isHarnessError(e);
  } finally {
    await page?.close();
  }
  return out;
}

/**
 * Launch Chrome for the bench with its own profile prefix.
 *
 * helpers/browser.mjs reaps every `dcs-chrome-*` Chrome older than two minutes
 * whenever anyone launches one, and on a loaded host a single package takes
 * longer than that, so concurrent test runs were killing the bench mid-package
 * ("fetch failed"). This launcher is launchChrome() with a `gamesd-bench-chrome-`
 * profile; it reaps its OWN leftovers older than 20 minutes, so a bench killed
 * hard still cannot leak browsers.
 */
export async function launchBenchChrome({ extraArgs = CHROME_ARGS, gpu = false } = {}) {
  const { spawn, execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  const bin = findChrome();
  if (!bin) throw new Error("no Chrome binary found");
  try {
    const ps = execFileSync("ps", ["-eo", "pid=,etime=,args="], { encoding: "utf8", maxBuffer: 1 << 24 });
    for (const line of ps.split("\n")) {
      if (!line.includes("--user-data-dir=") || !line.includes("gamesd-bench-chrome-")) continue;
      const m = /^\s*(\d+)\s+(\S+)/.exec(line);
      if (!m) continue;
      const parts = m[2].split(/[-:]/).map(Number);
      const secs = parts.length >= 4 ? 86400 * parts[0] + 3600 * parts[1] + 60 * parts[2] + parts[3] : parts.length === 3 ? 3600 * parts[0] + 60 * parts[1] + parts[2] : 60 * parts[0] + parts[1];
      if (secs > 1200) try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* gone */ }
    }
  } catch { /* no ps */ }
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "gamesd-bench-chrome-"));
  const args = [
    "--remote-debugging-port=0", `--user-data-dir=${userDir}`, "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-sync", "--disable-features=Translate,MediaRouter",
    "--window-size=1280,900", "--headless=new",
    // CPU: SwiftShader, as test/gamesb-browser.test.mjs. GPU: hardware GL through ANGLE's
    // Metal backend on macOS (the page records the renderer string, so a silent
    // fallback to SwiftShader is caught rather than reported as GPU numbers).
    ...(gpu ? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] : ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu"]),
    ...extraArgs, "about:blank",
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const bury = () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } };
  process.once("exit", bury);
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const to = setTimeout(() => reject(new Error("chrome did not report a devtools endpoint")), 60000);
    proc.stderr.on("data", (d) => { buf += d.toString(); const m = /ws:\/\/[^\s]+/.exec(buf); if (m) { clearTimeout(to); resolve(m[0]); } });
    proc.on("exit", (c) => { clearTimeout(to); reject(new Error("chrome exited " + c)); });
  });
  const close = async () => {
    bury();
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
    process.removeListener("exit", bury);
  };
  return { proc, wsUrl, close, kill: close };
}

/**
 * Bench several packages, a fresh Chrome every `perBrowser` packages. A package
 * whose run failed in the harness (CDP timeout, browser gone) is retried once
 * in a fresh browser; `attempts` records it.
 * @param {{ game_id, pkgPath }[]} entries
 * @returns {Promise<{ available: boolean, reason?: string, results: Object<string, object> }>}
 */
export async function benchPackages(entries, { gpu = false, perBrowser = 1, fpsSeconds = 4, minFrames = 12, evidenceDir, log = () => {}, root = ROOT } = {}) {
  if (!findChrome()) return { available: false, reason: "no Chrome binary (set DCS_CHROME)", results: {} };
  const site = await serveStatic(root);
  const results = {};
  let browser = null;
  try {
    for (let i = 0; i < entries.length; i++) {
      if (i % perBrowser === 0) { await browser?.close(); browser = await launchBenchChrome({ gpu }); }
      const e = entries[i];
      const t0 = Date.now();
      let r = await benchPackage(site, browser, e, { fpsSeconds, minFrames, evidenceDir });
      r.attempts = 1;
      if (!r.ok && r.harness_error) {
        if (gpu && r.renderer && !r.gpu) r.gpu_note = `GPU requested but the page got a software renderer (${r.renderer})`;
      log(`browser${gpu ? " gpu" : " cpu"} ${e.game_id} [${r.renderer || "?"}]: harness error (${r.reason}); retrying in a fresh browser`);
        await browser?.close(); browser = await launchBenchChrome({ gpu });
        const first = r.reason;
        r = await benchPackage(site, browser, e, { fpsSeconds, minFrames, evidenceDir });
        r.attempts = 2; r.first_attempt_reason = first;
      }
      results[e.game_id] = r;
      if (gpu && r.renderer && !r.gpu) r.gpu_note = `GPU requested but the page got a software renderer (${r.renderer})`;
      log(`browser${gpu ? " gpu" : " cpu"} ${e.game_id} [${r.renderer || "?"}]: ${r.ok ? "ok" : "FAIL " + r.reason} load ${r.load_ms} ms, ${r.fps?.fps ?? "-"} fps (p95 ${r.fps?.frame_ms_p95 ?? "-"} ms), save/load ${r.save_reload?.ok}, ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  } finally {
    await browser?.close();
    await site.close();
  }
  return { available: true, results };
}
