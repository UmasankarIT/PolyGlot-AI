"""
db_smoke.py — verify the DB layer works against YOUR Postgres before cutover.

Run this once after creating your Postgres database, using its EXTERNAL
connection string. If it prints "ALL GOOD", the Postgres path is safe to deploy.
Your DB password never leaves your machine (you set it as an env var locally).

PowerShell:
    $env:DATABASE_URL = "postgresql://user:pass@host/dbname"
    speech_env\Scripts\python.exe db_smoke.py

Git Bash:
    DATABASE_URL="postgresql://user:pass@host/dbname" speech_env/Scripts/python.exe db_smoke.py

It creates the tables, registers a throwaway user, upserts a session, reads it
back with the ownership check, then deletes everything it made.
"""
import os, sys, time

if not os.getenv("DATABASE_URL", "").strip():
    print("FAIL: set DATABASE_URL to your Postgres connection string first.")
    sys.exit(1)

from backend.db import is_postgres, get_db
from backend import auth, store

if not is_postgres():
    print("WARNING: DATABASE_URL is not a postgres:// url — this would test SQLite, not Postgres.")
    sys.exit(1)

print("Dialect: Postgres")

try:
    auth.init_db()
    store.init_store()
    print("PASS: tables created")

    uname = f"smoke_{int(time.time())}"
    res = auth.register_user(auth.RegisterRequest(username=uname, password="secret123"))
    uid = res["user_id"]
    print(f"PASS: register -> user_id={uid}")

    sid = f"smoke_sess_{int(time.time())}"
    store.save_session(sid, "study", "hello world content", filename="x.txt", meta={"a": 1}, user_id=uid)
    store.save_session(sid, "study", "updated content", filename="x.txt", meta={"a": 2}, user_id=uid)  # upsert
    status, content = store.authorized_content(sid, "study", uid)
    assert status == "ok" and content == "updated content", (status, content)
    print("PASS: session upsert + ownership read")

    # cleanup
    store.delete_session(sid, "study")
    conn = get_db()
    conn.execute("DELETE FROM users WHERE id = ?", (uid,))
    conn.commit()
    conn.close()
    print("PASS: cleanup done")
    print("\nALL GOOD — safe to set DATABASE_URL on Render and deploy.")
except Exception as e:
    print(f"\nFAIL: {type(e).__name__}: {e}")
    sys.exit(1)
