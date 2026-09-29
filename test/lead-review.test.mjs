// Lane G — adversarial review of the code written by the LEAD on 7 Sep 2026.
//
// The Lead authored and reviewed today's changes alone: the new unauthenticated
// /api/public/* surface, /me/home, the CORS gate, the save/load fixes, the A5
// media-consent gate, the cw5 op validation and the /health additions. This
// suite is the second reader.
//
// RECONCILED 7 Sep 2026, after the Lead fixed all thirteen findings.
//
//   `CLOSED (was DEFECT, OPEN):`  the defect is fixed. The test now asserts the
//                                 CORRECT behaviour and keeps the account of
//                                 what was wrong, because that history is the
//                                 part a future reader needs.
//   `DEFECT, OPEN:`               still red. Genuinely not closed.
//   `DISPROVED:`                  an attack that did not work, kept so nobody
//                                 re-derives it.
//
// Nothing here weakens an assertion to go green: every CLOSED test asserts the
// fix, not the absence of the symptom.
//
// Run: node --import tsx --test test/lead-review.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");
const SECRET = "lead-review-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-lead-review-"));
const PORT = 8720 + Math.floor(Math.random() * 120);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = crypto.randomBytes(4).toString("hex");

const TOKENS = {
  // Owns everything, on the internal-tester allowlist.
  OWNER: signLocalToken(SECRET, { sub: "user-g-owner", email: "g-owner@dcsai.ai", roles: ["internal_tester"] }, 7200),
  // A real, authenticated person who is NOT an internal tester, and whose
  // likeness nobody has consent for.
  VICTIM: signLocalToken(SECRET, { sub: "user-g-victim", email: "g-victim@example.com" }, 7200),
  // A second ordinary account, used for the quota-shaped tests.
  BULK: signLocalToken(SECRET, { sub: "user-g-bulk", email: "g-bulk@example.com" }, 7200),
};

let proc;
const F = {};

function baseEnv() {
  return {
    ...process.env,
    PORT: String(PORT),
    DCS_AUTH_SECRET: SECRET,
    DCS_DATA_DIR: DATA,
    PAYMENTS_LIVE: "0",
    NODE_ENV: "test", DCS_PUBLISH_VISIBILITY: "public",   // the PUBLIC (production-canary) visibility semantics are what this suite pins; internal is the default and is pinned in test/games-b-backend-closure.test.mjs
    DCS_PROVIDERS_OFFLINE: "1",
    ATLAS_PRIVATE_KEY: crypto.randomBytes(32).toString("base64"),
    DCS_INTERNAL_TESTERS: "g-owner@dcsai.ai",
    SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", DATABASE_URL: "",
    CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "", CEREBRAS_KEY_2: "",
    DEEPSEEK_API_KEY: "", TOGETHER_API_KEY: "",
  };
}

async function boot() {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB, env: baseEnv(), stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return p; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

async function call(who, method, url, body) {
  const headers = {};
  if (who) headers.Authorization = "Bearer " + TOKENS[who];
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}

/** The playtest gate can genuinely refuse a generated world; that is not the subject here. */
async function mintWorld(who, label) {
  let last = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await call(who, "POST", "/v3/worlds/generate", { prompt: `${label} take ${attempt} ${RUN}` });
    if (r.status === 200) return r.body.world_id;
    last = r;
  }
  throw new Error(`could not mint a world for ${label}: ${last.status} ${String(last.text).slice(0, 300)}`);
}

before(async () => {
  proc = await boot();
  for (const who of ["OWNER", "VICTIM", "BULK"]) {
    const r = await call(who, "POST", "/safety/age", { date_of_birth: "1990-01-01", method: "synthetic_test" });
    assert.equal(r.status, 200, `age assurance for ${who}: ${r.text.slice(0, 200)}`);
  }
  F.media = await mintWorld("OWNER", "a world whose media is generated");
  F.swap = await mintWorld("OWNER", "a world that is published and then rewritten");
  F.older = await mintWorld("OWNER", "a world published first");
  F.newer = await mintWorld("OWNER", "a world published second");
  F.runtime = await mintWorld("OWNER", "a world with runtime state");
});

