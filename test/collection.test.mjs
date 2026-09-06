// B15 — the durable collection behind social and safety.
//
// The services were durable across a restart but NOT across a redeploy: a
// container disk is ephemeral unless a volume is mounted, so a deploy would have
// lost friendships, reports and consent records. These tests assert the Supabase
// primary is used when configured, that the local shadow is always written, and
// that an outage degrades visibly rather than erasing anything.
//
// The second half of the file (LANE T2) covers the primary-path defects that
// test/supabase-paths.test.mjs reproduced over real HTTP. Everything here runs
// against an in-process fetch stand-in: no socket, no credential, no instance.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCollection, describeCollections } from "../src/core/collection.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dcs-coll-"));

/**
 * A minimal in-memory PostgREST stand-in.
 *
 * Models three things the real thing does and the first version of this stub did
 * not, because three defects hid in exactly those gaps:
 *   - every response is capped at `maxRows` (PostgREST's db-max-rows) and the
 *     Range header is honoured, so a caller that does not page gets a silent
 *     prefix;
 *   - a bulk insert whose objects carry different keys is a 400/PGRST102 unless
 *     `columns=` is supplied (ASSUMPTION — see the fidelity test below);
 *   - each verb can be taken down independently and brought back mid-test.
 */
function fakeSupabase({ failRead = false, failWrite = false, failDelete = false, maxRows = 1000, strictBulkKeys = true } = {}) {
  const rows = new Map();                 // key -> row
  const calls = { read: 0, upsert: 0, delete: 0 };
  const wire = [];                        // { method, url, range }
  const down = { read: failRead, write: failWrite, delete: failDelete };
  // Postgres identifies a row by its key COLUMNS, not by a string built from
  // them, so two rows differing in any column are two rows. Joining with a
  // separator (which is what collection.mjs used to do) is not injective, and a
  // stub that repeated the bug could not reproduce it — the two colliding rows
  // simply overwrote each other here and never reached the assertion.
  // With one column there is nothing to join, so the key is just the value and
  // `rows` stays indexable by it. With SEVERAL there is, and the join has to be
  // injective or the stub cannot hold the two rows the collision test needs.
  const keyOf = (r, pk) => (pk.length === 1
    ? String(r[pk[0]])
    : JSON.stringify(pk.map((k) => (r[k] === undefined || r[k] === null ? null : String(r[k])))));
  const res = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const sig = (r) => Object.keys(r).sort().join(",");
  return {
    rows, calls, wire, down,
    /**
     * Look a row up by its key COLUMNS rather than by the stub's internal key
     * encoding, so a test asserting "the primary holds this row" says exactly
     * that and does not quietly depend on how the key is spelled.
     */
    find: (want) => [...rows.values()].find((r) => Object.entries(want).every(([k, v]) => String(r[k]) === String(v))) || null,
    resetWire: () => { wire.length = 0; calls.read = 0; calls.upsert = 0; calls.delete = 0; },
    fetchImpl: async (url, opts = {}) => {
      const method = opts.method || "GET";
      const headers = opts.headers || {};
      wire.push({ method, url, range: headers.Range || null });
      const pk = (/on_conflict=([^&]+)/.exec(url) || [])[1];
      if (method === "GET") {
        calls.read++;
        if (down.read) return res(503, "down");
        const all = [...rows.values()];
        const range = headers.Range;
        let start = 0, end = maxRows - 1;
        if (range && /^\d+-\d+$/.test(range)) {
          const [a, b] = range.split("-").map(Number);
          // PostgREST answers 416 for a range that starts past the end.
          if (a > 0 && a >= all.length) return res(416, { code: "PGRST103", message: "Requested range not satisfiable" });
          start = a; end = Math.min(b, a + maxRows - 1);
        } else {
          const limit = (/[?&]limit=(\d+)/.exec(url) || [])[1];
          if (limit) end = Math.min(Number(limit) - 1, maxRows - 1);
        }
        return res(range ? 206 : 200, all.slice(start, end + 1));
      }
      if (method === "POST") {
        calls.upsert++;
        if (down.write) return res(503, "down");
        const body = JSON.parse(opts.body);
        if (strictBulkKeys && body.length > 1 && !/[?&]columns=/.test(url) && body.some((r) => sig(r) !== sig(body[0]))) {
          return res(400, { code: "PGRST102", message: "All object keys must match" });
        }
        const cols = decodeURIComponent(pk || "id").split(",");
        for (const r of body) rows.set(keyOf(r, cols), r);
        return res(201, body);
      }
      if (method === "DELETE") {
        calls.delete++;
        if (down.delete) return res(503, "down");
        const eqs = [...url.matchAll(/([a-z_]+)=eq\.([^&]+)/g)].map(([, k, v]) => [k, decodeURIComponent(v)]);
        for (const [k, r] of rows) {
          if (eqs.every(([col, val]) => String(r[col]) === val)) rows.delete(k);
        }
        return res(204, "");
      }
      return res(405, "");
    },
  };
}

