# Human acceptance — split into what a machine can prove and what it cannot

Every item from the original checklist appears below. Nothing was dropped to
make the list shorter. Items moved OUT of the human column only because a real
automated proof now exists and is named, and items that stayed are the ones
where the check *is* a human judgement.

Five categories:

| category | meaning |
| --- | --- |
| `AUTOMATED_AND_PROVEN` | a named suite asserts it against the deployed build |
| `HUMAN_VISUAL_REQUIRED` | a person must LOOK and judge; nothing to click |
| `HUMAN_INTERACTION_REQUIRED` | a person must USE it and judge the experience |
| `PHYSICAL_DEVICE_REQUIRED` | needs real hardware; no emulation substitutes |
| `ACCESSIBILITY_HUMAN_REQUIRED` | needs a person operating assistive technology |

---

## AUTOMATED_AND_PROVEN

### Engine coverage — this is what changed since the last revision

The original checklist said "no WebKit engine has ever run this code" and
"Firefox was reasoned about, not observed". Both are now false, and the proof
is `scripts/acceptance-engines.mjs` driving real engine builds against the
deployed preview and the deployed staging backend.

| check | engine | result |
| --- | --- | --- |
| the engine is genuinely WebKit, not Chromium wearing a UA string | WebKit | PASS |
| the engine is genuinely Gecko | Gecko | PASS |
| the environment resolver runs and resolves to **staging**, not production | both | PASS |
| gradient-clipped heading text is not invisible (`background-clip:text`) | both | PASS |
| `::placeholder` opacity is pinned rather than left to the engine | both | PASS |
| the engine reaches the staging API cross-origin — CORS holds per engine | both | PASS |
| payments are dark, asserted from inside each engine | both | PASS |
| `/player-home`, `/create-v3`, `/profile-v3`, `/history-v3` render | both | PASS |
| …and are real pages, not the 404 fallback | both | PASS |
| focusable controls exist; Tab moves focus off `<body>` | both | PASS |
| the session is stored under the key the site actually reads | both | PASS |
| a signed-in page reads its own profile from staging (HTTP 200) | both | PASS |
| a reload keeps the visitor signed in | both | PASS |
| no uncaught page errors across the whole sweep | both | PASS |
| a phone-shaped WebKit context reports touch support | WebKit @ 390px | PASS |
| `/`, `/player-home`, `/create-v3` render at phone width | WebKit @ 390px | PASS |
| …and do not scroll sideways at 390px | WebKit @ 390px | PASS |

**52 passed, 0 failed.**

What this does NOT cover, and why it is not a loophole: these are the WebKit and
Gecko builds Playwright ships. They are the real engines — the same WebCore,
JavaScriptCore and Gecko that ship in Safari and Firefox — so CSS, layout and
JS-API defects surface here. They are not Safari.app and not iOS Safari, so
Safari's own chrome, Intelligent Tracking Prevention, the iOS on-screen
keyboard and real GPU behaviour are not covered. Those stay below.

### Session and ownership behaviour

`scripts/acceptance-session.mjs` — **16 passed, 0 failed**, real Chrome against
the deployed preview and staging backend:

- signed out, a gated page does not show a working builder
- and it says WHY rather than rendering an empty page
- and it does not fabricate a signed-in identity
- no uncaught console errors while gated
- the session is stored under the key the site actually reads
- a signed-in page can read its own profile from staging
- a reload keeps the visitor signed in, with no console errors after it
- signing out really removes the session, and the page afterwards does not
  still show signed-in data
- a world created from a signed-in browser session is IMMEDIATELY in the
  creator's own list
- the list is newest-first
- the page is described as a page, not as a total
- another principal's world is refused — as a 404, not a 403, so the refusal is
  not an existence oracle
- a forged credential is refused

### The journey, mechanically

`scripts/staging-proofs.mjs` — **42/42** against deployed staging: Describe →
Generate → Play → Save → Return → Companion → Edit → Expand → Playtest →
Publish, including durability across a real process restart, version history,
rollback proven through the diff, and concurrent edits neither lost nor
duplicated. `scripts/staging-v2-proof.mjs` — **20/20** for the V2 surface.

### The staging-only constraint from §5 of the original checklist

- **the preview host resolves to the staging Supabase project and the staging
  Railway backend** — asserted from inside Chromium, WebKit and Gecko, so an
  account created during the session is a staging account by construction
- **payments are dark** — asserted continuously by `scripts/monitor-dark.mjs`
  and re-asserted inside every engine sweep
