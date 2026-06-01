"""
transcribe.py — PolyglotAI Transcription Service v5.2
  + language_confidence field added
"""
import os, io, logging, asyncio
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq

logger = logging.getLogger(__name__)

async def transcribe_audio(audio_bytes: bytes, filename: str, language: str = None) -> dict:
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "webm"
    mime_map = {
        "mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4",
        "mp4": "audio/mp4",  "webm": "audio/webm", "ogg": "audio/ogg",
        "flac": "audio/flac", "aac": "audio/aac",
    }
    mime = mime_map.get(ext, "audio/webm")

    try:
        audio_file = (filename, io.BytesIO(audio_bytes), mime)
        kwargs = dict(
            file=audio_file,
            model="whisper-large-v3-turbo",
            response_format="verbose_json",
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

        # Language confidence — Whisper returns this in verbose_json
        lang_confidence = None
        if hasattr(transcription, "language_probability"):
            lang_confidence = round(float(transcription.language_probability) * 100, 1)
        elif hasattr(transcription, "language_confidence"):
            lang_confidence = round(float(transcription.language_confidence) * 100, 1)

        segments = []
        if hasattr(transcription, "segments") and transcription.segments:
            for seg in transcription.segments:
                segments.append({
                    "start": round(float(getattr(seg, "start", 0)), 2),
                    "end":   round(float(getattr(seg, "end",   0)), 2),
                    "text":  getattr(seg, "text", "").strip(),
                })

        logger.info(f"Transcribed '{filename}': {len(text)} chars, lang={detected} ({lang_confidence}%), {len(segments)} segments")
        return {
            "text":                text,
            "language":            detected,
            "language_confidence": lang_confidence,
            "segments":            segments,
        }

    except Exception as e:
        logger.error(f"Whisper error for '{filename}': {e}")
        raise