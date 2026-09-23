# Face Scan Card

The shared face-scan display card for Omarchy. One card for every face-scan surface, with three states: scanning, face recognized, face not recognized.

This repo is UI only. It does not write PAM, does not talk to Howdy, does not receive the polkit flow, and never sees a password field. Install it after face is already set up on the host.

## Install

```bash
omarchy plugin add https://github.com/mark-groves/omarchy-face --enable
```

`omarchy plugin add` never uses sudo. The plugin lands at `~/.config/omarchy/plugins/markgroves.polkit-face/`.

Without `--enable`, or if the plugin is later disabled, the first-party card keeps its face glyph and "Look at the camera" hint at password size. Howdy still runs from the host PAM overlay.

## The card

A biometric instrument: a structured-light depth cloud inside counter-rotating instrument rings, with a landmark graph and seven-segment readouts in the corners.

| State | What the user sees |
| --- | --- |
| Scanning | Boots in: the rings draw on and the cloud assembles out of a scatter. The cloud sways a few degrees in yaw and pitch, with depth parallax, so it reads as a surface rather than a sticker. A scan plane, clipped to the disc and carrying range ticks, sweeps down and back up over 1900 ms. Dots ahead of it drift; dots behind it snap on and knit, and landmark crosshairs flare as it crosses them. A graduated bezel with a travelling cursor, a segmented data ring with orbiting carets, and a dashed inner ring all turn at unrelated periods. |
| Face recognized | Three beats, about 1.1 s. The cloud defocuses and the plane collapses. The sway stills and every ring snaps to its nearest detent with a spring. Thirteen landmarks lock in a cascade, reticles contract onto them, and the graph edges draw out between locked points. The cloud dissolves into that wireframe, the rim and data ring close, the cardinal clamps slam in, and a shockwave clears the field. Confidence counts to 99.7 and the status reads `PASS`. No dots remain, and there is no smile: the mouth is a measured line in every state. |
| Face not recognized | The depth lock tears: bands shear, glitch strips re-roll every 45 ms, and the rings jump out of sync. Landmark reticles hunt and are struck through. The anchors release under closed-form drag and the rim breaks into dashes. Confidence climbs, stalls and collapses to `00.0`, and `FAIL` blinks. It stays a broken cloud, because a miss is the state that never resolves. |

Corner readouts are frame counter (top left), match confidence over a ten-cell bar (top right), sample histogram (bottom left), and status word (bottom right). They are drawn at 100 px and up. The real lock, polkit and sudo slot is 116 px. Below 76 px the rings collapse to one. Below 48 px the cloud is rendered as a vector glyph instead: a segmented ring that closes on a lock and breaks on a miss, two eye marks, a mouth line and the scan line.

Strokes that share a role, alpha and width are batched into one path op, so a frame is about 300 ops at the real slot, fewer than the old card's 460, even with the instrument on top.

## Contract

| Manifest | Value |
| --- | --- |
| `id` | `markgroves.polkit-face` |
| `kinds` | `["polkit-chrome"]` |
| `entryPoints.polkitFace` | `FaceCardFrame.js` |

The entry point is a **JavaScript module, not a QML Item**. It exports exactly two functions:

```js
frame(size, spec) -> ops     // one frame as a list of numeric draw ops
holdMs(state)     -> ms      // how long the host should hold that state
```

`spec` carries only values:

| Field | Meaning |
| --- | --- |
| `state` | `"scanning"`, `"recognized"` or `"notRecognized"` |
| `clock` | free-running milliseconds, drives every ambient motion |
| `elapsed` | milliseconds since `state` was entered |

There are no colours in the spec. Each op carries a role index (0 accent, 1 foreground, 2 error) and the host resolves it against the live theme, so the card follows whatever theme is set and the plugin never chooses a colour.

### Why it is not a QML Item

A security review rated it HIGH that a plugin `Item` loaded onto a credential surface can walk `parent` and read the password field. Measured on Quickshell 0.3.1 / Qt 6.11, the ways that hole stays open are broader than one `Loader`:

- A plugin `Item` parented anywhere under the surface reaches the field.
- A `Loader` reaches the field even when it loads a non-Item `QtObject`, because the loader still injects a scope `parent`.
- A detached `Item` used as a `ShaderEffectSource.sourceItem` reaches the field, because being a source attaches the host **window** even though `parent` stays null.
- **Handing a plugin a 2D drawing context reaches the field.** The context exposes `canvas`, the canvas is a host `Item`, and its parent chain ends at the password field. A "pure paint routine" that takes a context is not isolated.

So the plugin is handed nothing at all. It returns numbers and the host draws them. The host treats the returned frame as hostile input: non-finite values are dropped, alpha and line width are clamped, coordinates are bounded, and the op and path-command counts are capped.

### Op format

```
[0, role, alpha, lineWidth, cmds]              stroke a path
[1, role, alpha, x, y, w, h]                   fill a rect
[2, role, alphaFrom, alphaTo, x, y, w, h,      fill a vertical gradient rect
    yFrom, yTo]

cmds entries:
  [0, x, y]                 moveTo
  [1, x, y]                 lineTo
  [2, cx, cy, x, y]         quadraticCurveTo
  [3, cx, cy, r, a0, a1]    arc
```

## Develop

```bash
quickshell -p Preview.qml     # scripted scan / lock / rescan / miss, the 116 px slot, the size ladder
node test/frame-test.js       # boundary and visual tests
```

`Preview.qml` owns its own Canvas and palette and replays the ops itself, mirroring the host painter. It is the reference for how the host drives this plugin.

The tests are the thing to keep green. The boundary checks are why this plugin is allowed to draw on a credential surface at all, and the dot-count check is the approved visual: a settled recognised face paints zero dots.
