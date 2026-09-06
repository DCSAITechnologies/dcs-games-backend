#!/usr/bin/env node
// A7 — secret scan. Fails the build if a credential is committed, or if a
// service-role key or private key could reach a client bundle or a log line.
import fs from "node:fs";
import path from "node:path";

const ROOTS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const TARGETS = ROOTS.length ? ROOTS : [process.cwd()];
const SKIP_DIRS = new Set([".git", "node_modules", ".dcs-data", "dist", "build", "forensics"]);

/**
 * A Supabase anon key is publishable by design and MUST be in the client for
 * auth to work; a service-role key in the same place is a breach. Decode the
 * claim and judge on the role rather than on the shape of the token.
 */
function jwtIsPrivileged(line) {
  const m = /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/.exec(line);
  if (!m) return true;
  try {
    const claims = JSON.parse(Buffer.from(m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const role = String(claims.role || claims.aud || "").toLowerCase();
    return role !== "anon" && role !== "authenticated";
  } catch {
    return true;   // undecodable: treat as privileged
  }
}

const RULES = [
  { id: "supabase-service-role", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, why: "a privileged JWT (service-role or similar)", check: jwtIsPrivileged },
  { id: "openai-style-key", re: /\bsk-[A-Za-z0-9]{20,}/, why: "an OpenAI-style secret key" },
  { id: "cerebras-key", re: /\bcsk-[A-Za-z0-9]{20,}/, why: "a Cerebras key" },
  { id: "together-key", re: /\btgp_v1_[A-Za-z0-9_-]{20,}/, why: "a Together.ai key" },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/, why: "an AWS access key id" },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, why: "a GitHub token" },
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, why: "a private key block", check: (line) => !/^\s*(?:\/\/|#|\*|--)/.test(line) && !/["'`]\s*$/.test(line.trim()) },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, why: "a Slack token" },
  { id: "generic-assignment", re: /(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/_\-]{24,}["']/i, why: "a hardcoded credential assignment" },
];

// Placeholders and documentation are not secrets.
const BENIGN = [
  /YOUR[_-]?[A-Z]/i, /<[^>]+>/, /xxx+/i, /\.\.\./, /example/i, /placeholder/i,
  /process\.env\./, /\$\{/, /test-secret|integration-secret|not-a-real-key|attacker-secret/,
  /REDACTED/i, /changeme/i,
];

// Files that must never reference a server-only secret at all.
const CLIENT_PATTERNS = [/\.html$/, /assets\/.*\.js$/, /public\//];
const SERVER_ONLY_ENV = /SUPABASE_SERVICE_ROLE_KEY|ATLAS_PRIVATE_KEY|DCS_AUTH_SECRET|DEEPSEEK_API_KEY|CEREBRAS_API_KEY|TOGETHER_API_KEY/;

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(mjs|js|ts|mts|cjs|json|html|css|md|yml|yaml|sh|sql|txt|env|example)$/.test(e.name) || e.name.startsWith(".env")) yield full;
  }
}

const findings = [];
for (const root of TARGETS) {
  if (!fs.existsSync(root)) continue;
  for (const f of walk(root)) {
    const rel = path.relative(root, f);
    let src;
    try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (BENIGN.some((b) => b.test(line))) return;
      for (const r of RULES) {
        if (r.re.test(line) && (!r.check || r.check(line))) {
          findings.push({ file: rel, line: i + 1, rule: r.id, why: r.why, excerpt: line.trim().slice(0, 90) });
        }
      }
      if (CLIENT_PATTERNS.some((p) => p.test(rel)) && SERVER_ONLY_ENV.test(line)) {
        findings.push({ file: rel, line: i + 1, rule: "server-secret-in-client", why: "a server-only secret name appears in a client-served file", excerpt: line.trim().slice(0, 90) });
      }
    });
  }
}

// A committed .env is a finding regardless of contents.
for (const root of TARGETS) {
  const env = path.join(root, ".env");
  if (fs.existsSync(env)) {
    const ignored = fs.existsSync(path.join(root, ".gitignore")) && /^\s*\.env\s*$/m.test(fs.readFileSync(path.join(root, ".gitignore"), "utf8"));
    if (!ignored) findings.push({ file: ".env", line: 0, rule: "unignored-env", why: ".env exists and is not in .gitignore", excerpt: "" });
  }
}

console.log(`secret scan — ${TARGETS.join(", ")}`);
if (findings.length) {
  for (const f of findings) console.log(`  ${f.file}:${f.line} [${f.rule}] ${f.why}\n      > ${f.excerpt}`);
  console.log(`\nRESULT: FAILED (${findings.length} finding(s))`);
  process.exit(1);
}
console.log("RESULT: CLEAN (no credential found in tracked source)");
