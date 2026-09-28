// Games-D gameplay/objective templates (STUB — owned by the gameplay agent). Node-side (uses the gamesb validators).
import { gameplayDifficulty } from "../difficulty.mjs";
export const TEMPLATES = Object.freeze({
  classic_chain: { id: "classic_chain", name: "Classic quest chain", genre: "adventure", summary: "Talk, gather, wake each site, finale.", needs: {}, timed: false, keywords: ["adventure", "quest"] },
});
export function templateConceptPatch(concept, ctx) { return { ...concept, genre: ctx.template.genre }; }
export function applyTemplate(gameplay, ctx) { return { ...gameplay, difficulty: gameplayDifficulty(ctx.difficulty) }; }
