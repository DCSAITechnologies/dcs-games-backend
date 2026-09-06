// Capability 77 — DCS Plus subscriptions, recovered and BUILT_DARK.
//
// The build this replaces kept subscriptions in an in-memory Map seeded with one
// fixture row — `{ plan: "dcs_plus", status: "active" }` for the founder — behind
// a table (dcsgames_subscriptions) that no migration in this repo has ever
// created. So the only subscription the product had was a hard-coded "active"
// for a user nobody had charged, and it evaporated on restart. That is the same
// failure the marketplace had: a money-shaped capability asserted rather than
// built.
//
// The invariant this module exists to hold: NO subscription anywhere carries a
// price or a paid status. It is held the way marketplace.mjs holds its own —
//   1. here, by refusing to subscribe at all rather than granting a free plan;
//   2. by a status vocabulary that has no paid state to write into;
//   3. in the schema, by CHECK constraints — migrations/0008_subscriptions_dark.sql,
//      mirrored by SUBSCRIPTIONS_DDL below.
//
// The two rules that shape everything else:
//
//   * A CUSTOMER CANNOT SUBSCRIBE. PAYMENTS_LIVE is false and no PSP is
//     integrated, so subscribe() refuses with a 503 exactly as
//     marketplace.acquire() does. It does NOT quietly hand out a free plan: a
//     silent grant would put a real user on a plan nobody billed, which is how
//     the fixture row above came to exist in the first place.
//
//   * AN INTERNAL TESTER MAY BE COMPED, and the row says so forever. Every
//     granted row is test_mode + comped with the granter recorded, so no later
//     read — and no later export — can mistake it for revenue.
//
// Entitlements are reported, never invented: publish credits come from the CW1
// identity-core rules that already enforce them, and anything money-shaped
// (coins, payouts, revenue share) is refused by name rather than left absent.
import crypto from "node:crypto";
import path from "node:path";
import { Errors } from "./errors.mjs";
import { createCollection, describeCollections } from "./collection.mjs";
import { publishCredits, canPublish } from "../cw1/identity-core.mjs";

/** The controlled internal test window. A comped grant may not outlive it. */
export const INTERNAL_WINDOW_ENDS = "2026-09-30";

export const PLAN_IDS = ["free", "dcs_plus"];

/**
 * The only statuses a stored row may hold. There is deliberately no "active",
 * no "trialing" and no "past_due": a status that means "this person is paying"
 * has nowhere to be written, so it cannot be written by accident.
 */
export const GRANT_STATUSES = ["comped", "revoked"];

/**
 * The vocabulary of the build this replaces. These are refused on write and
 * flagged by assertDark on read, so a row that acquired one out of band — a
 * migration, a manual edit, an import from the old Map — is caught.
 */
export const PAID_STATUSES = ["active", "trialing", "past_due", "canceled", "incomplete", "paid"];

/**
 * Entitlement keys this service will NEVER report as granted. A subscription
 * that unlocks currency is a subscription that has to be billed and refunded,
 * and neither exists. They are named rather than omitted so the refusal is
 * visible to anyone reading an entitlement response.
 */
export const MONEY_SHAPED = ["coins", "credits_currency", "balance", "payout", "payouts", "revenue_share", "cashback", "wallet", "gems"];

/**
 * The plan catalogue. Note what is NOT here: a price. No price has been set,
 * because pricing is a business decision nobody has taken and there is no PSP
 * to charge against — so the honest value is null with a reason, not a
 * plausible-looking 499.
 */
export const PLANS = [
  {
    id: "free",
    name: "Free",
    price_minor: 0,
    list_price_minor: null,
    price_note: "Free is free. There is nothing to charge.",
    // Enforced entitlements only: each one names the code that enforces it.
    entitlements: [
      { key: "publish_credits", name: "Worlds you may publish", enforced_by: "canPublish() in src/cw1/identity-core.mjs" },
    ],
  },
  {
    id: "dcs_plus",
    name: "DCS Plus",
    price_minor: 0,
    list_price_minor: null,
    price_note: "No price has been set. No payment provider is integrated, so nothing can be charged and nothing can be refunded.",
    entitlements: [
      { key: "publish_credits", name: "Worlds you may publish", enforced_by: "canPublish() in src/cw1/identity-core.mjs" },
    ],
  },
];

