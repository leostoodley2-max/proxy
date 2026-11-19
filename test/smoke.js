// Browser smoke test: starts the server and checks, in headless Chromium, that
// pages opened in the mini-browser's tabs go through the service worker, and
// that the app recovers on its own when they don't (instead of ending on
// "The proxy couldn't start").
//
//   npm test                 (needs the `playwright` package and Chromium:
//                             npm i --no-save playwright && npx playwright install chromium)
//
// It doesn't need internet access: a tab counts as working when its page was
// answered by the service worker (the real site, or Scramjet's error page if
// the site can't be reached).

"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = "http://localhost:" + PORT;
const TARGET = "https://example.com/";

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), WARP: "off", ORBIT_TEST_ALLOW_LOOPBACK: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => reject(new Error("server exited with code " + code)));
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("Proxy running")) resolve(child);
    });
  });
}

// Wait until the active tab shows a page served by the service worker.
async function expectProxiedTab(page, label) {
  const deadline = Date.now() + 30000;
  let last = "";
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes("/scramjet/"));
    if (frame) {
      try {
        const info = await frame.evaluate(() => ({
          title: document.title,
          text: document.body ? document.body.innerText : "",
          // The server only ever answers /scramjet/ URLs with the wait page
          // (or, before the fix, the app itself), so any other page means the
          // service worker proxied it. (Checking navigator.serviceWorker here
          // doesn't work: Scramjet hides it from proxied pages.)
          fromServer: document.title === "Starting…" || !!document.getElementById("tabs"),
        }));
        last = JSON.stringify(info).slice(0, 200);
        assert.ok(!/couldn't start/i.test(info.text), label + ': showed "' + info.text.trim() + '"');
        if (!info.fromServer && info.title) return;
      } catch (err) {
        if (err instanceof assert.AssertionError) throw err;
      }
    }
    await page.waitForTimeout(250);
  }
  throw new Error(label + ": tab never loaded through the service worker (last: " + last + ")");
}

async function openApp(context) {
  const page = await context.newPage();
  await page.goto(BASE + "/");
  await page.waitForFunction(() => window.Engine && navigator.serviceWorker.controller, null, { timeout: 20000 });
  return page;
}

async function go(page, url) {
  await page.waitForSelector("#address");
  await page.fill("#address", url);
  await page.press("#address", "Enter");
}

// A local site for the asset cache test. Counts requests per path.
const hits = {};
const site = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  hits[pathname] = (hits[pathname] || 0) + 1;
  const assets = {
    "/long.js": "public, max-age=31536000, immutable",
    "/cookie.js": "public, max-age=31536000",
    "/nostore.js": "no-store",
    "/short.js": "max-age=5",
  };
  if (pathname.startsWith("/page")) {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
    return res.end("<!doctype html><title>cache test</title>" +
      Object.keys(assets).map((src) => `<script src="${src}"></script>`).join("") +
      "<script>addEventListener('load', () => { window.__done = window.__ran; })</script>");
  }
  if (!assets[pathname]) return res.writeHead(404).end();
  const headers = { "Content-Type": "text/javascript", "Cache-Control": assets[pathname] };
  if (pathname === "/cookie.js") headers["Set-Cookie"] = "seen=1; Path=/";
  res.writeHead(200, headers);
  res.end("window.__ran = (window.__ran || 0) + 1;");
});

async function loadTestPage(page, url) {
  await go(page, url);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes(encodeURIComponent(url)));
    const done = frame && await frame.evaluate(() => window.__done).catch(() => undefined);
    if (done !== undefined) return assert.equal(done, 4, "all 4 scripts should run");
    await page.waitForTimeout(50);
  }
  const frame = page.frames().find((f) => f.url().includes(encodeURIComponent(url)));
  const state = frame && await frame.evaluate(() => [window.__ran, window.__done, document.documentElement.outerHTML.slice(0, 300)]).catch((e) => e.message);
  throw new Error("test page never finished loading: " + url + " " + JSON.stringify({ state, hits, frames: page.frames().map((f) => f.url()) }));
}

const tests = {
  async "asset cache: reuses long-lived files, never cookie/no-store ones"(browser) {
    const siteUrl = "http://127.0.0.1:" + site.address().port;
    const context = await browser.newContext();
    let page = await openApp(context);
    await loadTestPage(page, siteUrl + "/page1");
    // Reopen the app so the browser's in-memory cache can't help.
    await page.close();
    page = await openApp(context);
    await loadTestPage(page, siteUrl + "/page2");
    assert.equal(hits["/long.js"], 1, "long-lived script should come from the cache");
    assert.equal(hits["/cookie.js"], 2, "script that sets a cookie must not be cached");
    assert.equal(hits["/nostore.js"], 2, "no-store script must not be cached");
    assert.equal(hits["/short.js"], 2, "short-lived script must not be cached");
    await context.close();
  },

  async "first visit: tab loads through the proxy"(browser) {
    const context = await browser.newContext();
    const page = await openApp(context);
    await go(page, TARGET);
    await expectProxiedTab(page, "first visit");
    await context.close();
  },

  async "hard refresh: app regains the service worker"(browser) {
    const context = await browser.newContext();
    const page = await openApp(context);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.reload", { ignoreCache: true });
    await page.waitForFunction(() => window.Engine && navigator.serviceWorker.controller, null, { timeout: 20000 });
    await go(page, TARGET);
    await expectProxiedTab(page, "hard refresh");
    await context.close();
  },

  async "stray tab request: retries the tab and recovers"(browser) {
    const context = await browser.newContext();
    const page = await openApp(context);
    const cdp = await context.newCDPSession(page);
    // Make the next tab load skip the worker, as Safari sometimes does.
    await cdp.send("Network.setBypassServiceWorker", { bypass: true });
    page.on("response", (res) => {
      if (res.url().includes("/scramjet/") && res.status() === 503) {
        cdp.send("Network.setBypassServiceWorker", { bypass: false }).catch(() => {});
      }
    });
    await go(page, TARGET);
    await expectProxiedTab(page, "stray tab request");
    await context.close();
  },

  async "uncontrolled app: stray tab reloads the whole app"(browser) {
    // Safari skips the worker for every tab load while the app page itself
    // isn't controlled, so retrying only the tab can never work.
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(BASE + "/healthz");
    const reloaded = page.waitForEvent("load", { timeout: 15000 });
    await page.evaluate((url) => {
      window.Engine = {}; // Stand-in for an uncontrolled app page.
      const frame = document.createElement("iframe");
      frame.src = url;
      document.body.append(frame);
    }, "/scramjet/" + encodeURIComponent(TARGET));
    await reloaded;
    await context.close();
  },

  async "embedded app: renders inside another frame"(browser) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(BASE + "/healthz");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "/";
      document.body.append(frame);
    });
    await page.waitForFunction(() => {
      const doc = document.querySelector("iframe").contentDocument;
      return doc && doc.getElementById("tabs");
    }, null, { timeout: 15000 });
    await context.close();
  },
};

(async () => {
  const server = await startServer();
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch();
  let failed = 0;
  try {
    for (const [name, run] of Object.entries(tests)) {
      try {
        await run(browser);
        console.log("ok   " + name);
      } catch (err) {
        failed++;
        console.log("FAIL " + name + "\n     " + err.message);
      }
    }
  } finally {
    await browser.close();
    server.kill();
    site.close();
  }
  if (failed) {
    console.log(failed + " failed");
    process.exit(1);
  }
  console.log("all passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
