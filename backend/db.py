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
        if IS_POSTGRES:
            # RealDictCursor → rows behave like dicts: row["col"] and dict(row) both work.
            self._conn = psycopg2.connect(
                DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor
            )
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
        self._conn.close()


def get_db() -> "_Conn":
    """Return a new connection. Callers are responsible for close() (as before)."""
    return _Conn()
