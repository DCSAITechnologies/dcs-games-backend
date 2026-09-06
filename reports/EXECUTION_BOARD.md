# DCS Games — overnight closure execution board (7 Sep 2026)

Governing order: `DCS_GAMES_OVERNIGHT_AUTONOMOUS_FULL_CLOSURE_ORDER_07SEP2026.md`.
Staging only. Production out of scope. `PAYMENTS_LIVE=false`. `0002_seed.sql` never executed.

## Ownership rules
- **Lead only**: `server.mts`, `migrations/**`, `scripts/deploy-staging.sh`, all
  Railway deploys, all Cloudflare actions, `reports/**`.
- Agents never edit another lane's files. A cross-lane defect is reported to
  Lead, not edited concurrently.
- Never weaken an assertion to get green. Never skip to hide a failure.

## Lanes

| Lane | Owner | Scope | Files owned | Status |
| --- | --- | --- | --- | --- |
| Lead | Lead | frontend↔staging wiring, Cloudflare preview, deploys, evidence | server.mts, migrations, reports, scripts/deploy-* | ACTIVE |
| A | agent | V2 closure / legacy compatibility | src/cw1–cw7, test/cw1-identity, marketplace, subscriptions, social-discovery, verification | ACTIVE |
| B | agent | V3 world systems + B4 adversarial | src/v3/** , test/playtest, evolution, manifest-v3, runtime-v3, npc-memory, world-diff, world-rollback, fork, stitch | ACTIVE |
| C | agent | security / auth / persistence adversarial | src/core/**, test/security-regression, route-authz, auth-principal, supabase-paths, world-persistence, collection | ACTIVE |
| D | agent | browser / mobile / a11y / perf / netcode | test/browser-compat, a11y-pages, frontend-truth, runtime-perf, load-smoke, smoke-gate | ACTIVE |

## Closed before this board opened
- B4 repair/finding gap closed structurally (8 orphan fixes, UNREPAIRABLE registry)
- Staging deploy provenance (`deployment_id` verified before any deploy is claimed)
- Phase 5 + 6: 42/42 real remote staging proofs — `reports/STAGING_PROOFS.md`
