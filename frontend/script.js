// Switch API base: use VITE/env var if bundled, else auto-detect prod vs local
const API = (typeof __API_URL__ !== "undefined")
  ? __API_URL__
  : (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
    ? "http://127.0.0.1:8000"
    : "https://polyglot-ai-backed.onrender.com";  // ← replace with your Render URL after deploy

// RTL languages — text direction flips automatically
const RTL_LANGS = new Set(["Arabic", "Hebrew", "Urdu"]);

/* ── State ─────────────────────────────────────────────────────── */
let isLive           = false;
let liveTimerInt     = null;
let liveSecs         = 0;
let chunkCounter     = 0;
let waveInt          = null;
let selectedFile     = null;
let fileResults      = { transcript: "", translations: {}, summary: "" };
let options          = { transcript: true, translation: true, summary: false };
let liveTranscriptFull   = "";
let liveTranslationFull  = "";
let liveTranscriptChunks  = [];
let liveTranslationChunks = [];
let currentTheme     = localStorage.getItem("theme") || "dark";
// FIX #11: capture language at session start so mid-session changes don't corrupt slots
let sessionLang      = "Hindi";

/* ── Boot ──────────────────────────────────────────────────────── */
function startApp() {
  applyTheme(currentTheme);
  fetchLanguages();
  const splash = document.getElementById("splash");
  splash.classList.add("hide");
  setTimeout(() => {
    splash.style.display = "none";
    if (!authToken) showAuthOverlay();
    else launchApp();
  }, 550);
}

let _healthInterval = null;
let _appLaunched = false;  // true once the app is fully visible — never switch tabs again after this

function launchApp(defaultTab) {
  const appEl = document.getElementById("app");

  document.getElementById("authOverlay").style.display = "none";
  appEl.style.display = "flex";
  updateUserWidget();
  loadSessionHistory();
  checkHealth();
  if (!_healthInterval) _healthInterval = setInterval(checkHealth, 10000);
  registerKeyboardShortcuts();
  updateHistoryNudge();

  // Only switch tabs on the very first launch — NEVER after that
  if (!_appLaunched) {
    _appLaunched = true;
    switchTab(defaultTab || "live");
  }
}

async function checkHealth() {
  const dot = document.getElementById("statusDot");
  const txt = document.getElementById("statusText");
  try {
    const r = await fetch(`${API}/health`);
    if (r.ok) { dot.className = "status-dot online"; txt.textContent = "Groq API · Online"; }
    else       { dot.className = "status-dot offline"; txt.textContent = "API Error"; }
  } catch {
    dot.className = "status-dot offline"; txt.textContent = "Backend Offline";
  }
}

/* ── Languages from backend ────────────────────────────────────── */
async function fetchLanguages() {
  try {
    const r    = await fetch(`${API}/languages`);
    const data = await r.json();
    populateLangSelects(data.languages);
  } catch {
    // fallback: keep hardcoded options already in HTML
  }
}

function populateLangSelects(langs) {
  const indian   = ["Hindi","Telugu","Tamil","Kannada","Malayalam","Bengali","Marathi","Gujarati","Punjabi","Urdu"];
  const european = ["Spanish","French","German","Italian","Portuguese","Dutch","Russian","Polish","Swedish","Greek"];
  const asian    = ["Japanese","Korean","Chinese (Simplified)","Thai","Vietnamese","Indonesian"];
  const other    = ["Arabic","Hebrew","Turkish","Swahili"];

  const groups = [
    { label: "Indian Languages", items: indian },
    { label: "European",         items: european },
    { label: "Asian",            items: asian },
    { label: "Middle East & Africa", items: other },
  ];

  ["liveLang","fileLang"].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = "";
    groups.forEach(g => {
      const og = document.createElement("optgroup");
      og.label = g.label;
      g.items.filter(l => langs.includes(l)).forEach(l => {
        const opt = document.createElement("option");
        opt.value = l; opt.textContent = l;
        og.appendChild(opt);
      });
      if (og.children.length) sel.appendChild(og);
    });
    sel.value = current;
  });
}

/* ── Theme ─────────────────────────────────────────────────────── */
function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", currentTheme);
  applyTheme(currentTheme);
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeBtn");
  if (btn) btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

/* ── RTL support ───────────────────────────────────────────────── */
// FIX #1: apply RTL to all translation output elements, including dynamic file cards
function applyRTL(lang) {
  const isRTL = RTL_LANGS.has(lang);
  const dir   = isRTL ? "rtl" : "ltr";

  // Live translation panel
  const liveEl = document.getElementById("liveTranslationContent");
  if (liveEl) { liveEl.dir = dir; liveEl.style.textAlign = isRTL ? "right" : "left"; }

  // All dynamic file translation card bodies
  document.querySelectorAll('[id^="res-trans-"]').forEach(el => {
    el.dir = dir; el.style.textAlign = isRTL ? "right" : "left";
  });
}