- `0002_seed.sql` quarantined by content as well as filename

### Accessibility, the mechanical half

- every one of the 190 frontend pages navigated at 320 CSS px with touch on
- both navigation shells driven with real keyboard events
- every control carries a label the automated sweep accepted

---

## HUMAN_VISUAL_REQUIRED

A person must look at these and say what they read. There is nothing to click,
and no assertion can stand in for the judgement.

- [ ] An em dash where a number is unknown: does it read as **"we don't know"**,
      or as **broken**?
- [ ] "The marketplace is dark" — is that **understood**, or does it read as an
      **error**?
- [ ] The eleven disabled builder controls that name a route which does not
      exist: does that read as **honesty** or as a **broken product**?
      **This is the one most likely to need a product decision rather than a
      fix** — see `reports/DECISION_GAPS.md`.
- [ ] Does the deployed build look like a product someone would trust with their
      creative work? Not a defect list — an impression.

## HUMAN_INTERACTION_REQUIRED

A person must use it and judge the experience. The mechanics are proven; the
quality is not a property any assertion has access to.

- [ ] The full journey performed end to end **by someone who has not seen the
      code**. The 42/42 proves the transitions happen. It does not prove they
      make sense in sequence.
- [ ] Does the generated world **feel like the thing they described**?
- [ ] Is the companion's answer **useful**, or merely grounded? Automation
      proves it names a real zone from this world's own manifest; it cannot tell
      you whether the answer was worth reading.
- [ ] When the playtest gate **refuses** a world, is the reason **actionable to
      a person who is not an engineer**?
- [ ] Session discipline: the tester must actually open the staging preview URL.
      The build cannot stop a person typing the production domain instead.

## PHYSICAL_DEVICE_REQUIRED

Needs real hardware. Emulation is not a substitute for any of these, and saying
so is the point of keeping them separate.

- [ ] **iOS Safari on a real iPhone** — Safari's own chrome, Intelligent
      Tracking Prevention against `localStorage` sessions, and the on-screen
      keyboard covering a focused field. The WebKit ENGINE is now proven; the
      iPhone is not.
- [ ] **Android Chrome on a real mid-range handset** — touch latency and what
      the 3D runtime does on a mid-range GPU. The Chromium engine is proven; the
      handset is not.
- [ ] **Safari.app specifically** — see the paused sub-check below.

### PAUSED — one macOS GUI setting away from automated

`scripts/acceptance-webkit.mjs` drives **Safari.app itself** through
`safaridriver`, which covers the Safari-chrome and ITP gap that the Playwright
WebKit build does not. It is written, and it does not run:

```
Could not create a session: You must enable 'Allow remote automation' in the
Developer section of Safari Settings to control Safari via WebDriver.
```

`safaridriver` is present and its `/status` endpoint reports ready. The block is
a one-time GUI setting with no scriptable equivalent (`safaridriver --enable`
prompts for an administrator password, which is equally not automatable):

    Safari → Settings → Advanced → tick "Show features for web developers"
    Safari → Develop → tick "Allow Remote Automation"

Then `JWT_PATH=<token file> node scripts/acceptance-webkit.mjs`. Nothing else
about it needs to change. **It exits 2 — never 0 — while the setting is off**,
so an unrun engine can never be mistaken for a passing one.

**Founder action required. This is the only sub-check paused on a setting
rather than on a judgement.**

## ACCESSIBILITY_HUMAN_REQUIRED

Needs a person operating assistive technology. VoiceOver.app is installed on
this machine but is GUI-only with no scriptable output API — there is no way to
capture what it announces, so this genuinely cannot be automated here.

- [ ] **VoiceOver (macOS or iOS)** and/or **NVDA (Windows)** through: sign in →
      describe a world → generate → play → publish.
- [ ] Every control has a label the automated sweep accepted. Whether those
      labels **make sense read aloud, in order**, is a judgement no test makes.
- [ ] Is the focus order sensible to someone who cannot see the layout? The
      automated proof is that focus MOVES; that it moves somewhere reasonable is
      a human call.

---

## Recording the result

Whatever is found, write it down as a defect with the page, the device and the
engine — the same form the automated suites use — so it can be fixed and then
guarded. A finding reported as an impression cannot become a test.

## Then, and only then

If the session finds nothing a real user would call broken, the evidence
supports `CLOSED_BETA_CANDIDATE`. Until it happens the truthful label stays
`V3_VERTICAL_SLICE_PROVEN`, because "no human has used it" is not a gap the
engineering can close on its own.
