// GAMES-C QA — playtest gate runner.
//
// runGates(manifest) produces one JSON report with a status per gate:
//   PASS     — the gate ran and its threshold held (evidence attached)
//   FAIL     — the gate ran and the world failed it (evidence says why)
//   SKIPPED  — the gate could not run (module absent, browser not enabled...).
//              SKIPPED is NEVER counted as PASS: overall is "INCOMPLETE" if any
//              gate skipped and none failed.
//
// Headless gates reuse src/v3/playtest/{agent,validators}.mjs — the same
// simulation the B4 critic uses — so "unreachable" means unreachable in the game.
// Save/reload, edit/retest and publish/reopen call the sibling GAMES-C modules
// (memory, patch, publish) through dynamic import; if a module is missing or
// its API is not the one this runner knows, the gate is SKIPPED with the reason.
// FPS / memory / console-error gates need a real browser and are opt-in via
// DCS_GAMESC_BROWSER_GATES=1 (read-only use of the frontend checkout).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateManifest } from "../../manifest/schema.mjs";
import { simulatePlaythrough, simulateQuests, critique } from "../../playtest/agent.mjs";
import { validateNavigation, validateStructure, validateQuests, SEVERITY } from "../../playtest/validators.mjs";
import { guardManifest } from "../guard/index.mjs";
import { checkAssetUrl } from "../guard/url-policy.mjs";
import { checkAssetBudget } from "../guard/asset-limits.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAMESC = path.resolve(HERE, "..");
const REPO = path.resolve(HERE, "../../../..");

export const REPORT_VERSION = "1";
export const GATES = Object.freeze([
  "launch", "navigation", "movement", "collision", "objective_reachability", "asset_load",
  "fps", "memory", "console_errors", "save_reload", "edit_retest", "publish_package", "reopen_published_preview",
]);
export const STATUS = Object.freeze({ PASS: "PASS", FAIL: "FAIL", SKIPPED: "SKIPPED" });

export const DEFAULT_THRESHOLDS = Object.freeze({
  minCoverage: 0.05,            // fraction of terrain the agent can walk (agent.mjs critic uses 0.05)
  minVisitedCells: 2,           // could move off the spawn at all
  minFps: 20,                   // headless swiftshader; real GPUs are far higher
  maxHeapMB: 512,
  maxConsoleErrors: 0,
  browserSampleMs: 3000,
  browserBootTimeoutMs: 25000,
});

const sha = (s) => "sha256:" + crypto.createHash("sha256").update(s).digest("hex");
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const blocking = (fs_) => fs_.filter((f) => f.severity === SEVERITY.BLOCKER || f.severity === SEVERITY.MAJOR);

/**
 * Load sibling modules. Each entry is the module namespace or null, with a
 * reason when null. Never throws.
 */
export async function loadGamescModules({ root = GAMESC, only = null } = {}) {
  const out = { reasons: {} };
  for (const area of ["patch", "memory", "publish", "companion", "multiplayer"]) {
    if (only && !only.includes(area)) { out[area] = null; out.reasons[area] = "not requested"; continue; }
    const file = path.join(root, area, "index.mjs");
    if (!fs.existsSync(file)) { out[area] = null; out.reasons[area] = `module absent: ${path.relative(REPO, file)}`; continue; }
    try { out[area] = await import(pathToFileURL(file).href); }
    catch (e) { out[area] = null; out.reasons[area] = `import failed: ${String(e?.message || e).slice(0, 200)}`; }
  }
  return out;
}

function gate(name, status, evidence = {}, reason = null) {
  return { gate: name, status, ...(reason ? { reason } : {}), evidence };
}
const skip = (name, reason, evidence = {}) => gate(name, STATUS.SKIPPED, evidence, reason);

// ---------------------------------------------------------------- headless gates

function gateLaunch(m) {
  const schema = validateManifest(m);
  const guard = guardManifest(m, { requirePins: true });
  const spawn = m?.spawn?.player_spawns?.[0] || null;
  const ok = schema.ok && guard.ok && !!spawn;
  return gate("launch", ok ? STATUS.PASS : STATUS.FAIL, {
    mode: "headless (schema + guard + spawn); browser boot added when DCS_GAMESC_BROWSER_GATES=1",
    schema_ok: schema.ok, schema_errors: schema.errors.slice(0, 5),
    guard_ok: guard.ok, guard_blocking: guard.blocking.slice(0, 5), has_spawn: !!spawn,
  }, ok ? null : (!schema.ok ? "manifest fails validateManifest" : !guard.ok ? "manifest fails guardManifest" : "no player spawn"));
}

