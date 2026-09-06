// Phase 1 HTTP-level exit gate. Boots the REAL server.mts in a child process
// against a temp data dir and local HS256 auth, then exercises the routes the
// Round-2 audit found exploitable. Run with: node --import tsx --test
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");
const SECRET = "integration-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-api-"));
const PORT = 8100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;

const ALICE = signLocalToken(SECRET, { sub: "user-alice", email: "alice@dcsai.ai", roles: ["internal_tester"] }, 3600);
const MALLORY = signLocalToken(SECRET, { sub: "user-mallory", email: "mallory@example.com" }, 3600);
const MALLORY_TESTER = signLocalToken(SECRET, { sub: "user-mallory", email: "mallory@example.com", roles: ["internal_tester"] }, 3600);
const BOB = signLocalToken(SECRET, { sub: "user-bob", email: "bob@example.com" }, 3600);

let proc;

function baseEnv(extra = {}) {
  return {
    ...process.env,
    PORT: String(PORT),
    DCS_AUTH_SECRET: SECRET,
    DCS_DATA_DIR: DATA,
    PAYMENTS_LIVE: "0",
    NODE_ENV: "test",
    // Alice is on the tester ALLOWLIST, not merely carrying the role in her own
    // token, so grant-to-a-subject can be exercised for real. Mallory is not.
    DCS_INTERNAL_TESTERS: "alice@dcsai.ai",
    // force the local/offline profile: no Supabase, no live LLM calls in CI
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    CEREBRAS_API_KEY: "",
    CEREBRAS_API_KEY_1: "",
    CEREBRAS_API_KEY_2: "",
    CEREBRAS_KEY_2: "",
    ...extra,
  };
}

async function boot(env) {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB, env, stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return p;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

const req = (p, o = {}) => fetch(BASE + p, o);
const auth = (t) => ({ Authorization: "Bearer " + t });
const json = (t, b) => ({ ...auth(t), "Content-Type": "application/json", ...(b ? {} : {}) });

before(async () => { proc = await boot(baseEnv()); });
after(() => { proc?.kill("SIGKILL"); fs.rmSync(DATA, { recursive: true, force: true }); });

test("health reports the truth about auth, persistence and payments", async () => {
  const r = await req("/health");
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.payments_live, false, "PAYMENTS_LIVE must stay false");
  assert.equal(b.auth, "local-hs256");
  assert.equal(b.auth_header_fallback_removed, true);
  assert.equal(b.persistence, "file", "persistence must name the real backend, not a guess");
});

// ---------------------------------------------------------------- A1 gate
test("A1 GATE: the exact live exploit is dead — bad token + forged x-user-id is 401", async () => {
  const r = await req("/api/worlds/mine", { headers: { Authorization: "Bearer nope", "x-user-id": "victim-uuid" } });
  const b = await r.json();
  assert.equal(r.status, 401, "production returned 200 with owner:victim-uuid before this fix");
  assert.equal(b.ok, false);
  assert.equal(b.error, "invalid_token");
  assert.ok(b.correlation_id, "every error carries a correlation id");
});

test("A1: x-user-id alone is 401 and names the removed header", async () => {
  const r = await req("/api/worlds/mine", { headers: { "x-user-id": "victim-uuid" } });
  const b = await r.json();
  assert.equal(r.status, 401);
  assert.equal(b.meta?.removed_header, "x-user-id");
});

test("A1: unauthenticated private routes are 401, not empty 200s", async () => {
  for (const p of ["/api/worlds/mine", "/me/profile", "/v3/marketplace/owned"]) {
    const r = await req(p);
    assert.equal(r.status, 401, `${p} must refuse anonymous callers`);
  }
});

test("A1: a valid token reaches the caller's OWN data only", async () => {
  const r = await req("/api/worlds/mine", { headers: auth(ALICE) });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.owner, "user-alice");
});

test("A1: a forged x-user-id is ignored when a valid token is present", async () => {
  const r = await req("/api/worlds/mine", { headers: { ...auth(ALICE), "x-user-id": "user-victim" } });
  const b = await r.json();
  assert.equal(b.owner, "user-alice", "the token wins; the header is never consulted");
});

test("A1/doctrine: builder surfaces refuse a non-tester with 403 and name the window", async () => {
  const r = await req("/worlds/generate", { method: "POST", headers: json(MALLORY), body: JSON.stringify({ prompt: "x" }) });
  const b = await r.json();
  assert.equal(r.status, 403);
  assert.equal(b.error, "forbidden");
  assert.equal(b.meta?.window_ends, "2026-09-30");
});

// ------------------------------------------------------- A3 gate + A4 honesty
let generatedId;

test("A5: creation is refused until an age tier permits it", async () => {
  const r = await req("/worlds/generate", { method: "POST", headers: json(ALICE), body: JSON.stringify({ prompt: "x" }) });
  const b = await r.json();
  assert.equal(r.status, 403, "an unknown age tier must not be able to create");
  assert.equal(b.meta?.required_action, "record an age assurance");
});

