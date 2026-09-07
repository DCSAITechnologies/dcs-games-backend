# Human acceptance — the founder-only blocker, with the exact checklist

Every automated, internal and staging proof is green. What remains before
`CLOSED_BETA_CANDIDATE` cannot be automated, because it is the thing automation
is a proxy for: **a real person, on a real device, using the deployed build.**

This is recorded as a founder-only blocker rather than an engineering task. The
original blocker was "there is no deployed build"; that is gone.

## What is already proven, so that this session is not repeated

- the flagship journey end to end against the deployed service (42/42)
- the V2 surface (20/20)
- Atlas receipts verified with the published key, in a verifier that trusts
  nothing (16/16)
- security posture from outside (35/35), including that the browser-shipped anon
  key reads nothing from eight tables
- 36 concurrent writers with no lost updates (26/26)
- every one of the 190 frontend pages navigated at 320 CSS px with touch on
- both navigation shells driven with real keyboard events

## What a human session must establish, and nothing else can

### 1. Devices and engines that exist here only as an assumption

- [ ] **iOS Safari** — no WebKit engine has ever run this code. Not "probably
      fine": untested.
- [ ] **Android Chrome on a real handset** — touch latency, the on-screen
      keyboard covering a focused field, and what the 3D runtime does on a
      mid-range GPU.
- [ ] **Firefox** — the only engine-specific defect found all session was
      `::placeholder`, which Firefox dims on its own. That was reasoned about,
      not observed.

### 2. A screen reader, driven by someone who uses one

- [ ] **VoiceOver (macOS or iOS)** and/or **NVDA (Windows)** through: sign in →
      describe a world → generate → play → publish.
- [ ] Every control has a label the automated sweep accepted; whether those
      labels make **sense read aloud, in order** is a judgement no test makes.

### 3. The journey, performed rather than asserted

- [ ] Describe → Generate → Play → Save → Return → Companion → Edit → Expand →
      Playtest → Publish, by someone who has not seen the code.
- [ ] Does the generated world feel like the thing they described?
- [ ] Is the companion's answer useful, or merely grounded? Automation proves it
      names a real zone; it cannot tell you whether it was worth reading.
- [ ] When the playtest gate refuses a world, is the reason actionable to a
      person who is not an engineer?

### 4. The honest surfaces, read by someone who did not build them

- [ ] An em dash where a number is unknown: does it read as "we don't know", or
      as broken?
- [ ] "The marketplace is dark" — is that understood, or does it read as an
      error?
- [ ] The eleven disabled builder controls that name a route which does not
      exist: does that read as honesty or as a broken product? **This is the
      one most likely to need a product decision rather than a fix.**

### 5. What must NOT happen during the session

- [ ] No production deploy, no production migration, no payment activation.
- [ ] Testers use the staging preview and the staging Supabase project only.
- [ ] Any account created is a staging account.

## Recording the result

Whatever is found, write it down as a defect with the page, the device and the
engine — the same form the automated suites use — so it can be fixed and then
guarded. A finding reported as an impression cannot become a test.

## Then, and only then

If the session finds nothing that a real user would call broken, the evidence
supports **`CLOSED_BETA_CANDIDATE`**. Until it happens, the truthful label is
`V3_VERTICAL_SLICE_PROVEN`, because "no human has used it" is not a gap the
engineering can close on its own.
