// API base URL — auto-detects local vs production
const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://127.0.0.1:8000"
  : "https://polyglot-ai-backed.onrender.com";

const RTL_LANGS = new Set(["Arabic", "Hebrew", "Urdu"]);

/* ── State ─────────────────────────────────────────────────────── */
let isLive            = false;
let liveTimerInt      = null;
let liveSecs          = 0;
let chunkCounter      = 0;
let waveInt           = null;
let options           = { transcript: true, translation: true, summary: false, sentiment: false };
let liveTranscriptFull    = "";
let liveTranslationFull   = "";
let liveTranscriptChunks  = [];
let liveTranslationChunks = [];
let currentTheme      = localStorage.getItem("theme") || "dark";
let sessionLang       = "Hindi";
let recognition       = null;
let speechSupported   = ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
let _healthInterval   = null;
let _appLaunched      = false;
let authToken         = localStorage.getItem("polyglot_token") || "";
let currentUser       = JSON.parse(localStorage.getItem("polyglot_user") || "null");

/* ════════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════════ */
function startApp() {
  applyTheme(currentTheme);
  const splash = document.getElementById("splash");
  splash.classList.add("hide");
  setTimeout(() => {
    splash.style.display = "none";
    if (!authToken) showAuthOverlay();
    else launchApp();
  }, 550);
}

function launchApp(defaultTab) {
  document.getElementById("authOverlay").style.display = "none";
  document.getElementById("app").style.display = "flex";
  updateUserWidget();
  loadSessionHistory();
  checkHealth();
  if (!_healthInterval) _healthInterval = setInterval(checkHealth, 10000);
  registerKeyboardShortcuts();
  updateHistoryNudge();
  initSplashWave();
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
    if (r.ok) { dot.className = "status-dot online"; txt.textContent = "Groq · Online"; }
    else       { dot.className = "status-dot offline"; txt.textContent = "API Error"; }
  } catch {
    dot.className = "status-dot offline"; txt.textContent = "Backend Offline";
  }
}

/* ── Splash waveform animation ─────────────────────────────────── */
function initSplashWave() {
  const bars = document.querySelectorAll(".sdw-bar");
  if (!bars.length) return;
  setInterval(() => {
    bars.forEach(b => {
      b.style.height = (Math.random() * 28 + 4) + "px";
    });
  }, 120);
}
// Also run on page load for splash
setTimeout(initSplashWave, 100);

/* ── Theme ─────────────────────────────────────────────────────── */
function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", currentTheme);
  applyTheme(currentTheme);
}
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

/* ── Tab switching ─────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll(".nav-item").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const navEl  = document.getElementById("nav-" + name);
  const pageEl = document.getElementById("page-" + name);
  if (navEl)  navEl.classList.add("active");
  if (pageEl) pageEl.classList.add("active");
  if (name === "study" && typeof loadStudyDocuments === "function") loadStudyDocuments();
}

/* ── RTL ───────────────────────────────────────────────────────── */
function applyRTL(lang) {
  const isRTL = RTL_LANGS.has(lang);
  const dir   = isRTL ? "rtl" : "ltr";
  const liveEl = document.getElementById("liveTranslationContent");
  if (liveEl) { liveEl.dir = dir; liveEl.style.textAlign = isRTL ? "right" : "left"; }
  // Covers both the live card and the per-file cards ("<jobId>-res-trans-<Lang>").
  document.querySelectorAll('[id$="-res-translation"], [id^="res-trans-"], [id*="-res-trans-"]').forEach(el => {
    el.dir = dir; el.style.textAlign = isRTL ? "right" : "left";
  });
}
function onLiveLangChange() {
  const lang = document.getElementById("liveLang").value;
  applyRTL(lang);
  // If a live session is running, the target language was only sent to the server
  // at connect time — reconnect the WebSocket so new speech translates to the new
  // language. (Already-shown chunks keep their original translation.)
  if (typeof isLive !== "undefined" && isLive && typeof openWebSocket === "function") {
    closeWebSocket();
    openWebSocket(lang);
  }
}
function onFileLangChange() { applyRTL(document.getElementById("fileLang").value); }

/* ── Keyboard shortcuts ────────────────────────────────────────── */
let _shortcutsRegistered = false;
function registerKeyboardShortcuts() {
  if (_shortcutsRegistered) return;
  _shortcutsRegistered = true;
  document.addEventListener("keydown", e => {
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
    if (e.code === "Space" && document.getElementById("page-live")?.classList.contains("active")) {
      e.preventDefault(); toggleLive();
    }
    if (e.code === "Escape") {
      if (document.getElementById("page-live")?.classList.contains("active")) clearLive();
    }
    if (e.ctrlKey && e.key === "1") { e.preventDefault(); switchTab("live"); }
    if (e.ctrlKey && e.key === "2") { e.preventDefault(); switchTab("conversation"); }
    if (e.ctrlKey && e.key === "3") { e.preventDefault(); switchTab("file"); }
    if (e.ctrlKey && e.key === "4") { e.preventDefault(); switchTab("study"); }
  });
  const hint = document.getElementById("shortcutHint");
  if (hint) hint.textContent = "Space=mic · Esc=clear · Ctrl+1/2/3";
}

/* ════════════════════════════════════════════════════════════════
   LIVE TRANSLATION — Web Speech API (FIXED)
   Works in Chrome/Edge. Each final sentence → streamed translation.
   ════════════════════════════════════════════════════════════════ */

function toggleLive() {
  if (isLive) stopLive();
  else startLive();
}

// startLive, stopLive, _startRecognition, _restartRecognition
// are now handled by live_realtime.js (VAD + WebSocket upgrade)

/* ── Streaming SSE Translation ─────────────────────────────────── */
async function streamTranslation(text, lang, chunkNum, slotIndex) {
  const streamingDot = document.getElementById("streamingDot");
  if (streamingDot) streamingDot.style.display = "inline";

  try {
    const res = await fetch(`${API}/translate/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target_language: lang })
    });
    if (!res.ok || !res.body) return;

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let chunkTranslation = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
          updateChunkLogTranslation(slotIndex, chunkTranslation);
          if (streamingDot) streamingDot.style.display = "none";
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          if (parsed.token) {
            chunkTranslation += parsed.token;
            liveTranslationChunks[slotIndex] = chunkTranslation;
            liveTranslationFull = liveTranslationChunks.filter(Boolean).join("\n");
            setLiveText("translation", liveTranslationFull);
          }
        } catch {}
      }
    }
  } catch (e) {
    console.warn("streamTranslation error:", e);
    if (streamingDot) streamingDot.style.display = "none";
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

function addChunkLogEntry(num, transcript, translation, slotIndex) {
  const log   = document.getElementById("chunkLogItems");
  const entry = document.createElement("div");
  entry.className = "chunk-entry";
  if (slotIndex >= 0) entry.dataset.slot = slotIndex;
  entry.innerHTML = `
    <div class="chunk-num">#${num}</div>
    <div style="flex:1;min-width:0">
      <div class="chunk-entry-text">${escapeHtml(transcript)}</div>
      <div class="chunk-entry-trans" data-trans style="color:var(--text3);font-size:11px;margin-top:2px">translating…</div>
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
  const el = document.getElementById("liveProgress");
  if (el) el.style.display = on ? "block" : "none";
}

function clearLive() {
  liveTranscriptFull    = "";
  liveTranslationFull   = "";
  liveTranscriptChunks  = [];
  liveTranslationChunks = [];
  setLiveText("transcript",  "");
  setLiveText("translation", "");
  const log = document.getElementById("chunkLogItems");
  if (log) log.innerHTML = "";
  const det = document.getElementById("detectedLang");
  if (det) det.textContent = "";
  chunkCounter = 0;
  const card = document.getElementById("liveSentimentCard");
  if (card) { card.style.display = "none"; card.innerHTML = ""; }
  const btn = document.getElementById("liveSentimentBtn");
  if (btn) btn.style.display = "none";
}

/* ── Waveform ──────────────────────────────────────────────────── */
function startWave() {
  const wf = document.querySelector(".waveform");
  if (wf) wf.classList.add("active");
  waveInt = setInterval(() => {
    document.querySelectorAll(".waveform span").forEach(b => {
      b.style.height = (Math.random() * 22 + 4) + "px";
    });
  }, 110);
}
function stopWave() {
  clearInterval(waveInt);
  const wf = document.querySelector(".waveform");
  if (wf) wf.classList.remove("active");
  document.querySelectorAll(".waveform span").forEach(b => { b.style.height = "8px"; });
}

function copyText(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent || el.innerText)
    .then(() => toast("Copied!", "success")).catch(() => {});
}

/* ════════════════════════════════════════════════════════════════
   SENTIMENT ANALYSIS
   ════════════════════════════════════════════════════════════════ */

const SENTIMENT_EMOJI = { positive: "😊", negative: "😟", neutral: "😐", mixed: "😶" };
const EMOTION_EMOJI   = {
  joy: "😄", anger: "😠", sadness: "😢", fear: "😰",
  surprise: "😲", disgust: "🤢", neutral: "😐",
  excitement: "🤩", frustration: "😤", calm: "😌"
};
const SENTIMENT_COLOR = {
  positive: "#3dcba0", negative: "#e24b4a", neutral: "#9898aa", mixed: "#ef9f27"
};

let sentimentHistoryList = [];

async function runSentiment() {
  const text = document.getElementById("sentimentInput").value.trim();
  if (!text || text.length < 10) { toast("Enter at least 10 characters", "error"); return; }

  const btn = document.getElementById("sentimentBtn");
  btn.disabled = true;
  btn.textContent = "Analyzing…";
  document.getElementById("sentimentEmpty").style.display = "none";
  document.getElementById("sentimentResult").style.display = "none";

  try {
    const r = await fetch(`${API}/sentiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    const data = await r.json();
    renderSentimentResult(data);
    addSentimentHistory(text, data);
    await _pushHistory({
      date: new Date().toLocaleString(),
      lang: "Sentiment AI",
      transcript: text,
      translation: data.summary || data.sentiment,
      duration: 0,
      source: "sentiment",
      filename: ""
    });

    toast("Sentiment analyzed!", "success");
  } catch (err) {
    toast("Sentiment failed: " + err.message, "error");
    document.getElementById("sentimentEmpty").style.display = "flex";
  } finally {
    btn.disabled = false;
    btn.textContent = "😊 Analyze Sentiment";
  }
}

function renderSentimentResult(data) {
  const { sentiment, score, confidence, emotion, intensity, key_phrases, summary } = data;

  document.getElementById("sentimentEmoji").textContent =
    EMOTION_EMOJI[emotion] || SENTIMENT_EMOJI[sentiment] || "😐";
  const labelEl = document.getElementById("sentimentLabelBig");
  labelEl.textContent = sentiment.charAt(0).toUpperCase() + sentiment.slice(1);
  labelEl.style.color = SENTIMENT_COLOR[sentiment] || "var(--text)";
  document.getElementById("sentimentEmotionTag").textContent = emotion;

  const scoreBar = document.getElementById("sentimentScoreBar");
  const confBar  = document.getElementById("sentimentConfBar");
  scoreBar.style.background = SENTIMENT_COLOR[sentiment] || "var(--purple)";
  setTimeout(() => {
    scoreBar.style.width = Math.round(score * 100) + "%";
    confBar.style.width  = Math.round(confidence * 100) + "%";
  }, 50);
  document.getElementById("sentimentScoreVal").textContent = Math.round(score * 100) + "%";
  document.getElementById("sentimentConfVal").textContent  = Math.round(confidence * 100) + "%";

  const intensityEl = document.getElementById("sentimentIntensity");
  intensityEl.textContent = intensity + " intensity";
  intensityEl.className = `sentiment-intensity-badge intensity-${intensity}`;
  document.getElementById("sentimentSummary").textContent = summary;

  const phrasesEl = document.getElementById("sentimentPhrases");
  const phraseList = document.getElementById("sentimentPhraseList");
  if (key_phrases && key_phrases.length > 0) {
    phraseList.innerHTML = key_phrases.map(p => `<span class="phrase-tag">${escapeHtml(p)}</span>`).join("");
    phrasesEl.style.display = "block";
  } else {
    phrasesEl.style.display = "none";
  }

  document.getElementById("sentimentResult").style.display = "flex";
}

function addSentimentHistory(text, data) {
  sentimentHistoryList.unshift({ text: text.slice(0, 60) + (text.length > 60 ? "…" : ""), data });
  if (sentimentHistoryList.length > 5) sentimentHistoryList.pop();
  const container = document.getElementById("sentimentHistoryItems");
  container.innerHTML = sentimentHistoryList.map((item, i) => `
    <div class="sentiment-history-item" onclick="loadSentimentHistory(${i})">
      <span>${EMOTION_EMOJI[item.data.emotion] || "😐"}</span>
      <span style="flex:1;font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.text)}</span>
      <span style="font-size:11px;font-weight:600;color:${SENTIMENT_COLOR[item.data.sentiment]}">${item.data.sentiment}</span>
    </div>
  `).join("");
}

function loadSentimentHistory(i) {
  const item = sentimentHistoryList[i];
  if (!item) return;
  document.getElementById("sentimentInput").value = item.text;
  renderSentimentResult(item.data);
}

function loadLiveTranscript() {
  const transcript = document.getElementById("liveTranscriptContent")?.textContent?.trim();
  if (!transcript) { toast("No live transcript yet — start recording first", "error"); return; }
  document.getElementById("sentimentInput").value = transcript;
  switchTab("sentiment");
  toast("Live transcript loaded!", "success");
}

async function analyzeLiveSentiment() {
  const text = document.getElementById("liveTranscriptContent")?.textContent?.trim();
  if (!text) { toast("No transcript to analyze", "error"); return; }

  const card = document.getElementById("liveSentimentCard");
  card.style.display = "block";
  card.innerHTML = `<div style="padding:14px;color:var(--text3);font-size:13px">Analyzing emotion…</div>`;

  try {
    const r = await fetch(`${API}/sentiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    const data = await r.json();
    const emoji = EMOTION_EMOJI[data.emotion] || "😐";
    const color = SENTIMENT_COLOR[data.sentiment] || "var(--text)";
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px;padding:14px 16px">
        <span style="font-size:32px">${emoji}</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:${color};text-transform:capitalize">${data.sentiment} · ${data.emotion}</div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px">${escapeHtml(data.summary)}</div>
        </div>
        <span style="font-size:20px;font-weight:700;color:${color}">${Math.round(data.score*100)}%</span>
      </div>`;
  } catch {
    card.innerHTML = `<div style="padding:14px;color:var(--red);font-size:13px">Analysis failed</div>`;
  }
}

/* ════════════════════════════════════════════════════════════════
   CONVERSATION MODE
   How it works:
   - Person A taps mic → speaks in any language
   - Web Speech API transcribes it
   - Backend translates to Person B's chosen language
   - Chat bubble shows what A said + translation B can read
   - Then B taps mic → speaks → translated to A's language
   Real-world: doctor/patient, tourist/local, business meetings
   ════════════════════════════════════════════════════════════════ */

let convState = {
  isActive: false,
  activeSpeaker: null,
  recognition: null,
  feed: []
};

function convToggle(speaker) {
  if (convState.isActive && convState.activeSpeaker === speaker) {
    convStop();
  } else {
    if (convState.isActive) convStop();
    convStart(speaker);
  }
}

function convStart(speaker) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast("Use Chrome or Edge for conversation mode", "error");
    return;
  }

  convState.isActive      = true;
  convState.activeSpeaker = speaker;

  // Update UI
  const btn   = document.getElementById(`convMic${speaker}`);
  const label = document.getElementById(`convMicLabel${speaker}`);
  if (btn) btn.classList.add("active");
  if (label) label.textContent = "Listening…";

  document.getElementById("convBadge").textContent = `Person ${speaker} speaking`;
  document.getElementById("convBadge").className = "rec-badge live";
  document.getElementById("convFeedEmpty").style.display = "none";

  const rec = new SpeechRecognition();
  rec.continuous      = false;
  rec.interimResults  = true;
  rec.lang            = "en-US";
  convState.recognition = rec;

  let interimDiv = null;

  rec.onresult = async (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) {
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (interimDiv) { interimDiv.remove(); interimDiv = null; }

        const langA = document.getElementById("convLangA").value;
        const langB = document.getElementById("convLangB").value;
        // A speaks → translate to B's language (so B can read it)
        // B speaks → translate to A's language (so A can read it)
        const targetLang = speaker === "A" ? langB : langA;

        const bubbleId = `conv-bubble-${Date.now()}`;
        addConvBubble(speaker, text, bubbleId);
        convState.feed.push({ speaker, transcript: text, translation: "", lang: targetLang });

        try {
          const resp = await fetch(`${API}/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, target_language: targetLang })
          });
          const d = await resp.json();
          updateConvBubble(bubbleId, d.translation, targetLang);
          convState.feed[convState.feed.length - 1].translation = d.translation;
        } catch {
          updateConvBubble(bubbleId, "Translation failed", targetLang);
        }
        convStop();
      } else {
        interim += r[0].transcript;
      }
    }

    if (interim) {
      if (!interimDiv) {
        interimDiv = document.createElement("div");
        interimDiv.className = `conv-interim conv-interim-${speaker.toLowerCase()}`;
        document.getElementById("convFeed").appendChild(interimDiv);
      }
      interimDiv.textContent = interim + "…";
    }
  };

  rec.onend   = () => { if (convState.isActive) convStop(); };
  rec.onerror = (e) => {
    if (e.error !== "no-speech") toast("Mic error: " + e.error, "error");
    convStop();
  };

  try { rec.start(); } catch (e) {
    toast("Could not start mic", "error");
    convStop();
  }
}

