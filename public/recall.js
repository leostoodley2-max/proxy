// Recall: flashcards with spaced repetition, several study modes, import /
// export and a focus timer. Accounts and decks live in this browser's
// localStorage (passwords are stored only as salted PBKDF2 hashes) and are for
// revision only. One special sign-in opens the web browser at /app instead,
// which then asks for a (paid) browser account.
"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const ACCOUNTS = "recall.accounts.v1";
  const CURRENT = "recall.current.v1";
  const THEME = "recall.theme";
  // SHA-256 of "<username>:<password>" for the sign-in that opens /app.
  const BROWSER_KEY = "de28b315be7a7f934354a091ef77a2263965b0870eddfa02f413d7a7ba20ab67";

  const DAY = 86400000;
  // Spaced-repetition intervals in days, indexed by Leitner box.
  const INTERVALS = [0, 1, 2, 4, 7, 14, 30];
  const MASTER_BOX = 3; // box at which a card counts as "known"

  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or disabled */ }
  };
  const id = () => Math.random().toString(36).slice(2, 10);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ---- Theme (dark mode) ---------------------------------------------------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    write(THEME, theme);
    $("theme-toggle").textContent = theme === "dark" ? "☀️" : "🌙";
  }
  applyTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  $("theme-toggle").addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

  // ---- Accounts ------------------------------------------------------------
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sha256 = async (text) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  async function passwordHash(password, salt) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 120000 }, key, 256);
    return hex(bits);
  }
  const normal = (name) => name.trim().toLowerCase();
  let user = read(CURRENT, null);

  async function signIn(name, password) {
    if ((await sha256(normal(name) + ":" + password)) === BROWSER_KEY) {
      // Opens the web browser's own sign-in (its paid accounts live on the server).
      document.cookie = "orbit_gate=1; Path=/; Max-Age=31536000; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
      location.href = "/app";
      return null;
    }
    const account = read(ACCOUNTS, {})[normal(name)];
    if (!account || (await passwordHash(password, account.salt)) !== account.hash) return "Wrong username or password.";
    setUser(account.name);
    return null;
  }
  async function signUp(name, password) {
    const key = normal(name);
    if (!/^[a-z0-9_.-]{3,40}$/.test(key)) return "Usernames are 3–40 letters, numbers, dots, dashes or underscores.";
    if (!password) return "Enter a password.";
    const accounts = read(ACCOUNTS, {});
    if (accounts[key] || key === "proxy") return "That username is taken.";
    const salt = id() + id();
    accounts[key] = { name: name.trim(), salt, hash: await passwordHash(password, salt) };
    write(ACCOUNTS, accounts);
    setUser(name.trim());
    return null;
  }
  function setUser(name) {
    user = name;
    write(CURRENT, name);
    load();
  }

  // ---- Data + migration ------------------------------------------------------
  const newCard = (front, back) => ({ id: id(), front, back, box: 0, due: 0, starred: false });
  const sample = () => ({
    decks: [{
      id: id(), name: "Biology: Cells", cards: [
        ["What is the function of the mitochondria?", "Aerobic respiration: releasing energy from glucose."],
        ["What does the cell membrane do?", "Controls what enters and leaves the cell."],
        ["Where is genetic material found in a plant cell?", "In the nucleus."],
        ["What do ribosomes make?", "Proteins."],
        ["Name two structures found in plant cells but not animal cells.", "Cell wall, chloroplasts (and a permanent vacuole)."],
      ].map(([front, back]) => newCard(front, back)),
    }],
    sessions: { day: "", count: 0 },
    streak: { last: "", days: 0 },
  });
  // Bring older saved data up to the current shape without ever throwing.
  function migrate(d) {
    if (!d || typeof d !== "object") return sample();
    d.decks = (Array.isArray(d.decks) ? d.decks : []).map((dk) => ({
      id: dk.id || id(),
      name: String(dk.name || "Untitled"),
      cards: (Array.isArray(dk.cards) ? dk.cards : []).map((c) => ({
        id: c.id || id(),
        front: String(c.front || ""),
        back: String(c.back || ""),
        box: Number.isInteger(c.box) ? c.box : 0,
        due: typeof c.due === "number" ? c.due : 0,
        starred: !!c.starred,
      })),
    }));
    d.sessions = d.sessions && typeof d.sessions === "object" ? d.sessions : { day: "", count: 0 };
    d.streak = d.streak && typeof d.streak === "object" ? d.streak : { last: "", days: 0 };
    return d;
  }
  let data;
  const storeKey = () => "recall.data.v1." + (user ? normal(user) : "guest");
  const save = () => write(storeKey(), data);
  function load() {
    data = migrate(read(storeKey(), null));
    save();
    renderAccount();
    showDecks();
  }

  // ---- Spaced repetition -----------------------------------------------------
  const isDue = (c) => (c.due || 0) <= Date.now();
  const known = (c) => c.box >= MASTER_BOX;
  const dueCount = (deck) => deck.cards.filter(isDue).length;
  const mastery = (deck) => deck.cards.length ? Math.round(deck.cards.filter(known).length / deck.cards.length * 100) : 0;
  const allDue = () => data.decks.flatMap((d) => d.cards).filter(isDue);
  function schedule(card, knew) {
    card.box = knew ? clamp(card.box + 1, 0, INTERVALS.length - 1) : 0;
    card.due = Date.now() + INTERVALS[card.box] * DAY;
  }

  // ---- Views -----------------------------------------------------------------
  let deck = null;
  function show(view) {
    for (const v of ["hero", "deck-view", "study-view"]) $(v).hidden = v !== view;
    document.querySelector(".layout").hidden = view !== "hero";
    $("hero").hidden = view !== "hero";
  }
  function renderAccount() {
    $("who").hidden = $("signout").hidden = !user;
    $("open-signin").hidden = $("open-signup").hidden = !!user;
    $("who").textContent = user ? "Signed in as " + user : "";
    const today = new Date().toDateString();
    if (data.sessions.day !== today) data.sessions = { day: today, count: 0 };
    $("sessions").textContent = data.sessions.count;
    renderStreak();
  }
  function renderStreak() {
    const s = data.streak || { last: "", days: 0 };
    const today = new Date().toDateString();
    const yday = new Date(Date.now() - DAY).toDateString();
    const live = s.days > 0 && (s.last === today || s.last === yday);
    $("streak").textContent = live ? "🔥 " + s.days + " day study streak" : "";
  }
  // Counts the current calendar day towards the study streak (once per day).
  function markStudied() {
    const today = new Date().toDateString();
    const yday = new Date(Date.now() - DAY).toDateString();
    if (!data.streak || typeof data.streak !== "object") data.streak = { last: "", days: 0 };
    if (data.streak.last === today) return;
    data.streak.days = data.streak.last === yday ? (data.streak.days || 0) + 1 : 1;
    data.streak.last = today;
    save();
    renderStreak();
  }

  function showDecks() {
    show("hero");
    const due = allDue().length;
    const btn = $("review-due");
    btn.hidden = due === 0;
    btn.textContent = "Review " + due + " due card" + (due === 1 ? "" : "s");
    const list = $("deck-list");
    list.replaceChildren();
    if (!data.decks.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No decks yet. Add one above.";
      list.append(li);
    }
    for (const d of data.decks) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.className = "deck";
      b.type = "button";
      const name = document.createElement("strong");
      name.textContent = d.name;
      const count = document.createElement("span");
      const due = dueCount(d);
      count.textContent = d.cards.length + " cards · " + mastery(d) + "% known" + (due ? " · " + due + " due" : "");
      b.append(name, count);
      if (due) {
        const dot = document.createElement("span");
        dot.className = "due-badge";
        dot.textContent = due;
        dot.setAttribute("aria-label", due + " cards due");
        b.append(dot);
      }
      b.addEventListener("click", () => openDeck(d));
      li.append(b);
      list.append(li);
    }
  }

  function openDeck(d) {
    deck = d;
    show("deck-view");
    $("deck-title").textContent = d.name;
    $("deck-meta").textContent = d.cards.length
      ? d.cards.length + " cards · " + d.cards.filter(known).length + " known · " + dueCount(d) + " due · " + mastery(d) + "% mastery"
      : "No cards yet — add some below.";
    $("study").disabled = $("shuffle").disabled = !d.cards.length;
    renderCards();
  }
  function renderCards() {
    const list = $("card-list");
    list.replaceChildren();
    deck.cards.forEach((c, i) => {
      const li = document.createElement("li");
      li.className = "card-row" + (isDue(c) ? " due" : "");

      const front = document.createElement("span");
      front.className = "c-front";
      front.textContent = c.front;
      const back = document.createElement("span");
      back.className = "back";
      back.textContent = c.back;

      const tools = document.createElement("span");
      tools.className = "card-tools";
      const mk = (label, title, fn, cls) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.title = title;
        btn.setAttribute("aria-label", title);
        if (cls) btn.className = cls;
        btn.addEventListener("click", fn);
        return btn;
      };
      tools.append(
        mk(c.starred ? "★" : "☆", c.starred ? "Unstar" : "Star", () => { c.starred = !c.starred; save(); renderCards(); }, c.starred ? "star on" : "star"),
        mk("✎", "Edit card", () => editCard(c)),
        mk("↑", "Move up", () => { if (i > 0) { [deck.cards[i - 1], deck.cards[i]] = [deck.cards[i], deck.cards[i - 1]]; save(); renderCards(); } }),
        mk("↓", "Move down", () => { if (i < deck.cards.length - 1) { [deck.cards[i + 1], deck.cards[i]] = [deck.cards[i], deck.cards[i + 1]]; save(); renderCards(); } }),
        mk("×", "Delete card", () => { deck.cards = deck.cards.filter((x) => x !== c); save(); openDeck(deck); }, "del"),
      );
      li.append(front, back, tools);
      list.append(li);
    });
  }

  // ---- Edit card -------------------------------------------------------------
  let editing = null;
  function editCard(c) {
    editing = c;
    $("edit-front").value = c.front;
    $("edit-back").value = c.back;
    $("edit").showModal();
    $("edit-front").focus();
  }
  $("edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (editing) {
      editing.front = $("edit-front").value.trim();
      editing.back = $("edit-back").value.trim();
      save();
      renderCards();
    }
    $("edit").close();
  });
  $("edit-cancel").addEventListener("click", () => $("edit").close());

  // ---- Study -----------------------------------------------------------------
  let queue = [], current = null, total = 0, mode = "flip", flipped = false, graded = 0, answered = false;

  function pickCards() {
    const scope = $("study-scope").value;
    let cards = deck.cards;
    if (scope === "due") cards = cards.filter(isDue);
    if (scope === "starred") cards = cards.filter((c) => c.starred);
    if (!cards.length && scope === "due") cards = deck.cards; // nothing due: study all
    return cards;
  }
  function startStudy(cards, title, forcedMode) {
    if (!cards.length) return;
    mode = forcedMode || $("study-mode").value;
    queue = shuffleArr([...cards]);
    total = queue.length;
    graded = 0;
    show("study-view");
    $("study-title").textContent = title;
    $("shortcuts").textContent = mode === "choice"
      ? "Shortcuts: 1 Again · 2 Got it · Esc finish"
      : "Shortcuts: Space reveal · 1 Again · 2 Got it · Esc finish";
    next();
  }
  function next() {
    current = queue.shift() || null;
    flipped = false;
    answered = false;
    const done = total - queue.length - (current ? 1 : 0);
    $("progress-bar").style.width = (total ? (done / total) * 100 : 100) + "%";
    $("study-progress").textContent = Math.min(done + 1, total) + " / " + total;
    $("study-done").hidden = !!current;
    for (const v of ["flashcard", "type-area", "choice-area", "grade"]) $(v).hidden = true;
    if (!current) {
      if (graded > 0) markStudied();
      return;
    }
    if (mode === "flip") paintFlip();
    else if (mode === "type") paintType();
    else paintChoice();
  }

  // Flip mode
  function paintFlip() {
    $("flashcard").hidden = false;
    $("grade").hidden = false;
    $("flashcard").classList.toggle("flipped", flipped);
    $("card-side").textContent = flipped ? "Answer" : "Question";
    $("card-text").textContent = flipped ? current.back : current.front;
  }
  // Type-the-answer mode
  function paintType() {
    $("type-area").hidden = false;
    $("type-prompt").textContent = current.front;
    $("type-input").value = "";
    $("type-input").disabled = false;
    $("type-feedback").hidden = true;
    $("type-input").focus();
  }
  const normAns = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");
  function checkTyped() {
    if (answered) return;
    answered = true;
    const correct = normAns($("type-input").value) === normAns(current.back) && current.back.trim() !== "";
    $("type-input").disabled = true;
    const fb = $("type-feedback");
    fb.hidden = false;
    fb.className = "type-feedback " + (correct ? "ok" : "bad");
    fb.textContent = (correct ? "Correct — " : "Answer: ") + current.back;
    $("grade").hidden = false;
    $(correct ? "got-it" : "again").focus();
  }
  // Multiple-choice mode
  function paintChoice() {
    $("choice-area").hidden = false;
    $("choice-prompt").textContent = current.front;
    const pool = [...new Set(data.decks.flatMap((d) => d.cards).map((c) => c.back).filter((b) => b && b !== current.back))];
    const distractors = shuffleArr(pool).slice(0, 3);
    const options = shuffleArr([current.back, ...distractors]);
    const list = $("choice-list");
    list.replaceChildren();
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "choice";
      btn.textContent = opt;
      btn.addEventListener("click", () => pickChoice(btn, opt === current.back));
      list.append(btn);
    }
  }
  function pickChoice(btn, correct) {
    if (answered) return;
    answered = true;
    for (const b of $("choice-list").children) {
      b.disabled = true;
      if (b.textContent === current.back) b.classList.add("right");
    }
    if (!correct) btn.classList.add("wrong");
    setTimeout(() => grade(correct), 750);
  }

  function grade(knew) {
    if (!current) return;
    schedule(current, knew);
    graded++;
    save();
    next();
  }

  function shuffleArr(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---- Import / export -------------------------------------------------------
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const safeName = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "deck";
  function cleanDeck(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.cards)) return null;
    return {
      id: id(),
      name: String(raw.name || "Imported deck").slice(0, 60),
      cards: raw.cards
        .filter((c) => c && (c.front || c.back))
        .map((c) => ({ id: id(), front: String(c.front || "").slice(0, 300), back: String(c.back || "").slice(0, 600), box: Number.isInteger(c.box) ? c.box : 0, due: typeof c.due === "number" ? c.due : 0, starred: !!c.starred })),
    };
  }
  function importObject(obj) {
    let decks = [];
    if (Array.isArray(obj)) decks = obj;
    else if (obj && Array.isArray(obj.decks)) decks = obj.decks;
    else if (obj && Array.isArray(obj.cards)) decks = [obj];
    const added = decks.map(cleanDeck).filter(Boolean);
    if (!added.length) throw new Error("No decks found in that file.");
    data.decks.push(...added);
    save();
    showDecks();
    return added.reduce((n, d) => n + d.cards.length, 0);
  }

  // ---- Timer -----------------------------------------------------------------
  const STUDY = 25 * 60, BREAK = 5 * 60;
  let left = STUDY, studying = true, ticking = null;
  const paintTimer = () => {
    $("timer-clock").textContent = String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0");
    $("timer-mode").textContent = studying ? "Study" : "Break";
    $("timer-start").textContent = ticking ? "Pause" : "Start";
  };
  function tick() {
    if (--left > 0) return paintTimer();
    if (studying) { data.sessions.count++; save(); renderAccount(); markStudied(); }
    studying = !studying;
    left = studying ? STUDY : BREAK;
    paintTimer();
  }

  // ---- Wiring ----------------------------------------------------------------
  let authMode = "signin";
  function openAuth(which) {
    authMode = which;
    $("auth-title").textContent = which === "signin" ? "Sign in" : "Create account";
    $("auth-submit").textContent = which === "signin" ? "Sign in" : "Create account";
    $("auth-switch").textContent = which === "signin" ? "No account? Create one" : "Already have an account? Sign in";
    $("auth-pass").autocomplete = which === "signin" ? "current-password" : "new-password";
    $("auth-error").hidden = true;
    $("auth-form").reset();
    $("auth").showModal();
    $("auth-user").focus();
  }
  $("open-signin").addEventListener("click", () => openAuth("signin"));
  $("open-signup").addEventListener("click", () => openAuth("signup"));
  $("auth-switch").addEventListener("click", () => openAuth(authMode === "signin" ? "signup" : "signin"));
  $("auth-cancel").addEventListener("click", () => $("auth").close());
  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("auth-submit");
    submit.disabled = true;
    try {
      if (!window.crypto || !crypto.subtle) throw new Error("Accounts need a secure (https) connection.");
      const error = authMode === "signin"
        ? await signIn($("auth-user").value, $("auth-pass").value)
        : await signUp($("auth-user").value, $("auth-pass").value);
      if (error) {
        $("auth-error").textContent = error;
        $("auth-error").hidden = false;
      } else {
        $("auth").close();
      }
    } catch (e) {
      $("auth-error").textContent = e.message;
      $("auth-error").hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  $("signout").addEventListener("click", () => { user = null; write(CURRENT, null); load(); });

  $("new-deck").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("deck-name").value.trim();
    if (!name) return;
    const d = { id: id(), name, cards: [] };
    data.decks.push(d);
    save();
    $("deck-name").value = "";
    openDeck(d);
  });
  $("new-card").addEventListener("submit", (event) => {
    event.preventDefault();
    deck.cards.push(newCard($("card-front").value.trim(), $("card-back").value.trim()));
    save();
    $("new-card").reset();
    openDeck(deck);
    $("card-front").focus();
  });
  $("bulk-add").addEventListener("click", () => {
    const lines = $("bulk").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let added = 0;
    for (const line of lines) {
      const tab = line.indexOf("\t");
      const at = tab >= 0 ? tab : line.indexOf(",");
      if (at <= 0) continue;
      const front = line.slice(0, at).trim();
      const back = line.slice(at + 1).trim();
      if (front && back) { deck.cards.push(newCard(front, back)); added++; }
    }
    save();
    $("bulk").value = "";
    const out = $("bulk-result");
    out.hidden = false;
    out.textContent = added ? "Added " + added + " card" + (added === 1 ? "" : "s") + "." : "No cards found — use \"term, definition\" per line.";
    openDeck(deck);
  });
  $("back").addEventListener("click", showDecks);
  $("delete-deck").addEventListener("click", () => {
    if (!confirm('Delete the deck "' + deck.name + '" and all its cards?')) return;
    data.decks = data.decks.filter((d) => d !== deck);
    save();
    showDecks();
  });
  $("export-deck").addEventListener("click", () => download("recall-" + safeName(deck.name) + ".json", deck));
  $("export-all").addEventListener("click", () => {
    if (!data.decks.length) return alert("No decks to export yet.");
    download("recall-decks.json", { decks: data.decks });
  });
  $("import-all").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const cards = importObject(JSON.parse(await file.text()));
      alert("Imported " + cards + " card" + (cards === 1 ? "" : "s") + ".");
    } catch (err) {
      alert("Couldn't import that file: " + err.message);
    }
    e.target.value = "";
  });

  $("study").addEventListener("click", () => startStudy(pickCards(), deck.name));
  $("shuffle").addEventListener("click", () => { shuffleArr(deck.cards); save(); renderCards(); });
  $("review-due").addEventListener("click", () => startStudy(allDue(), "Review due cards", "flip"));
  $("stop-study").addEventListener("click", () => (deck ? openDeck(deck) : showDecks()));
  $("flashcard").addEventListener("click", () => { if (mode === "flip") { flipped = !flipped; paintFlip(); } });
  $("type-form").addEventListener("submit", (e) => { e.preventDefault(); if (!answered) checkTyped(); });
  $("again").addEventListener("click", () => grade(false));
  $("got-it").addEventListener("click", () => grade(true));

  // Keyboard shortcuts while studying.
  addEventListener("keydown", (e) => {
    if ($("study-view").hidden) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === "Escape") { e.preventDefault(); return deck ? openDeck(deck) : showDecks(); }
    if (typing) return; // don't hijack the type-answer box
    if (!current) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (mode === "flip") { flipped = !flipped; paintFlip(); }
      else if (mode === "type" && !answered) checkTyped();
    } else if (e.key === "1" && !$("grade").hidden) { e.preventDefault(); grade(false); }
    else if (e.key === "2" && !$("grade").hidden) { e.preventDefault(); grade(true); }
  });

  $("timer-start").addEventListener("click", () => {
    if (ticking) { clearInterval(ticking); ticking = null; }
    else ticking = setInterval(tick, 1000);
    paintTimer();
  });
  $("timer-reset").addEventListener("click", () => {
    clearInterval(ticking);
    ticking = null;
    studying = true;
    left = STUDY;
    paintTimer();
  });

  load();
  paintTimer();
})();
