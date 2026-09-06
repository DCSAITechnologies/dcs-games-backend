#!/usr/bin/env node
// Supabase cutover preflight — run this against a NEWLY PROVISIONED, DEDICATED
// DCS Games Supabase project BEFORE any migration touches it.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/cutover-check.mjs
//   ... node scripts/cutover-check.mjs --json
//
// WHY THIS EXISTS
// ---------------
// The production DCS Games API is pointed at `hznrmbxppcxrrrmyutjn.supabase.co`,
// a project SHARED with other live DCS products, and the project configured on
// the build machine (`wafbevykbubenjhgfqau`) is shared too: it holds 720 tables
// belonging to `app_*`, `whatslink_*`, `dcsrank_*`, `vendor_*`, `mart_*` and
// `mind_*` and not one DCS Games table. Applying this repo's 9-migration,
// 54-table chain to either of them would be a mutation whose blast radius is
// other people's live products.
//
// So the chain may only ever be applied to a DEDICATED DCS Games project. This
// script is the gate that makes "point it at the wrong project" fail loudly at
// 2am instead of succeeding quietly.
//
// WHAT IT IS
// ----------
// READ-ONLY, by construction: it issues HTTP GET and nothing else. It creates
// no table, writes no row, opens no psql session and stores no credential — the
// URL and key are read from the environment at run time and never written
// anywhere, not even to the JSON output (only a truncated, non-reversible
// fingerprint of the key is printed, so two operators can tell keys apart).
//
// THERE IS NO OVERRIDE FLAG. The forbidden-project refusal cannot be turned off
// by an environment variable or an argument, because every safety rail that has
// an override is eventually used with the override on.
//
// ENVIRONMENT (names only — never put values in a repo, a document or a chat)
//   SUPABASE_URL              required. https://<ref>.supabase.co of the NEW project.
//   SUPABASE_SERVICE_ROLE_KEY required. Used read-only, for GET, here only.
//   DATABASE_URL              optional. The same project's direct Postgres DSN.
//                             If set it is checked for project identity too, so
//                             a REST URL for the new project cannot be paired
//                             with a DSN for a shared one. It is NOT connected to.
//
// EXIT CODES
//   0  PASS         — a dedicated target, reachable, key works, safe to migrate
//   2  CONFIG       — required environment variables are missing
//   3  FORBIDDEN    — the target is (or may be) a shared project, or the URL,
//                     DSN and key do not all name the SAME project
//   4  UNREACHABLE  — could not reach the target, or it answered 5xx
//   5  AUTH         — the key was rejected: this is never reported as "clean"
//   6  CONTAMINATED — the target holds tables belonging to other products
//   7  INDETERMINATE— could not enumerate the target's contents, so cannot say
//                     it is clean. "Could not tell" is a refusal, not a pass.
import process from "node:process";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { REQUIRED_SCHEMA_VERSION, REQUIRED_TABLES } from "../src/core/schema.mjs";

// ---------------------------------------------------------------- constants

/** Projects this script must never be pointed at, and why, in words. */
export const FORBIDDEN_REFS = Object.freeze({
  hznrmbxppcxrrrmyutjn:
    "the SHARED production project. It carries OTHER LIVE DCS PRODUCTS. Applying the DCS Games chain to it is a mutation with blast radius beyond DCS Games.",
  wafbevykbubenjhgfqau:
    "the shared project configured on the build machine. It holds 720 tables belonging to other products and zero DCS Games tables.",
});

/** Table prefixes that mean "this project belongs to another product". */
export const FOREIGN_TABLE_PREFIXES = Object.freeze([
  "app_", "whatslink_", "dcsrank_", "vendor_", "mart_", "mind_",
]);

export const DCSGAMES_PREFIX = "dcsgames_";
export const CHAIN_TABLE = "dcsgames_schema_migrations";

export const EXIT = Object.freeze({
  PASS: 0, CONFIG: 2, FORBIDDEN: 3, UNREACHABLE: 4, AUTH: 5, CONTAMINATED: 6, INDETERMINATE: 7,
});

// ------------------------------------------------------------------ helpers

const lower = (s) => String(s == null ? "" : s).toLowerCase();

/** Any forbidden ref appearing anywhere in a string, however it got there. */
export function forbiddenRefsIn(s) {
  const hay = lower(s);
  return Object.keys(FORBIDDEN_REFS).filter((ref) => hay.includes(ref));
}