after(() => {
  proc?.kill("SIGKILL");
  fs.rmSync(DATA, { recursive: true, force: true });
});

// ===========================================================================
// 1. A5 media consent — the gate is keyed on a `kind` list, not on the
//    presence of a subject.
// ===========================================================================
//
// server.mts:1556 gates only kind ∈ {voice, narration, avatar}. But
// src/core/safety.mjs:24 declares MEDIA_KINDS = [voice, likeness, avatar, name,
// performance] and /health publishes that list under `safety.accepts.media_kind`
// as the vocabulary this server understands. `likeness` — the word the consent
// system itself uses for using a real person's face — is not in the gated set,
// and server.mts:1592 forwards `subject_id` to the media lane for EVERY kind
// (src/v3/providers/media.mjs:56 puts it on the wire to KINIX verbatim).
//
// The media provider module states the contract this breaks, at
// src/v3/providers/media.mjs:12:
//     "SAFETY: voice and likeness generation goes through the A5 consent gate.
//      An adapter here never bypasses it; the router calls requireMediaConsent
//      first."
// For `likeness` the router does not.
//
// Reproduced against the running server: kind "voice" + subject_id "user-g-victim"
// is correctly 403; the same request with kind "likeness" is 200.

test("CLOSED (was DEFECT, OPEN): the gate keys on a named subject, not on a word", async () => {
  // WAS: server.mts gated kind ∈ {voice, narration, avatar}. `likeness` — the
  // word the consent system itself uses for using a real person's face, and one
  // /health publishes as an accepted media_kind — was not in the set, so a
  // likeness of user-g-victim, who has granted nothing, returned 200 while the
  // identical request spelled `voice` returned 403.
  //
  // NOW: any request naming a subject needs consent whatever it calls itself,
  // and the inherently-personal kinds need it even with the subject implicit.
  const gated = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "voice", subject_id: "user-g-victim",
  });
  assert.equal(gated.status, 403, "a voice of another person is refused");

  const likeness = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "likeness", subject_id: "user-g-victim",
  });
  assert.equal(likeness.status, 403, "and so is a likeness of them: " + likeness.text.slice(0, 200));
  assert.match(likeness.body.detail, /no unrevoked .* consent is recorded for this subject/,
    "refused BY THE CONSENT GATE, not by some other error that happens to be a 403");

  // Every other word for the same act, including ones the server has never
  // heard of — an unrecognised kind naming a subject is read as a likeness.
  for (const kind of ["avatar", "name", "performance", "video", "hologram", "deepfake"]) {
    const r = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, { kind, subject_id: "user-g-victim" });
    assert.equal(r.status, 403, `kind:"${kind}" naming a subject must take the gate too`);
  }

  // And the gate did not become a blanket block: material tied to nobody still
  // goes through, which is what keeps this a consent gate rather than a switch.
  const scenery = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, { kind: "image", target: "thumbnail" });
  assert.equal(scenery.status, 200, "a thumbnail of a place, naming no one, is not gated");
});

test("CLOSED (was DEFECT, OPEN): an image of a named subject takes the consent gate", async () => {
  // WAS: `kind:"image"` was ungated entirely, and the portrait path is the one
  // that renders a face. The request returned 200 AND stored the asset in the
  // world, with subject_id forwarded to the provider.
  const r = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "image", target: "portrait", subject_id: "user-g-victim",
  });
  assert.equal(r.status, 403, "a portrait of a named person is refused: " + r.text.slice(0, 200));

  // And nothing was written to the world on the way to the refusal.
  const manifest = await call("OWNER", "GET", `/v3/worlds/${F.media}/manifest`);
  const assets = manifest.body.manifest?.assets || manifest.body.assets || [];
  assert.ok(
    !assets.some((a) => a.id === "asset_media_portrait"),
    "the refused portrait must not be in the manifest"
  );
});

