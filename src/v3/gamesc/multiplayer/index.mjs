// src/v3/gamesc/multiplayer/index.mjs — GAMES-C multiplayer integration shim.
//
// PURE, client/integration-side only. This module does NOT open sockets, does
// NOT talk to the netcode service and does NOT turn multiplayer on. It gives the
// backend two things it will need the day the netcode service is integrated:
//
//   1. sessionConfigFromManifest(manifest) — derive the session parameters a
//      netcode session should be created with (world id, version, manifest hash,
//      max players, spawn points) from a validated WorldManifestV3, and say
//      plainly which of those the netcode server at 524a7f6 can actually honour.
//   2. multiplayerGate(env) — a default-OFF feature gate. Multiplayer is only
//      considered enabled when DCS_NETCODE_URL is set AND the explicit flag
//      DCS_MULTIPLAYER_ENABLED is "1"/"true". With neither set (the state of
//      every environment today) it is disabled, which keeps the flagship E2E
//      assertion `manifest.multiplayer.enabled === false` true.
//
// Nothing here writes to a manifest; everything returns new objects.
// See docs/games-c/DCS_GAMES_MULTIPLAYER_RECOVERY.md.

import { validateManifest } from "../../manifest/schema.mjs";
import { hashManifestExact as defaultHashManifest } from "../publish/canonical.mjs";

/**
 * What the netcode service (dcs-games-netcode @ 524a7f6) actually implements.
 * Source: contracts/netcode-protocol.json + src/session.ts + src/validation.ts
 * in that repo. Mirrored here (not imported) because it lives in another repo.
 */
export const NETCODE_PROTOCOL = Object.freeze({
  protocol_version: "0.1.0-pre-day0-reconcile", // contracts/netcode-protocol.json "version"
  pinned_sha_recommended: "524a7f61c37313a2437c54f8dae7d9f0daf5424d",
  tick_hz: 15,                  // session.ts TICK_HZ
  keyframe_every_ticks: 30,     // session.ts KEYFRAME_EVERY_TICKS
  endpoint_path: "/play",       // server.ts upgrade handler
  world_bounds: Object.freeze({ min: -500, max: 500 }), // validation.ts LIMITS.WORLD_BOUNDS
  max_move_speed: 8.0,          // validation.ts LIMITS.MAX_MOVE_SPEED (units/sec)
  // Capabilities the server does NOT have today. The shim reports them rather
  // than pretending the derived config will be enforced.
  supports_spawn_points: false, // session.ts join(): fresh players spawn at {0,0,0}
  enforces_max_players: false,  // no cap anywhere in session.ts / gateway.ts
  verifies_world_hash: false,   // join frame carries world_id only; not checked vs session
  real_auth: false,             // server.ts wires mockTokenVerifier ("tok:<user_id>")
});

const TRUE_FLAGS = new Set(["1", "true", "yes", "on"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);

function inBounds(p) {
  const { min, max } = NETCODE_PROTOCOL.world_bounds;
  return [p.x, p.y, p.z].every((c) => c >= min && c <= max);
}

/**
 * Derive a netcode session config from a WorldManifestV3. Never throws.
 *
 * @param {object} manifest
 * @param {{ hashManifest?: (m:object)=>string }} [opts]
 * @returns {{ ok:boolean, errors:Array<{path,message}>, warnings:Array<{code,path,message}>, config:object|null }}
 */
export function sessionConfigFromManifest(manifest, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!isObj(manifest)) {
    return { ok: false, errors: [{ path: "$", message: "manifest must be an object" }], warnings, config: null };
  }
  let v;
  try { v = validateManifest(manifest); } catch (e) {
    return { ok: false, errors: [{ path: "$", message: `manifest validation threw: ${e?.message || e}` }], warnings, config: null };
  }
  if (!v.ok) {
    return { ok: false, errors: v.errors.map((e) => ({ path: e.path, message: e.message })), warnings, config: null };
  }

  const mp = isObj(manifest.multiplayer) ? manifest.multiplayer : {};
  const authoritative = mp.authoritative ?? "server";
  if (authoritative !== "server") {
    errors.push({ path: "multiplayer.authoritative", message: `'${authoritative}' is not supported; the netcode service is server-authoritative only` });
  }
  const max_players = Number.isInteger(mp.max_players) && mp.max_players >= 1 ? mp.max_players : 1;

  const spawn_points = (manifest.spawn?.player_spawns || []).map((s, i) => ({
    id: typeof s.id === "string" && s.id ? s.id : `spawn_${i}`,
    position: { x: s.position.x, y: s.position.y, z: s.position.z },
    zone: s.zone ?? null,
  }));
  spawn_points.forEach((s, i) => {
    if (!inBounds(s.position)) {
      errors.push({ path: `spawn.player_spawns[${i}].position`, message: `outside netcode world bounds [${NETCODE_PROTOCOL.world_bounds.min}, ${NETCODE_PROTOCOL.world_bounds.max}] — every move from here would be rejected as out of bounds` });
    }
  });

  if (!NETCODE_PROTOCOL.supports_spawn_points) {
    warnings.push({ code: "server_spawn_unsupported", path: "spawn.player_spawns", message: "netcode server spawns every fresh player at {0,0,0}; manifest spawn points are not transmitted by the protocol" });
  }
  if (!NETCODE_PROTOCOL.enforces_max_players && max_players > 0) {
    warnings.push({ code: "server_cap_unenforced", path: "multiplayer.max_players", message: "netcode server does not enforce max_players; the backend must gate session issuance" });
  }
  if (mp.enabled !== true) {
    warnings.push({ code: "manifest_multiplayer_disabled", path: "multiplayer.enabled", message: "world is not marked multiplayer-enabled; a session should not be issued" });
  }

  const hashFn = typeof opts.hashManifest === "function" ? opts.hashManifest : defaultHashManifest;
  let manifest_hash;
  try { manifest_hash = hashFn(manifest); } catch (e) {
    errors.push({ path: "$", message: `could not hash manifest: ${e?.message || e}` });
  }

  if (errors.length) return { ok: false, errors, warnings, config: null };

  return {
    ok: true,
    errors,
    warnings,
    config: {
      world_id: manifest.world_id,
      world_version: manifest.world_version,
      manifest_hash,
      manifest_multiplayer_enabled: mp.enabled === true,
      authoritative: "server",
      max_players,
      spawn_points,
      respawn_policy: manifest.spawn?.respawn_policy ?? null,
      safe_radius: isFiniteNum(manifest.spawn?.safe_radius) ? manifest.spawn.safe_radius : null,
      protocol_version: NETCODE_PROTOCOL.protocol_version,
      tick_hz: NETCODE_PROTOCOL.tick_hz,
    },
  };
}

