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

import os, asyncio, logging, json
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")
from groq import Groq
from backend.config import GROQ_LLM_MODEL, llm_call_kwargs, stream_chat
from typing import Optional
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from backend.auth import bearer_scheme, get_current_user
from backend.store import (
    save_session, get_content, list_sessions, delete_session, optional_user_id,
    authorized_content,
)


def _authorize_transcript(session_id: str, credentials) -> str:
    """Return the stored transcript or raise 404/403 based on ownership."""
    status, content = authorized_content(session_id, "transcript", optional_user_id(credentials))
    if status == "not_found":
        raise HTTPException(404, "Transcript not found. Please re-process the file first.")
    if status == "forbidden":
        raise HTTPException(403, "You don't have access to this transcript.")
    return content

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


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
async def rag_store(
    request: Request,
    req: StoreRequest,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
):
    """
    Store a transcript for RAG chat (persisted; survives restarts).
    Call this after transcription completes.
    """
    if not req.transcript.strip():
        raise HTTPException(400, "Transcript cannot be empty")
    if len(req.session_id.strip()) < 3:
        raise HTTPException(400, "Invalid session_id")

    save_session(
        req.session_id, "transcript", req.transcript.strip(),
        meta={"detected_lang": req.detected_lang},
        user_id=optional_user_id(credentials),
    )
    logger.info(f"[RAG] Stored transcript for session: {req.session_id} ({len(req.transcript)} chars)")
    return {"stored": True, "session_id": req.session_id}


@router.post("/rag/ask")
@limiter.limit("30/minute")
async def rag_ask(request: Request, req: AskRequest,
                  credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """
    Ask a question about a stored transcript.
    Returns an answer grounded in the transcript content.
    """
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty")

    transcript = _authorize_transcript(req.session_id, credentials)

    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    system = _rag_system_prompt(transcript, req.language)

    def _call():
        return client.chat.completions.create(
            model=GROQ_LLM_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": req.question.strip()},
            ],
            temperature=0.2,
            max_tokens=512,
            **llm_call_kwargs(),
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


@router.post("/rag/ask/stream")
@limiter.limit("30/minute")
async def rag_ask_stream(request: Request, req: AskRequest,
                         credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """Streaming version of /rag/ask — yields the answer token-by-token (SSE)."""
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty")
    transcript = _authorize_transcript(req.session_id, credentials)
    system = _rag_system_prompt(transcript, req.language)

    async def gen():
        try:
            async for tok in stream_chat(system, req.question.strip(), temperature=0.2, max_tokens=512):
                yield f"data: {json.dumps({'token': tok})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/rag/list")
async def rag_list(user: dict = Depends(get_current_user)):
    """List the current user's saved transcripts (most recent first)."""
    return {"transcripts": list_sessions(int(user["sub"]), "transcript", limit=50)}


@router.delete("/rag/store/{session_id}")
async def rag_clear(session_id: str,
                    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """Delete a stored transcript (only the owner may delete an owned transcript)."""
    status, _ = authorized_content(session_id, "transcript", optional_user_id(credentials))
    if status == "forbidden":
        raise HTTPException(403, "You don't have access to this transcript.")
    delete_session(session_id, "transcript")
    return {"cleared": True}