function convStop() {
  convState.isActive = false;
  if (convState.recognition) {
    try { convState.recognition.stop(); } catch {}
    convState.recognition = null;
  }
  convState.activeSpeaker = null;

  ["A", "B"].forEach(s => {
    const btn   = document.getElementById(`convMic${s}`);
    const label = document.getElementById(`convMicLabel${s}`);
    if (btn) btn.classList.remove("active");
    if (label) label.textContent = "Tap to Speak";
  });

  const badge = document.getElementById("convBadge");
  if (badge) { badge.textContent = "Idle"; badge.className = "rec-badge"; }
}

function addConvBubble(speaker, transcript, bubbleId) {
  const feed = document.getElementById("convFeed");
  const isA  = speaker === "A";
  const div  = document.createElement("div");
  div.id        = bubbleId;
  div.className = `conv-bubble conv-bubble-${isA ? "a" : "b"}`;
  div.innerHTML = `
    <div class="conv-bubble-speaker">${isA ? "👤 Person A" : "👤 Person B"}</div>
    <div class="conv-bubble-said">${escapeHtml(transcript)}</div>
    <div class="conv-bubble-trans" id="${bubbleId}-trans">
      <span style="opacity:0.5">translating…</span>
    </div>`;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

function updateConvBubble(bubbleId, translation, targetLang) {
  const el = document.getElementById(`${bubbleId}-trans`);
  if (el) el.innerHTML = `<span class="conv-trans-arrow">→ ${escapeHtml(targetLang)}:</span> ${escapeHtml(translation)}`;
}

function clearConversation() {
  convState.feed = [];
  document.getElementById("convFeed").innerHTML = `
    <div class="conv-feed-empty" id="convFeedEmpty">
      <div style="font-size:32px">💬</div>
      <p>Press a mic button above to start the conversation</p>
    </div>`;
  toast("Conversation cleared", "success");
}

function downloadConversation() {
  if (!convState.feed.length) { toast("No conversation to download", "error"); return; }
  const langA = document.getElementById("convLangA").value;
  const langB = document.getElementById("convLangB").value;
  let out = `PolyglotAI Conversation\nPerson A reads: ${langA} | Person B reads: ${langB}\n${"─".repeat(50)}\n\n`;
  convState.feed.forEach(item => {
    out += `[Person ${item.speaker}] said:\n${item.transcript}\n`;
    out += `→ Translated to ${item.lang}: ${item.translation}\n\n`;
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out], { type: "text/plain" }));
  a.download = `polyglot_conversation_${Date.now()}.txt`;
  a.click();
  toast("Downloaded!", "success");
}

/* ════════════════════════════════════════════════════════════════
   AUTH
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
  ["loginError","registerError"].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.display = "none"; el.textContent = ""; el.classList.remove("visible"); }
  });
}

function showAuthError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.style.display = "block"; el.classList.add("visible"); }
}

function setAuthLoading(form, loading) {
  const btnText = document.getElementById(form + "BtnText");
  const spinner = document.getElementById(form + "Spinner");
  const btn     = document.getElementById(form + "Btn");
  if (loading) { if(btnText) btnText.style.display="none"; if(spinner) spinner.style.display="block"; if(btn) btn.disabled=true; }
  else         { if(btnText) btnText.style.display="block"; if(spinner) spinner.style.display="none"; if(btn) btn.disabled=false; }
}

function authHeaders() {
  return authToken ? { "Authorization": `Bearer ${authToken}` } : {};
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
    toast(`Welcome, ${data.display_name || data.username}!`, "success");
  } catch { showAuthError("registerError", "Could not reach server"); }
  finally   { setAuthLoading("register", false); }
}

function skipAuth() { authToken = ""; currentUser = null; launchApp(); }

function doLogout() {
  authToken = ""; currentUser = null; _appLaunched = false;
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
   HISTORY
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
  setTimeout(() => renderHistory(), 0);
}

async function saveSessionHistory() {
  if (!liveTranscriptFull) return;
  await _pushHistory({
    date: new Date().toLocaleString(), lang: sessionLang,
    transcript: liveTranscriptFull, translation: liveTranslationFull,
    duration: liveSecs, source: "live", filename: ""
  });
}

async function saveFileHistory(filename, lang, transcript, translation) {
  if (!transcript) return;
  await _pushHistory({
    date: new Date().toLocaleString(), lang, transcript, translation,
    duration: 0, source: "file", filename
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
      const res = await fetch(`${API}/user/history`, { headers: authHeaders() });
      if (res.ok) { const data = await res.json(); history = data.history || []; }
    } catch {}
  } else {
    history = JSON.parse(localStorage.getItem("polyglot_history") || "[]");
  }

  if (history.length === 0) {
    list.innerHTML = `<div class="history-empty">No sessions yet — start recording or upload a file</div>`;
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
        <span class="history-lang" style="${s.source==='file'|| s.source==='study'|| s.source==='sentiment'?'background:rgba(29,158,117,0.12);color:var(--green2)':'background:rgba(226,75,74,0.1);color:var(--red)'}">
          ${
            s.source === "file" ? "📁 file" :
            s.source === "study" ? "📚 study" :
            s.source === "sentiment" ? "😊 sentiment" :"🎙️ live"
          }
        </span>
      </div>
      ${s.filename?`<div style="font-size:11px;color:var(--text3);margin-bottom:3px">📁 ${escapeHtml(s.filename)}</div>`:""}
      <div class="history-preview">${escapeHtml((s.transcript||"").slice(0,80))}${(s.transcript||"").length>80?"…":""}</div>`;
    div.addEventListener("click", () => loadHistoryEntry(s));
    list.appendChild(div);
  });
}

function loadHistoryEntry(s) {
  if (s.source === "file") {
    switchTab("file");
    // A history entry has no File object, so it comes back as a read-only
    // "restored" job: results are shown, but it is never re-processed.
    const job = _newFileJob(null);
    job.name    = s.filename || "Previous result";
    job.status  = "done";
    job.restored = true;
    job.results.transcript = s.transcript || "";
    if (s.lang && s.translation) job.results.translations[s.lang] = s.translation;
    fileJobs.push(job);
    renderFileJobs();
    _setJobMsg(job, "↺ Restored from history");
    document.getElementById("dropZone").classList.add("has-file");
    document.getElementById("dropMain").textContent = `✓ ${fileJobs.length} file${fileJobs.length === 1 ? "" : "s"} ready`;
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
  toast(`Loaded from ${s.date}`, "success");
}

async function clearHistory() {
  if (authToken && currentUser) {
    try { await fetch(`${API}/user/history`, { method:"DELETE", headers: authHeaders() }); } catch {}
  } else {
    localStorage.removeItem("polyglot_history");
  }
  renderHistory();
  toast("History cleared", "success");
}

/* ════════════════════════════════════════════════════════════════
   FILE UPLOAD & PROCESSING
   ════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════
   FILE UPLOAD & PROCESSING — MULTI-FILE

   Every selected file becomes a "job": its own queue row, its own
   result card, its own transcript / translations / summary / sentiment.
   Nothing is shared between jobs except the target language and the
   "include in results" toggles, which apply to the whole batch.
   ════════════════════════════════════════════════════════════════ */

let fileJobs   = [];
let _jobSeq    = 0;
let _batchBusy = false;

const AUDIO_EXTS = ["mp3", "wav", "m4a", "mp4", "webm", "ogg", "flac", "aac"];
const AUDIO_MAX  = 100 * 1024 * 1024;

const ICON_COPY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
const ICON_TXT  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zm-2 7l-3-3h2v-4h2v4h2l-3 3z"/></svg>';
const ICON_PDF  = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>';

function _fmtBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

