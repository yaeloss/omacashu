#!/bin/bash
# omaCashu helper installer.
# Installs only into your home directory (no root access, no system changes):
#   ~/.local/share/omacashu/helper      helper code + pinned dependencies (npm ci, install scripts disabled)
#   ~/.config/systemd/user/             omacashu-helper.service (sandboxed user service)
#   ~/.local/bin/omacashu               command wrapper
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/omacashu"
DEST="$DATA/helper"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BIN_DIR="$HOME/.local/bin"
UNIT=omacashu-helper.service

fail() { echo "omacashu install: $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] || fail "run as your normal user, not root"
[[ $DEST =~ ^[A-Za-z0-9._/-]+$ ]] || fail "unsupported characters in install path: $DEST"

find_node() {
  local candidate major
  for candidate in /usr/bin/node "$(command -v node 2>/dev/null || true)"; do
    [[ -n $candidate && -x $candidate ]] || continue
    major=$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if (( major >= 22 )); then echo "$candidate"; return 0; fi
  done
  return 1
}

NODE="$(find_node)" || fail "Node.js 22+ is required (omarchy pkg add nodejs-lts-jod)"
NPM="$(dirname "$NODE")/npm"
[[ -x $NPM ]] || NPM="$(command -v npm 2>/dev/null)" || fail "npm is required"
command -v secret-tool >/dev/null || fail "secret-tool is required (omarchy pkg add libsecret)"
command -v systemctl >/dev/null || fail "systemd is required"

cat <<INFO

omaCashu helper: live Lightning payments for the omaCashu bar widget.

  • Keeps your wallet connection (NWC) in the system keyring, never in the plugin.
  • Refuses connections without a wallet-enforced spending budget.
  • Every payment needs your confirmation in the panel.
  • Risk: anything running as your user could spend up to that budget. Keep it small.

Installs to $DEST, using $NODE.
INFO

if [[ ${1:-} != --yes ]]; then
  if command -v gum >/dev/null && [[ -t 0 ]]; then
    gum confirm "Install the omaCashu helper?" || exit 1
  else
    read -r -p "Install the omaCashu helper? [y/N] " answer
    [[ $answer =~ ^[Yy]$ ]] || exit 1
  fi
fi

mkdir -p "$DATA"
chmod 700 "$DATA"
STAGE="$DATA/helper.new.$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$SRC/bin" "$SRC/src" "$SRC/systemd" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/.npmrc" "$STAGE/"
echo "Installing pinned dependencies (lockfile verified, install scripts disabled)…"
(cd "$STAGE" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
chmod -R go-rwx "$STAGE"

# Keep both code and launch configuration until the replacement is healthy.
BACKUP=$(mktemp -d "$DATA/helper.rollback.XXXXXX")
WAS_ACTIVE=false
WAS_ENABLED=false
systemctl --user is-active --quiet "$UNIT" && WAS_ACTIVE=true
systemctl --user is-enabled --quiet "$UNIT" && WAS_ENABLED=true
[[ ! -e $UNIT_DIR/$UNIT ]] || cp -a "$UNIT_DIR/$UNIT" "$BACKUP/unit"
[[ ! -e $BIN_DIR/omacashu ]] || cp -a "$BIN_DIR/omacashu" "$BACKUP/wrapper"
REPLACED=false
rollback() {
  local result=$?
  trap - EXIT INT TERM
  if (( result != 0 )); then
    echo "omacashu install: restoring the previous installation" >&2
    systemctl --user stop "$UNIT" 2>/dev/null || true
    if $REPLACED; then rm -rf "$DEST"; fi
    [[ ! -d $BACKUP/helper ]] || mv "$BACKUP/helper" "$DEST"
    if [[ -e $BACKUP/unit ]]; then cp -a "$BACKUP/unit" "$UNIT_DIR/$UNIT"; else rm -f "$UNIT_DIR/$UNIT"; fi
    if [[ -e $BACKUP/wrapper ]]; then cp -a "$BACKUP/wrapper" "$BIN_DIR/omacashu"; else rm -f "$BIN_DIR/omacashu"; fi
    systemctl --user daemon-reload || true
    if $WAS_ENABLED; then systemctl --user enable "$UNIT" || true
    else systemctl --user disable "$UNIT" 2>/dev/null || true; fi
    if $WAS_ACTIVE; then systemctl --user start "$UNIT" || true; fi
  fi
  rm -rf "$STAGE" "$BACKUP"
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

systemctl --user stop "$UNIT" 2>/dev/null || true
[[ ! -d $DEST ]] || mv "$DEST" "$BACKUP/helper"
mv "$STAGE" "$DEST"
REPLACED=true

mkdir -p "$UNIT_DIR" "$BIN_DIR"
sed -e "s|@NODE@|$NODE|g" -e "s|@HELPER@|$DEST|g" "$DEST/systemd/$UNIT" > "$UNIT_DIR/$UNIT"
printf '#!/bin/sh\nexec "%s" --no-warnings "%s/bin/omacashu" "$@"\n' "$NODE" "$DEST" > "$BIN_DIR/omacashu"
chmod 755 "$BIN_DIR/omacashu"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
sleep 1
systemctl --user is-active --quiet "$UNIT" || fail "helper did not start; see: journalctl --user -u $UNIT"

cat <<DONE

✓ omaCashu helper installed and running.

Next: connect a wallet with a spending budget:
    omacashu connect

Remove later with: $SRC/uninstall.sh
DONE