/**
 * Default-OFF feature gate. Pure function of the env object passed in.
 *
 * Enabled only when ALL hold:
 *   - DCS_MULTIPLAYER_ENABLED is "1" / "true" / "yes" / "on"
 *   - DCS_NETCODE_URL is a parseable ws:// or wss:// URL
 *   - ws:// (plaintext) is only allowed for localhost
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ enabled:boolean, reason:string, netcode_url:string|null, play_url:string|null }}
 */
export function multiplayerGate(env = {}) {
  const off = (reason) => ({ enabled: false, reason, netcode_url: null, play_url: null });
  const e = isObj(env) ? env : {};
  const flag = String(e.DCS_MULTIPLAYER_ENABLED ?? "").trim().toLowerCase();
  const raw = String(e.DCS_NETCODE_URL ?? "").trim();
  if (!TRUE_FLAGS.has(flag)) return off("flag_off");
  if (!raw) return off("netcode_url_unset");
  let u;
  try { u = new URL(raw); } catch { return off("netcode_url_invalid"); }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") return off("netcode_url_scheme");
  if (u.protocol === "ws:" && !LOCAL_HOSTS.has(u.hostname)) return off("netcode_url_insecure");
  if (u.username || u.password) return off("netcode_url_credentials");
  const base = `${u.protocol}//${u.host}`;
  return { enabled: true, reason: "enabled", netcode_url: base, play_url: `${base}${NETCODE_PROTOCOL.endpoint_path}` };
}

/**
 * Whether a specific world may offer multiplayer: gate on AND manifest opts in
 * AND the manifest derives a valid session config.
 */
export function worldMultiplayerStatus(manifest, env = {}) {
  const gate = multiplayerGate(env);
  if (!gate.enabled) return { enabled: false, reason: gate.reason };
  const r = sessionConfigFromManifest(manifest);
  if (!r.ok) return { enabled: false, reason: "manifest_invalid", errors: r.errors };
  if (!r.config.manifest_multiplayer_enabled) return { enabled: false, reason: "manifest_multiplayer_disabled" };
  return { enabled: true, reason: "enabled", play_url: gate.play_url, config: r.config };
}

/**
 * Build a C2 `join` frame. Returns { ok, frame | error }. The token is opaque
 * here; it must be a backend-issued session token once real auth exists
 * (today's netcode server accepts "tok:<user_id>" from anyone — see doc).
 */
export function buildJoinFrame({ token, world_id, session_id } = {}) {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return { ok: false, error: "token required (1..4096 chars)" };
  if (typeof world_id !== "string" || world_id.length === 0 || world_id.length > 256) return { ok: false, error: "world_id required (1..256 chars)" };
  if (session_id !== undefined && (typeof session_id !== "string" || session_id.length === 0 || session_id.length > 256)) {
    return { ok: false, error: "session_id must be a non-empty string when present" };
  }
  const frame = { type: "join", token, world_id };
  if (session_id !== undefined) frame.session_id = session_id;
  return { ok: true, frame };
}