test("A5: an under-13 age assurance is recorded honestly and refused", async () => {
  const r = await req("/safety/age", { method: "POST", headers: json(MALLORY_TESTER), body: JSON.stringify({ date_of_birth: "2020-01-01", method: "synthetic_test" }) });
  const b = await r.json();
  assert.equal(r.status, 403);
  assert.equal(b.age_tier, "under13");
  assert.equal(b.onboarding_permitted, false);
  assert.ok(!("date_of_birth" in b), "the raw date of birth is never returned");
});

test("A3: an internal tester can generate a world and it is stamped with a real owner", async () => {
  const age = await req("/safety/age", { method: "POST", headers: json(ALICE), body: JSON.stringify({ date_of_birth: "1990-04-04" }) });
  assert.equal((await age.json()).age_tier, "adult");
  const r = await req("/worlds/generate", { method: "POST", headers: json(ALICE), body: JSON.stringify({ prompt: "Ashfall Harbour, a rainy nordic port" }) });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.ok, true);
  assert.equal(b.owner, "user-alice");
  assert.equal(b.world_version, 1);
  assert.ok(b.manifest_hash, "a content hash is recorded for every world");
  generatedId = b.world_id;
});

test("A3 GATE: the world survives a full process restart and loads canonically identical", async () => {
  const before = await (await req(`/worlds/${generatedId}/manifest`, { headers: auth(ALICE) })).json();

  proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  proc = await boot(baseEnv());                       // brand new process, same data dir

  const r = await req(`/worlds/${generatedId}/manifest`, { headers: auth(ALICE) });
  assert.equal(r.status, 200, "the world must still exist after a restart");
  const after_ = await r.json();
  assert.deepEqual(after_, before, "the manifest must be byte-equivalent across the restart");
});

test("A3: IDOR — another creator cannot read the draft", async () => {
  const r = await req(`/worlds/${generatedId}/manifest`, { headers: auth(MALLORY) });
  assert.equal(r.status, 403);
});

test("A3: IDOR — another creator cannot overwrite the world", async () => {
  const r = await req(`/worlds/${generatedId}/save`, {
    method: "POST", headers: json(MALLORY_TESTER),
    body: JSON.stringify({ manifest: { hacked: true } }),
  });
  assert.equal(r.status, 403);
});

test("A3: save is idempotent and versions monotonically", async () => {
  const m = { manifest_version: "3.0.0", meta: { title: "Edited" }, zones: [{ id: "z1" }] };
  const a = await (await req(`/worlds/${generatedId}/save`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ manifest: m }) })).json();
  const b = await (await req(`/worlds/${generatedId}/save`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ manifest: m }) })).json();
  assert.equal(b.idempotent, true);
  assert.equal(b.world_version, a.world_version);
  const c = await (await req(`/worlds/${generatedId}/save`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ manifest: { ...m, meta: { title: "Edited again" } } }) })).json();
  assert.equal(c.world_version, a.world_version + 1);
});

test("A3: a stale expected_version is rejected with 409, not silently applied", async () => {
  const r = await req(`/worlds/${generatedId}/save`, {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ manifest: { x: 1 }, expected_version: 1 }),
  });
  assert.equal(r.status, 409);
});

// -------------------------------------------------------------- A4 honesty
test("A4: a missing world is a real 404 with a correlation id", async () => {
  const r = await req("/worlds/does-not-exist/manifest", { headers: auth(ALICE) });
  const b = await r.json();
  assert.equal(r.status, 404);
  assert.equal(b.ok, false);
  assert.ok(b.correlation_id);
});

test("A4: every response carries the correlation id as a header too", async () => {
  const r = await req("/health");
  assert.match(r.headers.get("x-correlation-id") || "", /^cid_/);
});

test("A4: a caller-supplied correlation id is honoured for cross-service tracing", async () => {
  const r = await req("/health", { headers: { "x-correlation-id": "cid_from_client" } });
  assert.equal(r.headers.get("x-correlation-id"), "cid_from_client");
});

test("A4/B10: publish refuses to claim success when no Atlas signing key exists", async () => {
  const r = await req(`/worlds/${generatedId}/publish`, { method: "POST", headers: json(ALICE) });
  const b = await r.json();
  assert.equal(r.status, 503, "an unsigned publish must not return ok:true");
  assert.equal(b.error, "not_configured");
  assert.match(b.detail, /ATLAS_PRIVATE_KEY/);
});

// ---------------------------------------------------------------- money dark
test("payments stay dark: the revenue stub is retired rather than reporting a figure", async () => {
  // It used to answer 200 with total_minor:0 and a 70/30 split. A 200 with a
  // number in it is indistinguishable from a real measurement of zero — it
  // invites a UI to render "your revenue" and a developer to build on a shape
  // no service produces. There is no revenue while payments are dark.
  const r = await req("/api/me/revenue", { headers: auth(ALICE) });
  assert.equal(r.status, 410);
  const b = await r.json();
  assert.equal(b.ok, false);
  assert.equal(b.payments_live, false);
  assert.ok(b.replacement, "a retired route must name what replaced it");
  assert.equal("total_minor" in b, false, "a retired route must not still report a figure");
  assert.equal("payouts" in b, false);
});

