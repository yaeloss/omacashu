#!/bin/bash
# Removes the omaCashu helper from your home directory.
set -euo pipefail

DATA="${XDG_DATA_HOME:-$HOME/.local/share}/omacashu"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/omacashu"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/omacashu-helper.service"

confirm() {
  if command -v gum >/dev/null && [[ -t 0 ]]; then gum confirm "$1"; else read -r -p "$1 [y/N] " a; [[ $a =~ ^[Yy]$ ]]; fi
}

confirm "Remove the omaCashu helper?" || exit 1

systemctl --user disable --now omacashu-helper.service 2>/dev/null || true
rm -f "$UNIT_FILE" "$HOME/.local/bin/omacashu"
systemctl --user daemon-reload 2>/dev/null || true
rm -rf "$DATA"

if confirm "Also delete the wallet connection from your keyring?"; then
  secret-tool clear service omacashu account nwc 2>/dev/null || true
  echo "Keyring entry removed. Revoke the connection in your wallet too."
fi
if [[ -d $STATE ]] && confirm "Also delete the local payment ledger ($STATE)?"; then
  rm -rf "$STATE"
fi

echo "omaCashu helper removed."
