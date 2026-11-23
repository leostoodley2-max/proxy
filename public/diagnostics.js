// Diagnostics page: runs checks against the real sites people use through
// the proxy and builds a plain-text report that can be pasted into a bug report.
"use strict";

(() => {
  const list = document.getElementById("checks");
  const report = document.getElementById("report");
  const copy = document.getElementById("copy");
  const rerun = document.getElementById("rerun");
  const lines = [];

  // Proxied responses that set cookies wait for the page to acknowledge them
  // (see scripts/patch-scramjet.js); answer like a proxied page would.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", ({ data }) => {
      if (data && data.scramjet$type === "cookie" && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ scramjet$type: "cookie", scramjet$token: data.scramjet$token });
      }
    });
    navigator.serviceWorker.startMessages();
  }

  function row(name) {
    const li = document.createElement("li");
    li.className = "wait";
    li.innerHTML = "<div><strong></strong><div class=detail></div></div>";
    li.querySelector("strong").textContent = name;
    list.append(li);
    return (state, detail) => {
      li.className = state;
      li.querySelector(".detail").textContent = detail;
      lines.push({ ok: "OK  ", warn: "WARN", bad: "FAIL" }[state] + " " + name + ": " + detail);
    };
  }

  const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("no answer after " + ms / 1000 + " s")), ms));
  async function timed(work, ms = 25000) {
    const start = performance.now();
    const value = await Promise.race([work(), timeout(ms)]);
    return { value, ms: Math.round(performance.now() - start) };
  }
  // Fetch a real URL through the proxy (the service worker handles proxied /study/ URLs).
  // Scramjet answers a request it couldn't make at all with an empty 500.
  async function viaProxy(url, init) {
    const res = await fetch(window.Engine.scramjet.encodeUrl(url), init);
    if (res.status === 500 && !res.headers.get("content-type")) {
      throw new Error("the proxy couldn't connect to the site (details under Recent failed requests)");
    }
    return res;
  }
  const short = (error) => String((error && error.message) || error).slice(0, 200);

  async function checkBrowser() {
    const done = row("Browser");
    let streams = false;
    try {
      const channel = new MessageChannel(), stream = new ReadableStream();
      channel.port1.postMessage(stream, [stream]);
      streams = true;
    } catch (e) {}
    const facts = [
      navigator.userAgent,
      "service worker " + ("serviceWorker" in navigator ? (navigator.serviceWorker.controller ? "in control" : "not in control") : "unsupported"),
      "isolated " + window.crossOriginIsolated,
      "SharedWorker " + (typeof SharedWorker === "function"),
      "stream transfer " + streams,
    ];
    const bad = !("serviceWorker" in navigator) || typeof SharedWorker !== "function";
    done(bad ? "bad" : "ok", facts.join("; "));
  }

  async function checkServer() {
    const done = row("Proxy server");
    try {
      const { value, ms } = await timed(async () => (await fetch("/egress", { cache: "no-store" })).json());
      const where = value.ip ? " (exit IP " + value.ip + (value.colo ? ", " + value.colo : "") + ")" : "";
      if (value.warp) done(ms > 3000 ? "warn" : "ok", "answered in " + ms + " ms" + (ms > 3000 ? " (slow: probably waking up)" : "") + "; WARP on" + where);
      else done("bad", "answered in " + ms + " ms, but WARP is OFF" + where + ": sites see the server's own data-centre IP, so YouTube asks to confirm you're not a bot and Cloudflare sites challenge it");
    } catch (error) {
      done("bad", "no answer: " + short(error));
    }
  }

  async function checkEngine() {
    const done = row("Proxy engine");
    try {
      const { ms } = await timed(() => window.Engine.ready, 30000);
      done("ok", "ready in " + ms + " ms");
      return true;
    } catch (error) {
      done("bad", short(error));
      return false;
    }
  }

  async function checkExit() {
    const done = row("What websites see");
    try {
      const { value: text, ms } = await timed(async () => {
        const res = await viaProxy("https://www.cloudflare.com/cdn-cgi/trace");
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      });
      const trace = Object.fromEntries(text.trim().split("\n").map((line) => line.split("=")));
      const detail = "IP " + trace.ip + ", Cloudflare " + trace.colo + ", warp=" + trace.warp + " (" + ms + " ms)";
      done(trace.warp === "on" || trace.warp === "plus" ? "ok" : "warn", detail + (trace.warp === "off" ? "; not going out through WARP" : ""));
    } catch (error) {
      done("bad", "couldn't reach Cloudflare through the proxy: " + short(error));
    }
  }

  async function checkSpeed() {
    const done = row("Download speed");
    try {
      const { value: bytes, ms } = await timed(async () => {
        const res = await viaProxy("https://speed.cloudflare.com/__down?bytes=10000000");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const reader = res.body.getReader();
        let n = 0;
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) return n;
          n += value.length;
        }
      }, 60000);
      const mbit = (bytes * 8) / 1e6 / (ms / 1000);
      done(mbit < 5 ? "warn" : "ok", (bytes / 1e6).toFixed(1) + " MB in " + (ms / 1000).toFixed(1) + " s = " + mbit.toFixed(1) +
        " Mbit/s" + (mbit < 5 ? " (HD video needs about 5)" : ""));
    } catch (error) {
      done("bad", short(error));
    }
  }

  async function checkYouTube() {
    const page = row("YouTube page");
    try {
      const { value: res, ms } = await timed(() => viaProxy("https://www.youtube.com/"));
      page(res.ok ? "ok" : "bad", "HTTP " + res.status + " in " + ms + " ms");
    } catch (error) {
      page("bad", short(error));
    }
    // The player API decides whether a video plays for this IP: when YouTube
    // distrusts it, it answers LOGIN_REQUIRED ("Sign in to confirm you're not a bot").
    const player = row("YouTube video playback");
    try {
      const { value: data, ms } = await timed(async () => {
        const res = await viaProxy("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20251101.01.00", hl: "en" } }, videoId: "jNQXAC9IVRw" }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
      const status = data.playabilityStatus || {};
      const formats = ((data.streamingData || {}).adaptiveFormats || []).length;
      if (status.status === "OK") player("ok", "YouTube will play videos (" + formats + " streams offered, " + ms + " ms)");
      else player("bad", "YouTube refuses: " + status.status + (status.reason ? " (" + status.reason + ")" : "") + "; this is about the IP the proxy uses, not this browser");
    } catch (error) {
      player("bad", short(error));
    }
  }

  async function checkSite(name, url) {
    const done = row(name);
    try {
      const { value: res, ms } = await timed(() => viaProxy(url));
      const text = await res.text();
      const challenge = res.headers.get("cf-mitigated") === "challenge" || /<title>Just a moment|challenge-platform|cf-chl-/i.test(text);
      if (challenge) done("bad", "blocked by a Cloudflare bot check (HTTP " + res.status + ", " + ms + " ms)");
      else done(res.ok ? (ms > 8000 ? "warn" : "ok") : "bad", "HTTP " + res.status + " in " + ms + " ms" + (ms > 8000 ? " (slow)" : ""));
    } catch (error) {
      done("bad", short(error));
    }
  }

  async function recentErrors() {
    const done = row("Recent failed requests");
    try {
      const controller = navigator.serviceWorker.controller;
      if (!controller) throw new Error("service worker not in control");
      const { value: errors } = await timed(() => new Promise((resolve) => {
        navigator.serviceWorker.addEventListener("message", function on({ data }) {
          if (!data || data.type !== "orbit-diagnostics") return;
          navigator.serviceWorker.removeEventListener("message", on);
          resolve(data.errors || []);
        });
        controller.postMessage({ type: "orbit-diagnostics" });
      }), 5000);
      done(errors.length ? "warn" : "ok", errors.length ? errors.length + " (listed in the report)" : "none recorded");
      for (const e of errors) lines.push("     " + e.time + " [" + e.type + "] " + e.url + " -> " + e.error);
    } catch (error) {
      done("warn", "couldn't read them: " + short(error));
    }
  }

  async function run() {
    list.replaceChildren();
    lines.length = 0;
    copy.disabled = rerun.disabled = true;
    report.value = "Running…";
    lines.push("Orbit diagnostics, " + new Date().toISOString() + ", " + location.host);
    await checkBrowser();
    await checkServer();
    if (await checkEngine()) {
      await checkExit();
      await checkYouTube();
      await checkSite("Poki (games)", "https://poki.com/");
      await checkSite("CrazyGames (games)", "https://www.crazygames.com/");
      await checkSite("Coolmath Games", "https://www.coolmathgames.com/");
      await checkSite("TikTok", "https://www.tiktok.com/");
      await checkSpeed();
    }
    await recentErrors();
    report.value = lines.join("\n");
    copy.disabled = rerun.disabled = false;
  }

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(report.value);
      copy.textContent = "Copied";
    } catch (e) {
      report.select();
      copy.textContent = "Press Ctrl+C / ⌘C";
    }
    setTimeout(() => { copy.textContent = "Copy report"; }, 2000);
  });
  rerun.addEventListener("click", run);
  run();
})();
