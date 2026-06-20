/* CW6 ECONOMY ROUTER — gateway-mountable (Express).
 *
 * Per the CW1–CW8 handover: "deliver a clean gateway-mountable router that
 * reconciles any overlap, don't ship a separate server." This router mounts the
 * CW6 economy routes the Surface already calls, on the existing gateway:
 *
 *   GET  /api/marketplace             listings + storefronts + owned (DARK)
 *   POST /api/marketplace/listings    creator lists an item (DARK)
 *   POST /api/marketplace/checkout    test-mode checkout -> ledger_ref + receipt (DARK)
 *   GET  /api/me/payouts              creator payout dashboard (DARK)
 *
 * It does NOT re-implement auth. It reconciles to the gateway's Supabase-JWT
 * middleware by reading req.user (the gateway sets it). If a route needs a user
 * and req.user is absent, it returns 401 — matching the Surface's auth gate.
 *
 * Money is DARK: every money field is 0 / test_mode:true and no external value
 * moves. The 70/30 split + ledger_ref shape + receipt come from the frozen
 * Lane-A economy contracts (ledger_ref = lgr_<world_id>_<seq>).
 *
 * Mount (in the gateway, after its auth middleware):
 *   import { createEconomyRouter } from './economy-router.mjs';
 *   app.use(createEconomyRouter({ supabase, signReceipt }));
 *
 * Dependencies are injected so this stays gateway-agnostic and testable:
 *   - supabase:     the gateway's service-role client (server-side only). Optional;
 *                   if absent the router serves empty/seed-labeled DARK shapes.
 *   - signReceipt:  Atlas's ed25519 issueReceipt(payload) (CW7). Optional; if
 *                   absent the receipt is marked unsigned:true (honest, not faked).
 */

const PAYMENTS_LIVE = process.env.PAYMENTS_LIVE === "1"; // stays 0/DARK until DK flips
const SELLER_BPS = 7000; // 70.00%
const PLATFORM_BPS = 3000; // 30.00%

