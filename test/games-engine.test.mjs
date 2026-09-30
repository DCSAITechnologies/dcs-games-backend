// GAMES-A — the generation engine: routing, fallback, retries, budgets,
// health, provenance, redaction, and each adapter's wire shape.
//
// Entirely offline. Every external call goes to a fake fetch that records what
// it was sent; no test spends money or touches a network.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createGenerationEngine, createAdapters, engineLaneAdapter, TASK, TASKS, FAILURE, ROUTING_MATRIX } from "../src/v3/engine/index.mjs";
import { resolveRoutes } from "../src/v3/engine/routing.mjs";
import { requestMetadata, assetId, canonicalJson } from "../src/v3/engine/provenance.mjs";
import { redact } from "../src/v3/engine/redact.mjs";
import { classify, classifyHttp, GenerationError } from "../src/v3/engine/failures.mjs";
import { BudgetLedger } from "../src/v3/engine/budget.mjs";
import { HealthRegistry } from "../src/v3/engine/health.mjs";
import { estimateUsd } from "../src/v3/engine/pricing.mjs";
import { Lane } from "../src/v3/providers/contract.mjs";

// The timeout tests wait on nothing but AbortSignal.timeout(), whose timer is
// unref'd by design. In a server a listening socket keeps the loop alive; here
// nothing does, and Node 22 (the deploy runtime, nixpacks nodejs_22) then
// cancels the test mid-await, and every test after it, with "Promise
// resolution is still pending but the event loop has already resolved". Node
// 25 happened not to. Hold one ref'd handle for the life of this file.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const FAKE_KEY = "fixture-openai-key-0123456789abcdef";
const ONLINE = { DCS_PROVIDERS_ONLINE: "1" };
const quietLogger = { log() {}, warn() {}, error() {} };

