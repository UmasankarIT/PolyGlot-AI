"""
websocket_live.py — PolyglotAI Real-Time WebSocket Service
=============================================================
Replaces the old HTTP POST /live/chunk with a persistent WebSocket connection.

HOW IT WORKS:
  Browser                        Server (this file)
  ──────────────────────────────────────────────────
  connects to /ws/live  ───────▶  accepts connection
  sends audio bytes     ───────▶  transcribes with Whisper
                        ◀───────  sends back transcript + translation instantly
  sends more audio      ───────▶  transcribes again
                        ◀───────  sends result again
  ... (stays connected the whole session)

WHY THIS IS BETTER THAN HTTP:
  Old way: speak → HTTP request (open) → wait → response → (close) → speak again
           each request has ~200-400ms overhead just to open/close the connection

  New way: speak → bytes over open socket → instant response
           zero connection overhead, no gaps between sentences

Add this to main.py:
  from websocket_live import router as ws_router
  app.include_router(ws_router)
"""

import asyncio
import json
import base64
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from backend.services.transcribe import transcribe_audio
from backend.services.translate import translate_text, is_hallucination

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    """
    Real-time WebSocket endpoint.

    The browser sends JSON messages in this format:
      { "audio_b64": "...", "filename": "chunk.webm", "target_language": "Hindi" }

    The server responds with JSON:
      { "transcript": "...", "translation": "...", "detected_language": "...", "skipped": false }

    If audio is too short or is a hallucination, skipped=true is returned.
    """
    await websocket.accept()
    logger.info("WebSocket connected")

    try:
        while True:
            # Wait for audio chunk from browser
            raw = await websocket.receive_text()

            try:
                data = json.loads(raw)
            except Exception:
                await websocket.send_text(json.dumps({"error": "Invalid JSON"}))
                continue

            audio_b64       = data.get("audio_b64", "")
            filename        = data.get("filename", "chunk.webm")
            target_language = data.get("target_language", "Hindi")
            language        = data.get("language")  # optional forced language e.g. "en"

            # Decode base64 audio
            try:
                audio_bytes = base64.b64decode(audio_b64)
            except Exception:
                await websocket.send_text(json.dumps({"error": "Invalid base64"}))
                continue

            # Skip very short audio (silence / noise)
            # 15000 bytes ≈ less than 0.3 seconds of audio — not worth sending to Whisper
            if len(audio_bytes) < 15000:
                await websocket.send_text(json.dumps({
                    "transcript": "", "translation": "",
                    "detected_language": "", "skipped": True
                }))
                continue

            # Transcribe with Whisper (via Groq)
            result = None
            for attempt in range(2):  # retry once on failure
                try:
                    result = await transcribe_audio(audio_bytes, filename, language=language)
                    break
                except Exception as e:
                    logger.warning(f"Whisper attempt {attempt+1} failed: {e}")
                    if attempt == 0:
                        await asyncio.sleep(0.8)  # brief pause before retry

            if result is None:
                await websocket.send_text(json.dumps({"error": "Transcription failed"}))
                continue

            transcript = result["text"].strip()

            # Filter out Whisper hallucinations (fake words it generates for silence)
            if not transcript or is_hallucination(transcript):
                await websocket.send_text(json.dumps({
                    "transcript": "", "translation": "",
                    "detected_language": result["language"], "skipped": True
                }))
                continue

            # Translate the transcript
            try:
                translation = await translate_text(transcript, target_language)
            except Exception as e:
                logger.warning(f"Translation failed: {e}")
                translation = ""

            # Send result back to browser instantly
            await websocket.send_text(json.dumps({
                "transcript":        transcript,
                "translation":       translation.strip(),
                "detected_language": result["language"],
                "skipped":           False
            }))

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_text(json.dumps({"error": str(e)}))
        except Exception:
            pass