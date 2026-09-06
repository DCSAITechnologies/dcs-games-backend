// Lane S — the code paths that only run when a database is configured.
//
// Every other test in this estate runs with SUPABASE_URL unset, so it exercises
// FileWorldStore, FileBacking and the local-HS256 branch of the principal
// resolver. The moment SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are present —
// which is the DEPLOYED configuration — a different set of objects takes over:
//
//   SupabaseWorldStore, MirroredWorldStore   (src/core/worldstore.mjs)
//   SupabaseBacking + createCollection's primary path (src/core/collection.mjs)
//   the supabase branch of createPrincipalResolver (src/core/principal.mjs)
//
// A defect that only appears with a database configured is a defect that only
// appears in production. These tests drive those objects over REAL HTTP, with
// real global fetch, against a local node:http server that speaks as much of
// PostgREST as this estate actually uses.
//
// NOTHING here contacts a real Supabase instance, and no real credential is
// used. Every URL points at 127.0.0.1 on an ephemeral port.
//
// ---------------------------------------------------------------------------
// WHAT THE STUB IMPLEMENTS
//   GET    /rest/v1/<table>?select=*|<cols>&<col>=<op>.<v>&order=<col>.<dir>
//                          &limit=<n>&offset=<n>   + Range/Range-Unit headers
//   POST   /rest/v1/<table>[?on_conflict=<cols>]   single object or array body
//                          Prefer: resolution=merge-duplicates
//                          Prefer: return=representation | return=minimal
//   DELETE /rest/v1/<table>?<col>=eq.<v>...
//   GET    /auth/v1/user                            (GoTrue, for the resolver)
//   Per-table column schemas with NOT NULL and a primary key, so a write the
//   real migration would reject is rejected here too.
//   Error shapes: 401 bad key, 404 unknown table, 409/23505 duplicate key,
//   400/23502 not-null, 400/PGRST204 unknown column in a payload,
//   400/42703 unknown column in select, 400/PGRST102 heterogeneous bulk insert,
//   400/PGRST100 unparseable filter, and injectable 5xx faults.
//   Byte accounting on every request and response, for the wire-cost measurement.
//
// WHAT THE STUB DELIBERATELY DOES NOT IMPLEMENT
//   Row Level Security. The service-role key bypasses RLS on a real project, so
//     every query here is what the service SENDS, not what a policy would allow.
//     No test in this file says anything about RLS, and RLS cannot be validated
//     without a real project. Stated plainly because on several read paths the
//     query the service sends IS the only access control there is.
//   Postgres types, casts, collation, and the updated_at trigger from migration
//     0003. Rows are stored as the JSON that arrived. A type error, a text-vs-
//     uuid mismatch or a collation difference will NOT be found here.
//   PATCH / PUT, RPC, embedded resource selects (select=a,b(c)), or=/and=,
//     in.(), full-text search, count=exact, and the schema cache reload.
//   Concurrency and transactions: the stub is single-process and serial, so it
//     cannot reproduce a lost update between two real Postgres sessions.
//
// WHERE I AM NOT CERTAIN WHAT REAL POSTGREST RETURNS — each is marked again at
// its use site, and every one is an ASSUMPTION this file makes, not a
// measurement:
//   (a) The exact JSON body of a Supabase 401 for a bad apikey.
//   (b) The 404 body for an unknown table: PGRST205 in PostgREST >= 12, a bare
//       42P01 in older builds.
//   (c) Whether a POST upsert answers 201 or 200. I answer 201.
//   (d) PGRST102 "All object keys must match" for a bulk insert whose objects
//       carry different keys. I believe this is real — the `columns=` query
//       parameter exists precisely to work around it — but it is the single
//       most consequential assumption in this file (see the PGRST102 tests) and
//       it should be confirmed against a real instance before the finding it
//       produces is acted on.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  FileWorldStore, SupabaseWorldStore, MirroredWorldStore, WorldRepository,
  createWorldRepository, manifestHash,
} from "../src/core/worldstore.mjs";
import { createCollection, describeCollections } from "../src/core/collection.mjs";
import { createPrincipalResolver } from "../src/core/principal.mjs";
import { AppError } from "../src/core/errors.mjs";

// ===========================================================================
// The stub
// ===========================================================================

/** Column schema for dcsgames_base_worlds, transcribed from migrations/0003. */
const BASE_WORLDS_COLUMNS = {
  world_id:         { notNull: true,  pk: true },
  owner_id:         { notNull: false },
  title:            { notNull: false },
  state:            { notNull: true, default: "draft" },
  version:          { notNull: true, default: 1 },
  manifest:         { notNull: true },
  manifest_hash:    { notNull: true },
  manifest_version: { notNull: false },
  created_at:       { notNull: true, default: null },   // default now()
  updated_at:       { notNull: true, default: null },   // default now()
};

const J = (o) => JSON.stringify(o);

/**
 * A local PostgREST + GoTrue stand-in.
 *
 * @param {object} opts
 * @param {string} opts.key     the service-role key the stub will accept
 * @param {object} opts.tables  name -> { columns|null, pk, rows }; columns:null
 *                              means "accept any column"
 * @param {object} opts.user    the body GET /auth/v1/user answers with
 */
async function postgrestStub({ key = "stub-service-role-key", tables = {}, user = null } = {}) {
  const state = {
    key,
    user,
    userStatus: 200,
    userBody: undefined,          // when set, the raw string /auth/v1/user returns
    tables: {},
    wire: [],                     // { method, table, url, reqBytes, resBytes, status }
    faults: [],                   // { method?, table?, path?, status, body?, times? }
    strictBulkKeys: true,         // PGRST102; see assumption (d)
  };
  for (const [name, t] of Object.entries(tables)) {
    state.tables[name] = { columns: t.columns ?? null, pk: t.pk || ["id"], rows: (t.rows || []).map((r) => ({ ...r })) };
  }

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let out;
      try { out = route(state, req, raw); }
      catch (e) { out = { status: 500, body: J({ code: "XX000", message: String(e && e.message || e) }) }; }
      const body = out.body === undefined ? "" : out.body;
      state.wire.push({
        method: req.method, url: req.url,
        table: (/^\/rest\/v1\/([^?]+)/.exec(req.url || "") || [])[1] || null,
        reqBytes: Buffer.byteLength(raw), resBytes: Buffer.byteLength(body), status: out.status,
      });
      if (out.status === 204) { res.writeHead(204, out.headers || {}); return res.end(); }
      res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", ...(out.headers || {}) });
      res.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, key, state,
    get wire() { return state.wire; },
    rows: (t) => state.tables[t].rows,
    seed: (t, rows) => { state.tables[t].rows = rows.map((r) => ({ ...r })); },
    /** Inject a fault. `times` defaults to Infinity. */
    fail: (matcher) => { state.faults.push({ times: Infinity, status: 503, ...matcher }); },
    clearFaults: () => { state.faults.length = 0; },
    resetWire: () => { state.wire.length = 0; },
    /** Bytes this stub was asked to put on the wire, optionally filtered. */
    bytes: (pred = () => true) => state.wire.filter(pred).reduce((n, w) => n + w.resBytes, 0),
    setUser: (u) => { state.user = u; state.userStatus = 200; state.userBody = undefined; },
    setUserRaw: (status, body) => { state.userStatus = status; state.userBody = body; },
    close: () => new Promise((r) => server.close(r)),
  };
}

function route(state, req, raw) {
  const [pathname, qs] = String(req.url || "").split("?");
  const q = new URLSearchParams(qs || "");
  const H = (n) => req.headers[n.toLowerCase()];

  // -- fault injection ------------------------------------------------------
  for (const f of state.faults) {
    if (f.times <= 0) continue;
    if (f.method && f.method !== req.method) continue;
    if (f.path && !pathname.startsWith(f.path)) continue;
    if (f.table && !pathname.endsWith("/" + f.table)) continue;
    f.times -= 1;
    return { status: f.status, body: f.body != null ? f.body : J({ code: "XX000", message: "stub-injected upstream failure", details: null, hint: null }) };
  }

  // -- GoTrue ---------------------------------------------------------------
  if (pathname === "/auth/v1/user") {
    // GoTrue wants the apikey header and a user bearer token. The resolver only
    // ever sends a user token here, so the stub checks apikey and presence.
    if (H("apikey") !== state.key) return { status: 401, body: J({ message: "Invalid API key" }) };
    if (state.userBody !== undefined) return { status: state.userStatus, body: state.userBody };
    if (state.userStatus !== 200) return { status: state.userStatus, body: J({ code: state.userStatus, msg: "unauthorized" }) };
    return { status: 200, body: J(state.user) };
  }

  // -- PostgREST ------------------------------------------------------------
  const m = /^\/rest\/v1\/([^/]+)$/.exec(pathname);
  if (!m) return { status: 404, body: J({ code: "PGRST002", message: "no route", details: null, hint: null }) };

  // ASSUMPTION (a): the exact body of a Supabase 401 for a bad key.
  if (H("apikey") !== state.key || H("authorization") !== "Bearer " + state.key) {
    return { status: 401, body: J({ message: "Invalid API key", hint: "Double check your Supabase API key." }) };
  }

  const name = decodeURIComponent(m[1]);
  const T = state.tables[name];
  // ASSUMPTION (b): PostgREST >= 12 answers PGRST205/404 for an unknown table.
  if (!T) return { status: 404, body: J({ code: "PGRST205", message: `Could not find the table 'public.${name}' in the schema cache`, details: null, hint: null }) };

  if (req.method === "GET")    return doSelect(state, T, name, q, H);
  if (req.method === "POST")   return doInsert(state, T, name, q, H, raw);
  if (req.method === "DELETE") return doDelete(state, T, name, q);
  return { status: 405, body: J({ code: "PGRST105", message: "method not allowed", details: null, hint: null }) };
}

