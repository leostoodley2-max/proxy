// Speeds up libcurl.js (inside @mercuryworkshop/libcurl-transport), the
// in-browser HTTP client every proxied request goes through. Runs on every
// install; a no-op once applied.
//
// libcurl.js only processes network events from setInterval(..., 0), which
// browsers clamp to 4 ms per tick. A request needs several ticks (connect,
// TLS, headers, body), so each one waited ~6 ms longer than its network time,
// and every chunk of a video stream waited for the next tick too. Fix: also
// run curl as soon as data arrives from the Wisp tunnel (coalesced through a
// MessageChannel, so no busy loop); the timer stays as a fallback for curl's
// own timeouts.

const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "node_modules", "@mercuryworkshop", "libcurl-transport", "dist", "index.mjs");
const MARK = "__orbitKick";

const edits = [
  // Shared scheduler, declared next to the classes that use it.
  ["  class WispConnection extends EventTarget {",
    "  const __orbitSessions = new Set();\n" +
    "  let __orbitKickPending = false;\n" +
    "  const __orbitKickChannel = new MessageChannel();\n" +
    "  __orbitKickChannel.port1.onmessage = () => {\n" +
    "    __orbitKickPending = false;\n" +
    "    for (const session of __orbitSessions) {\n" +
    "      try { session.event_loop_func(); } catch (e) { console.error(e); }\n" +
    "    }\n" +
    "  };\n" +
    "  function __orbitKick() {\n" +
    "    if (__orbitKickPending || !__orbitSessions.size) return;\n" +
    "    __orbitKickPending = true;\n" +
    "    __orbitKickChannel.port2.postMessage(0);\n" +
    "  }\n" +
    "  class WispConnection extends EventTarget {"],
  // Data arrived from the tunnel: let curl handle it now.
  ["        this.on_ws_msg(event);\n", "        this.on_ws_msg(event);\n        __orbitKick();\n"],
  // Sessions with requests in flight get kicked; idle ones are dropped.
  ["      this.requests_list.push(request_ptr);\n", "      this.requests_list.push(request_ptr);\n      __orbitSessions.add(this);\n"],
  ["        clearInterval(this.event_loop);\n        this.event_loop = null;",
    "        clearInterval(this.event_loop);\n        this.event_loop = null;\n        __orbitSessions.delete(this);"],
];

let code;
try {
  code = fs.readFileSync(file, "utf8");
} catch {
  console.warn("[patch-libcurl] libcurl transport not found; skipped");
  process.exit(0);
}
if (code.includes(MARK)) {
  console.log("[patch-libcurl] already patched");
  process.exit(0);
}
for (const [find] of edits) {
  if (code.split(find).length !== 2) {
    console.warn("[patch-libcurl] Unexpected code (" + JSON.stringify(find.trim().slice(0, 40)) +
      "); left unchanged. Requests stay slower.");
    process.exit(0);
  }
}
for (const [find, replace] of edits) code = code.replace(find, () => replace);
fs.writeFileSync(file, code);
console.log("[patch-libcurl] Patched event loop");
