// GAMES-C guard — secret leakage in manifests, packages and logs.
//
// The rule set MIRRORS scripts/secret-scan.mjs (7 Sep 2026 rewrite). That file
// is a CLI with top-level side effects (it walks the cwd and calls
// process.exit), so it cannot be imported; the rules are copied here verbatim
// in shape and the lead is asked (see final report) to extract them into a
// shared module both can import. Same design lesson applies: the benign
// allowlist is judged against the MATCHED TEXT only, never the whole line.

function jwtIsPrivileged(match) {
  const parts = match.split(".");
  if (parts.length < 2) return true;
  try {
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const role = String(claims.role || claims.aud || "").toLowerCase();
    return role !== "anon" && role !== "authenticated";
  } catch { return true; }
}

const SLUG = /^[a-z]+[0-9]*(?:[-_][a-z]+[0-9]*){2,}$/;
function isWordSlug(literal) {
  if (!SLUG.test(literal)) return false;
  return literal.split(/[-_]/).every((seg) => seg.replace(/[0-9]+$/, "").length <= 12);
}

export const SECRET_RULES = Object.freeze([
  { id: "supabase-service-role", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, check: jwtIsPrivileged },
  { id: "openai-style-key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { id: "cerebras-key", re: /\bcsk-[A-Za-z0-9]{20,}/g },
  { id: "together-key", re: /\btgp_v1_[A-Za-z0-9_-]{20,}/g },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "bearer-header", re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{24,}=*/g },
  {
    id: "generic-assignment",
    re: /(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)["']?\s*[:=]\s*["'`]([A-Za-z0-9+/_\-]{24,})["'`]/gi,
    literalGroup: 1,
    check: (_m, literal) => !isWordSlug(literal),
  },
]);

const BENIGN = [
  /YOUR[_-]?[A-Z]/i, /^<[^>]*>$/, /xxxx/i, /\.\.\./, /example/i, /placeholder/i,
  /^process\.env\./, /\$\{/, /test-secret|integration-secret|not-a-real|attacker-secret|fixture/i,
  /REDACTED/i, /changeme/i, /^0+$/,
];

/** Env var NAMES that must never appear in client-served output. */
export const SERVER_ONLY_ENV = /SUPABASE_SERVICE_ROLE_KEY|ATLAS_PRIVATE_KEY|DCS_AUTH_SECRET|DEEPSEEK_API_KEY|CEREBRAS_API_KEY|TOGETHER_API_KEY|KINIX_API_KEY/;

/** Scan text. Findings carry rule + offset, NEVER the secret itself. */
export function scanText(text, { clientFacing = false } = {}) {
  const s = String(text ?? "");
  const findings = [];
  for (const r of SECRET_RULES) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(s))) {
      const literal = r.literalGroup ? m[r.literalGroup] : m[0];
      if (!BENIGN.some((b) => b.test(literal)) && (!r.check || r.check(m[0], literal))) {
        findings.push({ rule: r.id, index: m.index, length: m[0].length });
      }
      if (m[0].length === 0) r.re.lastIndex++;
    }
  }
  if (clientFacing) {
    const m = SERVER_ONLY_ENV.exec(s);
    if (m) findings.push({ rule: "server-secret-in-client", index: m.index, length: m[0].length });
  }
  return { ok: findings.length === 0, findings };
}

/** Scan every string in a JSON value (manifest, publish package, log record). */
export function scanValue(value, opts) {
  const findings = [];
  const walk = (v, path) => {
    if (typeof v === "string") { for (const f of scanText(v, opts).findings) findings.push({ path, rule: f.rule }); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (/^(api[_-]?key|secret|password|token|private[_-]?key|authorization)$/i.test(k) && typeof x === "string" && x.length >= 8 && !BENIGN.some((b) => b.test(x))) {
        findings.push({ path: `${path}.${k}`, rule: "secret-field" });
      }
      walk(x, `${path}.${k}`);
    }
  };
  walk(value, "$");
  return { ok: findings.length === 0, findings };
}

/** Replace every detected secret with [REDACTED:<rule>]. Safe for logs. */
export function redact(text) {
  let s = String(text ?? "");
  const hits = scanText(s).findings.sort((a, b) => b.index - a.index);
  for (const h of hits) s = s.slice(0, h.index) + `[REDACTED:${h.rule}]` + s.slice(h.index + h.length);
  return s;
}

/** Deep redaction of a JSON value (copy), including secret-named fields. */
export function redactValue(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /^(api[_-]?key|secret|password|token|private[_-]?key|authorization)$/i.test(k) && typeof v === "string" ? "[REDACTED:secret-field]" : redactValue(v);
    }
    return out;
  }
  return value;
}