// ---------------------------------------------------------------- A5 surface
test("A5: reporting requires authentication and persists", async () => {
  assert.equal((await req("/safety/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subject_type: "world", subject_id: "w", reason: "spam" }) })).status, 401);
  const r = await req("/safety/report", { method: "POST", headers: json(ALICE), body: JSON.stringify({ subject_type: "world", subject_id: generatedId, reason: "harassment" }) });
  const b = await r.json();
  assert.equal(r.status, 201);
  assert.equal(b.status, "open");
});

test("A5 GATE: a child-safety report escalates immediately", async () => {
  const b = await (await req("/safety/report", { method: "POST", headers: json(ALICE), body: JSON.stringify({ subject_type: "user", subject_id: "u-suspect", reason: "grooming" }) })).json();
  assert.equal(b.escalated, true);
});

test("A5: the moderation queue is staff-only, but the moderation LOG is public and honest", async () => {
  assert.equal((await req("/safety/reports", { headers: json(MALLORY) })).status, 403);
  const pub = await req("/safety/moderation-history");
  const b = await pub.json();
  assert.equal(pub.status, 200);
  assert.equal(b.automated_moderation, false, "the API must not claim moderation it does not perform");
  assert.equal(b.count, 0, "no moderation decision has been taken, and the log says so");
});

test("A5 GATE: voice generation consent is required and recorded", async () => {
  const r = await req("/safety/consent/media", { method: "POST", headers: json(ALICE), body: JSON.stringify({ media_kind: "voice", source: "founder", evidence_ref: "signed-2026-09-06" }) });
  assert.equal(r.status, 201);
  const list = await (await req("/safety/consent/media", { headers: json(ALICE) })).json();
  assert.equal(list.consents.length, 1);
  assert.equal(list.consents[0].source, "founder");
  const bad = await req("/safety/consent/media", { method: "POST", headers: json(ALICE), body: JSON.stringify({ media_kind: "voice", source: "scraped_from_the_internet" }) });
  assert.equal(bad.status, 422, "an unrecognised consent source must be refused");
});

test("A5: blocking round-trips", async () => {
  await req("/safety/block", { method: "POST", headers: json(ALICE), body: JSON.stringify({ blocked_id: "user-mallory" }) });
  const b = await (await req("/safety/blocks", { headers: json(ALICE) })).json();
  assert.deepEqual(b.blocked, ["user-mallory"]);
});

test("health advertises the safety posture truthfully", async () => {
  const b = await (await req("/health")).json();
  assert.equal(b.safety.minor_onboarding_enabled, false);
  assert.equal(b.safety.automated_content_moderation, false);
  assert.equal(b.internal_testing_window_ends, "2026-09-30");
});

// ------------------------------------------------------- B11 media + B15 social
test("B11: media generation produces a LABELLED placeholder when no provider exists", async () => {
  const r = await req(`/v3/worlds/${generatedId}/media`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ kind: "image", target: "thumbnail" }) });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  assert.equal(b.generated, true);
  assert.equal(b.placeholder, true, "offline, the placeholder must be labelled as one");
  assert.equal(b.status, "FALLBACK", "and the provenance must say FALLBACK, not AVAILABLE");
});

test("B11 GATE: voice generation is refused without a recorded consent grant", async () => {
  const r = await req(`/v3/worlds/${generatedId}/media`, {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ kind: "voice", target: "narration", subject_id: "some-real-person", source: "explicit_consent" }),
  });
  const b = await r.json();
  assert.equal(r.status, 403);
  assert.match(b.detail, /unrestricted cloning is disabled/);
});

test("B11: synthetic narration needs no subject consent, and reports honestly when it cannot be made", async () => {
  const r = await req(`/v3/worlds/${generatedId}/media`, {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ kind: "narration", target: "narration", source: "synthetic" }),
  });
  const b = await r.json();
  assert.equal(r.status, 200, JSON.stringify(b));
  // There is no offline audio synthesis, so it must say so rather than return silence.
  assert.equal(b.generated, false);
  assert.match(b.reason, /no media provider/);
});

test("B11: the media asset never changes the manifest SHAPE", async () => {
  const m = await (await req(`/v3/worlds/${generatedId}/manifest`, { headers: auth(ALICE) })).json();
  assert.ok(m.manifest.media, "media stays a first-class, always-present block");
  assert.equal(m.manifest.media.thumbnail_is_placeholder, true);
  assert.ok(m.manifest.assets.some((a) => a.id === "asset_media_thumbnail"));
});

test("B15: the profile is durable and reports money as dark", async () => {
  const r = await req("/me/profile", { headers: auth(ALICE) });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.economy.payments_live, false);
  assert.ok(b.worlds_created >= 1, "generating a world moved the real counter");
  assert.equal((await req("/me/profile")).status, 401, "the profile is private");
});

