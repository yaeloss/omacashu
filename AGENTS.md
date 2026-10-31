# omaCashu: agent instructions

Read `SECURITY.md`, `docs/THREAT_MODEL.md`, `docs/LIVE_WALLET_DESIGN.md` and `docs/RELEASE_CHECKLIST.md` before making changes.

## Policy (updated 2026-10-29: single public repository, live payments shipped in 0.2.0-alpha)

Live wallets are **allowed**, only through the design in `docs/LIVE_WALLET_DESIGN.md`:

- The NWC spending credential lives in the **omaCashu helper** (`helper/`, OS keyring). It never goes into QML, shell config, plugin files, logs, tests or screenshots.
- Wallet budgets are **optional** (owner policy change, 2026-10-31). Require `pay_invoice`; query `get_budget` only when advertised. There is no local budget ceiling. Respect remaining budget when reported, and never claim protection beyond the wallet's own restrictions. Keep all invoice, confirmation and replay protections.
- **Every payment must be confirmed** in the panel (press-and-hold or hold Space), using helper-verified details. No auto-pay, no background payments, no one-step pay operation in the helper protocol.

## Repository layout and rules

- `manifest.json`, `BarWidget.qml` and `Panel.qml` stay at the repository root.
- **QML capabilities** (enforced by `tests/test_plugin.py`):
  - exactly one `Socket`, to `$XDG_RUNTIME_DIR/omacashu/helper.sock`, using only `status`, `prepare`, `confirm` and `cancel`;
  - exactly one `execDetached` call, to `omarchy-launch-floating-terminal-with-presentation`, with the fixed install, connect or disconnect commands built from validated paths.

  `Process`, `FileView`, network APIs, `openUrlExternally` and clipboard APIs remain forbidden.
- Never parse invoices in QML. Show only helper-returned fields. Render all text as `Text.PlainText`.
- `helper/` is the desktop wallet helper. Keep its dependencies exact-pinned, with the lockfile resolved under a cooldown (`--before`) and `ignore-scripts=true`. It must never log secrets, invoices or amounts.
- `trusted/` is the optional separate-device kit. Its broker protocol and SSH bridge must never get a `pay`, `approve` or credential-returning operation.
- Never put seeds, real NWC URLs, Cashu proofs or real wallet amounts in code, tests, logs or screenshots. For live tests, use the NWC Faucet (fake sats).
- `preview.png` must be a real capture of the installed panel. Retake it whenever the UI changes.

## Checks

```bash
python3 -m unittest discover -s tests -v
(cd helper && npm ci && npm test)
(cd trusted && python3 -m unittest discover -s tests -v)
omarchy plugin validate .
```

On Omarchy, also run `qmllint` as described in `CONTRIBUTING.md`. Restart the shell (`omarchy restart shell`) after changing `Panel.qml`; nested panels are not hot-reloaded.
