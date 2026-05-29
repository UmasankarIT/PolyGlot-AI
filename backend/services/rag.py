"""
rag.py — PolyglotAI RAG (Retrieval Augmented Generation)
=========================================================
WHAT THIS DOES:
  Lets users CHAT with their transcript after processing.
  
  Example:
    Transcript: "The meeting discussed Q3 budget cuts and hiring freeze..."
    User asks:  "What was decided about hiring?"
    RAG answers: "According to the transcript, a hiring freeze was discussed..."

HOW IT WORKS (Simple RAG without vector DB):
  1. /rag/store  → saves transcript in server memory (per session_id)
  2. /rag/ask    → user asks question → LLaMA answers using ONLY the transcript
  
  This is "naive RAG" — no vector embeddings needed for short transcripts.
  For production scale, swap the dict store with ChromaDB.

WHY RAG vs normal LLM:
  Normal LLM: answers from training data (may hallucinate)
  RAG:        answers ONLY from the transcript (grounded, accurate)
"""

import os, asyncio, logging
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

# In-memory store: session_id → transcript
# Simple dict for now — works well for short transcripts
# For scale: replace with ChromaDB or Redis
_transcript_store: dict[str, str] = {}

MAX_STORE = 500  # max sessions in memory


# ── Pydantic models ───────────────────────────────────────────────

class StoreRequest(BaseModel):
    session_id:  str   # unique ID for this transcript (use filename + timestamp)
    transcript:  str   # full transcript text
    detected_lang: str = "en"

class AskRequest(BaseModel):
    session_id: str    # must match a stored transcript
    question:   str    # user's question
    language:   str = "English"  # answer language


# ── RAG System Prompt ─────────────────────────────────────────────

def _rag_system_prompt(transcript: str, answer_lang: str) -> str:
    return f"""You are a helpful assistant that answers questions about a specific audio transcript.

TRANSCRIPT:
\"\"\"
{transcript[:8000]}
\"\"\"

RULES:
1. Answer ONLY based on what is in the transcript above.
2. If the answer is not in the transcript, say "This wasn't mentioned in the transcript."
3. Be concise and direct.
4. Answer in {answer_lang}.
5. Quote relevant parts of the transcript when helpful.
6. Never make up information not present in the transcript.
"""


# ── Routes ────────────────────────────────────────────────────────

@router.post("/rag/store")
@limiter.limit("30/minute")
async def rag_store(request: Request, req: StoreRequest):
    """
    Store a transcript for RAG chat.
    Call this after transcription completes.
    """
    if not req.transcript.strip():
        raise HTTPException(400, "Transcript cannot be empty")
    if len(req.session_id.strip()) < 3:
        raise HTTPException(400, "Invalid session_id")

    # Evict oldest if store is full
    if len(_transcript_store) >= MAX_STORE:
        oldest = next(iter(_transcript_store))
        del _transcript_store[oldest]

    _transcript_store[req.session_id] = req.transcript.strip()
    logger.info(f"[RAG] Stored transcript for session: {req.session_id} ({len(req.transcript)} chars)")
    return {"stored": True, "session_id": req.session_id}


@router.post("/rag/ask")
@limiter.limit("30/minute")
async def rag_ask(request: Request, req: AskRequest):
    """
    Ask a question about a stored transcript.
    Returns an answer grounded in the transcript content.
    """
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty")

    transcript = _transcript_store.get(req.session_id)
    if not transcript:
        raise HTTPException(404, "Transcript not found. Please re-process the file first.")

    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    system = _rag_system_prompt(transcript, req.language)

    def _call():
        return client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": req.question.strip()},
            ],
            temperature=0.2,
            max_tokens=512,
        )

    try:
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _call)
        answer = response.choices[0].message.content.strip()
        logger.info(f"[RAG] Answered for session: {req.session_id}")
        return {
            "answer":     answer,
            "session_id": req.session_id,
        }
    except Exception as e:
        logger.error(f"[RAG] Error: {e}")
        raise HTTPException(500, f"RAG failed: {str(e)}")


@router.delete("/rag/store/{session_id}")
async def rag_clear(session_id: str):
    """Clear a stored transcript from memory."""
    _transcript_store.pop(session_id, None)
    return {"cleared": True}