test("B15: friends round-trip through the API", async () => {
  // Deliberately NOT user-mallory: an earlier test blocks them, and a blocked
  // person must not be friendable. That interaction is asserted separately below.
  const a = await req("/social/friends", { method: "POST", headers: json(ALICE), body: JSON.stringify({ friend_id: "user-bob" }) });
  assert.equal(a.status, 201);
  const mine = await (await req("/social/friends", { headers: auth(ALICE) })).json();
  assert.ok(mine.outgoing.some((x) => x.id === "user-bob"));
  const accepted = await req("/social/friends/accept", { method: "POST", headers: json(BOB), body: JSON.stringify({ friend_id: "user-alice" }) });
  assert.equal(accepted.status, 200);
  const after = await (await req("/social/friends", { headers: auth(ALICE) })).json();
  assert.ok(after.friends.some((x) => x.id === "user-bob"));
});

test("B15 GATE: a blocked person cannot be sent a friend request", async () => {
  // user-mallory was blocked by the A5 test above.
  const r = await req("/social/friends", { method: "POST", headers: json(ALICE), body: JSON.stringify({ friend_id: "user-mallory" }) });
  assert.equal(r.status, 403, "blocking must actually prevent contact, not merely hide it");
});

test("B15 GATE: discovery ranks on measured activity and labels honest zeros", async () => {
  const r = await req("/v3/discover?sort=most_played");
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(typeof b.count, "number");
  if (b.count && b.worlds.every((w) => w.stats.plays === 0)) {
    assert.match(b.note, /real zeros, not placeholders/);
  }
});

test("B15: recording a play then reading stats reflects it", async () => {
  await req(`/v3/worlds/${generatedId}/play`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ seconds: 90 }) });
  const s = await (await req(`/v3/worlds/${generatedId}/stats`)).json();
  assert.equal(s.stats.plays, 1);
  assert.equal(s.stats.total_seconds, 90);
  assert.equal(s.stats.rating_avg, null, "an unrated world has no average, not a default");
});

test("B15: a studio split must total 100% and settles nothing", async () => {
  const st = await (await req("/social/studios", { method: "POST", headers: json(ALICE), body: JSON.stringify({ name: "NovaStudio" }) })).json();
  assert.equal(st.studio.payments_live, false);
  const bad = await req(`/social/studios/${st.studio.id}/split`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ splits: [{ member_id: "user-alice", split_bps: 4000 }] }) });
  assert.equal(bad.status, 422);
  const ok = await req(`/social/studios/${st.studio.id}/split`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ splits: [{ member_id: "user-alice", split_bps: 10000 }] }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).payments_live, false);
});

// -------------------------------------------------------- P1 async generation

test("P1 GATE: async generation returns 202 immediately with a job to poll", async () => {
  const t0 = Date.now();
  const r = await req("/v3/worlds/generate/async", { method: "POST", headers: json(ALICE), body: JSON.stringify({ prompt: "A jungle expedition camp" }) });
  const b = await r.json();
  assert.equal(r.status, 202, JSON.stringify(b));
  assert.ok(Date.now() - t0 < 3000, "the request must return before the work finishes");
  assert.ok(b.job_id);
  assert.equal(b.poll, "/v3/jobs/" + b.job_id);
  // The whole stage list arrives up front, so a client can render it immediately.
  assert.ok(b.stages.length >= 6);
  assert.ok(b.stages.some((s) => s.id === "world_architect"));
  asyncJobId = b.job_id;
  asyncWorldId = b.world_id;
});

let asyncJobId, asyncWorldId;

test("P1 GATE: the job completes, and its progress came from real stages", async () => {
  let job = null;
  for (let i = 0; i < 100; i++) {
    job = (await (await req(`/v3/jobs/${asyncJobId}`, { headers: auth(ALICE) })).json()).job;
    if (["succeeded", "failed", "interrupted"].includes(job.state)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.state, "succeeded", JSON.stringify(job.error || job.progress));
  assert.equal(job.progress.basis, "completed stages, not elapsed time");
  assert.equal(job.progress.fraction, 1);

  // Every non-skipped stage records the provider that actually answered.
  const architect = job.stages.find((s) => s.id === "world_architect");
  assert.equal(architect.state, "done");
  assert.match(architect.detail, /FALLBACK|AVAILABLE/, "the stage detail must name what answered");

  // Optional stages nobody asked for are skipped with a reason, not left pending.
  assert.equal(job.stages.find((s) => s.id === "vision").state, "skipped");
  assert.match(job.stages.find((s) => s.id === "vision").detail, /no reference image/);

  assert.equal(job.result.world_id, asyncWorldId);
  assert.ok(job.result.counts.zones >= 3);
  assert.equal(job.result.playtest.verdict, "PASSED");
});

test("P1: the asynchronously generated world is really there and loads", async () => {
  const r = await req(`/v3/worlds/${asyncWorldId}/manifest`, { headers: auth(ALICE) });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.manifest.manifest_version, "3.0.0");
  assert.ok(b.manifest.zones.length >= 3);
});

