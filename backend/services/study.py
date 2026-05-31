import os, asyncio, logging
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / ".env")

from fastapi import APIRouter, UploadFile, File, HTTPException, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from backend.services.summarize import summarize_text
from backend.services.keywords import extract_keywords
from groq import Groq

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=get_remote_address)

ALLOWED_EXTS   = {"pdf", "docx", "txt", "doc"}
MAX_FILE_BYTES = 20 * 1024 * 1024  # 20MB

# In-memory store for study sessions
_study_store: dict[str, str] = {}
MAX_STORE = 200


# ── Models ────────────────────────────────────────────────────────

class StudyAskRequest(BaseModel):
    session_id: str
    question:   str
    mode:       str = "explain"  # explain | summarize | quiz | keypoints


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

def _study_prompt(text: str, mode: str) -> str:
    base = f"""You are an expert study assistant. You have access to the following study material:

\"\"\"
{text[:10000]}
\"\"\"

"""
    if mode == "explain":
        return base + "Answer questions clearly and thoroughly based on the material. Use examples where helpful. If something is not in the material, say so."
    elif mode == "quiz":
        return base + "Generate quiz questions and answers based on the material. Make them educational and test understanding."
    elif mode == "keypoints":
        return base + "Extract and explain key points, concepts, and important information from the material."
    else:
        return base + "Help the student understand and learn from this material."


# ── Routes ────────────────────────────────────────────────────────

@router.post("/study/upload")
@limiter.limit("10/minute")
async def study_upload(request: Request, file: UploadFile = File(...)):
    """
    Upload a document → extract text → summarize → keywords → store for chat
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

    # Store for chat
    import time
    session_id = f"study_{file.filename}_{int(time.time())}"
    if len(_study_store) >= MAX_STORE:
        oldest = next(iter(_study_store))
        del _study_store[oldest]
    _study_store[session_id] = text

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
async def study_ask(request: Request, req: StudyAskRequest):
    """Ask a question about the uploaded study material."""
    if not req.question.strip():
        raise HTTPException(400, "Question cannot be empty")

    text = _study_store.get(req.session_id)
    if not text:
        raise HTTPException(404, "Study session not found. Please re-upload the file.")

    client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    system = _study_prompt(text, req.mode)

    def _call():
        return client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": system},
                {"role": "user",   "content": req.question.strip()},
            ],
            temperature=0.3,
            max_tokens=1024,
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