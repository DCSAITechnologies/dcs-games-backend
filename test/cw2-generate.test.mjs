// CW2 — the legacy generation path treated its untrusted input two contradictory
// ways in the space of three lines.
//
// generateWorld() calls parsePrompt(), which coerces with String(), and then
// rng(), which iterated the raw value. So a prompt that was not a string either
// became a world or crashed, depending on whether it happened to be iterable.
// Reproduced 7 Sep 2026 against a booted server.mts, POST /worlds/generate:
//
//   {"prompt":123}     -> 500 {"error":"server_error",
//                              "detail":"seedStr is not iterable"}
//   {"prompt":{"a":1}} -> 500, same
//   {"prompt":true}    -> 500, same
//   {"prompt":null}    -> 200, a real persisted world owned by the caller,
//                         titled "Untitled World"
//   {"prompt":""}      -> 200, same
//   {"prompt":"   "}   -> 200, same
//   {"prompt":["x"]}   -> 200, a world titled "X"
//
// The v3 sibling POST /v3/worlds/generate answers 422 "prompt is required" to
// every one of those, so this is also two surfaces disagreeing about whether a
// prompt is required at all.
//
// The second half of this file is the one that matters most: the fix must not
// have moved a single generated world. Generation is deterministic in the
// prompt and the seed, and reproducibility is a property this estate claims.
//
// Run: node --test test/cw2-generate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateWorld, parsePrompt, P0_PROMPTS } from "../src/cw2/generate.mjs";
import { validateWorld } from "../src/cw2/validator.mjs";

/** Two worlds are the same world if everything but the wall-clock stamp matches. */
const canon = (w) => JSON.stringify({ ...w, meta: { ...w.meta, created_at: "T" } });

// ==========================================================================
// 1. A prompt that is not a prompt is refused, the same way v3 refuses it.
// ==========================================================================

test("a prompt that is not a non-empty string is refused, not crashed on and not invented from", () => {
  const cases = [
    [123, "number"], [null, "null"], [undefined, "undefined"], [true, "boolean"],
    [{ a: 1 }, "object"], [["x"], "array"], [{}, "object"],
    ["", "string"], ["   ", "string"], ["\n\t ", "string"],
  ];
  for (const [prompt, type] of cases) {
    let err = null;
    try { generateWorld(prompt, { creator_id: "u1" }); } catch (e) { err = e; }
    assert.ok(err, `${JSON.stringify(prompt)} must be refused, not turned into a world`);
    assert.equal(err.name, "AppError", `${JSON.stringify(prompt)} threw a raw ${err.name}: ${err.message}`);
    assert.equal(err.httpStatus, 422, `${JSON.stringify(prompt)} must be a 422, not a 500`);
    assert.match(err.detail, /prompt is required/);
    assert.equal(err.meta.received_type, type, "the refusal names what it was actually given");
    // The old failure leaked the name of a local variable inside the RNG.
    assert.ok(!/seedStr|not iterable/.test(err.detail), "an internal variable name must not reach a caller");
  }
});

test("the legacy and v3 surfaces now say the same thing about the same input", () => {
  // v3's wording, from server.mts's /v3/worlds/generate: "prompt is required".
  // Two generation surfaces that disagree about whether a prompt is required is
  // a gap that gets found in production.
  const err = (() => { try { generateWorld(null); } catch (e) { return e; } })();
  assert.match(err.detail, /^prompt is required/);
  assert.equal(err.code, "validation_failed");
});

test("an explicit seed must have a stable string form", () => {
  // A seed is what makes a world reproducible. An object or an array seeds
  // differently on the caller's next release and silently changes every world.
  for (const seed of [{ a: 1 }, ["x"], null, true]) {
    assert.throws(
      () => generateWorld("a valid prompt", { creator_id: "u1", seed }),
      (e) => e.httpStatus === 422 && /seed must be a string or a number/.test(e.detail),
      `seed ${JSON.stringify(seed)} must be refused`,
    );
  }
  // A number is fine, and seeds exactly as its string form does.
  const a = generateWorld("p", { creator_id: "u1", world_id: "w1", seed: 12345 });
  const b = generateWorld("p", { creator_id: "u1", world_id: "w1", seed: "12345" });
  assert.equal(canon(a), canon(b));
});

// ==========================================================================
// 2. A valid prompt still produces the same world it always did.
// ==========================================================================

test("every world this generator produces still validates against the C1 contract", () => {
  for (const { key, prompt } of P0_PROMPTS) {
    const v = validateWorld(generateWorld(prompt, { creator_id: "u1" }));
    assert.ok(v.valid, `${key}: ${JSON.stringify(v.errors)}`);
  }
});