/**
 * The schema half of the invariant. It is now IN the chain as
 * migrations/0008_subscriptions_dark.sql; this export mirrors it so the guard
 * can be asserted from a test without reaching into migrations/, and
 * test/subscriptions.test.mjs checks the two have not drifted apart.
 *
 * Whether 0008 has actually been applied to a database is not knowable from
 * here, so describe() reports schema_applied as null rather than guessing.
 */
export const SUBSCRIPTIONS_DDL = `
create table if not exists public.dcsgames_subscriptions (
  principal_id text        primary key,
  plan         text        not null default 'free'
                 check (plan in ('free','dcs_plus')),
  status       text        not null default 'comped'
                 check (status in ('comped','revoked')),
  test_mode    boolean     not null default true,
  comped       boolean     not null default true,
  price_minor  integer     not null default 0 check (price_minor = 0),
  currency     text        not null default 'INR',
  granted_by   text        not null,
  reason       text,
  granted_at   timestamptz not null default now(),
  -- NOT NULL deliberately: a comped grant with no expiry is a grant that
  -- outlives the internal window, which is the one thing it may not do.
  expires_at   timestamptz not null,
  revoked_at   timestamptz,

  -- The money guard. A subscription that is not comped cannot exist, whatever
  -- the application layer believes, and a comped one cannot carry a price.
  -- Turning subscriptions on is a deliberate schema change plus a PSP, not an
  -- environment variable.
  constraint dcsgames_subscriptions_dark check (test_mode = true and comped = true and price_minor = 0),

  -- The controlled internal testing window closes 30 September 2026. Nothing
  -- granted under it may outlive it.
  constraint dcsgames_subscriptions_internal_window
    check (expires_at <= timestamptz '2026-10-01T00:00:00Z')
);

create index if not exists dcsgames_subscriptions_plan_idx
  on public.dcsgames_subscriptions(plan, status);

-- Every grant and revocation is auditable. An empty table is an honest
-- "nobody has been comped", which is what the UI must be able to show.
create table if not exists public.dcsgames_subscription_events (
  id           text        primary key,
  principal_id text        not null,
  event        text        not null check (event in ('granted','revoked','subscribe_refused')),
  plan         text,
  actor_id     text        not null,
  reason       text,
  created_at   timestamptz not null default now()
);

create index if not exists dcsgames_subscription_events_principal_idx
  on public.dcsgames_subscription_events(principal_id, created_at desc);
`;

const id = (p) => p + "_" + crypto.randomBytes(6).toString("hex");

function planById(planId) {
  return PLANS.find((p) => p.id === planId) || null;
}

