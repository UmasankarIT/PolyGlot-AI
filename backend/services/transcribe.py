"""
transcribe.py — PolyglotAI Transcription Service v5.1
======================================================
WHAT CHANGED FROM v5.0:
  Now returns `segments` in addition to `text` and `language`.
  Segments are needed for speaker diarization — they contain
  timestamps for each sentence so we know WHEN each word was spoken.

  Old return: {"text": "...", "language": "en"}
  New return: {"text": "...", "language": "en", "segments": [...]}

  segments format:
  [
    {"start": 0.0, "end": 2.3, "text": "Hello everyone"},
    {"start": 2.5, "end": 5.1, "text": "Welcome to the meeting"},
    ...
  ]
"""

import os, io, logging, asyncio
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq

logger = logging.getLogger(__name__)

async def transcribe_audio(audio_bytes: bytes, filename: str, language: str = None) -> dict:
    """
    Transcribe audio using Whisper via Groq.

    Returns:
        {
            "text":     full transcript string,
            "language": detected language code (e.g. "en", "te", "hi"),
            "segments": list of timed segments for diarization
                        [{"start": 0.0, "end": 2.3, "text": "..."}, ...]
        }
    """
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "webm"
    mime_map = {
        "mp3":  "audio/mpeg",
        "wav":  "audio/wav",
        "m4a":  "audio/mp4",
        "mp4":  "audio/mp4",
        "webm": "audio/webm",
        "ogg":  "audio/ogg",
        "flac": "audio/flac",
        "aac":  "audio/aac",
    }
    mime = mime_map.get(ext, "audio/webm")

    try:
        audio_file = (filename, io.BytesIO(audio_bytes), mime)

        kwargs = dict(
            file=audio_file,
            model="whisper-large-v3-turbo",
            response_format="verbose_json",   # verbose_json returns segments with timestamps
            temperature=0.0,
            prompt="Transcribe exactly what is spoken. This may be in any language including Telugu, Hindi, Tamil, or English.",
        )
        if language:
            kwargs["language"] = language

        loop = asyncio.get_running_loop()
        transcription = await loop.run_in_executor(
            None, lambda: client.audio.transcriptions.create(**kwargs)
        )

        text     = transcription.text.strip()     if hasattr(transcription, "text")     else ""
        detected = transcription.language.strip() if hasattr(transcription, "language") else (language or "")

        # Extract segments — each has start time, end time, and text
        # These are used by diarize.py to match speakers to words
        segments = []
        if hasattr(transcription, "segments") and transcription.segments:
            for seg in transcription.segments:
                segments.append({
                    "start": round(float(getattr(seg, "start", 0)), 2),
                    "end":   round(float(getattr(seg, "end",   0)), 2),
                    "text":  getattr(seg, "text", "").strip(),
                })

        logger.info(f"Transcribed '{filename}': {len(text)} chars, lang={detected}, {len(segments)} segments")
        return {"text": text, "language": detected, "segments": segments}

    except Exception as e:
        logger.error(f"Whisper error for '{filename}': {e}")
        raise