// Accounts, data balances, top-up codes and saved sign-ins (the proxy's
// cookie jar per account), stored in SQLite (node:sqlite).
//
// The database lives in $DATA_DIR (default ./data). On Render that must be a
// persistent disk, or every deploy/restart wipes all accounts and balances.
//
// Environment:
//   DATA_DIR         where orbit.db is kept (default ./data)
//   ADMIN_PASSWORD   enables /admin.html (make codes, see users); unset = disabled
//   SIGNUP_GB        free data for new accounts, in GB (default 0)
//   AUTH_ATTEMPTS_PER_MINUTE  sign-up/sign-in/redeem attempts per IP (default 10)

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");

const GB = 1_000_000_000;
const SESSION_DAYS = 30;
const COOKIE = "orbit_session";
const MAX_JAR_BYTES = 2 * 1024 * 1024;

function open(dataDir) {
  // node:sqlite prints an "experimental" warning once; it is stable in practice.
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "orbit.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL,
      balance_bytes INTEGER NOT NULL DEFAULT 0,
      used_bytes INTEGER NOT NULL DEFAULT 0,
      subscription_until INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      redeemed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      redeemed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS cookie_jars (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      jar TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- Data used per account per day (UTC), for the admin page.
    CREATE TABLE IF NOT EXISTS usage_daily (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (user_id, day)
    );
  `);
  // Columns added after the first release.
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!columns.includes("last_active")) db.exec("ALTER TABLE users ADD COLUMN last_active INTEGER");
  return db;
}

// --- Passwords and tokens -----------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return "scrypt$" + salt.toString("base64") + "$" + hash.toString("base64");
}
function checkPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
function sameSecret(a, b) {
  const x = Buffer.from(sha256(String(a))), y = Buffer.from(sha256(String(b)));
  return crypto.timingSafeEqual(x, y);
}
// Codes like STUDY-7KQ2-M9XD-4TPA (no 0/O/1/I to avoid misreading).
function newCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return "STUDY-" + chars.slice(0, 4) + "-" + chars.slice(4, 8) + "-" + chars.slice(8, 12);
}

// Small in-memory limiter: at most `max` attempts per key per minute.
function limiter(max) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (key) => {
    const n = (hits.get(key) || 0) + 1;
    hits.set(key, n);
    return n <= max;
  };
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAccounts({ dataDir = process.env.DATA_DIR || path.join(__dirname, "data"), log = console } = {}) {
  const db = open(dataDir);
  const signupBytes = Math.round(Number(process.env.SIGNUP_GB || 0) * GB);
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  // Daily data allowances (reset at UTC midnight): everyone gets DAILY_FREE_GB
  // a day; accounts with an active subscription get DAILY_PAID_GB a day. Redeem
  // codes and admin top-ups add to balance_bytes, which is only spent once the
  // day's allowance has been used up.
  const dailyFreeBytes = Math.round(Number(process.env.DAILY_FREE_GB ?? 1) * GB);
  const dailyPaidBytes = Math.round(Number(process.env.DAILY_PAID_GB ?? 3) * GB);
  const q = {
    userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    addUser: db.prepare("INSERT INTO users (username, password, balance_bytes, created_at) VALUES (?, ?, ?, ?)"),
    addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"),
    session: db.prepare("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?"),
    dropSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    dropExpired: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
    charge: db.prepare("UPDATE users SET balance_bytes = MAX(0, balance_bytes - ?), used_bytes = used_bytes + ?, last_active = ? WHERE id = ?"),
    logUsage: db.prepare("INSERT INTO usage_daily (user_id, day, bytes) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET bytes = bytes + excluded.bytes"),
    setBalance: db.prepare("UPDATE users SET balance_bytes = MAX(0, ?) WHERE id = ?"),
    addBalance: db.prepare("UPDATE users SET balance_bytes = MAX(0, balance_bytes + ?) WHERE id = ?"),
    credit: db.prepare("UPDATE users SET balance_bytes = balance_bytes + ? WHERE id = ?"),
    addCode: db.prepare("INSERT INTO codes (code, bytes, note, created_at) VALUES (?, ?, ?, ?)"),
    claimCode: db.prepare("UPDATE codes SET redeemed_by = ?, redeemed_at = ? WHERE code = ? AND redeemed_by IS NULL"),
    code: db.prepare("SELECT * FROM codes WHERE code = ?"),
    codes: db.prepare("SELECT codes.*, users.username AS redeemed_by_name FROM codes LEFT JOIN users ON users.id = codes.redeemed_by ORDER BY created_at DESC LIMIT 200"),
    users: db.prepare(`SELECT u.id, u.username, u.balance_bytes, u.used_bytes, u.created_at, u.last_active, u.subscription_until,
        COALESCE((SELECT bytes FROM usage_daily WHERE user_id = u.id AND day = ?), 0) AS used_today,
        COALESCE((SELECT SUM(bytes) FROM usage_daily WHERE user_id = u.id AND day >= ?), 0) AS used_30d
      FROM users u ORDER BY COALESCE(u.last_active, u.created_at) DESC LIMIT 2000`),
    jar: db.prepare("SELECT jar, version FROM cookie_jars WHERE user_id = ?"),
    putJar: db.prepare("INSERT INTO cookie_jars (user_id, jar, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO UPDATE SET jar = excluded.jar, version = version + 1, updated_at = excluded.updated_at"),
    usedTodayRow: db.prepare("SELECT bytes FROM usage_daily WHERE user_id = ? AND day = ?"),
    setSubscription: db.prepare("UPDATE users SET subscription_until = ? WHERE id = ?"),
  };
  setInterval(() => q.dropExpired.run(Date.now()), 3600_000).unref();

  // --- Daily allowance helpers ----------------------------------------------
  const utcDay = () => new Date().toISOString().slice(0, 10);
  const isPaid = (u) => !!(u && u.subscription_until && u.subscription_until > Date.now());
  const dailyAllowanceBytes = (u) => (isPaid(u) ? dailyPaidBytes : dailyFreeBytes);
  function usedTodayBytes(userId) {
    const row = q.usedTodayRow.get(userId, utcDay());
    return row ? row.bytes : 0;
  }
  // Data the user may still spend right now: today's unused allowance plus any
  // extra balance from codes / top-ups.
  function availableBytes(u) {
    return Math.max(0, dailyAllowanceBytes(u) - usedTodayBytes(u.id)) + u.balance_bytes;
  }

  function userFromRequest(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    return q.session.get(sha256(token), Date.now()) || null;
  }
  function startSession(res, userId, secure) {
    const token = crypto.randomBytes(32).toString("base64url");
    q.addSession.run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure, maxAge: SESSION_DAYS * 86400_000, path: "/" });
  }
  const publicUser = (u) => {
    const allowance = dailyAllowanceBytes(u);
    const usedToday = usedTodayBytes(u.id);
    const allowanceLeft = Math.max(0, allowance - usedToday);
    return {
      username: u.username, balanceBytes: u.balance_bytes, usedBytes: u.used_bytes,
      subscriptionUntil: u.subscription_until || null,
      paid: isPaid(u),
      dailyAllowanceBytes: allowance,
      usedTodayBytes: usedToday,
      allowanceLeftBytes: allowanceLeft,
      availableBytes: allowanceLeft + u.balance_bytes,
    };
  };

  // --- Data metering --------------------------------------------------------
  // Every proxied byte goes through the Wisp WebSocket. Count each socket's
  // traffic in both directions and charge it to its account every few
  // seconds; close the socket when the balance runs out.
  const metered = new Set(); // { socket, userId, counted }
  function chargeAll() {
    const day = utcDay();
    for (const m of metered) {
      const total = m.socket.bytesRead + m.socket.bytesWritten;
      const delta = total - m.counted;
      if (delta > 0) {
        m.counted = total;
        const user = q.userById.get(m.userId);
        if (user) {
          // Spend today's free/paid allowance first; only the overflow comes
          // out of the account's extra balance.
          const allowanceLeft = Math.max(0, dailyAllowanceBytes(user) - usedTodayBytes(m.userId));
          const fromBalance = Math.max(0, delta - allowanceLeft);
          q.charge.run(fromBalance, delta, Date.now(), m.userId);
          q.logUsage.run(m.userId, day, delta);
        }
      }
      const user = q.userById.get(m.userId);
      if (!user || availableBytes(user) <= 0) m.socket.destroy();
    }
  }
  setInterval(chargeAll, 3000).unref();
  // Returns false (and answers the upgrade) when the request may not proxy.
  function admitWisp(req, socket) {
    const user = userFromRequest(req);
    const refuse = (status, text) => {
      socket.end("HTTP/1.1 " + status + " " + text + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return false;
    };
    if (!user) return refuse(401, "Unauthorized");
    if (availableBytes(user) <= 0) return refuse(402, "Payment Required");
    const entry = { socket, userId: user.id, counted: 0 };
    metered.add(entry);
    socket.once("close", () => {
      chargeAll();
      metered.delete(entry);
    });
    return true;
  }

  // --- HTTP API ---------------------------------------------------------------
  const router = express.Router();
  router.use(express.json({ limit: "3mb" }));
  const perMinute = Number(process.env.AUTH_ATTEMPTS_PER_MINUTE) || 10;
  const authLimit = limiter(perMinute), redeemLimit = limiter(perMinute);
  const ip = (req) => req.ip || req.socket.remoteAddress;
  const secureCookie = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";
  // Only accept JSON for state-changing calls: blocks cross-site form posts.
  router.use((req, res, next) => {
    if (req.method !== "GET" && !req.is("application/json")) return res.status(415).json({ error: "Send JSON." });
    res.set("Cache-Control", "no-store");
    next();
  });
  function requireUser(req, res, next) {
    req.user = userFromRequest(req);
    if (!req.user) return res.status(401).json({ error: "Please sign in." });
    next();
  }

  router.post("/signup", (req, res) => {
    if (!authLimit(ip(req))) return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(username)) return res.status(400).json({ error: "Usernames are 3–40 letters, numbers, dots, dashes or underscores." });
    if (!password) return res.status(400).json({ error: "Enter a password." });
    if (q.userByName.get(username)) return res.status(409).json({ error: "That username is taken." });
    const { lastInsertRowid } = q.addUser.run(username, hashPassword(password), signupBytes, Date.now());
    startSession(res, Number(lastInsertRowid), secureCookie(req));
    res.json({ user: publicUser(q.userById.get(Number(lastInsertRowid))) });
  });
  router.post("/login", (req, res) => {
    if (!authLimit(ip(req))) return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
    const user = q.userByName.get(String(req.body.username || "").trim());
    if (!user || !checkPassword(String(req.body.password || ""), user.password)) {
      return res.status(401).json({ error: "Wrong username or password." });
    }
    startSession(res, user.id, secureCookie(req));
    res.json({ user: publicUser(user) });
  });
  router.post("/logout", (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) q.dropSession.run(sha256(token));
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
  });
  router.get("/me", requireUser, (req, res) => {
    chargeAll();
    res.json({
      user: publicUser(q.userById.get(req.user.id)),
      pricing: {
        pencePerGb: 25,
        freeDailyGb: dailyFreeBytes / GB,
        subscription: { pounds: 1.99, dailyGb: dailyPaidBytes / GB, available: false },
      },
    });
  });
  router.post("/redeem", requireUser, (req, res) => {
    if (!redeemLimit(ip(req)) || !redeemLimit("user:" + req.user.id)) return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
    const code = String(req.body.code || "").trim().toUpperCase().replace(/\s+/g, "");
    const found = q.code.get(code);
    if (!found) return res.status(404).json({ error: "That code isn't valid." });
    const claimed = q.claimCode.run(req.user.id, Date.now(), code);
    if (claimed.changes !== 1) return res.status(409).json({ error: "That code has already been used." });
    q.credit.run(found.bytes, req.user.id);
    res.json({ addedBytes: found.bytes, user: publicUser(q.userById.get(req.user.id)) });
  });
  // Saved sign-ins: the proxy's cookie jar, last writer wins (by version).
  router.get("/cookies", requireUser, (req, res) => {
    const row = q.jar.get(req.user.id);
    res.json(row ? { version: row.version, jar: JSON.parse(row.jar) } : { version: 0, jar: null });
  });
  router.put("/cookies", requireUser, (req, res) => {
    const text = JSON.stringify(req.body.jar ?? null);
    if (text.length > MAX_JAR_BYTES) return res.status(413).json({ error: "Too many saved sign-ins." });
    q.putJar.run(req.user.id, text, Date.now());
    res.json({ version: q.jar.get(req.user.id).version });
  });

  // --- Admin (owner) ----------------------------------------------------------
  const adminLimit = limiter(Math.max(20, perMinute));
  function requireAdmin(req, res, next) {
    if (!adminPassword) return res.status(404).json({ error: "Admin is disabled (set ADMIN_PASSWORD)." });
    if (!adminLimit("admin:" + ip(req))) return res.status(429).json({ error: "Too many attempts." });
    if (!sameSecret(req.get("x-admin-password") || "", adminPassword)) return res.status(401).json({ error: "Wrong admin password." });
    next();
  }
  router.post("/admin/codes", requireAdmin, (req, res) => {
    const gb = Number(req.body.gb);
    const count = Math.min(50, Math.max(1, Math.floor(Number(req.body.count) || 1)));
    if (!(gb > 0 && gb <= 1000)) return res.status(400).json({ error: "Enter how many GB (more than 0)." });
    const note = String(req.body.note || "").slice(0, 100);
    const made = [];
    for (let i = 0; i < count; i++) {
      const code = newCode();
      q.addCode.run(code, Math.round(gb * GB), note, Date.now());
      made.push(code);
    }
    res.json({ codes: made, gb });
  });
  router.get("/admin/overview", requireAdmin, (req, res) => {
    chargeAll();
    const day = (offset) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);
    const users = q.users.all(day(0), day(29));
    const sum = (key) => users.reduce((total, u) => total + u[key], 0);
    res.json({
      codes: q.codes.all(), users,
      totals: { users: users.length, balanceBytes: sum("balance_bytes"), usedBytes: sum("used_bytes"), usedToday: sum("used_today"), used30d: sum("used_30d") },
    });
  });
  // Change one account's data: add, remove or set it to an exact amount (GB).
  router.post("/admin/balance", requireAdmin, (req, res) => {
    const user = q.userByName.get(String(req.body.username || ""));
    if (!user) return res.status(404).json({ error: "No such user." });
    const bytes = Math.round(Number(req.body.gb) * GB);
    if (!Number.isFinite(bytes) || bytes < 0) return res.status(400).json({ error: "Enter an amount of GB (0 or more)." });
    if (req.body.action === "add") q.addBalance.run(bytes, user.id);
    else if (req.body.action === "remove") q.addBalance.run(-bytes, user.id);
    else if (req.body.action === "set") q.setBalance.run(bytes, user.id);
    else return res.status(400).json({ error: "Unknown action." });
    chargeAll(); // closes their connections if they're now at zero
    res.json({ user: publicUser(q.userById.get(user.id)) });
  });
  router.post("/admin/credit", requireAdmin, (req, res) => {
    const user = q.userByName.get(String(req.body.username || ""));
    if (!user) return res.status(404).json({ error: "No such user." });
    q.credit.run(Math.round(Number(req.body.gb || 0) * GB), user.id);
    res.json({ user: publicUser(q.userById.get(user.id)) });
  });
  // Mark an account as paid (gets the bigger daily allowance) for a number of
  // days, or clear it back to free. "add" extends from the current expiry if
  // the subscription is still active.
  router.post("/admin/subscription", requireAdmin, (req, res) => {
    const user = q.userByName.get(String(req.body.username || ""));
    if (!user) return res.status(404).json({ error: "No such user." });
    let until;
    if (req.body.action === "clear") {
      until = null;
    } else {
      const days = Number(req.body.days);
      if (!Number.isFinite(days) || days <= 0) return res.status(400).json({ error: "Enter a number of days (more than 0)." });
      const base = isPaid(user) ? user.subscription_until : Date.now();
      until = base + days * 86400_000;
    }
    q.setSubscription.run(until, user.id);
    chargeAll();
    res.json({ user: publicUser(q.userById.get(user.id)) });
  });

  log.log("[accounts] database at " + path.join(dataDir, "orbit.db") + (adminPassword ? "; admin enabled" : "; admin disabled (no ADMIN_PASSWORD)"));
  return { router, userFromRequest, admitWisp, close: () => db.close() };
}

module.exports = { createAccounts, GB };