const OPS = {
  eq:  (a, b) => String(a) === b,
  neq: (a, b) => String(a) !== b,
  gt:  (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt:  (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  is:  (a, b) => (b === "null" ? a === null || a === undefined : String(a) === b),
};
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function filtersOf(q) {
  const out = [];
  for (const [k, v] of q.entries()) {
    if (RESERVED.has(k)) continue;
    const dot = v.indexOf(".");
    const op = dot < 0 ? null : v.slice(0, dot);
    if (!op || !OPS[op]) return { error: { status: 400, body: J({ code: "PGRST100", message: `failed to parse filter (${v})`, details: null, hint: null }) } };
    out.push({ col: k, op, val: v.slice(dot + 1) });
  }
  return { filters: out };
}

function doSelect(state, T, name, q, H) {
  const f = filtersOf(q);
  if (f.error) return f.error;
  const sel = q.get("select") || "*";
  const cols = sel === "*" ? null : sel.split(",").map((s) => s.trim());
  if (cols && T.columns) {
    for (const c of cols) {
      if (!(c in T.columns)) {
        // PostgREST surfaces the Postgres error for a column that is not there.
        return { status: 400, body: J({ code: "42703", message: `column ${name}.${c} does not exist`, details: null, hint: null }) };
      }
    }
  }
  let rows = T.rows.filter((r) => f.filters.every((x) => OPS[x.op](r[x.col], x.val)));
  const order = q.get("order");
  if (order) {
    const [c, dir = "asc"] = order.split(".");
    rows = rows.slice().sort((a, b) => String(a[c] == null ? "" : a[c]).localeCompare(String(b[c] == null ? "" : b[c])) * (dir.startsWith("desc") ? -1 : 1));
  }
  const offset = Number(q.get("offset") || 0);
  const limit = q.has("limit") ? Number(q.get("limit")) : null;
  let ranged = false, rangeStart = offset, rangeEnd = null;
  const range = H("range");
  if (range && /^\d+-\d+$/.test(range)) {
    ranged = true;
    const parts = range.split("-").map(Number);
    rangeStart = parts[0]; rangeEnd = parts[1];
  }
  const page = rows.slice(rangeStart, rangeEnd != null ? rangeEnd + 1 : (limit != null ? rangeStart + limit : undefined));
  const projected = cols ? page.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]]))) : page;
  const body = J(projected);
  if (ranged) {
    return { status: 206, body, headers: { "Content-Range": `${rangeStart}-${rangeStart + projected.length - 1}/*` } };
  }
  return { status: 200, body };
}

function keyOf(row, pk) { return pk.map((k) => String(row[k])).join(" "); }

function doInsert(state, T, name, q, H, raw) {
  let body;
  try { body = JSON.parse(raw || "null"); }
  catch { return { status: 400, body: J({ code: "PGRST102", message: "Empty or invalid json", details: null, hint: null }) }; }
  const rows = Array.isArray(body) ? body : [body];
  if (!rows.length) return { status: 201, body: "[]" };

  // ASSUMPTION (d). PostgREST requires every object in a bulk insert to carry
  // the same keys; `?columns=` exists to opt out of exactly this. Toggleable so
  // a test can state the assumption it depends on.
  if (state.strictBulkKeys && rows.length > 1 && !q.has("columns")) {
    const k0 = Object.keys(rows[0]).slice().sort().join(",");
    for (const r of rows.slice(1)) {
      if (Object.keys(r).slice().sort().join(",") !== k0) {
        return { status: 400, body: J({ code: "PGRST102", message: "All object keys must match", details: null, hint: null }) };
      }
    }
  }

  const prefer = String(H("prefer") || "");
  const merge = /resolution=merge-duplicates/.test(prefer);
  const minimal = /return=minimal/.test(prefer);
  const onConflict = q.get("on_conflict");
  const pk = onConflict ? decodeURIComponent(onConflict).split(",") : T.pk;

  const written = [];
  for (const r of rows) {
    if (T.columns) {
      for (const c of Object.keys(r)) {
        if (!(c in T.columns)) {
          return { status: 400, body: J({ code: "PGRST204", message: `Could not find the '${c}' column of '${name}' in the schema cache`, details: null, hint: null }) };
        }
      }
      for (const [c, def] of Object.entries(T.columns)) {
        const missing = !(c in r) || r[c] === null || r[c] === undefined;
        if (def.notNull && missing && !("default" in def)) {
          return { status: 400, body: J({ code: "23502", message: `null value in column "${c}" of relation "${name}" violates not-null constraint`, details: "Failing row contains (...).", hint: null }) };
        }
      }
    }
    const k = keyOf(r, pk);
    const i = T.rows.findIndex((x) => keyOf(x, pk) === k);
    if (i >= 0) {
      if (!merge) {
        return { status: 409, body: J({ code: "23505", message: `duplicate key value violates unique constraint "${name}_pkey"`, details: `Key (${pk.join(", ")})=(${pk.map((c) => r[c]).join(", ")}) already exists.`, hint: null }) };
      }
      // ON CONFLICT DO UPDATE SET <supplied columns> = EXCLUDED.<...>:
      // a column NOT in the payload keeps whatever it already held.
      T.rows[i] = { ...T.rows[i], ...r };
      written.push(T.rows[i]);
    } else {
      const row = { ...r };
      if (T.columns) for (const [c, def] of Object.entries(T.columns)) if (!(c in row) && "default" in def) row[c] = def.default;
      T.rows.push(row);
      written.push(row);
    }
  }
  // ASSUMPTION (c): a POST answers 201.
  if (minimal) return { status: 201, body: "" };
  return { status: 201, body: J(written) };
}

function doDelete(state, T, name, q) {
  const f = filtersOf(q);
  if (f.error) return f.error;
  T.rows = T.rows.filter((r) => !f.filters.every((x) => OPS[x.op](r[x.col], x.val)));
  return { status: 204 };
}

// ===========================================================================
// Shared helpers
// ===========================================================================

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dcs-supa-"));

/** Silence the deliberate degradation logging so the test output stays readable. */
function quiet() {
  const w = console.warn, e = console.error;
  console.warn = () => {}; console.error = () => {};
  return () => { console.warn = w; console.error = e; };
}

/** Retained world versions, transcribed from migrations/0003. Note there is
 *  deliberately NO `state` column: a version recovered from the database alone
 *  therefore carries no provable state, and the repository treats that as
 *  private — the fail-closed direction. */
const WORLD_VERSIONS_COLUMNS = {
  world_id:      { notNull: true, pk: true },
  version:       { notNull: true, pk: true },
  manifest:      { notNull: true },
  manifest_hash: { notNull: true },
  label:         { notNull: false },
  created_by:    { notNull: false },
  created_at:    { notNull: true, default: null },
};

const worldsTable = (rows = []) => ({
  dcsgames_base_worlds: { columns: BASE_WORLDS_COLUMNS, pk: ["world_id"], rows },
  // The version table exists in the chain (0003), so the stub must have it too —
  // otherwise every version write 404s and the test measures the stub's gap
  // rather than the store's behaviour.
  dcsgames_world_versions: { columns: WORLD_VERSIONS_COLUMNS, pk: ["world_id", "version"], rows: [] },
});

/** A manifest big enough that the wire cost of shipping it is measurable. */
function bigManifest(n = 60) {
  return {
    manifest_version: "3.0.0",
    meta: { title: "Pirate Island", genre: "adventure", creator_id: "alice" },
    media: { cover: "https://example.invalid/cover.png" },
    zones: Array.from({ length: n }, (_, i) => ({
      id: "zone_" + i, name: "Zone " + i,
      description: "A long-form generated description ".repeat(6),
      props: Array.from({ length: 8 }, (_, j) => ({ id: `p${i}_${j}`, kind: "prop", x: i, y: j, z: 0 })),
    })),
  };
}

function mkRepo(stub, dir) {
  return createWorldRepository({
    SUPABASE_URL: stub.url,
    SUPABASE_SERVICE_ROLE_KEY: stub.key,
    DCS_DATA_DIR: dir,
  });
}

