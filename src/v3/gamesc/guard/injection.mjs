// GAMES-C guard — script / markup / template injection in manifest strings.
//
// Manifests are DATA. Titles, NPC lines, quest text, UI labels and asset names
// come from users and from language models, and some of them are rendered into
// the DOM by the play page. This module (1) scans every string field for the
// shapes an injection takes, and (2) provides the one sanitiser the display
// path should use. Scanning is advisory for review; sanitising is mandatory
// for display.

export const INJECTION_PATTERNS = Object.freeze([
  { code: "script_tag", re: /<\s*\/?\s*script\b/i },
  { code: "event_handler", re: /\bon[a-z]{3,20}\s*=/i },
  { code: "javascript_url", re: /\bjavascript\s*:/i },
  { code: "vbscript_url", re: /\bvbscript\s*:/i },
  { code: "data_html", re: /\bdata\s*:\s*text\/html/i },
  { code: "dangerous_tag", re: /<\s*(iframe|object|embed|svg|math|link|meta|style|base|form|img)\b/i },
  { code: "eval_call", re: /\beval\s*\(/ },
  { code: "function_ctor", re: /\b(?:new\s+)?Function\s*\(/ },
  { code: "timer_string", re: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/ },
  { code: "import_call", re: /\bimport\s*\(/ },
  { code: "proto_pollution", re: /__proto__|constructor\s*\.\s*prototype/ },
  { code: "template_expr", re: /\$\{[^}]*\}|\{\{[^}]*\}\}|<%[\s\S]*?%>|#\{[^}]*\}/ },
  { code: "css_expression", re: /expression\s*\(|url\s*\(\s*["']?\s*javascript:/i },
]);

/** Object keys that are prototype-pollution vectors when merged. */
export const FORBIDDEN_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

/**
 * Walk a manifest (or any JSON) and report every string that matches an
 * injection pattern, and every forbidden key.
 * @returns {{ok:boolean, findings:Array<{path,code,excerpt}>}}
 */
export function scanForInjection(value, { maxFindings = 200 } = {}) {
  const findings = [];
  const seen = new Set();
  const walk = (v, path) => {
    if (findings.length >= maxFindings) return;
    if (typeof v === "string") {
      for (const p of INJECTION_PATTERNS) {
        if (p.re.test(v)) findings.push({ path, code: p.code, excerpt: v.slice(0, 80) });
      }
      return;
    }
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.includes(k)) findings.push({ path: `${path}.${k}`, code: "forbidden_key", excerpt: k });
      walk(v[k], `${path}.${k}`);
    }
    // JSON.parse keeps an own "__proto__" key; Object.keys lists it. Covered above.
  };
  walk(value, "$");
  return { ok: findings.length === 0, findings };
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;", "=": "&#61;" };

/**
 * Sanitise untrusted text for display. HTML-escapes, strips control and
 * bidi-override characters (Trojan-Source style spoofing), neutralises
 * template delimiters, and caps length. Output is safe for textContent AND for
 * innerHTML/attribute contexts.
 */
export function sanitizeText(s, { maxLength = 2000 } = {}) {
  if (s === null || s === undefined) return "";
  let t = String(s).normalize("NFKC");
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "");
  if (t.length > maxLength) t = t.slice(0, maxLength) + "…";
  t = t.replace(/[&<>"'`=]/g, (c) => ESC[c]);
  t = t.replace(/\$\{/g, () => "&#36;&#123;").replace(/\{\{/g, () => "&#123;&#123;");
  return t;
}

/** Deep-sanitise every string in a value (returns a copy). Drops forbidden keys. */
export function sanitizeDeep(value, opts) {
  if (typeof value === "string") return sanitizeText(value, opts);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, opts));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!FORBIDDEN_KEYS.includes(k)) out[k] = sanitizeDeep(v, opts);
    return out;
  }
  return value;
}
