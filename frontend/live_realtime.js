/* ════════════════════════════════════════════════════════════════
   live_realtime.js — PolyglotAI v5.1 Real-Time Upgrade
   ════════════════════════════════════════════════════════════════

   WHAT THIS FILE DOES:
   Replaces the old SpeechRecognition-based live recording with:
     1. VAD  — detects when you're actually speaking vs silent
     2. WebSocket — persistent connection to backend (no HTTP gaps)

   HOW TO USE:
   In your index.html, BEFORE script.js, add these two lines:
     <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
     <script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/bundle.min.js"></script>

   Then in script.js, replace the startLive() and stopLive() functions
   with the ones in this file.
   Also replace _startRecognition() and _restartRecognition() with initVAD().

   ════════════════════════════════════════════════════════════════ */


// ── WebSocket state ───────────────────────────────────────────────
// ws        = the WebSocket connection object
// vadInst   = the VAD instance (Silero VAD model running in browser)
// wsReady   = true when WebSocket is open and ready to receive audio
let ws       = null;
let vadInst  = null;
let wsReady  = false;

// Build WebSocket URL from the existing API constant
// http://127.0.0.1:8000  →  ws://127.0.0.1:8000/ws/live
// https://polyglot.onrender.com  →  wss://polyglot.onrender.com/ws/live
function getWsUrl() {
  return API.replace(/^http/, "ws") + "/ws/live";
}


/* ════════════════════════════════════════════════════════════════
   WEBSOCKET — open a persistent connection to the backend
   ════════════════════════════════════════════════════════════════ */

function openWebSocket() {
  const url = getWsUrl();
  ws = new WebSocket(url);
  wsReady = false;

  ws.onopen = () => {
    wsReady = true;
    console.log("[WS] Connected to", url);
  };

  // Receive transcript + translation from backend
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      // Error from server
      if (data.error) {
        console.warn("[WS] Server error:", data.error);
        return;
      }

      // Skipped (too short / silence / hallucination)
      if (data.skipped) return;

      const { transcript, translation, detected_language } = data;

      if (!transcript) return;

      // Update detected language display
      if (detected_language) {
        const det = document.getElementById("detectedLang");
        if (det) det.textContent = `🌐 ${detected_language}`;
      }

      // Add this chunk to the full transcript display
      chunkCounter++;
      const slotIndex = liveTranscriptChunks.length;
      liveTranscriptChunks.push(transcript);
      liveTranslationChunks.push(translation || "");
      liveTranscriptFull = liveTranscriptChunks.join("\n");
      liveTranslationFull = liveTranslationChunks.filter(Boolean).join("\n");

      setLiveText("transcript", liveTranscriptFull);
      setLiveText("translation", liveTranslationFull);
      applyRTL(document.getElementById("liveLang").value);
      addChunkLogEntry(chunkCounter, transcript, translation || "", slotIndex);
      updateChunkLogTranslation(slotIndex, translation || "");

      // Show sentiment button after first result
      const sentBtn = document.getElementById("liveSentimentBtn");
      if (sentBtn) sentBtn.style.display = "flex";

    } catch (e) {
      console.warn("[WS] Bad message:", e);
    }
  };

  ws.onerror = (e) => {
    console.warn("[WS] Error:", e);
    wsReady = false;
  };

  ws.onclose = () => {
    wsReady = false;
    console.log("[WS] Closed");

    // Auto-reconnect if session is still live
    // Waits 1 second then reconnects so we don't spam the server
    if (isLive) {
      console.log("[WS] Reconnecting in 1s...");
      setTimeout(() => {
        if (isLive) openWebSocket();
      }, 1000);
    }
  };
}

function closeWebSocket() {
  if (ws) {
    ws.onclose = null; // prevent auto-reconnect on intentional close
    ws.close();
    ws = null;
    wsReady = false;
  }
}


/* ════════════════════════════════════════════════════════════════
   VAD — Voice Activity Detection
   Silero VAD model runs in the browser via ONNX Runtime Web.

   What it does:
   - Listens to mic continuously
   - onSpeechStart: you started speaking → show visual indicator
   - onSpeechEnd:   you stopped speaking → send that audio chunk to backend
   - Only real speech is sent. Silence is dropped.
   ════════════════════════════════════════════════════════════════ */