function onLiveLangChange() {
  const lang = document.getElementById("liveLang").value;
  applyRTL(lang);
}
function onFileLangChange() {
  const lang = document.getElementById("fileLang").value;
  applyRTL(lang);
}

/* ── Tab switching ─────────────────────────────────────────────── */
function switchTab(name) {
  console.log("[switchTab]", name, new Error().stack);
  document.querySelectorAll(".nav-item").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById("nav-" + name).classList.add("active");
  document.getElementById("page-" + name).classList.add("active");
}

/* ── Keyboard shortcuts ────────────────────────────────────────── */
let _shortcutsRegistered = false;
function registerKeyboardShortcuts() {
  if (_shortcutsRegistered) return;
  _shortcutsRegistered = true;
  document.addEventListener("keydown", e => {
    // Auth modal Enter key
    const overlay = document.getElementById("authOverlay");
    if (overlay && overlay.style.display !== "none") {
      if (e.key === "Enter") {
        const loginForm = document.getElementById("formLogin");
        if (loginForm && loginForm.style.display !== "none") doLogin();
        else doRegister();
      }
      return;
    }
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    if (e.code === "Space" && document.getElementById("page-live").classList.contains("active")) {
      e.preventDefault();
      toggleLive();
    }
    if (e.code === "Escape") {
      if (document.getElementById("page-live").classList.contains("active")) clearLive();
      else clearFileResults();
    }
    if (e.ctrlKey && e.key === "c" && document.getElementById("page-live").classList.contains("active")) {
      const el = document.getElementById("liveTranscriptContent");
      if (el && el.textContent) {
        e.preventDefault();
        navigator.clipboard.writeText(el.textContent).then(() => toast("Transcript copied!", "success"));
      }
    }
    if (e.ctrlKey && e.key === "1") { e.preventDefault(); switchTab("live"); }
    if (e.ctrlKey && e.key === "2") { e.preventDefault(); switchTab("file"); }
  });

  document.getElementById("shortcutHint").textContent = "Space=mic  Esc=clear  Ctrl+C=copy";
}

/* ════════════════════════════════════════════════════════════════
   LIVE RECORDING — Web Speech API
   Replaces the old MediaRecorder/Whisper chunk approach.
   Browser handles real-time STT natively; we only call the backend
   for translation (streaming SSE), keeping all existing UI intact.
   ════════════════════════════════════════════════════════════════ */

let recognition      = null;   // SpeechRecognition instance
let speechSupported  = ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);



function toggleLive() {
  if (isLive) stopLive();
  else startLive();
}

function startLive() {
  if (!speechSupported) {
    toast("Web Speech API not supported — use Chrome or Edge", "error");
    return;
  }

  isLive = true;
  liveTranscriptFull    = "";
  liveTranslationFull   = "";
  liveTranscriptChunks  = [];
  liveTranslationChunks = [];
  chunkCounter          = 0;
  sessionLang = document.getElementById("liveLang").value;

  document.getElementById("chunkLogItems").innerHTML = "";
  setLiveText("transcript", "");
  setLiveText("translation", "");
  document.getElementById("detectedLang").textContent = "Listening…";

  document.getElementById("micBtn").classList.add("active");
  document.getElementById("micRingOuter").classList.add("pulse");
  document.getElementById("micLabel").textContent = "Recording — Space or tap to stop";
  document.getElementById("liveBadge").textContent = "LIVE";
  document.getElementById("liveBadge").style.display = "inline-flex";
  document.getElementById("recBadge").textContent = "Live";
  document.getElementById("recBadge").className = "rec-badge live";

  liveSecs = 0;
  document.getElementById("micTimer").style.display = "block";
  liveTimerInt = setInterval(() => {
    liveSecs++;
    const m = String(Math.floor(liveSecs / 60)).padStart(2, "0");
    const s = String(liveSecs % 60).padStart(2, "0");
    document.getElementById("micTimer").textContent = `${m}:${s}`;
  }, 1000);

  startWave();
  _startRecognition();
}

