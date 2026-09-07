// B15 — the marketplace backend, prepared while money stays DARK.
//
// Round-2 called this "doubly dark": the economy router was constructed with no
// database client, so its live branch was unreachable, and its three tables did
// not exist. Building it properly now is safe precisely because money is off,
// and it means the launch decision is a business one rather than a build one.
//
// The invariant this module exists to hold: NO code path can produce a non-zero
// amount while test mode is on. It is enforced three times over —
//   1. here, by refusing a priced listing and forcing every amount to zero;
//   2. in migration 0006, by CHECK constraints the database itself applies;
//   3. by PAYMENTS_LIVE, which must be explicitly turned on.
// Flipping the environment variable alone does not move money.
import crypto from "node:crypto";
import path from "node:path";
import { Errors } from "./errors.mjs";
import { createCollection, describeCollections } from "./collection.mjs";

export const LISTING_KINDS = ["world", "asset", "npc", "script", "music", "animation", "effect", "voice_pack"];
export const SELLER_BPS = 7000;      // 70%
export const PLATFORM_BPS = 3000;    // 30%

const id = (p) => p + "_" + crypto.randomBytes(6).toString("hex");

/**
 * What a test-mode acquisition actually gives you — which is a row, and nothing
 * else. Stated here once and returned with every acquisition, because the word
 * "ownership" invites a reader to assume more.
 *
 * Reproduced 7 Sep 2026 against a booted server, one run:
 *   user-b POST /v3/marketplace/listings/lst_.../acquire -> 200
 *          {"ownership":{"world_id":"w3_b3579c...","acquired_price_minor":0}}
 *   user-b GET  /v3/marketplace/owned  -> 200, the row is there
 *   user-b GET  /v3/worlds/w3_b3579c.../manifest -> 404 "world not found"
 *
 * market.ownedBy() is read by exactly one route in the estate,
 * GET /v3/marketplace/owned. No permission check anywhere consults it: not the
 * world repository, not discovery, not play, not the companion. So an
 * acquisition entitles the acquirer to precisely nothing, and the response used
 * to say "Ownership transferred at zero cost", which is a claim that something
 * changed hands.
 *
 * The flow is still worth exercising — that is what building the marketplace
 * dark is for — but a caller has to be able to tell an exercised flow from a
 * transfer.
 */
const ACQUISITION_CONFERS = {
  ownership_row: true,
  listed_in: "GET /v3/marketplace/owned",
  world_access: false,
  play_access: false,
  resale: false,
  refund: false,
  note: "A test-mode acquisition records an ownership row and nothing else. It does not grant access to the listed world — a private world stays 404 to the acquirer, and a published one was already readable by everybody — and no permission check in this service reads these rows. Nothing was transferred and no money moved.",
};

