// Tests for the Supabase cutover preflight (scripts/cutover-check.mjs).
//
// A preflight is only worth its refusals, so every refusal here is tested as a
// PAIR: the case that must be refused, and a CONTROL that differs ONLY in the
// thing being refused and must pass. A refusal that fires on everything is a
// broken script; a refusal that fires on nothing is a decoration. Both failure
// modes are excluded by construction below.
//
// Nothing here touches a real Supabase project. The target is a local PostgREST
// stand-in on 127.0.0.1, following the stub pattern in test/supabase-paths.test.mjs
// (read, not modified: this file carries its own smaller stub because it needs a
// PostgREST *root* — the OpenAPI document — which that stub does not serve).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  preflight, render, EXIT, FORBIDDEN_REFS, FOREIGN_TABLE_PREFIXES,
  refFromSupabaseUrl, refFromDsn, decodeKeyClaims, tablesFromOpenApi,
} from "../scripts/cutover-check.mjs";
import { REQUIRED_TABLES, REQUIRED_SCHEMA_VERSION } from "../src/core/schema.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/cutover-check.mjs", import.meta.url));
const J = (o) => JSON.stringify(o);

// The two refs this script exists to keep the migration chain away from. Written
// out in full here on purpose: if someone edits the constant in the script, this
// test fails rather than silently agreeing with them.
const SHARED_PROD_REF = "hznrmbxppcxrrrmyutjn";
const SHARED_LOCAL_REF = "wafbevykbubenjhgfqau";
// A plausible ref for the NEW dedicated project. Used in every control case.
const NEW_REF = "dcsgamesnewproj01xy";

// ===========================================================================
// helpers
// ===========================================================================

