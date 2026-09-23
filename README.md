# Face Scan Card

The shared face-scan display card for Omarchy. One card for every face-scan surface, with three states: scanning, face recognized, face not recognized.

This repo is UI only. It does not write PAM, does not talk to Howdy, does not receive the polkit flow, and never sees a password field. Install it after face is already set up on the host.

## Install

```bash
omarchy plugin add https://github.com/mark-groves/omarchy-face --enable
```

`omarchy plugin add` never uses sudo. The plugin lands at `~/.config/omarchy/plugins/markgroves.polkit-face/`.

Without `--enable`, or if the plugin is later disabled, the first-party card keeps its face glyph and "Look at the camera" hint at password size. Howdy still runs from the host PAM overlay.

## Switching styles

The card ships three styles. The Depth Lattice HUD is the default.

| Style | Name | Look |
| --- | --- | --- |
| `hud` | Depth Lattice HUD | Structured-light depth cloud inside counter-rotating instrument rings |
| `radar` | Phosphor Radar | A plan-position scope whose sweep paints the face as radar returns |
| `holo` | Holographic Wireframe | A perspective wireframe face mask projected from an emitter |

```bash
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style          # show the active style
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style radar    # switch
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style hud      # back to the default
```

A switch shows on the next frame, including on a lock screen that is already up. The shell does not need a restart. The choice is saved in `~/.config/omarchy/face-style`.

The plugin runs in isolation and is handed nothing to read, so the choice has to live in the module itself. The script writes it into the one `var STYLE = "…"` line of `FaceCardFrame.js`, which the host watches. It does this through a git clean/smudge filter declared in `.gitattributes`: git always sees the published default and a clean tree, so `omarchy plugin update` still fast-forwards, and every update writes your saved style back in. After removing and re-adding the plugin, run `omarchy-face-style apply` to restore the saved choice.

To try styles without switching the installed one, use the preview's style chips, or run `FACE_STYLE=holo quickshell -p Preview.qml`.

Every style covers all three states with the same timing contract, the same corner readouts (top left varies by style, then match confidence, a style gauge, and the status word), and the same rules. The mouth is a level line in every state, a settled recognised face is strokes only, and a miss paints only in the error colour.

## Depth Lattice HUD (`hud`)

A biometric instrument: a structured-light depth cloud inside counter-rotating instrument rings, with a landmark graph and seven-segment readouts in the corners.

| State | What the user sees |
| --- | --- |
| Scanning | Boots in: the rings draw on and the cloud assembles out of a scatter. The cloud sways a few degrees in yaw and pitch, with depth parallax, so it reads as a surface rather than a sticker. A scan plane, clipped to the disc and carrying range ticks, sweeps down and back up over 1900 ms. Dots ahead of it drift; dots behind it snap on and knit, and landmark crosshairs flare as it crosses them. A graduated bezel with a travelling cursor, a segmented data ring with orbiting carets, and a dashed inner ring all turn at unrelated periods. |
| Face recognized | Three beats, about 1.1 s. The cloud defocuses and the plane collapses. The sway stills and every ring snaps to its nearest detent with a spring. Thirteen landmarks lock in a cascade, reticles contract onto them, and the graph edges draw out between locked points. The cloud dissolves into that wireframe, the rim and data ring close, the cardinal clamps slam in, and a shockwave clears the field. Confidence counts to 99.7 and the status reads `PASS`. No dots remain, and there is no smile: the mouth is a measured line in every state. |
| Face not recognized | The depth lock tears: bands shear, glitch strips re-roll every 45 ms, and the rings jump out of sync. Landmark reticles hunt, then lose track as their corners drift apart and fade. The anchors release under closed-form drag and the rim breaks into dashes. Confidence climbs, stalls and collapses to `00.0`, and `FAIL` blinks. It stays a broken cloud, because a miss is the state that never resolves. |

