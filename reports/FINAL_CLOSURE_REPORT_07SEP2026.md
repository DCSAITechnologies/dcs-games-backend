# DCS Games — final defect-closure report, 7 September 2026

Written at the end of the closure pass triggered by a founder-observed defect:
*"after login, clicking Play Game can sign the user out."*

Everything below was measured against the staging preview and the staging
Railway backend. Production was not touched.

---

## 1. The founder-observed defect

**Reproduced: yes, deterministically, before any change was made.**

### The evidence, captured first

With an access token the staging server **accepts** — `curl` to `/me/profile`
returned HTTP 200 with that exact token — loading `/player-home` emptied
localStorage completely:

```
token length before navigating to /player-home: 816
t≈0ms    {"tok":0,"keys":[],"path":"/player-home","hasSupabaseLib":true,
          "api":"…backend-staging.up.railway.app","supa":"…nemmayskbjugulrncufd.supabase.co"}
t≈7000ms {"tok":0,"keys":[], …}
console errors: []
```

- originating URL: `/` on the preview, token written to `dcsgames.token`
- destination URL: `/player-home` — no redirect, no console error, no failed request
- environment resolution: correct (staging API, staging Supabase)
- auth storage keys: `dcsgames.token` written by `assets/auth.js` and read by
  `assets/dcs-truth.js` — **they match**; this was not a key mismatch
- the token was not expired, not malformed, and not rejected by anything

The page deleted a credential the server had not rejected.

### Root cause

`assets/auth.js`, both halves, treated *"I cannot see a Supabase session right
now"* as *"the user has signed out"*:

```js
sync():            if (s) setTok(s.access_token); else { setTok(null); setUser(null); }
onAuthStateChange: if (s) setTok(s.access_token); else { setTok(null); setUser(null); }
```

An empty `getSession()` is not a sign-out. It is equally what you get from an
expired or revoked refresh token, a Supabase hiccup, storage the browser
evicted, and supabase-js firing `INITIAL_SESSION` with a null session before it
has hydrated.

Only five pages load `auth.js` — `player-home`, `login`, `signup`,
`auth-callback`, and one studio page. Every other page in the journey merely
*reads* `dcsgames.token`. So the session died on player-home and the symptom
surfaced one click later:

1. `/player-home` wipes the token. The page still renders, because
   `requireAuth()` had already passed synchronously; its API calls then 401 and
   the hero switches to *"Your session has expired"*.
2. The **Open / Play** control goes to `/play-v3`, which reads the same key,
   finds nothing, and says *"You need to sign in to open this world"*.
3. Returning to `/player-home` now fails `requireAuth()` and redirects to
   `/login`. **Signed out, having touched nothing but a play button.**

The play button was never the bug. It was the first thing that needed the
credential that player-home had already destroyed.

### Fix

`sync()` adopts a session and never destroys one. `onAuthStateChange` clears
only on `SIGNED_OUT` and `USER_DELETED`. `logout()` is unchanged.

Clearing local storage was never the security control: the server verifies the
JWT on every call and answers 401 when it is bad, and the UI already reads that
401 honestly. Deleting a token the server accepts protects nothing and loses the
session.

Frontend commit `e6358d32520c59aab628a38b265b92e33e6fb99f`.

### Regression evidence

`test/auth-session-continuity.test.mjs` — hermetic, supabase-js stubbed, so it
asserts the behaviour rather than the network.

| | before the fix | after |
| --- | --- | --- |
| a page that cannot see a Supabase session must not delete an accepted token | **FAIL** | PASS |
| the same is true of every page that loads auth.js | **FAIL** | PASS |
| an explicit SIGNED_OUT event MUST still clear the session | PASS | PASS |
| a visible Supabase session is still copied into the local token | PASS | PASS |

The last two exist so the fix cannot degrade into *"nobody can ever log out"*.

Then, against the **deployed** preview: the same repro that emptied localStorage
now shows `tok=816` at every sample from 0ms to 7000ms.

And the journey itself, `scripts/acceptance-journey.mjs` — **19/19, run three
times consecutively with no flake** — asserting the token at *every hop*, because
a journey that ends signed in tells you nothing about whether it was signed in
throughout: player home → Open → play → back → reload → **new tab** → sign out.

---

## 2. Every other defect found in this pass