function _findFileJob(id) { return fileJobs.find(j => j.id === id) || null; }
function _statusLabel(status) {
  return status === "running" ? "Running"
       : status === "done"    ? "Done"
       : status === "error"   ? "Error" : "Queued";
}

/* ── Selection (picker + drag & drop) ───────────────────────────── */
function onDropZoneClick(e) {
  if (e.target === document.getElementById("fileInput")) return;
  document.getElementById("fileInput").click();
}
function onFileSelect(e) { addFilesToQueue(e.target.files); e.target.value = ""; }
function onDragOver(e)  { e.preventDefault(); document.getElementById("dropZone").classList.add("drag-over"); }
function onDragLeave()  { document.getElementById("dropZone").classList.remove("drag-over"); }
function onDrop(e) {
  e.preventDefault();
  document.getElementById("dropZone").classList.remove("drag-over");
  addFilesToQueue(e.dataTransfer.files);
}

function addFilesToQueue(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const rejected = [];
  files.forEach(f => {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) { rejected.push(`${f.name} (.${ext || "?"})`); return; }
    if (f.size > AUDIO_MAX)       { rejected.push(`${f.name} — over 100MB`); return; }
    fileJobs.push(_newFileJob(f));
  });
  renderFileJobs();
  if (fileJobs.length) {
    document.getElementById("dropZone").classList.add("has-file");
    document.getElementById("dropMain").textContent =
      `✓ ${fileJobs.length} file${fileJobs.length === 1 ? "" : "s"} ready`;
  }
  if (rejected.length) {
    toast(`Skipped ${rejected.length}: ${rejected.slice(0, 2).join(", ")}${rejected.length > 2 ? "…" : ""}`, "error");
  }
}

function _newFileJob(file) {
  return {
    id: "fjob" + (++_jobSeq),
    file, name: file ? file.name : "", size: file ? file.size : 0,
    status: "queued", error: "", collapsed: false, restored: false,
    results: {
      transcript: "", segments: [], translations: {}, summary: "",
      processedLang: "", sentiment: null, detectedLang: "", langConfidence: null,
      chapters: null, keywords: null, profiles: null, ragSessionId: "", ragLanguage: "English",
    },
    root: null,
  };
}

/* ── Per-file result card shell ─────────────────────────────────── */
function _buildFileJobCard(job) {
  const el = document.createElement("div");
  el.className = "file-job is-queued";
  el.id = job.id;
  el.innerHTML = `
    <div class="file-job-head" onclick="toggleFileJob('${job.id}')">
      <span class="fj-icon">🎵</span>
      <div class="fj-meta">
        <div class="fj-name" title="${escapeHtml(job.name)}">${escapeHtml(job.name)}</div>
        <div class="fj-sub" id="${job.id}-sub">${_fmtBytes(job.size)}</div>
      </div>
      <span class="fj-status queued" id="${job.id}-status">Queued</span>
      <div class="fj-actions">
        <button type="button" class="fj-btn" title="Smart Analyze this file" onclick="event.stopPropagation();agentAnalyze('${job.id}')">🤖</button>
        <button type="button" class="fj-btn" title="Remove this file" onclick="event.stopPropagation();removeFileJob('${job.id}')">✕</button>
      </div>
    </div>
    <div class="file-job-body" id="${job.id}-body">
      <div class="fj-msg" id="${job.id}-msg" style="display:none"></div>
      <div class="fj-extras" id="${job.id}-extras"></div>
      <div id="${job.id}-agent"></div>
      <div id="${job.id}-rag"></div>
      <div class="result-card" id="${job.id}-card-transcript" style="display:none">
        <div class="result-card-head">
          <span>Transcript</span>
          <button type="button" class="icon-action" onclick="copyText('${job.id}-res-transcript')">${ICON_COPY}</button>
        </div>
        <div class="result-card-body" id="${job.id}-res-transcript"></div>
      </div>
      <div id="${job.id}-translations"></div>
      <div class="result-card" id="${job.id}-card-summary" style="display:none">
        <div class="result-card-head">
          <span>AI Summary</span>
          <button type="button" class="icon-action" onclick="copyText('${job.id}-res-summary')">${ICON_COPY}</button>
        </div>
        <div class="result-card-body" id="${job.id}-res-summary"></div>
      </div>
      <div class="result-card" id="${job.id}-card-sentiment" style="display:none">
        <div class="result-card-head"><span>Sentiment Analysis</span></div>
        <div class="result-card-body" id="${job.id}-res-sentiment"></div>
      </div>
      <div class="fj-downloads" id="${job.id}-downloads" style="display:none">
        <button type="button" class="fj-dl-btn" onclick="downloadTxt('${job.id}')">${ICON_TXT} TXT</button>
        <button type="button" class="fj-dl-btn" onclick="downloadPDFFile('${job.id}')">${ICON_PDF} PDF</button>
        <details class="fj-dl-options">
          <summary>Include in download…</summary>
          <div class="fj-dl-list" id="${job.id}-dlg-list"></div>
        </details>
      </div>
    </div>`;
  job.root = el;
  return el;
}

/* ── Queue + controls ───────────────────────────────────────────── */
function renderFileJobs() {
  const host  = document.getElementById("fileJobs");
  const panel = document.getElementById("fileQueuePanel");
  const list  = document.getElementById("fileQueueList");
  const empty = document.getElementById("resultsEmpty");
  if (!host || !list || !panel || !empty) return;

  const n = fileJobs.length;
  panel.style.display = n ? "block" : "none";
  empty.style.display = n ? "none" : "flex";
  host.style.display  = n ? "flex" : "none";
  document.getElementById("fileQueueCount").textContent = `${n} file${n === 1 ? "" : "s"}`;

  list.innerHTML = fileJobs.map(j => `
    <div class="queue-row is-${j.status}" title="${escapeHtml(j.error || j.name)}">
      <span class="qr-dot"></span>
      <span class="qr-name">${escapeHtml(j.name)}</span>
      <span class="qr-size">${_fmtBytes(j.size)}</span>
      <button type="button" class="qr-remove" title="Remove" onclick="removeFileJob('${j.id}')">×</button>
    </div>`).join("");

  fileJobs.forEach(j => { if (!j.root) host.appendChild(_buildFileJobCard(j)); });
  Array.from(host.children).forEach(node => {
    if (!fileJobs.some(j => j.id === node.id)) node.remove();
  });
  fileJobs.forEach(renderFileJob);
  _updateBatchControls();
}

/* Light repaint: status pill, card border, queue dots — safe to call mid-run
   because it never rebuilds the streaming translation body. */
function syncFileJob(job) {
  if (job.root) job.root.className = "file-job is-" + job.status + (job.collapsed ? " collapsed" : "");
  const st = document.getElementById(job.id + "-status");
  if (st) { st.className = "fj-status " + job.status; st.textContent = _statusLabel(job.status); }
  const list = document.getElementById("fileQueueList");
  if (list) {
    const row = Array.from(list.children).find(r => r.querySelector(".qr-name")?.textContent === job.name);
    if (row) row.className = "queue-row is-" + job.status;
  }
  _updateBatchControls();
}

function _updateBatchControls() {
  const btn   = document.getElementById("processBtn");
  const label = document.getElementById("processBtnLabel");
  const badge = document.getElementById("fileBadge");
  const agent = document.getElementById("agentBtn");
  const total = fileJobs.length;
  const pending = fileJobs.filter(j => j.status === "queued" || j.status === "error").length;
  const done    = fileJobs.filter(j => j.status === "done").length;

  if (label) label.textContent = total > 1 ? `Process All (${pending} of ${total})` : "Process File";
  if (btn) btn.disabled = _batchBusy || !total;
  if (agent) agent.disabled = _batchBusy || !total;
  if (badge) {
    badge.textContent = !total ? "Idle"
      : _batchBusy  ? `${done}/${total} done`
      : pending === 0 ? "All done"
      : `${done}/${total} done`;
  }
}

function toggleFileJob(id) {
  const job = _findFileJob(id);
  if (!job) return;
  job.collapsed = !job.collapsed;
  job.root.className = "file-job is-" + job.status + (job.collapsed ? " collapsed" : "");
}

function removeFileJob(id) {
  const i = fileJobs.findIndex(j => j.id === id);
  if (i === -1) return;
  if (fileJobs[i].status === "running") { toast("That file is still processing", "error"); return; }
  const [gone] = fileJobs.splice(i, 1);
  if (gone.root) gone.root.remove();
  if (!fileJobs.length) {
    document.getElementById("dropZone").classList.remove("has-file");
    document.getElementById("dropMain").textContent = "Drop audio files or click to browse";
  }
  renderFileJobs();
}

function clearFileJobs() {
  if (_batchBusy) { toast("Wait for the current batch to finish", "error"); return; }
  fileJobs.forEach(j => j.root && j.root.remove());
  fileJobs = [];
  document.getElementById("dropZone").classList.remove("has-file");
  document.getElementById("dropMain").textContent = "Drop audio files or click to browse";
  renderFileJobs();
}

function toggleAllFileJobs() {
  const collapse = fileJobs.some(j => !j.collapsed);
  fileJobs.forEach(j => {
    j.collapsed = collapse;
    if (j.root) j.root.className = "file-job is-" + j.status + (collapse ? " collapsed" : "");
  });
}

/* ── Per-file result rendering ──────────────────────────────────── */
function renderFileJob(job) {
  if (!job.root) return;
  const r = job.results;
  job.root.className = "file-job is-" + job.status + (job.collapsed ? " collapsed" : "");

  const bits = [_fmtBytes(job.size)];
  if (r.detectedLang) {
    bits.push("detected " + r.detectedLang.toUpperCase() +
      (r.langConfidence != null ? ` ${r.langConfidence}%` : ""));
  }
  if (r.transcript) {
    bits.push(r.transcript.trim().split(/\s+/).filter(Boolean).length.toLocaleString() + " words");
  }
  const sub = document.getElementById(job.id + "-sub");
  if (sub) sub.textContent = bits.join(" · ");

  const st = document.getElementById(job.id + "-status");
  if (st) { st.className = "fj-status " + job.status; st.textContent = _statusLabel(job.status); }

  // transcript
  const tCard = document.getElementById(job.id + "-card-transcript");
  if (tCard) tCard.style.display = (options.transcript && r.transcript) ? "block" : "none";
  const tBody = document.getElementById(job.id + "-res-transcript");
  if (tBody && options.transcript && tBody.textContent !== r.transcript) tBody.textContent = r.transcript;

  // translations — cards are reused (never wiped) so an in-flight token
  // stream keeps writing into the same element
  const tHost = document.getElementById(job.id + "-translations");
  if (tHost) {
    const keep = new Set();
    Object.entries(r.translations).forEach(([lang, text]) => {
      if (!text) return;
      const key = lang.replace(/\s|\(|\)/g, "_");
      keep.add(job.id + "-card-trans-" + key);
      const body = _ensureTranslationCard(job, lang);
      if (body && body.textContent !== text) body.textContent = text;
    });
    Array.from(tHost.children).forEach(c => { if (!keep.has(c.id)) c.remove(); });
  }

  // summary
  const sCard = document.getElementById(job.id + "-card-summary");
  if (sCard) sCard.style.display = (options.summary && r.summary) ? "block" : "none";
  const sBody = document.getElementById(job.id + "-res-summary");
  if (sBody && options.summary && r.summary && sBody.textContent !== r.summary) sBody.textContent = r.summary;

  // sentiment
  const seCard = document.getElementById(job.id + "-card-sentiment");
  if (seCard) seCard.style.display = (options.sentiment && r.sentiment) ? "block" : "none";
  const seBody = document.getElementById(job.id + "-res-sentiment");
  if (seBody && r.sentiment) {
    const html = _sentimentHtml(r.sentiment);
    if (seBody.dataset.rendered !== job.status + html.length) {
      seBody.innerHTML = html;
      seBody.dataset.rendered = job.status + html.length;
    }
  }

  // chapters / keywords / speaker profiles
  const ex = document.getElementById(job.id + "-extras");
  if (ex) {
    ex.innerHTML = "";
    if (r.chapters) ex.appendChild(_buildChaptersCard(r.chapters));
    if (r.keywords)  ex.appendChild(_buildKeywordsCard(r.keywords));
    if (r.profiles)  ex.appendChild(_buildSpeakerCard(r.profiles));
  }

  // downloads
  const dl = document.getElementById(job.id + "-downloads");
  if (dl) dl.style.display = r.transcript ? "flex" : "none";
  renderDownloadOptions(job);
}

