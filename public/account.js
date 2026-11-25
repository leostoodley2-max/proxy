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
    if (res.status === 401) { location.replace("/"); throw new Error("Signed out."); }
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

  let me = null, lastPushed = null;
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
    const left = me.balanceBytes;
    const chip = $("account-chip");
    chip.textContent = gb(left) + " GB";
    chip.title = me.username + ": " + gb(left) + " GB of data left";
    chip.classList.toggle("low", left < 0.5 * GB);
    $("account-name").textContent = me.username;
    $("account-left").textContent = gb(left) + " GB";
    $("account-used").textContent = gb(me.usedBytes) + " GB used so far";
    const empty = left <= 0;
    $("out-of-data").hidden = !empty;
  }
  async function refresh() {
    const data = await api("me");
    me = data.user;
    paint();
  }

  $("account-chip").addEventListener("click", () => {
    $("redeem-result").hidden = true;
    $("account-dialog").showModal();
  });
  $("out-of-data").addEventListener("click", () => $("account-chip").click());
  $("close-account").addEventListener("click", () => $("account-dialog").close());
  $("sign-out").addEventListener("click", async () => {
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

  window.OrbitAccount = {
    // Resolves once the account is known and sign-ins are synced; tabs wait for it.
    ready: (async () => {
      await refresh();
      await window.Engine.ready;
      await pull().catch((e) => console.warn("[orbit] couldn't sync saved sign-ins", e));
      setInterval(() => push().catch(() => {}), 15000);
      addEventListener("pagehide", () => { push(true).catch(() => {}); });
      setInterval(() => refresh().catch(() => {}), 20000);
    })(),
    refresh,
    push, // save sign-ins now (also used by tests)
  };
})();