const b64u = (o) => Buffer.from(J(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-shaped service-role JWT. Unsigned garbage in the signature slot:
 *  the preflight reads the `ref` claim and never verifies the signature, which
 *  is exactly what it documents. */
function jwtKey(ref, role = "service_role", extra = {}) {
  return [
    b64u({ alg: "HS256", typ: "JWT" }),
    b64u({ iss: "supabase", ref, role, iat: 1750000000, exp: 2050000000, ...extra }),
    "not-a-real-signature",
  ].join(".");
}

/** A local PostgREST root + table reader. GET only; anything else is a 405. */
async function postgrestStub({ key, tables = [], chainRows = [], rootStatus = null, rootBody = null } = {}) {
  const state = { key, tables: tables.slice(), chainRows: chainRows.slice(), wire: [] };
  const server = http.createServer((req, res) => {
    const [pathname, qs] = String(req.url || "").split("?");
    state.wire.push({ method: req.method, path: pathname, qs: qs || "" });
    const H = (n) => req.headers[n.toLowerCase()];
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
      res.end(body);
    };
    if (req.method !== "GET") return reply(405, J({ code: "PGRST105", message: "method not allowed" }));

    if (pathname === "/rest/v1/" || pathname === "/rest/v1") {
      if (rootStatus != null) return reply(rootStatus, rootBody == null ? J({ message: "stub-forced" }) : rootBody);
      if (H("apikey") !== state.key || H("authorization") !== "Bearer " + state.key) {
        return reply(401, J({ message: "Invalid API key", hint: "Double check your Supabase API key." }));
      }
      return reply(200, J({
        swagger: "2.0",
        info: { title: "standard public schema" },
        paths: Object.fromEntries([["/", {}], ...state.tables.map((t) => ["/" + t, {}])]),
        definitions: Object.fromEntries(state.tables.map((t) => [t, { properties: {} }])),
      }));
    }
    const m = /^\/rest\/v1\/([^/]+)$/.exec(pathname);
    if (!m) return reply(404, J({ code: "PGRST002", message: "no route" }));
    if (H("apikey") !== state.key || H("authorization") !== "Bearer " + state.key) {
      return reply(401, J({ message: "Invalid API key" }));
    }
    const name = decodeURIComponent(m[1]);
    if (!state.tables.includes(name)) {
      return reply(404, J({ code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache` }));
    }
    if (name === "dcsgames_schema_migrations") {
      const rows = state.chainRows.slice().sort((a, b) => b.version - a.version).slice(0, 1).map((r) => ({ version: r.version }));
      return reply(200, J(rows));
    }
    return reply(200, "[]");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    key,
    get wire() { return state.wire; },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A port nothing is listening on: bind, note the port, release it. */
async function deadPort() {
  const s = http.createServer(() => {});
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

/** Run the real CLI as a child process, so exit codes are proven, not asserted about.
 *  Asynchronous deliberately: spawnSync would block the event loop that is
 *  serving the stub the child is talking to, and every run would time out. */
function runCli(env = {}, args = []) {
  const base = { ...process.env };
  // The operator's own shell may well have a Supabase project exported. Strip
  // every input this script reads so a test can never accidentally run against it.
  delete base.SUPABASE_URL; delete base.SUPABASE_SERVICE_ROLE_KEY; delete base.DATABASE_URL;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...base, ...env } });
    let so = "", se = "";
    p.stdout.on("data", (d) => { so += d; });
    p.stderr.on("data", (d) => { se += d; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout: so, stderr: se, out: so + se }));
  });
}

/** A fetch that fails the test if it is called at all. */
function noNetwork() {
  return () => { throw new Error("THE PREFLIGHT CONTACTED THE NETWORK"); };
}

// ===========================================================================
// 0. the pure helpers, so the refusals below rest on something tested
// ===========================================================================

test("ref extraction: url, dsn (direct and pooled), and the key's own claim", () => {
  assert.equal(refFromSupabaseUrl(`https://${NEW_REF}.supabase.co`), NEW_REF);
  assert.equal(refFromSupabaseUrl(`https://${NEW_REF}.supabase.co/`), NEW_REF);
  assert.equal(refFromSupabaseUrl("https://api.games.dcsai.ai"), null, "a custom domain names no project");
  assert.equal(refFromSupabaseUrl("not a url"), null);

  assert.equal(refFromDsn(`postgresql://postgres:pw@db.${NEW_REF}.supabase.co:5432/postgres`), NEW_REF);
  assert.equal(refFromDsn(`postgresql://postgres.${NEW_REF}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`), NEW_REF,
    "the pooler puts the ref in the USERNAME, which is the form people actually copy out of the dashboard");
  assert.equal(refFromDsn("postgresql://127.0.0.1:5432/dcs_games_staging"), null);
  assert.equal(refFromDsn(""), null);

  assert.deepEqual(
    (({ shape, ref, role }) => ({ shape, ref, role }))(decodeKeyClaims(jwtKey(NEW_REF))),
    { shape: "jwt", ref: NEW_REF, role: "service_role" });
  assert.equal(decodeKeyClaims("sb_secret_abcdef").shape, "opaque-sb-key");
  assert.equal(decodeKeyClaims("").shape, "missing");
});

test("the forbidden list names both shared projects and says, in words, why", () => {
  assert.deepEqual(Object.keys(FORBIDDEN_REFS).sort(), [SHARED_PROD_REF, SHARED_LOCAL_REF].sort());
  for (const [ref, why] of Object.entries(FORBIDDEN_REFS)) {
    assert.match(why, /shared/i, `${ref} must be explained as a shared project, not just listed`);
    assert.ok(why.length > 40, `${ref} needs a reason a tired human can read`);
  }
  assert.deepEqual([...FOREIGN_TABLE_PREFIXES], ["app_", "whatslink_", "dcsrank_", "vendor_", "mart_", "mind_"]);
});

test("openapi table extraction handles definitions, components and a paths-only document", () => {
  assert.deepEqual(tablesFromOpenApi({ definitions: { a: {}, b: {} } }), ["a", "b"]);
  assert.deepEqual(tablesFromOpenApi({ components: { schemas: { c: {} } } }), ["c"]);
  assert.deepEqual(tablesFromOpenApi({ paths: { "/": {}, "/d": {}, "/rpc/x": {} } }), ["d"]);
  assert.deepEqual(tablesFromOpenApi({ paths: { "/": {} } }), [], "an empty project is empty, not unreadable");
  assert.equal(tablesFromOpenApi({ hello: "world" }), null, "a non-PostgREST document is unreadable, not empty");
  assert.equal(tablesFromOpenApi(null), null);
});

// ===========================================================================
// 1. REFUSAL: the shared projects — and it fires before any connection
// ===========================================================================

test("REFUSAL: the real shared production ref is refused, without touching the network", async () => {
  const r = await preflight(
    { SUPABASE_URL: `https://${SHARED_PROD_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwtKey(SHARED_PROD_REF) },
    { fetch: noNetwork() });
  assert.equal(r.ok, false);
  assert.equal(r.code, EXIT.FORBIDDEN);
  assert.equal(r.requests.length, 0, "a forbidden target must be refused BEFORE it is contacted");
  assert.equal(r.refusals[0].name, "forbidden project");
  assert.match(r.refusals[0].detail, new RegExp(SHARED_PROD_REF));
  // "a dedicated project is the only valid target, and the check should say so in words"
  assert.match(r.refusals[0].detail, /dedicated DCS Games project is the ONLY valid target/);
  assert.match(r.refusals[0].detail, /OTHER LIVE DCS PRODUCTS/);
  const text = render(r);
  assert.match(text, /RESULT: REFUSED/);
  assert.match(text, /STOP\. Do not run scripts\/migrate\.mjs/);
});

test("CONTROL: the identical run against a dedicated ref is NOT refused as forbidden", async () => {
  // Same shape, same offline fetch, one character class different: the ref.
  const r = await preflight(
    { SUPABASE_URL: `https://${NEW_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwtKey(NEW_REF) },
    { fetch: noNetwork() });
  assert.equal(r.code, EXIT.UNREACHABLE, "it fails on the network, which is the offline stub — not on the ref");
  assert.notEqual(r.code, EXIT.FORBIDDEN);
  assert.equal(r.requests.length, 1, "a permitted target IS contacted");
});

test("REFUSAL: the second shared project on this machine is refused too", async () => {
  const r = await preflight(
    { SUPABASE_URL: `https://${SHARED_LOCAL_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwtKey(SHARED_LOCAL_REF) },
    { fetch: noNetwork() });
  assert.equal(r.code, EXIT.FORBIDDEN);
  assert.equal(r.refusals[0].name, "forbidden project");
  assert.match(r.refusals[0].detail, /720 tables/);
});

test("REFUSAL: case and trailing slashes do not smuggle a shared ref past the check", async () => {
  for (const url of [
    `https://${SHARED_PROD_REF.toUpperCase()}.supabase.co`,
    `https://${SHARED_PROD_REF}.supabase.co/`,
    `https://${SHARED_PROD_REF}.supabase.co/rest/v1`,
  ]) {
    const r = await preflight({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: jwtKey(NEW_REF) }, { fetch: noNetwork() });
    assert.equal(r.code, EXIT.FORBIDDEN, `${url} must be refused`);
    assert.equal(r.refusals[0].name, "forbidden project",
      `${url} must be refused FOR BEING A SHARED PROJECT, not incidentally for some other mismatch`);
  }
});

test("REFUSAL: a clean REST url paired with a shared-project DSN is still refused", async () => {
  const r = await preflight({
    SUPABASE_URL: `https://${NEW_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: jwtKey(NEW_REF),
    DATABASE_URL: `postgresql://postgres:pw@db.${SHARED_PROD_REF}.supabase.co:5432/postgres`,
  }, { fetch: noNetwork() });
  assert.equal(r.code, EXIT.FORBIDDEN);
  assert.equal(r.refusals[0].name, "forbidden project");
  assert.match(r.refusals[0].detail, /DATABASE_URL/);
  assert.equal(r.requests.length, 0);
});

test("REFUSAL: a clean REST url paired with the SHARED project's key is still refused", async () => {
  // The "new URL, old key" mistake: migrate.mjs uses DATABASE_URL, but a service
  // that boots with this key would read and write the shared project.
  const r = await preflight({
    SUPABASE_URL: `https://${NEW_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: jwtKey(SHARED_PROD_REF),
  }, { fetch: noNetwork() });
  assert.equal(r.code, EXIT.FORBIDDEN);
  assert.equal(r.refusals[0].name, "forbidden project");
  assert.match(r.refusals[0].detail, /ref` claim/);
});

test("CONTROL: a DSN and key for the SAME dedicated project are accepted", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: [] });
  t.after(() => stub.close());
  const r = await preflight({
    SUPABASE_URL: stub.url,                    // 127.0.0.1: no ref in the host
    SUPABASE_SERVICE_ROLE_KEY: key,            // ref comes from the key claim
    DATABASE_URL: `postgresql://postgres.${NEW_REF}:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`,
  });
  assert.equal(r.code, EXIT.PASS, J(r.refusals));
  assert.equal(r.target.ref, NEW_REF);
});

test("REFUSAL: url, dsn and key that name three different projects", async () => {
  const r = await preflight({
    SUPABASE_URL: `https://${NEW_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: jwtKey("someotherprojectaaa"),
    DATABASE_URL: `postgresql://postgres:pw@db.thirdprojectbbbbbbb.supabase.co:5432/postgres`,
  }, { fetch: noNetwork() });
  assert.equal(r.code, EXIT.FORBIDDEN);
  assert.equal(r.refusals[0].name, "mismatched project identity");
});

test("REFUSAL: a target nothing can identify is refused, not assumed innocent", async (t) => {
  const stub = await postgrestStub({ key: "sb_secret_opaque_key", tables: [] });
  t.after(() => stub.close());
  const r = await preflight({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_opaque_key" });
  assert.equal(r.code, EXIT.INDETERMINATE);
  assert.equal(r.refusals[0].name, "unidentifiable project");
  assert.match(r.refusals[0].detail, /custom domain can front ANY project/);
  assert.equal(r.requests.length, 0, "an unidentifiable target is not contacted either");
});

// ===========================================================================
// 2. REFUSAL: other products' tables
// ===========================================================================

const FOREIGN_SAMPLE = ["app_users", "whatslink_links", "dcsrank_scores", "vendor_invoices", "mart_daily_active", "mind_notes"];

test("REFUSAL: a target holding other products' tables is refused (exit 6, via the real CLI)", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: FOREIGN_SAMPLE });
  t.after(() => stub.close());
  const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.CONTAMINATED, r.out);
  assert.match(r.out, /RESULT: REFUSED/);
  assert.match(r.out, /other products/i);
  for (const p of FOREIGN_TABLE_PREFIXES) assert.match(r.out, new RegExp(p.replace("_", "_") + "\\*"), `report must name the ${p}* family`);
  assert.match(r.out, /signature of a SHARED project/);
  assert.doesNotMatch(r.out, /RESULT: PASS/);
});

test("CONTROL: the same stub with those tables removed passes (exit 0)", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: [] });
  t.after(() => stub.close());
  const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.PASS, r.out);
  assert.match(r.out, /RESULT: PASS/);
  assert.match(r.out, /READY \(empty project\)/);
});

