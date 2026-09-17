# Face Scan Card

Unique Quickshell chrome for the Omarchy polkit face card: a rotating scan ring around the host-owned face glyph.

This repo is UI only. It does not write PAM, does not talk to Howdy, and does not receive the polkit flow. Install it after face is already set up on the host.

## Install

```bash
omarchy plugin add https://github.com/mark-groves/omarchy-polkit-face --enable
```

`omarchy plugin add` never uses sudo. The plugin lands at `~/.config/omarchy/plugins/markgroves.polkit-face/`.

Without `--enable`, or if the plugin is later disabled, the first-party card keeps its face glyph and "Look at the camera" hint at password size. Howdy still runs from the host PAM overlay.

## Contract

| Manifest | Value |
| --- | --- |
| `id` | `markgroves.polkit-face` |
| `kinds` | `["polkit-chrome"]` |
| `entryPoints.polkitFace` | `PolkitFaceCard.qml` |

The host injects one `chrome` object after load. Paint from those properties. Do not expect `flow`, a PAM context, or any way to size the dialog.

Preview without the fork checkout:

```bash
quickshell -p dev/Preview.qml
```