| # | defect | severity | status |
| --- | --- | --- | --- |
| 1 | `/player-home` deletes a session the server accepts; Play then appears to sign the user out | **P1** | **FIXED** — commit `e6358d3` |
| 2 | `/me/home` + `/me/achievements` read up to 250 full world manifests to use five fields the summary card already carries | **P2** | **FIXED** — commit `e893233` |
| 3 | `scripts/deploy-staging.sh` verified HEAD against the PUBLIC origin, whose sprint branch was deliberately deleted — the guard could only be satisfied by re-publishing the history it exists to protect | **P2** | **FIXED** — commit `cdb48c6` |
| 4 | `scripts/acceptance-journey.mjs` flaked on a fixed 5s sleep while player-home took 4.3–4.9s to render | **P3** | **FIXED** — bounded condition wait; the flake was measuring defect 2 |
| 5 | Google OAuth and anonymous sign-in are both disabled on the staging Supabase project, and they are the only two ways `login.html` offers | **P1, not engineering** | **OPEN — founder console action** |
| 6 | `DCS_INTERNAL_TESTERS` holds exactly one address; thirty builder routes sit behind it | **P1, not engineering** | **OPEN — founder console action** |
| 7 | `loadProfile` clears the cached user on any non-OK response, including a transient 5xx | **P3** | **OPEN** — cosmetic only (the account menu reads "Account"); it cannot end a session |
| 8 | one run of `staging-proofs.mjs` reported 41/42 in the first minutes after the deploy; the assertion was not captured, and five consecutive runs since are 42/42 | **unclassified** | **OPEN, unreproduced** — recorded rather than dismissed |

Defect 2's measurement, before and after, on the same account:

```
                      before                        after
/me/achievements   3259ms 4171ms 3722ms   →   1873ms 1792ms 1792ms
/me/home           3166ms 2593ms 2461ms   →   1440ms 1129ms 1283ms
player-home hero   4906ms 4714ms 4316ms   →   2826ms 2308ms 2320ms
```

The page was **honest** while it waited — tag "Loading…", title an em dash, no
invented values — so this was slow, never untruthful.

---

## 3. Backend safe-bank SHA

```
local HEAD   cdb48c6d3a47cf60e52f9dc5bb3ff770ff3eaad9
bank         bank/sprint/2026-09-canonical
remote       https://github.com/DCSAITechnologies/dcs-games-backend-sprint-sep2026.git
```

## 4. Frontend SHA

```
local HEAD   e6358d32520c59aab628a38b265b92e33e6fb99f
origin/main  e6358d32520c59aab628a38b265b92e33e6fb99f   (private frontend repo)
```

## 5. Staging deployment IDs

| what | id | commit |
| --- | --- | --- |
| Railway staging | `b167fa26-ea5d-4cf4-8b47-7b0cce96b3ac` | `e893233a` |
| Cloudflare Pages preview | `767fd058` (alias `sprint-preview-07sep2026`) | `e6358d32` |

`/health` at the time of writing: `ok:true`, `payments_live:false`, schema
**v13** asserted against v13 required, `runtime_state_store: supabase, durable`,
**0 alerts**.

## 6. Full test totals

Re-run after **both** fixes. Zero failures, **zero skips at every stage**.

| suite | tests | pass | fail | skipped |
| --- | ---: | ---: | ---: | ---: |
| `test:unit` | 1109 | 1109 | 0 | 0 |
| `test:unit:tsx` | 69 | 69 | 0 | 0 |
| `test:api` | 126 | 126 | 0 | 0 |
| `test:browser` | 102 | 102 | 0 | 0 |
| `test:e2e` | 12 | 12 | 0 | 0 |
| `test:load` | 6 | 6 | 0 | 0 |
| **total** | **1424** | **1424** | **0** | **0** |

`test:unit` gained one (the `listOwnedCards` invariant); `test:browser` gained
four (the auth-session-continuity regression).

## 7. Browser and deployed-acceptance totals

Every one of these is an assertion against **deployed** infrastructure.

| suite | result |
| --- | --- |
| V3 flagship + persistence, deployed (`staging-proofs.mjs`) | **42 / 42** |
| V2 surface (`staging-v2-proof.mjs`) | **20 / 20** |
| Atlas provenance, verified trustlessly (`staging-atlas-proof.mjs`) | **16 / 16** |
| Remote security posture (`staging-security-probe.mjs`) | **35 / 35** |
| Concurrency under load (`staging-load-proof.mjs`) | **26 / 26** |
| Frontend↔staging in a real browser (`preview-integration-proof.mjs`) | **42 / 42** |
| Session and gate honesty (`acceptance-session.mjs`, Chromium) | **16 / 16** |
| **The founder journey (`acceptance-journey.mjs`, Chromium)** | **19 / 19** |
| Real WebKit (`acceptance-engines.mjs`) | **22 / 22** |
| Real Gecko (`acceptance-engines.mjs`) | **22 / 22** |
| WebKit at iPhone width, touch on (`acceptance-engines.mjs`) | **8 / 8** |
| Safari.app via safaridriver (`acceptance-webkit.mjs`) | **NOT RUN — exit 2** |

**268 assertions against deployed infrastructure, 0 failures.**

Netcode anti-cheat (**186 checks, 0 failures**) was NOT re-run in this pass: the
netcode repository is unchanged at the pinned ref `49f103531b67`, and
`scripts/verify-ci-pins.mjs` still resolves it.

