// The signed-in account inside the browser: data left, top-ups, sign out, and
// syncing saved sign-ins (the proxy's cookie jar) with the account, so they
// follow the user to any device.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const GB = 1e9;
  const gb = (bytes) => (bytes / GB).toFixed(bytes >= 10 * GB ? 1 : 2);

  async function api(path, method = "GET", body) {
    const res = await fetch("/api/" + path, {
      method, cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { if (!leaving) location.replace("/"); throw new Error("Signed out."); }
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    return data;
  }

  // ---- Saved sign-ins --------------------------------------------------------
  // Scramjet keeps its cookie jar in IndexedDB ($scramjet / cookies / "cookies").
  function jarStore(mode, work) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("$scramjet");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("cookies")) { db.close(); return resolve(undefined); }
        const tx = db.transaction("cookies", mode);
        const req = work(tx.objectStore("cookies"));
        tx.oncomplete = () => { db.close(); resolve(req && req.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const readJar = async () => (await jarStore("readonly", (s) => s.get("cookies"))) || {};
  const writeJar = (jar) => jarStore("readwrite", (s) => s.put(jar, "cookies"));
  function reloadWorkerJar() {
    return new Promise((resolve) => {
      const worker = navigator.serviceWorker.controller;
      if (!worker) return resolve();
      const done = (e) => { if (e.data && e.data.type === "orbit-cookies-reloaded") finish(); };
      const finish = () => { navigator.serviceWorker.removeEventListener("message", done); resolve(); };
      navigator.serviceWorker.addEventListener("message", done);
      worker.postMessage({ type: "orbit-reload-cookies" });
      setTimeout(finish, 3000);
    });
  }

  let me = null, lastPushed = null, leaving = false;
  const versionKey = () => "orbit.jarVersion:" + me.username.toLowerCase();
  // Bring this device's jar up to date with the account (before tabs load).
  async function pull() {
    const remote = await api("cookies");
    const owner = localStorage.getItem("orbit.jarOwner");
    const name = me.username.toLowerCase();
    const localVersion = Number(localStorage.getItem(versionKey()) || 0);
    if (owner !== name) {
      // Different person on this device: never keep the previous person's sign-ins.
      await writeJar(remote.jar || {});
      localStorage.setItem("orbit.jarOwner", name);
      localStorage.setItem(versionKey(), String(remote.version));
      await reloadWorkerJar();
    } else if (remote.jar && remote.version > localVersion) {
      await writeJar(remote.jar);
      localStorage.setItem(versionKey(), String(remote.version));
      await reloadWorkerJar();
    }
    lastPushed = JSON.stringify(await readJar());
  }
  // Save this device's changes to the account.
  async function push(keepalive = false) {
    if (!me) return;
    const jar = await readJar();
    const text = JSON.stringify(jar);
    if (text === lastPushed) return;
    const res = await fetch("/api/cookies", {
      method: "PUT", keepalive, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jar }),
    });
    if (res.ok) {
      lastPushed = text;
      localStorage.setItem(versionKey(), String((await res.json()).version));
    }
  }

  // ---- Data left and top-ups -------------------------------------------------
  function paint() {
    // Data left to spend now = today's unused allowance + any extra balance.
    const allowanceLeft = me.allowanceLeftBytes ?? me.balanceBytes ?? 0;
    const extra = me.balanceBytes ?? 0;
    const left = allowanceLeft + extra;
    const perDay = me.dailyAllowanceBytes ?? 0;
    const chip = $("account-chip");
    chip.textContent = gb(left) + " GB";
    chip.title = me.username + ": " + gb(allowanceLeft) + " GB left today"
      + (extra > 0 ? " + " + gb(extra) + " GB extra" : "")
      + " · " + (me.paid ? "paid " : "free ") + gb(perDay) + " GB/day";
    chip.classList.toggle("low", left < 0.1 * GB);
    $("account-name").textContent = me.username;
    $("account-left").textContent = gb(left) + " GB";
    $("account-used").textContent = gb(me.usedTodayBytes ?? 0) + " GB used today"
      + (me.usedBytes ? " · " + gb(me.usedBytes) + " GB in total" : "");
    const empty = left <= 0;
    $("out-of-data").hidden = !empty;
  }
  let planAvailable = false, planGb = 3;
  const subscribed = () => ["active", "trialing", "past_due"].includes(me.subscriptionStatus);
  function paintPlan() {
    const button = $("plan-action");
    if (!planAvailable) {
      button.textContent = "Coming soon";
      button.disabled = true;
    } else if (subscribed()) {
      const until = me.subscriptionUntil ? new Date(me.subscriptionUntil).toLocaleDateString() : "";
      $("plan-status").textContent = me.subscriptionStatus === "past_due"
        ? "Your last payment didn't go through. Update your card to keep your " + planGb + " GB a day."
        : "Active: " + planGb + " GB a day" + (until ? ", paid until " + until : "") + ".";
      button.textContent = "Manage or cancel";
      button.disabled = false;
    } else {
      $("plan-status").textContent = planGb + " GB every day instead of the free allowance, paid by card. Cancel any time.";
      button.textContent = "Subscribe";
      button.disabled = false;
    }
  }
  async function refresh() {
    const data = await api("me");
    me = data.user;
    planAvailable = !!(data.pricing && data.pricing.subscription && data.pricing.subscription.available);
    if (data.pricing && data.pricing.subscription && data.pricing.subscription.dailyGb) planGb = data.pricing.subscription.dailyGb;
    paint();
    paintPlan();
  }

  $("account-chip").addEventListener("click", () => {
    $("redeem-result").hidden = true;
    $("account-dialog").showModal();
  });
  $("out-of-data").addEventListener("click", () => $("account-chip").click());
  // Subscribe opens Stripe's checkout; subscribers get Stripe's page to manage or cancel.
  $("plan-action").addEventListener("click", async () => {
    const button = $("plan-action"), out = $("plan-result");
    button.disabled = true;
    out.hidden = true;
    try {
      const data = await api(subscribed() ? "stripe/portal" : "stripe/checkout", "POST", {});
      await push().catch(() => {});
      location.href = data.url;
    } catch (error) {
      out.textContent = error.message;
      out.className = "error";
      out.hidden = false;
      button.disabled = false;
    }
  });
  $("close-account").addEventListener("click", () => $("account-dialog").close());
  $("sign-out").addEventListener("click", async () => {
    leaving = true;
    await push().catch(() => {});
    await api("logout", "POST", {}).catch(() => {});
    location.replace("/");
  });
  $("redeem-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const out = $("redeem-result");
    try {
      const data = await api("redeem", "POST", { code: $("redeem-code").value });
      me = data.user;
      paint();
      out.textContent = "Added " + gb(data.addedBytes) + " GB. You now have " + gb(me.balanceBytes) + " GB.";
      out.className = "ok";
      $("redeem-code").value = "";
    } catch (error) {
      out.textContent = error.message;
      out.className = "error";
    }
    out.hidden = false;
  });

  // Data saver (see datasaver.js): on unless turned off on this device.
  function sendDataSaver() {
    const on = localStorage.getItem("orbit.dataSaver") !== "0";
    $("data-saver").checked = on;
    const worker = navigator.serviceWorker.controller;
    if (worker) worker.postMessage({ type: "orbit-data-saver", on });
  }
  $("data-saver").addEventListener("change", () => {
    localStorage.setItem("orbit.dataSaver", $("data-saver").checked ? "1" : "0");
    sendDataSaver();
  });

  window.OrbitAccount = {
    // Resolves once the account is known and sign-ins are synced; tabs wait for it.
    ready: (async () => {
      await refresh();
      await window.Engine.ready;
      sendDataSaver();
      await pull().catch((e) => console.warn("[orbit] couldn't sync saved sign-ins", e));
      setInterval(() => push().catch(() => {}), 15000);
      addEventListener("pagehide", () => { push(true).catch(() => {}); });
      setInterval(() => refresh().catch(() => {}), 20000);
      // Back from Stripe's checkout: the data arrives once Stripe confirms the payment.
      if (new URLSearchParams(location.search).get("subscribed") === "1") {
        history.replaceState(null, "", "/app");
        $("out-of-data").hidden = true;
        const thanks = $("subscribed-banner");
        thanks.hidden = false;
        setTimeout(() => { thanks.hidden = true; }, 15000);
        for (const wait of [3000, 8000, 15000]) setTimeout(() => refresh().catch(() => {}), wait);
      }
    })(),
    refresh,
    push, // save sign-ins now (also used by tests)
  };
})();