function _setJobMsg(job, text, isErr) {
  const el = document.getElementById(job.id + "-msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "fj-msg" + (isErr ? " err" : "");
  el.style.display = text ? "flex" : "none";
}

function showJobCard(job, type, text) {
  const card = document.getElementById(job.id + "-card-" + type);
  const body = document.getElementById(job.id + "-res-" + type);
  if (card) card.style.display = text ? "block" : "none";
  if (body && text) body.textContent = text;
}

/* Creates the translation card for a job+language if missing and returns its
   body element. Returns an existing element untouched so streaming is safe. */
function _ensureTranslationCard(job, lang) {
  const host = document.getElementById(job.id + "-translations");
  if (!host) return null;
  const key    = lang.replace(/\s|\(|\)/g, "_");
  const bodyId = job.id + "-res-trans-" + key;
  const existing = document.getElementById(bodyId);
  if (existing) return existing;

  const card = document.createElement("div");
  card.className = "result-card";
  card.id = job.id + "-card-trans-" + key;
  card.innerHTML = `
    <div class="result-card-head">
      <span>Translation — ${escapeHtml(lang)}</span>
      <button type="button" class="icon-action" onclick="copyText('${bodyId}')">${ICON_COPY}</button>
    </div>
    <div class="result-card-body" id="${bodyId}"></div>`;
  host.appendChild(card);
  return document.getElementById(bodyId);
}

function _sentimentHtml(s) {
  const emoji = EMOTION_EMOJI[s.emotion] || "😐";
  const color = SENTIMENT_COLOR[s.sentiment] || "var(--text)";
  return `
    <div style="display:flex;align-items:center;gap:14px">
      <span style="font-size:32px">${emoji}</span>
      <div style="flex:1">
        <div style="font-weight:600;color:${color};text-transform:capitalize">${escapeHtml(s.sentiment)} · ${escapeHtml(s.emotion)}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:3px">${escapeHtml(s.summary)}</div>
        ${s.key_phrases?.length ? `<div style="margin-top:8px">${s.key_phrases.map(p => `<span class="phrase-tag">${escapeHtml(p)}</span>`).join("")}</div>` : ""}
      </div>
      <span style="font-size:22px;font-weight:700;color:${color}">${Math.round(s.score * 100)}%</span>
    </div>`;
}

function toggleOption(key) {
  options[key] = !options[key];
  const btn = document.getElementById("tog-" + key);
  if (btn) btn.classList.toggle("on", options[key]);
  // re-render every card so toggling a section shows/hides it everywhere
  fileJobs.forEach(j => { if (j.status === "done") renderFileJob(j); });
}

/* ── Batch processing ───────────────────────────────────────────── */
async function processAllFiles() {
  if (_batchBusy) return;
  if (!fileJobs.length) { toast("Please add one or more files first", "error"); return; }
  const queue = fileJobs.filter(j => j.file && (j.status === "queued" || j.status === "error"));
  if (!queue.length) { toast(fileJobs.length ? "Every file has been processed ✓" : "Please add one or more files first", fileJobs.length ? "success" : "error"); return; }

  const lang = document.getElementById("fileLang").value;
  const prog = document.getElementById("fileProgress");
  const pmsg = document.getElementById("fileProgressMsg");

  _batchBusy = true;
  prog.style.display = "block";
  pmsg.style.display = "block";
  _updateBatchControls();

  let ok = 0, failed = 0;
  for (let i = 0; i < queue.length; i++) {
    pmsg.textContent = `Processing ${i + 1} of ${queue.length} — ${queue[i].name}`;
    const good = await processOneFileJob(queue[i], lang);
    if (good) ok++; else failed++;
  }

  prog.style.display = "none";
  pmsg.style.display = "none";
  _batchBusy = false;
  renderFileJobs();

  if (failed === 0)  toast(`All ${ok} file${ok === 1 ? "" : "s"} processed ✓`, "success");
  else if (ok === 0) toast(`All ${failed} file${failed === 1 ? "" : "s"} failed`, "error");
  else               toast(`${ok} processed, ${failed} failed`, "error");
}

async function processOneFileJob(job, lang) {
  const r = job.results;
  job.status = "running";
  job.error  = "";
  job.collapsed = false;
  _setJobMsg(job, "🎙️ Transcribing with Whisper…");
  syncFileJob(job);

  try {
    if (!r.transcript) {
      const fd = new FormData();
      fd.append("file", job.file);
      const tr = await fetch(`${API}/transcribe`, { method: "POST", body: fd });
      if (!tr.ok) throw new Error("Transcription failed");
      const data = await tr.json();
      r.transcript     = data.transcript || "";
      r.segments       = data.segments || [];
      r.detectedLang   = data.detected_language || "";
      r.langConfidence = data.language_confidence ?? null;
    }

    if (options.transcript) showJobCard(job, "transcript", r.transcript);

    if (r.segments && r.segments.length > 4) {
      generateChapters(job, r.segments, r.transcript).catch(() => {});
    }

    if (options.translation) {
      // Re-translate whenever the chosen language differs from the one already
      // stored for this file, even if a cached entry exists.
      if (r.translations[lang] && r.processedLang === lang) {
        _setJobMsg(job, `🌐 ${lang} translation already available`);
      } else {
        applyRTL(lang);
        _setJobMsg(job, `🌐 Translating to ${lang}…`);
        const body = _ensureTranslationCard(job, lang);
        const translated = await streamFileTranslation(r.transcript, lang, body);
        r.translations[lang] = translated;
        r.processedLang = lang;
        if (body) body.textContent = translated;
      }
    }

    if (options.summary) {
      if (!r.summary) {
        _setJobMsg(job, "🧠 Summarizing with LLaMA…");
        const sr = await fetch(`${API}/summarize`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: r.transcript })
        });
        if (!sr.ok) throw new Error("Summarization failed");
        r.summary = (await sr.json()).summary;
      }
      showJobCard(job, "summary", r.summary);
    }

    if (options.sentiment && r.transcript) {
      _setJobMsg(job, "😊 Analyzing sentiment…");
      try {
        const sr = await fetch(`${API}/sentiment`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: r.transcript })
        });
        if (sr.ok) r.sentiment = await sr.json();
      } catch {}
    }

    job.status = "done";
    _setJobMsg(job, "✓ Complete");
    renderFileJob(job);
    syncFileJob(job);
    saveFileHistory(job.name, lang, r.transcript, r.translations[lang] || "");
    return true;

  } catch (err) {
    job.status = "error";
    job.error  = err.message || String(err);
    _setJobMsg(job, "⚠️ " + job.error, true);
    renderFileJob(job);
    syncFileJob(job);
    return false;
  }
}

async function streamFileTranslation(text, lang, bodyEl) {
  try {
    const res = await fetch(`${API}/translate/stream`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target_language: lang })
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(errText ? errText.slice(0, 200) : `HTTP ${res.status}`);
    }
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") return full;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.token) { full += parsed.token; if (bodyEl) bodyEl.textContent = full; }
        } catch {}
      }
    }
    return full;
  } catch (e) {
    throw new Error(`Translation to ${lang} failed: ${e.message}`);
  }
}

/* ── Downloads ─────────────────────────────────────────────────── */
function downloadLiveTxt() {
  if (!liveTranscriptFull) { toast("Nothing to download", "error"); return; }
  let out = "";
  if (liveTranscriptFull)  out += `TRANSCRIPT:\n${liveTranscriptFull}\n\n`;
  if (liveTranslationFull) out += `TRANSLATION (${sessionLang}):\n${liveTranslationFull}\n`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.trim()], { type:"text/plain" }));
  a.download = `polyglot_live_${Date.now()}.txt`;
  a.click();
  toast("Downloaded TXT", "success");
}

function downloadTxt(jobId) {
  const job = _findFileJob(jobId);
  if (!job) return;
  const r = job.results;
  const sel = getDownloadSelection(job);
  const base = job.name.replace(/\.[^.]+$/, "");
  let out = "";
  if (sel.transcript && r.transcript) out += `FILE: ${job.name}\n\nTRANSCRIPT:\n${r.transcript}\n\n`;
  sel.langs.forEach(lang => {
    const text = r.translations[lang];
    if (text) out += `TRANSLATION (${lang}):\n${text}\n\n`;
  });
  if (sel.summary && r.summary) out += `SUMMARY:\n${r.summary}`;
  if (!out.trim()) { toast("Nothing selected to download", "error"); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.trim()], { type:"text/plain" }));
  a.download = `polyglot_${base}_${Date.now()}.txt`;
  a.click();
  toast(`Downloaded ${job.name}`, "success");
}

/* ── Download selection (per file) ───────────────────────────────── */
function _dlgLangId(job, lang) { return job.id + "-dlg-lang-" + lang.replace(/\s|\(|\)/g, "_"); }

function renderDownloadOptions(job) {
  const list = document.getElementById(job.id + "-dlg-list");
  if (!list) return;
  const r = job.results;
  let html = `<label class="dlg-opt"><input type="checkbox" id="${job.id}-dlg-transcript" checked> Transcript (original)</label>`;
  Object.entries(r.translations || {}).forEach(([lang, text]) => {
    if (text) html += `<label class="dlg-opt"><input type="checkbox" id="${_dlgLangId(job, lang)}" checked> Translation — ${escapeHtml(lang)}</label>`;
  });
  if (r.summary) html += `<label class="dlg-opt"><input type="checkbox" id="${job.id}-dlg-summary" checked> AI Summary</label>`;
  list.innerHTML = html;
}

function getDownloadSelection(job) {
  const checked = (id) => { const el = document.getElementById(id); return el ? el.checked : true; };
  const langs = Object.keys(job.results.translations || {}).filter(lang => checked(_dlgLangId(job, lang)));
  return { transcript: checked(job.id + "-dlg-transcript"), summary: checked(job.id + "-dlg-summary"), langs };
}

function downloadPDFFile(jobId) {
  const job = _findFileJob(jobId);
  if (!job) return;
  downloadPDF(job.results, { filter: true, job, title: job.name });
}
function downloadLivePDF() {
  downloadPDF({ transcript: liveTranscriptFull, translations: { [sessionLang]: liveTranslationFull }, summary: "" }, {});
}

// jsPDF's built-in helvetica can only render ASCII/Latin-1 — Telugu, Hindi,
// Tamil, Arabic, Chinese, etc. come out garbled. Detect non-ASCII content and
// use a printable HTML report instead, which uses the OS fonts and renders
// every script correctly.
function _hasNonLatin(str) { return /[^\x00-\x7F]/.test(str || ""); }
function _escHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

