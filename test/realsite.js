// Debugging aid: opens a real site through the proxy and reports what goes
// wrong (page errors, service worker errors, failed requests, frames), then
// saves a screenshot. For sandboxes, it can use the test-only server-side
// transport (test/support/server-fetch.js) instead of libcurl.
//
//   node test/realsite.js <url> [seconds=40] [screenshot.png]
//   SERVER_FETCH=0 node test/realsite.js ...   (use the real libcurl transport)

"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");
const codec = require("../public/codec.js");

const [url, seconds = "40", shot = "realsite.png"] = process.argv.slice(2);
const PORT = 19700 + Math.floor(Math.random() * 200);
const serverFetch = process.env.SERVER_FETCH !== "0";

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), WARP: "off", ORBIT_TEST_SERVER_FETCH: serverFetch ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("running") && r()));

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((test) => {
    try { if (window === window.top) localStorage.setItem("orbit.unlocked", "1"); } catch (e) {}
    if (test) window.__orbitTestTransport = "/__test/transport.mjs";
  }, serverFetch);
  const seen = new Set();
  const log = (kind, text) => {
    const key = kind + text.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    console.log(kind.padEnd(10) + text.slice(0, 500).replace(/\s+/g, " "));
  };
  const real = (u) => {
    try {
      const p = new URL(u);
      return p.pathname.startsWith(codec.prefix) ? codec.decode(p.pathname.slice(codec.prefix.length) + p.search) : u;
    } catch { return u; }
  };
  context.on("console", (m) => { if (["error", "warning"].includes(m.type())) log("console", m.text()); });
  context.on("weberror", (e) => log("EXCEPTION", e.error().message + " " + (e.error().stack || "").split("\n")[1]));
  context.on("requestfailed", (r) => log("REQFAIL", real(r.url()) + " " + (r.failure() && r.failure().errorText)));
  context.on("response", (r) => { if (r.status() >= 400 && r.url().includes(codec.prefix)) log("HTTP " + r.status(), real(r.url())); });

  const page = await context.newPage();
  if (process.env.CDP_NET) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const reqs = {};
    cdp.on("Network.requestWillBeSent", (e) => { reqs[e.requestId] = e; });
    cdp.on("Network.loadingFailed", (e) => {
      const r = reqs[e.requestId];
      if (!r || !new RegExp(process.env.CDP_NET).test(real(r.request.url))) return;
      if (process.env.CDP_RAW) console.log("RAWURL    " + r.request.url);
      console.log("NETFAIL   " + real(r.request.url).slice(0, 90) + " type=" + e.type + " error=" + e.errorText +
        " blocked=" + e.blockedReason + " cors=" + JSON.stringify(e.corsErrorStatus) + " initiator=" + (r.initiator && (r.initiator.url ? real(r.initiator.url).slice(0, 80) : r.initiator.type)) +
        " mode/dest=" + (r.request.headers && r.request.headers["Sec-Fetch-Mode"]));
    });
  }
  await page.goto("http://localhost:" + PORT + "/app");
  await page.waitForFunction(() => window.Engine && navigator.serviceWorker.controller);
  await page.evaluate(() => window.Engine.ready);
  await page.fill("#address", url);
  await page.press("#address", "Enter");
  await page.waitForTimeout(Number(seconds) * 1000);
  for (const f of page.frames()) {
    let info = "";
    try { info = await f.evaluate(() => document.title + " | " + (document.body ? document.body.innerText.slice(0, 150) : "")); } catch (e) { info = "(" + e.message.slice(0, 60) + ")"; }
    console.log("FRAME     " + real(f.url()).slice(0, 120) + " => " + info.replace(/\s+/g, " ").slice(0, 200));
  }
  if (process.env.EVAL) {
    const target = page.frames().find((f) => real(f.url()).startsWith(process.env.EVAL_FRAME || "zzz")) || page.frames().at(-1);
    console.log("EVAL      " + await target.evaluate(process.env.EVAL).catch((e) => "threw " + e.message));
  }
  await page.screenshot({ path: shot });
  console.log("screenshot: " + shot);
  await browser.close();
  server.kill();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