test("REFUSAL: ONE foreign table among many DCS Games tables is still a refusal", async (t) => {
  // The refusal is about presence, not proportion: a single app_* table means
  // this project belongs to something else too.
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: [...REQUIRED_TABLES, "app_users"], chainRows: [{ version: 9 }] });
  t.after(() => stub.close());
  const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.CONTAMINATED, r.out);
  assert.match(r.out, /app_\* x1/);
});

test("the report says what the target DOES contain, not merely whether it passed", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: ["some_other_table", "another_one"] });
  t.after(() => stub.close());
  const r = await preflight({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.PASS);
  assert.equal(r.contents.total, 2);
  assert.equal(r.contents.foreign_count, 0);
  assert.equal(r.contents.dcsgames_count, 0);
  assert.equal(r.contents.other_count, 2);
  const text = render(r);
  assert.match(text, /tables visible to the API : 2/);
  assert.match(text, /some_other_table/);
  assert.match(text, /dcsgames_schema_migrations: ABSENT/);
});

// ===========================================================================
// 3. REFUSAL: unreachable, and a rejected key
// ===========================================================================

test("REFUSAL: an unreachable target exits non-zero rather than passing", async () => {
  const port = await deadPort();
  const key = jwtKey(NEW_REF);
  const r = await runCli({ SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.notEqual(r.code, 0, "an unreachable target must never exit 0");
  assert.equal(r.code, EXIT.UNREACHABLE, r.out);
  assert.match(r.out, /could not be reached/);
  assert.match(r.out, /An unreachable target is a refusal, never a pass/);
  assert.doesNotMatch(r.out, /RESULT: PASS/);
});

test("REFUSAL: a 5xx from the target is unreachable, not clean", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, rootStatus: 503 });
  t.after(() => stub.close());
  const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.UNREACHABLE, r.out);
});