`acceptance-webkit.mjs` exits **2** — never 0 — while
`Safari → Develop → Allow Remote Automation` is off, so an engine that did not
run can never be mistaken for one that passed.

## 8. Human-only remaining items

Full five-way split in `reports/HUMAN_ACCEPTANCE_CHECKLIST.md`; the step-by-step
script is `reports/FOUNDER_TEST_SCRIPT.md`.

- **HUMAN_VISUAL_REQUIRED** — does an em dash read as "we don't know" or as
  broken; does "the marketplace is dark" read as honest or as an outage; do the
  eleven disabled builder controls read as candour or breakage; does the build
  look trustworthy.
- **HUMAN_INTERACTION_REQUIRED** — the journey performed by someone who has not
  seen the code; does the generated world *feel* like what was described; is the
  companion's answer *useful* rather than merely grounded; is a playtest refusal
  actionable to a non-engineer.
- **PHYSICAL_DEVICE_REQUIRED** — a real iPhone (Safari chrome, ITP evicting
  `localStorage`, the on-screen keyboard) and a real mid-range Android handset
  (touch latency, GPU). The WebKit and Chromium *engines* are proven; the
  handsets are not.
- **ACCESSIBILITY_HUMAN_REQUIRED** — VoiceOver/NVDA through the journey, and
  whether labels make sense *read aloud, in order*. VoiceOver.app is installed
  here but is GUI-only with no scriptable output API.
- **Safari.app** — one GUI toggle away from being automated, see §7.

No engineering defect has been parked in this bucket.

## 9. Product-decision-only items

Classified in `reports/DECISION_GAPS.md`; none is an engineering defect and none
was decided here.

| item | verdict |
| --- | --- |
| the eleven disabled builder controls | `BLOCKS_CLOSED_BETA` |
| `INTERNAL_WINDOW_ENDS = 2026-09-30`, if the beta runs past it | `BLOCKS_CLOSED_BETA` |
| `/v3/subscriptions/grant` + `/revoke` — who may comp, with what audit | `BLOCKS_PRODUCTION_ONLY` |
| the missing appeal path on the live `/safety/*` store | `BLOCKS_PRODUCTION_ONLY` |
| `games.dcsai.ai` promotion and its rollback | `BLOCKS_PRODUCTION_ONLY` |
| `POST /auth/login` + `/auth/signup` — keep as diagnostic, or retire | `NON_BLOCKING_FUTURE` |
| the legacy `/ts/reports*` console — retire or leave dormant | `NON_BLOCKING_FUTURE` |
| `/payout/kyc*` — blocking only at payment activation | `NON_BLOCKING_FUTURE` |

## 10. Production-only blockers

1. Who may comp a plan, and with what audit trail.
2. The missing appeal path — a moderated user has no in-product way to contest.
3. Promotion of `games.dcsai.ai`, which still runs a build predating this sprint
   (it has no `assets/dcs-truth.js` and answers 200 for paths that do not
   exist), plus its rollback plan.
4. Payment activation, which gates KYC and is explicitly out of scope.

## 11. Rollback proof

- Every commit is on the private bank; nothing exists only on this laptop.
- `reports/DEPLOYMENTS.md` maps every Railway deployment id to its commit, and
  `scripts/deploy-staging.sh` refuses to write a row unless the live service
  reports the deployment id it just created.
- The immediately previous staging deployment is
  `315cce74-477c-440a-8e90-2dd5fe342727` at commit `c94e39649b4e`. Rolling back
  is a redeploy of that commit; nothing in this pass changed the schema
  (**still v13**), so no migration has to be undone.
- The immediately previous Cloudflare preview is `774ddbad-…` at frontend
  `03e8e1f8`, reachable at `https://774ddbad.dcs-games.pages.dev` and
  redeployable by alias.
- `main` and `recovery/prod-schema-lineage` on the public origin are untouched.

## 12. Secret scan

```
RESULT: CLEAN — 422 file(s) read across 2 root(s), no credential found.
```

Roots: the backend repo and `dcs-games-LIVE`.

## 13. Public sprint branch absence

```
$ git ls-remote origin
e979d87b26c1ef15f245232c3a218be8b7f7904f  HEAD
e979d87b26c1ef15f245232c3a218be8b7f7904f  refs/heads/main
9937f2247c455d722852bceedd8a88dd4d08a0a3  refs/heads/recovery/prod-schema-lineage

$ git ls-remote --tags origin | wc -l
0
```

**`sprint/2026-09-canonical` is absent from the public origin and was not
recreated.** The deploy guard that used to require it there has been repointed
at the private bank (defect 3).

## 14. Readiness verdict

```
V3_VERTICAL_SLICE_PROVEN
```

