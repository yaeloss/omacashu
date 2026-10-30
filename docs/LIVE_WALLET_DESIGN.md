# Live wallet mode: design

**Status:** implemented in **0.2.0-alpha** (2026-10-29). Unaudited alpha.

**Decisions**
- The NWC spending credential lives in a **desktop helper**, a separate process on the Omarchy machine. It does not live in the plugin.
- Mandatory guardrails: a **wallet-enforced budget** and **confirm every payment**.

## 1. Why a helper and not the plugin

Every Omarchy plugin runs inside one unsandboxed `omarchy-shell` process. An NWC URL loaded into QML could be read by any other plugin. A separate helper process keeps the secret out of the shell's memory, and the plugin only ever sees helper-decoded payment details.

What this does **not** protect against: malware running as your login user can still read the keyring entry, or talk to the helper socket directly. In live wallet mode, **the wallet-enforced budget is the hard security boundary.** Everything else reduces accidents and attack surface.

## 2. Components

Everything lives in the single public repository `yaeloss/omacashu`:

| Component | Path | Runs as |
|---|---|---|
| omaCashu plugin (QML) | `manifest.json`, `BarWidget.qml`, `Panel.qml` | Inside `omarchy-shell` |
| Helper daemon + `omacashu` CLI | `helper/` | Your user, as the sandboxed `omacashu-helper` systemd user service |
| Request-only broker (optional) | `trusted/` | Separate device |

`omarchy plugin add` clones the whole repository, but the shell loads only the two QML files. The helper runs only after you click **Install helper** (or run `helper/install.sh`). That copies it to `~/.local/share/omacashu/helper` and installs pinned dependencies there, never inside the plugin folder, so Omarchy's no-symlink rule for plugin folders still holds.

## 3. Credential handling

- **Connect:** `omacashu connect` reads the NWC URI from **stdin only**, never argv or environment variables, and validates it with the same strict parser as `omacashu-trusted/sdk/credential.mjs`.
- **Budget check (refuse otherwise):**
  1. `get_info` must list `pay_invoice` and `get_budget`.
  2. Other permissions (keysend, hold invoices, `sign_message` and so on) are **allowed**. omaCashu never calls them; they are listed at connect time for information. Policy change of 2026-10-30: the method allowlist was removed at the owner's request. The wallet budget remains the hard limit on spending. Note that a stolen connection string could still use non-spending permissions such as `sign_message`.
  3. `get_budget` must return a `total_budget`. An empty response means no budget, and the connection is refused.
  4. If `total_budget` exceeds the local ceiling (default 100,000 sats per period, configurable down or up), the connection is refused.
  5. The budget is shown to the user, who must type `yes` to save the connection.
- **Storage:** the OS keyring (Secret Service via `secret-tool`, attributes `service=omacashu account=nwc`). There is no plaintext file fallback. `omacashu-helper disconnect` deletes the keyring entry and reminds you to revoke the connection in the wallet.
- **Logging:** the secret is loaded into memory only by the helper and is never logged. The helper's console is silenced as in `readonly.mjs`. Journald receives only fixed event names such as `payment_succeeded` and `payment_failed`, with no amounts, invoices or URIs.

## 4. Helper socket protocol

**Socket**
- Path: `$XDG_RUNTIME_DIR/omacashu/helper.sock`, in a `0700` directory with a `0600` socket.
- Only your user can connect. Node has no `SO_PEERCRED`, so this is enforced through the file system: at startup the helper refuses a socket directory that is a symlink, isn't owned by you, or is group- or world-accessible.
- One JSON line in, one out. Same bounds as the broker: 8 KiB, a 2-second deadline and a connection cap.

| Request | Response | Notes |
|---|---|---|
| `{"op":"status"}` | `{connected, budget:{used_sat,total_sat,renews_at}}` | No balance by default |
| `{"op":"prepare","invoice":"lnbc..."}` | `{payment_id, amount_sat, payee, description, expires_at}` | Helper-side verification, see §5 |
| `{"op":"confirm","payment_id":"..."}` | `{ok, status:"paid"\|"failed", fee_sat?}` | Single use; valid for 120 s after prepare |
| `{"op":"cancel","payment_id":"..."}` | `{ok}` | |

There is **no** one-step pay operation; every payment needs `prepare` and then `confirm`. Limits: `prepare` 10 per minute, `confirm` 3 per minute. Error replies are fixed strings that never echo input.

## 5. Invoice verification (in the helper, before showing anything)

