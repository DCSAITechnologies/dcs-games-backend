// GAMES-C guard — generated-code policy and play-page sandbox rules.
//
// POLICY: no generated code is ever executed. Providers, the companion and
// users produce DATA-ONLY manifests and patches; the runtime (dcs-runtime.js)
// interprets a closed set of behaviour kinds (schema.mjs BEHAVIOR_KINDS). A
// manifest that carries a code-shaped field is refused before it is stored.
//
// The CSP / iframe values below are PROPOSALS for the play page. They are not
// applied anywhere by this module (the frontend is a separate repo); the lead
// decides whether to ship them via _headers.

/** Keys that would mean "run this": refused anywhere in a manifest/patch. */
export const CODE_KEYS = Object.freeze([
  "script", "scripts", "code", "js", "javascript", "source_code", "eval", "function", "handler_code",
  "onload", "onclick", "oninit", "wasm", "shader_source", "glsl", "lua", "python", "exec", "cmd", "command",
]);

/**
 * Assert a manifest/patch is data-only: no function values, no code-named keys,
 * no strings that parse as a function/arrow expression.
 */
export function assertDataOnly(value) {
  const findings = [];
  const walk = (v, path) => {
    if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") { findings.push({ path, code: "non_json_value" }); return; }
    if (typeof v === "string") {
      if (/^\s*(?:async\s+)?function\s*[\w$]*\s*\(/.test(v) || /^\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/.test(v)) findings.push({ path, code: "code_string" });
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        // schema.mjs:181 still ACCEPTS `behaviors[].script` as an alternative to
        // `spec`; assembly.mjs always writes script:null. A null/empty code key
        // is inert and allowed; any populated one is refused.
        if (CODE_KEYS.includes(k.toLowerCase()) && x !== null && x !== undefined && x !== "") findings.push({ path: `${path}.${k}`, code: "code_key" });
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(value, "$");
  return { ok: findings.length === 0, findings };
}

/** PROPOSED Content-Security-Policy for play-v3.html (not yet deployed). */
export const PLAY_PAGE_CSP = Object.freeze({
  "default-src": ["'self'"],
  "script-src": ["'self'", "https://cdnjs.cloudflare.com"],   // three.js; add SRI on the tag
  "style-src": ["'self'", "'unsafe-inline'"],                   // existing inline styles; tighten later
  "img-src": ["'self'", "data:", "https://games.dcsai.ai", "https://assets.dcsai.ai"],
  "media-src": ["'self'", "data:", "https://assets.dcsai.ai"],
  "connect-src": ["'self'", "https://api.games.dcsai.ai", "wss://api.games.dcsai.ai", "https://assets.dcsai.ai"],
  "worker-src": ["'self'", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "frame-ancestors": ["'self'"],
  "form-action": ["'self'"],
});

export function cspHeader(policy = PLAY_PAGE_CSP) {
  return Object.entries(policy).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

/** PROPOSED iframe sandbox for embedding a published preview (UGC). No allow-same-origin together with allow-scripts. */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-pointer-lock";
export const PREVIEW_IFRAME_ALLOW = "fullscreen; gamepad";

/** Reject a CSP that re-enables code execution from strings or wildcard script hosts. */
export function checkCsp(header) {
  const problems = [];
  const h = String(header || "");
  const scriptSrc = /script-src([^;]*)/.exec(h)?.[1] ?? /default-src([^;]*)/.exec(h)?.[1] ?? "";
  if (/'unsafe-eval'/.test(scriptSrc)) problems.push("unsafe-eval in script-src");
  if (/'unsafe-inline'/.test(scriptSrc) && !/'nonce-|'sha256-/.test(scriptSrc)) problems.push("unsafe-inline in script-src without nonce/hash");
  if (/(^|\s)(\*|https:|http:|data:)(\s|$)/.test(scriptSrc)) problems.push("wildcard/scheme source in script-src");
  if (!/object-src\s+'none'/.test(h)) problems.push("object-src not 'none'");
  if (!/base-uri/.test(h)) problems.push("base-uri missing");
  return { ok: problems.length === 0, problems };
}

export function checkIframeSandbox(attr) {
  const t = String(attr || "").split(/\s+/).filter(Boolean);
  const problems = [];
  if (t.includes("allow-scripts") && t.includes("allow-same-origin")) problems.push("allow-scripts + allow-same-origin lets the frame remove its own sandbox");
  for (const bad of ["allow-top-navigation", "allow-popups-to-escape-sandbox", "allow-modals", "allow-downloads"]) if (t.includes(bad)) problems.push(`${bad} not permitted`);
  return { ok: problems.length === 0, problems };
}
