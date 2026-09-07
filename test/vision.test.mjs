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
// A payload that actually BEGINS like a PNG. The old fixture was a run of "x",
// which is not a PNG in any sense; validateImage now checks the first bytes
// against the format the data URL claims, because that claim is the only part
// of the request that is not attacker-controlled.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 400) =>
  "data:image/png;base64," + Buffer.concat([PNG_MAGIC, Buffer.from("x".repeat(Math.max(0, n - PNG_MAGIC.length)))]).toString("base64");

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

// ------------------------------------- a caller's claim cannot weaken the check

test("9.1 GATE: a caller cannot relabel a payload into an accepted image type", () => {
  // `const detected = (mime || m[1])` let the caller's label REPLACE the data
  // URL's own, and server.mts takes that label straight from the request body
  // (`image: { dataUrl: b.image_data_url, mime: b.image_mime }`). So a PDF —
  // or anything else — declared as `image/png` passed validation and was
  // forwarded to a vision provider.
  const pdf = "data:application/pdf;base64," + Buffer.from("%PDF-1.4 not an image at all").toString("base64");
  assert.throws(
    () => validateImage({ dataUrl: pdf, mime: "image/png" }),
    (e) => { assert.equal(e.httpStatus, 422); assert.match(e.detail, /says it is 'application\/pdf'/); return true; },
    "a payload must not be admitted on the strength of the label the sender put on it",
  );

  // Agreeing is fine; only disagreeing is refused.
  assert.deepEqual(validateImage({ dataUrl: png(64), mime: "image/png" }).mime, "image/png");
  assert.throws(() => validateImage({ dataUrl: png(64), mime: "image/webp" }), (e) => /says it is 'image\/png'/.test(e.detail));
});

test("9.1 GATE: a declared size may raise the figure but never lower it", () => {
  // `bytes ?? computed` meant a caller-declared size REPLACED the payload's, so
  // `bytes: 10` admitted a payload of any size at all. The limit exists to stop
  // us forwarding something enormous to a provider; a sender must not be able
  // to switch it off by saying a smaller number.
  const huge = "data:image/png;base64," + Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(8 * 1024 * 1024, 0x41),
  ]).toString("base64");

  assert.throws(() => validateImage({ dataUrl: huge }), (e) => /the limit is/.test(e.detail));
  assert.throws(
    () => validateImage({ dataUrl: huge, bytes: 10 }),
    (e) => /the limit is/.test(e.detail),
    "an undersized declaration must not admit an oversized payload",
  );
  // Raising it is still honoured, because that can only make the check stricter.
  assert.throws(() => validateImage({ dataUrl: png(64), bytes: 20 * 1024 * 1024 }), (e) => /the limit is/.test(e.detail));
});

test("9.1 GATE: a payload must begin like the format it claims to be", () => {
  // The declared type is a claim too. This is a cheap check rather than a
  // decoder — it says the bytes start the way that format starts, which is what
  // stops a document being handed to a vision provider as a picture.
  const notAPng = "data:image/png;base64," + Buffer.from("%PDF-1.4 pretending").toString("base64");
  assert.throws(() => validateImage({ dataUrl: notAPng }), (e) => /does not begin like a PNG/.test(e.detail));

  // Each accepted type is recognised by its own signature.
  const b64 = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(64, 0x41)]).toString("base64");
  assert.equal(validateImage({ dataUrl: "data:image/jpeg;base64," + b64([0xff, 0xd8, 0xff]) }).mime, "image/jpeg");
  assert.equal(validateImage({ dataUrl: "data:image/gif;base64," + b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) }).mime, "image/gif");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WEBP"), Buffer.alloc(64, 0x41)]);
  assert.equal(validateImage({ dataUrl: "data:image/webp;base64," + webp.toString("base64") }).mime, "image/webp");
  // RIFF that is not WEBP is not a WEBP.
  const riffNotWebp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WAVE"), Buffer.alloc(64, 0x41)]);
  assert.throws(() => validateImage({ dataUrl: "data:image/webp;base64," + riffNotWebp.toString("base64") }), (e) => /does not begin like a WEBP/.test(e.detail));
});
