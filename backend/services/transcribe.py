import os, io, logging, asyncio
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
from groq import Groq

logger = logging.getLogger(__name__)

async def transcribe_audio(audio_bytes: bytes, filename: str, language: str = None) -> dict:
    """
    Returns {"text": str, "language": str}
    Pass language="en" to force English and avoid Whisper mis-detecting
    short chunks as Javanese, Korean, etc.
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
            model="whisper-large-v3-turbo",  # faster + better on short live chunks than v3
            response_format="verbose_json",
            temperature=0.0,
            prompt="Transcribe exactly what is spoken. This may be in any language including Telugu, Hindi, Tamil, or English.",
        )
        # Only pin the language if explicitly provided
        if language:
            kwargs["language"] = language

        # FIX: use get_running_loop() instead of deprecated get_event_loop()
        loop = asyncio.get_running_loop()
        transcription = await loop.run_in_executor(
            None, lambda: client.audio.transcriptions.create(**kwargs)
        )
        text     = transcription.text.strip()     if hasattr(transcription, "text")     else ""
        detected = transcription.language.strip() if hasattr(transcription, "language") else (language or "")
        logger.info(f"Transcribed '{filename}': {len(text)} chars, lang={detected}")
        return {"text": text, "language": detected}
    except Exception as e:
        logger.error(f"Whisper error for '{filename}': {e}")
        raise