# omaCashu: read-only Alby SDK adapter (ALPHA, trusted device only)

**Uses:** [`@getalby/sdk`](https://github.com/getAlby/js-sdk), specifically `NWCClient` from `@getalby/sdk/nwc`, for **read-only** NIP-47 `get_info` and opt-in `get_balance`. There is no payment code.

> [!CAUTION]
> Alpha software. Never connect a funded wallet or a spending-capable connection. Ask your wallet for a **dedicated, revocable connection limited to `get_info` (and optionally `get_balance`)**. If the wallet cannot enforce that limit, do not use the credential.

## Supply chain

- The dependency is pinned exactly (`@getalby/sdk@8.0.3`, released May 2026), with a committed `package-lock.json`.
- The lockfile was resolved with a 4-week cooldown (`--before`), so no dependency is newer than 2026-10-01.
- `.npmrc` sets `ignore-scripts=true`, so no install scripts ever run.
- Verified on 2026-10-29: `npm audit` reports 0 vulnerabilities, and `npm audit signatures` shows all 10 packages with verified registry signatures and 8 with provenance attestations.
- CI runs `npm ci`, `npm audit` and `npm audit signatures` on every push.

To update, review the upstream changelog and diff, then run:

```bash
npm install --package-lock-only --before="$(date -d '-28 days' +%F)" @getalby/sdk@<version>
```

## Use (trusted device only)

```bash
cd sdk
npm ci                      # install scripts disabled by .npmrc
npm test
install -m 0600 /dev/null ~/private/nwc-connection.txt   # paste the URI into this file with an editor
node readonly.mjs info ~/private/nwc-connection.txt
OMACASHU_ALLOW_BALANCE=yes node readonly.mjs balance ~/private/nwc-connection.txt
```

## Protections

- **Credential file:** opened with `O_NOFOLLOW`, then checked on the open handle: regular file, owned by you, mode `0600` or stricter, at most 4 KiB.
- **Connection URI:** strictly parsed. Requires a 64-hex wallet pubkey, exactly one 64-hex secret, and `wss://` relays (`ws://` only for loopback).
- **Output:** all console output from the SDK is silenced. Any error prints a fixed generic message, and there is a 20-second hard timeout.
- **Wallet strings:** strings such as the alias are stripped of control, bidi and line-separator characters, and only allowlisted fields are printed.

Never put an NWC URL in command-line arguments, environment variables, QML, dotfiles, the clipboard, issues, screenshots or logs. Relays still carry the encrypted messages, so this is not offline.
