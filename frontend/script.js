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
let selectedFile      = null;
let fileResults       = { transcript: "", translations: {}, summary: "" };
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
  document.querySelectorAll('[id^="res-trans-"]').forEach(el => {
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
    fileResults = { transcript: s.transcript||"", translations:{}, summary:"" };
    if (s.lang && s.translation) fileResults.translations[s.lang] = s.translation;
    hideAllCards();
    document.getElementById("translations-container").innerHTML = "";
    document.getElementById("dropMain").textContent = s.filename?`✓ ${s.filename}`:"Previous result";
    document.getElementById("fileBadge").textContent = "Done";
    document.getElementById("resultsEmpty").style.display = "none";
    document.getElementById("downloadGroup").style.display = "flex";
    if (fileResults.transcript) showCard("transcript", fileResults.transcript);
    Object.entries(fileResults.translations).forEach(([lang, text]) => {
      if (!text) return;
      const cardId = `card-trans-${lang.replace(/\s|\(|\)/g,"_")}`;
      const bodyId = `res-trans-${lang.replace(/\s|\(|\)/g,"_")}`;
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

function onDropZoneClick(e) {
  if (e.target === document.getElementById("fileInput")) return;
  const btn = document.getElementById("processBtn");
  if (btn && btn.disabled) return;
  document.getElementById("fileInput").click();
}
function onFileSelect(e) { const f = e.target.files[0]; if (f) setSelectedFile(f); e.target.value = ""; }
function onDragOver(e)  { e.preventDefault(); document.getElementById("dropZone").classList.add("drag-over"); }
function onDragLeave()  { document.getElementById("dropZone").classList.remove("drag-over"); }
function onDrop(e) {
  e.preventDefault();
  document.getElementById("dropZone").classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (f) setSelectedFile(f);
}

const allFileResults = {};

function setSelectedFile(f) {
  selectedFile = f;
  document.getElementById("dropMain").textContent = `✓ ${f.name}`;
  document.getElementById("dropZone").classList.add("has-file");
  if (!allFileResults[f.name]) allFileResults[f.name] = { transcript:"", translations:{}, summary:"" };
  fileResults = allFileResults[f.name];
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
    const cardId = `card-trans-${lang.replace(/\s|\(|\)/g,"_")}`;
    const bodyId = `res-trans-${lang.replace(/\s|\(|\)/g,"_")}`;
    addTranslationCard(lang, cardId, bodyId);
    const el = document.getElementById(bodyId);
    if (el) el.textContent = text;
  });
  if (fileResults.summary) showCard("summary", fileResults.summary);
}

function toggleOption(key) {
  options[key] = !options[key];
  const btn = document.getElementById("tog-" + key);
  if (btn) btn.classList.toggle("on", options[key]);
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

  try {
    if (!fileResults.transcript) {
      pmsg.textContent = "🎙️ Transcribing with Whisper…";
      const fd = new FormData();
      fd.append("file", selectedFile);
      const tr = await fetch(`${API}/transcribe`, { method:"POST", body:fd });
      if (!tr.ok) throw new Error("Transcription failed");
      const trData = await tr.json();
      fileResults.transcript = trData.transcript;
      fileResults.segments = trData.segments || [];
      if (trData.detected_language)
        showLanguageConfidence(trData.detected_language, trData.language_confidence || null);
    }

    const transcript = fileResults.transcript;
    if (options.transcript) showCard("transcript", transcript);

    // Auto-chapters if segments available
    if (fileResults.segments && fileResults.segments.length > 4) {
      generateChapters(fileResults.segments, transcript).catch(()=>{});
    }

    if (options.translation) {
      if (fileResults.translations[lang]) {
        toast(`${lang} already done ✓`, "success");
      } else {
        applyRTL(lang);
        pmsg.textContent = `🌐 Translating to ${lang}…`;
        const cardId = `card-trans-${lang.replace(/\s|\(|\)/g,"_")}`;
        const bodyId = `res-trans-${lang.replace(/\s|\(|\)/g,"_")}`;
        addTranslationCard(lang, cardId, bodyId);
        const translated = await streamFileTranslation(transcript, lang, bodyId);
        fileResults.translations[lang] = translated;
        const el = document.getElementById(bodyId);
        if (el) el.textContent = translated;
      }
    }

    if (options.summary) {
      if (!fileResults.summary) {
        pmsg.textContent = "🧠 Summarizing with LLaMA…";
        const sr = await fetch(`${API}/summarize`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ text: transcript })
        });
        if (!sr.ok) throw new Error("Summarization failed");
        const { summary } = await sr.json();
        fileResults.summary = summary;
      }
      showCard("summary", fileResults.summary);
    }

    // Sentiment toggle support
    if (options.sentiment && transcript) {
      pmsg.textContent = "😊 Analyzing sentiment…";
      try {
        const sr = await fetch(`${API}/sentiment`, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ text: transcript })
        });
        if (sr.ok) {
          const sData = await sr.json();
          const card = document.getElementById("card-sentiment-file");
          const body = document.getElementById("res-sentiment-file");
          if (card && body) {
            const emoji = EMOTION_EMOJI[sData.emotion] || "😐";
            const color = SENTIMENT_COLOR[sData.sentiment] || "var(--text)";
            body.innerHTML = `
              <div style="display:flex;align-items:center;gap:14px">
                <span style="font-size:32px">${emoji}</span>
                <div style="flex:1">
                  <div style="font-weight:600;color:${color};text-transform:capitalize">${sData.sentiment} · ${sData.emotion}</div>
                  <div style="font-size:12px;color:var(--text2);margin-top:3px">${escapeHtml(sData.summary)}</div>
                  ${sData.key_phrases?.length ? `<div style="margin-top:8px">${sData.key_phrases.map(p=>`<span class="phrase-tag">${escapeHtml(p)}</span>`).join("")}</div>` : ""}
                </div>
                <span style="font-size:22px;font-weight:700;color:${color}">${Math.round(sData.score*100)}%</span>
              </div>`;
            card.style.display = "block";
          }
        }
      } catch {}
    }

    document.getElementById("downloadGroup").style.display = "flex";
    document.getElementById("fileBadge").textContent = "Done";
    toast("Done! ✓", "success");
    saveFileHistory(selectedFile.name, lang, fileResults.transcript, fileResults.translations[lang]||"");

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
  const card = document.createElement("div");
  card.className = "result-card"; card.id = cardId;
  card.innerHTML = `
    <div class="result-card-head">
      <span>Translation — ${escapeHtml(lang)}</span>
      <button class="icon-action" onclick="copyText('${bodyId}')"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg></button>
    </div>
    <div class="result-card-body" id="${bodyId}"></div>`;
  container.appendChild(card);
}

