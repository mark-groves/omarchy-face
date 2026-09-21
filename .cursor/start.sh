#!/usr/bin/env bash
# Per-boot startup: bring up a headless X display for Quickshell/Qt Quick.
# Idempotent: reuses an already-running Xvfb and returns once it is ready.
set -euo pipefail

DISPLAY_NUM="${QS_DISPLAY_NUM:-99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

is_up() { DISPLAY=":$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; }

if ! is_up; then
  rm -f "/tmp/.X${DISPLAY_NUM}-lock"
  Xvfb ":$DISPLAY_NUM" -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
  for _ in $(seq 1 40); do
    if is_up; then break; fi
    sleep 0.5
  done
fi

if is_up; then
  echo "Xvfb ready on :$DISPLAY_NUM"
else
  echo "Xvfb failed to start; see /tmp/xvfb.log" >&2
  exit 1
fi