const env = (on) => on ? { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" } : {};

test("with no Supabase configured, the collection is local and says so", async () => {
  const c = createCollection({ dir: tmp(), name: "t", table: "dcsgames_t", primaryKey: ["id"], env: env(false) });
  assert.equal(c.kind, "file");
  await c.insert({ id: "a", v: 1 });
  assert.equal((await c.all()).length, 1);
});

test("B15 GATE: with Supabase configured, rows reach the database", async () => {
  const sb = fakeSupabase();
  const c = createCollection({ dir: tmp(), name: "t", table: "dcsgames_t", primaryKey: ["id"], env: env(true), fetchImpl: sb.fetchImpl });
  assert.equal(c.kind, "supabase+file");
  await c.insert({ id: "a", v: 1 });
  assert.equal(sb.rows.size, 1);
  assert.deepEqual(sb.rows.get("a"), { id: "a", v: 1 });
});

test("B15 GATE: a row is ALWAYS written locally too, never only remotely", async () => {
  const dir = tmp();
  const sb = fakeSupabase();
  const c = createCollection({ dir, name: "t", table: "dcsgames_t", primaryKey: ["id"], env: env(true), fetchImpl: sb.fetchImpl });
  await c.insert({ id: "a", v: 1 });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "t.json"), "utf8"));
  assert.deepEqual(onDisk, [{ id: "a", v: 1 }]);
});

test("B15 GATE: a Supabase outage degrades visibly and loses nothing", async () => {
  const dir = tmp();
  const sb = fakeSupabase({ failWrite: true });
  const c = createCollection({ dir, name: "t", table: "dcsgames_t", primaryKey: ["id"], env: env(true), fetchImpl: sb.fetchImpl });
  await c.insert({ id: "a", v: 1 });
  assert.ok(c.degraded, "the collection must report that the primary rejected the write");
  // The row is still there, from the shadow.
  assert.equal((await c.all()).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "t.json"), "utf8")), [{ id: "a", v: 1 }]);
});

test("a read outage falls back to the shadow rather than returning empty", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "t.json"), JSON.stringify([{ id: "a", v: 1 }]));
  const sb = fakeSupabase({ failRead: true });
  const c = createCollection({ dir, name: "t", table: "dcsgames_t", primaryKey: ["id"], env: env(true), fetchImpl: sb.fetchImpl });
  const rows = await c.all();
  assert.equal(rows.length, 1, "an outage must not look like an empty collection");
  assert.ok(c.degraded);
});