function _startRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();

  // continuous = keep listening across pauses; interim = show live text
  recognition.continuous      = true;
  recognition.interimResults  = true;
  recognition.maxAlternatives = 1;

  // Use the target language as the speech input language for Indian languages;
  // fall back to English for European/other targets
  recognition.lang = "en-US";  // Web Speech API — Chrome only reliably supports English

  // Show interim (in-progress) results as greyed hint
  let interimEl = null;

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        const text = result[0].transcript.trim();
        if (!text) continue;

        chunkCounter++;
        const num       = chunkCounter;
        // Always read the CURRENT dropdown value — not the snapshotted sessionLang
        const lang      = document.getElementById("liveLang").value;
        const slotIndex = liveTranscriptChunks.length;

        liveTranscriptChunks.push(text);
        liveTranslationChunks.push("");
        liveTranscriptFull = liveTranscriptChunks.join("\n");
        setLiveText("transcript", liveTranscriptFull);
        addChunkLogEntry(num, text, "", slotIndex);

        // Translate the finalised sentence via existing SSE stream
        streamTranslation(text, lang, num, slotIndex);

        // Remove interim display
        if (interimEl) { interimEl.remove(); interimEl = null; }

      } else {
        interim += result[0].transcript;
      }
    }

    // Show interim text as a greyed-out preview below the transcript
    if (interim) {
      if (!interimEl) {
        interimEl = document.createElement("div");
        interimEl.style.cssText = "color:var(--text3);font-style:italic;margin-top:4px;font-size:0.9em;";
        const txEl = document.getElementById("liveTranscriptContent");
        if (txEl) txEl.parentNode.appendChild(interimEl);
      }
      interimEl.textContent = interim + "…";
    } else if (interimEl) {
      interimEl.remove(); interimEl = null;
    }
  };

  recognition.onerror = (e) => {
    // "no-speech" is normal silence — just restart quietly
    if (e.error === "no-speech") {
      if (isLive && recognition) _restartRecognition();
      return;
    }
    if (e.error === "not-allowed") {
      toast("Microphone access denied", "error");
      stopLive();
      return;
    }
    console.warn("SpeechRecognition error:", e.error);
    if (isLive && recognition) _restartRecognition();
  };

  recognition.onend = () => {
    // Only restart if still live AND recognition wasn't nulled by stopLive()
    if (isLive && recognition) _restartRecognition();
  };

  try {
    recognition.start();
    document.getElementById("detectedLang").textContent = `Translating to: ${sessionLang}`;
  } catch (e) {
    console.warn("Recognition start failed:", e);
    toast("Could not start microphone", "error");
    stopLive();
  }
}

function _restartRecognition() {
  setTimeout(() => {
    if (!isLive || !recognition) return;
    try { recognition.start(); } catch {}
  }, 300);
}

function stopLive() {
  // Null out recognition FIRST so any pending onend/onerror callbacks bail immediately
  const rec = recognition;
  recognition = null;
  isLive = false;
  if (rec) {
    try { rec.stop(); } catch {}
  }
  clearInterval(liveTimerInt);
  stopWave();

  document.getElementById("micBtn").classList.remove("active");
  document.getElementById("micRingOuter").classList.remove("pulse");
  document.getElementById("micLabel").textContent = "Tap or press Space to start";
  document.getElementById("micTimer").style.display = "none";
  document.getElementById("liveBadge").style.display = "none";
  document.getElementById("recBadge").textContent = "Idle";
  document.getElementById("recBadge").className = "rec-badge";
  document.getElementById("chunkStatus").style.display = "none";
  document.getElementById("detectedLang").textContent = "";

  // Save history completely detached — no await, no side effects on UI
  if (liveTranscriptFull) setTimeout(() => saveSessionHistory(), 0);
}

/* ── SSE Streaming Translation ─────────────────────────────────── */
async function streamTranslation(text, lang, chunkNum, slotIndex) {
  try {
    const res = await fetch(`${API}/translate/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target_language: lang })
    });

    if (!res.ok || !res.body) return;

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer           = "";
    let chunkTranslation = "";

    let timeoutId;
    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => reader.cancel(), 15000);
    };
    resetTimeout();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetTimeout();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();

          if (raw === "[DONE]") {
            liveTranslationChunks[slotIndex] = chunkTranslation;
            liveTranslationFull = liveTranslationChunks.filter(Boolean).join("\n");
            setLiveText("translation", liveTranslationFull);
            applyRTL(lang);
            // FIX #4: update the chunk log entry with the completed translation
            updateChunkLogTranslation(slotIndex, chunkTranslation);
            clearTimeout(timeoutId);
            return;
          }

          try {
            const parsed = JSON.parse(raw);
            if (parsed.token) {
              chunkTranslation += parsed.token;
              liveTranslationChunks[slotIndex] = chunkTranslation;
              liveTranslationFull = liveTranslationChunks.filter(Boolean).join("\n");
              setLiveText("translation", liveTranslationFull);
              applyRTL(lang);
            }
          } catch {}
        }
      }
    } finally {
      clearTimeout(timeoutId);
    }

  } catch (e) {
    console.warn(`streamTranslation chunk #${chunkNum} error:`, e);
  }
}

/* ── Live text display ─────────────────────────────────────────── */
function setLiveText(type, text) {
  const ids = {
    transcript:  ["liveTranscriptPh",  "liveTranscriptContent"],
    translation: ["liveTranslationPh", "liveTranslationContent"]
  };
  const [phId, txId] = ids[type];
  const ph = document.getElementById(phId);
  const tx = document.getElementById(txId);
  if (!ph || !tx) return;
  if (text) {
    ph.style.display = "none";
    tx.classList.add("visible");
    tx.textContent = text;
    tx.scrollTop = tx.scrollHeight;
  } else {
    ph.style.display = "block";
    tx.classList.remove("visible");
    tx.textContent = "";
  }
}

// FIX #4: chunk log entries store their slotIndex as a data attribute so
// updateChunkLogTranslation can find and patch them
function addChunkLogEntry(num, transcript, translation, slotIndex) {
  const log   = document.getElementById("chunkLogItems");
  const entry = document.createElement("div");
  entry.className = "chunk-entry";
  if (slotIndex >= 0) entry.dataset.slot = slotIndex;
  entry.innerHTML = `
    <div class="chunk-num">#${num}</div>
    <div style="flex:1;min-width:0">
      <div class="chunk-entry-text">${escapeHtml(transcript)}</div>
      <div class="chunk-entry-trans" data-trans></div>
    </div>`;
  log.prepend(entry);
}

function updateChunkLogTranslation(slotIndex, translation) {
  const entry = document.querySelector(`.chunk-entry[data-slot="${slotIndex}"]`);
  if (!entry) return;
  const transEl = entry.querySelector("[data-trans]");
  if (transEl) transEl.textContent = translation;
}

function showLiveProgress(on) {
  document.getElementById("liveProgress").style.display = on ? "block" : "none";
}

function clearLive() {
  liveTranscriptFull    = "";
  liveTranslationFull   = "";
  liveTranscriptChunks  = [];
  liveTranslationChunks = [];
  setLiveText("transcript",  "");
  setLiveText("translation", "");
  document.getElementById("chunkLogItems").innerHTML = "";
  document.getElementById("detectedLang").textContent = "";
  chunkCounter = 0;
}

function copyText(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent || el.innerText)
    .then(() => toast("Copied!", "success")).catch(() => {});
}

