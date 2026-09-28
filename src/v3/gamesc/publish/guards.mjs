// guards.mjs — preconditions and staging-only guards for the publish pipeline.
//
// Pure functions. Nothing here touches the network, the filesystem or an env
// var it was not handed.

// ------------------------------------------------------------------ secrets
//
// Patterns mirror scripts/secret-scan.mjs (RULES + BENIGN, 7 Sep 2026 rewrite).
// That file is a CLI that walks the tree and calls process.exit at import time,
// so it cannot be imported; the proposed refactor (export RULES/BENIGN from a
// side-effect-free module) is in DCS_GAMES_PUBLISH_PIPELINE.md. Until then the
// two lists must be kept in step by hand — the test suite pins a sample of each.

const SLUG = /^[a-z]+[0-9]*(?:[-_][a-z]+[0-9]*){2,}$/;
function isWordSlug(literal) {
  if (!SLUG.test(literal)) return false;
  return literal.split(/[-_]/).every((seg) => seg.replace(/[0-9]+$/, "").length <= 12);
}
function jwtIsPrivileged(match) {
  const parts = match.split(".");
  if (parts.length < 2) return true;
  try {
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const role = String(claims.role || claims.aud || "").toLowerCase();
    return role !== "anon" && role !== "authenticated";
  } catch { return true; }
}