/** A fake fetch driven by a list of handlers: (url, init) => {status, json|text|bytes, headers}. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.signal?.aborted) throw init.signal.reason;
    const r = await handler(String(url), init, calls.length);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null },
      text: async () => text, json: async () => JSON.parse(text),
      arrayBuffer: async () => (r.bytes || Buffer.from(text)).buffer.slice(0),
    };
  };
  fn.calls = calls;
  return fn;
}

const chatOk = (obj) => ({ json: { model: "m", choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 1000, completion_tokens: 2000 } } });
const WORLD = { zones: [{ id: "harbour", name: "Harbour", kind: "district", bounds: [0, 0, 100, 100] }], structures: [{ id: "tavern", zone: "harbour", archetype: "tavern", position: { x: 5, y: 0, z: 5 } }] };

function engine({ env = {}, fetchImpl, routes, budget, health, sleeps } = {}) {
  return createGenerationEngine({
    env: { ...ONLINE, ...env }, fetchImpl, routes, budget, health, logger: quietLogger,
    sleepImpl: async (ms) => { sleeps?.push(ms); },
  });
}

// ------------------------------------------------------------------ matrix

test("every task class has primary, fallback 1, fallback 2 and a local step, all registered", () => {
  const adapters = createAdapters();
  assert.deepEqual(Object.keys(ROUTING_MATRIX).sort(), [...TASKS].sort());
  for (const task of TASKS) {
    const route = ROUTING_MATRIX[task];
    assert.equal(route.length, 4, `${task} should have exactly 4 steps`);
    for (const s of route) {
      assert.ok(adapters[s.provider], `${task}: ${s.provider} is not registered`);
      assert.ok(adapters[s.provider].tasks.includes(task), `${task}: ${s.provider} does not serve it`);
    }
    assert.ok(adapters[route[3].provider].isLocal, `${task}: last step must be local`);
    assert.ok(route.slice(0, 3).every((s) => !adapters[s.provider].isLocal), `${task}: first three steps must be external`);
  }
});

test("retired endpoints are not routed: no Sora, no Imagen", () => {
  const flat = JSON.stringify(ROUTING_MATRIX);
  assert.doesNotMatch(flat, /sora|imagen/i);
});

test("route overrides are applied, unknown providers dropped, local step kept", () => {
  const adapters = createAdapters();
  const r = resolveRoutes({ DCS_GAMES_ROUTE_TEXTURE: "google:gemini-3.1-flash-image,nonsense:x" }, adapters);
  assert.deepEqual(r.TEXTURE.map((s) => s.provider), ["google", "local:procedural-texture"]);
  assert.equal(r.TEXTURE[0].model, "gemini-3.1-flash-image");
  assert.equal(r.WORLD_DESIGN.length, 4);
});

// ------------------------------------------------------- offline fallback

test("offline: every task class still produces a result from its local step, at zero cost", async () => {
  const f = fakeFetch(() => { throw new Error("must not be called"); });
  const e = createGenerationEngine({ env: { DCS_PROVIDERS_OFFLINE: "1", OPENAI_API_KEY: FAKE_KEY }, fetchImpl: f, logger: quietLogger });
  for (const task of TASKS) {
    const res = await e.run(task, { prompt: "a rainy nordic port town", worldId: "w1", seed: 7, ...WORLD });
    assert.equal(res.provenance.status, "FALLBACK", task);
    assert.equal(res.cost_usd, 0, task);
    assert.ok(res.assets.length >= 1, task);
    assert.match(res.assets[0].asset_id, /^ga_[a-z0-9]+_[0-9a-f]{24}$/, task);
    assert.ok(res.attempts.every((a) => a.class === FAILURE.NOT_CONFIGURED), task);
  }
  assert.equal(f.calls.length, 0);
});

test("offline results are deterministic: same request, same request_id, same asset ids, same content", async () => {
  const e = createGenerationEngine({ env: { DCS_PROVIDERS_OFFLINE: "1" }, logger: quietLogger });
  const req = { prompt: "ash desert outpost", worldId: "w2", seed: 11, ...WORLD };
  for (const task of [TASK.WORLD_DESIGN, TASK.TEXTURE, TASK.SPATIAL_3D, TASK.CHARACTER]) {
    const a = await e.run(task, req), b = await e.run(task, req);
    assert.equal(a.request.request_id, b.request.request_id);
    assert.deepEqual(a.assets.map((x) => x.asset_id), b.assets.map((x) => x.asset_id));
    assert.deepEqual(a.assets.map((x) => x.content_sha256), b.assets.map((x) => x.content_sha256));
  }
});

// ------------------------------------------------------------- provenance

test("request metadata is key-order independent and changes when the request changes", () => {
  const a = requestMetadata(TASK.WORLD_DESIGN, { prompt: "x", seed: 1, worldId: "w" });
  const b = requestMetadata(TASK.WORLD_DESIGN, { worldId: "w", seed: 1, prompt: "x" });
  const c = requestMetadata(TASK.WORLD_DESIGN, { prompt: "y", seed: 1, worldId: "w" });
  const d = requestMetadata(TASK.TEXTURE, { prompt: "x", seed: 1, worldId: "w" });
  assert.equal(a.request_id, b.request_id);
  assert.notEqual(a.request_id, c.request_id);
  assert.notEqual(a.request_id, d.request_id);
  assert.match(a.request_id, /^gr_wd_[0-9a-f]{24}$/);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.notEqual(assetId("TEXTURE", "r", "google", "m", 0), assetId("TEXTURE", "r", "together", "m", 0));
});

test("an attached image contributes its hash to the fingerprint, never its bytes", () => {
  const m = requestMetadata(TASK.IMAGE_ASSET, { prompt: "x", image: { dataUrl: "data:image/png;base64,AAAA" } });
  assert.doesNotMatch(JSON.stringify(m), /AAAA/);
});

// ------------------------------------------------------ fallthrough/retry

test("a 5xx is retried once at the same provider, then the route falls through", async () => {
  const sleeps = [];
  const e = engine({ env: { OPENAI_API_KEY: FAKE_KEY, GEMINI_API_KEY: "fixture-gemini-key-0123456789" }, fetchImpl: fakeFetch((url) => {
    if (url.includes("openai")) return { status: 503, text: "overloaded" };
    return { json: { candidates: [{ content: { parts: [{ text: JSON.stringify({ zones: WORLD.zones, structures: WORLD.structures }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } } };
  }), sleeps });
  const res = await e.run(TASK.WORLD_DESIGN, { prompt: "harbour", worldId: "w" });
  assert.equal(res.provenance.provider, "google");
  assert.equal(res.provenance.route_position, 1);
  assert.equal(res.attempts[0].provider, "openai");
  assert.equal(res.attempts[0].class, FAILURE.UPSTREAM_5XX);
  assert.equal(res.attempts[0].tries, 2);
  assert.equal(sleeps.length, 1);
  assert.deepEqual(res.provenance.after, ["openai:UPSTREAM_5XX"]);
});

test("429 honours retry-after (capped) before retrying", async () => {
  const sleeps = [];
  let n = 0;
  const e = engine({ env: { CEREBRAS_API_KEY: "fixture-cerebras-0123456789" }, sleeps, fetchImpl: fakeFetch(() => (++n === 1 ? { status: 429, headers: { "retry-after": "2" }, text: "slow down" } : chatOk({ genre: "x", tags: [] }))) });
  const res = await e.run(TASK.FAST_ITERATION, { prompt: "p" });
  assert.equal(res.provenance.provider, "cerebras");
  assert.equal(res.provenance.tries, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("billed job creations are never retried: an image 5xx falls straight through", async () => {
  const e = engine({ env: { GEMINI_API_KEY: "fixture-gemini-key-0123456789", OPENAI_API_KEY: FAKE_KEY }, fetchImpl: fakeFetch((url) => {
    if (url.includes("googleapis")) return { status: 500, text: "boom" };
    return { json: { data: [{ b64_json: "iVBORw0KGgo=" }] } };
  }) });
  const res = await e.run(TASK.IMAGE_ASSET, { prompt: "key art" });
  assert.equal(res.attempts[0].tries, 1);
  assert.equal(res.provenance.provider, "openai");
  assert.match(res.assets[0].uri, /^data:image\/png;base64,/);
});

test("a timeout is not retried and its estimate stays charged (possible spend)", async () => {
  const budget = new BudgetLedger({ perRequestUsd: 5, perWorldUsd: 10, perDayUsd: 10 });
  const e = engine({ env: { OPENAI_API_KEY: FAKE_KEY }, budget, fetchImpl: fakeFetch((url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)))) });
  const res = await e.run(TASK.WORLD_DESIGN, { prompt: "p", worldId: "wt", attemptTimeoutMs: 20 });
  assert.equal(res.attempts[0].class, FAILURE.TIMEOUT);
  assert.equal(res.attempts[0].tries, 1);
  assert.equal(res.provenance.status, "FALLBACK");
  assert.ok(budget.spentWorld("wt") > 0, "timed-out spend must remain charged");
});

test("a content-policy refusal stops the route: no vendor shopping, no fallback", async () => {
  const f = fakeFetch((url) => url.includes("openai") ? { status: 400, text: '{"error":{"code":"content_policy_violation"}}' } : chatOk({}));
  const e = engine({ env: { OPENAI_API_KEY: FAKE_KEY, GEMINI_API_KEY: "fixture-gemini-key-0123456789" }, fetchImpl: f });
  await assert.rejects(e.run(TASK.WORLD_DESIGN, { prompt: "p" }), (err) => {
    assert.equal(err.failureClass, FAILURE.CONTENT_POLICY);
    assert.equal(err.attempts.length, 1);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("an invalid model answer is INVALID_OUTPUT and falls through", async () => {
  const e = engine({ env: { CEREBRAS_API_KEY: "fixture-cerebras-0123456789" }, fetchImpl: fakeFetch(() => ({ json: { choices: [{ message: { content: "sorry, no json" } }] } })) });
  const res = await e.run(TASK.FAST_ITERATION, { prompt: "p" });
  assert.equal(res.attempts[0].class, FAILURE.INVALID_OUTPUT);
  assert.equal(res.provenance.provider, "local:keyword-classifier");
});

// ---------------------------------------------------------------- health

test("AUTH opens the circuit at once; the next request skips the provider without calling it", async () => {
  const health = new HealthRegistry();
  const f = fakeFetch(() => ({ status: 401, text: "bad key" }));
  const e = engine({ env: { CEREBRAS_API_KEY: "fixture-cerebras-0123456789" }, fetchImpl: f, health });
  await e.run(TASK.FAST_ITERATION, { prompt: "a" });
  const before = f.calls.length;
  const res = await e.run(TASK.FAST_ITERATION, { prompt: "b" });
  assert.equal(f.calls.length, before);
  assert.equal(res.attempts[0].class, FAILURE.CIRCUIT_OPEN);
  assert.equal(health.snapshot().cerebras.circuit, "open");
});

test("circuit half-opens after cooldown and closes on success", () => {
  let t = 0;
  const h = new HealthRegistry({ failureThreshold: 2, cooldownMs: 1000, now: () => t });
  h.recordFailure("p", FAILURE.UPSTREAM_5XX); h.recordFailure("p", FAILURE.UPSTREAM_5XX);
  assert.equal(h.canCall("p"), false);
  t = 1001;
  assert.equal(h.canCall("p"), true);
  h.recordSuccess("p", 50);
  assert.equal(h.snapshot().p.circuit, "closed");
  h.recordFailure("q", FAILURE.BAD_REQUEST);
  assert.equal(h.snapshot().q, undefined, "a 4xx about the request is not a provider-health failure");
});

// ---------------------------------------------------------------- budget

test("a provider whose estimate breaks the budget is skipped for a cheaper step", async () => {
  const budget = new BudgetLedger({ perRequestUsd: 0.5, perWorldUsd: 1, perDayUsd: 5 });
  const f = fakeFetch(() => { throw new Error("must not be called"); });
  const e = engine({ env: { WORLDLABS_API_KEY: "fixture-wlt-key-0123456789" }, fetchImpl: f, budget });
  const res = await e.run(TASK.SPATIAL_3D, { prompt: "island", worldId: "wb" }).catch((x) => x);
  // marble-1.1 (~$1.26) is refused on the per-request cap; marble-1.0-draft (~$0.20) fits and is tried.
  assert.equal(res.attempts?.[0]?.class ?? null, FAILURE.BUDGET_EXCEEDED);
  assert.ok(f.calls.length >= 1 && f.calls[0].body.model === "marble-1.0-draft");
});

test("budget ledger: reserve, settle to actual, release on failure, daily cap", () => {
  const b = new BudgetLedger({ perRequestUsd: 1, perWorldUsd: 2, perDayUsd: 2.5 });
  const r1 = b.reserve({ worldId: "w", requestId: "r", provider: "p", model: "m", estimateUsd: 0.9 });
  b.settle(r1, 0.4);
  assert.equal(+b.spentWorld("w").toFixed(2), 0.4);
  const r2 = b.reserve({ worldId: "w", requestId: "r", provider: "p", model: "m", estimateUsd: 0.9 });
  b.release(r2);
  assert.equal(+b.spentWorld("w").toFixed(2), 0.4);
  assert.throws(() => b.reserve({ worldId: "w", estimateUsd: 1.5 }), (e) => e.failureClass === FAILURE.BUDGET_EXCEEDED);
  b.settle(b.reserve({ worldId: "w2", estimateUsd: 1 }), 1);
  b.settle(b.reserve({ worldId: "w3", estimateUsd: 1 }), 1);
  assert.throws(() => b.reserve({ worldId: "w4", estimateUsd: 0.5 }), /daily spend/);
});

test("reported token usage settles cost; estimates are pessimistic", async () => {
  const e = engine({ env: { CEREBRAS_API_KEY: "fixture-cerebras-0123456789" }, fetchImpl: fakeFetch(() => chatOk({ genre: "g", tags: [] })) });
  const res = await e.run(TASK.FAST_ITERATION, { prompt: "p" });
  assert.equal(res.provenance.cost_basis, "reported");
  assert.equal(res.cost_usd, +((1000 * 0.35 + 2000 * 0.75) / 1e6).toFixed(6));
  assert.ok(estimateUsd("cerebras", "gpt-oss-120b", "FAST_ITERATION", { prompt: "p", maxTokens: 700 }) > 0);
  assert.ok(estimateUsd("unknown", "model", "SPATIAL_3D", {}) >= 1, "unknown 3D models are assumed expensive");
});

// ------------------------------------------------------------- redaction

test("no credential reaches attempts, errors or logs, even when a vendor echoes it", async () => {
  const lines = [];
  const logger = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const env = { ...ONLINE, OPENAI_API_KEY: FAKE_KEY, GEMINI_API_KEY: "fixture-gemini-key-0123456789" };
  const e = createGenerationEngine({ env, logger, sleepImpl: async () => {}, fetchImpl: fakeFetch((url, init) => ({ status: 502, text: `upstream saw Authorization: ${init.headers.Authorization || ""} key=${init.headers["x-goog-api-key"] || ""}` })) });
  const res = await e.run(TASK.WORLD_DESIGN, { prompt: "p" });
  const everything = JSON.stringify(res) + lines.join("\n");
  assert.doesNotMatch(everything, new RegExp(FAKE_KEY));
  assert.doesNotMatch(everything, /fixture-gemini-key-0123456789/);
  assert.match(everything, /REDACTED/);
});

test("redact masks generic credential shapes", () => {
  const s = redact("Bearer abcdefghijklmnop sk-proj-ABCDEFGHIJKLMNOP123 ?key=AIzaSyDUMMYDUMMYDUMMYDUMMY1234 \"api_key\":\"zzz\"", {});
  assert.doesNotMatch(s, /abcdefghijklmnop|ABCDEFGHIJKLMNOP123|AIzaSy|zzz/);
});

test("failure classification", () => {
  assert.equal(classifyHttp(401), FAILURE.AUTH);
  assert.equal(classifyHttp(429), FAILURE.RATE_LIMITED);
  assert.equal(classifyHttp(503), FAILURE.UPSTREAM_5XX);
  assert.equal(classifyHttp(400, "safety system rejected"), FAILURE.CONTENT_POLICY);
  assert.equal(classifyHttp(404), FAILURE.BAD_REQUEST);
  const t = classify(Object.assign(new Error("x"), { name: "TimeoutError" }));
  assert.equal(t.class, FAILURE.TIMEOUT); assert.equal(t.retryable, false);
  assert.equal(classify(new GenerationError(FAILURE.CONTENT_POLICY, "no")).fallthrough, false);
  assert.equal(classify(new TypeError("fetch failed")).class, FAILURE.NETWORK);
});

// ------------------------------------------------------------ wire shapes

test("openai: bearer auth, max_completion_tokens, no temperature, JSON mode", async () => {
  const f = fakeFetch(() => chatOk({ zones: WORLD.zones, structures: WORLD.structures }));
  const e = engine({ env: { OPENAI_API_KEY: FAKE_KEY }, fetchImpl: f });
  const res = await e.run(TASK.WORLD_DESIGN, { prompt: "p" });
  const c = f.calls[0];
  assert.equal(c.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(c.init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(c.body.model, "gpt-6-sol");
  assert.ok(c.body.max_completion_tokens > 0);
  assert.equal(c.body.temperature, undefined);
  assert.deepEqual(c.body.response_format, { type: "json_object" });
  assert.equal(res.assets[0].json.zones[0].id, "harbour");
});

test("google: key in x-goog-api-key header, never in the URL", async () => {
  const f = fakeFetch(() => ({ json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBOR" } }] } }] } }));
  const e = engine({ env: { GOOGLE_AI_API_KEY: "fixture-gemini-key-0123456789" }, fetchImpl: f });
  const res = await e.run(TASK.CHARACTER, { prompt: "a lighthouse keeper" });
  assert.match(f.calls[0].url, /models\/gemini-3-pro-image:generateContent$/);
  assert.doesNotMatch(f.calls[0].url, /key=/);
  assert.equal(f.calls[0].init.headers["x-goog-api-key"], "fixture-gemini-key-0123456789");
  assert.match(f.calls[0].body.contents[0].parts[0].text, /character concept sheet/i);
  assert.equal(res.assets[0].uri, "data:image/png;base64,iVBOR");
});

test("google veo: long-running operation is polled to completion", async () => {
  let polls = 0;
  const f = fakeFetch((url) => {
    if (url.endsWith(":predictLongRunning")) return { json: { name: "operations/abc" } };
    polls++;
    return { json: polls < 2 ? { done: false } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://files/v.mp4" } }] } } } };
  });
  const e = engine({ env: { GEMINI_API_KEY: "fixture-gemini-key-0123456789" }, fetchImpl: f });
  const res = await e.run(TASK.VIDEO_CINEMATIC, { prompt: "flyover", durationS: 8 });
  assert.equal(res.assets[0].uri, "https://files/v.mp4");
  assert.equal(res.provenance.upstream_job_id, "operations/abc");
  assert.equal(polls, 2);
});

test("runway: X-Runway-Version header, measured ratio, single /v1/tasks poll route", async () => {
  const f = fakeFetch((url) => url.endsWith("/v1/text_to_video") ? { json: { id: "11111111-1111-4111-8111-111111111111" } } : { json: { status: "SUCCEEDED", output: ["https://cdn/out.mp4"] } });
  const e = engine({ env: { RUNWAYML_API_SECRET: "fixture-runway-0123456789" }, fetchImpl: f, routes: { VIDEO_CINEMATIC: [{ provider: "runway", model: "gen4.5" }, { provider: "local:media-placeholder" }] } });
  const res = await e.run(TASK.VIDEO_CINEMATIC, { prompt: "p" });
  assert.equal(f.calls[0].init.headers["X-Runway-Version"], "2024-11-06");
  assert.equal(f.calls[0].body.ratio, "1280:720");
  assert.match(f.calls[1].url, /\/v1\/tasks\/11111111-/);
  assert.equal(res.assets[0].uri, "https://cdn/out.mp4");
});

test("ltx: completed with no video_url is a failure, not a success", async () => {
  const f = fakeFetch((url) => url.endsWith("/v2/text-to-video") ? { json: { id: "j1" } } : { json: { status: "completed", result: {} } });
  const e = engine({ env: { LTX_API_KEY: "fixture-ltx-0123456789" }, fetchImpl: f, routes: { VIDEO_CINEMATIC: [{ provider: "ltx", model: "ltx-2-5-fast" }, { provider: "local:media-placeholder" }] } });
  const res = await e.run(TASK.VIDEO_CINEMATIC, { prompt: "p" });
  assert.equal(res.attempts[0].class, FAILURE.JOB_FAILED);
  assert.equal(res.assets[0].placeholder, true);
});

test("world labs: WLT-Api-Key header, operation poll, assets read, credits costed", async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith("/worlds:generate")) return { json: { operation_id: "op1" } };
    if (url.includes("/operations/")) return { json: { done: true, metadata: { world_id: "wid" }, cost: { total_credits: 1580 } } };
    return { json: { assets: { mesh: { collider_mesh_url: "https://wl/c.glb" }, splats: { spz_urls: { "500k": "https://wl/s.spz" } } } } };
  });
  const e = engine({ env: { WORLDLABS_API_KEY: "fixture-wlt-key-0123456789" }, fetchImpl: f });
  const res = await e.run(TASK.SPATIAL_3D, { prompt: "floating island monastery", worldId: "w" });
  assert.equal(f.calls[0].init.headers["WLT-Api-Key"], "fixture-wlt-key-0123456789");
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(f.calls[0].body.world_prompt, { type: "text", text_prompt: "floating island monastery" });
  assert.equal(res.assets[0].uri, "https://wl/c.glb");
  assert.equal(res.provenance.cost_basis, "reported");
  assert.equal(res.cost_usd, +(1580 * 0.0008).toFixed(6));
});

test("elevenlabs: xi-api-key header and mp3 bytes as a data uri", async () => {
  const f = fakeFetch(() => ({ bytes: Buffer.from([0xff, 0xfb, 0x90]) }));
  const e = engine({ env: { ELEVENLABS_API_KEY: "fixture-eleven-0123456789" }, fetchImpl: f });
  const res = await e.run(TASK.VOICE_AUDIO, { text: "Welcome to Ashfall Harbour." });
  assert.equal(f.calls[0].init.headers["xi-api-key"], "fixture-eleven-0123456789");
  assert.match(f.calls[0].url, /text-to-speech\/.+output_format=mp3_44100_128/);
  assert.match(res.assets[0].uri, /^data:audio\/mpeg;base64,/);
});

test("placeholder credentials are treated as unset; hedra never dispatches", () => {
  const a = createAdapters();
  assert.equal(a.ltx.configured({ LTX_API_KEY: "changeme" }), false);
  assert.equal(a.hedra.configured({ HEDRA_API_KEY: "fixture-hedra-0123456789" }), false);
});

// ------------------------------------------------------------ B1 bridge

test("engine task drops into a B1 Lane ahead of that lane's own fallback", async () => {
  const f = fakeFetch(() => chatOk({ genre: "noir", tags: ["rain"], maturity: "13+", mood: "grim", summary: "s" }));
  const e = engine({ env: { CEREBRAS_API_KEY: "fixture-cerebras-0123456789" }, fetchImpl: f });
  const lane = new Lane("fast_inference", [
    engineLaneAdapter(e, TASK.FAST_ITERATION),
    { name: "local", rank: 99, isFallback: true, status: async () => "FALLBACK", invoke: async () => ({ genre: "local" }) },
  ]);
  const r = await lane.run({ prompt: "p" });
  assert.equal(r.value.genre, "noir");
  assert.match(r.value._model, /^cerebras:/);
  assert.match(r.value._engine.request_id, /^gr_fi_/);

  const off = createGenerationEngine({ env: { DCS_PROVIDERS_OFFLINE: "1" }, logger: quietLogger });
  const lane2 = new Lane("fast_inference", [engineLaneAdapter(off, TASK.FAST_ITERATION), { name: "local", rank: 99, isFallback: true, status: async () => "FALLBACK", invoke: async () => ({ genre: "local" }) }]);
  assert.equal((await lane2.run({ prompt: "p" })).value.genre, "local");
});

test("describe() reports routes, configuration and health without calling anything", () => {
  const f = fakeFetch(() => { throw new Error("must not be called"); });
  const e = engine({ env: { CEREBRAS_API_KEY: "fixture-cerebras-0123456789" }, fetchImpl: f });
  const d = e.describe();
  assert.equal(d.routes.FAST_ITERATION[0].configured, true);
  assert.equal(d.routes.WORLD_DESIGN[0].configured, false);
  assert.doesNotMatch(JSON.stringify(d), /fixture-cerebras/);
  assert.equal(f.calls.length, 0);
});

// ------------------------------------------------------------- benchmark

test("benchmark plan: no network, capped calls, cheapest first, every routed external pair", async () => {
  const { planBenchmark, runBenchmark, MAX_CALLS_PER_PAIR } = await import("../src/v3/engine/benchmark.mjs");
  const adapters = createAdapters();
  const f = fakeFetch(() => { throw new Error("must not be called"); });
  const plan = planBenchmark({ adapters, env: { CEREBRAS_API_KEY: "fixture-cerebras-0123456789" }, calls: 99 });
  assert.ok(plan.every((p) => p.calls === MAX_CALLS_PER_PAIR));
  assert.ok(plan.every((p, i) => i === 0 || plan[i - 1].est_usd_per_call <= p.est_usd_per_call));
  assert.ok(plan.some((p) => p.provider === "worldlabs" && p.model === "marble-1.0-draft"));
  assert.equal(plan.filter((p) => p.configured === "yes").every((p) => p.provider === "cerebras"), true);
  const rows = await runBenchmark({ adapters, env: {}, plan, live: false, fetchImpl: f });
  assert.ok(rows.every((r) => r.success === "NOT_RUN"));
  assert.equal(f.calls.length, 0);
});

test("benchmark live mode: one provider per call, drops a provider after AUTH, respects the USD cap", async () => {
  const { planBenchmark, runBenchmark } = await import("../src/v3/engine/benchmark.mjs");
  const adapters = createAdapters();
  const env = { ...ONLINE, CEREBRAS_API_KEY: "fixture-cerebras-0123456789", OPENAI_API_KEY: FAKE_KEY };
  const f = fakeFetch((url) => url.includes("openai") ? { status: 401, text: "bad" } : chatOk({ genre: "g", tags: ["t"], maturity: "13+", mood: "m", summary: "s" }));
  const plan = planBenchmark({ adapters, env, calls: 2, tasks: ["FAST_ITERATION", "WORLD_DESIGN"], providers: ["cerebras", "openai"] });
  const rows = await runBenchmark({ adapters, env, plan, live: true, maxUsd: 1, fetchImpl: f, logger: quietLogger });
  const openaiCalls = f.calls.filter((c) => c.url.includes("openai")).length;
  assert.equal(openaiCalls, 1, "AUTH must drop the provider after one call");
  const ok = rows.find((r) => r.task === "FAST_ITERATION" && r.provider === "cerebras" && r.success === "YES");
  assert.ok(ok && /^5\/5$/.test(ok.quality));
  assert.ok(rows.every((r) => !JSON.stringify(r).includes(FAKE_KEY)));
});

test("an engine result maps onto a GAMES-B ProvenanceStage", async () => {
  const { toProvenanceStage } = await import("../src/v3/engine/index.mjs");
  const e = engine({ env: { CEREBRAS_API_KEY: "fixture-cerebras-0123456789" }, fetchImpl: fakeFetch(() => chatOk({ genre: "g", tags: [] })) });
  const s = toProvenanceStage(await e.run(TASK.FAST_ITERATION, { prompt: "p" }), "concept");
  assert.deepEqual(Object.keys(s).sort(), ["at", "cost_usd", "lane", "latency_ms", "model", "provider", "stage", "status", "tokens"].sort());
  assert.equal(s.lane, "fast_inference");
  assert.deepEqual(s.tokens, { in: 1000, out: 2000 });
});
