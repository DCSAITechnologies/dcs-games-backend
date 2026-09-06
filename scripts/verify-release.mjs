#!/usr/bin/env node
// Release gate — the single command that says whether this build is safe to
// promote. It asserts the invariants that, when they were absent, produced the
// incidents this sprint exists to close: a forged migration lineage, live money,
// a seeded "verified" creator, and an unidentifiable build.
//
//   node scripts/verify-release.mjs
//
// Every check either returns a detail string or throws. Any failure exits 1, so
// this can gate a deploy directly. It reads; it changes nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadMigrations, validateChain, REQUIRED_SCHEMA_VERSION } from "../src/core/schema.mjs";
import { createMarketplaceService } from "../src/core/marketplace.mjs";
import { createPrincipalResolver, signLocalToken } from "../src/core/principal.mjs";
import {
  createSubscriptionsService, INTERNAL_WINDOW_ENDS, PLANS,
  PLAN_IDS, GRANT_STATUSES, PAID_STATUSES, MONEY_SHAPED,
} from "../src/core/subscriptions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();

// ------------------------------------------------------------ migration chain

check("the migration chain is linear and complete", async () => {
  // A gapped, reordered or duplicated chain means two databases built from the
  // same repo can end up with different schemas — the divergent-lineage problem
  // that started this. loadMigrations/validateChain are the canonical answer;
  // this script imports them rather than re-implementing the rule.
  const migrations = loadMigrations();
  if (!migrations.length) throw new Error("no migrations were found at all");
  const problems = validateChain(migrations);
  if (problems.length) throw new Error(problems.join("; "));
  const top = migrations[migrations.length - 1];
  if (top.version !== REQUIRED_SCHEMA_VERSION) {
    throw new Error(`the code requires schema v${REQUIRED_SCHEMA_VERSION} but the chain tops out at v${top.version} (${top.file})`);
  }
  return `${migrations.length} migrations, 0001..${String(top.version).padStart(4, "0")}, code requires v${REQUIRED_SCHEMA_VERSION}`;
});