test("P1: a job is private, and listing shows only your own", async () => {
  assert.equal((await req(`/v3/jobs/${asyncJobId}`, { headers: auth(MALLORY) })).status, 403);
  assert.equal((await req(`/v3/jobs/${asyncJobId}`)).status, 401);
  const mine = await (await req("/v3/jobs", { headers: auth(ALICE) })).json();
  assert.ok(mine.jobs.some((j) => j.id === asyncJobId));
  const theirs = await (await req("/v3/jobs", { headers: auth(MALLORY) })).json();
  assert.equal(theirs.jobs.length, 0);
});

test("P1: async generation is still gated to internal testers", async () => {
  const r = await req("/v3/worlds/generate/async", { method: "POST", headers: json(MALLORY), body: JSON.stringify({ prompt: "x" }) });
  assert.equal(r.status, 403);
});

test("P1: health reports the async job runner and what it reconciled at boot", async () => {
  const b = await (await req("/health")).json();
  assert.equal(b.jobs.async_generation, true);
  assert.ok(b.jobs.boot_id);
  assert.equal(typeof b.jobs.interrupted_on_boot, "number");
});

test("the legacy CW6 economy surface is retired and names its replacement", async () => {
  // It had no durable store and derived its buyer from the x-user-id header.
  for (const [path, method, expected] of [
    ["/api/marketplace", "GET", "/v3/marketplace"],
    ["/api/marketplace/checkout", "POST", "/v3/marketplace"],
    ["/api/me/payouts", "GET", "/v3/marketplace/ledger"],
  ]) {
    const r = await req(path, { method, headers: json(ALICE), body: method === "POST" ? "{}" : undefined });
    const b = await r.json();
    assert.equal(r.status, 410, `${path} should be retired`);
    assert.equal(b.superseded_by, expected);
    assert.equal(b.payments_live, false);
  }
});

test("retained world versions are queryable, and are what a rollback would target", async () => {
  const v = await (await req(`/v3/worlds/${generatedId}/versions`, { headers: auth(ALICE) })).json();
  assert.ok(v.versions.length >= 2, `expected several retained versions, got ${v.versions.length}`);
  assert.ok(v.versions.every((x) => Number.isInteger(x.version) && x.manifest_hash));
  const first = await (await req(`/v3/worlds/${generatedId}/versions/1`, { headers: auth(ALICE) })).json();
  assert.equal(first.version, 1);
  assert.ok(first.manifest, "the retained manifest itself is available");
  assert.equal((await req(`/v3/worlds/${generatedId}/versions/999`, { headers: auth(ALICE) })).status, 404);
});

test("INTEGRATION: every route health advertises actually responds", async () => {
  // A hand-maintained route list drifts the moment someone adds a route and
  // forgets. This walks what /health claims and proves each one is real: a 404
  // means the surface and the advertisement have diverged.
  const h = await (await req("/health")).json();
  const groups = Object.entries(h.routes).filter(([g]) => g !== "retired");
  const missing = [];

  for (const [group, entries] of groups) {
    for (const entry of entries) {
      const [method, p] = entry.split(" ");
      const concrete = p
        .replace(":id", generatedId)
        .replace(":username", "alice")
        .replace(":channel", "email");
      const r = await req(concrete, {
        method,
        headers: method === "POST" ? json(ALICE) : auth(ALICE),
        body: method === "POST" ? "{}" : undefined,
      });
      // A handler that answers "no such job" for a made-up id HAS been reached;
      // only the router's catch-all means the advertisement is a lie. The two
      // are told apart by the catch-all's `path` field, which no handler sets.
      if (r.status === 405) missing.push(`${group}: ${entry} -> 405`);
      else if (r.status === 404) {
        const b = await r.json().catch(() => ({}));
        if (b.path) missing.push(`${group}: ${entry} -> router catch-all 404`);
      }
    }
  }
  assert.deepEqual(missing, [], "health advertises routes that do not exist");
});

test("INTEGRATION: every retired route really is retired", async () => {
  for (const path of ["/api/marketplace", "/api/me/payouts"]) {
    assert.equal((await req(path, { headers: auth(ALICE) })).status, 410, `${path} should be 410`);
  }
});

test("INTEGRATION: health never leaks a secret or a credential", async () => {
  const raw = await (await req("/health")).text();
  for (const pattern of [/eyJ[A-Za-z0-9_-]{20,}\./, /csk-[A-Za-z0-9]{10,}/, /sk-[A-Za-z0-9]{10,}/, /tgp_v1_/, /SERVICE_ROLE/]) {
    assert.ok(!pattern.test(raw), `health output matches ${pattern}`);
  }
  // It should describe capabilities, not configuration values.
  const h = JSON.parse(raw);
  assert.equal(h.payments_live, false);
  assert.equal(h.auth_header_fallback_removed, true);
});

// ------------------------------------------------- money is dark over HTTP
//
// The service refuses, the flag is off and the database has a CHECK constraint,
// but the only surface an outsider can actually touch is this one. If money is
// dark everywhere except here, it is not dark.

