// B1 / B11 — media lane: images, textures, portraits, voice, narration, video.
//
// This is the KINIX/Kynex integration seam. The contract rule from the reuse map
// is absolute: WorldManifestV3 must not change when KINIX is unavailable. So the
// media lane only ever writes optional refs into `manifest.media`, and its
// fallback produces a deterministic local placeholder rather than blocking.
//
// A live media provider IS configured on this estate (Together.ai: 29 image, 15
// audio, 33 video models, all confirmed reachable on 6 Sep 2026), so this lane is
// genuinely usable — but nothing depends on it.
//
// SAFETY: voice and likeness generation goes through the A5 consent gate. An
// adapter here never bypasses it; the router calls requireMediaConsent first.
import crypto from "node:crypto";
import { STATUS, LANES, ProviderError, offline } from "./contract.mjs";

const TOGETHER = "https://api.together.xyz/v1";

function keyed(env, ...names) {
  for (const n of names) { const v = env[n]; if (v && String(v).trim()) return String(v).trim(); }
  return "";
}

// ------------------------------------------------------------------ KINIX seam
//
// The KINIX/Kynex runtime is not yet reachable from this service. Rather than
// stub it out silently, the adapter is fully written against a documented
// payload shape and reports UNAVAILABLE until DCS_KINIX_URL is set — so plugging
// it in later requires no change to WorldManifestV3 or to any caller.

export function kinixAdapter(env = process.env) {
  const base = (env.DCS_KINIX_URL || "").replace(/\/$/, "");
  const key = keyed(env, "DCS_KINIX_KEY", "KINIX_API_KEY");
  return {
    name: "kinix",
    lane: LANES.MEDIA,
    rank: 5,
    isFallback: false,
    model: "kynex",
    async status() {
      if (offline(env)) return STATUS.UNAVAILABLE;
      return base && key ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
    },
    /**
     * Expected KINIX payload (documented so the module can be wired without
     * touching this file's callers):
     *   POST {DCS_KINIX_URL}/generate
     *   { kind: "image"|"voice"|"video"|"caption", prompt, subject_id?, style?, duration_s?, language? }
     *   -> { uri, mime, duration_s?, provider_ref, model }
     */
    async invoke(req) {
      const r = await fetch(base + "/generate", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: req.kind, prompt: req.prompt, subject_id: req.subjectId ?? null,
          style: req.style ?? null, duration_s: req.durationS ?? null, language: req.language ?? "en",
        }),
        signal: AbortSignal.timeout(120000),
      }).catch((e) => { throw new ProviderError("kinix", String(e?.message || e)); });
      if (!r.ok) throw new ProviderError("kinix", `HTTP ${r.status}`, { status: r.status });
      const j = await r.json();
      if (!j?.uri) throw new ProviderError("kinix", "response carried no uri");
      return { kind: req.kind, uri: j.uri, mime: j.mime || null, duration_s: j.duration_s ?? null, provider_ref: j.provider_ref || null, _model: j.model || "kynex" };
    },
  };
}

// ---------------------------------------------------------------- Together.ai

const IMAGE_MODEL = "black-forest-labs/FLUX.1-kontext-pro";
const AUDIO_MODEL = "cartesia/sonic-3";
const VIDEO_MODEL = "ByteDance/Seedance-1.0-lite";

