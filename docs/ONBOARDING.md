# Set up omaCashu

The panel guides you through **install → connect → review and pay**. This is an unaudited alpha. Start with a new wallet connection with a small budget; 1,000 sats is enough for a first test.

## 1. Install the helper

Open omaCashu in the bar and choose **Install helper**. A terminal opens. Read the installation summary and accept when ready. The helper installs into your home directory.

You need Node.js 22+, npm, libsecret (`secret-tool`), a Secret Service keyring and user services. If installation stops, read the missing-requirement message, resolve it and try again. No wallet connection is needed at this step.

Reopen the panel when installation finishes. If it still shows step 1, choose **I've finished — check setup**. This screen means the helper could not be reached; it does not prove the helper is absent. If already installed, check `systemctl --user status omacashu-helper` before reinstalling.

## 2. Prepare and connect your wallet

In your wallet's Nostr Wallet Connect settings, create a new connection named omaCashu. Enable paying invoices (`pay_invoice`) and reading the budget (`get_budget`). Set a small wallet-enforced spending budget and check whether it renews. Other permissions are accepted, but give only those you need.

Not every Cashu or Lightning wallet supports NWC or NWC budgets. A balance is not a connection budget. If your wallet cannot issue a budget-limited NWC connection, it cannot be used with this release.

Choose **Continue in secure prompt** in the panel. Paste the connection string into the hidden terminal prompt. Never paste a seed phrase. The helper checks the wallet, shows its reported budget and asks you to type `yes` before saving in the system keyring.

Reopen the panel. A ready screen with your remaining budget means connection checks passed. This does not constitute a successful payment test.

## 3. Review and pay

Use an amount-bearing mainnet Lightning invoice with at least a minute remaining. Check the verified amount and destination, then hold the payment button or Space for 1.5 seconds. Confirm receipt in the destination wallet. Do not retry a payment with an uncertain outcome until you check your wallet.

## If something stops setup

| What you see | What to do |
|---|---|
| Missing Node.js, npm or secret-tool | Install the prerequisite named by the installer and rerun it. |
| Cannot save to keyring | Unlock your system keyring and ensure Secret Service is available; run connect again. There is no plaintext fallback. |
| No wallet-enforced budget | Create a connection with a budget in a wallet that supports `get_budget`. |
| Budget exceeds ceiling | Lower the connection budget in your wallet; the default local ceiling is 100,000 sats per period. |
| Wallet unreachable | Check internet access and whether the wallet is online, then retry. |
| Connected but blocked | Read the reported policy problem and correct the connection in your wallet. |
| Command not found | Run `~/.local/bin/omacashu status` directly. |

To disconnect, use the panel settings and then revoke the connection in your wallet. Local removal alone does not revoke a copied connection string. Malware running as your desktop user can spend up to the remaining wallet budget.