test("B15 GATE: nothing on the subscription surface can be bought", async () => {
  const plans = await (await req("/v3/subscriptions/plans")).json();
  assert.equal(plans.purchasable, false);
  assert.equal(plans.payments_live, false);
  for (const p of plans.plans) {
    assert.equal(p.price_minor, 0, `${p.id} carries a price`);
    assert.equal(p.purchasable, false, `${p.id} is offered as purchasable`);
  }

  // The refusal is on "no PSP", not on the flag, so it holds in both states.
  const r = await req("/v3/subscriptions/subscribe", { method: "POST", headers: json(ALICE), body: JSON.stringify({ plan: "dcs_plus" }) });
  assert.equal(r.status, 503);
  const b = await r.json();
  assert.equal(b.error, "not_configured");
  assert.equal(b.ok, false);
  assert.match(JSON.stringify(b), /psp|provider|configured/i);
});

test("B15 GATE: the subscription surface reports itself dark, and a monitor can watch it", async () => {
  const r = await req("/v3/subscriptions/assert-dark");
  assert.equal(r.status, 200, "a non-200 here is the alarm");
  const b = await r.json();
  assert.equal(b.dark, true);
  assert.deepEqual(b.problems, []);
});

test("B15 GATE: a comped test grant never reads as revenue", async () => {
  const g = await req("/v3/subscriptions/grant", {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ principal_id: "alice@dcsai.ai", plan: "dcs_plus", reason: "internal testing" }),
  });
  const gb = await g.json();
  assert.equal(g.status, 200, JSON.stringify(gb));
  const grant = gb.grant;
  assert.equal(grant.price_minor, 0);
  assert.equal(grant.comped, true);
  assert.equal(grant.test_mode, true);
  assert.equal(grant.status, "comped");
  assert.notEqual(grant.status, "active", "there must be no status meaning 'this person is paying'");
  assert.ok(grant.granted_by, "who comped this must be recorded");
  assert.ok(new Date(grant.expires_at) <= new Date("2026-10-01T00:00:00Z"), "a test grant must not outlive the internal window");

  const list = await (await req("/v3/subscriptions/grants", { headers: auth(ALICE) })).json();
  assert.equal(list.total_price_minor, 0);
  assert.equal(list.paid_count, 0);

  // And it is still dark afterwards — a grant must not be able to un-dark it.
  assert.equal((await (await req("/v3/subscriptions/assert-dark")).json()).dark, true);
});

test("B15: a plan cannot be comped for someone whose tester status cannot be verified", async () => {
  const r = await req("/v3/subscriptions/grant", {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ principal_id: "mallory@example.com", plan: "dcs_plus" }),
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).detail, /internal tester|cannot be billed/i);
});

test("B15: a non-tester cannot comp anybody, including themselves", async () => {
  const r = await req("/v3/subscriptions/grant", {
    method: "POST", headers: json(MALLORY),
    body: JSON.stringify({ principal_id: "mallory@example.com", plan: "dcs_plus" }),
  });
  assert.equal(r.status, 403);
  const g = await req("/v3/subscriptions/grants", { headers: auth(MALLORY) });
  assert.equal(g.status, 403);
});

// ------------------------------------- a block holds on EVERY path, over HTTP
//
// The block check used to live on POST /social/friends and nowhere else, so
// A requests B, B blocks A, and either side could still call /accept — a
// friendship formed across a live block. The check now lives in the service,
// which is the only place that can cover a path nobody remembered to guard.

test("A5 GATE: a block prevents a friendship forming through the accept path too", async () => {
  const CARL = signLocalToken(SECRET, { sub: "user-carl", email: "carl@example.com" }, 3600);
  const DANA = signLocalToken(SECRET, { sub: "user-dana", email: "dana@example.com" }, 3600);

  const reqd = await req("/social/friends", { method: "POST", headers: json(CARL), body: JSON.stringify({ friend_id: "user-dana" }) });
  assert.ok(reqd.status < 400, `request should succeed before any block: ${reqd.status}`);

  const blocked = await req("/safety/block", { method: "POST", headers: json(DANA), body: JSON.stringify({ blocked_id: "user-carl" }) });
  assert.ok(blocked.status < 400, `block should succeed: ${blocked.status} ${await blocked.text()}`);

  // The accept path is the one that had no guard at all.
  const accept = await req("/social/friends/accept", { method: "POST", headers: json(DANA), body: JSON.stringify({ friend_id: "user-carl" }) });
  assert.ok(accept.status >= 400, `a blocked pair must not be able to become friends: ${accept.status} ${await accept.text()}`);

  // And the un-acceptable request must not sit in her list forever.
  const list = await (await req("/social/friends", { headers: auth(DANA) })).json();
  const stillPending = JSON.stringify(list).includes("user-carl");
  assert.equal(stillPending, false, "a request that can never be accepted must not linger in the list");
});

