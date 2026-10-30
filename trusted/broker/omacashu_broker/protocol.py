"""Strict, untrusted request parsing. Never handles wallet credentials."""
import json
import re
from typing import Any

MAX_MESSAGE_BYTES = 8192
MAX_INVOICE_LENGTH = 4096
# Format *screening only*, NOT BOLT11 cryptographic verification or amount decoding.
BOLT11_SHAPE = re.compile(r"^ln(?:bc|tb|bcrt|tbs)[0-9a-z]+$", re.IGNORECASE)
REQUEST_ID_SHAPE = re.compile(r"^[A-Za-z0-9_-]{20,40}$")


class ProtocolError(ValueError):
    pass


def parse_message(raw: bytes) -> dict[str, Any]:
    if not isinstance(raw, (bytes, bytearray)) or len(raw) > MAX_MESSAGE_BYTES:
        raise ProtocolError("request too large")
    try:
        msg = json.loads(raw)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ProtocolError("invalid JSON") from None
    if not isinstance(msg, dict):
        raise ProtocolError("JSON object required")
    op = msg.get("op")
    if op == "submit":
        if set(msg) != {"op", "invoice"}:
            raise ProtocolError("unsupported field")
        invoice = msg.get("invoice")
        if not isinstance(invoice, str) or not 16 <= len(invoice) <= MAX_INVOICE_LENGTH:
            raise ProtocolError("invalid invoice length")
        if not invoice.isascii() or not BOLT11_SHAPE.fullmatch(invoice):
            raise ProtocolError("expected BOLT11-looking Lightning invoice")
        # Bech32 forbids mixed case; reject it so a future decoder sees one canonical form.
        if invoice != invoice.lower() and invoice != invoice.upper():
            raise ProtocolError("mixed case invoice not allowed")
        return {"op": "submit", "invoice": invoice.lower()}
    if op == "status":
        if set(msg) != {"op", "id"}:
            raise ProtocolError("unsupported field")
        request_id = msg.get("id")
        if not isinstance(request_id, str) or not request_id.isascii() or not REQUEST_ID_SHAPE.fullmatch(request_id):
            raise ProtocolError("invalid request id")
        return {"op": "status", "id": request_id}
    if op == "ping":
        if set(msg) != {"op"}:
            raise ProtocolError("unsupported field")
        return {"op": "ping"}
    raise ProtocolError("operation not permitted")


def encode_response(value: dict) -> bytes:
    return (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode()
