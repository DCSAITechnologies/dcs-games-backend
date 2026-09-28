// Keyboard, mouse and touch input for the Games-B runtime. Browser-only.
//
// Controls produce a camera-relative *wish* (forward/right in [-1,1]); main.mjs
// rotates it by the camera yaw into the world-space `input.move` sim-core wants.
// Keeping the conversion out of here means the test hook and a touch stick feed
// the sim through exactly the same path as WASD.
//
// Orbit is drag-to-look, never pointer lock: the Round-2 finding on the v3 runtime
// was that a pointer-lock modal made mobile unplayable.

export function createControls({ canvas, cam, root = document, onKey = () => {} }) {
  const keys = new Set();
  const state = { choice: null, touchMove: { x: 0, y: 0 }, touchRun: false, touchJump: false, touchInteract: false, dragging: false, lastDrag: 0 };
  const isTyping = (e) => /INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || "");

  root.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
    keys.add(e.code);
    if (/^Digit[1-4]$/.test(e.code)) state.choice = Number(e.code.slice(5)) - 1;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "F3", "F5", "F9"].includes(e.code)) e.preventDefault();
    onKey(e.code, e);
  });
  root.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => keys.clear());

  // Mouse / pen drag orbit on the canvas.
  let last = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    last = { x: e.clientX, y: e.clientY };
    state.dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!last || e.pointerType === "touch") return;
    orbit(e.clientX - last.x, e.clientY - last.y);
    last = { x: e.clientX, y: e.clientY };
  });
  const end = () => { last = null; state.dragging = false; state.lastDrag = performance.now(); };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    cam.dist = Math.max(2.5, Math.min(18, cam.dist * (1 + Math.sign(e.deltaY) * 0.1)));
  }, { passive: false });

  function orbit(dx, dy) {
    cam.yaw -= dx * 0.0055;
    cam.pitch = Math.max(cam.minPitch ?? -0.35, Math.min(cam.maxPitch ?? 1.2, cam.pitch + dy * 0.0045));
    state.lastDrag = performance.now();
  }

  // Touch: left half is a floating joystick, right half orbits.
  const stick = document.getElementById("touch-stick");
  const knob = document.getElementById("touch-knob");
  const touches = new Map();
  const onTouchStart = (e) => {
    for (const t of e.changedTouches) {
      if (t.target.closest?.(".touch-btn, .hud-btn, #dialogue")) continue;
      const left = t.clientX < window.innerWidth * 0.45;
      touches.set(t.identifier, { kind: left ? "stick" : "orbit", x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY });
      if (left && stick) { stick.style.left = `${t.clientX - 60}px`; stick.style.top = `${t.clientY - 60}px`; stick.classList.add("active"); }
    }
  };
  const onTouchMove = (e) => {
    for (const t of e.changedTouches) {
      const s = touches.get(t.identifier);
      if (!s) continue;
      e.preventDefault();
      if (s.kind === "orbit") orbit(t.clientX - s.x, t.clientY - s.y);
      s.x = t.clientX; s.y = t.clientY;
      if (s.kind === "stick") {
        let dx = (s.x - s.x0) / 55, dy = (s.y - s.y0) / 55;
        const l = Math.hypot(dx, dy);
        if (l > 1) { dx /= l; dy /= l; }
        state.touchMove = { x: dx, y: dy };
        state.touchRun = l > 0.95;
        if (knob) knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      }
    }
  };
  const onTouchEnd = (e) => {
    for (const t of e.changedTouches) {
      const s = touches.get(t.identifier);
      touches.delete(t.identifier);
      if (s?.kind === "stick") {
        state.touchMove = { x: 0, y: 0 }; state.touchRun = false;
        if (knob) knob.style.transform = "";
        stick?.classList.remove("active");
      }
    }
  };
  canvas.addEventListener("touchstart", onTouchStart, { passive: true });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);
  for (const [id, key] of [["btn-jump", "touchJump"], ["btn-interact", "touchInteract"]]) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); state[key] = true; });
    const up = () => { state[key] = false; };
    b.addEventListener("pointerup", up); b.addEventListener("pointerleave", up); b.addEventListener("pointercancel", up);
  }
  if (matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window) document.body.classList.add("touch");

  const k = (...codes) => codes.some((c) => keys.has(c));
  return {
    keys,
    /** Camera-relative wish from every input source. */
    wish() {
      const forward = (k("KeyW", "ArrowUp") ? 1 : 0) - (k("KeyS", "ArrowDown") ? 1 : 0) - state.touchMove.y;
      const right = (k("KeyD", "ArrowRight") ? 1 : 0) - (k("KeyA", "ArrowLeft") ? 1 : 0) + state.touchMove.x;
      return {
        forward: Math.max(-1, Math.min(1, forward)), right: Math.max(-1, Math.min(1, right)),
        run: k("ShiftLeft", "ShiftRight") || state.touchRun,
        jump: k("Space") || state.touchJump,
        interact: k("KeyE") || state.touchInteract,
        unstuck: k("KeyR"),
        up: (k("KeyQ", "Space") ? 1 : 0) - (k("KeyZ", "ControlLeft") ? 1 : 0),
      };
    },
    takeChoice() { const c = state.choice; state.choice = null; return c; },
    recentlyOrbited(ms = 1500) { return state.dragging || performance.now() - state.lastDrag < ms; },
    orbit,
  };
}
