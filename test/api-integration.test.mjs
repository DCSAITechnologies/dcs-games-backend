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
  for (const p of ["/api/worlds/mine", "/api/me/revenue"]) {
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
test("payments stay dark: revenue is zero and flagged, never fabricated", async () => {
  const b = await (await req("/api/me/revenue", { headers: auth(ALICE) })).json();
  assert.equal(b.payments_live, false);
  assert.equal(b.total_minor, 0);
  assert.deepEqual(b.payouts, []);
  assert.equal(b.dark, true);
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