async function streamFileTranslation(text, lang, bodyId) {
  return new Promise(async (resolve) => {
    try {
      const res = await fetch(`${API}/translate/stream`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ text, target_language: lang })
      });
      if (!res.ok) { resolve(""); return; }
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ""; let full = "";
      const el = document.getElementById(bodyId);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") { resolve(full); return; }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.token) { full += parsed.token; if (el) el.textContent = full; }
          } catch {}
        }
      }
      resolve(full);
    } catch { resolve(""); }
  });
}

function showCard(type, text) {
  const card = document.getElementById("card-" + type);
  const body = document.getElementById("res-" + type);
  if (card) card.style.display = "block";
  if (body) body.textContent = text;
}

function hideAllCards() {
  ["transcript","summary"].forEach(t => {
    const card = document.getElementById("card-" + t);
    const body = document.getElementById("res-" + t);
    if (card) card.style.display = "none";
    if (body) body.textContent = "";
  });
  const sentCard = document.getElementById("card-sentiment-file");
  if (sentCard) sentCard.style.display = "none";
}

function clearFileResults() {
  hideAllCards();
  fileResults = { transcript:"", translations:{}, summary:"" };
  document.getElementById("translations-container").innerHTML = "";
  document.getElementById("resultsEmpty").style.display = "flex";
  document.getElementById("downloadGroup").style.display = "none";
  document.getElementById("fileBadge").textContent = "Idle";
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

function downloadTxt() {
  let out = "";
  if (fileResults.transcript) out += `TRANSCRIPT:\n${fileResults.transcript}\n\n`;
  Object.entries(fileResults.translations).forEach(([lang,text]) => {
    if (text) out += `TRANSLATION (${lang}):\n${text}\n\n`;
  });
  if (fileResults.summary) out += `SUMMARY:\n${fileResults.summary}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([out.trim()], { type:"text/plain" }));
  a.download = `polyglot_${Date.now()}.txt`;
  a.click();
  toast("Downloaded TXT", "success");
}

function downloadPDFFile() { downloadPDF(fileResults); }
function downloadLivePDF() {
  downloadPDF({ transcript: liveTranscriptFull, translations: { [sessionLang]: liveTranslationFull }, summary: "" });
}

async function downloadPDF(results) {
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
  doc.text("PolyglotAI — Speech Translation Report", margin, 9);
  doc.setTextColor(200,200,255); doc.setFontSize(8); doc.setFont("helvetica","normal");
  doc.text(new Date().toLocaleString(), pageW-margin, 9, { align:"right" });
  y = 24; doc.setTextColor(30,30,30);
  function addSection(title, body, color) {
    if (!body) return;
    doc.setFontSize(10); doc.setFont("helvetica","bold"); doc.setTextColor(...color);
    doc.text(title, margin, y); y += 5;
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
  doc.save(`polyglot_${Date.now()}.pdf`);
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

let agentTranscript   = "";
let agentDetectedLang = "";

async function agentAnalyze() {
  if (!selectedFile) { toast("Please upload a file first", "error"); return; }

  const btn  = document.getElementById("agentBtn");
  const prog = document.getElementById("fileProgress");
  const pmsg = document.getElementById("fileProgressMsg");

  btn.disabled = true;
  prog.style.display = "block";
  pmsg.style.display = "block";
  pmsg.textContent = "🤖 Agent is analyzing your audio…";
  document.getElementById("fileBadge").textContent = "Analyzing…";
  document.getElementById("resultsEmpty").style.display = "none";

  // Remove old panel if any
  const oldPanel = document.getElementById("agentPanel");
  if (oldPanel) oldPanel.remove();

  try {
    const lang = document.getElementById("fileLang").value;
    const fd   = new FormData();
    fd.append("file", selectedFile);
    fd.append("target_language", lang);

    const res  = await fetch(`${API}/agent/analyze`, { method: "POST", body: fd });
    if (!res.ok) throw new Error("Agent analysis failed");
    const data = await res.json();

    agentTranscript   = data.transcript;
    agentDetectedLang = data.detected_lang;

    // Show transcript immediately
    fileResults.transcript = data.transcript;
    showCard("transcript", data.transcript);
    showKeywords(data.keywords);
    await ragStore(data.transcript, data.session_id, document.getElementById("fileLang").value);
    setTimeout(() => document.getElementById("ragChatCard")?.scrollIntoView({behavior:"smooth"}), 500);
    if (data.detected_lang)
      showLanguageConfidence(data.detected_lang, null);

    // Show suggestion panel
    _showAgentPanel(data.suggestions, lang, data.duration_secs, data.word_count);

    document.getElementById("fileBadge").textContent = "Agent Ready";
    toast("✅ Transcribed — confirm steps below", "success");

  } catch (err) {
    toast("Agent error: " + err.message, "error");
    document.getElementById("fileBadge").textContent = "Error";
    document.getElementById("resultsEmpty").style.display = "flex";
  } finally {
    prog.style.display = "none";
    pmsg.style.display = "none";
    btn.disabled = false;
  }
}

function _showAgentPanel(suggestions, lang, durationSecs, wordCount) {
  const panel = document.createElement("div");
  panel.id = "agentPanel";
  panel.style.cssText = `
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 20px;
    margin: 14px 0;
  `;

  const info = durationSecs
    ? `<div style="font-size:11px;color:var(--text3);margin-bottom:12px">
         ⏱ ~${durationSecs}s · ${wordCount} words
       </div>`
    : "";

  panel.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:4px;color:var(--accent)">
      🤖 Agent Suggestions
    </div>
    ${info}
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
      ${suggestions.map(s => `
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">
          <input type="checkbox" id="agent-chk-${s.tool}" ${s.enabled ? "checked" : ""}
            style="width:15px;height:15px;margin-top:2px;accent-color:var(--accent);cursor:pointer;flex-shrink:0">
          <span>
            <strong>${_agentToolLabel(s.tool)}</strong>
            <span style="color:var(--text2);margin-left:6px;font-size:12px">${escapeHtml(s.reason)}</span>
          </span>
        </label>
      `).join("")}
    </div>
    <button onclick="_agentRun('${lang}')" style="
      background:var(--accent);color:#fff;border:none;border-radius:8px;
      padding:10px 0;font-size:13px;font-weight:600;cursor:pointer;width:100%;
    ">▶ Run Selected</button>
  `;

  // Insert after dropzone
  const dropZone = document.getElementById("dropZone");
  if (dropZone) dropZone.parentNode.insertBefore(panel, dropZone.nextSibling);
}

function _agentToolLabel(tool) {
  return { translate: "🌐 Translate", summarize: "📝 Summarize", sentiment: "😊 Sentiment", diarize: "👥 Speaker Detection" }[tool] || tool;
}

async function _agentRun(lang) {
  const runTranslate = document.getElementById("agent-chk-translate")?.checked || false;
  const runSummarize = document.getElementById("agent-chk-summarize")?.checked || false;
  const runSentiment = document.getElementById("agent-chk-sentiment")?.checked || false;

  const prog = document.getElementById("fileProgress");
  const pmsg = document.getElementById("fileProgressMsg");
  prog.style.display = "block";
  pmsg.style.display = "block";
  pmsg.textContent   = "🤖 Running selected tools…";
  document.getElementById("fileBadge").textContent = "Processing…";

  // Disable run button
  const runBtn = document.querySelector("#agentPanel button");
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = "Running…"; }

  try {
    const res = await fetch(`${API}/agent/run`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        transcript:      agentTranscript,
        detected_lang:   agentDetectedLang,
        target_language: lang,
        run_translate:   runTranslate,
        run_summarize:   runSummarize,
        run_sentiment:   runSentiment,
      }),
    });

    if (!res.ok) throw new Error("Agent run failed");
    const data = await res.json();

    // Show translation
    if (data.translation) {
      applyRTL(lang);
      const cardId = `card-trans-${lang.replace(/\s|\(|\)/g, "_")}`;
      const bodyId = `res-trans-${lang.replace(/\s|\(|\)/g, "_")}`;
      addTranslationCard(lang, cardId, bodyId);
      const el = document.getElementById(bodyId);
      if (el) el.textContent = data.translation;
      fileResults.translations[lang] = data.translation;
    }

    // Show summary
    if (data.summary) {
      fileResults.summary = data.summary;
      showCard("summary", data.summary);
    }

    // Show sentiment
    if (data.sentiment) {
      const sData = data.sentiment;
      const card  = document.getElementById("card-sentiment-file");
      const body  = document.getElementById("res-sentiment-file");
      if (card && body) {
        const emoji = EMOTION_EMOJI[sData.emotion] || "😐";
        const color = SENTIMENT_COLOR[sData.sentiment] || "var(--text)";
        body.innerHTML = `
          <div style="display:flex;align-items:center;gap:14px">
            <span style="font-size:32px">${emoji}</span>
            <div style="flex:1">
              <div style="font-weight:600;color:${color};text-transform:capitalize">${sData.sentiment} · ${sData.emotion}</div>
              <div style="font-size:12px;color:var(--text2);margin-top:3px">${escapeHtml(sData.summary)}</div>
              ${sData.key_phrases?.length ? `<div style="margin-top:8px">${sData.key_phrases.map(p=>`<span class="phrase-tag">${escapeHtml(p)}</span>`).join("")}</div>` : ""}
            </div>
            <span style="font-size:22px;font-weight:700;color:${color}">${Math.round(sData.score*100)}%</span>
          </div>`;
        card.style.display = "block";
      }
    }

    document.getElementById("downloadGroup").style.display = "flex";
    document.getElementById("fileBadge").textContent = "Done";
    toast("🤖 Agent done! ✓", "success");
    saveFileHistory(selectedFile.name, lang, agentTranscript, data.translation || "");

    // Remove panel
    const panel = document.getElementById("agentPanel");
    if (panel) panel.remove();

  } catch (err) {
    toast("Agent error: " + err.message, "error");
    document.getElementById("fileBadge").textContent = "Error";
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = "▶ Run Selected"; }
  } finally {
    prog.style.display = "none";
    pmsg.style.display = "none";
  }
}

