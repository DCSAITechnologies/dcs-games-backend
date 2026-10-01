// Graceful SIGTERM: stop taking new work, let the work in hand finish, exit 0.
//
// THE OLD INSTANCE DROPPED REQUESTS AT EVERY HANDOVER. (1 Oct 2026, staging L1.)
// The platform starts the new deployment, moves traffic to it and sends the old
// one SIGTERM. Nothing here listened for it, so Node's default ran: exit at
// once, mid-response. Every request still in flight on the old instance was cut
// off, and the edge reported it as a 499/5xx that no handler ever wrote.
//
// On the first SIGTERM or SIGINT:
//   - isDraining() turns true, so /ready answers 503 and no healthcheck or
//     router sends this instance anything new;
//   - the listener closes, so no new connection is accepted;
//   - idle keep-alive sockets are closed, and a request that arrives on a busy
//     one is still served, with `Connection: close`, so the proxy reconnects to
//     the new instance for the next one rather than seeing a reset;
//   - when the last in-flight request finishes the process exits 0.
// If work is still running after graceMs, the remaining sockets are closed and
// the process exits 0 anyway: shutdown is bounded, and the platform's SIGKILL
// (its draining window) must be longer than graceMs for this to be the path.
// A second signal during the drain is logged and otherwise ignored.
export function installGracefulShutdown(server, {
  graceMs = 10000,
  signals = ["SIGTERM", "SIGINT"],
  exit = (code) => process.exit(code),
  log = (msg) => console.log(msg),
} = {}) {
  let draining = false;
  let inflight = 0;

  // Prepended so the header is set before the application handler writes.
  server.prependListener("request", (req, res) => {
    inflight++;
    let done = false;
    // A request that was in flight when the drain began went out on a
    // keep-alive socket; once it is answered that socket is idle and would hold
    // close() open until the keep-alive timeout, so it is closed here.
    const finish = () => {
      if (done) return;
      done = true; inflight--;
      if (draining && typeof server.closeIdleConnections === "function") setImmediate(() => server.closeIdleConnections());
    };
    res.once("finish", finish);
    res.once("close", finish);
    if (draining) res.setHeader("Connection", "close");
  });

  function begin(signal = "manual") {
    if (draining) { log(`[shutdown] ${signal} again while draining (${inflight} in flight); still waiting`); return; }
    draining = true;
    const t0 = Date.now();
    log(`[shutdown] ${signal}: draining, ${inflight} request(s) in flight, grace ${graceMs}ms`);
    let exited = false;
    const leave = (how) => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      log(`[shutdown] ${how} after ${Date.now() - t0}ms; exit 0`);
      exit(0);
    };
    const timer = setTimeout(() => {
      log(`[shutdown] grace ${graceMs}ms over with ${inflight} request(s) still in flight; closing them`);
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      leave("forced close");
    }, graceMs);
    server.close(() => leave("drained"));
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
  }

  for (const s of signals) process.on(s, () => begin(s));

  return {
    isDraining: () => draining,
    inflight: () => inflight,
    begin,
  };
}
