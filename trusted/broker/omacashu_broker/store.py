"""Broker-private SQLite request queue; there is deliberately no spend method."""
import hashlib
import os
import secrets
import sqlite3
import stat
import time
from pathlib import Path

MAX_PENDING = 100
MAX_ROWS = 1000
TTL_SECONDS = 10 * 60
RETENTION_SECONDS = 24 * 60 * 60


class UnsafeStateError(RuntimeError):
    pass


def check_private(path: Path, *, directory: bool) -> None:
    """Require a real (non-symlink) path owned by us with no group/other access."""
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        raise UnsafeStateError(f"{path} must not be a symlink")
    if directory and not stat.S_ISDIR(st.st_mode):
        raise UnsafeStateError(f"{path} must be a directory")
    if not directory and not stat.S_ISREG(st.st_mode):
        raise UnsafeStateError(f"{path} must be a regular file")
    if st.st_uid != os.geteuid():
        raise UnsafeStateError(f"{path} must be owned by the broker user")
    if st.st_mode & 0o077:
        raise UnsafeStateError(f"{path} must not be group/other accessible")


def connect(state_dir: Path) -> sqlite3.Connection:
    state_dir = Path(state_dir)
    # Normally provisioned by systemd StateDirectory= (mode 0700).
    if not os.path.lexists(state_dir):
        os.mkdir(state_dir, 0o700)
    check_private(state_dir, directory=True)
    db_path = state_dir / "pending.sqlite3"
    old_mask = os.umask(0o077)
    try:
        fd = os.open(db_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        os.close(fd)
        check_private(db_path, directory=False)
        db = sqlite3.connect(db_path, timeout=5, isolation_level=None, check_same_thread=False)
    finally:
        os.umask(old_mask)
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("PRAGMA secure_delete=ON")
    db.execute("""CREATE TABLE IF NOT EXISTS requests (
       id TEXT PRIMARY KEY,
       invoice_hash TEXT NOT NULL UNIQUE,
       invoice TEXT NOT NULL,
       created INTEGER NOT NULL,
       status TEXT NOT NULL CHECK(status IN ('pending','rejected','expired'))
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS requests_status_created ON requests(status, created)")
    return db


def _housekeeping(db: sqlite3.Connection, now: int) -> None:
    db.execute("UPDATE requests SET status='expired' WHERE status='pending' AND created < ?", (now - TTL_SECONDS,))
    db.execute("DELETE FROM requests WHERE status!='pending' AND created < ?", (now - RETENTION_SECONDS,))


def submit(db: sqlite3.Connection, invoice: str, *, now: int | None = None) -> dict:
    now = int(time.time()) if now is None else now
    invoice_hash = hashlib.sha256(invoice.encode("ascii")).hexdigest()
    db.execute("BEGIN IMMEDIATE")
    try:
        _housekeeping(db, now)
        row = db.execute("SELECT id, status FROM requests WHERE invoice_hash=?", (invoice_hash,)).fetchone()
        if row:
            result = {"ok": True, "id": row[0], "status": row[1], "duplicate": True}
        elif db.execute("SELECT COUNT(*) FROM requests WHERE status='pending'").fetchone()[0] >= MAX_PENDING:
            result = {"ok": False, "error": "queue full"}
        elif db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] >= MAX_ROWS:
            result = {"ok": False, "error": "queue full"}
        else:
            rid = secrets.token_urlsafe(20)
            db.execute("INSERT INTO requests VALUES (?,?,?,?,?)", (rid, invoice_hash, invoice, now, "pending"))
            result = {"ok": True, "id": rid, "status": "pending", "duplicate": False}
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise
    return result


def status(db: sqlite3.Connection, rid: str, *, now: int | None = None) -> dict:
    now = int(time.time()) if now is None else now
    row = db.execute("SELECT status, created FROM requests WHERE id=?", (rid,)).fetchone()
    if not row:
        return {"ok": False, "error": "not found"}
    result = "expired" if row[0] == "pending" and row[1] < now - TTL_SECONDS else row[0]
    return {"ok": True, "status": result, "id": rid}


def list_pending(db: sqlite3.Connection, *, now: int | None = None) -> list[dict]:
    now = int(time.time()) if now is None else now
    return [{"id": rid, "invoice": invoice, "age_seconds": now - created}
            for rid, invoice, created in db.execute(
                "SELECT id, invoice, created FROM requests WHERE status='pending' AND created >= ? ORDER BY created DESC",
                (now - TTL_SECONDS,))]


def reject(db: sqlite3.Connection, rid: str) -> bool:
    cur = db.execute("UPDATE requests SET status='rejected' WHERE id=? AND status='pending'", (rid,))
    return cur.rowcount == 1
