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

That is the difference this document exists to preserve: eight decisions, and
one defect that was wearing a decision's clothes.
