from fastapi import FastAPI, UploadFile, File, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import os, base64, json, asyncio
from dotenv import load_dotenv
from pathlib import Path

load_dotenv(Path(__file__).parent / ".env")

from backend.services.transcribe import transcribe_audio
from backend.services.translate import translate_text, translate_text_stream, is_hallucination
from backend.services.summarize import summarize_text
from backend.services.sentiment import analyze_sentiment          # NEW
from backend.services.translate import LANGUAGE_MAP
from backend.auth import (
    init_db, get_current_user,
    register_user, login_user,
    save_history_entry, get_history,
    delete_history_entry, clear_all_history,
    RegisterRequest, LoginRequest, HistoryEntry
)

app = FastAPI(title="PolyglotAI API", version="5.0.0")

_FRONTEND_URL = os.getenv("FRONTEND_URL", "")
_ALLOWED_ORIGINS = [_FRONTEND_URL] if _FRONTEND_URL else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ALLOWED_EXTS    = {"mp3", "wav", "m4a", "mp4", "webm", "ogg", "flac", "aac"}
MAX_FILE_BYTES  = 25 * 1024 * 1024


@app.on_event("startup")
async def startup_check():
    if not os.getenv("GROQ_API_KEY"):
        raise RuntimeError("GROQ_API_KEY is not set")
    init_db()


# ── Auth ──────────────────────────────────────────────────────────
@app.post("/auth/register")
async def register(req: RegisterRequest): return register_user(req)

@app.post("/auth/login")
async def login(req: LoginRequest): return login_user(req)

@app.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return {"user_id": user["sub"], "username": user["username"]}


# ── History ───────────────────────────────────────────────────────
@app.post("/user/history")
async def add_history(entry: HistoryEntry, user: dict = Depends(get_current_user)):
    return save_history_entry(user, entry)

@app.get("/user/history")
async def fetch_history(user: dict = Depends(get_current_user)):
    return {"history": get_history(user)}

@app.delete("/user/history/{entry_id}")
async def remove_history(entry_id: int, user: dict = Depends(get_current_user)):
    return delete_history_entry(user, entry_id)

@app.delete("/user/history")
async def wipe_history(user: dict = Depends(get_current_user)):
    return clear_all_history(user)


# ── Models ────────────────────────────────────────────────────────
class TranslateRequest(BaseModel):
    text: str
    target_language: str

class SummarizeRequest(BaseModel):
    text: str

class SentimentRequest(BaseModel):
    text: str

class LiveChunkRequest(BaseModel):
    audio_b64: str
    filename: str
    target_language: str
    translate: bool = True
    language: str | None = None


def _validate_audio_upload(file: UploadFile, audio_bytes: bytes):
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else ""
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, f"Unsupported file type: .{ext}")
    if len(audio_bytes) > MAX_FILE_BYTES:
        raise HTTPException(400, "File too large. Max 25MB.")


# ── Health & Meta ─────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "message": "PolyglotAI API is running", "version": "5.0.0"}

@app.get("/languages")
async def languages():
    return {"languages": list(LANGUAGE_MAP.keys())}


# ── Transcribe ────────────────────────────────────────────────────
@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    audio_bytes = await file.read()
    _validate_audio_upload(file, audio_bytes)
    result = await transcribe_audio(audio_bytes, file.filename)
    if not result["text"]:
        raise HTTPException(500, "Whisper returned empty transcript.")
    return {"transcript": result["text"], "detected_language": result["language"]}


# ── Translate ─────────────────────────────────────────────────────
@app.post("/translate")
async def translate(req: TranslateRequest):
    if not req.text.strip():
        raise HTTPException(400, "Text cannot be empty")
    translation = await translate_text(req.text, req.target_language)
    return {"translation": translation}

@app.post("/translate/stream")
async def translate_stream(req: TranslateRequest):
    if not req.text.strip():
        raise HTTPException(400, "Text cannot be empty")

    async def event_generator():
        try:
            async for token in translate_text_stream(req.text, req.target_language):
                yield f"data: {json.dumps({'token': token})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Summarize ─────────────────────────────────────────────────────
@app.post("/summarize")
async def summarize(req: SummarizeRequest):
    if not req.text.strip():
        raise HTTPException(400, "Text cannot be empty")
    summary = await summarize_text(req.text)
    return {"summary": summary}


# ── Sentiment (NEW) ───────────────────────────────────────────────
@app.post("/sentiment")
async def sentiment(req: SentimentRequest):
    """
    Analyze emotional tone of transcript or any text.
    Returns: sentiment, score, confidence, emotion, intensity, key_phrases, summary.
    Real-world uses: customer service QA, interview scoring, meeting tone analysis.
    """
    if not req.text.strip() or len(req.text.strip()) < 10:
        raise HTTPException(400, "Text too short for sentiment analysis (min 10 chars)")
    result = await analyze_sentiment(req.text)
    return result


# ── Live chunk ────────────────────────────────────────────────────
@app.post("/live/chunk")
async def live_chunk(req: LiveChunkRequest):
    try:
        audio_bytes = base64.b64decode(req.audio_b64)
    except Exception:
        raise HTTPException(400, "Invalid base64 audio data")

    if len(audio_bytes) < 15000:
        return {"transcript": "", "translation": "", "detected_language": "", "skipped": True}

    result = None
    last_err = None
    for attempt in range(2):
        try:
            result = await transcribe_audio(audio_bytes, req.filename, language=req.language)
            break
        except Exception as e:
            last_err = e
            if attempt == 0: await asyncio.sleep(1)

    if result is None:
        raise HTTPException(500, f"Transcription failed: {last_err}")

    transcript = result["text"].strip()
    if not transcript or is_hallucination(transcript):
        return {"transcript": "", "translation": "", "detected_language": result["language"], "skipped": True}

    translation = ""
    if req.translate:
        translation = await translate_text(transcript, req.target_language)

    return {
        "transcript": transcript,
        "translation": translation.strip(),
        "detected_language": result["language"],
        "skipped": False
    }


# ── Process all ───────────────────────────────────────────────────
@app.post("/process")
async def process_all(
    file: UploadFile = File(...),
    target_language: str = "Hindi",
    include_summary: bool = False,
    include_sentiment: bool = False,
):
    audio_bytes = await file.read()
    _validate_audio_upload(file, audio_bytes)
    result     = await transcribe_audio(audio_bytes, file.filename)
    transcript = result["text"]
    translation = await translate_text(transcript, target_language)
    out = {"transcript": transcript, "translation": translation, "detected_language": result["language"]}
    if include_summary:   out["summary"]   = await summarize_text(transcript)
    if include_sentiment: out["sentiment"] = await analyze_sentiment(transcript)
    return out