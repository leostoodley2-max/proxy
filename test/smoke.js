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
const accounts = require("./support/accounts.js");
const codec = require("../public/codec.js");

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = "http://localhost:" + PORT;
const TARGET = "https://example.com/";

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), WARP: "off", ORBIT_TEST_ALLOW_LOOPBACK: "1", ...accounts.serverEnv() },
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
    const frame = page.frames().find((f) => f.url().includes(codec.prefix));
    if (frame) {
      try {
        const info = await frame.evaluate(() => ({
          title: document.title,
          text: document.body ? document.body.innerText : "",
          // The server only ever answers proxied (/study/) URLs with the wait page
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
  await page.goto(BASE + "/app");
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
  if (pathname === "/setcookie") {
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "login=yes-" + Date.now() + "; Path=/; HttpOnly", "Cache-Control": "no-store" });
    return res.end("<title>set</title>");
  }
  if (pathname === "/big") {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end("<title>big</title><!--" + "x".repeat(2_000_000) + "-->");
  }
  if (pathname === "/whoami") { // shows the Cookie header the site received
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    return res.end("<title>" + (req.headers.cookie || "no cookies").replace(/[<>&]/g, "") + "</title>");
  }
  if (pathname === "/flaky" && hits[pathname] === 1) return req.socket.destroy(); // dropped connection
  if (pathname === "/flaky") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end("<title>recovered</title>");
  }
  if (pathname.startsWith("/page")) {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
    return res.end("<!doctype html><title>cache test</title>" +
      Object.keys(assets).map((src) => `<script src="${src}"></script>`).join("") +
      "<script>addEventListener('load', async () => { await (await fetch('/game.data')).arrayBuffer(); " +
      "await (await fetch('/api.json', { headers: { Authorization: 'Bearer x' } })).text(); window.__done = window.__ran; })</script>");
  }
  if (pathname === "/game.data") {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=86400" });
    return res.end(Buffer.alloc(200000, 7));
  }
  if (pathname === "/api.json") { // per-user answer: must never be shared
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600", "Vary": "Authorization" });
    return res.end("{}");
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
    const frame = page.frames().find((f) => f.url().includes(codec.encode(url)));
    const done = frame && await frame.evaluate(() => window.__done).catch(() => undefined);
    if (done !== undefined) return assert.equal(done, 4, "all 4 scripts should run");
    await page.waitForTimeout(50);
  }
  const frame = page.frames().find((f) => f.url().includes(codec.encode(url)));
  const state = frame && await frame.evaluate(() => [window.__ran, window.__done, document.documentElement.outerHTML.slice(0, 300)]).catch((e) => e.message);
  throw new Error("test page never finished loading: " + url + " " + JSON.stringify({ state, hits, frames: page.frames().map((f) => f.url()) }));
}

async function frameTitle(page, url) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => f.url().includes(codec.encode(url)));
    const title = frame && await frame.evaluate(() => document.title).catch(() => "");
    if (title) return title;
    await page.waitForTimeout(100);
  }
  return "";
}

