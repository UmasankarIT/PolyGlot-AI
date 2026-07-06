"""
chapters_profiling.py — PolyglotAI
=====================================
Feature 1: Auto-Chapters from Whisper segments
Feature 2: Speaker Profiling from diarized transcript
"""

import os, asyncio, json, logging
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq
from backend.config import GROQ_LLM_MODEL, llm_call_kwargs
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

client_cache = None
def get_client():
    global client_cache
    if not client_cache:
        client_cache = Groq(api_key=os.getenv("GROQ_API_KEY"))
    return client_cache


# ── Models ────────────────────────────────────────────────────────

class ChaptersRequest(BaseModel):
    segments: list   # Whisper segments: [{start, end, text}, ...]
    transcript: str

class ProfilingRequest(BaseModel):
    diarized_segments: list  # [{speaker, start, end, text}, ...]
    dialogue: str


# ── Helper: format seconds to mm:ss ──────────────────────────────

def fmt_time(secs: float) -> str:
    m = int(secs // 60)
    s = int(secs % 60)
    return f"{m}:{s:02d}"


# ── Auto-Chapters ─────────────────────────────────────────────────

CHAPTERS_PROMPT = """You are an expert at analyzing speech transcripts and identifying topic changes.

Given a transcript with timestamps, identify 3-6 natural chapter breaks where the topic significantly changes.

Return ONLY a valid JSON array:
[
  {"time": 0.0, "title": "Introduction"},
  {"time": 45.2, "title": "Main Topic"},
  {"time": 120.5, "title": "Key Points"},
  {"time": 200.0, "title": "Conclusion"}
]

RULES:
- time must be a float (seconds) matching actual segment timestamps
- title must be 2-5 words, descriptive
- Return ONLY valid JSON array, no markdown, no explanation
- First chapter always starts at 0.0
- Only create chapters where topic genuinely changes
"""

@router.post("/analyze/chapters")
@limiter.limit("15/minute")
async def auto_chapters(request: Request, req: ChaptersRequest):
    """Generate auto-chapters from Whisper segments."""
    if not req.segments or len(req.segments) < 3:
        return {"chapters": [{"time": 0.0, "time_fmt": "0:00", "title": "Full Audio"}]}

    # Build timestamped transcript for LLaMA
    timestamped = "\n".join(
        f"[{fmt_time(seg.get('start', 0))}] {seg.get('text', '').strip()}"
        for seg in req.segments if seg.get('text', '').strip()
    )

    client = get_client()

    def _call():
        return client.chat.completions.create(
            model=GROQ_LLM_MODEL,
            messages=[
                {"role": "system", "content": CHAPTERS_PROMPT},
                {"role": "user", "content": f"Transcript with timestamps:\n\n{timestamped[:6000]}"}
            ],
            temperature=0.1,
            max_tokens=700,
            response_format={"type": "json_object"},
            **llm_call_kwargs(),
        )

    try:
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _call)
        raw = response.choices[0].message.content.strip()

        # Handle both array and object responses
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            chapters = parsed.get("chapters", list(parsed.values())[0] if parsed else [])
        else:
            chapters = parsed

        # Add formatted time to each chapter
        for ch in chapters:
            ch["time_fmt"] = fmt_time(float(ch.get("time", 0)))

        return {"chapters": chapters}

    except Exception as e:
        logger.warning(f"[Chapters] Failed: {e}")
        return {"chapters": [{"time": 0.0, "time_fmt": "0:00", "title": "Full Audio"}]}


# ── Speaker Profiling ─────────────────────────────────────────────

PROFILING_PROMPT = """You are an expert linguist and communication analyst.

Analyze the speech patterns of each speaker in this diarized transcript and create a brief profile for each.

Return ONLY a valid JSON object:
{
  "Speaker 1": {
    "style": "Direct and confident",
    "traits": ["Uses technical terms", "Asks clarifying questions", "Speaks in short sentences"],
    "tone": "Professional",
    "vocabulary": "Advanced",
    "summary": "A focused communicator who drives the conversation forward"
  },
  "Speaker 2": {
    ...
  }
}

RULES:
- Return ONLY valid JSON, no markdown
- traits: array of 2-4 specific observations
- tone: one word (Professional/Casual/Formal/Friendly/Assertive/Analytical)
- vocabulary: one word (Basic/Intermediate/Advanced/Technical)
- summary: one sentence max
"""

@router.post("/analyze/speaker-profiles")
@limiter.limit("10/minute")
async def speaker_profiles(request: Request, req: ProfilingRequest):
    """Generate speaker profiles from diarized transcript."""
    if not req.diarized_segments:
        raise HTTPException(400, "No diarized segments provided")

    # Group text by speaker
    speaker_texts = {}
    for seg in req.diarized_segments:
        sp = seg.get("speaker", "Speaker 1")
        text = seg.get("text", "").strip()
        if text:
            if sp not in speaker_texts:
                speaker_texts[sp] = []
            speaker_texts[sp].append(text)

    if len(speaker_texts) < 1:
        raise HTTPException(400, "No speaker data found")

    # Build dialogue sample for LLaMA
    sample = ""
    for sp, texts in speaker_texts.items():
        sample += f"\n{sp}:\n"
        sample += "\n".join(f'  "{t}"' for t in texts[:10])
        sample += "\n"

    client = get_client()

    def _call():
        return client.chat.completions.create(
            model=GROQ_LLM_MODEL,
            messages=[
                {"role": "system", "content": PROFILING_PROMPT},
                {"role": "user", "content": f"Analyze these speakers:\n{sample[:5000]}"}
            ],
            temperature=0.2,
            max_tokens=900,
            response_format={"type": "json_object"},
            **llm_call_kwargs(),
        )

    try:
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _call)
        raw = response.choices[0].message.content.strip()
        profiles = json.loads(raw)
        return {"profiles": profiles, "speaker_count": len(speaker_texts)}
    except Exception as e:
        logger.error(f"[Profiling] Failed: {e}")
        raise HTTPException(500, f"Speaker profiling failed: {str(e)}")