function gateNavigation(m) {
  const f = validateNavigation(m);
  const bad = blocking(f);
  return gate("navigation", bad.length ? STATUS.FAIL : STATUS.PASS, { validator: "validators.validateNavigation", findings: f.slice(0, 10) },
    bad.length ? bad.map((x) => x.id).join(", ") : null);
}

function gateMovement(m, walk, T) {
  const ok = walk.ok && walk.visited_cells >= T.minVisitedCells && walk.coverage >= T.minCoverage;
  return gate("movement", ok ? STATUS.PASS : STATUS.FAIL, {
    simulator: "agent.simulatePlaythrough", ok: walk.ok, visited_cells: walk.visited_cells ?? 0, coverage: walk.coverage ?? 0,
    step_m: walk.step, truncated: walk.truncated, thresholds: { minCoverage: T.minCoverage, minVisitedCells: T.minVisitedCells },
  }, ok ? null : !walk.ok ? `cannot start: ${walk.reason}` : walk.visited_cells < T.minVisitedCells ? "agent could not move from the spawn" : `coverage ${walk.coverage} < ${T.minCoverage}`);
}

const COLLISION_IDS = new Set(["asset_no_collision", "spawn_inside_structure", "structure_out_of_bounds"]);
function gateCollision(m, walk) {
  const f = [...validateStructure(m), ...validateNavigation(m)].filter((x) => COLLISION_IDS.has(x.id));
  const overlap = validateStructure(m).filter((x) => x.id === "structures_overlap").length;
  return gate("collision", f.length ? STATUS.FAIL : STATUS.PASS, {
    checks: [...COLLISION_IDS], findings: f.slice(0, 10), overlaps_minor: overlap,
    blocked_by_solids: "simulatePlaythrough treats structure footprints as solid (agent.mjs)",
    visited_cells: walk.visited_cells ?? 0,
  }, f.length ? f.map((x) => x.id).join(", ") : null);
}

function gateObjectives(m, walk, quests) {
  const f = blocking(validateQuests(m));
  const notDone = quests.filter((q) => !q.completable);
  const none = !(m.quests || []).length;
  const ok = !none && !f.length && !notDone.length;
  return gate("objective_reachability", ok ? STATUS.PASS : STATUS.FAIL, {
    simulator: "agent.simulateQuests", quests: quests.map((q) => ({ quest: q.quest, completable: q.completable, blocked: q.steps.filter((s) => !s.ok).map((s) => s.why) })),
    validator_findings: f.slice(0, 10),
  }, ok ? null : none ? "world has no quests/objectives" : notDone.length ? `${notDone.length} quest(s) not completable` : f.map((x) => x.id).join(", "));
}

function gateAssetLoad(m) {
  const problems = [];
  const ids = new Set((m.assets || []).map((a) => a.id));
  for (const coll of ["structures", "npcs", "items"]) for (const e of m[coll] || []) {
    if (e.asset_ref && !ids.has(e.asset_ref)) problems.push({ code: "missing_asset", where: `${coll}:${e.id}`, ref: e.asset_ref });
  }
  for (const a of m.assets || []) {
    if ((a.format === "glb" || a.format === "gltf")) {
      const u = checkAssetUrl(a.uri || "");
      if (!u.ok) problems.push({ code: "asset_url_" + u.code, where: a.id });
    } else if (a.format === "primitive" && (!a.primitive || typeof a.primitive !== "object")) problems.push({ code: "primitive_missing", where: a.id });
  }
  const budget = checkAssetBudget(m.assets);
  for (const f of budget.findings) problems.push({ code: f.code, where: f.id || "$" });
  return gate("asset_load", problems.length ? STATUS.FAIL : STATUS.PASS, {
    mode: "headless (refs resolve, url policy, bomb limits); network load checked in browser mode",
    assets: (m.assets || []).length, formats: [...new Set((m.assets || []).map((a) => a.format))], totals: budget.totals, problems: problems.slice(0, 10),
  }, problems.length ? problems.slice(0, 3).map((p) => `${p.code}@${p.where}`).join(", ") : null);
}

