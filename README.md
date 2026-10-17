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

All three are designed for the large card: 220 px on the lock screen, the polkit prompt and the sudo face overlay.

On a host that paints op level 3, the card is an instrument display: the host puts it on a dark glass panel derived from the theme, on light and dark themes alike, and resolves every colour against that glass. The instrument is one lit system in the accent. Structure (graduations, grids, scales, the cage) is the dim tier, the live signal (rings, scan plane, sweep arm, lock rim, reticles) is the bright tier with its edges in the bloom, and key strokes carry a white-hot core. Numerals are in ink. The theme's second and third hues are kept to a few small data channels. Once a miss fails, the whole instrument, structure included, turns to the error colour. Crossing strokes add up and run hot on the glass.

On a host that paints op level 2 (the Omarchy fork with the large card), every style is drawn as an instrument with three tiers of colour. The live signal (rings, scan plane, sweep arm, lock rim, reticles) is in the accent, and only its edges light the GPU bloom, so the glow sits on the lit strokes instead of hazing the card. Graduations, grids, scales and the cage are engraved in the foreground, as ink. The theme's second and third hues are kept to a few small data channels. A faint plate of the foreground sits under the instrument: a face plate on a light card, a lifted glass on a dark one. Crossing strokes add up and run hot on a dark card, and key strokes carry a white-hot core. On an older host the same module draws its original frame, with faked halos in the accent, foreground and error colours.

| Style | Name | Look |
| --- | --- | --- |
| `hud` | Depth Lattice HUD | A lit, triangulated depth head under a sweeping scan plane, inside dense, counter-rotating instrument rings |
| `radar` | Phosphor Radar | A plan-position scope whose sweep paints the face's topography as radar returns |
| `holo` | Holographic Wireframe | A whole wireframe head floating in an emitter's light cone, in structured-light slices |

```bash
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style          # show the active style
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style radar    # switch
~/.config/omarchy/plugins/markgroves.polkit-face/bin/omarchy-face-style hud      # back to the default
```

A switch shows on the next frame, including on a lock screen that is already up. The shell does not need a restart. The choice is saved in `~/.config/omarchy/face-style`.

The plugin runs in isolation and is handed nothing to read, so the choice has to live in the module itself. The script writes it into the one `var STYLE = "…"` line of `FaceCardFrame.js`, which the host watches. It does this through a git clean/smudge filter declared in `.gitattributes`: git always sees the published default and a clean tree, so `omarchy plugin update` still fast-forwards, and every update writes your saved style back in. After removing and re-adding the plugin, run `omarchy-face-style apply` to restore the saved choice.

To try styles without switching the installed one, use the preview's style chips, or run `FACE_STYLE=holo quickshell -p Preview.qml`.

Every style covers all three states with the same timing contract, the same corner readouts (top left varies by style, then match confidence, a style gauge, and the status word), and the same rules:

