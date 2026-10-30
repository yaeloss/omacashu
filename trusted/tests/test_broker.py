import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "broker"))
from omacashu_broker import store  # noqa: E402
from omacashu_broker.protocol import ProtocolError, parse_message  # noqa: E402
from omacashu_broker.server import RateLimiter  # noqa: E402
from omacashu_broker.store import UnsafeStateError, connect, list_pending, reject, status, submit  # noqa: E402

INVOICE = "lnbc2500n1" + "p" * 70  # format fixture, NOT a valid or payable BOLT11


def invoice(n: int) -> str:
    # Distinct BOLT11-shaped fixtures using only [0-9a-z].
    return "lnbc1000n1" + format(n, "x").replace("1", "q") + "p" * 60


class ProtocolTests(unittest.TestCase):
    def test_accept_submit(self):
        data = parse_message(json.dumps({"op": "submit", "invoice": INVOICE}).encode())
        self.assertEqual(data["invoice"], INVOICE)

    def test_uppercase_is_canonicalized(self):
        data = parse_message(json.dumps({"op": "submit", "invoice": INVOICE.upper()}).encode())
        self.assertEqual(data["invoice"], INVOICE)

    def test_reject_secrets_and_junk(self):
        for bad in ["nostr+walletconnect://secret", "cashuAsecret", "lnbc 11", "../../etc/passwd",
                    "lnbc2500n1" + "p" * 70 + "\n", "lnbc2500n1\u017f" + "p" * 70, "lnbc2500n1\u212a" + "p" * 70]:
            with self.subTest(bad=bad), self.assertRaises(ProtocolError):
                parse_message(json.dumps({"op": "submit", "invoice": bad}).encode())

    def test_no_pay_or_approve(self):
        for method in ["pay", "approve", "get_nwc_url", "get_balance", "list", "reject", None, 1]:
            with self.subTest(method=method), self.assertRaises(ProtocolError):
                parse_message(json.dumps({"op": method}).encode())

    def test_reject_extra_fields(self):
        for msg in [{"op": "submit", "invoice": INVOICE, "amount": 1}, {"op": "ping", "x": 1},
                    {"op": "status", "id": "a" * 27, "approve": True}]:
            with self.subTest(msg=msg), self.assertRaises(ProtocolError):
                parse_message(json.dumps(msg).encode())

    def test_length_nesting_and_encoding(self):
        for payload in [b"{" * 10000, b'"string"', b"{bad json", b"[" * 8000, b"\xff\xfe{}", b"[]", b"null"]:
            with self.subTest(payload=payload[:10]), self.assertRaises(ProtocolError):
                parse_message(payload)

    def test_mixed_case(self):
        with self.assertRaises(ProtocolError):
            parse_message(json.dumps({"op": "submit", "invoice": "LNBC2500N1" + "p" * 70}).encode())

    def test_status_id_shape(self):
        for rid in ["short", "a" * 41, "a" * 27 + "/", "ａ" * 27]:
            with self.subTest(rid=rid), self.assertRaises(ProtocolError):
                parse_message(json.dumps({"op": "status", "id": rid}).encode())


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / "state"
        self.db = connect(self.state)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_duplicate_never_double_enqueued(self):
        first = submit(self.db, INVOICE, now=1000)
        second = submit(self.db, INVOICE, now=1001)
        self.assertTrue(first["ok"])
        self.assertEqual(first["id"], second["id"])
        self.assertTrue(second["duplicate"])

    def test_expiry_and_rejection(self):
        first = submit(self.db, INVOICE, now=1000)
        self.assertEqual(status(self.db, first["id"], now=1001)["status"], "pending")
        self.assertEqual(status(self.db, first["id"], now=2000)["status"], "expired")
        self.assertFalse(list_pending(self.db, now=2000))
        new = submit(self.db, invoice(1), now=1000)
        self.assertTrue(reject(self.db, new["id"]))
        self.assertFalse(reject(self.db, new["id"]))
        self.assertEqual(status(self.db, new["id"], now=1001)["status"], "rejected")

    def test_pending_cap(self):
        for i in range(store.MAX_PENDING):
            self.assertTrue(submit(self.db, invoice(i), now=1000)["ok"])
        self.assertEqual(submit(self.db, invoice(10_000), now=1000), {"ok": False, "error": "queue full"})

    def test_total_rows_capped_and_pruned(self):
        old_max = store.MAX_ROWS
        store.MAX_ROWS = 5
        try:
            for i in range(5):
                rid = submit(self.db, invoice(i), now=1000)["id"]
                reject(self.db, rid)
            self.assertEqual(submit(self.db, invoice(99), now=1000)["error"], "queue full")
            later = 1000 + store.RETENTION_SECONDS + 1
            self.assertTrue(submit(self.db, invoice(99), now=later)["ok"])
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM requests").fetchone()[0], 1)
        finally:
            store.MAX_ROWS = old_max

    def test_private_permissions(self):
        self.assertEqual((self.state / "pending.sqlite3").stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)


class StateSafetyTests(unittest.TestCase):
    def test_rejects_open_state_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            state.mkdir(mode=0o755)
            os.chmod(state, 0o755)
            with self.assertRaises(UnsafeStateError):
                connect(state)

    def test_rejects_symlinked_state_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = Path(tmp) / "real"
            real.mkdir(mode=0o700)
            link = Path(tmp) / "link"
            link.symlink_to(real)
            with self.assertRaises(UnsafeStateError):
                connect(link)

    def test_rejects_symlinked_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            state.mkdir(mode=0o700)
            target = Path(tmp) / "elsewhere.sqlite3"
            target.touch(mode=0o600)
            (state / "pending.sqlite3").symlink_to(target)
            with self.assertRaises(OSError):
                connect(state)

    def test_rejects_readable_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            state.mkdir(mode=0o700)
            db = state / "pending.sqlite3"
            db.touch()
            os.chmod(db, 0o644)
            with self.assertRaises(UnsafeStateError):
                connect(state)


class RateLimiterTests(unittest.TestCase):
    def test_sliding_window(self):
        now = [0.0]
        limiter = RateLimiter(3, 60, clock=lambda: now[0])
        self.assertEqual([limiter.allow() for _ in range(4)], [True, True, True, False])
        now[0] = 61
        self.assertTrue(limiter.allow())


if __name__ == "__main__":
    unittest.main()
