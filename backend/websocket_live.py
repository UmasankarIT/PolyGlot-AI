"""
websocket_live.py — PolyglotAI Real-Time WebSocket v5.2
=========================================================
WHAT CHANGED FROM v5.1:
  v5.1 used Whisper for live (slow, inaccurate on short clips)
  v5.2 uses Deepgram Nova-2 (word by word, real-time, like Google)

TWO TYPES OF RESULTS:
  interim = partial words as you speak (shown greyed out instantly)
  final   = complete sentence (translated and added to chunk log)
"""

import asyncio, json, logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from backend.services.translate import translate_text, is_hallucination
from backend.services.deepgram_live import stream_to_deepgram

logger = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    """
    Browser sends:
      First message:  { "type": "config", "target_language": "Hindi" }
      After that:     Raw PCM audio bytes (16-bit, 16kHz, mono)

    Server sends back:
      { "type": "interim",  "transcript": "hello how" }
      { "type": "final",    "transcript": "Hello, how are you?", "translation": "..." }
      { "type": "error",    "message": "..." }
    """
    await websocket.accept()
    logger.info("[WS] Client connected")

    audio_queue  = asyncio.Queue()
    result_queue = asyncio.Queue()
    target_language = "Hindi"

    try:
        # First message = config
        config_raw = await websocket.receive_text()
        config = json.loads(config_raw)
        if config.get("type") == "config":
            target_language = config.get("target_language", "Hindi")

        # Start Deepgram in background
        deepgram_task = asyncio.create_task(
            stream_to_deepgram(audio_queue, result_queue)
        )

        async def receive_audio():
            while True:
                try:
                    data = await websocket.receive_bytes()
                    await audio_queue.put(data)
                except WebSocketDisconnect:
                    break
                except Exception as e:
                    logger.warning(f"[WS] Receive error: {e}")
                    break
            await audio_queue.put(None)

        async def send_results():
            while True:
                result = await result_queue.get()
                if result is None:
                    break
                if "error" in result:
                    await websocket.send_text(json.dumps({"type": "error", "message": result["error"]}))
                    break

                transcript = result.get("transcript", "").strip()
                is_final   = result.get("is_final", False)
                if not transcript:
                    continue

                if not is_final:
                    # Partial — send immediately, browser shows greyed out
                    await websocket.send_text(json.dumps({
                        "type": "interim", "transcript": transcript
                    }))
                else:
                    if is_hallucination(transcript):
                        continue
                    translation = ""
                    try:
                        translation = await translate_text(transcript, target_language)
                    except Exception as e:
                        logger.warning(f"[WS] Translation failed: {e}")
                    await websocket.send_text(json.dumps({
                        "type": "final",
                        "transcript": transcript,
                        "translation": translation.strip(),
                    }))

        await asyncio.gather(receive_audio(), send_results())

    except WebSocketDisconnect:
        logger.info("[WS] Client disconnected")
    except Exception as e:
        logger.error(f"[WS] Error: {e}")
        try:
            await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        await audio_queue.put(None)
        if 'deepgram_task' in locals():
            deepgram_task.cancel()