#!/usr/bin/python3 -I
"""Forced SSH command for the restricted request-only account on the trusted device.

Install root-owned and non-writable, and run it only through sshd ForceCommand
(see deploy/sshd_config.d/omacashu-propose.conf). Never install it for the
payment-capable account. SSH_ORIGINAL_COMMAND and the environment are ignored:
the only input is one JSON request line on stdin.
"""
import os
import signal
import socket
import sys

SOCKET_PATH = "/run/omacashu/requests.sock"
MAX_REQUEST_BYTES = 8192
MAX_RESPONSE_BYTES = 4096
DEADLINE_SECONDS = 5
BROKER_TIMEOUT_SECONDS = 4


def _deadline(signum, frame):
    raise TimeoutError("bridge deadline exceeded")


def read_request(fd: int, limit: int = MAX_REQUEST_BYTES) -> bytes:
    """Read until newline, EOF or limit+1 bytes; the caller enforces the overall deadline."""
    data = bytearray()
    while len(data) <= limit:
        chunk = os.read(fd, min(4096, limit + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if b"\n" in chunk:
            break
    return bytes(data)


def relay(request: bytes, socket_path: str = SOCKET_PATH) -> bytes:
    """Send one request line to the broker and return its single bounded response line."""
    line = request.split(b"\n", 1)[0]
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(BROKER_TIMEOUT_SECONDS)
        s.connect(socket_path)
        s.sendall(line + b"\n")
        s.shutdown(socket.SHUT_WR)
        response = bytearray()
        while len(response) <= MAX_RESPONSE_BYTES:
            chunk = s.recv(MAX_RESPONSE_BYTES + 1 - len(response))
            if not chunk:
                break
            response.extend(chunk)
            if b"\n" in chunk:
                break
    if len(response) > MAX_RESPONSE_BYTES or not response.endswith(b"\n") or response.count(b"\n") != 1:
        raise OSError("malformed broker response")
    return bytes(response)


def main() -> int:
    signal.signal(signal.SIGALRM, _deadline)
    signal.alarm(DEADLINE_SECONDS)
    try:
        data = read_request(sys.stdin.fileno())
        if len(data) > MAX_REQUEST_BYTES:
            sys.stdout.write('{"ok":false,"error":"too large"}\n')
            return 1
        sys.stdout.buffer.write(relay(data))
        return 0
    except OSError:  # includes TimeoutError
        sys.stdout.write('{"ok":false,"error":"broker unavailable"}\n')
        return 1
    finally:
        signal.alarm(0)
        sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main())