export const SECRET_RULES = [
  { id: "supabase-service-role", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, check: jwtIsPrivileged },
  { id: "openai-style-key", re: /\bsk-[A-Za-z0-9]{20,}/ },
  { id: "cerebras-key", re: /\bcsk-[A-Za-z0-9]{20,}/ },
  { id: "together-key", re: /\btgp_v1_[A-Za-z0-9_-]{20,}/ },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    id: "generic-assignment",
    re: /(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*["'`]([A-Za-z0-9+/_\-]{24,})["'`]/i,
    literalGroup: 1,
    check: (_m, literal) => !isWordSlug(literal),
  },
  // A published game has no business naming a server-only credential at all.
  { id: "server-only-env-name", re: /SUPABASE_SERVICE_ROLE_KEY|ATLAS_PRIVATE_KEY|ATLAS_SIGNING_SK_B64|DCS_AUTH_SECRET|DEEPSEEK_API_KEY|CEREBRAS_API_KEY|TOGETHER_API_KEY/ },
];
const BENIGN = [
  /YOUR[_-]?[A-Z]/i, /^<[^>]*>$/, /xxxx/i, /\.\.\./, /example/i, /placeholder/i,
  /^process\.env\./, /\$\{/, /test-secret|integration-secret|not-a-real|attacker-secret|fixture/i,
  /REDACTED/i, /changeme/i, /^0+$/,
];

function scanText(text, where, out) {
  for (const r of SECRET_RULES) {
    const m = text.match(r.re);
    if (!m) continue;
    const literal = r.literalGroup ? m[r.literalGroup] : m[0];
    if (BENIGN.some((b) => b.test(literal))) continue;
    if (r.check && !r.check(m[0], literal)) continue;
    // never echo the matched text: a finding must not become the leak
    out.push({ code: "secret_like", path: where, message: `looks like ${r.id}` });
  }
}

/** Deep-scan every string (and key:value pair) of a JSON value. */
export function scanSecrets(value, rootPath = "$") {
  const out = [];
  (function walk(v, p, key) {
    if (typeof v === "string") {
      scanText(v, p, out);
      if (key != null) scanText(`${key}: "${v}"`, p, out);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`, null));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) { scanText(k, `${p}.${k}`, out); walk(v[k], `${p}.${k}`, k); }
  })(value, rootPath, null);
  // one finding per path+rule is enough
  const seen = new Set();
  return out.filter((f) => { const k = f.path + f.message; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function scanTextSecrets(text, where) { const out = []; scanText(text, where, out); return out; }

// --------------------------------------------------------------- URLs / MIME

export const DEFAULT_MIME_ALLOWLIST = Object.freeze([
  "model/gltf-binary", "model/gltf+json",
  "image/png", "image/jpeg", "image/webp", "image/ktx2",
  "audio/ogg", "audio/mpeg", "audio/wav",
  "application/json", "text/plain",
]);
// Explicitly refused even if someone adds them to an allowlist: each can carry
// script into the page that hosts the runtime.
export const NEVER_MIME = Object.freeze(["text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript", "application/wasm"]);
export const TEXT_MIME = new Set(["application/json", "text/plain", "model/gltf+json"]);

const MAGIC = {
  "model/gltf-binary": (b) => b.length >= 4 && b.subarray(0, 4).toString("latin1") === "glTF",
  "image/png": (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};
export function magicMatches(mime, bytes) { const f = MAGIC[mime]; return f ? f(bytes) : true; }

/**
 * Every URL-shaped string in the manifest. External (http/https or
 * protocol-relative) hosts must be on the allowlist; other schemes are refused;
 * package-relative `assets/...` refs must resolve to a packaged file.
 */
export function checkUrls(manifest, { hostAllowlist = [], packagedPaths = new Set() } = {}) {
  const errs = [];
  const allow = new Set(hostAllowlist.map((h) => String(h).toLowerCase()));
  (function walk(v, p) {
    if (typeof v === "string") {
      const s = v.trim();
      if (/^(?:javascript|vbscript|file|blob|data):/i.test(s)) { errs.push({ code: "disallowed_url_scheme", path: p, message: `scheme '${s.split(":")[0].toLowerCase()}:' is not allowed in a published game` }); return; }
      if (/^(?:https?:)?\/\//i.test(s)) {
        let host = "";
        try { host = new URL(s.startsWith("//") ? "https:" + s : s).hostname.toLowerCase(); } catch { errs.push({ code: "external_url_unparseable", path: p, message: "unparseable external URL" }); return; }
        if (!allow.has(host)) errs.push({ code: "external_url_not_allowlisted", path: p, message: `external host '${host}' is not on the asset allowlist` });
        return;
      }
      if (/^\.?\/?assets\//.test(s)) {
        const norm = s.replace(/^\.?\//, "");
        if (!packagedPaths.has(norm)) errs.push({ code: "asset_missing", path: p, message: `'${norm}' is referenced but not in the package` });
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`);
  })(manifest, "$");
  return errs;
}

// ------------------------------------------------------- staging-only guard

// Hosts that ARE production. Anything under dcsai.ai without a staging marker
// is treated as production too — fail closed.
export const PRODUCTION_HOSTS = Object.freeze(["games.dcsai.ai", "api.games.dcsai.ai", "dcsai.ai", "www.dcsai.ai"]);
const STAGING_MARKER = /(^|[.-])(staging|stage|preview)([.-]|$)/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class ProductionTargetError extends Error {
  constructor(msg) { super(msg); this.name = "ProductionTargetError"; this.code = "production_target_refused"; }
}

/** Throws ProductionTargetError unless `urlOrHost` is local or carries an explicit staging marker. */
export function assertStagingTarget(urlOrHost) {
  let host;
  try { host = (String(urlOrHost).includes("://") ? new URL(urlOrHost).hostname : String(urlOrHost).split(/[/:]/)[0]).toLowerCase(); }
  catch { throw new ProductionTargetError(`unparseable preview target; refusing`); }
  if (!host) throw new ProductionTargetError("empty preview target; refusing");
  if (LOCAL_HOSTS.has(host)) return host;
  const labels = host.replace(/\.$/, "");
  if (PRODUCTION_HOSTS.includes(labels)) throw new ProductionTargetError(`'${host}' is a production host; the GAMES-C pipeline only stages`);
  // On *.pages.dev the bare <project>.pages.dev IS the production deployment;
  // only a branch alias with a staging marker is a staging target.
  const sub = labels.endsWith(".pages.dev") ? labels.slice(0, -".pages.dev".length).split(".").slice(0, -1).join(".") : labels;
  if (!STAGING_MARKER.test(sub)) throw new ProductionTargetError(`'${host}' carries no staging marker (staging/stage/preview); refusing to treat it as staging`);
  return host;
}

/** Checks every publish-relevant env var this lane knows about. */
export function assertStagingOnlyEnv(env = process.env) {
  for (const k of ["DCS_STAGING_PREVIEW_BASE", "DCS_PUBLISH_TARGET", "DCS_STAGING_ORIGIN"]) {
    if (env[k]) assertStagingTarget(env[k]);
  }
  return true;
}
