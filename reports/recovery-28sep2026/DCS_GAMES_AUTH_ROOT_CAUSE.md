# DCS Games — login / "bounced back out" root cause (28 Sep 2026)

**Founder report:** the user enters login/dashboard, then gets bounced or logged back out.

**Verdict:** there is not one bug. There are four defects, and together they produce exactly that experience.
- All four are in the static frontend (`dcs-games-LIVE`).
- The backend verifies Supabase JWTs correctly and was not changed.
- Guards were **not** disabled. The server is still the enforcement point for every authenticated call.

## Which build are we talking about?

| | Frontend | Backend |
|---|---|---|
| **Production** games.dcsai.ai | `efcb7c6` (6 Sep). Every sampled file is byte-identical to that commit, apart from Cloudflare's injected challenge script | `api.games.dcsai.ai`: older CW1/2/5/7 build with no V3 routes |
| **HEAD before this work** | `2cce536` (9 Sep), 34 commits never deployed. It contains the 7 Sep fix (`e6358d3`) | staging `e7d175f` |
| **This fix** | branch `fix/dcs-games-website-dashboard-recovery-28sep2026` | same branch; tests only |

Production is still running the auth code from **before** the 7 Sep fix. Everything below applies to production, and all of it except RC-0 applies to HEAD.

## RC-0 (production only, already fixed on HEAD 7 Sep): the auth listener deleted working sessions

- **Production defect:** the `assets/auth.js` served in production clears the token whenever `getSession()` is empty or `onAuthStateChange` fires `INITIAL_SESSION` with a null session.
  - Neither of those is a sign-out.
- **Fixed on HEAD in `e6358d3`, never deployed.** Pinned by `test/auth-session-continuity.test.mjs`.

## RC-1: the session was never refreshed on 186 of 191 pages

- **The token copy expires.** `dcsgames.token` is a *copy* of the Supabase access token, and it lives about an hour. Only supabase-js can mint the next one, using the refresh token it keeps under `sb-<ref>-auth-token`.
- **supabase-js was rarely loaded, and loaded late.** It came in through `auth.js` on **5 of 191 pages**.
  - Even on those five, it loaded from a CDN, **after** the page's inline script had already sent its API calls with whatever copy was in storage.
  - That is an auth-state hydration race.
- **What the person experienced:**
  1. Sign in and use the site.
  2. Come back after the hour, or the next day.
  3. The dashboard sends `/me/home`, `/me/streak` and the rest with an expired token. The server correctly answers 401.
  4. `player-home` says **"Your session has expired — Sign in again."** Meanwhile a perfectly valid refresh token sat in storage the whole time.

## RC-2: `/login` bounced a dead session straight back (the loop)

- **The check was storage-only.** `login.html` did `if (DCSAuth.isLoggedIn()) location.href = next;`, where "is logged in" meant "a token string is in localStorage".
- **The loop:**
  1. The "Sign in again" link from RC-1 lands on `/login?next=/player-home`, **still carrying the token the server just refused**.
  2. `/login` redirects straight back to the dashboard.
  3. The dashboard says "session expired" again.
- **Why it never ends:** after the 7 Sep change, nothing ever cleared a token except an explicit logout. So in HEAD this loop could not end on its own once the refresh token was also dead.
- **Two related gaps:**
  - `signup.html` had the same pattern.
  - `requireAuth()` also passed on the presence of the string alone.

## RC-3: the header said "Log in" to signed-in people

- **The check depended on `auth.js`.** `assets/site-chrome.js` swapped "Log in" for the account only `if (window.DCSAuth && …)`, and `window.DCSAuth` exists only where `auth.js` is loaded.
  - That was 5 of 73 marketing pages.
- **The home page was hard-coded.** `index.html` showed "Log in", plus an avatar reading **"OV"** for every visitor.
- **Effect:** a founder who signs in, then clicks Home, Explore or Community, is told to log in. That reads as "I was logged out", even though nothing was lost.

## RC-4: sign-out was either too wide or not real

- **Too wide.** `DCSAuth.logout()` called `supabase.auth.signOut()`. supabase-js v2 defaults to `scope: 'global'`, which **revokes every session the person has on every device**.
  - Signing out on a laptop logs the phone out at its next refresh.
- **Not real.** The V3 header's "Sign out" removed only the local token copy and left the Supabase session behind.

## Other auth-adjacent findings

