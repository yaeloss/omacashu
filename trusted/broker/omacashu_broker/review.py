"""Trusted-device-only review tool. No payment execution or approval.

Run on the trusted device's own console as the broker user, never from an
SSH session that started on the Omarchy desktop.
"""
import argparse
import sys
from pathlib import Path

from .protocol import REQUEST_ID_SHAPE
from .store import UnsafeStateError, connect, list_pending, reject


def main():
    p = argparse.ArgumentParser(description="Review untrusted proposals on the trusted device")
    p.add_argument("--state", type=Path, default=Path("/var/lib/omacashu"))
    sp = p.add_subparsers(dest="action", required=True)
    sp.add_parser("list")
    r = sp.add_parser("reject")
    r.add_argument("id")
    a = p.parse_args()
    if a.action == "reject" and not REQUEST_ID_SHAPE.fullmatch(a.id):
        p.error("invalid request id")
    try:
        db = connect(a.state)
    except (UnsafeStateError, OSError) as exc:
        print(f"omacashu-review: {exc}", file=sys.stderr)
        raise SystemExit(1)
    try:
        if a.action == "list":
            # Invoices are restricted to [0-9a-z] by the protocol, so printing them cannot inject terminal escapes.
            for req in list_pending(db):
                print("ID:", req["id"])
                print("AGE:", req["age_seconds"], "seconds")
                print("INVOICE (UNVERIFIED):", req["invoice"])
                print("AMOUNT: NOT VERIFIED; PAYMENT UNAVAILABLE")
                print()
        elif a.action == "reject":
            print("Rejected" if reject(db, a.id) else "Not found or not pending")
    finally:
        db.close()


if __name__ == "__main__":
    main()
