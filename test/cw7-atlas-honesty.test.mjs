// CW7 — the public trust surface must not present the absence of a measurement
// as a measurement.
//
// server.mts constructs makeAtlasRoutes({ worlds: [], events: [], receipts: [],
// verifiedWorldIds: [] }) and serves its route table at GET /atlas/builder/:id
// and GET /atlas/world/:id. With an empty corpus every id is unknown, so the
// "honest zeros for unknown ids" claim in src/cw7/atlas-routes.mjs and
// RUNBOOK_INTEGRATION.md was vacuous: KNOWN ids returned the same zeros.
//
// Reproduced 7 Sep 2026 against a locally booted server.mts, in one run:
//   POST /worlds/:id/publish   -> 200 published, signed
//   GET  /atlas/receipt/:hash  -> 200, this estate's own signature over that world
//   GET  /v3/worlds/:id/stats  -> 200 {"plays":1,"unique_players":1}
//   GET  /atlas/world/:id      -> 200 {"verified":false,"ownership_history":[],
//                                      "reputation":0,"visits":0,"ratings":0}
//   GET  /atlas/world/undefined-> 200, byte-identical
//
// The end-to-end test at the bottom is the one that matters: it asserts the two
// surfaces of the SAME server cannot contradict each other about the same world.
// It passes today because the trust surface now declares itself unmeasured, and
// it will keep passing once the corpus is wired in — at which point it will be
// asserting that the ownership really is reported. It cannot be satisfied by
// going back to silent zeros.
//
// Run: node --test test/cw7-atlas-honesty.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";
import { makeAtlasRoutes } from "../src/cw7/atlas-routes.mjs";

// atlas-local-sign loads its key lazily on first use and caches it, so the key
// has to be in the environment before the module is imported — the same setup
// test/atlas-provenance.test.mjs uses. Without it issueWorldReceipt returns an
// UNSIGNED receipt and the "a genuine receipt verifies" control below would
// pass for the wrong reason.
const ATLAS_SEED = crypto.randomBytes(32);
process.env.ATLAS_PRIVATE_KEY = ATLAS_SEED.toString("base64");
delete process.env.ATLAS_SIGNING_SK_B64;
delete process.env.ATLAS_PRIVATE_KEY_B64;
delete process.env.ATLAS_PUBLIC_KEY;
const { issueWorldReceipt, verifyReceipt, atlasReady } = await import("../src/cw7/atlas-local-sign.mjs");
assert.equal(atlasReady(), true, "the test signing key must load, or the controls below prove nothing");

// ==========================================================================
// 1. The three states are distinguishable, in the module, without a server.
// ==========================================================================

test("with no corpus at all, nothing is reported as a number", () => {
  // This is exactly how server.mts constructs it today.
  const atlas = makeAtlasRoutes({ worlds: [], events: [], receipts: [], verifiedWorldIds: [] });

  const b = atlas.builder("user-owner");
  assert.equal(b.measured, false, "an empty corpus cannot have measured anything");
  assert.equal(b.trust_score, null, "0 reads as a verdict; null reads as blank, which is the truth");
  assert.equal(b.reputation, null);
  assert.equal(b.verified, false, "trust fails closed — never null, never true without proof");
  assert.ok(/ABSENCE of a measurement/.test(b.note), "the response must say so in words, not only in a flag");

  const w = atlas.world("w3_anything");
  assert.equal(w.measured, false);
  assert.equal(w.reputation, null);
  assert.equal(w.visits, null);
  assert.equal(w.ratings, null);
  assert.equal(w.verified, false);
  assert.deepEqual(w.ownership_history, []);
  assert.ok(/ABSENCE of a measurement/.test(w.note));
});

test("with a corpus, a subject the corpus has never seen gets real zeros — and is told so", () => {
  const atlas = makeAtlasRoutes({
    worlds: [{ world_id: "w1", builder_id: "someone-else" }],
    events: [], receipts: [], verifiedWorldIds: [],
  });

  const b = atlas.builder("a-stranger");
  assert.equal(b.measured, true, "there is a corpus, so the arithmetic is real");
  assert.equal(b.known, false, "but it contains nothing about this builder");
  assert.equal(b.trust_score, 0, "zeros for an unseen subject are honest once they are labelled");
  assert.ok(/never seen/.test(b.note), "and the label must be in the response");

  const w = atlas.world("no-such-world");
  assert.equal(w.measured, true);
  assert.equal(w.known, false);
  assert.equal(w.reputation, 0);
  assert.ok(/never seen/.test(w.note));
});