test("B15 GATE: a comped tester sees the real allowance, and it still is not revenue", async () => {
  const g = await req("/v3/subscriptions/grant", {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ principal_id: "alice@dcsai.ai", plan: "dcs_plus", reason: "entitlement path" }),
  });
  assert.ok(g.status === 200 || g.status === 409, `grant: ${g.status} ${await g.text()}`);

  const ent = await (await req("/me/entitlements", { headers: auth(ALICE) })).json();
  assert.equal(ent.dcs_plus_paid, false, "a comped grant must never read as paid");
  assert.equal(ent.price_minor, 0);
  assert.equal(ent.payments_live, false);

  // The profile and the entitlement endpoint must not disagree about what this
  // person may do — one saying 1 credit while the other says 10 is how a tester
  // ends up debugging the wrong system.
  const me = await (await req("/me/profile", { headers: auth(ALICE) })).json();
  assert.equal(me.economy?.dcs_plus ?? false, false, "economy.dcs_plus means PAID and must stay false");
  assert.equal(me.subscription?.dcs_plus_paid ?? false, false);
  // The plan must not sit in level_signals: it does not move the level, and
  // listing it there tells a user that paying would raise their reach.
  assert.equal("dcs_plus" in (me.level_signals || {}), false, "the plan must not be advertised as a level signal");
  assert.ok(me.level_signals?.email_verified !== undefined, "the real level signals are still reported");
});

test("HONESTY: /health cannot claim a capability the routes do not provide", async () => {
  const h = await (await req("/health")).json();

  // Subscriptions: if health says nothing is subscribable, subscribing must
  // actually refuse — and if it ever says otherwise, that is a founder decision
  // that must not arrive by accident.
  assert.equal(h.subscriptions.subscribable, false);
  assert.equal(h.subscriptions.psp_integrated, false);
  const sub = await req("/v3/subscriptions/subscribe", { method: "POST", headers: json(ALICE), body: "{}" });
  assert.equal(sub.status, 503, "health says nothing is subscribable, so this must refuse");

  // Verification: with no delivery provider, health must not imply the channel
  // works — and starting a verification must not hand back a code either.
  const chans = h.verification.channels || {};
  for (const [name, c] of Object.entries(chans)) {
    if (c.status === "AVAILABLE") continue;                 // a real provider exists; nothing to prove here
    const r = await req(`/verify/${name}/start`, { method: "POST", headers: json(ALICE), body: JSON.stringify({ destination: "alice@dcsai.ai" }) });
    assert.notEqual(r.status, 200, `${name} is ${c.status} but /verify/${name}/start succeeded`);
    const body = await r.text();
    assert.equal(/_devCode|"code"\s*:\s*"?\d{6}/.test(body), false, "a verification code must never reach a client");
  }

  // Payments: one flag, and every surface that depends on it must agree.
  assert.equal(h.payments_live, false);
  assert.equal((await (await req("/v3/marketplace/assert-dark")).json()).dark, true);
  assert.equal((await (await req("/v3/subscriptions/assert-dark")).json()).dark, true);
});

// ------------------------------------------------- rollback, end to end
//
// This route had no end-to-end test, and that is exactly how it shipped saving
// the world and THEN throwing while recording the chronicle: the rollback
// really happened, the caller was told it failed, and the history entry was
// lost. A unit test of planRollback could not have seen it, because the bug was
// in the seam between the plan and the record.

/**
 * Rollback needs its OWN world. The shared fixture has been hand-saved with
 * partial manifests by earlier tests, so most of its retained versions are not
 * playable worlds — a rollback correctly refuses them, which would make this
 * gate prove nothing about the success path.
 */
let rollbackWorldId = null;

test("B6 setup: a world with two real, playable versions", async () => {
  const g = await (await req("/v3/worlds/generate", {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ prompt: "Saltmarsh Reach, a tidal fishing village" }),
  })).json();
  assert.equal(g.ok, true, JSON.stringify(g));
  rollbackWorldId = g.world_id;

  const e = await req(`/v3/worlds/${rollbackWorldId}/expand`, {
    method: "POST", headers: json(ALICE), body: JSON.stringify({ request: "add a lighthouse district" }),
  });
  const eb = await e.json();
  assert.equal(e.status, 200, `expansion failed: ${JSON.stringify(eb)}`);

  const v = await (await req(`/v3/worlds/${rollbackWorldId}/versions`, { headers: auth(ALICE) })).json();
  assert.ok(v.versions.length >= 2, `expected two retained versions, got ${v.versions.length}`);
});

