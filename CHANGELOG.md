# Changelog

All notable changes to omaCashu. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

- Alpha banner can be dismissed with × (keyboard accessible); Omarchy widget settings remember the choice across restarts.
- Ledger loading fails closed on read errors and invalid schemas; ledger replacement syncs the parent directory before payments.
- Helper updates retain the previous code and launch configuration until startup succeeds and restore them on failure.
- Added isolated installer rollback tests and ledger failure-path tests.

- Guided panel setup with numbered install, connect and payment steps, wallet preparation instructions and a manual setup recheck.
- Added an onboarding recovery guide and explicit pre-publication onboarding checks.
- Corrected stale confirmation status and narrowed duplicate-payment wording to local ledger protection.
- Refreshed `preview.png` with a real capture of the installed payment panel with the warning dismissed; complete onboarding and social captures remain pending.

## [0.2.0-alpha] - 2026-10-29

**Live, budget-limited payments.**

### Added
- **`helper/`, the omaCashu desktop helper** (`omacashu` CLI + sandboxed `omacashu-helper` systemd user service):
  - `connect`/`disconnect` store the NWC connection in the system keyring, using hidden input;
  - refuses connections without a wallet-enforced budget or over the local ceiling (100,000 sats by default). Other permissions are allowed and listed at connect time;
  - verified BOLT11 decoder (signature, payee, network, amount, expiry) that passes every BOLT #11 spec vector;
  - `prepare`/`confirm` protocol over a user-only socket, with single-use 120-second confirmations, rate limits, and a payment ledger written before paying that blocks double payment and unresolved retries;
  - checks that the preimage matches the payment hash before reporting "paid";
  - home-only `install.sh`/`uninstall.sh`, exact-pinned dependencies with a lockfile under a 4-week cooldown, and `ignore-scripts`.
- **New panel, matching the original concept:**
  - a header with a settings gear, an alpha banner and a footer status row;
  - states for helper missing, not connected, unreachable, blocked, connected (budget bar), review (verified amount, recipient node, expiry, budget after) and paying/paid/failed;
  - press-and-hold to pay, or hold Space;
  - a settings view for wallet and helper.
- Real end-to-end payment test against the NWC Faucet (`helper/test/e2e/faucet-e2e.mjs`), and a UI test daemon.
- `trusted/`: the optional separate-device kit, merged into this repository (formerly `omacashu-trusted`).

### Changed
- **Single public repository:** plugin, helper and optional trusted kit.
- **Policy:** live wallets allowed under `docs/LIVE_WALLET_DESIGN.md`. The plugin may use one helper socket and one fixed Omarchy terminal launcher.
- `preview.png` and the social preview are real captures of the 0.2 panels, using a test wallet.

### Security
- The wallet secret never enters `omarchy-shell`. Accepted risk, documented everywhere: malware running as your user can spend up to the remaining wallet budget.

## [0.1.0-alpha] - 2026-10-29

First public alpha, renamed from the OmaCash prototype.

### Changed
- Renamed to **omaCashu**; plugin ID `io.github.yaeloss.omacashu`.
- Split the project: this repository now contains only the Omarchy plugin. Broker, SSH bridge, CLI and SDK adapter moved to [`omacashu-trusted`](https://github.com/yaeloss/omacashu-trusted), so `omarchy plugin add` no longer clones trusted-device code onto the desktop.
- The panel now uses Omarchy's native `PanelHero`, section header and separator components, the bar font everywhere, and plain-text rendering for all strings.
- The bar button uses `BarIconButton` and forwards `settings`, matching the built-in widgets.
- Replaced the concept-art preview and social image with a real capture of the installed panel.

### Added
- `barWidget.description` in the manifest.
- CI tests that mirror `omarchy plugin validate`, enforce the file allowlist and forbid process, file, network and URL APIs in QML.
- Secret scanning, SHA-pinned GitHub Actions and Dependabot for actions.

### Security
- The plugin holds no keys, makes no network requests and cannot pay. No payment code exists in this repository.