test("CLOSED (was DEFECT, OPEN): consent covers the subject even when they are implicit", async () => {
  // The other half of the fix, and the half that is easy to miss: "no
  // subject_id" on a voice clone means the CALLER, not nobody. Without a
  // recorded consent for themselves, the caller is refused too.
  const implicit = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, { kind: "voice" });
  assert.equal(implicit.status, 403, "an implicit subject is still a subject: " + implicit.text.slice(0, 200));
  assert.equal(implicit.body.meta?.subject_id, "user-g-owner", "and the subject is the caller");
});

test("DISPROVED: 'synthetic' cannot be smuggled past the gate by spelling or case", async () => {
  // Hypothesis: the naming check is `b.source === "synthetic"` (strict) while
  // requireMediaConsent might normalise, so "Synthetic" would name a subject AND
  // claim the exemption. It does not: safety.mjs:430 is strict too, so a
  // differently-cased value falls through to "not synthetic" and is refused.
  const caps = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "voice", source: "Synthetic", subject_id: "user-g-victim",
  });
  assert.equal(caps.status, 403, "a mis-cased 'Synthetic' claim is not exempt");

  const exact = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "voice", source: "synthetic", subject_id: "user-g-victim",
  });
  assert.equal(exact.status, 422, "and an honest synthetic claim that names a subject is refused outright");

  const absent = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "voice", subject_id: "user-g-victim",
  });
  assert.equal(absent.status, 403, "an absent source is 'unknown', and unknown is not exempt");
});

// ===========================================================================
// 2. A save on a published world.
// ===========================================================================
//
// WAS: the Lead replaced `state: b.state || "draft"` with
// `prior?.state || "draft"`, which looked like the smaller change and was
// worse. The world stayed published while its whole manifest was replaced from
// the request body — no publish authorisation, no new receipt — and
// `meta.atlas_signed` / `meta.atlas_receipt_hash` came straight from the
// caller. /v3/discover renders that flag as the verification badge and
// /api/public/worlds served the invented hash to anonymous readers.
//
// NOW: a save on a published world returns it to draft and says why, and the
// two trust fields are stripped on the way in — they are the publish route's
// to write.

test("CLOSED (was DEFECT, OPEN): a save on a published world returns it to draft, unbadged", async () => {
  const pub = await call("OWNER", "POST", `/worlds/${F.swap}/publish`, {});
  assert.equal(pub.status, 200, "the world publishes normally: " + pub.text.slice(0, 200));
  const realHash = pub.body.receipt.receipt_hash;

  const listed = await call(null, "GET", "/api/public/worlds");
  assert.ok(listed.body.worlds.some((w) => w.world_id === F.swap), "and is in the public catalogue");

  // Direct state-setting is still refused.
  const direct = await call("OWNER", "POST", `/worlds/${F.swap}/save`, {
    manifest: { meta: { title: "x" } }, state: "published",
  });
  assert.equal(direct.status, 422, "a body `state` is refused");

  // The swap that used to keep the badge.
  const swapped = await call("OWNER", "POST", `/worlds/${F.swap}/save`, {
    manifest: { meta: { title: `SWAPPED-${RUN}`, atlas_signed: true, atlas_receipt_hash: "deadbeefdeadbeef" } },
  });
  assert.equal(swapped.status, 200, "the save itself succeeds — saving is saving");
  assert.equal(swapped.body.state, "draft", "and the world is now a draft");
  assert.equal(swapped.body.unpublished, true);
  assert.match(swapped.body.unpublished_reason, /receipt attested to the previous manifest/,
    "and the caller is told why, rather than discovering it from a listing");

  const cards = await call(null, "GET", "/api/public/worlds");
  assert.ok(
    !cards.body.worlds.some((w) => w.world_id === F.swap),
    "the swapped world has left the public catalogue until it is published again"
  );

  const disc = await call(null, "GET", "/v3/discover");
  assert.ok(!disc.body.worlds.some((w) => w.world_id === F.swap), "and discovery too");

  // The forged trust fields never reached the store, so re-publishing cannot
  // resurrect them either.
  const owner = await call("OWNER", "GET", `/worlds/${F.swap}/load`);
  assert.equal(owner.body.manifest.meta.atlas_receipt_hash, undefined, "the invented receipt hash was stripped");
  assert.equal(owner.body.manifest.meta.atlas_signed, undefined, "and so was the badge");
  assert.notEqual(owner.body.manifest.meta.atlas_receipt_hash, realHash, "including the real one — publish rewrites it");
});

