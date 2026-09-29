// Games-D engine flags. Node-side.
//
// DCS_GAMES_ENGINE_EXTERNAL is the switch that will one day let the games
// engine route a stage to an external (paid) provider. It is OFF, and in this
// build it cannot be turned on: no provider benchmark has been approved, so an
// external route has nothing measured to stand on. Any value other than unset
// or "0" is recorded as a request and refused; the build stays local
// (fail-closed), and the refusal is reported back to the caller, never hidden.
//
// Enabling it later is a code change behind a founder GO, not an env flip:
// `ENGINE_EXTERNAL_APPROVED` must become true in the same change that wires a
// capped provider route.

export const ENGINE_EXTERNAL_ENV = "DCS_GAMES_ENGINE_EXTERNAL";
export const ENGINE_EXTERNAL_APPROVED = false;

/** Provenance label every Games-D package and result carries. */
export const LOCAL_FALLBACK_PROVIDER = "local_fallback";

/**
 * @param {object} [env=process.env]
 * @returns {{ name: string, value: string|null, requested: boolean, enabled: false, reason: string|null }}
 */
export function resolveEngineExternal(env = process.env) {
  const raw = env?.[ENGINE_EXTERNAL_ENV];
  const value = raw === undefined || raw === null ? null : String(raw).trim();
  const requested = value !== null && value !== "" && value !== "0";
  return {
    name: ENGINE_EXTERNAL_ENV,
    value,
    requested,
    enabled: false,
    reason: requested
      ? `${ENGINE_EXTERNAL_ENV}=${JSON.stringify(value)} refused: external engine routes are not approved in this build; built locally`
      : null,
  };
}