/* ── Waveform ──────────────────────────────────────────────────── */
function startWave() {
  document.querySelector(".waveform").classList.add("active");
  waveInt = setInterval(() => {
    document.querySelectorAll(".waveform span").forEach(b => {
      b.style.height = (Math.random() * 22 + 4) + "px";
    });
  }, 110);
}
function stopWave() {
  clearInterval(waveInt);
  document.querySelector(".waveform").classList.remove("active");
  document.querySelectorAll(".waveform span").forEach(b => { b.style.height = "8px"; });
}

/* ── Auth state ─────────────────────────────────────────────────── */
let authToken   = localStorage.getItem("polyglot_token") || "";
let currentUser = JSON.parse(localStorage.getItem("polyglot_user") || "null");

function authHeaders() {
  return authToken ? { "Authorization": `Bearer ${authToken}` } : {};
}

/* ════════════════════════════════════════════════════════════════
   AUTH UI
   ════════════════════════════════════════════════════════════════ */

function showAuthOverlay() {
  document.getElementById("authOverlay").style.display = "flex";
}

function showAuthTab(tab) {
  document.getElementById("formLogin").style.display    = tab === "login"    ? "flex" : "none";
  document.getElementById("formRegister").style.display = tab === "register" ? "flex" : "none";
  document.getElementById("tabLogin").classList.toggle("active",    tab === "login");
  document.getElementById("tabRegister").classList.toggle("active", tab === "register");
  clearAuthErrors();
}

function clearAuthErrors() {
  ["loginError", "registerError"].forEach(id => {
    const el = document.getElementById(id);
    el.style.display = "none"; el.textContent = ""; el.classList.remove("visible");
  });
}

function showAuthError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg; el.style.display = "block"; el.classList.add("visible");
}

function setAuthLoading(form, loading) {
  const btnText = document.getElementById(form + "BtnText");
  const spinner = document.getElementById(form + "Spinner");
  const btn     = document.getElementById(form + "Btn");
  if (loading) { btnText.style.display="none"; spinner.style.display="block"; btn.disabled=true; }
  else         { btnText.style.display="block"; spinner.style.display="none"; btn.disabled=false; }
}

async function doLogin() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  if (!username || !password) { showAuthError("loginError", "Please fill in all fields"); return; }
  setAuthLoading("login", true);
  try {
    const res  = await fetch(`${API}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { showAuthError("loginError", data.detail || "Login failed"); return; }
    persistAuth(data);
    launchApp();
    toast(`Welcome back, ${data.display_name || data.username}!`, "success");
  } catch { showAuthError("loginError", "Could not reach server"); }
  finally   { setAuthLoading("login", false); }
}

async function doRegister() {
  const display_name = document.getElementById("regDisplayName").value.trim();
  const username     = document.getElementById("regUsername").value.trim();
  const password     = document.getElementById("regPassword").value;
  if (!username || !password) { showAuthError("registerError", "Username and password required"); return; }
  setAuthLoading("register", true);
  try {
    const res  = await fetch(`${API}/auth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, display_name })
    });
    const data = await res.json();
    if (!res.ok) { showAuthError("registerError", data.detail || "Registration failed"); return; }
    persistAuth(data);
    launchApp();
    toast(`Account created! Welcome, ${data.display_name || data.username}!`, "success");
  } catch { showAuthError("registerError", "Could not reach server"); }
  finally   { setAuthLoading("register", false); }
}

