import os, asyncio, logging, json
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")

from typing import Optional
from fastapi import APIRouter, UploadFile, File, HTTPException, Request, Depends
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from backend.services.summarize import summarize_text
from backend.services.keywords import extract_keywords
from groq import Groq
from backend.config import GROQ_LLM_MODEL, llm_call_kwargs, stream_chat
from backend.auth import bearer_scheme, get_current_user
from backend.store import (
    save_session, get_content, get_session_row, list_sessions, optional_user_id,
    authorized_content, authorized_row,
)


def _authorize(session_id: str, kind: str, credentials) -> str:
    """Return the session's text or raise 404/403 based on ownership."""
    status, content = authorized_content(session_id, kind, optional_user_id(credentials))
    if status == "not_found":
        raise HTTPException(404, "Session not found. Please re-upload the file.")
    if status == "forbidden":
        raise HTTPException(403, "You don't have access to this document.")
    return content

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

ALLOWED_EXTS   = {"pdf", "docx", "txt", "doc"}
MAX_FILE_BYTES = 20 * 1024 * 1024  # 20MB


# ── Models ────────────────────────────────────────────────────────

class StudyAskRequest(BaseModel):
    session_id: str
    question:   str
    mode:       str = "tutor"  # kept for backward-compat; a single smart tutor is used


class StudyQuizRequest(BaseModel):
    session_id:    str
    num_questions: int = 5


# ── Text Extractors ───────────────────────────────────────────────

def _extract_pdf(data: bytes) -> str:
    import fitz  # PyMuPDF
    doc = fitz.open(stream=data, filetype="pdf")
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text.strip()

def _extract_docx(data: bytes) -> str:
    import io
    from docx import Document
    doc = Document(io.BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs if p.text.strip())

def _extract_txt(data: bytes) -> str:
    for enc in ("utf-8", "latin-1", "cp1252"):
        try:
            return data.decode(enc).strip()
        except Exception:
            continue
    return data.decode("utf-8", errors="ignore").strip()


def extract_text(data: bytes, filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == "pdf":
        return _extract_pdf(data)
    elif ext in ("docx", "doc"):
        return _extract_docx(data)
    elif ext == "txt":
        return _extract_txt(data)
    raise ValueError(f"Unsupported file type: .{ext}")


# ── RAG prompt for study ──────────────────────────────────────────

def _study_prompt(text: str, mode: str = "tutor") -> str:
    """A single smart-tutor prompt that adapts to whatever the student asks in
    natural language — explain, key points, examples, definitions, etc."""
    return f"""You are an expert, friendly study tutor. You are helping a student learn from the following study material:

\"\"\"
{text[:10000]}
\"\"\"

Answer the student's request using ONLY this material, adapting to what they ask:
- If they ask you to EXPLAIN something, explain it clearly and simply, with examples where helpful.
- If they ask for KEY POINTS / summary / main ideas, respond with a concise bulleted list.
- If they ask for a definition, define the concept in plain language.
- If they ask a factual question, answer directly and cite the relevant idea from the material.
- Keep answers focused and educational. Use short paragraphs or bullets — never a wall of text.
- If something is not covered in the material, say so honestly instead of inventing facts.
"""


# ── Routes ────────────────────────────────────────────────────────

@router.post("/study/upload")
@limiter.limit("10/minute")
async def study_upload(
    request: Request,
    file: UploadFile = File(...),
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
):
    """
    Upload a document → extract text → summarize → keywords → persist for chat
    """
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, f"Unsupported file type. Use PDF, DOCX, or TXT.")

    data = await file.read()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(400, "File too large. Max 20MB.")

    # Extract text
    loop = asyncio.get_running_loop()
    try:
        text = await loop.run_in_executor(None, extract_text, data, file.filename)
    except Exception as e:
        raise HTTPException(500, f"Could not read file: {str(e)}")

    if not text or len(text.strip()) < 50:
        raise HTTPException(400, "Could not extract readable text from this file.")

    # Run summary + keywords in parallel
    summary, kw = await asyncio.gather(
        summarize_text(text[:8000]),
        extract_keywords(text[:4000]),
    )

    # Persist for chat (survives restarts, tied to user when logged in)
    import time
    session_id = f"study_{file.filename}_{int(time.time())}"
    save_session(
        session_id, "study", text,
        filename=file.filename,
        meta={"summary": summary, "keywords": kw, "word_count": len(text.split())},
        user_id=optional_user_id(credentials),
    )

    return {
        "session_id":  session_id,
        "filename":    file.filename,
        "char_count":  len(text),
        "word_count":  len(text.split()),
        "summary":     summary,
        "keywords":    kw,
        "preview":     text[:300] + "..." if len(text) > 300 else text,
    }


