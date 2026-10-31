# Live wallet mode: design

**Status:** implemented in **0.2.0-alpha** (2026-10-29). Unaudited alpha.

**Decisions**
- The NWC spending credential lives in a **desktop helper**, a separate process on the Omarchy machine. It does not live in the plugin.
- Mandatory guardrail: **confirm every payment**. Wallet budgets are optional; no local ceiling.

## 1. Why a helper and not the plugin

Every Omarchy plugin runs inside one unsandboxed `omarchy-shell` process. An NWC URL loaded into QML could be read by any other plugin. A separate helper process keeps the secret out of the shell's memory, and the plugin only ever sees helper-decoded payment details.

What this does **not** protect against: malware running as your login user can still read the keyring entry, or talk to the helper socket directly. In live wallet mode, **exposure is everything the connection permits; only the wallet’s own restrictions limit spending.** Everything else reduces accidents and attack surface.

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
- **Connection check (policy changed 2026-10-31):** `get_info` must advertise `pay_invoice`. `get_budget` is optional: query it only when advertised, and treat an unavailable or unsupported response as no reported budget. Accept connections without budget reporting and budgets of any size; there is no local ceiling. Show the reported budget, or explicitly say it is not reported, before the user types `yes` to save. Wallet-side restrictions remain in force. Other permissions are allowed and listed.
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
- When a budget is reported, the amount must be no more than its remaining amount (`total - used`).
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
- Limitation, stated in the README and threat model: confirmation prevents mistakes and stops a buggy plugin from paying silently. It cannot stop malware running as your user, which could call the socket directly. Only restrictions configured in the wallet limit that.

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
| Malware running as your user | **Can spend everything the connection allows** and copy the NWC secret from the keyring. Mitigations: small budget, revoke in the wallet, renewal-period limits |
| Fake or tampered invoice details | The helper verifies the signature, network, amount and expiry. The plugin shows only helper data |
| Double payment or replay | Single-use `payment_id`; paid payment hashes are kept across restarts |
| Leaks through logs or crashes | Silenced console, generic errors, nothing secret in journald, systemd `LimitCORE=0` |
| Wallet or relay compromise | Out of scope; bounded by the wallet's own controls |

## 10. Current validation

The helper accepts connections without `get_budget` and without a reported budget, and budgets above the former 100,000-sat ceiling. Unit tests cover optional budget reporting and preserve signature, expiry, mainnet, single-use confirmation, replay and preimage checks. Faucet tests use the production policy and fake sats. A successful Cashu.me connection has not yet been verified with the owner's wallet.

Historical release evidence and remaining onboarding checks are in RELEASE_CHECKLIST.md. The earlier mandatory-budget policy was superseded on 2026-10-31.
