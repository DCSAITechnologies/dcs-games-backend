// B15 — one durable collection abstraction for the row-shaped stores.
//
// The social and safety services were written against atomic JSON files. That is
// genuinely durable across a restart, but NOT across a redeploy: on Railway the
// container disk is ephemeral unless a volume is mounted, so a deploy would lose
// friendships, reports and consent records.
//
// This gives them the same shape the world store already uses: Supabase as the
// primary when configured, an atomic local file as a shadow that is always
// written, and honest reporting when the primary is degraded. A read prefers the
// primary and falls back to the shadow, so a Supabase outage degrades rather than
// erases.
//
// The interface is deliberately the same as the JSON tables it replaces, so the
// services above it did not have to change shape.
//
// ---------------------------------------------------------------------------
// WHICH BACKING WINS — the one rule everything below follows
//
// Two states, and only two:
//
//   CLEAN    every local write has been confirmed by the primary. The primary is
//            authoritative: all() takes its answer and refreshes the shadow with
//            it, INCLUDING an empty answer. An empty answer is an answer — a row
//            the primary no longer has is a row that was deleted, and a deletion
//            has to stick. This is the consent-revocation / block / report-
//            deletion path: "I deleted it" must stay true, so the shadow is never
//            allowed to resurrect a row the primary does not have.
//
//   PENDING  this process (or a previous one) wrote rows the primary did not
//            confirm. Those rows exist ONLY in the shadow, so for as long as that
//            is true the shadow is authoritative and its contents are replayed at
//            the primary. Nothing else may overwrite it.
//
// The two are told apart by a DURABLE journal (`<name>.pending.json`) written
// next to the shadow BEFORE the primary is contacted and removed only after a
// confirmed round trip. It has to be durable because the in-memory flag it
// replaces did not survive a redeploy, a crash or a health-check kill — and the
// row it was protecting was destroyed by the next read in the new process.
//
// It also has to be self-clearing, because a marker that is never cleared is a
// collection that is permanently authoritative locally and permanently
// "degraded" on /health. So: it is cleared on the first replay the primary
// actually confirms, and "confirmed" means a request went out and came back —
// never an empty upsert that made no request at all.
//
// A FAILED READ IS NOT PENDING. A read that times out says nothing about whether
// the shadow diverges from the primary, so it degrades the health report and
// falls back to the shadow for that one call, and that is all. It must not push
// the shadow back at the primary — that is how a row someone deleted at the
// primary gets resurrected by an unrelated GET failure.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Errors, optional } from "./errors.mjs";
import { createKeyedMutex } from "./mutex.mjs";

/** Shared across every collection in this process; the KEY keeps them independent. */
const withLock = createKeyedMutex();

/** PostgREST caps a single response; page under the cap rather than truncating. */
const PAGE = 1000;
/** A collection this big is a bug, and a silent half-answer is worse than a throw. */
const MAX_ROWS = 250000;

/** Write-then-rename, so a reader never sees a half-written file. */
async function atomicWrite(file, value) {
  const tmp = file + ".tmp-" + crypto.randomBytes(4).toString("hex");
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

/** Atomic JSON file. Always written, so nothing is ever only in a remote database. */
class FileBacking {
  constructor(dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, name + ".json");
    this.kind = "file";
  }
  async read() {
    try { return JSON.parse(await fsp.readFile(this.file, "utf8")); }
    catch (e) { if (e.code === "ENOENT") return []; throw e; }
  }
  async write(rows) {
    await atomicWrite(this.file, rows);
    return rows;
  }
}

/**
 * The durable "the shadow holds writes the primary has not confirmed" marker.
 *
 * Content is deliberately tiny: when it was opened, why, and the primary-key
 * columns of the rows this process DELETED but could not confirm. The rows to
 * (re)send are not copied here — the shadow already is that list, and a second
 * copy could only ever go stale.
 *
 * Deletions have to be journalled explicitly because they are the one operation
 * that cannot be inferred from the shadow: an absent row and a row that was
 * never there look identical.
 */
class PendingJournal {
  constructor(dir, name) {
    this.file = path.join(dir, name + ".pending.json");
    this.state = this._loadSync();
  }
  _loadSync() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!j || typeof j !== "object") return null;
      return { at: j.at || null, detail: j.detail || "unconfirmed local writes", deletes: Array.isArray(j.deletes) ? j.deletes : [] };
    } catch { return null; }                 // ENOENT or corrupt: nothing is pending
  }
  get pending() { return this.state; }
  /** Open (or extend) the journal. Called BEFORE the primary is attempted. */
  async record({ deletes = [], detail, keyOf }) {
    const merged = new Map();
    for (const d of (this.state?.deletes || [])) merged.set(keyOf(d), d);
    for (const d of deletes) merged.set(keyOf(d), d);
    const next = { at: new Date().toISOString(), detail, deletes: [...merged.values()] };
    await atomicWrite(this.file, next);
    this.state = next;
    return next;
  }
  /** Only ever called after a round trip the primary actually answered. */
  async clear() {
    this.state = null;
    await fsp.rm(this.file, { force: true });
  }
}

