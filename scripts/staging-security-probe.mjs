#!/usr/bin/env node
// Remote security posture of the DEPLOYED staging estate.
//
// Everything here is checked from OUTSIDE, the way an attacker sees it. Unit
// tests prove the code refuses; this proves the deployment refuses — which are
// different claims, and only the second one covers a misconfigured Supabase
// project, a leaked key, or a service that quietly answers on a path nobody
// meant to expose.
//
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... node scripts/staging-security-probe.mjs
// (run under `railway run` so the staging values come from the environment;
// no secret is ever printed by this script)
import { REQUIRED_SCHEMA_VERSION } from "../src/core/schema.mjs";

const API = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const SUPA = process.env.SUPABASE_URL || "";
const ANON = process.env.SUPABASE_ANON_KEY || "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Projects this deployment must NEVER be pointed at. The staging estate exists
// precisely so that work does not touch the shared production project.
const FORBIDDEN_REFS = ["hznrmbxppcxrrrmyutjn"];

let pass = 0, fail = 0;
const out = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; out.push(`  PASS  ${name}`); }
  else { fail++; out.push(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
};

const TABLES = [
  "dcsgames_worlds", "dcsgames_base_worlds", "dcsgames_profiles", "dcsgames_orgs",
  "dcsgames_reports", "dcsgames_blocks", "dcsgames_media_consents", "dcsgames_world_versions",
];

// ------------------------------------------------ the API's own posture

const health = await (await fetch(API + "/health")).json();
ok("the deployed service is healthy", health.ok === true);
ok("payments are dark", health.payments_live === false, String(health.payments_live));
// Read from the source of truth, not written here. A hardcoded number turns
// every migration into a false failure in the security probe, which is exactly
// the noise that teaches people to ignore it.
ok(`the schema it asserts is the one this code requires (v${REQUIRED_SCHEMA_VERSION})`,
   health.schema_assertion?.version === REQUIRED_SCHEMA_VERSION,
   `deployment reports v${health.schema_assertion?.version}`);
ok("auth is real Supabase JWT verification, not a header", health.auth === "supabase-jwt", String(health.auth));
ok("the x-user-id impersonation path is gone", health.auth_header_fallback_removed === true);
ok("CORS is an allowlist, not a wildcard", health.cors?.mode === "allowlist", String(health.cors?.mode));
ok("the running commit is identifiable", !!health.build?.commit && !!health.build?.deployment_id);

// No secret may ever appear in a public document.
const healthText = JSON.stringify(health);
ok("no service-role key appears in /health", !SERVICE || !healthText.includes(SERVICE));
ok("no anon key appears in /health", !ANON || !healthText.includes(ANON));
for (const ref of FORBIDDEN_REFS) {
  ok(`no production project ref (${ref.slice(0, 8)}…) appears in /health`, !healthText.includes(ref));
}

// --------------------------------------------- unauthenticated refusals

for (const path of ["/worlds/mine", "/me/profile", "/me/home", "/safety/reports", "/v3/marketplace/owned", "/me/entitlements"]) {
  const r = await fetch(API + path);
  ok(`anonymous ${path} is refused`, r.status === 401, `HTTP ${r.status}`);
}

// A forged token must not be accepted.
const forged = [
  "Bearer not-a-token",
  "Bearer " + Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") + ".e30.",
].map((t) => t);
for (const t of forged) {
  const r = await fetch(API + "/me/profile", { headers: { Authorization: t } });
  ok(`a forged credential is refused (${t.slice(0, 24)}…)`, r.status === 401, `HTTP ${r.status}`);
}

// The retired impersonation header must do nothing.
const imp = await fetch(API + "/me/profile", { headers: { "x-user-id": "somebody-else" } });
ok("the x-user-id header cannot authenticate", imp.status === 401, `HTTP ${imp.status}`);

// ------------------------------------------------- money stays dark

for (const path of ["/v3/marketplace/assert-dark", "/v3/subscriptions/assert-dark"]) {
  const r = await fetch(API + path);
  const b = await r.json().catch(() => ({}));
  ok(`${path} confirms nothing has moved`, r.status === 200 && b.ok !== false, `HTTP ${r.status}`);
}
const market = await (await fetch(API + "/api/public/market")).json();
ok("the public market says it is dark rather than empty", market.enabled === false && !!market.reason);

// ------------------------------------ the database, reached directly

if (SUPA && ANON) {
  ok("the deployment points at the dedicated staging project",
     FORBIDDEN_REFS.every((r) => !SUPA.includes(r)), SUPA.replace(/https:\/\/([a-z]{6}).*/, "https://$1…"));

  // The anon key is public by design. What must be true is that it can read
  // NOTHING: RLS is on with no policies, and the anon role holds no grants.
  for (const t of TABLES) {
    const r = await fetch(`${SUPA}/rest/v1/${t}?select=*&limit=1`, {
      headers: { apikey: ANON, Authorization: "Bearer " + ANON },
    });
    ok(`the anon key cannot read ${t} directly`, r.status === 401 || r.status === 403 || r.status === 404,
       `HTTP ${r.status} — a 200 means the Data API is serving rows to anyone with the public key`);
  }
  // And it cannot write.
  const w = await fetch(`${SUPA}/rest/v1/dcsgames_worlds`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ world_id: "probe_should_never_exist", owner_id: "nobody" }),
  });
  ok("the anon key cannot write", w.status >= 400, `HTTP ${w.status}`);

  // GoTrue must not hand out an admin listing to the public key.
  const admin = await fetch(`${SUPA}/auth/v1/admin/users?per_page=1`, {
    headers: { apikey: ANON, Authorization: "Bearer " + ANON },
  });
  ok("the anon key cannot list users", admin.status >= 400, `HTTP ${admin.status}`);
}

// -------------------------------------------- the service does not leak

// A 500 must not carry a runtime message. Provoke one the only way an outsider
// can — malformed input — and check the shape of what comes back.
const bad = await fetch(API + "/v3/worlds/%2e%2e%2f%2e%2e%2fetc%2fpasswd/manifest");
const badText = await bad.text();
ok("a hostile path does not return a filesystem path", !/\/(etc|Users|app|home)\//.test(badText), badText.slice(0, 120));
ok("a hostile path is refused", bad.status >= 400, `HTTP ${bad.status}`);

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   target=${API}`);
process.exit(fail ? 1 : 0);