/**
 * The project ref in a Supabase REST URL. Returns null for a custom domain,
 * which is honest: a custom domain can front ANY project, including a shared
 * one, so the caller must fall back to the key's own ref claim.
 */
export function refFromSupabaseUrl(url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
  const m = /^([a-z0-9-]+)\.supabase\.(?:co|in|net|red)$/.exec(host);
  return m ? m[1] : null;
}

/**
 * The project ref in a Postgres DSN: `db.<ref>.supabase.co` for a direct
 * connection, or the `postgres.<ref>` username for the pooler.
 */
export function refFromDsn(dsn) {
  if (!dsn) return null;
  let u;
  try { u = new URL(String(dsn)); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const direct = /^db\.([a-z0-9-]+)\.supabase\.(?:co|in|net|red)$/.exec(host);
  if (direct) return direct[1];
  const bare = /^([a-z0-9-]+)\.supabase\.(?:co|in|net|red)$/.exec(host);
  if (bare) return bare[1];
  const user = decodeURIComponent(u.username || "");
  const pooled = /^postgres\.([a-z0-9-]+)$/.exec(user.toLowerCase());
  if (pooled) return pooled[1];
  return null;
}

/**
 * Read the ref/role a Supabase service-role JWT declares about itself. The
 * signature is NOT verified — there is no secret here to verify it with, and it
 * is not needed: this is used only to catch a key that names a DIFFERENT
 * project than the URL, which is the "new URL, old key" mistake. The key itself
 * is never returned.
 */
export function decodeKeyClaims(key) {
  const k = String(key || "");
  if (!k) return { shape: "missing", ref: null, role: null, exp: null };
  if (/^sb_(secret|publishable)_/.test(k)) {
    // The new-style Supabase API keys are opaque: they carry no readable ref.
    return { shape: "opaque-sb-key", ref: null, role: null, exp: null };
  }
  const parts = k.split(".");
  if (parts.length !== 3) return { shape: "unrecognised", ref: null, role: null, exp: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return {
      shape: "jwt",
      ref: payload.ref ? lower(payload.ref) : null,
      role: payload.role || null,
      exp: typeof payload.exp === "number" ? payload.exp : null,
    };
  } catch {
    return { shape: "unreadable-jwt", ref: null, role: null, exp: null };
  }
}

/** Non-reversible, truncated. Enough to tell two keys apart; not enough to be one. */
export function keyFingerprint(key) {
  if (!key) return null;
  return "sha256:" + crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 12);
}

