// GAMES-C patch — data-only value checks. A patch carries DATA, never code.
import { LIMITS } from "./whitelist.mjs";

export const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const KEY_RE = /^[A-Za-z0-9_+\-.:#]{1,64}$/;
export const ID_RE = /^[A-Za-z0-9_\-:.]{1,96}$/;

const CODE_PATTERNS = [
  /<\s*\/?\s*(script|iframe|object|embed|svg|img|style|link|meta|form|base)\b/i,
  /\bon[a-z]{3,}\s*=/i,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bFunction\s*\(/,
  /\bimport\s*\(/,
  /\brequire\s*\(/,
  /=>/,
  /\bfunction\s*[A-Za-z0-9_$]*\s*\(/,
  /\b(document|window|globalThis|process)\s*\.\s*[A-Za-z_]/,
  /\$\{[^}]*\}/,
  /\bsetTimeout\s*\(|\bsetInterval\s*\(/,
];
const URL_PATTERNS = [
  /\b(?:https?|ftp|file|wss?|data|javascript|vbscript|blob|about|chrome):/i,
  /\/\/[a-z0-9-]+\.[a-z]{2,}/i,
  /\bwww\.[a-z0-9-]+\./i,
];

export function looksLikeCode(s) { return CODE_PATTERNS.some((re) => re.test(s)); }
export function looksLikeUrl(s) { return URL_PATTERNS.some((re) => re.test(s)); }

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
export { isPlainObject };

/**
 * Walk a value and push {path, message} for anything that is not plain, bounded,
 * code-free JSON data. `allowUrlAt` is a set of exact dotted sub-paths where a
 * URL string is tolerated (the caller then applies its own allowlist).
 * `trusted` skips only the content heuristics (code/url) — structural checks
 * (types, finiteness, pollution keys, depth) always run.
 */
export function checkData(value, basePath, out, { allowUrlAt = new Set(), trusted = false } = {}) {
  const walk = (v, path, rel, depth) => {
    if (depth > LIMITS.MAX_DEPTH) { out.push({ path, message: `nesting deeper than ${LIMITS.MAX_DEPTH}` }); return; }
    if (v === null || typeof v === "boolean") return;
    if (typeof v === "number") { if (!Number.isFinite(v)) out.push({ path, message: "numbers must be finite" }); return; }
    if (typeof v === "string") {
      if (v.length > LIMITS.MAX_STRING) out.push({ path, message: `string longer than ${LIMITS.MAX_STRING}` });
      if (!trusted) {
        if (looksLikeCode(v)) out.push({ path, message: "string looks like code/script; patches carry data only" });
        if (!allowUrlAt.has(rel) && looksLikeUrl(v)) out.push({ path, message: "URL not permitted in this field" });
      }
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > LIMITS.MAX_ARRAY) { out.push({ path, message: `array longer than ${LIMITS.MAX_ARRAY}` }); return; }
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) { out.push({ path: `${path}[${i}]`, message: "sparse arrays are not data" }); continue; }
        walk(v[i], `${path}[${i}]`, rel, depth + 1);
      }
      return;
    }
    if (!isPlainObject(v)) { out.push({ path, message: `unsupported value type (${typeof v})` }); return; }
    const keys = Reflect.ownKeys(v);
    if (keys.length > LIMITS.MAX_KEYS) { out.push({ path, message: `more than ${LIMITS.MAX_KEYS} keys` }); return; }
    for (const k of keys) {
      if (typeof k !== "string") { out.push({ path, message: "symbol keys are not data" }); continue; }
      if (POLLUTION_KEYS.has(k)) { out.push({ path: `${path}.${k}`, message: `forbidden key '${k}' (prototype pollution)` }); continue; }
      if (!KEY_RE.test(k)) { out.push({ path: `${path}.${k}`, message: "invalid key name" }); continue; }
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !("value" in d)) { out.push({ path: `${path}.${k}`, message: "accessor properties are not data" }); continue; }
      walk(d.value, `${path}.${k}`, rel ? `${rel}.${k}` : k, depth + 1);
    }
  };
  walk(value, basePath, "", 0);
  return out;
}
