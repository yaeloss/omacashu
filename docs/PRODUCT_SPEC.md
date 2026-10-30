# omaCashu product specification (scope for v0.2.0-alpha)

## Product statement

**omaCashu: a security-first Lightning + Cashu companion for Omarchy.** It is not a new custodial wallet, mint, Lightning node or token vault. It is built on **NIP-47**, with the **Alby JavaScript SDK** used only on a trusted device. The desktop GUI is always untrusted.

## Repository (`yaeloss/omacashu`)

| Path | Contents | Runs on |
|---|---|---|
| root | Omarchy plugin (manifest + 2 QML files) | Inside `omarchy-shell` |
| `helper/` | Desktop wallet helper (`omacashu` CLI + daemon) | Omarchy, as a sandboxed user service |
| `trusted/` | Broker, SSH bridge, CLI, read-only SDK adapter, deployment files | Separate trusted device (CLI on the desktop) |

## v0.1.0-alpha (superseded)

- Static bar widget and panel with ALPHA and payments-disabled notices, using Omarchy's native components and theme.
- Request-only broker reached through a restricted SSH forced command. The queue stores unverified, BOLT11-shaped text; there is no payment action.
- Standalone read-only SDK adapter (`get_info`, opt-in `get_balance`). It is not wired to the UI or broker.

## Intended user flow (not implemented)

1. Install from the Omarchy marketplace or with `omarchy plugin add`.
2. Open omaCashu from the bar.
3. Choose **Use phone (no connection)**, **Restricted NWC connection** or **Independent trusted device**.
4. Show only the wallet operations that are actually supported, and explain each permission.
5. Hide balances by default. Never pay in the background.

### UI rules

- Bar: minimal bolt button. Never show a balance in the bar without opt-in.
- Panel: security mode always visible; ALPHA shown on development builds; warnings never hidden after errors.
- Use Omarchy's theme, keyboard navigation and plugin lifecycle.

## v0.2.0-alpha (implemented): live wallet mode

Per [LIVE_WALLET_DESIGN.md](LIVE_WALLET_DESIGN.md):

- `omacashu-helper` desktop process: NWC connection in the OS keyring, verified BOLT11, `prepare`/`confirm` protocol over a user-only socket.
- Mandatory wallet-enforced budget; press-and-hold confirmation for every payment; no auto-pay.
- Panel states: helper missing, not connected, budget, invoice entry, confirm and result; settings view; hold Space as the keyboard alternative.

## v0.3 (planned)

- Credential-free "open in wallet" handoff with a real QR code.
- Trusted-device read-only capability status over a narrow channel; optional balance masking.
- Reproducible trusted-device setup.

## v0.4 (gated): trusted-device payments

- Verified BOLT11 parser and approval on the trusted device bound to invoice hash, amount and maximum fee.
- Replay protection, idempotency, spend budgets and an external audit before payments are enabled.

## Out of scope

Native Cashu token import and export, mint storage, unattended agent spending, node and channel management.

## Attribution

[Alby JS SDK](https://github.com/getAlby/js-sdk) · [NIP-47](https://nips.nostr.com/47) · [Omarchy plugins](https://omarchyplugins.com/develop.html). omaCashu is independent and not affiliated with any of these projects.