// ===========================================================================
// 3. GET /api/public/events, and 4. GET /me/home — a page called a total.
// ===========================================================================

test("CLOSED (was DEFECT, OPEN): the catalogue feed no longer claims to be a publication log", async () => {
  // WAS: `{kind: "world_published", at: w.updated_at}`, sorted on `at`. An edit
  // re-ordered the "publication" feed and back-dated nothing — the world
  // published first led it, carrying its edit time as though that were when it
  // went live. The store keeps no publication timestamp, so the feed never had
  // one to report.
  const a = await call("OWNER", "POST", `/worlds/${F.older}/publish`, {});
  assert.equal(a.status, 200, "world A publishes: " + a.text.slice(0, 200));
  await new Promise((r) => setTimeout(r, 1100));
  const b = await call("OWNER", "POST", `/worlds/${F.newer}/publish`, {});
  assert.equal(b.status, 200, "world B publishes second: " + b.text.slice(0, 200));

  const feed = await call(null, "GET", "/api/public/events");
  const events = feed.body.events;
  assert.ok(events.length >= 2);

  for (const e of events) {
    assert.equal(e.kind, "world_in_catalogue", "no event claims to be a publication");
    assert.equal(e.at, undefined, "the ambiguous field name is gone");
    assert.ok(e.last_changed_at, "and the timestamp says what it actually is");
  }
  assert.match(
    feed.body.basis, /no publication timestamp/i,
    "and the basis states plainly that this is not a chronology of publications"
  );

  // The ordering claim it DOES make — most recently changed first — is true,
  // and an edit moving a world up it is now correct rather than misleading.
  const changed = events.map((e) => e.last_changed_at);
  assert.deepEqual(changed, [...changed].sort().reverse(), "ordered by last change, descending");
});

test("CLOSED (was DEFECT, OPEN): /me/home reports a page as a page", async () => {
  // WAS: `worlds: { total: mine.length }` over `listOwned(me.id, 50)`. A creator
  // with 55 worlds was told they had exactly 50, for ever.
  const N = 55;
  for (let i = 0; i < N; i++) {
    // Creation through save is now an internal-tester surface (see below), so
    // this is the OWNER rather than an ordinary account.
    const r = await call("OWNER", "POST", `/worlds/gb_${RUN}_${i}/save`, { manifest: { meta: { title: `bulk ${i}` } } });
    assert.equal(r.status, 200, `world ${i} stored: ${r.text.slice(0, 160)}`);
  }
  const home = await call("OWNER", "GET", "/me/home");
  assert.equal(home.status, 200);
  const w = home.body.worlds;
  assert.equal(w.total, undefined, "the field that lied is gone, not merely corrected");
  assert.equal(w.counted, 50, "what was counted");
  assert.equal(w.page_limit, 50, "out of how many it could count");
  assert.equal(w.complete, false, "and whether that is all of them");
  assert.match(w.note, /not a total/, "said in words as well as in fields");
  assert.equal(w.published + w.drafts, w.counted, "the breakdown adds up to what was counted");
});

test("CLOSED (was DEFECT, OPEN): the play figure is named for what it counts", async () => {
  // WAS: `plays_of_my_worlds`, computed in the same loop over the same 50
  // records, so when `worlds.complete` is false it was the play count of an
  // arbitrary page reported as a bare number beside counts that had just been
  // given their provenance. A creator with 200 worlds read it as their total.
  //
  // NOW: `plays_of_the_worlds_counted_above` — which needs no note, because the
  // name is the note.
  const home = await call("OWNER", "GET", "/me/home");
  assert.equal(home.body.worlds.complete, false, "precondition: this caller has more worlds than one page");
  assert.equal(home.body.plays_of_my_worlds, undefined, "the name that overclaimed is gone, not merely annotated");
  assert.equal(
    typeof home.body.plays_of_the_worlds_counted_above, "number",
    "and the figure is still reported, under a name that says exactly what it is over"
  );
});

