# Marketplace submission (prepared)

Submit after `yaeloss/omacashu` is public and CI is green. Confirm every checklist statement yourself. `preview.png` and `assets/social-preview.jpg` are your own captures of this plugin.

## Expected automated results

- **Compatibility validation:** passes. The root manifest is valid, the `bar-widget` entry point exists, and there are no symlinks.
- **Automated Security Baseline:** expect **`review-required`**, with no findings. These capabilities will be flagged for a maintainer to review:
  - `installer`: `helper/install.sh` and `helper/uninstall.sh`;
  - `package-manager`: `npm ci` in the installer;
  - `service-management`: the `omacashu-helper` systemd **user** unit and `systemctl --user`, plus the optional `trusted/deploy/omacashu-broker.service`.

  It should **not** flag:
  - privilege escalation (the installer refuses to run as root and never uses root access);
  - sudoers changes;
  - fetch-and-run code (dependencies come only from the committed lockfile);
  - bundled binaries.

## Issue body

Title: `[Plugin]: omaCashu`

```markdown
### Repository URL

https://github.com/yaeloss/omacashu

### Category

Widgets

### Tags

bar, quickshell, security

### Suggest a missing tag

finance

### Maintainer notes

Lightning/Cashu (NWC) wallet bar widget. The QML has exactly one capability beyond UI: a Socket to a local helper at $XDG_RUNTIME_DIR/omacashu/helper.sock (plus one fixed Omarchy terminal launcher for the helper's install/connect/disconnect commands). The wallet secret never enters omarchy-shell. It lives in the helper (helper/, a sandboxed systemd --user service installed only into $HOME after an explicit click/confirmation) and the system keyring. The helper accepts optional wallet budget reporting with no local spending ceiling, verifies BOLT11 signatures, and requires press-and-hold confirmation for every payment. Expected baseline capabilities: installer, package-manager (npm ci --ignore-scripts from a committed lockfile), service-management (user unit). No root access, no sudoers, no fetch-and-run code. The optional trusted/ folder is a separate-device kit and is never loaded by the shell. Tests: tests/test_plugin.py (QML capability rules), helper/test (BOLT11 spec vectors, policy, socket).

### Submission checklist

- [x] The repository is public and contains installation and removal instructions.
- [x] I have documented the plugin license and any external dependencies.
- [x] I confirm that I own or have permission to submit this plugin and its preview assets.
- [x] The plugin does not overwrite user configuration without explicit consent.
- [x] I understand that approval is for listing and is not a security review.
```

## Submit

Save the issue body above to a file, then:

```bash
gh issue create --repo omacom/omarchy-plugin-marketplace --title "[Plugin]: omaCashu" --body-file /tmp/omacashu-submission.md
```

Or use the [web form](https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=submit-plugin.yml).
