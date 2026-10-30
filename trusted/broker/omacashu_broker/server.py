"""Minimal AF_UNIX broker server. Wallet operations intentionally NOT implemented.

Run only on a separate trusted device (see deploy/omacashu-broker.service).
Socket permissions decide who can submit requests; this is not a security
boundary when run under the same account as the Omarchy desktop.
"""
import argparse
import collections
import grp
import os
import signal
import socket
import stat
import sys
import threading
import time
from pathlib import Path

from .protocol import MAX_MESSAGE_BYTES, ProtocolError, encode_response, parse_message
from .store import UnsafeStateError, connect, status, submit

CONNECTION_DEADLINE_SECONDS = 2.0
MAX_CONNECTIONS = 8
SUBMITS_PER_WINDOW = 30
WINDOW_SECONDS = 60.0


class RateLimiter:
    """Sliding-window limit on accepted operations (single proposer, global window)."""

    def __init__(self, limit: int, window: float, clock=time.monotonic):
        self.limit = limit
        self.window = window
        self.clock = clock
        self.events: collections.deque[float] = collections.deque()
        self.lock = threading.Lock()

    def allow(self) -> bool:
        with self.lock:
            now = self.clock()
            while self.events and self.events[0] <= now - self.window:
                self.events.popleft()
            if len(self.events) >= self.limit:
                return False
            self.events.append(now)
            return True


def send_and_close(conn: socket.socket, response: dict) -> None:
    """Reply, then discard a bounded amount of unread input so close() does not reset the reply away."""
    try:
        conn.settimeout(1)
        conn.sendall(encode_response(response))
        conn.shutdown(socket.SHUT_WR)
        conn.setblocking(False)
        for _ in range(4):
            if not conn.recv(65536):
                break
    except OSError:
        pass
    finally:
        conn.close()


def read_request(conn: socket.socket, deadline_seconds: float = CONNECTION_DEADLINE_SECONDS) -> bytes:
    """Read one newline-terminated request within an overall deadline (not per recv)."""
    deadline = time.monotonic() + deadline_seconds
    data = bytearray()
    while len(data) <= MAX_MESSAGE_BYTES:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("request deadline exceeded")
        conn.settimeout(remaining)
        chunk = conn.recv(min(4096, MAX_MESSAGE_BYTES + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if b"\n" in chunk:
            break
    return bytes(data)


class Broker:
    def __init__(self, db, limiter: RateLimiter | None = None):
        self.db = db
        self.db_lock = threading.Lock()
        self.limiter = limiter or RateLimiter(SUBMITS_PER_WINDOW, WINDOW_SECONDS)

    def handle(self, raw: bytes) -> dict:
        msg = parse_message(raw.strip())
        if msg["op"] == "ping":
            return {"ok": True, "mode": "request-only", "payments_enabled": False}
        if msg["op"] == "submit":
            if not self.limiter.allow():
                return {"ok": False, "error": "rate limited"}
            with self.db_lock:
                return submit(self.db, msg["invoice"])
        if msg["op"] == "status":
            with self.db_lock:
                return status(self.db, msg["id"])
        return {"ok": False, "error": "not permitted"}

    def serve_connection(self, conn: socket.socket) -> None:
        try:
            result = self.handle(read_request(conn))
        except (ProtocolError, OSError):
            result = {"ok": False, "error": "invalid or timed-out request"}
        except Exception:
            # Never echo exceptions, SQL or request payloads.
            result = {"ok": False, "error": "broker failure"}
        send_and_close(conn, result)


def check_socket_parent(socket_path: Path) -> None:
    parent = socket_path.parent
    st = os.lstat(parent)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        raise UnsafeStateError("socket directory must be a real directory")
    if st.st_uid not in (0, os.geteuid()):
        raise UnsafeStateError("socket directory must be owned by root or the broker user")
    if st.st_mode & 0o022:
        raise UnsafeStateError("socket directory must not be group/other writable")


def _raise_exit(signum, frame):
    raise SystemExit(0)


def serve(socket_path: Path, state_dir: Path, socket_group: str | None) -> None:
    socket_path = Path(socket_path)
    check_socket_parent(socket_path)
    if os.path.lexists(socket_path):
        raise UnsafeStateError("socket path already exists: stop the old broker or remove it safely")
    gid = grp.getgrnam(socket_group).gr_gid if socket_group else -1
    db = connect(state_dir)
    broker = Broker(db)
    slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    bound_inode = None
    signal.signal(signal.SIGTERM, _raise_exit)
    signal.signal(signal.SIGINT, _raise_exit)
    try:
        old_mask = os.umask(0o117)  # socket is created 0660: no window with wider permissions
        try:
            sock.bind(str(socket_path))
        finally:
            os.umask(old_mask)
        bound_inode = os.lstat(socket_path).st_ino
        if gid != -1:
            os.chown(socket_path, -1, gid)
        os.chmod(socket_path, 0o660)
        sock.listen(16)

        def worker(conn):
            try:
                broker.serve_connection(conn)
            finally:
                slots.release()

        while True:
            conn, _ = sock.accept()
            if not slots.acquire(blocking=False):
                send_and_close(conn, {"ok": False, "error": "busy"})
                continue
            threading.Thread(target=worker, args=(conn,), daemon=True).start()
    finally:
        sock.close()
        try:
            st = os.lstat(socket_path)
            if bound_inode is not None and stat.S_ISSOCK(st.st_mode) and st.st_ino == bound_inode:
                socket_path.unlink()
        except FileNotFoundError:
            pass
        with broker.db_lock:
            db.close()


def main():
    parser = argparse.ArgumentParser(description="Trusted-device, request-only omaCashu broker")
    parser.add_argument("--socket", type=Path, default=Path("/run/omacashu/requests.sock"))
    parser.add_argument("--state", type=Path, default=Path("/var/lib/omacashu"))
    parser.add_argument("--socket-group", help="proposer group allowed to connect (default: broker's group)")
    a = parser.parse_args()
    try:
        serve(a.socket, a.state, a.socket_group)
    except (UnsafeStateError, OSError, KeyError) as exc:
        print(f"omacashu-broker: refusing to start: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
