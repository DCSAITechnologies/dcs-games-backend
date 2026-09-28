// Games-D difficulty variants. ISOMORPHIC (plain data).
//
// One table drives every stage: the rules engine reads damage/speed/time mults
// through GameplaySpec.difficulty, the npc presets read npc_speed_mult and
// sight_mult, and the roster reads hostile_bonus. Easy must stay finishable
// by a careless player; hard must still be finishable by the headless agent.

export const DIFFICULTY_LEVELS = Object.freeze(["easy", "normal", "hard"]);

export const DIFFICULTY = Object.freeze({
  easy:   Object.freeze({ level: "easy",   damage_mult: 0.5, speed_mult: 1, time_mult: 1.5,  lives: 5, player_health: 120, hostile_bonus: 0, npc_speed_mult: 0.8,  sight_mult: 0.75 }),
  normal: Object.freeze({ level: "normal", damage_mult: 1,   speed_mult: 1, time_mult: 1,    lives: 3, player_health: 100, hostile_bonus: 1, npc_speed_mult: 1,    sight_mult: 1 }),
  hard:   Object.freeze({ level: "hard",   damage_mult: 1.6, speed_mult: 1, time_mult: 0.75, lives: 2, player_health: 90,  hostile_bonus: 2, npc_speed_mult: 1.15, sight_mult: 1.3 }),
});

/** GameplaySpec.difficulty block (CONTRACT §5 fields only). */
export function gameplayDifficulty(d) {
  return { level: d.level, damage_mult: d.damage_mult, speed_mult: d.speed_mult, time_mult: d.time_mult };
}
