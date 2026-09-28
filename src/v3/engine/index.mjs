// GAMES-A — engine assembly: adapters + routes + budget + health, and the
// bridge that lets any engine task serve as a B1 `Lane` adapter.
import { GenerationEngine } from "./engine.mjs";
import { resolveRoutes } from "./routing.mjs";
import { localAdapters } from "./adapters/local.mjs";
import { openAiCompatibleAdapter } from "./adapters/openai-compatible.mjs";
import { googleAdapter } from "./adapters/google.mjs";
import { ltxAdapter, runwayAdapter, worldLabsAdapter, elevenLabsAdapter, hedraAdapter, external3dAdapter, kinixGatewayAdapter } from "./adapters/media-vendors.mjs";
import { STATUS } from "../providers/contract.mjs";
import { MANIFEST_LANE } from "./task-classes.mjs";

export { TASK, TASKS } from "./task-classes.mjs";
export { FAILURE } from "./failures.mjs";
export { ROUTING_MATRIX } from "./routing.mjs";

export function createAdapters() {
  return {
    openai: openAiCompatibleAdapter("openai"),
    deepseek: openAiCompatibleAdapter("deepseek"),
    cerebras: openAiCompatibleAdapter("cerebras"),
    together: openAiCompatibleAdapter("together"),
    google: googleAdapter(),
    ltx: ltxAdapter(),
    runway: runwayAdapter(),
    worldlabs: worldLabsAdapter(),
    elevenlabs: elevenLabsAdapter(),
    hedra: hedraAdapter(),
    "external-3d": external3dAdapter(),
    kinix: kinixGatewayAdapter(),
    ...localAdapters(),
  };
}

export function createGenerationEngine(opts = {}) {
  const env = opts.env || process.env;
  const adapters = opts.adapters || createAdapters();
  return new GenerationEngine({ ...opts, env, adapters, routes: opts.routes || resolveRoutes(env, adapters) });
}

/**
 * Wrap an engine task as a B1 ProviderAdapter so it can be dropped into an
 * existing `Lane` ahead of that lane's vendors. The lane's own deterministic
 * fallback stays where it is; this adapter reports UNAVAILABLE when no
 * external step of the route is usable, so the lane skips it cleanly.
 */
export function engineLaneAdapter(engine, task, { rank = 1, mapRequest = (r) => r, mapResult = (res) => res.assets[0]?.json ?? res.assets[0] } = {}) {
  return {
    name: `games-engine:${task}`,
    lane: MANIFEST_LANE[task],
    rank,
    isFallback: false,
    async status() {
      const route = engine.describe().routes[task] || [];
      return route.some((s) => !s.local && s.configured && !s.circuit_open) ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
    },
    async invoke(req) {
      const res = await engine.run(task, mapRequest(req));
      if (res.provenance.status === "FALLBACK") throw new Error(`games-engine:${task} reached its local step; deferring to the lane's own fallback`);
      const value = mapResult(res);
      return { ...value, _model: `${res.provenance.provider}:${res.provenance.model}`, _engine: { request_id: res.request.request_id, asset_ids: res.assets.map((a) => a.asset_id), cost_usd: res.cost_usd } };
    },
  };
}

/**
 * An engine result as a GAMES-B `ProvenanceStage` (src/gamesb/CONTRACT.md §8),
 * so the world pipeline can record engine calls without knowing the engine.
 */
export function toProvenanceStage(res, stage) {
  const p = res.provenance, u = p.usage || {};
  const tin = u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount;
  const tout = u.completion_tokens ?? u.output_tokens ?? u.candidatesTokenCount;
  return {
    stage, lane: MANIFEST_LANE[p.task], provider: p.provider, model: p.model || "deterministic",
    status: p.status, latency_ms: p.latency_ms, cost_usd: p.cost_usd,
    ...(Number.isFinite(tin) && Number.isFinite(tout) ? { tokens: { in: tin, out: tout } } : {}),
    ...(res.attempts.length ? { after_failed: res.attempts.map((a) => a.provider) } : {}),
    at: p.at,
  };
}