test("a subject the corpus does know is reported as measured, with no caveat", () => {
  const events = [
    { type: "visit", world_id: "w1", actor_id: "player-1" },
    { type: "visit", world_id: "w1", actor_id: "player-2" },
    { type: "rating", world_id: "w1", actor_id: "player-1", stars: 5 },
  ];
  const atlas = makeAtlasRoutes({
    worlds: [{ world_id: "w1", builder_id: "builder-1" }],
    events, receipts: [], verifiedWorldIds: [],
  });

  const w = atlas.world("w1");
  assert.equal(w.measured, true);
  assert.equal(w.known, true);
  assert.equal(w.note, null, "a measured, known subject needs no caveat");
  assert.equal(w.visits, 2, "the real count, not a placeholder");
  assert.equal(w.ratings, 1);
  assert.ok(w.reputation > 0, "a world with visits and a five-star rating scores above zero");

  const b = atlas.builder("builder-1");
  assert.equal(b.known, true);
  assert.equal(b.note, null);
  assert.ok(b.trust_score > 0);
});

test("the three states are actually distinguishable from one another", () => {
  // The whole point: a reader must be able to tell them apart from the response
  // alone. Before this change all three produced the same body.
  const none = makeAtlasRoutes({ worlds: [], events: [], receipts: [] }).world("w1");
  const withCorpus = makeAtlasRoutes({ worlds: [{ world_id: "other", builder_id: "b" }], events: [], receipts: [] });
  const unknown = withCorpus.world("w1");
  const known = makeAtlasRoutes({
    worlds: [{ world_id: "w1", builder_id: "b" }],
    events: [{ type: "visit", world_id: "w1", actor_id: "p" }], receipts: [],
  }).world("w1");

  const sig = (o) => JSON.stringify([o.measured, o.known, o.reputation]);
  assert.notEqual(sig(none), sig(unknown), "unmeasured must not look like unknown");
  assert.notEqual(sig(unknown), sig(known), "unknown must not look like measured-and-known");
  assert.notEqual(sig(none), sig(known));
});

test("describeCorpus reports the gap, so it can be surfaced without probing a route", () => {
  const empty = makeAtlasRoutes({ worlds: [], events: [], receipts: [] }).describeCorpus();
  assert.equal(empty.measured, false);
  assert.deepEqual([empty.worlds, empty.events, empty.receipts], [0, 0, 0]);
  assert.equal(empty.verifier_injected, false, "server.mts injects no verifyReceiptSig either");
  assert.ok(empty.note);

  const wired = makeAtlasRoutes({
    worlds: [{ world_id: "w1", builder_id: "b" }], events: [], receipts: [],
    verifyReceiptSig: verifyReceipt,
  }).describeCorpus();
  assert.equal(wired.measured, true);
  assert.equal(wired.verifier_injected, true);
  assert.equal(wired.note, null);
});

// ==========================================================================
// 2. Making the absence visible must not have loosened anything.
// ==========================================================================

test("verified stays fail-closed in every state, including the unmeasured one", () => {
  // The 6 Sep forgery fix: an unchecked signature must never establish ownership.
  // A `null` here would be a regression — a consumer testing `if (!verified)`
  // still refuses, but one testing `verified === false` would stop refusing.
  const forged = [{
    receipt_id: "r1", world_id: "w1", builder_id: "attacker", action: "create",
    prev_receipt_id: null, ts: "2026-01-01", sig: "NOT-A-SIGNATURE",
  }];
  for (const deps of [
    { worlds: [], events: [], receipts: [] },
    { worlds: [{ world_id: "w1", builder_id: "attacker" }], events: [], receipts: forged },
    { worlds: [{ world_id: "w1", builder_id: "attacker" }], events: [], receipts: forged, verifyReceiptSig: verifyReceipt },
  ]) {
    const r = makeAtlasRoutes(deps);
    assert.equal(r.world("w1").verified, false, "an unverified receipt must not establish ownership");
    assert.strictEqual(typeof r.world("w1").verified, "boolean", "verified must stay a boolean");
    assert.strictEqual(typeof r.builder("attacker").verified, "boolean");
  }
});

test("a genuine receipt, with the real verifier injected, still produces a verified chain", () => {
  // The control for the test above: if this stops passing, the fail-closed
  // assertions are no longer measuring anything.
  const receipt = issueWorldReceipt("world-real", "creator-honest");
  const atlas = makeAtlasRoutes({
    worlds: [{ world_id: "world-real", builder_id: "creator-honest" }],
    events: [], receipts: [receipt], verifyReceiptSig: verifyReceipt,
  });
  const w = atlas.world("world-real");
  assert.equal(w.verified, true, "this estate's own signature over its own world must verify");
  assert.equal(w.known, true);
  assert.equal(w.ownership_history[0].builder_id, "creator-honest");
});

// ==========================================================================
// 3. The two surfaces of one server may not contradict each other.
// ==========================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");
const SECRET = "cw7-atlas-honesty-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-cw7-atlas-"));
const PORT = 8600 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = signLocalToken(SECRET, { sub: "user-owner", email: "owner@dcsai.ai", roles: ["internal_tester"] }, 3600);
const PLAYER = signLocalToken(SECRET, { sub: "user-player", email: "player@dcsai.ai" }, 3600);

