// CW1 Identity — GATEWAY-MOUNTABLE T&S / SSO / KYC module (v3.0 Part A).
// Per the handover: deliver a clean gateway-mountable router that reconciles to the gateway's
// Supabase-JWT auth + Supabase db — NOT a separate server. The integration owner mounts this.
//
// Contract with the gateway (passed in `ctx`):
//   ctx.user   : the gateway's already-auth-resolved user  { id, is_admin?, is_moderator? }  (or null if anon)
//   ctx.repo   : the gateway's Supabase-backed repo, OR omit and pass ctx.db to build one here
//   ctx.send   : (res, code, json) responder
//   ctx.body   : async (req) -> parsed JSON
//
// Returns true if it handled the request, false to fall through. Zero new auth, zero new db client —
// it uses whatever the gateway already established, so there's no overlap or double-verification.

import { isModerator, applyModeration, applyAppeal } from "./trust-safety.mjs";
import { makeRepo } from "./db.mjs";

export async function handleTrustSafetySSO(req, res, ctx) {
  const { user, send } = ctx;
  // reconcile to the gateway's repo if given; else build one from its db handle (same code path)
  const repo = ctx.repo || makeRepo(ctx.db || { mode: "memory" });
  const body = ctx.body || (async (r) => { let d=""; for await (const c of r) d+=c; try { return d?JSON.parse(d):{}; } catch { return {}; } });
  const url = new URL(req.url, "http://x");
  let path = url.pathname; if (path.startsWith("/api/")) path = path.slice(4) || "/";
  const m = req.method, seg = path.split("/").filter(Boolean);
  const uid = () => (user && user.id) || null;
  const anon = () => !uid();

  // ---- file a report (any signed-in user) ----
  if (path === "/reports" && m === "POST") {
    if (anon()) { send(res, 401, { error:"unauthenticated" }); return true; }
    const b = await body(req);
    if (!b.target_id) { send(res, 400, { error:"target_id_required" }); return true; }
    send(res, 200, await repo.createReport(uid(), b.target_id, b.reason)); return true;
  }

  // ---- moderator queue ----
  if (path === "/ts/reports" && m === "GET") {
    const me = await repo.getUser(uid());
    if (!isModerator(me || user)) { send(res, 403, { error:"forbidden", reason:"moderator_only" }); return true; }
    send(res, 200, { reports: await repo.listReports(url.searchParams.get("state")) }); return true;
  }

  // ---- moderator action ----
  if (seg[0]==="ts" && seg[1]==="reports" && seg[2] && seg[3]==="action" && m==="POST") {
    const me = await repo.getUser(uid());
    if (!isModerator(me || user)) { send(res, 403, { error:"forbidden", reason:"moderator_only" }); return true; }
    const report = await repo.getReport(seg[2]); if(!report){ send(res,404,{error:"no_report"}); return true; }
    const r = applyModeration(report, (await body(req)).action, uid());
    if (r.error) { send(res, 400, r); return true; }
    await repo.saveReport(r.report); await repo.writeAudit(r.audit);
    send(res, 200, { report:r.report, audit:r.audit }); return true;
  }

  // ---- actioned user appeals ----
  if (seg[0]==="reports" && seg[1] && seg[2]==="appeal" && m==="POST") {
    if (anon()) { send(res, 401, { error:"unauthenticated" }); return true; }
    const report = await repo.getReport(seg[1]); if(!report){ send(res,404,{error:"no_report"}); return true; }
    if (report.target_id !== uid()) { send(res, 403, { error:"forbidden", reason:"only_the_actioned_user_can_appeal" }); return true; }
    if (report.state !== "actioned") { send(res, 400, { error:"not_actionable", state:report.state }); return true; }
    report.state = "appealed"; report.appealed_at = new Date().toISOString();
    await repo.saveReport(report); send(res, 200, report); return true;
  }

  // ---- moderator decides appeal ----
  if (seg[0]==="ts" && seg[1]==="reports" && seg[2] && seg[3]==="appeal" && seg[4]==="decide" && m==="POST") {
    const me = await repo.getUser(uid());
    if (!isModerator(me || user)) { send(res, 403, { error:"forbidden", reason:"moderator_only" }); return true; }
    const report = await repo.getReport(seg[2]); if(!report){ send(res,404,{error:"no_report"}); return true; }
    const r = applyAppeal(report, (await body(req)).decision, uid());
    if (r.error) { send(res, 400, r); return true; }
    await repo.saveReport(r.report); await repo.writeAudit(r.audit);
    send(res, 200, { report:r.report, audit:r.audit }); return true;
  }

  // ---- payout-KYC shell (DARK) ----
  if (path === "/payout/kyc" && m === "GET") {
    if (anon()) { send(res, 401, { error:"unauthenticated" }); return true; }
    send(res, 200, { ...await repo.getKyc(uid()), payments_live: false }); return true;
  }
  if (path === "/payout/kyc/start" && m === "POST") {
    if (anon()) { send(res, 401, { error:"unauthenticated" }); return true; }
    const row = await repo.setKycStatus(uid(), "pending", null);
    send(res, 200, { ...row, status:"dark_pending", note:"KYC provider session created when DK enables payments" }); return true;
  }

  // SSO note: federation (Apple/Discord/enterprise) is a FRONTEND concern — the gateway already
  // verifies whatever Supabase-JWT the provider issues, so there is NO backend route to add here.
  // The providers are enabled in Supabase + wired in web/auth-client.mjs (signInOAuth). Documented
  // so the integration owner knows the SSO half needs no gateway mount — only provider-enable.

  return false; // not a T&S/KYC route — let the gateway continue
}
