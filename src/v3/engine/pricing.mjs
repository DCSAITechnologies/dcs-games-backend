// GAMES-A — list prices used for cost ESTIMATES (budget reservation) and for
// the cost matrix. Researched 28 Sep 2026 from vendor pricing pages; see
// docs/games-a/DCS_GAMES_PROVIDER_COST_MATRIX.csv for sources and confidence.
//
// These are estimates, not invoices. Where a provider reports cost or token
// usage in its response, the engine settles to that instead.
//
// unit:  tokens  -> in/out USD per 1M tokens
//        image   -> USD per image
//        second  -> USD per output second
//        kchars  -> USD per 1,000 input characters
//        gen     -> USD per generation (3D / world)

export const PRICES = Object.freeze({
  "openai:gpt-6-sol": { unit: "tokens", in: 2.0, out: 10.0 },
  "openai:gpt-6-astra": { unit: "tokens", in: 10.0, out: 50.0 },
  "openai:gpt-5.3-codex": { unit: "tokens", in: 1.75, out: 14.0 },
  "openai:gpt-5.4-mini": { unit: "tokens", in: 0.75, out: 4.5 },
  "openai:gpt-5.4-nano": { unit: "tokens", in: 0.2, out: 1.25 },
  "openai:gpt-image-1-mini": { unit: "image", usd: 0.04 },
  "openai:gpt-4o-mini-tts": { unit: "kchars", usd: 0.015 },
  "google:gemini-3.1-pro-preview": { unit: "tokens", in: 2.0, out: 12.0 },
  "google:gemini-3.8-flash": { unit: "tokens", in: 0.75, out: 3.75 },
  "google:gemini-3.5-flash-lite": { unit: "tokens", in: 0.3, out: 2.5 },
  "google:gemini-3.1-flash-image": { unit: "image", usd: 0.067 },
  "google:gemini-3-pro-image": { unit: "image", usd: 0.134 },
  "google:veo-3.1-fast-generate-preview": { unit: "second", usd: 0.12 },
  "google:veo-3.1-lite-generate-preview": { unit: "second", usd: 0.08 },
  "google:gemini-3.8-flash-tts": { unit: "kchars", usd: 0.012 },
  "deepseek:deepseek-v4-pro": { unit: "tokens", in: 1.32, out: 3.96 },
  "deepseek:deepseek-flash": { unit: "tokens", in: 0.3, out: 1.2 },
  "cerebras:gpt-oss-120b": { unit: "tokens", in: 0.35, out: 0.75 },
  "cerebras:qwen-3.8-27b": { unit: "tokens", in: 0.6, out: 1.2 },
  "together:zai-org/GLM-5.3": { unit: "tokens", in: 1.4, out: 4.4 },
  "together:zai-org/GLM-5.3-Flash": { unit: "tokens", in: 0.15, out: 0.5 },
  "together:deepseek-ai/DeepSeek-V4-Pro-0813": { unit: "tokens", in: 1.32, out: 3.96 },
  "together:black-forest-labs/FLUX.2-pro": { unit: "image", usd: 0.03 },
  "together:black-forest-labs/FLUX.2-dev": { unit: "image", usd: 0.0154 },
  "together:black-forest-labs/FLUX.1-kontext-pro": { unit: "image", usd: 0.04 },
  "together:cartesia/sonic-3": { unit: "kchars", usd: 0.065 },
  "together:ByteDance/Seedance-1.0-lite": { unit: "second", usd: 0.05 },
  "ltx:ltx-2-5-fast": { unit: "second", usd: 0.13 },
  "ltx:ltx-2-5-pro": { unit: "second", usd: 0.17 },
  "runway:gen4.5": { unit: "second", usd: 0.12 },
  "runway:gen4_image_turbo": { unit: "image", usd: 0.02 },
  "worldlabs:marble-1.1": { unit: "gen", usd: 1.26 },
  "worldlabs:marble-1.0-draft": { unit: "gen", usd: 0.2 },
  "hedra:character-3": { unit: "second", usd: 0.0625 },
  "elevenlabs:eleven_flash_v2_5": { unit: "kchars", usd: 0.04 },
  "tripo:text-to-3d": { unit: "gen", usd: 0.2 },
  "meshy:meshy-7": { unit: "gen", usd: 0.4 },
});

/** Conservative defaults when a model is not in the table. */
const DEFAULTS = { tokens: { in: 5.0, out: 30.0 }, image: 0.2, second: 0.5, kchars: 0.1, gen: 3.0 };

/**
 * Estimate a request's cost BEFORE it is sent. Deliberately pessimistic: it
 * assumes the full max-token output, so a budget check can only err toward
 * refusing.
 */
export function estimateUsd(provider, model, task, req = {}) {
  const p = PRICES[`${provider}:${model}`];
  const unit = p?.unit || unitForTask(task);
  if (unit === "tokens") {
    const inTok = Math.ceil(String(req.prompt || "").length / 3) + 1500;   // prompt + system
    const outTok = req.maxTokens || 8000;
    const rate = p || DEFAULTS.tokens;
    return (inTok * rate.in + outTok * rate.out) / 1e6;
  }
  if (unit === "image") return (p?.usd ?? DEFAULTS.image) * (req.n || 1);
  if (unit === "second") return (p?.usd ?? DEFAULTS.second) * (req.durationS || 5);
  if (unit === "kchars") return (p?.usd ?? DEFAULTS.kchars) * Math.max(1, String(req.text || req.prompt || "").length / 1000);
  return p?.usd ?? DEFAULTS.gen;
}

/** Actual cost from reported token usage (OpenAI-compatible or Gemini shapes). */
export function costFromUsage(provider, model, usage) {
  const p = PRICES[`${provider}:${model}`];
  if (!p || p.unit !== "tokens" || !usage) return null;
  const inTok = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount;
  const outTok = usage.completion_tokens ?? usage.output_tokens ?? ((usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0) || undefined);
  if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) return null;
  return (inTok * p.in + outTok * p.out) / 1e6;
}

function unitForTask(task) {
  return { IMAGE_ASSET: "image", TEXTURE: "image", CHARACTER: "image", VIDEO_CINEMATIC: "second", VOICE_AUDIO: "kchars", SPATIAL_3D: "gen" }[task] || "tokens";
}
