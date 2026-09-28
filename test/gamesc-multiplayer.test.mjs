// test/gamesc-multiplayer.test.mjs — GAMES-C multiplayer integration shim.
// Pure; offline; no sockets. Run: node --test test/gamesc-multiplayer*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyManifest, validateManifest } from "../src/v3/manifest/schema.mjs";
import { hashManifestExact as hashManifest } from "../src/v3/gamesc/publish/canonical.mjs";
import {
  NETCODE_PROTOCOL,
  sessionConfigFromManifest,
  multiplayerGate,
  worldMultiplayerStatus,
  buildJoinFrame,
} from "../src/v3/gamesc/multiplayer/index.mjs";

const base = () => emptyManifest({ worldId: "w_mp_test", title: "MP test" });
const mpWorld = () => {
  const m = base();
  m.multiplayer = { enabled: true, max_players: 8, authoritative: "server", replicated_refs: [], shared_zones: [] };
  m.spawn.player_spawns = [
    { id: "a", position: { x: 1, y: 1, z: 2 }, zone: null },
    { id: "b", position: { x: -10, y: 0, z: 40 }, zone: null },
  ];
  return m;
};

test("fixture manifests are schema-valid", () => {
  assert.equal(validateManifest(base()).ok, true);
  assert.equal(validateManifest(mpWorld()).ok, true);
});

test("sessionConfigFromManifest: default world → config, multiplayer disabled, warnings honest", () => {
  const r = sessionConfigFromManifest(base());
  assert.equal(r.ok, true);
  assert.equal(r.config.world_id, "w_mp_test");
  assert.equal(r.config.world_version, 1);
  assert.equal(r.config.max_players, 1);
  assert.equal(r.config.manifest_multiplayer_enabled, false);
  assert.equal(r.config.authoritative, "server");
  assert.deepEqual(r.config.spawn_points, [{ id: "spawn_default", position: { x: 0, y: 1, z: 0 }, zone: null }]);
  assert.equal(r.config.tick_hz, 15);
  const codes = r.warnings.map((w) => w.code);
  assert.ok(codes.includes("server_spawn_unsupported"));
  assert.ok(codes.includes("server_cap_unenforced"));
  assert.ok(codes.includes("manifest_multiplayer_disabled"));
});

test("sessionConfigFromManifest: spawn points, max players, hash", () => {
  const m = mpWorld();
  const r = sessionConfigFromManifest(m);
  assert.equal(r.ok, true);
  assert.equal(r.config.max_players, 8);
  assert.equal(r.config.manifest_multiplayer_enabled, true);
  assert.deepEqual(r.config.spawn_points.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(r.config.spawn_points[1].position, { x: -10, y: 0, z: 40 });
  assert.match(r.config.manifest_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(r.config.manifest_hash, hashManifest(m));
  assert.ok(!r.warnings.some((w) => w.code === "manifest_multiplayer_disabled"));
});

test("sessionConfigFromManifest: hash is stable across key order and changes with content/version", () => {
  const m = mpWorld();
  const reordered = Object.fromEntries(Object.entries(m).reverse());
  assert.equal(sessionConfigFromManifest(reordered).config.manifest_hash, sessionConfigFromManifest(m).config.manifest_hash);
  const bumped = mpWorld(); bumped.world_version = 2;
  assert.notEqual(sessionConfigFromManifest(bumped).config.manifest_hash, sessionConfigFromManifest(m).config.manifest_hash);
  assert.equal(sessionConfigFromManifest(bumped).config.world_version, 2);
});

test("sessionConfigFromManifest: does not mutate input and returns copies", () => {
  const m = mpWorld();
  const before = JSON.stringify(m);
  const r = sessionConfigFromManifest(m);
  r.config.spawn_points[0].position.x = 999;
  assert.equal(JSON.stringify(m), before);
});

test("sessionConfigFromManifest: never throws on garbage; invalid manifest → ok:false", () => {
  for (const bad of [null, undefined, 42, "x", [], { world_id: "only" }]) {
    const r = sessionConfigFromManifest(bad);
    assert.equal(r.ok, false);
    assert.equal(r.config, null);
    assert.ok(r.errors.length > 0);
  }
  const noSpawn = mpWorld(); noSpawn.spawn.player_spawns = [];
  assert.equal(sessionConfigFromManifest(noSpawn).ok, false);
  const badCap = mpWorld(); badCap.multiplayer.max_players = 0;
  assert.equal(sessionConfigFromManifest(badCap).ok, false);
});

test("sessionConfigFromManifest: rejects client-authoritative and out-of-netcode-bounds spawns", () => {
  const ca = mpWorld(); ca.multiplayer.authoritative = "client";
  const r1 = sessionConfigFromManifest(ca);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.path === "multiplayer.authoritative"));
  const far = mpWorld(); far.spawn.player_spawns[1].position.x = 501;
  const r2 = sessionConfigFromManifest(far);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.path === "spawn.player_spawns[1].position"));
});

