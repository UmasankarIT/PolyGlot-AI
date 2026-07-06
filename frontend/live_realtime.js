/* ═══════════════════════════════════════════════════════════════
   live_realtime.js — PolyglotAI v5.2 (Deepgram Real-Time)
   ═══════════════════════════════════════════════════════════════

   WHAT CHANGED FROM v5.1:
     v5.1: VAD detected speech → sent WAV chunks to Whisper → slow
     v5.2: Raw audio streams continuously to Deepgram → words appear instantly

   HOW IT WORKS:
     1. Browser opens WebSocket to /ws/live
     2. Sends config (target language)
     3. Starts mic → streams raw PCM audio bytes continuously
     4. Deepgram sends back words AS YOU SPEAK (interim)
     5. When you pause → Deepgram sends final sentence → we translate it

   ADD TO index.html (before script.js):
     <script src="live_realtime.js"></script>
═══════════════════════════════════════════════════════════════ */

let ws            = null;
let wsReady       = false;
let mediaStream   = null;
let audioContext  = null;
let processor     = null;
let liveIdToSlot  = {};   // maps a final-chunk id → its slot index, so async translations land in the right row

// Convert API URL to WebSocket URL
// https://polyglot.onrender.com → wss://polyglot.onrender.com/ws/live
function getWsUrl() {
  return API.replace(/^http/, "ws") + "/ws/live";
}


/* ═══════════════════════════════════════════════════════════════
   WEBSOCKET
═══════════════════════════════════════════════════════════════ */

function openWebSocket(targetLanguage) {
  ws      = new WebSocket(getWsUrl());
  wsReady = false;

  ws.onopen = () => {
    wsReady = true;
    console.log("[WS] Connected");

    // First message must be config
    ws.send(JSON.stringify({
      type:            "config",
      target_language: targetLanguage,
    }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "error") {
        console.warn("[WS] Server error:", data.message);
        toast("Transcription error: " + data.message, "error");
        return;
      }

      if (data.type === "interim") {
        // Partial words — show greyed out as user speaks
        showInterim(data.transcript);
        return;
      }

      if (data.type === "final") {
        // Complete sentence — show the transcript IMMEDIATELY.
        // The translation arrives separately (type "translation") so recognition
        // never waits on the LLM.
        clearInterim();
        const { transcript, id } = data;
        if (!transcript) return;

        chunkCounter++;
        const slotIndex = liveTranscriptChunks.length;
        liveTranscriptChunks.push(transcript);
        // Back-compat: newer server sends translation:"" here + a separate
        // "translation" message; older server sends it inline. Handle both.
        liveTranslationChunks.push(data.translation || "");
        if (id !== undefined && id !== null) liveIdToSlot[id] = slotIndex;
        liveTranscriptFull = liveTranscriptChunks.join("\n");

        setLiveText("transcript", liveTranscriptFull);
        applyRTL(document.getElementById("liveLang").value);
        addChunkLogEntry(chunkCounter, transcript, "", slotIndex);   // shows "translating…"
        if (data.translation) {
          liveTranslationFull = liveTranslationChunks.filter(Boolean).join("\n");
          setLiveText("translation", liveTranslationFull);
          updateChunkLogTranslation(slotIndex, data.translation);
        }

        const sentBtn = document.getElementById("liveSentimentBtn");
        if (sentBtn) sentBtn.style.display = "flex";

        const badge = document.getElementById("recBadge");
        if (badge) { badge.textContent = "Recording"; badge.className = "rec-badge recording"; }
        return;
      }

      if (data.type === "translation") {
        // Async translation for a previously-shown final chunk.
        const slotIndex = liveIdToSlot[data.id];
        if (slotIndex === undefined) return;
        liveTranslationChunks[slotIndex] = data.translation || "";
        liveTranslationFull = liveTranslationChunks.filter(Boolean).join("\n");
        setLiveText("translation", liveTranslationFull);
        applyRTL(document.getElementById("liveLang").value);
        updateChunkLogTranslation(slotIndex, data.translation || "");
        return;
      }

    } catch (e) {
      console.warn("[WS] Bad message:", e);
    }
  };

  ws.onerror = () => { wsReady = false; };

  ws.onclose = () => {
    wsReady = false;
    if (isLive) {
      setTimeout(() => { if (isLive) openWebSocket(targetLanguage); }, 1000);
    }
  };
}

function closeWebSocket() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
    wsReady = false;
  }
}


/* ═══════════════════════════════════════════════════════════════
   INTERIM TEXT — greyed out partial words shown while speaking
═══════════════════════════════════════════════════════════════ */

let interimEl = null;

function showInterim(text) {
  if (!interimEl) {
    interimEl = document.createElement("div");
    interimEl.className = "live-interim";
    const txEl = document.getElementById("liveTranscriptContent");
    if (txEl) txEl.parentNode.appendChild(interimEl);
  }
  interimEl.textContent = text + "…";

  const badge = document.getElementById("recBadge");
  if (badge) { badge.textContent = "Speaking…"; badge.className = "rec-badge recording"; }
}

function clearInterim() {
  if (interimEl) { interimEl.remove(); interimEl = null; }
}


/* ═══════════════════════════════════════════════════════════════
   MIC STREAMING — capture raw PCM audio and send to WebSocket
   Deepgram expects: PCM 16-bit, 16kHz, mono
═══════════════════════════════════════════════════════════════ */

async function startMicStream() {
  try {
    // Request mic access
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // Create audio context at 16kHz (what Deepgram expects)
    audioContext = new AudioContext({ sampleRate: 16000 });

    const source = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessor captures raw audio samples
    // bufferSize 4096 = sends audio to Deepgram every ~256ms
    processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!wsReady) return;

      // Get raw float32 audio samples
      const float32 = e.inputBuffer.getChannelData(0);

      // Convert float32 (-1 to 1) → int16 (-32768 to 32767)
      // Deepgram expects 16-bit PCM
      const int16 = float32ToInt16(float32);

      // Send raw bytes over WebSocket
      ws.send(int16.buffer);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    console.log("[MIC] Streaming started");

  } catch (e) {
    if (e.name === "NotAllowedError") {
      toast("Microphone access denied — check browser permissions", "error");
    } else {
      toast("Could not start microphone: " + e.message, "error");
    }
    stopLive();
  }
}

function stopMicStream() {
  if (processor) {
    processor.disconnect();
    processor = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  clearInterim();
}

// Convert Float32Array to Int16Array
function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped * 32767;
  }
  return int16;
}


/* ═══════════════════════════════════════════════════════════════
   MAIN START / STOP
═══════════════════════════════════════════════════════════════ */

async function startLive() {
  if (isLive) return;
  isLive   = true;
  liveSecs = 0;
  liveIdToSlot = {};

  const lang = document.getElementById("liveLang")?.value || "Hindi";

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

  // Step 1: Open WebSocket
  openWebSocket(lang);

  // Step 2: Wait for WebSocket to be ready, then start mic
  // Poll every 100ms until connected (max 3 seconds)
  let waited = 0;
  while (!wsReady && waited < 3000) {
    await new Promise(r => setTimeout(r, 100));
    waited += 100;
  }

  if (!wsReady) {
    toast("Could not connect to server", "error");
    stopLive();
    return;
  }

  // Step 3: Start mic streaming
  await startMicStream();

  document.getElementById("recBadge").textContent = "Recording";
}

function stopLive() {
  if (!isLive) return;
  isLive = false;

  stopMicStream();
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