check("the forensic seed cannot re-enter the migration chain", async () => {
  // The quarantined 0002 inserted invented creators with atlas_verified=true.
  // The loader refuses it by shape, not by filename, so renaming it does not
  // help. This proves the guard is still armed rather than assuming it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-release-seed-"));
  try {
    fs.writeFileSync(path.join(dir, "0001_ok.sql"), "create table if not exists t(id int);");
    fs.writeFileSync(
      path.join(dir, "0002_seed.sql"),
      "insert into public.dcsgames_users (username, atlas_verified) values ('novastudio', 'verified');"
    );
    let rejected = false;
    try { loadMigrations(dir); } catch (e) { rejected = /forensic seed/.test(String(e?.detail || e?.message || e)); }
    if (!rejected) throw new Error("loadMigrations accepted a forensic seed — the guard is no longer armed");
    return "a seed migration is refused by shape, whatever it is named";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- money

check("PAYMENTS_LIVE is not enabled", async () => {
  const v = process.env.PAYMENTS_LIVE;
  if (v === "1") throw new Error("PAYMENTS_LIVE=1 — real money is reachable and this build must not be promoted");
  return `PAYMENTS_LIVE=${v === undefined ? "(unset)" : JSON.stringify(v)}`;
});

check("the marketplace is dark", async () => {
  // assertDark scans the actual stored rows, so this is a statement about the
  // data this build would ship with, not only about a flag.
  const m = createMarketplaceService(process.env);
  const r = await m.assertDark();
  if (!r.dark) throw new Error(r.problems.join("; "));
  return `no priced listing, paid acquisition or non-test ledger entry (store: ${m.dir})`;
});

// --------------------------------------------------- fabricated verification

// An INSERT that writes an atlas_verified creator. Matched by shape so a rename
// or a new table name does not slip past. Deliberately narrow enough that the
// guard's own regexes in src/core/schema.mjs are not mistaken for the thing they
// guard against.
const SEED_INSERT = /insert\s+into\s+[a-z0-9_."`]*(users|creators|principals|profiles|builders)\b[\s\S]{0,600}?atlas_verified/i;
const SCANNED = /\.(sql|mjs|mts|cjs|js|ts)$/;
// The statement the quarantined 0002 actually contained. The scan below asserts
// the detector still matches it, so this check can never rot into matching
// nothing and reporting a clean sweep.
const KNOWN_SEED = "insert into public.dcsgames_users (username, atlas_verified) values ('novastudio', 'verified');";

/**
 * Classify one file body against the seed detector.
 *
 *   "violation" — it writes an atlas_verified creator
 *   "guard"     — the ONLY thing in it that matches is the known forensic-seed
 *                 statement, held as a fixture (this script holds one itself)
 *   "clean"     — no match at all
 *
 * The exemption is granted to the fixture STRING, never to a file or a
 * directory: the literal is removed and the detector is run again, so a file
 * that carries the fixture AND a genuine insert is still a violation. That is
 * what stops this from becoming a hole shaped like whichever file the fixture
 * happens to live in.
 */
function classifySeed(body) {
  if (!SEED_INSERT.test(body)) return "clean";
  return SEED_INSERT.test(body.split(KNOWN_SEED).join("")) ? "violation" : "guard";
}

check("no shipped source marks a creator atlas-verified", async () => {
  // The forensic seed invented verified creators. Nothing outside forensics/ may
  // ever write that column: a verified builder has to come from a signed
  // ownership chain, not from a fixture.
  //
  // Four self-tests first. A scan that reports "0 violations" is worth exactly
  // as much as the proof that it could have reported one.
  if (!SEED_INSERT.test(KNOWN_SEED)) throw new Error("the detector no longer matches the known forensic seed statement");
  if (classifySeed(KNOWN_SEED) !== "guard") throw new Error("the known seed statement, alone, must classify as a guard fixture");
  if (classifySeed("select 1;") !== "clean") throw new Error("the detector matches a file with nothing seed-shaped in it");
  {
    // Proven on disk rather than argued: a real violation, and a real violation
    // hidden behind the exempt fixture, must both still be caught.
    //
    // The synthetic violation is ASSEMBLED at runtime rather than written out,
    // for the same reason the fixture is exempted by literal: a second seed
    // statement sitting in this file would make the file a violation of its own
    // check. Joining the parts leaves no `insert into <table>` in the source,
    // and the assertion two lines down proves that is still true.
    const SYNTHETIC = ["insert into", "public.dcsgames_creators (handle,", "atlas_verified) values ('atlantis', true);"].join(" ");
    if (!SEED_INSERT.test(SYNTHETIC)) throw new Error("the synthetic violation is not seed-shaped, so it proves nothing");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-release-detector-"));
    try {
      fs.writeFileSync(path.join(dir, "real.sql"), SYNTHETIC);
      fs.writeFileSync(path.join(dir, "hidden.mjs"), `const FIXTURE = ${JSON.stringify(KNOWN_SEED)};\n// and then, quietly:\n${SYNTHETIC}\n`);
      for (const f of ["real.sql", "hidden.mjs"]) {
        const kind = classifySeed(fs.readFileSync(path.join(dir, f), "utf8"));
        if (kind !== "violation") throw new Error(`the detector classified ${f} as '${kind}' — it can no longer catch a real seed insert`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const files = git("ls-files", "-z").split("\0").filter(Boolean);
  const violations = [];
  const guards = [];
  for (const rel of files) {
    if (!SCANNED.test(rel)) continue;
    if (rel.startsWith("forensics/") || rel.startsWith("node_modules/")) continue;
    let body;
    try { body = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
    const kind = classifySeed(body);
    if (kind === "clean") continue;
    // A test file is never applied to a database, and the fixtures that live
    // there exist to PROVE the loader rejects the seed. They are reported, not
    // counted as violations. Anything else earns its exemption only by holding
    // nothing but the fixture.
    (kind === "guard" || rel.startsWith("test/") ? guards : violations).push(rel);
  }
  if (violations.length) throw new Error(`these files insert a verified creator: ${violations.join(", ")}`);
  return `${files.filter((f) => SCANNED.test(f)).length} tracked source files scanned, 0 violations` +
    (guards.length ? ` (${guards.length} guard fixture(s), exempt only for the known seed literal: ${guards.join(", ")})` : "");
});

// -------------------------------------------------------------------- auth
//
// The Round-2 P0: `Authorization: Bearer nope` + `x-user-id: victim-uuid`
// answered 200 as the victim. The impersonation path was deleted on 6 Sep 2026;
// these two checks assert it stayed deleted, from both sides — the behaviour of
// the resolver, and the shape of the source.

const SERVER = fs.readFileSync(path.join(ROOT, "server.mts"), "utf8");

/**
 * A header read that becomes an identity. Three shapes, because the defect can
 * come back wearing any of them:
 *   1. an identity-named binding assigned from a *-user-id style header
 *   2. a header used as the right-hand side of a || / ?? fallback
 *   3. a header used as the fallback arm of a ternary
 * Reading the header in order to REFUSE it — which src/core/principal.mjs does,
 * deliberately — matches none of these, and the known-negative below proves it.
 */
const HEADER_IDENTITY = [
  /(?:const|let|var)\s+\w*(?:user|uid|actor|owner|principal|caller|me)\w*\s*=\s*[^;\n]*headers\s*\[\s*["'`][^"'`]*(?:user|actor|principal|uid)[^"'`]*["'`]\s*\]/i,
  /headers\s*\[\s*["'`][^"'`]*(?:user|actor|principal|uid)[^"'`]*["'`]\s*\]\s*(?:\|\||\?\?)/i,
  /(?:\|\||\?\?)\s*(?:\w+\.)*headers\s*\[\s*["'`][^"'`]*(?:user|actor|principal|uid)[^"'`]*["'`]\s*\]/i,
  /\?\s*[^;\n]*:\s*(?:\w+\.)*headers\s*\[\s*["'`][^"'`]*(?:user|actor|principal|uid)[^"'`]*["'`]\s*\]/i,
];
const readsHeaderIdentity = (body) => HEADER_IDENTITY.some((re) => re.test(body));

// The exact live exploit, and two variants of it, as the detector's known
// positives. The known negative is the refusal principal.mjs actually contains.
const HEADER_FALLBACK_FIXTURES = [
  `const uid = principal ? principal.id : req.headers["x-user-id"];`,
  `const userId = headers["x-user-id"] || claims.sub;`,
  `const actorId = req.headers["x-actor-id"] ?? me.id;`,
];
const HEADER_REFUSAL_FIXTURE = [
  `const legacy = get("x-user-id");`,
  `if (legacy && !token) throw Errors.unauthenticated("x-user-id is not an authentication mechanism", {});`,
].join("\n");

check("no auth path derives an identity from a request header", async () => {
  // Detector self-test first, both directions.
  for (const positive of HEADER_FALLBACK_FIXTURES) {
    if (!readsHeaderIdentity(positive)) throw new Error(`the detector no longer matches a header-identity fallback: ${positive}`);
  }
  if (readsHeaderIdentity(HEADER_REFUSAL_FIXTURE)) {
    throw new Error("the detector matches the deliberate refusal in principal.mjs, so it would flag the fix as the bug");
  }

  const files = git("ls-files", "-z").split("\0").filter(Boolean).filter((f) => /\.(mjs|mts|cjs|js|ts)$/.test(f));
  const offenders = [];
  for (const rel of files) {
    if (rel.startsWith("node_modules/") || rel.startsWith("test/") || rel.startsWith("scripts/") || rel.startsWith("forensics/")) continue;
    let body;
    try { body = fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { continue; }
    if (readsHeaderIdentity(body)) offenders.push(rel);
  }
  if (offenders.length) throw new Error(`these files turn a request header into an identity: ${offenders.join(", ")}`);

  // Source shape is necessary, not sufficient. Run the real chokepoint.
  // Generated per run rather than written here. A literal would be a hardcoded
  // credential in tracked source — which the secret scan is right to refuse
  // whatever it is for — and a random one proves the resolver works with any
  // secret rather than with one this file knows.
  const probeSecret = crypto.randomBytes(32).toString("hex");
  const resolver = createPrincipalResolver({ localSecret: probeSecret, supabaseUrl: "", supabaseKey: "" });
  const mustReject = async (headers, why) => {
    try { const p = await resolver.resolve(headers); throw new Error(`${why}: resolved as ${JSON.stringify(p)}`); }
    catch (e) { if (!e.httpStatus || e.httpStatus !== 401) throw new Error(`${why}: expected 401, got ${e.message}`); }
  };
  await mustReject({ "x-user-id": "victim-uuid" }, "a bare x-user-id authenticated someone");
  await mustReject({ authorization: "Bearer nope", "x-user-id": "victim-uuid" }, "the live P0 request authenticated someone");
  await mustReject({ authorization: "bearer nope", "x-user-id": ["victim-uuid"] }, "the live P0 request, lower-cased scheme, authenticated someone");
  const good = await resolver.resolve({
    authorization: "Bearer " + signLocalToken(probeSecret, { sub: "user-alice" }),
    "x-user-id": "victim-uuid",
  });
  if (!good || good.id !== "user-alice") throw new Error("a valid token no longer resolves to its own subject");
  if (JSON.stringify(good).includes("victim-uuid")) throw new Error("an attacker-supplied header value reached the principal");

  return `${files.length} tracked JS/TS files scanned, 0 header-identity paths; the resolver refuses the live P0 request (401) and ignores a forged header beside a valid token`;
});

check("every route takes its actor from the principal resolver", async () => {
  // A route that decides ownership from a request body is the same defect as the
  // header fallback with a different input. Every actor-shaped argument in
  // server.mts must be an expression derived from the resolved principal.
  // Only names that unambiguously mean THE CALLER. sellerId/buyerId/principalId
  // are deliberately absent: in this codebase they name a subject being filtered
  // on or acted upon (market.browse({ sellerId: q.get("seller") }) is a public
  // filter, not an identity), so including them would make this gate cry wolf,
  // and a gate that cries wolf gets switched off. The names below have exactly
  // one meaning: who this write is attributed to, or whose permission is checked.
  const ACTOR_ARG = /\b(ownerId|actorId|stitcherId|forkerId|requesterId|granterId)\s*[:=]\s*([^,;)}\n]+)/g;
  const RESOLVED = /^(?:me\.id|me\?\.id\s*\?\?\s*null|principal\.id|principal\?\.id\s*\?\?\s*null|principal\?\.id|uid|null|me|principal)$/;

  const classifyActors = (body) => {
    const bad = [];
    for (const m of body.matchAll(ACTOR_ARG)) {
      const value = m[2].trim().replace(/\s+/g, " ");
      if (!RESOLVED.test(value)) bad.push(`${m[1]}: ${value}`);
    }
    return bad;
  };

  // Self-test: the check must flag an actor taken from the request body, and
  // must not flag the resolver-derived spellings the server actually uses.
  for (const positive of [
    `const saved = await repo.upsert({ worldId: id, ownerId: b.owner_id, manifest });`,
    `const target = await repo.getVersion(id, v, { requesterId: q.get("as") });`,
    `planRollback(cur, tgt, { actorId: b.actor_id });`,
    `planStitch(host, guest, { stitcherId: req.headers["x-user-id"] });`,
  ]) {
    if (!classifyActors(positive).length) throw new Error(`the detector no longer flags an actor taken from request input: ${positive}`);
  }
  const negative = classifyActors(`await repo.get(id, { requesterId: principal?.id ?? null });\nawait repo.upsert({ ownerId: me.id });`);
  if (negative.length) throw new Error(`the detector flags legitimate resolver-derived actors: ${negative.join(", ")}`);

  const bad = classifyActors(SERVER);
  if (bad.length) throw new Error(`these routes take an actor from somewhere other than the resolver: ${bad.join("; ")}`);

  // And the helpers those expressions come from must all go through the resolver.
  const helpers = ["whoOrNull", "mustBe", "mustBeInternalTester"];
  for (const h of helpers) {
    const m = SERVER.match(new RegExp(`async function ${h}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!m) throw new Error(`the identity helper ${h}() is gone; this check is looking at the wrong thing`);
    if (!/auth\.(require|resolve)\s*\(/.test(m[1])) throw new Error(`${h}() no longer delegates to the principal resolver`);
  }
  if ((SERVER.match(/createPrincipalResolver\s*\(/g) || []).length !== 1) {
    throw new Error("server.mts constructs more than one principal resolver; there must be exactly one chokepoint");
  }
  return `${helpers.length} identity helpers all delegate to the single principal resolver, and every actor argument in server.mts is resolver-derived`;
});

// --------------------------------------------------------- subscriptions dark

check("the subscription surface is dark", async () => {
  // Same standard as the marketplace: a statement about the ROWS this build
  // would ship with, not only about a flag. The row scan lives here rather than
  // being delegated wholesale, so the gate can be proven against a planted row.
  const windowEnd = new Date(INTERNAL_WINDOW_ENDS + "T23:59:59Z").getTime();
  const rowProblems = (rows) => {
    const problems = [];
    for (const r of rows) {
      const who = r.principal_id;
      if (Number(r.price_minor) !== 0) problems.push(`grant ${who} carries a price`);
      if (PAID_STATUSES.includes(r.status)) problems.push(`grant ${who} is in paid status '${r.status}'`);
      if (!GRANT_STATUSES.includes(r.status)) problems.push(`grant ${who} is in unknown status '${r.status}'`);
      if (r.test_mode !== true || r.comped !== true) problems.push(`grant ${who} is not marked test_mode+comped`);
      if (!PLAN_IDS.includes(r.plan)) problems.push(`grant ${who} is on unknown plan '${r.plan}'`);
      // An expiry that cannot be parsed is a grant that never expires: NaN loses
      // every comparison, so "is it past the window" silently answers no.
      const at = new Date(r.expires_at).getTime();
      if (!r.expires_at || Number.isNaN(at)) problems.push(`grant ${who} has no usable expiry, so it outlives the internal window (${INTERNAL_WINDOW_ENDS})`);
      else if (at > windowEnd) problems.push(`grant ${who} outlives the internal window (${INTERNAL_WINDOW_ENDS})`);
    }
    return problems;
  };

  // Self-test: prove the row scan can fail, on every kind of row it exists for.
  const planted = [
    { principal_id: "a", plan: "dcs_plus", status: "active", test_mode: true, comped: true, price_minor: 0, expires_at: "2026-09-01T00:00:00Z" },
    { principal_id: "b", plan: "dcs_plus", status: "comped", test_mode: true, comped: true, price_minor: 49900, expires_at: "2026-09-01T00:00:00Z" },
    { principal_id: "c", plan: "dcs_plus", status: "comped", test_mode: false, comped: false, price_minor: 0, expires_at: "2026-09-01T00:00:00Z" },
    { principal_id: "d", plan: "dcs_plus", status: "comped", test_mode: true, comped: true, price_minor: 0, expires_at: "2027-01-01T00:00:00Z" },
    { principal_id: "e", plan: "dcs_plus", status: "comped", test_mode: true, comped: true, price_minor: 0, expires_at: null },
    { principal_id: "f", plan: "dcs_plus", status: "comped", test_mode: true, comped: true, price_minor: 0, expires_at: "whenever" },
  ];
  const caught = rowProblems(planted);
  for (const who of ["a", "b", "c", "d", "e", "f"]) {
    if (!caught.some((p) => p.startsWith(`grant ${who} `))) throw new Error(`the row scan cannot catch a '${who}'-shaped row; it would pass vacuously`);
  }
  if (rowProblems([{ principal_id: "ok", plan: "dcs_plus", status: "comped", test_mode: true, comped: true, price_minor: 0, expires_at: "2026-09-01T00:00:00Z" }]).length) {
    throw new Error("the row scan flags a legitimate comped grant");
  }

  const svc = createSubscriptionsService(process.env);
  const problems = [];
  const dark = await svc.assertDark();
  if (!dark.dark) problems.push(...dark.problems);
  problems.push(...rowProblems((await svc.listGrants()).grants));

  // The catalogue is a promise too: an advertised price is money-shaped even
  // with no rows behind it.
  for (const plan of PLANS) {
    if (Number(plan.price_minor) !== 0) problems.push(`plan '${plan.id}' carries a price`);
    if (plan.list_price_minor !== null && Number(plan.list_price_minor) !== 0) problems.push(`plan '${plan.id}' advertises a list price`);
    for (const e of plan.entitlements) {
      if (MONEY_SHAPED.includes(e.key)) problems.push(`plan '${plan.id}' claims money-shaped entitlement '${e.key}'`);
    }
  }
  if (GRANT_STATUSES.some((g) => PAID_STATUSES.includes(g))) problems.push("a paid status has been added to the writable status vocabulary");
  const described = svc.describe();
  if (described.subscribable !== false) problems.push("the service advertises itself as subscribable");
  if (described.psp_integrated !== false) problems.push("a payment provider is reported as integrated");
  if (svc.plans().purchasable !== false) problems.push("the plan catalogue advertises a purchasable plan");

  if (problems.length) throw new Error(problems.join("; "));
  const grants = await svc.listGrants();
  return `no price, no paid status, no grant past ${INTERNAL_WINDOW_ENDS}; ${grants.count} comped grant(s), total ${grants.total_price_minor} minor units (store: ${svc.dir})`;
});

// ------------------------------------------------------------ route honesty

check("every route /health advertises exists in server.mts", async () => {
  // STATIC. It reads server.mts and matches each advertised path against the
  // route patterns actually compiled there. It does NOT start a server, so it
  // cannot prove a route RESPONDS or that it answers the advertised METHOD —
  // that needs a live process and is covered by
  // test/api-integration.test.mjs:479 ("every route health advertises actually
  // responds"), which boots one. What this catches without a server is the
  // failure that has actually happened: a path advertised in /health that no
  // handler in the file matches.
  const start = SERVER.indexOf("\n      routes: {");
  const end = SERVER.indexOf("\n      },", start);
  if (start < 0 || end < 0) throw new Error("the /health routes block is no longer where this check looks for it");
  const block = SERVER.slice(start, end);

  const advertised = [];
  for (const g of block.matchAll(/^\s*(\w+):\s*\[([^\]]*)\],?\s*$/gm)) {
    for (const q of g[2].matchAll(/"([^"]+)"/g)) advertised.push({ group: g[1], entry: q[1] });
  }
  if (advertised.length < 20) throw new Error(`only ${advertised.length} advertised routes were parsed; the extractor has stopped reading the block`);

  const literals = [...SERVER.matchAll(/url\s*===\s*"([^"]+)"/g)].map((m) => m[1]);
  const patterns = SERVER.split("\n")
    .map((line) => { const m = line.match(/url\.match\(\/(.*)\/[gimsuy]*\)/); return m ? m[1] : null; })
    .filter(Boolean)
    .map((sourceText) => new RegExp(sourceText));
  if (!literals.length || !patterns.length) throw new Error("no route patterns were extracted from server.mts; the extractor is broken");

  const concrete = (p) => p.replace(/:[A-Za-z_]+/g, "X");
  const resolves = (p) => literals.includes(concrete(p)) || patterns.some((rx) => rx.test(concrete(p)));
  const missingIn = (entries) => entries
    .filter(({ group }) => group !== "retired")
    .filter(({ entry }) => !resolves(entry.split(" ")[1] || ""))
    .map(({ entry }) => entry);

  // Self-test: a route that does not exist must be reported, and one that does
  // must not be — otherwise this reports "0 missing" whatever happens.
  if (!missingIn([{ group: "world", entry: "GET /v3/worlds/:id/definitely-not-a-route" }]).length) {
    throw new Error("the drift check cannot detect a route that does not exist");
  }
  if (missingIn([{ group: "trust", entry: "GET /health" }, { group: "world", entry: "POST /v3/worlds/generate" }]).length) {
    throw new Error("the drift check reports routes that plainly do exist");
  }

  const missing = missingIn(advertised);
  if (missing.length) throw new Error(`/health advertises routes with no handler in server.mts: ${missing.join(", ")}`);
  const checked = advertised.filter((a) => a.group !== "retired").length;
  return `${checked} advertised paths all resolve to a handler (${literals.length} literal + ${patterns.length} pattern routes). STATIC ONLY: methods and live responses need a running server — test/api-integration.test.mjs:479 covers that.`;
});

// ------------------------------------------------------------ build identity

check("the working tree is clean and the build is identifiable", async () => {
  // A release you cannot name is a release you cannot roll back. A dirty tree
  // means the artefact does not correspond to any commit.
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const sha = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain").split("\n").filter(Boolean);
  if (dirty.length) {
    throw new Error(`${dirty.length} uncommitted change(s) — commit or stash before promoting: ${dirty.slice(0, 8).join(", ")}${dirty.length > 8 ? ", ..." : ""}`);
  }
  return `${branch} @ ${sha.slice(0, 12)} (clean)`;
});

// -------------------------------------------------------------------- report

const results = [];
for (const c of checks) {
  try { results.push({ name: c.name, ok: true, detail: await c.fn() }); }
  catch (e) { results.push({ name: c.name, ok: false, detail: String(e?.detail || e?.message || e) }); }
}

console.log(`verify-release: ${ROOT}\n`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}\n        ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${failed.length === 0 ? "PASS — safe to promote" : "FAIL — do not promote"} (${results.length - failed.length}/${results.length})`);
if (failed.length) console.log(`Blocking: ${failed.map((r) => r.name).join("; ")}`);
process.exit(failed.length === 0 ? 0 : 1);
