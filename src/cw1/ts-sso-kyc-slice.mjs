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

  // ---- file a report — RETIRED. It was a second set of books for moderation. ----
  //
  // POST /reports wrote into the CW1 repo, which server.mts:422 constructs as
  // `{ mode: "memory" }` unconditionally — a process-local map, whatever the
  // deployment is configured with. src/core/safety.mjs serves the SAME concept
  // durably at POST /safety/report. Reproduced 7 Sep 2026 against a booted
  // server, one run, one principal:
  //
  //   POST /reports {target_id:"user-b",reason:"harassment"}
  //     -> 200 {"id":"rpt_1788...","state":"open"}
  //   POST /safety/report {subject_type:"user",subject_id:"user-b",reason:"harassment"}
  //     -> 201
  //   GET  /safety/reports        -> 200, count 1 — only the durable one
  //   GET  /ts/reports            -> 403 moderator_only
  //   POST /safety/reports/rpt_1788.../moderate -> 404 "report ... not found"
  //
  // So a report filed here reaches NOBODY. The durable queue cannot see it. The
  // legacy queue below is moderator-only and isModerator can never be true for a
  // real principal — the memory repo's getUser returns null for any id that is
  // not one of its three seeded fixtures, and the gateway user object carries no
  // moderator flag — so nothing in the estate can read these rows, and a restart
  // erases them. That is the write-only store POST /teams was retired for,
  // holding moderation reports.
  //
  // Two things make it worse than the social duplication was:
  //
  //   * it does not validate `reason`. `reason:"lol"` is stored; /safety/report
  //     refuses it against the enum.
  //   * `reason:"csam"` is accepted and answered 200 with state "open".
  //     safety.report() escalates csam, grooming and self_harm immediately —
  //     state "under_review", severity "critical", and a SAFETY_ESCALATION line
  //     on stderr saying to route it to the designated safety contact and, where
  //     applicable, the relevant authority. Filed here, a child-safety report
  //     produces a 200, a report id, no escalation, no log, no reader, and is
  //     gone at the next deploy.
  //
  // Retired the way the duplicated social routes were: 410 naming the durable
  // surface, so a client still on this path is told where to file rather than
  // being handed a receipt for a report nobody will ever see.
  if (seg[0] === "reports" && m !== "OPTIONS") {
    const appealing = seg[2] === "appeal";
    send(res, 410, {
      ok: false, error: "gone",
      detail: appealing
        // Honest about the gap: there is no durable appeal route to point at.
        // Naming one that does not exist would repeat the mistake that made the
        // /verify retirement swallow its own replacement.
        ? "this appealed against reports held in a process-local map that no route could read and a restart erased; that store is retired. There is no durable appeal surface yet — what exists is POST /safety/reports/:id/moderate for a moderator decision and GET /safety/moderation-history for the audit trail"
        : "this filed moderation reports into a process-local map that the durable moderation queue could not see, no route could read, and a restart erased; it also accepted any reason string and did not escalate csam, grooming or self_harm. Use POST /safety/report, which validates the reason, escalates the critical ones immediately and is readable at GET /safety/reports",
      superseded_by: appealing ? "/safety/reports/:id/moderate" : "/safety/report",
    });
    return true;
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

  // ---- actioned user appeals — RETIRED with the store it appealed against.
  // Handled by the guard above, which keys on the whole /reports/* prefix so a
  // sub-path cannot quietly reach back into the map.

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
