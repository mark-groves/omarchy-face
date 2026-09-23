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
| `hud` | Depth Lattice HUD | Structured-light depth cloud inside dense, counter-rotating instrument rings |
| `radar` | Phosphor Radar | A plan-position scope whose sweep paints the face's topography as radar returns |
| `holo` | Holographic Wireframe | A whole wireframe head and neck projected from an emitter, in structured-light slices |

```bash
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style          # show the active style
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style radar    # switch
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style hud      # back to the default
```

A switch shows on the next frame, including on a lock screen that is already up. The shell does not need a restart. The choice is saved in `~/.config/omarchy/face-style`.

The plugin runs in isolation and is handed nothing to read, so the choice has to live in the module itself. The script writes it into the one `var STYLE = "…"` line of `FaceCardFrame.js`, which the host watches. It does this through a git clean/smudge filter declared in `.gitattributes`: git always sees the published default and a clean tree, so `omarchy plugin update` still fast-forwards, and every update writes your saved style back in. After removing and re-adding the plugin, run `omarchy-face-style apply` to restore the saved choice.

To try styles without switching the installed one, use the preview's style chips, or run `FACE_STYLE=holo quickshell -p Preview.qml`.

Every style covers all three states with the same timing contract, the same corner readouts (top left varies by style, then match confidence, a style gauge, and the status word), and the same rules:

- The face is built only from a relief-mapped depth surface: its depth, its slope, and the way stripes and returns bend over it. No style draws eyes, a mouth or brows, at any size or in any state, and no lock graph puts points on the eyes or mouth.
- A lock plays as a multi-beat sequence over 1.9 s. A miss is told as a story over 1.8 s: the lock is attempted, stutters between the accent and the error colour, then fails. Both stay under the host's 2 s hold clamp.
- A settled recognised face is strokes only. Once the attempt has failed, a miss paints only in the error colour.
- Every frame at the real 116 px slot stays under 1,000 ops and 6,500 path commands, well inside the host caps.

Shared micro-detail sits in the corners: a data bus and a scrolling log under the top-left value, a graduated ruler, caret and oscilloscope trace under the confidence bar, and registration marks. At 100 px and up, telemetry columns of hex scroll beside the face, freeze on a lock and scramble on a miss. Below 150 px they are greeked.

## Depth Lattice HUD (`hud`)

A biometric instrument: a structured-light depth cloud inside counter-rotating instrument rings, with a lock graph and seven-segment readouts in the corners.

| State | What the user sees |
| --- | --- |
| Scanning | Boots in: the rings draw on and the cloud assembles out of a scatter. The cloud is a slope-shaded lattice of about 250 points on the relief, meshed to three neighbours, under twenty structured-light stripes that bend over the brow, nose, cheekbones and chin. It sways in yaw and pitch with depth parallax. A scan plane sweeps down and back up, lighting the dots and stripes it crosses. A second scanner crosses it at right angles, with a scan head where they meet. Around it, all at unrelated periods: a fine polar sub-grid, a radial spectrum of 96 bars with an orbiting crest, a vernier turning against the bezel, an outer micro-scale, a fast and a creeping spinner, satellites with tails on the dashed ring, faint hunting face brackets, and the graduated bezel, segmented data ring and dashed ring. |
| Face recognized | The cloud defocuses and the planes collapse. Face-lock brackets fly in from outside and seat with an overshoot. The rings snap to their detents in a cascade, outermost first, while the spectrum drives to full. The dots lock in a wave from the centre out, and the stripes resolve top to bottom behind a sweep. Thirteen bone-structure landmarks (nose, bridge, brow, forehead, temples, cheekbones, jaw, chin) lock with reticles and flash their IDs, and the graph draws out between them. The cloud dissolves, the rim closes into a graduated dial, a lock burst of rays fires round the rim, and two shockwaves clear the field. The pose settles slightly off-axis. Confidence counts to 99.7 and the status reads `PASS`. |
| Face not recognized | The attempt starts to lock, then stutters. The disc floods red and drains, a chromatic split slips the cloud off register, and static re-rolls every 40 ms. Bands shear, glitch strips tear, the rings jump out of sync, and the spectrum drains into spikes. The reticles lose track, the anchors release under drag, the stripes break, and the rim breaks into dashes. Confidence collapses and `FAIL` blinks. It stays a broken cloud. |

Corner readouts are frame counter (top left), match confidence over a ten-cell bar (top right), sample histogram (bottom left), and status word (bottom right). They are drawn at 100 px and up. Below 76 px the rings collapse to one. Below 48 px the card is a vector glyph: a segmented ring that closes on a lock and breaks on a miss, three structured-light stripes, and the scan line.

