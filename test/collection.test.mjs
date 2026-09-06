// B15 — the durable collection behind social and safety.
//
// The services were durable across a restart but NOT across a redeploy: a
// container disk is ephemeral unless a volume is mounted, so a deploy would have
// lost friendships, reports and consent records. These tests assert the Supabase
// primary is used when configured, that the local shadow is always written, and
// that an outage degrades visibly rather than erasing anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCollection, describeCollections } from "../src/core/collection.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dcs-coll-"));

/** A minimal in-memory PostgREST stand-in. */
function fakeSupabase({ failRead = false, failWrite = false } = {}) {
  const rows = new Map();                 // key -> row
  const calls = { read: 0, upsert: 0, delete: 0 };
  const keyOf = (r, pk) => pk.map((k) => String(r[k])).join(" ");
  return {
    rows, calls,
    fetchImpl: async (url, opts = {}) => {
      const method = opts.method || "GET";
      const pk = (/on_conflict=([^&]+)/.exec(url) || [])[1];
      if (method === "GET") {
        calls.read++;
        if (failRead) return { ok: false, status: 503, text: async () => "down", json: async () => ({}) };
        return { ok: true, status: 200, json: async () => [...rows.values()] };
      }
      if (method === "POST") {
        calls.upsert++;
        if (failWrite) return { ok: false, status: 503, text: async () => "down", json: async () => ({}) };
        const body = JSON.parse(opts.body);
        const cols = decodeURIComponent(pk || "id").split(",");
        for (const r of body) rows.set(keyOf(r, cols), r);
        return { ok: true, status: 201, json: async () => body, text: async () => "" };
      }
      if (method === "DELETE") {
        calls.delete++;
        const eqs = [...url.matchAll(/([a-z_]+)=eq\.([^&]+)/g)].map(([, k, v]) => [k, decodeURIComponent(v)]);
        for (const [k, r] of rows) {
          if (eqs.every(([col, val]) => String(r[col]) === val)) rows.delete(k);
        }
        return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
      }
      return { ok: false, status: 405, json: async () => ({}), text: async () => "" };
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
  assert.equal(sb.rows.get("u1 u2").status, "accepted", "an update must reach the primary");

  await c.remove((r) => r.friend_id === "u3");
  assert.equal(sb.rows.size, 1, "a removal must delete from the primary, not just locally");
  assert.ok(sb.rows.has("u1 u2"));
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