/** Bring up a stub + temp dir + repository, torn down after the test. */
async function withRepo(t, { rows = [] } = {}) {
  const stub = await postgrestStub({ tables: worldsTable(rows) });
  const dir = tmp();
  t.after(async () => { await stub.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { stub, dir, repo: mkRepo(stub, dir) };
}

// ===========================================================================
// 1. Stub fidelity — the stub is only worth what its protocol fidelity is worth
// ===========================================================================

test("stub: select=* returns every column, select=<cols> returns only those", async (t) => {
  const stub = await postgrestStub({ tables: worldsTable([{ world_id: "w1", owner_id: "alice", state: "published", version: 1, manifest: { meta: { title: "T" } }, manifest_hash: "h", title: "T", manifest_version: "3.0.0", created_at: "a", updated_at: "b" }]) });
  t.after(() => stub.close());
  const h = { apikey: stub.key, Authorization: "Bearer " + stub.key };
  const all = await (await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds?select=*`, { headers: h })).json();
  assert.equal(all.length, 1);
  assert.ok("manifest" in all[0]);
  const proj = await (await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds?select=world_id,state`, { headers: h })).json();
  assert.deepEqual(proj, [{ world_id: "w1", state: "published" }]);
});

test("stub: a bad service key is a 401, an unknown table is a 404", async (t) => {
  const stub = await postgrestStub({ tables: worldsTable() });
  t.after(() => stub.close());
  const bad = await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds?select=*`, { headers: { apikey: "wrong", Authorization: "Bearer wrong" } });
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).message, /Invalid API key/);
  const missing = await fetch(`${stub.url}/rest/v1/no_such_table?select=*`, { headers: { apikey: stub.key, Authorization: "Bearer " + stub.key } });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "PGRST205");
});

test("stub: a plain INSERT over an existing primary key is a 409/23505; merge-duplicates is not", async (t) => {
  const stub = await postgrestStub({ tables: { t: { pk: ["id"], rows: [{ id: "a", v: 1 }] } } });
  t.after(() => stub.close());
  const h = { apikey: stub.key, Authorization: "Bearer " + stub.key, "Content-Type": "application/json" };
  const dup = await fetch(`${stub.url}/rest/v1/t`, { method: "POST", headers: h, body: J({ id: "a", v: 2 }) });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).code, "23505");
  const up = await fetch(`${stub.url}/rest/v1/t?on_conflict=id`, {
    method: "POST", headers: { ...h, Prefer: "resolution=merge-duplicates,return=representation" }, body: J({ id: "a", v: 2 }),
  });
  assert.equal(up.status, 201);
  assert.equal(stub.rows("t").length, 1);
  assert.equal(stub.rows("t")[0].v, 2);
});

test("stub: a column the migration does not declare is PGRST204, a NOT NULL gap is 23502", async (t) => {
  const stub = await postgrestStub({ tables: worldsTable() });
  t.after(() => stub.close());
  const h = { apikey: stub.key, Authorization: "Bearer " + stub.key, "Content-Type": "application/json" };
  const unknown = await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds`, { method: "POST", headers: h, body: J({ world_id: "w", base: {} }) });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).code, "PGRST204");
  const nn = await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds`, { method: "POST", headers: h, body: J({ world_id: "w", owner_id: "a" }) });
  assert.equal(nn.status, 400);
  assert.equal((await nn.json()).code, "23502");
});

test("stub: filters, order, limit and Range behave the way the callers assume", async (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: String(i), owner: i % 2 ? "bob" : "alice", n: i }));
  const stub = await postgrestStub({ tables: { t: { pk: ["id"], rows } } });
  t.after(() => stub.close());
  const h = { apikey: stub.key, Authorization: "Bearer " + stub.key };
  const g = async (qs) => await (await fetch(`${stub.url}/rest/v1/t?${qs}`, { headers: h })).json();
  assert.equal((await g("select=*&owner=eq.alice")).length, 3);
  assert.equal((await g("select=*&n=gt.3")).length, 1);
  assert.equal((await g("select=*&limit=2")).length, 2);
  assert.deepEqual((await g("select=id&order=id.desc")).map((r) => r.id), ["4", "3", "2", "1", "0"]);
  const r = await fetch(`${stub.url}/rest/v1/t?select=id`, { headers: { ...h, Range: "0-1", "Range-Unit": "items" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "0-1/*");
  assert.equal((await r.json()).length, 2);
  const bad = await fetch(`${stub.url}/rest/v1/t?select=*&owner=alice`, { headers: h });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "PGRST100");
});

// ===========================================================================
// 2. SupabaseWorldStore, over the wire
// ===========================================================================

test("SupabaseWorldStore: a write that succeeds remotely round-trips losslessly", async (t) => {
  const stub = await postgrestStub({ tables: worldsTable() });
  t.after(() => stub.close());
  const s = new SupabaseWorldStore({ url: stub.url, serviceRoleKey: stub.key });
  const manifest = bigManifest(3);
  const rec = {
    world_id: "w.one", owner_id: "alice", title: "Pirate Island", state: "published", version: 1,
    manifest, manifest_hash: manifestHash(manifest), manifest_version: "3.0.0",
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
  };
  assert.deepEqual(await s.put(rec), rec);
  const back = await s.get("w.one");
  assert.deepEqual(back.manifest, manifest, "the whole manifest must survive the round trip");
  assert.equal(back.manifest_hash, rec.manifest_hash);
  // The upsert really did use on_conflict + merge-duplicates, so a retry is not a 409.
  await s.put({ ...rec, version: 2 });
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1);
  assert.equal((await s.get("w.one")).version, 2);
  assert.equal(await s.get("nope"), null);
});

test("SupabaseWorldStore: every remote failure surfaces as a retryable 502, and a read never fails open", async (t) => {
  const stub = await postgrestStub({ tables: worldsTable() });
  t.after(() => stub.close());
  const good = new SupabaseWorldStore({ url: stub.url, serviceRoleKey: stub.key });
  const wrongKey = new SupabaseWorldStore({ url: stub.url, serviceRoleKey: "not-the-key" });
  const manifest = { meta: { title: "x" } };
  const rec = { world_id: "w1", owner_id: "a", title: "x", state: "draft", version: 1, manifest, manifest_hash: manifestHash(manifest), manifest_version: null, created_at: "t", updated_at: "t" };

  // 401 from a rejected key.
  const e401 = await good.put(rec).then(() => null, (e) => e);
  assert.equal(e401, null, "sanity: the good key works");
  const bad = await wrongKey.put(rec).then(() => null, (e) => e);
  assert.ok(bad instanceof AppError);
  assert.equal(bad.httpStatus, 502);
  assert.equal(bad.code, "upstream_failure");
  assert.equal(bad.retryable, true);
  assert.match(bad.detail, /world upsert failed \(401\)/);

  // 5xx on a read: null is NOT an answer. A read that cannot be performed must
  // throw, or "your world does not exist" becomes indistinguishable from
  // "the database is down" and the caller deletes or recreates it.
  stub.fail({ method: "GET", status: 500 });
  const readErr = await good.get("w1").then((v) => ({ v }), (e) => e);
  assert.ok(readErr instanceof AppError, "a failed read must throw, not return null");
  assert.match(readErr.detail, /world read failed \(500\)/);
  const listErr = await good.list({}).then((v) => ({ v }), (e) => e);
  assert.ok(listErr instanceof AppError);
  assert.match(listErr.detail, /world list failed \(500\)/);
  stub.clearFaults();

  // and a delete that could not be performed is not silently a success.
  stub.fail({ method: "DELETE", status: 503 });
  const delErr = await good.delete("w1").then(() => null, (e) => e);
  assert.ok(delErr instanceof AppError);
  assert.match(delErr.detail, /world delete failed \(503\)/);
});

test("SupabaseWorldStore.list: filters by owner and by state on the wire, not in memory", async (t) => {
  const stub = await postgrestStub({ tables: worldsTable() });
  t.after(() => stub.close());
  const s = new SupabaseWorldStore({ url: stub.url, serviceRoleKey: stub.key });
  const mk = (id, owner, state, at) => ({ world_id: id, owner_id: owner, title: id, state, version: 1, manifest: { meta: { title: id } }, manifest_hash: "h" + id, manifest_version: null, created_at: at, updated_at: at });
  await s.put(mk("a", "alice", "published", "2026-01-01"));
  await s.put(mk("b", "alice", "draft", "2026-01-02"));
  await s.put(mk("c", "bob", "published", "2026-01-03"));

  assert.deepEqual((await s.list({ ownerId: "alice" })).map((r) => r.world_id).sort(), ["a", "b"]);
  assert.deepEqual((await s.list({ state: "published" })).map((r) => r.world_id).sort(), ["a", "c"]);
  assert.deepEqual((await s.list({ ownerId: "alice", state: "published" })).map((r) => r.world_id), ["a"]);
  assert.equal((await s.list({ limit: 1 })).length, 1);
  // updated_at.desc, and the newest is first.
  assert.equal((await s.list({}))[0].world_id, "c");
});

test("DEFECT (low, latent): SupabaseWorldStore.list interpolates `limit` into the query unencoded", async (t) => {
  // Every call site in server.mts passes an integer constant, so this is not
  // reachable today. It is one route change away from being reachable, and the
  // fix is one Number() call. Filed as hardening, not as an exploit.
  const stub = await postgrestStub({ tables: worldsTable() });
  t.after(() => stub.close());
  const s = new SupabaseWorldStore({ url: stub.url, serviceRoleKey: stub.key });
  await s.list({ limit: "1&owner_id=eq.injected" });
  const sent = stub.wire.at(-1).url;
  assert.doesNotMatch(sent, /owner_id=eq\.injected/, "caller-supplied text must not reach the query string");
  assert.match(sent, /limit=50/, "an unparseable limit falls back to the default rather than being interpolated");
  // src/core/worldstore.mjs:345 — `&limit=${limit}` should be `&limit=${Number(limit) || 50}`.
});

// ===========================================================================
// 3. MirroredWorldStore — the deployed store
// ===========================================================================

test("MirroredWorldStore: the deployed configuration is supabase+file and writes reach both", async (t) => {
  const { stub, dir, repo } = await withRepo(t);
  assert.equal(repo.kind, "supabase+file");
  const manifest = bigManifest(2);
  const saved = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest, state: "draft", title: "W1" });
  assert.equal(saved.idempotent, false);
  assert.equal(saved._mirrored, undefined, "a fully mirrored write says nothing about degradation");
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1);
  assert.deepEqual(stub.rows("dcsgames_base_worlds")[0].manifest, manifest);
  const local = JSON.parse(await fsp.readFile(path.join(dir, "worlds", "w1.json"), "utf8"));
  assert.deepEqual(local.manifest, manifest, "the shadow holds the whole manifest too");
});

test("MirroredWorldStore: a write the primary rejects is reported as _mirrored:false and stays durable locally", async (t) => {
  const restore = quiet();
  const { stub, dir, repo } = await withRepo(t);
  t.after(restore);
  stub.fail({ method: "POST", status: 503 });
  const manifest = bigManifest(2);
  const saved = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest, state: "draft", title: "W1" });

  assert.equal(saved._mirrored, false, "the caller must learn the write was degraded");
  assert.match(String(saved._mirror_error), /world upsert failed \(503\)/);
  assert.equal(stub.rows("dcsgames_base_worlds").length, 0, "nothing reached the primary");
  // ...and the row is genuinely durable locally: a fresh repository over the
  // same directory still finds it.
  const repo2 = mkRepo(stub, dir);
  const back = await repo2.get("w1", { requesterId: "alice" });
  assert.equal(back.version, 1);
  assert.deepEqual(back.manifest, manifest);
});

test("MirroredWorldStore.get prefers the shadow while degraded — so get() and list() disagree", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  const v1 = bigManifest(1);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: v1, state: "published", title: "V1" });
  assert.equal(stub.rows("dcsgames_base_worlds")[0].version, 1);

  stub.fail({ method: "POST", status: 503 });
  const v2 = bigManifest(2);
  const saved = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: v2, state: "published", title: "V2" });
  assert.equal(saved._mirrored, false);

  // get() reads the shadow: version 2.
  assert.equal((await repo.get("w1", { requesterId: "alice" })).version, 2);
  // list() reads the primary, which is still on version 1 — and the primary
  // answered successfully with a non-empty list, so the shadow is never
  // consulted. ONE repository, TWO answers for the same world.
  const listed = await repo.listOwned("alice");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].version, 2, "get() and list() must agree: the pending overlay is served by both");
  assert.equal(listed[0].title, "V2", "the pending overlay carries the newer title too");
  assert.equal(listed[0].manifest_hash, manifestHash(v2), "and the newer hash");
});

test("DEFECT (high): nothing ever re-syncs a world the primary refused — and the retry that 'succeeds' is a no-op", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  const manifest = bigManifest(2);
  stub.fail({ method: "POST", status: 503 });
  const first = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest, state: "published", title: "W" });
  assert.equal(first._mirrored, false);

  // The primary comes back.
  stub.clearFaults();
  // Reads, listings and version lookups all touch the primary...
  await repo.get("w1", { requesterId: "alice" });
  await repo.listOwned("alice");
  await repo.listPublished(10);
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1, "a read must drain the pending write to the primary");

  // The obvious client remedy — retry the same save — is answered `idempotent`
  // by a check made against the SHADOW, so the primary is never written.
  const retry = await repo.upsert({ worldId: "w1", ownerId: "alice", manifest, state: "published", title: "W" });
  assert.equal(retry._mirrored ?? true, true, "and after the drain the retry is genuinely mirrored, not merely idempotent");
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1,
    "the primary now has the world, and a further save does not duplicate it");
  // Contrast: createCollection HAS an opportunistic re-sync (collection.mjs:128).
  // MirroredWorldStore has none. Fix belongs in src/core/worldstore.mjs
  // MirroredWorldStore.put/get — replay the shadow when the primary recovers,
  // or persist a pending-mirror marker that a later write drains.
});

test("MirroredWorldStore.list falls back to the shadow when the primary read fails", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  stub.fail({ method: "GET", status: 500 });
  const cards = await repo.listPublished(10);
  assert.equal(cards.length, 1, "a primary outage degrades the listing rather than emptying it");
  assert.equal(cards[0]._summary, true);
});

test("DEFECT (medium): an EMPTY answer from the primary is treated as a failed answer", async (t) => {
  // MirroredWorldStore.list only trusts the primary when `remote.value.length`
  // is non-zero, so "the primary says there is nothing" and "the primary did
  // not answer" are the same event. A world removed from the primary therefore
  // reappears from the shadow.
  const { stub, repo } = await withRepo(t);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  stub.seed("dcsgames_base_worlds", []);                 // the primary now holds nothing
  const cards = await repo.listPublished(10);
  assert.equal(cards.length, 0, "an EMPTY answer from the primary is an answer, not a failure");
  // Fix: src/core/worldstore.mjs MirroredWorldStore.list — fall back on
  // `!remote.ok` only, never on an empty-but-successful result.
});

test("FIXED: a delete the primary refused is still a delete — tombstoned, retried, and out of discovery", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "W" });
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1);

  stub.fail({ method: "DELETE", status: 503 });
  await repo.store.delete("w1");        // resolves; the caller is told nothing

  // FIXED: a tombstone is written BEFORE either copy is touched and retried
  // until the primary converges, so no crash point resurrects the world.
  assert.equal(stub.rows("dcsgames_base_worlds").length, 1, "the primary refused, so its row is still there for now");
  // The shadow no longer has it, so get() falls through to the primary and the
  // "deleted" world is served again — content, owner and manifest intact.
  await assert.rejects(
    () => repo.get("w1", { requesterId: null }),
    (e) => e.httpStatus === 404,
    "a deleted world must not be served again from the primary",
  );
  // ...and it is still in the public catalogue.
  assert.equal((await repo.listPublished(10)).length, 0, "and must not be in the public catalogue");
  // Unlike put(), delete() has no _mirrored channel at all: MirroredWorldStore
  // .delete (src/core/worldstore.mjs) awaits optional() and returns undefined,
  // so a caller cannot distinguish a deletion from a non-deletion.
});

// ===========================================================================
// 4. The wire cost of a discovery listing
// ===========================================================================

test("WIRE COST: listPublished asks for a projection, and falls back without breaking the card contract", async (t) => {
  const { stub, repo } = await withRepo(t);
  const N = 24;                                  // /v3/discover's default page
  for (let i = 0; i < N; i++) {
    await repo.upsert({ worldId: "w" + i, ownerId: "alice", manifest: bigManifest(60), state: "published", title: "World " + i });
  }
  stub.resetWire();
  const cards = await repo.listPublished(N);
  assert.equal(cards.length, N);

  const listCalls = stub.wire.filter((w) => w.method === "GET");
  // FIXED: the listing now asks for a PROJECTION rather than select=*.
  //
  // This stub does not implement PostgREST's json arrow selector, so it answers
  // 42703 to `manifest->meta` — which is exactly the older-PostgREST / view /
  // text-column case the store's compatibility fallback exists for. So the
  // measurement here is two GETs: the projection, refused by the stub, then one
  // fallback. On a real PostgREST it is one GET and no fallback. What this
  // asserts is the property that matters and that the stub CAN observe: the
  // projection is attempted first, and the card contract survives either way.
  assert.ok(listCalls.length >= 1 && listCalls.length <= 2,
    `expected the projection and at most one compatibility fallback, got ${listCalls.length} GETs`);
  assert.match(listCalls[0].url, /select=world_id/, "the first attempt must be the narrow projection, not select=*");
  assert.match(listCalls[0].url, /manifest-%3Emeta|manifest->meta/, "and must ask for manifest.meta rather than the whole manifest");
  const actual = listCalls.at(-1).resBytes;

  // What the summary projection actually needs. FileWorldStore.summarise reads
  // nine scalar columns plus manifest.meta and manifest.media, which PostgREST
  // can project with its json arrow selector.
  const SCALARS = "world_id,owner_id,title,state,version,manifest_hash,manifest_version,created_at,updated_at";
  const projection = `${SCALARS},manifest->meta,manifest->media`;
  const h = { apikey: stub.key, Authorization: "Bearer " + stub.key };
  stub.resetWire();
  await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds?select=${SCALARS}&state=eq.published&limit=${N}&order=updated_at.desc`, { headers: h });
  const scalarsOnly = stub.wire.at(-1).resBytes;
  // The card also carries manifest.meta and manifest.media; measured from the
  // cards the repository actually returned, which is the projection's payload.
  const cardBytes = Buffer.byteLength(JSON.stringify(cards));

  console.log(`\n  WIRE COST (${N} published worlds, 60-zone manifests):`);
  console.log(`    what SupabaseWorldStore.list asks for : ${listCalls[0].url.includes("select=%2A") || listCalls[0].url.includes("select=*") ? "select=*" : "a narrow projection"}`);
  console.log(`    bytes it received                    : ${actual}  (${Math.round(actual / N)} B/world)`);
  console.log(`    the nine scalar columns alone        : ${scalarsOnly}`);
  console.log(`    the cards it then served             : ${cardBytes}  (${Math.round(cardBytes / N)} B/world)`);
  console.log(`    thrown away after being paid for     : ${actual - cardBytes}  (${(100 * (1 - cardBytes / actual)).toFixed(1)}% of the transfer)`);
  console.log(`    the projection it should ask for     : select=${projection}\n`);

  // The stub's fallback answer is still select=*, so this records what the OLD
  // behaviour cost on every discovery request — the reason the projection exists.
  assert.ok(actual > 20 * cardBytes, `select=* costs an order of magnitude more than the cards it serves (was ${actual} vs ${cardBytes})`);
  assert.ok(cards.every((c) => c._summary === true), "MirroredWorldStore.list does re-summarise, so the WASTE is purely on the wire");
  assert.ok(cards.every((c) => !("zones" in (c.manifest || {}))), "the manifest body is dropped after it has already been paid for");
});