function skipAuth() { authToken = ""; currentUser = null; launchApp(); }

function doLogout() {
  authToken = ""; currentUser = null;
  _appLaunched = false;  // reset so next login lands on correct tab
  localStorage.removeItem("polyglot_token");
  localStorage.removeItem("polyglot_user");
  updateUserWidget(); updateHistoryNudge(); renderHistory();
  toast("Signed out", "");
}

function persistAuth(data) {
  authToken   = data.token;
  currentUser = { username: data.username, display_name: data.display_name, user_id: data.user_id };
  localStorage.setItem("polyglot_token", authToken);
  localStorage.setItem("polyglot_user", JSON.stringify(currentUser));
}

function updateUserWidget() {
  const widget = document.getElementById("userWidget");
  if (!widget) return;
  if (currentUser && authToken) {
    widget.style.display = "flex";
    document.getElementById("userDisplayName").textContent = currentUser.display_name || currentUser.username;
    document.getElementById("userAvatar").textContent = (currentUser.display_name || currentUser.username || "U")[0].toUpperCase();
  } else {
    widget.style.display = "none";
  }
}

function updateHistoryNudge() {
  const nudge = document.getElementById("historyLoginNudge");
  if (nudge) nudge.style.display = (currentUser && authToken) ? "none" : "flex";
}

/* ════════════════════════════════════════════════════════════════
   SESSION HISTORY — API-backed (localStorage fallback for guests)
   ════════════════════════════════════════════════════════════════ */

async function _pushHistory(entry) {
  if (authToken && currentUser) {
    try {
      await fetch(`${API}/user/history`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(entry)
      });
    } catch {}
  } else {
    const history = JSON.parse(localStorage.getItem("polyglot_history") || "[]");
    history.unshift(entry);
    if (history.length > 20) history.splice(20);
    localStorage.setItem("polyglot_history", JSON.stringify(history));
  }
  // Update history panel in background — don't block caller
  setTimeout(() => renderHistory(), 0);
}

// Called when live session ends
async function saveSessionHistory() {
  if (!liveTranscriptFull) return;
  await _pushHistory({
    date:        new Date().toLocaleString(),
    lang:        sessionLang,
    transcript:  liveTranscriptFull,
    translation: liveTranslationFull,
    duration:    liveSecs,
    source:      "live",
    filename:    ""
  });
}

// Called after file processing completes
async function saveFileHistory(filename, lang, transcript, translation) {
  if (!transcript) return;
  await _pushHistory({
    date:        new Date().toLocaleString(),
    lang:        lang,
    transcript:  transcript,
    translation: translation,
    duration:    0,
    source:      "file",
    filename:    filename
  });
}

function loadSessionHistory() { renderHistory(); }

async function renderHistory() {
  const list = document.getElementById("historyList");
  if (!list) return;
  updateHistoryNudge();

  let history = [];
  if (authToken && currentUser) {
    try {
      const res  = await fetch(`${API}/user/history`, { headers: authHeaders() });
      if (res.status === 401) { history = []; }  // token expired — don't redirect, just show empty
      else { const data = await res.json(); history = data.history || []; }
    } catch { history = []; }
  } else {
    history = JSON.parse(localStorage.getItem("polyglot_history") || "[]");
  }

  if (history.length === 0) {
    list.innerHTML = `<div class="history-empty">No sessions yet</div>`;
    return;
  }

  list.innerHTML = "";
  history.forEach((s) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `
      <div class="history-meta">
        <span class="history-lang">${escapeHtml(s.lang)}</span>
        <span class="history-date">${escapeHtml(s.date)}</span>
        ${s.duration ? `<span class="history-dur">${Math.floor(s.duration/60)}m ${s.duration%60}s</span>` : ""}
        ${s.source === "file"
          ? `<span class="history-lang" style="background:rgba(29,158,117,0.12);color:var(--green2)">file</span>`
          : `<span class="history-lang" style="background:rgba(226,75,74,0.1);color:var(--red)">live</span>`}
      </div>
      ${s.filename ? `<div class="history-preview" style="color:var(--text3);font-size:11px">📁 ${escapeHtml(s.filename)}</div>` : ""}
      <div class="history-preview">${escapeHtml((s.transcript||"").slice(0, 80))}${(s.transcript||"").length > 80 ? "…" : ""}</div>`;
    div.addEventListener("click", () => loadHistoryEntry(s));
    list.appendChild(div);
  });
}

