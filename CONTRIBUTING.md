# Contributing to omaCashu

omaCashu is an **unaudited alpha** that can move real funds subject to the wallet’s own restrictions. Never include seeds, real NWC connection URLs, Cashu tokens, private keys or real invoices in issues, PRs, screenshots or logs. For live tests, use the [NWC Faucet](https://faucet.nwc.dev) (fake sats).

## Ground rules

- Follow [docs/LIVE_WALLET_DESIGN.md](docs/LIVE_WALLET_DESIGN.md):
  - the credential lives only in the helper;
  - wallet budgets are optional and there is no local spending ceiling;
  - every payment is confirmed in the panel against helper-verified details.
- **QML** may only:
  - use one `Socket` to the helper, with the `status`, `prepare`, `confirm` and `cancel` operations;
  - make one `execDetached` call to the Omarchy terminal launcher, with the fixed helper commands.

  Do not add `Process`, `FileView`, network APIs, `XMLHttpRequest`, `Qt.openUrlExternally` or clipboard access. CI rejects them. Render all text with `textFormat: Text.PlainText`. Never parse invoices in QML.
- **Helper:**
  - never log or echo secrets, invoices, amounts or request payloads;
  - keep every input bounded (size, time, rate);
  - never relax `STRICT_POLICY` outside test harnesses;
  - add new dependencies only with an exact pin, a lockfile resolved under a cooldown (`npm install --package-lock-only --before=<date 4 weeks ago>`), and passing `npm audit` and `npm audit signatures`.
- **`trusted/`:** never add `pay`, `approve` or credential-returning operations to the broker or SSH bridge.
- Add negative tests for every parsing, permission or protocol change.

## Checks

```bash
python3 -m unittest discover -s tests -v
(cd helper && npm ci && npm test)
(cd trusted && python3 -m unittest discover -s tests -v && cd sdk && npm ci && npm test)
omarchy plugin validate .
mkdir -p /tmp/qs-imports && ln -sfn "$OMARCHY_PATH/shell" /tmp/qs-imports/qs
/usr/lib/qt6/bin/qmllint -I /tmp/qs-imports BarWidget.qml Panel.qml
```

`qmllint` reports `missing-property` warnings for duck-typed shell objects such as `bar` and `Style`, as Omarchy's built-in plugins do. Any other warning should be fixed.

### Real payment test (fake sats)

```bash
node helper/test/e2e/faucet-e2e.mjs
```

This creates two faucet wallets and pays a 21-sat invoice through the real helper service, verifier and NWC client. It uses the production policy, which accepts connections without budget reporting.

### On-device UI test

1. Copy the tracked files to `~/.config/omarchy/plugins/io.github.yaeloss.omacashu/`, then run `omarchy restart shell`. Nested panels are not hot-reloaded.
2. Check every state: helper missing, not connected, connected, review, paying and result. Also test the settings view, Esc, `omarchy-shell shell summon io.github.yaeloss.omacashu '{}'` and `… hide …`.
3. To exercise the connected and payment screens without a real wallet:
   1. Stop the real helper.
   2. Run `node helper/test/e2e/ui-daemon.mjs`. It uses a faucet wallet with a simulated budget.
   3. Restart the real helper afterwards.
4. `qs log -p "$OMARCHY_PATH/shell" --tail 100` must show no errors for the plugin.

Update `README.md`, `SECURITY.md`, `CHANGELOG.md` and `preview.png` (real captures only) when behavior or the UI changes.

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/yaeloss/omacashu/security/advisories/new), not a public issue.
