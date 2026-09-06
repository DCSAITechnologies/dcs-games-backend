// Section 9.1 — multimodal world creation.
//
// A creator can condition a world on a reference image, a sketch or a map as
// well as text. The image is never stored in the manifest and never reaches the
// world architect directly: a vision model READS it into a structured
// description, and that description is what conditions generation.
//
// That indirection is deliberate. It keeps WorldManifestV3 provider-neutral (no
// image bytes, no vendor blob), it keeps the conditioning auditable — you can
// read exactly what the system thought your picture showed — and it means a
// world can still be built when no vision provider is available.
//
// A vision provider IS configured on this estate: DeepSeek ships
// deepseek-v4-flash-vision-exp, and Together carries vision-capable chat models.
// Both answered a live probe on 6 Sep 2026.
import { STATUS, ProviderError, parseJsonLoose, offline } from "./contract.mjs";
import { Errors } from "../../core/errors.mjs";

export const VISION_LANE = "vision";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const SYSTEM = `You read a reference image for a game-world designer and describe ONLY what you can actually see.

Return ONE JSON object:
{
  "kind": "photo" | "sketch" | "map" | "concept_art" | "screenshot" | "unclear",
  "setting": string,                 // the place this depicts, in a few words
  "style": string,                   // materials, palette, light, mood — concrete, not poetic
  "structures": [string],            // building or object types you can SEE
  "terrain": string,                 // flat, hilly, coastal, urban grid, forested...
  "time_of_day": "night"|"dawn"|"day"|"dusk"|"unclear",
  "weather": "clear"|"cloudy"|"rain"|"storm"|"snow"|"fog"|"unclear",
  "layout_hints": [string],          // spatial relationships you can see
  "confidence": number,              // 0..1, how sure you are the image is usable
  "not_visible": [string]            // things a designer might want that this image does NOT show
}

Rules:
- Describe only what is present. If you cannot tell, say "unclear" and put it in not_visible.
- Do not invent a backstory, a name, or anything outside the frame.
- Do not describe people's identities or attempt to recognise anyone.
Return JSON only.`;

/**
 * Validate an image the caller supplied. Rejects anything oversized or of an
 * unexpected type before a byte is sent anywhere.
 */
export function validateImage({ dataUrl = null, mime = null, bytes = null } = {}) {
  if (!dataUrl) throw Errors.validation("an image data URL is required");
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl));
  if (!m) throw Errors.validation("the image must be a base64 data URL");
  const detected = (mime || m[1]).toLowerCase();
  if (!ALLOWED_MIME.includes(detected)) {
    throw Errors.validation(`image type '${detected}' is not accepted`, { meta: { allowed: ALLOWED_MIME } });
  }
  const size = bytes ?? Math.floor(m[2].length * 0.75);
  if (size > MAX_IMAGE_BYTES) {
    throw Errors.validation(`the image is ${(size / 1048576).toFixed(1)}MB; the limit is ${MAX_IMAGE_BYTES / 1048576}MB`);
  }
  return { mime: detected, bytes: size };
}

function keyed(env, ...names) {
  for (const n of names) { const v = env[n]; if (v && String(v).trim()) return String(v).trim(); }
  return "";
}

function makeVisionAdapter({ name, baseUrl, model, keys, rank, env }) {
  const apiKey = keyed(env, ...keys);
  return {
    name, lane: VISION_LANE, rank, model, isFallback: false,
    async status() {
      if (offline(env)) return STATUS.UNAVAILABLE;
      return apiKey ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
    },
    async invoke(req) {
      const body = {
        model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: `Read this reference for a world described as: "${req.prompt || "(no text prompt given)"}"` },
              { type: "image_url", image_url: { url: req.dataUrl } },
            ],
          },
        ],
        max_tokens: 1200,
        temperature: 0.2,
      };
      let r;
      try {
        r = await fetch(baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
      } catch (e) { throw new ProviderError(name, String(e?.message || e)); }
      if (!r.ok) throw new ProviderError(name, `HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`, { status: r.status });
      const j = await r.json();
      const parsed = parseJsonLoose(j?.choices?.[0]?.message?.content);
      if (!parsed || !parsed.setting) throw new ProviderError(name, "the vision response was not a usable reading");
      parsed._model = j.model || model;
      return parsed;
    },
  };
}