test("a composite primary key upserts and deletes correctly", async () => {
  const sb = fakeSupabase();
  const c = createCollection({ dir: tmp(), name: "friends", table: "dcsgames_principal_friends", primaryKey: ["user_id", "friend_id"], env: env(true), fetchImpl: sb.fetchImpl });
  await c.insert({ user_id: "u1", friend_id: "u2", status: "requested" });
  await c.insert({ user_id: "u1", friend_id: "u3", status: "requested" });
  assert.equal(sb.rows.size, 2);

  await c.update((r) => r.user_id === "u1" && r.friend_id === "u2", (r) => ({ ...r, status: "accepted" }));
  assert.equal(sb.find({ user_id: "u1", friend_id: "u2" }).status, "accepted", "an update must reach the primary");

  await c.remove((r) => r.friend_id === "u3");
  assert.equal(sb.rows.size, 1, "a removal must delete from the primary, not just locally");
  assert.ok(sb.find({ user_id: "u1", friend_id: "u2" }), "and the row that was not removed is still there");
});

test("a removal is propagated, so a deleted row does not come back on the next read", async () => {
  const sb = fakeSupabase();
  const c = createCollection({ dir: tmp(), name: "t", table: "dcsgames_t", primaryKey: ["id"], env: env(true), fetchImpl: sb.fetchImpl });
  await c.insert({ id: "a" });
  await c.insert({ id: "b" });
  await c.remove((r) => r.id === "a");
  const rows = await c.all();
  assert.deepEqual(rows.map((r) => r.id), ["b"]);
});

test("the primary is the source of truth when both have data", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "t.json"), JSON.stringify([{ id: "stale", v: 0 }]));
  const sb = fakeSupabase();
  sb.rows.set("fresh", { id: "fresh", v: 1 });
  const c = createCollection({ dir, name: "t", table: "dcsgames_t", primaryKey: ["id"], env: env(true), fetchImpl: sb.fetchImpl });
  const rows = await c.all();
  assert.deepEqual(rows.map((r) => r.id), ["fresh"], "the database wins over a stale local shadow");
  // and the shadow is refreshed, so a later outage serves something recent
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "t.json"), "utf8")).map((r) => r.id), ["fresh"]);
});

test("describeCollections reports the backend and any degradation", async () => {
  const sb = fakeSupabase({ failWrite: true });
  const a = createCollection({ dir: tmp(), name: "a", table: "t_a", primaryKey: ["id"], env: env(true), fetchImpl: sb.fetchImpl });
  const b = createCollection({ dir: tmp(), name: "b", table: "t_b", primaryKey: ["id"], env: env(true), fetchImpl: sb.fetchImpl });
  await a.insert({ id: "x" });
  const d = describeCollections({ a, b });
  assert.equal(d.persistence, "supabase+file");
  assert.equal(d.degraded.length, 1);
  assert.equal(d.degraded[0].collection, "a");
});

test("the services report where they are actually persisting", async () => {
  const { createSocialService } = await import("../src/core/social.mjs");
  const { createSafetyService } = await import("../src/core/safety.mjs");
  const dir = tmp();
  assert.equal(createSocialService({ DCS_DATA_DIR: dir }).describe().persistence, "file");
  assert.equal(createSafetyService({ DCS_DATA_DIR: dir }).describe().persistence, "file");
  const withSupa = { DCS_DATA_DIR: dir, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" };
  assert.equal(createSocialService(withSupa).describe().persistence, "supabase+file");
  assert.equal(createSafetyService(withSupa).describe().persistence, "supabase+file");
});

// ===========================================================================
// LANE T2 — the Supabase-primary defects reproduced in supabase-paths.test.mjs
//
// Every test below fails against the code as it was before this lane. The
// scenarios are the measured ones: an outage plus a restart, a verb-selective
// outage, an empty replay, a table bigger than one page, rows of different
// shapes, and a row deleted at the primary.
// ===========================================================================

const shadow = (dir, name = "t") => JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8"));
const journal = (dir, name = "t") => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name + ".pending.json"), "utf8")); }
  catch { return null; }
};
const mk = (dir, sb, name = "t", primaryKey = ["id"]) => createCollection({
  dir, name, table: "dcsgames_t", primaryKey, env: env(true), fetchImpl: sb.fetchImpl,
});
/** The deliberate degradation logging is noise here. */
function quiet() {
  const w = console.warn, e = console.error;
  console.warn = () => {}; console.error = () => {};
  return () => { console.warn = w; console.error = e; };
}