test("CLOSED (was DEFECT, OPEN): creating a world through save takes the tester gate", async () => {
  // WAS: both generate routes take mustBeInternalTester; save took mustBe, and
  // upsert's owner check only fires when a record already exists. So any
  // authenticated account could bring unlimited worlds into being on ids of its
  // choosing, during a window explicitly limited to authorised testers — and
  // that was the cheap half of the cost amplification in
  // test/lead-review-cost.test.mjs.
  const refusedGenerate = await call("VICTIM", "POST", "/v3/worlds/generate", { prompt: `a world ${RUN}` });
  assert.equal(refusedGenerate.status, 403, "the generate surface is closed to non-testers");

  const refusedSave = await call("VICTIM", "POST", `/worlds/squatted_${RUN}/save`, {
    manifest: { meta: { title: "created without passing the internal-tester gate" } },
  });
  assert.equal(
    refusedSave.status, 403,
    "and so is creation through save: " + refusedSave.text.slice(0, 200)
  );

  // The world must not exist even as a side effect of the refusal.
  const exists = await call("OWNER", "GET", `/worlds/squatted_${RUN}/load`);
  assert.equal(exists.status, 404, "nothing was created on the way to the 403");

  // And the fix is narrow: SAVING a world that already exists is untouched,
  // which is the whole point of the route. (An ordinary account can no longer
  // own a world at all, because every creation path is now tester-only — worth
  // knowing when the testing window ends.)
  const created = await call("OWNER", "POST", `/worlds/owned_${RUN}/save`, { manifest: { meta: { title: "mine" } } });
  assert.equal(created.status, 200, "a tester creates it");
  const resaved = await call("OWNER", "POST", `/worlds/owned_${RUN}/save`, { manifest: { meta: { title: "mine, edited" } } });
  assert.equal(resaved.status, 200, "and re-saving it is not gated again");
});

// ===========================================================================
// 6. cw5: seq validation, and how a refusal reaches the caller.
// ===========================================================================

test("CLOSED (was DEFECT, OPEN): cw5 refuses a delta whose seq is not a number", async () => {
  // WAS: save() checked only `delta.seq == null`. A non-numeric seq walked
  // through every numeric comparison as NaN — `seq <= maxSeq` false, so it was
  // appended — and was filtered straight back out of every replay by
  // `d.seq > afterSeq`. The caller was told ok:true with the seq they sent and
  // the ops were never applied to anything, ever.
  const saved = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: "not-a-number",
    ops: [{ op: "var_set", key: `ghost_${RUN}`, value: "written and acknowledged" }],
  });
  assert.equal(saved.status, 422, "refused, not acknowledged: " + saved.text.slice(0, 200));

  const loaded = await call("OWNER", "GET", `/worlds/${F.runtime}/load`);
  assert.equal(
    loaded.body.runtime_state?.vars?.[`ghost_${RUN}`], undefined,
    "and nothing from the refused delta is in the world"
  );

  // The neighbouring values that are also not a seq.
  for (const seq of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 2, "3", null, {}, []]) {
    const r = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, { seq, ops: [] });
    assert.ok(r.status === 422 || r.status === 409, `seq=${JSON.stringify(seq)} is refused (got ${r.status})`);
  }
});

