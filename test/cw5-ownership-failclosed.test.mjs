// Object ownership must fail CLOSED.
//
// save() reads who owns what by calling load(), and wrapped that call in
//   try { ... } catch { /* no base world yet: nothing is owned */ }
// so ANY load failure left the ownership map empty. An empty map makes
// assertActorBound find no owner for anything and permit every op — the
// ownership check does not refuse, it disappears.
//
// That was reachable in two requests. A `var_set` op with no key was accepted
// on the way in, and applyOp throws on it during replay, so load() threw from
// then on — permanently, because the store is append-only and the bad op cannot
// be taken back out. The second request could then act on anybody's objects.
import test from "node:test";
import assert from "node:assert/strict";

// The CW5 engine is TypeScript with parameter properties, so plain `node --test`
// cannot load it. Under `tsx --test` it runs in full. The skip is conditional on
// the loader, never on the outcome — see the same pattern in livestate.test.mjs.
let cw5 = null;
try { cw5 = await import("../src/cw5/cw5_persistence.ts"); } catch { /* needs tsx */ }

function engine() {
  const store = new cw5.InMemoryPersistenceStore();
  return { engine: new cw5.PersistenceEngine(store), store };
}

test("CW5 GATE: a malformed op is refused rather than stored", async (t) => {
  if (!cw5) return t.skip("CW5 engine needs tsx (TypeScript parameter properties)");
  const { engine: e, store } = engine();
  await store.putBaseWorld({ world_id: "w1", objects: [] });
  await assert.rejects(
    () => e.save({ world_id: "w1", seq: 1, ops: [{ op: "var_set", value: 1 }] }, { actorId: "u1" }),
    (err) => /not valid and would make this world unreadable/.test(String(err.message)),
    "a var_set with no key must never reach an append-only store"
  );
  // And the world is still readable, because nothing was written.
  const snap = await e.load("w1");
  assert.ok(snap, "the world must still load after a refused save");
});

test("CW5 GATE: if ownership cannot be read, the save is refused, not permitted", async (t) => {
  if (!cw5) return t.skip("CW5 engine needs tsx (TypeScript parameter properties)");
  const { engine: e, store } = engine();
  await store.putBaseWorld({ world_id: "w2", objects: [{ object_id: "o1", owner_id: "alice" }] });

  // Simulate a world whose replay is broken, which is the state the malformed
  // op used to produce. The point is the DECISION: an unreadable world must not
  // become an unguarded one.
  const realLoad = e.load.bind(e);
  e.load = async (id) => { if (id === "w2") throw new Error("replay failed: var_set requires key"); return realLoad(id); };

  await assert.rejects(
    () => e.save({ world_id: "w2", seq: 1, ops: [{ op: "remove_object", object_id: "o1" }] }, { actorId: "mallory" }),
    (err) => /ownership could not be read/.test(String(err.message)),
    "acting without ownership means acting with the check silently disabled"
  );
});

test("CW5: a world that genuinely does not exist yet still accepts a first save", async (t) => {
  if (!cw5) return t.skip("CW5 engine needs tsx (TypeScript parameter properties)");
  // The legitimate case the original catch was written for must keep working:
  // nothing is owned because nothing is there.
  const { engine: e } = engine();
  const r = await e.save({ world_id: "w_new", seq: 1, ops: [{ op: "var_set", key: "weather", value: "rain" }] }, { actorId: "u1" });
  assert.equal(r.ok, true);
});