function loadHistoryEntry(s) {
  if (s.source === "file") {
    // Load file result back into the file tab — don't switch away
    switchTab("file");
    fileResults = { transcript: s.transcript || "", translations: {}, summary: "" };
    if (s.lang && s.translation) fileResults.translations[s.lang] = s.translation;
    hideAllCards();
    document.getElementById("translations-container").innerHTML = "";
    document.getElementById("dropMain").textContent = s.filename ? `✓ ${s.filename}` : "Previous result";
    document.getElementById("fileBadge").textContent = "Done";
    document.getElementById("fileDetectedLang").textContent = "";
    document.getElementById("resultsEmpty").style.display = "none";
    document.getElementById("downloadGroup").style.display = "flex";
    if (fileResults.transcript) showCard("transcript", fileResults.transcript);
    Object.entries(fileResults.translations).forEach(([lang, text]) => {
      if (!text) return;
      const cardId = `card-trans-${lang.replace(/\s|\(|\)/g, "_")}`;
      const bodyId = `res-trans-${lang.replace(/\s|\(|\)/g, "_")}`;
      addTranslationCard(lang, cardId, bodyId);
      const el = document.getElementById(bodyId);
      if (el) el.textContent = text;
    });
  } else {
    switchTab("live");
    liveTranscriptFull    = s.transcript  || "";
    liveTranslationFull   = s.translation || "";
    liveTranscriptChunks  = liveTranscriptFull  ? liveTranscriptFull.split("\n")  : [];
    liveTranslationChunks = liveTranslationFull ? liveTranslationFull.split("\n") : [];
    chunkCounter = liveTranscriptChunks.length;
    setLiveText("transcript",  liveTranscriptFull);
    setLiveText("translation", liveTranslationFull);
  }
  toast(`Loaded session from ${s.date}`, "success");
}

async function clearHistory() {
  if (authToken && currentUser) {
    try { await fetch(`${API}/user/history`, { method: "DELETE", headers: authHeaders() }); } catch {}
  } else {
    localStorage.removeItem("polyglot_history");
  }
  renderHistory();
  toast("History cleared", "success");
}

/* ── PDF Export (live tab) ─────────────────────────────────────── */
// FIX #15: wire up live tab PDF/TXT export
function downloadLiveTxt() {
  if (!liveTranscriptFull) { toast("Nothing to download", "error"); return; }
  let out = "";
  if (liveTranscriptFull)  out += `TRANSCRIPT:\n${liveTranscriptFull}\n\n`;
  if (liveTranslationFull) out += `TRANSLATION (${sessionLang}):\n${liveTranslationFull}\n`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.trim()], { type: "text/plain" }));
  a.download = `polyglot_live_${Date.now()}.txt`;
  a.click();
  toast("Downloaded TXT", "success");
}

function downloadLivePDF() {
  if (!liveTranscriptFull) { toast("Nothing to download", "error"); return; }
  downloadPDF({
    transcript:   liveTranscriptFull,
    translations: { [sessionLang]: liveTranslationFull },
    summary:      ""
  });
}

/* ── PDF Export (using jsPDF) ──────────────────────────────────── */
async function downloadPDF(results) {
  if (!window.jsPDF) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const margin  = 20;
  const pageW   = doc.internal.pageSize.getWidth();
  const maxW    = pageW - margin * 2;
  let y = margin;

  doc.setFillColor(127, 119, 221);
  doc.rect(0, 0, pageW, 14, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11); doc.setFont("helvetica", "bold");
  doc.text("PolyglotAI — Speech Translation Report", margin, 9);
  doc.setTextColor(200, 200, 255);
  doc.setFontSize(8); doc.setFont("helvetica", "normal");
  doc.text(new Date().toLocaleString(), pageW - margin, 9, { align: "right" });

  y = 24;
  doc.setTextColor(30, 30, 30);

  function addSection(title, body, color) {
    if (!body) return;
    doc.setFontSize(10); doc.setFont("helvetica", "bold");
    doc.setTextColor(...color);
    doc.text(title, margin, y); y += 5;
    doc.setDrawColor(...color); doc.setLineWidth(0.3);
    doc.line(margin, y, pageW - margin, y); y += 4;

    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    doc.setTextColor(50, 50, 50);
    const lines = doc.splitTextToSize(body, maxW);
    lines.forEach(line => {
      if (y > 270) { doc.addPage(); y = margin; }
      doc.text(line, margin, y); y += 5;
    });
    y += 6;
  }

  addSection("Transcript", results.transcript, [127, 119, 221]);
  Object.entries(results.translations || {}).forEach(([lang, text]) => {
    addSection(`Translation (${lang})`, text, [29, 158, 117]);
  });
  addSection("AI Summary", results.summary, [239, 159, 39]);

  doc.setFontSize(7); doc.setTextColor(150, 150, 150);
  doc.text("Generated by PolyglotAI · Powered by Groq + Whisper + LLaMA", margin, 287);

  doc.save(`polyglot_${Date.now()}.pdf`);
  toast("PDF downloaded!", "success");
}

/* ════════════════════════════════════════════════════════════════
   FILE UPLOAD
   ════════════════════════════════════════════════════════════════ */

