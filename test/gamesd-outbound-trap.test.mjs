// Games-D staging prep: DCS_GAMES_ENGINE_EXTERNAL stays off, the build makes
// zero outbound calls, and provenance says local_fallback and nothing else.
//
// The sample builds run with a hostile environment on purpose: fake provider
// keys, DCS_PROVIDERS_ONLINE=1, NODE_ENV=production, no DCS_PROVIDERS_OFFLINE,
// and DCS_GAMES_ENGINE_EXTERNAL=1. If anything in the engine read the process
// env instead of OFFLINE_ENV, a provider adapter would try the network and the
// trap would record it.
import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import childProcess from "node:child_process";

import { buildFromRecipe, GENERATION } from "../src/gamesd/engine.mjs";
import { resolveEngineExternal, ENGINE_EXTERNAL_APPROVED, LOCAL_FALLBACK_PROVIDER } from "../src/gamesd/engine-flags.mjs";
import { installOutboundTrap, OutboundBlocked } from "../src/gamesd/quality/outbound-trap.mjs";
import { SAMPLE_RECIPES } from "../src/gamesd/samples/catalogue.mjs";
import { toManifestV3 } from "../src/gamesb/runtime/to-manifest-v3.mjs";

const HOSTILE_ENV = {
  DCS_GAMES_ENGINE_EXTERNAL: "1",
  DCS_PROVIDERS_ONLINE: "1",
  NODE_ENV: "production",
  CEREBRAS_API_KEY: "trap-not-a-key",
  TOGETHER_API_KEY: "trap-not-a-key",
  DEEPSEEK_API_KEY: "trap-not-a-key",
  KINIX_API_KEY: "trap-not-a-key",
  DCS_KINIX_URL: "https://kinix.trap.invalid",
  DCS_ASSET3D_URL: "https://asset3d.trap.invalid",
  DCS_ASSET3D_KEY: "trap-not-a-key",
  DCS_SPATIAL_URL: "https://spatial.trap.invalid",
  DCS_SPATIAL_KEY: "trap-not-a-key",
};

function withEnv(patch, fn) {
  const saved = {};
  for (const k of [...Object.keys(patch), "DCS_PROVIDERS_OFFLINE"]) saved[k] = process.env[k];
  delete process.env.DCS_PROVIDERS_OFFLINE;
  Object.assign(process.env, patch);
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return Promise.resolve().then(fn).finally(restore);
}

// Names that would mean a package claims (or implies) external model generation.
// ("together" only as the provider id: it is also an ordinary word in NPC text.)
const EXTERNAL_CLAIM = /\b(ai[- ]generated|generated (by|with) ai|powered by|gpt-|cerebras|together(\.ai|:|_api)|openai|anthropic|claude|gemini|deepseek|kinix|flux\.1|meshy|tripo)\b/i;
const LOCAL_PROVIDER = /^(local(:[a-z-]+)?|authored)$/;

test("DCS_GAMES_ENGINE_EXTERNAL: off by default, any request refused, not approvable by env", () => {
  assert.equal(ENGINE_EXTERNAL_APPROVED, false);
  for (const v of [undefined, "", "0", " 0 "]) {
    const r = resolveEngineExternal(v === undefined ? {} : { DCS_GAMES_ENGINE_EXTERNAL: v });
    assert.equal(r.requested, false, JSON.stringify(v));
    assert.equal(r.enabled, false);
    assert.equal(r.reason, null);
  }
  for (const v of ["1", "true", "yes", "on", "2"]) {
    const r = resolveEngineExternal({ DCS_GAMES_ENGINE_EXTERNAL: v });
    assert.equal(r.requested, true, v);
    assert.equal(r.enabled, false, v);
    assert.match(r.reason, /refused/);
  }
});

test("outbound trap: positive control records and refuses every route", async () => {
  const trap = installOutboundTrap();
  try {
    await assert.rejects(fetch("https://example.invalid/x"), OutboundBlocked);
    assert.throws(() => https.request("https://example.invalid/y"), OutboundBlocked);
    assert.throws(() => net.connect({ host: "example.invalid", port: 443 }), OutboundBlocked);
    assert.throws(() => dns.lookup("example.invalid", () => {}), OutboundBlocked);
    assert.throws(() => childProcess.spawn("curl", ["https://example.invalid"]), OutboundBlocked);
    const { request } = await import("node:https");   // named ESM binding sees the patch too
    assert.throws(() => request("https://example.invalid/z"), OutboundBlocked);
  } finally { trap.restore(); }
  assert.deepEqual(trap.calls.map((c) => c.api), ["fetch", "https.request", "net.connect", "dns.lookup", "child_process.spawn", "https.request"]);
  assert.ok(trap.apis.length >= 20, `only ${trap.apis.length} routes trapped`);
  assert.notEqual(globalThis.fetch.name, "blocked", "fetch was not restored");
});

