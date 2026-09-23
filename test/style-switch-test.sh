#!/usr/bin/env bash
# End-to-end tests for bin/omarchy-face-style against a real plugin checkout.
#
# The load-bearing checks: a switch changes the style the host will load,
# `git status` stays clean, and `omarchy plugin update` (a fast-forward
# merge) still succeeds and keeps the chosen style.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  ok   $name"
  else
    echo "  FAIL $name"
    failures=$((failures + 1))
  fi
}

export HOME="$WORK/home"
export XDG_CONFIG_HOME="$HOME/.config"
export GIT_CONFIG_GLOBAL="$WORK/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.name test
git config --file "$GIT_CONFIG_GLOBAL" user.email test@example.invalid
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main

# An upstream repo holding the plugin as published, and an install cloned
# from it the way `omarchy plugin add` does.
UP="$WORK/upstream"
mkdir -p "$UP/bin"
cp "$ROOT/FaceCardFrame.js" "$ROOT/manifest.json" "$ROOT/.gitattributes" "$UP/"
cp "$ROOT/bin/omarchy-face-style" "$UP/bin/"
git -C "$UP" init -q
git -C "$UP" add -A
git -C "$UP" commit -qm published

PLUGIN="$XDG_CONFIG_HOME/omarchy/plugins/markgroves.polkit-face"
mkdir -p "$(dirname "$PLUGIN")"
git clone -q "$UP" "$PLUGIN"
SWITCH="$PLUGIN/bin/omarchy-face-style"
MODULE="$PLUGIN/FaceCardFrame.js"

style_line() { grep -E '^var STYLE = ' "$MODULE"; }
is_style() { style_line | grep -qF "var STYLE = \"$1\""; }
tree_clean() { [[ -z $(git -C "$PLUGIN" status --porcelain) ]]; }
saved_is() { [[ $(cat "$XDG_CONFIG_HOME/omarchy/face-style") == "$1" ]]; }

# The module the host would load exports frame() and paints the given style.
loads_as() {
  node -e '
    const fs = require("fs")
    const body = fs.readFileSync(process.argv[1], "utf8").replace(/^\s*\.pragma\s+library\s*$/m, "")
    const api = new Function(body + "\nreturn { frame: frame, holdMs: holdMs, STYLE: STYLE }")()
    if (api.STYLE !== process.argv[2]) process.exit(1)
    const a = JSON.stringify(api.frame(116, { state: "scanning", clock: 2000, elapsed: 2000 }))
    const b = JSON.stringify(api.frame(116, { state: "scanning", clock: 2000, elapsed: 2000, style: process.argv[2] }))
    process.exit(a === b ? 0 : 1)
  ' "$MODULE" "$1"
}

check 'a fresh install paints the HUD' is_style hud
check 'showing the style works before anything is saved' bash -c "'$SWITCH' | grep -q 'Face style: hud'"
check 'the listed styles are the module styles' bash -c "[[ \$('$SWITCH' list | tr '\n' ' ') == 'hud radar holo ' ]] && grep -q 'var STYLES = \[\"hud\", \"radar\", \"holo\"\]' '$MODULE'"

check 'switching to radar succeeds' "$SWITCH" radar
check 'the module now paints radar' is_style radar
check 'the host would load it as radar' loads_as radar
check 'the choice is saved in ~/.config/omarchy/face-style' saved_is radar
check 'git still sees a clean tree' tree_clean

# Upstream ships a change to the very file the switch rewrote.
printf '\n// upstream change\n' >>"$UP/FaceCardFrame.js"
git -C "$UP" commit -qam 'upstream change'
update() {
  git -C "$PLUGIN" fetch --quiet origin HEAD &&
    git -C "$PLUGIN" merge --ff-only FETCH_HEAD
}
check 'omarchy plugin update still fast-forwards' update
check 'the update landed' grep -q '// upstream change' "$MODULE"
check 'the update kept radar' is_style radar
check 'the tree is clean after the update' tree_clean

check 'switching to holo succeeds' "$SWITCH" holo
check 'the host would load it as holo' loads_as holo

check 'an unknown style is refused' bash -c "! '$SWITCH' sparkles"
check 'a refused style changes nothing' is_style holo

printf 'garbage; rm -rf /\n' >"$XDG_CONFIG_HOME/omarchy/face-style"
check 'a corrupt saved style smudges to the HUD' bash -c "printf 'var STYLE = \"radar\" // omarchy-face:style\n' | '$SWITCH' smudge | grep -qF 'var STYLE = \"hud\"'"
check 'clean always writes the default' bash -c "printf 'var STYLE = \"holo\" // omarchy-face:style\n' | '$SWITCH' clean | grep -qF 'var STYLE = \"hud\"'"

# A reinstall drops the local filter config; apply brings the style back.
echo radar >"$XDG_CONFIG_HOME/omarchy/face-style"
rm -rf "$PLUGIN"
git clone -q "$UP" "$PLUGIN"
check 'a reinstall starts on the HUD' is_style hud
check 'apply restores the saved style' "$SWITCH" apply
check 'the reinstall now paints radar' is_style radar
check 'the reinstall tree is clean' tree_clean

check 'switching back to the HUD succeeds' "$SWITCH" hud
check 'the host would load it as the HUD' loads_as hud
check 'the tree is clean on the HUD' tree_clean

if ((failures == 0)); then
  echo
  echo "all style switch tests passed"
  exit 0
fi
echo
echo "$failures style switch test(s) failed"
exit 1