test("CLOSED (was DEFECT, OPEN): a cw5 refusal reaches the caller with its reason", async () => {
  // WAS: cw5 throws plain Errors, and the top-level handler treats anything that
  // is not an AppError as an internal fault whose message is withheld. So the
  // carefully written refusals — 'unknown op', 'a delta may not act on another
  // player's behalf', 'ownership could not be read' — were logged as server
  // faults and the caller was told "an unexpected error occurred" with a 500
  // that reads as retryable.
  const unknownOp = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: 900, ops: [{ op: "teleport", object_id: "x" }],
  });
  assert.equal(unknownOp.status, 422, "a bad request is a validation failure, not a server fault");
  assert.match(unknownOp.body.detail, /unknown op 'teleport'/, "and it says which op");
  assert.match(unknownOp.body.detail, /unloadable/, "and why it matters that it was not stored");

  // Non-monotonic is a conflict, not a validation failure — the caller's delta
  // is well-formed and simply late.
  await call("OWNER", "POST", `/worlds/${F.runtime}/save`, { seq: 700, ops: [] });
  const late = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, { seq: 600, ops: [] });
  assert.equal(late.status, 409, "a stale seq is a conflict: " + late.text.slice(0, 160));

  // Nothing the runtime authored leaks through the mapping: every message that
  // reaches a client here is one the engine wrote for a caller.
  for (const r of [unknownOp, late]) {
    assert.match(r.body.detail, /^save: /, "only the engine's own caller-facing text");
    assert.ok(!/\bat \/|node:internal|cw5_persistence\.ts/.test(r.text), "no stack, no file path");
  }
});

test("DISPROVED: cw5 op validation does not accept anything replay refuses", async () => {
  // Hypothesis: ops are validated against `emptyState()` while replay applies
  // them to a populated state, so an op could pass validation and throw on
  // replay — bricking an append-only world, the exact failure the check exists
  // to prevent. It cannot: every throw in applyOp is a field-presence check on
  // the op itself and none of them consult the state. move_object on an existing
  // object takes a different branch, but that branch cannot throw either.
  const place = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: 1001, ops: [{ op: "place_object", object_id: `obj_${RUN}`, kind: "structure", transform: { x: 1, y: 0, z: 2 } }],
  });
  assert.equal(place.status, 200);
  const move = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: 1002, ops: [{ op: "move_object", object_id: `obj_${RUN}`, transform: { x: 9 } }],
  });
  assert.equal(move.status, 200);
  const loaded = await call("OWNER", "GET", `/worlds/${F.runtime}/load`);
  assert.equal(loaded.status, 200, "replay still succeeds after both");
  const obj = loaded.body.runtime_state.objects.find((o) => o.object_id === `obj_${RUN}`);
  assert.equal(obj.transform.x, 9, "and the world holds what was acknowledged");
});

// ===========================================================================
// 7. /api/public/stats and the play figures.
// ===========================================================================
//
// WAS: the play route's own comment recorded the problem — "25 requests took a
// world from 0 to 25 plays and 360,000 seconds of watch time — no credential,
// no rate limit, no dedupe" — and only the credential had been added. Ten
// requests from one token in twenty milliseconds produced ten plays and forty
// hours, and those totals were published anonymously as the platform's
// MEASURED figures.
//
// NOW: a play is a session (repeats from one principal within the window fold
// into the existing row), and the seconds are published under a name that
// carries their provenance instead of being presented as a measurement.

test("CLOSED (was DEFECT, OPEN): one account is one player, and the seconds say they are a claim", async () => {
  const w = await mintWorld("OWNER", "a world whose play count was inflated");
  const pub = await call("OWNER", "POST", `/worlds/${w}/publish`, {});
  assert.equal(pub.status, 200, "published: " + pub.text.slice(0, 200));

  const before = (await call(null, "GET", "/api/public/stats")).body;
  for (let i = 0; i < 10; i++) {
    const r = await call("OWNER", "POST", `/v3/worlds/${w}/play`, { seconds: 999999 });
    assert.equal(r.status, 201, "each report is still accepted — a client re-reporting progress is behaving correctly");
  }
  const after = (await call(null, "GET", "/api/public/stats")).body;

  assert.equal(
    after.plays - before.plays, 1,
    "ten requests from one principal in one window are one session, not ten plays"
  );

  // The seconds are no longer offered as something the server measured.
  assert.equal(after.play_seconds, undefined, "the neutral name that read as measured is gone");
  assert.equal(after.play_seconds_measured, null, "nothing times a session, and that is stated");
  assert.match(after.play_seconds_note, /reported by clients/i, "and the self-reported figure carries its provenance");

  // A claim is still bounded: one session's worth, not forty hours.
  const claimed = after.play_seconds_self_reported - before.play_seconds_self_reported;
  assert.ok(
    claimed <= 4 * 60 * 60,
    `one principal contributed ${claimed} seconds in one window; a single clamped session is the ceiling`
  );
});