## Phosphor Radar (`radar`)

A plan-position scope. The face is its topography: about 750 fine returns laid along thirteen iso-depth contours of the relief, plus the silhouette and a speckle of skin. The socket loops are left out, because concentric loops there read as eyes. Returns decay behind the arm but never below a floor, so the whole face stays legible at 116 px between sweeps. They are range cells, never outlines, so the face reads as sensor data.

| State | What the user sees |
| --- | --- |
| Scanning | The graticule draws on and the first revolution paints the face in. The arm trails a 64-line phosphor afterglow wedge, and fresh returns bloom. Range rings carry sub-ticks every 5 degrees and range labels, bearing spokes run every 10 degrees, an inner azimuth ring creeps against the sweep, and a micro-scale sits outside the bezel. A nodding sector scanner lights the returns it crosses, and a range strobe rides the arm. Interference speckle, spokes and ring flashes re-roll all the time, and clutter re-rolls each time the arm passes it. Target brackets hunt around the face, and three trackers hunt on asymmetric landmarks, with scrambling coordinates beside them. An A-scope over a fine grid traces return amplitude along the bearing. |
| Face recognized | The arm spins up for an extra revolution while the afterglow intensifies. Noise and clutter are filtered out, and the sector scanner collapses. The range rings pulse outward in turn, and the returns refresh in a cascade from the centre out. The target box seats with an overshoot, the trackers lock, and the middle ring expands into a lock ring. Three pings sweep out, and the returns flare as each passes their range. Chevrons seat on the diagonals, a track marker drops onto the centre, and the reticle spins up. Confidence reaches 99.7 and the status reads `PASS`. |
| Face not recognized | The attempt starts, stutters, then the scope is jammed. Speckle floods in, interference spokes and ring flashes strobe, the arm stutters and runs backwards, and the sector scanner jumps about. Returns jitter in range and smear radially, the target box blows apart, and the trackers lose track. Two error pings go out, glitch tears cross the scope, and `FAIL` blinks. |

The top-left readout is the arm bearing in degrees. Below 48 px the glyph is a ring, the sweep arm and three returns.

## Holographic Wireframe (`holo`)

A projected head: a whole head, lofted between side and front profiles, with a cranium behind the face, ears, a jaw and a neck down to an emitter. The face (brow, sockets, nose, cheekbones, lips, chin) is relief on its front. Its layers are:
- 26 structured-light slices round the whole head, lit from the upper left, with a rim light where the surface turns away and a two-colour chromatic fringe; the back of the head shows faintly through
- an outline traced from the slices, so a turn shows the brow, nose and chin in profile
- a vertex point cloud
- a cage turning the other way outside it
- two tilted orbit rings with nodes
- projection beams, a volumetric light cone with volume slices, and pulse rings
- side scopes for the face's depth profile and the scan height

The camera sits a little above the head, and the head turns up to about 45 degrees, so the slices bend over the brow, nose, cheekbones and chin even at 116 px.

| State | What the user sees |
| --- | --- |
| Scanning | The head turns slowly while the cage and the orbits turn at their own rates. Two interference bands roll at different speeds, brightening and jittering what they cross, and tracking points shimmer as they pass. Scanlines, an occasional vertical-hold roll and rare block glitches play over the projector flicker. Motes and pulse rings rise through the lit cone. |
| Face recognized | The flicker steadies and the chromatic fringe closes. The cage spins up, then collapses onto the head and dims, and the orbits level out into a halo at eye height. Two scanner rings pass, down then up, and the head solidifies from the top down behind the first. The point cloud flares, then fuses into the mesh. A scatter of tracking points locks in a wave from the nose outward. The beams and cone flare, the emitter throws a ring, and the head settles in a three-quarter pose. Confidence reaches 99.7 and the status reads `PASS`. |
| Face not recognized | The attempt starts, stutters, then the projection fails. The chromatic split widens and jitters, blocks of the image slip sideways, the vertical hold rolls, and static fills the disc. The slices, point cloud and neck fragment and drift under drag. The cage breaks into dashes, and the orbits wobble and drop. The beams cut out, the emitter sputters, and the tracking points lose track. `FAIL` blinks. |

The top-left readout is head yaw in degrees, and the bottom-left gauges show yaw, pitch and projector sync. Below 48 px the glyph is a turning wire sphere with three sliding slices and the emitter.

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

The tests are the thing to keep green. The boundary checks are why this plugin is allowed to draw on a credential surface at all. The dot-count check is the approved visual: a settled recognised face paints zero dots. The replay-budget checks, run on every 20 ms of every state at 116 px, keep the dense styles affordable on a software canvas.