test("B6 GATE: a rollback succeeds, is recorded, and creates a NEW version", async () => {
  const versions = await (await req(`/v3/worlds/${rollbackWorldId}/versions`, { headers: auth(ALICE) })).json();
  assert.ok(versions.versions.length >= 2, `need at least two versions to roll back; have ${versions.versions.length}`);
  const target = versions.versions.at(-2).version;
  const latest = versions.versions.at(-1).version;

  const r = await req(`/v3/worlds/${rollbackWorldId}/rollback`, {
    method: "POST", headers: json(ALICE),
    body: JSON.stringify({ to_version: target, reason: "end-to-end gate" }),
  });
  const b = await r.json();
  assert.equal(r.status, 200, `rollback failed: ${JSON.stringify(b)}`);
  assert.equal(b.rolled_back_to, target);

  // A rollback goes FORWARD. Nothing is erased.
  assert.ok(b.world_version > latest, `a rollback must create a new version, got v${b.world_version} after v${latest}`);

  // The claim the caller was given must match what was actually stored — the
  // save-then-throw bug made these two disagree.
  const after = await (await req(`/v3/worlds/${rollbackWorldId}/versions`, { headers: auth(ALICE) })).json();
  assert.equal(after.versions.length, versions.versions.length + 1, "the retained history must have gained exactly one version");

  // And the chronicle must actually carry the event, with both versions.
  const mem = await (await req(`/v3/worlds/${rollbackWorldId}/memory`, { headers: auth(ALICE) })).json();
  // chronology is the event list; timeline is the same events grouped by version.
  const ev = (mem.chronology || []).find((e) => e.kind === "rolled_back");
  assert.ok(ev, `the chronicle has no rolled_back event: ${JSON.stringify((mem.chronology || []).map((e) => e.kind))}`);
  assert.equal(Number(ev.to_version), Number(target), "the event must say which version it moved to");
  assert.ok(Number(ev.from_version) > 0, "the event must say which version it moved from");

  // Honest about how far the ownership check reached. The server determines
  // live state for itself now, so this is no longer a yes/no about what the
  // CLIENT sent — it names which categories were actually established and which
  // could not be. "I could not check" must never render as "nothing is held".
  assert.ok(Array.isArray(b.live_state_checked), "the response must name what it checked");
  assert.ok(Array.isArray(b.live_state_not_checked), "and what it could not");
  assert.equal(typeof b.live_state_complete, "boolean");
  assert.equal(b.live_state_from_client, null, "no client live state was supplied here");
  // completed_quest_ids and known_npc_ids have no durable source on this estate
  // yet, so they must be reported as unchecked rather than silently empty.
  const checked = b.live_state_checked.map((x) => x.category ?? x);
  // Ownership and inventory DO have a real durable source, and a v3-created
  // world must be registered with the runtime engine for them to be readable.
  // Before that registration existed they reported UNAVAILABLE for exactly the
  // worlds people actually make, so the protection was honest but blind.
  assert.ok(checked.includes("owned_entity_ids"), `ownership must be checkable for a v3 world, got checked=${JSON.stringify(checked)}`);
  assert.ok(checked.includes("inventory_item_ids"), `inventory must be checkable for a v3 world, got checked=${JSON.stringify(checked)}`);

  const gaps = b.live_state_not_checked.map((x) => x.category ?? x);
  assert.ok(gaps.includes("completed_quest_ids"), `expected an honest gap, got ${JSON.stringify(gaps)}`);
  for (const g of b.live_state_not_checked) {
    assert.ok(g.reason && g.reason.length > 0, `every gap must say WHY: ${JSON.stringify(g)}`);
  }
  assert.equal(b.live_state_complete, false, "the guarantee is not complete while two categories have no source");
  assert.ok(b.live_state_note && b.live_state_note.length > 0);
});

test("B6 GATE: a target that no longer passes the playtest gate is refused, not shipped", async () => {
  // v1 of this world was written before the v3 manifest existed. It is a
  // legitimate rollback TARGET — the route migrates it — but it has no
  // behaviours and its spawns sit inside a structure, so today's gate rejects
  // it. The world must be left exactly as it was, and the caller must be told
  // what was wrong rather than given a world nobody can play.
  const before = await (await req(`/v3/worlds/${generatedId}/versions`, { headers: auth(ALICE) })).json();

  const r = await req(`/v3/worlds/${generatedId}/rollback`, {
    method: "POST", headers: json(ALICE), body: JSON.stringify({ to_version: 1 }),
  });
  const b = await r.json();
  assert.equal(r.status, 422, JSON.stringify(b));
  assert.equal(b.error, "rollback_failed_playtest");
  assert.ok(b.findings.length > 0, "the refusal must say what was wrong");
  assert.match(b.detail, /was not changed/);

  const after = await (await req(`/v3/worlds/${generatedId}/versions`, { headers: auth(ALICE) })).json();
  assert.equal(after.versions.length, before.versions.length, "a refused rollback must not have written a version");
});

test("B6: a rollback to a version that does not exist is a 404, not a silent no-op", async () => {
  const r = await req(`/v3/worlds/${generatedId}/rollback`, {
    method: "POST", headers: json(ALICE), body: JSON.stringify({ to_version: 999 }),
  });
  assert.equal(r.status, 404);
});

test("B6 GATE: another creator cannot roll back your world", async () => {
  const r = await req(`/v3/worlds/${generatedId}/rollback`, {
    method: "POST", headers: json(MALLORY_TESTER), body: JSON.stringify({ to_version: 1 }),
  });
  assert.equal(r.status, 403, await r.text());
});