/** Table names out of a PostgREST OpenAPI document, whichever dialect it speaks. */
export function tablesFromOpenApi(doc) {
  if (!doc || typeof doc !== "object") return null;
  const out = new Set();
  if (doc.definitions && typeof doc.definitions === "object") {
    for (const k of Object.keys(doc.definitions)) out.add(k);
  }
  if (doc.components && doc.components.schemas && typeof doc.components.schemas === "object") {
    for (const k of Object.keys(doc.components.schemas)) out.add(k);
  }
  if (!out.size && doc.paths && typeof doc.paths === "object") {
    for (const p of Object.keys(doc.paths)) {
      const name = p.replace(/^\//, "");
      if (!name || name.startsWith("rpc/")) continue;
      out.add(name);
    }
  }
  // A PostgREST root with paths but no tables is a legitimately empty project;
  // a document with neither is not a PostgREST root at all.
  if (!out.size && !(doc.paths || doc.definitions || doc.components)) return null;
  return [...out].sort();
}

// ------------------------------------------------------------------- the run

class Refusal extends Error {
  constructor(code, name, detail, next) {
    super(detail);
    this.code = code; this.name_ = name; this.detail = detail; this.next = next;
  }
}

/**
 * @param {object} env    process.env, or a stand-in
 * @param {object} opts   { fetch, timeoutMs } — fetch is injectable so a test
 *                        can prove a refusal fires WITHOUT any network at all.
 */
export async function preflight(env = process.env, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs || 15000);

  const report = {
    ok: false,
    code: EXIT.INDETERMINATE,
    verdict: "REFUSED",
    checked_at: new Date().toISOString(),
    target: { url: null, ref: null, ref_source: null, dsn_ref: null, dsn_configured: false, key: null },
    contents: null,
    chain: null,
    refusals: [],
    notes: [],
    unverified: [],
    requests: [],          // every HTTP call this run made, method included
  };
  const refuse = (code, name, detail, next) => {
    report.refusals.push({ code, name, detail, next });
    return new Refusal(code, name, detail, next);
  };

  // GET is the only verb this script has. There is no other request function.
  const get = async (url, headers) => {
    report.requests.push({ method: "GET", url: String(url).split("?")[0] });
    return doFetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
  };

  try {
    // -- 1. configuration ---------------------------------------------------
    const rawUrl = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    const dsn = String(env.DATABASE_URL || "").trim();
    const missing = [];
    if (!rawUrl) missing.push("SUPABASE_URL");
    if (!key) missing.push("SUPABASE_SERVICE_ROLE_KEY");
    if (missing.length) {
      throw refuse(EXIT.CONFIG, "configuration", `not set: ${missing.join(", ")}`, [
        `Export ${missing.join(" and ")} for the NEW dedicated DCS Games project, in this shell only.`,
        "Take them from the Supabase dashboard of the new project: Settings -> API.",
        "Do not write them into a file in this repo, and do not paste them into a chat or a document.",
        "Then re-run: node scripts/cutover-check.mjs",
      ]);
    }
    report.target.url = rawUrl;
    report.target.dsn_configured = !!dsn;

    // -- 2. project identity, BEFORE any connection -------------------------
    // This runs first and off-line on purpose. A forbidden project must be
    // refused without so much as a DNS lookup against it.
    const urlRef = refFromSupabaseUrl(rawUrl);
    const dsnRef = refFromDsn(dsn);
    const claims = decodeKeyClaims(key);
    report.target.ref = urlRef;
    report.target.ref_source = urlRef ? "SUPABASE_URL host" : null;
    report.target.dsn_ref = dsnRef;
    report.target.key = { shape: claims.shape, ref: claims.ref, role: claims.role, fingerprint: keyFingerprint(key) };

    const hits = new Map();  // ref -> [where]
    const note = (ref, where) => { if (!ref) return; const k = lower(ref); if (FORBIDDEN_REFS[k]) hits.set(k, [...(hits.get(k) || []), where]); };
    for (const r of forbiddenRefsIn(rawUrl)) note(r, "SUPABASE_URL");
    for (const r of forbiddenRefsIn(dsn)) note(r, "DATABASE_URL");
    note(urlRef, "SUPABASE_URL host");
    note(dsnRef, "DATABASE_URL host/user");
    note(claims.ref, "the service-role key's own `ref` claim");
    if (hits.size) {
      const lines = [...hits.entries()].map(([ref, where]) =>
        `  ${ref} — seen in ${[...new Set(where)].join(", ")}\n      ${FORBIDDEN_REFS[ref]}`);
      throw refuse(EXIT.FORBIDDEN, "forbidden project",
        "the target is a SHARED Supabase project. A dedicated DCS Games project is the ONLY valid target for this migration chain.\n" + lines.join("\n"), [
          "STOP. Do not run scripts/migrate.mjs against this target.",
          "Point SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL at the NEW, DEDICATED DCS Games project.",
          "If no dedicated project exists yet, the cutover cannot proceed: the founder must create one first.",
          "There is no override for this refusal, and there must not be one.",
        ]);
    }

    // Every channel that names a project must name the SAME project. A REST URL
    // for the new project paired with a DSN or key for another one is how the
    // right preflight passes and the wrong database gets migrated.
    const named = [
      ["SUPABASE_URL", urlRef], ["DATABASE_URL", dsnRef], ["SUPABASE_SERVICE_ROLE_KEY", claims.ref],
    ].filter(([, v]) => !!v);
    const distinct = [...new Set(named.map(([, v]) => v))];
    if (distinct.length > 1) {
      throw refuse(EXIT.FORBIDDEN, "mismatched project identity",
        "these do not all name the same project: " + named.map(([k, v]) => `${k}=${v}`).join(", "), [
          "STOP. One of these credentials belongs to a different Supabase project.",
          "Re-copy all of them from the SAME project's dashboard and re-run.",
        ]);
    }
    if (!distinct.length) {
      throw refuse(EXIT.INDETERMINATE, "unidentifiable project",
        `nothing names a project ref: SUPABASE_URL is not a *.supabase.co host (${rawUrl}) and the key is ${claims.shape}. ` +
        "A custom domain can front ANY project, including a shared one, so the target cannot be identified and therefore cannot be cleared.", [
          "Set SUPABASE_URL to the project's own https://<ref>.supabase.co host rather than a custom domain, and re-run.",
          "If the project only has a custom domain, confirm its ref in the Supabase dashboard and confirm by hand that it is the dedicated DCS Games project before doing anything else.",
        ]);
    }
    if (!urlRef) {
      report.target.ref = distinct[0];
      report.target.ref_source = dsnRef === distinct[0] ? "DATABASE_URL" : "service-role key claim";
      report.unverified.push("SUPABASE_URL is not a *.supabase.co host, so the project ref was taken from another channel.");
    }
    if (claims.shape === "jwt") {
      if (claims.role && claims.role !== "service_role") {
        report.notes.push(`the key declares role="${claims.role}", not "service_role" — an anon key cannot see the whole schema, so a "clean" result from it would be meaningless`);
      }
      if (claims.exp && claims.exp * 1000 < Date.now()) {
        report.notes.push("the key's own `exp` claim is in the past — it is expired");
      }
    } else {
      report.unverified.push(`the key is ${claims.shape}: it carries no readable project ref, so key-to-project binding could not be checked here (the reachability check below still proves the key works against this URL).`);
    }
    if (!dsn) {
      report.unverified.push("DATABASE_URL is not set, so the DSN used by scripts/migrate.mjs was not identity-checked. Set it and re-run before migrating.");
    }

    // -- 3. reachability + the key actually working -------------------------
    // The PostgREST root is an OpenAPI document listing every table exposed in
    // the API schema. Fetching it proves reachability, proves the key works,
    // and enumerates the contents — in one GET, writing nothing.
    const h = { apikey: key, Authorization: "Bearer " + key, Accept: "application/json" };
    let res;
    try {
      res = await get(rawUrl + "/rest/v1/", h);
    } catch (e) {
      throw refuse(EXIT.UNREACHABLE, "unreachable",
        `${rawUrl}/rest/v1/ could not be reached: ${e?.message || e}`, [
          "Confirm the project exists and is not paused (a paused Supabase project refuses connections).",
          "Confirm SUPABASE_URL is exactly the project URL from the dashboard.",
          "Do NOT proceed to the migration. An unreachable target is a refusal, never a pass.",
        ]);
    }
    if (res.status === 401 || res.status === 403) {
      throw refuse(EXIT.AUTH, "key rejected",
        `${rawUrl}/rest/v1/ answered ${res.status}: the service-role key was refused. The target's contents are therefore UNKNOWN and this is NOT a clean result.`, [
          "Re-copy SUPABASE_SERVICE_ROLE_KEY from the new project's dashboard (Settings -> API -> service_role).",
          "Confirm the key belongs to the same project as SUPABASE_URL.",
          "Re-run this preflight. Do not migrate until it passes.",
        ]);
    }
    if (res.status >= 500) {
      throw refuse(EXIT.UNREACHABLE, "upstream error",
        `${rawUrl}/rest/v1/ answered ${res.status}`, [
          "The project is unhealthy or still provisioning. Wait, then re-run.",
          "Do not migrate against a target that cannot answer a read.",
        ]);
    }

    let doc = null, parseError = null;
    try { doc = await res.json(); } catch (e) { parseError = e?.message || String(e); }
    const tables = tablesFromOpenApi(doc);
    if (!Array.isArray(tables)) {
      throw refuse(EXIT.INDETERMINATE, "contents unreadable",
        `${rawUrl}/rest/v1/ answered ${res.status} but not a PostgREST OpenAPI document${parseError ? ` (${parseError})` : ""}. ` +
        "The target's contents could not be enumerated, so it cannot be declared clean.", [
          "Confirm SUPABASE_URL points at a Supabase project's REST endpoint and not at a proxy, a redirect or a paused project.",
          "Do not migrate. 'Could not tell' is a refusal, not a pass.",
        ]);
    }

    // -- 4. what is in there ------------------------------------------------
    const byPrefix = {};
    const foreign = [];
    for (const t of tables) {
      for (const p of FOREIGN_TABLE_PREFIXES) {
        if (t.startsWith(p)) { byPrefix[p] = (byPrefix[p] || 0) + 1; foreign.push(t); break; }
      }
    }
    const dcs = tables.filter((t) => t.startsWith(DCSGAMES_PREFIX));
    const other = tables.filter((t) => !foreign.includes(t) && !t.startsWith(DCSGAMES_PREFIX));
    report.contents = {
      total: tables.length,
      foreign_count: foreign.length,
      foreign_by_prefix: byPrefix,
      foreign_sample: foreign.slice(0, 12),
      dcsgames_count: dcs.length,
      other_count: other.length,
      other_sample: other.slice(0, 12),
      source: "GET /rest/v1/ (PostgREST OpenAPI). Only schemas exposed to the API are listed; a table in a non-exposed schema is invisible here.",
    };
    report.unverified.push("the table list covers only API-exposed schemas (public by default). Cross-check with `node scripts/migrate.mjs status --dsn \"$DATABASE_URL\"`, which counts information_schema directly.");

    if (foreign.length) {
      throw refuse(EXIT.CONTAMINATED, "other products present",
        `the target holds ${foreign.length} table(s) belonging to other products: ` +
        Object.entries(byPrefix).map(([p, n]) => `${p}* x${n}`).join(", ") +
        `. Examples: ${foreign.slice(0, 8).join(", ")}. ` +
        "That is the signature of a SHARED project, whatever ref it carries.", [
          "STOP. This is not a dedicated DCS Games project, or someone has pointed the environment at a shared one.",
          "Do not run scripts/migrate.mjs against it: the chain creates 54 tables and would be a mutation on another product's database.",
          "Confirm the ref above with the founder, then point the environment at the dedicated project and re-run.",
        ]);
    }

    // -- 5. has our chain already been applied? -----------------------------
    const chainPresent = tables.includes(CHAIN_TABLE);
    report.chain = {
      table_present: chainPresent,
      version: null,
      required_version: REQUIRED_SCHEMA_VERSION,
      dcsgames_tables: dcs.length,
      missing_required_tables: REQUIRED_TABLES.filter((t) => !tables.includes(t)),
    };
    if (chainPresent) {
      try {
        const vres = await get(`${rawUrl}/rest/v1/${CHAIN_TABLE}?select=version&order=version.desc&limit=1`, h);
        if (vres.ok) {
          const rows = await vres.json();
          report.chain.version = Array.isArray(rows) && rows.length ? Number(rows[0].version) : 0;
        } else {
          report.unverified.push(`could not read ${CHAIN_TABLE} (HTTP ${vres.status}), so the applied schema version is unknown.`);
        }
      } catch (e) {
        report.unverified.push(`could not read ${CHAIN_TABLE}: ${e?.message || e}`);
      }
    }

    // -- 6. verdict ---------------------------------------------------------
    report.ok = true;
    report.code = EXIT.PASS;
    if (!chainPresent && !dcs.length) {
      report.verdict = tables.length === 0 ? "READY (empty project)" : "READY (no DCS Games tables, no foreign products)";
    } else if (chainPresent && report.chain.version >= REQUIRED_SCHEMA_VERSION && !report.chain.missing_required_tables.length) {
      report.verdict = `ALREADY MIGRATED (schema v${report.chain.version}, ${dcs.length} dcsgames_ tables)`;
    } else {
      report.verdict = `PARTIAL (schema v${report.chain.version ?? 0}, ${dcs.length} dcsgames_ tables, ${report.chain.missing_required_tables.length} required table(s) missing)`;
    }
    return report;
  } catch (e) {
    if (e instanceof Refusal) {
      report.ok = false;
      report.code = e.code;
      report.verdict = "REFUSED";
      return report;
    }
    report.ok = false;
    report.code = EXIT.INDETERMINATE;
    report.verdict = "REFUSED";
    report.refusals.push({
      code: EXIT.INDETERMINATE, name: "preflight failed", detail: String(e?.message || e),
      next: ["The preflight itself failed, which is not a pass. Fix the error above and re-run before migrating."],
    });
    return report;
  }
}

