// GAMES-A — the ten task classes the generation engine routes.
//
// The six B1 lanes (world_architect, fast_inference, spatial, asset_3d,
// gameplay, media) describe where a result lands in WorldManifestV3. These
// describe what is being ASKED of a provider, which is what decides who should
// answer: a texture and a character portrait are both "media" to the manifest,
// and they want different vendors.

export const TASK = Object.freeze({
  WORLD_DESIGN: "WORLD_DESIGN",
  GAMEPLAY_LOGIC: "GAMEPLAY_LOGIC",
  FAST_ITERATION: "FAST_ITERATION",
  CODE_GENERATION: "CODE_GENERATION",
  IMAGE_ASSET: "IMAGE_ASSET",
  TEXTURE: "TEXTURE",
  CHARACTER: "CHARACTER",
  SPATIAL_3D: "SPATIAL_3D",
  VIDEO_CINEMATIC: "VIDEO_CINEMATIC",
  VOICE_AUDIO: "VOICE_AUDIO",
});

export const TASKS = Object.freeze(Object.values(TASK));

/** What kind of output a task produces. The engine validates against this. */
export const OUTPUT_KIND = Object.freeze({
  WORLD_DESIGN: "json",
  GAMEPLAY_LOGIC: "json",
  FAST_ITERATION: "json",
  CODE_GENERATION: "json",
  IMAGE_ASSET: "image",
  TEXTURE: "image",
  CHARACTER: "image",
  SPATIAL_3D: "model3d",
  VIDEO_CINEMATIC: "video",
  VOICE_AUDIO: "audio",
});

/** The B1 manifest lane a task's result feeds, so the bridge knows where to put it. */
export const MANIFEST_LANE = Object.freeze({
  WORLD_DESIGN: "world_architect",
  GAMEPLAY_LOGIC: "gameplay",
  FAST_ITERATION: "fast_inference",
  CODE_GENERATION: "gameplay",
  IMAGE_ASSET: "media",
  TEXTURE: "media",
  CHARACTER: "asset_3d",
  SPATIAL_3D: "spatial",
  VIDEO_CINEMATIC: "media",
  VOICE_AUDIO: "media",
});

/**
 * Per-task deadlines. The whole route shares one deadline, so a slow primary
 * cannot eat the fallbacks' time. Media and 3D are asynchronous jobs upstream
 * (submit, then poll) and get correspondingly longer.
 */
export const DEADLINE_MS = Object.freeze({
  WORLD_DESIGN: 180_000,
  GAMEPLAY_LOGIC: 180_000,
  FAST_ITERATION: 30_000,
  CODE_GENERATION: 180_000,
  IMAGE_ASSET: 150_000,
  TEXTURE: 150_000,
  CHARACTER: 150_000,
  SPATIAL_3D: 900_000,
  VIDEO_CINEMATIC: 900_000,
  VOICE_AUDIO: 90_000,
});

/** Per-attempt timeouts: one adapter call may not use more than this. */
export const ATTEMPT_TIMEOUT_MS = Object.freeze({
  WORLD_DESIGN: 120_000,
  GAMEPLAY_LOGIC: 120_000,
  FAST_ITERATION: 15_000,
  CODE_GENERATION: 120_000,
  IMAGE_ASSET: 120_000,
  TEXTURE: 120_000,
  CHARACTER: 120_000,
  SPATIAL_3D: 600_000,
  VIDEO_CINEMATIC: 600_000,
  VOICE_AUDIO: 60_000,
});

export function assertTask(task) {
  if (!TASKS.includes(task)) throw new TypeError(`unknown task class '${task}'`);
  return task;
}