@router.post("/study/ask")
@limiter.limit("30/minute")
async def study_ask(request: Request, req: StudyAskRequest,
                    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """Ask a question about the uploaded study material."""
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty")

    text = _authorize(req.session_id, "study", credentials)

    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    system = _study_prompt(text, req.mode)

    def _call():
        return client.chat.completions.create(
            model=GROQ_LLM_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": req.question.strip()},
            ],
            temperature=0.3,
            max_tokens=1024,
            **llm_call_kwargs(),
        )

    try:
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _call)
        return {
            "answer":     response.choices[0].message.content.strip(),
            "session_id": req.session_id,
        }
    except Exception as e:
        raise HTTPException(500, f"Study ask failed: {str(e)}")


@router.post("/study/ask/stream")
@limiter.limit("30/minute")
async def study_ask_stream(request: Request, req: StudyAskRequest,
                           credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """Streaming version of /study/ask — yields the answer token-by-token (SSE)."""
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty")
    text = _authorize(req.session_id, "study", credentials)
    system = _study_prompt(text, req.mode)

    async def gen():
        try:
            async for tok in stream_chat(system, req.question.strip(), temperature=0.3, max_tokens=1024):
                yield f"data: {json.dumps({'token': tok})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


QUIZ_SYSTEM = """You are an expert educator who writes fair, concept-focused quizzes.

Given study material, create multiple-choice questions that TEST UNDERSTANDING of the
concepts and ideas — not trivia about names, dates, or people.

Return ONLY a valid JSON object of this exact shape:
{
  "questions": [
    {
      "question": "<a clear question about a concept in the material>",
      "options": ["<option A>", "<option B>", "<option C>", "<option D>"],
      "answer": <0-based index of the correct option>,
      "explanation": "<one short sentence explaining why that answer is correct>"
    }
  ]
}

STRICT RULES:
- Return ONLY valid JSON. No markdown fences, no extra text.
- Exactly 4 options per question. Exactly one correct answer.
- Questions must be answerable from the material and focus on CONCEPTS, not names of people.
- Vary the position of the correct answer across questions.
- Keep questions and options concise and unambiguous.
"""


@router.post("/study/quiz")
@limiter.limit("15/minute")
async def study_quiz(request: Request, req: StudyQuizRequest,
                     credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """Generate a multiple-choice quiz from the uploaded study material."""
    text = _authorize(req.session_id, "study", credentials)

    n = max(3, min(int(req.num_questions or 5), 10))
    client = Groq(api_key=os.getenv("GROQ_API_KEY"))

    def _call():
        return client.chat.completions.create(
            model=GROQ_LLM_MODEL,
            messages=[
                {"role": "system", "content": QUIZ_SYSTEM},
                {"role": "user", "content":
                    f"Create {n} multiple-choice questions from this material:\n\n{text[:10000]}"},
            ],
            temperature=0.4,
            max_tokens=2048,
            response_format={"type": "json_object"},
            **llm_call_kwargs(),
        )

    try:
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(None, _call)
        raw = response.choices[0].message.content.strip()
        data = json.loads(raw)
    except Exception as e:
        raise HTTPException(500, f"Quiz generation failed: {str(e)}")

    # Validate / sanitize
    clean = []
    for q in (data.get("questions") or []):
        opts = q.get("options") or []
        if not isinstance(opts, list) or len(opts) < 2:
            continue
        opts = [str(o) for o in opts[:4]]
        try:
            ans = int(q.get("answer", 0))
        except (TypeError, ValueError):
            ans = 0
        if ans < 0 or ans >= len(opts):
            ans = 0
        clean.append({
            "question":    str(q.get("question", "")).strip(),
            "options":     opts,
            "answer":      ans,
            "explanation": str(q.get("explanation", "")).strip(),
        })

    if not clean:
        raise HTTPException(500, "Could not generate a quiz from this material.")

    return {"session_id": req.session_id, "questions": clean}


@router.get("/study/list")
async def study_list(user: dict = Depends(get_current_user)):
    """List the current user's saved study documents (most recent first)."""
    return {"documents": list_sessions(int(user["sub"]), "study", limit=50)}


@router.get("/study/session/{session_id}")
async def study_session(session_id: str,
                        credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    """Re-open a previously uploaded document: returns its summary/keywords/stats."""
    status, row = authorized_row(session_id, "study", optional_user_id(credentials))
    if status == "not_found":
        raise HTTPException(404, "Study session not found.")
    if status == "forbidden":
        raise HTTPException(403, "You don't have access to this document.")
    meta    = row.get("meta", {}) or {}
    content = row.get("content", "") or ""
    return {
        "session_id": session_id,
        "filename":   row.get("filename", ""),
        "summary":    meta.get("summary", ""),
        "keywords":   meta.get("keywords", {}),
        "word_count": meta.get("word_count", len(content.split())),
        "char_count": len(content),
        "created_at": row.get("created_at", ""),
    }