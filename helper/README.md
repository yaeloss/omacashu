# omaCashu helper

The desktop half of omaCashu. It is the **only** component that holds your wallet connection. The Omarchy panel talks to it over a user-only socket and never sees the secret.

```text
omacashu connect      store a budget-limited NWC connection in the system keyring (hidden input)
omacashu status       helper and wallet status (budget, never balances)
omacashu disconnect   remove the connection (then revoke it in your wallet)
omacashu daemon       the service itself (run by systemd --user)
```

## Install

Click **Install helper** in the omaCashu panel, or run:

```bash
./install.sh            # installs to ~/.local/share/omacashu/helper, enables omacashu-helper (user service)
./uninstall.sh          # removes it; optionally the keyring entry and the payment ledger
```

The installer runs as your user only, and refuses to run as root. It copies the helper out of the plugin folder and installs pinned dependencies with `npm ci --ignore-scripts`. It writes a sandboxed systemd **user** unit and adds `~/.local/bin/omacashu`.

## What it enforces

| Check | Where |
|---|---|
| Connection must have a wallet-enforced budget, at most `budgetCeilingSat` (default 100,000) | `src/policy.mjs` |
| Connection must allow `pay_invoice` and `get_budget`; other permissions are allowed and listed at connect time | `src/policy.mjs` |
| BOLT11 signature, payee, network (mainnet by default), amount present, ≥ 60 s validity, within remaining budget | `src/bolt11.mjs`, `src/policy.mjs` |
| `prepare` → single-use `confirm` within 120 s; at most 10 prepares and 3 confirms per minute | `src/service.mjs` |
| Attempt recorded before paying; paid or unresolved invoices are never paid again; preimage must match | `src/service.mjs`, `src/ledger.mjs` |
| Socket `0600` in a private `0700` directory; 8 KiB requests, 2 s read deadline, 8 connections | `src/server.mjs` |
| Console silenced; errors are fixed strings; nothing secret, and no invoices or amounts, in logs | `bin/omacashu`, `src/*.mjs` |

Optional config, `~/.config/omacashu/helper.json`:

```json
{ "budgetCeilingSat": 50000, "network": "mainnet" }
```

## Protocol (one JSON line per connection)

```json
{"op":"status"}
{"op":"prepare","invoice":"lnbc..."}
{"op":"confirm","payment_id":"<32 hex>"}
{"op":"cancel","payment_id":"<32 hex>"}
{"op":"reload"}
```

There is no one-step pay operation.

## Tests

```bash
npm ci && npm test                 # BOLT11 spec vectors, policy, service (fake wallet), socket, CLI
node test/e2e/faucet-e2e.mjs       # real payment between two NWC Faucet wallets (fake sats)
node test/e2e/ui-daemon.mjs        # serve the panel from a faucet wallet (stop the real helper first)
```

The e2e harnesses build relaxed policies **inside the test files**, because faucet wallets have no budgets. The shipped daemon always uses `STRICT_POLICY`.
