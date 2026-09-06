// Section 9.1 — multimodal world creation.
//
// The design rule: an image is READ into a description, and the description
// conditions generation. No image bytes ever enter the manifest, the reading is
// always visible to the creator, and a world can still be built with no vision
// provider at all.
import test from "node:test";
import assert from "node:assert/strict";
import { createAssemblyRouter } from "../src/v3/router/assembly.mjs";
import { validateImage, conditionPrompt, readingToConstraints, visionAdapters, VISION_LANE, noVisionFallback } from "../src/v3/providers/vision.mjs";
import { Lane, STATUS } from "../src/v3/providers/contract.mjs";
import { validateManifest } from "../src/v3/manifest/schema.mjs";

const OFFLINE = { DCS_PROVIDERS_OFFLINE: "1" };
const png = (n = 400) => "data:image/png;base64," + Buffer.from("x".repeat(n)).toString("base64");

const goodReading = {
  kind: "photo", setting: "a stone harbour at dusk", style: "wet black stone, low amber light",
  structures: ["warehouse", "crane", "cottage"], terrain: "coastal",
  time_of_day: "dusk", weather: "rain", layout_hints: ["quay runs east to west"],
  confidence: 0.82, not_visible: ["anything inland"],
};

// ------------------------------------------------------------- input safety

test("9.1: an image must be a base64 data URL of an accepted type", () => {
  assert.throws(() => validateImage({}), (e) => e.httpStatus === 422);
  assert.throws(() => validateImage({ dataUrl: "https://example.com/x.png" }), (e) => /base64 data URL/.test(e.detail));
  assert.throws(() => validateImage({ dataUrl: "data:application/pdf;base64,AAAA" }), (e) => /not accepted/.test(e.detail));
  const ok = validateImage({ dataUrl: png() });
  assert.equal(ok.mime, "image/png");
});

test("9.1 GATE: an oversized image is refused BEFORE a byte is sent anywhere", () => {
  assert.throws(
    () => validateImage({ dataUrl: png(64), bytes: 20 * 1024 * 1024 }),
    (e) => e.httpStatus === 422 && /the limit is 6MB/.test(e.detail)
  );
});

// -------------------------------------------------------------- conditioning

test("9.1 GATE: a confident reading conditions the prompt, and the creator's words still win", () => {
  const r = conditionPrompt("A rainy nordic port town", goodReading);
  assert.equal(r.conditioned, true);
  assert.ok(r.prompt.startsWith("A rainy nordic port town"), "the creator's words stay first");
  assert.match(r.prompt, /stone harbour at dusk/);
  assert.match(r.prompt, /warehouse, crane, cottage/);
  assert.match(r.prompt, /take priority where they conflict/);
});

test("9.1 GATE: a LOW-confidence reading contributes nothing rather than noise", () => {
  const r = conditionPrompt("A port town", { ...goodReading, confidence: 0.1 });
  assert.equal(r.conditioned, false);
  assert.equal(r.prompt, "A port town", "the prompt is untouched");
  assert.match(r.reason, /low confidence/);
});

test("9.1 GATE: with no vision provider, the image is honestly not read", async () => {
  const fb = noVisionFallback();
  assert.equal(await fb.status(), STATUS.FALLBACK);
  const reading = await fb.invoke();
  assert.equal(reading.unread, true);
  assert.equal(reading.confidence, 0);
  assert.match(reading.not_visible[0], /no vision provider is available/);

  const r = conditionPrompt("A port town", reading);
  assert.equal(r.conditioned, false);
  assert.match(r.reason, /no vision provider was available/);
});

test("9.1: what the image says becomes real constraints", () => {
  const c = readingToConstraints(goodReading);
  assert.equal(c.style, goodReading.style);
  assert.equal(c.weather, "rain");
  assert.equal(c.time_of_day, 0.82, "dusk maps to a real time-of-day value");
  assert.deepEqual(c.preferred_structures, ["warehouse", "crane", "cottage"]);
  assert.equal(readingToConstraints({ unread: true }), null);
});

// ----------------------------------------------------------- lane behaviour

test("9.1: the vision lane exists, is ranked, and ends in a fallback", async () => {
  const lane = new Lane(VISION_LANE, visionAdapters(OFFLINE));
  const d = await lane.describe();
  assert.equal(d.lane, "vision");
  assert.ok(d.adapters.length >= 3);
  assert.ok(d.adapters.some((a) => a.is_fallback));
  assert.ok(d.adapters.every((a) => a.status === STATUS.UNAVAILABLE || a.status === STATUS.FALLBACK), "offline, no vendor may claim to be available");
});