test("CLOSED (was DEFECT, OPEN): /api/public/stats says when its own listing is capped", async () => {
  // The same class as /me/home's `total`, one endpoint along: every figure is
  // computed over `listPublished(1000)`, so above a thousand published worlds
  // they silently become floors. The response now says so in the answer rather
  // than leaving it to be discovered when the numbers stop moving.
  const s = (await call(null, "GET", "/api/public/stats")).body;
  assert.equal(s.page_limit, 1000);
  assert.equal(s.complete, s.counted_over < 1000);
  assert.equal(typeof s.counted_over, "number");
});

// ===========================================================================
// 8. The public surface: what is safe, and one thing that is not.
// ===========================================================================

test("DISPROVED: the public endpoints do not leak drafts or unpublished content", async () => {
  const draft = await mintWorld("OWNER", "a draft that must stay invisible");
  await call("OWNER", "POST", `/v3/worlds/${draft}/play`, { seconds: 30 });
  await call("OWNER", "POST", `/v3/worlds/${draft}/rate`, { rating: 5 });

  for (const url of ["/api/public/worlds", "/api/public/events", "/api/public/stats", "/api/public/market", "/api/public/atlas/feed", "/api/public/atlas/stats"]) {
    const r = await call(null, "GET", url);
    assert.equal(r.status, 200, url);
    assert.ok(!r.text.includes(draft), `${url} must not mention a draft world id`);
  }
  const stats = (await call(null, "GET", "/api/public/stats")).body;
  assert.match(stats.basis, /PUBLISHED worlds only/);
});

test("CLOSED (consequence of fix 2, and handled with it): the Atlas feed drops worlds that left the catalogue", async () => {
  // This one belongs to the Lead, not to me: returning a saved world to draft
  // creates a receipt whose subject is no longer public, and he closed that in
  // the same pass. Kept as a regression test because the interaction is not
  // obvious from either side alone.
  //
  // The receipt row issued at publish stays in the collection for ever — the
  // publish handler is its only writer and nothing removes one — so an
  // unfiltered feed would go on naming the world after it left the catalogue.
  //
  // Two things follow. The feed is the public provenance surface, and it now
  // lists receipts whose subject an anonymous caller cannot fetch, verify, or
  // even confirm exists: every sibling route answers 404 for that id, which is
  // the answer the repository deliberately gives so that status alone is not an
  // existence oracle. And the feed's own claim — these are the receipts that
  // were issued — quietly becomes "these were issued, for content that may no
  // longer be public".
  const w = await mintWorld("OWNER", "a world published then edited");
  assert.equal((await call("OWNER", "POST", `/worlds/${w}/publish`, {})).status, 200);
  const edited = await call("OWNER", "POST", `/worlds/${w}/save`, { manifest: { meta: { title: `edited-${RUN}` } } });
  assert.equal(edited.body.unpublished, true, "precondition: the save returned it to draft");

  const anon = await call(null, "GET", `/worlds/${w}/manifest`);
  assert.equal(anon.status, 404, "precondition: the world is private now");

  const feed = (await call(null, "GET", "/api/public/atlas/feed")).body;
  assert.ok(
    !feed.receipts.some((r) => r.subject_id === w),
    `the anonymous provenance feed must not name ${w}, a world an anonymous caller is told does not exist`
  );
  assert.match(feed.basis, /still valid and still fetchable by hash/,
    "and it says what it is showing, so a filtered feed is not read as a withdrawn receipt");

  // The receipt itself is not destroyed — it attests to something that happened.
  const stats = (await call(null, "GET", "/api/public/atlas/stats")).body;
  assert.ok(stats.receipts_issued >= feed.count, "issuance is still counted in full");
});

