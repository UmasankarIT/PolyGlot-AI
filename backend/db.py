"""
db.py — Database layer that works with BOTH SQLite (local dev) and Postgres (prod).

Why: SQLite lives on the server's disk, and hosts like Render wipe that disk on
every deploy — so all users/history/documents were lost each time. Postgres is a
managed database that persists across deploys.

How it switches:
    - If DATABASE_URL is set (postgres://…) → use Postgres (production).
    - Otherwise → use the local SQLite file polyglot.db (development).

The rest of the app keeps using a sqlite-style API: `conn.execute(sql, params)`
returning a cursor with `.fetchone()/.fetchall()/.lastrowid`, plus `.commit()`
and `.close()`. This wrapper translates the small differences (`?` vs `%s`
placeholders, dict-like rows) so auth.py / store.py barely change.
"""

import os
import sqlite3
from pathlib import Path

DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
# psycopg2 accepts postgres:// and postgresql://; treat both as Postgres.
IS_POSTGRES = DATABASE_URL.startswith("postgres://") or DATABASE_URL.startswith("postgresql://")

DB_PATH = Path(__file__).parent / "polyglot.db"

if IS_POSTGRES:
    import psycopg2
    import psycopg2.extras
    import psycopg2.pool

_POOL = None


def _get_pool():
    """Lazy pool — created on first use so import never hangs if DB sleeps."""
    global _POOL
    if _POOL is None:
        _POOL = psycopg2.pool.ThreadedConnectionPool(
            1, 10,
            DATABASE_URL,
            cursor_factory=psycopg2.extras.RealDictCursor,
            connect_timeout=10,
            keepalives=1,
            keepalives_idle=30,
            keepalives_interval=10,
            keepalives_count=5,
        )
    return _POOL


def is_postgres() -> bool:
    return IS_POSTGRES


class _Cursor:
    """Thin wrapper so both backends expose fetchone/fetchall/lastrowid uniformly."""
    def __init__(self, cur):
        self._cur = cur

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    @property
    def lastrowid(self):
        return getattr(self._cur, "lastrowid", None)


class _Conn:
    """A connection that behaves like sqlite3's (has .execute) for both backends."""
    def __init__(self):
        self._pooled = False
        if IS_POSTGRES:
            # Reuse warm connection from pool — no TCP+TLS handshake per request.
            # RealDictCursor → rows behave like dicts: row["col"] and dict(row) both work.
            self._conn = _get_pool().getconn()
            self._pooled = True
        else:
            self._conn = sqlite3.connect(str(DB_PATH))
            self._conn.row_factory = sqlite3.Row  # rows support row["col"] and dict(row)

    def execute(self, sql: str, params=()):
        if IS_POSTGRES:
            sql = sql.replace("?", "%s")  # our SQL never contains a literal '?'
        cur = self._conn.cursor()
        cur.execute(sql, params)
        return _Cursor(cur)

    def executescript(self, sql: str):
        if IS_POSTGRES:
            # psycopg2 can run several ';'-separated statements in one execute().
            cur = self._conn.cursor()
            cur.execute(sql)
        else:
            self._conn.executescript(sql)

    def commit(self):
        self._conn.commit()

    def close(self):
        if IS_POSTGRES and self._pooled:
            try:
                _get_pool().putconn(self._conn)
            except Exception:
                try:
                    self._conn.close()
                except Exception:
                    pass
        else:
            self._conn.close()


def ping_db() -> bool:
    """Light keepalive query for cron pingers. Returns True if DB reachable."""
    try:
        conn = get_db()
        try:
            conn.execute("SELECT 1", ())
            return True
        finally:
            conn.close()
    except Exception:
        return False


def get_db() -> "_Conn":
    """Return a new connection. Callers are responsible for close() (as before)."""
    return _Conn()
