"""
agent.py — PolyglotAI Smart Agent
===================================
An AI agent that analyzes uploaded audio and DECIDES what to run.

HOW IT WORKS:
  Step 1 → /agent/analyze  : transcribe + detect language + estimate duration
                              returns suggested tools with reasons
  Step 2 → user confirms   : frontend shows checkboxes, user picks
  Step 3 → /agent/run      : runs only the confirmed tools, returns all results

TOOLS AVAILABLE:
  transcribe  → always runs (required)
  translate   → suggested if detected language != target language
  summarize   → suggested if audio duration > 60 seconds
  sentiment   → off by default, user can enable
  diarize     → suggested if transcript has multiple speaker cues
"""

import os, asyncio, logging
from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
from slowapi import Limiter
from slowapi.util import get_remote_address

from backend.services.transcribe import transcribe_audio
from backend.services.translate import translate_text, LANGUAGE_MAP
from backend.services.summarize import summarize_text
from backend.services.sentiment import analyze_sentiment

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

ALLOWED_EXTS   = {"mp3", "wav", "m4a", "mp4", "webm", "ogg", "flac", "aac"}
MAX_FILE_BYTES = 25 * 1024 * 1024

# Speaker cue words — if transcript contains these, suggest diarization
SPEAKER_CUES = [
    "he said", "she said", "they said", "according to",
    "speaker", "interviewer", "interviewee", "host", "guest",
    "question", "answer", "i asked", "replied", "responded",
]


class AgentRunRequest(BaseModel):
    transcript:      str
    detected_lang:   str
    target_language: str
    run_translate:   bool = True
    run_summarize:   bool = False
    run_sentiment:   bool = False


# ── Step 1: Analyze ───────────────────────────────────────────────
@router.post("/agent/analyze")
@limiter.limit("20/minute")
async def agent_analyze(
    request: Request,
    file: UploadFile = File(...),
    target_language: str = "Hindi",
):
    """
    Transcribes the audio and returns suggested tools with reasons.
    Frontend shows these as checkboxes for user to confirm.
    """
    # Validate file
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, f"Unsupported file type: .{ext}")

    audio_bytes = await file.read()
    if len(audio_bytes) > MAX_FILE_BYTES:
        raise HTTPException(400, "File too large. Max 25MB.")

    # Step 1 — Transcribe
    result     = await transcribe_audio(audio_bytes, file.filename)
    transcript = result["text"].strip()
    detected   = result["language"] or ""
    segments   = result.get("segments", [])

    if not transcript:
        raise HTTPException(500, "Could not transcribe audio.")

    # Step 2 — Estimate duration from segments
    duration_secs = 0
    if segments:
        duration_secs = int(segments[-1].get("end", 0))

    # Step 3 — Agent decides suggested tools
    suggestions = []

    # Always suggest translate if language differs from target
    should_translate = True  # always useful
    suggestions.append({
        "tool":    "translate",
        "enabled": True,
        "reason":  f"Translate to {target_language}",
    })

    # Suggest summarize only if audio is long enough
    if duration_secs >= 45 or len(transcript.split()) > 80:
        suggestions.append({
            "tool":    "summarize",
            "enabled": True,
            "reason":  f"Audio is {'~'+str(duration_secs)+'s' if duration_secs else 'long'} — summary recommended",
        })
    else:
        suggestions.append({
            "tool":    "summarize",
            "enabled": False,
            "reason":  "Audio is short — summary optional",
        })

    # Suggest sentiment — off by default, user chooses
    suggestions.append({
        "tool":    "sentiment",
        "enabled": False,
        "reason":  "Analyze emotional tone (optional)",
    })

    # Suggest diarization if speaker cues found
    transcript_lower = transcript.lower()
    has_speaker_cues = any(cue in transcript_lower for cue in SPEAKER_CUES)
    speaker_count    = len(set(seg.get("speaker","") for seg in segments if seg.get("speaker")))

    if has_speaker_cues or speaker_count > 1:
        suggestions.append({
            "tool":    "diarize",
            "enabled": True,
            "reason":  "Multiple speakers detected",
        })

    return {
        "transcript":      transcript,
        "detected_lang":   detected,
        "duration_secs":   duration_secs,
        "word_count":      len(transcript.split()),
        "suggestions":     suggestions,
    }


# ── Step 2: Run confirmed tools ───────────────────────────────────
@router.post("/agent/run")
@limiter.limit("20/minute")
async def agent_run(request: Request, req: AgentRunRequest):
    """
    Runs only the tools the user confirmed.
    Returns all results in one response.
    """
    result = {
        "transcript": req.transcript,
        "detected_lang": req.detected_lang,
    }

    tasks = []

    async def do_translate():
        try:
            translation = await translate_text(req.transcript, req.target_language)
            result["translation"] = translation.strip()
        except Exception as e:
            logger.warning(f"[Agent] Translate failed: {e}")
            result["translation"] = ""

    async def do_summarize():
        try:
            summary = await summarize_text(req.transcript)
            result["summary"] = summary
        except Exception as e:
            logger.warning(f"[Agent] Summarize failed: {e}")
            result["summary"] = ""

    async def do_sentiment():
        try:
            sentiment = await analyze_sentiment(req.transcript)
            result["sentiment"] = sentiment
        except Exception as e:
            logger.warning(f"[Agent] Sentiment failed: {e}")
            result["sentiment"] = None

    if req.run_translate:  tasks.append(do_translate())
    if req.run_summarize:  tasks.append(do_summarize())
    if req.run_sentiment:  tasks.append(do_sentiment())

    # Run all confirmed tools in parallel
    if tasks:
        await asyncio.gather(*tasks)

    return result