test("DISPROVED: an anonymous caller cannot influence the cost of the public endpoints", async () => {
  // Hypothesis: a limit/offset/sort parameter would let a caller ask for the
  // expensive answer. None of the four read the query string at all — the caps
  // (1000 published worlds for /stats, 200 for /events) are constants in
  // server.mts. The cost is fixed per request and set by the catalogue size.
  const plain = await call(null, "GET", "/api/public/stats");
  const loaded = await call(null, "GET", "/api/public/stats?limit=1000000&sort=expensive");
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.counted_over, plain.body.counted_over, "a query string changes nothing");
  const events = await call(null, "GET", "/api/public/events?limit=100000");
  assert.ok(events.body.events.length <= 40, "the events feed is capped at 40 whatever is asked for");
});

test("DISPROVED: /me/home requires authentication and reveals nobody else's data", async () => {
  const anon = await call(null, "GET", "/me/home");
  assert.equal(anon.status, 401);
  const mine = await call("VICTIM", "GET", "/me/home");
  assert.equal(mine.status, 200);
  assert.equal(mine.body.principal_id, "user-g-victim");
  assert.ok(!mine.text.includes("user-g-owner"), "no other principal's id appears");
  // The /api/* rewrite deliberately exempts /api/public/*, so /api/me/home is
  // the same authenticated route rather than a public one.
  const viaApi = await call(null, "GET", "/api/me/home");
  assert.equal(viaApi.status, 401, "and it cannot be reached anonymously under the /api prefix either");
});

test("DISPROVED: the refusal of a body `state` has no spelling or route around it", async () => {
  const w = await mintWorld("OWNER", "a world whose state is attacked");
  for (const state of ["published", "draft", null, 0, "", ["published"], { toString: () => "published" }]) {
    const r = await call("OWNER", "POST", `/worlds/${w}/save`, { manifest: { meta: { title: "t" } }, state });
    assert.equal(r.status, 422, `state=${JSON.stringify(state)} is refused`);
  }
  // JSON.parse never honours __proto__, so the prototype spelling is inert.
  const proto = await call("OWNER", "POST", `/worlds/${w}/save`, JSON.parse('{"manifest":{"meta":{"title":"t"}},"__proto__":{"state":"published"}}'));
  assert.equal(proto.status, 200);
  const still = await call("OWNER", "GET", `/worlds/${w}/load`);
  assert.equal(still.body.state, "draft", "and the world is still a draft");

  // And no other route takes `state` from a request body: every one of the
  // twelve repo.upsert() call sites in server.mts passes a literal ("draft" at
  // generate/expand/fork, "published" at publish) or `rec.state`.
  const viaEdit = await call("OWNER", "POST", `/v3/worlds/${w}/edit`, { request: "make it brighter", state: "published" });
  assert.ok(viaEdit.status !== 200 || (await call("OWNER", "GET", `/worlds/${w}/load`)).body.state === "draft",
    "an edit cannot publish either");
});

test("DISPROVED: no message the runtime authored reaches a client", async () => {
  // The original form of this test asserted that a cw5 refusal came back as an
  // opaque 500. That was the defect, not the property: the property is that the
  // client is never handed a message nobody chose to send it.
  //
  // The refusals are now mapped to 4xx and DO carry text — but only the
  // engine's own `save: ...` strings, which were written for a caller. Anything
  // without that prefix still falls through to the opaque 500 (the route's
  // mapping re-throws it), so an ENOENT naming a container path or a database
  // error naming relations and columns cannot reach a browser.
  const mapped = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: 4000, ops: [{ op: "definitely_not_an_op" }],
  });
  assert.equal(mapped.status, 422);
  assert.match(mapped.body.detail, /^save: /, "deliberate, caller-facing text");
  assert.ok(mapped.body.correlation_id, "and a correlation id to quote");
  assert.ok(
    !/node:internal|\/Users\/|\.ts:\d+|ENOENT|EACCES/.test(mapped.text),
    "no stack, no filesystem path, no runtime error code"
  );

  // The 404 body is equally sparse: a path, a code, an id, nothing about the
  // process.
  const missing = await call(null, "GET", "/definitely-not-a-route");
  assert.equal(missing.status, 404);
  assert.deepEqual(Object.keys(missing.body).sort(), ["correlation_id", "error", "ok", "path"]);
});
