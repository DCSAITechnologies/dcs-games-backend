// GAMES-A — video, voice, 3D and world adapters.
//
// The wire details are PORTED from the KINIX gateway (vl-be-integration @
// 618249d7), where each was measured against the live API on 4–20 Sep 2026 —
// not re-guessed here. File references are to that repo:
//   LTX         services/gateway/src/adapters/ltx.ts        POST /v2/text-to-video, GET /v2/{endpoint}/{id}
//   Runway      services/gateway/src/adapters/runway.ts     X-Runway-Version mandatory, GET /v1/tasks/{id}
//   World Labs  backend/src/ace/worlds/worldlabs.ts         WLT-Api-Key header (Bearer is 401)
//   ElevenLabs  services/gateway/src/adapters/elevenlabs.ts xi-api-key, /v1/text-to-speech/{voice}
//   Hedra       services/gateway/src/adapters/hedra.ts      NOT DISPATCHED: media upload unverified
import { TASK } from "../task-classes.mjs";
import { GenerationError, FAILURE } from "../failures.mjs";
import { estimateUsd } from "../pricing.mjs";
import { keyFrom, jsonRequest, pollJob } from "./http.mjs";

// Values the KINIX envValue guard treats as unset, so a placeholder never becomes a credential.
const PLACEHOLDER = /^(false|true|null|none|changeme|undefined|todo|xxx+)$/i;
const cred = (env, names) => { const v = keyFrom(env, names); return v && !PLACEHOLDER.test(v) ? v : ""; };

function vendorAdapter({ id, tasks, keys, defaults, invoke, extraConfigured = () => true }) {
  return {
    id, vendor: id, isLocal: false, tasks,
    configured: (env) => !!cred(env, keys) && extraConfigured(env),
    retrySafe: () => false,                     // every one of these is a billed job creation
    defaultModel: (task) => defaults[task] || defaults.any,
    estimateUsd: (task, model, req) => estimateUsd(id, model, task, req),
    invoke: (call) => invoke({ ...call, key: cred(call.env, keys) }),
  };
}

// ------------------------------------------------------------------------ LTX