function onDropZoneClick(e) {
  // Don't reopen the file picker if the click came from the input itself
  if (e.target === document.getElementById("fileInput")) return;
  // Don't reopen while actively processing
  const btn = document.getElementById("processBtn");
  if (btn && btn.disabled) return;
  document.getElementById("fileInput").click();
}

function onFileSelect(e) {
  const f = e.target.files[0];
  if (f) setSelectedFile(f);
  // Reset so selecting the same file again still triggers onchange
  e.target.value = "";
}
function onDragOver(e) {
  e.preventDefault();
  document.getElementById("dropZone").classList.add("drag-over");
}
function onDragLeave() {
  document.getElementById("dropZone").classList.remove("drag-over");
}
function onDrop(e) {
  e.preventDefault();
  document.getElementById("dropZone").classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f) setSelectedFile(f);
}
// allFileResults stores results per filename so switching files never loses data
const allFileResults = {};

function setSelectedFile(f) {
  selectedFile = f;
  document.getElementById("dropMain").textContent = `✓ ${f.name}`;
  document.getElementById("dropZone").classList.add("has-file");

  // Restore saved results for this file, or start fresh
  if (!allFileResults[f.name]) {
    allFileResults[f.name] = { transcript: "", translations: {}, summary: "" };
  }
  fileResults = allFileResults[f.name];

  // Rebuild the UI from whatever we already have for this file
  hideAllCards();
  document.getElementById("translations-container").innerHTML = "";
  document.getElementById("fileBadge").textContent = "Idle";
  document.getElementById("fileDetectedLang").textContent = "";

  if (fileResults.transcript) {
    showCard("transcript", fileResults.transcript);
    document.getElementById("resultsEmpty").style.display = "none";
    document.getElementById("downloadGroup").style.display = "flex";
    document.getElementById("fileBadge").textContent = "Done";
  } else {
    document.getElementById("resultsEmpty").style.display = "flex";
    document.getElementById("downloadGroup").style.display = "none";
  }

  Object.entries(fileResults.translations).forEach(([lang, text]) => {
    if (!text) return;
    const cardId = `card-trans-${lang.replace(/\s|\(|\)/g, "_")}`;
    const bodyId = `res-trans-${lang.replace(/\s|\(|\)/g, "_")}`;
    addTranslationCard(lang, cardId, bodyId);
    const el = document.getElementById(bodyId);
    if (el) el.textContent = text;
  });

  if (fileResults.summary) showCard("summary", fileResults.summary);
}

function toggleOption(key) {
  options[key] = !options[key];
  document.getElementById("tog-" + key).classList.toggle("on", options[key]);
}

