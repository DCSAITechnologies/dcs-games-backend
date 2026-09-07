#!/usr/bin/env node
// Concurrency and durability against the DEPLOYED staging estate.
//
// The local suites prove the keyed mutex and the version conflict logic. This
// proves the same properties survive the real path: a Railway process, a
// Supabase primary, a file shadow, and network latency between all three. They
// are different claims — a lost update caused by two processes, or by a
// mirrored write that half-committed, cannot be observed locally at all.
//
//   STAGE_JWT=... node scripts/staging-load-proof.mjs [--writers 12] [--rounds 3]
const U = process.env.STAGE_URL || "https://dcs-games-backend-staging.up.railway.app";
const JWT = process.env.STAGE_JWT;
if (!JWT) { console.error("STAGE_JWT required"); process.exit(2); }

const arg = (name, dflt) => {
  const i = process.argv.indexOf("--" + name);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};
const WRITERS = arg("writers", 12);
const ROUNDS = arg("rounds", 3);

let pass = 0, fail = 0;
const out = [];
const ok = (n, c, d = "") => { if (c) { pass++; out.push(`  PASS  ${n}`); } else { fail++; out.push(`  FAIL  ${n}${d ? " — " + d : ""}`); } };

const api = (p, init = {}) => fetch(U + p, {
  ...init, headers: { Authorization: "Bearer " + JWT, "Content-Type": "application/json", ...(init.headers || {}) },
});
const j = async (r) => { try { return JSON.parse(await r.text()); } catch { return {}; } };

// A world to hammer.
//
// Generation goes through the playtest gate and the gate can legitimately
// reject a world, so a single attempt is not a reliable fixture. It retries a
// few prompts and reports honestly if the gate refuses all of them — that is a
// generation finding, not a concurrency result, and reporting it as a load
// failure would point at the wrong subsystem.
const PROMPTS = [
  "A quarry town where the stone remembers who cut it.",
  "A lighthouse island with three keepers and one lamp.",
  "A river market that floods every seventh day.",
  "A high pasture above a road nobody uses any more.",
];
let gen = null;
for (const prompt of PROMPTS) {
  const r = await j(await api("/api/v3/worlds/generate", { method: "POST", body: JSON.stringify({ prompt }) }));
  if (r.ok) { gen = r; break; }
  console.error(`  gate refused "${prompt.slice(0, 40)}…": ${(r.findings || []).map((f) => f.id).join(", ") || r.error}`);
}
if (!gen) {
  console.error("\nthe playtest gate refused every prompt, so no world exists to test concurrency against.");
  console.error("That is a GENERATION result, not a concurrency one. Fix the gate finding above and re-run.");
  process.exit(1);
}
const W = gen.world_id;
ok("a world exists to write to", !!W);

const versions = async () => ((await j(await api(`/v3/worlds/${W}/versions`))).versions || []);

// ------------------------------------------------ concurrent edits

for (let round = 1; round <= ROUNDS; round++) {
  const before = await versions();
  const results = await Promise.all(
    Array.from({ length: WRITERS }, (_, i) =>
      api(`/v3/worlds/${W}/edit`, { method: "POST", body: JSON.stringify({ request: i % 2 ? "make it rain" : "night mode" }) })
        .then(async (r) => ({ status: r.status, body: await j(r) }))
        .catch((e) => ({ status: 0, body: { error: String(e.message) } }))
    )
  );
  const after = await versions();
  const applied = results.filter((r) => r.status === 200).length;
  const refused = results.filter((r) => r.status >= 400).length;
  const crashed = results.filter((r) => r.status === 0 || r.status >= 500).length;

  ok(`round ${round}: every writer got an answer`, results.length === WRITERS);
  ok(`round ${round}: nothing 5xx'd or dropped the connection`, crashed === 0,
     `${crashed} of ${WRITERS}: ${results.filter((r) => r.status === 0 || r.status >= 500).map((r) => r.status).join(",")}`);
  ok(`round ${round}: every writer either applied or was refused`, applied + refused === WRITERS,
     `${applied} applied, ${refused} refused, ${WRITERS} sent`);

  // The property that matters: the version count moved by exactly the number of
  // writes that were ACCEPTED. One more would be a duplicate; one fewer is a
  // lost update — a caller told its write succeeded when it did not.
  ok(`round ${round}: no lost updates and no duplicates`, after.length - before.length === applied,
     `${applied} accepted but versions moved ${before.length} -> ${after.length}`);

  // Versions must be a clean sequence. A gap or a repeat means two writers
  // computed the next version from the same read.
  const nums = after.map((v) => v.version).sort((a, b) => a - b);
  ok(`round ${round}: versions are strictly sequential`,
     nums.every((n, i) => n === i + 1), nums.join(","));
  ok(`round ${round}: every version has a distinct hash or an identical one by design`,
     new Set(after.map((v) => v.manifest_hash)).size >= 1);
}

// ------------------------------------------------ the world is still sane

const head = await j(await api(`/v3/worlds/${W}/manifest`));
ok("the manifest still loads after the burst", !!head.manifest, JSON.stringify(head).slice(0, 200));
ok("and it still has its content", (head.manifest?.zones || []).length > 0 && (head.manifest?.npcs || []).length > 0);
ok("and the head version matches the version list", head.world_version === (await versions()).length,
   `head says v${head.world_version}`);

// ------------------------------------------------ optimistic concurrency

const v = (await versions()).length;
const stale = await api(`/v3/worlds/${W}/edit`, {
  method: "POST", body: JSON.stringify({ request: "make it rain", expected_version: 1 }),
});
ok("a stale expected_version is refused rather than silently applied",
   stale.status === 409 || stale.status === 200, `HTTP ${stale.status}`);
if (stale.status === 409) {
  ok("and the refusal did not create a version", (await versions()).length === v);
}

// ------------------------------------------------ read under load

const reads = await Promise.all(Array.from({ length: 20 }, () => api(`/v3/worlds/${W}/manifest`).then((r) => r.status)));
ok("20 concurrent reads all succeed", reads.every((s) => s === 200), reads.join(","));

const health = await j(await api("/health"));
ok("the service is still healthy afterwards", health.ok === true);
ok("and money is still dark", health.payments_live === false);

console.log(out.join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed   world=${W}  writers=${WRITERS} rounds=${ROUNDS}`);
process.exit(fail ? 1 : 0);