test("T2/1: the pending marker is durable, so a RESTART mid-outage does not destroy the row", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase({ failWrite: true });
  const first = mk(dir, sb);
  await first.insert({ id: "r1", reason: "harassment" });
  assert.ok(first.degraded, "the write was rejected");
  assert.deepEqual(shadow(dir), [{ id: "r1", reason: "harassment" }], "the report is durable on disk");
  assert.ok(journal(dir), "and a durable marker says the primary has not confirmed it");

  // The process dies — redeploy, crash, health-check kill — and the primary is
  // back up by the time the new one starts.
  sb.down.write = false;
  const reborn = mk(dir, sb);
  assert.ok(reborn.degraded, "the new process reads the marker and reports itself degraded from the first second");

  const rows = await reborn.all();
  assert.deepEqual(rows, [{ id: "r1", reason: "harassment" }], "the shadow wins over the primary's empty answer");
  assert.deepEqual(shadow(dir), [{ id: "r1", reason: "harassment" }], "and the shadow was not overwritten");
  assert.equal(sb.rows.size, 1, "the row was replayed to the primary");
  assert.equal(reborn.degraded, null, "the marker clears on the round trip that confirmed it");
  assert.equal(journal(dir), null, "and the marker is gone from disk, so it is not its own failure mode");
});

test("T2/1b: once the marker clears, the primary is authoritative again", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase({ failWrite: true });
  const c = mk(dir, sb);
  await c.insert({ id: "r1" });
  sb.down.write = false;
  await c.all();                                   // replay, marker cleared
  assert.equal(journal(dir), null);

  // Someone deletes the row at the primary. With nothing pending, that deletion
  // is the truth — the shadow must not put it back.
  sb.rows.clear();
  assert.deepEqual(await c.all(), [], "the primary's answer wins");
  assert.deepEqual(shadow(dir), [], "and the shadow follows it");
});

test("T2/2: a remove() whose pre-read fails still deletes remotely, and says it is degraded", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase();
  const c = mk(dir, sb);
  await c.insert({ id: "r1", subject: "pii" });
  assert.equal(sb.rows.size, 1);

  // The primary can be written but not read: a permission change, a statement
  // timeout on a big select, a transient 5xx on one verb.
  sb.down.read = true;
  const removed = await c.remove((r) => r.id === "r1");
  assert.equal(removed, 1);
  assert.deepEqual(shadow(dir), [], "gone locally");
  assert.equal(sb.rows.size, 0, "and GONE REMOTELY: the deletion is journalled, not inferred from a read that failed");
  assert.ok(c.degraded, "the pre-read failed, so the write is not claimed to be fully reconciled");

  sb.down.read = false;
  assert.deepEqual(await c.all(), [], "the deleted row does not come back");
  assert.deepEqual(shadow(dir), [], "and is not resurrected into the shadow");
  assert.equal(c.degraded, null);
});

test("T2/2b: a deletion the primary REFUSED is journalled and re-applied on recovery", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase();
  const c = mk(dir, sb);
  await c.insert({ id: "a" });
  await c.insert({ id: "b" });

  sb.down.delete = true;
  assert.equal(await c.remove((r) => r.id === "a"), 1);
  assert.ok(c.degraded, "the deletion did not happen remotely and the collection says so");
  assert.ok(sb.rows.has("a"), "the primary still holds it");
  assert.deepEqual(journal(dir).deletes, [{ id: "a" }], "the deletion is durable, not merely attempted");

  sb.down.delete = false;
  const rows = await c.all();
  assert.deepEqual(rows.map((r) => r.id), ["b"]);
  assert.ok(!sb.rows.has("a"), "the replay applies the deletion, not just the upsert half");
  assert.equal(c.degraded, null);
  assert.deepEqual((await c.all()).map((r) => r.id), ["b"], "and the primary now agrees");
});