/**
 * An upstream failure the CALLER may see, with the upstream's own body kept out of it.
 *
 * PostgREST answers a 4xx with a JSON body naming the constraint, the relation,
 * the offending column and a hint. That body used to be interpolated straight
 * into the AppError detail — and `optional()` copies a detail into `degraded`,
 * `describeCollections()` copies `degraded` into /health, and /health answers
 * before any authentication runs. So an anonymous caller polling /health during
 * an outage read the private schema: table names, column names and constraint
 * names available no other way, which is the reconnaissance step for every
 * constraint-shaped probe after it.
 *
 * The body is not discarded — it is the only thing that says WHY the write was
 * refused, and losing it would trade a disclosure for a blind operator. It goes
 * to the log, where an operator can read it and a stranger cannot, and the
 * caller keeps the table, the operation and the status.
 */
function upstreamWithoutBody(table, op, r, body) {
  if (body) {
    console.warn(JSON.stringify({
      level: "warn", upstream: "supabase", table, op, status: r.status,
      detail: String(body).slice(0, 2000),
      note: "upstream body logged, not returned: it names constraints and columns and /health is unauthenticated",
      ts: new Date().toISOString(),
    }));
  }
  return Errors.upstream("supabase", `${table} ${op} failed (${r.status})`);
}

/** Group rows so that every object inside one group carries exactly the same keys. */
function byShape(rows) {
  const groups = new Map();
  for (const r of rows) {
    const sig = Object.keys(r).sort().join(" ");
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(r);
  }
  return [...groups.values()];
}

/**
 * PostgREST-backed table. Whole-collection read/write, which is the right trade
 * for these collections: they are small, bounded per principal, and correctness
 * matters more than write amplification during internal testing.
 */
class SupabaseBacking {
  constructor({ url, serviceRoleKey, table, primaryKey, fetchImpl }) {
    this.url = String(url).replace(/\/$/, "");
    this.key = serviceRoleKey;
    this.table = table;
    this.primaryKey = primaryKey;           // array of column names
    this.fetch = fetchImpl || globalThis.fetch;
    this.kind = "supabase";
  }
  get _h() { return { apikey: this.key, Authorization: "Bearer " + this.key, "Content-Type": "application/json" }; }