// ===========================================================================
// 5. Ownership and permission with a primary configured
// ===========================================================================

test("ownership: with rows coming from the primary, a stranger gets 404 and never 403", async (t) => {
  const { repo } = await withRepo(t);
  await repo.upsert({ worldId: "secret", ownerId: "alice", manifest: bigManifest(1), state: "draft", title: "Secret" });
  const asStranger = await repo.get("secret", { requesterId: "mallory" }).then(() => null, (e) => e);
  assert.equal(asStranger.httpStatus, 404);
  const asNobodyForNothing = await repo.get("does-not-exist", { requesterId: "mallory" }).then(() => null, (e) => e);
  assert.equal(asNobodyForNothing.httpStatus, 404);
  assert.equal(asStranger.code, asNobodyForNothing.code);
  assert.equal(asStranger.detail.replace("secret", "X"), asNobodyForNothing.detail.replace("does-not-exist", "X"),
    "the two refusals must be byte-identical apart from the id, or the status is an existence oracle");
  assert.equal((await repo.get("secret", { requesterId: "alice" })).world_id, "secret");
});

test("ownership: a row the primary holds under another owner cannot be overwritten or claimed", async (t) => {
  const restore = quiet();
  const { stub, repo } = await withRepo(t);
  t.after(restore);
  // The row exists ONLY in the primary — as it would after a redeploy wiped the
  // container disk, or if another process wrote it.
  stub.seed("dcsgames_base_worlds", [{
    world_id: "w1", owner_id: "alice", title: "Alice's", state: "draft", version: 3,
    manifest: { meta: { title: "Alice's" } }, manifest_hash: "h", manifest_version: null,
    created_at: "t", updated_at: "t",
  }]);
  const e = await repo.upsert({ worldId: "w1", ownerId: "mallory", manifest: { meta: { title: "Mine now" } }, state: "published" }).then(() => null, (x) => x);
  assert.equal(e.httpStatus, 403);
  assert.match(e.detail, /belongs to another creator/);
  assert.equal(stub.rows("dcsgames_base_worlds")[0].owner_id, "alice");
  assert.equal(stub.rows("dcsgames_base_worlds")[0].state, "draft", "and it was not published out from under her");
  // LANE C: w1 is a DRAFT, so mallory has no way to learn it exists — requireOwner
  // now answers exactly what a world that was never created answers. A published
  // world, which she could already read, still answers 403. A plain read is 404.
  const ro = await repo.get("w1", { requesterId: "mallory", requireOwner: true }).then(() => null, (x) => x);
  assert.equal(ro.httpStatus, 404);
  const plain = await repo.get("w1", { requesterId: "mallory" }).then(() => null, (x) => x);
  assert.equal(plain.httpStatus, 404);
});

test("ownership: a primary row with a NULL owner is not free to take — for a NAMED caller", async (t) => {
  const { stub, repo } = await withRepo(t);
  // Exactly the shape a row written by another subsystem, or by a seed, has.
  // In file mode every row was written by this repository and therefore has an
  // owner; a NULL owner_id column is only reachable with a database configured.
  stub.seed("dcsgames_base_worlds", [{
    world_id: "orphan", owner_id: null, title: "Orphan", state: "draft", version: 1,
    manifest: { meta: { title: "Orphan" } }, manifest_hash: "h", manifest_version: null,
    created_at: "t", updated_at: "t",
  }]);
  const e = await repo.upsert({ worldId: "orphan", ownerId: "mallory", manifest: { meta: { title: "Mine" } }, state: "published" }).then(() => null, (x) => x);
  assert.equal(e.httpStatus, 403, "an absent owner is not permission");
  const r = await repo.get("orphan", { requesterId: "mallory" }).then(() => null, (x) => x);
  assert.equal(r.httpStatus, 404, "an unowned draft is not public");
  const ro = await repo.get("orphan", { requesterId: "mallory", requireOwner: true }).then(() => null, (x) => x);
  assert.equal(ro.httpStatus, 404, "and mallory does not satisfy requireOwner on it, nor learn the draft exists");
});

test("FIXED: a NULL-owner row belongs to nobody, so nobody may read, write or publish it", async (t) => {
  // src/core/worldstore.mjs WorldRepository. Both ownership tests compare the
  // stored owner against the requester with `!==`, and both sides are null for
  // an anonymous caller on an unowned row, so null === null lets the caller
  // through every gate. The comment above the upsert check says the fix was
  // made because "a stored row with a null owner could be overwritten — and
  // re-published — by any caller"; that is still true for the caller who
  // presents no identity at all, which is the easiest caller to be.
  //
  // The read half is reachable from live routes today: server.mts:882, :1066,
  // :1271, :1307 and :1315 all call repo.get with
  // `requesterId: principal?.id ?? null`, which is null for an anonymous
  // request. It needs a row whose owner_id is NULL — impossible in file mode,
  // where the repository writes every row itself, and entirely possible in the
  // deployed mode, where the column is nullable (migrations/0003:12), the table
  // is shared with CW5 (src/cw5/cw5_supabase_store.ts) and rows can be written
  // by a dashboard, a seed or a migration.
  const { stub, repo } = await withRepo(t);
  stub.seed("dcsgames_base_worlds", [{
    world_id: "orphan", owner_id: null, title: "Orphan", state: "draft", version: 1,
    manifest: { meta: { title: "Orphan" }, secret: "unpublished" }, manifest_hash: "h",
    manifest_version: null, created_at: "t", updated_at: "t",
  }]);

  // FIXED: ownership now needs a named owner AND a named caller who are the
  // same person. Nobody is not somebody, so an unowned row matches nobody.
  await assert.rejects(
    () => repo.get("orphan", { requesterId: null }),
    (e) => e.httpStatus === 404,
    "an anonymous caller must not read an unpublished draft, nor learn it exists",
  );
  await assert.rejects(
    () => repo.get("orphan", { requesterId: null, requireOwner: true }),
    (e) => e.httpStatus === 404,
    "and must not satisfy requireOwner on it, nor learn the unowned draft exists",
  );
  await assert.rejects(
    () => repo.upsert({ worldId: "orphan", manifest: { meta: { title: "Mine" } }, state: "published" }),
    (e) => e.httpStatus === 403,
    "an upsert with no ownerId must not overwrite the row, let alone publish it",
  );
  assert.equal(stub.rows("dcsgames_base_worlds")[0].state, "draft", "the row is untouched on the primary");
  assert.equal(stub.rows("dcsgames_base_worlds")[0].manifest.secret, "unpublished");

  // A NAMED caller is still refused too — an unowned row belongs to nobody, so
  // it is not claimable by whoever asks first.
  await assert.rejects(
    () => repo.upsert({ worldId: "orphan", ownerId: "opportunist", manifest: { meta: { title: "Mine" } } }),
    (e) => e.httpStatus === 403,
  );
});

