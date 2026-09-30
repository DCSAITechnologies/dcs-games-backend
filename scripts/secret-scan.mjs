#!/usr/bin/env node
// A7 — secret scan. Fails the build if a credential is committed, or if a
// service-role key or private key could reach a client bundle or a log line.
//
// Rewritten 7 Sep 2026 after the previous version was tested against synthetic
// secrets in a scratch directory and let SIX realistic cases through. The
// failures all came from one design mistake — the placeholder allowlist was
// applied to the WHOLE LINE before any rule ran, so any line that happened to
// contain an HTML tag, an ellipsis or the text `process.env.` was exempt from
// every rule. A key inside `<script>...</script>`, a key on a line carrying a
// `// ...` comment, and `process.env.X || "<real key>"` — the single most
// common way a credential actually gets committed — were all reported CLEAN.
//
// The allowlist is now applied to the MATCHED TEXT, so a placeholder can only
// excuse itself, never its neighbours on the same line.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOTS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const TARGETS = ROOTS.length ? ROOTS : [process.cwd()];

// Known synthetic test credentials, excused ONE AT A TIME: an entry names the
// file (relative to the scanned root), the rule, and the sha256 of the exact
// matched literal. A different literal in the same file, or the same literal
// anywhere else, is still a finding — nothing is excused by pattern or by path
// alone. DCS_SECRET_SCAN_ALLOWLIST points at another file (tests use it).
const ALLOWLIST_FILE = process.env.DCS_SECRET_SCAN_ALLOWLIST
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "secret-scan-allowlist.json");
const ALLOWED = (() => {
  if (!fs.existsSync(ALLOWLIST_FILE)) return [];
  const list = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf8")).entries || [];
  for (const e of list) {
    if (!e.path || !e.rule || !/^[0-9a-f]{64}$/.test(e.sha256 || "") || !e.reason) {
      console.log(`RESULT: FAILED — allowlist entry is incomplete (path, rule, sha256, reason all required): ${JSON.stringify(e)}`);
      process.exit(1);
    }
  }
  return list;
})();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const allowed = (rel, rule, literal) => ALLOWED.find((e) => e.path === rel && e.rule === rule && e.sha256 === sha256(literal));
const allowlisted = [];

// Directories with nothing of our own in them. `forensics` is deliberately NOT
// here: the forensic quarantine is a ban on EXECUTING that content, not a
// licence to stop looking for credentials inside it.
const SKIP_DIRS = new Set([".git", "node_modules", ".dcs-data", "dist", "build", "coverage", ".next", ".wrangler"]);

// Binary and media extensions only. Everything else is read as text, so an
// extensionless Dockerfile/Procfile and a .toml/.tf/.ini config are all
// scanned — three of the six synthetic misses were files the old walk simply
// never opened.
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|m4[av]|mov|avi|mkv|webm|wav|flac|ogg|ttf|otf|woff2?|eot|wasm|so|dylib|dll|exe|bin|dat|db|sqlite3?|bundle|pack|idx|node|class|jar|pyc)$/i;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * A Supabase anon key is publishable by design and MUST be in the client for
 * auth to work; a service-role key in the same place is a breach. Decode the
 * claim and judge on the role rather than on the shape of the token.
 */
function jwtIsPrivileged(match) {
  const parts = match.split(".");
  if (parts.length < 2) return true;
  try {
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const role = String(claims.role || claims.aud || "").toLowerCase();
    return role !== "anon" && role !== "authenticated";
  } catch {
    return true;   // undecodable: treat as privileged
  }
}

/**
 * `generic-assignment` is the only shape-blind rule, so it is the only one that
 * needs a discriminator. A generated credential is not a lowercase word slug:
 * `deploy-probe-not-a-real-token` is a name someone typed, `A1b2C3d4...` is not.
 * Segments must be letters with at most trailing digits, so a UUID or a hex
 * string (`550e8400`, `a1b2c3d4`) is NOT excused.
 *
 * KNOWN BLIND SPOT, stated rather than hidden: a human-chosen passphrase such
 * as `my-super-secret-password` has slug shape and is not reported by this
 * rule. Every format-specific rule above is exempt from this test, so a real
 * provider key, AWS id, GitHub token, Slack token or private key is still
 * caught regardless of shape.
 */
const SLUG = /^[a-z]+[0-9]*(?:[-_][a-z]+[0-9]*){2,}$/;
function isWordSlug(literal) {
  if (!SLUG.test(literal)) return false;
  return literal.split(/[-_]/).every((seg) => seg.replace(/[0-9]+$/, "").length <= 12);
}