async function processFile() {
  if (!selectedFile) { toast("Please upload a file first", "error"); return; }

  const btn  = document.getElementById("processBtn");
  const prog = document.getElementById("fileProgress");
  const pmsg = document.getElementById("fileProgressMsg");
  btn.disabled = true;
  prog.style.display = "block";
  pmsg.style.display = "block";
  document.getElementById("resultsEmpty").style.display = "none";
  document.getElementById("fileBadge").textContent = "Processing…";

  const lang = document.getElementById("fileLang").value;
  const needsTranscript = !fileResults.transcript;

  try {
    if (needsTranscript) {
      pmsg.textContent = "Transcribing with Whisper…";
      const fd = new FormData();
      fd.append("file", selectedFile);
      const tr = await fetch(`${API}/transcribe`, { method: "POST", body: fd });
      if (!tr.ok) throw new Error("Transcription failed");
      const trData = await tr.json();
      fileResults.transcript = trData.transcript;
      if (trData.detected_language) {
        document.getElementById("fileDetectedLang").textContent = `Detected: ${trData.detected_language.toUpperCase()}`;
      }
    }

    const transcript = fileResults.transcript;
    if (options.transcript) showCard("transcript", transcript);

    if (options.translation) {
      if (fileResults.translations[lang]) {
        toast(`${lang} translation already done ✓`, "success");
      } else {
        applyRTL(lang);
        pmsg.textContent = `Translating to ${lang}…`;
        const cardId = `card-trans-${lang.replace(/\s|\(|\)/g, "_")}`;
        const bodyId = `res-trans-${lang.replace(/\s|\(|\)/g, "_")}`;
        addTranslationCard(lang, cardId, bodyId);
        const translated = await streamFileTranslation(transcript, lang, bodyId);
        fileResults.translations[lang] = translated;
        const el = document.getElementById(bodyId);
        if (el) el.textContent = translated;
      }
    }

    if (options.summary) {
      if (!fileResults.summary) {
        pmsg.textContent = "Summarizing with LLaMA 3.3…";
        const sr = await fetch(`${API}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: transcript })
        });
        if (!sr.ok) throw new Error("Summarization failed");
        const { summary } = await sr.json();
        fileResults.summary = summary;
      }
      showCard("summary", fileResults.summary);
    }

    document.getElementById("downloadGroup").style.display = "flex";
    document.getElementById("fileBadge").textContent = "Done";
    toast("Done! ✓", "success");

    // Save to history (file upload)
    saveFileHistory(selectedFile.name, lang, fileResults.transcript, fileResults.translations[lang] || "");

  } catch (err) {
    document.getElementById("resultsEmpty").textContent = "Error: " + err.message;
    document.getElementById("resultsEmpty").style.display = "flex";
    document.getElementById("fileBadge").textContent = "Error";
    toast(err.message, "error");
  } finally {
    prog.style.display = "none";
    pmsg.style.display = "none";
    btn.disabled = false;
  }
}

function addTranslationCard(lang, cardId, bodyId) {
  if (document.getElementById(cardId)) return;
  const container = document.getElementById("translations-container");
  const copyIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>`;
  const card = document.createElement("div");
  card.className = "result-card";
  card.id = cardId;
  card.innerHTML = `
    <div class="result-card-head">
      <span>Translation — ${escapeHtml(lang)}</span>
      <button class="icon-action" onclick="copyText('${bodyId}')" title="Copy">${copyIcon}</button>
    </div>
    <div class="result-card-body" id="${bodyId}"></div>`;
  container.appendChild(card);
}

async function streamFileTranslation(text, lang, bodyId) {
  return new Promise(async (resolve) => {
    try {
      const res = await fetch(`${API}/translate/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, target_language: lang })
      });
      if (!res.ok) { resolve(""); return; }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full   = "";

      const el = document.getElementById(bodyId);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") { resolve(full); return; }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.token) {
              full += parsed.token;
              if (el) el.textContent = full;
            }
          } catch {}
        }
      }
      resolve(full);
    } catch {
      resolve("");
    }
  });
}

function showCard(type, text) {
  document.getElementById("card-" + type).style.display = "block";
  document.getElementById("res-" + type).textContent = text;
}

function hideAllCards() {
  ["transcript", "summary"].forEach(t => {
    document.getElementById("card-" + t).style.display = "none";
    document.getElementById("res-" + t).textContent = "";
  });
}

function clearFileResults() {
  hideAllCards();
  fileResults = { transcript: "", translations: {}, summary: "" };
  document.getElementById("translations-container").innerHTML = "";
  document.getElementById("resultsEmpty").textContent = "Upload a file and click Process";
  document.getElementById("resultsEmpty").style.display = "flex";
  document.getElementById("downloadGroup").style.display = "none";
  document.getElementById("fileBadge").textContent = "Idle";
  document.getElementById("fileDetectedLang").textContent = "";
}

/* ── Downloads ─────────────────────────────────────────────────── */
function downloadTxt() {
  if (!fileResults.transcript && !Object.keys(fileResults.translations).length) return;
  let out = "";
  if (fileResults.transcript) out += `TRANSCRIPT:\n${fileResults.transcript}\n\n`;
  Object.entries(fileResults.translations).forEach(([lang, text]) => {
    if (text) out += `TRANSLATION (${lang}):\n${text}\n\n`;
  });
  if (fileResults.summary) out += `SUMMARY:\n${fileResults.summary}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.trim()], { type: "text/plain" }));
  a.download = `polyglot_${Date.now()}.txt`;
  a.click();
  toast("Downloaded TXT", "success");
}

function downloadPDFFile() {
  if (!fileResults.transcript && !Object.keys(fileResults.translations).length) return;
  downloadPDF(fileResults);
}

/* ── Toast ─────────────────────────────────────────────────────── */
let toastTimeout = null;
function toast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (type ? " " + type : "");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { el.className = "toast"; }, 3200);
}


/* ── Splash floating words ─────────────────────── */
(function initSplashFloats() {
  const words = [
    "नमस्ते","こんにちは","안녕하세요","مرحبا","Bonjour","Hola","Ciao","Привет",
    "你好","Hallo","مرحبا","สวัสดี","Xin chào","Olá","Merhaba","שלום",
    "నమస్కారం","வணக்கம்","ನಮಸ್ಕಾರ","നമസ്കാരം"
  ];
  const container = document.getElementById("langFloats");
  if (!container) return;
  function spawnWord() {
    const el = document.createElement("div");
    el.className = "lf-word";
    el.textContent = words[Math.floor(Math.random() * words.length)];
    el.style.left = (10 + Math.random() * 80) + "%";
    el.style.top  = (20 + Math.random() * 60) + "%";
    el.style.animationDuration = (5 + Math.random() * 4) + "s";
    el.style.animationDelay   = (Math.random() * 2) + "s";
    container.appendChild(el);
    setTimeout(() => el.remove(), 10000);
  }
  for (let i = 0; i < 6; i++) setTimeout(spawnWord, i * 600);
  setInterval(spawnWord, 1800);
})();
function getSupportedMime() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror  = reject;
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}