  /**
   * The whole collection, paginated.
   *
   * A single `limit=10000` silently truncated: the 10001st row was not returned,
   * nothing said so, and all() then rewrote the shadow WITHOUT it. Page with
   * Range until a short page proves the end, the way cw5_supabase_store.getDeltas
   * already does. Ordered by the primary key so the pages partition the table
   * instead of overlapping.
   *
   * "A short page is the end" assumes the server's own row cap is not SMALLER
   * than PAGE — with a numeric total absent from Content-Range (PostgREST sends
   * `/*` unless a count is requested) a truncated page and a final page are
   * indistinguishable. PAGE is set to the cap this estate already assumes
   * elsewhere; a collection whose size is an exact multiple of it asks for one
   * page past the end, which PostgREST answers 416, and that is the end too.
   */
  async read() {
    const order = this.primaryKey.map((k) => `${k}.asc`).join(",");
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const r = await this.fetch(
        `${this.url}/rest/v1/${this.table}?select=*&order=${encodeURIComponent(order)}`,
        { headers: { ...this._h, Range: `${offset}-${offset + PAGE - 1}`, "Range-Unit": "items" } },
      );
      if (r.status === 416) return out;      // range past the end: there is no next page
      if (!r.ok && r.status !== 206) throw Errors.upstream("supabase", `${this.table} read failed (${r.status})`);
      const page = await r.json();
      if (!Array.isArray(page)) throw Errors.upstream("supabase", `${this.table} read returned ${typeof page}, not an array`);
      out.push(...page);
      if (page.length < PAGE) return out;
      if (out.length >= MAX_ROWS) {
        // Refusing loudly beats handing back a prefix that all() would then write
        // over the shadow as if it were the whole collection.
        throw Errors.upstream("supabase", `${this.table} read exceeded ${MAX_ROWS} rows; refusing to treat a truncated answer as the whole collection`);
      }
    }
  }

  /** A cheap round trip, for when there is nothing to replay but health still has to be earned. */
  async ping() {
    const r = await this.fetch(`${this.url}/rest/v1/${this.table}?select=*&limit=1`, { headers: this._h });
    if (!r.ok) throw Errors.upstream("supabase", `${this.table} probe failed (${r.status})`);
    return { requests: 1 };
  }

  /**
   * Upsert the rows that changed. Deletions are applied explicitly by the caller.
   *
   * Rows are grouped by their key set and each homogeneous group is POSTed on its
   * own, with `columns=` naming exactly the keys in that group. These collections
   * legitimately hold rows of different shapes — social.mjs builds a profile row
   * with no `updated_at` and adds it to ONE row on the first edit — and a bulk
   * insert whose objects carry different keys is believed to be a 400/PGRST102.
   * Grouping means a heterogeneous array is never put on the wire at all, so the
   * write is correct whether or not that belief holds.
   *
   * Rows are NOT padded out to the union of keys with nulls: `updated_at`,
   * `created_at`, `status`, `level` and friends are NOT NULL DEFAULT columns in
   * migrations 0004/0005, so an explicit null would trade PGRST102 for a 23502.
   */
  async upsert(rows) {
    if (!rows.length) return { requests: 0 };
    const onConflict = encodeURIComponent(this.primaryKey.join(","));
    let requests = 0;
    for (const group of byShape(rows)) {
      const columns = encodeURIComponent(Object.keys(group[0]).sort().join(","));
      const r = await this.fetch(`${this.url}/rest/v1/${this.table}?on_conflict=${onConflict}&columns=${columns}`, {
        method: "POST",
        headers: { ...this._h, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(group),
      });
      requests += 1;
      if (!r.ok) throw upstreamWithoutBody(this.table, "upsert", r, await r.text().catch(() => ""));
    }
    return { requests };
  }
  async deleteWhere(row) {
    const q = this.primaryKey.map((k) => `${k}=eq.${encodeURIComponent(row[k])}`).join("&");
    const r = await this.fetch(`${this.url}/rest/v1/${this.table}?${q}`, { method: "DELETE", headers: this._h });
    if (!r.ok) throw Errors.upstream("supabase", `${this.table} delete failed (${r.status})`);
    return { requests: 1 };
  }
}

/**
 * A durable collection of rows.
 *
 * @param {object} opts
 * @param {string} opts.dir            local shadow directory
 * @param {string} opts.name           collection name (also the local filename)
 * @param {string} [opts.table]        Supabase table; omit to stay local-only
 * @param {string[]} [opts.primaryKey] columns identifying a row, for upsert/delete
 * @param {object} [opts.env]
 */