// ── Global RAG state ─────────────────────────────────────────────
let ragSessionId   = "";
let ragLanguage    = "English";
let ragChatHistory = [];

// ── Show Keywords & Topics ────────────────────────────────────────
function showKeywords(kwData) {
  if (!kwData) return;

  // Remove old if exists
  const old = document.getElementById("keywordsCard");
  if (old) old.remove();

  const { topics = [], keywords = [], tag = "" } = kwData;
  if (!topics.length && !keywords.length) return;

  const card = document.createElement("div");
  card.id = "keywordsCard";
  card.style.cssText = `
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px 18px;
    margin: 12px 0;
  `;

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
      background: var(--surface2, var(--border));
      color: var(--text);
      border-radius: 20px;
      padding: 3px 10px;
      font-size: 12px;
      border: 1px solid var(--border);
    ">${escapeHtml(k)}</span>
  `).join("");

  card.innerHTML = `
    ${tag ? `<div style="font-size:12px;color:var(--text2);margin-bottom:10px;font-style:italic">📌 ${escapeHtml(tag)}</div>` : ""}
    ${topicTags ? `<div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:6px">${topicTags}</div>` : ""}
    ${kwTags    ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${kwTags}</div>` : ""}
  `;

  // Insert after transcript card
  const transcriptCard = document.getElementById("card-transcript");
  if (transcriptCard) {
    transcriptCard.parentNode.insertBefore(card, transcriptCard.nextSibling);
  }
}

// ── Initialize RAG after transcription ───────────────────────────
async function ragStore(transcript, sessionId, lang) {
  if (!transcript || !sessionId) return;
  ragSessionId = sessionId;
  ragLanguage  = lang || "English";

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
    // Show chat UI after storing
    showRagChat();
  } catch (e) {
    console.warn("[RAG] Store failed:", e);
  }
}

