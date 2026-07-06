import os, asyncio, logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from backend.services.transcribe import transcribe_audio
from backend.services.translate import translate_text, LANGUAGE_MAP
from backend.services.summarize import summarize_text
from backend.services.sentiment import analyze_sentiment
from backend.services.keywords import extract_keywords

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

ALLOWED_EXTS   = {"mp3", "wav", "m4a", "mp4", "webm", "ogg", "flac", "aac"}
MAX_FILE_BYTES = 25 * 1024 * 1024

SPEAKER_CUES = [
    "he said", "she said", "they said", "according to",
    "speaker", "interviewer", "interviewee", "host", "guest",
    "question", "answer", "i asked", "replied", "responded",
]


class AgentRunRequest(BaseModel):
    transcript:      str
    detected_lang:   str
    target_language: str
    session_id:      str = ""
    run_translate:   bool = True
    run_summarize:   bool = False
    run_sentiment:   bool = False


@router.post("/agent/analyze")
@limiter.limit("20/minute")
async def agent_analyze(
    request: Request,
    file: UploadFile = File(...),
    target_language: str = "Hindi",
):
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, f"Unsupported file type: .{ext}")

    audio_bytes = await file.read()
    if len(audio_bytes) > MAX_FILE_BYTES:
        raise HTTPException(400, "File too large. Max 25MB.")

    result = await transcribe_audio(audio_bytes, file.filename)

    transcript = result["text"].strip()
    detected   = result["language"] or ""
    segments   = result.get("segments", [])

    if not transcript:
        raise HTTPException(500, "Could not transcribe audio.")

    # Run keyword extraction in parallel with duration calculation
    kw_result = await extract_keywords(transcript)

    # Duration from segments
    duration_secs = 0
    if segments:
        duration_secs = int(segments[-1].get("end", 0))

    # Generate session_id for RAG
    import time
    session_id = f"{file.filename}_{int(time.time())}"

    # Build suggestions
    suggestions = []

    suggestions.append({
        "tool": "translate", "enabled": True,
        "reason": f"Translate to {target_language}",
    })

    if duration_secs >= 45 or len(transcript.split()) > 80:
        suggestions.append({
            "tool": "summarize", "enabled": True,
            "reason": f"Audio is ~{duration_secs}s — summary recommended",
        })
    else:
        suggestions.append({
            "tool": "summarize", "enabled": False,
            "reason": "Audio is short — summary optional",
        })

    suggestions.append({
        "tool": "sentiment", "enabled": False,
        "reason": "Analyze emotional tone (optional)",
    })

    transcript_lower = transcript.lower()
    has_speaker_cues = any(cue in transcript_lower for cue in SPEAKER_CUES)
    if has_speaker_cues:
        suggestions.append({
            "tool": "diarize", "enabled": True,
            "reason": "Multiple speakers detected",
        })

    return {
        "transcript":    transcript,
        "detected_lang": detected,
        "duration_secs": duration_secs,
        "word_count":    len(transcript.split()),
        "suggestions":   suggestions,
        "keywords":      kw_result,   # ← NEW: always included
        "session_id":    session_id,  # ← NEW: for RAG chat
    }


@router.post("/agent/run")
@limiter.limit("20/minute")
async def agent_run(request: Request, req: AgentRunRequest):
    result = {
        "transcript":  req.transcript,
        "detected_lang": req.detected_lang,
        "session_id":  req.session_id,
    }

    async def do_translate():
        try:
            result["translation"] = (await translate_text(req.transcript, req.target_language)).strip()
        except Exception as e:
            logger.warning(f"[Agent] Translate failed: {e}")
            result["translation"] = ""

    async def do_summarize():
        try:
            result["summary"] = await summarize_text(req.transcript)
        except Exception as e:
            logger.warning(f"[Agent] Summarize failed: {e}")
            result["summary"] = ""

    async def do_sentiment():
        try:
            result["sentiment"] = await analyze_sentiment(req.transcript)
        except Exception as e:
            logger.warning(f"[Agent] Sentiment failed: {e}")
            result["sentiment"] = None

    tasks = []
    if req.run_translate: tasks.append(do_translate())
    if req.run_summarize: tasks.append(do_summarize())
    if req.run_sentiment: tasks.append(do_sentiment())

    if tasks:
        await asyncio.gather(*tasks)

    return result