// ----------------------------------------------------------- module-backed gates

async function gateSaveReload(m, mods) {
  const mem = mods.memory;
  if (!mem) return skip("save_reload", mods.reasons.memory || "memory module absent");
  if (typeof mem.createWorldMemoryV2 !== "function") return skip("save_reload", "memory module has no createWorldMemoryV2()");
  try {
    const hashManifest = mods.patch?.hashManifest || ((x) => sha(stable(x)));
    const memory = mem.createWorldMemoryV2({
      hashManifest,
      applyPatch: mods.patch?.applyPatch || null, replayPatches: mods.patch?.replayPatches || null, diffManifests: mods.patch?.diffManifests || null,
    });
    const w = m.world_id;
    const saved = await memory.save(w, { manifest: m, author: { kind: "system", id: "qa-gates" }, label: "qa save" });
    const again = await memory.save(w, { manifest: m, author: { kind: "system", id: "qa-gates" } });
    const resumed = await memory.resume(w);
    const before = hashManifest(m), after = hashManifest(resumed.manifest);
    const integrity = typeof memory.verifyIntegrity === "function" ? await memory.verifyIntegrity(w, { deep: true }) : null;
    const ok = before === after && resumed.version === saved.version.version && again.idempotent === true && (integrity ? integrity.ok !== false : true);
    return gate("save_reload", ok ? STATUS.PASS : STATUS.FAIL, {
      module: "gamesc/memory.createWorldMemoryV2 (in-memory adapter)", saved_version: saved.version.version, idempotent_resave: again.idempotent,
      hash_before: before, hash_after_reload: after, integrity_ok: integrity ? integrity.ok : null,
    }, ok ? null : before !== after ? "reloaded manifest differs from saved" : "version/idempotency/integrity check failed");
  } catch (e) {
    return gate("save_reload", STATUS.FAIL, { error: String(e?.message || e).slice(0, 300), code: e?.code || null }, "memory save/reload threw");
  }
}

/** A benign, reversible edit every world supports. */
function probeOps(m) {
  const weathers = ["rain", "storm", "clear", "fog"];
  const cur = m?.environment?.weather;
  return [{ op: "set", path: "environment.weather", value: weathers.find((x) => x !== cur) }];
}

async function gateEditRetest(m, mods, T) {
  const p = mods.patch;
  if (!p) return skip("edit_retest", mods.reasons.patch || "patch module absent");
  for (const fn of ["createPatch", "applyPatch", "hashManifest"]) if (typeof p[fn] !== "function") return skip("edit_retest", `patch module has no ${fn}()`);
  try {
    // Prefer a companion-authored edit (natural language → patch) when the
    // companion module is present; fall back to a fixed probe op otherwise.
    let patch = null, probe_source = "fixed", probe_text = null;
    const c = mods.companion;
    if (c && typeof c.interpret === "function" && typeof c.buildPatch === "function") {
      probe_text = m?.environment?.weather === "storm" ? "make it foggy" : "make it stormy";
      try {
        const interp = c.interpret(probe_text, m);
        patch = c.buildPatch(interp, m, { now: "2026-09-28T00:00:00.000Z", author: { kind: "companion", id: "qa-gates" } });
        if (patch) probe_source = "companion";
      } catch { patch = null; }
    }
    patch = patch || p.createPatch({ manifest: m, ops: probeOps(m), author: { kind: "system", id: "qa-gates" }, intent: { text: "qa probe: change weather", category: "lighting_weather" }, created_at: "2026-09-28T00:00:00.000Z" });
    const v = typeof p.validatePatch === "function" ? p.validatePatch(patch, m) : { ok: true };
    const applied = p.applyPatch(m, patch);
    if (!v.ok || !applied.ok) return gate("edit_retest", STATUS.FAIL, { validate: v.errors?.slice?.(0, 5), apply: applied.errors?.slice?.(0, 5) }, "probe patch rejected");
    // Retest the edited world with the same gates that matter for play.
    const walk = simulatePlaythrough(applied.manifest);
    const quests = simulateQuests(applied.manifest, walk);
    const verdict = critique(applied.manifest, { walk, quests });
    const baseVerdict = critique(m, { walk: simulatePlaythrough(m), quests: simulateQuests(m, simulatePlaythrough(m)) });
    const reverted = p.applyPatch(applied.manifest, applied.inverse);
    const strip = (x) => { const c = structuredClone(x); delete c.world_version; if (c.meta) delete c.meta.updated_at; if (c.provenance) delete c.provenance.manifest_hash; return c; };
    const roundTrip = reverted.ok && p.hashManifest(strip(reverted.manifest)) === p.hashManifest(strip(m));
    const regressed = baseVerdict.passed && !verdict.passed;
    const guard = guardManifest(applied.manifest);
    const ok = !regressed && roundTrip && guard.ok && walk.coverage >= T.minCoverage;
    return gate("edit_retest", ok ? STATUS.PASS : STATUS.FAIL, {
      module: "gamesc/patch", probe_source, probe_text, patch_id: patch.patch_id, ops: patch.ops,
      verdict_before: baseVerdict.verdict, verdict_after: verdict.verdict, coverage_after: walk.coverage,
      inverse_round_trip: roundTrip, guard_after_ok: guard.ok,
    }, ok ? null : regressed ? "edit regressed the playtest verdict" : !roundTrip ? "inverse patch did not restore the manifest" : !guard.ok ? "edited manifest fails guard" : "coverage dropped below threshold");
  } catch (e) {
    return gate("edit_retest", STATUS.FAIL, { error: String(e?.message || e).slice(0, 300) }, "patch apply/retest threw");
  }
}

