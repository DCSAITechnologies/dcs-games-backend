// GAMES-A — Google Gemini API: Gemini text, Gemini image ("Nano Banana"),
// Gemini TTS and Veo video (long-running operation, polled).
//
// The key goes in the x-goog-api-key header, never the query string, so it
// cannot end up in a logged URL. Imagen 4 was shut down on the Gemini API on
// 17 Aug 2026 and is deliberately absent.
import { TASK } from "../task-classes.mjs";
import { GenerationError, FAILURE } from "../failures.mjs";
import { estimateUsd, costFromUsage } from "../pricing.mjs";
import { keyFrom, jsonRequest, pollJob, requireJsonObject } from "./http.mjs";
import { TEXT_SPEC, TEXT_TASKS } from "./prompts.mjs";
import { visualPrompt } from "./openai-compatible.mjs";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_AI_API_KEY"];
const IMAGE_TASKS = [TASK.IMAGE_ASSET, TASK.TEXTURE, TASK.CHARACTER];

const DEFAULTS = {
  text: "gemini-3.1-pro-preview", FAST_ITERATION: "gemini-3.5-flash-lite", image: "gemini-3.1-flash-image",
  CHARACTER: "gemini-3-pro-image", VIDEO_CINEMATIC: "veo-3.1-fast-generate-preview", VOICE_AUDIO: "gemini-3.8-flash-tts",
};

function partsOf(j) {
  const c = j?.candidates?.[0];
  if (!c) {
    const block = j?.promptFeedback?.blockReason;
    throw new GenerationError(block ? FAILURE.CONTENT_POLICY : FAILURE.INVALID_OUTPUT, `google: no candidate${block ? ` (blocked: ${block})` : ""}`, { provider: "google" });
  }
  if (/SAFETY|PROHIBITED|BLOCKLIST|IMAGE_SAFETY/.test(c.finishReason || "")) throw new GenerationError(FAILURE.CONTENT_POLICY, `google: finish ${c.finishReason}`, { provider: "google" });
  return c.content?.parts || [];
}

export function googleAdapter() {
  const id = "google";
  return {
    id, vendor: "google", isLocal: false,
    tasks: [...TEXT_TASKS, ...IMAGE_TASKS, TASK.VIDEO_CINEMATIC, TASK.VOICE_AUDIO],
    configured: (env) => !!keyFrom(env, KEYS),
    retrySafe: (task) => TEXT_TASKS.includes(task),
    defaultModel: (task) => DEFAULTS[task] || (IMAGE_TASKS.includes(task) ? DEFAULTS.image : DEFAULTS.text),
    estimateUsd: (task, model, req) => estimateUsd(id, model, task, { ...req, maxTokens: req.maxTokens || TEXT_SPEC[task]?.maxTokens, durationS: req.durationS || 8 }),

    async invoke(call) {
      const { task, model, req, env } = call;
      const headers = { "x-goog-api-key": keyFrom(env, KEYS) };
      const generate = (body) => jsonRequest(call, id, `${BASE}/models/${encodeURIComponent(model)}:generateContent`, { headers, body });

      if (TEXT_TASKS.includes(task)) {
        const spec = TEXT_SPEC[task];
        const j = await generate({
          systemInstruction: { parts: [{ text: spec.system }] },
          contents: [{ role: "user", parts: [{ text: spec.user(req) }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: req.maxTokens || spec.maxTokens, temperature: spec.temperature },
        });
        const text = partsOf(j).map((p) => p.text || "").join("");
        const json = requireJsonObject(id, text, spec.parse);
        return { outputs: [{ json, mime: "application/json" }], model: j.modelVersion || model, usage: j.usageMetadata || null, costUsd: costFromUsage(id, model, j.usageMetadata) };
      }

      if (IMAGE_TASKS.includes(task)) {
        const j = await generate({
          contents: [{ role: "user", parts: [{ text: visualPrompt(task, req) }] }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: req.aspectRatio || (task === TASK.IMAGE_ASSET ? "16:9" : "1:1") } },
        });
        const img = partsOf(j).find((p) => p.inlineData?.data);
        if (!img) throw new GenerationError(FAILURE.INVALID_OUTPUT, "google: image response carried no image", { provider: id });
        return { outputs: [{ uri: `data:${img.inlineData.mimeType || "image/png"};base64,${img.inlineData.data}`, mime: img.inlineData.mimeType || "image/png" }], model, usage: j.usageMetadata || null };
      }

      if (task === TASK.VOICE_AUDIO) {
        const text = String(req.text || req.prompt || "").slice(0, 4000);
        const j = await generate({
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice || "Kore" } } } },
        });
        const a = partsOf(j).find((p) => p.inlineData?.data);
        if (!a) throw new GenerationError(FAILURE.INVALID_OUTPUT, "google: tts response carried no audio", { provider: id });
        // Gemini TTS returns raw PCM (audio/L16;rate=24000). The mime says so; the
        // pipeline's media store wraps it as WAV before it reaches a browser.
        return { outputs: [{ uri: `data:${a.inlineData.mimeType};base64,${a.inlineData.data}`, mime: a.inlineData.mimeType, meta: { chars: text.length } }], model };
      }

      if (task === TASK.VIDEO_CINEMATIC) {
        const op = await jsonRequest(call, id, `${BASE}/models/${encodeURIComponent(model)}:predictLongRunning`, {
          headers, body: { instances: [{ prompt: req.prompt }], parameters: { aspectRatio: req.aspectRatio || "16:9", ...(req.durationS ? { durationSeconds: req.durationS } : {}) } },
        });
        if (!op?.name) throw new GenerationError(FAILURE.INVALID_OUTPUT, "google: video submit returned no operation", { provider: id });
        const done = await pollJob(call, id, async () => {
          const s = await jsonRequest(call, id, `${BASE}/${op.name}`, { method: "GET", headers });
          if (!s.done) return {};
          if (s.error) return { failed: true, reason: s.error.message };
          return { done: true, result: s.response };
        }, { intervalMs: 8000, maxPolls: 90 });
        const sample = done?.generateVideoResponse?.generatedSamples?.[0]?.video;
        if (sample?.uri === undefined) {
          const filtered = done?.generateVideoResponse?.raiMediaFilteredReasons;
          throw new GenerationError(filtered ? FAILURE.CONTENT_POLICY : FAILURE.INVALID_OUTPUT, `google: video carried no sample${filtered ? ` (${filtered.join("; ")})` : ""}`, { provider: id });
        }
        // The file URI needs the API key to download. It is stored bare; the media
        // store fetches it server-side, so the key never enters the manifest.
        return { outputs: [{ uri: sample.uri, mime: "video/mp4", meta: { requires_server_fetch: true } }], model, jobId: op.name, costUsd: null };
      }
      throw new GenerationError(FAILURE.UNSUPPORTED, `google: ${task} not supported`, { provider: id });
    },
  };
}
