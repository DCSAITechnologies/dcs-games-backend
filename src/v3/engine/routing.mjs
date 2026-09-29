// GAMES-A — the routing matrix: task class -> primary, fallback 1, fallback 2, local.
//
// PROVISIONAL (28 Sep 2026). Ordering is set from published capability and
// price, KINIX live evidence (10–20 Sep) and DCS staging evidence (Cerebras
// only, 6–8 Sep). It has NOT yet been confirmed by the GAMES-A live benchmark
// (tools/provider-benchmark.mjs), which is the gate for making it final. The
// matrix is data: re-ordering after the benchmark is a change to this table
// only, and each step can be overridden per deployment with
//   DCS_GAMES_ROUTE_<TASK>=provider[:model],provider[:model],...
// The local step is always appended if an override leaves it out.
import { TASK, TASKS } from "./task-classes.mjs";

export const ROUTING_MATRIX = Object.freeze({
  [TASK.WORLD_DESIGN]: [
    { provider: "openai", model: "gpt-6-sol" },
    { provider: "google", model: "gemini-3.1-pro-preview" },
    { provider: "cerebras", model: "gpt-oss-120b" },          // the one text vendor proven on DCS staging
    { provider: "local:procedural-architect" },
  ],
  [TASK.GAMEPLAY_LOGIC]: [
    { provider: "openai", model: "gpt-6-sol" },
    { provider: "deepseek", model: "deepseek-v4-pro" },
    { provider: "cerebras", model: "gpt-oss-120b" },
    { provider: "local:behavior-library" },
  ],
  [TASK.FAST_ITERATION]: [
    { provider: "cerebras", model: "gpt-oss-120b" },          // ~1000+ tok/s; the latency floor
    { provider: "google", model: "gemini-3.5-flash-lite" },
    { provider: "together", model: "zai-org/GLM-5.3-Flash" },
    { provider: "local:keyword-classifier" },
  ],
  [TASK.CODE_GENERATION]: [
    { provider: "openai", model: "gpt-5.3-codex" },
    { provider: "deepseek", model: "deepseek-v4-pro" },
    { provider: "together", model: "zai-org/GLM-5.3" },
    { provider: "local:behavior-library" },
  ],
  [TASK.IMAGE_ASSET]: [
    { provider: "google", model: "gemini-3.1-flash-image" },  // KINIX-verified family (Nano Banana)
    { provider: "openai", model: "gpt-image-1-mini" },
    { provider: "together", model: "black-forest-labs/FLUX.2-pro" },
    { provider: "local:media-placeholder" },
  ],
  [TASK.TEXTURE]: [
    { provider: "together", model: "black-forest-labs/FLUX.2-dev" }, // cheapest per tile
    { provider: "google", model: "gemini-3.1-flash-image" },
    { provider: "openai", model: "gpt-image-1-mini" },
    { provider: "local:procedural-texture" },
  ],
  [TASK.CHARACTER]: [
    { provider: "google", model: "gemini-3-pro-image" },
    { provider: "openai", model: "gpt-image-1-mini" },
    { provider: "together", model: "black-forest-labs/FLUX.2-pro" },
    { provider: "local:parametric-character" },
  ],
  [TASK.SPATIAL_3D]: [
    { provider: "worldlabs", model: "marble-1.1" },           // KINIX-verified 10 Sep (1580 credits)
    { provider: "worldlabs", model: "marble-1.0-draft" },     // same vendor, ~6x cheaper, if the budget refuses 1.1
    { provider: "external-3d" },                              // B1 seam: Tripo/Meshy proxy when configured
    { provider: "local:procedural-spatial" },
  ],
  [TASK.VIDEO_CINEMATIC]: [
    { provider: "google", model: "veo-3.1-fast-generate-preview" },
    { provider: "ltx", model: "ltx-2-5-fast" },               // KINIX-verified family (ltx-2-3-fast, 10 Sep)
    { provider: "runway", model: "gen4.5" },                  // KINIX-verified 10 Sep
    { provider: "local:media-placeholder" },
  ],
  [TASK.VOICE_AUDIO]: [
    { provider: "elevenlabs", model: "eleven_flash_v2_5" },
    { provider: "google", model: "gemini-3.8-flash-tts" },
    { provider: "openai", model: "gpt-4o-mini-tts" },
    { provider: "local:media-placeholder" },
  ],
});

/** Apply DCS_GAMES_ROUTE_<TASK> overrides. Unknown providers are dropped, never invented. */
export function resolveRoutes(env = process.env, adapters = {}) {
  const out = {};
  for (const task of TASKS) {
    const base = ROUTING_MATRIX[task];
    const raw = (env[`DCS_GAMES_ROUTE_${task}`] || "").trim();
    if (!raw) { out[task] = base.map((s) => ({ ...s })); continue; }
    const steps = raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const local = s.startsWith("local:");
      const i = local ? -1 : s.indexOf(":");
      return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : { provider: s };
    }).filter((s) => adapters[s.provider]);
    const localStep = base[base.length - 1];
    if (!steps.some((s) => s.provider === localStep.provider)) steps.push({ ...localStep });
    out[task] = steps;
  }
  return out;
}
