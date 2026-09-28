// Games-B LLM plumbing shared by the concept and gameplay stages. NODE-ONLY.
//
// Both stages use the same shape: a `Lane` whose first adapter asks Cerebras
// gpt-oss-120b for strict JSON, and whose last adapter is the deterministic
// local generator. The model's answer is never trusted as-is — each stage
// repairs it onto its deterministic result and re-validates — so this file only
// owns transport, status and cost accounting.
import { STATUS, ProviderError, chatCompletion, parseJsonLoose, offline } from "../../v3/providers/contract.mjs";

// Same key names text.mjs reads for Cerebras. Duplicated rather than imported
// because text.mjs does not export its vendor table.
export const CEREBRAS = Object.freeze({
  baseUrl: "https://api.cerebras.ai/v1",
  model: "gpt-oss-120b",
  keys: ["CEREBRAS_API_KEY", "CEREBRAS_API_KEY_1", "CEREBRAS_KEY_2", "CEREBRAS_API_KEY_2"],
});

// ESTIMATES, not billing truth: Cerebras' published list price for
// gpt-oss-120b as last checked (USD per million tokens). The provenance record
// labels cost as an estimate; reconcile against the vendor invoice.
export const PRICE_PER_MTOK = Object.freeze({
  "gpt-oss-120b": { in: 0.25, out: 0.69 },
});

export function estimateCostUsd(model, tokens) {
  const p = PRICE_PER_MTOK[model] || PRICE_PER_MTOK["gpt-oss-120b"];
  if (!tokens) return 0;
  return Math.round(((tokens.in * p.in + tokens.out * p.out) / 1e6) * 1e6) / 1e6;
}

function keyed(env, names) {
  for (const n of names) {
    const v = env?.[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "";
}

/**
 * A Cerebras JSON adapter. `chat` is injectable so tests can feed it messy,
 * partial or truncated model text without a network; an injected transport is
 * always AVAILABLE because the test, not the environment, controls it.
 * The adapter returns the loosely-parsed object; the stage repairs it.
 */
export function cerebrasJsonAdapter({ lane, system, build, env = process.env, chat = null, rank = 10, maxTokens = 4000, temperature = 0.6, name }) {
  const apiKey = chat ? "" : keyed(env, CEREBRAS.keys);
  const provider = name || `cerebras:${CEREBRAS.model}`;
  return {
    name: provider,
    lane,
    rank,
    model: CEREBRAS.model,
    isFallback: false,
    async status() {
      if (chat) return STATUS.AVAILABLE;
      if (offline(env)) return STATUS.UNAVAILABLE;   // CI and tests never spend money
      return apiKey ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
    },
    async invoke(req, ctx) {
      const call = chat || ((args) => chatCompletion({ ...args, baseUrl: CEREBRAS.baseUrl, apiKey }));
      const { text, model: usedModel, usage } = await call({
        model: CEREBRAS.model, system, user: build(req, ctx),
        maxTokens, temperature, json: true, providerName: provider,
      });
      const parsed = parseJsonLoose(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ProviderError(provider, "response was not a usable JSON object", { retryable: false });
      }
      parsed._model = usedModel || CEREBRAS.model;
      parsed._usage = usage || null;
      return parsed;
    },
  };
}

/** A deterministic fallback adapter wrapping a local generator. */
export function localAdapter({ lane, name, produce }) {
  return {
    name, lane, rank: 99, isFallback: true, model: "deterministic",
    async status() { return STATUS.FALLBACK; },
    async invoke(req) { return produce(req); },
  };
}

/** Normalise OpenAI-style usage into §8 tokens, or undefined when absent. */
export function tokensFrom(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const tin = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const tout = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  return { in: tin, out: tout };
}

/** Build a §8 ProvenanceStage from a Lane.run provenance record. */
export function stageProvenance(stage, runProv, { usage, model, statusOverride, extraFailed, billed } = {}) {
  const tokens = tokensFrom(usage);
  const failed = [...(runProv.after_failed || []), ...(extraFailed || [])];
  const status = statusOverride || runProv.status;
  const m = model || runProv.model || "deterministic";
  // `billed`: a model was called even though its answer was not used, so the
  // call still cost money and the record must say so.
  const paid = status === STATUS.AVAILABLE || billed === true;
  return {
    stage,
    lane: runProv.lane,
    provider: runProv.provider,
    model: m,
    status,
    latency_ms: runProv.latency_ms ?? 0,
    cost_usd: paid ? estimateCostUsd(billed ? runProv.model || m : m, tokens) : 0,
    cost_is_estimate: true,
    ...(tokens && paid ? { tokens } : {}),
    ...(failed.length ? { after_failed: failed } : {}),
    at: runProv.at || new Date().toISOString(),
  };
}

/** Ensure an injected adapter list still ends in the deterministic fallback. */
export function withFallback(adapters, fallback) {
  const list = [...adapters];
  if (!list.some((a) => a.isFallback)) list.push(fallback);
  return list;
}

/** snake_case id from arbitrary text. */
export function slugify(s, fallback = "item") {
  const v = String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/g, "");
  if (!v) return fallback;
  return /^[a-z]/.test(v) ? v : `${fallback}_${v}`;
}