export function createEconomyRouter(deps = {}) {
  const { supabase = null, signReceipt = null, express } = deps;
  // Lazy-require express if not injected (works in ESM gateways that pass it in).
  const Router = (express && express.Router) ? express.Router : globalThisRouter();
  const router = Router();

  // --- helpers -------------------------------------------------------------
  const json = (res, code, body) => res.status(code).json(body);
  const requireUser = (req, res) => {
    const u = req.user || (req.auth && req.auth.user) || null;
    if (!u) { json(res, 401, { error: "auth_required" }); return null; }
    return u;
  };
  const ledgerRef = (worldId, seq) => `lgr_${worldId}_${seq}`;
  const split = (gross) => {
    const seller = Math.floor((gross * SELLER_BPS) / 10000);
    const platform = gross - seller; // platform takes the remainder; sums exactly
    return { seller_minor: seller, platform_minor: platform };
  };

  // --- GET /api/marketplace ------------------------------------------------
  router.get("/api/marketplace", async (req, res) => {
    try {
      if (!supabase) return json(res, 200, { listings: [], owned: [], storefronts: [], dark: true, source: "seed" });
      const { data: listings } = await supabase.from("dcsgames_listings").select("*").eq("active", true).limit(100);
      const { data: stores } = await supabase.from("dcsgames_storefronts").select("name, items, rating").limit(50);
      const u = req.user || null;
      let owned = [];
      if (u) {
        const { data } = await supabase.from("dcsgames_ownership").select("world_id, name").eq("user_id", u.id).limit(100);
        owned = data || [];
      }
      return json(res, 200, { listings: listings || [], storefronts: stores || [], owned, dark: true });
    } catch (e) { return json(res, 200, { listings: [], owned: [], storefronts: [], dark: true, error: "read_failed" }); }
  });

  // --- POST /api/marketplace/listings -------------------------------------
  router.post("/api/marketplace/listings", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const { world_id = null, name = null, price_minor = 0, kind = "world" } = req.body || {};
    // DARK: price is recorded but no money moves; listing is test-mode.
    const listing = {
      id: `l_${Date.now().toString(36)}`,
      seller_id: u.id, world_id, name, kind,
      price_minor: PAYMENTS_LIVE ? price_minor : 0,
      test_mode: !PAYMENTS_LIVE, active: true,
    };
    try {
      if (supabase) await supabase.from("dcsgames_listings").insert(listing);
      return json(res, 200, { ok: true, listing });
    } catch (e) { return json(res, 200, { ok: true, listing, persisted: false }); }
  });

  // --- POST /api/marketplace/checkout -------------------------------------
  // Test-mode checkout: builds a ledger entry (70/30) + an Atlas receipt, DARK.
  router.post("/api/marketplace/checkout", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    const { items = [], test_mode = true } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) return json(res, 400, { error: "empty_cart" });

    // DARK: gross is 0 until money is live; the split math is exercised for shape.
    const seq = Date.now();
    const worldId = String(items[0]);
    const gross = PAYMENTS_LIVE ? Number(req.body.gross_minor || 0) : 0;
    const { seller_minor, platform_minor } = split(gross);
    const ref = ledgerRef(worldId, seq);

    const entry = {
      ledger_ref: ref, world_id: worldId, kind: "sale",
      gross_minor: gross, seller_minor, platform_minor,
      status: PAYMENTS_LIVE ? "hold" : "test", buyer_id: u.id, test_mode: !PAYMENTS_LIVE,
    };

    // Receipt: signed by Atlas (CW7) if injected; otherwise honestly unsigned.
    const payload = { receipt: `rcpt_${ref}`, ledger_ref: ref, buyer: u.id, items, test_mode: !PAYMENTS_LIVE, issued_at: new Date().toISOString() };
    let receipt = payload, unsigned = true;
    if (signReceipt) { try { receipt = await signReceipt(payload); unsigned = false; } catch (_) { /* keep unsigned */ } }

    try { if (supabase) await supabase.from("dcsgames_economy_ledger").insert(entry); } catch (_) {}

    return json(res, 200, {
      ok: true, test_mode: !PAYMENTS_LIVE, dark: !PAYMENTS_LIVE,
      receipt: payload.receipt, receipt_payload: receipt, unsigned,
      ledger: entry,
    });
  });

  // --- GET /api/me/payouts -------------------------------------------------
  router.get("/api/me/payouts", async (req, res) => {
    const u = requireUser(req, res); if (!u) return;
    try {
      if (!supabase) return json(res, 200, { balance_minor: 0, lifetime_minor: 0, pending_minor: 0, kyc_status: "not_started", history: [], dark: true });
      const { data: led } = await supabase.from("dcsgames_economy_ledger").select("seller_minor, status").eq("seller_id", u.id);
      const lifetime = (led || []).reduce((a, r) => a + (r.seller_minor || 0), 0);
      const pending = (led || []).filter(r => r.status === "hold").reduce((a, r) => a + (r.seller_minor || 0), 0);
      const { data: kyc } = await supabase.from("dcsgames_payout_kyc").select("status").eq("user_id", u.id).maybeSingle();
      // DARK: balances reflect ledger but are non-withdrawable until money-flip.
      return json(res, 200, {
        balance_minor: PAYMENTS_LIVE ? (lifetime - pending) : 0,
        lifetime_minor: PAYMENTS_LIVE ? lifetime : 0,
        pending_minor: PAYMENTS_LIVE ? pending : 0,
        kyc_status: (kyc && kyc.status) || "not_started",
        history: [], dark: !PAYMENTS_LIVE,
      });
    } catch (e) { return json(res, 200, { balance_minor: 0, lifetime_minor: 0, pending_minor: 0, kyc_status: "not_started", history: [], dark: true, error: "read_failed" }); }
  });

  return router;
}

// Minimal Router shim so the module loads + unit-tests without express installed.
// In production the gateway passes its real express in (deps.express).
function globalThisRouter() {
  return function () {
    const routes = [];
    const api = {
      get: (p, h) => routes.push({ method: "GET", path: p, handler: h }),
      post: (p, h) => routes.push({ method: "POST", path: p, handler: h }),
      // test helper: dispatch a fake req/res
      _routes: routes,
      async _dispatch(method, path, { user = null, body = {} } = {}) {
        const r = routes.find(x => x.method === method && x.path === path);
        if (!r) return { status: 404, body: { error: "no_route" } };
        let captured = { status: 200, body: null };
        const res = { status(c) { captured.status = c; return this; }, json(b) { captured.body = b; return this; } };
        await r.handler({ user, body }, res);
        return captured;
      },
    };
    return api;
  };
}