function downloadPDFPrint(results, title) {
  let sections = "";
  if (results.transcript) sections += `<section><h2>📝 Transcript</h2><p>${_escHtml(results.transcript)}</p></section>`;
  Object.entries(results.translations || {}).forEach(([lang, text]) => {
    if (text) sections += `<section><h2>🌐 Translation (${_escHtml(lang)})</h2><p>${_escHtml(text)}</p></section>`;
  });
  if (results.summary) sections += `<section><h2>🧠 AI Summary</h2><p>${_escHtml(results.summary)}</p></section>`;

  const heading = title ? `PolyglotAI — ${_escHtml(title)}` : "PolyglotAI — Speech Translation Report";
  const win = window.open("", "_blank", "width=820,height=900");
  if (!win) { toast("Popup blocked — allow popups to save the PDF", "error"); return; }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>PolyglotAI Report</title>
<style>
  body { font-family: 'Segoe UI', 'Noto Sans', 'Noto Sans Telugu', 'Noto Sans Devanagari', 'Noto Sans Tamil', sans-serif; margin: 40px; color: #1a1a2e; }
  header { background: #7f77dd; color: #fff; padding: 14px 20px; border-radius: 8px; margin-bottom: 24px; }
  header h1 { margin: 0; font-size: 20px; }
  header div { font-size: 11px; opacity: .85; margin-top: 2px; }
  section { margin-bottom: 22px; page-break-inside: avoid; }
  h2 { font-size: 13px; color: #7f77dd; border-bottom: 2px solid #7f77dd; padding-bottom: 4px; }
  p { font-size: 12.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
  footer { color: #999; font-size: 10px; text-align: center; margin-top: 30px; }
</style></head><body>
<header><h1>${heading}</h1><div>${_escHtml(new Date().toLocaleString())}</div></header>
${sections}
<footer>Generated by PolyglotAI · Powered by Groq + Whisper + Deepgram + LLM</footer>
</body></html>`);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 350);
  toast("Choose 'Save as PDF' in the print dialog", "success");
}

async function downloadPDF(raw, opts) {
  // Apply the user's download-selection (which languages/intro/summary to include).
  let results = raw;
  if (opts && opts.filter && opts.job) {
    const sel = getDownloadSelection(opts.job);
    results = {
      transcript: sel.transcript ? raw.transcript : "",
      translations: sel.langs.reduce((acc, lang) => {
        if (raw.translations && raw.translations[lang]) acc[lang] = raw.translations[lang];
        return acc;
      }, {}),
      summary: sel.summary ? raw.summary : "",
    };
  }
  const title = (opts && opts.title) || "";
  const hasContent = results.transcript || results.summary || Object.keys(results.translations || {}).some(k => results.translations[k]);
  if (!hasContent) { toast("Nothing selected to download", "error"); return; }

  // Non-Latin content (Telugu, Hindi, Tamil, …) can't render in jsPDF fonts —
  // fall back to the print-view which renders all scripts natively.
  const needsUnicode = [results.transcript, ...Object.values(results.translations || {}), results.summary]
    .some(_hasNonLatin);
  if (needsUnicode) { downloadPDFPrint(results, title); return; }
  if (!window.jsPDF) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"mm", format:"a4" });
  const margin = 20; const pageW = doc.internal.pageSize.getWidth(); const maxW = pageW - margin * 2;
  let y = margin;
  doc.setFillColor(127,119,221); doc.rect(0,0,pageW,14,"F");
  doc.setTextColor(255,255,255); doc.setFontSize(11); doc.setFont("helvetica","bold");
  doc.text(title ? `PolyglotAI — ${title}` : "PolyglotAI — Speech Translation Report", margin, 9);
  doc.setTextColor(200,200,255); doc.setFontSize(8); doc.setFont("helvetica","normal");
  doc.text(new Date().toLocaleString(), pageW-margin, 9, { align:"right" });
  y = 24; doc.setTextColor(30,30,30);
  function addSection(title2, body, color) {
    if (!body) return;
    doc.setFontSize(10); doc.setFont("helvetica","bold"); doc.setTextColor(...color);
    doc.text(title2, margin, y); y += 5;
    doc.setDrawColor(...color); doc.setLineWidth(0.3); doc.line(margin, y, pageW-margin, y); y += 4;
    doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(50,50,50);
    const lines = doc.splitTextToSize(body, maxW);
    lines.forEach(line => { if (y > 270) { doc.addPage(); y = margin; } doc.text(line, margin, y); y += 5; });
    y += 6;
  }
  addSection("Transcript", results.transcript, [127,119,221]);
  Object.entries(results.translations||{}).forEach(([lang,text]) => addSection(`Translation (${lang})`, text, [29,158,117]));
  addSection("AI Summary", results.summary, [239,159,39]);
  doc.setFontSize(7); doc.setTextColor(150,150,150);
  doc.text("Generated by PolyglotAI · Powered by Groq + Whisper + LLaMA", margin, 287);
  const safeName = (title || "report").replace(/\.[^.]+$/, "").replace(/[^\w\-. ]+/g, "_");
  doc.save(`polyglot_${safeName}_${Date.now()}.pdf`);
  toast("PDF downloaded!", "success");
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

/* ── Utils ─────────────────────────────────────────────────────── */
function escapeHtml(str) {
  return (str || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror   = reject;
    reader.readAsDataURL(blob);
  });
}
/* ════════════════════════════════════════════════════════════════
   AGENT — Smart AI Analysis (v5.3)
   Analyzes audio, suggests tools, user confirms, runs in parallel
   ════════════════════════════════════════════════════════════════ */

async function agentAnalyze(jobId) {
  let job = jobId ? _findFileJob(jobId) : null;
  if (!job) {
    if (fileJobs.length === 1) job = fileJobs[0];
    else {
      toast(fileJobs.length ? "Use the 🤖 button on a specific file" : "Please add a file first", "error");
      return;
    }
  }
  if (job.status === "running") { toast("That file is still processing", "error"); return; }
  if (!job.file) { toast("This is a restored history entry — re-add the file to analyze it", "error"); return; }

  const host = document.getElementById(job.id + "-agent");
  if (host) host.innerHTML = "";
  job.status = "running";
  job.error = "";
  job.collapsed = false;
  _setJobMsg(job, "🤖 Agent is analyzing your audio…");
  syncFileJob(job);

  try {
    const lang = document.getElementById("fileLang").value;
    const fd = new FormData();
    fd.append("file", job.file);
    fd.append("target_language", lang);

    const res = await fetch(`${API}/agent/analyze`, { method: "POST", body: fd });
    if (!res.ok) throw new Error("Agent analysis failed");
    const data = await res.json();
    const r = job.results;

    r.transcript   = data.transcript;
    r.detectedLang = data.detected_lang;
    r.keywords     = data.keywords || null;

    showJobCard(job, "transcript", r.transcript);
    renderFileJob(job);
    ragStore(job, data.transcript, data.session_id, lang).catch(() => {});

    _showAgentPanel(job, data.suggestions, lang, data.duration_secs, data.word_count);
    job.status = "done";
    _setJobMsg(job, "✓ Transcribed — confirm the steps below");
    renderFileJob(job);
    syncFileJob(job);

  } catch (err) {
    job.status = "error";
    job.error = err.message || String(err);
    _setJobMsg(job, "⚠️ " + job.error, true);
    syncFileJob(job);
  }
}

function _showAgentPanel(job, suggestions, lang, durationSecs, wordCount) {
  const host = document.getElementById(job.id + "-agent");
  if (!host) return;
  host.innerHTML = "";

  const panel = document.createElement("div");
  panel.id = job.id + "-agentPanel";
  panel.style.cssText = `
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 20px;
  `;

  const info = durationSecs
    ? `<div style="font-size:11px;color:var(--text3);margin-bottom:12px">⏱ ~${durationSecs}s · ${wordCount} words</div>`
    : "";

  panel.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:4px;color:var(--accent)">
      🤖 Agent Suggestions
    </div>
    ${info}
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
      ${suggestions.map(s => `
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
          <input type="checkbox" id="${job.id}-agent-chk-${s.tool}" ${s.enabled ? "checked" : ""}
            style="width:15px;height:15px;margin-top:2px;accent-color:var(--accent);cursor:pointer;flex-shrink:0">
          <span>
            <strong>${_agentToolLabel(s.tool)}</strong>
            <span style="color:var(--text2);margin-left:6px;font-size:12px">${escapeHtml(s.reason)}</span>
          </span>
        </label>
      `).join("")}
    </div>
    <button onclick="_agentRun('${job.id}','${escapeHtml(lang)}')" style="
      background:var(--accent);color:#fff;border:none;border-radius:8px;
      padding:10px 0;font-size:13px;font-weight:600;cursor:pointer;width:100%;
    ">▶ Run Selected</button>
  `;
  host.appendChild(panel);
}

function _agentToolLabel(tool) {
  return { translate: "🌐 Translate", summarize: "📝 Summarize", sentiment: "😊 Sentiment", diarize: "👥 Speaker Detection" }[tool] || tool;
}

async function _agentRun(jobId, lang) {
  const job = _findFileJob(jobId);
  if (!job) return;
  const r = job.results;

  const chk = (tool) => document.getElementById(job.id + "-agent-chk-" + tool)?.checked || false;
  const runTranslate = chk("translate");
  const runSummarize = chk("summarize");
  const runSentiment = chk("sentiment");

  job.status = "running";
  _setJobMsg(job, "🤖 Running selected tools…");
  syncFileJob(job);

  const panel = document.getElementById(job.id + "-agentPanel");
  const runBtn = panel?.querySelector("button");
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = "Running…"; }

  try {
    const res = await fetch(`${API}/agent/run`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        transcript:      r.transcript,
        detected_lang:   r.detectedLang,
        target_language: lang,
        run_translate:   runTranslate,
        run_summarize:   runSummarize,
        run_sentiment:   runSentiment,
      }),
    });

    if (!res.ok) throw new Error("Agent run failed");
    const data = await res.json();

    if (data.translation) {
      applyRTL(lang);
      r.translations[lang] = data.translation;
      r.processedLang = lang;
    }
    if (data.summary) r.summary = data.summary;
    if (data.sentiment) r.sentiment = data.sentiment;

    job.status = "done";
    _setJobMsg(job, "✓ Complete");
    renderFileJob(job);
    syncFileJob(job);
    saveFileHistory(job.name, lang, r.transcript, data.translation || "");

    if (panel) panel.remove();

  } catch (err) {
    job.status = "error";
    job.error = err.message || String(err);
    _setJobMsg(job, "⚠️ " + job.error, true);
    syncFileJob(job);
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = "▶ Run Selected"; }
  }
}

// ── Keywords & Topics (returns a card element; the caller places it) ──
function _buildKeywordsCard(kwData) {
  if (!kwData) return null;
  const { topics = [], keywords = [], tag = "" } = kwData;
  if (!topics.length && !keywords.length) return null;

  const card = document.createElement("div");
  card.className = "result-card";

  const topicTags = topics.map(t => `
    <span style="
      background: var(--accent);
      color: #fff;
      border-radius: 20px;
      padding: 3px 12px;
      font-size: 12px;
      font-weight: 600;
    ">${escapeHtml(t)}</span>
  `).join("");

  const kwTags = keywords.map(k => `
    <span style="
      background: var(--bg3);
      color: var(--text);
      border-radius: 20px;
      padding: 3px 10px;
      font-size: 12px;
      border: 1px solid var(--border);
    ">${escapeHtml(k)}</span>
  `).join("");

  card.innerHTML = `
    <div class="result-card-head"><span>🏷️ Keywords & Topics</span></div>
    <div class="result-card-body">
      ${tag ? `<div style="font-size:12px;color:var(--text2);margin-bottom:10px;font-style:italic">📌 ${escapeHtml(tag)}</div>` : ""}
      ${topicTags ? `<div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px">${topicTags}</div>` : ""}
      ${kwTags    ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${kwTags}</div>` : ""}
    </div>
  `;
  return card;
}

// ── Initialize RAG after transcription (per file) ─────────────────
async function ragStore(job, transcript, sessionId, lang) {
  if (!transcript || !sessionId) return;
  job.results.ragSessionId = sessionId;
  job.results.ragLanguage   = lang || "English";

  try {
    await fetch(`${API}/rag/store`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        session_id:    sessionId,
        transcript:    transcript,
        detected_lang: lang || "en",
      }),
    });
    showRagChat(job);
  } catch (e) {
    console.warn("[RAG] Store failed:", e);
  }
}

// ── RAG Chat UI, scoped to one file's card ────────────────────────
function showRagChat(job) {
  const host = document.getElementById(job.id + "-rag");
  if (!host) return;
  host.innerHTML = "";

  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = `
    <div class="result-card-head"><span>💬 Ask about this transcript</span></div>
    <div class="result-card-body" style="display:flex;flex-direction:column;gap:10px">
      <div id="${job.id}-ragMessages" style="
        max-height: 240px; overflow-y: auto;
        display: flex; flex-direction: column; gap: 8px;
      ">
        <div style="font-size:12px;color:var(--text2);text-align:center">
          Ask anything about what was said in the audio
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <input
          id="${job.id}-ragInput"
          type="text"
          placeholder="e.g. What was the main topic?"
          style="
            flex:1;
            background: var(--bg3);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 13px;
            color: var(--text);
            outline: none;
            font-family: inherit;
          "
          onkeydown="if(event.key==='Enter') ragAsk('${job.id}')"
        />
        <button onclick="ragAsk('${job.id}')" style="
          background: var(--accent);
          color: #fff;
          border: none;
          border-radius: 8px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        ">Ask</button>
      </div>
    </div>
  `;
  host.appendChild(card);
}

