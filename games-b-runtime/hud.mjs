// Games-B HUD: objectives, compass, minimap, health, inventory, prompts, toasts,
// dialogue, save/load, win/lose and the F3 debug overlay. Browser-only DOM.
//
// Every element is written only when its text actually changes: the HUD updates
// each rendered frame, and rewriting innerHTML sixty times a second is the kind
// of cost that shows up as dropped frames on a phone.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function setHTML(el, html) { if (el && el._html !== html) { el.innerHTML = html; el._html = html; } }
function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
function show(el, on) { if (el) el.hidden = !on; }

export function createHud({ pkg, lib, onChoice, onRestart, onSave, onLoad, onDownload, onImport }) {
  const gp = pkg.gameplay || {};
  const world = pkg.world;
  const itemsById = new Map((gp.inventory?.items || []).map((i) => [i.id, i]));
  const charsById = new Map((pkg.characters?.characters || []).map((c) => [c.id, c]));
  const maxHealth = gp.rules?.player_health ?? 100;
  let lastMsgCount = 0;
  let debugOn = /[?&]debug=1/.test(location.search);
  const doneAt = new Map();

  setText($("game-title"), pkg.title || pkg.concept?.title || "DCS Game");
  $("btn-save")?.addEventListener("click", () => onSave?.());
  $("btn-load")?.addEventListener("click", () => onLoad?.());
  $("btn-download")?.addEventListener("click", () => onDownload?.());
  $("btn-import")?.addEventListener("click", () => $("import-file")?.click());
  $("import-file")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (f) { try { onImport?.(JSON.parse(await f.text())); } catch (err) { toast(`Import failed: ${err.message}`, "bad"); } }
    e.target.value = "";
  });
  $("btn-restart")?.addEventListener("click", () => onRestart?.());
  $("dialogue-choices")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-choice]");
    if (b) onChoice?.(Number(b.dataset.choice));
  });

  // ---- minimap base: the heightfield painted once -----------------------------
  const mm = $("minimap");
  const mmCtx = mm?.getContext("2d");
  const base = document.createElement("canvas");
  if (mm) {
    const S = 160;
    base.width = base.height = S;
    const g = base.getContext("2d");
    const img = g.createImageData(S, S);
    const t = world.terrain;
    const wl = world.environment?.water?.enabled ? world.environment.water.level ?? 0 : -Infinity;
    const layerCol = (ref) => {
      const c = lib.colorOf(ref);
      return [c.r, c.g, c.b].map((v) => Math.round(255 * Math.pow(v, 1 / 2.2)));   // linear → sRGB for canvas
    };
    const layers = (t.material_layers || []).map((l) => ({ ...l, rgb: layerCol(l.material_ref) }));
    const water = (() => { const c = lib.colorOf("mat:water"); return [c.r, c.g, c.b].map((v) => Math.round(255 * Math.pow(v, 1 / 2.2))); })();
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const wx = (x / S) * world.size.w, wz = (y / S) * world.size.h;
      const i = Math.min(t.cols - 1, Math.round(wx / t.cell)), j = Math.min(t.rows - 1, Math.round(wz / t.cell));
      const h = t.heights[j * t.cols + i];
      const hE = t.heights[j * t.cols + Math.min(t.cols - 1, i + 1)];
      let rgb = water;
      if (h > wl) {
        const l = layers.find((L) => h >= L.min_h && h <= L.max_h) || layers[layers.length - 1];
        rgb = l ? l.rgb : [110, 130, 80];
      }
      const shade = h > wl ? 1 + Math.max(-0.3, Math.min(0.3, (hE - h) * 0.12)) : 0.85 + Math.max(-0.2, (h - wl) * 0.02);
      const k = (y * S + x) * 4;
      img.data[k] = rgb[0] * shade; img.data[k + 1] = rgb[1] * shade; img.data[k + 2] = rgb[2] * shade; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // Region labels
    g.font = "600 8px system-ui, sans-serif"; g.fillStyle = "rgba(255,255,255,0.85)"; g.textAlign = "center";
    for (const r of world.regions || []) g.fillText(r.name || r.id, (r.center.x / world.size.w) * S, (r.center.z / world.size.h) * S);
  }

  function drawMinimap(f) {
    if (!mmCtx) return;
    const S = mm.width;
    mmCtx.clearRect(0, 0, S, S);
    mmCtx.drawImage(base, 0, 0, S, S);
    const toMap = (p) => [(p.x / world.size.w) * S, (p.z / world.size.h) * S];
    for (const [id, n] of Object.entries(f.npcs || {})) {
      const ch = charsById.get(id);
      if (!ch || f.defeated?.has(id)) continue;
      const [x, y] = toMap(n.position);
      mmCtx.fillStyle = ch.behavior?.hostile ? "#6fb8ff" : ch.companion ? "#ffb060" : "#fff2c8";
      mmCtx.beginPath(); mmCtx.arc(x, y, 2.6, 0, Math.PI * 2); mmCtx.fill();
    }
    if (f.objectiveTarget) {
      const [x, y] = toMap(f.objectiveTarget);
      mmCtx.strokeStyle = "#ffcf5a"; mmCtx.lineWidth = 2;
      mmCtx.beginPath(); mmCtx.arc(x, y, 5 + Math.sin(performance.now() / 200), 0, Math.PI * 2); mmCtx.stroke();
    }
    if (f.player) {
      const [x, y] = toMap(f.player.position);
      const r = f.player.rotation_y || 0;
      mmCtx.save(); mmCtx.translate(x, y); mmCtx.rotate(-r + Math.PI);
      mmCtx.fillStyle = "#ffffff"; mmCtx.strokeStyle = "#000"; mmCtx.lineWidth = 1;
      mmCtx.beginPath(); mmCtx.moveTo(0, -6); mmCtx.lineTo(4, 4); mmCtx.lineTo(0, 2); mmCtx.lineTo(-4, 4); mmCtx.closePath(); mmCtx.fill(); mmCtx.stroke();
      mmCtx.restore();
    }
  }

  // ---- compass -----------------------------------------------------------------
  // Bearing 0 = north = -z (the top of the minimap), 90 = east = +x.
  const bearingOf = (dx, dz) => Math.atan2(dx, -dz);
  function drawCompass(f) {
    const el = $("compass-strip");
    if (!el) return;
    const facing = bearingOf(-Math.sin(f.camYaw), -Math.cos(f.camYaw));
    const items = [["N", 0], ["NE", Math.PI / 4], ["E", Math.PI / 2], ["SE", 3 * Math.PI / 4], ["S", Math.PI], ["SW", -3 * Math.PI / 4], ["W", -Math.PI / 2], ["NW", -Math.PI / 4]];
    let html = "";
    for (const [label, b] of items) {
      const d = Math.atan2(Math.sin(b - facing), Math.cos(b - facing));
      if (Math.abs(d) > Math.PI / 2) continue;
      html += `<span class="cp${label.length === 1 ? " major" : ""}" style="left:${50 + (d / (Math.PI / 2)) * 50}%">${label}</span>`;
    }
    if (f.objectiveTarget && f.player) {
      const b = bearingOf(f.objectiveTarget.x - f.player.position.x, f.objectiveTarget.z - f.player.position.z);
      const d = Math.atan2(Math.sin(b - facing), Math.cos(b - facing));
      const dist = Math.hypot(f.objectiveTarget.x - f.player.position.x, f.objectiveTarget.z - f.player.position.z);
      const left = 50 + Math.max(-1, Math.min(1, d / (Math.PI / 2))) * 50;
      html += `<span class="cp obj" style="left:${left}%">◆<small>${Math.round(dist)} m</small></span>`;
    }
    // Round positions to whole percents so the string only changes when something visibly moves.
    setHTML(el, html.replace(/left:(-?\d+(?:\.\d+)?)%/g, (_, v) => `left:${Math.round(v * 2) / 2}%`));
  }

  // ---- toasts ------------------------------------------------------------------
  function toast(text, kind = "") {
    const box = $("toasts");
    if (!box) return;
    const d = document.createElement("div");
    d.className = `toast ${kind}`;
    d.textContent = text;
    box.appendChild(d);
    setTimeout(() => d.classList.add("out"), 3800);
    setTimeout(() => d.remove(), 4400);
    while (box.children.length > 4) box.firstChild.remove();
  }

  function update(f) {
    const g = f.game || {};
    // Objectives: active first, then the most recently finished for a few seconds.
    const now = performance.now();
    const rows = [];
    // Required objectives first; optional side content is capped so the main
    // thread of the quest never scrolls out of the panel.
    let optionalShown = 0, optionalHidden = 0;
    const ordered = [...(gp.objectives || [])].sort((a, b) => (a.optional ? 1 : 0) - (b.optional ? 1 : 0));
    for (const o of ordered) {
      const st = g.objectives?.[o.id];
      if (st === "done" && !doneAt.has(o.id)) doneAt.set(o.id, now);
      const recent = st === "done" && now - doneAt.get(o.id) < 5000;
      if (st !== "active" && !recent) continue;
      if (o.optional && st === "active") { if (optionalShown >= 1) { optionalHidden++; continue; } optionalShown++; }
      const count = o.count || 1;
      const prog = Math.min(count, g.progress?.[o.id] ?? (st === "done" ? count : 0));
      rows.push(`<li class="${st}${o.optional ? " optional" : ""}"><b>${esc(o.title)}</b>${count > 1 ? ` <span class="prog">${prog}/${count}</span>` : ""}` +
        `${st === "active" && o.description ? `<small>${esc(o.description)}</small>` : ""}</li>`);
    }
    const total = (gp.objectives || []).filter((o) => !o.optional).length;
    const done = (gp.objectives || []).filter((o) => !o.optional && g.objectives?.[o.id] === "done").length;
    if (optionalHidden) rows.push(`<li class="muted more">${optionalHidden} more optional</li>`);
    setHTML($("objective-list"), rows.join("") || `<li class="muted">Explore.</li>`);
    setText($("objective-count"), `${done}/${total}`);

    // Health & lives
    const hp = Math.max(0, g.health ?? maxHealth);
    const bar = $("health-fill");
    if (bar) { const w = `${Math.round((hp / maxHealth) * 100)}%`; if (bar.style.width !== w) bar.style.width = w; bar.classList.toggle("low", hp / maxHealth < 0.3); }
    setText($("health-text"), `${Math.round(hp)} / ${maxHealth}`);
    setText($("lives"), "♥".repeat(Math.max(0, g.lives ?? 0)) || "—");
    setText($("level"), `Lv ${g.level ?? 1} · ${g.xp ?? 0} xp`);

    // Timer
    const limit = gp.rules?.time_limit_s ? gp.rules.time_limit_s * (gp.difficulty?.time_mult ?? 1) : null;
    const tEl = $("timer");
    if (limit && tEl) {
      const left = Math.max(0, limit - (g.t ?? f.t ?? 0));
      setText(tEl, `Storm ${String(Math.floor(left / 60)).padStart(2, "0")}:${String(Math.floor(left % 60)).padStart(2, "0")}`);
      tEl.classList.toggle("urgent", left < 60);
      show(tEl, true);
    } else show(tEl, false);

    // Inventory
    const inv = Object.entries(g.inventory || {}).filter(([, n]) => n > 0);
    setHTML($("inventory"), inv.map(([id, n]) => {
      const it = itemsById.get(id);
      const url = lib.iconUrl(it?.icon_ref) || lib.iconUrl(`icon:${id}`);
      const name = it?.name || id;
      return `<div class="slot" title="${esc(name)}" data-item="${esc(id)}">${url ? `<img alt="${esc(name)}" src="${url}">` : `<span>${esc(name.slice(0, 2))}</span>`}${n > 1 ? `<i>${n}</i>` : ""}</div>`;
    }).join(""));

    // Prompt
    const pr = $("prompt");
    if (f.nearest && !f.dialogue && f.status === "playing") {
      setHTML(pr, `<kbd>E</kbd> ${esc(f.nearest.prompt || f.nearest.kind)}`);
      show(pr, true);
    } else show(pr, false);

    // Dialogue
    const dl = $("dialogue");
    if (f.dialogue) {
      const sp = charsById.get(f.dialogue.node.speaker) || charsById.get(f.dialogue.character_ref);
      setText($("dialogue-speaker"), sp?.name || f.dialogue.node.speaker || "");
      setText($("dialogue-text"), f.dialogue.node.text || "");
      const ch = f.dialogue.choices?.length ? f.dialogue.choices : [{ text: "…" }];
      setHTML($("dialogue-choices"), ch.map((c, i) => `<button class="choice" data-choice="${i}"><kbd>${i + 1}</kbd>${esc(c.text)}</button>`).join(""));
      show(dl, true);
    } else show(dl, false);

    // Messages
    const msgs = g.messages || [];
    if (msgs.length < lastMsgCount) lastMsgCount = 0;
    for (let i = lastMsgCount; i < msgs.length; i++) toast(msgs[i].text);
    lastMsgCount = msgs.length;

    // End overlay
    const ov = $("overlay");
    if (f.status === "won" || f.status === "lost") {
      if (!ov._shown) {
        ov._shown = true;
        ov.className = f.status;
        setText($("overlay-title"), f.status === "won" ? "Victory" : "Defeat");
        setText($("overlay-sub"), f.status === "won" ? `Quest complete${pkg.title ? ` — ${pkg.title}` : ""}`
          : (g.lives ?? 1) <= 0 ? "No lives left." : (limit && (g.t ?? 0) >= limit ? "The storm made landfall." : "The journey ends here."));
        const mins = Math.floor((g.t ?? 0) / 60), secs = Math.floor((g.t ?? 0) % 60);
        setText($("overlay-stats"), `Time ${mins}:${String(secs).padStart(2, "0")} · ${done}/${total} objectives · ${g.xp ?? 0} xp`);
        show(ov, true);
      }
    } else if (ov && !ov.hidden) { ov._shown = false; show(ov, false); }

    drawCompass(f);
    drawMinimap(f);

    if (debugOn && f.stats) {
      const s = f.stats;
      setText($("debug"), [
        `fps ${s.fps?.toFixed(0)}  frame p50 ${s.frame_ms_p50?.toFixed(1)} ms  p95 ${s.frame_ms_p95?.toFixed(1)} ms`,
        `draw calls ${s.draw_calls}  tris ${s.triangles}  tex ${s.textures}  geo ${s.geometries}`,
        f.player ? `pos ${f.player.position.x.toFixed(1)}, ${f.player.position.y.toFixed(1)}, ${f.player.position.z.toFixed(1)}  t ${(g.t ?? 0).toFixed(1)}s` : "view-only",
        `sim ${f.mode}  ${f.modulesNote || ""}`,
      ].join("\n"));
    }
  }

  function toggleDebug() { debugOn = !debugOn; show($("debug"), debugOn); }
  show($("debug"), debugOn);

  function reset() { lastMsgCount = 0; doneAt.clear(); const ov = $("overlay"); if (ov) { ov._shown = false; show(ov, false); } }
  function skipMessages(n) { lastMsgCount = n; }

  return { update, toast, toggleDebug, reset, skipMessages };
}

// ---- loading / error screens -----------------------------------------------------
export function progress(frac, label) {
  const f = $("loading-fill");
  if (f) f.style.width = `${Math.round(frac * 100)}%`;
  setText($("loading-label"), label || "");
}
export function hideLoading() { const l = $("loading"); if (l) { l.classList.add("done"); setTimeout(() => { l.hidden = true; }, 600); } }
export function showError(title, detail) {
  const l = $("loading"); if (l) l.hidden = true;
  const e = $("error");
  if (!e) return;
  setText($("error-title"), title);
  setText($("error-detail"), detail || "");
  e.hidden = false;
}