export function createSubscriptionsService(env = process.env) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "subscriptions");
  const mk = (name, table, primaryKey) => createCollection({ dir, name, table, primaryKey, env });
  const subscriptions = mk("subscriptions", "dcsgames_subscriptions", ["principal_id"]);
  const events = mk("events", "dcsgames_subscription_events", ["id"]);
  const collections = { subscriptions, events };

  /** Payments are off unless explicitly enabled. Everything below reads this. */
  const paymentsLive = () => env.PAYMENTS_LIVE === "1";

  /**
   * There is no PSP behind either branch of paymentsLive(). The flag records a
   * business intent; this records the engineering fact, and it is what
   * subscribe() actually refuses on.
   */
  const pspIntegrated = () => false;

  async function record(principalId, event, { plan = null, actorId, reason = null }) {
    return await events.insert({
      id: id("sev"), principal_id: principalId, event, plan,
      actor_id: actorId, reason, created_at: new Date().toISOString(),
    });
  }

  /**
   * A grant that has passed its expiry is spent, not silently still in force.
   *
   * A row with NO expiry is not live either. grantTestPlan cannot write one, but
   * a row that arrived some other way (an import, a manual edit, a migration
   * from the old build) would otherwise be a comped plan that never ends —
   * exactly the never-expiring entitlement the internal window exists to
   * prevent. assertDark flags it as well, so it is refused and reported.
   */
  function isLive(row) {
    if (!row) return false;
    if (row.status !== "comped") return false;
    if (row.revoked_at) return false;
    if (!row.expires_at) return false;
    if (Date.now() > new Date(row.expires_at).getTime()) return false;
    return true;
  }

  const svc = {
    dir,
    PLANS,
    PLAN_IDS,

    describe: () => ({
      ...describeCollections(collections),
      payments_live: paymentsLive(),
      psp_integrated: pspIntegrated(),
      // Said plainly, because /health must not imply a capability that is absent.
      subscribable: false,
      // Unknown from here: this process cannot see which migrations a database
      // has run, and guessing "true" would be the kind of claim this module
      // exists to avoid.
      schema_applied: null,
      schema_migration: "migrations/0008_subscriptions_dark.sql",
      schema_note: "The DDL is in the chain as migrations/0008_subscriptions_dark.sql (mirrored by SUBSCRIPTIONS_DDL). Whether it has been applied to a database is not knowable from this process, so it is reported as unknown rather than assumed; the collection always writes its local shadow.",
      note: "No customer can subscribe. The only subscriptions that exist are comped internal-test grants, and every one of them is marked test_mode.",
    }),

    // ------------------------------------------------------------ the refusal
    /**
     * What a customer hits. It always refuses.
     *
     * Handing back a free DCS Plus instead would be worse than the 503: the
     * caller would believe they had subscribed, the row would look like every
     * other subscription, and the first genuine billing run would have no way to
     * tell the two apart. Refusing is the honest answer to "take my money" when
     * there is nothing to take it with.
     */
    async subscribe(principalId, planId = "dcs_plus") {
      if (!principalId) throw Errors.unauthenticated("subscribing needs an authenticated principal");
      if (!PLAN_IDS.includes(planId)) throw Errors.validation(`plan must be one of: ${PLAN_IDS.join(", ")}`, { meta: { plans: PLAN_IDS } });
      // Recorded before the throw: a refused attempt is real demand evidence,
      // and it is the only honest thing this endpoint can produce.
      await record(principalId, "subscribe_refused", { plan: planId, actorId: principalId, reason: "no PSP integrated" });
      throw Errors.notConfigured(
        "a payment provider (no PSP is integrated; subscribing is not implemented, and a plan is not granted for free instead)",
        { meta: { payments_live: paymentsLive(), psp_integrated: false, plan: planId, window_ends: INTERNAL_WINDOW_ENDS } }
      );
    },

    // -------------------------------------------------------- the test grant
    /**
     * Comp an internal tester onto a plan so the entitlement paths can be
     * exercised. Both ends are checked: only an internal tester may grant, and
     * only an internal tester may be granted. The row is permanently marked
     * test_mode + comped and carries the granter, so it can never be counted as
     * a sale.
     *
     * @param {{id:string,isInternalTester?:boolean}} granter
     * @param {{id:string,isInternalTester?:boolean}} subject
     */
    async grantTestPlan(granter, subject, planId = "dcs_plus", { reason = null, expiresAt = INTERNAL_WINDOW_ENDS } = {}) {
      if (!granter || !granter.id) throw Errors.unauthenticated("granting a test plan needs an authenticated principal");
      if (!granter.isInternalTester) throw Errors.forbidden("only an internal tester can comp a plan");
      if (!subject || !subject.id) throw Errors.validation("a subject principal is required");
      if (!subject.isInternalTester) {
        // The whole point of the marking is that a comped plan stays inside the
        // internal window. Comping an outside user would create exactly the
        // ambiguous row this module exists to prevent.
        throw Errors.forbidden(
          "only an internal tester can be comped; a plan cannot be granted to a customer because a customer cannot be billed for it",
          { meta: { subject_id: subject.id, window_ends: INTERNAL_WINDOW_ENDS } }
        );
      }
      if (!PLAN_IDS.includes(planId)) throw Errors.validation(`plan must be one of: ${PLAN_IDS.join(", ")}`, { meta: { plans: PLAN_IDS } });
      if (planId === "free") throw Errors.validation("'free' is the absence of a subscription; there is nothing to grant");

      // An explicit null used to pass straight through to the row, producing a
      // comped grant that never expired — the default protected the careless
      // caller but not the deliberate one, and the column is NOT NULL in 0008.
      if (expiresAt == null || expiresAt === "") {
        throw Errors.validation(
          `a test grant must expire; the controlled internal window ends ${INTERNAL_WINDOW_ENDS}`,
          { meta: { window_ends: INTERNAL_WINDOW_ENDS } },
        );
      }
      const expires = new Date(String(expiresAt).length === 10 ? expiresAt + "T23:59:59Z" : expiresAt);
      if (Number.isNaN(expires.getTime())) throw Errors.validation("expires_at is not a date");
      if (expires.getTime() > new Date(INTERNAL_WINDOW_ENDS + "T23:59:59Z").getTime()) {
        throw Errors.validation(`a test grant cannot outlive the internal window (${INTERNAL_WINDOW_ENDS})`);
      }

      const row = {
        principal_id: subject.id,
        plan: planId,
        status: "comped",
        // These three are the whole point. They are written every time and
        // asserted by assertDark; nothing in this module can produce a row
        // without them.
        test_mode: true,
        comped: true,
        price_minor: 0,
        currency: "INR",
        granted_by: granter.id,
        reason: reason ? String(reason).slice(0, 400) : null,
        granted_at: new Date().toISOString(),
        expires_at: expires.toISOString(),
        revoked_at: null,
      };
      await subscriptions.upsert((s) => s.principal_id === subject.id, row);
      await record(subject.id, "granted", { plan: planId, actorId: granter.id, reason });
      return { ...row, paid: false, note: "Comped for internal testing. Nobody was charged and no revenue was recorded." };
    },

    async revokeTestPlan(granter, principalId) {
      if (!granter || !granter.id) throw Errors.unauthenticated("revoking a test plan needs an authenticated principal");
      if (!granter.isInternalTester) throw Errors.forbidden("only an internal tester can revoke a comped plan");
      const cur = await subscriptions.one((s) => s.principal_id === principalId);
      if (!cur) throw Errors.notFound(`a subscription for ${principalId}`);
      const updated = await subscriptions.update((s) => s.principal_id === principalId, (s) => ({
        ...s, status: "revoked", revoked_at: new Date().toISOString(),
      }));
      await record(principalId, "revoked", { plan: cur.plan, actorId: granter.id });
      return updated;
    },

    // ------------------------------------------------------------- reporting
    /**
     * The subscription state of one principal. Everyone who was never comped is
     * "free" with status "none" — an absence, reported as an absence, rather
     * than a fixture row.
     */
    async statusFor(principalId) {
      const row = await subscriptions.one((s) => s.principal_id === principalId);
      const live = isLive(row);
      return {
        principal_id: principalId,
        plan: live ? row.plan : "free",
        status: row ? row.status : "none",
        active_grant: live,
        // Never true. There is no code path that can set it, which is the point.
        paid: false,
        test_mode: live ? true : null,
        comped: live ? true : false,
        price_minor: 0,
        granted_by: live ? row.granted_by : null,
        granted_at: live ? row.granted_at : null,
        expires_at: row ? row.expires_at : null,
        // A grant that ran out says so, instead of quietly reverting to free.
        expired: !!(row && row.status === "comped" && !row.revoked_at && row.expires_at && !live),
        payments_live: paymentsLive(),
        note: live
          ? "This plan was comped for internal testing. It was not purchased, nobody was charged, and it expires with the internal test window."
          : "No subscription. Subscribing is not possible: no payment provider is integrated.",
      };
    },

    /**
     * What a plan actually unlocks for this principal.
     *
     * Publish credits are computed by the CW1 rules that already enforce them at
     * publish time rather than re-implemented here, so this cannot report an
     * allowance the gate would not honour. Everything money-shaped is listed as
     * WITHHELD by name — an entitlement that is merely absent looks like an
     * oversight; one that is refused out loud is a decision.
     */
    async entitlementsFor(principalId, { level = "explorer", publishedCount = 0 } = {}) {
      const st = await svc.statusFor(principalId);
      const plus = st.plan === "dcs_plus";
      const credits = publishCredits({ level, dcs_plus: plus });
      const gate = canPublish({ level, dcs_plus: plus, published_count: publishedCount });
      const plan = planById(st.plan) || planById("free");

      const entitlements = [
        {
          key: "publish_credits",
          name: "Worlds you may publish",
          // Infinity does not survive JSON, so it is null plus a flag rather
          // than silently becoming zero. Same rule as social.me().
          value: credits === Infinity ? null : credits,
          unlimited: credits === Infinity,
          granted: true,
          enforced: true,
          enforced_by: "canPublish() in src/cw1/identity-core.mjs",
          remaining: gate.remaining === Infinity ? null : gate.remaining,
        },
      ];

      return {
        principal_id: principalId,
        plan: st.plan,
        plan_name: plan.name,
        // Two separate facts, never collapsed into one "dcs_plus" boolean: what
        // the entitlement engine should read, and whether anyone paid for it.
        dcs_plus_effective: plus,
        dcs_plus_paid: false,
        comped: st.comped,
        test_mode: st.test_mode,
        entitlements,
        withheld: MONEY_SHAPED.map((key) => ({
          key,
          granted: false,
          why: "money is disabled during controlled internal testing; no plan grants currency, a payout or a share of revenue",
        })),
        price_minor: 0,
        list_price_minor: plan.list_price_minor,
        price_note: plan.price_note,
        payments_live: paymentsLive(),
        note: plus
          ? "These entitlements come from a comped internal-test grant, not a purchase."
          : "Free-plan entitlements. Upgrading is not available: no payment provider is integrated.",
      };
    },

    /** The catalogue, with the missing price stated rather than filled in. */
    plans() {
      return {
        plans: PLANS.map((p) => ({ ...p, purchasable: false })),
        purchasable: false,
        payments_live: paymentsLive(),
        psp_integrated: pspIntegrated(),
        note: "No plan is purchasable. Prices are unset because no pricing decision has been taken and no payment provider is integrated.",
      };
    },

    /** Everything comped, for review. Empty is an honest "nobody was comped". */
    async listGrants() {
      const rows = (await subscriptions.all()).slice().sort((a, b) => String(b.granted_at).localeCompare(String(a.granted_at)));
      return {
        count: rows.length,
        grants: rows,
        // Real sums over real rows. They are zero because every row is zero.
        total_price_minor: rows.reduce((a, r) => a + (Number(r.price_minor) || 0), 0),
        paid_count: rows.filter((r) => PAID_STATUSES.includes(r.status)).length,
        comped_count: rows.filter((r) => r.comped === true).length,
        // Named so that nothing downstream has to infer it: a comped grant is
        // not revenue, and the count of grants is not a count of sales.
        revenue_minor: 0,
        note: rows.length === 0
          ? "No subscription has ever been granted."
          : "Every row is a comped internal-test grant. None was purchased.",
      };
    },

    async eventsFor(principalId) {
      const rows = await events.find((e) => e.principal_id === principalId);
      return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },

    // ------------------------------------------------------------ the check
    /**
     * The invariant, checkable from outside — the same public statement
     * marketplace.assertDark() makes, for subscriptions.
     *
     * It reads the stored rows rather than trusting the code that wrote them, so
     * a row corrupted past the service (a manual edit, a bad import, a future
     * migration) fails it. A check that cannot fail proves nothing.
     */
    async assertDark() {
      const problems = [];
      if (paymentsLive()) problems.push("PAYMENTS_LIVE is set");

      for (const s of await subscriptions.all()) {
        const who = s.principal_id;
        if (Number(s.price_minor) !== 0) problems.push(`subscription ${who} carries a price`);
        if (PAID_STATUSES.includes(s.status)) problems.push(`subscription ${who} is in paid status '${s.status}'`);
        if (!GRANT_STATUSES.includes(s.status)) problems.push(`subscription ${who} is in unknown status '${s.status}'`);
        if (s.test_mode !== true) problems.push(`subscription ${who} is not marked test_mode`);
        if (s.comped !== true) problems.push(`subscription ${who} is not marked comped`);
        if (!s.granted_by) problems.push(`subscription ${who} records no granter`);
        if (!PLAN_IDS.includes(s.plan)) problems.push(`subscription ${who} is on unknown plan '${s.plan}'`);
        if (!s.expires_at) problems.push(`subscription ${who} never expires, so it outlives the internal window`);
        if (s.expires_at && new Date(s.expires_at).getTime() > new Date(INTERNAL_WINDOW_ENDS + "T23:59:59Z").getTime()) {
          problems.push(`subscription ${who} outlives the internal window`);
        }
      }

      // The catalogue is part of the claim: a plan that advertises currency is
      // a money-shaped promise even if no row exists yet.
      for (const p of PLANS) {
        if (Number(p.price_minor) !== 0) problems.push(`plan '${p.id}' carries a price`);
        if (p.list_price_minor !== null && Number(p.list_price_minor) !== 0) problems.push(`plan '${p.id}' advertises a list price`);
        for (const e of p.entitlements) {
          if (MONEY_SHAPED.includes(e.key)) problems.push(`plan '${p.id}' claims money-shaped entitlement '${e.key}'`);
        }
      }

      return { dark: problems.length === 0, problems };
    },
  };

  return svc;
}
