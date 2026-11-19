// Web proxy server.
//
// The heavy lifting happens in the browser: a Scramjet service worker
// intercepts every request a proxied page makes (HTML, JS, XHR, video
// segments, WebSockets) and rewrites it client-side. All of that traffic is
// tunnelled to this server over a single Wisp WebSocket at /wisp/, and this
// server just opens the TCP connections. So this file only has to:
//   1. serve the static UI and the engine files,
//   2. route WebSocket upgrades on /wisp/ to the Wisp server.

const http = require("node:http");
const path = require("node:path");
const express = require("express");
const compression = require("compression");
const { server: wisp, logging } = require("@mercuryworkshop/wisp-js/server");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const { libcurlPath } = require("@mercuryworkshop/libcurl-transport");
const { startWarp, stopWarp, getRoute, getEgress } = require("./warp");
const { makeTCPSocket } = require("./wisp-socks");

const PORT = parseInt(process.env.PORT, 10) || 8080;
const warpEnabled = process.env.WARP?.toLowerCase() !== "off";

logging.set_level(logging.WARN);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  // Don't let proxied pages reach the server's own network.
  allow_private_ips: false,
  allow_loopback_ips: false,
  dns_servers: ["1.1.1.1", "1.0.0.1"],
});

const app = express();
app.disable("x-powered-by");
app.use(compression());

// Scramjet needs a cross-origin isolated top page (SharedArrayBuffer).
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

const cacheLong = { maxAge: "7d", immutable: false };
app.use("/scram/", express.static(scramjetPath, cacheLong));
app.use("/baremux/", express.static(baremuxPath, cacheLong));
app.use("/libcurl/", express.static(libcurlPath, cacheLong));

// The service worker must never be cached, or updates get stuck.
app.get("/sw.js", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

// UI files revalidate on every load (cheap 304s) so a new deploy shows up at once.
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

// Render's health check.
app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.get("/egress", (req, res) => res.set("Cache-Control", "no-store").json(getEgress()));

// Any unknown path (e.g. a stale proxied URL opened before the service worker
// is ready) loads the app instead of a bare 404, so the browser can recover.
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
const TCPSocket = warpEnabled ? makeTCPSocket(getRoute, wisp.options) : undefined;

server.on("upgrade", (req, socket, head) => {
  if (req.url.endsWith("/wisp/")) wisp.routeRequest(req, socket, head, { TCPSocket });
  else socket.end();
});

// Render's load balancer drops idle connections after ~60s; keep sockets alive
// a bit longer than that so long video streams aren't cut mid-request.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Proxy running on http://localhost:" + PORT);
  if (warpEnabled) void startWarp({ log: console });
});

function shutdown() {
  stopWarp();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