const tests = {
  async "proxied address opened on its own shows the revision page; from a link it opens"(browser) {
    const real = "http://127.0.0.1:" + site.address().port + "/whoami";
    const proxied = BASE + codec.prefix + codec.encode(real);
    const context = await browser.newContext();
    await openApp(context); // installs the service worker
    const page = await context.newPage();
    await page.goto(proxied); // typed / pasted / bookmarked: no referrer
    await page.waitForURL(BASE + "/");
    assert.match(await page.title(), /Recall/);
    await page.goto(proxied, { referer: BASE + codec.prefix + codec.encode("http://127.0.0.1:1/") }); // like "Open in new tab"
    await page.waitForFunction(() => document.title && !/Recall/.test(document.title), null, { timeout: 15000 });
    assert.equal(await page.title(), "no cookies");
    await context.close();
  },

  async "disguised addresses: no proxied request shows the real site"(browser) {
    const host = "127.0.0.1:" + site.address().port;
    const url = "http://" + host + "/page-disguise";
    const context = await browser.newContext();
    const page = await openApp(context);
    const seen = [];
    context.on("request", (req) => seen.push(req.url()));
    await loadTestPage(page, url);
    const proxied = seen.filter((u) => new URL(u).pathname.startsWith(codec.prefix));
    assert.ok(proxied.length >= 5, "page and its scripts went through the proxy (" + proxied.length + ")");
    for (const u of proxied) {
      const path = new URL(u).pathname;
      assert.match(path, /^\/study\/[a-z]+-[a-z]+-[A-Za-z0-9_-]+$/, "disguised: " + path);
      for (const leak of [host, encodeURIComponent(host), "127.0.0.1", "page-disguise", "scramjet"]) {
        assert.ok(!u.includes(leak), "address leaks " + leak + ": " + u);
      }
    }
    // The address bar shows the disguised address too, and it can be typed back in.
    const shown = await page.inputValue("#address");
    assert.match(shown, /\/study\/[a-z]+-[a-z]+-[A-Za-z0-9_-]+$/, "address bar: " + shown);
    assert.ok(!shown.includes("127.0.0.1") && !shown.includes("page-disguise"), "address bar leaks: " + shown);
    assert.equal(await page.evaluate((text) => window.Engine.toUrl(text), shown), url);
    await context.close();
    for (const key in hits) delete hits[key]; // the asset cache test counts these from zero
  },

  async "front page: accounts on the server; signing in opens the browser"(browser) {
    const context = await browser.newSignedOutContext();
    const page = await context.newPage();
    await page.goto(BASE + "/app");
    await page.waitForURL(BASE + "/");
    assert.match(await page.title(), /Recall/, "/app without signing in shows the revision app");
    const name = "student" + Date.now();
    await page.click("#open-signup");
    await page.fill("#auth-user", name);
    await page.fill("#auth-pass", "revision-pass-1");
    await page.click("#auth-submit");
    await page.waitForURL(BASE + "/app");
    await page.waitForSelector("#address");
    // Sign out from the account dialog, then a wrong password is refused.
    await page.click("#account-chip");
    await page.click("#sign-out");
    await page.waitForURL(BASE + "/", { waitUntil: "commit" });
    await page.waitForSelector("#open-signin:not([hidden])");
    await page.click("#open-signin");
    await page.fill("#auth-user", name);
    await page.fill("#auth-pass", "wrong-password");
    await page.click("#auth-submit");
    await page.waitForSelector("#auth-error:not([hidden])");
    assert.equal(new URL(page.url()).pathname, "/");
    await page.fill("#auth-pass", "revision-pass-1");
    await page.click("#auth-submit");
    await page.waitForURL(BASE + "/app");
    // The old shared login no longer opens anything.
    const res = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "proxy", password: "12345" }) });
    assert.equal(res.status, 401);
    await context.close();
  },

  async "data: usage is metered, and pages stop at zero with a top-up banner"(browser) {
    const url = "http://127.0.0.1:" + site.address().port + "/big";
    const context = await browser.newContext();
    const page = await openApp(context);
    const before = (await (await page.request.get(BASE + "/api/me")).json()).user;
    await go(page, url);
    await frameTitle(page, url);
    await page.waitForTimeout(3500); // usage is charged every 3 s
    const after = (await (await page.request.get(BASE + "/api/me")).json()).user;
    assert.ok(after.usedBytes - before.usedBytes >= 2_000_000, "charged " + (after.usedBytes - before.usedBytes) + " bytes for a 2 MB page");
    assert.equal(before.balanceBytes - after.balanceBytes, after.usedBytes - before.usedBytes);
    // Use up the balance: the proxy refuses, and the banner offers a top-up.
    await fetch(BASE + "/api/admin/credit", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": accounts.ADMIN_PASSWORD },
      body: JSON.stringify({ username: context.username, gb: -1000 }) });
    await page.evaluate(() => window.OrbitAccount.refresh());
    await page.waitForSelector("#out-of-data:not([hidden])");
    const ws = await page.evaluate((u) => new Promise((resolve) => {
      const socket = new WebSocket(u);
      socket.onopen = () => resolve("open");
      socket.onerror = () => resolve("refused");
    }), BASE.replace("http", "ws") + "/wisp/");
    assert.equal(ws, "refused");
    await context.close();
  },

  async "data: redeeming a code adds data, once"(browser) {
    const context = await browser.newContext();
    const page = await openApp(context);
    const code = await accounts.adminCode(BASE, 2);
    await page.click("#account-chip");
    await page.fill("#redeem-code", code.toLowerCase());
    await page.click("#redeem-form .primary");
    await page.waitForSelector("#redeem-result.ok");
    assert.match(await page.textContent("#redeem-result"), /Added 2\.00 GB\. You now have 10[12]\.\d+ GB/);
    await page.fill("#redeem-code", code);
    await page.click("#redeem-form .primary");
    await page.waitForSelector("#redeem-result.error");
    assert.match(await page.textContent("#redeem-result"), /already been used/);
    await context.close();
  },

  async "saved sign-ins: survive a service worker restart and follow the account to another device"(browser) {
    const real = "http://127.0.0.1:" + site.address().port;
    const context = await browser.newContext();
    const page = await openApp(context);
    await go(page, real + "/setcookie");
    assert.equal(await frameTitle(page, real + "/setcookie"), "set");
    await page.waitForTimeout(1500); // the worker saves the jar ~1 s after a change
    // The browser stops idle service workers; sign-ins must come back.
    const cdp = await context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await page.waitForTimeout(500);
    await go(page, real + "/whoami");
    assert.match(await frameTitle(page, real + "/whoami"), /login=yes/);
    await page.evaluate(() => window.OrbitAccount.push());
    // Another device: a new browser profile signed in to the same account.
    const login = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: context.username, password: "test-password-1" }) });
    const cookie = /orbit_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1];
    const other = await browser.newSignedOutContext();
    await other.addCookies([{ name: "orbit_session", value: cookie, url: BASE }]);
    const page2 = await openApp(other);
    await go(page2, real + "/whoami");
    assert.match(await frameTitle(page2, real + "/whoami"), /login=yes/);
    // A different account on that device must not see them.
    await other.clearCookies();
    const stranger = await accounts.createAccount(BASE);
    await other.addCookies([{ name: "orbit_session", value: stranger.cookie, url: BASE }]);
    const page3 = await openApp(other);
    await go(page3, real + "/whoami?again");
    assert.equal(await frameTitle(page3, real + "/whoami?again"), "no cookies");
    await context.close();
    await other.close();
  },


  async "bring in a sign-in: imported cookies reach the site"(browser) {
    const url = "http://127.0.0.1:" + site.address().port + "/whoami";
    const context = await browser.newContext();
    const page = await openApp(context);
    await page.click("#open-import");
    await page.fill("#import-text", JSON.stringify([
      { domain: "127.0.0.1", hostOnly: true, name: "session", value: "abc123", path: "/", httpOnly: true, secure: false },
      { domain: "127.0.0.1", hostOnly: true, name: "old", value: "x", path: "/", expirationDate: 1 },
    ]));
    await page.click("#import-form .primary");
    await page.waitForSelector("#import-result:not([hidden])");
    assert.match(await page.textContent("#import-result"), /Imported 1 cookie .*1 expired/);
    await page.keyboard.press("Escape");
    await go(page, url);
    assert.equal(await frameTitle(page, url), "session=abc123");
    await context.close();
  },

  async "dropped connection: retried instead of an error page"(browser) {
    const url = "http://127.0.0.1:" + site.address().port + "/flaky";
    const context = await browser.newContext();
    const page = await openApp(context);
    await go(page, url);
    const deadline = Date.now() + 20000;
    let title;
    while (Date.now() < deadline) {
      const frame = page.frames().find((f) => f.url().includes(codec.encode(url)));
      title = frame && await frame.evaluate(() => document.title).catch(() => "");
      if (title) break;
      await page.waitForTimeout(100);
    }
    assert.equal(title, "recovered");
    assert.equal(hits["/flaky"], 2, "should take exactly one retry");
    await context.close();
  },

  async "asset cache: reuses long-lived files and game data, never cookie/no-store/per-user ones"(browser) {
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
    assert.equal(hits["/game.data"], 1, "long-lived game data (fetch) should come from the cache");
    assert.equal(hits["/api.json"], 2, "response that varies per user must not be cached");
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
      if (res.url().includes(codec.prefix) && res.status() === 503) {
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
    }, codec.prefix + codec.encode(TARGET));
    await reloaded;
    await context.close();
  },

  async "embedded app: renders inside another frame"(browser) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(BASE + "/healthz");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "/app";
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
  const browser = accounts.signedIn(await chromium.launch(), () => "http://localhost:" + PORT);
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