// ── Show RAG Chat UI ──────────────────────────────────────────────
function showRagChat() {
  const old = document.getElementById("ragChatCard");
  if (old) old.remove();

  ragChatHistory = [];

  const card = document.createElement("div");
  card.id = "ragChatCard";
  card.style.cssText = `
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px 18px;
    margin: 12px 0;
  `;

  card.innerHTML = `
    <div style="font-weight:600;font-size:14px;margin-bottom:12px;color:var(--accent)">
      💬 Ask about this transcript
    </div>
    <div id="ragMessages" style="
      max-height: 280px;
      overflow-y: auto;
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    ">
      <div style="font-size:12px;color:var(--text2);text-align:center">
        Ask anything about what was said in the audio
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <input
        id="ragInput"
        type="text"
        placeholder="e.g. What was the main topic?"
        style="
          flex:1;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 13px;
          color: var(--text);
          outline: none;
        "
        onkeydown="if(event.key==='Enter') ragAsk()"
      />
      <button onclick="ragAsk()" style="
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
  `;

  // Insert at bottom of output area
  const outputArea = document.getElementById("resultsBody") ||
                     document.querySelector(".output-area");
  if (outputArea) {
    outputArea.appendChild(card);
    setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }
}

// ── Ask RAG question ──────────────────────────────────────────────
async function ragAsk() {
  const input = document.getElementById("ragInput");
  const question = input?.value?.trim();
  if (!question) return;
  if (!ragSessionId) { toast("Please process a file first", "error"); return; }

  input.value = "";
  input.disabled = true;

  // Add user message
  _ragAddMessage("user", question);

  // Assistant message we stream tokens into
  const msgId = "rag-" + Date.now();
  _ragAddMessage("assistant", "…", msgId);
  const msgEl = document.getElementById(msgId);
  const box   = document.getElementById("ragMessages");

  try {
    const res = await fetch(`${API}/rag/ask/stream`, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        session_id: ragSessionId,
        question:   question,
        language:   ragLanguage,
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

function _ragAddMessage(role, text, id) {
  const container = document.getElementById("ragMessages");
  if (!container) return;

  const isUser = role === "user";
  const div = document.createElement("div");
  if (id) div.id = id;
  div.style.cssText = `
    max-width: 85%;
    align-self: ${isUser ? "flex-end" : "flex-start"};
    background: ${isUser ? "var(--accent)" : "var(--bg)"};
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

let studySessionId   = "";

function onStudyDragOver(e)  { e.preventDefault(); document.getElementById("studyDropZone").classList.add("drag-over"); }
function onStudyDragLeave()  { document.getElementById("studyDropZone").classList.remove("drag-over"); }
function onStudyDrop(e)      { e.preventDefault(); onStudyDragLeave(); const f = e.dataTransfer.files[0]; if(f) handleStudyFile(f); }
function onStudyZoneClick(e) { if(e.target.id==="studyFileInput") return; document.getElementById("studyFileInput").click(); }
function onStudyFileSelect(e){ const f = e.target.files[0]; if(f) handleStudyFile(f); }

function handleStudyFile(file) {
  const allowed = ["pdf","docx","doc","txt"];
  const ext = file.name.split(".").pop().toLowerCase();
  if (!allowed.includes(ext)) { toast("Use PDF, DOCX, or TXT files", "error"); return; }
  const dz = document.getElementById("studyDropZone");
  dz.classList.add("has-file");
  document.getElementById("studyDropMain").textContent = "✓ " + file.name;
  const btn = document.getElementById("studyUploadBtn");
  btn.disabled = false;
  btn._file = file;
}

async function studyUpload() {
  const btn  = document.getElementById("studyUploadBtn");
  const file = btn._file;
  if (!file) { toast("Please select a file first", "error"); return; }

  btn.disabled = true;
  btn.textContent = "Processing…";
  document.getElementById("studyBadge").textContent = "Analyzing…";
  document.getElementById("studyBadge").className = "rec-badge recording";
  document.getElementById("studyProgress").style.display = "block";
  document.getElementById("studyProgressMsg").style.display = "block";
  document.getElementById("studyProgressMsg").textContent = "📖 Extracting and analyzing your material…";
  document.getElementById("studyOutput").style.display = "none";
  document.getElementById("studyEmpty").style.display = "none";

  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API}/study/upload`, { method: "POST", headers: authHeaders(), body: fd });
    if (!res.ok) { const err = await res.json(); throw new Error(err.detail || "Upload failed"); }
    const data = await res.json();

    studySessionId = data.session_id;

    // Show stats
    document.getElementById("studyStats").style.display = "block";
    document.getElementById("studyWordCount").textContent = data.word_count.toLocaleString();
    document.getElementById("studyCharCount").textContent = data.char_count.toLocaleString();
    document.getElementById("studyFilenameLabel").textContent = data.filename;

    // Show output section
    document.getElementById("studyOutput").style.display = "flex";

    // Keywords
    _renderStudyKeywords(data.keywords);

    // Summary
    document.getElementById("studySummaryText").textContent = data.summary;

    // Reset chat
    document.getElementById("studyChatMessages").innerHTML = `
      <div style="font-size:12px;color:var(--text3);text-align:center;padding:12px 0">
        📚 Material ready — ask anything about it!
      </div>`;

    document.getElementById("studyBadge").textContent = "Ready";
    document.getElementById("studyBadge").className = "rec-badge";
    await _pushHistory({
      date: new Date().toLocaleString(),
      lang: "Study Assistant",
      transcript: data.summary,
      translation: "",
      duration: 0,
      source: "study",
      filename: data.filename
    });

    loadStudyDocuments();   // refresh the saved-documents list
    toast("✅ Material analyzed — start asking questions!", "success");

  } catch (err) {
    toast("Error: " + err.message, "error");
    document.getElementById("studyEmpty").style.display = "flex";
    document.getElementById("studyBadge").textContent = "Error";
    document.getElementById("studyBadge").className = "rec-badge";
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3z"/></svg> Analyze Material`;
    document.getElementById("studyProgress").style.display = "none";
    document.getElementById("studyProgressMsg").style.display = "none";
  }
}

function _renderStudyKeywords(kw) {
  const container = document.getElementById("studyKeywordsContainer");
  if (!container) return;
  const section = document.getElementById("studyConceptsSection");
  kw = kw || {};
  const topics   = (kw.topics   || []);
  const keywords = (kw.keywords || []);

  if (!topics.length && !keywords.length && !kw.tag) {
    if (section) section.style.display = "none";
    container.innerHTML = "";
    return;
  }
  if (section) section.style.display = "block";

  const topicChips = topics.map(t =>
    `<span class="concept-topic">${escapeHtml(t)}</span>`).join("");
  const kwChips = keywords.map(k =>
    `<span class="concept-chip">${escapeHtml(k)}</span>`).join("");

  container.innerHTML = `
    ${kw.tag ? `<div class="concept-tag">${escapeHtml(kw.tag)}</div>` : ""}
    ${topics.length ? `
      <div class="concept-group">
        <div class="concept-group-label">Topics</div>
        <div class="concept-row">${topicChips}</div>
      </div>` : ""}
    ${keywords.length ? `
      <div class="concept-group">
        <div class="concept-group-label">Concepts &amp; Terms</div>
        <div class="concept-row">${kwChips}</div>
      </div>` : ""}`;
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

    studySessionId = data.session_id;
    document.getElementById("studyEmpty").style.display  = "none";
    document.getElementById("studyOutput").style.display = "flex";
    document.getElementById("studyStats").style.display  = "block";
    document.getElementById("studyWordCount").textContent = (data.word_count || 0).toLocaleString();
    document.getElementById("studyCharCount").textContent = (data.char_count || 0).toLocaleString();
    const fn = document.getElementById("studyFilenameLabel");
    if (fn) fn.textContent = data.filename || "";

    _renderStudyKeywords(data.keywords);
    document.getElementById("studySummaryText").textContent = data.summary || "";
    document.getElementById("studyChatMessages").innerHTML = `
      <div style="font-size:12px;color:var(--text3);text-align:center;padding:12px 0">
        📚 Reopened “${escapeHtml(data.filename || "document")}” — ask anything about it!
      </div>`;
    document.getElementById("studyBadge").textContent = "Ready";
    document.getElementById("studyBadge").className   = "rec-badge";
    toast("📄 Document reopened", "success");
  } catch { toast("Could not open document", "error"); }
}

