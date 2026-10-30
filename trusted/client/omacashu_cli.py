#!/usr/bin/env python3
"""Omarchy-side request-only client. Never stores NWC credentials.

Requires an SSH key that is authorized *only* for the trusted device's forced
command, plus a dedicated known_hosts file that pins the trusted device's host key.
The user's ~/.ssh/config is ignored (-F none) so it cannot weaken these settings.
"""
import argparse
import json
import os
import re
import stat
import subprocess
import sys
import threading

USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$")
IPV6_RE = re.compile(r"^[0-9A-Fa-f:.]{2,45}$")
UNSAFE_PATH_CHARS = re.compile(r"[\s%\"'\\,=]")
MAX_RESPONSE_BYTES = 4096
TIMEOUT_SECONDS = 12


class UsageError(ValueError):
    pass


def validate_user(user: str) -> str:
    if not USER_RE.fullmatch(user):
        raise UsageError("invalid SSH user name")
    return user


def validate_host(host: str) -> str:
    if host.startswith("-") or not (HOSTNAME_RE.fullmatch(host) or (":" in host and IPV6_RE.fullmatch(host))):
        raise UsageError("invalid host name")
    return host


def validate_file(path: str, what: str, *, private: bool) -> str:
    if not path or path.startswith("-") or UNSAFE_PATH_CHARS.search(path):
        raise UsageError(f"unsupported characters in {what} path")
    try:
        st = os.stat(path)
    except OSError:
        raise UsageError(f"{what} not found") from None
    if not stat.S_ISREG(st.st_mode):
        raise UsageError(f"{what} must be a regular file")
    if private and st.st_mode & 0o077:
        raise UsageError(f"{what} must not be group/other accessible (chmod 600)")
    return os.path.abspath(path)


def build_ssh_command(user: str, host: str, port: int, identity: str, known_hosts: str) -> list[str]:
    return [
        "ssh", "-F", "none", "-T", "-x", "-a",
        "-p", str(port),
        "-i", identity,
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "IdentityAgent=none",
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "StrictHostKeyChecking=yes",
        "-o", f"UserKnownHostsFile={known_hosts}",
        "-o", "GlobalKnownHostsFile=/dev/null",
        "-o", "UpdateHostKeys=no",
        "-o", "ForwardAgent=no",
        "-o", "ForwardX11=no",
        "-o", "ClearAllForwardings=yes",
        "-o", "ControlMaster=no",
        "-o", "ControlPath=none",
        "-o", "PermitLocalCommand=no",
        "-o", "ConnectTimeout=5",
        "-o", "ServerAliveInterval=5",
        "-o", "ServerAliveCountMax=1",
        "-l", user,
        "--", host,
    ]


def run_ssh(command: list[str], payload: bytes) -> bytes | None:
    proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C"})
    timer = threading.Timer(TIMEOUT_SECONDS, proc.kill)
    timer.start()
    try:
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
        except OSError:
            pass
        output = proc.stdout.read(MAX_RESPONSE_BYTES + 1)
        if len(output) > MAX_RESPONSE_BYTES:
            proc.kill()
            proc.wait()
            return None
        if proc.wait() != 0:
            return None
        return output
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="omaCashu request-only terminal client")
    p.add_argument("--host", required=True, help="trusted device host name or IP")
    p.add_argument("--port", type=int, default=22)
    p.add_argument("--user", default="omacashu-propose")
    p.add_argument("--identity", required=True, help="private key authorized ONLY for the forced command")
    p.add_argument("--known-hosts", required=True, help="dedicated known_hosts file pinning the trusted device")
    sp = p.add_subparsers(dest="action", required=True)
    sp.add_parser("ping")
    sp.add_parser("submit", help="read a Lightning invoice from standard input (never argv)")
    status_cmd = sp.add_parser("status")
    status_cmd.add_argument("id")
    a = p.parse_args(argv)
    try:
        if not 1 <= a.port <= 65535:
            raise UsageError("invalid port")
        command = build_ssh_command(
            validate_user(a.user), validate_host(a.host), a.port,
            validate_file(a.identity, "identity", private=True),
            validate_file(a.known_hosts, "known_hosts", private=False),
        )
    except UsageError as exc:
        p.error(str(exc))

    if a.action == "submit":
        payload = {"op": "submit", "invoice": sys.stdin.readline(4100).strip()}
    elif a.action == "status":
        payload = {"op": "status", "id": a.id}
    else:
        payload = {"op": "ping"}

    try:
        output = run_ssh(command, (json.dumps(payload) + "\n").encode())
    except OSError:
        output = None
    if output is None:
        print("Trusted device unreachable or request refused (check the SSH setup locally)", file=sys.stderr)
        return 1
    try:
        result = json.loads(output)
    except (UnicodeDecodeError, ValueError):
        print("Malformed broker response", file=sys.stderr)
        return 1
    if not isinstance(result, dict):
        print("Malformed broker response", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0 if result.get("ok") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