// ── Ask RAG question about a specific file ────────────────────────
async function ragAsk(jobId) {
  const job = _findFileJob(jobId);
  if (!job) return;
  const input = document.getElementById(job.id + "-ragInput");
  const question = input?.value?.trim();
  if (!question) return;
  const sessionId = job.results.ragSessionId;
  if (!sessionId) { toast("Process this file first", "error"); return; }

  input.value = "";
  input.disabled = true;

  _ragAddMessage(job, "user", question);
  const msgId = job.id + "-rag-" + Date.now();
  _ragAddMessage(job, "assistant", "…", msgId);
  const msgEl = document.getElementById(msgId);
  const box   = document.getElementById(job.id + "-ragMessages");

  try {
    const res = await fetch(`${API}/rag/ask/stream`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        session_id: sessionId,
        question:   question,
        language:   job.results.ragLanguage || "English",
      }),
    });
    if (!res.ok || !res.body) throw new Error("RAG request failed");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        let parsed; try { parsed = JSON.parse(raw); } catch { continue; }
        if (parsed.token) {
          full += parsed.token;
          if (msgEl) msgEl.textContent = full;
          if (box) box.scrollTop = box.scrollHeight;
        }
      }
    }
    if (msgEl && !full.trim()) msgEl.textContent = "Sorry, could not get an answer. Try again.";

  } catch (err) {
    if (msgEl) msgEl.textContent = "Sorry, could not get an answer. Try again.";
    console.warn("[RAG] Ask failed:", err);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function _ragAddMessage(job, role, text, id) {
  const container = document.getElementById(job.id + "-ragMessages");
  if (!container) return;

  const isUser = role === "user";
  const div = document.createElement("div");
  if (id) div.id = id;
  div.style.cssText = `
    max-width: 85%;
    align-self: ${isUser ? "flex-end" : "flex-start"};
    background: ${isUser ? "var(--accent)" : "var(--bg3)"};
    color: ${isUser ? "#fff" : "var(--text)"};
    border-radius: ${isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px"};
    padding: 8px 12px;
    font-size: 13px;
    line-height: 1.5;
    border: ${isUser ? "none" : "1px solid var(--border)"};
  `;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

/* ════════════════════════════════════════════════════════════════
   STUDY ASSISTANT — PolyglotAI v5.3
   ════════════════════════════════════════════════════════════════ */

let studyJobs        = [];
let _studySeq        = 0;
let _studyBusy       = false;
let activeStudyJobId = null;
let studySessionId   = "";   // session id of the document open in the chat workspace

const STUDY_EXTS = ["pdf", "docx", "doc", "txt"];
const STUDY_MAX  = 20 * 1024 * 1024;

function onStudyDragOver(e)  { e.preventDefault(); document.getElementById("studyDropZone").classList.add("drag-over"); }
function onStudyDragLeave()  { document.getElementById("studyDropZone").classList.remove("drag-over"); }
function onStudyDrop(e)      { e.preventDefault(); onStudyDragLeave(); addStudyFiles(e.dataTransfer.files); }
function onStudyZoneClick(e) { if (e.target.id === "studyFileInput") return; document.getElementById("studyFileInput").click(); }
function onStudyFileSelect(e){ addStudyFiles(e.target.files); e.target.value = ""; }

function addStudyFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const rejected = [];
  files.forEach(f => {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!STUDY_EXTS.includes(ext)) { rejected.push(`${f.name} (.${ext || "?"})`); return; }
    if (f.size > STUDY_MAX)         { rejected.push(`${f.name} — over 20MB`); return; }
    studyJobs.push(_newStudyJob(f));
  });
  renderStudyJobs();
  if (studyJobs.length) {
    document.getElementById("studyDropZone").classList.add("has-file");
    document.getElementById("studyDropMain").textContent =
      `✓ ${studyJobs.length} file${studyJobs.length === 1 ? "" : "s"} ready`;
  }
  if (rejected.length) {
    toast(`Skipped ${rejected.length}: ${rejected.slice(0, 2).join(", ")}${rejected.length > 2 ? "…" : ""}`, "error");
  }
}

function _newStudyJob(file) {
  return {
    id: "sjob" + (++_studySeq),
    file, name: file.name, size: file.size,
    status: "queued", error: "", collapsed: false,
    sessionId: "", summary: "", keywords: null, wordCount: 0, charCount: 0,
    root: null,
  };
}

/* ── Per-document result card ───────────────────────────────────── */
function _buildStudyJobCard(job) {
  const el = document.createElement("div");
  el.className = "file-job is-queued";
  el.id = job.id;
  el.innerHTML = `
    <div class="file-job-head" onclick="toggleStudyJob('${job.id}')">
      <span class="fj-icon">📄</span>
      <div class="fj-meta">
        <div class="fj-name" title="${escapeHtml(job.name)}">${escapeHtml(job.name)}</div>
        <div class="fj-sub" id="${job.id}-sub">${_fmtBytes(job.size)}</div>
      </div>
      <span class="fj-status queued" id="${job.id}-status">Queued</span>
      <div class="fj-actions">
        <button type="button" class="fj-btn" title="Remove this document" onclick="event.stopPropagation();removeStudyJob('${job.id}')">✕</button>
      </div>
    </div>
    <div class="file-job-body" id="${job.id}-body">
      <div class="fj-msg" id="${job.id}-msg" style="display:none"></div>
      <div class="sj-stats" id="${job.id}-stats" style="display:none">
        <div><div class="sj-stat-n" id="${job.id}-words">—</div><div class="sj-stat-l">words</div></div>
        <div><div class="sj-stat-n" id="${job.id}-chars" style="color:var(--purple)">—</div><div class="sj-stat-l">characters</div></div>
      </div>
      <div class="topics-strip" id="${job.id}-topics" style="display:none"></div>
      <div class="result-card" id="${job.id}-card-summary" style="display:none">
        <div class="result-card-head">
          <span>📝 AI Summary</span>
          <button type="button" class="icon-action" onclick="copyText('${job.id}-res-summary')">${ICON_COPY}</button>
        </div>
        <div class="result-card-body" id="${job.id}-res-summary"></div>
      </div>
      <div>
        <button type="button" class="sj-activate" id="${job.id}-activate"
          onclick="activateStudyJob('${job.id}')" style="display:none">💬 Study this material</button>
      </div>
    </div>`;
  job.root = el;
  return el;
}

function renderStudyJobs() {
  const host  = document.getElementById("studyJobs");
  const panel = document.getElementById("studyQueuePanel");
  const list  = document.getElementById("studyQueueList");
  const empty = document.getElementById("studyEmpty");
  if (!host || !list || !panel || !empty) return;

  const n = studyJobs.length;
  panel.style.display = n ? "block" : "none";
  empty.style.display = n ? "none" : "flex";
  host.style.display  = n ? "flex" : "none";
  document.getElementById("studyQueueCount").textContent = `${n} file${n === 1 ? "" : "s"}`;

  list.innerHTML = studyJobs.map(j => `
    <div class="queue-row is-${j.status}" title="${escapeHtml(j.error || j.name)}">
      <span class="qr-dot"></span>
      <span class="qr-name">${escapeHtml(j.name)}</span>
      <span class="qr-size">${_fmtBytes(j.size)}</span>
      <button type="button" class="qr-remove" title="Remove" onclick="removeStudyJob('${j.id}')">×</button>
    </div>`).join("");

  studyJobs.forEach(j => { if (!j.root) host.appendChild(_buildStudyJobCard(j)); });
  Array.from(host.children).forEach(node => {
    if (!studyJobs.some(j => j.id === node.id)) node.remove();
  });
  studyJobs.forEach(renderStudyJob);
  _updateStudyControls();
}

function syncStudyJob(job) {
  if (job.root) job.root.className = "file-job is-" + job.status + (job.collapsed ? " collapsed" : "");
  const st = document.getElementById(job.id + "-status");
  if (st) { st.className = "fj-status " + job.status; st.textContent = _statusLabel(job.status); }
  const list = document.getElementById("studyQueueList");
  if (list) {
    const row = Array.from(list.children).find(r => r.querySelector(".qr-name")?.textContent === job.name);
    if (row) row.className = "queue-row is-" + job.status;
  }
  _updateStudyControls();
}

function renderStudyJob(job) {
  if (!job.root) return;
  job.root.className = "file-job is-" + job.status + (job.collapsed ? " collapsed" : "");

  const bits = [_fmtBytes(job.size)];
  if (job.wordCount) bits.push(job.wordCount.toLocaleString() + " words");
  const sub = document.getElementById(job.id + "-sub");
  if (sub) sub.textContent = bits.join(" · ");

  const st = document.getElementById(job.id + "-status");
  if (st) { st.className = "fj-status " + job.status; st.textContent = _statusLabel(job.status); }

  const stats = document.getElementById(job.id + "-stats");
  if (stats) {
    stats.style.display = job.status === "done" ? "flex" : "none";
    const w = document.getElementById(job.id + "-words");
    const c = document.getElementById(job.id + "-chars");
    if (w) w.textContent = job.wordCount.toLocaleString();
    if (c) c.textContent = job.charCount.toLocaleString();
  }

  _renderStudyTopics(job);

  const card = document.getElementById(job.id + "-card-summary");
  if (card) card.style.display = job.summary ? "block" : "none";
  const body = document.getElementById(job.id + "-res-summary");
  if (body && job.summary && body.textContent !== job.summary) body.textContent = job.summary;

  const act = document.getElementById(job.id + "-activate");
  if (act) {
    act.style.display = job.sessionId ? "inline-block" : "none";
    const isActive = activeStudyJobId === job.id;
    act.className = "sj-activate" + (isActive ? " active" : "");
    act.textContent = isActive ? "✓ Open in workspace" : "💬 Study this material";
  }
}

function _studyMsg(job, text, isErr) {
  const el = document.getElementById(job.id + "-msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = "fj-msg" + (isErr ? " err" : "");
  el.style.display = text ? "flex" : "none";
}

function toggleStudyJob(id) {
  const job = studyJobs.find(j => j.id === id);
  if (!job) return;
  job.collapsed = !job.collapsed;
  job.root.className = "file-job is-" + job.status + (job.collapsed ? " collapsed" : "");
}

function removeStudyJob(id) {
  const i = studyJobs.findIndex(j => j.id === id);
  if (i === -1) return;
  if (studyJobs[i].status === "running") { toast("That document is still processing", "error"); return; }
  const [gone] = studyJobs.splice(i, 1);
  if (gone.root) gone.root.remove();
  if (activeStudyJobId === id) _resetStudyWorkspace();
  if (!studyJobs.length) {
    document.getElementById("studyDropZone").classList.remove("has-file");
    document.getElementById("studyDropMain").textContent = "Drop PDF, DOCX, or TXT files";
  }
  renderStudyJobs();
}

function clearStudyJobs() {
  if (_studyBusy) { toast("Wait for the current batch to finish", "error"); return; }
  studyJobs.forEach(j => j.root && j.root.remove());
  studyJobs = [];
  _resetStudyWorkspace();
  document.getElementById("studyDropZone").classList.remove("has-file");
  document.getElementById("studyDropMain").textContent = "Drop PDF, DOCX, or TXT files";
  renderStudyJobs();
}

function _updateStudyControls() {
  const btn   = document.getElementById("studyUploadBtn");
  const label = document.getElementById("studyUploadBtnLabel");
  const badge = document.getElementById("studyBadge");
  const total = studyJobs.length;
  const pending = studyJobs.filter(j => j.status === "queued" || j.status === "error").length;
  const done    = studyJobs.filter(j => j.status === "done").length;

  if (label) label.textContent = total > 1 ? `Analyze All (${pending} of ${total})` : "Analyze Material";
  if (btn) btn.disabled = _studyBusy || !total;
  if (badge) {
    badge.textContent = _studyBusy ? "Analyzing…"
      : !total ? "Idle"
      : `${done}/${total} ready`;
    badge.className = "rec-badge";
  }
}

/* ── Batch analysis ─────────────────────────────────────────────── */
async function studyUploadAll() {
  if (_studyBusy) return;
  if (!studyJobs.length) { toast("Please add one or more documents first", "error"); return; }
  const queue = studyJobs.filter(j => j.status === "queued" || j.status === "error");
  if (!queue.length) { toast("Every document has been analyzed ✓", "success"); return; }

  const prog = document.getElementById("studyProgress");
  const pmsg = document.getElementById("studyProgressMsg");
  _studyBusy = true;
  prog.style.display = "block";
  pmsg.style.display = "block";
  _updateStudyControls();

  let ok = 0, failed = 0;
  for (let i = 0; i < queue.length; i++) {
    pmsg.textContent = `Analyzing ${i + 1} of ${queue.length} — ${queue[i].name}`;
    const good = await _studyOneJob(queue[i]);
    if (good) ok++; else failed++;
  }

  prog.style.display = "none";
  pmsg.style.display = "none";
  _studyBusy = false;
  renderStudyJobs();
  loadStudyDocuments();   // refresh the saved-documents list

  if (failed === 0)  toast(`All ${ok} document${ok === 1 ? "" : "s"} analyzed ✓`, "success");
  else if (ok === 0) toast(`All ${failed} document${failed === 1 ? "" : "s"} failed`, "error");
  else               toast(`${ok} analyzed, ${failed} failed`, "error");
}

async function _studyOneJob(job) {
  job.status = "running";
  job.error = "";
  job.collapsed = false;
  _studyMsg(job, "📖 Extracting and analyzing your material…");
  syncStudyJob(job);

  try {
    const fd = new FormData();
    fd.append("file", job.file);
    const res = await fetch(`${API}/study/upload`, { method: "POST", headers: authHeaders(), body: fd });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || "Upload failed"); }
    const data = await res.json();

    job.sessionId = data.session_id;
    job.summary   = data.summary || "";
    job.keywords  = data.keywords || null;
    job.wordCount = data.word_count || 0;
    job.charCount = data.char_count || 0;
    job.status    = "done";

    _studyMsg(job, "✓ Ready — open it in the workspace to chat");
    renderStudyJob(job);
    syncStudyJob(job);

    await _pushHistory({
      date: new Date().toLocaleString(),
      lang: "Study Assistant",
      transcript: data.summary,
      translation: "",
      duration: 0,
      source: "study",
      filename: data.filename
    });
    return true;

  } catch (err) {
    job.status = "error";
    job.error = err.message || String(err);
    _studyMsg(job, "⚠️ " + job.error, true);
    renderStudyJob(job);
    syncStudyJob(job);
    return false;
  }
}