export function createCollection({ dir, name, table = null, primaryKey = ["id"], env = process.env, fetchImpl } = {}) {
  const file = new FileBacking(dir, name);
  const url = (env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY || "";
  const remote = table && url && key ? new SupabaseBacking({ url, serviceRoleKey: key, table, primaryKey, fetchImpl }) : null;

  /** Durable record of writes the primary has not confirmed. Null when local-only. */
  const journal = remote ? new PendingJournal(dir, name) : null;

  /**
   * A row's identity, as a string, from its primary-key columns.
   *
   * This was `primaryKey.map((k) => String(r[k])).join(" ")`, which is NOT
   * injective. Any key value containing the separator makes two DISTINCT rows
   * share one identity, and `undefined`/`null` collapse onto the literal
   * strings "undefined"/"null". Postgres identifies a row by its key COLUMNS,
   * so the two backings disagreed about what a row even is.
   *
   * What that cost: write() computes the deletion set as
   *   before.filter((r) => !now.has(rowKey(r)))
   * so when a SURVIVING row happened to share a removed row's key, the removed
   * row was never journalled and never deleted at the primary — while the
   * caller was told the removal succeeded and `degraded` stayed null. The next
   * healthy read then pulled the row back from the primary and rewrote the
   * shadow with it. syncToPrimary's `dead` map has the same shape, so two
   * remote rows sharing a key produced one DELETE and the other survived.
   *
   * This is the block / consent-revocation / report-deletion path, and the
   * header of this file states the rule it broke: "I deleted it" must stay true.
   *
   * JSON encoding of the column ARRAY is injective by construction — every `"`
   * inside a value is escaped, so no value can forge an element boundary — and
   * an absent column is `null`, which no string can spell. The encoding is
   * internal and recomputed on every call; nothing persists it, so changing it
   * cannot strand a journal written by an earlier build (the journal stores the
   * key COLUMNS, via keyCols, not this string).
   */
  const rowKey = (r) => JSON.stringify(primaryKey.map((k) => {
    const v = r?.[k];
    return v === undefined || v === null ? null : String(v);
  }));
  const keyCols = (r) => Object.fromEntries(primaryKey.map((k) => [k, r[k]]));

  /**
   * Rows the primary has not accepted, so a caller can see the collection is
   * degraded. Seeded from the journal at construction: a process that starts up
   * holding unreplayed writes is degraded from its first second, and /health says
   * so, instead of finding out at the moment it destroys them.
   */
  let degraded = journal?.pending
    ? `supabase: ${table} has unconfirmed local writes from ${journal.pending.at} awaiting replay (${journal.pending.detail})`
    : null;

  /**
   * Push the shadow's contents at the primary.
   *
   * @param rows              the whole shadow — upserted
   * @param deletes           key-only rows to DELETE (from the journal)
   * @param reconcileRemote   also delete rows the primary holds that `rows` does
   *                          not. True for a write(), which is a whole-collection
   *                          replace. FALSE for a replay: rows that appeared at
   *                          the primary while we were degraded are not ours to
   *                          delete.
   * Throws unless every part of it was confirmed.
   */
  async function syncToPrimary(rows, deletes, { reconcileRemote }) {
    const now = new Set(rows.map(rowKey));
    const dead = new Map();
    for (const d of deletes) if (!now.has(rowKey(d))) dead.set(rowKey(d), keyCols(d));

    // The pre-read used to be `remote.read().catch(() => [])`. Swallowing it meant
    // a remove() whose GET failed computed an EMPTY deletion set, deleted nothing
    // remotely, reported success, and left `degraded` null — and the row came back
    // on the next successful read. The journal above is what makes the caller's
    // own deletions survive that; this read only ever ADDS rows we never knew
    // about, and if it fails the write is degraded, because it provably did not
    // do everything it claimed.
    let unverified = null;
    if (reconcileRemote) {
      try {
        for (const r of await remote.read()) if (!now.has(rowKey(r))) dead.set(rowKey(r), keyCols(r));
      } catch (e) { unverified = e; }
    }

    let requests = 0;
    for (const d of dead.values()) requests += (await remote.deleteWhere(d)).requests;
    requests += (await remote.upsert(rows)).requests;

    if (unverified) {
      throw Errors.upstream("supabase", `${table} write only partly reconciled: the pre-write read failed (${unverified?.message || unverified}); ${dead.size} journalled deletion(s) applied, any other remote row is unverified`);
    }
    // Nothing to send is not the same as a healthy primary. An empty upsert makes
    // no request, and clearing the journal on the strength of a request that never
    // happened is how /health came to claim everything was fine during an outage.
    if (requests === 0) await remote.ping();
    return true;
  }

  async function onSynced() { await journal.clear(); degraded = null; }

  const api = {
    name,
    table,
    get kind() { return remote ? `${remote.kind}+${file.kind}` : file.kind; },
    get degraded() { return degraded; },
    /** The durable journal, for callers that want more than a boolean. */
    get pending() { return journal?.pending || null; },

    /**
     * Read the collection. Prefers the primary, EXCEPT while the durable journal
     * says the shadow holds writes the primary has not confirmed.
     *
     * That exception matters: a write the primary rejected lives only in the
     * shadow. Reading the primary then and overwriting the shadow with its
     * answer silently destroys the row — and because the marker is on disk, a
     * restart in the middle of an outage no longer destroys it either.
     */
    async all() {
      if (!remote) return await file.read();

      const pending = journal.pending;
      if (pending) {
        const local = await file.read();
        // Opportunistic re-sync: if the primary is healthy again, replay the
        // shadow so the two converge rather than drifting apart. The journalled
        // deletions are replayed too — the deletion half of a failed write is
        // exactly the half a caller was told had happened.
        const retry = await optional(`supabase-${name}-resync`, () => syncToPrimary(local, pending.deletes, { reconcileRemote: false }));
        if (retry.ok) await onSynced();
        else degraded = retry.error;
        return local;
      }

      const r = await optional(`supabase-${name}-read`, () => remote.read());
      if (r.ok) {
        degraded = null;
        // Keep the shadow warm so a later outage has something recent to serve.
        // An empty answer overwrites it too: with nothing pending the primary is
        // authoritative, and a deletion that the shadow could undo is not a
        // deletion. See the header.
        await optional(`supabase-${name}-shadow`, () => file.write(r.value));
        return r.value;
      }
      // A read failure is not evidence of local divergence, so it does NOT open
      // the journal: it degrades the health report and serves the shadow.
      degraded = r.error;
      return await file.read();
    },

    /**
     * Replace the whole collection. The shadow is written FIRST, so a row is
     * never only in a remote database that might reject it — and the journal is
     * opened BEFORE the primary is contacted, so a crash mid-request leaves
     * evidence that the next process must replay rather than overwrite.
     */
    async write(rows) {
      if (!remote) { await file.write(rows); return rows; }
      const before = await file.read();          // what we last told the primary
      await file.write(rows);
      const now = new Set(rows.map(rowKey));
      const deletes = before.filter((r) => !now.has(rowKey(r))).map(keyCols);
      await journal.record({ deletes, detail: `write of ${rows.length} row(s), ${deletes.length} deletion(s)`, keyOf: rowKey });
      const r = await optional(`supabase-${name}-write`, () => syncToPrimary(rows, journal.pending.deletes, { reconcileRemote: true }));
      if (r.ok) await onSynced();
      else degraded = r.error;
      return rows;
    },

    async find(pred) { return (await api.all()).filter(pred); },
    async one(pred) { return (await api.all()).find(pred) || null; },
    // Every mutation below reads the whole collection, changes it, and writes it
    // back, with awaits in between. Without a lock two concurrent callers both
    // read the OLD rows and the second write erases the first — and both are
    // told they succeeded. Measured: two simultaneous inserts stored one row.
    // The lock is per collection, so unrelated collections never wait on
    // each other, and reads are never blocked.
    async insert(row) {
      return await withLock(name, async () => {
        const rows = await api.all();
        rows.push(row);
        await api.write(rows);
        return row;
      });
    },
    /**
     * Find-or-insert, atomically.
     *
     * `const x = await c.one(pred); if (!x) await c.insert(build())` looks
     * correct and is not: the gap between the read and the insert is a window,
     * and every concurrent caller passes through it. Measured after write
     * serialisation removed the lost-update bug that was masking it — 128
     * simultaneous first sign-ins created 128 profile rows for ONE principal,
     * because all 128 had already looked and seen nothing.
     *
     * `build` may READ this collection (reads are never locked, so a username
     * collision check inside it is fine) but must not WRITE to it.
     */
    async ensure(pred, build) {
      return await withLock(name, async () => {
        const rows = await api.all();
        const found = rows.find(pred);
        if (found) return { row: found, created: false };
        const row = await build();
        const fresh = await api.all();          // re-read: build() may have taken time
        const raced = fresh.find(pred);
        if (raced) return { row: raced, created: false };
        fresh.push(row);
        await api.write(fresh);
        return { row, created: true };
      });
    },
    async update(pred, mut) {
      return await withLock(name, async () => {
        const rows = await api.all();
        const i = rows.findIndex(pred);
        if (i < 0) return null;
        const next = mut(rows[i]);
        // A mutator that falls off the end — an `if` with no `else`, an early
        // return, a forgotten `return` — used to have its `undefined` stored
        // unconditionally. JSON.stringify turns that into `null`, so the row was
        // DESTROYED while update() reported success, and under Supabase the null
        // was then upserted, making the destruction durable. A row is an object
        // or the mutator is wrong; saying so beats writing the damage.
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          throw Errors.internal(`${name}: an update mutator returned ${Array.isArray(next) ? "an array" : typeof next}, not a row; refusing to overwrite the row with it`);
        }
        rows[i] = next;
        await api.write(rows);
        return rows[i];
      });
    },
    async upsert(pred, row) {
      return await withLock(name, async () => {
        const rows = await api.all();
        const i = rows.findIndex(pred);
        if (i >= 0) rows[i] = { ...rows[i], ...row };
        else rows.push(row);
        await api.write(rows);
        return row;
      });
    },
    async remove(pred) {
      return await withLock(name, async () => {
        const rows = await api.all();
        const kept = rows.filter((r) => !pred(r));
        await api.write(kept);
        return rows.length - kept.length;
      });
    },
  };

  return api;
}

/** Describe where a set of collections is actually persisting, for /health. */
export function describeCollections(collections) {
  const kinds = new Set(Object.values(collections).map((c) => c.kind));
  const degraded = Object.entries(collections).filter(([, c]) => c.degraded).map(([k, c]) => ({ collection: k, error: c.degraded }));
  return {
    persistence: kinds.size === 1 ? [...kinds][0] : [...kinds].join(","),
    degraded: degraded.length ? degraded : null,
  };
}
