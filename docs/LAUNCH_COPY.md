# omaCashu: launch copy (alpha)

## GitHub short description

omaCashu ⚡: Lightning + Cashu (NWC) wallet for the Omarchy bar. Budget-limited, hold-to-pay. Alpha.

## Tagline

**omaCashu: Lightning + Cashu for the Omarchy bar.** *Your wallet. Your budget. Every payment confirmed.*

## Announcement (post only after the repository is public)

⚡ omaCashu 0.2.0-alpha: pay Lightning invoices from your Omarchy bar.

Connect your existing Lightning or Cashu wallet over Nostr Wallet Connect (NIP-47). The connection stays in your system keyring, held by a small sandboxed helper and never by the desktop shell. omaCashu refuses any connection without a spending budget enforced by your wallet. It verifies every invoice's signature, amount and expiry, and pays only when you press and hold.

⚠️ Unaudited alpha. Use a new, small, budget-limited connection.

`omarchy plugin add https://github.com/yaeloss/omacashu.git --enable`

## Language rules

- Say "budget-limited" and "anything running as your user could spend up to the budget", not "safe" or "secure wallet".
- Say "Cashu-compatible when the wallet exposes NWC with budgets", not "works with all Cashu wallets".
- Say "the wallet connection never enters the shell", not "keys never leave your device". The helper on your desktop does hold the connection.
- NWC relays encrypted messages, so never say "fully offline".