const RULES = [
  { id: "supabase-service-role", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, why: "a privileged JWT (service-role or similar)", check: jwtIsPrivileged },
  { id: "openai-style-key", re: /\bsk-[A-Za-z0-9]{20,}/, why: "an OpenAI-style secret key" },
  { id: "cerebras-key", re: /\bcsk-[A-Za-z0-9]{20,}/, why: "a Cerebras key" },
  { id: "together-key", re: /\btgp_v1_[A-Za-z0-9_-]{20,}/, why: "a Together.ai key" },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/, why: "an AWS access key id" },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, why: "a GitHub token" },
  { id: "private-key-block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, why: "a private key block", checkLine: (line) => !/^\s*(?:\/\/|#|\*|--)/.test(line) },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, why: "a Slack token" },
  {
    id: "generic-assignment",
    re: /(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*["'`]([A-Za-z0-9+/_\-]{24,})["'`]/i,
    why: "a hardcoded credential assignment",
    literalGroup: 1,
    check: (_m, literal) => !isWordSlug(literal),
  },
];

// Placeholders and documentation are not secrets — judged against the MATCHED
// TEXT, never against the rest of the line.
const BENIGN = [
  /YOUR[_-]?[A-Z]/i, /^<[^>]*>$/, /xxxx/i, /\.\.\./, /example/i, /placeholder/i,
  /^process\.env\./, /\$\{/, /test-secret|integration-secret|not-a-real|attacker-secret|fixture/i,
  /REDACTED/i, /changeme/i, /^0+$/,
];

// Files that must never reference a server-only secret at all.
const CLIENT_PATTERNS = [/\.html$/, /assets\/.*\.js$/, /public\//];
const SERVER_ONLY_ENV = /SUPABASE_SERVICE_ROLE_KEY|ATLAS_PRIVATE_KEY|DCS_AUTH_SECRET|DEEPSEEK_API_KEY|CEREBRAS_API_KEY|TOGETHER_API_KEY/;

const NUL = String.fromCharCode(0);

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.isSymbolicLink()) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && !BINARY.test(e.name)) yield full;
  }
}

const findings = [];
let scanned = 0;
const perRoot = [];

for (const root of TARGETS) {
  if (!fs.existsSync(root)) { perRoot.push({ root, files: 0, missing: true }); continue; }
  let files = 0;
  for (const f of walk(root)) {
    const rel = path.relative(root, f) || path.basename(f);
    let src;
    try {
      if (fs.statSync(f).size > MAX_BYTES) continue;
      src = fs.readFileSync(f, "utf8");
    } catch { continue; }
    if (src.includes(NUL)) continue;          // binary that slipped the extension test
    files++; scanned++;
    src.split("\n").forEach((line, i) => {
      for (const r of RULES) {
        const m = r.re.exec(line);
        if (!m) continue;
        const literal = r.literalGroup ? m[r.literalGroup] : m[0];
        if (BENIGN.some((b) => b.test(literal))) continue;
        if (r.checkLine && !r.checkLine(line)) continue;
        if (r.check && !r.check(m[0], literal)) continue;
        const a = allowed(rel.split(path.sep).join("/"), r.id, literal);
        if (a) { allowlisted.push({ file: rel, line: i + 1, rule: r.id, reason: a.reason }); continue; }
        findings.push({ file: rel, line: i + 1, rule: r.id, why: r.why, excerpt: line.trim().slice(0, 90) });
      }
      if (CLIENT_PATTERNS.some((p) => p.test(rel)) && SERVER_ONLY_ENV.test(line)) {
        findings.push({ file: rel, line: i + 1, rule: "server-secret-in-client", why: "a server-only secret name appears in a client-served file", excerpt: line.trim().slice(0, 90) });
      }
    });
  }
  perRoot.push({ root, files, missing: false });
}

// A committed .env is a finding regardless of contents.
for (const root of TARGETS) {
  const env = path.join(root, ".env");
  if (fs.existsSync(env)) {
    const gi = path.join(root, ".gitignore");
    const ignored = fs.existsSync(gi) && /^\s*\.env\s*$/m.test(fs.readFileSync(gi, "utf8"));
    if (!ignored) findings.push({ file: ".env", line: 0, rule: "unignored-env", why: ".env exists and is not in .gitignore", excerpt: "" });
  }
}

console.log(`secret scan — ${TARGETS.join(", ")}`);
for (const r of perRoot) {
  console.log(`  ${r.root}: ${r.missing ? "MISSING — not scanned" : `${r.files} file(s) read`}`);
}

// A pass over nothing is not a pass. The old script printed CLEAN whether it
// had read 183 files or none.
const emptyRoot = perRoot.find((r) => !r.missing && r.files === 0);
if (emptyRoot) {
  console.log(`\nRESULT: FAILED — root ${emptyRoot.root} exists but yielded no readable file; the scan proved nothing.`);
  process.exit(1);
}

// Every excused hit is printed, so an allowlist can never hide anything quietly.
for (const a of allowlisted) console.log(`  allowlisted ${a.file}:${a.line} [${a.rule}] — ${a.reason}`);

if (findings.length) {
  for (const f of findings) console.log(`  ${f.file}:${f.line} [${f.rule}] ${f.why}\n      > ${f.excerpt}`);
  console.log(`\nRESULT: FAILED (${findings.length} finding(s))`);
  process.exit(1);
}
// Say exactly what was covered. This walks the WORKING TREE of each root; it
// does not consult git, so an untracked file IS scanned and a .gitignored file
// is scanned too (except for the skip list above).
console.log(`\nRESULT: CLEAN — ${scanned} file(s) read across ${TARGETS.length} root(s), no credential found${allowlisted.length ? ` (${allowlisted.length} synthetic test literal(s) allowlisted by path + sha256)` : ""}.`);
