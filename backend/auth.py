"""
auth.py  —  PolyglotAI Authentication
- SQLite database (polyglot.db) auto-created on first run
- bcrypt password hashing
- JWT access tokens (24h expiry)
- Per-user session history stored in DB
"""

import os, sqlite3, bcrypt, json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
from jose import JWTError, jwt
from fastapi import HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

# ── Config ───────────────────────────────────────────────────────────

_DEV_SECRET = "polyglot-dev-secret-change-in-production"
SECRET_KEY  = os.getenv("JWT_SECRET", _DEV_SECRET)

# Fail hard in production if the secret is missing/default — a known secret means
# anyone can forge login tokens for any user. Render sets RENDER=true automatically.
_IS_PROD = bool(os.getenv("RENDER") or os.getenv("PRODUCTION") or os.getenv("FRONTEND_URL"))
if _IS_PROD and SECRET_KEY == _DEV_SECRET:
    raise RuntimeError(
        "JWT_SECRET is not set in production. Refusing to start with the public dev secret. "
        "Set a strong JWT_SECRET environment variable."
    )

ALGORITHM   = "HS256"
TOKEN_HOURS = 24
DB_PATH     = Path(__file__).parent / "polyglot.db"

bearer_scheme = HTTPBearer(auto_error=False)


# ── Pydantic models ──────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    username: str
    password: str
    display_name: str = ""

class LoginRequest(BaseModel):
    username: str
    password: str

class HistoryEntry(BaseModel):
    date: str
    lang: str
    transcript: str
    translation: str
    duration: int = 0
    source: str = "live"   # "live" or "file"
    filename: str = ""


# ── DB setup ─────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Create tables if they don't exist. Called at app startup."""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            username     TEXT    UNIQUE NOT NULL,
            display_name TEXT    NOT NULL DEFAULT '',
            password_hash TEXT   NOT NULL,
            created_at   TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS history (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            date         TEXT    NOT NULL,
            lang         TEXT    NOT NULL,
            transcript   TEXT    NOT NULL DEFAULT '',
            translation  TEXT    NOT NULL DEFAULT '',
            duration     INTEGER NOT NULL DEFAULT 0,
            source       TEXT    NOT NULL DEFAULT 'live',
            filename     TEXT    NOT NULL DEFAULT '',
            created_at   TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id);
    """)
    conn.commit()
    conn.close()


# ── Password helpers ─────────────────────────────────────────────────

def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()

def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


# ── JWT helpers ──────────────────────────────────────────────────────

def create_token(user_id: int, username: str) -> str:
    payload = {
        "sub":      str(user_id),
        "username": username,
        "exp":      datetime.utcnow() + timedelta(hours=TOKEN_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


# ── Auth dependency ──────────────────────────────────────────────────

def get_current_user(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)) -> dict:
    """FastAPI dependency — extracts and validates JWT from Authorization header."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return decode_token(credentials.credentials)


# ── Auth route handlers (called from main.py) ────────────────────────

def register_user(req: RegisterRequest) -> dict:
    if len(req.username.strip()) < 3:
        raise HTTPException(400, "Username must be at least 3 characters")
    if len(req.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")

    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM users WHERE username = ?", (req.username.lower(),)
        ).fetchone()
        if existing:
            raise HTTPException(400, "Username already taken")

        hashed = hash_password(req.password)
        cursor = conn.execute(
            "INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)",
            (req.username.lower(), req.display_name or req.username, hashed, datetime.utcnow().isoformat())
        )
        conn.commit()
        user_id = cursor.lastrowid
        token   = create_token(user_id, req.username.lower())
        return {
            "token":        token,
            "user_id":      user_id,
            "username":     req.username.lower(),
            "display_name": req.display_name or req.username,
        }
    finally:
        conn.close()


def login_user(req: LoginRequest) -> dict:
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, username, display_name, password_hash FROM users WHERE username = ?",
            (req.username.lower(),)
        ).fetchone()
        if not row or not verify_password(req.password, row["password_hash"]):
            raise HTTPException(401, "Invalid username or password")

        token = create_token(row["id"], row["username"])
        return {
            "token":        token,
            "user_id":      row["id"],
            "username":     row["username"],
            "display_name": row["display_name"],
        }
    finally:
        conn.close()


def save_history_entry(user: dict, entry: HistoryEntry) -> dict:
    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO history
               (user_id, date, lang, transcript, translation, duration, source, filename, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                int(user["sub"]),
                entry.date,
                entry.lang,
                entry.transcript,
                entry.translation,
                entry.duration,
                entry.source,
                entry.filename,
                datetime.utcnow().isoformat(),
            )
        )
        conn.commit()
        return {"saved": True}
    finally:
        conn.close()


def get_history(user: dict, limit: int = 50) -> list:
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT id, date, lang, transcript, translation, duration, source, filename
               FROM history WHERE user_id = ?
               ORDER BY created_at DESC LIMIT ?""",
            (int(user["sub"]), limit)
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def delete_history_entry(user: dict, entry_id: int) -> dict:
    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM history WHERE id = ? AND user_id = ?",
            (entry_id, int(user["sub"]))
        )
        conn.commit()
        return {"deleted": True}
    finally:
        conn.close()


def clear_all_history(user: dict) -> dict:
    conn = get_db()
    try:
        conn.execute("DELETE FROM history WHERE user_id = ?", (int(user["sub"]),))
        conn.commit()
        return {"cleared": True}
    finally:
        conn.close()