test("all sample games build under a hostile env with zero outbound calls and truthful provenance", { timeout: 600000 }, async () => {
  await withEnv(HOSTILE_ENV, async () => {
    const trap = installOutboundTrap();
    const built = [];
    try {
      for (const recipe of SAMPLE_RECIPES) built.push([recipe.id, await buildFromRecipe(recipe)]);
    } finally { trap.restore(); }

    assert.deepEqual(trap.calls, [], `outbound attempts: ${JSON.stringify(trap.calls)}`);
    assert.equal(built.length, SAMPLE_RECIPES.length);
    for (const [id, r] of built) {
      assert.ok(r.ok, `${id} not ok`);
      assert.equal(r.provider, LOCAL_FALLBACK_PROVIDER, id);
      assert.equal(r.engine_external.requested, true, id);
      assert.equal(r.engine_external.enabled, false, id);
      assert.ok(r.notes.some((n) => /DCS_GAMES_ENGINE_EXTERNAL.*refused/.test(n)), `${id}: refusal not reported`);

      const { pkg } = r;
      assert.deepEqual(pkg.generation, { ...GENERATION }, id);
      assert.equal(pkg.generation.provider, "local_fallback");
      for (const s of pkg.provenance.stages) {
        assert.match(s.provider, LOCAL_PROVIDER, `${id}: stage ${s.stage} provider ${s.provider}`);
        assert.ok(["AVAILABLE", "FALLBACK", "CACHED"].includes(s.status), `${id}: ${s.stage} ${s.status}`);
        assert.ok(s.model === null || ["deterministic", "human", "content-addressed"].includes(s.model), `${id}: ${s.stage} model ${s.model}`);
        assert.equal(s.cost_usd, 0, `${id}: ${s.stage} cost`);
      }
      for (const rec of pkg.assets.records) {
        assert.match(rec.provenance?.adapter ?? rec.provider ?? "local", LOCAL_PROVIDER, `${id}: asset ${rec.asset_id}`);
      }
      // Nothing outside the stage list's after_failed names a provider or claims AI generation.
      const { provenance, ...rest } = pkg;
      const scrubbed = JSON.stringify(rest, (k, v) => (k === "after_failed" ? undefined : v));
      assert.doesNotMatch(scrubbed, EXTERNAL_CLAIM, `${id}: package text implies external generation`);
      const m = toManifestV3(pkg);
      for (const g of m.provenance.generated_by) assert.match(g.provider, LOCAL_PROVIDER, `${id}: manifest ${g.stage}`);
    }
  });
});

test("the package bytes do not depend on DCS_GAMES_ENGINE_EXTERNAL", async () => {
  const recipe = SAMPLE_RECIPES[0];
  const off = await buildFromRecipe(recipe, { playtest: false, env: { DCS_GAMES_ENGINE_EXTERNAL: "0" } });
  const on = await buildFromRecipe(recipe, { playtest: false, env: { DCS_GAMES_ENGINE_EXTERNAL: "1" } });
  assert.equal(off.pkg.integrity.sha256, on.pkg.integrity.sha256);
  assert.equal(off.notes.length + 1, on.notes.length);
});

test("control: the hostile env without Games-D's OFFLINE_ENV does reach for the network, and the trap catches it", { timeout: 120000 }, async () => {
  // Proves the zero above is the engine's doing, not a trap that sees nothing.
  const { buildGame } = await import("../src/gamesb/pipeline.mjs");
  await withEnv(HOSTILE_ENV, async () => {
    const trap = installOutboundTrap();
    const warn = console.warn;
    console.warn = () => {};   // the lanes log each refused adapter; expected here
    try {
      await buildGame("a small island with a lighthouse", { seed: 1, env: process.env, playtest: false, createdAt: "2026-09-29T00:00:00.000Z" });
    } finally { console.warn = warn; trap.restore(); }
    assert.ok(trap.calls.length > 0, "hostile env produced no outbound attempt; the trap test would be vacuous");
    assert.ok(trap.calls.every((c) => c.api === "fetch"), JSON.stringify(trap.calls));
  });
});