// Every world these inputs produced BEFORE the input check was added, hashed.
// Captured from the module as it stood at commit bded1df, which is the last
// revision without the check. Comparing against `git show HEAD:...` would have
// stopped meaning anything the moment this change was committed — HEAD would be
// the new file and the test would compare it with itself. These do not decay.
//
// If one of these ever changes, generation has moved. That is not automatically
// wrong, but it is never incidental: every world already stored was generated by
// the old arithmetic, and this estate publishes reproducibility as a property.
const GOLDEN = [
  ["Zombie School — a quarantined high school overrun by the dead, co-op escape.", null, "6596ce7b89e35e11"],
  ["Zombie School — a quarantined high school overrun by the dead, co-op escape.", "fixed-seed", "e94eabd1dee9587c"],
  ["Cyberpunk Mumbai — neon megacity streets, android vendors, hack the megacorp.", null, "89924fe90db52874"],
  ["Cyberpunk Mumbai — neon megacity streets, android vendors, hack the megacorp.", "fixed-seed", "de618a54cfbfc24e"],
  ["Dragon Kingdom — a fantasy castle approach guarded by an ancient dragon.", null, "73f9ea65f85c8fe1"],
  ["Dragon Kingdom — a fantasy castle approach guarded by an ancient dragon.", "fixed-seed", "b5927038ec5247bc"],
  ["Pirate Island — a smuggler's cove with buried treasure and patrolling buccaneers.", null, "028b9da31cbc23df"],
  ["Pirate Island — a smuggler's cove with buried treasure and patrolling buccaneers.", "fixed-seed", "e71998c4195ab361"],
  ["a rainy nordic port town", null, "69e4dbb79828314a"],
  ["a rainy nordic port town", "fixed-seed", "837caf479ec8728e"],
  ["x", null, "3505a741f10b4a84"],
  ["x", "fixed-seed", "b8ad3c98b9711002"],
  ["pirate island", null, "1bac584dcdd475d2"],
  ["pirate island", "fixed-seed", "8217f66fbe45475b"],
  ["medieval village siege", null, "b007d89cfb2ae3fe"],
  ["medieval village siege", "fixed-seed", "0c8714499cd37945"],
  ["ünïcödé prömpt with émoji and a tail long enough to cross the sixty-character size threshold", null, "e0da8289c9c2b0c7"],
  ["ünïcödé prömpt with émoji and a tail long enough to cross the sixty-character size threshold", "fixed-seed", "37a3502f10e999d6"],
];

test("REPRODUCIBILITY: the input check moved no world, byte for byte", () => {
  // rng() now iterates String(seed) rather than the raw seed. For a string those
  // are the same iteration — this is what says so, rather than the comment in
  // the module that asserts it.
  for (const [prompt, seed, want] of GOLDEN) {
    const opts = { creator_id: "u1", world_id: "w1", ...(seed === null ? {} : { seed }) };
    const got = crypto.createHash("sha256").update(canon(generateWorld(prompt, opts))).digest("hex").slice(0, 16);
    assert.equal(got, want, `${JSON.stringify(prompt)} @ seed ${seed} is not the world it used to be`);
  }
  // A guard on the guard: the hash must actually discriminate, or the table
  // above would pass against any generator at all.
  const decoy = crypto.createHash("sha256")
    .update(canon(generateWorld("a rainy nordic port town", { creator_id: "u1", world_id: "w1", seed: "other-seed" })))
    .digest("hex").slice(0, 16);
  assert.notEqual(decoy, GOLDEN.find(([p, s]) => p === "a rainy nordic port town" && s === "fixed-seed")[2]);
});

test("the same prompt still produces the same world twice, and different prompts differ", () => {
  const opts = { creator_id: "u1", world_id: "w1" };
  assert.equal(canon(generateWorld("pirate island", opts)), canon(generateWorld("pirate island", opts)));
  assert.notEqual(canon(generateWorld("pirate island", opts)), canon(generateWorld("zombie school", opts)));
  // The genre really is read off the prompt, so these are not all one fixture.
  assert.equal(parsePrompt("Pirate Island — buried treasure").genre, "pirate");
  assert.equal(parsePrompt("Zombie School — the dead").genre, "horror");
  assert.equal(generateWorld("Dragon Kingdom — a castle", opts).meta.genre, "fantasy");
});

test("a world id is not derived from the prompt, so it stays unguessable", () => {
  // Kept from the earlier fix that removed sha256(prompt) ids: two worlds from
  // the SAME prompt must not collide, or the id is a prompt-space oracle again.
  const a = generateWorld("a rainy nordic port town", { creator_id: "u1" });
  const b = generateWorld("a rainy nordic port town", { creator_id: "u2" });
  assert.notEqual(a.world_id, b.world_id);
  assert.match(a.world_id, /^world_[0-9a-f]{12}$/);
  // ...while the CONTENT is still identical, which is what reproducibility means.
  assert.equal(canon({ ...a, world_id: "w", meta: { ...a.meta, creator_id: "u" } }),
    canon({ ...b, world_id: "w", meta: { ...b.meta, creator_id: "u" } }));
});
