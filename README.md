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

| State | What the user sees |
| --- | --- |
| Scanning | A structured-light dot cloud on a depth surface, wired by a mesh. A scan plane sweeps down and back up over 1900 ms. Dots ahead of it drift; dots behind it snap onto the surface and knit. |
| Face recognized | Three beats. The cloud defocuses, which makes the lock-on read as a change. Feature-lock brackets close over the eyes, then the mouth, then the rim. Then each group hands itself to a stroke and the card settles on a drawn face with a check. No dots remain. |
| Face not recognized | The depth lock shears into bands, the anchors release under closed-form drag, the mouth goes to a slight frown and the rim breaks into dashes. It stays a broken cloud, because a miss is the state that never resolves. |

Below 48 px the cloud is rendered as a vector glyph instead. Same circle, same two eyes, same mouth, same morphs. A cloud of 240 dots is a smudge at the 30 px lock in-field slot and the 26 px polkit glyph slot.

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
| `clock` | free-running milliseconds, drives the scan sweep |
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
quickshell -p Preview.qml     # three states, replaying, plus the size ladder
node test/frame-test.js       # boundary and visual tests
```

`Preview.qml` owns its own Canvas and palette and replays the ops itself, mirroring the host painter. It is the reference for how the host drives this plugin.

The tests are the thing to keep green. The boundary checks are why this plugin is allowed to draw on a credential surface at all, and the dot-count check is the approved visual: a settled recognised face paints zero dots.
