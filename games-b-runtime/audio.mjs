// Games-B runtime audio: procedural WebAudio from the optional pkg.audio
// AudioSpec (src/gamesd/audio/sfx.mjs describes the shape). Browser-only; no
// audio files. Every sound is synthesised from oscillators and seeded noise.
//
// Rules this module keeps:
//   * It never throws and never blocks. No WebAudio (old browser, locked-down
//     headless Chrome) → every call is a no-op and state says why.
//   * Nothing sounds before a user gesture (autoplay policy): main.mjs calls
//     start() from the first pointerdown/keydown/touchstart.
//   * No pkg.audio → createAudio returns an inert controller.
//   * Noise buffers and emitter jitter come from the seeded rng, so two runs
//     schedule the same sounds.
//
// createAudio(spec, { win, storage }) → { state, start, setMuted, toggleMute, cue, onEvents, step, dispose }
// `state` is live and is what main.mjs exposes as window.__DCS_GAMES_B__.audio.

import { rng } from "../src/gamesb/common/rng.mjs";

const EVENT_CUE = { pickup: "pickup", objective_done: "objective_done", locked: "locked", talk: "dialogue_open" };
const MUTE_KEY = "dcs-gamesb:audio-muted";

export function createAudio(spec, { win = typeof window !== "undefined" ? window : {}, storage = null } = {}) {
  const present = !!(spec && typeof spec === "object" && spec.cues && spec.ambience);
  const AC = present ? (win.AudioContext || win.webkitAudioContext || null) : null;
  let muted = false;
  try { muted = storage?.getItem?.(MUTE_KEY) === "1"; } catch { /* storage blocked */ }

  const state = {
    present,
    available: !!AC,
    reason: !present ? "no audio in package" : !AC ? "WebAudio unavailable" : null,
    started: false,
    muted,
    enabled: false,
    context_state: null,
    preset: present ? spec.preset || null : null,
    layers: present && Array.isArray(spec.ambience.layers) ? spec.ambience.layers.length : 0,
    emitters: present && Array.isArray(spec.emitters) ? spec.emitters.length : 0,
    cues_played: 0,        // cue events handled (counted even before start / while muted)
    cues_sounded: 0,       // cues actually scheduled into WebAudio
    emitter_plays: 0,
    cue_counts: {},
    last_cue: null,
    errors: [],
  };
  const refresh = () => {
    state.enabled = state.present && state.available && state.started && !state.muted;
    state.context_state = ctx ? ctx.state : null;
  };
  const fail = (where, e) => { if (state.errors.length < 20) state.errors.push(`${where}: ${e?.message || e}`); };

  let ctx = null, master = null, cueBus = null, ambBus = null;
  const noise = {};
  const crackles = [];
  const r = rng(((spec?.seed ?? 1) >>> 0) || 1);
  const emitTimers = new Map();
  let stride = 0;
  let lastStatus = "playing";
  const lastAt = {};                 // cue → sim time it last fired from an event (cooldowns)
  const COOLDOWN = { damage: 0.35, locked: 0.6, interact: 0.15 };

  // ---------------------------------------------------------------- graph
  function noiseBuffer(kind) {
    if (noise[kind]) return noise[kind];
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = r() * 2 - 1;
      if (kind === "pink") {             // Paul Kellet's economy pink filter
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      } else if (kind === "brown") {
        last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5;
      } else d[i] = w;
    }
    // Cross-fade the loop point so the bed has no click once a cycle.
    const fade = Math.min(2048, len >> 3);
    for (let i = 0; i < fade; i++) { const t = i / fade; d[len - fade + i] = d[len - fade + i] * (1 - t) + d[i] * t; }
    noise[kind] = buf;
    return buf;
  }

  function filterNode(f) {
    const n = ctx.createBiquadFilter();
    n.type = f.type; n.frequency.value = f.freq; n.Q.value = f.q ?? 1;
    return n;
  }

  function startLayer(l) {
    let src, param = null;
    if (l.source === "osc") {
      src = ctx.createOscillator(); src.type = l.wave || "sine"; src.frequency.value = l.freq || 110;
      if (l.detune) src.detune.value = l.detune;
    } else {
      src = ctx.createBufferSource(); src.buffer = noiseBuffer(l.noise || "white"); src.loop = true;
      src.loopStart = 0; src.loopEnd = src.buffer.duration;
    }
    const g = ctx.createGain(); g.gain.value = l.gain || 0;
    let head = src;
    let filt = null;
    if (l.filter) { filt = filterNode(l.filter); head.connect(filt); head = filt; }
    head.connect(g); g.connect(ambBus);
    if (l.lfo && l.lfo.rate > 0) {
      const lfo = ctx.createOscillator(); lfo.frequency.value = l.lfo.rate;
      const depth = ctx.createGain();
      if (l.lfo.target === "filter" && filt) { param = filt.frequency; depth.gain.value = l.filter.freq * l.lfo.depth * 0.5; }
      else if (l.lfo.target === "freq" && l.source === "osc") { param = src.frequency; depth.gain.value = (l.freq || 110) * l.lfo.depth * 0.05; }
      else { param = g.gain; depth.gain.value = (l.gain || 0) * l.lfo.depth * 0.5; }
      lfo.connect(depth); depth.connect(param); lfo.start();
    }
    if (l.crackle) crackles.push({ rate: l.crackle.rate || 5, gain: l.crackle.gain || 0.1, filter: l.filter || null, next: 0 });
    src.start(ctx.currentTime + 0.01 + r() * 0.2);
  }

  function voice(v, when, gain, bus) {
    const t0 = when + (v.delay || 0);
    const g = ctx.createGain();
    const peak = Math.max(0.0001, (v.gain ?? 0.5) * gain);
    const atk = Math.max(0.001, v.attack ?? 0.005), dec = Math.max(0.01, v.decay ?? 0.2);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + dec);
    let src;
    if (v.source === "osc") {
      src = ctx.createOscillator(); src.type = v.wave || "sine";
      src.frequency.setValueAtTime(v.freq || 440, t0);
      if (v.freq_end) src.frequency.exponentialRampToValueAtTime(Math.max(1, v.freq_end), t0 + atk + dec);
    } else {
      src = ctx.createBufferSource(); src.buffer = noiseBuffer(v.noise || "white");
    }
    let head = src;
    if (v.filter) { const f = filterNode(v.filter); head.connect(f); head = f; }
    head.connect(g); g.connect(bus);
    if (v.source === "osc") src.start(t0); else src.start(t0, r() * 1.5);
    src.stop(t0 + atk + dec + 0.05);
  }

  function play(name, gain = 1) {
    const c = spec.cues[name];
    if (!c || !ctx || state.muted) return false;
    const now = ctx.currentTime + 0.005;
    for (const v of c.voices || []) voice(v, now, (c.gain ?? 0.5) * gain, cueBus);
    return true;
  }

  // ---------------------------------------------------------------- api
  function start() {
    if (!state.present || !state.available) { refresh(); return false; }
    try {
      if (!ctx) {
        ctx = new AC();
        master = ctx.createGain(); master.gain.value = state.muted ? 0 : (spec.master ?? 0.5);
        master.connect(ctx.destination);
        ambBus = ctx.createGain(); ambBus.gain.value = 0.0001; ambBus.connect(master);
        cueBus = ctx.createGain(); cueBus.gain.value = 1; cueBus.connect(master);
        for (const l of spec.ambience.layers || []) { try { startLayer(l); } catch (e) { fail(`layer ${l?.id}`, e); } }
        // Fade the bed in rather than slamming it on at the first key press.
        ambBus.gain.setValueAtTime(0.0001, ctx.currentTime);
        ambBus.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 2.5);
        state.started = true;
      }
      if (ctx.state === "suspended" && ctx.resume) ctx.resume().then(refresh, (e) => fail("resume", e));
    } catch (e) {
      fail("start", e);
      state.available = false; state.reason = `WebAudio failed: ${e?.message || e}`;
    }
    refresh();
    return state.started;
  }

  function setMuted(m) {
    state.muted = !!m;
    try { storage?.setItem?.(MUTE_KEY, state.muted ? "1" : "0"); } catch { /* storage blocked */ }
    try { if (master && ctx) master.gain.setTargetAtTime(state.muted ? 0 : (spec.master ?? 0.5), ctx.currentTime, 0.05); } catch (e) { fail("mute", e); }
    refresh();
    return state.muted;
  }

  function cue(name, gain = 1) {
    if (!state.present || !spec.cues?.[name]) return false;
    state.cues_played++;
    state.cue_counts[name] = (state.cue_counts[name] || 0) + 1;
    state.last_cue = name;
    try { if (play(name, gain)) state.cues_sounded++; } catch (e) { fail(`cue ${name}`, e); }
    return true;
  }

  /**
   * Sim events → cues. At most one of each cue per batch, a short cooldown on
   * repeating ones (hazard damage ticks), and win/lose only on the transition
   * (sim-core repeats its status event every step once the game has ended).
   */
  function onEvents(events, t = null) {
    if (!state.present || !Array.isArray(events) || !events.length) return;
    try {
      const fired = new Set();
      const once = (n, g) => {
        if (fired.has(n)) return;
        fired.add(n);
        if (Number.isFinite(t) && COOLDOWN[n] && Number.isFinite(lastAt[n]) && t - lastAt[n] < COOLDOWN[n]) return;
        if (Number.isFinite(t)) lastAt[n] = t;
        cue(n, g);
      };
      const hasPickup = events.some((e) => e.kind === "pickup");
      for (const ev of events) {
        if (EVENT_CUE[ev.kind]) once(EVENT_CUE[ev.kind]);
        else if (ev.kind === "interact" && !hasPickup) once("interact");
        else if (ev.kind === "damage" && (ev.value ?? 1) > 0) once("damage");
        else if (ev.kind === "status") {
          if (ev.value !== lastStatus) { if (ev.value === "won") once("win"); else if (ev.value === "lost") once("lose"); }
          lastStatus = ev.value;
        }
        else if (ev.kind === "land" && (ev.impact ?? 0) > 2) once("footstep", 1.3);
      }
    } catch (e) { fail("events", e); }
  }

  /** Per fixed step: footsteps from the player's ground speed; placed emitters near the player. */
  function step(sim, dt) {
    if (!state.present || !sim?.player) return;
    try {
      const p = sim.player;
      const v = p.velocity || { x: 0, z: 0 };
      const speed = Math.hypot(v.x || 0, v.z || 0);
      if (p.grounded && speed > 0.6) {
        stride += speed * dt;
        const len = speed > 5 ? 2.6 : 1.9;
        if (stride >= len) { stride -= len; cue("footstep", Math.min(1.2, 0.6 + speed / 10)); }
      } else if (!p.grounded) stride = 0;

      if (!ctx || state.muted) return;
      for (const e of spec.emitters || []) {
        const d = Math.hypot(e.position.x - p.position.x, e.position.z - p.position.z);
        if (d > e.radius) continue;
        let t = emitTimers.has(e.id) ? emitTimers.get(e.id) : r() * (e.interval || 1);
        t -= dt;
        if (t <= 0) {
          const k = 1 - d / e.radius;
          if (play(e.cue, 0.25 + 0.75 * k * k)) state.emitter_plays++;
          t = (e.interval || 1) * (0.6 + 0.8 * r());
        }
        emitTimers.set(e.id, t);
      }
      // Fire crackle beds: random pops at the layer's rate.
      for (const c of crackles) {
        c.next -= dt;
        if (c.next <= 0) {
          voice({ source: "noise", noise: "white", attack: 0.001, decay: 0.02 + r() * 0.05, gain: c.gain * (0.4 + 0.6 * r()), filter: c.filter || { type: "bandpass", freq: 3000, q: 1 } }, ctx.currentTime + 0.005, 1, ambBus);
          c.next = -Math.log(1 - r() * 0.999) / c.rate;
        }
      }
    } catch (e) { fail("step", e); }
  }

  /** After a restart / load: forget the ended status so the next win sounds again. */
  function reset(status = "playing") { lastStatus = status; stride = 0; }

  function dispose() { try { ctx?.close?.(); } catch { /* already closed */ } ctx = null; state.started = false; refresh(); }

  refresh();
  Object.assign(state, { start, setMuted, toggleMute: () => setMuted(!state.muted), cue });
  return { state, start, setMuted, toggleMute: () => setMuted(!state.muted), cue, onEvents, step, reset, dispose };
}

/** The inert controller used when the audio module or pkg.audio is missing. */
export function noAudio(reason = "no audio in package") {
  const state = { present: false, available: false, reason, started: false, muted: false, enabled: false, cues_played: 0, cues_sounded: 0, emitter_plays: 0, cue_counts: {}, last_cue: null, errors: [] };
  const nop = () => false;
  Object.assign(state, { start: nop, setMuted: nop, toggleMute: nop, cue: nop });
  return { state, start: nop, setMuted: nop, toggleMute: nop, cue: nop, onEvents: () => {}, step: () => {}, reset: () => {}, dispose: () => {} };
}