async function buildPackage(m, mods, verdict) {
  const pub = mods.publish;
  const signer = pub.generateThrowawaySigner("qa-gates");
  return pub.buildStagingPackage({
    manifest: m, runtime: { version: m.manifest_version || "3.0.0" }, playtestVerdict: { ...verdict, manifest: m },
    signer, provenance: { source: "qa-gates" }, createdAt: "2026-09-28T00:00:00.000Z",
  });
}

async function gatePublish(m, mods, verdict, ctx) {
  const pub = mods.publish;
  if (!pub) return skip("publish_package", mods.reasons.publish || "publish module absent");
  for (const fn of ["buildStagingPackage", "generateThrowawaySigner"]) if (typeof pub[fn] !== "function") return skip("publish_package", `publish module has no ${fn}()`);
  try {
    const built = await buildPackage(m, mods, verdict);
    if (!built.ok) return gate("publish_package", STATUS.FAIL, { errors: built.errors.slice(0, 8) }, built.errors.slice(0, 3).map((e) => e.code).join(", "));
    const pkg = built.package;
    // The package itself must pass the guard: no secrets, no code, no unsafe urls.
    const descriptorGuard = guardManifest(pkg.descriptor, { requirePins: false });
    const ok = !!pkg.package_id && descriptorGuard.ok;
    ctx.pkg = pkg;
    return gate("publish_package", ok ? STATUS.PASS : STATUS.FAIL, {
      module: "gamesc/publish.buildStagingPackage", package_id: pkg.package_id, files: [...pkg.files.keys()],
      archive_bytes: pkg.archive.length, manifest_hash: pkg.descriptor.manifest_hash, playtest: pkg.descriptor.playtest?.verdict,
      descriptor_guard_ok: descriptorGuard.ok,
    }, ok ? null : "package descriptor fails guard");
  } catch (e) {
    return gate("publish_package", STATUS.FAIL, { error: String(e?.message || e).slice(0, 300) }, "package build threw");
  }
}