async function initVAD() {
  // Check that vad-web CDN script loaded
  if (typeof vad === "undefined") {
    console.warn("[VAD] vad-web not loaded — falling back to SpeechRecognition");
    _startRecognitionFallback();
    return;
  }

  try {
    vadInst = await vad.MicVAD.new({
      // CDN paths for the ONNX model and audio worklet
      // These match the CDN scripts you added to index.html
      onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",
      baseAssetPath:    "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/",

      // Called the moment you start speaking
      // Use this to show a "listening" indicator
      onSpeechStart: () => {
        const badge = document.getElementById("recBadge");
        if (badge) {
          badge.textContent = "Listening…";
          badge.className = "rec-badge recording";
        }
      },

      // Called when you stop speaking
      // `audioFloat32` is the captured audio as Float32Array (16kHz sample rate)
      onSpeechEnd: async (audioFloat32) => {
        const badge = document.getElementById("recBadge");
        if (badge) {
          badge.textContent = "Processing…";
          badge.className = "rec-badge";
        }

        if (!wsReady || !isLive) return;

        // Convert Float32Array → WAV → base64 so we can send over WebSocket as JSON
        const wavBytes  = float32ToWav(audioFloat32, 16000);
        const audio_b64 = arrayBufferToBase64(wavBytes);

        const lang = document.getElementById("liveLang")?.value || "Hindi";

        // Send to backend over the open WebSocket connection
        ws.send(JSON.stringify({
          audio_b64,
          filename:        "vad_chunk.wav",
          target_language: lang,
        }));
      },

      // Called when VAD thought you spoke but it was too short (cough, noise)
      onVADMisfire: () => {
        const badge = document.getElementById("recBadge");
        if (badge) badge.textContent = "Recording";
      },

      // Tune these to match your speaking pace:
      // positiveSpeechThreshold: how confident VAD needs to be that you're speaking
      // negativeSpeechThreshold: how confident it needs to be that you stopped
      // redemptionFrames: how many silent frames before it triggers onSpeechEnd
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.45,
      redemptionFrames:        10,  // ~0.96 seconds of silence before cutting
      minSpeechFrames:         4,   // ignore clips shorter than ~0.38 seconds
    });

    vadInst.start();
    console.log("[VAD] Started");

  } catch (e) {
    console.warn("[VAD] Failed to init:", e);
    toast("VAD failed, using fallback mode", "error");
    _startRecognitionFallback();
  }
}

function stopVAD() {
  if (vadInst) {
    try { vadInst.pause(); } catch {}
    vadInst = null;
  }
}


/* ════════════════════════════════════════════════════════════════
   MAIN LIVE START / STOP — replaces the old startLive() / stopLive()
   ════════════════════════════════════════════════════════════════ */

async function startLive() {
  if (isLive) return;
  isLive    = true;
  liveSecs  = 0;

  document.getElementById("micBtn").classList.add("active");
  document.getElementById("micRingOuter").classList.add("pulse");
  document.getElementById("micLabel").textContent = "Recording — tap to stop";
  document.getElementById("micTimer").style.display = "inline";
  document.getElementById("liveBadge").style.display = "inline-flex";
  document.getElementById("recBadge").textContent = "Connecting…";
  document.getElementById("recBadge").className = "rec-badge recording";
  document.getElementById("chunkStatus").style.display = "flex";

  liveTimerInt = setInterval(() => {
    liveSecs++;
    const m = String(Math.floor(liveSecs / 60)).padStart(2, "0");
    const s = String(liveSecs % 60).padStart(2, "0");
    const el = document.getElementById("micTimer");
    if (el) el.textContent = `${m}:${s}`;
  }, 1000);

  startWave();

  // Step 1: Open WebSocket to backend
  openWebSocket();

  // Step 2: Start VAD in browser
  // VAD will automatically call onSpeechEnd whenever you finish a sentence
  await initVAD();

  document.getElementById("recBadge").textContent = "Recording";
}

