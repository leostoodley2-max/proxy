// Test helpers for accounts: a fresh database per test server, and browser
// contexts that start signed in to a new account with plenty of data.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ADMIN_PASSWORD = "test-admin-password";

// Extra environment for a test server: its own empty database.
function serverEnv(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-test-db-"));
  process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { DATA_DIR: dataDir, SIGNUP_GB: "100", ADMIN_PASSWORD, NODE_NO_WARNINGS: "1", AUTH_ATTEMPTS_PER_MINUTE: "1000",
    // No free daily allowance, so balances behave predictably (tests opt in).
    DAILY_FREE_GB: "0", ...extra };
}

let counter = 0;
// Creates an account on the server at `base`; returns { username, cookie }.
async function createAccount(base, username = "tester" + process.pid + "x" + ++counter) {
  const res = await fetch(base + "/api/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "test-password-1" }),
  });
  if (!res.ok) throw new Error("signup failed: " + res.status + " " + await res.text());
  const cookie = /orbit_session=([^;]+)/.exec(res.headers.get("set-cookie"))[1];
  return { username, cookie };
}

// Makes browser.newContext() return contexts signed in to a new account.
// `base()` returns the proxy's address. browser.newSignedOutContext() skips it.
function signedIn(browser, base) {
  const newContext = browser.newContext.bind(browser);
  browser.newSignedOutContext = newContext;
  browser.newContext = async (options) => {
    const context = await newContext(options);
    const { username, cookie } = await createAccount(base());
    await context.addCookies([{ name: "orbit_session", value: cookie, url: base() }]);
    context.username = username;
    return context;
  };
  return browser;
}

async function adminCode(base, gb) {
  const res = await fetch(base + "/api/admin/codes", {
    method: "POST", headers: { "Content-Type": "application/json", "x-admin-password": ADMIN_PASSWORD },
    body: JSON.stringify({ gb }),
  });
  return (await res.json()).codes[0];
}

module.exports = { serverEnv, createAccount, signedIn, adminCode, ADMIN_PASSWORD };