test("REFUSAL: a bad key is never reported as clean", async (t) => {
  const stub = await postgrestStub({ key: jwtKey(NEW_REF), tables: [] });
  t.after(() => stub.close());
  // Same project ref, so the identity checks pass and the ONLY thing wrong is
  // that the key itself is not the one the target accepts.
  const wrongKey = jwtKey(NEW_REF, "service_role", { iat: 1750000001 });
  const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: wrongKey });
  assert.equal(r.code, EXIT.AUTH, r.out);
  assert.doesNotMatch(r.out, /RESULT: PASS/);
  assert.doesNotMatch(r.out, /READY/);
  assert.doesNotMatch(r.out, /\bis clean\b/i);
  assert.doesNotMatch(r.out, /tables visible to the API/, "it must not report contents it could not read");
  assert.equal(JSON.parse((await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: wrongKey }, ["--json"])).stdout).contents, null);
  assert.match(r.out, /contents are therefore UNKNOWN and this is NOT a clean result/);
  assert.match(r.out, /Do not migrate until it passes/);
});

test("CONTROL: the correct key against the same stub passes", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: [] });
  t.after(() => stub.close());
  const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.PASS, r.out);
});

test("REFUSAL: a target that answers but is not PostgREST is indeterminate, not empty", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, rootStatus: 200, rootBody: J({ hello: "world" }) });
  t.after(() => stub.close());
  const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.INDETERMINATE, r.out);
  assert.match(r.out, /'Could not tell' is a refusal, not a pass/);
});