test("T2/3: an empty replay never clears the marker without a request that actually happened", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase({ failRead: true, failWrite: true });
  const c = mk(dir, sb);

  await c.write([]);                               // nothing to send, primary down
  assert.ok(c.degraded, "a write during an outage is degraded even when there is nothing to send");
  assert.ok(journal(dir), "and the marker is open");

  sb.resetWire();
  await c.all();                                   // the replay path, with an empty shadow
  assert.ok(sb.wire.length > 0, "a real request was made rather than an early return");
  assert.ok(c.degraded, "the primary is still down, so the marker stays");
  assert.equal(describeCollections({ t: c }).degraded.length, 1, "and /health still says so");

  sb.down.read = false; sb.down.write = false;
  await c.all();
  assert.equal(c.degraded, null, "it clears only once a round trip confirmed it");
  assert.equal(journal(dir), null);
});

test("T2/4: a collection larger than one page is read whole, not truncated", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase();                       // caps every response at 1000 rows
  for (let i = 0; i < 2500; i++) sb.rows.set("r" + i, { id: "r" + i });
  const c = mk(dir, sb);

  const rows = await c.all();
  assert.equal(rows.length, 2500, "every row, not the first page");
  assert.equal(shadow(dir).length, 2500, "and the shadow is not rewritten without the remainder");
  assert.ok(sb.wire.filter((w) => w.method === "GET").length >= 3, "which took paging, not one big limit");
  assert.ok(sb.wire.every((w) => w.method !== "GET" || w.range || /limit=1(&|$)/.test(w.url)), "each page asks for a Range");
});

test("T2/4b: a collection that is an exact multiple of the page size is not an outage", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase();
  for (let i = 0; i < 1000; i++) sb.rows.set("r" + i, { id: "r" + i });
  const c = mk(dir, sb);
  // The last full page is followed by a request that starts past the end, which
  // PostgREST answers 416. That is the end of the collection, not a failure.
  const rows = await c.all();
  assert.equal(rows.length, 1000);
  assert.equal(c.degraded, null, "a 416 at the page boundary must not degrade the collection");
  assert.equal(shadow(dir).length, 1000);
});

test("T2/5: rows with different key sets are written, not rejected as one heterogeneous array", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase();
  const c = mk(dir, sb);
  // Exactly the social.mjs shape: a profile row built without `updated_at`, and
  // another that has one because it has been edited once.
  await c.insert({ principal_id: "a", id: "a", username: "alice" });
  await c.insert({ principal_id: "b", id: "b", username: "bob", updated_at: "2026-09-06" });

  assert.equal(c.degraded, null, "no outage, no bad input, so no degradation");
  assert.equal(sb.rows.size, 2, "both rows reached the primary");
  const posts = sb.wire.filter((w) => w.method === "POST");
  assert.ok(posts.every((w) => /[?&]columns=/.test(w.url)), "every POST names the columns it is sending");

  // And it keeps working: the next write of the same mixed collection is fine.
  await c.update((r) => r.id === "a", (r) => ({ ...r, username: "alice2" }));
  assert.equal(c.degraded, null);
  assert.equal(sb.rows.get("a").username, "alice2");
});