async function studyAsk() {
  const input    = document.getElementById("studyChatInput");
  const question = input?.value?.trim();
  if (!question) return;
  if (!studySessionId) { toast("Please upload a file first", "error"); return; }

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
  if (!studySessionId) { toast("Please upload a file first", "error"); return; }
  input.value = text;
  studyAsk();
}

/* ════════════════════════════════════════════════════════════════
   STUDY QUIZ — generate → answer → score
   ════════════════════════════════════════════════════════════════ */
let studyQuiz = { questions: [], answers: [], submitted: false };

async function startStudyQuiz() {
  if (!studySessionId) { toast("Upload a document first", "error"); return; }
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

function closeStudyQuiz() {
  document.getElementById("studyQuizCard").style.display = "none";
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

// ── 1. Language Confidence Display ───────────────────────────────
function showLanguageConfidence(lang, confidence) {
  const el = document.getElementById("fileDetectedLang");
  if (!el) return;
  if (confidence !== null && confidence !== undefined) {
    el.innerHTML = `Detected: <strong>${lang.toUpperCase()}</strong> <span style="color:var(--green2);font-size:11px">${confidence}% confident</span>`;
  } else {
    el.textContent = `Detected: ${lang.toUpperCase()}`;
  }
}


// ── 2. Auto-Chapters ──────────────────────────────────────────────
async function generateChapters(segments, transcript) {
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
      showChapters(data.chapters);
    }
  } catch (e) {
    console.warn("[Chapters] Failed:", e);
  }
}

