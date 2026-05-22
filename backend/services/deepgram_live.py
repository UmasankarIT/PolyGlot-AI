"""
deepgram_live.py — PolyglotAI Real-Time Streaming via Deepgram
===============================================================
WHY DEEPGRAM INSTEAD OF WHISPER FOR LIVE:
  Whisper = designed for complete audio files
             sends chunk → waits → gets result (slow, inaccurate on short clips)

  Deepgram = designed for live streaming
              words appear AS YOU SPEAK, word by word
              like Google Live Translate

HOW IT WORKS:
  Browser mic → raw audio bytes → WebSocket to our server
  Our server   → streams those bytes → Deepgram WebSocket
  Deepgram     → sends back words in real time → we translate → browser shows

SETUP:
  1. Go to https://deepgram.com → sign up (free $200 credit)
  2. Dashboard → API Keys → Create API Key → copy it
  3. Render → Environment → add:
     DEEPGRAM_API_KEY = your_key_here
"""

import os, json, asyncio, logging
import websockets
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
print(f"[Deepgram] API key loaded: {bool(os.getenv('DEEPGRAM_API_KEY'))}")

logger = logging.getLogger(__name__)

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")

# Deepgram WebSocket URL with parameters
# model=nova-2       → best accuracy model
# language=multi     → auto detect any language
# punctuate=true     → adds punctuation automatically
# interim_results    → sends partial words as you speak (shows text instantly)
# endpointing=300    → detects end of sentence after 300ms silence
DEEPGRAM_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-2"
    "&language=multi"
    "&punctuate=true"
    "&interim_results=true"
    "&utterance_end_ms=1000"
    "&endpointing=150"
    "&encoding=linear16"
    "&sample_rate=16000"
)


async def stream_to_deepgram(
    audio_queue: asyncio.Queue,
    result_queue: asyncio.Queue,
):
    """
    Opens a WebSocket to Deepgram and streams audio from audio_queue.
    Puts transcript results into result_queue.

    audio_queue: receives raw PCM audio bytes from browser
    result_queue: sends back {"transcript": "...", "is_final": bool}
    """
    if not DEEPGRAM_API_KEY:
        raise RuntimeError("DEEPGRAM_API_KEY not set in environment variables.")

    headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}

    try:
        async with websockets.connect(DEEPGRAM_URL, additional_headers=headers) as dg_ws:
            logger.info("[Deepgram] Connected")

            async def send_audio():
                """Read audio from queue and send to Deepgram."""
                while True:
                    chunk = await audio_queue.get()
                    if chunk is None:  # None = stop signal
                        # Tell Deepgram we're done sending audio
                        await dg_ws.send(json.dumps({"type": "CloseStream"}))
                        break
                    try:
                        await dg_ws.send(chunk)
                    except Exception as e:
                        logger.warning(f"[Deepgram] Send error: {e}")
                        break

            async def receive_results():
                """Receive transcript results from Deepgram and put in result_queue."""
                async for message in dg_ws:
                    try:
                        data = json.loads(message)

                        # Only process speech results (ignore metadata, etc.)
                        if data.get("type") != "Results":
                            continue

                        channel = data.get("channel", {})
                        alts    = channel.get("alternatives", [])
                        if not alts:
                            continue

                        transcript = alts[0].get("transcript", "").strip()
                        if not transcript:
                            continue

                        is_final   = data.get("is_final", False)
                        confidence = alts[0].get("confidence", 0)

                        # Skip very low confidence results
                        if confidence < 0.4:
                            continue

                        await result_queue.put({
                            "transcript": transcript,
                            "is_final":   is_final,
                            "confidence": round(confidence, 2),
                        })

                    except Exception as e:
                        logger.warning(f"[Deepgram] Parse error: {e}")

            # Run both send and receive concurrently
            await asyncio.gather(send_audio(), receive_results())

    except Exception as e:
        logger.error(f"[Deepgram] Connection error: {e}")
        await result_queue.put({"error": str(e)})
    finally:
        await result_queue.put(None)  # signal done
        logger.info("[Deepgram] Disconnected")