/**
 * The fallback. There is no honest way to read an image without a vision model,
 * so it does not pretend to: it returns an explicitly empty reading that the
 * caller must treat as "no visual conditioning available".
 */
export function noVisionFallback() {
  return {
    name: "local:no-vision",
    lane: VISION_LANE,
    rank: 99,
    isFallback: true,
    model: "none",
    async status() { return STATUS.FALLBACK; },
    async invoke() {
      return {
        kind: "unclear",
        setting: null,
        style: null,
        structures: [],
        terrain: null,
        time_of_day: "unclear",
        weather: "unclear",
        layout_hints: [],
        confidence: 0,
        not_visible: ["everything — no vision provider is available, so the image was not read"],
        unread: true,
        _model: "none",
      };
    },
  };
}

export function visionAdapters(env = process.env) {
  return [
    makeVisionAdapter({ name: "deepseek:vision", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash-vision-exp", keys: ["DEEPSEEK_API_KEY"], rank: 10, env }),
    makeVisionAdapter({ name: "together:vision", baseUrl: "https://api.together.xyz/v1", model: "Qwen/Qwen3.8-Flash", keys: ["TOGETHER_API_KEY"], rank: 20, env }),
    noVisionFallback(),
  ];
}

/**
 * Fold a visual reading into the text prompt the architect lane receives.
 *
 * The reading is ADDED to the prompt, never substituted for it: the creator's
 * words stay primary, and the image informs style and layout. A low-confidence
 * or unread image contributes nothing rather than contributing noise.
 */
export function conditionPrompt(prompt, reading, { minConfidence = 0.35 } = {}) {
  if (!reading || reading.unread || Number(reading.confidence || 0) < minConfidence) {
    return {
      prompt,
      conditioned: false,
      reason: reading?.unread
        ? "no vision provider was available, so the image was not read"
        : `the image was read with low confidence (${Number(reading?.confidence || 0).toFixed(2)}), so it was not used`,
    };
  }
  const parts = [prompt];
  parts.push(`\nReference image (${reading.kind}) shows: ${reading.setting}.`);
  if (reading.style) parts.push(`Visual style: ${reading.style}.`);
  if (reading.terrain) parts.push(`Terrain: ${reading.terrain}.`);
  if (reading.structures?.length) parts.push(`Structures visible: ${reading.structures.slice(0, 12).join(", ")}.`);
  if (reading.layout_hints?.length) parts.push(`Layout: ${reading.layout_hints.slice(0, 6).join("; ")}.`);
  if (reading.time_of_day && reading.time_of_day !== "unclear") parts.push(`Time of day: ${reading.time_of_day}.`);
  if (reading.weather && reading.weather !== "unclear") parts.push(`Weather: ${reading.weather}.`);
  if (reading.not_visible?.length) parts.push(`The image does NOT show: ${reading.not_visible.slice(0, 5).join(", ")} — invent those from the text prompt instead.`);
  parts.push("The creator's words take priority where they conflict with the image.");

  return { prompt: parts.join(" "), conditioned: true, confidence: Number(reading.confidence) };
}

/** Map a reading onto manifest fields the architect can be given as constraints. */
export function readingToConstraints(reading) {
  if (!reading || reading.unread) return null;
  const tod = { night: 0.02, dawn: 0.25, day: 0.5, dusk: 0.82 }[reading.time_of_day];
  return {
    style: reading.style || null,
    ...(typeof tod === "number" ? { time_of_day: tod } : {}),
    ...(reading.weather && reading.weather !== "unclear" ? { weather: reading.weather } : {}),
    preferred_structures: (reading.structures || []).slice(0, 10),
  };
}