function showChapters(chapters) {
  // Remove old card if exists
  document.getElementById("chaptersCard")?.remove();

  const card = document.createElement("div");
  card.id = "chaptersCard";
  card.className = "result-card";
  card.style.cssText = "margin-bottom:0";

  const items = chapters.map((ch, i) => `
    <div style="display:flex;align-items:center;gap:12px;padding:8px 0;${i < chapters.length-1 ? 'border-bottom:1px solid var(--border)' : ''}">
      <span style="
        background:var(--purple-dim);color:var(--purple);
        border-radius:6px;padding:3px 8px;font-size:11px;
        font-weight:700;font-family:'JetBrains Mono',monospace;
        white-space:nowrap;min-width:44px;text-align:center;
      ">${ch.time_fmt}</span>
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

  // Insert after transcript card
  const transcriptCard = document.getElementById("card-transcript");
  if (transcriptCard) {
    transcriptCard.parentNode.insertBefore(card, transcriptCard.nextSibling);
  } else {
    const resultsBody = document.getElementById("resultsBody") || document.querySelector(".output-area");
    if (resultsBody) resultsBody.prepend(card);
  }
}


// ── 3. Speaker Profiling ──────────────────────────────────────────
async function generateSpeakerProfiles(diarizedSegments) {
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
    if (data.profiles) showSpeakerProfiles(data.profiles);
  } catch (e) {
    console.warn("[Profiling] Failed:", e);
  }
}

function showSpeakerProfiles(profiles) {
  document.getElementById("speakerProfilesCard")?.remove();

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
            ${speaker.replace("Speaker ", "")}
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
  card.id = "speakerProfilesCard";
  card.className = "result-card";
  card.innerHTML = `
    <div class="result-card-head">
      <span>👥 Speaker Profiles</span>
      <span style="font-size:11px;color:var(--text3)">${Object.keys(profiles).length} speakers</span>
    </div>
    <div class="result-card-body">${cards}</div>
  `;

  // Insert after diarization card or transcript
  const outputArea = document.getElementById("resultsBody") || document.querySelector(".output-area");
  if (outputArea) outputArea.appendChild(card);
}