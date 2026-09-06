// A keyed async mutex, so a read-modify-write cannot interleave with itself.
//
// Every durable store on this estate is read-modify-write: read the whole JSON
// file, change one row, write it back. There are awaits between the read and
// the write, so two concurrent callers both read the OLD contents and the
// second write erases the first. The caller is told 201. Nothing errors.
//
// Measured before this existed: TWO simultaneous play records produced one
// stored row; 128 produced one. 128 first-time sign-ins produced two profiles.
// 64 concurrent world saves advanced the version by one. That is not a stress
// case — the floor is two concurrent requests, which is ordinary traffic.
//
// SCOPE, stated plainly: this serialises writers WITHIN ONE PROCESS. It is the
// right fix for the file-backed store, which is process-local anyway. It does
// NOT make two server instances sharing a directory safe, and it is not a
// substitute for the database doing this properly — Postgres already holds the
// real constraints, and a multi-instance deployment must use it rather than the
// file store. `describeCollections` reports which one is in use.
export function createKeyedMutex() {
  /** key -> a promise that resolves when the last queued holder releases */
  const tails = new Map();

  return async function withLock(key, fn) {
    const prev = tails.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((res) => { release = res; });
    // The queue must survive a holder that throws, or one failed write would
    // deadlock every later write to the same key.
    const tail = prev.then(() => mine, () => mine);
    tails.set(key, tail);

    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Drop the entry once nothing is queued behind us, so a long-running
      // process does not accumulate one promise per key it has ever touched.
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
