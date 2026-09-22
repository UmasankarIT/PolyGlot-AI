"""
transcribe.py — PolyglotAI Transcription Service v5.3
  + Deepgram Nova-3 fallback for large files (>20MB) — whole file in one
    request, no chunking. Groq Whisper remains the default for small files.
"""
import os, io, logging, asyncio, re
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq
import httpx

logger = logging.getLogger(__name__)

# Groq's hosted Whisper caps request bodies at ~25MB — anything near that goes
# to Deepgram Nova-3 instead (handles 100MB+ files in a single request).
DEEPGRAM_FALLBACK_BYTES = 20 * 1024 * 1024
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")

_ISO_LANG = re.compile(r"^[a-z]{2,3}$")


def _words_to_segments(words: list) -> list:
    """Group Deepgram word timings into whisper-style segments (split on long pauses)."""
    segments = []
    current = []
    prev_end = None
    for w in words:
        start = float(w.get("start", 0) or 0)
        end   = float(w.get("end", 0) or 0)
        if current and prev_end is not None and (start - prev_end) > 1.5:
            segments.append(current)
            current = []
        current.append(w)
        prev_end = end
    if current:
        segments.append(current)

    out = []
    for seg in segments:
        text = " ".join((w.get("punctuated_word") or w.get("word") or "").strip() for w in seg).strip()
        if text:
            out.append({
                "start": round(float(seg[0]["start"]), 2),
                "end":   round(float(seg[-1]["end"]), 2),
                "text":  text,
            })
    return out


async def _transcribe_deepgram(audio_bytes: bytes, filename: str, language: str = None) -> dict:
    """Pre-recorded transcription via Deepgram — handles very large files in one shot."""
    if not DEEPGRAM_API_KEY:
        raise RuntimeError("DEEPGRAM_API_KEY is not set — cannot process large file")

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "webm"
    mime_map = {
        "mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4",
        "mp4": "audio/mp4",  "webm": "audio/webm", "ogg": "audio/ogg",
        "flac": "audio/flac", "aac": "audio/aac",
    }
    mime = mime_map.get(ext, "audio/webm")

    # language=multi → auto-detect (Nova-3 has improved Indic coverage: te/hi/ta/bn/mr).
    # If the caller passed an ISO code (e.g. "te"), pin it instead.
    lang_param = "multi"
    if language and _ISO_LANG.match(language.strip()):
        lang_param = language.strip()

    url = "https://api.deepgram.com/v1/listen"
    params = {"model": "nova-3", "language": lang_param, "smart_format": "true", "words": "true", "punctuate": "true"}
    request_headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}", "Content-Type": mime}

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(url, params=params, headers=request_headers, content=audio_bytes)
        if resp.status_code != 200:
            logger.error(f"[Deepgram] HTTP {resp.status_code}: {resp.text[:500]}")
            raise RuntimeError(f"Deepgram transcription failed: HTTP {resp.status_code}: {resp.text[:200]}")

        data = resp.json()
        alt = ((data.get("results") or {}).get("channels") or [{}])[0].get("alternatives") or [{}]
        alt = alt[0] if alt else {}

        text = (alt.get("transcript") or "").strip()
        lang = alt.get("language") or ""
        confidence = alt.get("confidence") or 0
        words = alt.get("words") or []

        logger.info(f"[Deepgram] Transcribed '{filename}': {len(text)} chars, lang={lang} ({round(confidence*100,1)}%), {len(words)} words")
        return {
            "text":                text,
            "language":            lang,
            "language_confidence": round(float(confidence) * 100, 1) if confidence else None,
            "segments":            _words_to_segments(words),
        }


async def transcribe_audio(audio_bytes: bytes, filename: str, language: str = None) -> dict:
    # Large files → Deepgram Nova-3 (Groq's 25MB cap can't handle them).
    if len(audio_bytes) > DEEPGRAM_FALLBACK_BYTES:
        try:
            return await _transcribe_deepgram(audio_bytes, filename, language)
        except Exception as e:
            logger.warning(f"Deepgram fallback failed for '{filename}', trying Groq: {e}")
            # fall through — Groq will succeed for 20–25MB files and 413 for the rest.

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