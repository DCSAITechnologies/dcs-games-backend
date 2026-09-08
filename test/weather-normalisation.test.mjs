// A world must not be lost because a model wrote "overcast" instead of "cloudy".
//
// Observed on staging, 8 Sep 2026, non-deterministically: two generations
// succeeded and the third came back
//
//   server_error: the assembled world did not satisfy WorldManifestV3
//   errors: [{ path: "environment.weather", ... }]
//
// src/v3/router/assembly.mjs took `plan.environment?.weather || "clear"` —
// whatever the model said, unvalidated — two lines below a `maturity` field
// that IS checked against its own enum with a fallback. Same file, same shape,
// one validated and one not. So an unrecognised weather word failed the whole
// manifest, and the person who described that world lost it to a cosmetic,
// OPTIONAL field.
//
// The schema keeps its eight values. The assembly stage normalises onto them.
import test from "node:test";
import assert from "node:assert/strict";
import { WEATHERS } from "../src/v3/manifest/schema.mjs";
import { normaliseWeather } from "../src/v3/router/assembly.mjs";

test("REGRESSION: no input can produce a weather outside the schema's enum", () => {
  // Every one of these is a plausible model output, and none of them is in
  // WEATHERS. Before the fix each one failed the whole generation.
  const strays = ["overcast", "Overcast", "partly cloudy", "partly-cloudy", "drizzle",
                  "thunderstorm", "blizzard", "misty", "hazy", "duststorm", "sunny",
                  "", "   ", "banana", "42", null, undefined, {}, []];
  for (const raw of strays) {
    const out = normaliseWeather(raw);
    assert.ok(WEATHERS.includes(out),
      `${JSON.stringify(raw)} became ${JSON.stringify(out)}, which is not in the schema's enum`);
  }
});

test("a synonym keeps its meaning rather than collapsing to the default", () => {
  // Mapping "overcast" to "cloudy" is normalisation: the same concept in a
  // different word. Mapping it to "clear" would discard what the model actually
  // said, which is the same failure in a quieter form.
  const pairs = [["overcast", "cloudy"], ["drizzle", "rain"], ["thunderstorm", "storm"],
                 ["blizzard", "snow"], ["misty", "fog"], ["duststorm", "sandstorm"],
                 ["partly cloudy", "cloudy"], ["Rainy", "rain"], ["ASHFALL", "ash"]];
  for (const [raw, want] of pairs) {
    assert.equal(normaliseWeather(raw), want, `${raw} should normalise to ${want}`);
  }
});

test("a weather the schema already allows is passed through untouched", () => {
  for (const w of WEATHERS) assert.equal(normaliseWeather(w), w);
});

test("an absent weather is the same default it always was", () => {
  // The field is optional. Absent must not become an assertion about weather.
  assert.equal(normaliseWeather(undefined), "clear");
  assert.equal(normaliseWeather(null), "clear");
});
