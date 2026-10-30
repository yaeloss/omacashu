# omaCashu release checklist

## v0.2.0-alpha: live payments

**Plugin**
- [x] `omarchy plugin validate .` passes. The manifest is at version `0.2.0-alpha`, with a description that names the budget, the helper and the alpha status.
- [x] `qmllint` with Omarchy shell imports shows only duck-typing `missing-property` warnings, the same as the built-in plugins.
- [x] CI rules: one helper socket, one fixed launcher, four protocol operations, plain text only, an exact list of executables, and no bundled binaries.
- [x] UI matches the original concept: header with a gear, alpha banner, centered state with a primary button, footer row.
- [x] Tested on Omarchy (Hyprland 0.56.2):
  - helper missing → install, and not connected;
  - connected, review, hold Space, paying, paid (with a faucet wallet);
  - no QML errors.

**Helper**
- [x] Verified BOLT11 decoder that passes every BOLT #11 spec vector.
- [x] Strict policy: budget required, ceiling, mainnet only, amount required, expiry margin, ledger.
- [x] Single-use 120-second confirmations. The attempt is written to the ledger before the wallet is contacted, and success requires a matching preimage.
- [x] User-only socket, bounded requests, rate limits, silenced logging, generic errors.
- [x] Sandboxed user unit (`systemd-analyze --user security`: 4.7 OK). The installer uses only your home directory; uninstaller included.
- [x] Lockfile resolved with a 4-week cooldown. `npm audit`: 0 vulnerabilities. `npm audit signatures`: all verified.
- [x] Real end-to-end payment on the NWC Faucet (fake sats). The strict policy refuses the faucet connection.
- [ ] A mainnet payment with your own wallet and a budget of 1,000 sats or less.

**Repository**
- [x] Single public repository: plugin, `helper/`, and `trusted/`, the optional kit with its tests passing.
- [x] gitleaks clean. Actions pinned by SHA. Dependabot covers actions and both npm projects.
- [x] `preview.png` and `assets/social-preview.jpg` are real captures from a test wallet, with private screen content removed.
- [ ] Commit, push, enable private vulnerability reporting, upload the social preview, and create a signed `v0.2.0-alpha` tag.
- [ ] Marketplace submission (`docs/MARKETPLACE_SUBMISSION.md`). Expect the security baseline to say `review-required`, because of the helper installer, npm and the systemd user unit.

## Never claim before verified

- Audited, sandboxed (the plugin itself is not), production-ready, fully offline or zero-risk.
- That live wallet mode protects against malware running as your user. It doesn't; the wallet budget is the limit.
- That all Cashu wallets support NWC, or NWC budgets.

## Trusted-device payment gates (future, `trusted/`)

- [ ] Use the verified BOLT11 decoder in the broker, and bind approval to the signed amount, recipient and payment hash.
- [ ] Approval on the trusted device's own screen. No spending credential or approval secret on Omarchy.
- [ ] Broker caps plus a wallet budget, idempotency and fail-closed behavior.
- [ ] Adversarial tests and an independent review.

## Onboarding review (2026-10-30)

- [x] Panel explains install, wallet preparation, hidden credential entry and the return to payment screen.
- [x] Setup recovery guide documents prerequisites and common failures.
- [ ] Validate the revised panel on Omarchy, including narrow screens and keyboard navigation; capture new preview and social images before release.
- [ ] Test clean installation with no helper, missing prerequisites, locked keyring and interrupted install.
- [ ] Test a real budget-compatible wallet: connect, reconnect, revoke and disconnect, then a small owner-approved mainnet payment.
- [ ] Publish a wallet compatibility table with tested wallet versions and budget support. Faucet tests use a relaxed policy and do not prove production onboarding works.
- [ ] Distinguish installed-but-stopped helper from missing helper in the setup UI; current socket failure offers installation for either case.
- [x] Installer retains code and launch configuration until startup succeeds; isolated tests cover failed upgrade, failed first install and successful upgrade.
- [ ] Verify private vulnerability reporting and release links after creating the GitHub repository.

These entries record remaining work; previously checked historical claims are not a fresh security audit.

### Checks rerun for this onboarding change

- 25 plugin checks, 31 helper tests and 42 trusted-kit tests passed locally.
- Omarchy plugin validation passed. QML lint with Omarchy imports reports only existing-style missing-property warnings.
- This run did not exercise a funded wallet, reinstall the live plugin or retake UI captures. Dependency audits and secret scanning must also pass on GitHub before release.

### Review fixes (2026-10-30)

- Ledger read errors other than a missing file and invalid schemas prevent startup. Directory entries are synced after atomic replacement, before contacting the wallet.
- Regression tests cover invalid ledger schemas, unreadable ledger paths and persistence failure preventing wallet calls.
- Installed panel warning is dismissible and persists through Omarchy widget settings; `preview.png` shows the payment panel with the warning dismissed, using an NWC Faucet test wallet and simulated budget.
- Budget-compatible wallet onboarding, clean-machine/keyring scenarios and full social captures remain open gates above. No funded payment was performed for these changes.
