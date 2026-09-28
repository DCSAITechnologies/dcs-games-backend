// Games-B runtime entry (contract §10). Browser-only.
//
// Boot order: fetch the package → load the isomorphic modules → build the scene →
// create the sim → run. The sim steps at a fixed 1/60 s from an accumulator, so
// game logic is identical at 30 fps, 144 fps and in the headless playtest; the
// renderer only ever reads the sim.
//
// If sim-core (or one of its deps) cannot load, the page still renders the world
// in a view-only mode with a free camera and says so — a broken rules module
// should cost a player the game, not the ability to see what was generated.
/* global THREE */

import { createRenderer } from "./renderer.mjs";
import { createControls } from "./controls.mjs";
import { createHud, progress, hideLoading, showError } from "./hud.mjs";

const SIM_DT = 1 / 60;
const HOOK = (window.__DCS_GAMES_B__ = Object.assign(window.__DCS_GAMES_B__ || {}, { ready: false, errors: window.__DCS_GAMES_B__?.errors || [] }));
const params = new URLSearchParams(location.search);
const pkgUrl = new URL(params.get("pkg") || "./games/lanternfall/package.json", location.href).href;
const quality = params.get("quality") || (/SwiftShader/i.test(glRendererName()) ? "low" : "high");

function glRendererName() {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
  } catch { return ""; }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** localStorage, or null when the page may not use it. */
function safeStorage() { try { const s = window.localStorage; s.getItem("x"); return s; } catch { return null; } }

/** Stand-in when there is no pkg.audio or the audio module failed: every call is a no-op. */
function inertAudio(reason) {
  const nop = () => false;
  const state = { present: false, available: false, reason, started: false, muted: false, enabled: false, cues_played: 0, cues_sounded: 0, emitter_plays: 0, cue_counts: {}, last_cue: null, errors: [], start: nop, setMuted: nop, toggleMute: nop, cue: nop };
  return { state, start: nop, setMuted: nop, toggleMute: nop, cue: nop, onEvents: () => {}, step: () => {}, reset: () => {}, dispose: () => {} };
}

// Each import is a literal import("…") so the publisher's import-closure scan
// (hooks/publish.mjs) sees it and ships the module with the game.
async function tryImport(load) {
  try { return await load(); } catch (e) { return { __error: e }; }
}

/** Shape checks that keep a wrong URL or a half-written package from reaching three.js. */
function checkPackage(pkg) {
  const errs = [];
  if (!pkg || typeof pkg !== "object") return ["not a JSON object"];
  if (pkg.package_version !== "1.0.0") errs.push(`package_version is ${JSON.stringify(pkg.package_version)}, expected "1.0.0"`);
  const w = pkg.world, t = w?.terrain;
  if (!w?.size?.w || !w?.size?.h) errs.push("world.size missing");
  if (!t || !Array.isArray(t.heights) || t.heights.length !== t.cols * t.rows) errs.push("world.terrain.heights must hold cols*rows values");
  if (!Array.isArray(pkg.assets?.records)) errs.push("assets.records missing");
  return errs;
}