test("9.1: the router exposes vision alongside the other lanes", async () => {
  const d = await createAssemblyRouter(OFFLINE).describe();
  const names = d.lanes.map((l) => l.lane);
  assert.ok(names.includes("vision"));
  assert.equal(names.length, 7);
});

// ---------------------------------------------------------------- assembly

test("9.1 GATE: a world assembles with an image even when no vision provider exists", async () => {
  const out = await createAssemblyRouter(OFFLINE).assemble({
    prompt: "A rainy nordic port town", worldId: "w_mm", creatorId: "u1", image: { dataUrl: png() },
  });
  assert.equal(out.validation.ok, true, JSON.stringify(out.validation.errors));
  assert.equal(out.conditioning.conditioned, false);
  assert.ok(out.manifest.zones.length >= 3, "the world is still fully built");
});

test("9.1 GATE: no image bytes ever enter the manifest", async () => {
  const dataUrl = png(2000);
  const out = await createAssemblyRouter(OFFLINE).assemble({
    prompt: "A rainy nordic port town", worldId: "w_mm2", creatorId: "u1", image: { dataUrl },
  });
  const json = JSON.stringify(out.manifest);
  assert.ok(!json.includes(dataUrl.slice(30, 120)), "the image data must never be stored in the world contract");
  assert.ok(!json.includes("base64"), "no base64 payload anywhere in the manifest");
});

test("9.1 GATE: the manifest records what the system thought the image showed", async () => {
  const out = await createAssemblyRouter(OFFLINE).assemble({
    prompt: "A rainy nordic port town", worldId: "w_mm3", creatorId: "u1", image: { dataUrl: png() },
  });
  const ref = out.manifest.meta.reference_image;
  assert.ok(ref, "a creator must be able to see how their image was read");
  assert.equal(ref.conditioned, false);
  assert.match(ref.not_used_because, /no vision provider/);
  assert.ok(ref.reading, "the reading itself is recorded, even when unusable");
});

test("9.1: a world assembled WITHOUT an image carries no reference-image block", async () => {
  const out = await createAssemblyRouter(OFFLINE).assemble({ prompt: "A neon city", worldId: "w_mm4", creatorId: "u1" });
  assert.equal(out.manifest.meta.reference_image, undefined);
  assert.equal(out.conditioning.conditioned, false);
  assert.match(out.conditioning.reason, /no reference image/);
});

test("9.1 GATE: a confident reading really does change the world that comes out", async () => {
  // Inject a vision adapter that returns a confident reading, and check the
  // conditioning reaches the architect rather than being decorative.
  const router = createAssemblyRouter(OFFLINE);
  let sawPrompt = null;
  router.lanes[VISION_LANE] = new Lane(VISION_LANE, [
    { name: "test:vision", rank: 1, isFallback: false, model: "test", status: async () => STATUS.AVAILABLE, invoke: async () => ({ ...goodReading, _model: "test" }) },
    noVisionFallback(),
  ]);
  const architect = router.lanes.world_architect;
  const origRun = architect.run.bind(architect);
  architect.run = async (req, ctx) => { sawPrompt = req.prompt; return origRun(req, ctx); };

  const out = await router.assemble({ prompt: "A port town", worldId: "w_mm5", creatorId: "u1", image: { dataUrl: png() } });
  assert.equal(out.conditioning.conditioned, true);
  assert.match(sawPrompt, /stone harbour at dusk/, "the architect must actually receive the conditioning");
  assert.equal(out.manifest.meta.reference_image.conditioned, true);
  assert.equal(validateManifest(out.manifest).ok, true);
  // And the reading is in provenance, so which model read the image is recorded.
  assert.ok(out.provenance.some((p) => p.lane === "vision" && p.provider === "test:vision"));
});

test("9.1: a vision failure degrades to no conditioning rather than failing the world", async () => {
  const router = createAssemblyRouter(OFFLINE);
  router.lanes[VISION_LANE] = new Lane(VISION_LANE, [
    { name: "broken:vision", rank: 1, isFallback: false, status: async () => STATUS.AVAILABLE, invoke: async () => { throw new Error("vision down"); } },
    noVisionFallback(),
  ]);
  const out = await router.assemble({ prompt: "A port town", worldId: "w_mm6", creatorId: "u1", image: { dataUrl: png() } });
  assert.equal(out.validation.ok, true, "a broken vision provider must not cost you the world");
  assert.equal(out.conditioning.conditioned, false);
});
