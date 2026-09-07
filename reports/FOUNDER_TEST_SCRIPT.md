# Founder human-acceptance test script

The shortest script that still covers everything no machine can check. Every
step states the expected PASS. Anything else is a defect: write it down with the
page, the device and the engine.

**Use this URL and no other:**

    https://sprint-preview-07sep2026.dcs-games.pages.dev

That host resolves to the staging Supabase project and the staging Railway
backend — asserted from inside Chromium, WebKit and Gecko, so any account you
create is a staging account by construction. `games.dcsai.ai` is the PUBLIC
PRODUCTION frontend running an older build. Do not use it.

---

## PRE-FLIGHT — two console settings, or the session cannot start

Both were found by inspecting the deployed state, not assumed. Neither is a code
change and neither is something engineering should decide.

### P1. Sign-in is not enabled on the staging Supabase project

`login.html` offers exactly two ways in: **Continue with Google** and
**Continue as guest** (Supabase anonymous sign-in). The staging project has both
switched off:

    GET https://nemmayskbjugulrncufd.supabase.co/auth/v1/settings
      → "google": false,  "anonymous_users": false,  "email": true

    GET .../auth/v1/authorize?provider=google  → HTTP 400

**As it stands, a human cannot sign in through the staging UI at all.** Every
automated proof authenticates with a token minted directly against Supabase, so
the suites are green and the button has never been pressed by anything.

**Fix (Supabase dashboard → staging project `nemmayskbjugulrncufd`):**
- Authentication → Sign In / Providers → enable **Google** (client id + secret),
  **or** enable **Allow anonymous sign-ins** for the guest path.
- Authentication → URL Configuration → add the redirect URL
  `https://sprint-preview-07sep2026.dcs-games.pages.dev/auth-callback.html`.

**Expected PASS afterwards:** `/auth/v1/settings` reports `"google": true`, and
the authorize URL above returns a redirect rather than 400.

### P2. The internal-tester allowlist has exactly one entry

Thirty builder routes sit behind `mustBeInternalTester`. On staging,
`DCS_INTERNAL_TESTERS` is set and contains **one** address — a gmail.com account
which is the identity every automated proof authenticates as, and which is **not
the account this workstation is signed in as**. Sign in as any other account and
every builder surface answers 403.

Read the value yourself with `railway variables` in the Staging environment (it
is not reproduced here). Then either sign in as that account, or add yours.

**Expected PASS:** after signing in, `/create-v3` shows the builder rather than
the internal-testing refusal.

---

## THE SCRIPT

### Getting in

1. **Open `/create-v3` in a private window, signed out.**
   PASS: the page explains that this is limited to authorized internal testers.
   It does not show a working builder, an empty page, or a fabricated identity.

2. **Go to `/login`, press Continue with Google, complete Google sign-in.**
   PASS: you land on `/player-home` signed in, with your own name or handle —
   not a placeholder.

3. **Reload the page. Then close the tab, reopen the URL.**
   PASS: still signed in both times.

### The flagship journey — the part only a person can judge

4. **`/create-v3` → describe a world in your own words. Generate.**
   PASS: it finishes and tells you it finished.
   **JUDGEMENT — the one that matters most:** does the world you get feel like
   the thing you described? Automation proves a world was produced. It cannot
   tell you it was the right one.

5. **Enter the world and play it.**
   PASS: it loads and is playable. On a laptop the 3D runtime holds a usable
   frame rate.

6. **Save, leave to `/player-home`, then come back into the world.**
   PASS: you get back exactly what you left, not a fresh generation.

7. **Ask the companion something specific about this world.**
   PASS: the answer names a real place from your world.
   **JUDGEMENT:** was it worth reading, or merely correct? Grounded is proven;
   useful is not.

8. **Edit the world by describing a change in chat.**
   PASS: the change is applied and a new version appears — the old one is not
   overwritten.

9. **Expand the world.**
   PASS: new content, recorded as another version.

10. **Run a playtest. If it refuses, read the refusal.**
    PASS: it reports a verdict.
    **JUDGEMENT:** if refused, is the reason actionable to someone who is not an
    engineer? "Invalid manifest" is a failure of this step even though the gate
    worked.

11. **`/history-v3` → roll back to version 1.**
    PASS: the world returns to its original content, and the rollback is
    recorded as a NEW version rather than erasing the history.

12. **Publish the world. Then open it in a private window, signed out.**
    PASS: an anonymous visitor can load it. Before publishing, they could not.

13. **`/profile-v3` → find the world in your own list.**
    PASS: it is there, newest first, at the version you expect.

### Reading the honest surfaces — look, do not click

14. **Find a metric rendered as an em dash (—).**
    PASS: it reads as *"we don't know this yet"*.
    FAIL: it reads as broken.

15. **Find the marketplace and the "dark" notice.**
    PASS: a reader understands nothing is for sale yet.
    FAIL: it reads as an error or an outage.

16. **Find the eleven disabled builder controls naming routes that do not
    exist.**
    PASS: reads as honesty about what is not built yet.
    FAIL: reads as a broken product.
    **This is a product decision, not a defect** — see `DECISION_GAPS.md` §5.
    Record which way it reads to you; that is the answer.

### Real hardware — no emulation substitutes

17. **Open the site on a real iPhone in Safari. Sign in, open the builder, type
    into a text field.**
    PASS: nothing overflows sideways; the on-screen keyboard does not cover the
    field you are typing into; the session survives (Safari's tracking
    prevention can evict `localStorage`, and only a real iPhone shows that).

18. **Open it on a real Android handset in Chrome. Enter a world.**
    PASS: touch responds without noticeable lag; the 3D runtime is usable on a
    mid-range GPU.

### Assistive technology — needs a person who uses one

19. **Turn on VoiceOver (or NVDA) and go: sign in → describe → generate → play
    → publish, without looking at the screen.**
    PASS: every control announces something that makes sense **in the order it
    is read**. Labels exist — that is proven. Whether they are comprehensible
    aloud is what you are testing.

20. **Tab through `/player-home` and `/create-v3` with the keyboard only.**
    PASS: focus is always visible, the order follows the visual layout, and no
    control can be reached only with a mouse.

---

## One optional step that converts a human check into an automated one

21. **Safari → Settings → Advanced → tick "Show features for web developers".
    Then Safari → Develop → tick "Allow Remote Automation".**

    Then run: `JWT_PATH=<token file> node scripts/acceptance-webkit.mjs`

    PASS: it runs and reports its results instead of exiting 2. That covers
    Safari.app's own behaviour permanently, so step 17 shrinks to the parts that
    genuinely need an iPhone. It is a one-time GUI setting; nothing else about
    the script changes.

---

## Recording what you find

Page, device, engine, what you expected, what happened. A finding written as an
impression cannot become a test; written in that form it becomes a regression
guard the same day.
