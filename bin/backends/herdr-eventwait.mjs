#!/usr/bin/env node
// Windows named-pipe subscriber for herdr's native pane.agent_status_changed
// stream - the win32 sibling of herdr-eventwait.py, and the WIRE TRANSPORT half
// of the herdr push-escalation path (bin/backends/herdr.sh
// fm_backend_herdr_wait_transition). Like its Python sibling it deliberately
// does NOT know firstmate's supervision policy: it opens ONE connection,
// subscribes, and projects one line per event for the bash normalizer.
//
// WHY A SECOND READER EXISTS
// The Python reader speaks AF_UNIX, and win32 CPython exposes no AF_UNIX at
// all - verified absent on 3.11, 3.12 and 3.13 here, even though the OS has
// supported it since build 17063. That alone would be reason enough, but the
// deeper reason is that it would not help: herdr does not serve a Unix socket
// on Windows. The advertised `.sock` path is a plain ~25 byte text file holding
// a `<server-pid>:<nonce>` token, and connecting to it yields ENOTSOCK. The
// real endpoint is a NAMED PIPE whose name embeds that same path:
//
//   \\.\pipe\C:\Users\<user>\AppData\Roaming\herdr\herdr.sock
//
// Node reaches named pipes natively, and the wire protocol above the transport
// is identical, so this file changes the socket and nothing else.
//
// Wire protocol (newline-delimited JSON), byte-identical to the Python reader:
//   request : {"id","method":"events.subscribe","params":{"subscriptions":[
//              {"type":"pane.agent_status_changed","pane_id":P}, ...]}}\n
//   ack     : {"id",...,"result":{"type":"subscription_started"}}\n
//   stream  : {"event":"pane.agent_status_changed","data":{...}}\n
//
// Usage: herdr-eventwait.mjs <socket_path> <timeout_seconds> <pane_id> [...]
//
// Output, matching the Python reader exactly so the bash caller cannot tell
// them apart (a raw projection, NOT the normalized record):
//   @subscribed
//   <pane_id>\t<workspace_id>\t<agent_status>\t<agent>
//
// Exit status, also matching:
//   0  streamed until the timeout elapsed with no error - a clean bounded wait.
//   2  bad arguments, could not connect, or could not send the subscribe request.
//   3  the subscribe request did not return a subscription_started ack.
//   4  the server closed the stream early or a receive operation failed.
// A non-zero exit tells the bash caller to fall back to plain polling for this
// cycle, never to go silent.

import net from "node:net";

const CONNECT_TIMEOUT_MS = 5000;
const ACK_TIMEOUT_MS = 5000;
const BS = String.fromCharCode(92);

// Exit without letting a pending stdout write resurrect us, and without
// throwing if the caller already closed the pipe.
function done(code) {
  try {
    process.exitCode = code;
    process.stdout.end();
  } catch {
    /* already gone */
  }
  process.exit(code);
}

// Accept the socket path in either form the callers use - native
// `C:\...\herdr.sock` or MSYS `/c/.../herdr.sock` - and name the pipe that
// actually serves it.
// Built with string operations rather than a RegExp: a literal backslash has
// to be doubled in a pattern source, which is an easy and silent thing to get
// wrong when the pattern is assembled from a variable.
function pipePathFor(sockPath) {
  let p = sockPath.split("/").join(BS);
  // MSYS form: \c\Users\... -> C:\Users\...
  if (p.length > 2 && p[0] === BS && p[2] === BS && /^[A-Za-z]$/.test(p[1])) {
    p = p[1].toUpperCase() + ":" + p.slice(2);
  }
  return BS + BS + "." + BS + "pipe" + BS + p;
}

// Tabs and newlines would corrupt the caller's TAB-separated line shape.
function clean(value) {
  return String(value ?? "").replace(/[\t\r\n]/g, " ");
}

const argv = process.argv.slice(2);
if (argv.length < 3) done(2);
const sockPath = argv[0];
const timeoutSeconds = Number(argv[1]);
const panes = argv.slice(2);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || panes.length === 0) done(2);

const deadline = Date.now() + timeoutSeconds * 1000;
let subscribed = false;
let buf = "";

const socket = net.connect({ path: pipePathFor(sockPath) });
socket.setNoDelay(true);

// Connect budget is its own, and is torn down once the connection lands.
const connectTimer = setTimeout(() => {
  try { socket.destroy(); } catch { /* ignore */ }
  done(2);
}, CONNECT_TIMEOUT_MS);

// The overall bounded wait. Reaching it with no error is the SUCCESS case: it
// means "no fast escalation this cycle", and the caller keeps its poll cadence.
const overallTimer = setTimeout(() => {
  try { socket.destroy(); } catch { /* ignore */ }
  done(0);
}, Math.max(1, deadline - Date.now()));

// The ack has its own short budget, never past the overall deadline.
let ackTimer = setTimeout(
  () => {
    if (!subscribed) {
      try { socket.destroy(); } catch { /* ignore */ }
      done(2);
    }
  },
  Math.max(1, Math.min(ACK_TIMEOUT_MS, deadline - Date.now())),
);

socket.on("connect", () => {
  clearTimeout(connectTimer);
  const request = {
    id: "fm-eventwait",
    method: "events.subscribe",
    params: {
      subscriptions: panes.map((pane) => ({
        type: "pane.agent_status_changed",
        pane_id: pane,
      })),
    },
  };
  try {
    socket.write(JSON.stringify(request) + "\n");
  } catch {
    done(2);
  }
});

socket.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let index;
  while ((index = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, index);
    buf = buf.slice(index + 1);
    if (!line.trim()) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // A malformed frame is skipped rather than fatal, matching the Python
      // reader: one bad line must not cost the whole bounded wait.
      if (!subscribed) done(3);
      continue;
    }

    if (!subscribed) {
      if ((message.result || {}).type !== "subscription_started") done(3);
      subscribed = true;
      clearTimeout(ackTimer);
      ackTimer = null;
      process.stdout.write("@subscribed\n");
      continue;
    }

    if (message.event !== "pane.agent_status_changed") continue;
    const data = message.data || {};
    process.stdout.write(
      [
        clean(data.pane_id),
        clean(data.workspace_id),
        clean(data.agent_status),
        clean(data.agent),
      ].join("\t") + "\n",
    );
  }
});

// The server closing, or any socket error, is the caller's signal to poll this
// cycle rather than trust a truncated stream.
socket.on("close", () => done(subscribed ? 4 : 2));
socket.on("error", () => done(subscribed ? 4 : 2));

// The bash caller kills this reader once it has its actionable edge; that is a
// normal, successful end of the wait, not a failure.
process.stdout.on("error", (err) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) process.exit(0);
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
