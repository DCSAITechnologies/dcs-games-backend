// Lane G — adversarial review of the code written by the LEAD on 7 Sep 2026.
//
// The Lead authored and reviewed today's changes alone: the new unauthenticated
// /api/public/* surface, /me/home, the CORS gate, the save/load fixes, the A5
// media-consent gate, the cw5 op validation and the /health additions. This
// suite is the second reader.
//
// Every test named `DEFECT, OPEN:` FAILS on purpose and carries a reproduction.
// Every test named `DISPROVED:` PASSES and records a hypothesis that turned out
// to be wrong, so nobody re-derives it.
//
// Nothing here weakens an assertion to go green.
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
    NODE_ENV: "test",
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

test("DEFECT, OPEN: the media consent gate is bypassed by naming the kind 'likeness'", async () => {
  const gated = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "voice", subject_id: "user-g-victim",
  });
  assert.equal(gated.status, 403, "control: a voice of another person is correctly refused");

  const bypass = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "likeness", subject_id: "user-g-victim",
  });
  assert.equal(
    bypass.status, 403,
    "a likeness of user-g-victim, who has granted nothing, must be refused exactly as their voice is. " +
    "server.mts:1556 gates on kind ∈ {voice,narration,avatar}; 'likeness' is a declared MEDIA_KIND " +
    "(src/core/safety.mjs:24), is published by /health as accepted, and is passed to the provider " +
    `with the subject id attached. Observed ${bypass.status}: ${String(bypass.text).slice(0, 200)}`
  );
});

