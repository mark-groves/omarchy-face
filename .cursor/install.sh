#!/usr/bin/env bash
# Idempotent bootstrap for the Face Scan Card (Quickshell) dev environment.
# Ubuntu 24.04 only ships Qt 6.4, which is too old for Quickshell, so Quickshell
# and a matching Qt are provided through a single-user Nix install.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# System packages: a headless X server (Xvfb) plus tooling to render and
# screenshot Qt Quick windows without a GPU.
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  xvfb \
  x11-utils \
  x11-xserver-utils \
  scrot \
  ca-certificates \
  curl \
  xz-utils \
  fonts-noto-color-emoji

# Single-user Nix install (creates /nix, edits ~/.profile). Skipped if present.
if [ ! -e "$HOME/.nix-profile/bin/nix-env" ] && [ ! -e /nix/var/nix/profiles/default/bin/nix-env ]; then
  curl -L https://nixos.org/nix/install -o /tmp/nix-install.sh
  sh /tmp/nix-install.sh --no-daemon
fi

# shellcheck disable=SC1091
. "$HOME/.nix-profile/etc/profile.d/nix.sh"

# Quickshell (pulls in a compatible Qt from the Nix binary cache).
if ! command -v quickshell >/dev/null 2>&1; then
  nix-env -iA nixpkgs.quickshell
fi

# Make Nix + headless rendering settings available to interactive agent shells.
MARK_START="# >>> face-scan-card env >>>"
if ! grep -qF "$MARK_START" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<'EOF'
# >>> face-scan-card env >>>
if [ -e "$HOME/.nix-profile/etc/profile.d/nix.sh" ]; then . "$HOME/.nix-profile/etc/profile.d/nix.sh"; fi
export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}"
export QT_QUICK_BACKEND="${QT_QUICK_BACKEND:-software}"
# <<< face-scan-card env <<<
EOF
fi

echo "Quickshell: $(quickshell --version)"