test("ownership: the listPublished projection carries no draft and no manifest body", async (t) => {
  const { repo } = await withRepo(t);
  await repo.upsert({ worldId: "pub", ownerId: "alice", manifest: bigManifest(3), state: "published", title: "Pub" });
  await repo.upsert({ worldId: "draft", ownerId: "alice", manifest: bigManifest(3), state: "draft", title: "Draft" });
  const cards = await repo.listPublished(50);
  assert.deepEqual(cards.map((c) => c.world_id), ["pub"]);
  assert.equal(cards[0]._summary, true);
  assert.deepEqual(Object.keys(cards[0].manifest).sort(), ["media", "meta"]);
  // listOwned is the owner's own view, so it DOES carry the full record.
  const owned = await repo.listOwned("alice", 50);
  assert.equal(owned.length, 2);
  assert.ok(owned.every((w) => w.owner_id === "alice"));
});

test("DEFECT (medium, defence in depth): the repository re-filters nothing the primary returns", async (t) => {
  // The stub is deliberately made to answer an owner-filtered query with a
  // foreign row. That is not a thing PostgREST does on its own — it is what a
  // dropped filter, a mis-set RLS policy, a view with a different definition or
  // a future `or=` refactor looks like from this side. The point of the test is
  // that NOTHING between the wire and the caller notices.
  const stub = await postgrestStub({ tables: worldsTable() });
  const dir = tmp();
  t.after(async () => { await stub.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const repo = mkRepo(stub, dir);
  await repo.upsert({ worldId: "alice-w", ownerId: "alice", manifest: { meta: { title: "A" } }, state: "draft", title: "A" });
  stub.seed("dcsgames_base_worlds", [
    { world_id: "alice-w", owner_id: "alice", title: "A", state: "draft", version: 1, manifest: { meta: { title: "A" } }, manifest_hash: "h", manifest_version: null, created_at: "t", updated_at: "t" },
    // a row that does NOT match owner_id=eq.alice, but which the primary hands back anyway
    { world_id: "bob-private", owner_id: "bob", title: "Bob's private draft", state: "draft", version: 1, manifest: { meta: { title: "B" }, secret: "bob's unpublished work" }, manifest_hash: "h2", manifest_version: null, created_at: "t", updated_at: "t" },
  ]);
  const leaked = await repo.listOwned("alice", 50);
  assert.equal(leaked.length, 1, "the stub applies the filter faithfully, so nothing leaks here");
  // Now prove the absence of the second check directly: MirroredWorldStore.list
  // returns the primary's rows unmodified.
  const mirrored = new MirroredWorldStore(
    { kind: "supabase", list: async () => [{ world_id: "bob-private", owner_id: "bob", state: "draft", updated_at: "t", manifest: { secret: 1 } }] },
    new FileWorldStore(path.join(dir, "worlds")),
  );
  const rows = await mirrored.list({ ownerId: "alice" });
  assert.deepEqual(rows.map((r) => r.owner_id), [],
    "a row the primary returned that does not match the filter must be dropped on this side too");
  // Fix: src/core/worldstore.mjs MirroredWorldStore.list — re-apply
  // `ownerId`/`state` to the primary's rows before returning them, exactly as
  // FileWorldStore.list already does on the shadow path.
});

test("DEFECT (critical): the query behind GET /api/public/worlds returns every draft, with its manifest, to anyone", async (t) => {
  // server.mts:347 — `supaGet("dcsgames_base_worlds?select=*&limit=50")` on an
  // UNAUTHENTICATED route (the principal is resolved at line 344 but never
  // required here). No state filter, no owner filter, whole manifests.
  const { stub, repo } = await withRepo(t);
  await repo.upsert({ worldId: "alice-draft", ownerId: "alice", manifest: bigManifest(2), state: "draft", title: "Unreleased" });
  await repo.upsert({ worldId: "bob-pub", ownerId: "bob", manifest: bigManifest(2), state: "published", title: "Public" });

  const h = { apikey: stub.key, Authorization: "Bearer " + stub.key };
  const rows = await (await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds?select=*&limit=50`, { headers: h })).json();
  const ids = rows.map((r) => r.world_id).sort();
  assert.deepEqual(ids, ["alice-draft", "bob-pub"],
    "DEFECT: the public route's own query returns unpublished worlds belonging to other people");
  const draft = rows.find((r) => r.world_id === "alice-draft");
  assert.ok(draft.manifest.zones.length > 0, "and the full unreleased manifest with it");

  // The repository's own published listing, for contrast, does the right thing.
  assert.deepEqual((await repo.listPublished(50)).map((c) => c.world_id), ["bob-pub"]);
  // Fix: server.mts:347 — add `&state=eq.published` and the summary projection,
  // or route the handler through repo.listPublished() like /v3/discover does.
});

test("DEFECT (high): supaGet turns every upstream failure into an empty 200", async (t) => {
  // server.mts:251-258. `if (!r.ok) return []` and `catch { return [] }`, and
  // the handlers then answer `{ ok: true, count: 0, source: "supabase" }`. A
  // rejected key, a dropped table and a genuinely empty catalogue are one
  // answer. This contradicts src/core/errors.mjs' stated rule that a failure
  // can never be reported as ok:true.
  const stub = await postgrestStub({ tables: worldsTable() });
  t.after(() => stub.close());
  const supaGet = async (pathq, key) => {          // verbatim from server.mts
    try {
      const r = await fetch(stub.url + "/rest/v1/" + pathq, { headers: { apikey: key, Authorization: "Bearer " + key } });
      if (!r.ok) return [];
      return await r.json();
    } catch { return []; }
  };
  assert.deepEqual(await supaGet("dcsgames_base_worlds?select=*&limit=50", "wrong-key"), [],
    "a 401 is indistinguishable from an empty catalogue");
  assert.deepEqual(await supaGet("dcsgames_nonexistent?select=*", stub.key), [],
    "so is a missing table");
  stub.fail({ method: "GET", status: 500 });
  assert.deepEqual(await supaGet("dcsgames_base_worlds?select=*&limit=50", stub.key), [],
    "so is a 500");
});

// ===========================================================================
// 6. Version history: declared in the database, written only to disk
// ===========================================================================

test("DEFECT (high): with Supabase configured, version history never reaches the database", async (t) => {
  const { stub, dir, repo } = await withRepo(t);
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(1), state: "published", title: "v1" });
  await repo.upsert({ worldId: "w1", ownerId: "alice", manifest: bigManifest(2), state: "published", title: "v2" });

  const versions = await repo.listVersions("w1", { requesterId: "alice" });
  assert.deepEqual(versions.map((v) => v.version), [1, 2], "history exists...");
  assert.ok(stub.wire.filter((w) => w.table === "dcsgames_world_versions").length > 0,
    "retained versions must actually reach dcsgames_world_versions");
  assert.ok(fs.existsSync(path.join(dir, "world-versions", "w1@1.json")), "it lives only on the container disk");

  // What that means operationally: a redeploy that keeps the database and loses
  // the disk keeps every world and loses every rollback target.
  await fsp.rm(path.join(dir, "world-versions"), { recursive: true, force: true });
  const repo2 = mkRepo(stub, dir);
  assert.equal((await repo2.get("w1", { requesterId: "alice" })).version, 2, "the world survives");
  assert.ok((await repo2.listVersions("w1", { requesterId: "alice" })).length > 0, "and the history survives with it, from the database");
  // A version recovered from the DATABASE alone carries no provable state —
  // migration 0003 declares no `state` column — so it is owner-only, which is
  // the fail-closed direction. The owner can still reach it, which is what
  // rollback needs.
  const recovered = await repo2.getVersion("w1", 1, { requesterId: "alice" });
  assert.equal(recovered.version, 1, "B6 rollback still has a target after the disk is lost");
  // Fix: createWorldRepository (src/core/worldstore.mjs) always builds a
  // file-only VersionHistoryStore. Migration 0003 declares
  // dcsgames_world_versions (world_id, version) precisely for this; it needs a
  // Supabase/mirrored backing when url+key are present.
});

// ===========================================================================
// 7. createCollection — the Supabase-primary path
// ===========================================================================

function mkColl(stub, dir, { name = "reports", table = "dcsgames_reports", primaryKey = ["id"] } = {}) {
  return createCollection({
    dir, name, table, primaryKey,
    env: { SUPABASE_URL: stub.url, SUPABASE_SERVICE_ROLE_KEY: stub.key },
  });
}

async function withColl(t, opts = {}) {
  const stub = await postgrestStub({ tables: { dcsgames_reports: { pk: opts.primaryKey || ["id"], columns: null, rows: [] } } });
  const dir = tmp();
  t.after(async () => { await stub.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return { stub, dir, coll: mkColl(stub, dir, opts) };
}

const shadowOf = async (dir, name = "reports") => JSON.parse(await fsp.readFile(path.join(dir, name + ".json"), "utf8"));

test("createCollection: with a primary configured, a row lands in both backings", async (t) => {
  const { stub, dir, coll } = await withColl(t);
  assert.equal(coll.kind, "supabase+file");
  await coll.insert({ id: "r1", reason: "spam" });
  assert.deepEqual(stub.rows("dcsgames_reports"), [{ id: "r1", reason: "spam" }]);
  assert.deepEqual(await shadowOf(dir), [{ id: "r1", reason: "spam" }]);
  assert.equal(coll.degraded, null);
  assert.deepEqual(describeCollections({ reports: coll }), { persistence: "supabase+file", degraded: null });
});

test("createCollection: a rejected write degrades visibly, keeps the row locally, and re-syncs on recovery", async (t) => {
  const restore = quiet();
  const { stub, dir, coll } = await withColl(t);
  t.after(restore);
  stub.fail({ method: "POST", status: 503 });
  await coll.insert({ id: "r1", reason: "spam" });

  assert.ok(coll.degraded, "the collection says it is degraded");
  assert.equal(stub.rows("dcsgames_reports").length, 0);
  assert.deepEqual(await shadowOf(dir), [{ id: "r1", reason: "spam" }], "the row is durable locally");
  assert.deepEqual(describeCollections({ reports: coll }).degraded, [{ collection: "reports", error: coll.degraded }]);

  // While degraded the SHADOW is authoritative: a read must not let the
  // primary's older answer destroy the row.
  stub.seed("dcsgames_reports", [{ id: "other", reason: "from the primary" }]);
  stub.clearFaults();
  const rows = await coll.all();
  assert.deepEqual(rows.map((r) => r.id), ["r1"], "the degraded read serves the shadow");
  assert.equal(coll.degraded, null, "and the primary recovered, so the flag clears");
  assert.deepEqual(stub.rows("dcsgames_reports").map((r) => r.id).sort(), ["other", "r1"], "the shadow was replayed");
});

test("FIXED: the outage marker is durable, so a restart cannot destroy the row it protects", async (t) => {
  const restore = quiet();
  const { stub, dir, coll } = await withColl(t);
  t.after(restore);
  stub.fail({ method: "POST", status: 503 });
  await coll.insert({ id: "r1", reason: "harassment" });
  assert.ok(coll.degraded);
  assert.deepEqual(await shadowOf(dir), [{ id: "r1", reason: "harassment" }]);
  stub.clearFaults();

  // The process restarts — a redeploy, a crash, a Railway health-check kill.
  // The new process has never seen a failure, so `degraded` is null, so all()
  // reads the primary and writes its answer over the shadow.
  // FIXED: the marker is a durable journal written next to the shadow BEFORE the
  // primary is contacted, so a reborn process is degraded from its first second
  // rather than discovering it at the moment all() destroys the row.
  const reborn = mkColl(stub, dir);
  assert.ok(reborn.degraded, "a new process must inherit the outage, not forget it");
  assert.match(String(reborn.degraded), /unconfirmed|replay/i);
  const rows = await reborn.all();
  assert.deepEqual(rows, [{ id: "r1", reason: "harassment" }],
    "the row the journal is protecting must survive the restart");
  assert.deepEqual(await shadowOf(dir), [{ id: "r1", reason: "harassment" }],
    "and must still be on disk — a restart must not overwrite what the journal protects");
  // Fix: src/core/collection.mjs — the degraded marker must be durable next to
  // the shadow (a `<name>.pending.json` written before the primary is
  // attempted and cleared only on a confirmed round trip), or all() must
  // reconcile rather than overwrite (union by primary key, newest wins).
});

test("FIXED: a remove() whose pre-read fails still deletes remotely, and says it was only partly reconciled", async (t) => {
  const restore = quiet();
  const { stub, dir, coll } = await withColl(t);
  t.after(restore);
  await coll.insert({ id: "r1", subject: "pii" });
  assert.equal(stub.rows("dcsgames_reports").length, 1);

  // The primary can be written but not read — a permission change on the table,
  // a statement timeout on a big select, a transient 5xx on one verb.
  stub.fail({ method: "GET", status: 500 });
  const removed = await coll.remove((r) => r.id === "r1");
  assert.equal(removed, 1, "the caller is told one row was removed");
  assert.deepEqual(await shadowOf(dir), [], "locally it is gone");
// FIXED: deletions are computed from the pre-write shadow and JOURNALLED, so
  // the DELETE is issued even when the pre-read is down. It used to be computed
  // from `remote.read().catch(() => [])`, so a failed GET meant no deletion was
  // ever sent — while the caller was told the row was removed.
  assert.equal(stub.rows("dcsgames_reports").length, 0,
    "the deletion must actually reach the primary, not only the shadow");
  assert.ok(coll.degraded, "and a partly-reconciled write must say so");
  assert.deepEqual((await coll.all()).map((r) => r.id), [], "the deleted row must not come back");
  assert.deepEqual((await shadowOf(dir)).map((r) => r.id), [], "and must not be rewritten to disk");
  // Fix: src/core/collection.mjs:151 — `remote.read().catch(() => [])` must not
  // swallow. If the pre-read fails the whole write is degraded, because the
  // deletion half of it provably did not happen.
});

test("FIXED: degraded is only cleared by a request that actually happened", async (t) => {
  const restore = quiet();
  const { stub, coll } = await withColl(t);
  t.after(restore);
  stub.fail({ status: 503 });                      // everything fails
  await coll.all();                                // read fails -> degraded
  assert.ok(coll.degraded);

  stub.resetWire();
  const rows = await coll.all();                   // degraded path, local is []
  assert.deepEqual(rows, []);
// FIXED: a sync that put ZERO requests on the wire must earn its clearance with
  // a real ping. Nothing is cleared on the strength of a request that never
  // happened — which is what "upsert([]) returns early" used to do.
  assert.ok(stub.wire.length > 0, "clearing degraded must involve actually contacting the primary");
  assert.ok(coll.degraded, "the primary is still down, so the collection is still degraded");
  assert.ok(describeCollections({ reports: coll }).degraded, "and /health must still say so");
  // Fix: src/core/collection.mjs:128 — only clear `degraded` on a round trip
  // that actually occurred (probe with a cheap read when there is nothing to
  // replay), or make SupabaseBacking.upsert([]) a no-op that reports "not run".
});

test("DIVERGENCE: a duplicate row survives locally and is silently collapsed by the primary's upsert", async (t) => {
  // createCollection.insert() appends without consulting the primary key, so
  // two identical inserts produce two local rows. The primary's
  // `on_conflict=<pk>` + merge-duplicates collapses them to one. The two
  // backings then hold different data, and which one you get depends on
  // whether SUPABASE_URL happens to be set.
  const localDir = tmp();
  const localOnly = createCollection({ dir: localDir, name: "reports", table: "dcsgames_reports", primaryKey: ["id"], env: {} });
  const { stub, dir, coll } = await withColl(t);
  t.after(async () => { await fsp.rm(localDir, { recursive: true, force: true }); });

  const row = () => ({ id: "dup", reason: "spam" });
  await localOnly.insert(row());
  await localOnly.insert(row());
  assert.equal((await localOnly.all()).length, 2, "file-backed: two rows, for ever");

  await coll.insert(row());
  await coll.insert(row());
  assert.equal((await shadowOf(dir)).length, 2, "the shadow was written with two rows...");
  assert.equal(stub.rows("dcsgames_reports").length, 1, "...but the primary collapsed them to one");
  assert.equal((await coll.all()).length, 1, "DIVERGENCE: the same code answers 2 locally and 1 with a primary");
  assert.equal((await shadowOf(dir)).length, 1, "and the primary's answer then overwrites the shadow");
  // This matters wherever a count is a rule: party/org/studio capacity, the
  // one-rating-per-player invariant, a report count that triggers moderation.
  // Fix: src/core/collection.mjs — insert() should reject or merge a row whose
  // primaryKey already exists, so both backings agree by construction.
});

test("DIVERGENCE (high): merge-duplicates keeps a column the caller removed, and the next read restores it", async (t) => {
  // PostgREST's ON CONFLICT DO UPDATE only touches the columns present in the
  // payload. A row rewritten WITHOUT a field keeps the old value remotely,
  // while the shadow drops it — so clearing a field is a local-only edit that
  // the next successful read undoes.
  const { stub, dir, coll } = await withColl(t);
  await coll.insert({ id: "r1", reason: "spam", reporter_note: "contains a home address" });
  assert.equal(stub.rows("dcsgames_reports")[0].reporter_note, "contains a home address");

  await coll.update((r) => r.id === "r1", (r) => ({ id: r.id, reason: r.reason }));   // redact
  assert.deepEqual(await shadowOf(dir), [{ id: "r1", reason: "spam" }], "redacted locally");
  assert.equal(stub.rows("dcsgames_reports")[0].reporter_note, "contains a home address",
    "DEFECT: the primary kept the field the caller removed");
  const back = await coll.all();
  assert.equal(back[0].reporter_note, "contains a home address", "DEFECT: and the next read brings it back");
  assert.equal((await shadowOf(dir))[0].reporter_note, "contains a home address", "into the shadow too");
  // Fix: src/core/collection.mjs SupabaseBacking.upsert — normalise every row to
  // the collection's full column set (missing keys explicitly null) before
  // POSTing, or DELETE-then-INSERT the changed rows. The same fix closes the
  // PGRST102 defect below.
});

test("DEFECT (high, assumption-dependent): a collection whose rows have different keys cannot be written at all", async (t) => {
  // ASSUMPTION (d). PostgREST rejects a bulk insert whose objects do not all
  // carry the same keys (PGRST102 "All object keys must match"); `?columns=`
  // exists to opt out, and createCollection does not send it.
  //
  // createCollection.write() POSTs the WHOLE collection as one array, and rows
  // in these collections legitimately diverge in shape. Concretely:
  // src/core/social.mjs:326 `principals.ensure()` builds a row with no
  // `updated_at`; src/core/social.mjs:434 `updateProfile` writes
  // `{...p, ...changes, updated_at}` into ONE row. From the first profile edit
  // onwards the `principals` array is heterogeneous, and every subsequent write
  // to that collection 400s.
  const restore = quiet();
  const { stub, dir, coll } = await withColl(t);
  t.after(restore);
  await coll.insert({ principal_id: "a", id: "a", username: "alice" });
  assert.equal(stub.rows("dcsgames_reports").length, 1);

  await coll.insert({ principal_id: "b", id: "b", username: "bob", updated_at: "2026-09-06" });
  assert.equal(coll.degraded, null, "grouping by key-set keeps a heterogeneous array off the wire entirely");
  assert.equal(stub.rows("dcsgames_reports").length, 2, "both rows reach the primary");

  // And it does not recover on its own: the resync replays the same
  // heterogeneous array and is rejected the same way, for ever.
  const rows = await coll.all();
  assert.equal(rows.length, 2);
  assert.equal(coll.degraded, null, "and the collection is not left permanently degraded by its own shape");
  // Fix: src/core/collection.mjs SupabaseBacking.upsert — send
  // `&columns=<union of keys>` and normalise each row to that set.
});

test("FIXED: a collection larger than one page is paged, not silently truncated", async (t) => {
  const { stub, dir, coll } = await withColl(t);
  stub.seed("dcsgames_reports", Array.from({ length: 10001 }, (_, i) => ({ id: "r" + i })));
  const rows = await coll.all();
  // FIXED: read() pages with Range/Range-Unit rather than stopping at the
  // server's default cap, so a large collection is not silently truncated —
  // and, more to the point, the shadow is no longer rewritten without the
  // rows that were never fetched.
  assert.equal(rows.length, 10001, "every row must be returned, not the first page");
  assert.equal((await shadowOf(dir)).length, 10001, "and the shadow must keep all of them");
  assert.equal(stub.rows("dcsgames_reports").length, 10001, "the primary still has it, so this is recoverable — but silent");
  // Fix: src/core/collection.mjs:62 — paginate with Range like
  // cw5_supabase_store.getDeltas already does, or at minimum detect a full page
  // and refuse to treat it as the whole collection.
});

test("createCollection: a read outage falls back to the shadow rather than erasing it", async (t) => {
  const restore = quiet();
  const { stub, dir, coll } = await withColl(t);
  t.after(restore);
  await coll.insert({ id: "r1", reason: "spam" });
  stub.fail({ method: "GET", status: 503 });
  const rows = await coll.all();
  assert.deepEqual(rows, [{ id: "r1", reason: "spam" }]);
  assert.ok(coll.degraded);
  assert.deepEqual(await shadowOf(dir), [{ id: "r1", reason: "spam" }], "and the shadow was not clobbered");
});

test("createCollection: a composite primary key round-trips through on_conflict and DELETE filters", async (t) => {
  const stub = await postgrestStub({ tables: { dcsgames_reports: { pk: ["blocker_id", "blocked_id"], columns: null, rows: [] } } });
  const dir = tmp();
  t.after(async () => { await stub.close(); await fsp.rm(dir, { recursive: true, force: true }); });
  const coll = mkColl(stub, dir, { primaryKey: ["blocker_id", "blocked_id"] });
  await coll.insert({ blocker_id: "alice", blocked_id: "mallory", at: "t1" });
  await coll.insert({ blocker_id: "alice", blocked_id: "eve", at: "t2" });
  assert.equal(stub.rows("dcsgames_reports").length, 2);
  const post = stub.wire.find((w) => w.method === "POST");
  assert.match(post.url, /on_conflict=blocker_id%2Cblocked_id/, "the composite key is sent url-encoded");

  await coll.remove((r) => r.blocked_id === "eve");
  assert.deepEqual(stub.rows("dcsgames_reports").map((r) => r.blocked_id), ["mallory"]);
  const del = stub.wire.find((w) => w.method === "DELETE");
  assert.match(del.url, /blocker_id=eq\.alice&blocked_id=eq\.eve/, "both key columns are in the delete filter");
});

// ===========================================================================
// 8. The auth branch
// ===========================================================================

function mkAuth(stub, extra = {}) {
  return createPrincipalResolver({
    supabaseUrl: stub.url, supabaseKey: stub.key,
    localSecret: "unused-in-supabase-mode", internalTesters: "", ...extra,
  });
}

test("auth: a token Supabase accepts becomes a principal, and nothing else does", async (t) => {
  const stub = await postgrestStub({ user: { id: "user-uuid-1", email: "alice@example.invalid" } });
  t.after(() => stub.close());
  const auth = mkAuth(stub);
  assert.equal(auth.mode, "supabase-jwt");
  assert.equal(auth.hasSupabase, true);

  const p = await auth.resolve({ authorization: "Bearer real-token" });
  assert.equal(p.id, "user-uuid-1");
  assert.equal(p.source, "supabase");
  assert.equal(p.email, "alice@example.invalid");
  assert.equal(p.isInternalTester, false);

  // No credential at all is anonymous, and costs no request.
  stub.resetWire();
  assert.equal(await auth.resolve({}), null);
  assert.equal(stub.wire.length, 0);
});

test("auth: an unreachable Supabase fails CLOSED — 502, never a guessed principal", async (t) => {
  const stub = await postgrestStub({ user: { id: "u1" } });
  const url = stub.url;
  await stub.close();                                  // nothing is listening now
  const auth = createPrincipalResolver({ supabaseUrl: url, supabaseKey: "k", localSecret: "s", internalTesters: "" });
  const e = await auth.resolve({ authorization: "Bearer anything" }).then((v) => ({ v }), (x) => x);
  assert.ok(e instanceof AppError, "an unverifiable credential must throw");
  assert.equal(e.httpStatus, 502);
  assert.equal(e.code, "upstream_failure");
  assert.equal(e.retryable, true);
  // and require() cannot be talked into an anonymous pass either.
  const e2 = await auth.require({ authorization: "Bearer anything" }).then((v) => ({ v }), (x) => x);
  assert.ok(e2 instanceof AppError);
  assert.equal(e2.httpStatus, 502);
});

test("auth: a 401 from Supabase is a 401 here, and carries the upstream status", async (t) => {
  const stub = await postgrestStub({ user: null });
  t.after(() => stub.close());
  stub.setUserRaw(401, J({ code: 401, msg: "invalid claim: missing sub claim" }));
  const auth = mkAuth(stub);
  const e = await auth.resolve({ authorization: "Bearer forged" }).then((v) => ({ v }), (x) => x);
  assert.ok(e instanceof AppError);
  assert.equal(e.httpStatus, 401);
  assert.equal(e.code, "invalid_token");
  assert.deepEqual(e.meta, { upstream_status: 401 });
});

test("auth: a malformed or subject-less user body never becomes a principal", async (t) => {
  const stub = await postgrestStub({ user: null });
  t.after(() => stub.close());
  const auth = mkAuth(stub);
  const reject = async (label) => {
    const e = await auth.resolve({ authorization: "Bearer t-" + label }).then((v) => ({ v }), (x) => x);
    assert.ok(e instanceof AppError, `${label}: expected a refusal, got ${JSON.stringify(e)}`);
    assert.equal(e.httpStatus, 401, label);
    return e;
  };
  stub.setUserRaw(200, "this is not json");                    await reject("not-json");
  stub.setUserRaw(200, "null");                                await reject("null-body");
  stub.setUserRaw(200, J({}));                                 await reject("no-id");
  stub.setUserRaw(200, J({ id: "" }));                         await reject("empty-id");
  stub.setUserRaw(200, J({ id: null, email: "a@b.c" }));       await reject("null-id");
  stub.setUserRaw(200, J([{ id: "array-not-object" }]));       await reject("array-body");
  stub.setUserRaw(200, "");                                    await reject("empty-body");
});

test("auth: x-user-id is still refused in supabase mode, and never reaches the wire", async (t) => {
  const stub = await postgrestStub({ user: { id: "victim-uuid" } });
  t.after(() => stub.close());
  const auth = mkAuth(stub);
  stub.resetWire();
  const e = await auth.resolve({ "x-user-id": "victim-uuid" }).then((v) => ({ v }), (x) => x);
  assert.ok(e instanceof AppError);
  assert.equal(e.httpStatus, 401);
  assert.match(e.detail, /x-user-id is not an authentication mechanism/);
  assert.equal(stub.wire.length, 0, "the header is refused before any verification is attempted");
  // and with a bad token present, the header does not rescue it.
  stub.setUserRaw(401, J({ msg: "bad" }));
  const e2 = await auth.resolve({ authorization: "Bearer nope", "x-user-id": "victim-uuid" }).then((v) => ({ v }), (x) => x);
  assert.equal(e2.httpStatus, 401);
  assert.equal(e2.code, "invalid_token");
});

test("FIXED: a 5xx from Supabase Auth is an outage, not a verdict on the token", async (t) => {
  // The unreachable case is a retryable 502; a 500 RESPONSE from the same
  // service is a non-retryable 401 invalid_token. A client that logs the user
  // out on a 401 — which is the correct client behaviour — will sign everybody
  // out during a GoTrue incident.
  const stub = await postgrestStub({ user: { id: "u1" } });
  t.after(() => stub.close());
  const auth = mkAuth(stub);
  for (const status of [500, 502, 503, 429]) {
    stub.setUserRaw(status, J({ msg: "upstream" }));
    auth._clearCache();
    const e = await auth.resolve({ authorization: "Bearer good-token" }).then((v) => ({ v }), (x) => x);
    // FIXED: an outage is an outage. A 5xx or a 429 from GoTrue says nothing
    // about the token, and reporting it as invalid_token signs every correct
    // client out during an incident.
    assert.ok(e instanceof AppError);
    assert.notEqual(e.code, "invalid_token", `a ${status} must not be reported as a bad token`);
    assert.ok(e.httpStatus >= 500, `a ${status} must surface as an upstream failure, got ${e.httpStatus}`);
  }
  // Fix: src/core/principal.mjs:193 — branch on r.status. 401/403 is
  // invalid_token; anything >= 500 or 429 is Errors.upstream (retryable 502),
  // matching the unreachable branch four lines above it.
});

test("FIXED: a self-asserted Supabase role does not grant privilege", async (t) => {
  // GET /auth/v1/user returns user_metadata, which the user themself can set
  // (GoTrue's PUT /auth/v1/user updates raw_user_meta_data). principal.mjs
  // spreads it into `claims` and decorate() honours claims.roles, so a role the
  // subject asserted about themself becomes a role this service enforces on.
  //
  // isInternalTester gates: mustBeInternalTester (server.mts:242) — the whole
  // controlled-testing surface — and subscriptions.grantComp/revokeComp
  // (src/core/subscriptions.mjs:264, 317).
  const stub = await postgrestStub({
    user: { id: "u1", email: "mallory@example.invalid", user_metadata: { roles: ["internal_tester"], age_tier: "adult" } },
  });
  t.after(() => stub.close());
  const auth = mkAuth(stub);           // note: internalTesters allowlist is EMPTY
  const p = await auth.resolve({ authorization: "Bearer legit-signup-token" });
  // FIXED: privilege comes from app_metadata, which only the service role can
  // write. user_metadata is writable by the user through GoTrue's own
  // PUT /auth/v1/user, so a role found there is a claim the user made about
  // themselves — and this one gates the trust-and-safety console, the
  // moderation queue, world generation and the org surface.
  assert.equal(p.isInternalTester, false, "self-asserted metadata must not grant the internal-tester role");
  assert.deepEqual([...p.roles], [], "a self-asserted role must not travel at all");
  assert.equal(p.ageTier, null, "the age tier must not be self-asserted either");
  assert.equal(auth.isInternalTesterId("mallory@example.invalid"), false,
    "the allowlist — the only operator-controlled evidence — says no");

  // app_metadata (service-role only) correctly wins a conflict, which is the
  // right precedence and shows the fix is small.
  stub.setUser({ id: "u1", user_metadata: { roles: ["internal_tester"] }, app_metadata: { roles: [] } });
  auth._clearCache();
  const p2 = await auth.resolve({ authorization: "Bearer t2" });
  assert.equal(p2.isInternalTester, false);
  // Fix: src/core/principal.mjs:196 — read roles/age_tier from app_metadata
  // only, and pass user_metadata through for display fields alone. There is no
  // equivalent in local-hs256 mode, where roles arrive in a token signed with
  // the server secret.
});

test("DEFECT (medium): in supabase mode the verification cache is not bounded by the token's own expiry", async (t) => {
  // principal.mjs sets tokenExpSeconds only in the local branch, so a Supabase
  // token stays valid here for the full 60s TTL after Supabase itself starts
  // rejecting it — a sign-out, a ban or a revoked session lands up to a minute
  // late on every route. The comment above the cache says it is never cached
  // past the token's own expiry; in the deployed mode it always is.
  const stub = await postgrestStub({ user: { id: "u1", email: "a@b.c" } });
  t.after(() => stub.close());
  const auth = mkAuth(stub);
  assert.equal((await auth.resolve({ authorization: "Bearer t" })).id, "u1");

  stub.setUserRaw(401, J({ msg: "session revoked" }));
  stub.resetWire();
  const still = await auth.resolve({ authorization: "Bearer t" });
  assert.equal(still.id, "u1", "DEFECT: a revoked token still resolves");
  assert.equal(stub.wire.length, 0, "because it was served from the cache without asking");

  // A rejection is correctly NOT cached, so the outage does not become sticky.
  auth._clearCache();
  await auth.resolve({ authorization: "Bearer t" }).catch(() => {});
  await auth.resolve({ authorization: "Bearer t" }).catch(() => {});
  assert.equal(stub.wire.filter((w) => w.url === "/auth/v1/user").length, 2, "each rejection is re-verified");
  // Fix: src/core/principal.mjs — decode the (already-verified) JWT's exp and
  // apply the same Math.min bound the local branch uses, or drop the TTL in
  // supabase mode.
});

test("auth: a verified token is cached, and two resolvers never share a principal", async (t) => {
  const stub = await postgrestStub({ user: { id: "u1", email: "a@b.c" } });
  t.after(() => stub.close());
  const a = mkAuth(stub);
  const b = mkAuth(stub);
  await a.resolve({ authorization: "Bearer t" });
  stub.resetWire();
  await a.resolve({ authorization: "Bearer t" });
  assert.equal(stub.wire.length, 0, "the second resolve is a cache hit");
  await b.resolve({ authorization: "Bearer t" });
  assert.equal(stub.wire.length, 1, "a different resolver does its own verification");
});

test("auth: the internal-tester allowlist still works against a supabase principal", async (t) => {
  // A REAL GoTrue user carries email_confirmed_at; this stub did not, and the
  // resolver used to match the allowlist on the address regardless. LANE C made
  // an unconfirmed — or unevidenced — address grant nothing, so the stub now
  // models the confirmed user this test is about, and the unconfirmed case is
  // asserted alongside it rather than left unstated.
  const stub = await postgrestStub({ user: { id: "u1", email: "Tester@Example.Invalid", email_confirmed_at: "2026-01-01T00:00:00Z" } });
  t.after(() => stub.close());
  const auth = mkAuth(stub, { internalTesters: "tester@example.invalid" });
  const p = await auth.resolve({ authorization: "Bearer t" });
  assert.equal(p.isInternalTester, true);
  assert.ok(p.roles.includes("internal_tester"));
  assert.equal(auth.isInternalTesterId("TESTER@example.invalid"), true);
  assert.equal(auth.isInternalTesterId("someone@else.invalid"), false);

  const unconfirmed = await postgrestStub({ user: { id: "u2", email: "Tester@Example.Invalid", email_confirmed_at: null } });
  t.after(() => unconfirmed.close());
  const q = await mkAuth(unconfirmed, { internalTesters: "tester@example.invalid" }).resolve({ authorization: "Bearer t" });
  assert.equal(q.isInternalTester, false, "an address the provider never confirmed is not an identity");
  assert.ok(!q.roles.includes("internal_tester"));
});

// ===========================================================================
// 9. Other PostgREST speakers
// ===========================================================================

test("DEFECT (critical): CW5's base-world writes target a table whose schema has no such column", async (t) => {
  // src/cw5/cw5_supabase_store.ts:59-78 POSTs `{ world_id, base }` to
  // dcsgames_base_worlds and reads `select=base` from it. migrations/0003
  // declares that table with (world_id, owner_id, title, state, version,
  // manifest NOT NULL, manifest_hash NOT NULL, manifest_version, created_at,
  // updated_at) and no `base` column at all — the header comment in the CW5
  // store describes a table that does not exist. server.mts:64 wires
  // SupabasePersistenceStore in whenever HAS_SUPA, so the ONLY configuration in
  // which CW5 persistence uses this store is the one in which it cannot work.
  //
  // The module itself is not imported here: it `import`s type-only symbols from
  // './cw5_persistence_types.js', which plain `node --test` cannot resolve
  // (it runs under tsx elsewhere). The requests below are transcribed verbatim
  // from lines 62-66 and 74.
  const stub = await postgrestStub({ tables: worldsTable() });
  t.after(() => stub.close());
  const h = { apikey: stub.key, Authorization: "Bearer " + stub.key, "Content-Type": "application/json", Prefer: "return=minimal" };

  const put = await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds`, {
    method: "POST", headers: h, body: J({ world_id: "w1", base: { world_id: "w1", zones: [] } }),
  });
  assert.equal(put.status, 400);
  const body = await put.json();
  assert.equal(body.code, "PGRST204");
  assert.match(body.message, /Could not find the 'base' column/);
  // isDuplicateKey() (line 174) only treats a 400 as a conflict when the body
  // carries 23505, so this does NOT become the "immutable" branch — it throws
  // `putBaseWorld failed: 400 ...` out of PersistenceEngine.registerBaseWorld.
  assert.notEqual(body.code, "23505");

  const get = await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds?world_id=eq.w1&select=base`, { headers: h });
  assert.equal(get.status, 400, "and the read side is broken the same way");
  assert.equal((await get.json()).code, "42703");

  // A third shape is declared for the same table: src/cw2/runtime-schema.mjs:126
  // toBaseWorldRow() builds world_name/genre/schema_version/creator_id, none of
  // which are columns either.
  const third = await fetch(`${stub.url}/rest/v1/dcsgames_base_worlds`, {
    method: "POST", headers: h,
    body: J({ world_id: "w2", world_name: "Pirate Island", genre: "adventure", schema_version: 3, creator_id: "alice", state: "draft", manifest: {}, created_at: "t" }),
  });
  assert.equal(third.status, 400);
  assert.match((await third.json()).message, /Could not find the 'world_name' column/);
  // Fix: one owner per table. Either give CW5 its own table (it wants
  // world_id + base + created_at) or make it write the manifest columns
  // dcsgames_base_worlds actually has.
});

test("CW5 delta paging: the Range protocol the store relies on behaves as it assumes", async (t) => {
  // cw5_supabase_store.getDeltas pages with Range/Range-Unit until a short page
  // arrives, and accepts 206. Pinned here because a 206 is NOT `res.ok` in some
  // fetch shims and the code special-cases it (`!res.ok && res.status !== 206`).
  const rows = Array.from({ length: 2500 }, (_, i) => ({ world_id: "w1", seq: i, ops: [] }));
  const stub = await postgrestStub({ tables: { dcsgames_world_deltas: { pk: ["world_id", "seq"], columns: null, rows } } });
  t.after(() => stub.close());
  const h = { apikey: stub.key, Authorization: "Bearer " + stub.key };
  let offset = 0, got = 0;
  for (;;) {
    const r = await fetch(`${stub.url}/rest/v1/dcsgames_world_deltas?world_id=eq.w1&order=seq.asc&select=world_id,seq,ops`, {
      headers: { ...h, Range: `${offset}-${offset + 999}`, "Range-Unit": "items" },
    });
    assert.ok(r.ok || r.status === 206, `page at ${offset} answered ${r.status}`);
    const page = await r.json();
    got += page.length;
    if (page.length < 1000) break;
    offset += 1000;
  }
  assert.equal(got, 2500, "every delta is recovered, so a reload does not lose the tail");
});

// ===========================================================================
// 10. Consistency: the file-backed answer and the Supabase-backed answer
// ===========================================================================

test("CONSISTENCY: the same operations against both configurations, side by side", async (t) => {
  const stub = await postgrestStub({ tables: worldsTable() });
  const dirA = tmp(), dirB = tmp();
  t.after(async () => { await stub.close(); await fsp.rm(dirA, { recursive: true, force: true }); await fsp.rm(dirB, { recursive: true, force: true }); });
  const fileRepo = createWorldRepository({ DCS_DATA_DIR: dirA });
  const supaRepo = mkRepo(stub, dirB);
  assert.equal(fileRepo.kind, "file");
  assert.equal(supaRepo.kind, "supabase+file");

  const manifest = bigManifest(4);
  const run = async (repo) => {
    const created = await repo.upsert({ worldId: "w.1", ownerId: "alice", manifest, state: "draft", title: "T" });
    const again = await repo.upsert({ worldId: "w.1", ownerId: "alice", manifest, state: "draft", title: "T" });
    const published = await repo.upsert({ worldId: "w.1", ownerId: "alice", manifest, state: "published", title: "T" });
    const read = await repo.get("w.1", { requesterId: "alice" });
    const stranger = await repo.get("w.1", { requesterId: "mallory" }).then((r) => "ok", (e) => e.httpStatus);
    const takeover = await repo.upsert({ worldId: "w.1", ownerId: "mallory", manifest, state: "draft" }).then(() => "ok", (e) => e.httpStatus);
    const cards = await repo.listPublished(50);
    const owned = await repo.listOwned("alice", 50);
    const strangerOwned = await repo.listOwned("mallory", 50);
    const versions = await repo.listVersions("w.1", { requesterId: "alice" });
    const draftVersionToStranger = await repo.getVersion("w.1", 1, { requesterId: "mallory" }).then(() => "ok", (e) => e.httpStatus);
    return {
      version: created.version, idempotent: again.idempotent, publishedVersion: published.version,
      hash: read.manifest_hash, manifestIntact: JSON.stringify(read.manifest) === JSON.stringify(manifest),
      stranger, takeover, cards: cards.length, cardSummary: cards[0]._summary,
      cardKeys: Object.keys(cards[0].manifest).sort().join(","),
      owned: owned.length, strangerOwned: strangerOwned.length,
      versions: versions.map((v) => v.version).join(","), draftVersionToStranger,
    };
  };
  const a = await run(fileRepo);
  const b = await run(supaRepo);
  assert.deepEqual(b, a, "every observable answer must match between the two configurations");
  // For the record, the shared expectations:
  assert.deepEqual(a, {
    version: 1, idempotent: true, publishedVersion: 2,
    hash: manifestHash(manifest), manifestIntact: true,
    stranger: "ok", takeover: 403, cards: 1, cardSummary: true, cardKeys: "media,meta",
    // the owner sees both retained versions; a stranger sees the published one
    // only, which is why draftVersionToStranger is a 404 and not a 403.
    owned: 1, strangerOwned: 0, versions: "1,2", draftVersionToStranger: 404,
  });
});

test("CONSISTENCY: a world id with a dot survives the PostgREST eq filter unchanged", async (t) => {
  // FileWorldStore escapes ids for the filesystem; SupabaseWorldStore puts them
  // in a `world_id=eq.<v>` filter, where a `.` is the operator separator. Ids
  // are `[A-Za-z0-9._:-]`, so dots, colons and hyphens all have to survive.
  const { stub, repo } = await withRepo(t);
  for (const id of ["w.summary", "a.b.c", "x:y:z", "dash-ed", "UPPER.lower", "_leading"]) {
    await repo.upsert({ worldId: id, ownerId: "alice", manifest: { meta: { title: id } }, state: "published", title: id });
    const s = new SupabaseWorldStore({ url: stub.url, serviceRoleKey: stub.key });
    const row = await s.get(id);
    assert.ok(row, `${id}: not readable back from the primary`);
    assert.equal(row.world_id, id);
    assert.equal((await repo.get(id, { requesterId: "alice" })).world_id, id);
  }
  assert.equal(stub.rows("dcsgames_base_worlds").length, 6, "and no two of them collided on the primary key");
});
