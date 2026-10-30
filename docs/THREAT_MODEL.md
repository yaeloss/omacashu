# omaCashu threat model (v0.2.0-alpha)

> **Alpha: not audited. Use only a small, budget-limited wallet connection.**

This document covers the whole omaCashu system: the Omarchy plugin, the desktop helper (`helper/`) and the optional trusted-device kit (`trusted/`).

## Modes

| Mode | Spending credential lives in | Hard limit if the desktop is compromised | Status |
|---|---|---|---|
| **Preview** (0.1.0-alpha, superseded) | Nowhere; no payments | Nothing to spend | Superseded by 0.2.0 |
| **Live wallet (desktop helper)** | `omacashu-helper` service + OS keyring on Omarchy | **Remaining wallet-enforced budget** | **Default, shipped in 0.2.0-alpha**; see [LIVE_WALLET_DESIGN.md](LIVE_WALLET_DESIGN.md) |
| **Trusted device** (`trusted/`) | Separate physical device | Only what you approve on that device's screen | Request-only kit; payments gated (see the end of this document) |

The rest of this document describes the trusted-device mode in detail. The live-wallet threat changes are in §9 of the design document. In short: malware running as your login user can spend up to the remaining budget, so the budget must be small and revocable.

## Assets

| Asset | Where it may exist |
|---|---|
| Wallet seed, Cashu bearer proofs, private Nostr keys | Wallet only. Never on Omarchy, never in omaCashu |
| NWC connection URI (contains the client's spending key) | Preview/trusted mode: trusted device only. Live wallet mode: `omacashu-helper` + OS keyring, budget-limited by the wallet |
| Payment authorization | Live wallet mode: press-and-hold confirmation in the omaCashu panel on helper-verified details. Trusted mode: the trusted device's own screen. Desktop confirmation is implemented; trusted-device approval remains future work |
| Proposal SSH key | Omarchy. Can only submit invoice-shaped text or query an opaque ID |
| Pending proposal queue | Trusted device, broker-private SQLite (`0600`, owner-checked) |

## Trust levels

- **Untrusted:** the Omarchy session, Quickshell and every plugin in it, local scripts and environment variables, command-line arguments, the clipboard, any AI agent, and anything else running as the login user. Assume an attacker has code execution as that user.
- **Semi-trusted:** the broker service account on the trusted device. It never holds wallet credentials in v0.1.
- **Trusted:** the separate device's own console and the wallet application. The Nostr relay is untrusted for availability and metadata, but cannot decrypt correctly implemented NIP-44 payloads.

## Boundaries and controls

1. **Plugin capabilities are minimal.** It has one socket to the helper, one fixed terminal launcher, and no process, file, network, clipboard or URL APIs. CI enforces this in `tests/test_plugin.py`. Nothing in `trusted/` is loaded by the shell.
2. **Proposal channel.** The Omarchy client holds an SSH key that can only run a forced command (`restrict` plus `ForceCommand`, no TTY, no forwarding, `MaxSessions 1`). The client ignores `~/.ssh/config` (`-F none`), pins the host key in a dedicated known-hosts file and validates the user and host it is given, so they cannot be read as ssh options.
3. **Bridge.** It reads one request of at most 8 KiB within a 5-second overall deadline, relays it to the broker socket and returns a response of at most 4 KiB. `SSH_ORIGINAL_COMMAND` is ignored, and Python runs in isolated mode (`-I -B`).
4. **Broker.** Strict allowlist: `ping`, `submit` (BOLT11-shaped text) and `status` (opaque 160-bit ID). There is no `pay` or `approve` operation. Protections:
   - each connection gets a 2-second overall deadline;
   - at most 8 concurrent connections;
   - submits are rate-limited (30 per minute);
   - at most 100 pending requests and 1,000 stored rows, with pruning after 24 hours;
   - errors are never echoed back.

   Runs under a hardened systemd unit: no network namespace access, `AF_UNIX` only, read-only system, no capabilities and a syscall filter.
5. **Filesystem.** State directory and database must be owned by the broker user with mode `0700`/`0600`, and must not be symlinks. The socket's parent directory must not be group- or world-writable. The socket is created under umask `0117` (`0660`, no permission race).
6. **SDK adapter (trusted device only).** The credential file is opened with `O_NOFOLLOW` and checked on the open handle: owner, `0600`, regular file, at most 4 KiB. The URL is strictly parsed (64-hex pubkey and secret, `wss://` relays). Console output is silenced, global error handlers print a generic message, and a hard timeout applies. Wallet-supplied strings are stripped of control and bidi characters. Dependencies are exact-pinned with a lockfile and installed with install scripts disabled.
7. **Approval (future).** Approval must happen on the trusted device's own display and input, **not** through an SSH session started from Omarchy, a remote desktop controlled by Omarchy, or a phone prompt without verified payment details.

## Explicit non-goals for the trusted-device kit

- No wallet connection in the plugin or broker. In trusted mode, there are no payments. (Desktop payments go through the helper; see the design document.)
- The trusted broker only **shape-screens** BOLT11. Full verification exists in `helper/src/bolt11.mjs`, but the broker does not use it yet.
- Arbitrary code execution as root, on the trusted device or inside the wallet process is out of scope.

## Residual risks

- A compromised desktop can draw fake UI or submit misleading proposals. That is why approval must be independent.
- `omarchy plugin add` and `omarchy plugin update` track the repository's mutable `HEAD`.
- Anyone holding the proposal key can spam up to the rate and storage caps, and can query IDs they already know.
- Relay operators see traffic metadata. Cashu mints are custodial.
- A second Linux user on the same machine as Omarchy offers far less protection than a separate device.

## Gates before trusted-device payments

- Independently verify the complete BOLT11 on the trusted device (signature, network, payee, amount, expiry, payment hash). Reject amountless invoices by default.
- Approve on the trusted device's screen, bound to invoice hash, amount and maximum fee. No unattended override.
- Broker-side per-payment and daily caps plus wallet-side NWC budgets, idempotency and fail-closed behavior.
- Keep the NWC secret in an OS- or hardware-backed vault. Provide revocation flows.
- External security review, and tests with a disposable small-value wallet.
