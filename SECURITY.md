# omaCashu security policy

> [!CAUTION]
> **Alpha: experimental and unaudited.** Use only a **new, small, budget-limited** NWC connection created for omaCashu. Never put a seed phrase or private key into anything related to this project.

## Components

| Component | Runs as | Holds the wallet secret? |
|---|---|---|
| Plugin: `manifest.json`, `BarWidget.qml`, `Panel.qml` | Inside the shared, unsandboxed `omarchy-shell` | **No, never** |
| Helper: `helper/` | Your user, as the sandboxed `omacashu-helper` systemd user service | Yes (loaded from the OS keyring) |
| Optional kit: `trusted/` | A separate trusted device | Read-only adapter only; no payments |

## Rules every release must keep

1. **The secret stays in the helper.** The NWC connection is entered only through `omacashu connect` (hidden input, never argv or env) and stored only in the Secret Service keyring. It is never written to plugin files, shell config, logs, the clipboard or screenshots.
2. **Wallet limits are optional.**
   - Require `pay_invoice`. `get_budget` is optional and queried only when advertised.
   - No local spending ceiling. If a budget is reported, invoices must fit its remaining amount.
   - A missing budget report does not prove the connection is unlimited. Wallet-side restrictions still apply.
   - Other permissions are allowed and listed at connect time.
3. **Verified, confirmed payments only.**
   - The helper verifies each BOLT11 invoice: signature, mainnet, amount present, not expired, under the remaining budget, never paid before.
   - The panel shows only helper-returned fields, and payment needs a 1.5-second press-and-hold (or hold Space) within 120 seconds.
   - Confirmations are single-use.
   - The attempt is written to the ledger **before** the wallet is contacted.
   - Success counts only when the preimage matches the payment hash.
4. **The panel's capabilities are minimal.** It may only:
   - open one socket to the helper, using the four protocol operations;
   - run one fixed terminal launcher for `install`, `connect` or `disconnect`.

   `tests/test_plugin.py` enforces this in CI.

> [!WARNING]
> **Accepted risk:** malware running as your Omarchy user can read the keyring entry or call the helper socket, so it can spend **everything the connection permits**. Only restrictions enforced by the wallet limit that exposure. omaCashu does not require or impose a spending cap. If you suspect compromise, revoke the connection in your wallet. For stronger isolation, use the separate-device kit in [`trusted/`](trusted/).

## Supply chain

- The plugin has no dependencies.
- The helper pins `@getalby/sdk`, `@noble/curves`, `@noble/hashes` and `@scure/base` exactly, with a committed lockfile resolved under a 4-week release cooldown.
- The installer uses `npm ci --ignore-scripts`. CI runs `npm audit` and `npm audit signatures`.
- GitHub Actions are pinned to commit SHAs.

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x-alpha | ✅ security fixes |
| 0.1.x-alpha | ❌ please upgrade |

## Reporting a vulnerability

Report privately at **GitHub → Security → [Report a vulnerability](https://github.com/yaeloss/omacashu/security/advisories/new)**. Do not open a public issue.

Never include live NWC URLs, private keys, seed phrases or spendable Cashu tokens in a report. If you exposed one, revoke the NWC connection in your wallet immediately. Expect an acknowledgement within 7 days. Fixes ship as a new tagged version, with an advisory when users need to act.

## Residual risks

- A malicious plugin or process in the same session can draw fake UI over the panel. Payments still need the helper's single-use confirmation, and any wallet-side restrictions still apply.
- `omarchy plugin add` and `omarchy plugin update` fetch the repository's current `HEAD`, not a reviewed commit.
- Feature-bit negotiation and routing are left to your wallet.
- Relay operators see NWC traffic metadata. Cashu mints are custodial.
- No independent security audit has been performed.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [docs/LIVE_WALLET_DESIGN.md](docs/LIVE_WALLET_DESIGN.md).
