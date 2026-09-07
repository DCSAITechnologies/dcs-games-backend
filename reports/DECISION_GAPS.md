# Product decisions that are not engineering gaps

Nine live routes have no user interface. **None of them is unfinished work.**
Each is a place where building the surface would require inventing product
behaviour that nobody has decided, and inventing it would be worse than leaving
the capability unreached.

They are recorded here separately from defects so that "unreached" is never read
as "forgotten", and so the founder can decide each one on its merits.

---

## 1. `POST /auth/login`, `POST /auth/signup`

**Why unwired:** the site authenticates through Supabase OAuth in
`assets/auth.js`. Wiring a second credential path would give the product two
ways to hold a password, two places for a session to be created, and two things
to keep in step.

**What these routes are for:** they are the honest not-configured path. On a
deployment without Supabase they answer 503 naming the missing variables, which
is what a developer running locally needs to see.

**The decision:** keep them as a machine/diagnostic surface, or retire them.
Not an engineering question.

## 2. `POST /v3/subscriptions/grant`, `POST /v3/subscriptions/revoke`

**Why unwired:** these comp a plan to *another* principal. A surface for that
needs a principal picker, and how a staff member is supposed to find and choose
a user — by email, by id, by search, with what audit — is a product decision
nobody has made.

**The risk of guessing:** a picker that searches by email quietly becomes a user
directory.

## 3. `GET /ts/reports`, `POST /ts/reports/:id/action`, `POST /ts/reports/:id/appeal/decide`

**Why unwired:** this is the LEGACY moderation console. `safety-v3.html` uses
the `/safety/*` equivalents, which are the ones that persist. Its store is no
longer written to since `POST /reports` was retired, so it can only ever return
an empty queue.

**The decision:** retire these routes, or migrate the appeal flow (which the
`/safety/*` set does not yet have) onto the live store. Building a second
moderation queue against a different slice would be worse than leaving one
unreached.

## 4. `GET /payout/kyc`, `POST /payout/kyc/start`

**Why unwired, and this one is a judgement worth stating plainly:** a KYC flow
collects identity documents. Payouts are dark and no payout has ever been made,
so this would ask real people for passports and addresses in service of a
payment that cannot happen.

**The decision:** this stays unbuilt until payments are genuinely being
activated. That is not a gap to close; it is a thing not to do yet.

---

## The one that WAS a gap, and is now closed

`POST /v3/marketplace/storefronts` was unwired because it was **write-only**:
`createStorefront` had a route and `storefrontsFor` had none, so a creator could
name a storefront and never see it again. There was nothing to render. The read
was added, the surface built, and it is proven in a browser against staging.

That is the difference this document exists to preserve: decisions, and one
defect that was wearing a decision's clothes.

**A correction to this document's own arithmetic.** An earlier revision closed
with "eight decisions". That was wrong: the four clusters above cover **nine**
unreached routes, and storefronts — the defect — was a tenth that is now wired.
Nine routes, four decisions, one closed defect.


---

# Classification — what each decision blocks

Requested by the founder for acceptance closure. Each row states the exact
decision, what the system does today in the absence of an answer, what goes
wrong if it is never answered, and one of:

- `BLOCKS_CLOSED_BETA` — must be answered before testers are let in
- `BLOCKS_PRODUCTION_ONLY` — closed beta is fine without it; production is not
- `NON_BLOCKING_FUTURE` — neither gate depends on it

**No decision below has been made on the founder's behalf.** The classification
is about consequence and timing only.

## 1. `POST /auth/login`, `POST /auth/signup` — `NON_BLOCKING_FUTURE`

**Exact decision:** keep email/password auth as a machine and diagnostic
surface, or retire the two routes.

**Current default:** live and functional. Staging has Supabase configured, so
they proxy GoTrue and return a real access token. No page references them. On a
deployment without Supabase they answer 503 naming the missing variables, which
is what a developer running locally needs to see.

**Risk if unanswered:** `POST /auth/signup` lets anyone create an account in the
staging Supabase project without an invitation. The account is **inert** —
authorization is the internal-tester allowlist, and all thirty builder routes
sit behind `mustBeInternalTester` — so this is not a privilege path. It is an
unpoliced write into the auth store, and a second place a session can be
created if the site ever grows a password form.

**Why not blocking:** access is decided by the allowlist, not by whether an
account exists. This becomes `BLOCKS_CLOSED_BETA` only if "closed" is defined
at the account level rather than the allowlist level — which is precisely the
decision.

## 2. `POST /v3/subscriptions/grant`, `POST /v3/subscriptions/revoke` — `BLOCKS_PRODUCTION_ONLY`

**Exact decision:** how a staff member finds and chooses the principal being
comped — by email, by id, by search — and what audit trail that leaves. Or:
keep it API-only with no surface at all.

