// GAMES-A — local, deterministic, zero-cost adapters: the last step of every
// route. They wrap the B1 fallbacks that already ship (so a world built by the
// engine offline is the same world the assembly router builds offline) and add
// two the engine needs: a procedural texture tile and a parametric character.
//
// Each one says what it is. A placeholder is flagged `placeholder: true`; a
// procedural result carries `meta.procedural: true`. Neither is ever presented
// as a generated asset.
import { TASK } from "../task-classes.mjs";
import { planWorldLocally, classifyLocally, behaviorsLocally, rng, hashString } from "../../providers/local-planner.mjs";
import { placeholderMediaAdapter } from "../../providers/media.mjs";
import { generateTerrainLocally } from "../../providers/spatial.mjs";
import { buildAsset, resolveArchetype } from "../../providers/asset3d.mjs";

function localAdapter(id, tasks, invoke) {
  return {
    id, vendor: "local", isLocal: true, tasks,
    configured: () => true, retrySafe: () => false, defaultModel: () => "deterministic", estimateUsd: () => 0,
    async invoke(call) { return { model: "deterministic", costUsd: 0, ...(await invoke(call)) }; },
  };
}

const seedOf = (req) => req.seed ?? hashString(String(req.prompt || ""));

/** A tileable procedural texture: a seeded cell pattern, as SVG. */
export function proceduralTextureSvg(prompt, seed, size = 256) {
  const r = rng(seed);
  const hue = Math.floor(r() * 360);
  const cells = 8, step = size / cells;
  let rects = "";
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const l = 22 + Math.floor(r() * 26);
    rects += `<rect x="${x * step}" y="${y * step}" width="${step}" height="${step}" fill="hsl(${hue} 28% ${l}%)"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rects}</svg>`;
}

export function localAdapters() {
  const media = placeholderMediaAdapter();
  const placeholder = (kind) => async ({ req }) => {
    const out = await media.invoke({ kind, prompt: req.prompt, label: req.label, width: req.width, height: req.height });
    return { outputs: [{ uri: out.uri, mime: out.mime, placeholder: true, meta: { reason: out.unavailable_reason || "no provider produced this asset" } }] };
  };
  return {
    "local:procedural-architect": localAdapter("local:procedural-architect", [TASK.WORLD_DESIGN],
      async ({ req }) => ({ outputs: [{ json: planWorldLocally({ ...req, seed: seedOf(req) }), meta: { procedural: true } }] })),
    "local:keyword-classifier": localAdapter("local:keyword-classifier", [TASK.FAST_ITERATION],
      async ({ req }) => ({ outputs: [{ json: classifyLocally(req), meta: { procedural: true } }] })),
    "local:behavior-library": localAdapter("local:behavior-library", [TASK.GAMEPLAY_LOGIC, TASK.CODE_GENERATION],
      async ({ req }) => ({ outputs: [{ json: behaviorsLocally(req), meta: { procedural: true } }] })),
    "local:procedural-texture": localAdapter("local:procedural-texture", [TASK.TEXTURE],
      async ({ req }) => {
        const svg = proceduralTextureSvg(req.prompt, seedOf(req));
        return { outputs: [{ uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, mime: "image/svg+xml", meta: { procedural: true, tileable: true } }] };
      }),
    "local:parametric-character": localAdapter("local:parametric-character", [TASK.CHARACTER],
      async ({ req }) => {
        const arche = resolveArchetype(req.archetype || req.prompt, req.kindHint || "character");
        return { outputs: [{ json: buildAsset(arche, { kindHint: "character", style: req.style || null, seed: seedOf(req) }), meta: { procedural: true, archetype: arche } }] };
      }),
    "local:procedural-spatial": localAdapter("local:procedural-spatial", [TASK.SPATIAL_3D],
      async ({ req }) => ({ outputs: [{ json: generateTerrainLocally({ seed: seedOf(req), size: req.size, zones: req.zones || [], structures: req.structures || [] }), meta: { procedural: true, format: "heightmap+navgraph" } }] })),
    "local:media-placeholder": localAdapter("local:media-placeholder", [TASK.IMAGE_ASSET, TASK.VIDEO_CINEMATIC, TASK.VOICE_AUDIO],
      async (call) => placeholder({ IMAGE_ASSET: "image", VIDEO_CINEMATIC: "video", VOICE_AUDIO: "voice" }[call.task])(call)),
  };
}