export function ltxAdapter() {
  return vendorAdapter({
    id: "ltx", tasks: [TASK.VIDEO_CINEMATIC], keys: ["LTX_API_KEY"], defaults: { any: "ltx-2-5-fast" },
    async invoke(call) {
      const base = (call.env.LTX_API_BASE_URL && !PLACEHOLDER.test(call.env.LTX_API_BASE_URL) ? call.env.LTX_API_BASE_URL : "https://api.ltx.io").replace(/\/$/, "");
      const headers = { Authorization: `Bearer ${call.key}` };
      const portrait = call.req.aspectRatio === "9:16";
      const sub = await jsonRequest(call, "ltx", `${base}/v2/text-to-video`, {
        headers, body: { model: call.model, prompt: call.req.prompt, duration: call.req.durationS || 5, resolution: portrait ? "720x1280" : "1280x720" },
      });
      if (!sub?.id) throw new GenerationError(FAILURE.INVALID_OUTPUT, "ltx: accepted but returned no job id", { provider: "ltx" });
      const result = await pollJob(call, "ltx", async () => {
        const s = await jsonRequest(call, "ltx", `${base}/v2/text-to-video/${encodeURIComponent(sub.id)}`, { method: "GET", headers });
        if (["completed", "succeeded", "done"].includes(s.status)) return { done: true, result: s.result };
        if (["failed", "error", "cancelled"].includes(s.status)) return { failed: true, reason: s.error?.message || s.status };
        return {};
      }, { intervalMs: 5000, maxPolls: 120 });
      // A completed job with no URL is a failure, not a success (ltx.ts "SUCCEEDED WITH NOTHING").
      if (typeof result?.video_url !== "string" || !/^https?:\/\//.test(result.video_url)) throw new GenerationError(FAILURE.JOB_FAILED, "ltx: completed with no video_url", { provider: "ltx" });
      return { outputs: [{ uri: result.video_url, mime: "video/mp4", meta: { provider_marking: "c2pa" } }], model: call.model, jobId: `text-to-video:${sub.id}` };
    },
  });
}

// --------------------------------------------------------------------- Runway

const RUNWAY = "https://api.dev.runwayml.com";
const RUNWAY_VERSION = "2024-11-06";

export function runwayAdapter() {
  return vendorAdapter({
    id: "runway", tasks: [TASK.VIDEO_CINEMATIC], keys: ["RUNWAYML_API_SECRET", "RUNWAY_API_KEY"], defaults: { any: "gen4.5" },
    async invoke(call) {
      const headers = { Authorization: `Bearer ${call.key}`, "X-Runway-Version": RUNWAY_VERSION };
      // gen4.5 text_to_video accepts only 1280:720 and 720:1280, duration >= 2 (measured, runway.ts:140,341).
      const sub = await jsonRequest(call, "runway", `${RUNWAY}/v1/text_to_video`, {
        headers, body: { model: call.model, promptText: call.req.prompt, ratio: call.req.aspectRatio === "9:16" ? "720:1280" : "1280:720", duration: Math.max(2, call.req.durationS || 5) },
      });
      if (!sub?.id) throw new GenerationError(FAILURE.INVALID_OUTPUT, "runway: accepted but returned no task id", { provider: "runway" });
      const task = await pollJob(call, "runway", async () => {
        const t = await jsonRequest(call, "runway", `${RUNWAY}/v1/tasks/${encodeURIComponent(sub.id)}`, { method: "GET", headers });
        if (t.status === "SUCCEEDED") return { done: true, result: t };
        if (t.status === "FAILED" || t.status === "CANCELLED") return { failed: true, reason: t.failure || t.failureCode || t.status };
        return {};
      }, { intervalMs: 5000, maxPolls: 120 });
      const url = Array.isArray(task?.output) ? task.output.find((u) => typeof u === "string") : null;
      if (!url) throw new GenerationError(FAILURE.JOB_FAILED, "runway: succeeded with no output", { provider: "runway" });
      return { outputs: [{ uri: url, mime: "video/mp4", meta: { provider_marking: "c2pa" } }], model: call.model, jobId: sub.id };
    },
  });
}

// ----------------------------------------------------------------- World Labs

const WLT = "https://api.worldlabs.ai/marble/v1";
/** marble-1.1: 1580 credits (80 pano + 1500 world) measured 10 Sep 2026 ≈ $1.26 list → $0.0008 / credit. */
export const WORLDLABS_USD_PER_CREDIT = 0.0008;

export function worldLabsAdapter() {
  return vendorAdapter({
    id: "worldlabs", tasks: [TASK.SPATIAL_3D], keys: ["WORLDLABS_API_KEY"], defaults: { any: "marble-1.1" },
    async invoke(call) {
      const headers = { "WLT-Api-Key": call.key };
      const sub = await jsonRequest(call, "worldlabs", `${WLT}/worlds:generate`, {
        headers, body: { model: call.model, ...(call.req.title ? { display_name: String(call.req.title).slice(0, 80) } : {}), world_prompt: { type: "text", text_prompt: call.req.prompt } },
      });
      const opId = sub?.operation_id || sub?.operationId || sub?.id || sub?.name;
      if (!opId) throw new GenerationError(FAILURE.INVALID_OUTPUT, "worldlabs: submit carried no operation id", { provider: "worldlabs" });
      const op = await pollJob(call, "worldlabs", async () => {
        // ~6 requests in 4 s triggers 429 on this vendor; the interval keeps well under it.
        const o = await jsonRequest(call, "worldlabs", `${WLT}/operations/${encodeURIComponent(opId)}`, { method: "GET", headers });
        if (o.error) return { failed: true, reason: typeof o.error === "string" ? o.error : JSON.stringify(o.error) };
        if (o.done === true || o.metadata?.progress?.status === "SUCCEEDED") return { done: true, result: o };
        return {};
      }, { intervalMs: 10000, maxPolls: 60 });
      const worldId = op?.metadata?.world_id || op?.response?.world_id || op?.response?.worldId;
      if (!worldId) throw new GenerationError(FAILURE.JOB_FAILED, "worldlabs: operation finished with no world id", { provider: "worldlabs" });
      const w = await jsonRequest(call, "worldlabs", `${WLT}/worlds/${encodeURIComponent(worldId)}`, { method: "GET", headers });
      const a = w?.assets || {};
      const splats = a.splats?.spz_urls || {};
      const collider = a.mesh?.collider_mesh_url || null;
      const primary = collider || Object.values(splats).find((u) => typeof u === "string") || null;
      if (!primary) throw new GenerationError(FAILURE.JOB_FAILED, "worldlabs: world has no mesh or splat asset", { provider: "worldlabs" });
      const credits = Number.isFinite(op?.cost?.total_credits) ? op.cost.total_credits : null;
      return {
        outputs: [{
          uri: primary, mime: collider ? "model/gltf-binary" : "application/octet-stream",
          meta: { world_id: worldId, splat_urls: splats, collider_mesh_url: collider, panorama_url: a.imagery?.pano_url || null, caption: a.caption || null,
                  viewer_url: w?.world_marble_url || `https://marble.worldlabs.ai/world/${worldId}`, credits,
                  license_note: "commercial redistribution terms unresolved — publish gate must check" },
        }],
        model: call.model, jobId: opId, costUsd: credits == null ? null : credits * WORLDLABS_USD_PER_CREDIT,
      };
    },
  });
}

// ----------------------------------------------------------------- ElevenLabs

const STOCK_VOICE = "21m00Tcm4TlvDq8ikWAM";   // ElevenLabs' public stock voice "Rachel"

export function elevenLabsAdapter() {
  return vendorAdapter({
    id: "elevenlabs", tasks: [TASK.VOICE_AUDIO], keys: ["ELEVENLABS_API_KEY"], defaults: { any: "eleven_flash_v2_5" },
    async invoke(call) {
      const voice = call.req.voiceId || keyFrom(call.env, ["ELEVENLABS_DEFAULT_VOICE_ID"]) || STOCK_VOICE;
      const text = String(call.req.text || call.req.prompt || "").slice(0, 4000);
      const r = await jsonRequest(call, "elevenlabs", `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        headers: { "xi-api-key": call.key, Accept: "audio/mpeg" }, body: { text, model_id: call.model }, raw: true,
      });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new GenerationError(FAILURE.INVALID_OUTPUT, "elevenlabs: empty audio", { provider: "elevenlabs" });
      return { outputs: [{ uri: `data:audio/mpeg;base64,${buf.toString("base64")}`, mime: "audio/mpeg", meta: { bytes: buf.length, chars: text.length } }], model: call.model };
    },
  });
}

// ---------------------------------------------------------------------- Hedra
//
// Registered so it shows up in describe() and the routing matrix, but it never
// reports configured: KINIX withholds dispatch (dispatchPolicy.ts:33,
// HEDRA_INGEST_UNVERIFIED) because a talking-character job needs an uploaded
// start image and audio, and that upload path has not been proven.

export function hedraAdapter() {
  return vendorAdapter({
    id: "hedra", tasks: [TASK.VIDEO_CINEMATIC], keys: ["HEDRA_API_KEY"], defaults: { any: "character-3" },
    extraConfigured: () => false,
    async invoke() { throw new GenerationError(FAILURE.NOT_CONFIGURED, "hedra: dispatch withheld until media upload is verified", { provider: "hedra" }); },
  });
}

// ------------------------------------------------- DCS seams (B1, unchanged)

/** The B1 external 3D seam (DCS_ASSET3D_URL/KEY) — e.g. a Tripo or Meshy proxy. */
export function external3dAdapter() {
  return vendorAdapter({
    id: "external-3d", tasks: [TASK.SPATIAL_3D, TASK.CHARACTER], keys: ["DCS_ASSET3D_KEY"], defaults: { any: "external-3d" },
    extraConfigured: (env) => !!(env.DCS_ASSET3D_URL || "").trim(),
    async invoke(call) {
      const base = call.env.DCS_ASSET3D_URL.replace(/\/$/, "");
      const j = await jsonRequest(call, "external-3d", `${base}/generate`, {
        headers: { Authorization: `Bearer ${call.key}` },
        body: { prompt: call.req.prompt, archetype: call.req.archetype || null, style: call.req.style || null, format: "glb", poly_budget: call.req.polyBudget || 20000 },
      });
      if (!j?.uri) throw new GenerationError(FAILURE.INVALID_OUTPUT, "external-3d: response carried no uri", { provider: "external-3d" });
      return { outputs: [{ uri: j.uri, mime: "model/gltf-binary", meta: { polycount: j.polycount ?? null, license: j.license ?? null } }], model: j.model || call.model };
    },
  });
}

/** The B1 KINIX seam (DCS_KINIX_URL/KEY). Payload shape documented in media.mjs, not yet proven live. */
export function kinixGatewayAdapter() {
  return vendorAdapter({
    id: "kinix", tasks: [TASK.IMAGE_ASSET, TASK.VIDEO_CINEMATIC, TASK.VOICE_AUDIO], keys: ["DCS_KINIX_KEY", "KINIX_API_KEY"], defaults: { any: "kynex" },
    extraConfigured: (env) => !!(env.DCS_KINIX_URL || "").trim(),
    async invoke(call) {
      const kind = { IMAGE_ASSET: "image", VIDEO_CINEMATIC: "video", VOICE_AUDIO: "voice" }[call.task];
      const j = await jsonRequest(call, "kinix", `${call.env.DCS_KINIX_URL.replace(/\/$/, "")}/generate`, {
        headers: { Authorization: `Bearer ${call.key}` },
        body: { kind, prompt: call.req.prompt, style: call.req.style ?? null, duration_s: call.req.durationS ?? null, language: call.req.language ?? "en" },
      });
      if (!j?.uri) throw new GenerationError(FAILURE.INVALID_OUTPUT, "kinix: response carried no uri", { provider: "kinix" });
      return { outputs: [{ uri: j.uri, mime: j.mime || null, meta: { provider_ref: j.provider_ref || null } }], model: j.model || "kynex" };
    },
  });
}