- Full BOLT11 decode. The **signature is verified** and the payee node key recovered, using `@noble/curves` secp256k1 and `@scure/base` bech32 (both already locked in the SDK's dependency tree). It must pass every vector in the BOLT11 specification.
- The network must be **mainnet** (`lnbc`), unless the helper was started with an explicit `--network` for testing.
- **Amount required:** amountless invoices are refused.
- The invoice must not be expired and must have at least 60 seconds of validity left. The timestamp must not be in the future.
- The amount must be no more than the budget's remaining amount (`total - used`).
- **Duplicates:** a payment hash that was already paid is refused. Paid hashes are kept in `$XDG_STATE_HOME/omacashu/paid.json` (`0600`), and duplicate prepares are tracked in memory.
- The description is sanitized (control, bidi and line-separator characters removed, at most 120 characters) and shown as **unverified text**.

## 6. Confirmation UX (plugin)

- The alpha warning appears until dismissed with ×. Only that preference is persisted via Omarchy’s widget settings; payment confirmation remains mandatory.

- The panel shows only helper-returned fields:
  - the amount in sats (large);
  - the payee node key (shortened, with the full value on hover);
  - the expiry countdown;
  - the remaining budget after this payment;
  - the description, labeled as "unverified".
- Confirmation is a deliberate press-and-hold action (1.5 s) on a **Pay N sats** button. Esc or closing the panel cancels.
- There is no auto-pay, no "remember this payee" and no background payments. Each `payment_id` is shown once.
- Invoices arrive by pasting into the panel's text field. The field has focus whenever the panel is ready.
- Keyboard alternative: the hold button takes focus on the review screen, and holding <kbd>Space</kbd> for 1.5 s confirms. Auto-repeat events are ignored.
- Limitation, stated in the README and threat model: confirmation prevents mistakes and stops a buggy plugin from paying silently. It cannot stop malware running as your user, which could call the socket directly. The budget is what limits that.

## 7. Plugin rules (enforced by `tests/test_plugin.py`)

- The QML has exactly **one** `Quickshell.Io` `Socket`, at the fixed `$XDG_RUNTIME_DIR/omacashu/helper.sock` path, and sends only `status`, `prepare`, `confirm` and `cancel`.
- The QML has exactly **one** `Quickshell.execDetached` call: `omarchy-launch-floating-terminal-with-presentation` with one of three fixed commands, which open the helper installer, `omacashu connect` or `omacashu disconnect`. The commands are built only from `$HOME`, `$XDG_RUNTIME_DIR` and the plugin folder, and only if each path matches `^/[A-Za-z0-9._/-]+$`. This lets the panel's buttons work without the panel ever handling the secret: the connection string is typed into the helper's own hidden prompt.
- `Process`, `FileView`, network APIs, `openUrlExternally` and clipboard APIs stay forbidden.
- All text stays `PlainText`. The plugin never parses invoices itself.

## 8. Helper sandbox (`systemd --user`)

See `helper/systemd/omacashu-helper.service`. It sets:

- `NoNewPrivileges`, `PrivateUsers`, `PrivateTmp`, `ProtectSystem=strict` and `ProtectHome=read-only`;
- `StateDirectory`/`RuntimeDirectory` (`0700`), the only writable paths;
- `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, because relays need the network;
- `RestrictNamespaces`, `LockPersonality`, `SystemCallFilter=@system-service`, `UMask=0077`, `LimitCORE=0` and memory and task caps.

`MemoryDenyWriteExecute` is omitted because Node's JIT needs it. The service reaches the keyring over the session bus. `systemd-analyze --user security` rates it 4.7 ("OK").

## 9. Threat model changes

| Threat | Result in live wallet mode |
|---|---|
| Malicious or buggy plugin in the same shell | Cannot read the secret. Can submit invoices, but payment needs confirmation in the omaCashu panel. Another plugin could draw over the panel, which is a known limitation |
| Malware running as your user | **Can spend up to the remaining wallet budget per period** and copy the NWC secret from the keyring. Mitigations: small budget, revoke in the wallet, renewal-period limits |
| Fake or tampered invoice details | The helper verifies the signature, network, amount and expiry. The plugin shows only helper data |
| Double payment or replay | Single-use `payment_id`; paid payment hashes are kept across restarts |
| Leaks through logs or crashes | Silenced console, generic errors, nothing secret in journald, systemd `LimitCORE=0` |
| Wallet or relay compromise | Out of scope; bounded by the wallet's own controls |

## 10. Implementation status (0.2.0-alpha)

1. ✅ Verified BOLT11 decoder (`helper/src/bolt11.mjs`): passes every BOLT #11 spec vector, both valid and invalid, plus high-S and tampering tests.
2. ✅ `omacashu connect` and `disconnect`: hidden input, keyring storage, budget, method and ceiling checks.
3. ✅ Daemon: user-only socket, strict request parsing, rate limits, single-use confirmations, persistent ledger, silenced logging.
4. ✅ Sandboxed systemd user unit and home-only installer and uninstaller.
5. ✅ Plugin: helper missing, not connected, unreachable, blocked, ready, review, paying, result and settings states.
6. ✅ Tests:
   - 31 helper unit tests and 25 plugin rule tests;
   - real NWC Faucet end-to-end payment (`helper/test/e2e/faucet-e2e.mjs`);
   - on-device UI flow on Omarchy: paste, review, hold Space, paid. The payee balance confirmed receipt.
7. ⏳ A mainnet payment with a real budget-limited wallet (budget of 1,000 sats or less). This needs your wallet.

## 11. Release gates for the first paying version

- [x] All BOLT11 spec vectors pass, plus negative tests: bad signature, wrong network, amountless, expired, future timestamp, over budget, high-S with an `n` field.
- [x] Connections without a budget or over the ceiling are refused. Extra permissions are allowed and reported. Checked live: the NWC Faucet connection is refused.
- [x] `payment_id` is single-use and expires after 120 s. Duplicate payment hashes are refused across restarts, and unresolved attempts block retries.
- [x] No secret, invoice or amount in logs or stderr. The console is silenced, errors are generic, and the CLI test checks this.
- [x] The socket is user-only (`0600` in `0700`, ownership-checked). The plugin CI allows only the helper socket and the fixed launcher.
- [x] End-to-end payment on the NWC Faucet (fake sats).
- [ ] A mainnet payment with a budget of 1,000 sats or less, using your own wallet.
- [x] README, SECURITY and the listing state that malware running as your user can spend up to the wallet budget.
- [ ] Independent review before promoting live mode beyond alpha.