test("T2/5b: the stand-in enforces the PGRST102 assumption this fix routes around", async () => {
  // ASSUMPTION: PostgREST answers 400/PGRST102 "All object keys must match" for
  // a bulk insert whose objects carry different keys. Unconfirmed against a real
  // instance. The fix does not depend on it — it never sends such an array — but
  // the stand-in enforces it so the test above proves something.
  const sb = fakeSupabase();
  const r = await sb.fetchImpl("https://x/rest/v1/t?on_conflict=id", {
    method: "POST", body: JSON.stringify([{ id: "a" }, { id: "b", extra: 1 }]),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, "PGRST102");
});

test("T2/6: a READ outage never replays the shadow, so a row deleted at the primary stays deleted", async (t) => {
  t.after(quiet());
  const dir = tmp();
  const sb = fakeSupabase();
  const c = mk(dir, sb);
  await c.insert({ id: "a" });
  await c.insert({ id: "b" });

  sb.rows.delete("b");                             // deleted at the primary by another writer
  sb.down.read = true;
  sb.resetWire();

  const rows = await c.all();
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"], "the outage is served from the shadow");
  assert.ok(c.degraded, "and reported");
  assert.equal(sb.calls.upsert, 0, "but a failed READ must not push the shadow back at the primary");
  assert.ok(!sb.rows.has("b"), "so the deletion stands");
  assert.equal(journal(dir), null, "a read failure is not evidence of unconfirmed local writes");

  sb.down.read = false;
  assert.deepEqual((await c.all()).map((r) => r.id), ["a"], "and the next healthy read agrees with the primary");
  assert.deepEqual(shadow(dir).map((r) => r.id), ["a"]);
});

// ===========================================================================
// LANE C — security, auth and persistence adversarial closure (sections 10/13)
//
// Three holes, each written here as the attack FIRST. Every one of them was
// reproduced against the code as it stood before this lane.
// ===========================================================================

test("LANE C/1: a PostgREST error body must not reach /health, which is unauthenticated", async (t) => {
  t.after(quiet());
  // ATTACK: make one write fail the way a real constraint violation fails.
  //
  // PostgREST answers a 4xx with a JSON body naming the CONSTRAINT, the
  // RELATION, the offending COLUMN and a hint. collection.mjs interpolated that
  // body verbatim into the AppError detail; optional() copies the detail into
  // `degraded`; describeCollections() copies `degraded` into /health; and
  // /health (server.mts:308) answers before any authentication runs.
  //
  // So an anonymous caller polling /health during an outage reads the private
  // schema: table names, column names and constraint names it has no other way
  // to learn. That is the reconnaissance step for every constraint-shaped
  // probe that follows.
  const PG = JSON.stringify({
    code: "23514",
    hint: "the internal column dcsgames_blocks.reviewer_ref must reference dcsgames_principals.id",
    message: 'new row for relation "dcsgames_blocks" violates check constraint "dcsgames_blocks_reviewer_fk"',
  });
  const fetchImpl = async (url, opts = {}) => {
    if ((opts.method || "GET") === "GET") return { ok: true, status: 200, json: async () => [], text: async () => "[]" };
    return { ok: false, status: 400, json: async () => JSON.parse(PG), text: async () => PG };
  };
  const c = createCollection({
    dir: tmp(), name: "blocks", table: "dcsgames_blocks",
    primaryKey: ["blocker_id", "blocked_id"], env: env(true), fetchImpl,
  });
  await c.insert({ blocker_id: "u1", blocked_id: "u2" });

  const health = JSON.stringify(describeCollections({ blocks: c }));
  assert.ok(c.degraded, "the failure is still reported — this test must not be satisfied by hiding it");
  assert.equal(c.kind, "supabase+file");
  assert.doesNotMatch(health, /dcsgames_blocks_reviewer_fk/, "a constraint name must not be published to anonymous callers");
  assert.doesNotMatch(health, /reviewer_ref/, "nor an internal column name");
  assert.doesNotMatch(health, /23514/, "nor the SQLSTATE");
  // What SHOULD survive: enough for an operator to know something is wrong,
  // and the correlating status code. Honesty is not what is being removed.
  assert.match(health, /dcsgames_blocks/, "the collection that is degraded is still named");
  assert.match(String(c.degraded), /400/, "and the upstream status is still reported");
});

test("LANE C/2: a deletion the caller was told succeeded must actually be applied at the primary", async (t) => {
  t.after(quiet());
  // ATTACK: two DISTINCT rows whose primary-key columns join to the same string.
  //
  // rowKey() was `primaryKey.map((k) => String(r[k])).join(" ")`, which is not
  // injective: any key value containing the separator makes two different rows
  // share one identity. write() computes the deletion set as
  //   before.filter((r) => !now.has(rowKey(r)))
  // so when a SURVIVING row happens to share the removed row's key, the removed
  // row is never journalled and never deleted remotely. The caller is told the
  // removal succeeded; the next healthy read pulls the row back from the
  // primary and rewrites the shadow with it.
  //
  // This is the block / consent-revocation / report-deletion path, which this
  // module's own header says must stay true once it is true: "I deleted it".
  const dir = tmp();
  const sb = fakeSupabase();
  const c = mk(dir, sb, "t", ["scope", "subject"]);

  await c.insert({ scope: "world-42 alice", subject: "bob", note: "row-A" });
  await c.insert({ scope: "world-42", subject: "alice bob", note: "row-B" });
  assert.equal(sb.rows.size, 2, "precondition: the primary really holds two distinct rows");

  const removed = await c.remove((r) => r.note === "row-A");
  assert.equal(removed, 1, "the caller is told one row was removed");

  assert.ok(!c.degraded, "and is told nothing went wrong");
  assert.equal(sb.rows.size, 1, "so exactly one row may survive AT THE PRIMARY");
  assert.deepEqual([...sb.rows.values()].map((r) => r.note), ["row-B"], "and it must be the one that was kept");

  // The consequence, stated as its own assertion: a row the primary still holds
  // is resurrected into the shadow by the next ordinary read.
  assert.deepEqual((await c.all()).map((r) => r.note), ["row-B"], "a deleted row must not come back");
  assert.deepEqual(shadow(dir).map((r) => r.note), ["row-B"]);
});

test("LANE C/3: update() must refuse to write a row its mutator did not return", async () => {
  // ATTACK: a mutator that falls off the end (an `if` with no `else`, an early
  // return, a forgotten `return`). update() stored the result unconditionally,
  // so `undefined` was written into the rows array, JSON.stringify turned it
  // into `null`, and the row was destroyed — while update() reported success.
  // Under Supabase that null is then upserted, so the destruction is durable.
  const c = createCollection({ dir: tmp(), name: "t", table: null, primaryKey: ["id"], env: env(false) });
  await c.insert({ id: "a", v: 1 });
  await assert.rejects(
    () => c.update((r) => r.id === "a", () => undefined),
    (e) => e.code === "server_error" || e.code === "validation_failed",
    "a mutator that returns nothing must throw, not silently destroy the row",
  );
  assert.deepEqual(await c.all(), [{ id: "a", v: 1 }], "and the row must be intact");
});

test("LANE C/4: the safe primitive does not lose a concurrent write, and is the one services must use", async () => {
  // This is the CONTRACT that safety.mjs:230 (unblock) and jobs.mjs:194 (prune)
  // bypass by doing all()-then-write() outside the lock. remove() and update()
  // take it, so a concurrent insert survives. Pinned here so the fix to those
  // two call sites has something to be checked against.
  const c = createCollection({ dir: tmp(), name: "t", table: null, primaryKey: ["id"], env: env(false) });
  await c.insert({ id: "keep" });
  await Promise.all([
    c.remove((r) => r.id === "never-present"),
    c.insert({ id: "concurrent-a" }),
    c.insert({ id: "concurrent-b" }),
    c.update((r) => r.id === "keep", (r) => ({ ...r, touched: true })),
  ]);
  const ids = (await c.all()).map((r) => r.id).sort();
  assert.deepEqual(ids, ["concurrent-a", "concurrent-b", "keep"], "no concurrent write may be erased");
});