test("DEFECT, OPEN: an image of a named subject reaches the provider with no consent check", async () => {
  // The portrait path is the one that actually renders a face, and
  // mediaPromptFor() builds a portrait prompt for it. `kind: "image"` is not in
  // the gated set at all, so the consent gate never runs, and the asset is
  // written into the world.
  const r = await call("OWNER", "POST", `/v3/worlds/${F.media}/media`, {
    kind: "image", target: "portrait", subject_id: "user-g-victim",
  });
  assert.equal(
    r.status, 403,
    "generating a portrait of a named person must take the same consent gate as their voice. " +
    `Observed ${r.status} and the asset was stored: ${String(r.text).slice(0, 200)}`
  );
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
// 2. POST /worlds/:id/save now PRESERVES `published`, which turns saving into
//    an unreviewed content swap on a live, signed, publicly listed world.
// ===========================================================================
//
// The old expression was `state: b.state || "draft"`. The Lead correctly killed
// the `b.state` half. The `|| "draft"` half was replaced with
// `prior?.state || "draft"` (server.mts:2081), which is a different behaviour,
// not a smaller one: before, a save of a published world dropped it back to
// draft and OUT of the public catalogue. Now the world stays published while its
// entire manifest is replaced by whatever the request body carries — no publish
// authorisation, no Atlas receipt, no re-signing, and the manifest's own
// `meta.atlas_signed` flag comes straight from the caller.
//
// /v3/discover renders exactly that field as the verification badge
// (src/core/social.mjs:1172: `atlas_signed: !!w.manifest?.meta?.atlas_signed`),
// and /api/public/worlds — a route the Lead shipped today — serves the forged
// `atlas_receipt_hash` to anonymous callers.

test("DEFECT, OPEN: a save rewrites a PUBLISHED world and can forge its Atlas badge", async () => {
  const pub = await call("OWNER", "POST", `/worlds/${F.swap}/publish`, {});
  assert.equal(pub.status, 200, "the world publishes normally: " + pub.text.slice(0, 200));
  const realHash = pub.body.receipt.receipt_hash;

  // Direct state-setting is correctly refused. This is the Lead's fix working.
  const direct = await call("OWNER", "POST", `/worlds/${F.swap}/save`, {
    manifest: { meta: { title: "x" } }, state: "published",
  });
  assert.equal(direct.status, 422, "a body `state` is refused");

  // ...and here is the same outcome without ever naming `state`.
  const swapped = await call("OWNER", "POST", `/worlds/${F.swap}/save`, {
    manifest: { meta: { title: `SWAPPED-${RUN}`, atlas_signed: true, atlas_receipt_hash: "deadbeefdeadbeef" } },
  });
  assert.equal(swapped.status, 200, "the swap is accepted");

  const cards = await call(null, "GET", "/api/public/worlds");
  const card = cards.body.worlds.find((w) => w.world_id === F.swap);
  assert.ok(card, "the world is still in the public catalogue");

  assert.notEqual(
    card.title, `SWAPPED-${RUN}`,
    "a published world's content was replaced through POST /worlds/:id/save with no publish " +
    "authorisation and no new receipt, and it stayed published and publicly listed. " +
    "server.mts:2081 preserves `published`; the previous code dropped it to draft, which at least " +
    "took the swapped content out of discovery."
  );
  assert.notEqual(
    card.manifest?.meta?.atlas_receipt_hash, "deadbeefdeadbeef",
    `the anonymous catalogue is serving a receipt hash the caller invented; the real one is ${realHash}`
  );

  const disc = await call(null, "GET", "/v3/discover");
  const row = disc.body.worlds.find((w) => w.world_id === F.swap);
  assert.equal(
    row?.atlas_signed, false,
    "the discovery 'atlas_signed' badge is read straight out of the manifest the caller just wrote, " +
    "so any world owner can display a verification badge over content Atlas never saw"
  );
});

// ===========================================================================
// 3. GET /api/public/events labels a MODIFICATION time as a publication.
// ===========================================================================
//
// server.mts:566 builds `{kind: "world_published", at: w.updated_at || w.created_at}`
// and sorts on it. `updated_at` moves on every save, so the feed the site renders
// as "recently published" is really "recently touched", and a world published
// days ago jumps back to the top of it the moment its creator edits it — with a
// timestamp that reads as its publication date.

test("DEFECT, OPEN: /api/public/events reports the last edit as the publication time", async () => {
  const a = await call("OWNER", "POST", `/worlds/${F.older}/publish`, {});
  assert.equal(a.status, 200, "world A publishes: " + a.text.slice(0, 200));
  const publishedA = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 1100));    // distinct second, so the ordering is not a tie
  const b = await call("OWNER", "POST", `/worlds/${F.newer}/publish`, {});
  assert.equal(b.status, 200, "world B publishes second: " + b.text.slice(0, 200));

  const before = await call(null, "GET", "/api/public/events");
  const orderBefore = before.body.events.map((e) => e.world_id).filter((id) => id === F.older || id === F.newer);
  assert.deepEqual(orderBefore, [F.newer, F.older], "control: the most recently published world leads the feed");

  await new Promise((r) => setTimeout(r, 1100));
  const edit = await call("OWNER", "POST", `/worlds/${F.older}/save`, {
    manifest: { meta: { title: `edited-${RUN}` } },
  });
  assert.equal(edit.status, 200, "world A is edited, not re-published");

  const after = await call(null, "GET", "/api/public/events");
  const eventA = after.body.events.find((e) => e.world_id === F.older);
  assert.ok(eventA, "world A is still in the feed");

  assert.ok(
    eventA.at <= publishedA,
    `a record announced as kind:"world_published" carries at=${eventA.at}, which is when the world was ` +
    `last EDITED, not when it was published (${publishedA}). The store keeps no publication timestamp, ` +
    "so this feed cannot report one, and it must not present updated_at as though it were one."
  );

  const orderAfter = after.body.events.map((e) => e.world_id).filter((id) => id === F.older || id === F.newer);
  assert.deepEqual(
    orderAfter, [F.newer, F.older],
    "an edit re-ordered the publication feed: the older publication now leads it"
  );
});

// ===========================================================================
// 4. GET /me/home publishes a page size as a total.
// ===========================================================================
//
// server.mts:634 reads `repo.listOwned(me.id, 50)` and then answers
// `worlds: { total: mine.length, ... }` and `plays_of_my_worlds` summed over the
// same 50. A creator with more than 50 worlds is told they have exactly 50, for
// ever, and their play total is the total for an arbitrary page of them.
//
// This is the same class of defect the endpoint's own neighbours are written to
// prevent — /api/public/stats deliberately refuses to report a platform-wide
// unique-player count rather than report a wrong one.

test("DEFECT, OPEN: /me/home reports the first page of worlds as the total", async () => {
  const N = 55;
  for (let i = 0; i < N; i++) {
    const r = await call("BULK", "POST", `/worlds/gb_${RUN}_${i}/save`, { manifest: { meta: { title: `bulk ${i}` } } });
    assert.equal(r.status, 200, `world ${i} stored`);
  }
  const home = await call("BULK", "GET", "/me/home");
  assert.equal(home.status, 200);
  assert.equal(
    home.body.worlds.total, N,
    `the caller owns ${N} worlds and /me/home reports total=${home.body.worlds.total}, which is the ` +
    "page size at server.mts:634. Either count them, or report the page honestly as a page."
  );
});