Corner readouts are frame counter (top left), match confidence over a ten-cell bar (top right), sample histogram (bottom left), and status word (bottom right). They are drawn at 100 px and up. The real lock, polkit and sudo slot is 116 px. Below 76 px the rings collapse to one. Below 48 px the cloud is rendered as a vector glyph instead: a segmented ring that closes on a lock and breaks on a miss, two eye marks, a mouth line and the scan line.

Strokes that share a role, alpha and width are batched into one path op, so a frame is about 300 ops at the real slot, fewer than the old card's 460, even with the instrument on top.

## Phosphor Radar (`radar`)

A plan-position scope with range rings, a bearing bezel and a sweep arm trailing a persistence wedge. The face is a fixed set of returns: the rim, two iris rings, the nose, a level mouth row and sparse skin. The returns decay behind the arm but never below a floor, so the whole face stays legible at 116 px between sweeps. They are range cells and radial ticks, not outlines, so the face reads as sensor data.

| State | What the user sees |
| --- | --- |
| Scanning | The graticule draws on and the first revolution paints the face in. Returns flare under the arm and fade to their floor over a 2.4 s revolution. Clutter re-rolls each time the arm passes it. A bezel cursor rides with the arm, and an A-scope in the corner traces return amplitude along the current bearing. |
| Face recognized | The arm spins up for an extra revolution that refreshes every return at once, then fades. The returns stop decaying and clutter is filtered out. The middle range ring expands into a lock ring around the face, four chevrons seat on the diagonals, and a track marker drops onto the centre. Two sonar pings clear the scope. Confidence reaches 99.7 and the status reads `PASS`. |
| Face not recognized | The arm stutters and runs backwards. The range rings wobble, clutter floods in, and the returns smear radially and dim. The chevrons hunt and fade, and glitch tears cross the scope. Confidence collapses and `FAIL` blinks. |

The top-left readout is the arm bearing in degrees. Below 48 px the glyph is a ring, the sweep arm, eye marks and mouth ticks.

## Holographic Wireframe (`holo`)

A projected face mask: a relief-mapped half ellipsoid with a nose, eye sockets, brow and lips. It is wired by latitude and longitude lines in true perspective, with depth-faded hidden lines, and rises from an emitter ring through a faint projection cone. It turns at most about 22 degrees, with a bold silhouette and surface feature contours, so it stays a face at 116 px while the parallax sells the depth.

| State | What the user sees |
| --- | --- |
| Scanning | The mask turns slowly. An interference band rolls down it, brightening and jittering the lines it crosses, and landmark pips shimmer as it passes. The projector flickers and drops out now and then. Motes rise through the cone, and scanlines roll across the disc. |
| Face recognized | The mask eases face-on and the flicker stops. A body-scanner ring travels down the mask as it solidifies. Landmark reticles lock in a cascade. The emitter throws a ring outward, confidence reaches 99.7, and the status reads `PASS`. |
| Face not recognized | The pose jerks and the projection tears into glitch slices. The mesh fragments: segments shrink and drift outward under drag. The projector flickers out, the emitter ring sputters, and the landmark reticles lose track. `FAIL` blinks. |

The top-left readout is head yaw in degrees, and the bottom-left gauges show yaw, pitch and projector sync. Below 48 px the glyph is a turning wire sphere with eye marks, a mouth line and the emitter.

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
| `style` | optional, `"hud"`, `"radar"` or `"holo"`. It overrides the installed style, and unknown values are ignored. Today's host does not send it; the preview does. |

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
quickshell -p Preview.qml       # scripted scan / lock / rescan / miss, style chips, the 116 px slot, the size ladder
node test/frame-test.js         # boundary, visual and per-style tests
bash test/style-switch-test.sh  # the style switch against a real plugin checkout and update
```

`Preview.qml` owns its own Canvas and palette and replays the ops itself, mirroring the host painter. It is the reference for how the host drives this plugin.

The tests are the thing to keep green. The boundary checks are why this plugin is allowed to draw on a credential surface at all, and the dot-count check is the approved visual: a settled recognised face paints zero dots.
