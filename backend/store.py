"""
store.py — Persistent session store for Study docs & RAG transcripts.

Replaces the old in-memory dicts (_study_store / _transcript_store) which lost
all their data on every backend restart and did not work across multiple
workers (a request could land on a worker that never saw the session).

Backed by the same SQLite database as auth (polyglot.db). One generic table
holds any kind of stored text keyed by session_id:
    kind = "study"      → uploaded document text (Study Assistant)
    kind = "transcript" → audio transcript (RAG chat)
"""

import json
from datetime import datetime
from typing import Optional

from backend.auth import get_db, decode_token

# Safety cap so a public instance can't grow unbounded. Newest rows are kept.
MAX_SESSIONS_PER_KIND = 1000


def init_store():
    """Create the doc_sessions table. Called at app startup, after init_db()."""
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS doc_sessions (
            session_id TEXT PRIMARY KEY,
            user_id    INTEGER,
            kind       TEXT NOT NULL,
            filename   TEXT NOT NULL DEFAULT '',
            content    TEXT NOT NULL,
            meta       TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_doc_sessions_user ON doc_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_doc_sessions_kind ON doc_sessions(kind);
    """)
    conn.commit()
    conn.close()


def save_session(session_id: str, kind: str, content: str,
                 filename: str = "", meta: dict = None, user_id: int = None):
    """Persist (or replace) a session's text and metadata."""
    conn = get_db()
    try:
        conn.execute(
            """INSERT OR REPLACE INTO doc_sessions
               (session_id, user_id, kind, filename, content, meta, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (session_id, user_id, kind, filename, content,
             json.dumps(meta or {}), datetime.utcnow().isoformat()),
        )
        # Evict oldest beyond the cap for this kind.
        conn.execute(
            """DELETE FROM doc_sessions
               WHERE kind = ? AND session_id NOT IN (
                   SELECT session_id FROM doc_sessions WHERE kind = ?
                   ORDER BY created_at DESC LIMIT ?
               )""",
            (kind, kind, MAX_SESSIONS_PER_KIND),
        )
        conn.commit()
    finally:
        conn.close()


def get_content(session_id: str, kind: str = None) -> Optional[str]:
    """Return the stored text for a session, or None if it doesn't exist."""
    conn = get_db()
    try:
        if kind:
            row = conn.execute(
                "SELECT content FROM doc_sessions WHERE session_id = ? AND kind = ?",
                (session_id, kind)).fetchone()
        else:
            row = conn.execute(
                "SELECT content FROM doc_sessions WHERE session_id = ?",
                (session_id,)).fetchone()
        return row["content"] if row else None
    finally:
        conn.close()


def get_session_row(session_id: str, kind: str = None) -> Optional[dict]:
    """Return the full stored row (content + parsed meta) or None."""
    conn = get_db()
    try:
        if kind:
            row = conn.execute(
                "SELECT session_id, filename, content, meta, created_at FROM doc_sessions WHERE session_id = ? AND kind = ?",
                (session_id, kind)).fetchone()
        else:
            row = conn.execute(
                "SELECT session_id, filename, content, meta, created_at FROM doc_sessions WHERE session_id = ?",
                (session_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["meta"] = json.loads(d.get("meta") or "{}")
        except Exception:
            d["meta"] = {}
        return d
    finally:
        conn.close()


def list_sessions(user_id: int, kind: str, limit: int = 50) -> list:
    """List a user's saved sessions of a kind (for a future 'my documents' view)."""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT session_id, filename, meta, created_at
               FROM doc_sessions WHERE user_id = ? AND kind = ?
               ORDER BY created_at DESC LIMIT ?""",
            (user_id, kind, limit)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["meta"] = json.loads(d.get("meta") or "{}")
            except Exception:
                d["meta"] = {}
            out.append(d)
        return out
    finally:
        conn.close()


def authorized_content(session_id: str, kind: str, requester_id: Optional[int]):
    """
    Return (status, content) enforcing ownership:
      - "ok"        → content is returned (session is public/guest-owned, or owned by requester)
      - "not_found" → no such session
      - "forbidden" → session belongs to a different registered user

    Guest-uploaded sessions (user_id NULL) have no owner, so they remain accessible
    by session_id — but any session owned by a registered user is locked to that user.
    """
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT user_id, content FROM doc_sessions WHERE session_id = ? AND kind = ?",
            (session_id, kind)).fetchone()
        if not row:
            return ("not_found", None)
        owner = row["user_id"]
        if owner is not None and owner != requester_id:
            return ("forbidden", None)
        return ("ok", row["content"])
    finally:
        conn.close()


def authorized_row(session_id: str, kind: str, requester_id: Optional[int]):
    """Like authorized_content, but returns (status, full_row_dict) with parsed meta."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT session_id, user_id, filename, content, meta, created_at "
            "FROM doc_sessions WHERE session_id = ? AND kind = ?",
            (session_id, kind)).fetchone()
        if not row:
            return ("not_found", None)
        d = dict(row)
        owner = d.get("user_id")
        if owner is not None and owner != requester_id:
            return ("forbidden", None)
        try:
            d["meta"] = json.loads(d.get("meta") or "{}")
        except Exception:
            d["meta"] = {}
        return ("ok", d)
    finally:
        conn.close()


def delete_session(session_id: str, kind: str = None):
    """Delete a stored session."""
    conn = get_db()
    try:
        if kind:
            conn.execute("DELETE FROM doc_sessions WHERE session_id = ? AND kind = ?", (session_id, kind))
        else:
            conn.execute("DELETE FROM doc_sessions WHERE session_id = ?", (session_id,))
        conn.commit()
    finally:
        conn.close()


def optional_user_id(credentials) -> Optional[int]:
    """
    Best-effort user id from an optional bearer token. Returns None for guests
    (skipAuth) or invalid tokens — never raises, so it never breaks the request.
    """
    if not credentials:
        return None
    try:
        return int(decode_token(credentials.credentials)["sub"])
    except Exception:
        return None