// ------------------------------------------------------------------- output

export function render(report) {
  const L = [];
  L.push("DCS Games — Supabase cutover preflight (READ-ONLY: this run issued only GET requests)");
  L.push("");
  L.push(`target url    : ${report.target.url || "(not set)"}`);
  L.push(`project ref   : ${report.target.ref || "(unidentified)"}${report.target.ref_source ? `  [from ${report.target.ref_source}]` : ""}`);
  if (report.target.dsn_configured) L.push(`DATABASE_URL  : set, ref ${report.target.dsn_ref || "(unidentified)"}`);
  else L.push("DATABASE_URL  : not set");
  if (report.target.key) L.push(`service key   : ${report.target.key.shape}${report.target.key.role ? `, role=${report.target.key.role}` : ""}${report.target.key.ref ? `, ref=${report.target.key.ref}` : ""}, ${report.target.key.fingerprint}`);
  L.push("");

  if (report.contents) {
    L.push("WHAT THE TARGET CONTAINS");
    L.push(`  tables visible to the API : ${report.contents.total}`);
    L.push(`  other products' tables    : ${report.contents.foreign_count}${report.contents.foreign_count ? "  (" + Object.entries(report.contents.foreign_by_prefix).map(([p, n]) => `${p}* x${n}`).join(", ") + ")" : ""}`);
    if (report.contents.foreign_sample.length) L.push(`      e.g. ${report.contents.foreign_sample.join(", ")}`);
    L.push(`  dcsgames_* tables         : ${report.contents.dcsgames_count}`);
    L.push(`  other tables              : ${report.contents.other_count}${report.contents.other_sample.length ? "  (e.g. " + report.contents.other_sample.join(", ") + ")" : ""}`);
    L.push(`  source: ${report.contents.source}`);
    L.push("");
  }
  if (report.chain) {
    L.push("DCS GAMES MIGRATION CHAIN");
    L.push(`  ${CHAIN_TABLE}: ${report.chain.table_present ? "present" : "ABSENT — the chain has never been applied here"}`);
    L.push(`  schema version            : ${report.chain.version == null ? (report.chain.table_present ? "unknown" : "0 (not applied)") : "v" + report.chain.version}   (code requires v${report.chain.required_version})`);
    if (report.chain.missing_required_tables.length) {
      L.push(`  required tables missing   : ${report.chain.missing_required_tables.length} (${report.chain.missing_required_tables.slice(0, 8).join(", ")}${report.chain.missing_required_tables.length > 8 ? ", ..." : ""})`);
    }
    L.push("");
  }
  for (const n of report.notes) L.push(`NOTE: ${n}`);
  if (report.notes.length) L.push("");
  for (const u of report.unverified) L.push(`UNVERIFIED: ${u}`);
  if (report.unverified.length) L.push("");

  if (report.ok) {
    L.push(`RESULT: PASS — ${report.verdict}`);
    L.push("");
    L.push("WHAT TO DO NEXT");
    if (/^READY/.test(report.verdict)) {
      L.push("  1. Confirm with the founder, in writing, that this ref is the dedicated DCS Games project.");
      L.push("  2. Set DATABASE_URL to this same project's direct Postgres DSN (if it is not set already) and re-run this preflight.");
      L.push("  3. node scripts/migrate.mjs status  --dsn \"$DATABASE_URL\"      # expect version 0, and the tables count you saw above");
      L.push("  4. node scripts/migrate.mjs up      --dsn \"$DATABASE_URL\" --i-have-a-backup   # IRREVERSIBLE: creates 54 tables");
      L.push("  5. node scripts/migrate.mjs verify  --dsn \"$DATABASE_URL\"      # expect ok:true at v" + REQUIRED_SCHEMA_VERSION);
      L.push("  See DCS_GAMES_SUPABASE_CUTOVER_RUNBOOK.md for the full sequence, including how to prove money is still dark.");
    } else if (/^ALREADY MIGRATED/.test(report.verdict)) {
      L.push("  Nothing to migrate. Verify and move on:");
      L.push("  1. node scripts/migrate.mjs verify --dsn \"$DATABASE_URL\"");
      L.push("  2. node scripts/monitor-dark.mjs --base <the deployed api base>   # prove money is still dark");
    } else {
      L.push("  The chain is PARTIALLY applied here. Do not assume; look before acting:");
      L.push("  1. node scripts/migrate.mjs status --dsn \"$DATABASE_URL\"");
      L.push("  2. Re-running `migrate.mjs up` applies only the missing migrations and is a no-op for the applied ones.");
      L.push("  3. If the version or the table set is not what the runbook predicts, STOP and ask before writing anything.");
    }
    return L.join("\n");
  }

  L.push("RESULT: REFUSED");
  for (const r of report.refusals) {
    L.push("");
    L.push(`  [${r.name}]  ${r.detail}`);
    L.push("  WHAT TO DO NEXT:");
    for (const n of r.next) L.push(`    - ${n}`);
  }
  L.push("");
  L.push(`exit code ${report.code}`);
  return L.join("\n");
}

// ---------------------------------------------------------------------- CLI

const isMain = (() => {
  try { return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url; }
  catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const ti = argv.indexOf("--timeout");
  const timeoutMs = ti >= 0 ? Number(argv[ti + 1]) : 15000;
  const report = await preflight(process.env, { timeoutMs });
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  process.exit(report.code);
}

export default { preflight, render, EXIT, FORBIDDEN_REFS, FOREIGN_TABLE_PREFIXES };