test("REFUSAL: missing environment is a refusal with named variables and an exit code", async () => {
  const r = await runCli({});
  assert.equal(r.code, EXIT.CONFIG, r.out);
  assert.match(r.out, /not set: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/);
  const half = await runCli({ SUPABASE_URL: `https://${NEW_REF}.supabase.co` });
  assert.equal(half.code, EXIT.CONFIG);
  assert.match(half.out, /not set: SUPABASE_SERVICE_ROLE_KEY/);
});

// ===========================================================================
// 4. What it reports about the DCS Games chain
// ===========================================================================

test("a clean empty target passes and is told to migrate; an unset DSN is flagged unverified", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: [] });
  t.after(() => stub.close());
  const r = await preflight({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.PASS);
  assert.equal(r.chain.table_present, false);
  assert.equal(r.chain.version, null);
  assert.equal(r.chain.required_version, REQUIRED_SCHEMA_VERSION);
  assert.equal(r.chain.missing_required_tables.length, REQUIRED_TABLES.length);
  assert.ok(r.unverified.some((u) => /DATABASE_URL is not set/.test(u)));
  const text = render(r);
  assert.match(text, /migrate\.mjs up.*--i-have-a-backup/);
  assert.match(text, /IRREVERSIBLE/);
});

test("an already-migrated target reports the applied version, and only reads it", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: REQUIRED_TABLES, chainRows: [{ version: 4 }, { version: REQUIRED_SCHEMA_VERSION }] });
  t.after(() => stub.close());
  const r = await preflight({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.PASS, J(r.refusals));
  assert.equal(r.chain.table_present, true);
  assert.equal(r.chain.version, REQUIRED_SCHEMA_VERSION);
  assert.deepEqual(r.chain.missing_required_tables, []);
  assert.match(r.verdict, /^ALREADY MIGRATED/);
  assert.ok(stub.wire.every((w) => w.method === "GET"), "reading the version must not write anything");
});

test("a half-applied target is reported as PARTIAL with the missing tables named", async (t) => {
  const key = jwtKey(NEW_REF);
  const tables = ["dcsgames_schema_migrations", "dcsgames_base_worlds"];
  const stub = await postgrestStub({ key, tables, chainRows: [{ version: 3 }] });
  t.after(() => stub.close());
  const r = await preflight({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.PASS);
  assert.match(r.verdict, /^PARTIAL/);
  assert.equal(r.chain.version, 3);
  assert.ok(r.chain.missing_required_tables.includes("dcsgames_ledger"));
  assert.match(render(r), /STOP and ask before writing anything/);
});

// ===========================================================================
// 5. It is read-only, and it does not leak the credential
// ===========================================================================

test("every request the preflight makes is a GET — proven at the target, both paths", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: REQUIRED_TABLES, chainRows: [{ version: 9 }] });
  t.after(() => stub.close());
  const r = await preflight({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key });
  assert.equal(r.code, EXIT.PASS);
  assert.ok(stub.wire.length >= 2, "root + chain read");
  assert.deepEqual([...new Set(stub.wire.map((w) => w.method))], ["GET"]);
  assert.deepEqual([...new Set(r.requests.map((w) => w.method))], ["GET"]);
});

