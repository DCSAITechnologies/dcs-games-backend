// src/adapter.mjs
// Round-3 deliverable: the generation ADAPTER SEAM.
// Goal (Manager): "deterministic seeder stays the impl until the model lands — but ship the swap-in
// seam so P-gen is a one-line flip." The real LLM, when provisioned, drops in behind THE SAME C1
// contract: callers still get a schema-valid world.json either way.
//
// Honest: the LLM adapter does NOT fabricate model output. Until a real model client is injected,
// it fails closed (throws) — it never returns invented worlds. The seeder remains the default impl.
// Zero npm deps.

import { generateWorld } from "./generate.mjs";
import { validateWorld } from "./validator.mjs";

// ---- the seam: every adapter implements generate(prompt, opts) -> world.json (C1-valid) ----

// Impl A (DEFAULT, live now): deterministic seeder. Real, schema-valid, reproducible.
export const seederAdapter = {
  name: "deterministic-seeder",
  ready: true,
  async generate(prompt, opts = {}) {
    return generateWorld(prompt, opts);
  },
};

// Impl B (SEAM, not live): real-LLM adapter. Same interface; fills the slot when a model client lands.
// Takes an injected `modelClient` with .complete(messages) -> string (structured JSON world).
// Until injected, ready=false and generate() throws — NO fabricated output, ever.
export function makeLLMAdapter({ modelClient = null, systemPrompt = DEFAULT_SYSTEM } = {}) {
  return {
    name: "llm",
    ready: Boolean(modelClient),
    async generate(prompt, opts = {}) {
      if (!modelClient) {
        // Honest fail-closed: no model provisioned, so we do not invent a world.
        const err = new Error("llm_adapter_not_provisioned: inject a modelClient (AI model + sandbox are infra-gated)");
        err.code = "ADAPTER_NOT_READY";
        throw err;
      }
      // When a real client exists: ask for structured world.json, then VALIDATE before returning.
      const raw = await modelClient.complete([
        { role: "system", content: systemPrompt },
        { role: "user", content: String(prompt) },
      ]);
      let world;
      try { world = JSON.parse(raw); } catch { throw new Error("llm_adapter: model did not return valid JSON"); }
      const v = validateWorld(world);
      if (!v.valid) {
        // The model proposed; the contract validates. A bad proposal is rejected, not shipped.
        const err = new Error("llm_adapter: model output failed C1 validation");
        err.details = v.errors;
        throw err;
      }
      return world;
    },
  };
}

const DEFAULT_SYSTEM = [
  "You generate a DCS Games world as STRICT JSON matching the C1 world.json schema.",
  "Required: world_id, schema_version:'1.0', meta{title,prompt,genre,creator_id,created_at,atlas_receipt_hash},",
  "terrain{type:tilegrid|heightmap,size,data,zones}, spawns[], objects[], npcs[], quests[], items[].",
  "Set atlas_receipt_hash to null (issued at publish). Return ONLY the JSON, no prose.",
].join(" ");

// ---- the one-line flip: which adapter is active ----
let active = seederAdapter;
export function setAdapter(adapter) {
  if (!adapter || typeof adapter.generate !== "function") throw new Error("invalid adapter");
  active = adapter;
}
export function getAdapter() { return active; }

// Public generate(): always behind the active adapter, always returns a C1-valid world
// (seeder guarantees it; LLM path validates-or-throws). This is what the API + callers use.
export async function generateVia(prompt, opts = {}) {
  const world = await active.generate(prompt, opts);
  const v = validateWorld(world);
  if (!v.valid) {
    const err = new Error("adapter_output_invalid: " + active.name);
    err.details = v.errors;
    throw err; // belt-and-suspenders: nothing non-conforming ever leaves the seam
  }
  return world;
}
