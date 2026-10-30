# Publishing omaCashu

There is one public repository, `yaeloss/omacashu`, containing the plugin, `helper/` and `trusted/`. The folder is already a git repository on branch `main`, with all files staged.

## 1. Final local checks

```bash
cd omacashu
python3 -m unittest discover -s tests -v
(cd helper && npm ci && npm test && npm audit && npm audit signatures)
(cd trusted && python3 -m unittest discover -s tests -v)
omarchy plugin validate .
git status --short            # only intended files; no node_modules, no secrets
```

Optional: a real payment test with fake sats (`node helper/test/e2e/faucet-e2e.mjs`), and a local secret scan (`gitleaks dir .`). CI also runs gitleaks.

## 2. Commit and push

```bash
git config user.email "you@example.com"     # if not set globally
git commit -m "omaCashu 0.2.0-alpha: live budget-limited payments"
gh repo create yaeloss/omacashu --public --source . --push
```

Or create an empty public repository on GitHub, then run `git remote add origin https://github.com/yaeloss/omacashu.git` and `git push -u origin main`.

## 3. Repository settings

1. **About:** `omaCashu ⚡: Lightning + Cashu (NWC) wallet for the Omarchy bar. Budget-limited, hold-to-pay. Alpha.`
2. **Topics:** `omarchy`, `omarchy-plugins`, `omarchy-quattro`, `quickshell`, `bitcoin`, `lightning-network`, `cashu`, `nostr`, `nip-47`.
3. **Settings → General → Social preview:** upload `assets/social-preview.jpg`.
4. **Settings → Code security:** enable private vulnerability reporting, Dependabot alerts, secret scanning and push protection.
5. **Settings → Branches:** protect `main` (require PRs and the CI checks; no force pushes).
6. **Settings → Actions → General:** set workflow permissions to "Read repository contents".

## 4. Tag and release

```bash
git tag -s v0.2.0-alpha -m "omaCashu 0.2.0-alpha"    # -a if you have no signing key
git push origin v0.2.0-alpha
```

Create a GitHub release from the tag, paste the changelog entry, and mark it as a **pre-release**.

## 5. Marketplace

Follow `docs/MARKETPLACE_SUBMISSION.md`.

## User install

```bash
omarchy plugin add https://github.com/yaeloss/omacashu.git --enable
```

Then: **Install helper** → **Connect wallet** (with a budget) → paste an invoice → hold to pay.