async function boot() {
  progress(0.02, "Fetching the game package");
  let pkg;
  try {
    const res = await fetch(pkgUrl, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${pkgUrl}`);
    pkg = await res.json();
  } catch (e) {
    return showError("Could not load the game", `${e.message}. Pass ?pkg=<url of a package.json>.`);
  }
  const bad = checkPackage(pkg);
  if (bad.length) return showError("This game package is invalid", bad.join("\n"));
  HOOK.pkg = pkg;
  document.title = `${pkg.title || "Game"} — DCS Games`;

  progress(0.06, "Loading the engine");
  if (typeof THREE === "undefined") return showError("Three.js did not load", "The 3D engine is fetched from cdnjs; check the network.");
  const [simMod, depsMod, texMod, terrMod] = await Promise.all([
    tryImport(() => import("../src/gamesb/runtime/sim-core.mjs")),
    tryImport(() => import("../src/gamesb/runtime/deps.mjs")),
    tryImport(() => import("../src/gamesb/assets/texture-synth.mjs")),
    tryImport(() => import("../src/gamesb/world/terrain-sample.mjs")),
  ]);
  const notes = [];
  for (const [name, m] of [["sim-core", simMod], ["deps", depsMod], ["texture-synth", texMod], ["terrain-sample", terrMod]]) {
    if (m.__error) notes.push(`${name}: ${m.__error.message}`);
  }
  const mods = {
    synthesizeTexture: texMod.synthesizeTexture || null,
    sampleHeight: terrMod.sampleHeight || null,
    expandScatter: terrMod.expandScatter || depsMod.realDeps?.expandScatter || null,
  };

  const canvas = document.getElementById("scene");
  let R;
  try {
    R = await createRenderer({
      canvas, pkg, mods, baseUrl: pkgUrl, quality,
      onProgress: async (f, label) => { progress(0.1 + f * 0.85, label); await tick(); },
      warn: (m) => { if (!HOOK.warnings) HOOK.warnings = []; if (HOOK.warnings.length < 200) HOOK.warnings.push(m); },
    });
  } catch (e) {
    console.error(e);
    return showError("The world failed to build", e.message);
  }
  HOOK.renderer = R;

  // ---- simulation ---------------------------------------------------------------
  const haveSim = !simMod.__error && !depsMod.__error && typeof simMod.createSim === "function";
  const S = haveSim ? simMod : null;
  const deps = depsMod.realDeps;
  let sim = null;
  let mode = "view-only";
  const lit = new Set();
  if (S) {
    try { sim = S.createSim(pkg, deps); mode = "play"; } catch (e) { notes.push(`createSim: ${e.message}`); HOOK.errors.push(`createSim: ${e.message}`); }
  }
  const setSim = (s) => {
    sim = s;
    R.setColliders(s?.colliders || []);
    lit.clear();
    deriveLit();
  };
  const ixById = new Map((pkg.world.interactables || []).map((i) => [i.id, i]));
  const LIGHTABLE = new Set(["lantern", "altar", "portal", "switch", "lever"]);
  // A light is lit once an objective that targets it is done — which survives a
  // save/load — or once an interact event on it has been seen this session.
  function deriveLit() {
    if (!sim) return;
    for (const o of pkg.gameplay?.objectives || []) {
      if (sim.game.objectives?.[o.id] === "done" && ixById.has(o.target_ref) && LIGHTABLE.has(ixById.get(o.target_ref).kind)) lit.add(o.target_ref);
    }
  }
  setSim(sim);

  // ---- audio (optional pkg.audio; procedural WebAudio, no files) -----------------
  // Loaded only when the package asks for it, started on the first user gesture
  // (autoplay policy), and never allowed to break the game: any failure leaves
  // an inert controller whose state says why.
  let audio = inertAudio(pkg.audio ? "audio module not loaded" : "no audio in package");
  if (pkg.audio) {
    const audioMod = await tryImport(() => import("./audio.mjs"));
    if (audioMod.__error) notes.push(`audio: ${audioMod.__error.message}`);
    else {
      try { audio = audioMod.createAudio(pkg.audio, { win: window, storage: safeStorage() }); } catch (e) { notes.push(`audio: ${e.message}`); }
    }
  }
  HOOK.audio = audio.state;
  const muteBtn = document.getElementById("btn-mute");
  const syncMute = () => {
    if (!muteBtn) return;
    muteBtn.classList.toggle("off", !!audio.state.muted);
    muteBtn.setAttribute("aria-pressed", audio.state.muted ? "true" : "false");
    muteBtn.title = audio.state.muted ? "Sound off (M)" : "Sound on (M)";
  };
  if (audio.state.present) {
    const gestures = ["pointerdown", "keydown", "touchstart"];
    const onGesture = () => {
      try { audio.start(); } catch (e) { notes.push(`audio start: ${e.message}`); }
      if (audio.state.started || !audio.state.available) for (const g of gestures) window.removeEventListener(g, onGesture, true);
    };
    for (const g of gestures) window.addEventListener(g, onGesture, { capture: true, passive: true });
    if (muteBtn) {
      muteBtn.hidden = false;
      muteBtn.addEventListener("click", () => { audio.toggleMute(); syncMute(); });
      syncMute();
    }
  }

  // ---- UI -------------------------------------------------------------------
  const SAVE_KEY = `dcs-gamesb:${pkg.game_id}:save`;
  const hud = createHud({
    pkg, lib: R.lib,
    onChoice: (i) => { pending.choice = i; },
    onRestart: () => restart(),
    onSave: () => { try { HOOK.save(); hud.toast("Game saved"); } catch (e) { hud.toast(`Save failed: ${e.message}`, "bad"); } },
    onLoad: () => { try { HOOK.load(); hud.toast("Game loaded"); } catch (e) { hud.toast(`Load failed: ${e.message}`, "bad"); } },
    onDownload: () => {
      if (!sim) return;
      const blob = new Blob([JSON.stringify(S.snapshot(sim), null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${pkg.game_id}-save.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    onImport: (save) => { HOOK.load(save); hud.toast("Save imported"); },
  });
  const controls = createControls({
    canvas, cam: R.cam,
    onKey: (code) => {
      if (code === "F3") hud.toggleDebug();
      if (code === "F5") { try { HOOK.save(); hud.toast("Game saved"); } catch (e) { hud.toast(`Save failed: ${e.message}`, "bad"); } }
      if (code === "F9") { try { HOOK.load(); hud.toast("Game loaded"); } catch (e) { hud.toast(`Load failed: ${e.message}`, "bad"); } }
      if (code === "KeyH") document.getElementById("help")?.toggleAttribute("hidden");
      if (code === "KeyM" && audio.state.present) { audio.toggleMute(); syncMute(); hud.toast(audio.state.muted ? "Sound off" : "Sound on"); }
    },
  });
  if (!sim) {
    document.body.classList.add("view-only");
    hud.toast(`View-only mode: ${notes[0] || "no simulation"}`, "bad");
    const sp = (pkg.world.spawn_points || []).find((s) => s.kind === "player") || { position: { x: pkg.world.size.w / 2, z: pkg.world.size.h / 2 } };
    R.cam.pos.set(sp.position.x, R.heightAt(sp.position.x, sp.position.z) + 12, sp.position.z + 20);
    R.cam.pitch = 0.3;
    R.cam.yaw = 0;
  }

  // ---- input plumbing --------------------------------------------------------
  // Hook inputs are presses (interact, jump, choice) or holds (move, run). A press
  // must reach sim-core as a rising edge, so if the sim's latch is still down
  // from a previous press we first feed one released step.
  const pending = { interact: false, jump: false, choice: null };
  let hookHold = { move: { x: 0, z: 0 }, run: false };
  let manual = false;

  function worldMove(wish) {
    const yaw = R.cam.yaw;
    // Camera looks along -(sin yaw, cos yaw); right is (cos yaw, -sin yaw).
    let x = -Math.sin(yaw) * wish.forward + Math.cos(yaw) * wish.right;
    let z = -Math.cos(yaw) * wish.forward - Math.sin(yaw) * wish.right;
    const l = Math.hypot(x, z);
    if (l > 1) { x /= l; z /= l; }
    return { x, z };
  }

  function buildInput() {
    const input = { move: { x: 0, z: 0 }, run: false, jump: false, interact: false };
    if (manual) {
      input.move = { ...hookHold.move };
      input.run = !!hookHold.run;
    } else {
      const w = controls.wish();
      input.move = worldMove(w);
      input.run = w.run; input.jump = w.jump; input.interact = w.interact;
      const c = controls.takeChoice();
      if (c !== null) pending.choice = c;
    }
    for (const k of ["interact", "jump"]) {
      if (pending[k]) {
        if (sim.latch?.[k]) input[k] = false;
        else { input[k] = true; pending[k] = false; }
      }
    }
    if (pending.choice !== null && sim.activeDialogue) { input.choice = pending.choice; pending.choice = null; }
    else if (pending.choice !== null && !sim.activeDialogue) pending.choice = null;
    return input;
  }

  function stepOnce() {
    if (!sim) return;
    const input = buildInput();
    let r;
    try { r = S.stepSim(sim, input, SIM_DT); } catch (e) {
      HOOK.errors.push(`stepSim: ${e.message}`);
      console.error(e);
      return;
    }
    audio.onEvents(r.events, sim.t);
    audio.step(sim, SIM_DT);
    for (const ev of r.events || []) {
      if (ev.kind === "interact" && LIGHTABLE.has(ixById.get(ev.ref)?.kind)) lit.add(ev.ref);
      if (ev.kind === "objective_done") {
        const o = (pkg.gameplay?.objectives || []).find((x) => x.id === ev.ref);
        if (o) hud.toast(`✓ ${o.title}`, "good");
        deriveLit();
      }
    }
  }

  // ---- view for the renderer / HUD ------------------------------------------------
  function objectiveTarget() {
    if (!sim) return null;
    for (const o of pkg.gameplay?.objectives || []) {
      if (sim.game.objectives?.[o.id] !== "active" || o.optional) continue;
      const ref = o.target_ref;
      const region = (pkg.world.regions || []).find((r) => r.id === ref);
      if (region) return region.center;
      const ix = ixById.get(ref);
      if (ix) { const p = S.interactablePosition ? S.interactablePosition(sim, ix) : null; if (p) return p; }
      if (sim.npcs[ref]) return sim.npcs[ref].position;
      const pick = (pkg.world.interactables || []).find((i) => i.item_ref === ref && !sim.collected.includes(i.id));
      if (pick) { const p = S.interactablePosition?.(sim, pick); if (p) return p; }
    }
    return null;
  }
  function questMarkers() {
    const out = new Set();
    if (!sim) return out;
    for (const o of pkg.gameplay?.objectives || []) {
      if (sim.game.objectives?.[o.id] === "active" && (o.kind === "talk" || o.kind === "deliver") && sim.npcs[o.target_ref]) out.add(o.target_ref);
    }
    return out;
  }

  let lastFrame = { view: null };
  function makeView(freeWish) {
    if (!sim) return { freeWish, npcs: {}, collected: new Set(), lit, defeated: new Set() };
    const near = S.nearestInteractable(sim);
    let nearestPos = null;
    if (near && S.interactablePosition) nearestPos = S.interactablePosition(sim, ixById.get(near.id));
    return {
      player: sim.player, npcs: sim.npcs, collected: new Set(sim.collected), lit, defeated: new Set(sim.defeated || []), weather: sim.game.weather,
      nearest: near, nearestPos, objectiveTarget: objectiveTarget(), questMarkers: questMarkers(),
    };
  }

  // ---- frame timing ----------------------------------------------------------
  const frameMs = [];
  const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  function stats() {
    const recent = frameMs.slice(-300);
    const p50 = pct(recent, 0.5);
    return { fps: p50 ? 1000 / p50 : 0, frame_ms_p50: p50, frame_ms_p95: pct(recent, 0.95), frames: recent.length, ...R.stats() };
  }

  function renderFrame(dt) {
    const view = makeView(sim ? null : controls.wish());
    R.update(dt, view);
    R.render();
    lastFrame = { view };
    const cd = sim && S.currentDialogue ? S.currentDialogue(sim) : null;
    hud.update({
      game: sim?.game, status: sim ? sim.status : "view-only", player: sim?.player, npcs: sim?.npcs, defeated: view.defeated,
      nearest: view.nearest, dialogue: cd, camYaw: R.cam.yaw, objectiveTarget: view.objectiveTarget, t: sim?.t,
      stats: frameMs.length % 15 === 0 ? stats() : null, mode, modulesNote: notes.join("; "),
    });
  }

  // ---- main loop ------------------------------------------------------------
  let acc = 0, last = performance.now(), benchmarking = false;
  function frame(now) {
    const raw = now - last;
    last = now;
    frameMs.push(raw);
    if (frameMs.length > 600) frameMs.splice(0, frameMs.length - 600);
    const dt = Math.min(0.1, raw / 1000);
    if (sim && !manual) {
      acc += dt;
      let n = 0;
      while (acc >= SIM_DT && n < 6) { stepOnce(); acc -= SIM_DT; n++; }
      if (n === 6) acc = 0;   // a long stall: drop time rather than spiral
    }
    // While a benchmark runs it owns rendering; a second render per frame would double its numbers.
    if (!benchmarking) { try { renderFrame(dt); } catch (e) { HOOK.errors.push(`render: ${e.message}`); console.error(e); } }
    requestAnimationFrame(frame);
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    R.resize(w, h);
  }
  window.addEventListener("resize", resize);
  resize();

  function restart() {
    if (!S) return;
    setSim(S.createSim(pkg, deps));
    audio.reset(sim?.status || "playing");
    hud.reset();
    R.cam.initialised = false;
  }

  // ---- test hook (§10) ---------------------------------------------------------------
  Object.assign(HOOK, {
    pkg, mode,
    status: () => (sim ? sim.status : "view-only"),
    /** Hold move/run (world-space, as sim-core takes them); press interact/jump/choice. Switches to manual stepping. */
    input(partial = {}) {
      manual = true;
      if (partial.move) hookHold.move = { x: +partial.move.x || 0, z: +partial.move.z || 0 };
      if ("run" in partial) hookHold.run = !!partial.run;
      if (partial.interact) pending.interact = true;
      if (partial.jump) pending.jump = true;
      if (Number.isInteger(partial.choice)) pending.choice = partial.choice;
      if (partial.clear) { hookHold = { move: { x: 0, z: 0 }, run: false }; }
    },
    /** Advance exactly n fixed steps, then render one frame. Deterministic; rAF no longer steps the sim. */
    stepFrames(n = 1) {
      manual = true;
      for (let i = 0; i < n; i++) stepOnce();
      renderFrame(Math.min(1, n * SIM_DT));
      return sim ? { t: sim.t, status: sim.status, position: { ...sim.player.position } } : null;
    },
    /** Hand the sim back to real time and the keyboard. */
    resume() { manual = false; hookHold = { move: { x: 0, z: 0 }, run: false }; },
    teleport(x, z) {
      if (!sim) { R.cam.pos.set(x, R.heightAt(x, z) + 10, z + 15); return null; }
      S.teleport(sim, x, z);
      R.cam.initialised = false;
      return { ...sim.player.position };
    },
    save() {
      if (!sim) throw new Error("no simulation (view-only mode)");
      const s = S.snapshot(sim);
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch (e) { HOOK.errors.push(`localStorage: ${e.message}`); }
      return s;
    },
    load(save) {
      if (!S) throw new Error("no simulation (view-only mode)");
      const s = save || JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
      if (!s) throw new Error("no saved game");
      setSim(S.restoreSim(pkg, s, deps));
      audio.reset(sim?.status || "playing");
      hud.reset();
      hud.skipMessages((sim.game.messages || []).length);
      R.cam.initialised = false;
      return { t: sim.t, position: { ...sim.player.position } };
    },
    stats,
    /** Render n frames synchronously and time each one with a GPU sync — for benchmarks where rAF is throttled. */
    benchmark(n = 60) {
      const gl = R.renderer.getContext();
      const px = new Uint8Array(4);
      const times = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        renderFrame(1 / 60);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        times.push(performance.now() - t0);
      }
      frameMs.push(...times);
      HOOK.lastBenchmark = times;
      return { frames: n, frame_ms_p50: pct(times, 0.5), frame_ms_p95: pct(times, 0.95), fps: 1000 / pct(times, 0.5), ...R.stats() };
    },
    /**
     * The same measurement spread over timers, so a slow (CPU-rendered) machine
     * never holds one call open for minutes. Poll `benchmarkResult`.
     */
    startBenchmark(n = 300, maxMs = Infinity) {
      HOOK.benchmarkResult = null;
      benchmarking = true;
      const times = [];
      const t0 = performance.now();
      // MessageChannel, not setTimeout: a background tab clamps chained timers
      // (to once a minute after a while), which would stall the measurement.
      const ch = new MessageChannel();
      const next = () => ch.port2.postMessage(0);
      ch.port1.onmessage = () => step();
      const step = () => {
        const r = HOOK.benchmark(1);
        times.push(r.frame_ms_p50);
        // Stop at n frames, or at the wall-clock cap with however many were measured.
        if (times.length < n && performance.now() - t0 < maxMs) { next(); return; }
        HOOK.lastBenchmark = times;
        benchmarking = false;
        HOOK.benchmarkResult = { ...r, frames: times.length, requested: n, frame_ms_p50: pct(times, 0.5), frame_ms_p95: pct(times, 0.95), fps: 1000 / pct(times, 0.5) };
      };
      next();
      return true;
    },
    /** Point the camera (orbit angles in radians, distance in metres) — used for screenshots. */
    view({ yaw, pitch, dist } = {}) {
      if (Number.isFinite(yaw)) R.cam.yaw = yaw;
      if (Number.isFinite(pitch)) R.cam.pitch = pitch;
      if (Number.isFinite(dist)) R.cam.dist = dist;
      R.cam.fixed = null;
      R.cam.initialised = false;
      renderFrame(0.016);
    },
    /** A fixed camera (world points {x,y,z}) until the next view() — for framed screenshots. */
    photo(from, at) { R.cam.fixed = { from, at }; renderFrame(0.016); },
    camera: () => ({ x: R.camera.position.x, y: R.camera.position.y, z: R.camera.position.z, yaw: R.cam.yaw, pitch: R.cam.pitch }),
    scene: () => ({
      terrain: !!R.objects.terrain?.parent, water: !!R.objects.water?.parent, sky: !!R.objects.sky?.parent,
      characters: R.objects.chars.size, placements: R.objects.placements.size, ...R.info,
    }),
    placementVisible: (id) => R.objects.placements.get(id)?.obj.visible ?? null,
    dialogue: () => (sim && S.currentDialogue ? S.currentDialogue(sim) : null),
    nearest: () => (sim ? S.nearestInteractable(sim) : null),
    hud: () => ({
      prompt: document.getElementById("prompt")?.hidden ? null : document.getElementById("prompt")?.textContent,
      dialogue: !document.getElementById("dialogue")?.hidden,
      overlay: document.getElementById("overlay")?.hidden ? null : document.getElementById("overlay-title")?.textContent,
      inventory: document.querySelectorAll("#inventory .slot").length,
      objectives: [...document.querySelectorAll("#objective-list li b")].map((b) => b.textContent),
    }),
    notes,
  });
  Object.defineProperty(HOOK, "sim", { get: () => sim, configurable: true, enumerable: true });

  renderFrame(0.016);
  hideLoading();
  HOOK.ready = true;
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(frame); });
  setTimeout(() => document.getElementById("help")?.setAttribute("hidden", ""), 12000);
}

boot().catch((e) => {
  HOOK.errors.push(`boot: ${e.message}`);
  console.error(e);
  showError("Something went wrong while starting the game", e.message);
});