test("sessionConfigFromManifest: a throwing hash fn is reported, not thrown", () => {
  const r = sessionConfigFromManifest(mpWorld(), { hashManifest: () => { throw new Error("boom"); } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /boom/);
});

test("multiplayerGate: default (no env) is disabled", () => {
  assert.deepEqual(multiplayerGate({}), { enabled: false, reason: "flag_off", netcode_url: null, play_url: null });
  assert.equal(multiplayerGate().enabled, false);
  assert.equal(multiplayerGate(null).enabled, false);
});

test("multiplayerGate: URL alone or flag alone is NOT enough", () => {
  assert.equal(multiplayerGate({ DCS_NETCODE_URL: "wss://netcode.example.test" }).reason, "flag_off");
  assert.equal(multiplayerGate({ DCS_MULTIPLAYER_ENABLED: "1" }).reason, "netcode_url_unset");
  assert.equal(multiplayerGate({ DCS_MULTIPLAYER_ENABLED: "0", DCS_NETCODE_URL: "wss://n.example.test" }).enabled, false);
  assert.equal(multiplayerGate({ DCS_MULTIPLAYER_ENABLED: "false", DCS_NETCODE_URL: "wss://n.example.test" }).enabled, false);
});

test("multiplayerGate: both set → enabled with /play URL", () => {
  const g = multiplayerGate({ DCS_MULTIPLAYER_ENABLED: "true", DCS_NETCODE_URL: "wss://netcode.example.test/ignored?x=1" });
  assert.equal(g.enabled, true);
  assert.equal(g.netcode_url, "wss://netcode.example.test");
  assert.equal(g.play_url, "wss://netcode.example.test/play");
  const local = multiplayerGate({ DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_URL: "ws://127.0.0.1:8090" });
  assert.equal(local.enabled, true);
  assert.equal(local.play_url, "ws://127.0.0.1:8090/play");
});

test("multiplayerGate: rejects bad scheme, plaintext remote, credentials, garbage", () => {
  const on = (u) => multiplayerGate({ DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_URL: u });
  assert.equal(on("https://n.example.test").reason, "netcode_url_scheme");
  assert.equal(on("javascript:alert(1)").reason, "netcode_url_scheme");
  assert.equal(on("ws://n.example.test").reason, "netcode_url_insecure");
  assert.equal(on("wss://user:pw@n.example.test").reason, "netcode_url_credentials");
  assert.equal(on("not a url").reason, "netcode_url_invalid");
});

test("worldMultiplayerStatus: gate off → disabled even for an MP-enabled manifest", () => {
  assert.deepEqual(worldMultiplayerStatus(mpWorld(), {}), { enabled: false, reason: "flag_off" });
});

test("worldMultiplayerStatus: gate on requires the manifest to opt in and be valid", () => {
  const env = { DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_URL: "wss://n.example.test" };
  assert.equal(worldMultiplayerStatus(base(), env).reason, "manifest_multiplayer_disabled");
  assert.equal(worldMultiplayerStatus({ nope: 1 }, env).reason, "manifest_invalid");
  const s = worldMultiplayerStatus(mpWorld(), env);
  assert.equal(s.enabled, true);
  assert.equal(s.play_url, "wss://n.example.test/play");
  assert.equal(s.config.max_players, 8);
});

test("flagship-e2e invariant preserved: default manifest + default env = multiplayer off", () => {
  const m = base();
  assert.equal(m.multiplayer.enabled, false);
  assert.ok(m.multiplayer.max_players >= 1);
  assert.equal(worldMultiplayerStatus(m, {}).enabled, false);
  // Even with the gate fully on, a default manifest (enabled:false) stays off.
  assert.equal(worldMultiplayerStatus(m, { DCS_MULTIPLAYER_ENABLED: "1", DCS_NETCODE_URL: "wss://n.example.test" }).enabled, false);
});

test("buildJoinFrame: shape + validation", () => {
  assert.deepEqual(buildJoinFrame({ token: "t", world_id: "w" }), { ok: true, frame: { type: "join", token: "t", world_id: "w" } });
  assert.deepEqual(buildJoinFrame({ token: "t", world_id: "w", session_id: "s" }).frame, { type: "join", token: "t", world_id: "w", session_id: "s" });
  assert.equal(buildJoinFrame({ world_id: "w" }).ok, false);
  assert.equal(buildJoinFrame({ token: "t" }).ok, false);
  assert.equal(buildJoinFrame({ token: "x".repeat(4097), world_id: "w" }).ok, false);
  assert.equal(buildJoinFrame({ token: "t", world_id: "w", session_id: "" }).ok, false);
  assert.equal(buildJoinFrame().ok, false);
});

test("NETCODE_PROTOCOL is frozen and honest about missing server capabilities", () => {
  assert.ok(Object.isFrozen(NETCODE_PROTOCOL));
  assert.equal(NETCODE_PROTOCOL.supports_spawn_points, false);
  assert.equal(NETCODE_PROTOCOL.enforces_max_players, false);
  assert.equal(NETCODE_PROTOCOL.real_auth, false);
});

// Cross-repo drift check: only runs where the netcode worktree exists locally
// (skipped in CI, which has no sibling checkout).
const NETCODE_DIR = process.env.DCS_NETCODE_DIR || path.join(os.homedir(), "Developer", "dcs-games-c-netcode");
const contractPath = path.join(NETCODE_DIR, "contracts", "netcode-protocol.json");
test("NETCODE_PROTOCOL matches the netcode repo contract (local only)", { skip: !fs.existsSync(contractPath) && "netcode checkout not present" }, () => {
  const c = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  assert.equal(c.version, NETCODE_PROTOCOL.protocol_version);
  assert.equal(c.tick_hz, NETCODE_PROTOCOL.tick_hz);
  const validation = fs.readFileSync(path.join(NETCODE_DIR, "src", "validation.ts"), "utf8");
  assert.match(validation, /WORLD_BOUNDS:\s*\{\s*min:\s*-500,\s*max:\s*500\s*\}/);
  assert.match(validation, /MAX_MOVE_SPEED:\s*8\.0/);
  const session = fs.readFileSync(path.join(NETCODE_DIR, "src", "session.ts"), "utf8");
  // If the server ever learns spawn points, this fails and the shim flag must flip.
  assert.match(session, /const spawnPos: Vec3 = \{ x: 0, y: 0, z: 0 \}/);
});