// ===========================================================================
// 5. Any authenticated account can mint world records through the V2 save route.
// ===========================================================================
//
// Creation is an internal-tester surface on every route that calls itself one:
// POST /worlds/generate and POST /v3/worlds/generate both go through
// mustBeInternalTester. POST /worlds/:id/save takes mustBe only, and upsert's
// ownership check — as the Lead's own comment at server.mts:2056 observes —
// "only fires when a record already exists". The Lead used that observation to
// justify removing `b.state`, and left the creation itself open: an id nobody has
// claimed becomes a world owned by whoever asked, with no tester check, no
// playtest gate, no prompt, and no limit. The 55 worlds in the test above were
// created that way by a non-tester in about a second.

test("DEFECT, OPEN: a non-internal-tester creates worlds through POST /worlds/:id/save", async () => {
  const refused = await call("VICTIM", "POST", "/v3/worlds/generate", { prompt: `a world ${RUN}` });
  assert.equal(refused.status, 403, "control: the generate surface is closed to non-testers");

  const created = await call("VICTIM", "POST", `/worlds/squatted_${RUN}/save`, {
    manifest: { meta: { title: "created without passing the internal-tester gate" } },
  });
  assert.equal(
    created.status, 403,
    "creating a world is an internal-tester surface until 30 Sep 2026; POST /worlds/:id/save on an " +
    `unclaimed id creates one for anyone with a token. Observed ${created.status}: ${created.text.slice(0, 200)}`
  );
});

// ===========================================================================
// 6. cw5: every op was validated. `seq` was not.
// ===========================================================================
//
// The Lead's stated purpose (cw5_persistence.ts:~355) is "nothing can be
// accepted that replay will later refuse". The op loop achieves that. But
// `save()` only checks `delta.seq == null`, and a non-numeric seq then walks
// through every numeric comparison as NaN — `seq <= maxSeq` is false, so it is
// appended — and is dropped again on the way out, because getDeltas filters
// `d.seq > afterSeq`, which is also false for NaN. The caller is told ok:true
// with the seq they sent, and the ops are never applied to anything, ever.
//
// It also poisons the append-only store's ordering: the list is sorted with
// `a.seq - b.seq`, which is NaN for this row, and getMaxSeq reads the last
// element of that sort.

test("DEFECT, OPEN: cw5 accepts a delta whose seq is not a number, and silently never applies it", async () => {
  const saved = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: "not-a-number",
    ops: [{ op: "var_set", key: `ghost_${RUN}`, value: "written and acknowledged" }],
  });

  if (saved.status === 200) {
    const loaded = await call("OWNER", "GET", `/worlds/${F.runtime}/load`);
    assert.equal(
      loaded.body.runtime_state?.vars?.[`ghost_${RUN}`], "written and acknowledged",
      `the save answered ${saved.status} ok:true seq=${JSON.stringify(saved.body.seq)}, and the op is ` +
      "not in the world. cw5_persistence.ts save() validates every op but never validates seq, so a " +
      "non-numeric seq passes the monotonic check as NaN, is appended, and is then filtered back out " +
      "of every replay. Refuse it instead."
    );
  }
  assert.equal(
    saved.status, 422,
    `a delta with seq=${JSON.stringify("not-a-number")} must be refused, not acknowledged. Observed ${saved.status}`
  );
});

test("DEFECT, OPEN: every cw5 refusal reaches the caller as a 500 with no reason", async () => {
  // cw5_persistence.ts throws plain Errors — 'unknown op', 'a delta may not act
  // on another player's behalf', 'refusing because the world's current ownership
  // could not be read'. The top-level handler (server.mts:2124) treats anything
  // that is not an AppError as an internal fault, and since today's change the
  // message is deliberately withheld. So the carefully written refusals the Lead
  // added are logged as server faults and the caller — who sent a bad request —
  // is told "an unexpected error occurred" with a 500 that reads as retryable.
  const r = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: 900, ops: [{ op: "teleport", object_id: "x" }],
  });
  assert.equal(
    r.status, 422,
    "a client sending an op kind the engine does not know is a validation failure, not a server fault. " +
    `Observed ${r.status} ${JSON.stringify(r.body?.detail)}. These throws need to be AppErrors ` +
    "(Errors.validation / Errors.forbidden) or the route must translate them."
  );
});