async function gateReopen(m, mods, ctx, opts) {
  const pub = mods.publish;
  if (!pub) return skip("reopen_published_preview", mods.reasons.publish || "publish module absent");
  if (typeof pub.createStagingRegistry !== "function") return skip("reopen_published_preview", "publish module has no createStagingRegistry()");
  if (!ctx.pkg) return skip("reopen_published_preview", "no package was built (publish_package did not pass)");
  const root = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), "dcs-gamesc-qa-"));
  try {
    const reg = pub.createStagingRegistry({ root, env: {}, now: () => "2026-09-28T00:00:00.000Z" });
    const staged = reg.publishStaging(ctx.pkg);
    const opened = reg.openPreview(ctx.pkg.world_id, ctx.pkg.package_id);
    const current = reg.current(ctx.pkg.world_id);
    let reverify = null;
    if (opened.ok) {
      const walk = simulatePlaythrough(opened.manifest);
      reverify = { coverage: walk.coverage, quests_completable: simulateQuests(opened.manifest, walk).every((q) => q.completable) };
    }
    const ok = opened.ok && current.ok && opened.manifest_hash === ctx.pkg.descriptor.manifest_hash && reverify && reverify.quests_completable;
    return gate("reopen_published_preview", ok ? STATUS.PASS : STATUS.FAIL, {
      module: "gamesc/publish.createStagingRegistry + openPreview", preview_url: staged.preview_url, channel_current: staged.channel?.current,
      opened_ok: opened.ok, open_code: opened.code || null, manifest_hash: opened.manifest_hash || null, replayed_after_reopen: reverify,
    }, ok ? null : !opened.ok ? `openPreview: ${opened.code}` : "reopened package differs or is not playable");
  } catch (e) {
    return gate("reopen_published_preview", STATUS.FAIL, { error: String(e?.message || e).slice(0, 300), code: e?.code || null }, "staging publish/reopen threw");
  } finally {
    if (!opts.workDir && !opts.keepWorkDir) rmReadOnly(root);
  }
}

function rmReadOnly(dir) {
  try {
    const walk = (p) => { try { fs.chmodSync(p, 0o755); } catch {} if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)); };
    walk(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* temp dir; best effort */ }
}

// ---------------------------------------------------------------- browser gates

function browserEnabled(env) { return env.DCS_GAMESC_BROWSER_GATES === "1"; }

export function resolveSiteDir(env = process.env) {
  const candidates = [env.DCS_SITE_DIR, path.resolve(REPO, "../../dcs-games-LIVE"), path.resolve(REPO, "../dcs-games-LIVE")].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, "play-v3.html"))) return c;
  return null;
}

/**
 * Real browser run: serve the frontend read-only, stub the manifest API, boot
 * play-v3.html, sample rAF for FPS, read heap and console/page errors.
 * Returns {ok, reason?, evidence}. Never writes into the site dir.
 */
