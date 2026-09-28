// GAMES-A — OpenAI and the OpenAI-compatible vendors (DeepSeek, Cerebras,
// Together). Text tasks share one chat-completions path; OpenAI and Together
// also serve images and voice from the same credential.
import { TASK } from "../task-classes.mjs";
import { GenerationError, FAILURE } from "../failures.mjs";
import { estimateUsd, costFromUsage } from "../pricing.mjs";
import { keyFrom, jsonRequest, requireJsonObject } from "./http.mjs";
import { TEXT_SPEC, TEXT_TASKS } from "./prompts.mjs";

const VENDORS = {
  openai: { base: "https://api.openai.com/v1", keys: ["OPENAI_API_KEY"], tokenParam: "max_completion_tokens", temperature: false,
    tasks: [...TEXT_TASKS, TASK.IMAGE_ASSET, TASK.TEXTURE, TASK.CHARACTER, TASK.VOICE_AUDIO] },
  deepseek: { base: "https://api.deepseek.com/v1", keys: ["DEEPSEEK_API_KEY"], tokenParam: "max_tokens", temperature: true, tasks: TEXT_TASKS },
  cerebras: { base: "https://api.cerebras.ai/v1", keys: ["CEREBRAS_API_KEY", "CEREBRAS_API_KEY_1", "CEREBRAS_KEY_2", "CEREBRAS_API_KEY_2"], tokenParam: "max_completion_tokens", temperature: true, tasks: TEXT_TASKS },
  together: { base: "https://api.together.xyz/v1", keys: ["TOGETHER_API_KEY"], tokenParam: "max_tokens", temperature: true,
    tasks: [...TEXT_TASKS, TASK.IMAGE_ASSET, TASK.TEXTURE, TASK.CHARACTER, TASK.VOICE_AUDIO] },
};

const DEFAULT_MODELS = {
  openai: { text: "gpt-6-sol", CODE_GENERATION: "gpt-5.3-codex", FAST_ITERATION: "gpt-5.4-nano", image: "gpt-image-1-mini", VOICE_AUDIO: "gpt-4o-mini-tts" },
  deepseek: { text: "deepseek-v4-pro", FAST_ITERATION: "deepseek-flash" },
  cerebras: { text: "gpt-oss-120b" },
  together: { text: "zai-org/GLM-5.3", FAST_ITERATION: "zai-org/GLM-5.3-Flash", image: "black-forest-labs/FLUX.2-pro", TEXTURE: "black-forest-labs/FLUX.2-dev", VOICE_AUDIO: "cartesia/sonic-3" },
};

const IMAGE_TASKS = [TASK.IMAGE_ASSET, TASK.TEXTURE, TASK.CHARACTER];

/** Prompt shaping for visual tasks: a texture must tile, a character must read as a character sheet. */
export function visualPrompt(task, req) {
  const style = req.style ? ` Style: ${req.style}.` : "";
  if (task === TASK.TEXTURE) return `Seamless tileable ${req.material || "surface"} texture, flat even lighting, no perspective, no shadows, no text: ${req.prompt}.${style}`;
  if (task === TASK.CHARACTER) return `Game character concept sheet, full body, neutral A-pose, front view, plain background, no text: ${req.prompt}.${style}`;
  return `${req.prompt}.${style}`;
}

export function openAiCompatibleAdapter(vendor) {
  const v = VENDORS[vendor];
  const id = vendor;
  return {
    id, vendor, isLocal: false, tasks: v.tasks,
    configured: (env) => !!keyFrom(env, v.keys),
    // Chat completions are rejected before execution on 429/5xx, so one retry is
    // safe; image and audio generations are billed per call and are not retried.
    retrySafe: (task) => TEXT_TASKS.includes(task),
    defaultModel: (task) => {
      const d = DEFAULT_MODELS[vendor];
      return d[task] || (IMAGE_TASKS.includes(task) ? d.image : d.text);
    },
    estimateUsd: (task, model, req) => estimateUsd(vendor, model, task, { ...req, maxTokens: req.maxTokens || TEXT_SPEC[task]?.maxTokens }),

    async invoke(call) {
      const { task, model, req, env } = call;
      const auth = { Authorization: "Bearer " + keyFrom(env, v.keys) };

      if (TEXT_TASKS.includes(task)) {
        const spec = TEXT_SPEC[task];
        const body = {
          model,
          messages: [{ role: "system", content: spec.system }, { role: "user", content: spec.user(req) }],
          [v.tokenParam]: req.maxTokens || spec.maxTokens,
          response_format: { type: "json_object" },
          ...(v.temperature ? { temperature: spec.temperature } : {}),
        };
        const j = await jsonRequest(call, id, `${v.base}/chat/completions`, { headers: auth, body });
        const text = j?.choices?.[0]?.message?.content;
        if (typeof text !== "string") throw new GenerationError(j?.choices?.[0]?.finish_reason === "content_filter" ? FAILURE.CONTENT_POLICY : FAILURE.INVALID_OUTPUT, `${id}: no message content`, { provider: id });
        const json = requireJsonObject(id, text, spec.parse);
        return { outputs: [{ json, mime: "application/json" }], model: j.model || model, usage: j.usage || null, costUsd: costFromUsage(vendor, model, j.usage) };
      }

      if (IMAGE_TASKS.includes(task)) {
        const prompt = visualPrompt(task, req);
        const body = vendor === "openai"
          ? { model, prompt, size: req.size || (task === TASK.IMAGE_ASSET ? "1536x1024" : "1024x1024"), n: 1 }
          : { model, prompt, width: req.width || 1024, height: req.height || 1024, n: 1, response_format: "b64_json" };
        const j = await jsonRequest(call, id, `${v.base}/images/generations`, { headers: auth, body });
        const d = j?.data?.[0];
        const uri = d?.b64_json ? `data:image/png;base64,${d.b64_json}` : d?.url;
        if (!uri) throw new GenerationError(FAILURE.INVALID_OUTPUT, `${id}: image response carried no image`, { provider: id });
        return { outputs: [{ uri, mime: "image/png", meta: { revised_prompt: d.revised_prompt || null } }], model, usage: j.usage || null };
      }

      if (task === TASK.VOICE_AUDIO) {
        const text = String(req.text || req.prompt || "").slice(0, 4000);
        const body = vendor === "openai"
          ? { model, input: text, voice: req.voice || "alloy", response_format: "mp3", ...(req.instructions ? { instructions: req.instructions } : {}) }
          : { model, input: text, voice: req.voice || "narrator", response_format: "mp3" };
        const r = await jsonRequest(call, id, `${v.base}/audio/${vendor === "openai" ? "speech" : "generations"}`, { headers: auth, body, raw: true });
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length) throw new GenerationError(FAILURE.INVALID_OUTPUT, `${id}: empty audio`, { provider: id });
        return { outputs: [{ uri: `data:audio/mpeg;base64,${buf.toString("base64")}`, mime: "audio/mpeg", meta: { bytes: buf.length, chars: text.length } }], model };
      }
      throw new GenerationError(FAILURE.UNSUPPORTED, `${id}: ${task} not supported`, { provider: id });
    },
  };
}