| # | Finding | Status |
|---|---|---|
| A-1 | **Open redirect.** `?next=` was used unvalidated on login, the auth callback and Google OAuth. `/login?next=https://evil…` or `javascript:` were accepted | **Fixed**: `DCSAuth.safeNext()` accepts same-origin paths only (tested) |
| A-2 | Public API routes (`/v3/discover`, `/api/public/*`) answer **401 to any bad bearer**, so a dead session also blanked public feeds | **Mitigated in the frontend**: reads retry once anonymously. The backend behaviour is unchanged and recorded as a follow-up |
| A-3 | The beta-lock overlay on `/login`, `/studio` and `/cr-studio` (production host only) has a two-email allowlist and **"Sign in" that is not a sign-in**. It only lifts the overlay, and only for this tab (sessionStorage). The real sign-in follows, which reads as being bounced | Relabelled "On the beta list? … Continue". Whether production keeps this gate is a **founder decision** |
| A-4 | Production Supabase (`hznrmbxppcxrrrmyutjn`) has **anonymous sign-ins OFF** (public `/auth/v1/settings`), so "▶ Continue as guest" always fails on production | Not changed (a dashboard setting). **Founder decision** |
| A-5 | The Google OAuth redirect allowlist cannot be verified from outside: the `state` is opaque. If `https://games.dcsai.ai/auth-callback.html` is not allowlisted, Supabase falls back to the Site URL and the session never reaches `auth-callback` | **UNVERIFIED**. Check in the Supabase dashboard → Authentication → URL Configuration |
| A-6 | On HEAD, `login.html`'s staff email/password form was meant to show only on staging, but `#pwform{display:flex}` overrode `hidden`, so it rendered everywhere | **Fixed**: global `[hidden]{display:none!important}` |
| A-7 | Cookie scope, SameSite and Secure are not involved: auth is bearer-token in localStorage, and API calls use `credentials:"omit"` | n/a |
| A-8 | Staging and production separation is correct: `dcs-truth.js` pairs API and Supabase project by hostname, and the backend verifies the JWT `ref` | No change |

## The fix

`assets/dcs-truth.js` loads first on all 191 pages. It now owns the session:

- **`DCSTruth.freshToken()`** decides what token to send:
  - A token with more than 60 s left is used as-is, with no network and no CDN.
  - Otherwise `auth.js` is loaded, on **any** page, and supabase-js refreshes the token.
  - A token we cannot parse is left for the server to judge.
  - A copy whose own `exp` has passed, when no refresh is possible, is cleared. No server can accept it.
- **`DCSTruth.authFetch()`** is the single request path. It attaches a fresh token, and on a 401:
  1. forces **one** refresh and **one** retry;
  2. for a read that is still refused, retries once anonymously (see A-2).

  All six request wrappers now go through it: `T.call`, `dcs-live.js`, and the `create-v3`, `play-v3`, `history-v3` and `social-v3` wrappers.
- **`DCSAuth.verifiedSession()`** is what `/login` and `/signup` use before redirecting. It asks the server (`GET /me/profile`, after a refresh):
  - If the session is accepted, the person is sent on.
  - If it is refused, the session is ended **locally** and the form is shown with "Your previous session has ended."
- **`requireAuth()`** redirects immediately when there is no session at all. It then confirms a current token can be obtained, and sends a dead session to `/login?reason=expired` instead of rendering "expired" under a sign-in that would bounce.
- **Sign-out is `signOut({ scope: 'local' })` everywhere.** The V3 header and the new dashboard "Sign out" go through it too.
- **Header state comes from `DCSTruth.signedIn()`**, which is available on every page:
  - `site-chrome.js` and `index.html` use it.
  - The fake "OV" avatar is replaced with the person's own initials, and is shown only when signed in.
- **`auth.js` guards against double-loading.** Two supabase-js clients would race for the same single-use refresh token.
- **The 7 Sep rule is kept.** Nothing deletes a token the server accepts, and all six 7 Sep tests still pass.

## Regression proof

- **New file:** `test/auth-session-refresh.test.mjs` (9 tests), registered in `npm run test:browser`.
- **How it works:** supabase-js and the API are stubbed in the page. Tokens carry real `exp` values. Refresh takes 150 ms, as a network round trip would. A rejected refresh token emits SIGNED_OUT, as supabase-js v2 does.

| Test | Fixed tree | Baseline `2cce536` |
|---|---|---|
| LOGIN → DASHBOARD → PAGE REFRESH → NAVIGATE → RETURN: session remains valid | pass | **fail** |
| Expired access token + good refresh token: refreshed, not bounced | pass | **fail** |
| Page that never loaded auth.js still refreshes before use | pass | **fail** |
| Dead session goes to /login once, and /login does not send it back (the loop) | pass | **fail** |
| Token the server refuses is ended at /login, locally | pass | **fail** |
| Unexpired, server-accepted token is sent on from /login | pass | pass (control) |
| `?next=` only leads to a same-origin path | pass | **fail** |
| Header sign-out is local and stays ended | pass | **fail** |
| V3 header sign-out ends the Supabase session | pass | **fail** |

`test/auth-session-continuity.test.mjs` (the 7 Sep suite) is 6/6 on the fixed tree.

## Not yet proven, and needs a human

- **A real sign-in against staging Supabase.**
  - No staging credentials exist on disk, and creating a user is a write I did not make.
  - Founder or staff: sign in on a staging preview, wait over an hour (or set a short JWT expiry on staging), then reopen `/player-home`.
- **The Google OAuth allowlist (A-5).**