- The subject is one shared model: a generic, anonymous head with a broad, shallow relief (forehead, brow, nose bridge, cheeks, chin) and a neck (the holo style stops at the chin). It is shown only as depth: point density, contour and topology lines, a surface-conforming scan line and shading. No eye, nose, mouth, lip, brow or jaw is ever drawn, so it reads as a head being scanned rather than a cartoon face.
- The scanner's analysis is shown with technical markers, not pictures: landmark points, crosshair brackets, measurement ticks, distance lines and confidence readouts at fifteen regions of the face. While scanning, each marker seats as the style's scan head passes it. A recognised face confirms them in a cascade and the mesh locks with them. A miss never lets them confirm: they drift off, break away and fade in the error colour while the head volume stays visible. The attempt scans for 450 ms before it fails, so a miss never flashes a result state.
- A lock plays as a multi-beat sequence over 1.9 s. A miss is told as a story over 1.8 s: the scan runs for 450 ms in the accent, then the markers fail to confirm and break off in the error colour. Both stay under the host's 2 s hold clamp.
- A settled recognised face is strokes only. Once the attempt has failed, a miss paints only in the error colour.
- Every frame on the 220 px card stays under 1,500 ops, 7,500 path commands and 1,200 glowing ops, well inside the host caps (6,000 ops, 600 commands per op, 2,000 glow ops).
- Every colour follows the active Omarchy theme. The plugin paints role indices only; the host resolves them, including the derived roles (see [Contract](#contract)).

Shared micro-detail sits in the corners. The numerals are seven-segment with ghosted unlit segments; they boot on in a scramble, and a digit that changes lights its new segments hot and lets the old ones fade behind it. Confidence is a ten-cell bar filled to the pixel, with end stops, a lock-threshold tick, a bright leading edge and a sliding glint, over a graduated ruler whose major ticks sit on the cell boundaries, a caret, and an oscilloscope trace with a centre line, a trigger mark and a lingering trace. The status word sits in a framed tag: a cursor runs round it while scanning, PASS snaps the frame in from larger with a hot flash and a ring, and FAIL blinks word and frame hard. A data bus and a scrolling log sit under the top-left value, with registration marks in the card corners. Telemetry columns of hex scroll beside the face with a graduated rail and a bracketed, hot sample row, freeze on a lock and scramble on a miss.

Every landmark marker is a small precision reticle: a point and plus at the centre, four L brackets that snap in from a larger box with a hot flash and a bloom ring as the scan passes, ticks off each edge, and a two-arc ring that spins while it tracks and winds down onto a lock. Five carry a leader line to a confidence label. Measurement lines between marker pairs are hairlines with a tick at each step and a pulse running along them. A miss jitters the markers, scatters their brackets on separate courses and fades them in the error colour. Markers are projected through the same pose and perspective as the head surface; the ones on the jaw are pulled in so they stay on the visible side, and a marker on a surface that is turning away shrinks and dims toward the silhouette instead of floating beside it. Glitch tears are slipped blocks of the image with the channels split into offset slivers; chevrons are stacked double Vs with a stem.

What level 2 adds to every style:

| Style | Bloom and additive light | Theme's second and third hues | White-hot core |
| --- | --- | --- | --- |
| HUD | About 600 lit depth dots (twice the level-1 lattice) and a flickering IR speckle; the data ring, scan plane, lock rim and shockwaves bloom, as do the dots on the scan crest, the rim-lit silhouette and the glints | The oscilloscope trace and the link indicator in the corner readouts | Scan plane, data ring, lock rim, shockwaves, dots on the scan crest |
| Radar | The sweep arm, lock ring, pings and fresh returns bloom | The oscilloscope trace and the link indicator in the corner readouts | Fresh returns behind the arm and returns under each ping |
| Holo | The emitter, the scan planes, the rim light, the glints and shimmering vertices bloom; on dark glass a soft light spill sits behind the head | The chromatic fringe in two hues, plus the corner trace and indicator | The rim light where the head turns away, and shimmering vertices |

A miss still paints only in the error colour once the attempt fails.

## Depth Lattice HUD (`hud`)

A biometric instrument: a lit, triangulated depth head inside counter-rotating instrument rings, with a lock graph and seven-segment readouts in the corners.

The head is the shared head model (cranium, jaw, neck flaring into the shoulders), shown only as depth. It sways about 17 degrees each way under a key light from the upper left, so the shading slides over the relief. Each dot is sized and lit by its own surface normal (key light, a fresnel rim that brightens the silhouette, a specular lobe that throws a couple of glints) and falls off with depth. A coarse mesh is stitched into triangles over the surface, tilted structured-light stripes bend over it with a projector parallax, and a flickering IR speckle covers the head and the wall behind it, which slides against the head as it turns.

| State | What the user sees |
| --- | --- |
| Scanning | Boots in 620 ms: a flash ignites at the reticle, a ring pulse with sparks runs out through the instrument, the rings draw on with a spark at each lead, and the lattice condenses out of a scatter while the head turns into pose. Then a scan plane sweeps down and back up along the head: its lit edge follows the surface, with a phosphor trail of echoes behind it. Dots ahead of it are noise and resolve as it arrives, the dots it has passed fade through white-hot, bright and dim memory, and the mesh and stripes light as it crosses. Landmark markers seat as it passes them. Around it, at unrelated periods: a polar sub-grid, a 96-bar spectrum with an orbiting crest, a vernier, an outer micro-scale, spinners, satellites with tails, hex telemetry, and the graduated bezel, segmented data ring and dashed ring. |
| Face recognized | The cloud defocuses, then a completion wave runs down the head: behind it the dots lock to their homes with a flash, and the mesh and stripes resolve. The landmark markers confirm in a cascade from the brow down, the cardinal clamps slam in, and a bright lock ring flies in and clamps onto the head. On impact the rim flashes white-hot, rays burst off it, two shockwaves clear the field and the rim writes itself into a graduated dial. The rings snap to detents outermost first, then creep. The head settles slightly off-axis, a comet circles the dial, and glints and the dots breathe. Confidence counts to 99.7 and the status reads `PASS`. |
| Face not recognized | The attempt scans for 450 ms in the accent, then desyncs: the disc floods red and drains, a chromatic split slips the cloud off register, horizontal slabs of the head slip sideways, glitch strips tear, and static re-rolls every 40 ms. The mesh tears apart point by point along the surface normals, edges snap, and points drop out in bursts. The rings jam, throwing sparks, and freeze out of true, the spectrum drains, the rim breaks into dashes and the reticles lose track. Confidence collapses and `FAIL` blinks. The head stays a lit, broken volume in the error colour. |

Corner readouts are frame counter (top left), match confidence over a ten-cell bar (top right), sample histogram (bottom left), and status word (bottom right). Smaller sizes still paint (a reduced instrument, then a vector glyph below 48 px), but they are no longer a design target.

## Phosphor Radar (`radar`)

A plan-position scope scan-converted to a head. The sweep reads the subject through 36 range gates by 256 bearing cells. Each gate is a thin ring whose lit runs follow the head's relief (sensor-facing, lit from the upper left, a bright edge where the surface rolls away, nearer returns stronger), so the head reads as a lit volume made of range cells. The gates nearest the centre are thinned and broken into short arcs, so the middle does not stack into the whorl of a fingerprint and the iso-depth contours carry the relief. The silhouette glows without saturating. On top of it sit the iso-depth contours (where they crowd the surface is steep), one closed silhouette stroke and a neck and shoulder hint. A range gate nods slowly through the head and lights the cells it sits on. Phosphor holds the picture behind the arm and decays over a revolution, but never below a floor, so the whole head stays legible between sweeps. The returns trace the silhouette, depth and contours only; no feature is drawn.

| State | What the user sees |
| --- | --- |
| Scanning | Ignites in about 600 ms: a hot dot, a cross of light that stretches out and gutters, and a ring of phosphor racing to the bezel while the graticule draws on and the arm appears. The first revolution paints the head in. The arm has a hot, blooming leading edge and a two-decay afterglow wedge behind it. Fresh returns flash white-hot, then cool through the accent to a dim floor. Range rings light where the arm crosses them, bearing spokes run every 10 degrees, an inner azimuth ring creeps against the sweep, and a micro-scale sits outside the bezel. A nodding sector scanner lights the returns it crosses, and a range strobe rides the arm. Interference speckle and clutter re-roll all the time over a faint lit-phosphor screen. Target brackets hunt around the head, and landmark markers seat as the arm passes them. An A-scope over a fine grid traces return amplitude along the bearing, with three earlier traces still glowing under it. |
| Face recognized | The arm spins up for an extra revolution and the returns refresh from the centre out, each ring of the head flaring white-hot as the front passes. Target brackets converge from outside the scope and seat with an overshoot and a hot flash, while eight clamp arcs close onto the middle ring as it expands into the lock ring. Three pings sweep out and make the head flare as each passes its range. Chevrons seat on the diagonals, a track marker drops onto the centre, and the landmark markers lock in a cascade. Confidence reaches 99.7 and the status reads `PASS`. It then settles: noise and clutter are filtered out, the head holds a steady glow, the lock ring breathes with its detents turning slowly, and the arm idles at a slow sweep. Strokes only, no dots. |
| Face not recognized | The attempt starts, stutters, then the scope is jammed. Fans of barrage noise spread along a few bearings and hop every 90 ms, speckle floods in, spokes and ring flashes strobe, and the arm stutters and runs backwards. The scope loses sync: bands of range gates slip in bearing and jitter in range, and returns smear radially. The target box blows apart and the landmark markers break off. Two error pings go out, glitch tears cross the scope, and `FAIL` blinks. After the failure everything, structure included, is in the error colour, and the head's contours and silhouette stay legible. |

The top-left readout is the arm bearing in degrees.

## Holographic Wireframe (`holo`)

A projected head: a whole head, lofted between side and front profiles, with a cranium behind the face, ears and a jaw, closed under the chin. It has no neck: it floats above an emitter, in the light cone that rises to meet it. The face is a broad, shallow relief on its front, shown only as depth in the wireframe, with the same landmark markers as the other styles over it. Its layers are:
- 26 structured-light slices round the whole head, lit from the upper left. Nearer surface is brighter and heavier than the far side, the back of the head shows faintly through, every fourth slice is a major, and a slow interference runs along them. A rim light burns where the surface turns away, with a two-colour chromatic fringe. A faint wide stroke between the slice edges gives the head a glass body
- an outline traced from the slices, with an aura spilling past it, so a turn shows the head in profile
- scan planes: a ring of light that wraps the surface, in a plane that reaches past the head, with a sweeping arm, a wake behind it and a lens that bunches the slices toward it
- a vertex point cloud, with a few glints that catch the light
- a cage turning the other way outside it, and two tilted orbit rings with nodes
- an emitter with an iris, turning ticks, an anamorphic streak and ripples; a light cone that reaches up to the jaw and fades out there, with haze, a bright core, god rays with packets of light running up them, volume slices, rising rings and motes
- projection beams to the landmarks, with packets of light on them, and side scopes for the depth profile and the scan height

The camera sits a little above the head, and the head turns up to about 45 degrees, so the slices bend over the relief.

| State | What the user sees |
| --- | --- |
| Scanning | A 0.6 s boot: a hot spark on the emitter is the first frame, then the emitter ignites with a flash and a ripple, the cone rises, and the head is built from the chin up behind a bright ring that climbs the cone, its slices flickering in. Then the head turns slowly while the cage and the orbits turn at their own rates. A scan plane sweeps down through the head, from just over the crown to just under the chin, with its wake, and a faster one crosses it the other way; the markers seat as the plane passes them. Scanlines drift and beat, an occasional vertical-hold roll and rare block glitches play over the projector flicker, and glints, motes and packets of light run through the cone. |
| Face recognized | The flicker steadies and the chromatic fringe closes. An energy pulse races up the beam from the emitter, dragging streaks of light, and flares at the crown with rays and a spreading ring. A solidify ring sweeps back down, and the head hardens behind it: brighter, heavier, filled. The point cloud flares, then fuses into the mesh. The cage spins up, then collapses onto the head and dims. The landmark markers lock in a wave from the brow downward. The orbits level out into a halo collar round the jaw that closes from dashes to a graduated ring and throws a ripple as PASS lands, and a ripple leaves the emitter across the plate. Confidence reaches 99.7 and the status reads `PASS`. The head then rests in a three-quarter pose, strokes only, breathing slightly: rim lit with its aura, a slow scan plane drifting through it, glints, the halo turning, the emitter idling with a slow ripple. |
| Face not recognized | The attempt scans in the accent, then the projection fails and everything turns to the error colour. The chromatic split tears wide, slices slip sideways as rigid strips, blocks of the image shear, the picture rolls and shows twice while a vertical-hold bar crosses it, and the emitter browns out and sputters, taking the cone and the beams with it. The head volume stays legible throughout. It settles to a dim idle that still slips and drops out now and then, with the emitter ring broken and a faint hum bar rolling. The markers lose track and `FAIL` blinks. |

The top-left readout is head yaw in degrees, and the bottom-left gauges show yaw, pitch and projector sync.

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
| `host` | optional, the op level the host paints. `2` unlocks glow, additive blending and roles 3 to 5. `3` means the host paints the card on its own dark glass and resolves every role against it, so the frame draws its structure in the tint instead of the text colour. Absent means level 1, and the frame is exactly the level-1 frame. |

There are no colours in the spec. Each op carries a role index and the host resolves it against the live theme, so the card follows whatever theme is set and the plugin never chooses a colour:

| Role | Colour | Level |
| --- | --- | --- |
| 0 | the surface accent | 1 |
| 1 | the surface text colour | 1 |
| 2 | the surface error colour | 1 |
| 3 | hot: the accent pushed toward the text colour | 2 |
| 4 | the theme palette colour furthest in hue from the accent | 2 |
| 5 | the next most distinct palette colour | 2 |

The host derives roles 3 to 5 from the theme's `colors.toml` (for example `cyan`, `magenta`, `yellow` or the ANSI colours), never from a hardcoded colour, and never reuses the error colour. A theme without a usable palette gets hues rotated off its accent. Switching themes recolours all six.

At level 3 the host also derives the glass: the theme's darker base (its background on a dark theme, its text colour on a light one), tinted toward the accent and deepened. Role 1 becomes the theme's lighter base as ink, and the accent, error and palette roles are lifted until they read on the glass. Nothing is hardcoded; the glass and all six roles move with the theme.

### Why it is not a QML Item

A security review rated it HIGH that a plugin `Item` loaded onto a credential surface can walk `parent` and read the password field. Measured on Quickshell 0.3.1 / Qt 6.11, the ways that hole stays open are broader than one `Loader`:

- A plugin `Item` parented anywhere under the surface reaches the field.
- A `Loader` reaches the field even when it loads a non-Item `QtObject`, because the loader still injects a scope `parent`.
- A detached `Item` used as a `ShaderEffectSource.sourceItem` reaches the field, because being a source attaches the host **window** even though `parent` stays null.
- **Handing a plugin a 2D drawing context reaches the field.** The context exposes `canvas`, the canvas is a host `Item`, and its parent chain ends at the password field. A "pure paint routine" that takes a context is not isolated.

So the plugin is handed nothing at all. It returns numbers and the host draws them. The host treats the returned frame as hostile input: non-finite values are dropped, alpha, glow and line width are clamped, coordinates are bounded, and the op, path-command and glow-op counts are capped. The bloom, the blend modes and the derived colours are all host-owned; the plugin only chooses numbers.

### Op format

```
[0, role, alpha, lineWidth, cmds]              stroke a path
[1, role, alpha, x, y, w, h]                   fill a rect
[2, role, alphaFrom, alphaTo, x, y, w, h,      fill a vertical gradient rect
    yFrom, yTo]

Level 2 only (a level-1 host ignores both):
  a trailing glow value on any op above                the op's alpha on the
                                                       host's blurred bloom layer
  [3, mode]                                            later ops blend normally (0)
                                                       or add light (1)

cmds entries:
  [0, x, y]                 moveTo
  [1, x, y]                 lineTo
  [2, cx, cy, x, y]         quadraticCurveTo
  [3, cx, cy, r, a0, a1]    arc
```

## Develop

```bash
quickshell -p Preview.qml       # scripted scan / lock / rescan / miss, style chips, host level 1, 2 or 3, the 220 px card
node test/frame-test.js         # boundary, visual and per-style tests
bash test/style-switch-test.sh  # the style switch against a real plugin checkout and update
```

`Preview.qml` owns its own Canvas and palette and replays the ops itself, mirroring the host painter. It is the reference for how the host drives this plugin.

The tests are the thing to keep green. The boundary checks are why this plugin is allowed to draw on a credential surface at all. The dot-count check is the approved visual: a settled recognised HUD keeps its depth lattice, and a settled radar or holo face is strokes with no dots. The replay-budget checks, run on every 20 ms of every state on the 220 px card at op levels 2 and 3, keep the dense styles affordable on a software canvas. The level-1 purity check is what keeps the module safe on an older host: without `spec.host` it emits no blend op, no glow value and no role past the error colour.

### Visual harness

`tools/` renders frames headlessly to PNG, so a change can be seen without a Wayland session. It needs node 22+ and `chromium` (and `ffmpeg` for video); nothing is installed. `tools/render.html` paints the ops the way `Preview.qml` does (host level 3 glass, roles, additive blend, half-resolution bloom blurred twice), and `tools/shoot.js` drives headless Chromium over the DevTools protocol. Output goes to the gitignored `tools/out/`.

```bash
node tools/shoot.js --style hud --sheet                  # contact sheet: scanning, recognized and notRecognized timelines, with op counts
node tools/shoot.js --style holo --state recognized --elapsed 600 --out f.png   # one frame at 3x
node tools/shoot.js --style radar --video r.mp4 --seconds 12                    # the Preview script at 30 fps (--gif for a gif)
node tools/shoot.js --style hud --host 2 --theme latte --sheet                  # host level 1-3; themes tokyo mocha latte gruvbox nord dawn, current, or a colors.toml
node tools/shoot.js --help
```

The bloom blur is an approximation of Qt's `MultiEffect` (tune it with `--bloom wide,tight`). `node tools/shoot.js --serve` serves `tools/render.html` for use in a browser, with the same URL parameters.

`Preview.qml` takes its colours from the active Omarchy theme (`~/.local/state/omarchy/current/theme/colors.toml`) when there is one, and falls back to Tokyo Night.