export async function runBrowserProbe(m, { env = process.env, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const site = resolveSiteDir(env);
  if (!site) return { ok: false, reason: "frontend (play-v3.html) not found; set DCS_SITE_DIR" };
  let helpers;
  try { helpers = await import(pathToFileURL(path.join(REPO, "test/helpers/browser.mjs")).href); }
  catch (e) { return { ok: false, reason: "browser helper import failed: " + e.message }; }
  if (!helpers.findChrome()) return { ok: false, reason: "no Chrome binary" };
  const worldId = m.world_id;
  const api = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }); res.end(JSON.stringify(body)); };
      if (req.method === "OPTIONS") return send(204, {});
      const u = (req.url || "").split("?")[0];
      if (u === `/v3/worlds/${encodeURIComponent(worldId)}/manifest`) return send(200, { ok: true, world_id: worldId, world_version: m.world_version, state: "draft", owner: "u1", manifest: m });
      if (/\/companion$/.test(u)) return send(401, { ok: false, error: "unauthenticated" });
      return send(404, { ok: false, error: "not_found" });
    });
    s.listen(0, "127.0.0.1", () => resolve({ port: s.address().port, close: () => new Promise((r) => s.close(r)) }));
  });
  const srv = await helpers.serveStatic(site);
  let browser = null;
  try {
    browser = await helpers.launchChrome();
    const page = await helpers.Page.open(browser);
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.DCS_API_BASE = "http://127.0.0.1:${api.port}";` });
    const t0 = Date.now();
    await page.goto(`${srv.url}/play-v3.html?world=${encodeURIComponent(worldId)}&stats=1`, { waitMs: 1500 });
    const booted = await page.waitFor("window.__rt && document.getElementById('boot') && document.getElementById('boot').style.display === 'none'", { timeout: thresholds.browserBootTimeoutMs }).then(() => true, () => false);
    const bootMs = Date.now() - t0;
    let fps = null, heapMB = null, stats = null, ctxFrames = null;
    if (booted) {
      // Same measurement as test/runtime-perf.test.mjs: let the runtime render a
      // fixed number of frames (warm-up + LOD controller settle), then read its
      // own frame_ms_avg. Budget there is frame_ms_avg < 50ms, i.e. >= 20 fps.
      const warm = Date.now();
      while (Date.now() - warm < 45000) {
        const n = await page.eval("try { return window.__rt.stats().samples || 0; } catch (e) { return 0; }").catch(() => 0);
        if (n >= 120) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const rs = await page.eval("try { const s = window.__rt.stats(); return { fps_avg: s.fps_avg, frame_ms_avg: s.frame_ms_avg, samples: s.samples }; } catch (e) { return null; }").catch(() => null);
      const raf = await page.eval(`return await new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < ${thresholds.browserSampleMs}) requestAnimationFrame(f); else res(n * 1000 / (performance.now() - t)); }; requestAnimationFrame(f); });`);
      fps = rs && Number.isFinite(rs.frame_ms_avg) && rs.frame_ms_avg > 0 ? 1000 / rs.frame_ms_avg : raf;
      ctxFrames = { runtime: rs, raf_fps: raf && Number(raf.toFixed(1)), source: rs && Number.isFinite(rs.frame_ms_avg) ? "runtime.stats().frame_ms_avg after >=120 frames" : "requestAnimationFrame sample" };
      heapMB = await page.eval("return performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null;");
      stats = await page.eval("try { return window.__rt.stats(); } catch (e) { return null; }").catch(() => null);
    }
    const consoleErrors = page.consoleLogs.filter((l) => l.type === "error").map((l) => l.text);
    const benign = (u) => /\/companion$|\/favicon\.ico$/.test(u || "");
    const requestFailures = page.requestFailures.filter((r) => !benign(r.url));
    return {
      ok: true,
      evidence: {
        site, booted, boot_ms: bootMs, fps: fps && Number(fps.toFixed(1)), frames: ctxFrames, heap_mb: heapMB && Number(heapMB.toFixed(1)),
        page_errors: page.pageErrors.slice(0, 10), console_errors: consoleErrors.slice(0, 10), request_failures: requestFailures.slice(0, 10),
        bad_responses: page.responses.filter((r) => r.status >= 400 && !benign(r.url)).slice(0, 10),
        runtime_stats: stats && { structures: stats.structures, drawCalls: stats.drawCalls ?? stats.draw_calls, instances: stats.instances },
      },
    };
  } catch (e) {
    return { ok: false, reason: "browser run failed: " + String(e?.message || e).slice(0, 200) };
  } finally {
    try { await browser?.close(); } catch {}
    await srv.close(); await api.close();
  }
}

function browserGates(probe, T) {
  const e = probe.evidence;
  const errs = [...e.page_errors, ...e.console_errors];
  return [
    gate("fps", e.booted && e.fps >= T.minFps ? STATUS.PASS : STATUS.FAIL, { fps: e.fps, min: T.minFps, frames: e.frames, renderer: "headless Chrome + swiftshader (software GL)" }, e.booted ? (e.fps >= T.minFps ? null : `fps ${e.fps} < ${T.minFps}`) : "runtime did not boot"),
    gate("memory", e.booted && e.heap_mb !== null && e.heap_mb <= T.maxHeapMB ? STATUS.PASS : e.heap_mb === null && e.booted ? STATUS.SKIPPED : STATUS.FAIL, { heap_mb: e.heap_mb, max_mb: T.maxHeapMB }, e.heap_mb === null ? (e.booted ? "performance.memory unavailable" : "runtime did not boot") : e.heap_mb > T.maxHeapMB ? `heap ${e.heap_mb}MB > ${T.maxHeapMB}MB` : null),
    gate("console_errors", e.booted && errs.length <= T.maxConsoleErrors ? STATUS.PASS : STATUS.FAIL, { page_errors: e.page_errors, console_errors: e.console_errors, max: T.maxConsoleErrors }, !e.booted ? "runtime did not boot" : errs.length > T.maxConsoleErrors ? `${errs.length} error(s)` : null),
  ];
}

// ------------------------------------------------------------------ runner

/**
 * @param manifest WorldManifestV3
 * @param {object} opts
 *   modules    pre-loaded modules (tests inject); default loadGamescModules()
 *   env        default process.env (DCS_GAMESC_BROWSER_GATES=1 enables browser gates)
 *   thresholds overrides for DEFAULT_THRESHOLDS
 *   only       subset of GATES to run (others SKIPPED "not requested")
 *   workDir    staging registry root (default: temp dir, removed after)
 *   clock      () -> ISO string
 */
export async function runGates(manifest, opts = {}) {
  const env = opts.env || process.env;
  const T = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const clock = opts.clock || (() => new Date().toISOString());
  const mods = opts.modules || await loadGamescModules();
  mods.reasons = mods.reasons || {};
  const want = (g) => !opts.only || opts.only.includes(g);
  const started = clock();
  const results = [];
  const timed = async (name, fn) => {
    if (!want(name)) { results.push(skip(name, "not requested")); return; }
    const t = Date.now();
    let r;
    try { r = await fn(); } catch (e) { r = gate(name, STATUS.FAIL, { error: String(e?.message || e).slice(0, 300) }, "gate threw"); }
    r.duration_ms = Date.now() - t;
    results.push(r);
  };

  const m = manifest;
  const walk = simulatePlaythrough(m);
  const quests = simulateQuests(m, walk);
  const verdict = critique(m, { walk, quests });
  const ctx = {};

  await timed("launch", () => gateLaunch(m));
  await timed("navigation", () => gateNavigation(m));
  await timed("movement", () => gateMovement(m, walk, T));
  await timed("collision", () => gateCollision(m, walk));
  await timed("objective_reachability", () => gateObjectives(m, walk, quests));
  await timed("asset_load", () => gateAssetLoad(m));

  const bGates = ["fps", "memory", "console_errors"];
  if (bGates.some(want)) {
    if (!browserEnabled(env)) {
      for (const g of bGates) results.push(skip(g, "browser gates disabled; set DCS_GAMESC_BROWSER_GATES=1 (needs Chrome + frontend at DCS_SITE_DIR; loads three.js from cdnjs)"));
    } else {
      const probe = await (opts.browserProbe || runBrowserProbe)(m, { env, thresholds: T });
      if (!probe.ok) for (const g of bGates) results.push(skip(g, probe.reason));
      else {
        for (const r of browserGates(probe, T)) if (want(r.gate)) results.push(r);
        const launch = results.find((r) => r.gate === "launch");
        if (launch) {
          launch.evidence.browser = { booted: probe.evidence.booted, boot_ms: probe.evidence.boot_ms, request_failures: probe.evidence.request_failures, bad_responses: probe.evidence.bad_responses };
          if (!probe.evidence.booted) { launch.status = STATUS.FAIL; launch.reason = "runtime did not boot in browser"; }
        }
        const al = results.find((r) => r.gate === "asset_load");
        if (al && (probe.evidence.request_failures.length || probe.evidence.bad_responses.length)) {
          al.status = STATUS.FAIL; al.reason = "browser: asset/network request failed"; al.evidence.browser = { request_failures: probe.evidence.request_failures, bad_responses: probe.evidence.bad_responses };
        }
      }
    }
  }

  await timed("save_reload", () => gateSaveReload(m, mods));
  await timed("edit_retest", () => gateEditRetest(m, mods, T));
  await timed("publish_package", () => gatePublish(m, mods, verdict, ctx));
  await timed("reopen_published_preview", () => gateReopen(m, mods, ctx, opts));

  results.sort((a, b) => GATES.indexOf(a.gate) - GATES.indexOf(b.gate));
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = { pass: count(STATUS.PASS), fail: count(STATUS.FAIL), skipped: count(STATUS.SKIPPED), total: results.length };
  return {
    report_version: REPORT_VERSION,
    world_id: m?.world_id ?? null,
    manifest_hash: sha(stable(m)),
    started_at: started,
    finished_at: clock(),
    playtest_verdict: verdict.verdict,
    overall: summary.fail ? "FAIL" : summary.skipped ? "INCOMPLETE" : "PASS",
    summary,
    modules: Object.fromEntries(["patch", "memory", "publish", "companion", "multiplayer"].map((k) => [k, mods[k] ? "loaded" : (mods.reasons[k] || "absent")])),
    gates: results,
  };
}