export function createMarketplaceService(env = process.env) {
  const dir = path.join(env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "marketplace");
  const mk = (name, table, primaryKey) => createCollection({ dir, name, table, primaryKey, env });
  const storefronts = mk("storefronts", "dcsgames_storefronts", ["id"]);
  const listings = mk("listings", "dcsgames_listings", ["id"]);
  const ownership = mk("ownership", "dcsgames_ownership", ["id"]);
  const ledger = mk("ledger", "dcsgames_ledger", ["ref"]);
  const collections = { storefronts, listings, ownership, ledger };

  /** Payments are off unless explicitly enabled. Everything below reads this. */
  const paymentsLive = () => env.PAYMENTS_LIVE === "1";

  const svc = {
    dir,
    describe: () => ({
      ...describeCollections(collections),
      payments_live: paymentsLive(),
      // /health must not let a reader infer that acquiring something gives them
      // it. It does not, and this says so where the rest of the honesty lives.
      acquisition_confers: ACQUISITION_CONFERS,
    }),

    // ------------------------------------------------------------ storefront
    async createStorefront(ownerId, { name, description = null, studioId = null }) {
      if (!ownerId) throw Errors.unauthenticated("a storefront needs an authenticated principal");
      if (!name || String(name).trim().length < 2) throw Errors.validation("a storefront needs a name");
      const row = {
        id: id("sf"), owner_id: ownerId, name: String(name).trim().slice(0, 80),
        description: description ? String(description).slice(0, 400) : null,
        studio_id: studioId, active: true, created_at: new Date().toISOString(),
      };
      return await storefronts.insert(row);
    },

    async storefrontsFor(ownerId) { return await storefronts.find((s) => s.owner_id === ownerId); },

    // --------------------------------------------------------------- listing
    /**
     * List something. A price is REFUSED while money is dark rather than
     * silently zeroed, so a creator is never told their price was accepted when
     * it was not.
     */
    async createListing(sellerId, { storefrontId = null, worldId = null, kind = "world", title, description = null, priceMinor = 0 }) {
      if (!sellerId) throw Errors.unauthenticated("listing needs an authenticated principal");
      if (!LISTING_KINDS.includes(kind)) throw Errors.validation(`kind must be one of: ${LISTING_KINDS.join(", ")}`);
      if (!title || String(title).trim().length < 2) throw Errors.validation("a listing needs a title");
      if (!paymentsLive() && Number(priceMinor) > 0) {
        throw Errors.forbidden(
          "a price cannot be set while payments are disabled; the listing would have been silently free",
          { meta: { payments_live: false, requested_price_minor: Number(priceMinor), window_ends: "2026-09-30" } }
        );
      }
      if (storefrontId) {
        const sf = await storefronts.one((s) => s.id === storefrontId);
        if (!sf) throw Errors.notFound(`storefront ${storefrontId}`);
        if (sf.owner_id !== sellerId) throw Errors.forbidden("that storefront belongs to someone else");
      }
      const row = {
        id: id("lst"), storefront_id: storefrontId, seller_id: sellerId, world_id: worldId,
        kind, title: String(title).trim().slice(0, 120),
        description: description ? String(description).slice(0, 1000) : null,
        price_minor: 0,                        // the invariant, held here as well as in the schema
        currency: "INR",
        test_mode: !paymentsLive(),
        active: true,
        created_at: new Date().toISOString(),
      };
      return await listings.insert(row);
    },

    async browse({ sellerId = null, kind = null, limit = 50 } = {}) {
      let rows = await listings.find((l) => l.active);
      if (sellerId) rows = rows.filter((l) => l.seller_id === sellerId);
      if (kind) rows = rows.filter((l) => l.kind === kind);
      rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return {
        count: rows.length,
        listings: rows.slice(0, limit),
        payments_live: paymentsLive(),
        dark: !paymentsLive(),
        note: paymentsLive() ? null : "Every listing is free and non-transactable: payments are disabled during controlled internal testing.",
      };
    },

    async unlist(sellerId, listingId) {
      const l = await listings.one((x) => x.id === listingId);
      if (!l) throw Errors.notFound(`listing ${listingId}`);
      // Same answer as a thing that does not exist. A 403 here confirms the id
      // is real to somebody who may not see it — the existence oracle already
      // closed on worlds and on retained versions, one surface along.
      if (l.seller_id !== sellerId) throw Errors.notFound(`listing ${listingId}`);
      return await listings.update((x) => x.id === listingId, (x) => ({ ...x, active: false }));
    },

    // ------------------------------------------------------------- acquiring
    /**
     * Acquire a listing. In dark mode this transfers ownership at zero cost and
     * writes a zero ledger entry, so the whole flow — including the 70/30 split
     * shape — is exercised without a single unit of currency moving.
     */
    async acquire(buyerId, listingId) {
      if (!buyerId) throw Errors.unauthenticated("acquiring needs an authenticated principal");
      const l = await listings.one((x) => x.id === listingId && x.active);
      if (!l) throw Errors.notFound(`active listing ${listingId}`);
      if (l.seller_id === buyerId) throw Errors.validation("you already own what you listed");

      const already = await ownership.one((o) => o.owner_id === buyerId && o.listing_id === listingId);
      if (already) return { ownership: already, ledger: null, idempotent: true, payments_live: paymentsLive(), confers: ACQUISITION_CONFERS };

      if (paymentsLive()) {
        // Deliberately unreachable during the internal window. If payments are
        // ever enabled, this must go through a real PSP rather than this path.
        throw Errors.notConfigured("a payment provider (no PSP is integrated; acquiring a priced listing is not implemented)");
      }

      const gross = 0, seller = 0, platform = 0;
      const own = {
        id: id("own"), owner_id: buyerId, listing_id: listingId, world_id: l.world_id,
        name: l.title, acquired_at: new Date().toISOString(),
        acquired_price_minor: 0, test_mode: true,
      };
      await ownership.insert(own);

      const entry = {
        ref: "lgr_" + crypto.randomBytes(8).toString("hex"),
        buyer_id: buyerId, seller_id: l.seller_id, listing_id: listingId,
        gross_minor: gross, seller_minor: seller, platform_minor: platform,
        currency: "INR", status: "test", test_mode: true,
        created_at: new Date().toISOString(),
        // The split shape is recorded so the model can be reviewed, at zero.
        split_bps: { seller: SELLER_BPS, platform: PLATFORM_BPS },
      };
      await ledger.insert(entry);

      return {
        ownership: own, ledger: entry, payments_live: false,
        confers: ACQUISITION_CONFERS,
        note: ACQUISITION_CONFERS.note,
      };
    },

    async ownedBy(principalId) { return await ownership.find((o) => o.owner_id === principalId); },

    // ---------------------------------------------------------------- ledger
    /** Compute the split for a hypothetical gross, for modelling only. */
    splitFor(grossMinor) {
      const gross = Math.max(0, Math.round(Number(grossMinor) || 0));
      const seller = Math.floor((gross * SELLER_BPS) / 10000);
      const platform = gross - seller;                 // remainder to the platform, so it always balances
      return { gross_minor: gross, seller_minor: seller, platform_minor: platform, seller_bps: SELLER_BPS, platform_bps: PLATFORM_BPS, settles: false };
    },

    async ledgerFor(principalId) {
      const rows = await ledger.find((e) => e.buyer_id === principalId || e.seller_id === principalId);
      const settled = rows.filter((e) => e.status === "settled");
      return {
        entries: rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
        // These are real sums over real rows. They are zero because every row is zero.
        gross_minor: rows.reduce((a, e) => a + e.gross_minor, 0),
        seller_minor: rows.reduce((a, e) => a + e.seller_minor, 0),
        settled_count: settled.length,
        payments_live: paymentsLive(),
        note: "Every entry is a zero-value test record. Nothing has been settled, and nothing can be while payments are disabled.",
      };
    },

    /** The invariant, checkable from outside. Used by the smoke test. */
    async assertDark() {
      const problems = [];
      if (paymentsLive()) problems.push("PAYMENTS_LIVE is set");
      for (const l of await listings.all()) if (l.price_minor !== 0) problems.push(`listing ${l.id} carries a price`);
      for (const o of await ownership.all()) if (o.acquired_price_minor !== 0) problems.push(`ownership ${o.id} records a paid acquisition`);
      for (const e of await ledger.all()) {
        if (e.gross_minor !== 0) problems.push(`ledger ${e.ref} carries a gross amount`);
        if (e.status !== "test") problems.push(`ledger ${e.ref} is in status '${e.status}'`);
      }
      return { dark: problems.length === 0, problems };
    },
  };

  return svc;
}