let proc;
before(async () => {
  proc = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT), DCS_AUTH_SECRET: SECRET, DCS_DATA_DIR: DATA,
      PAYMENTS_LIVE: "0", NODE_ENV: "test", DCS_PUBLISH_VISIBILITY: "public",   // the PUBLIC (production-canary) visibility semantics are what this suite pins; internal is the default and is pinned in test/games-b-backend-closure.test.mjs DCS_INTERNAL_TESTERS: "owner@dcsai.ai",
      // A real signing key, so publishing genuinely signs rather than skipping.
      // Deliberately a DIFFERENT key from this process's: the server must verify
      // its own receipts with its own key, not with the test harness's.
      ATLAS_PRIVATE_KEY: crypto.randomBytes(32).toString("base64"),
      DCS_PROVIDERS_OFFLINE: "1",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "",
      CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "", CEREBRAS_KEY_2: "",
    },
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 250; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error("server did not become healthy");
});
after(() => { proc?.kill("SIGKILL"); fs.rmSync(DATA, { recursive: true, force: true }); });

const call = async (tok, m, p, b) => {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { ...(tok ? { Authorization: "Bearer " + tok } : {}), "Content-Type": "application/json" },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test("the trust surface never contradicts the receipt surface about the same world", async () => {
  // Age is a precondition for creating during the internal test window.
  assert.equal((await call(OWNER, "POST", "/safety/age", { date_of_birth: "1990-01-01" })).status, 200);
  assert.equal((await call(PLAYER, "POST", "/safety/age", { date_of_birth: "1990-01-01" })).status, 200);

  const gen = await call(OWNER, "POST", "/v3/worlds/generate", { prompt: "a rainy nordic port town" });
  assert.equal(gen.status, 200, JSON.stringify(gen.body).slice(0, 300));
  const id = gen.body.world_id;
  assert.ok(id, "the world must have an id to ask about");

  const pub = await call(OWNER, "POST", `/worlds/${id}/publish`, {});
  assert.equal(pub.status, 200);
  assert.equal(pub.body.published, true);
  assert.equal(pub.body.signed, true, "with a signing key set, the receipt must really be signed");
  const hash = pub.body.receipt.receipt_hash;

  await call(PLAYER, "POST", `/v3/worlds/${id}/play`, { seconds: 120 });

  // Surface 1: the receipt. This estate's own signature over this exact world.
  const rec = await call(null, "GET", `/atlas/receipt/${hash}`);
  assert.equal(rec.status, 200);
  assert.equal(rec.body.subject_id, id);
  assert.equal(rec.body.attested_by, "user-owner");
  assert.ok(rec.body.sig, "the receipt carries a real signature");

  // Surface 2: the world's measured play. Real, non-zero.
  const stats = await call(PLAYER, "GET", `/v3/worlds/${id}/stats`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.stats.plays, 1);

  // Surface 3: the trust view. It is entitled to say it has not measured this
  // world. It is NOT entitled to report a measurement that contradicts the two
  // surfaces above.
  const trust = await call(null, "GET", `/atlas/world/${id}`);
  assert.equal(trust.status, 200, "the public trust surface stays public and stays 200");

  if (trust.body.measured) {
    // The corpus is wired: then it must agree with the receipt and the plays.
    assert.equal(trust.body.known, true, `a published, signed, played world must be known: ${JSON.stringify(trust.body)}`);
    assert.equal(trust.body.verified, true, "a world this estate signed must not be reported unverified");
    assert.ok(trust.body.visits >= 1, "a world with a recorded play must not report zero visits");
  } else {
    // The corpus is not wired: then it must not emit numbers at all, and must
    // say why. This is the state server.mts is in today.
    assert.equal(trust.body.reputation, null, "an unmeasured world must not be given a reputation number");
    assert.equal(trust.body.visits, null);
    assert.equal(trust.body.ratings, null);
    assert.ok(/ABSENCE of a measurement/.test(trust.body.note || ""),
      "and must say, in the response, that this is not a measurement");
  }
  // In either state, `verified: false` beside a valid receipt must never be
  // presented as a finding.
  assert.notEqual(
    JSON.stringify({ verified: trust.body.verified, measured: trust.body.measured, note: trust.body.note }),
    JSON.stringify({ verified: false, measured: true, note: null }),
    "reporting a signed world as measured-and-unverified would contradict /atlas/receipt",
  );
});

test("the builder surface answers the same way about the builder who signed it", async () => {
  const b = await call(null, "GET", "/atlas/builder/user-owner");
  assert.equal(b.status, 200);
  if (b.measured) {
    assert.equal(b.body.known, true);
  } else {
    assert.equal(b.body.trust_score, null, "an unmeasured builder must not be given a score");
    assert.ok(b.body.note);
  }
  assert.strictEqual(typeof b.body.verified, "boolean", "verified stays fail-closed on the wire too");
  assert.ok(!JSON.stringify(b.body).includes("owner@dcsai.ai"), "the public trust surface leaks no email");
});