/* ── Active document: drives the shared chat / quiz / flashcards ── */
function activateStudyJob(id) {
  const job = studyJobs.find(j => j.id === id);
  if (!job || !job.sessionId) { toast("Analyze this document first", "error"); return; }

  activeStudyJobId = id;
  studySessionId   = job.sessionId;
  studyQuiz  = { questions: [], answers: [], submitted: false };
  studyFlash = null;
  _hideStudyQuiz();
  _hideStudyFlashcards();

  document.getElementById("studyOutput").style.display = "flex";
  document.getElementById("studyEmpty").style.display  = "none";

  const nameEl = document.getElementById("studyActiveDocName");
  if (nameEl) nameEl.textContent = job.name;
  const fn = document.getElementById("studyFilenameLabel");
  if (fn) fn.textContent = job.name;

  document.getElementById("studySummaryText").textContent = job.summary || "";
  document.getElementById("studyChatMessages").innerHTML = `
    <div style="font-size:12px;color:var(--text3);text-align:center;padding:12px 0">
      📚 “${escapeHtml(job.name)}” is ready — ask anything about it!
    </div>`;

  const stats = document.getElementById("studyStats");
  if (stats) stats.style.display = "block";
  document.getElementById("studyWordCount").textContent = job.wordCount.toLocaleString();
  document.getElementById("studyCharCount").textContent = job.charCount.toLocaleString();

  renderStudyJobs();
  document.getElementById("studyOutput").scrollIntoView({ behavior: "smooth", block: "start" });
}

function _resetStudyWorkspace() {
  activeStudyJobId = null;
  studySessionId  = "";
  studyQuiz  = { questions: [], answers: [], submitted: false };
  studyFlash = null;
  const out = document.getElementById("studyOutput");
  if (out) out.style.display = "none";
  _hideStudyQuiz();
  _hideStudyFlashcards();
  const stats = document.getElementById("studyStats");
  if (stats) stats.style.display = "none";
  const fn = document.getElementById("studyFilenameLabel");
  if (fn) fn.textContent = "";
  const nameEl = document.getElementById("studyActiveDocName");
  if (nameEl) nameEl.textContent = "";
  const sum = document.getElementById("studySummaryText");
  if (sum) sum.textContent = "";
}

function _renderStudyTopics(job) {
  const strip = document.getElementById(job.id + "-topics");
  if (!strip) return;
  const kw = job.keywords || {};
  const topics   = kw.topics   || [];
  const keywords = kw.keywords || [];

  if (!topics.length && !keywords.length) {
    strip.style.display = "none";
    strip.innerHTML = "";
    return;
  }

  // Show up to 3 top topics; anything opens the full mind map for this document.
  const top3 = topics.slice(0, 3);
  strip.style.display = "flex";
  strip.innerHTML = `
    <span class="topics-strip-label">Key topics</span>
    ${top3.map(t => `<button type="button" class="topic-chip" onclick="openConceptMap('${job.id}')">${escapeHtml(t)}</button>`).join("")}
    <button type="button" class="topics-map-btn" onclick="openConceptMap('${job.id}')">🧠 Concept map</button>`;
}

/* ── Concept mind-map modal (per document) ─────────────────────── */
function openConceptMap(jobId) {
  const job = studyJobs.find(j => j.id === jobId);
  const overlay = document.getElementById("conceptMapOverlay");
  const canvas  = document.getElementById("conceptMapCanvas");
  if (!overlay || !canvas || !job || !job.keywords) {
    toast("Analyze this document first", "error");
    return;
  }
  canvas.innerHTML = _buildConceptMap(job.keywords);
  overlay.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function closeConceptMap(e) {
  const overlay = document.getElementById("conceptMapOverlay");
  if (!overlay) return;
  overlay.style.display = "none";
  document.body.style.overflow = "";
}

// Close on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const ov = document.getElementById("conceptMapOverlay");
    if (ov && ov.style.display === "flex") closeConceptMap();
  }
});

function _buildConceptMap(kw) {
  const topics   = (kw.topics   || []).slice(0, 6);
  const keywords = (kw.keywords || []);
  const center   = (kw.tag && kw.tag.length <= 42) ? kw.tag
                 : (topics[0] || "This Document");

  // Distribute keywords round-robin under the topics as leaf branches.
  const buckets = topics.map(() => []);
  if (topics.length) keywords.forEach((k, i) => buckets[i % topics.length].push(k));
  else buckets.push([...keywords]);

  const branches = topics.length ? topics.map((t, i) => `
    <div class="cmap-branch">
      <div class="cmap-topic">${escapeHtml(t)}</div>
      <div class="cmap-leaves">
        ${buckets[i].map(k => `<span class="cmap-leaf">${escapeHtml(k)}</span>`).join("")}
      </div>
    </div>`).join("")
    : `<div class="cmap-branch"><div class="cmap-leaves">
         ${keywords.map(k => `<span class="cmap-leaf">${escapeHtml(k)}</span>`).join("")}
       </div></div>`;

  return `
    <div class="cmap-center">${escapeHtml(center)}</div>
    <div class="cmap-branches">${branches}</div>`;
}

/* ── My Documents (persisted study docs) ──────────────────────────── */
async function loadStudyDocuments() {
  const section = document.getElementById("studyDocsSection");
  const list    = document.getElementById("studyDocsList");
  if (!section || !list) return;
  // Only meaningful for logged-in users (guests aren't tied to saved docs)
  if (!authToken || !currentUser) { section.style.display = "none"; return; }

  try {
    const res = await fetch(`${API}/study/list`, { headers: authHeaders() });
    if (!res.ok) { section.style.display = "none"; return; }
    const docs = (await res.json()).documents || [];
    if (!docs.length) { section.style.display = "none"; return; }

    section.style.display = "block";
    const countEl = document.getElementById("studyDocsCount");
    if (countEl) countEl.textContent = `${docs.length}`;

    list.innerHTML = docs.map(d => {
      const wc   = (d.meta && d.meta.word_count) ? `${Number(d.meta.word_count).toLocaleString()} words` : "";
      const when = d.created_at ? new Date(d.created_at + "Z").toLocaleDateString() : "";
      const sub  = [wc, when].filter(Boolean).join(" · ");
      return `<button type="button" class="study-doc-item" onclick="openStudyDocument('${encodeURIComponent(d.session_id)}')">
        <span class="sdi-icon">📄</span>
        <span class="sdi-main">
          <span class="sdi-name">${escapeHtml(d.filename || "Document")}</span>
          <span class="sdi-sub">${escapeHtml(sub)}</span>
        </span>
      </button>`;
    }).join("");
  } catch { section.style.display = "none"; }
}

async function openStudyDocument(sid) {
  try {
    const res = await fetch(`${API}/study/session/${sid}`, { headers: authHeaders() });
    if (!res.ok) { toast("Could not open document", "error"); return; }
    const data = await res.json();

    // A reopened saved document is not part of the current batch — it just
    // becomes the document the shared chat / quiz / workspace is bound to.
    activeStudyJobId = null;
    studySessionId   = data.session_id;
    studyQuiz  = { questions: [], answers: [], submitted: false };
    studyFlash = null;
    _hideStudyQuiz();
    _hideStudyFlashcards();

    document.getElementById("studyEmpty").style.display  = "none";
    document.getElementById("studyOutput").style.display = "flex";
    document.getElementById("studyStats").style.display  = "block";
    document.getElementById("studyWordCount").textContent = (data.word_count || 0).toLocaleString();
    document.getElementById("studyCharCount").textContent = (data.char_count || 0).toLocaleString();
    const fn = document.getElementById("studyFilenameLabel");
    if (fn) fn.textContent = data.filename || "";
    const nameEl = document.getElementById("studyActiveDocName");
    if (nameEl) nameEl.textContent = data.filename || "Saved document";

    document.getElementById("studySummaryText").textContent = data.summary || "";
    document.getElementById("studyChatMessages").innerHTML = `
      <div style="font-size:12px;color:var(--text3);text-align:center;padding:12px 0">
        📚 Reopened “${escapeHtml(data.filename || "document")}” — ask anything about it!
      </div>`;
    _updateStudyControls();
    toast("📄 Document reopened", "success");
  } catch { toast("Could not open document", "error"); }
}

async function studyAsk() {
  const input    = document.getElementById("studyChatInput");
  const question = input?.value?.trim();
  if (!question) return;
  if (!studySessionId) { toast("Open a document in the workspace first", "error"); return; }

  input.value    = "";
  input.disabled = true;
  _addStudyMsg("user", question);
  const msgId = "sm-" + Date.now();
  _addStudyMsg("assistant", "…", msgId);
  const msgEl   = document.getElementById(msgId);
  const msgsBox = document.getElementById("studyChatMessages");

  try {
    const res = await fetch(`${API}/study/ask/stream`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ session_id: studySessionId, question, mode: "tutor" }),
    });
    if (!res.ok || !res.body) throw new Error("Failed");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", full = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        let parsed; try { parsed = JSON.parse(raw); } catch { continue; }
        if (parsed.token) {
          full += parsed.token;
          if (msgEl) msgEl.textContent = full;
          if (msgsBox) msgsBox.scrollTop = msgsBox.scrollHeight;
        }
      }
    }
    if (msgEl && !full.trim()) msgEl.textContent = "Sorry, couldn't get an answer. Try again.";
  } catch {
    if (msgEl) msgEl.textContent = "Sorry, couldn't get an answer. Try again.";
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function _addStudyMsg(role, text, id) {
  const c = document.getElementById("studyChatMessages");
  if (!c) return;
  const isUser = role === "user";
  const div = document.createElement("div");
  if (id) div.id = id;
  div.style.cssText = `
    max-width:88%;align-self:${isUser?"flex-end":"flex-start"};
    background:${isUser?"var(--purple)":"var(--bg3)"};
    color:${isUser?"#fff":"var(--text)"};
    border-radius:${isUser?"14px 14px 3px 14px":"14px 14px 14px 3px"};
    padding:10px 14px;font-size:13px;line-height:1.6;
    border:${isUser?"none":"1px solid var(--border)"};
    white-space:pre-wrap;word-break:break-word;`;
  div.textContent = text;
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
}

/* ── Quick-ask suggestion chips ───────────────────────────────────── */
function studyQuickAsk(text) {
  const input = document.getElementById("studyChatInput");
  if (!input) return;
  if (!studySessionId) { toast("Open a document in the workspace first", "error"); return; }
  input.value = text;
  studyAsk();
}

/* ════════════════════════════════════════════════════════════════
   STUDY QUIZ — generate → answer → score
   ════════════════════════════════════════════════════════════════ */
let studyQuiz = { questions: [], answers: [], submitted: false };

async function startStudyQuiz() {
  if (!studySessionId) { toast("Open a document in the workspace first", "error"); return; }
  const card = document.getElementById("studyQuizCard");
  const body = document.getElementById("studyQuizBody");
  const btn  = document.getElementById("studyQuizBtn");
  const scoreEl = document.getElementById("studyQuizScore");
  if (scoreEl) scoreEl.style.display = "none";

  card.style.display = "block";
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  body.innerHTML = `<div class="quiz-loading"><span class="quiz-spinner"></span> Generating your quiz…</div>`;
  if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }

  try {
    const res = await fetch(`${API}/study/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ session_id: studySessionId, num_questions: 5 }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.detail || "Quiz failed"); }
    const data = await res.json();
    studyQuiz = { questions: data.questions || [], answers: [], submitted: false };
    if (!studyQuiz.questions.length) throw new Error("No questions generated");
    _renderStudyQuiz();
  } catch (err) {
    body.innerHTML = `<div class="quiz-loading">⚠️ ${escapeHtml(err.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = "🧠 Take Quiz"; }
  }
}

function _renderStudyQuiz() {
  const body = document.getElementById("studyQuizBody");
  const q = studyQuiz;
  const items = q.questions.map((item, qi) => {
    const opts = item.options.map((opt, oi) => {
      const picked  = q.answers[qi] === oi;
      const correct = item.answer === oi;
      let cls = "quiz-option";
      if (q.submitted) {
        if (correct) cls += " correct";
        else if (picked) cls += " wrong";
      } else if (picked) cls += " picked";
      return `<button type="button" class="${cls}" ${q.submitted ? "disabled" : ""}
                onclick="pickQuizAnswer(${qi},${oi})">
                <span class="quiz-opt-letter">${String.fromCharCode(65+oi)}</span>
                <span>${escapeHtml(opt)}</span>
              </button>`;
    }).join("");
    const expl = (q.submitted && item.explanation)
      ? `<div class="quiz-explain">${q.answers[qi]===item.answer ? "✅" : "❌"} ${escapeHtml(item.explanation)}</div>`
      : "";
    return `<div class="quiz-q">
        <div class="quiz-q-title"><span class="quiz-q-num">${qi+1}</span>${escapeHtml(item.question)}</div>
        <div class="quiz-options">${opts}</div>
        ${expl}
      </div>`;
  }).join("");

  const footer = q.submitted
    ? `<button type="button" class="btn-primary quiz-action" onclick="startStudyQuiz()">Retake Quiz</button>`
    : `<button type="button" class="btn-primary quiz-action" onclick="submitStudyQuiz()">Submit Answers</button>`;

  body.innerHTML = items + `<div class="quiz-footer">${footer}</div>`;
}

function pickQuizAnswer(qi, oi) {
  if (studyQuiz.submitted) return;
  studyQuiz.answers[qi] = oi;
  _renderStudyQuiz();
}

function submitStudyQuiz() {
  const q = studyQuiz;
  const unanswered = q.questions.some((_, i) => q.answers[i] === undefined);
  if (unanswered) { toast("Answer all questions first", "error"); return; }
  q.submitted = true;
  const score = q.questions.reduce((s, item, i) => s + (q.answers[i] === item.answer ? 1 : 0), 0);
  const total = q.questions.length;
  const pct   = Math.round((score / total) * 100);
  const scoreEl = document.getElementById("studyQuizScore");
  if (scoreEl) {
    scoreEl.style.display = "inline-flex";
    scoreEl.textContent = `${score}/${total} · ${pct}%`;
    scoreEl.className = "study-quiz-score " + (pct >= 70 ? "good" : pct >= 40 ? "ok" : "bad");
  }
  _renderStudyQuiz();
  const msg = pct >= 70 ? "🎉 Great job!" : pct >= 40 ? "Keep studying — you're getting there!" : "Review the material and try again.";
  toast(`${msg} Score: ${score}/${total}`, pct >= 70 ? "success" : "");
}

function closeStudyQuiz() { _hideStudyQuiz(); }
function _hideStudyQuiz() {
  const card = document.getElementById("studyQuizCard");
  if (card) card.style.display = "none";
  const score = document.getElementById("studyQuizScore");
  if (score) score.style.display = "none";
}

/* ════════════════════════════════════════════════════════════════
   STUDY FLASHCARDS — flip, mark, spaced re-queue, progress (persisted)
   ════════════════════════════════════════════════════════════════ */
let studyFlash = null;   // { cards, queue, masteredCount, flipped }

function _flashKey() { return "flash_" + studySessionId; }

function _saveFlash() {
  try {
    if (studyFlash) localStorage.setItem(_flashKey(), JSON.stringify({
      cards: studyFlash.cards, queue: studyFlash.queue, masteredCount: studyFlash.masteredCount,
    }));
  } catch {}
}

async function startStudyFlashcards() {
  if (!studySessionId) { toast("Open a document in the workspace first", "error"); return; }
  const card = document.getElementById("studyFlashcardsCard");
  card.style.display = "block";
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Resume a saved deck for this document if one exists.
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(_flashKey()) || "null"); } catch {}
  if (saved && Array.isArray(saved.cards) && saved.cards.length) {
    studyFlash = { cards: saved.cards, queue: saved.queue || [], masteredCount: saved.masteredCount || 0, flipped: false };
    _renderFlashcard();
    return;
  }

  await _fetchFlashDeck();
}