test("DISPROVED: cw5 op validation does not accept anything replay refuses", async () => {
  // Hypothesis: ops are validated against `emptyState()` while replay applies
  // them to a populated state, so an op could pass validation and throw on
  // replay — bricking an append-only world, the exact failure the check exists
  // to prevent. It cannot: every throw in applyOp is a field-presence check on
  // the op itself and none of them consult the state. move_object on an existing
  // object takes a different branch, but that branch cannot throw either.
  const place = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: 1, ops: [{ op: "place_object", object_id: `obj_${RUN}`, kind: "structure", transform: { x: 1, y: 0, z: 2 } }],
  });
  assert.equal(place.status, 200);
  const move = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: 2, ops: [{ op: "move_object", object_id: `obj_${RUN}`, transform: { x: 9 } }],
  });
  assert.equal(move.status, 200);
  const loaded = await call("OWNER", "GET", `/worlds/${F.runtime}/load`);
  assert.equal(loaded.status, 200, "replay still succeeds after both");
  const obj = loaded.body.runtime_state.objects.find((o) => o.object_id === `obj_${RUN}`);
  assert.equal(obj.transform.x, 9, "and the world holds what was acknowledged");
});

// ===========================================================================
// 7. /api/public/stats publishes a figure one account can move at will.
// ===========================================================================
//
// The play route's own comment (server.mts:1219) records the problem and the
// fix: "Anonymously, 25 requests took a world from 0 to 25 plays and 360,000
// seconds of watch time — no credential, no rate limit, no dedupe". Only the
// credential was added. With one token the same loop produces the same numbers,
// and as of today they are published, unauthenticated, as the platform's
// measured play total on /api/public/stats — the endpoint written to stop the
// site showing figures no system ever measured.
//
// The assertion below is not a matter of taste: 10 requests in a few
// milliseconds cannot have produced 40 hours of play in a world that has existed
// for seconds.

test("DEFECT, OPEN: public play figures exceed what could physically have been played", async () => {
  const w = await mintWorld("OWNER", "a world whose play count is inflated");
  const pub = await call("OWNER", "POST", `/worlds/${w}/publish`, {});
  assert.equal(pub.status, 200, "published: " + pub.text.slice(0, 200));

  const beforeStats = (await call(null, "GET", "/api/public/stats")).body;
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) {
    const r = await call("OWNER", "POST", `/v3/worlds/${w}/play`, { seconds: 999999 });
    assert.equal(r.status, 201, "each play is accepted");
  }
  const elapsedSeconds = (Date.now() - t0) / 1000;
  const after = (await call(null, "GET", "/api/public/stats")).body;

  const addedSeconds = after.play_seconds - beforeStats.play_seconds;
  const addedPlays = after.plays - beforeStats.plays;
  assert.ok(
    addedSeconds <= Math.max(elapsedSeconds, 60),
    `/api/public/stats now reports ${addedSeconds} seconds of play added by ONE principal in ` +
    `${elapsedSeconds.toFixed(2)} wall-clock seconds (${addedPlays} plays). Nothing times a session ` +
    "server-side and nothing dedupes or rate-limits POST /v3/worlds/:id/play, so this public, " +
    "unauthenticated 'measured' figure is whatever any single account decides it is."
  );
});

// ===========================================================================
// 8. Hypotheses about the new public surface that did NOT hold.
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
  // And the draft's engagement is excluded from the platform figures, which the
  // `basis` string states.
  const stats = (await call(null, "GET", "/api/public/stats")).body;
  assert.match(stats.basis, /PUBLISHED worlds only/);

  // The Atlas feed only ever contains published subjects: server.mts:2026 is the
  // single writer of that collection and it is inside the publish handler.
  const feed = (await call(null, "GET", "/api/public/atlas/feed")).body;
  for (const rec of feed.receipts) {
    const seen = await call(null, "GET", `/worlds/${rec.subject_id}/manifest`);
    assert.equal(seen.status, 200, `receipt subject ${rec.subject_id} is a world anyone may already read`);
  }
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

test("DISPROVED: the error handler does not leak internal messages", async () => {
  const r = await call("OWNER", "POST", `/worlds/${F.runtime}/save`, {
    seq: 5000, ops: [{ op: "unknown_kind_that_throws" }],
  });
  assert.equal(r.status, 500, "wrongly classified — see the 500 defect above");
  assert.equal(r.body.detail, "an unexpected error occurred; quote the correlation id");
  assert.ok(r.body.correlation_id, "and the caller gets a correlation id to quote");
  assert.ok(!/unknown op|unloadable|cw5_persistence/.test(r.text), "the internal message stays in the log");
});
