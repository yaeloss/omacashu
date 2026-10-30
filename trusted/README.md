# omaCashu trusted-device kit (optional)

**Request-only broker, restricted SSH bridge, desktop CLI and read-only Alby SDK adapter for the high-assurance omaCashu setup, where the wallet lives on a separate device.**

> [!CAUTION]
> **Alpha, unaudited.** This kit cannot pay anything. Live payments on the desktop use the [omaCashu helper](../helper/) instead. Never paste a seed phrase, spending-capable NWC connection, private key or Cashu token here.

Most users don't need this folder. It exists for anyone who wants the wallet on a **separate physical device** that the Omarchy desktop can propose invoices to but never control. Nothing in this folder is loaded by the Omarchy plugin.

| Component | Path | Runs on |
|---|---|---|
| Request-only broker (Unix socket, private SQLite queue) | `broker/`, `bin/omacashu-broker` | Trusted device, hardened systemd unit |
| Review tool (list/reject; no approve) | `bin/omacashu-review` | Trusted device console |
| SSH forced-command bridge | `bridge/` | Trusted device, via sshd `ForceCommand` |
| Request-only CLI | `client/` | Omarchy desktop |
| Read-only NWC adapter (`@getalby/sdk`) | `sdk/` | Trusted device |
| systemd unit, sshd snippet, authorized_keys example | `deploy/` | Trusted device |

## Protocol

The broker accepts exactly three operations:

```json
{"op":"ping"}
{"op":"submit","invoice":"lnbc..."}      // BOLT11-shaped text only, shape-screened, NOT verified
{"op":"status","id":"<opaque id>"}
```

There is **no** `pay` or `approve` operation, and none may be added to this channel.

## Hardening

- **Broker:**
  - 2-second overall deadline per connection, at most 8 concurrent connections, submits limited to 30 per minute;
  - at most 100 pending requests and 1,000 stored rows, pruned after 24 hours;
  - removes its socket on `SIGTERM`; error replies never echo input.
- **Broker filesystem:**
  - the state directory, database and socket directory must be owned by the broker user, and must not be symlinks or group/world-accessible;
  - the socket is created `0660` with no permission race.
- **systemd:** no network, `AF_UNIX` only, read-only system, no capabilities, syscall filter, memory-deny-write-execute.
- **Bridge:** 5-second overall deadline, at most 8 KiB in and 4 KiB out, ignores `SSH_ORIGINAL_COMMAND`, isolated Python (`-I -B`).
- **Client:** ignores `~/.ssh/config` and the SSH agent, pins the host key and rejects option-shaped user or host values. Invoices are read from stdin, never argv.
- **SDK:** see [`sdk/README.md`](sdk/README.md).

Deployment: [`deploy/DEPLOYMENT.md`](deploy/DEPLOYMENT.md). Threat model: [`../docs/THREAT_MODEL.md`](../docs/THREAT_MODEL.md).

## Tests

No wallet or internet access is needed:

```bash
cd trusted
python3 -m unittest discover -s tests -v
cd sdk && npm ci && npm test
```

The tests cover protocol fuzz cases, idle-client and slowloris resistance, the connection cap, rate limiting, storage caps, symlink and permission attacks, SIGTERM cleanup, bridge deadlines and size limits, ssh option injection and credential-file races.

## Requirements

- **Python** 3.10+ (standard library only).
- **Node.js** 22+ for `sdk/` only.
- **OpenSSH** 8.4+ on both ends.
- **systemd** on the trusted device.