Unchanged, and not promoted here. The engineering blockers found in this pass
are fixed and regression-guarded; what stands between this and
`CLOSED_BETA_CANDIDATE` is two staging console settings and then human
acceptance.

---

# Restart information for a fresh session

Everything a new session needs, without relying on this conversation.

## Where things are

| | |
| --- | --- |
| backend repo | `/Users/NEWUSER/Desktop/Project DCSAI/dcs-games-6month-deploy/gb` |
| frontend repo | `/Users/NEWUSER/Desktop/Project DCSAI/dcs-games-LIVE` |
| private bank remote | `bank` → `dcs-games-backend-sprint-sep2026` (branch `sprint/2026-09-canonical`) |
| public origin | `origin` → `dcs-games-backend`. **Never push the sprint branch here.** |
| staging frontend | `https://sprint-preview-07sep2026.dcs-games.pages.dev` |
| staging backend | `https://dcs-games-backend-staging.up.railway.app` |
| staging Supabase | project `nemmayskbjugulrncufd` |
| production (DO NOT TOUCH) | `games.dcsai.ai`, `api.games.dcsai.ai`, Supabase `hznrmbxppcxrrrmyutjn` |

## Standing constraints

`PAYMENTS_LIVE=false`. Never run `0002_seed.sql`. No production deploy,
migration, promotion or payment activation. No force-push, no history rewrite.
Do not recreate the public sprint branch. Never print secret values.

## How to get a staging token (the automation identity)

Tokens last one hour. Mint a fresh one through Railway so the service-role key
never leaves the environment:

```
railway run -- node -e '
  const fs=require("fs");
  const SUPA=(process.env.SUPABASE_URL||"").replace(/\/$/,"");
  const SR=process.env.SUPABASE_SERVICE_ROLE_KEY, AN=process.env.SUPABASE_ANON_KEY||SR;
  const email=(process.env.DCS_INTERNAL_TESTERS||"").split(",")[0].trim();
  (async()=>{
    const g=await fetch(SUPA+"/auth/v1/admin/generate_link",{method:"POST",
      headers:{apikey:SR,Authorization:"Bearer "+SR,"Content-Type":"application/json"},
      body:JSON.stringify({type:"magiclink",email})});
    const gj=await g.json();
    const th=gj.hashed_token||(gj.properties&&gj.properties.hashed_token);
    const v=await fetch(SUPA+"/auth/v1/verify",{method:"POST",
      headers:{apikey:AN,"Content-Type":"application/json"},
      body:JSON.stringify({type:"magiclink",token_hash:th})});
    const s=await v.json();
    fs.writeFileSync("/tmp/stage.jwt", s.access_token);
  })();'
```

## How to run everything

```
npm run test:unit && npm run test:unit:tsx && npm run test:api \
  && npm run test:load && npm run test:browser && npm run test:e2e

JWT_PATH=/tmp/stage.jwt npm run acceptance:journey    # the founder journey, 19
JWT_PATH=/tmp/stage.jwt npm run acceptance:session    # session + gates, 16
PW_CORE=<playwright-core path> JWT_PATH=/tmp/stage.jwt npm run acceptance:engines   # WebKit + Gecko + phone, 52
JWT_PATH=/tmp/stage.jwt npm run acceptance:webkit     # Safari.app; exits 2 until the GUI toggle

STAGE_JWT=… OTHER_JWT=… PRIOR_WORLD=… PRIOR_HASH=… node scripts/staging-proofs.mjs
railway run -- node scripts/staging-security-probe.mjs
node scripts/secret-scan.mjs . ../../dcs-games-LIVE
```

`acceptance-engines.mjs` needs `playwright-core@1.61.0` — the release whose
pinned WebKit (2311) and Gecko (1532) revisions match the browsers already
cached on this machine, so nothing downloads. It is deliberately NOT a
dependency of this repo: adding it would change `npm ci` and the cold-rebuild
proof for a check that is not part of the build.

```
npm install --prefix /tmp/pw playwright-core@1.61.0
PW_CORE=/tmp/pw/node_modules/playwright-core node scripts/acceptance-engines.mjs
```

## How to deploy staging

```
./scripts/deploy-staging.sh      # refuses unless HEAD is on the private bank
wrangler pages deploy . --project-name dcs-games --branch sprint-preview-07sep2026
```

## What to do next

1. **Founder console, blocking:** enable Google (or anonymous sign-ins) on the
   staging Supabase project and add
   `https://sprint-preview-07sep2026.dcs-games.pages.dev/auth-callback.html`
   to the redirect allowlist; confirm the founder's own account is in
   `DCS_INTERNAL_TESTERS` (`railway variables`, Staging environment).
2. Run `reports/FOUNDER_TEST_SCRIPT.md`.
3. If the human session finds nothing a real user would call broken, the
   evidence supports `CLOSED_BETA_CANDIDATE`.
