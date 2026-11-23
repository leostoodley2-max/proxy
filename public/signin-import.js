// "Bring in a sign-in": imports cookies exported from the user's normal
// browser (Cookie-Editor style JSON, or Netscape cookies.txt) into Scramjet's
// cookie store, so sites opened in the proxy see the user as signed in.
// A web page can't read another site's cookies itself; exporting them with an
// extension and pasting them here is the only way across.
"use strict";

(() => {
  const dialog = document.getElementById("import-dialog");
  const text = document.getElementById("import-text");
  const result = document.getElementById("import-result");

  // -> [{ name, value, domain, hostOnly, path, secure, httpOnly, sameSite, expires (seconds) }]
  function parse(input) {
    const trimmed = input.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      let list = JSON.parse(trimmed);
      if (!Array.isArray(list)) list = list.cookies || [list];
      return list.map((c) => ({
        name: c.name, value: c.value, domain: c.domain || c.host,
        hostOnly: c.hostOnly === true || (c.hostOnly === undefined && !String(c.domain || "").startsWith(".")),
        path: c.path || "/", secure: !!c.secure, httpOnly: !!(c.httpOnly ?? c.httponly),
        sameSite: String(c.sameSite || c.samesite || ""),
        expires: c.session ? null : Number(c.expirationDate ?? c.expires ?? c.expiry) || null,
      }));
    }
    // Netscape cookies.txt: domain, subdomains flag, path, secure, expiry, name, value (tab-separated).
    const cookies = [];
    for (let line of trimmed.split(/\r?\n/)) {
      let httpOnly = false;
      if (line.startsWith("#HttpOnly_")) { httpOnly = true; line = line.slice(10); }
      if (!line || line.startsWith("#")) continue;
      const f = line.split("\t");
      if (f.length < 7) continue;
      cookies.push({
        domain: f[0], hostOnly: f[1].toUpperCase() !== "TRUE", path: f[2] || "/", secure: f[3].toUpperCase() === "TRUE",
        expires: Number(f[4]) || null, name: f[5], value: f.slice(6).join("\t"), httpOnly, sameSite: "",
      });
    }
    return cookies;
  }

  function setCookieHeader(c) {
    const parts = [c.name + "=" + c.value, "Path=" + c.path];
    if (!c.hostOnly) parts.push("Domain=" + c.domain.replace(/^\./, ""));
    if (c.expires) parts.push("Expires=" + new Date(c.expires * 1000).toUTCString());
    if (c.secure) parts.push("Secure");
    if (c.httpOnly) parts.push("HttpOnly");
    const sameSite = { no_restriction: "None", none: "None", lax: "Lax", strict: "Strict" }[c.sameSite.toLowerCase()];
    if (sameSite) parts.push("SameSite=" + sameSite);
    return parts.join("; ");
  }

  async function importCookies(input) {
    const cookies = parse(input).filter((c) => c.name && c.domain && typeof c.value === "string");
    if (!cookies.length) throw new Error("No cookies found. Paste the JSON or cookies.txt export.");
    const now = Date.now() / 1000;
    const live = cookies.filter((c) => !c.expires || c.expires > now);
    const worker = (await navigator.serviceWorker.ready).active;
    const sites = new Set();
    for (const c of live) {
      const host = c.domain.replace(/^\./, "");
      sites.add(host.replace(/^www\./, ""));
      // Scramjet's service worker stores the cookie and saves its cookie jar.
      worker.postMessage({ scramjet$type: "cookie", cookie: setCookieHeader(c), url: "https://" + host + c.path });
    }
    return { count: live.length, expired: cookies.length - live.length, sites: [...sites] };
  }

  document.getElementById("open-import").addEventListener("click", () => {
    document.getElementById("import-form").reset();
    result.hidden = true;
    dialog.showModal();
    text.focus();
  });
  document.getElementById("cancel-import").addEventListener("click", () => dialog.close());
  document.getElementById("import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const { count, expired, sites } = await importCookies(text.value);
      result.textContent = "Imported " + count + " cookie" + (count === 1 ? "" : "s") + " for " + sites.slice(0, 4).join(", ") +
        (sites.length > 4 ? " and " + (sites.length - 4) + " more" : "") + (expired ? " (" + expired + " expired ones skipped)" : "") +
        ". Reload that site's tab. Some sites (Google, for one) tie a sign-in to the device and may still ask you to sign in again.";
      result.style.color = "";
      text.value = "";
    } catch (error) {
      result.textContent = error instanceof SyntaxError ? "That isn't valid JSON. Paste the whole export." : error.message;
      result.style.color = "#ff7b8a";
    }
    result.hidden = false;
  });
})();
