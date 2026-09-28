// GAMES-A — deterministic request metadata, generated asset IDs, provenance.
//
// The same request must always carry the same request_id and yield the same
// asset IDs, so a retried job, a replayed world or a restored bundle can be
// matched to what it produced without trusting clocks or counters. Timestamps
// are recorded beside the IDs, never inside them.
import crypto from "node:crypto";

export const ENGINE_VERSION = "games-a/1.0.0";

/** JSON with sorted keys, so key order never changes a hash. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined && typeof v[k] !== "function")
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const SHORT = {
  WORLD_DESIGN: "wd", GAMEPLAY_LOGIC: "gl", FAST_ITERATION: "fi", CODE_GENERATION: "cg", IMAGE_ASSET: "img",
  TEXTURE: "tex", CHARACTER: "chr", SPATIAL_3D: "s3d", VIDEO_CINEMATIC: "vid", VOICE_AUDIO: "vox",
};

/**
 * The parts of a request that define WHAT is asked for. Transport details
 * (callbacks, signals, raw image bytes) are excluded; an attached image
 * contributes its hash, not its bytes.
 */
export function requestFingerprintInput(task, req = {}) {
  const { onProgress, signal, image, ...rest } = req;
  return { task, ...rest, ...(image?.dataUrl ? { image_sha256: sha256(image.dataUrl) } : {}) };
}

export function requestMetadata(task, req = {}, { clock = () => new Date() } = {}) {
  const fp = sha256(canonicalJson(requestFingerprintInput(task, req)));
  return {
    request_id: `gr_${SHORT[task] || "x"}_${fp.slice(0, 24)}`,
    task,
    world_id: req.worldId ?? null,
    creator_id: req.creatorId ?? null,
    seed: req.seed ?? null,
    prompt_sha256: req.prompt ? sha256(String(req.prompt)) : null,
    fingerprint: fp,
    engine_version: ENGINE_VERSION,
    created_at: clock().toISOString(),
  };
}

/**
 * A generated asset's ID: a pure function of the request, the provider that
 * answered, the model and the output's position. Two different providers
 * answering the same request produce different IDs, which is correct — they are
 * different assets.
 */
export function assetId(task, requestId, provider, model, index = 0) {
  const h = sha256(canonicalJson({ task, requestId, provider, model: model || null, index }));
  return `ga_${SHORT[task] || "x"}_${h.slice(0, 24)}`;
}

/** Hash of an output's content, where there is content to hash. */
export function contentHash(output) {
  if (output == null) return null;
  if (typeof output.text === "string") return sha256(output.text);
  if (output.json !== undefined) return sha256(canonicalJson(output.json));
  if (typeof output.uri === "string") return sha256(output.uri);
  return null;
}