export function togetherMediaAdapter(env = process.env) {
  const key = keyed(env, "TOGETHER_API_KEY");
  return {
    name: "together",
    lane: LANES.MEDIA,
    rank: 10,
    isFallback: false,
    async status() {
      if (offline(env)) return STATUS.UNAVAILABLE;
      return key ? STATUS.AVAILABLE : STATUS.UNAVAILABLE;
    },
    async invoke(req) {
      if (req.kind === "image") {
        const r = await fetch(TOGETHER + "/images/generations", {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: req.model || IMAGE_MODEL, prompt: req.prompt, width: req.width || 1024, height: req.height || 576, n: 1 }),
          signal: AbortSignal.timeout(120000),
        }).catch((e) => { throw new ProviderError("together", String(e?.message || e)); });
        if (!r.ok) throw new ProviderError("together", `image HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`, { status: r.status });
        const j = await r.json();
        const uri = j?.data?.[0]?.url || j?.data?.[0]?.b64_json;
        if (!uri) throw new ProviderError("together", "image response carried no url");
        return { kind: "image", uri, mime: "image/png", _model: req.model || IMAGE_MODEL };
      }
      if (req.kind === "voice" || req.kind === "narration") {
        const r = await fetch(TOGETHER + "/audio/generations", {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: req.model || AUDIO_MODEL, input: req.prompt, voice: req.voice || "narrator", response_format: "mp3" }),
          signal: AbortSignal.timeout(120000),
        }).catch((e) => { throw new ProviderError("together", String(e?.message || e)); });
        if (!r.ok) throw new ProviderError("together", `audio HTTP ${r.status}`, { status: r.status });
        const buf = Buffer.from(await r.arrayBuffer());
        return { kind: req.kind, uri: `data:audio/mpeg;base64,${buf.toString("base64")}`, mime: "audio/mpeg", bytes: buf.length, _model: req.model || AUDIO_MODEL };
      }
      if (req.kind === "video") {
        const r = await fetch(TOGETHER + "/videos/generations", {
          method: "POST",
          headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ model: req.model || VIDEO_MODEL, prompt: req.prompt, duration: req.durationS || 5 }),
          signal: AbortSignal.timeout(300000),
        }).catch((e) => { throw new ProviderError("together", String(e?.message || e)); });
        if (!r.ok) throw new ProviderError("together", `video HTTP ${r.status}`, { status: r.status });
        const j = await r.json();
        const uri = j?.data?.[0]?.url || j?.url;
        if (!uri) throw new ProviderError("together", "video response carried no url");
        return { kind: "video", uri, mime: "video/mp4", _model: req.model || VIDEO_MODEL };
      }
      throw new ProviderError("together", `unsupported media kind '${req.kind}'`, { retryable: false });
    },
  };
}

// ------------------------------------------------------------------- fallback
//
// Deterministic, offline, and honest: an inline SVG placeholder that says what it
// is standing in for. A page that renders it is visibly missing artwork rather
// than silently showing something that looks generated.

export function placeholderMediaAdapter() {
  return {
    name: "local:placeholder",
    lane: LANES.MEDIA,
    rank: 99,
    isFallback: true,
    model: "deterministic",
    async status() { return STATUS.FALLBACK; },
    async invoke(req) {
      const label = (req.label || req.kind || "media").slice(0, 40);
      const hue = crypto.createHash("sha256").update(String(req.prompt || label)).digest()[0] * 360 / 256;
      if (req.kind === "image") {
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${req.width || 1024}" height="${req.height || 576}" viewBox="0 0 1024 576">` +
          `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
          `<stop offset="0" stop-color="hsl(${hue.toFixed(0)} 45% 18%)"/><stop offset="1" stop-color="hsl(${((hue + 40) % 360).toFixed(0)} 40% 8%)"/>` +
          `</linearGradient></defs>` +
          `<rect width="1024" height="576" fill="url(#g)"/>` +
          `<text x="512" y="280" fill="#e6ebf7" font-family="system-ui,sans-serif" font-size="34" text-anchor="middle">${escapeXml(label)}</text>` +
          `<text x="512" y="322" fill="#8b93a7" font-family="system-ui,sans-serif" font-size="18" text-anchor="middle">artwork not generated — no media provider available</text>` +
          `</svg>`;
        return { kind: "image", uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, mime: "image/svg+xml", placeholder: true, _model: "deterministic" };
      }
      // Audio and video have no honest local synthesis, so the caller is told
      // plainly that the asset is absent rather than handed silence that looks real.
      return { kind: req.kind, uri: null, mime: null, placeholder: true, unavailable_reason: "no media provider is configured for this kind", _model: "deterministic" };
    },
  };
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
}

export function mediaAdapters(env = process.env) {
  return [kinixAdapter(env), togetherMediaAdapter(env), placeholderMediaAdapter()];
}