async function _fetchFlashDeck() {
  const body = document.getElementById("studyFlashBody");
  const btn  = document.getElementById("studyFlashBtn");
  body.innerHTML = `<div class="quiz-loading"><span class="quiz-spinner"></span> Building your flashcards…</div>`;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API}/study/flashcards`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ session_id: studySessionId, num_cards: 10 }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.detail || "Flashcards failed"); }
    const data = await res.json();
    const cards = data.cards || [];
    if (!cards.length) throw new Error("No flashcards generated");
    studyFlash = { cards, queue: cards.map((_, i) => i), masteredCount: 0, flipped: false };
    _saveFlash();
    _renderFlashcard();
  } catch (err) {
    body.innerHTML = `<div class="quiz-loading">⚠️ ${escapeHtml(err.message)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _renderFlashcard() {
  const body = document.getElementById("studyFlashBody");
  const prog = document.getElementById("studyFlashProgress");
  const f = studyFlash;
  const total = f.cards.length;

  if (prog) { prog.style.display = "inline-flex"; prog.textContent = `${f.masteredCount}/${total} mastered`; }

  if (!f.queue.length) { _flashDone(); return; }

  const idx = f.queue[0];
  const cardData = f.cards[idx];
  const remaining = f.queue.length;
  const face = f.flipped ? cardData.back : cardData.front;
  const hint = f.flipped ? "ANSWER" : "TERM";

  body.innerHTML = `
    <div class="flash-topbar">
      <span>${remaining} card${remaining === 1 ? "" : "s"} left this round</span>
      <span>${f.masteredCount}/${total} mastered</span>
    </div>
    <div class="flashcard ${f.flipped ? "flipped" : ""}" onclick="flipFlashcard()">
      <div class="flash-face-label">${hint}</div>
      <div class="flash-face-text">${escapeHtml(face)}</div>
      ${!f.flipped ? `<div class="flash-tap">👆 tap to reveal answer</div>` : ""}
    </div>
    ${f.flipped ? `
      <div class="flash-actions">
        <button type="button" class="flash-btn again" onclick="markFlashcard(false)">↻ Review again</button>
        <button type="button" class="flash-btn got" onclick="markFlashcard(true)">✓ Got it</button>
      </div>` : `
      <div class="flash-actions">
        <button type="button" class="flash-btn reveal" onclick="flipFlashcard()">Show answer</button>
      </div>`}
  `;
}

function flipFlashcard() {
  if (!studyFlash) return;
  studyFlash.flipped = !studyFlash.flipped;
  _renderFlashcard();
}

function markFlashcard(known) {
  const f = studyFlash;
  if (!f || !f.queue.length) return;
  const idx = f.queue.shift();
  if (known) f.masteredCount++;
  else f.queue.push(idx);   // spaced re-queue: send to the back to see again
  f.flipped = false;
  _saveFlash();
  _renderFlashcard();
}

function _flashDone() {
  const body = document.getElementById("studyFlashBody");
  const total = studyFlash.cards.length;
  body.innerHTML = `
    <div class="flash-done">
      <div class="flash-done-emoji">🎉</div>
      <div class="flash-done-title">Deck complete!</div>
      <div class="flash-done-sub">You mastered all ${total} cards.</div>
      <div class="flash-done-actions">
        <button type="button" class="btn-primary quiz-action" onclick="restartFlashcards()">Study again</button>
        <button type="button" class="flash-btn again" onclick="newFlashDeck()">New deck</button>
      </div>
    </div>`;
}

function restartFlashcards() {
  if (!studyFlash) return;
  studyFlash.queue = studyFlash.cards.map((_, i) => i);
  studyFlash.masteredCount = 0;
  studyFlash.flipped = false;
  _saveFlash();
  _renderFlashcard();
}

function newFlashDeck() {
  try { localStorage.removeItem(_flashKey()); } catch {}
  studyFlash = null;
  _fetchFlashDeck();
}

function closeStudyFlashcards() { _hideStudyFlashcards(); }
function _hideStudyFlashcards() {
  const card = document.getElementById("studyFlashcardsCard");
  if (card) card.style.display = "none";
  const prog = document.getElementById("studyFlashProgress");
  if (prog) prog.style.display = "none";
}

/* ════════════════════════════════════════════════════════════════
   SIDEBAR COLLAPSE TOGGLE
   ════════════════════════════════════════════════════════════════ */
function toggleSidebar() {
  const app = document.getElementById("app");
  if (!app) return;
  const collapsed = app.classList.toggle("nav-collapsed");
  localStorage.setItem("sidebar_collapsed", collapsed ? "1" : "0");
}
// Restore collapsed state on load
(function () {
  if (localStorage.getItem("sidebar_collapsed") === "1") {
    document.addEventListener("DOMContentLoaded", () => {
      const app = document.getElementById("app");
      if (app) app.classList.add("nav-collapsed");
    });
  }
})();

/* ════════════════════════════════════════════════════════════════
   NEW FEATURES FRONTEND — PolyglotAI v5.4
   1. Language Identification Confidence
   2. Auto-Chapters
   3. Speaker Profiling
   
   Paste at bottom of script.js
   ════════════════════════════════════════════════════════════════ */

// ── 2. Auto-Chapters (per file) ───────────────────────────────────
async function generateChapters(job, segments, transcript) {
  if (!segments || segments.length < 5) return;

  try {
    const res = await fetch(`${API}/analyze/chapters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments, transcript }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.chapters && data.chapters.length > 1) {
      job.results.chapters = data.chapters;
      renderFileJob(job);
    }
  } catch (e) {
    console.warn("[Chapters] Failed:", e);
  }
}

function _buildChaptersCard(chapters) {
  const card = document.createElement("div");
  card.className = "result-card";

  const items = chapters.map((ch, i) => `
    <div style="display:flex;align-items:center;gap:12px;padding:8px 0;${i < chapters.length-1 ? 'border-bottom:1px solid var(--border)' : ''}">
      <span style="
        background:var(--purple-dim);color:var(--purple);
        border-radius:6px;padding:3px 8px;font-size:11px;
        font-weight:700;font-family:'JetBrains Mono',monospace;
        white-space:nowrap;min-width:44px;text-align:center;
      ">${escapeHtml(ch.time_fmt)}</span>
      <span style="font-size:13px;color:var(--text)">${escapeHtml(ch.title)}</span>
    </div>
  `).join("");

  card.innerHTML = `
    <div class="result-card-head">
      <span>📑 Auto-Chapters</span>
      <span style="font-size:11px;color:var(--text3)">${chapters.length} chapters</span>
    </div>
    <div class="result-card-body" style="padding:4px 16px">${items}</div>
  `;
  return card;
}


// ── 3. Speaker Profiling (per file) ──────────────────────────────
async function generateSpeakerProfiles(job, diarizedSegments) {
  if (!diarizedSegments || diarizedSegments.length < 2) return;

  // Check if multiple speakers
  const speakers = new Set(diarizedSegments.map(s => s.speaker));
  if (speakers.size < 2) return;

  try {
    const res = await fetch(`${API}/analyze/speaker-profiles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        diarized_segments: diarizedSegments,
        dialogue: diarizedSegments.map(s => `${s.speaker}: ${s.text}`).join("\n"),
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.profiles) {
      job.results.profiles = data.profiles;
      renderFileJob(job);
    }
  } catch (e) {
    console.warn("[Profiling] Failed:", e);
  }
}

function _buildSpeakerCard(profiles) {
  const SPEAKER_COLORS = ["var(--purple)", "var(--green2)", "var(--amber)", "#63b3ed"];

  const cards = Object.entries(profiles).map(([speaker, profile], i) => {
    const color = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
    const traits = (profile.traits || []).map(t =>
      `<span style="background:var(--bg4);border:1px solid var(--border);border-radius:20px;padding:2px 10px;font-size:11px;color:var(--text2)">${escapeHtml(t)}</span>`
    ).join("");

    return `
      <div style="padding:14px;background:var(--bg3);border-radius:10px;border:1px solid var(--border);margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="width:32px;height:32px;border-radius:50%;background:${color}22;border:2px solid ${color};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:${color}">
            ${escapeHtml(speaker.replace("Speaker ", ""))}
          </div>
          <div>
            <div style="font-weight:600;font-size:13px;color:var(--text)">${escapeHtml(speaker)}</div>
            <div style="font-size:11px;color:var(--text3)">${escapeHtml(profile.tone || "")} · ${escapeHtml(profile.vocabulary || "")} vocabulary</div>
          </div>
        </div>
        <div style="font-size:12px;color:var(--text2);margin-bottom:8px;font-style:italic">"${escapeHtml(profile.summary || "")}"</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px">${traits}</div>
      </div>
    `;
  }).join("");

  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = `
    <div class="result-card-head">
      <span>👥 Speaker Profiles</span>
      <span style="font-size:11px;color:var(--text3)">${Object.keys(profiles).length} speakers</span>
    </div>
    <div class="result-card-body">${cards}</div>
  `;
  return card;
}