test("the source contains no write verb, no DDL and no psql", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  for (const bad of [/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i, /\bpsqlExec\b/, /\bcreate\s+table\b/i,
                     /\binsert\s+into\b/i, /\bdrop\s+(table|database|schema)\b/i, /\balter\s+table\b/i,
                     /\bdelete\s+from\b/i, /\btruncate\b/i]) {
    assert.doesNotMatch(src, bad, `cutover-check.mjs must be read-only; found ${bad}`);
  }
  assert.match(src, /method: "GET"/);
});

test("there is no environment or flag that turns the forbidden-project refusal off", async () => {
  const env = {
    SUPABASE_URL: `https://${SHARED_PROD_REF}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: jwtKey(SHARED_PROD_REF),
    // Every override name someone might reach for at 2am.
    DCS_CUTOVER_ALLOW_SHARED: "1", DCS_ALLOW_SHARED_PROJECT: "1", FORCE: "1", I_KNOW_WHAT_IM_DOING: "1",
  };
  const r = await runCli(env, ["--force", "--yes", "--i-have-a-backup", "--allow-shared"]);
  assert.equal(r.code, EXIT.FORBIDDEN, r.out);
  assert.match(r.out, /There is no override for this refusal/);
});

test("the service-role key never appears in the output, in either format", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: [] });
  t.after(() => stub.close());
  const dsn = `postgresql://postgres.${NEW_REF}:SUPERSECRETPASSWORD@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`;
  for (const args of [[], ["--json"]]) {
    const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key, DATABASE_URL: dsn }, args);
    assert.equal(r.code, EXIT.PASS, r.out);
    assert.ok(!r.out.includes(key), `the key leaked into the output (${args.join(" ") || "text"})`);
    assert.ok(!r.out.includes("SUPERSECRETPASSWORD"), "the DSN password leaked into the output");
    assert.match(r.out, /sha256:[0-9a-f]{12}/, "a non-reversible fingerprint is printed instead");
  }
});

test("--json emits the same verdict and exit code as the human output", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub = await postgrestStub({ key, tables: FOREIGN_SAMPLE });
  t.after(() => stub.close());
  const r = await runCli({ SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: key }, ["--json"]);
  assert.equal(r.code, EXIT.CONTAMINATED);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, EXIT.CONTAMINATED);
  assert.equal(parsed.verdict, "REFUSED");
  assert.equal(parsed.contents.foreign_count, FOREIGN_SAMPLE.length);
  assert.ok(parsed.refusals[0].next.length > 0, "a refusal without a next step is not actionable");
});

test("every refusal carries at least one concrete next step", async (t) => {
  const key = jwtKey(NEW_REF);
  const stub503 = await postgrestStub({ key, rootStatus: 503 });
  t.after(() => stub503.close());
  const cases = [
    await preflight({}, { fetch: noNetwork() }),
    await preflight({ SUPABASE_URL: `https://${SHARED_PROD_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwtKey(SHARED_PROD_REF) }, { fetch: noNetwork() }),
    await preflight({ SUPABASE_URL: `https://${NEW_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: jwtKey(NEW_REF) }, { fetch: noNetwork() }),
    await preflight({ SUPABASE_URL: stub503.url, SUPABASE_SERVICE_ROLE_KEY: key }),
  ];
  for (const r of cases) {
    assert.equal(r.ok, false);
    assert.notEqual(r.code, 0);
    assert.ok(r.refusals.length >= 1);
    for (const ref of r.refusals) {
      assert.ok(Array.isArray(ref.next) && ref.next.length >= 1, `${ref.name} has no next step`);
      assert.ok(ref.detail && ref.detail.length > 20, `${ref.name} has no readable detail`);
    }
    assert.match(render(r), /WHAT TO DO NEXT/);
  }
});