**Current default:** API-only, no UI, and tightly bounded in code: only an
internal tester may grant, only an internal tester may **receive** (a customer
cannot be comped, because a customer cannot be billed for it), a grant must
carry an expiry, and no grant may outlive the internal window.

**Risk if unanswered:** any internal tester can comp any other internal tester.
With payments dark nothing is billed and no money moves, so the exposure today
is entitlement noise, not revenue. The moment payments are real, "who may comp,
and where is that recorded" is an auditing question with a financial answer.

**And the reason a picker was not simply built:** a picker that searches by
email quietly becomes a user directory.

### 2b. The window constant — `BLOCKS_CLOSED_BETA` *if the beta runs past 2026-09-30*

Surfaced while classifying the above; it is a dated fact, not an opinion.

`INTERNAL_WINDOW_ENDS = "2026-09-30"` (`src/core/subscriptions.mjs:40`) bounds
every comped grant. After that date `grantTestPlan` **refuses to issue one**
(*"a test grant cannot outlive the internal window"*) and existing grants stop
being live. It is one constant, and changing it is a founder decision about how
long the window runs — not an engineering fix to make unasked.

Access itself is NOT affected: `mustBeInternalTester` has no date logic, so the
allowlist keeps working. There is no time bomb on sign-in. Only comped plans
lapse.

**As of 7 Sep 2026 that is 23 days away.**

## 3. `GET /ts/reports`, `POST /ts/reports/:id/action`, `POST /ts/reports/:id/appeal/decide`

This cluster splits, and reporting it as one verdict would hide the half that
matters.

### 3a. Retiring the legacy console — `NON_BLOCKING_FUTURE`

**Exact decision:** delete the three legacy routes, or leave them dormant.

**Current default:** live but unreachable and unfed. `safety-v3.html` uses the
`/safety/*` equivalents, which are the ones that persist. The legacy store has
not been written since `POST /reports` was retired, so these can only ever
return an empty queue.

**Risk if unanswered:** three routes that answer, do nothing, and will confuse
the next person to read the route table.

### 3b. The missing appeal path — `BLOCKS_PRODUCTION_ONLY`

**Exact decision:** migrate the appeal flow onto the live `/safety/*` store, or
accept that a moderated user has no in-product way to contest a decision.

**Current default:** the only appeal endpoint that exists is on the dead legacy
store. The live `/safety/*` set has moderation and history but **no appeal**.

**Risk if unanswered:** in closed beta a moderated tester can reach the founder
directly, so the gap is survivable. In public production, moderating a user with
no route to contest it is a fairness problem and, depending on jurisdiction and
user age, potentially a compliance one.

## 4. `GET /payout/kyc`, `POST /payout/kyc/start` — `NON_BLOCKING_FUTURE`

**Exact decision:** when to build the KYC flow.

**Current default:** unbuilt. Payouts are dark; no payout has ever been made.

**Risk if unanswered:** none while payouts are dark. The risk runs the other
way — building it now would ask real people for passports and addresses in
service of a payment that cannot happen.

**Precondition, stated exactly:** this becomes blocking at **payment
activation**, which is a separate gate from both closed beta and a plain
production deploy with `PAYMENTS_LIVE=false`.

---

## Two further decisions this closure surfaced

Not part of the four above. Recorded here so they are not lost.

### 5. The eleven disabled builder controls — `BLOCKS_CLOSED_BETA`

**Exact decision:** do eleven visibly disabled controls naming a route that does
not exist read as honesty, or as a broken product?

**Current default:** shown, disabled, and honest about why.

**Risk if unanswered:** this is the first thing a tester touches and the item
most likely to produce "the product is broken" as a verdict when the truthful
reading is "the product is candid". It cannot be settled by engineering because
both readings are defensible — it needs a person to look, which is why it also
appears in `HUMAN_ACCEPTANCE_CHECKLIST.md` under `HUMAN_VISUAL_REQUIRED`.

**Why `BLOCKS_CLOSED_BETA`:** unlike the others, testers will encounter it in
the first minute of the session the beta exists to run.

### 6. `games.dcsai.ai` runs an older public build — `BLOCKS_PRODUCTION_ONLY`

**Exact decision:** when the sprint build is promoted to the public production
frontend, and with what rollback.

**Current default:** untouched, exactly as instructed. The production domain
serves a build that predates this sprint — it has no `assets/dcs-truth.js` (the
request falls back to `index.html`), so the truth layer and the environment
resolver are not on it, and it answers `200` for paths that do not exist where
the preview correctly answers `404`.

**Risk if unanswered:** none to closed beta, which runs entirely on the preview
host. It is listed so that "production is fine" is never inferred from "staging
is green" — they are different builds.
