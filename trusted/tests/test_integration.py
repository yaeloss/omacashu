"""Exercise the real AF_UNIX broker and SSH bridge without networking or a wallet."""
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INVOICE = "lnbc2500n1" + "p" * 70  # placeholder only, never payable


def load_bridge():
    spec = importlib.util.spec_from_file_location("omacashu_ssh_bridge", ROOT / "bridge" / "omacashu_ssh_bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LiveBroker:
    def __init__(self, folder: Path):
        self.folder = folder
        self.state = folder / "state"
        self.sockpath = folder / "run" / "broker.sock"
        self.sockpath.parent.mkdir(mode=0o700, exist_ok=True)
        self.proc = None

    def start(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-I", str(ROOT / "bin" / "omacashu-broker"),
             "--socket", str(self.sockpath), "--state", str(self.state)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(300):
            if self.sockpath.exists():
                return self
            if self.proc.poll() is not None:
                raise AssertionError("broker failed to start: " + self.proc.stderr.read().decode())
            time.sleep(0.01)
        raise AssertionError("broker did not create socket")

    def stop(self, sig=signal.SIGTERM):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(sig)
            self.proc.wait(timeout=5)

    def query(self, payload, raw=None):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(3)
            s.connect(str(self.sockpath))
            s.sendall(raw if raw is not None else json.dumps(payload).encode() + b"\n")
            s.shutdown(socket.SHUT_WR)
            return json.loads(recv_all(s))


def recv_all(s):
    chunks = []
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


class BrokerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.broker = LiveBroker(Path(self.tmp.name)).start()

    def tearDown(self):
        self.broker.stop(signal.SIGKILL)
        self.tmp.cleanup()

    def test_request_only_protocol(self):
        q = self.broker.query
        self.assertEqual(q({"op": "ping"}), {"ok": True, "mode": "request-only", "payments_enabled": False})
        request = q({"op": "submit", "invoice": INVOICE})
        self.assertTrue(request["ok"])
        self.assertEqual(q({"op": "status", "id": request["id"]})["status"], "pending")
        self.assertEqual(q({"op": "submit", "invoice": INVOICE})["id"], request["id"])
        self.assertFalse(q({"op": "pay", "invoice": INVOICE})["ok"])
        self.assertFalse(q({"op": "approve", "id": request["id"]})["ok"])
        self.assertEqual(q(None, raw=b"x" * 9000)["error"], "invalid or timed-out request")

    def test_errors_do_not_echo_input(self):
        reply = self.broker.query(None, raw=b'{"op":"pay","invoice":"SECRET-MARKER"}\n')
        self.assertNotIn("SECRET", json.dumps(reply))

    def test_socket_permissions(self):
        self.assertEqual(self.broker.sockpath.stat().st_mode & 0o777, 0o660)

    def test_idle_client_cannot_block_broker(self):
        idle = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        idle.connect(str(self.broker.sockpath))
        idle.sendall(b"{")  # slowloris: never finishes the request
        try:
            started = time.monotonic()
            self.assertTrue(self.broker.query({"op": "ping"})["ok"])
            self.assertLess(time.monotonic() - started, 1.0)
            idle.settimeout(5)
            started = time.monotonic()
            reply = json.loads(recv_all(idle))
            self.assertEqual(reply["error"], "invalid or timed-out request")
            self.assertLess(time.monotonic() - started, 3.5)  # overall 2 s deadline, not per-recv
        finally:
            idle.close()

    def test_connection_cap_returns_busy(self):
        idle = []
        try:
            for _ in range(8):
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(str(self.broker.sockpath))
                idle.append(s)
            time.sleep(0.2)
            self.assertEqual(self.broker.query({"op": "ping"})["error"], "busy")
        finally:
            for s in idle:
                s.close()

    def test_submit_rate_limit(self):
        results = [self.broker.query({"op": "submit", "invoice": "lnbc1000n1" + format(i, "x") + "p" * 60})
                   for i in range(31)]
        self.assertTrue(all(r["ok"] for r in results[:30]))
        self.assertEqual(results[30]["error"], "rate limited")

    def test_sigterm_removes_socket_and_restart_works(self):
        self.broker.stop(signal.SIGTERM)
        self.assertEqual(self.broker.proc.returncode, 0)
        self.assertFalse(os.path.lexists(self.broker.sockpath))
        self.broker.start()
        self.assertTrue(self.broker.query({"op": "ping"})["ok"])


class BrokerStartupSafetyTests(unittest.TestCase):
    def run_broker(self, sockdir: Path, state: Path):
        return subprocess.run(
            [sys.executable, "-I", str(ROOT / "bin" / "omacashu-broker"), "--socket", str(sockdir / "b.sock"),
             "--state", str(state)], capture_output=True, text=True, timeout=10)

    def test_refuses_world_writable_socket_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            sockdir = Path(tmp) / "run"
            sockdir.mkdir()
            os.chmod(sockdir, 0o777)
            result = self.run_broker(sockdir, Path(tmp) / "state")
            self.assertEqual(result.returncode, 1)
            self.assertIn("refusing to start", result.stderr)

    def test_refuses_existing_socket_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            sockdir = Path(tmp) / "run"
            sockdir.mkdir(mode=0o700)
            (sockdir / "b.sock").symlink_to("/etc/passwd")
            result = self.run_broker(sockdir, Path(tmp) / "state")
            self.assertEqual(result.returncode, 1)
            self.assertTrue((sockdir / "b.sock").is_symlink())


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.broker = LiveBroker(Path(self.tmp.name)).start()
        self.bridge = load_bridge()

    def tearDown(self):
        self.broker.stop(signal.SIGKILL)
        self.tmp.cleanup()

    def test_relays_single_line(self):
        reply = self.bridge.relay(b'{"op":"ping"}\n{"op":"pay"}\n', str(self.broker.sockpath))
        self.assertTrue(json.loads(reply)["ok"])

    def test_rejects_oversized_or_malformed_response(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "fake.sock")
            for payload in [b"x" * 5000 + b"\n", b"no newline", b"a\nb\n"]:
                with self.subTest(payload=payload[:10]):
                    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    server.bind(path)
                    server.listen(1)
                    pid = os.fork()
                    if pid == 0:
                        conn, _ = server.accept()
                        conn.recv(10000)
                        conn.sendall(payload)
                        conn.close()
                        os._exit(0)
                    try:
                        with self.assertRaises(OSError):
                            self.bridge.relay(b'{"op":"ping"}\n', path)
                    finally:
                        os.waitpid(pid, 0)
                        server.close()
                        os.unlink(path)

    def test_stalled_client_hits_overall_deadline(self):
        proc = subprocess.Popen([sys.executable, "-I", str(ROOT / "bridge" / "omacashu_ssh_bridge.py")],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            proc.stdin.write(b"{")
            proc.stdin.flush()
            started = time.monotonic()
            out = proc.stdout.read()
            proc.wait(timeout=10)
            self.assertLess(time.monotonic() - started, 7)
            self.assertEqual(json.loads(out)["error"], "broker unavailable")
        finally:
            if proc.poll() is None:
                proc.kill()

    def test_oversized_request_rejected(self):
        proc = subprocess.run([sys.executable, "-I", str(ROOT / "bridge" / "omacashu_ssh_bridge.py")],
                              input=b"x" * 9000, capture_output=True, timeout=10)
        self.assertEqual(json.loads(proc.stdout)["error"], "too large")


if __name__ == "__main__":
    unittest.main()
