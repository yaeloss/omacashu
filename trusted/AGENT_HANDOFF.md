# Agent handoff: omaCashu trusted-device development

**Alpha warning:** experimental and unaudited. Do not connect funded wallets or spending-enabled NWC credentials.

## Current state (0.1.0-alpha)

- The plugin (repository root) and the helper (`../helper/`) handle desktop payments. This folder is the optional separate-device kit.
- The broker is a standard-library Python Unix-socket service accepting only `ping`, `submit` and `status`. It is hardened against stalls, floods and filesystem attacks, and runs under a sandboxed systemd unit (`deploy/`).
- The SSH bridge is a forced command with an overall deadline and bounded input and output.
- The client is a hardened ssh invocation: `-F none`, a pinned known_hosts file and validated arguments.
- `sdk/` is a standalone read-only Alby SDK adapter (`@getalby/sdk@8.0.3`, locked). It is **not** wired to the broker or UI, and has not been tested against a real wallet.

## Project direction (2026-10-29)

Live payments shipped in 0.2.0-alpha through the **desktop helper** in `../helper/`, with a mandatory wallet-enforced budget and confirmation for every payment (see `../docs/LIVE_WALLET_DESIGN.md`). This kit is unaffected: it remains the high-assurance path, and the proposal channel stays request-only. The verified BOLT11 decoder in `../helper/src/bolt11.mjs` should be reused for the trusted-device payment milestone.

## Next milestone: read-only NWC status

1. End-to-end test of `sdk/readonly.mjs` against an unfunded, read-only NWC connection.
2. A broker-side `get_info` status exposed over a separate, narrow channel. Never send the NWC URL to the desktop, and keep balances hidden by default.
3. Independent review of the SSH, UID and systemd isolation on real trusted-device hardware.

## Payment milestone (blocked until independent review)

- Parse BOLT11 on the trusted device and verify signature, network, payee, expiry, amount and payment hash. No amountless invoices by default.
- Approval on the trusted device's own screen, showing **verified** amount, destination, expiry and maximum fee, bound to the invoice hash.
- Broker caps plus wallet-side NWC budgets, idempotency and fail-closed behavior.
- Test only with disposable small-value wallets, after an external audit.

## Non-goals

- No Cashu wallet or NUT cryptography in the Omarchy shell; bearer proofs are funds.
- No `pay` command on the proposal socket or SSH bridge.
- No wallets, seeds or NWC credentials under the Omarchy login account.
