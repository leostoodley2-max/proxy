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
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const compression = require("compression");
const { server: wisp, logging } = require("@mercuryworkshop/wisp-js/server");
const { scramjetPath } = require("@mercuryworkshop/scramjet/path");
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node");
const { libcurlPath } = require("@mercuryworkshop/libcurl-transport");
const { startWarp, stopWarp, getRoute, getEgress } = require("./warp");
const { makeTCPSocket } = require("./wisp-socks");
const { createAccounts } = require("./accounts");

const PORT = parseInt(process.env.PORT, 10) || 8080;
const warpEnabled = process.env.WARP?.toLowerCase() !== "off";

logging.set_level(logging.WARN);
Object.assign(wisp.options, {
  allow_udp_streams: false,
  // Don't let proxied pages reach the server's own network.
  allow_private_ips: false,
  // Only the benchmark (test/bench.js) sets this, to proxy a local test site.
  allow_loopback_ips: process.env.ORBIT_TEST_ALLOW_LOOPBACK === "1",
  dns_servers: ["1.1.1.1", "1.0.0.1"],
});

const app = express();
app.disable("x-powered-by");
// Render terminates HTTPS in front of the app: trust its X-Forwarded-* headers
// (client IP for rate limits, https for secure cookies).
app.set("trust proxy", 1);
app.use(compression());

// Scramjet needs a cross-origin isolated top page (SharedArrayBuffer).
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

const cacheLong = { maxAge: "7d", immutable: false };
// Scramjet is patched at install time (scripts/patch-scramjet.js), so let
// browsers revalidate it (cheap 304s) instead of keeping a stale copy for days.
const engineDirs = [
  ["/scram/", scramjetPath, { maxAge: 0 }],
  ["/baremux/", baremuxPath, cacheLong],
  ["/libcurl/", libcurlPath, cacheLong],
];
for (const [mount, dir, options] of engineDirs) {
  app.use(mount, precompressed(mount, dir, options), express.static(dir, options));
}

// Serves the copies made by scripts/precompress.js (brotli or gzip) when the
// browser accepts them and they are up to date; otherwise falls through to
// express.static, which the compression middleware compresses on the fly.
function precompressed(mount, dir, options) {
  const root = path.join(__dirname, "precompressed", mount);
  const encodings = [["br", ".br"], ["gzip", ".gz"]];
  const available = new Map(); // "/name" -> { br: file, gzip: file }
  let names = [];
  try { names = fs.readdirSync(root); } catch {}
  for (const name of names) {
    const match = /^(.+)\.(br|gz)$/.exec(name);
    if (!match) continue;
    const original = path.join(dir, match[1]);
    const copy = path.join(root, name);
    try {
      if (fs.statSync(copy).mtimeMs < fs.statSync(original).mtimeMs) continue; // stale
    } catch { continue; }
    const entry = available.get("/" + match[1]) || {};
    entry[match[2] === "br" ? "br" : "gzip"] = copy;
    available.set("/" + match[1], entry);
  }
  return (req, res, next) => {
    const entry = (req.method === "GET" || req.method === "HEAD") && available.get(req.path);
    if (!entry) return next();
    res.vary("Accept-Encoding");
    const encoding = req.acceptsEncodings(...encodings.map(([name]) => name).filter((name) => entry[name]));
    if (!encoding) return next();
    res.setHeader("Content-Encoding", encoding);
    res.type(express.static.mime.lookup(req.path));
    res.sendFile(entry[encoding], { maxAge: options.maxAge, lastModified: true }, (error) => {
      if (error && !res.headersSent) {
        res.removeHeader("Content-Encoding");
        next();
      }
    });
  };
}

// Accounts, data balances, top-up codes, saved sign-ins (see accounts.js).
const accounts = createAccounts();
app.use("/api", accounts.router);

// Pages that need a signed-in account: anyone else gets the front page.
const signedInPage = (file) => (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!accounts.userFromRequest(req)) return res.redirect(302, "/");
  res.sendFile(path.join(__dirname, "public", file));
};
// /app: the browser for signed-in browser accounts; after the front page's
// special login (gate cookie) but before signing in, the browser's own
// sign-in page; anyone else just gets the revision front page.
app.get("/app", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (accounts.userFromRequest(req)) return res.sendFile(path.join(__dirname, "public", "browser.html"));
  if (/(?:^|;\s*)orbit_gate=1(?:;|$)/.test(req.headers.cookie || "")) return res.sendFile(path.join(__dirname, "public", "signin.html"));
  res.redirect(302, "/");
});
app.get(["/diagnostics.html", "/diagnostics"], signedInPage("diagnostics.html"));
app.get(["/admin", "/admin.html"], (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.get(["/browser.html", "/signin.html"], (req, res) => res.redirect(302, "/app"));

// The service worker must never be cached, or updates get stuck.
app.get("/sw.js", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

// UI files revalidate on every load (cheap 304s) so a new deploy shows up at once.
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 }));

// Test only: lets tests in a sandbox reach real sites (see test/support/server-fetch.js).
if (process.env.ORBIT_TEST_SERVER_FETCH === "1") require("./test/support/server-fetch")(app);

// Public suffix list for Scramjet (see scripts/patch-scramjet.js), one rule
// per line, from the `psl` package. Read as data, not executed.
const publicSuffixList = (() => {
  try {
    const source = fs.readFileSync(path.join(path.dirname(require.resolve("psl")), "..", "data", "rules.js"), "utf8");
    const rules = JSON.parse(source.replace(/^\s*export default\s*/, "").replace(/;\s*$/, ""));
    return rules.filter((rule) => typeof rule === "string" && /^[!*]?[^\s/]+$/.test(rule)).join("\n");
  } catch (error) {
    console.warn("[psl] Public suffix list unavailable: " + error.message);
    return null;
  }
})();
app.get("/psl.dat", (req, res) => {
  if (!publicSuffixList) return res.sendStatus(404);
  res.set("Cache-Control", "public, max-age=86400").type("text").send(publicSuffixList);
});

// Render's health check.
app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.get("/egress", (req, res) => res.set("Cache-Control", "no-store").json(getEgress()));

// A proxied URL only reaches the server when the service worker didn't handle
// it (not in control yet). Never answer with the app itself, or the browser UI
// would load inside its own tab; send a page that waits for the worker and
// retries instead.
app.use("/study/", (req, res) => {
  res.status(503).set({ "Cache-Control": "no-store", "Retry-After": "1" });
  res.sendFile(path.join(__dirname, "public", "engine-wait.html"));
});

// Any other unknown path loads the front page instead of a bare 404.
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
const TCPSocket = warpEnabled ? makeTCPSocket(getRoute, wisp.options) : undefined;

server.on("upgrade", (req, socket, head) => {
  if (!req.url.endsWith("/wisp/")) return socket.end();
  // Only signed-in accounts with data left may proxy; their traffic is metered.
  if (!accounts.admitWisp(req, socket)) return;
  wisp.routeRequest(req, socket, head, { TCPSocket });
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