function stopLive() {
  if (!isLive) return;
  isLive = false;

  // Stop VAD
  stopVAD();

  // Close WebSocket
  closeWebSocket();

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

  if (liveTranscriptFull) setTimeout(() => saveSessionHistory(), 0);
}


/* ════════════════════════════════════════════════════════════════
   AUDIO HELPERS
   VAD gives us a Float32Array at 16kHz.
   We need to convert it to WAV bytes before sending over WebSocket.
   ════════════════════════════════════════════════════════════════ */

/**
 * Convert Float32Array audio samples to WAV format bytes.
 * WAV is a simple uncompressed audio format Whisper understands perfectly.
 *
 * @param {Float32Array} samples - raw audio at 16kHz
 * @param {number} sampleRate - always 16000 from VAD
 * @returns {ArrayBuffer} - WAV file as bytes
 */
function float32ToWav(samples, sampleRate) {
  const numChannels  = 1;       // mono audio
  const bitsPerSample = 16;     // 16-bit PCM
  const byteRate     = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign   = numChannels * (bitsPerSample / 8);
  const dataSize     = samples.length * (bitsPerSample / 8);
  const buffer       = new ArrayBuffer(44 + dataSize);  // 44 byte WAV header
  const view         = new DataView(buffer);

  // WAV header (standard format, don't change these)
  writeString(view, 0,  "RIFF");
  view.setUint32(4,  36 + dataSize, true);
  writeString(view, 8,  "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);          // PCM format chunk size
  view.setUint16(20, 1,  true);          // PCM format type
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Convert float samples (-1.0 to 1.0) to 16-bit integers (-32768 to 32767)
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped * 32767, true);
    offset += 2;
  }

  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary  = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}


/* ════════════════════════════════════════════════════════════════
   FALLBACK — if VAD CDN fails to load, use old SpeechRecognition
   (same as v5.0 behaviour — works but has the 200-400ms gap)
   ════════════════════════════════════════════════════════════════ */

function _startRecognitionFallback() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast("Speech recognition not supported in this browser", "error");
    stopLive();
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous      = true;
  recognition.interimResults  = true;
  recognition.maxAlternatives = 1;
  recognition.lang            = "en-US";

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
        const lang      = document.getElementById("liveLang").value;
        const slotIndex = liveTranscriptChunks.length;
        liveTranscriptChunks.push(text);
        liveTranslationChunks.push("");
        liveTranscriptFull = liveTranscriptChunks.join("\n");
        setLiveText("transcript", liveTranscriptFull);
        addChunkLogEntry(num, text, "", slotIndex);
        const sentBtn = document.getElementById("liveSentimentBtn");
        if (sentBtn) sentBtn.style.display = "flex";
        streamTranslation(text, lang, num, slotIndex);
        if (interimEl) { interimEl.remove(); interimEl = null; }
      } else {
        interim += result[0].transcript;
      }
    }
    if (interim) {
      if (!interimEl) {
        interimEl = document.createElement("div");
        interimEl.className = "live-interim";
        const txEl = document.getElementById("liveTranscriptContent");
        if (txEl) txEl.parentNode.appendChild(interimEl);
      }
      interimEl.textContent = interim + "…";
    } else if (interimEl) {
      interimEl.remove(); interimEl = null;
    }
  };

  recognition.onerror = (e) => {
    if (e.error === "no-speech") { if (isLive && recognition) _restartRecognitionFallback(); return; }
    if (e.error === "not-allowed") { toast("Microphone access denied", "error"); stopLive(); return; }
    if (isLive && recognition) _restartRecognitionFallback();
  };

  recognition.onend = () => { if (isLive && recognition) _restartRecognitionFallback(); };

  try { recognition.start(); } catch (e) { toast("Could not start microphone", "error"); stopLive(); }
}

function _restartRecognitionFallback() {
  setTimeout(() => {
    if (!isLive || !recognition) return;
    try { recognition.start(); } catch {}
  }, 300);
}