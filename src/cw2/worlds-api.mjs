// src/worlds-api.mjs
// C4 endpoints CW2 owns:
//   POST /worlds/generate {prompt} -> {world_id, status, manifest_url}
//   GET  /worlds/:id/manifest      -> the world.json
// Zero-dep node:http. P0: generate seeds a schema-valid world (AI path matures behind the same contract).
// Honest: a world is only served if it passes the C1 validator (fail-closed) — CW3 never gets a bad world.

import http from "node:http";
import { generateWorld } from "./generate.mjs";
import { validateWorld } from "./validator.mjs";
// Adapter seam: when a real LLM is provisioned and set active, this endpoint serves it
// automatically with no route change. Seeder is the default impl. (Round-3 deliverable.)
import { generateVia } from "./adapter.mjs";

const store = new Map(); // world_id -> world.json (in-memory; CW5 owns durable persistence)

export async function handle(req, res, urlStr, body) {
  const url = new URL(urlStr, "http://x");
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.method === "POST" && url.pathname === "/worlds/generate") {
    let prompt;
    try { prompt = JSON.parse(body || "{}").prompt; } catch { return json(400, { error: "bad_json" }); }
    if (!prompt || typeof prompt !== "string") return json(400, { error: "prompt_required" });
    let world;
    try {
      world = await generateVia(prompt); // via adapter seam (seeder now; LLM when provisioned)
    } catch (e) {
      // Honest: if the active adapter isn't ready (e.g. LLM set but no model), say so — don't fake a world.
      return json(503, { error: "generation_unavailable", reason: e.code || e.message });
    }
    const v = validateWorld(world);
    if (!v.valid) return json(500, { error: "generation_failed_validation", details: v.errors }); // fail-closed
    store.set(world.world_id, world);
    return json(200, { world_id: world.world_id, status: "ready", manifest_url: `/worlds/${world.world_id}/manifest` });
  }

  const m = url.pathname.match(/^\/worlds\/([^/]+)\/manifest$/);
  if (req.method === "GET" && m) {
    const world = store.get(m[1]);
    if (!world) return json(404, { error: "world_not_found" });
    return json(200, world);
  }

  // C4 discovery (CW2 + CW6): published worlds with creator_name. Shapes match canonical mock-server.
  if (req.method === "GET" && url.pathname === "/worlds") {
    const worlds = [...store.values()]
      .filter((w) => w.state === "published")
      .map((w) => ({ world_id: w.world_id, title: w.meta.title, creator_name: w.meta.creator_id, visits: 0, genre: w.meta.genre }));
    return json(200, { ok: true, worlds });
  }

  // C4: drafts + published for the current creator (mock: split by state).
  if (req.method === "GET" && url.pathname === "/worlds/mine") {
    const all = [...store.values()];
    return json(200, {
      ok: true,
      drafts: all.filter((w) => (w.state || "draft") !== "published").map((w) => w.world_id),
      published: all.filter((w) => w.state === "published").map((w) => w.world_id),
    });
  }

  return json(404, { error: "no_route" });
}

// Standalone runner (node src/worlds-api.mjs) for local/CW3 integration.
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = process.env.PORT || 7302;
  http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => handle(req, res, req.url, body));
  }).listen(PORT, () => console.log(`CW2 worlds-api on :${PORT}`));
}
