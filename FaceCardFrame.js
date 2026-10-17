.pragma library

// Paint routine for the Omarchy shared face-scan card.
//
// This file is the whole plugin. It owns no Item, keeps no state between
// frames, and has no route to anything in the host. It exports two pure
// functions and nothing else.
//
//   frame(size, spec)   return one frame as a list of numeric draw ops
//   holdMs(state)       how long the host should hold that state
//
// The host does NOT hand this module a drawing context. Handing one over is
// the whole leak: a 2D context exposes `canvas`, the canvas is a host Item,
// and its parent chain reaches the password field. Measured on this build.
// So the module paints into its own recorder and returns numbers.
//
// spec carries only values:
//   state        "scanning" | "recognized" | "notRecognized"
//   clock        free-running milliseconds, drives every ambient motion
//   elapsed      milliseconds since `state` was entered
//   style        optional, "hud" | "radar" | "holo"; overrides STYLE below
//   host         optional op level the host paints; 2 adds glow, additive
//                blending and roles 3..5. Absent means a level-1 host, and
//                the frame is exactly what a level-1 host has always drawn.
//
// Three styles share the op vocabulary, the timing contract and the corner
// readouts: the Depth Lattice HUD, the Phosphor Radar and the Holographic
// Wireframe. The installed style is the STYLE line, which
// bin/omarchy-face-style rewrites through a git filter so plugin updates
// still fast-forward.
//
// Colours are not in the spec. Ops carry a role index and the host resolves
// it against the live theme.
//
// Determinism is a security property here, not a nicety. Nothing calls
// Math.random() after buildParticles, no frame-to-frame accumulator exists,
// and every motion is evaluated in closed form. The same spec renders the
// same pixels every time, which is what lets the host paint this itself
// instead of loading a plugin Item next to the password field.
//
// The host keeps `clock - elapsed` constant for the life of a state, so a
// result can recover the exact instrument pose it was entered from and ease
// out of it without a jump.
//
// Hints, glyphs, card geometry and the failure shake stay host-owned.

// --- the op vocabulary the host replays ------------------------------------

var ROLE_ACCENT = 0
var ROLE_FG = 1
var ROLE_ERROR = 2
// Level 2 roles, derived by the host from the theme. On a level-1 host they
// are remapped to the foreground before they leave the module.
var ROLE_HOT = 3    // the accent pushed toward white: the core of a lit stroke
var ROLE_ALT = 4    // the theme's most distinct second hue
var ROLE_ALT2 = 5   // its next most distinct hue
// Readout numerals. It leaves the module as the foreground: on glass the
// foreground role is the instrument's structure, so ink needs its own name.
var ROLE_INK = 6

var OP_PATH = 0   // [OP_PATH, role, alpha, lineWidth, cmds, glow?]
var OP_RECT = 1   // [OP_RECT, role, alpha, x, y, w, h, glow?]
var OP_GRAD = 2   // [OP_GRAD, role, alphaFrom, alphaTo, x, y, w, h, yFrom, yTo, glow?]
var OP_BLEND = 3  // [OP_BLEND, mode], level 2 only: 0 normal, 1 additive

// Set per frame from spec.host. When true the frame uses glow (an op's alpha
// on the host's blurred bloom layer), additive blending and roles 3..5, and
// drops the stacked-stroke halos a level-1 host needs to fake a glow.
var LUMEN = false
// Set per frame from spec.host >= 3: the host paints the card on its own dark
// glass and resolves every role against it. Structure is drawn in the
// frame's tint there instead of in the foreground, so the instrument is one
// lit system with numerals in ink, not grey linework over colour.
var GLASS = false
// The tint of the frame being painted: the accent, or the error colour once
// a miss has failed. Set by each style as it starts.
var TINT = 0

// Structural roles for secondary instrumentation: the foreground, as ink.
// Graduations, grids and scales read as the instrument's engraving, and the
// accent is left for what is live. The theme's second and third hues go to
// a few small data channels instead (altOf, alt2Of). Set per frame in
// paintInto.
var FG2 = 1
var FG3 = 1
// True once a miss has failed, so the fault strobe's accent frames stay in the
// accent and error pair. Set per frame in paintInto.
var MISSING = false

// Path commands, all numeric:
//   [0, x, y]                 moveTo
//   [1, x, y]                 lineTo
//   [2, cx, cy, x, y]         quadraticCurveTo
//   [3, cx, cy, r, a0, a1]    arc

// The host truncates a path past 600 commands. Batches split well under it.
var PATH_CHUNK = 560

var TAU = Math.PI * 2

// The installed style. Keep this on one line in exactly this form: the
// omarchy-face-style filter matches it. Unknown values paint the HUD.
var STYLE = "hud" // omarchy-face:style

var STYLES = ["hud", "radar", "holo"]

function resolveStyle(spec) {
  var asked = spec && typeof spec.style === "string" ? spec.style : ""
  if (STYLES.indexOf(asked) !== -1) return asked
  if (STYLES.indexOf(STYLE) !== -1) return STYLE
  return "hud"
}

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    var t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Stateless hash in [0, 1). Glitch steps index it, so a given step always
// tears the same way.
function hash(n) {
  var s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
function clamp01(v) { return clamp(v, 0, 1) }
function mix(a, b, k) { return a + (b - a) * k }

// Normalised progress through the [a, b] millisecond window.
function seg(ms, a, b) { return clamp01((ms - a) / (b - a)) }

function easeOutCubic(k) { var f = 1 - k; return 1 - f * f * f }
function easeInOutCubic(k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2 }
function easeOutBack(k) {
  // c3 is c1 + 1 so the curve is 0 at the start. A smaller cubic coefficient
  // leaves the gesture already partway seated when the lock begins.
  if (k <= 0) return 0
  if (k >= 1) return 1
  var c1 = 1.2
  var c3 = c1 + 1
  var f = k - 1
  return 1 + c3 * f * f * f + c1 * f * f
}

// One-shot bump: rises over the first third, falls over the rest.
function bump(ms, a, b) {
  var k = seg(ms, a, b)
  return k <= 0 || k >= 1 ? 0 : Math.sin(Math.PI * Math.pow(k, 0.7))
}

// Damped oscillation used for the lock-on overshoot.
function spring(ms, start, period, decay) {
  if (ms <= start) return 0
  var u = (ms - start) / period
  return Math.sin(u * Math.PI * 2) * Math.exp(-u * decay)
}

var RIM_R = 0.86

// Depth the surface is modelled at, in face units. Sway rotates about the
// card plane, so the nose-forward centre travels further than the rim and the
// cloud reads as a solid rather than a sticker.
var DEPTH = 0.88

// --- timing -----------------------------------------------------------------

var SWEEP_MS = 1900
var PLANE_R = 1.0
var BOOT_MS = 620

// Recognition reads as three beats. Unclear, then who is it, then clear.
// The cloud carries the first two and is gone by the third, where the
// landmark wireframe takes over. No dots remain on a recognised face.
var REC_SETTLE = [60, 520]
var REC_LOCK0 = 140
var REC_LOCK_STEP = 36
var REC_LOCK_LEN = 170
var REC_COUNT = [150, 700]
var REC_CLAMP = [540, 720]
var REC_PASS = 640
var REC_WAVE = [620, 1040]

// When each dot stops drifting and locks onto its home, and when it shrinks
// out, handing the face to the wireframe. Both run as a wave from the
// centre of the face outward.
function recLock(p) {
  if (p.kind === "field") return [200, 430]
  return [150 + p.d * 300, 300 + p.d * 300]
}

function recDissolve(p) {
  if (p.kind === "field") return [380, 570]
  return [400 + p.d * 260, 580 + p.d * 260]
}

var CACHE = {}

// Spacing of the dots laid along a feature line, in face units.
var FEAT_DOT_GAP = 0.036

// Seven-segment glyphs, segments a..g. Ghosted unlit segments are drawn under
// every character, which is what makes a handful of strokes read as an
// instrument readout rather than as lettering.
var SEG7 = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
  "A": "abcefg", "B": "cdefg", "C": "adef", "D": "bcdeg", "E": "adefg",
  "F": "aefg", "S": "afgcd", "N": "ceg", "P": "abefg", "I": "bc",
  "L": "def", "-": "g", " ": ""
}

function buildParticles(seed, step) {
  var key = "p3" + seed + ":" + step
  if (CACHE[key]) return CACHE[key]

  var rnd = mulberry32(seed)
  var ps = []

  var curRow = -1
  function push(kind, hx, hy, z, shade, stage) {
    ps.push({
      kind: kind, hx: hx, hy: hy, z: z, shade: shade, stage: stage, d: Math.hypot(hx, hy / 1.1),
      sa: rnd(), sb: rnd(), sc: rnd(), n1: -1, n2: -1, n3: -1, row: curRow
    })
  }

  var lx = -0.45, ly = -0.55, lz = 0.7
  var ll = Math.hypot(lx, ly, lz)
  function shadeAt(x, y) {
    var e = 0.01
    var zx = (holoZAt(x + e, y) - holoZAt(x - e, y)) / (2 * e)
    var zy = (holoZAt(x, y + e) - holoZAt(x, y - e)) / (2 * e)
    var nl = Math.hypot(zx, zy, 1)
    return clamp01(0.5 + 0.5 * ((-zx * lx - zy * ly + lz) / (nl * ll)) * 1.4 - 0.2)
  }

  // A projected dot grid over the face, like a depth sensor's: near-regular
  // rows that bend with the relief and the pose, which is what reads as a
  // surface. No dot belongs to a feature.
  var x, y, ins, row = 0
  for (var gy = FACE_TOP + 0.02; gy <= FACE_CHIN; gy += step * 0.866) {
    row++
    curRow = row
    for (var gx = -0.5 + (row % 2) * step * 0.5; gx <= 0.5; gx += step) {
      x = gx + (rnd() - 0.5) * step * 0.12
      y = gy + (rnd() - 0.5) * step * 0.12
      ins = holoInside(x, y)
      if (ins <= 0.04) continue
      push(ins < 0.14 ? "edge" : "skin", x, y, holoZAt(x, y), shadeAt(x, y), -1)
    }
  }

  curRow = -1
  // The silhouette, as dots.
  for (var side = -1; side <= 1; side += 2) {
    var oacc = 0, lastY = FACE_TOP
    for (var oy = FACE_TOP; oy <= FACE_CHIN - 0.004; oy += 0.01) {
      oacc += 0.01
      if (oacc < FEAT_DOT_GAP * 1.5) continue
      oacc = 0
      push("edge", side * faceHalfW(oy), oy, 0.02, 0.9, -1)
    }
  }
  // The neck, set back under the jaw and fading toward the base: a head on
  // a neck reads as a person where a bare mask reads as a print.
  var neck = step * 0.8
  for (y = 0.52; y <= 0.96; y += neck) {
    var nk = clamp01((y - 0.52) / 0.44)
    var nw = mix(0.19, 0.27, nk)
    for (x = -nw; x <= nw + 1e-6; x += neck) {
      var nxx = x + (rnd() - 0.5) * neck * 0.4
      var nyy = y + (rnd() - 0.5) * neck * 0.4
      if (faceHalfW(nyy) > Math.abs(nxx) - 0.02 && nyy < FACE_CHIN) continue
      push("neck", nxx, nyy, -0.06, 0.4 + 0.3 * rnd(), -1)
    }
  }
  push("edge", 0, FACE_TOP, 0.02, 0.9, -1)
  push("edge", 0, FACE_CHIN, 0.02, 0.9, -1)

  for (var i = 0; i < 44; i++) {
    var a = rnd() * Math.PI * 2
    var fr = 0.98 + rnd() * 0.62
    push("field", Math.cos(a) * fr, Math.sin(a) * fr * 0.82, 0.10 + rnd() * 0.22, 0.5, -1)
  }

  // Static mesh topology, resolved once. Per-frame nearest-neighbour search
  // would be quadratic every tick and is not needed: the homes never move.
  var face = []
  for (i = 0; i < ps.length; i++) if (ps[i].kind !== "field") face.push(i)
  for (var fa = 0; fa < face.length; fa++) {
    var pi = face[fa]
    var b1 = 9, b2 = 9, b3 = 9, i1 = -1, i2 = -1, i3 = -1
    for (var fb = 0; fb < face.length; fb++) {
      if (fb === fa) continue
      var pj = face[fb]
      var d = Math.hypot(ps[pi].hx - ps[pj].hx, ps[pi].hy - ps[pj].hy)
      if (d < b1) { b3 = b2; i3 = i2; b2 = b1; i2 = i1; b1 = d; i1 = pj }
      else if (d < b2) { b3 = b2; i3 = i2; b2 = d; i2 = pj }
      else if (d < b3) { b3 = d; i3 = pj }
    }
    ps[pi].n1 = i1
    ps[pi].n2 = i2
    ps[pi].n3 = i3
  }
  // The lattice links along its rows, so the mesh reads as structured light
  // laid on the surface rather than as a scribble between near neighbours.
  for (i = 0; i + 1 < ps.length; i++) {
    if (ps[i].row >= 0) {
      ps[i].n1 = ps[i + 1].row === ps[i].row ? i + 1 : -1
      ps[i].n2 = -1
    }
  }

  var fieldIdx = []
  for (i = 0; i < ps.length; i++) if (ps[i].kind === "field") fieldIdx.push(i)

  CACHE[key] = { all: ps, face: face, field: fieldIdx }
  return CACHE[key]
}

// Signed distance from the scan plane, negative ahead of it and positive in its
// wake, so the wake can decay over a longer tail than the leading edge.
function scanPlane(t) {
  var ph = (t % SWEEP_MS) / SWEEP_MS
  var down = ph < 0.5
  var k = down ? ph * 2 : (1 - ph) * 2
  var eased = easeInOutCubic(k)
  return { y: mix(-0.97, 0.97, eased), dir: down ? 1 : -1 }
}

function acquisition(plane, y) {
  var d = (plane.y - y) * plane.dir
  if (d >= 0) return Math.exp(-d / 0.55)
  return Math.exp(-(-d) / 0.055)
}

// Idle head pose. Two incommensurate periods, so the sway never visibly loops.
function swayYaw(t) { return 0.24 * Math.sin(t / 5200 * TAU) + 0.03 * Math.sin(t / 1730 * TAU) }
function swayPitch(t) { return 0.07 * Math.sin(t / 7300 * TAU + 1.1) }

// Instrument ring angles at clock t. Each ring has its own period so the
// layers slide past each other instead of turning as one.
function ringAt(ring, t) {
  if (ring === 0) return t / 24000 * TAU
  if (ring === 1) return -t / 9000 * TAU
  if (ring === 2) return t / 6000 * TAU
  return t / 3200 * TAU
}

// The angle a ring locks to: the nearest detent to where it was when the
// result arrived, so alignment is a short snap, never a long unwind.
var RING_DETENT = [TAU / 72, TAU / 4, TAU / 48, TAU / 4]

function ringPose(ring, state, t, rt) {
  var live = ringAt(ring, t)
  if (state === "recognized") {
    var t0 = t - rt
    var detent = RING_DETENT[ring]
    var target = Math.round(ringAt(ring, t0 + 90) / detent) * detent
    // Rings snap in a cascade, outermost first, each with its own spring.
    var lag = ring * 45
    var k = easeOutCubic(seg(rt, REC_SETTLE[0] + lag, REC_SETTLE[1] + lag))
    return mix(ringAt(ring, t0 + rt * (1 - k)), target, k)
      + spring(rt, REC_SETTLE[1] - 120 + lag, 300, 3.2) * 0.05 * (ring % 2 ? -1 : 1)
  }
  if (state === "notRecognized") {
    // Desync: the rings jump in quantised steps while the lock is lost, then
    // freeze wherever the last jump left them.
    var step = Math.min(6, Math.floor(rt / 55))
    var off = (hash(step * 7 + ring * 13 + 1) - 0.5) * 1.1 * (step > 0 ? 1 : 0)
    return ringAt(ring, (t - rt) + rt * 0.25) + off
  }
  return live
}

// A paint token, not a colour. The host resolves the role against the live
// theme, so this module never sees or chooses a colour.
function rgba(role, a) {
  return [role, clamp01(a)]
}

// Closed-form position under linear drag. Keeping this analytic is what makes
// the scatter reproducible from elapsed time alone.
function dragOffset(v0, tau, k) {
  return v0 * (1 - Math.exp(-k * tau)) / k
}

// Bloom gains on a level-2 host. Ordinary strokes do not bloom: on a light
// card the host lays the bloom down as a coloured haze, and a frame where
// every stroke glows smears into one pale disc. Only halo pens (which a
// level-1 frame draws at about 0.16 of the stroke) light the bloom, so it
// sits on the edges that are meant to read as lit.
var GLOW_CRISP = 0
var GLOW_HALO = 2.4

// Batches strokes that share a role, alpha and width into one path op.
// Alpha is quantised into 1/32 steps, which is below what a 1 px line can
// show and turns hundreds of mesh edges into a handful of ops.
//
// On a level-2 host every stroke also carries a glow: `gain` times its alpha
// by default. A halo pen (`halo` true) paints only the bloom: its strokes
// have no sharp alpha, just glow.
function pen(ctx, gain, halo) {
  var order = []
  var groups = {}
  var gk = gain === undefined ? GLOW_CRISP : gain

  // Keyed by the quantised steps packed into one integer: this runs for
  // every mesh edge, and a string key built from floats was most of a frame.
  function group(role, a, w) {
    var ia = Math.round(clamp01(a) * 32)
    if (ia <= 0) return null
    var ig = 0
    if (LUMEN) {
      ig = Math.round(clamp01(a * gk) * 16)
      if (halo) {
        if (ig <= 0) return null
        ia = 0
      }
    }
    var iw = Math.max(1, Math.round(w * 4))
    var key = role + 8 * (ia + 33 * (ig + 17 * iw))
    var g = groups[key]
    if (!g) {
      g = groups[key] = { role: role, a: ia / 32, w: iw / 4, g: ig / 16, cmds: [] }
      order.push(g)
    }
    return g
  }

  return {
    line: function (role, a, w, x0, y0, x1, y1) {
      var g = group(role, a, w)
      if (g) g.cmds.push([0, x0, y0], [1, x1, y1])
    },
    poly: function (role, a, w, pts) {
      if (pts.length < 2) return
      var g = group(role, a, w)
      if (!g) return
      g.cmds.push([0, pts[0][0], pts[0][1]])
      for (var i = 1; i < pts.length; i++) g.cmds.push([1, pts[i][0], pts[i][1]])
    },
    arc: function (role, a, w, x, y, r, a0, a1) {
      if (a1 <= a0 || r <= 0) return
      var g = group(role, a, w)
      if (g) g.cmds.push([0, x + Math.cos(a0) * r, y + Math.sin(a0) * r], [3, x, y, r, a0, a1])
    },
    flush: function () {
      for (var i = 0; i < order.length; i++) {
        var g = order[i]
        var cmds = g.cmds
        var at = 0
        while (at < cmds.length) {
          var end = Math.min(cmds.length, at + PATH_CHUNK)
          // Never split a subpath from its moveTo.
          while (end < cmds.length && cmds[end][0] !== 0) end++
          ctx.strokeStyle = rgba(g.role, g.a)
          ctx.lineWidth = g.w
          ctx.glow = g.g
          ctx.beginPath()
          for (var c = at; c < end; c++) {
            var k = cmds[c]
            if (k[0] === 0) ctx.moveTo(k[1], k[2])
            else if (k[0] === 1) ctx.lineTo(k[1], k[2])
            else ctx.arc(k[1], k[2], k[3], k[4], k[5])
          }
          ctx.stroke()
          at = end
        }
      }
      ctx.glow = 0
      order = []
      groups = {}
    }
  }
}

function haloPen(ctx) { return pen(ctx, GLOW_HALO, true) }

// The instrument glass: a faint disc of the foreground under the
// instrument, closed by a hairline rim. The foreground is the colour that
// contrasts with the surface on any theme, so the plate reads as a face
// plate on a light card and as a lifted glass on a dark one. One stroke,
// as wide as the radius, fills the disc.
function plate(p, cx, cy, R, boot, rim) {
  if (!LUMEN || GLASS) return
  p.arc(ROLE_FG, 0.045 * boot, R, cx, cy, R * 0.5, 0, TAU)
  p.arc(ROLE_FG, 0.05 * boot, R * 0.04, cx, cy, R * 0.98, 0, TAU)
  if (rim > 0) p.arc(ROLE_FG, 0.5 * boot, Math.max(0.5, R * 0.006), cx, cy, R * rim, 0, TAU)
}

// The white-hot core colour for a stroke in `role`. A failed miss keeps its
// own role, and a level-1 host has no hot role at all.
function hotOf(role) { return MISSING || role === ROLE_ERROR ? role : ROLE_HOT }
// The theme's second and third hues, except in a miss.
function altOf(role) { return MISSING || role === ROLE_ERROR ? role : ROLE_ALT }
function alt2Of(role) { return MISSING || role === ROLE_ERROR ? role : ROLE_ALT2 }

// A line with bloom: a wide faint pass under the crisp one. Two pens keep the
// halo under every crisp stroke of the same layer.
//
// On a level-2 host the halo lights the bloom layer instead, and a thin hot
// core runs down the middle of the stroke, which is what makes it read as
// light rather than as paint.
function glowLine(halo, crisp, role, a, w, x0, y0, x1, y1) {
  halo.line(role, a * 0.16, w * (LUMEN ? 2.2 : 3.6), x0, y0, x1, y1)
  crisp.line(role, a, w, x0, y0, x1, y1)
  if (LUMEN) crisp.line(hotOf(role), a * 0.85, Math.max(0.5, w * 0.42), x0, y0, x1, y1)
}

function glowArc(halo, crisp, role, a, w, x, y, r, a0, a1) {
  halo.arc(role, a * 0.16, w * (LUMEN ? 2.2 : 3.6), x, y, r, a0, a1)
  crisp.arc(role, a, w, x, y, r, a0, a1)
  if (LUMEN) crisp.arc(hotOf(role), a * 0.85, Math.max(0.5, w * 0.42), x, y, r, a0, a1)
}

var SEG_LINES = {
  a: [0.12, 0, 0.88, 0],
  b: [1, 0.08, 1, 0.44],
  c: [1, 0.56, 1, 0.92],
  d: [0.12, 1, 0.88, 1],
  e: [0, 0.56, 0, 0.92],
  f: [0, 0.08, 0, 0.44],
  g: [0.12, 0.5, 0.88, 0.5]
}

// Seven-segment text. (x, y) is the top-left of the first cell, `align`
// 1 right-aligns the string on x. A "." attaches to the previous cell.
function seg7(p, role, a, ghost, w, x, y, cw, ch, pitch, str, align) {
  var cells = []
  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i)
    if (c === "." && cells.length) cells[cells.length - 1].dp = true
    else cells.push({ c: c, dp: false })
  }
  var x0 = align === 1 ? x - (cells.length * pitch - (pitch - cw)) : x
  var skew = 0.16 * cw
  for (var ci = 0; ci < cells.length; ci++) {
    var cx0 = x0 + ci * pitch
    var lit = SEG7[cells[ci].c] || ""
    for (var s in SEG_LINES) {
      var L = SEG_LINES[s]
      var on = lit.indexOf(s) !== -1
      var alpha = on ? a : ghost
      if (alpha <= 0) continue
      p.line(role, alpha, w,
        cx0 + L[0] * cw + (1 - L[1]) * skew, y + L[1] * ch,
        cx0 + L[2] * cw + (1 - L[3]) * skew, y + L[3] * ch)
    }
    if (cells[ci].dp) {
      var dx = cx0 + cw + (pitch - cw) * 0.5
      p.line(role, a, w * 1.4, dx, y + ch, dx + w * 0.3, y + ch)
    }
  }
}

function hex4(n) {
  var s = (Math.floor(n) & 0xffff).toString(16).toUpperCase()
  while (s.length < 4) s = "0" + s
  return s
}

function pad3(n) {
  var s = String(Math.max(0, Math.min(999, Math.round(n))))
  while (s.length < 3) s = "0" + s
  return s
}

function paintHud(ctx, size, spec) {
  var state = spec.state || "scanning"
  var t = spec.clock || 0
  var rt = spec.elapsed || 0
  var compact = size < 76
  var micro = size < 48
  var hud = size >= 100

  // The large card on a level-2 host gets a finer lattice: about twice the
  // points, each smaller, so the cloud reads as a dense depth scan.
  var dense = LUMEN && size >= 160
  var latStep = dense ? 0.052 : 0.088
  var P = buildParticles(1337, latStep)
  var ps = P.all
  var cx = size / 2
  var cy = size / 2
  var R = size * 0.45
  // The face sits a little inside the instrument, which leaves an annulus for
  // the spectrum ring between the rim and the dashed ring.
  var FSC = compact ? 1 : 0.856
  var RF = R * FSC

  ctx.reset()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var scanning = !ok && !bad
  var tint = bad ? missTint(rt) : ROLE_ACCENT
  TINT = tint

  // Base stroke weights. Everything scales with the card; the floor keeps
  // hairlines on the pixel grid at the real 116 px slot.
  var hair = Math.max(1, size * 0.0065)
  var thin = Math.max(1, size * 0.009)
  var bold = Math.max(1, size * 0.016)
  // Sub-pixel graduations. On a 2x panel this is one device pixel.
  var fine = Math.max(0.5, size * 0.0038)

  var boot = scanning ? easeOutCubic(seg(rt, 0, BOOT_MS)) : 1
  var t0 = t - rt

  // Pose: idle sway, eased to face-on by a lock and frozen by a miss.
  var yaw = swayYaw(t)
  var pitch = swayPitch(t)
  if (ok) {
    // The lock settles slightly off-axis, so the relief reads in 3D rather
    // than as flat nested rings.
    var still = easeOutCubic(seg(rt, 0, 420))
    yaw = mix(swayYaw(t0 + rt * (1 - still)), 0.3, still)
    pitch = mix(swayPitch(t0 + rt * (1 - still)), -0.2, still)
  } else if (bad) {
    yaw = swayYaw(t0 + rt * 0.2)
    pitch = swayPitch(t0 + rt * 0.2)
  }
  var cyaw = Math.cos(yaw), syaw = Math.sin(yaw)
  var cpit = Math.cos(pitch), spit = Math.sin(pitch)

  var plane = scanPlane(scanning ? t : t0)

  // Global result gestures.
  var lockPulse = ok ? spring(rt, 430, 330, 2.8) * 0.045 : 0
  var faceScale = 1 + lockPulse
  var shearK = bad ? (1 - easeOutCubic(seg(rt, 70, 240))) * seg(rt, 0, 60) : 0
  var scatterTau = bad ? Math.max(0, rt - 150) / 1000 : 0
  var errWave = bad ? seg(rt, 0, 220) * 2.2 : 0

  // Glitch tears drag the dots inside them sideways.
  var tears = bad ? glitchTears(rt) : []

  // Face space to screen, through the sway. `d` is depth toward the viewer.
  function project(x, y, d) {
    var xr = x * cyaw + d * syaw
    var zr = -x * syaw + d * cyaw
    var yr = y * cpit - zr * spit
    return { x: xr, y: yr }
  }
  function toPx(x, y) { return { x: cx + x * RF, y: cy + y * RF } }

  var halo = haloPen(ctx)
  var crisp = pen(ctx)
  function flush() { halo.flush(); crisp.flush() }

  // --- micro: a vector glyph, the cloud is a smudge down here ---------------
  if (micro) {
    paintHudMicro(crisp, size, state, t, rt, cx, cy, R, tint)
    crisp.flush()
    return
  }

  // --- backplate: scanlines and a faint graticule ----------------------------
  if (!compact) {
    plate(crisp, cx, cy, R, boot, 1.0)
    var lines = GLASS ? 0 : 30
    for (var li = 0; li < lines; li++) {
      var ly = ((li + 0.5) / lines) * 2 - 1
      var half = Math.sqrt(Math.max(0, 1 - ly * ly)) * 1.0
      if (half <= 0.05) continue
      crisp.line(ROLE_FG, 0.045 * boot, hair, cx - half * R, cy + ly * R, cx + half * R, cy + ly * R)
    }
    crisp.line(tint, 0.10 * boot, hair, cx - R * 0.98, cy, cx - R * 0.90, cy)
    crisp.line(tint, 0.10 * boot, hair, cx + R * 0.90, cy, cx + R * 0.98, cy)
    crisp.line(tint, 0.10 * boot, hair, cx, cy - R * 0.98, cx, cy - R * 0.90)
    crisp.line(tint, 0.10 * boot, hair, cx, cy + R * 0.90, cx, cy + R * 0.98)
    hudGraticule(crisp, cx, cy, R, fine, hair, boot, tint, t)
    flush()
  }

  // --- instrument rings -----------------------------------------------------
  var dim = bad ? mix(1, 0.55, easeOutCubic(seg(rt, 200, 700))) : 1
  var passFlash = ok ? bump(rt, REC_PASS - 40, REC_PASS + 420) : 0
  var closeK = ok ? easeInOutCubic(seg(rt, 470, 760)) : 0

  if (!compact) {
    // Graduated bezel with a travelling bright cursor.
    var bez = ringPose(0, state, t, rt)
    var cur = ringPose(3, state, t, rt)
    var rIn = R * 0.985
    var drawn = seg(boot, 0, 0.8)
    for (var bi = 0; bi < 72; bi++) {
      if (bi / 72 > drawn) break
      var ba = bez + bi * TAU / 72 - Math.PI / 2
      var major = bi % 6 === 0
      var rel = Math.atan2(Math.sin(ba - cur), Math.cos(ba - cur))
      var near = Math.exp(-rel * rel / 0.10)
      var la = (major ? 0.62 : 0.30) + near * 0.55 * (ok ? 1 - closeK : 1) + passFlash * 0.5
      var len = R * (major ? 0.065 : 0.032) * (1 + near * 0.4)
      crisp.line(major || near > 0.3 ? tint : ROLE_FG, la * dim, major ? thin : fine,
        cx + Math.cos(ba) * rIn, cy + Math.sin(ba) * rIn,
        cx + Math.cos(ba) * (rIn + len), cy + Math.sin(ba) * (rIn + len))
    }

    // Segmented data ring. Three arcs with notched ends; a lock grows them
    // until the gaps close, a miss shrinks them to fragments.
    var dr = R * 0.915
    var drot = ringPose(1, state, t, rt)
    var arcs = [[0.00, 1.55], [2.05, 1.05], [3.60, 2.15]]
    var dataK = seg(boot, 0.15, 0.95)
    for (var ai = 0; ai < arcs.length; ai++) {
      var start = drot + arcs[ai][0]
      var span = arcs[ai][1] * dataK
      if (ok) {
        var next = ai + 1 < arcs.length ? arcs[ai + 1][0] : TAU
        span = mix(span, next - arcs[ai][0] - 0.02, closeK)
      }
      if (bad) span *= mix(1, 0.35, easeOutCubic(seg(rt, 60, 420)))
      glowArc(halo, crisp, tint, (0.9 + passFlash * 0.1) * dim, bold, cx, cy, dr, start, start + span)
      var ends = [start, start + span]
      for (var ei = 0; ei < 2; ei++) {
        crisp.line(tint, 0.7 * dim * dataK, hair,
          cx + Math.cos(ends[ei]) * (dr - R * 0.04), cy + Math.sin(ends[ei]) * (dr - R * 0.04),
          cx + Math.cos(ends[ei]) * (dr + R * 0.04), cy + Math.sin(ends[ei]) * (dr + R * 0.04))
      }
    }

    // Orbiting carets riding the data ring at their own rates.
    if (!ok || closeK < 1) {
      var carets = [t / 2100 * TAU, -t / 3700 * TAU + 2]
      if (!scanning) carets = [t0 / 2100 * TAU, -t0 / 3700 * TAU + 2]
      for (var oc = 0; oc < carets.length; oc++) {
        var ca = carets[oc]
        var tipR = dr - R * 0.035
        var baseR = dr - R * 0.095
        var wing = 0.055
        crisp.poly(tint, 0.85 * dataK * dim * (1 - closeK), thin, [
          [cx + Math.cos(ca - wing) * baseR, cy + Math.sin(ca - wing) * baseR],
          [cx + Math.cos(ca) * tipR, cy + Math.sin(ca) * tipR],
          [cx + Math.cos(ca + wing) * baseR, cy + Math.sin(ca + wing) * baseR]
        ])
      }
    }

    // Fine dashed inner ring.
    var dsh = ringPose(2, state, t, rt)
    var dashR = R * 0.862
    var dashK = seg(boot, 0.3, 1)
    for (var di = 0; di < 48; di++) {
      if (di / 48 > dashK) break
      var da = dsh + di * TAU / 48
      crisp.arc(FG2, (LUMEN ? 0.42 : 0.20) * dim, hair, cx, cy, dashR, da, da + 0.055)
    }

    // Lock clamps at the cardinals. They idle just outside the data ring and
    // slam inward on a lock.
    var clampIn = ok ? easeOutBack(seg(rt, REC_CLAMP[0], REC_CLAMP[1])) : 0
    var clampOut = bad ? easeOutCubic(seg(rt, 80, 400)) : 0
    for (var cq = 0; cq < 4; cq++) {
      var qa = cq * Math.PI / 2 + (ok ? 0 : Math.sin(t / 1500 + cq) * 0.02)
      var qr = R * (1.0 - 0.10 * clampIn + 0.06 * clampOut)
      var qw = 0.07
      var qd = R * 0.05
      crisp.poly(tint, (0.55 + 0.45 * clampIn) * dim * boot, thin, [
        [cx + Math.cos(qa - qw) * (qr + qd), cy + Math.sin(qa - qw) * (qr + qd)],
        [cx + Math.cos(qa) * qr, cy + Math.sin(qa) * qr],
        [cx + Math.cos(qa + qw) * (qr + qd), cy + Math.sin(qa + qw) * (qr + qd)]
      ])
    }
    hudSubRings(halo, crisp, state, t, rt, cx, cy, R, fine, hair, thin, boot, dim, tint, passFlash, closeK)
    if (hud) telemetryColumns(crisp, cx, cy, R, size, state, t, rt, boot, tint, 0.62)
    flush()
  } else {
    // Compact: one ring carries the instrument.
    var crot = ringPose(1, state, t, rt)
    var cspan = ok ? mix(1.9, TAU / 3 - 0.02, closeK) : (bad ? 0.8 : 1.9)
    for (var ck = 0; ck < 3; ck++) {
      var cs = crot + ck * TAU / 3
      crisp.arc(tint, 0.55 * dim, thin, cx, cy, R * 0.95, cs, cs + cspan)
    }
    crisp.flush()
  }

  // --- resolve every particle's on-screen position -------------------------
  var pos = new Array(ps.length)
  var lit = new Array(ps.length)

  for (var i = 0; i < ps.length; i++) {
    var p = ps[i]
    var hx = p.hx
    var hy = p.hy
    var a = 0

    // Unacquired dots drift; acquisition pulls them onto the depth surface.
    var pr = project(hx, hy, p.z * DEPTH)

    if (scanning) {
      a = acquisition(plane, pr.y * FSC)
      if (p.kind === "field") a *= 0.35
    } else if (ok) {
      var lw = recLock(p)
      a = p.kind === "field" ? 0.3 : easeOutCubic(seg(rt, lw[0], lw[1]))
    } else {
      // The head keeps the level the scan left it at and settles to a dimmer
      // steady one: a miss loses its lock, not its subject.
      a = mix(clamp01(acquisition(plane, pr.y * FSC)), 0.5, easeOutCubic(seg(rt, 0, 260)))
    }

    var wander = bad ? 0.05 : 1 - a
    var slack = p.kind === "field" ? 0.150 : (p.kind === "edge" ? 0.05 : 0.09)
    var x = pr.x + Math.sin(t / 1000 * 0.85 + p.sa * 6.283) * slack * wander
    var y = pr.y + Math.cos(t / 1000 * 0.71 + p.sb * 6.283) * slack * wander

    if (boot < 1) {
      // Assemble from a scatter as the card comes up.
      var sc = (1 - boot) * (0.35 + p.sc * 0.5)
      var ang = p.sa * TAU
      x += Math.cos(ang) * sc
      y += Math.sin(ang) * sc
    }

    if (ok) {
      // Rack out of focus, then in. This is the "unclear" beat that makes the
      // lock-on legible as a change rather than as a state that was always true.
      var defoc = bump(rt, 0, 165) * 0.085 * wander
      x = x * (1 + defoc) * faceScale
      y = y * (1 + defoc) * faceScale
    }

    if (bad) {
      // Depth lock breaks: horizontal slices shear, then anchors let go.
      var band = Math.floor((hy + 1.2) / 0.48)
      x += shearK * (band % 2 === 0 ? 0.16 : -0.16)
      x += tearShift(tears, y)

      if (scatterTau > 0) {
        var len2 = Math.hypot(hx, hy) || 0.001
        var spread = p.kind === "field" ? 2.1 : 0.1
        var vx = (hx / len2) * spread * (0.45 + p.sa)
        var vy = (hy / len2) * spread * (0.45 + p.sb) - 0.25
        x += dragOffset(vx, scatterTau, 4.2)
        y += dragOffset(vy, scatterTau, 4.2)
      }
    }

    pos[i] = toPx(x, y)
    lit[i] = a * (boot < 1 ? boot : 1)
  }

  // --- recognition: the ambient field is swept out and leaves nothing ------
  var waveR = ok ? mix(0.15, 2.0, easeOutCubic(seg(rt, 150, 620))) : 0

  if (ok) {
    for (var fi2 = 0; fi2 < P.field.length; fi2++) {
      var idx = P.field[fi2]
      var fp = ps[idx]
      var pushed = clamp01((waveR - Math.hypot(fp.hx, fp.hy)) * 1.4)
      pos[idx] = {
        x: pos[idx].x + (pos[idx].x - cx) * pushed * 1.25,
        y: pos[idx].y + (pos[idx].y - cy) * pushed * 1.25
      }
      lit[idx] = (1 - pushed) * 0.5
    }
  }

  // --- the cloud --------------------------------------------------------------
  var dotBase = Math.max(1, size * (compact ? 0.030 : (dense ? 0.0128 : 0.0168)))

  if (!compact) {
    // Longer than a jittered row neighbour at this step, shorter than a link
    // that would bridge a gap in the row.
    var meshCap = Math.max(0.085, latStep * 1.3)
    var meshFade = ok ? 1 - 0.3 * easeInOutCubic(seg(rt, 390, 620)) : 1
    if (meshFade > 0.01) {
      for (var mi = 0; mi < P.face.length; mi++) {
        var pi = P.face[mi]
        var pp = ps[pi]
        var nbs = [pp.n1, pp.n2]
        for (var nb = 0; nb < 2; nb++) {
          var nj = nbs[nb]
          if (nj < 0 || nj < pi || (nb === 1 && (dense || pp.kind === "skin"))) continue
          if (Math.hypot(pp.hx - ps[nj].hx, pp.hy - ps[nj].hy) > meshCap) continue
          var la2 = Math.min(lit[pi], lit[nj])
          // The mesh never fully disappears: it is the standing structure the
          // scan wake lights up, not something the wake draws from nothing.
          crisp.line(tint, (0.05 + 0.42 * la2) * meshFade * boot * (nb === 1 ? 0.7 : 1), hair,
            pos[pi].x, pos[pi].y, pos[nj].x, pos[nj].y)
        }
      }
      crisp.flush()
    }
    hudTopology(halo, crisp, state, t, rt, boot, tint, fine, hair, plane, project, toPx, FSC, tears, shearK, faceScale)
    flush()
  } else if (scanning) {
    crisp.arc(tint, 0.28, Math.max(1, size * 0.018), cx, cy, R * RIM_R, 0, TAU)
    crisp.flush()
  }

  for (var i2 = 0; i2 < ps.length; i2++) {
    var p2 = ps[i2]
    if (compact && p2.kind === "field" && !ok) continue

    var l = lit[i2]
    var zf = 0.55 + 1.0 * p2.z
    var s = dotBase * zf * (p2.kind === "field" ? 0.72 : (p2.kind === "edge" ? 1.2 : (!ok && p2.kind === "skin" ? 0.75 : 1))) * (ok ? 0.62 + 0.18 * l : 0.68 + 0.42 * l)
    // The rim and the features carry the face; the depth-map interior is
    // texture behind them. Without this weighting the silhouette dissolves
    // on a light theme, where accent-on-near-white has little contrast.
    var kw = p2.kind === "field" ? 0.46
      : (p2.kind === "edge" ? 1.0 : 0.45 + 0.95 * p2.shade)
    // Additive light flattens the slope shading, so the dense cloud leans
    // harder on it to keep the sockets, nose and cheekbones legible.
    if (dense && p2.kind === "skin") kw = 0.1 + 1.35 * Math.pow(p2.shade, 2.5)
    if (p2.kind === "neck") kw = 0.62 * (1 - 0.88 * clamp01((p2.hy - 0.55) / 0.4))
    // Floor keeps the silhouette readable between sweeps; the cubed term is
    // the bright crest that rides the scan plane itself.
    var crest = ok ? 0.1 : (p2.kind === "skin" ? 0.12 : 0.34)
    var alpha = (0.48 + 0.44 * l + crest * l * l * l) * kw * (0.70 + 0.30 * p2.z)
    if (!ok && p2.kind === "skin") alpha *= 0.42
    else if (ok && p2.kind === "skin") alpha *= 0.85
    if (scanning) alpha *= mix(0.2, 1, boot)

    if (bad && p2.kind !== "field") {
      var reached = clamp01(errWave - Math.hypot(p2.hx, p2.hy))
      alpha *= mix(1, 0.62, reached)
    }
    if (ok) {
      var dw = recDissolve(p2)
      var gone = easeInOutCubic(seg(rt, dw[0], dw[1]))
      if (p2.kind !== "field") gone *= 0.2
      if (gone >= 0.998) continue
      alpha *= 1 - gone
      s *= 1 - gone * 0.4
    }

    if (dense) alpha *= ok ? 0.85 : 0.8
    if (LUMEN) {
      // Each dot lights the bloom, and the crest riding the scan plane burns
      // white-hot, so the wake reads as light sweeping across a surface.
      // Only the crest riding the scan plane, and a lock's cloud, light the
      // bloom; the rest of the lattice stays sharp.
      ctx.glow = bad ? 0 : (ok ? alpha * 0.3 : (l > 0.6 ? alpha * (l - 0.6) * 2.2 : 0))
      ctx.fillStyle = rgba(scanning && l > 0.85 && p2.kind !== "skin" ? hotOf(tint) : tint, alpha)
    } else {
      ctx.fillStyle = rgba(tint, alpha)
    }
    ctx.fillRect(pos[i2].x - s / 2, pos[i2].y - s / 2, s, s)
  }
  ctx.glow = 0

  // Chromatic split on a miss: a foreground ghost of the cloud slips off
  // register while the lock tears, as a failing sensor would.
  if (bad && !compact) {
    var split = bump(rt, 0, 520) * size * 0.022
    if (split > 0.3) {
      var gs = dotBase * 0.8
      for (var ci = 0; ci < ps.length; ci += 7) {
        if (ps[ci].kind === "field") continue
        ctx.fillStyle = rgba(ROLE_FG, 0.22 * bump(rt, 0, 520))
        ctx.fillRect(pos[ci].x + split - gs / 2, pos[ci].y - split * 0.3 - gs / 2, gs, gs)
      }
    }
  }

  // --- the analysis markers ------------------------------------------------------
  if (!compact) {
    faceMarkers(halo, crisp, {
      proj: function (X, Y, Z) {
        var pr = project(X * faceScale, Y * faceScale, Z * DEPTH)
        var pp = toPx(pr.x, pr.y)
        return { x: pp.x, y: pp.y, v: 1 }
      },
      pass: function (X, Y, q) { return ((plane.y - (q.y - cy) / R) * plane.dir) * boot - (1 - boot) },
      post: function (q) {
        if (!bad) return q
        var yu = (q.y - cy) / RF
        var band = Math.floor((yu + 1.2) / 0.48)
        return { x: q.x + (shearK * (band % 2 === 0 ? 0.16 : -0.16) + tearShift(tears, yu)) * RF, y: q.y, v: q.v }
      },
      tint: tint, U: RF, gain: boot, labels: size >= 150, clock: t, cx: cx,
      wLine: Math.max(0.6, size * 0.0042), wMark: Math.max(0.8, size * 0.0055)
    })
    flush()
    if (ok) {
      // The rim closes out of the dissolving cloud.
      var rimK = easeInOutCubic(seg(rt, 460, 700))
      if (rimK > 0.004) {
        glowArc(halo, crisp, tint, Math.min(1, rimK * 2.4), bold * 0.85, cx, cy, RF * RIM_R * faceScale,
          -Math.PI / 2 - Math.PI * rimK, -Math.PI / 2 + Math.PI * rimK)
        // The closed rim becomes a graduated dial.
        var rr0 = RF * RIM_R * faceScale + R * 0.018
        for (var dt = 0; dt < 120; dt++) {
          var dta = -Math.PI / 2 + dt * TAU / 120
          var drel = Math.abs(Math.atan2(Math.sin(dta + Math.PI / 2), Math.cos(dta + Math.PI / 2)))
          if (drel > Math.PI * rimK) continue
          var dl = R * (dt % 10 === 0 ? 0.04 : (dt % 5 === 0 ? 0.026 : 0.014))
          crisp.line(tint, (dt % 10 === 0 ? 0.8 : 0.45), fine,
            cx + Math.cos(dta) * rr0, cy + Math.sin(dta) * rr0, cx + Math.cos(dta) * (rr0 + dl), cy + Math.sin(dta) * (rr0 + dl))
        }
      }
    }
    flush()
  } else if (ok) {
    var rimC = easeInOutCubic(seg(rt, 460, 700))
    if (rimC > 0.004) {
      crisp.arc(tint, Math.min(1, rimC * 2.4), Math.max(1, size * 0.036), cx, cy, R * RIM_R * faceScale,
        -Math.PI / 2, -Math.PI / 2 + TAU * rimC)
    }
    crisp.flush()
  }

  // --- face-lock brackets ------------------------------------------------------
  // Faint and hunting while scanning; on a lock they fly in from outside and
  // seat on the face with an overshoot; on a miss they spring apart.
  if (!compact) {
    var fbx = RF * 0.66, fby = RF * 0.84
    var fk = ok ? easeOutBack(seg(rt, 80, 380)) : 0
    var fo = bad ? easeOutCubic(seg(rt, 0, 400)) : 0
    var fsc = ok ? mix(1.45, 1, fk) : (bad ? 1 + 0.3 * fo : 1.08 + 0.02 * Math.sin(t / 600))
    var fa = ok ? clamp01(seg(rt, 60, 200) * 1.5) * (0.85 + 0.15 * passFlash) : (bad ? 0.7 * (1 - fo) : 0.3 * boot)
    var fl = R * 0.14
    var fjx = scanning ? Math.sin(t / 290) * R * 0.012 : 0
    var fjy = scanning ? Math.cos(t / 340) * R * 0.01 : 0
    if (fa > 0.02) {
      var hx0 = fbx * fsc, hy0 = fby * fsc
      bracketCorner(crisp, tint, fa, hair, cx - hx0 + fjx, cy - hy0 + fjy, 1, 1, fl)
      bracketCorner(crisp, tint, fa, hair, cx + hx0 + fjx, cy - hy0 + fjy, -1, 1, fl)
      bracketCorner(crisp, tint, fa, hair, cx - hx0 + fjx, cy + hy0 + fjy, 1, -1, fl)
      bracketCorner(crisp, tint, fa, hair, cx + hx0 + fjx, cy + hy0 + fjy, -1, -1, fl)
      if (ok && fk > 0) {
        bracketCorner(halo, tint, 0.2 * fa, thin * 3, cx - hx0, cy - hy0, 1, 1, fl)
        bracketCorner(halo, tint, 0.2 * fa, thin * 3, cx + hx0, cy - hy0, -1, 1, fl)
        bracketCorner(halo, tint, 0.2 * fa, thin * 3, cx - hx0, cy + hy0, 1, -1, fl)
        bracketCorner(halo, tint, 0.2 * fa, thin * 3, cx + hx0, cy + hy0, -1, -1, fl)
      }
    }
    flush()
  }

  // --- scan plane ----------------------------------------------------------
  // The plane is clipped to the instrument disc, so it reads as light
  // projected onto the face rather than a bar across the card.
  function chord(yu) { return Math.sqrt(Math.max(0, PLANE_R * PLANE_R - yu * yu)) }
  var planeK = scanning ? boot : (1 - easeOutCubic(seg(rt, 0, 240)))
  if (planeK > 0.01) {
    var py = cy + plane.y * R
    var pw = R * Math.max(0.12, chord(plane.y)) * (scanning ? 1 : mix(1, 0.05, easeInOutCubic(seg(rt, 0, 240))))
    var trail = 0.30
    if (scanning) {
      // The wake is four gradient slices, each cut to the disc at its own
      // depth, which rounds off what would otherwise be a hard rectangle.
      var slices = 4
      for (var sli = 0; sli < slices; sli++) {
        var u0 = plane.y - plane.dir * trail * sli / slices
        var u1 = plane.y - plane.dir * trail * (sli + 1) / slices
        var sw = R * chord(Math.abs(u0) > Math.abs(u1) ? u0 : u1)
        if (sw <= 1) continue
        var y0 = cy + u0 * R, y1 = cy + u1 * R
        var grad = ctx.createLinearGradient(0, cy + (plane.y - plane.dir * trail) * R, 0, py)
        grad.addColorStop(0, rgba(tint, 0))
        grad.addColorStop(1, rgba(tint, 0.13 * planeK))
        ctx.fillStyle = grad
        ctx.fillRect(cx - sw, Math.min(y0, y1), sw * 2, Math.abs(y1 - y0))
      }
    }

    if (scanning && !compact) {
      // The beam rides the relief: it bows over the brow, the nose and the
      // cheeks instead of cutting straight across the face.
      var beam = []
      var bu = RF * faceScale
      var byf = (py - cy) / bu
      for (var bi2 = 0; bi2 <= 48; bi2++) {
        var bpx = cx - pw + (2 * pw) * bi2 / 48
        var bxf = (bpx - cx) / bu
        var bz = holoInside(bxf, byf) > 0 ? holoZAt(bxf, byf) : 0
        beam.push([bpx, py - bz * R * 0.12])
      }
      halo.poly(tint, 0.3 * planeK, thin * 3.2, beam)
      crisp.poly(tint, 0.95 * planeK, thin, beam)
    } else {
      glowLine(halo, crisp, tint, 0.92 * planeK, thin, cx - pw, py, cx + pw, py)
    }
    if (!compact) {
      // Range ticks along the plane, alternating sides.
      for (var rtk = -9; rtk <= 9; rtk++) {
        var tx = cx + rtk * pw / 10
        var tl = R * (rtk % 5 === 0 ? 0.05 : 0.022)
        crisp.line(tint, 0.55 * planeK, hair, tx, py, tx, py + tl * (rtk % 2 ? -plane.dir : plane.dir))
      }
    }
    flush()

    if (scanning) {
      ctx.fillStyle = rgba(tint, planeK)
      var nub = Math.max(2, size * 0.024)
      ctx.fillRect(cx - pw - nub / 2, py - nub / 2, nub, nub)
      ctx.fillRect(cx + pw - nub / 2, py - nub / 2, nub, nub)
    }
  }

  // A second scanner crossing the plane at right angles. Where they meet, a
  // scan head rides with both.
  if (!compact && planeK > 0.01) {
    var vph = frac(t / 3100)
    var vtri = vph < 0.5 ? vph * 2 : (1 - vph) * 2
    var vxu = mix(-0.9, 0.9, easeInOutCubic(vtri))
    if (!scanning) vxu = mix(vxu, 0, easeInOutCubic(seg(rt, 0, 240)))
    var vh = Math.sqrt(Math.max(0, 1 - vxu * vxu)) * R
    var vx = cx + vxu * R
    crisp.line(FG2, (LUMEN ? 0.5 : 0.3) * planeK, fine, vx, cy - vh, vx, cy + vh)
    for (var vt = -8; vt <= 8; vt++) {
      var vty = cy + vt * vh / 9
      crisp.line(FG2, 0.35 * planeK, fine, vx, vty, vx + R * (vt % 4 === 0 ? 0.035 : 0.016), vty)
    }
    var hy0 = cy + plane.y * R
    if (Math.abs(hy0 - cy) < vh) {
      var hr = R * 0.045
      glowArc(halo, crisp, tint, 0.9 * planeK, hair, vx, hy0, hr, 0, TAU)
      crisp.line(tint, 0.9 * planeK, fine, vx - hr * 1.8, hy0, vx - hr * 0.6, hy0)
      crisp.line(tint, 0.9 * planeK, fine, vx + hr * 0.6, hy0, vx + hr * 1.8, hy0)
      crisp.line(tint, 0.9 * planeK, fine, vx, hy0 - hr * 1.8, vx, hy0 - hr * 0.6)
      crisp.line(tint, 0.9 * planeK, fine, vx, hy0 + hr * 0.6, vx, hy0 + hr * 1.8)
    }
    flush()
  }

  // --- result flourishes ---------------------------------------------------
  if (ok) {
    var waves = [REC_WAVE, [760, 1120]]
    for (var wv = 0; wv < waves.length; wv++) {
      var wave = bump(rt, waves[wv][0], waves[wv][1])
      if (wave <= 0.01) continue
      var wk = easeOutCubic(seg(rt, waves[wv][0], waves[wv][1]))
      glowArc(halo, crisp, tint, wave * (wv ? 0.35 : 0.6), Math.max(1, size * 0.014 * (1 - wk * 0.7)), cx, cy, R * mix(0.74, 1.08, wk), 0, TAU)
    }
    // PASS: the rim flashes white-hot for a beat.
    var passHot = LUMEN ? bump(rt, REC_PASS - 30, REC_PASS + 300) : 0
    if (passHot > 0.01) glowArc(halo, crisp, hotOf(tint), passHot, bold * 1.4, cx, cy, RF * RIM_R * faceScale, 0, TAU)
    // Lock burst: rays fire off the rim in a sweep that runs once round.
    if (!compact) {
      for (var ry = 0; ry < 60; ry++) {
        var rya = -Math.PI / 2 + ry * TAU / 60
        var rk = bump(rt, 580 + ry * 4, 820 + ry * 4)
        if (rk <= 0.02) continue
        var r0 = RF * RIM_R * 1.02, r1 = r0 + R * (0.05 + 0.1 * rk) * (ry % 3 === 0 ? 1.4 : 1)
        crisp.line(tint, rk * 0.7, ry % 3 === 0 ? hair : fine,
          cx + Math.cos(rya) * r0, cy + Math.sin(rya) * r0, cx + Math.cos(rya) * r1, cy + Math.sin(rya) * r1)
      }
    }
    flush()
  }

  if (bad && !compact) {
    // Error flash: the whole disc floods red and drains top to bottom.
    var flash = bump(rt, 0, 300)
    if (flash > 0.02) {
      for (var fs = 0; fs < 8; fs++) {
        var fy0 = -1 + fs / 4, fy1 = fy0 + 0.25
        var fw = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(fy0) > Math.abs(fy1) ? fy1 : fy0, 2))) * R
        var fgd = ctx.createLinearGradient(0, cy - R, 0, cy + R)
        fgd.addColorStop(0, rgba(ROLE_ERROR, 0.2 * flash))
        fgd.addColorStop(1, rgba(ROLE_ERROR, 0.02 * flash))
        ctx.fillStyle = fgd
        ctx.fillRect(cx - fw, cy + fy0 * R, fw * 2, 0.25 * R)
      }
    }
    // Static: short dashes re-rolled every 40 ms while the lock tears.
    var noiseK = 1 - seg(rt, 300, 700)
    if (noiseK > 0) {
      var nstep = Math.floor(rt / 40)
      for (var nz = 0; nz < 70; nz++) {
        var nr = Math.sqrt(hash(nstep * 131 + nz)) * R
        var na = hash(nstep * 71 + nz * 3) * TAU
        var nx = cx + Math.cos(na) * nr, ny = cy + Math.sin(na) * nr
        var nlen = R * (0.02 + 0.06 * hash(nz * 13 + nstep))
        crisp.line(nz % 3 ? ROLE_ERROR : ROLE_FG, 0.35 * noiseK, fine, nx - nlen, ny, nx + nlen, ny)
      }
    }
  }

  if (bad) {
    drawTears(crisp, tears, cx, cy, R)

    // Error wave: a ring that races out as the anchors let go.
    var ew = bump(rt, 0, 340)
    if (ew > 0.01) {
      crisp.arc(ROLE_ERROR, ew * 0.6, Math.max(1, size * 0.018), cx, cy,
        R * mix(0.1, 1.05, easeOutCubic(seg(rt, 0, 340))), 0, TAU)
    }

    // Broken rim: dashes that drift apart once the lock is gone.
    var brk = easeOutCubic(seg(rt, 240, 620))
    if (brk > 0.02) {
      for (var bd = 0; bd < 10; bd++) {
        var bda = (bd / 10) * TAU + brk * 0.22 * (bd % 2 ? 1 : -1)
        crisp.arc(ROLE_ERROR, 0.45 * (1 - brk * 0.4), thin, cx, cy, RF * (RIM_R + brk * 0.12), bda, bda + 0.24)
      }
    }
    flush()
  }

  // --- corner readouts ---------------------------------------------------------
  if (hud) paintHudReadouts(crisp, size, state, t, rt, boot, tint)
  crisp.flush()
}

// --- corner readouts, shared by every style ---------------------------------

// Seven-segment cells in the four corners the round instrument leaves free.
function readoutGeom(size, boot) {
  var m = size * 0.035
  var ch = size * 0.054
  return {
    m: m,
    cw: size * 0.028,
    ch: ch,
    pitch: size * 0.041,
    w: Math.max(1, size * 0.0075),
    hair: Math.max(1, size * 0.0065),
    ghost: 0.07 * boot,
    fgA: 0.62 * boot,
    boot: boot,
    tagY: m + ch + size * 0.022,
    base: size - m
  }
}

// Top right: match confidence over a ten-cell bar. It wanders low while
// scanning, counts to 99.7 on a lock, and climbs, stalls and collapses on a
// miss.
function readConfidence(p, g, size, state, t, rt, tint) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var t0 = t - rt
  function wander(at) { return 8 + 6 * Math.sin(at / 700) + 4 * Math.sin(at / 233 + 1) + 3 * Math.sin(at / 91) }
  var conf = wander(t)
  if (ok) conf = mix(wander(t0), 99.7, easeOutCubic(seg(rt, REC_COUNT[0], REC_COUNT[1])))
  if (bad) conf = mix(wander(t0), 41, easeOutCubic(seg(rt, 0, 180))) * (1 - easeInOutCubic(seg(rt, 200, 460)))
  var str = g.boot < 0.6 ? "---" : pad3(conf * 10)
  if (str !== "---") str = str.slice(0, 2) + "." + str.slice(2)
  var blinkOff = bad && rt > 460 && Math.floor(rt / 120) % 2 === 1
  var role = bad ? ROLE_ERROR : (ok ? tint : ROLE_INK)
  var a = blinkOff ? 0.18 : (ok ? 0.95 : g.fgA)
  seg7(p, role, a, g.ghost, g.w, size - g.m, g.m, g.cw, g.ch, g.pitch, str, 1)
  var cells = 10
  var barW = g.pitch * 3
  var cellW = barW / cells
  var filled = clamp01(conf / 100) * cells
  for (var c = 0; c < cells; c++) {
    var on = clamp01(filled - c)
    var x0 = size - g.m - barW + c * cellW
    p.line(on > 0 ? role : ROLE_FG, on > 0 ? mix(0.25, 0.9, on) * g.boot : 0.12 * g.boot, g.w * 1.6,
      x0 + cellW * 0.18, g.tagY, x0 + cellW * 0.82, g.tagY)
  }
}

// Bottom right: status word.
function readStatus(p, g, size, state, t, rt, tint) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var word = "SCAN"
  if (ok) word = rt < 300 ? "SCAN" : (rt < REC_PASS ? chase(rt) : "PASS")
  if (bad) word = rt < 150 ? "SCAN" : "FAIL"
  var wordOff = bad && rt > 150 && Math.floor(rt / 110) % 2 === 1
  var scanBlink = !ok && !bad && Math.floor(t / 530) % 2 === 1
  var a = wordOff ? 0.2 : (ok && rt >= REC_PASS ? 1 : (scanBlink ? g.fgA * 0.55 : g.fgA))
  var role = bad ? ROLE_ERROR : (ok && rt >= REC_PASS ? tint : ROLE_INK)
  seg7(p, role, a, g.ghost, g.w, size - g.m, g.base - g.ch, g.cw, g.ch, g.pitch, word, 1)
  // A decided result burns in the segments' cores, so PASS and FAIL read at
  // a glance against the busy instrument.
  if (LUMEN && ((ok && rt >= REC_PASS) || (bad && rt >= 150)) && !wordOff) {
    seg7(p, hotOf(role), a * 0.85, 0, Math.max(0.5, g.w * 0.45), size - g.m, g.base - g.ch, g.cw, g.ch, g.pitch, word, 1)
  }
}

// Top left: a seven-segment value over a rule with a travelling tick.
function readTopLeft(p, g, size, t, role, str) {
  seg7(p, role, g.fgA, g.ghost, g.w, g.m, g.m, g.cw, g.ch, g.pitch, str, 0)
  var tagW = g.pitch * 4 - (g.pitch - g.cw)
  p.line(ROLE_FG, 0.22 * g.boot, g.hair, g.m, g.tagY, g.m + tagW, g.tagY)
  var tick = ((t / 900) % 1) * tagW
  p.line(role === ROLE_ERROR ? ROLE_ERROR : ROLE_ACCENT, 0.8 * g.boot, g.w * 1.3,
    g.m + tick, g.tagY, g.m + Math.min(tagW, tick + size * 0.03), g.tagY)
}

function paintHudReadouts(p, size, state, t, rt, boot, tint) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var t0 = t - rt
  var g = readoutGeom(size, boot)

  // Top left: frame counter. It freezes on the frame a result was taken.
  var frameNo = t / 16.667
  if (ok) frameNo = seg(rt, 0, REC_PASS) < 1 ? frameNo : (t0 + REC_PASS) / 16.667
  if (bad) frameNo = rt < 300 ? hash(Math.floor(rt / 40)) * 65535 : (t0 + 300) / 16.667
  readTopLeft(p, g, size, t, bad ? ROLE_ERROR : ROLE_INK, hex4(frameNo))

  readConfidence(p, g, size, state, t, rt, tint)

  // Bottom left: live sample histogram. Bars level out on a lock and drain
  // on a miss.
  var bars = 8
  var bw = size * 0.022
  var bh = size * 0.075
  for (var b = 0; b < bars; b++) {
    var live = 0.18 + 0.82 * Math.abs(Math.sin(t / (170 + b * 37) + b * 1.7) * Math.sin(t / (410 + b * 53) + b))
    var hK = live
    if (ok) hK = mix(live, 0.55 + 0.35 * Math.cos(b * 0.9), easeOutCubic(seg(rt, 200, 620)))
    if (bad) hK = live * (1 - easeOutCubic(seg(rt, 100, 500))) * 0.8 + 0.06
    var bx = g.m + b * bw * 1.35 + bw / 2
    p.line(FG3, 0.12 * boot, bw, bx, g.base, bx, g.base - bh)
    p.line(bad ? ROLE_ERROR : tint, 0.75 * boot, bw, bx, g.base, bx, g.base - bh * hK * boot)
  }

  readStatus(p, g, size, state, t, rt, tint)
  readoutDetail(p, g, size, state, t, rt, tint)
}

// The matching beat on the status word: a single segment chases round.
function chase(rt) {
  var frames = ["-   ", " -  ", "  - ", "   -"]
  return frames[Math.floor(rt / 60) % frames.length]
}

// Below roughly 48 px the cloud is a smudge, so the same geometry is rendered
// as vector strokes instead: a segmented ring that closes on a lock and
// breaks on a miss, three structured-light stripes, and the scan line.
function paintHudMicro(p, size, state, t, rt, cx, cy, R, tint) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var w = Math.max(1, size * 0.072)
  var baseA = ok ? 1 : (bad ? 0.9 : 0.86)

  if (bad) {
    var brk = easeOutCubic(seg(rt, 200, 560))
    for (var i = 0; i < 8; i++) {
      var ma = (i / 8) * TAU + brk * 0.3 * (i % 2 ? 1 : -1)
      p.arc(tint, baseA * (1 - brk * 0.45), w, cx, cy, R * (RIM_R + brk * 0.18), ma, ma + 0.42)
    }
  } else {
    var close = ok ? easeInOutCubic(seg(rt, 0, 320)) : 0
    var rot = ok ? 0 : t / 1600 * TAU
    var span = mix(1.15, TAU / 4 - 0.001, close)
    for (var q = 0; q < 4; q++) {
      var a0 = rot + q * TAU / 4
      p.arc(tint, baseA * (ok ? 1 : 0.8), w, cx, cy, R * RIM_R, a0, a0 + span)
    }
  }

  microStripes(p, tint, baseA, w, cx, cy, R, 0)

  if (!ok && !bad) {
    var py = cy + scanPlane(t).y * R * 0.9
    p.line(tint, 0.9, Math.max(1, size * 0.04), cx - R, py, cx + R, py)
  }

  if (ok) {
    var mh = bump(rt, 40, 520)
    if (mh > 0.01) {
      p.arc(tint, mh * 0.7, Math.max(1, size * 0.04 * (1 - seg(rt, 40, 520) * 0.7)), cx, cy,
        R * mix(0.84, 1.08, easeOutCubic(seg(rt, 40, 520))), 0, TAU)
    }
  }
}

// --- dense detail kit ---------------------------------------------------------

// The small-size glyph's face: three structured-light stripes that bend up
// over the middle, the way the full card's stripes bend over a face. Two
// marks over a line is a face icon; three stripes are a scan.
function microStripes(p, tint, a, w, cx, cy, R, shift) {
  var rows = [[-0.32, 0.42], [0, 0.56], [0.32, 0.42]]
  for (var i = 0; i < rows.length; i++) {
    var y = cy + rows[i][0] * R
    var hw = rows[i][1] * R
    var x0 = cx + shift
    p.poly(tint, a, w, [[x0 - hw, y], [x0 - hw * 0.3, y], [x0, y - R * 0.1], [x0 + hw * 0.3, y], [x0 + hw, y]])
  }
}

// A polyline whose segments carry their own alpha. Consecutive segments in
// the same alpha step share one subpath, which keeps dense meshes cheap to
// replay. An alpha of zero breaks the line.
function strip(p, role, w, pts, al) {
  var run = null
  var runA = -1
  for (var i = 1; i < pts.length; i++) {
    var a = Math.round(clamp01(al[i - 1]) * 14) / 14
    if (a !== runA) {
      if (run && run.length > 1 && runA > 0) p.poly(role, runA, w, run)
      run = [[pts[i - 1].x, pts[i - 1].y]]
      runA = a
    }
    run.push([pts[i].x, pts[i].y])
  }
  if (run && run.length > 1 && runA > 0) p.poly(role, runA, w, run)
}

// Corner readout micro-detail shared by every style: a data bus under the
// top-left value, a graduated ruler under the confidence bar, and
// registration marks in the card corners.
function readoutDetail(p, g, size, state, t, rt, tint) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var fine = Math.max(0.5, size * 0.0038)
  var y = g.tagY + size * 0.02
  var cell = size * 0.011
  var step = Math.floor((ok && rt > REC_PASS ? t - rt + REC_PASS : t) / 90)
  for (var i = 0; i < 12; i++) {
    var on = hash(step * 13 + i * 7) > 0.5
    if (ok && rt > REC_PASS) on = i % 3 !== 2
    if (bad) on = hash(Math.floor(rt / 45) * 11 + i) > 0.35
    // The last cell is a steady link indicator in the theme's third hue.
    var led = LUMEN && i === 11 && !bad
    var x = g.m + i * cell * 1.45
    p.line(led ? alt2Of(tint) : (on ? (bad ? ROLE_ERROR : tint) : ROLE_FG), (on || led ? 0.85 : 0.14) * g.boot, g.w * 1.1, x, y, x + cell, y)
  }
  var rw = g.pitch * 3
  var rx = size - g.m - rw
  var ry = g.tagY + size * 0.016
  var ticks = []
  for (var k = 0; k <= 20; k++) {
    var tx = rx + rw * k / 20
    var th = size * (k % 5 === 0 ? 0.012 : 0.006)
    p.line(FG3, 0.28 * g.boot, fine, tx, ry, tx, ry + th)
  }
  var caret = ok ? mix(frac(t / 1300), 1, easeOutCubic(seg(rt, 150, 700))) : frac(t / 1300)
  if (bad) caret = clamp01(frac((t - rt) / 1300) + (hash(Math.floor(rt / 50)) - 0.5) * 0.4)
  var cxr = rx + rw * caret
  p.poly(bad ? ROLE_ERROR : tint, 0.85 * g.boot, fine * 1.5, [[cxr - size * 0.008, ry + size * 0.02], [cxr, ry + size * 0.012], [cxr + size * 0.008, ry + size * 0.02]])
  // A scrolling data log: greeked lines that read as text streaming past.
  var logStep = Math.floor((ok && rt > REC_PASS ? t - rt + REC_PASS : t) / 120)
  for (var lr = 0; lr < 3; lr++) {
    var lyy = y + size * (0.018 + lr * 0.013)
    var seed = (logStep + lr) * 17
    var xx = g.m
    for (var wd = 0; wd < 4; wd++) {
      var wl = size * (0.008 + 0.018 * hash(seed + wd * 3))
      if (xx + wl > g.m + size * 0.085) break
      p.line(bad ? ROLE_ERROR : (wd === 0 ? tint : FG2), (wd === 0 ? 0.6 : 0.3) * g.boot, fine, xx, lyy, xx + wl, lyy)
      xx += wl + size * 0.006
    }
  }
  // An oscilloscope trace under the ruler: live while scanning, a clean
  // carrier on a lock, noise on a miss.
  var ty = ry + size * 0.036
  var tr = []
  for (var ti = 0; ti <= 30; ti++) {
    var tu = ti / 30
    var v = Math.sin(tu * 14 + t / 90) * 0.6 + Math.sin(tu * 31 - t / 57) * 0.4 * (ok ? 1 - seg(rt, 200, 600) : 1)
    if (bad) v = (hash(Math.floor(rt / 40) * 31 + ti) - 0.5) * 2
    tr.push([rx + rw * tu, ty + v * size * 0.008])
  }
  p.poly(bad ? ROLE_ERROR : (LUMEN ? altOf(tint) : tint), 0.85 * g.boot, fine * 1.4, tr)

  var cm = size * 0.012
  var corners = [[cm, cm], [size - cm, cm], [cm, size - cm], [size - cm, size - cm]]
  for (var c = 0; c < 4; c++) {
    var q = corners[c]
    p.line(FG3, 0.3 * g.boot, fine, q[0] - cm * 0.6, q[1], q[0] + cm * 0.6, q[1])
    p.line(FG3, 0.3 * g.boot, fine, q[0], q[1] - cm * 0.6, q[0], q[1] + cm * 0.6)
  }
}

// Telemetry columns inside the disc beside the face: rows of hex that scroll
// upward while scanning, freeze and light on a lock, and scramble red on a
// miss. Below 150 px the rows are greeked, which still reads as data.
function telemetryColumns(p, cx, cy, R, size, state, t, rt, boot, tint, xu) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var fine = Math.max(0.5, size * 0.0038)
  var rows = 9
  var rowH = R * 0.085
  var period = bad ? 60 : 380
  var tt = ok ? (t - rt) + Math.min(rt, 500) : t
  var scroll = ok && rt > 500 ? 0 : frac(tt / period)
  var base = Math.floor(tt / period)
  var digits = size >= 150
  for (var side = -1; side <= 1; side += 2) {
    var x = cx + side * xu * R - (side < 0 ? R * 0.075 : 0)
    for (var r = 0; r < rows; r++) {
      var y = cy + (r - rows / 2 + 0.5 - scroll) * rowH
      var edge = Math.min(1, (rows / 2 - Math.abs(r - rows / 2 + 0.5 - scroll)) / 1.5)
      if (edge <= 0) continue
      var seed = (base + r) * 7 + (side + 1) * 131
      var hot = ok ? rt > 700 && (r + side) % 3 === 0 : (Math.floor(tt / 190) % rows === r)
      var role = bad ? ROLE_ERROR : (hot ? tint : FG3)
      var a = (hot ? 0.75 : 0.3) * edge * boot
      if (digits) {
        seg7(p, role, a, 0, fine, x, y - R * 0.018, R * 0.017, R * 0.034, R * 0.026, hex4(hash(seed) * 65535).slice(1), 0)
      } else {
        var wl = R * (0.03 + 0.04 * hash(seed))
        p.line(role, a, fine, x, y, x + wl, y)
      }
    }
  }
}

// HUD backplate: a fine polar grid behind the cloud, with registration
// crosses at its major intersections.
function hudGraticule(p, cx, cy, R, fine, hair, boot, tint, t) {
  for (var r = 1; r <= 5; r++) p.arc(FG3, 0.085 * boot, fine, cx, cy, R * r * 0.15, 0, TAU)
  for (var s = 0; s < 24; s++) {
    var a = s * TAU / 24
    p.line(FG3, (s % 2 ? 0.045 : 0.075) * boot, fine,
      cx + Math.cos(a) * R * 0.1, cy + Math.sin(a) * R * 0.1, cx + Math.cos(a) * R * 0.76, cy + Math.sin(a) * R * 0.76)
  }
  var k = R * 0.018
  for (var ri = 1; ri <= 2; ri++) {
    for (var ci = 0; ci < 12; ci++) {
      var ca = ci * TAU / 12 + ri * 0.26
      var x = cx + Math.cos(ca) * R * ri * 0.3, y = cy + Math.sin(ca) * R * ri * 0.3
      var tw = 0.10 + 0.08 * Math.sin(t / 600 + ci + ri * 2)
      p.line(ROLE_FG, tw * 2 * boot, fine, x - k, y, x + k, y)
      p.line(ROLE_FG, tw * 2 * boot, fine, x, y - k, x, y + k)
    }
  }
}

// HUD secondary instrumentation between and around the main rings: a radial
// spectrum, a counter-rotating vernier, an outer micro-scale, and satellites
// orbiting the dashed ring.
function hudSubRings(halo, crisp, state, t, rt, cx, cy, R, fine, hair, thin, boot, dim, tint, passFlash, closeK) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var t0 = t - rt

  // Radial spectrum. A travelling crest orbits it; a lock drives every bar
  // to full, then settles them; a miss drains them into random spikes.
  var nb = 96
  var rb = R * 0.772
  var spin = ringPose(2, state, t, rt) * 0.25
  var sStep = Math.floor(t / 70)
  for (var i = 0; i < nb; i++) {
    if (i / nb > boot) break
    var ang = spin + i * TAU / nb - Math.PI / 2
    var crest = Math.pow(0.5 + 0.5 * Math.cos(ang * 3 - t / 520), 3)
    var v = 0.12 + 0.55 * crest + 0.33 * hash(sStep * 97 + i)
    if (ok) {
      v = mix(v, 1, easeOutCubic(seg(rt, 380, 560)))
      v = mix(v, 0.35 + 0.25 * (i % 4 === 0 ? 1 : 0), easeInOutCubic(seg(rt, 700, 980)))
    }
    if (bad) {
      var drain = easeOutCubic(seg(rt, 60, 420))
      v = v * (1 - drain) + (hash(Math.floor(rt / 45) * 7 + i) > 0.86 ? 0.9 : 0.05) * drain
    }
    var len = R * 0.075 * v
    crisp.line(LUMEN && v <= 0.62 && tint !== ROLE_ERROR ? FG2 : tint, (0.24 + 0.62 * v) * dim, i % 2 === 0 ? hair : fine,
      cx + Math.cos(ang) * rb, cy + Math.sin(ang) * rb, cx + Math.cos(ang) * (rb + len), cy + Math.sin(ang) * (rb + len))
  }

  // Vernier: a fine scale turning against the bezel, 1.6 times as fast.
  var vr = ringPose(0, state, t, rt) * -1.6
  for (var vi = 0; vi < 144; vi++) {
    if (vi / 144 > boot) break
    var va = vr + vi * TAU / 144
    var vl = R * (vi % 12 === 0 ? 0.03 : 0.016)
    crisp.line(FG2, (vi % 12 === 0 ? 0.55 : 0.3) * dim * (1 + passFlash), fine,
      cx + Math.cos(va) * R * 0.936, cy + Math.sin(va) * R * 0.936,
      cx + Math.cos(va) * (R * 0.936 + vl), cy + Math.sin(va) * (R * 0.936 + vl))
  }

  // Outer micro-scale, clear of the corner readouts.
  var mr = ringPose(2, state, t, rt) * -0.3
  for (var mi = 0; mi < 120; mi++) {
    var ma = mr + mi * TAU / 120
    var off = Math.abs(((ma % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4)
    if (off < 0.32) continue
    var ml = R * (mi % 5 === 0 ? 0.022 : 0.012)
    crisp.line(ROLE_FG, 0.34 * dim * boot, fine,
      cx + Math.cos(ma) * R * 1.083, cy + Math.sin(ma) * R * 1.083,
      cx + Math.cos(ma) * (R * 1.083 + ml), cy + Math.sin(ma) * (R * 1.083 + ml))
  }

  // Spinners: one fast, one creeping the other way, between the rings.
  var spA = ok ? 1 - seg(rt, 500, 800) : 1
  var sp1 = t / 350
  var sp2 = -t / 5200
  if (bad) sp1 = t0 / 350 + (hash(Math.floor(rt / 50)) - 0.5) * 3
  crisp.arc(tint, 0.7 * dim * boot * spA, hair, cx, cy, R * 0.889, sp1, sp1 + 0.35)
  crisp.arc(tint, 0.35 * dim * boot * spA, fine, cx, cy, R * 0.889, sp1 + Math.PI, sp1 + Math.PI + 0.2)
  for (var sq = 0; sq < 6; sq++) crisp.arc(FG3, 0.3 * dim * boot, fine, cx, cy, R * 0.899, sp2 + sq * TAU / 6, sp2 + sq * TAU / 6 + 0.12)

  // Satellites on the dashed ring, each with a fading tail.
  var sats = [[t / 1300, 1], [-t / 2900 + 1, -1], [t / 4700 + 3, 1]]
  var satA = (1 - closeK) * dim * boot
  if (satA > 0.02) {
    for (var si = 0; si < sats.length; si++) {
      var sa = sats[si][0]
      var sr = R * 0.862
      var dir = sats[si][1]
      for (var tl = 1; tl <= 6; tl++) {
        var ta0 = sa - dir * tl * 0.06, ta1 = sa - dir * (tl - 1) * 0.06
        crisp.arc(tint, 0.5 * (1 - tl / 7) * satA, hair, cx, cy, sr, Math.min(ta0, ta1), Math.max(ta0, ta1))
      }
      var d = R * 0.022
      var sx = cx + Math.cos(sa) * sr, sy = cy + Math.sin(sa) * sr
      halo.poly(tint, 0.18 * satA, thin * 3, [[sx, sy - d], [sx + d, sy], [sx, sy + d], [sx - d, sy], [sx, sy - d]])
      crisp.poly(tint, 0.95 * satA, fine * 1.5, [[sx, sy - d], [sx + d, sy], [sx, sy + d], [sx - d, sy], [sx, sy - d]])
    }
  }
}


// HUD structured light: horizontal stripes projected onto the face and seen
// from the camera, each displaced by the depth under it, so the brow, nose,
// cheekbones and chin appear as bends in parallel lines. Stripes never close
// into loops, which is what keeps them from drawing a face of their own. The
// scan plane lights them as it passes; a lock resolves them top to bottom
// behind a sweep; a miss shears and breaks them.
var HUD_STRIPES = 20
var HUD_STRIPE_K = 0.22

function hudTopology(halo, crisp, state, t, rt, boot, tint, fine, hair, plane, project, toPx, FSC, tears, shearK, faceScale) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var scanning = !ok && !bad
  var brk = bad ? 0.45 * easeOutCubic(seg(rt, 150, 600)) : 0
  var resolved = ok ? easeOutCubic(seg(rt, 450, 900)) : 0
  for (var si = 0; si < HUD_STRIPES; si++) {
    var y = mix(-0.76, 0.76, si / (HUD_STRIPES - 1))
    var sweepAt = 220 + (y + 0.82) * 380
    var cas = ok ? bump(rt, sweepAt, sweepAt + 260) : 0
    // Faint while scanning, so the dot cloud stays the subject.
    var base = (scanning ? 0.2 : 0.3) + 0.55 * cas + 0.4 * resolved
    var pts = [], al = []
    for (var k = 0; k <= 30; k++) {
      var x = mix(-0.66, 0.66, k / 30)
      if (holoInside(x, y) <= 0.005) {
        if (pts.length > 1) strip(crisp, tint, fine * 1.8, pts, al)
        pts = []
        al = []
        continue
      }
      var z = holoZAt(x, y)
      var pr = project(x * faceScale, y * faceScale, z * DEPTH)
      var X = pr.x
      var Y = pr.y - z * HUD_STRIPE_K
      if (bad) {
        var band = Math.floor((y + 1.2) / 0.48)
        X += shearK * (band % 2 === 0 ? 0.16 : -0.16) + tearShift(tears, Y)
      }
      pts.push(toPx(X, Y))
      var a = base
      if (scanning) a += 0.6 * acquisition(plane, Y * FSC)
      if (bad && hash(si * 131 + k) < brk) a = 0
      al.push(a * boot * (0.55 + 0.45 * z / 0.8))
    }
    if (pts.length > 1) strip(crisp, tint, fine * 1.8, pts, al)
  }
}

// --- the analysis markers -------------------------------------------------------
//
// The head is only ever shown as depth: dots, slices, contours, shading. The
// analysis is drawn over it as instrument marks and never as pictures of
// features: landmark points with crosshair ticks and corner brackets that
// close onto them, measurement lines laid along the surface between pairs of
// them, and two-digit confidence readouts. They sit at the regions a face
// scanner measures, in stages from the forehead to the chin.
//
// Scanning, a marker seats as the scan passes it and eases back to tracking
// behind it. A match confirms the stages in order. A miss gets partway, then
// the stages break off in the error colour in the same order. The times are
// real milliseconds from the start of the result, not the authored clock the
// rest of the instrument is played on, so the cascade reads at the same pace
// whatever the style does around it.

var REC_FEAT0 = 80
var REC_FEAT_STEP = 200
var REC_FEAT_LEN = 300
var FAIL_STEP = 130
var FAIL_LEN = 420

// Set per frame in paintInto. mode: "scan", "rec" or "fail"; rt: real
// milliseconds into the mode.
var FEAT = { mode: "scan", rt: 0 }

function featStart(s) { return REC_FEAT0 + s * REC_FEAT_STEP }

// x, y on the face; stage 0..4 down the face; whether it carries a readout.
// Scattered over the whole face on purpose: a pair of marks level with each
// other reads as eyes, so none of them sit as a symmetric pair.
var MARKS = [
  [0.02, -0.52, 0, 1], [-0.32, -0.36, 0, 0], [0.31, -0.33, 0, 0], [-0.15, -0.2, 0, 0],
  [-0.36, -0.05, 1, 1], [0.34, -0.03, 1, 0], [0.14, -0.06, 1, 0],
  [0.02, 0.14, 2, 1], [-0.3, 0.15, 2, 0], [0.32, 0.2, 2, 0],
  [-0.15, 0.37, 3, 1], [0.37, 0.4, 3, 0],
  [0.03, 0.6, 4, 1], [-0.24, 0.54, 4, 0], [0.25, 0.53, 4, 0]
]
// Pairs of MARKS joined by a measurement line.
var MARK_LINES = [[1, 2], [0, 12], [4, 5], [8, 9], [13, 14]]

var MARK_NUM = [97, 99, 98, 96, 99, 98, 97, 99, 98, 96]

// The state of one marker. `d` is how far the scan has passed it, in face
// units (negative while it is still ahead).
function markState(m, mi, d) {
  var st = { a: 0, seat: 0, solid: 0, fail: 0, flash: 0, mode: FEAT.mode }
  var j = mi % 3
  if (FEAT.mode === "rec") {
    var t0 = featStart(m[2]) + j * 30
    var k = seg(FEAT.rt, t0, t0 + REC_FEAT_LEN)
    st.seat = k
    st.solid = easeOutCubic(k)
    st.a = 0.3 + 0.7 * clamp01(k * 1.6)
    st.flash = bump(FEAT.rt, t0 + 20, t0 + 360)
  } else if (FEAT.mode === "fail") {
    var f0 = m[2] * FAIL_STEP + j * 24
    st.fail = easeOutCubic(seg(FEAT.rt, f0, f0 + FAIL_LEN))
    st.seat = 0.75
    st.a = 0.7 * (1 - st.fail) + 0.38 * st.fail
  } else {
    st.seat = seg(d, -0.04, 0.2)
    st.a = 0.18 + 0.82 * st.seat * (0.5 + 0.5 * Math.exp(-Math.max(0, d) / 1.1))
  }
  return st
}

// `o.proj(x, y, z)` projects face space to {x, y, v} (v the visibility),
// `o.pass(x, y, q)` is how far the scan has passed that point, `o.post` an
// optional distortion, `o.U` the face radius in pixels.
function faceMarkers(halo, crisp, o) {
  var mode = FEAT.mode
  var U = o.U
  var st = [], pt = [], i, j
  for (i = 0; i < MARKS.length; i++) {
    var m = MARKS[i]
    var q = o.proj(m[0], m[1], holoZAt(m[0], m[1]) + 0.02)
    if (o.post && q) q = o.post(q)
    var d = mode === "scan" ? o.pass(m[0], m[1], q) : 0
    pt.push(q)
    st.push(markState(m, i, d))
  }

  // Measurement lines first, so the marks sit on top of them.
  for (i = 0; i < MARK_LINES.length; i++) {
    var A = MARKS[MARK_LINES[i][0]], B = MARKS[MARK_LINES[i][1]]
    var sa = st[MARK_LINES[i][0]], sb = st[MARK_LINES[i][1]]
    var qa = pt[MARK_LINES[i][0]], qb = pt[MARK_LINES[i][1]]
    if (!qa || !qb || qa.v < 0.2 || qb.v < 0.2) continue
    var prog, la
    if (mode === "rec") {
      var tl = featStart(Math.max(A[2], B[2])) + 120
      prog = seg(FEAT.rt, tl, tl + 360)
      la = 0.55 * Math.min(sa.a, sb.a)
    } else if (mode === "fail") {
      prog = 1
      la = 0.4 * Math.min(sa.a, sb.a) * (1 - Math.max(sa.fail, sb.fail))
    } else {
      prog = Math.min(sa.seat, sb.seat)
      la = 0.42 * Math.min(sa.a, sb.a)
    }
    if (prog <= 0.02 || la <= 0.02) continue
    var role = mode === "fail" ? ROLE_ERROR : o.tint
    var N = 16, run = []
    var broke = mode === "fail" ? Math.max(sa.fail, sb.fail) : 0
    for (j = 0; j <= N; j++) {
      var u = j / N
      if (u > prog) break
      var X = mix(A[0], B[0], u), Y = mix(A[1], B[1], u)
      var qq = o.proj(X, Y, holoZAt(X, Y) + 0.02)
      if (o.post && qq) qq = o.post(qq)
      if (broke > 0) {
        var shake = (hash(i * 31 + j) - 0.5) * broke * U * 0.07
        qq = { x: qq.x + shake, y: qq.y + (hash(i * 17 + j) - 0.5) * broke * U * 0.05, v: qq.v }
      }
      run.push(qq)
    }
    for (j = 0; j + 1 < run.length; j += 2) {
      if (run[j].v < 0.2 || run[j + 1].v < 0.2) continue
      if (broke > 0 && hash(i * 13 + j * 7) < broke * 0.9) continue
      crisp.line(role, la * o.gain, o.wLine, run[j].x, run[j].y, run[j + 1].x, run[j + 1].y)
    }
    if (run.length > 2 && !broke) {
      var e0 = run[0], e1 = run[run.length - 1]
      var tx = e1.x - e0.x, ty = e1.y - e0.y
      var tl2 = Math.hypot(tx, ty) || 1
      var nx = -ty / tl2 * U * 0.022, ny = tx / tl2 * U * 0.022
      crisp.line(role, la * 1.4 * o.gain, o.wLine, e0.x - nx, e0.y - ny, e0.x + nx, e0.y + ny)
      if (prog >= 0.98) crisp.line(role, la * 1.4 * o.gain, o.wLine, e1.x - nx, e1.y - ny, e1.x + nx, e1.y + ny)
    }
    if (o.labels && prog >= 0.98 && run.length > 2 && la > 0.2) {
      var mid = run[Math.floor(run.length / 2)]
      var dist = Math.round(Math.hypot((A[0] - B[0]) * 296, (A[1] - B[1]) * 296))
      seg7(crisp, role, la * 1.5 * o.gain, 0, o.wLine, mid.x - U * 0.03, mid.y - U * 0.065, U * 0.016, U * 0.03, U * 0.023, String(dist), 0)
    }
  }

  for (i = 0; i < MARKS.length; i++) {
    var M = MARKS[i], S = st[i], Q = pt[i]
    if (!Q || Q.v < 0.15) continue
    var al = S.a * Q.v * o.gain
    if (al < 0.03) continue
    var rl = S.fail > 0 ? ROLE_ERROR : o.tint
    var h = U * 0.04 * mix(2.6, 1, easeOutCubic(S.seat))
    var lc = h * 0.45
    var dotW = Math.max(1.4, U * 0.022 * (0.7 + 0.5 * S.solid))
    // The point itself: round dot, hot at its core once it has seated.
    crisp.line(rl, al, dotW, Q.x, Q.y, Q.x + 0.01, Q.y)
    if (LUMEN && S.mode !== "fail" && S.seat > 0.6) {
      halo.line(rl, al * 0.5, dotW * 2.6, Q.x, Q.y, Q.x + 0.01, Q.y)
      crisp.line(hotOf(rl), al * (0.45 + 0.5 * S.flash), Math.max(0.8, dotW * 0.45), Q.x, Q.y, Q.x + 0.01, Q.y)
    }
    if (S.seat < 0.04) continue
    var ba = al * (0.55 + 0.45 * S.seat) * (1 - 0.85 * S.fail)
    var br = h + S.fail * h * 2.4
    var ang = S.fail * (hash(i * 5 + 1) - 0.5) * 1.6
    for (j = 0; j < 4; j++) {
      var cxs = j % 2 ? 1 : -1, cys = j < 2 ? -1 : 1
      var wob = S.fail * (hash(i * 7 + j) - 0.5) * h * 2.2
      var ox = cxs * br + wob, oy = cys * br - wob * 0.6
      var cs = Math.cos(ang), sn = Math.sin(ang)
      var px = Q.x + ox * cs - oy * sn, py = Q.y + ox * sn + oy * cs
      bracketCorner(crisp, rl, ba, o.wMark, px, py, -cxs, -cys, lc)
    }
    // Crosshair ticks at the cardinals, once seated.
    if (S.seat > 0.5 && S.fail < 0.5) {
      var ta = ba * 0.8
      var g0 = dotW * 1.2 + U * 0.012, g1 = g0 + h * 0.5
      crisp.line(rl, ta, o.wMark, Q.x - g1, Q.y, Q.x - g0, Q.y)
      crisp.line(rl, ta, o.wMark, Q.x + g0, Q.y, Q.x + g1, Q.y)
      crisp.line(rl, ta, o.wMark, Q.x, Q.y - g1, Q.x, Q.y - g0)
      crisp.line(rl, ta, o.wMark, Q.x, Q.y + g0, Q.x, Q.y + g1)
    }
    // The confidence readout: churning while it tracks, steady once confirmed,
    // a dash when it fails.
    if (o.labels && M[3] && S.seat > 0.5) {
      var txt
      if (S.mode === "rec") txt = S.seat >= 0.98 ? String(MARK_NUM[i % MARK_NUM.length]) : String(60 + Math.floor(hash(i * 9 + Math.floor(FEAT.rt / 45)) * 30))
      else if (S.mode === "fail") txt = S.fail > 0.5 ? "--" : String(40 + Math.floor(hash(i * 9 + Math.floor(FEAT.rt / 45)) * 30))
      else txt = String(30 + Math.floor(hash(i * 9 + Math.floor(o.clock / 120)) * 50))
      var tw = U * 0.02, th = U * 0.036
      var lx = Q.x + br + U * 0.016
      seg7(crisp, rl, ba * 0.9, 0, o.wMark, Q.x > o.cx ? lx : Q.x - br - U * 0.016 - 2 * U * 0.028 + U * 0.008, Q.y - th / 2, tw, th, U * 0.028, txt, 0)
    }
  }
}

// --- shared result gestures ---------------------------------------------------

// A miss opens with a fault strobe, flickering between the accent and the
// error colour before it commits to the error colour.
function missTint(rt) {
  return rt < 120 && Math.floor(rt / 30) % 2 === 0 ? ROLE_ACCENT : ROLE_ERROR
}

// Glitch tears. A few horizontal strips, re-rolled every 45 ms for the first
// 300 ms of a miss.
function glitchTears(rt) {
  var tears = []
  if (rt >= 300) return tears
  var tstep = Math.floor(rt / 45)
  for (var tj = 0; tj < 3; tj++) {
    tears.push({
      y: (hash(tstep * 5 + tj * 17) * 2 - 1) * 0.85,
      h: 0.035 + hash(tstep * 9 + tj) * 0.06,
      dx: (hash(tstep * 11 + tj * 3) - 0.5) * 0.42
    })
  }
  return tears
}

function tearShift(tears, y) {
  var dx = 0
  for (var i = 0; i < tears.length; i++) if (Math.abs(y - tears[i].y) < tears[i].h) dx += tears[i].dx
  return dx
}

function drawTears(p, tears, cx, cy, R) {
  for (var i = 0; i < tears.length; i++) {
    var ty = cy + tears[i].y * R
    var tdx = tears[i].dx * R
    p.line(ROLE_ERROR, 0.45, Math.max(1, tears[i].h * R * 0.5), cx - R * 0.9 + tdx, ty, cx + R * 0.9 + tdx, ty)
  }
}

// A reticle contracting and rotating onto a landmark (k 0..1), leaving a
// small locked diamond behind.
function drawLockReticle(halo, crisp, tint, C, k, R, hair, thin, flash) {
  if (k <= 0) return
  var ret = 1 - k
  if (ret > 0.01) {
    var rs = R * mix(0.05, 0.20, ret)
    var rrot = ret * 0.8
    var ra = clamp01(k * 3) * 0.95
    var sq = []
    for (var q = 0; q < 4; q++) {
      var qa = rrot + q * Math.PI / 2 + Math.PI / 4
      sq.push([C.x + Math.cos(qa) * rs, C.y + Math.sin(qa) * rs])
    }
    for (var q3 = 0; q3 < 4; q3++) {
      var Pq = sq[q3], Pn = sq[(q3 + 1) % 4], Pv = sq[(q3 + 3) % 4]
      crisp.poly(tint, ra, hair, [
        [mix(Pq[0], Pv[0], 0.3), mix(Pq[1], Pv[1], 0.3)],
        Pq,
        [mix(Pq[0], Pn[0], 0.3), mix(Pq[1], Pn[1], 0.3)]
      ])
    }
  }
  var ds = R * 0.032 * mix(1.8, 1, easeOutBack(k))
  var dA = clamp01(k * 2) * (0.9 + 0.1 * flash)
  var dia = [[C.x, C.y - ds], [C.x + ds, C.y], [C.x, C.y + ds], [C.x - ds, C.y], [C.x, C.y - ds]]
  halo.poly(tint, dA * 0.2, thin * 3.2, dia)
  crisp.poly(tint, dA, thin, dia)
}

// A reticle that hunted and lost track: its corners drift apart and fade.
// Never an X: an X on each eye is a cartoon dead face.
function drawLostTrack(crisp, bx, by, R, lost, alpha, hair, seed) {
  var xs = R * (0.045 + 0.035 * lost)
  var arm = R * 0.028 * (1 - 0.4 * lost)
  var skew = (hash(seed * 3 + 5) - 0.5) * 0.5 * lost
  for (var q = 0; q < 4; q++) {
    var qa = skew + q * Math.PI / 2 + Math.PI / 4
    var kx = bx + Math.cos(qa) * xs, ky = by + Math.sin(qa) * xs
    var ux = Math.cos(qa + Math.PI * 0.75), uy = Math.sin(qa + Math.PI * 0.75)
    var vx = Math.cos(qa - Math.PI * 0.75), vy = Math.sin(qa - Math.PI * 0.75)
    crisp.poly(ROLE_ERROR, alpha, hair, [[kx + ux * arm, ky + uy * arm], [kx, ky], [kx + vx * arm, ky + vy * arm]])
  }
}

// A V pointing at the centre, used for lock clamps and chevrons.
function chevron(p, role, a, w, cx, cy, ang, r, depth, wing) {
  p.poly(role, a, w, [
    [cx + Math.cos(ang - wing) * (r + depth), cy + Math.sin(ang - wing) * (r + depth)],
    [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r],
    [cx + Math.cos(ang + wing) * (r + depth), cy + Math.sin(ang + wing) * (r + depth)]
  ])
}

// The mask's ellipsoid, which every style lays its relief on. Declared ahead
// of the radar, which is the first style to read it.
var HOLO_A = 0.60
var HOLO_B = 0.78
var HOLO_C = 0.55
var HOLO_CY = -0.06

// --- Phosphor Radar -------------------------------------------------------------
//
// A plan-position scope. The sweep arm refreshes a dense topology of returns
// laid on the face: the silhouette, iso-depth contours of the relief, and a
// speckle of skin. Returns decay behind the arm but
// never below a floor, so the whole face stays legible at 116 px between
// sweeps; the first revolution after entry paints it in. Returns are range
// cells, short arcs about the scope centre, never smooth outlines, so the
// face reads as sensor data. Around it: a fine graticule with sub-ticks, a
// nodding sector scanner, a range strobe, interference, and target brackets.

var RADAR_REV_MS = 2400
var RADAR_CLUTTER = 90
var RADAR_FLOOR = 0.26
var RADAR_FACE = 1.1

function radarReturns() {
  if (CACHE.radar4) return CACHE.radar4
  var rnd = mulberry32(4242)
  var rs = []
  // Takes face coordinates; depth is sampled there and the position is then
  // scaled out to the scope.
  function add(kind, fx, fy, gain, stage) {
    var z = holoInside(fx, fy) > 0 ? classicZAt(fx, fy) : 0
    var x = fx * RADAR_FACE, y = fy * RADAR_FACE
    rs.push({ kind: kind, x: x, y: y, r: Math.hypot(x, y), a: Math.atan2(y, x), gain: gain * (0.7 + 0.5 * z), j: rnd(), stage: stage === undefined ? -1 : stage })
  }
  var i, a, j
  // The head's silhouette, laid as returns along its outline. Nothing inside
  // it is drawn as a line: the face is only its relief, below.
  for (var side = -1; side <= 1; side += 2) {
    var racc = 0
    for (var oy = FACE_TOP; oy <= FACE_CHIN - 0.004; oy += 0.01) {
      racc += 0.01
      if (racc < 0.034) continue
      racc = 0
      add("rim", side * faceHalfW(oy), oy, 0.8)
    }
  }
  add("rim", 0, FACE_TOP, 0.8)
  add("rim", 0, FACE_CHIN, 0.8)
  // The face itself is its relief: fine returns laid along dense iso-depth
  // contours, so the cheekbones and the forehead emerge as topography.
  var lv = []
  for (i = 0; i < 10; i++) lv.push(0.06 + i * 0.068)
  var topo = reliefContours("radarT", 20, 27, lv, false, classicZAt)
  for (i = 0; i < topo.segs.length; i++) {
    var S = topo.segs[i]
    add("topo", (S[0] + S[2]) / 2, (S[1] + S[3]) / 2, 0.36 + 0.03 * S[5])
  }
  var n = 0
  while (n < 40) {
    var sx = (rnd() * 2 - 1) * 0.6
    var sy2 = (rnd() * 2 - 1) * 0.78
    if (holoInside(sx, sy2) <= 0.05) continue
    add("skin", sx, sy2, 0.3)
    n++
  }
  CACHE.radar4 = rs
  return rs
}

// Unwrapped sweep angle. A lock spins the arm up for an extra revolution
// that refreshes every return at once; a miss stutters it and runs it
// backwards.
function radarSweep(state, t, rt) {
  var t0 = t - rt
  if (state === "recognized") {
    return t0 / RADAR_REV_MS * TAU + rt / RADAR_REV_MS * TAU + TAU * 1.2 * easeInOutCubic(seg(rt, 0, 450))
  }
  if (state === "notRecognized") {
    var step = Math.min(7, Math.floor(rt / 60))
    var off = step > 0 ? (hash(step * 5 + 2) - 0.5) * 1.4 : 0
    return t0 / RADAR_REV_MS * TAU - rt / RADAR_REV_MS * TAU * 0.5 + off
  }
  return t / RADAR_REV_MS * TAU
}

function frac(v) { return v - Math.floor(v) }

// An L-bracket at (x, y) opening toward (dx, dy).
function bracketCorner(p, role, a, w, x, y, dx, dy, len) {
  p.poly(role, a, w, [[x + dx * len, y], [x, y], [x, y + dy * len]])
}

function bracketBox(p, role, a, w, x, y, h, len) {
  bracketCorner(p, role, a, w, x - h, y - h, 1, 1, len)
  bracketCorner(p, role, a, w, x + h, y - h, -1, 1, len)
  bracketCorner(p, role, a, w, x - h, y + h, 1, -1, len)
  bracketCorner(p, role, a, w, x + h, y + h, -1, -1, len)
}

function paintRadar(ctx, size, spec) {
  var state = spec.state || "scanning"
  var t = spec.clock || 0
  var rt = spec.elapsed || 0
  var compact = size < 76
  var micro = size < 48
  var hud = size >= 100
  var labels = size >= 150

  var cx = size / 2
  var cy = size / 2
  var R = size * 0.45

  ctx.reset()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var scanning = !ok && !bad
  var tint = bad ? missTint(rt) : ROLE_ACCENT
  TINT = tint
  var t0 = t - rt

  var hair = Math.max(1, size * 0.0065)
  var thin = Math.max(1, size * 0.009)
  var bold = Math.max(1, size * 0.016)
  var fine = Math.max(0.5, size * 0.0038)

  var boot = scanning ? easeOutCubic(seg(rt, 0, BOOT_MS)) : 1
  var sweepU = radarSweep(state, t, rt)
  var arm = sweepU - Math.PI / 2
  // Everything the arm has passed since this state was entered.
  var swept = scanning ? rt / RADAR_REV_MS * TAU : TAU

  var armK = scanning ? boot : (ok ? 1 - easeOutCubic(seg(rt, 420, 680)) : mix(1, 0.45, seg(rt, 300, 700)))
  var spinGlow = ok ? 1 + 0.8 * bump(rt, 0, 500) : 1
  var holdK = ok ? easeOutCubic(seg(rt, 150, 500)) : 0
  var smearK = bad ? easeOutCubic(seg(rt, 120, 520)) : 0
  var jamK = bad ? easeOutCubic(seg(rt, 0, 260)) * (1 - 0.5 * seg(rt, 500, 900)) : 0
  var calm = ok ? 1 - easeOutCubic(seg(rt, 0, 300)) : 1
  var passFlash = ok ? bump(rt, REC_PASS - 40, REC_PASS + 420) : 0
  var tears = bad ? glitchTears(rt) : []

  var halo = haloPen(ctx)
  var crisp = pen(ctx)
  function flush() { halo.flush(); crisp.flush() }

  var R_ret = radarReturns()

  // Age of a bearing behind the arm, as a fraction of a revolution, plus the
  // sweep cycle it belongs to. The cycle flips exactly when the arm passes,
  // so anything keyed to it changes under the arm, never behind it.
  function ageOf(phi) {
    var u = (arm - phi) / TAU
    return { f: frac(u), c: Math.floor(u) }
  }
  function visible(f) {
    return scanning ? clamp01((swept - f * TAU) / 0.15) : 1
  }

  if (micro) {
    var mw = Math.max(1, size * 0.072)
    if (bad) {
      var brk = easeOutCubic(seg(rt, 200, 560))
      for (var mb = 0; mb < 8; mb++) {
        var ma = (mb / 8) * TAU + brk * 0.3 * (mb % 2 ? 1 : -1)
        crisp.arc(tint, 0.9 * (1 - brk * 0.45), mw, cx, cy, R * (0.92 + brk * 0.08), ma, ma + 0.42)
      }
    } else {
      crisp.arc(tint, ok ? 1 : 0.75, mw, cx, cy, R * 0.92, 0, TAU)
    }
    var mArm = ok ? t0 / RADAR_REV_MS * TAU - Math.PI / 2 : arm
    crisp.line(tint, (ok ? 1 - seg(rt, 0, 300) : 0.95), mw, cx, cy, cx + Math.cos(mArm) * R * 0.85, cy + Math.sin(mArm) * R * 0.85)
    // Three returns at different ranges and bearings: sensor data, not a face.
    var mret = [[0.32, -2.3], [0.55, 0.4], [0.72, 2.2]]
    for (var me = 0; me < mret.length; me++) {
      crisp.arc(tint, 0.95, mw * 1.1, cx, cy, mret[me][0] * R, mret[me][1] - 0.35, mret[me][1] + 0.35)
    }
    if (ok) {
      var mh = bump(rt, 40, 620)
      if (mh > 0.01) crisp.arc(tint, mh * 0.7, Math.max(1, size * 0.04), cx, cy, R * mix(0.2, 1.08, easeOutCubic(seg(rt, 40, 620))), 0, TAU)
    }
    crisp.flush()
    return
  }

  var wob = function (i) { return bad && rt < 420 ? 1 + (hash(Math.floor(rt / 60) * 3 + i) - 0.5) * 0.06 : 1 }
  var ringDraw = TAU * seg(boot, 0, 0.9)
  var breathe = 1 + 0.008 * Math.sin(t / 900)
  var lockRing = ok ? easeInOutCubic(seg(rt, 300, 650)) : 0

  // --- graticule --------------------------------------------------------------
  if (!compact) {
    plate(crisp, cx, cy, R, boot, 0)
    // Range rings with sub-ticks every 5 degrees, pulsing outward in turn on
    // a lock.
    for (var rr = 1; rr <= 4; rr++) {
      var rad = R * rr * 0.2 * breathe * wob(rr)
      var pulse = ok ? bump(rt, 180 + rr * 70, 420 + rr * 70) : 0
      crisp.arc(pulse > 0.02 ? tint : ROLE_FG, (0.1 + 0.6 * pulse) * boot, pulse > 0.02 ? hair : fine, cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + ringDraw)
      var nt = 24 + rr * 12
      for (var st = 0; st < nt; st++) {
        if (st / nt > seg(boot, 0, 0.9)) break
        var sa0 = st * TAU / nt
        var tl = R * (st % 6 === 0 ? 0.022 : 0.011)
        crisp.line(FG3, 0.16 * boot, fine,
          cx + Math.cos(sa0) * rad, cy + Math.sin(sa0) * rad,
          cx + Math.cos(sa0) * (rad - tl), cy + Math.sin(sa0) * (rad - tl))
      }
    }
    // Bearing spokes: every 10 degrees fine, every 30 heavier.
    for (var sp = 0; sp < 36; sp++) {
      var sa = sp * TAU / 36
      var heavy = sp % 3 === 0
      crisp.line(FG3, (heavy ? 0.075 : 0.035) * boot, heavy ? hair : fine,
        cx + Math.cos(sa) * R * 0.05, cy + Math.sin(sa) * R * 0.05,
        cx + Math.cos(sa) * R * 0.975, cy + Math.sin(sa) * R * 0.975)
    }
    // Inner azimuth ring, creeping against the sweep.
    var az = -t / 30000 * TAU
    for (var zt = 0; zt < 120; zt++) {
      var za = az + zt * TAU / 120
      var zl = R * (zt % 10 === 0 ? 0.03 : 0.014)
      crisp.line(ROLE_FG, (zt % 10 === 0 ? 0.5 : 0.26) * boot, fine,
        cx + Math.cos(za) * R * 0.94, cy + Math.sin(za) * R * 0.94, cx + Math.cos(za) * (R * 0.94 - zl), cy + Math.sin(za) * (R * 0.94 - zl))
    }
    if (hud) telemetryColumns(crisp, cx, cy, R, size, state, t, rt, boot, tint, 0.66)
    // Lock ring: the middle range ring expands to enclose the face.
    if (lockRing > 0) {
      glowArc(halo, crisp, tint, (0.75 + 0.25 * passFlash) * lockRing, mix(hair, bold * 0.7, lockRing), cx, cy, R * mix(0.6, 0.88, lockRing), 0, TAU)
    }
    // Bearing bezel with a micro-scale outside it.
    for (var bt = 0; bt < 72; bt++) {
      if (bt / 72 > seg(boot, 0, 0.8)) break
      var ba = bt * TAU / 72 - Math.PI / 2
      var major = bt % 6 === 0
      var rel = Math.atan2(Math.sin(ba - arm), Math.cos(ba - arm))
      var near = Math.exp(-rel * rel / 0.02) * armK
      var la = (major ? 0.62 : 0.3) + near * 0.6 + passFlash * 0.4
      var len = R * (major ? 0.065 : 0.03)
      crisp.line(major || near > 0.3 ? tint : ROLE_FG, la, major ? thin : fine,
        cx + Math.cos(ba) * R * 1.0, cy + Math.sin(ba) * R * 1.0,
        cx + Math.cos(ba) * (R * 1.0 + len), cy + Math.sin(ba) * (R * 1.0 + len))
    }
    for (var mt = 0; mt < 180; mt++) {
      var mta = mt * TAU / 180
      var offd = Math.abs(((mta % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4)
      if (offd < 0.3) continue
      crisp.line(FG3, 0.2 * boot, fine,
        cx + Math.cos(mta) * R * 1.075, cy + Math.sin(mta) * R * 1.075,
        cx + Math.cos(mta) * R * (mt % 5 === 0 ? 1.1 : 1.088), cy + Math.sin(mta) * R * (mt % 5 === 0 ? 1.1 : 1.088))
    }
    if (armK > 0.02) chevron(crisp, tint, 0.9 * armK, thin, cx, cy, arm, R * 1.075, R * 0.05, 0.07)
    if (labels) {
      var lw2 = Math.max(0.5, size * 0.0035)
      for (var lb = 1; lb <= 4; lb++) {
        seg7(crisp, ROLE_FG, 0.3 * boot, 0, lw2, cx + R * lb * 0.2 + R * 0.012, cy - R * 0.055, R * 0.022, R * 0.04, R * 0.03, String(lb * 2), 0)
      }
    }
  }
  glowArc(halo, crisp, tint, (0.42 + passFlash * 0.4) * boot * (bad ? mix(1, 0.6, smearK) : 1), thin, cx, cy, R * 0.985 * wob(3), -Math.PI / 2, -Math.PI / 2 + ringDraw)
  flush()

  // --- interference ------------------------------------------------------------
  if (!compact) {
    var noiseA = (scanning ? 1 : (ok ? calm : 1 + 1.5 * jamK)) * boot
    var nStep = Math.floor(t / 45)
    var nSpeck = Math.round(80 + 180 * jamK)
    for (var ns = 0; ns < nSpeck; ns++) {
      var nr = (0.08 + 0.9 * Math.sqrt(hash(nStep * 131 + ns))) * R
      var na = hash(nStep * 71 + ns * 3) * TAU
      crisp.arc(tint, (0.08 + 0.14 * hash(ns * 7 + nStep)) * noiseA, fine, cx, cy, nr, na, na + 0.025)
    }
    var spokes = scanning ? 3 : (bad ? 10 : 3)
    var sStep = Math.floor(t / 90)
    for (var sk = 0; sk < spokes; sk++) {
      if (hash(sStep * 17 + sk) < (bad ? 0.2 : 0.55)) continue
      var ska = hash(sStep * 29 + sk * 5) * TAU
      crisp.line(tint, 0.13 * noiseA, fine, cx + Math.cos(ska) * R * 0.1, cy + Math.sin(ska) * R * 0.1,
        cx + Math.cos(ska) * R * 0.97, cy + Math.sin(ska) * R * 0.97)
    }
    if (hash(Math.floor(t / 400)) > (bad ? 0.3 : 0.82)) {
      crisp.arc(tint, 0.14 * noiseA, fine, cx, cy, R * (0.15 + 0.8 * hash(Math.floor(t / 400) + 3)), 0, TAU)
    }
    crisp.flush()
  }

  // --- sweep, afterglow and the range strobe -------------------------------------
  if (armK > 0.01) {
    var dir = bad ? -1 : 1
    var trail = compact ? 10 : 64
    var span = compact ? 0.045 : 0.026
    for (var k = 1; k <= trail; k++) {
      var wa = arm - dir * k * span
      crisp.line(tint, 0.34 * Math.exp(-k / (compact ? 8 : 20)) * armK * spinGlow, compact ? thin : fine,
        cx + Math.cos(wa) * R * 0.04, cy + Math.sin(wa) * R * 0.04,
        cx + Math.cos(wa) * R * 0.975, cy + Math.sin(wa) * R * 0.975)
    }
    crisp.flush()
    glowLine(halo, crisp, tint, 0.95 * armK, thin, cx, cy, cx + Math.cos(arm) * R * 0.98, cy + Math.sin(arm) * R * 0.98)
    if (!compact) {
      var gate = R * (0.1 + 0.85 * frac(t / 1400))
      var tail = arm - 0.13 * dir, lead = arm + 0.04 * dir
      crisp.arc(tint, 0.8 * armK, hair, cx, cy, gate, Math.min(tail, lead), Math.max(tail, lead))
    }
    flush()
  }

  // A second, nodding sector scanner over the face. It lights the returns
  // it crosses, collapses on a lock and jumps about on a miss.
  var secC = t / 11000 * TAU - Math.PI / 2
  var secAmp = 0.85 * (ok ? 1 - easeOutCubic(seg(rt, 0, 300)) : 1)
  var secBeam = secC + secAmp * Math.sin(t / 850)
  if (bad) secBeam = secC + (hash(Math.floor(rt / 60) * 3 + 1) - 0.5) * 2
  var secK = (ok ? 1 - seg(rt, 200, 420) : 1) * boot
  if (!compact && secK > 0.01) {
    for (var sl = 0; sl < 2; sl++) {
      var lim = secC + (sl ? 1 : -1) * 0.85
      for (var dd = 0; dd < 12; dd += 2) {
        var d0 = R * (0.1 + dd * 0.07), d1 = R * (0.1 + (dd + 1) * 0.07)
        crisp.line(FG2, 0.2 * secK, fine, cx + Math.cos(lim) * d0, cy + Math.sin(lim) * d0, cx + Math.cos(lim) * d1, cy + Math.sin(lim) * d1)
      }
    }
    crisp.arc(FG2, 0.22 * secK, fine, cx, cy, R * 0.94, secC - 0.85, secC + 0.85)
    for (var sb = 0; sb < 10; sb++) {
      var sba = secBeam - Math.cos(t / 850) * sb * 0.012
      crisp.line(tint, 0.3 * Math.exp(-sb / 3) * secK, fine, cx + Math.cos(sba) * R * 0.12, cy + Math.sin(sba) * R * 0.12,
        cx + Math.cos(sba) * R * 0.93, cy + Math.sin(sba) * R * 0.93)
    }
    crisp.flush()
  }

  // --- returns -----------------------------------------------------------------------
  var pings = ok ? [[600, 1000], [720, 1090], [840, 1150]] : (bad ? [[0, 340], [150, 500]] : [])
  var pingR = []
  for (var pg = 0; pg < pings.length; pg++) {
    var pk = seg(rt, pings[pg][0], pings[pg][1])
    if (pk > 0 && pk < 1) pingR.push(mix(0.05, 1.05, easeOutCubic(pk)))
  }
  var jitStep = Math.floor(rt / 60)
  for (var i = 0; i < R_ret.length; i++) {
    var q = R_ret[i]
    if (compact && (q.kind === "skin" || q.kind === "topo")) continue
    var ag = ageOf(q.a)
    var vis = visible(ag.f)
    if (vis <= 0) continue
    var fresh = Math.exp(-ag.f * (bad ? 6 : 3))
    if (ok) fresh = mix(fresh, 1, easeOutCubic(seg(rt, 150 + q.r * 350, 320 + q.r * 350)))
    var secHit = 0
    if (!compact && secK > 0.01) {
      var sd = Math.atan2(Math.sin(q.a - secBeam), Math.cos(q.a - secBeam))
      secHit = Math.exp(-sd * sd / 0.004) * 0.45 * secK
    }
    var echo = 0
    for (var pr = 0; pr < pingR.length; pr++) {
      var de = (q.r - pingR[pr]) / 0.05
      echo += Math.exp(-de * de) * 0.6
    }
    var flick = scanning ? 0.82 + 0.18 * hash(ag.c * 13 + i) : 1
    var alpha = q.gain * (RADAR_FLOOR + (1 - RADAR_FLOOR) * fresh) * flick * vis + secHit + echo
    if (bad) alpha *= 1 - 0.3 * seg(rt, 200, 800)
    alpha *= 1 + passFlash * 0.2
    var w = clamp(0.03 / Math.max(q.r, 0.05), 0.05, 0.22)
    if (q.kind === "rim") w *= mix(0.8, 1.2, holdK)
    if (q.kind === "topo" || q.kind === "skin") w *= 0.5
    var lw = compact ? Math.max(1, size * 0.03)
      : (q.kind === "rim" ? Math.max(1, size * 0.012) : Math.max(0.6, size * 0.0068))
    var ox = bad ? tearShift(tears, q.y) * R : 0
    var qr = q.r * R
    if (bad && jamK > 0) qr += (hash(jitStep * 7 + i) - 0.5) * 0.025 * R * jamK
    {
      var qrole = tint
      if (LUMEN) {
        // A fresh return flashes white-hot, then decays in the accent. A
        // second hue for old returns faded the face out on a light card.
        alpha *= ok ? 0.72 : 0.85
        if (echo > 0.3 || (scanning && fresh > 0.72)) qrole = hotOf(tint)
      }
      crisp.arc(qrole, alpha, lw, cx + ox, cy, qr, q.a - w, q.a + w)
      // Phosphor bloom on fresh returns.
      if (!compact && q.kind === "topo" && fresh > 0.6 && i % 2 === 0) halo.arc(tint, alpha * 0.2 * fresh, lw * 4, cx + ox, cy, qr, q.a - w, q.a + w)
    }
    if (smearK > 0.01 && (q.kind !== "topo" || i % 2 === 0)) {
      var r1 = qr * (1 + 0.16 * smearK * (0.5 + q.j))
      crisp.line(tint, alpha * 0.5, fine, cx + ox + Math.cos(q.a) * qr, cy + Math.sin(q.a) * qr,
        cx + ox + Math.cos(q.a) * r1, cy + Math.sin(q.a) * r1)
    }
  }

  // Clutter: re-rolled per sweep cycle, flooding in on a miss and filtered
  // out by a lock.
  var nClutter = scanning ? 22 : (bad ? Math.round(22 + (RADAR_CLUTTER - 22) * 0.5 * easeOutCubic(seg(rt, 0, 400))) : 22)
  var clutterGain = ok ? 1 - easeOutCubic(seg(rt, 100, 500)) : (bad ? 1.2 : 1)
  if (!compact && clutterGain > 0.01) {
    for (var ci = 0; ci < nClutter; ci++) {
      var base = hash(ci * 7.3 + 1) * TAU
      var cg = ageOf(base)
      var cvis = visible(cg.f)
      if (cvis <= 0 || hash(cg.c * 11 + ci * 2) < 0.45) continue
      var cr = (0.12 + 0.86 * hash(cg.c * 17 + ci * 3)) * R
      var cphi = base + (hash(cg.c * 5 + ci) - 0.5) * 0.2
      var cfresh = Math.exp(-cg.f * 4)
      crisp.arc(tint, 0.28 * clutterGain * (0.15 + 0.85 * cfresh) * cvis, Math.max(1, size * 0.012),
        cx, cy, cr, cphi - 0.04, cphi + 0.04)
    }
  }
  flush()

  // --- target brackets and lock symbology -------------------------------------------
  if (!compact) {
    // Trackers on three asymmetric landmarks: never a pair where eyes sit.
    // Face box: hunting while scanning, seated with an overshoot on a lock,
    // blown apart on a miss.
    var snap = ok ? easeOutBack(seg(rt, 350, 560)) : 0
    var boxH = R * mix(0.76 + 0.03 * Math.sin(t / 700), 0.68, snap)
    var jx = scanning ? Math.sin(t / 310) * R * 0.015 : 0
    var jy = scanning ? Math.cos(t / 370) * R * 0.012 : 0
    var boxA = (scanning ? 0.4 + 0.15 * Math.sin(t / 250) : (ok ? 0.5 + 0.5 * seg(rt, 350, 500) : 0.7)) * boot
    if (bad) {
      var blow = easeOutCubic(seg(rt, 60, 700))
      for (var bc = 0; bc < 4; bc++) {
        var sx = bc % 2 ? 1 : -1, sy = bc < 2 ? -1 : 1
        var fly = dragOffset(0.6, Math.max(0, rt - 60) / 1000, 3) * R
        var bxp = cx + sx * (boxH + fly * 0.7), byp = cy + sy * (boxH + fly * 0.7)
        var rot = blow * 0.6 * (bc % 2 ? 1 : -1)
        var L0 = R * 0.16 * (1 - 0.5 * blow)
        crisp.poly(ROLE_ERROR, 0.8 * (1 - blow * 0.8), hair, [
          [bxp - sx * L0 * Math.cos(rot), byp + L0 * Math.sin(rot) * sy],
          [bxp, byp],
          [bxp - L0 * Math.sin(rot) * sx, byp - sy * L0 * Math.cos(rot)]
        ])
      }
    } else {
      bracketBox(crisp, tint, boxA, hair, cx + jx, cy + jy, boxH, R * mix(0.16, 0.22, snap))
      if (ok && snap > 0) bracketBox(halo, tint, 0.2 * snap, thin * 3, cx, cy, boxH, R * 0.22)
    }
    // Analysis markers: seated by the arm's pass over each region.
    faceMarkers(halo, crisp, {
      proj: function (X, Y, Z) { return { x: cx + X * RADAR_FACE * R, y: cy + Y * RADAR_FACE * R, v: 1 } },
      pass: function (X, Y, q) {
        var ag2 = ageOf(Math.atan2(Y, X))
        return visible(ag2.f) * boot > 0.5 ? ag2.f * 1.4 : -0.1
      },
      post: function (q) { return bad ? { x: q.x + tearShift(tears, (q.y - cy) / R) * R, y: q.y, v: q.v } : q },
      tint: tint, U: R * RADAR_FACE, gain: boot, labels: labels, clock: t, cx: cx,
      wLine: fine * 1.4, wMark: fine * 1.4
    })
    // Centre reticle, turning.
    var cRot = t / 1500 + (ok ? 2 * easeInOutCubic(seg(rt, 0, 700)) : 0)
    for (var cd = 0; cd < 12; cd++) {
      var cda = cRot + cd * TAU / 12
      crisp.arc(tint, 0.45 * boot, fine, cx, cy, R * 0.11, cda, cda + 0.26)
    }
    crisp.flush()
  }

  if (ok || bad) {
    var chevK = ok ? easeOutBack(seg(rt, 380, 620)) : easeOutCubic(seg(rt, 0, 260))
    var drift = bad ? easeOutCubic(seg(rt, 260, 760)) : 0
    // A miss brings the chevrons in, but they hunt instead of seating and
    // fade out inside the scope, clear of the corner readouts.
    var chevR = ok ? mix(1.35, 0.93, chevK) : mix(1.35, 0.95, chevK) + 0.04 * Math.sin(rt / 37) * (1 - drift)
    var chevA = ok ? clamp01(chevK * 1.5) : clamp01(chevK * 1.5) * (1 - drift)
    for (var cq = 0; cq < 4; cq++) {
      var ang = Math.PI / 4 + cq * Math.PI / 2 + drift * 0.45 * (cq % 2 ? 1 : -1)
      chevron(crisp, tint, chevA, thin, cx, cy, ang, R * chevR, R * 0.07, 0.09)
    }
    for (var pi2 = 0; pi2 < pings.length; pi2++) {
      var pb = bump(rt, pings[pi2][0], pings[pi2][1])
      if (pb <= 0.01) continue
      var pk2 = easeOutCubic(seg(rt, pings[pi2][0], pings[pi2][1]))
      glowArc(halo, crisp, tint, pb * (ok ? 0.55 : 0.6), Math.max(1, size * 0.012 * (1 - pk2 * 0.6)), cx, cy, R * mix(0.05, 1.05, pk2), 0, TAU)
    }
    if (ok) {
      var tk = easeOutBack(seg(rt, 480, 680))
      if (tk > 0) {
        var ts = R * mix(0.12, 0.05, tk)
        crisp.poly(tint, clamp01(tk * 2), thin, [[cx, cy - ts], [cx + ts, cy], [cx, cy + ts], [cx - ts, cy], [cx, cy - ts]])
      }
    } else {
      drawTears(crisp, tears, cx, cy, R)
    }
    flush()
  }

  crisp.arc(tint, 0.8 * boot, thin, cx, cy, R * 0.022, 0, TAU)
  crisp.flush()

  if (hud) paintRadarReadouts(crisp, size, state, t, rt, boot, tint, arm, R_ret, ageOf)
  crisp.flush()
}

function paintRadarReadouts(p, size, state, t, rt, boot, tint, arm, returns, ageOf) {
  var bad = state === "notRecognized"
  var g = readoutGeom(size, boot)
  var fine = Math.max(0.5, size * 0.0038)

  // Top left: arm bearing in degrees. It spins with the lock and scrambles
  // on a miss.
  var deg = frac((arm + Math.PI / 2) / TAU) * 360
  if (bad && rt < 300) deg = hash(Math.floor(rt / 40)) * 359
  readTopLeft(p, g, size, t, bad ? ROLE_ERROR : ROLE_INK, " " + pad3(deg))

  readConfidence(p, g, size, state, t, rt, tint)

  // Bottom left: A-scope. Return amplitude against range along the arm, over
  // a fine grid.
  var x0 = g.m
  var wA = size * 0.23
  var hA = size * 0.075
  var yb = g.base
  for (var gx = 0; gx <= 6; gx++) p.line(FG3, 0.1 * boot, fine, x0 + wA * gx / 6, yb, x0 + wA * gx / 6, yb - hA)
  for (var gy = 1; gy <= 2; gy++) p.line(FG3, 0.1 * boot, fine, x0, yb - hA * gy / 3, x0 + wA, yb - hA * gy / 3)
  p.line(ROLE_FG, 0.22 * boot, g.hair, x0, yb, x0 + wA, yb)
  var n = 48
  var noiseStep = Math.floor(t / 50)
  var pts = []
  for (var s = 0; s <= n; s++) {
    var rr = s / n
    var amp = 0.05 + 0.06 * hash(noiseStep * 31 + s) * (bad ? 2.2 : 1)
    for (var i = 0; i < returns.length; i++) {
      var q = returns[i]
      var d = Math.atan2(Math.sin(q.a - arm), Math.cos(q.a - arm))
      if (Math.abs(d) > 0.14) continue
      var dr = (rr - q.r) / 0.035
      amp += q.gain * 0.7 * Math.exp(-dr * dr) * (1 - Math.abs(d) / 0.14)
    }
    pts.push([x0 + rr * wA, yb - Math.min(1, amp) * hA * boot])
  }
  p.poly(bad ? ROLE_ERROR : tint, 0.9 * boot, g.hair, pts)

  readStatus(p, g, size, state, t, rt, tint)
  readoutDetail(p, g, size, state, t, rt, tint)
}

// --- Holographic Wireframe ---------------------------------------------------
//
// A projected head, built in layers: structured-light slices round a whole
// head and neck in true perspective, lit from the upper left, with the
// silhouette traced from the slices and a rim light where the surface turns
// away. Over it, a vertex point cloud; outside it, a cage turning the other
// way and two tilted orbit rings. It rises from an emitter through projection
// beams and a volumetric cone, and turns far enough that the brow, nose and
// jaw show in the slices and the skull behind them shows in the outline.

// The projected rig is drawn a little under the disc radius so the crown
// clears the corner readouts.
var HOLO_K = 0.86
var HOLO_F = 3.4
var HOLO_BAND_MS = 2300
var HOLO_SLICES = 26

// --- the face -------------------------------------------------------------------
//
// One head, shared by every style: a generic anonymous volume seen from the
// front. The styles project it their own way (dots, radar returns, a
// wireframe head). Depth is a broad shallow relief (forehead, brow, nose
// ridge, cheeks, chin). Nothing here is an eye, nose, mouth, lip or jaw
// outline.
//
// Face units: x to the right, y down. EYE_Y is the vertical centre the depth
// falloff is measured from, not a drawn eye line.

var FACE_TOP = -0.8
var FACE_CHIN = 0.685
var EYE_Y = -0.06
var FACE_C = 0.5

// The right half of the outline, crown to chin: cranium, temple, the
// cheekbone, the jaw angle, a squared chin.
var FACE_Y = [-0.80, -0.78, -0.725, -0.64, -0.53, -0.40, -0.26, -0.12, 0.02, 0.14, 0.26, 0.38, 0.50, 0.595, 0.655, 0.685]
var FACE_X = [0.0, 0.13, 0.25, 0.35, 0.425, 0.465, 0.487, 0.495, 0.49, 0.47, 0.44, 0.40, 0.31, 0.205, 0.105, 0.0]

function faceHalfW(y) {
  if (y <= FACE_TOP || y >= FACE_CHIN) return 0
  return Math.max(0, profileAt(FACE_Y, FACE_X, y))
}

// 1 at the middle of the face, 0 on its outline and beyond.
function holoInside(x, y) {
  var w = faceHalfW(y)
  if (w <= 0.004) return 0
  var k = x / w
  return 1 - k * k
}

function gauss(dx, sx, dy, sy) { return Math.exp(-((dx / sx) * (dx / sx) + (dy / sy) * (dy / sy))) }

// The depth of a generic head over the dome: a soft forehead, a broad nose
// ridge, cheeks and a chin. Every style draws from this one surface, and only
// ever as depth: dot density, slice and contour bend, shading. The relief is
// kept broad and shallow so no feature (sockets, lips, a nose line) can be
// read out of it.
function faceRelief(x, y) {
  var ax = Math.abs(x)
  var forehead = 0.03 * gauss(x, 0.3, y + 0.46, 0.18)
  var brow = 0.022 * gauss(ax - 0.2, 0.26, y + 0.2, 0.07)
  var ridge = 0.085 * gauss(x, 0.085, y - 0.02, 0.2)
  var tip = 0.04 * gauss(x, 0.08, y - 0.15, 0.07)
  var cheek = 0.045 * gauss(ax - 0.3, 0.16, y - 0.04, 0.16)
  var chin = 0.04 * gauss(x, 0.15, y - 0.56, 0.09)
  return forehead + brow + ridge + tip + cheek + chin
}

function holoZAt(x, y) {
  var ins = holoInside(x, y)
  if (ins <= 0) return 0
  var v = (y - EYE_Y) / 0.75
  var fall = Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(v), 4)))
  return FACE_C * Math.sqrt(ins) * fall + faceRelief(x, y)
}

// The radar was tuned on a plainer surface; the face now has one surface.
function classicZAt(x, y) { return holoZAt(x, y) }

// The head turns far enough, about 45 degrees, that the nose leaves the
// cheek line and the skull shows behind the face: a turning profile is what
// reads as a person rather than an egg.
function holoYaw(t) { return 0.76 * Math.sin(t / 6400 * TAU) + 0.04 * Math.sin(t / 1900 * TAU) }
// The camera sits a little above the head, so the slices bend with the
// relief even face-on.
var HOLO_TILT = -0.18

function holoPitch(t) { return HOLO_TILT + 0.08 * Math.sin(t / 8100 * TAU + 0.7) }

// --- the projected head ---------------------------------------------------------
//
// A whole head, not a mask: lofted between a side profile (front and back of
// the skull) and a front profile (its half width), sampled from crown to
// chin. At each height the cross-section is a squared-off ellipse from face
// to nape, with the face's relief laid on its front and the ears on its
// sides. A cranium that runs back behind the face, a jaw, ears and a neck are
// what make it read as a person when it turns; a symmetric shell reads as an
// egg.
var HEAD_Y = [-0.78, -0.72, -0.6, -0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.42, 0.52, 0.6, 0.66]
var HEAD_FRONT = [-0.08, 0.14, 0.3, 0.4, 0.45, 0.43, 0.44, 0.45, 0.44, 0.41, 0.39, 0.34, 0.18]
var HEAD_BACK = [-0.08, -0.34, -0.52, -0.62, -0.64, -0.6, -0.52, -0.42, -0.32, -0.24, -0.18, -0.14, -0.1]
var HEAD_HALF = [0, 0.28, 0.44, 0.52, 0.55, 0.55, 0.54, 0.5, 0.44, 0.37, 0.29, 0.2, 0.08]
var HEAD_TOP = -0.78
var HEAD_CHIN = 0.66
var NECK_TOP = 0.56
var NECK_BASE = 1.0

function profileAt(ys, vs, y) {
  var n = ys.length
  if (y <= ys[0]) return vs[0]
  if (y >= ys[n - 1]) return vs[n - 1]
  var i = 0
  while (i < n - 2 && y > ys[i + 1]) i++
  var k = (y - ys[i]) / (ys[i + 1] - ys[i])
  var p0 = vs[Math.max(0, i - 1)], p1 = vs[i], p2 = vs[i + 1], p3 = vs[Math.min(n - 1, i + 2)]
  var k2 = k * k, k3 = k2 * k
  return 0.5 * (2 * p1 + (p2 - p0) * k + (2 * p0 - 5 * p1 + 4 * p2 - p3) * k2 + (3 * p1 - p0 - 3 * p2 + p3) * k3)
}

// The face on the front of the head: brow ridge, eye sockets, the nose from
// bridge to tip, cheekbones, lips and chin. It only ever shows as the way the
// slices bend and shade, never as drawn features.
function headRelief(x, y) { return faceRelief(x, y) }

function sgnPow(a, p) { return a < 0 ? -Math.pow(-a, p) : Math.pow(a, p) }

// A point on the head at bearing u (0 faces the viewer) and height y.
function headPoint(u, y) {
  var F = profileAt(HEAD_Y, HEAD_FRONT, y)
  var B = profileAt(HEAD_Y, HEAD_BACK, y)
  var W = Math.max(0, profileAt(HEAD_Y, HEAD_HALF, y))
  var su = Math.sin(u), cu = Math.cos(u)
  var ear = 0.11 * Math.exp(-(((Math.abs(u) - 1.72) / 0.22) * ((Math.abs(u) - 1.72) / 0.22) + ((y + 0.06) / 0.12) * ((y + 0.06) / 0.12)))
  var x = W * sgnPow(su, 0.78) * (1 + ear)
  var z = (F + B) / 2 + (F - B) / 2 * sgnPow(cu, 0.85)
  var front = Math.max(0, cu)
  z += headRelief(x, y) * front * front
  return [x, y, z]
}

// The neck, a flared cylinder set back under the jaw, down to the emitter.
function neckPoint(u, y) {
  var k = clamp01((y - NECK_TOP) / (NECK_BASE - NECK_TOP))
  var flare = 1 + 0.3 * k * k * k
  return [Math.sin(u) * 0.19 * flare, y, -0.1 + Math.cos(u) * 0.17 * flare]
}

// A vertex with its outward normal and a slope shade under a light from the
// upper left: [x, y, z, nx, ny, nz, shade].
function headVertex(fn, u, y) {
  var P = fn(u, y)
  var e = 0.004
  var Pu = fn(u + e, y), Pv = fn(u, y + e)
  var ux = Pu[0] - P[0], uy = Pu[1] - P[1], uz = Pu[2] - P[2]
  var vx = Pv[0] - P[0], vy = Pv[1] - P[1], vz = Pv[2] - P[2]
  var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
  var nl = Math.hypot(nx, ny, nz) || 1
  nx /= nl; ny /= nl; nz /= nl
  if (nx * Math.sin(u) + nz * Math.cos(u) < 0) { nx = -nx; ny = -ny; nz = -nz }
  var shade = clamp01(0.45 + 1.5 * (nx * -0.45 + ny * -0.55 + nz * 0.7 - 0.55))
  return [P[0], P[1], P[2], nx, ny, nz, shade]
}

// Bearings round the head, packed densest at the face so the nose and the
// sockets resolve, sparse round the back.
function headBearing(s) { return Math.PI * s * (0.42 + 0.58 * s * s) }

// The head's surface vertex under a point of the flat face model, nudged out
// along its normal so lines sit on the skin rather than inside it.
function headFaceVertex(X, Y, lift) {
  var W = Math.max(0.05, profileAt(HEAD_Y, HEAD_HALF, Y))
  var su = clamp(X / W, -0.999, 0.999)
  su = su < 0 ? -Math.pow(-su, 1 / 0.78) : Math.pow(su, 1 / 0.78)
  var V = headVertex(headPoint, Math.asin(clamp(su, -1, 1)), Y)
  return [V[0] + V[3] * lift, V[1] + V[4] * lift, V[2] + V[5] * lift, V[3], V[4], V[5], V[6]]
}

function holoMesh(compact) {
  var key = compact ? "headC" : "head"
  if (CACHE[key]) return CACHE[key]
  var lines = []
  // Structured light: dense horizontal slices round the whole head, then a
  // few meridians and the neck to hold them together. Slices come first.
  var nLat = compact ? 9 : HOLO_SLICES
  var nU = compact ? 22 : 40
  var nLon = compact ? 6 : 10
  var i, j, pts
  for (i = 0; i < nLat; i++) {
    var y = mix(HEAD_TOP + 0.05, HEAD_CHIN - 0.03, i / (nLat - 1))
    pts = []
    for (j = 0; j <= nU; j++) pts.push(headVertex(headPoint, headBearing(mix(-1, 1, j / nU)), y))
    lines.push(pts)
  }
  for (i = 0; i < nLon; i++) {
    var u = (i + 0.5) / nLon * TAU - Math.PI
    pts = []
    for (j = 0; j <= (compact ? 12 : 24); j++) pts.push(headVertex(headPoint, u, mix(HEAD_TOP + 0.01, HEAD_CHIN, j / (compact ? 12 : 24))))
    lines.push(pts)
  }
  var nRings = compact ? 2 : 4
  for (i = 0; i < nRings; i++) {
    var ny = mix(NECK_TOP + 0.08, NECK_BASE, i / (nRings - 1))
    pts = []
    for (j = 0; j <= 24; j++) pts.push(headVertex(neckPoint, j / 24 * TAU - Math.PI, ny))
    lines.push(pts)
  }
  for (i = 0; i < (compact ? 4 : 8); i++) {
    var nu = (i + 0.5) / (compact ? 4 : 8) * TAU - Math.PI
    pts = []
    for (j = 0; j <= 6; j++) pts.push(headVertex(neckPoint, nu, mix(NECK_TOP + 0.04, NECK_BASE, j / 6)))
    lines.push(pts)
  }
  CACHE[key] = lines
  return lines
}

// The vertex cloud: a jittered lattice over the face and the sides of the
// head. Points facing away are dropped per frame.
function holoPoints() {
  if (CACHE.headP) return CACHE.headP
  var rnd = mulberry32(777)
  var pts = []
  for (var i = 0; i < 22; i++) {
    for (var j = 0; j < 26; j++) {
      var u = headBearing(mix(-0.8, 0.8, (j + rnd() * 0.7) / 25.7))
      var y = mix(HEAD_TOP + 0.08, HEAD_CHIN - 0.04, (i + rnd() * 0.7) / 21.7)
      pts.push({ P: headVertex(headPoint, u, y), j: rnd(), k: rnd() })
    }
  }
  CACHE.headP = pts
  return pts
}

// Iso-depth contours of the relief, by marching squares. Static geometry in
// face space; the pose is applied per frame. `skipSockets` drops the closed loops
// the eye sockets make (concentric loops there read as eyes); `skipNose`
// drops the nose, whose nested teardrop reads as something else entirely.
function reliefContours(key, nx, ny, levels, skipSockets, zfn, skipNose) {
  var zf = zfn || holoZAt
  if (CACHE[key]) return CACHE[key]
  var x0 = -0.64, x1 = 0.64, y0 = -0.82, y1 = 0.82
  var grid = []
  for (var j = 0; j <= ny; j++) {
    var row = []
    for (var i = 0; i <= nx; i++) {
      var x = mix(x0, x1, i / nx), y = mix(y0, y1, j / ny)
      row.push(holoInside(x, y) > 0 ? zf(x, y) : -1)
    }
    grid.push(row)
  }
  var segs = []
  function lerp(a, b, va, vb, L) { return a + (b - a) * ((L - va) / (vb - va)) }
  function socket(x, y) {
    var ex = Math.abs(x) - 0.25
    return Math.exp(-((ex / 0.13) * (ex / 0.13) + ((y + 0.18) / 0.09) * ((y + 0.18) / 0.09)))
  }
  for (var li = 0; li < levels.length; li++) {
    var L = levels[li]
    for (var cj = 0; cj < ny; cj++) {
      for (var ci = 0; ci < nx; ci++) {
        var xa = mix(x0, x1, ci / nx), xb = mix(x0, x1, (ci + 1) / nx)
        var ya = mix(y0, y1, cj / ny), yb = mix(y0, y1, (cj + 1) / ny)
        var mxc = (xa + xb) / 2, myc = (ya + yb) / 2
        if (skipSockets && socket(mxc, myc) > (skipSockets === true ? 0.3 : skipSockets)) continue
        if (skipNose && Math.abs(mxc) < 0.13 && myc > -0.2 && myc < 0.26) continue
        var v00 = grid[cj][ci], v10 = grid[cj][ci + 1], v01 = grid[cj + 1][ci], v11 = grid[cj + 1][ci + 1]
        var pts = []
        if ((v00 < L) !== (v10 < L)) pts.push([lerp(xa, xb, v00, v10, L), ya])
        if ((v10 < L) !== (v11 < L)) pts.push([xb, lerp(ya, yb, v10, v11, L)])
        if ((v01 < L) !== (v11 < L)) pts.push([lerp(xa, xb, v01, v11, L), yb])
        if ((v00 < L) !== (v01 < L)) pts.push([xa, lerp(ya, yb, v00, v01, L)])
        if (pts.length >= 2) segs.push([pts[0][0], pts[0][1], pts[1][0], pts[1][1], L + 0.004, li])
        if (pts.length === 4) segs.push([pts[2][0], pts[2][1], pts[3][0], pts[3][1], L + 0.004, li])
      }
    }
  }
  CACHE[key] = { segs: segs, levels: levels.length }
  return CACHE[key]
}

// Solver nodes: a jittered lattice of surface points the lock resolves in a
// wave from the nose outward. Deliberately not the landmark set: a lock
// diamond in each eye socket reads as pupils.
function holoNodes() {
  if (CACHE.headN) return CACHE.headN
  // A scatter of tracking points on a low-discrepancy sequence: even
  // coverage with no rows or pairs, because rows of points on a curved mask
  // bow into mouths and pairs of them become eyes.
  function halton(i, b) {
    var f = 1, r = 0
    while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b) }
    return r
  }
  var nodes = []
  for (var i = 1; i <= 44; i++) {
    var u = headBearing(mix(-0.72, 0.72, halton(i, 2)))
    var y = mix(HEAD_TOP + 0.14, HEAD_CHIN - 0.08, halton(i, 3))
    var P = headVertex(headPoint, u, y)
    nodes.push({ P: P, order: Math.hypot(P[0], P[1] - 0.05) * 6 + hash(i * 13) })
  }
  CACHE.headN = { nodes: nodes, edges: [] }
  return CACHE.headN
}

// --- the projector --------------------------------------------------------------
//
// Where the head stands: an emitter plate under the neck, in screen units of
// the disc radius.
var HOLO_EY = 0.9
var HOLO_ERX = 0.46
var HOLO_ERY = 0.07
// The crown of the projected head, on screen.
var HOLO_CROWN = HOLO_CY + (-0.78) * HOLO_K
// A lock lands over 1.15 s of authored time. The sequence, in ms:
//   20..430    an energy pulse races up from the emitter to the crown
//   340..900   a solidify ring sweeps back down, and the head hardens behind it
//   200..640   the orbits level out into a halo, which snaps shut on PASS
//   860..1150  a ripple leaves the emitter across the plate
// After that the head rests: solid, rim lit, slowly scanned.
var HOLO_WAVE = [860, 1150]
var HOLO_HALO_Y = 0.34

// A polyline whose segments carry their own alpha and width. A run ends where
// either changes, so a gradient along a slice costs a few extra subpaths and
// the front of the head can be drawn heavier than its back.
function holoStrip(p, role, pts, al, wd) {
  var run = null
  var runA = -1
  var runW = -1
  for (var i = 1; i < pts.length; i++) {
    var a = Math.round(clamp01(al[i - 1]) * 16) / 16
    var w = wd[i - 1]
    if (a !== runA || w !== runW) {
      if (run && run.length > 1 && runA > 0) p.poly(role, runA, runW, run)
      run = [[pts[i - 1].x, pts[i - 1].y]]
      runA = a
      runW = w
    }
    run.push([pts[i].x, pts[i].y])
  }
  if (run && run.length > 1 && runA > 0) p.poly(role, runA, runW, run)
}

// A closed ellipse as points, for the rings round the emitter and the cone.
function holoEllipse(x, y, rx, ry, n) {
  var out = []
  for (var i = 0; i <= n; i++) {
    var a = i / n * TAU
    out.push([x + Math.cos(a) * rx, y + Math.sin(a) * ry])
  }
  return out
}

// The projector's power through a miss: it browns out, sputters between
// nothing and a flicker, and settles at a low idle that still drops out now
// and then. Never zero for long: the head must stay legible.
function holoPower(rt) {
  var p = mix(1, 0.5, easeOutCubic(seg(rt, 60, 760)))
  if (rt > 90 && rt < 560) {
    var h = hash(Math.floor(rt / 46) + 31)
    if (h > 0.62) p *= 0.2
    else if (h < 0.1) p = Math.min(1, p * 1.5)
  } else if (rt >= 560 && hash(Math.floor(rt / 90) + 57) > 0.9) {
    p *= 0.45
  }
  return p
}

function paintHolo(ctx, size, spec) {
  var state = spec.state || "scanning"
  var t = spec.clock || 0
  var rt = spec.elapsed || 0
  var compact = size < 76
  var micro = size < 48
  var hud = size >= 100

  var cx = size / 2
  var cy = size / 2
  var R = size * 0.45

  ctx.reset()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var scanning = !ok && !bad
  var tint = bad ? missTint(rt) : ROLE_ACCENT
  TINT = tint
  var t0 = t - rt

  var hair = Math.max(1, size * 0.0065)
  var thin = Math.max(1, size * 0.009)
  var bold = Math.max(1, size * 0.016)
  var fine = Math.max(0.5, size * 0.0038)

  // --- the boot: the emitter ignites, the cone rises, and the head is built
  // slice by slice from the neck up behind a bright front.
  var bootK = scanning ? seg(rt, 0, BOOT_MS) : 1
  var boot = easeOutCubic(bootK)
  var buildK = seg(rt, 130, 600)
  var buildY = bootK < 1 ? mix(1.08, -0.9, buildK * buildK * (3 - 2 * buildK)) : -9
  var bootGate = scanning ? clamp01((bootK - 0.35) / 0.65) : 1
  var ignite = scanning ? seg(rt, 0, 150) : 1
  var coneUp = scanning ? easeOutCubic(seg(rt, 40, 420)) : 1

  // --- a lock, in authored milliseconds
  var restK = ok ? seg(rt, 640, 1000) : 0
  var pulseT = ok ? easeInOutCubic(seg(rt, 20, 430)) : 0
  var pulseOn = ok && rt > 20 && rt < 470
  var pulseY = mix(HOLO_EY - 0.04, HOLO_CROWN, pulseT)
  var crownK = ok ? bump(rt, 380, 820) : 0
  var ringT = ok ? easeInOutCubic(seg(rt, 340, 900)) : 0
  var ringOn = ok && rt > 340 && rt < 960
  var ringY = mix(HOLO_CROWN, HOLO_EY - 0.08, ringT)
  var solidFront = ok && rt >= 340 ? ringY : -9
  var passFlash = ok ? bump(rt, REC_PASS - 40, REC_PASS + 420) : 0
  var passPulse = ok && LUMEN ? bump(rt, REC_PASS - 80, REC_PASS + 420) : 0

  // Pose: slow turn, eased to a three-quarter view by a lock, jerked by a miss.
  var yaw = holoYaw(t)
  var pitch = holoPitch(t)
  if (ok) {
    // The lock settles in a three-quarter pose, which shows the relief in
    // the silhouette instead of flattening it face-on, and then breathes.
    var still = easeOutCubic(seg(rt, 0, 450))
    yaw = mix(holoYaw(t0 + rt * (1 - still)), 0.5, still) + restK * 0.04 * Math.sin(t / 1300)
    pitch = mix(holoPitch(t0 + rt * (1 - still)), HOLO_TILT, still) + restK * 0.012 * Math.sin(t / 1900 + 1)
  } else if (bad) {
    var jstep = Math.min(6, Math.floor(rt / 55))
    yaw = holoYaw(t0 + rt * 0.2) + (jstep > 0 ? (hash(jstep * 7 + 3) - 0.5) * 0.35 : 0)
    pitch = holoPitch(t0 + rt * 0.2) + (jstep > 0 ? (hash(jstep * 5 + 1) - 0.5) * 0.12 : 0)
  }
  var cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), spp = Math.sin(pitch)

  // Projector power and flicker. Steady on a lock; a brownout on a miss.
  var power = bad ? holoPower(rt) : 1
  var flickRaw = 0.9 + 0.1 * Math.sin(t / 41) * Math.sin(t / 97)
  if (hash(Math.floor(t / 140)) > 0.93) flickRaw *= 0.7
  if (ok) flickRaw = mix(flickRaw, 1, seg(rt, 0, 300))
  if (bad) flickRaw *= 0.55 + 0.45 * power
  if (bootK < 1 && hash(Math.floor(rt / 36) + 3) > 0.55) flickRaw *= 1 - 0.5 * (1 - bootK)
  var flick = flickRaw * boot

  // Scan planes. The main one sweeps down through the head; a second, faster
  // one crosses it the other way. A lock slows the scan to a drift.
  var bandY = mix(-1.1, 1.1, frac(t / (ok ? 4200 : HOLO_BAND_MS)))
  var band2Y = mix(1.1, -1.1, frac(t / 3100 + 0.3))
  var bandK = scanning ? 1 : (ok ? (1 - seg(rt, 0, 300)) + 0.4 * restK : 0.6 * (1 - seg(rt, 100, 520)))
  var band2K = scanning ? 1 : (ok ? 0 : bandK)

  // The failing projection: slices slip sideways as rigid strips, blocks of
  // the image shear, the vertical hold rolls, and the picture splits into
  // two colours.
  var failK = bad ? seg(rt, 0, 90) : 0
  var slipStep = bad ? (rt < 500 ? Math.floor(rt / 55) : 9 + Math.floor((rt - 500) / 140)) : 0
  var burst = bad && rt > 600 && frac(t / 760) < 0.16 && hash(Math.floor(t / 760) + 9) > 0.35 ? 1 : 0
  var slipAmp = bad ? 0.085 * failK * (1 - 0.78 * easeOutCubic(seg(rt, 300, 900))) + 0.05 * burst : 0
  var nSl = compact ? 9 : HOLO_SLICES
  var slipY0 = HEAD_TOP + 0.05
  var slipDy = (HEAD_CHIN - 0.03 - slipY0) / (nSl - 1)
  function slipVal(k) {
    var h1 = hash(slipStep * 13 + k * 7 + 1), h2 = hash(slipStep * 5 + k * 3 + 2)
    return (h1 - 0.5) * 2 * slipAmp * (h2 > 0.28 ? 1 : 0.15)
  }
  function slipField(hy) {
    if (slipAmp <= 0) return 0
    var k = (hy - slipY0) / slipDy
    var lo = Math.floor(k)
    return mix(slipVal(lo), slipVal(lo + 1), k - lo)
  }
  var tears = bad ? glitchTears(rt) : []
  var roll = 0
  var rollPh = frac(t / 2600)
  if (scanning && hash(Math.floor(t / 2600) + 5) > 0.55 && rollPh < 0.05) roll = 0.1 * Math.sin(Math.PI * rollPh / 0.05)
  if (bad && rt > 20) roll = 0.2 * Math.exp(-rt / 190) * Math.cos(rt / 52)
  var blocks = []
  var blockOn = bad ? rt < 480 : (scanning && bootK >= 1 && hash(Math.floor(t / 200) + 11) > 0.93)
  if (blockOn) {
    var bs = Math.floor((bad ? rt : t) / 50)
    for (var bi = 0; bi < (bad ? 5 : 2); bi++) {
      blocks.push({
        y: (hash(bs * 7 + bi) * 2 - 1) * 0.9, h: 0.04 + 0.1 * hash(bs * 3 + bi),
        x: (hash(bs * 5 + bi * 2) * 2 - 1) * 0.7, w: 0.2 + 0.4 * hash(bs * 13 + bi),
        dx: (hash(bs * 11 + bi) - 0.5) * (bad ? 0.3 : 0.12)
      })
    }
  }
  function blockShift(x, y) {
    var d = 0
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i]
      if (y > b.y && y < b.y + b.h && x > b.x && x < b.x + b.w) d += b.dx
    }
    return d
  }
  function glitchX(x, y) {
    return (bad ? tearShift(tears, y) : 0) + blockShift(x, y)
  }

  // Chromatic offset: copies of the image off register. It closes on a lock
  // and tears wide on a miss.
  var chroma = (scanning ? boot : (ok ? 1 - seg(rt, 0, 300) : 1 + 3 * bump(rt, 0, 600) + 0.6 * burst))
  var chX = size * 0.013 * chroma * (bad ? 1 + (hash(Math.floor(rt / 40)) - 0.5) : 1)
  var chY = -size * 0.003 * chroma

  function project(P) {
    var xr = P[0] * cyw + P[2] * syw
    var zr = -P[0] * syw + P[2] * cyw
    var yr = P[1] * cp - zr * spp
    var z2 = P[1] * spp + zr * cp
    var s = HOLO_F / (HOLO_F - z2)
    // How squarely the surface faces the camera, where the vertex has a normal.
    var f = 1
    if (P.length > 5) {
      var nxr = P[3] * cyw + P[5] * syw
      var nzr = -P[3] * syw + P[5] * cyw
      var nyr = P[4] * cp - nzr * spp
      var nz2 = P[4] * spp + nzr * cp
      var vl = Math.hypot(xr, yr, HOLO_F - z2)
      f = (-nxr * xr - nyr * yr + nz2 * (HOLO_F - z2)) / vl
    }
    return { x: xr * s * HOLO_K, y: yr * s * HOLO_K + HOLO_CY + roll, z: z2, f: f }
  }
  // Projected half width of the head (or the neck) at height y, and the
  // offset of its centre, for the rings and beams that wrap it.
  function headSpan(y) {
    var fy = (y - HOLO_CY) / HOLO_K
    if (fy > HEAD_CHIN) return { w: HOLO_K * (0.19 * Math.abs(cyw) + 0.17 * Math.abs(syw)), c: -0.1 * syw * HOLO_K }
    var F = profileAt(HEAD_Y, HEAD_FRONT, fy), B = profileAt(HEAD_Y, HEAD_BACK, fy)
    var W = Math.max(0.05, profileAt(HEAD_Y, HEAD_HALF, fy))
    return { w: HOLO_K * Math.hypot(W * cyw, (F - B) / 2 * syw), c: HOLO_K * (F + B) / 2 * syw }
  }
  // The same, widened below the neck into the emitter plate.
  function bodySpan(y) {
    var baseY = HOLO_CY + NECK_BASE * HOLO_K
    if (y <= baseY) {
      var hs = headSpan(y)
      return { w: Math.max(0.1, hs.w), c: hs.c }
    }
    var ns = headSpan(baseY)
    var k = easeInOutCubic(clamp01((y - baseY) / (HOLO_EY - baseY)))
    return { w: mix(ns.w, HOLO_ERX, k), c: mix(ns.c, 0, k) }
  }
  function toPx(x, y) { return { x: cx + x * R, y: cy + y * R } }
  // A lens that rides each plane: the slices bunch up toward it, which is
  // what makes it read as light refracted through glass.
  function lensY(y) {
    var d1 = y - bandY
    var out = 0
    if (bandK > 0 && Math.abs(d1) < 0.2) out -= 0.022 * bandK * Math.sin(Math.PI * d1 / 0.2)
    var d2 = y - band2Y
    if (band2K > 0 && Math.abs(d2) < 0.1) out -= 0.012 * band2K * Math.sin(Math.PI * d2 / 0.1)
    return y + out
  }
  function tri(d, w) { var k = 1 - Math.abs(d) / w; return k > 0 ? k * k : 0 }
  function bandBoost(y) {
    var a = 0
    if (bandK > 0) {
      a += 0.5 * tri(y - bandY, 0.1) * bandK
      // The wake: the scan leaves the head lit above it, fading out.
      var wk = bandY - y
      if (wk > 0 && wk < 1.1) a += 0.13 * Math.exp(-wk / 0.32) * bandK
    }
    if (band2K > 0) a += 0.3 * tri(y - band2Y, 0.05) * band2K
    if (pulseOn) a += 0.8 * tri(y - pulseY, 0.16) * bump(rt, 20, 470)
    if (ringOn) a += 0.6 * tri(y - ringY, 0.12) * bump(rt, 340, 960)
    return a
  }
  // 0 before the solidify ring has passed, 1 behind it.
  function solidAt(y) { return ok ? clamp01((solidFront - y) / 0.08) : 0 }

  var halo = haloPen(ctx)
  var soft = pen(ctx, GLASS ? 3.2 : 1.6, true)
  var crisp = pen(ctx)
  function flush() { halo.flush(); soft.flush(); crisp.flush() }

  if (micro) {
    var mw = Math.max(1, size * 0.07)
    var mrot = ok ? 0 : t / 2200 * TAU
    if (bad) {
      var brk = easeOutCubic(seg(rt, 200, 560))
      for (var mb = 0; mb < 8; mb++) {
        var ma = (mb / 8) * TAU + brk * 0.3 * (mb % 2 ? 1 : -1)
        crisp.arc(tint, 0.9 * (1 - brk * 0.45), mw, cx, cy - R * 0.08, R * (0.72 + brk * 0.12), ma, ma + 0.42)
      }
    } else {
      crisp.arc(tint, ok ? 1 : 0.85, mw, cx, cy - R * 0.08, R * 0.72, 0, TAU)
      for (var ml = 0; ml < 2; ml++) {
        var rx = Math.abs(Math.cos(mrot + ml * Math.PI / 2)) * R * 0.72
        var mpts = []
        for (var mi = 0; mi <= 16; mi++) {
          var aa = mi / 16 * TAU
          mpts.push([cx + Math.cos(aa) * rx, cy - R * 0.08 + Math.sin(aa) * R * 0.72])
        }
        crisp.poly(tint, 0.55, Math.max(1, mw * 0.6), mpts)
      }
    }
    // The slices slide with the turn, which is what reads as a head at 24 px.
    var turn = bad ? 0 : Math.sin(mrot) * R * 0.16
    microStripes(crisp, tint, 0.95, mw * 0.8, cx, cy - R * 0.08, R * 0.9, turn)
    crisp.line(tint, 0.9, mw, cx - R * 0.5, cy + R * 0.86, cx + R * 0.5, cy + R * 0.86)
    if (ok) {
      var mh = bump(rt, 40, 520)
      if (mh > 0.01) crisp.arc(tint, mh * 0.7, Math.max(1, size * 0.04), cx, cy, R * mix(0.84, 1.08, easeOutCubic(seg(rt, 40, 520))), 0, TAU)
    }
    crisp.flush()
    return
  }

  var EY = HOLO_EY
  var erx = HOLO_ERX
  var ery = HOLO_ERY

  // --- backplate: scanlines that drift and beat, and a fine grid ------------------
  if (!compact) {
    plate(crisp, cx, cy, R, boot, 0)
    var lines = 48
    var wraps = Math.floor(t / 5200)
    var drift = frac(t / 5200)
    for (var li = 0; li < lines; li++) {
      var ly = ((li + drift) / lines) * 2 - 1
      var half = Math.sqrt(Math.max(0, 1 - ly * ly))
      if (half <= 0.05) continue
      var major = (((li - wraps) % 4) + 4) % 4 === 0
      // Two slow waves of different pitch run through the lines: interference.
      var beat = 0.62 + 0.38 * Math.sin(ly * 7.5 + t / 1100) * Math.sin(ly * 3.1 - t / 1700)
      crisp.line(ROLE_FG, (major ? 0.1 : 0.055) * boot * beat, major ? hair : fine, cx - half * R, cy + ly * R, cx + half * R, cy + ly * R)
    }
    for (var gv = -4; gv <= 4; gv++) {
      var gx = gv * 0.22
      var gh = Math.sqrt(Math.max(0, 1 - gx * gx))
      crisp.line(ROLE_FG, 0.03 * boot, fine, cx + gx * R, cy - gh * R, cx + gx * R, cy + gh * R)
    }
    var rollL = mix(-1, 1, frac(t / 900))
    var rh = Math.sqrt(Math.max(0, 1 - rollL * rollL))
    crisp.line(tint, 0.12 * flick, hair, cx - rh * R, cy + rollL * R, cx + rh * R, cy + rollL * R)
    // Circular frame with a fine graduated scale.
    crisp.arc(ROLE_FG, 0.16 * boot, fine, cx, cy, R * 1.02, 0, TAU)
    for (var gt = 0; gt < 120; gt++) {
      var ga = gt * TAU / 120
      var goff = Math.abs(((ga % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4)
      if (goff < 0.3) continue
      var gl = R * (gt % 10 === 0 ? 0.05 : (gt % 5 === 0 ? 0.03 : 0.015))
      crisp.line(gt % 10 === 0 ? tint : ROLE_FG, (gt % 10 === 0 ? 0.7 : 0.32) * boot, fine,
        cx + Math.cos(ga) * R * 1.02, cy + Math.sin(ga) * R * 1.02, cx + Math.cos(ga) * (R * 1.02 + gl), cy + Math.sin(ga) * (R * 1.02 + gl))
    }
    // Yaw index riding the frame.
    var yi = -Math.PI / 2 + clamp(yaw * 1.4, -0.45, 0.45)
    chevron(crisp, tint, 0.85 * boot, thin, cx, cy, yi, R * 0.97, R * 0.05, 0.08)
    crisp.flush()
    // Light spill: the projector's glow behind the head, as bloom only.
    if (GLASS) soft.arc(tint, 0.034 * flick * (bad ? 0.7 * power : 1), R * 0.9, cx, cy + R * 0.12, R * 0.45, 0, TAU)
    soft.flush()
  }

  // --- the outer cage, turning against the head ------------------------------------
  if (!compact) {
    var cageRot = t / 9000 * TAU
    if (ok) cageRot = t0 / 9000 * TAU + TAU * 0.6 * easeInOutCubic(seg(rt, 0, 600)) + Math.max(0, rt - 600) / 26000 * TAU
    if (bad) cageRot = t0 / 9000 * TAU + (hash(Math.floor(rt / 50) + 2) - 0.5) * 0.5 * (1 - seg(rt, 400, 700))
    var cageS = ok ? mix(1, 0.9, easeInOutCubic(seg(rt, 300, 750))) : 1
    var cageA = (ok ? 1 - 0.55 * easeInOutCubic(seg(rt, 400, 800)) : (bad ? 0.45 * (0.4 + 0.6 * power) : 1)) * flick * bootGate
    if (cageA > 0.01) {
      var cr = Math.cos(cageRot), sr = Math.sin(cageRot)
      var CA = 0.8 * cageS, CB = 0.98 * cageS
      var cageLine = function (P3list, dashed) {
        var pts = [], al = []
        for (var i = 0; i < P3list.length; i++) {
          var P = P3list[i]
          var X = P[0] * cr + P[2] * sr, Z = -P[0] * sr + P[2] * cr
          var Q = project([X, P[1], Z])
          pts.push(toPx(Q.x + glitchX(Q.x, Q.y), Q.y))
          var front = clamp01((Z + 0.8) / 1.6)
          al.push((0.04 + 0.22 * front * front) * cageA * (dashed && i % 2 ? 0 : 1))
        }
        strip(crisp, LUMEN ? ROLE_FG : tint, fine, pts, al)
      }
      for (var cm = 0; cm < 12; cm++) {
        var ph = cm * TAU / 12
        var mer = []
        for (var cv = 0; cv <= 18; cv++) {
          var vv = mix(-1.35, 1.35, cv / 18)
          mer.push([CA * Math.cos(vv) * Math.sin(ph), CB * Math.sin(vv), CA * Math.cos(vv) * Math.cos(ph)])
        }
        cageLine(mer, bad && power < 0.7)
      }
      for (var cpl = -2; cpl <= 2; cpl++) {
        var pv = cpl * 0.5
        var par = []
        for (var cu = 0; cu <= 36; cu++) {
          var uu = cu / 36 * TAU
          par.push([CA * Math.cos(pv) * Math.sin(uu), CB * Math.sin(pv), CA * Math.cos(pv) * Math.cos(uu)])
        }
        cageLine(par, bad && power < 0.7)
      }
      crisp.flush()
    }
  }

  // --- the emitter ----------------------------------------------------------------------
  var ePulse = 0.5 + 0.5 * Math.sin(t / 420)
  var eFlash = scanning && rt < 360 ? bump(rt, 0, 360) : 0
  var eA = (0.55 + 0.25 * passFlash + 0.55 * eFlash + 0.12 * restK * ePulse) * ignite * power
  var ering = holoEllipse(cx, cy + EY * R, erx * R, ery * R, 32)
  if (bad) {
    // A brownout: the ring loses segments and the rest flicker.
    for (var ed = 0; ed < 32; ed += 2) {
      if (hash(Math.floor(rt / 60) * 3 + ed) > power * 1.1) continue
      crisp.line(tint, eA, thin, ering[ed][0], ering[ed][1], ering[ed + 1][0], ering[ed + 1][1])
    }
  } else {
    soft.poly(tint, eA * 0.2, thin * 3.4, ering)
    crisp.poly(tint, eA, thin, ering)
    if (LUMEN) crisp.poly(hotOf(tint), eA * 0.55, Math.max(0.5, thin * 0.42), ering)
  }
  for (var ec = 1; ec <= 3; ec++) {
    var er = erx * (ec === 1 ? 0.76 + 0.04 * ePulse : (ec === 2 ? 0.5 : 0.26))
    var einner = holoEllipse(cx, cy + EY * R, er * R, ery * er / erx * R, 28)
    crisp.poly(tint, eA * (ec === 1 ? 0.55 : (ec === 2 ? 0.4 : 0.7)), fine, einner)
    if (ec === 3 && !bad) soft.poly(tint, eA * 0.25, thin * 2.4, einner)
  }
  if (!compact) {
    // Ticks turning round the plate, and the spokes of an iris in its middle.
    var etr = t / 3000 * TAU
    for (var et = 0; et < 32; et++) {
      var eta = etr + et * TAU / 32
      if (Math.sin(eta) < -0.2) continue
      if (bad && hash(Math.floor(rt / 70) * 5 + et) > power * 1.1) continue
      crisp.line(tint, eA * 0.6, fine, cx + Math.cos(eta) * erx * R, cy + (EY + Math.sin(eta) * ery) * R,
        cx + Math.cos(eta) * erx * 1.08 * R, cy + (EY + Math.sin(eta) * ery * 1.08) * R)
    }
    for (var ek = 0; ek < 6; ek++) {
      var eka = -etr * 1.7 + ek * TAU / 6
      crisp.line(tint, eA * 0.4, fine, cx + Math.cos(eka) * erx * 0.12 * R, cy + (EY + Math.sin(eka) * ery * 0.12) * R,
        cx + Math.cos(eka) * erx * 0.46 * R, cy + (EY + Math.sin(eka) * ery * 0.46) * R)
    }
    // An anamorphic streak across the plate, brightest at the middle.
    var streakA = (0.2 + 0.4 * eFlash + 0.25 * passFlash + 0.08 * ePulse) * ignite * power * power
    for (var sk2 = 0; sk2 < 7; sk2++) {
      var sx0 = sk2 / 7, sx1 = (sk2 + 1) / 7
      var sa = streakA * Math.pow(1 - (sx0 + sx1) / 2, 2)
      crisp.line(tint, sa, hair, cx - sx1 * R * 0.98, cy + EY * R, cx - sx0 * R * 0.98, cy + EY * R)
      crisp.line(tint, sa, hair, cx + sx0 * R * 0.98, cy + EY * R, cx + sx1 * R * 0.98, cy + EY * R)
    }
    if (LUMEN) crisp.line(hotOf(tint), streakA * 0.9, Math.max(0.5, hair * 0.5), cx - R * 0.3, cy + EY * R, cx + R * 0.3, cy + EY * R)
    soft.line(tint, streakA * 0.22, thin * 2, cx - R * 0.5, cy + EY * R, cx + R * 0.5, cy + EY * R)

    // Ripples leaving the plate: at ignition, on the lock, and as a slow idle.
    var ripples = []
    if (scanning && rt < 420) ripples.push([seg(rt, 20, 420), 0.5])
    if (ok) {
      ripples.push([seg(rt, HOLO_WAVE[0], HOLO_WAVE[1]), 0.8])
      ripples.push([frac(t / 2600), 0.14 * restK])
    }
    if (scanning && bootK >= 1) ripples.push([frac(t / 3200), 0.08])
    for (var rp = 0; rp < ripples.length; rp++) {
      var rk = ripples[rp][0]
      if (rk <= 0 || rk >= 1 || ripples[rp][1] <= 0) continue
      var rka = ripples[rp][1] * Math.pow(1 - rk, 1.5)
      var rr = mix(erx, rp === 0 && ok ? 1.05 : 0.95, easeOutCubic(rk))
      var rpts = holoEllipse(cx, cy + EY * R, rr * R, ery * (rr / erx) * 0.8 * R, 40)
      crisp.poly(tint, rka, thin, rpts)
      if (ripples[rp][1] > 0.3) soft.poly(tint, rka * 0.3, bold * 2, rpts)
    }
  }
  flush()

  // --- the light cone: haze, god rays, volume slices, rising rings, motes ------------
  if (!compact) {
    var coneP = power * power
    var coneA = 0.09 * flickRaw * coneP * coneUp
    var topY = HOLO_CY + 0.1
    var tw = headSpan(topY).w * 0.98
    var coneTop = mix(EY, topY, coneUp)
    crisp.line(tint, coneA, hair, cx - erx * R, cy + EY * R, cx - mix(erx, tw, coneUp) * R, cy + coneTop * R)
    crisp.line(tint, coneA, hair, cx + erx * R, cy + EY * R, cx + mix(erx, tw, coneUp) * R, cy + coneTop * R)
    // Volumetric glow: the cone filled with light that fades as it rises,
    // cut into slices so its edges follow the cone.
    var glowA = (ok ? 1 + 1.2 * bump(rt, 400, 900) + 0.35 * restK : 1) * flickRaw * coneP
    for (var gsl = 0; gsl < 8; gsl++) {
      var g0 = gsl / 8, g1 = (gsl + 1) / 8
      var gy0 = mix(EY, coneTop, g0), gy1 = mix(EY, coneTop, g1)
      var gw = mix(erx, tw, (g0 + g1) / 2) * R
      var gg = ctx.createLinearGradient(0, cy + EY * R, 0, cy + coneTop * R)
      gg.addColorStop(0, rgba(tint, 0.085 * glowA))
      gg.addColorStop(1, rgba(tint, 0))
      ctx.fillStyle = gg
      ctx.fillRect(cx - gw, cy + gy1 * R, gw * 2, (gy0 - gy1) * R)
    }
    // God rays: columns of light up the cone, each with its own width,
    // reach and shimmer.
    var nCol = 12
    for (var gc = 0; gc < nCol; gc++) {
      var gcx = (hash(gc * 3.7 + 1) * 2 - 1) * erx * 0.92
      var gcw = fine * (1.4 + 2.6 * hash(gc * 5.1 + 2))
      var gch = (0.45 + 0.7 * hash(gc * 7.3 + 3)) * coneUp
      var gsh = 0.5 + 0.5 * Math.sin(t / (520 + 380 * hash(gc * 2.3)) + gc * 2.4)
      var gca = (0.05 + 0.08 * hash(gc * 9.1 + 4)) * (gc % 4 === 0 ? 1.8 : 1) * gsh * flickRaw * coneP * (ok ? 1 + 0.9 * bump(rt, 300, 900) : 1)
      if (gca < 0.01 || gch <= 0.02) continue
      var gcg = ctx.createLinearGradient(0, cy + EY * R, 0, cy + (EY - gch) * R)
      gcg.addColorStop(0, rgba(tint, gca))
      gcg.addColorStop(1, rgba(tint, 0))
      ctx.fillStyle = gcg
      ctx.fillRect(cx + gcx * R - gcw / 2, cy + (EY - gch) * R, gcw, gch * R)
    }
    // A core of light up the middle, from the plate into the neck.
    var coreH = (0.55 + 0.1 * Math.sin(t / 700)) * coneUp
    var corG = ctx.createLinearGradient(0, cy + EY * R, 0, cy + (EY - coreH) * R)
    corG.addColorStop(0, rgba(tint, 0.2 * flickRaw * coneP))
    corG.addColorStop(1, rgba(tint, 0))
    ctx.fillStyle = corG
    ctx.fillRect(cx - R * 0.045, cy + (EY - coreH) * R, R * 0.09, coreH * R)
    // Striations: rays fanning out from the plate, with packets of light
    // running up them. The outer ones are the tallest, so they clear the head.
    var nRay = 18
    for (var gi = 0; gi < nRay; gi++) {
      var gth = (gi + 0.5) / nRay * TAU + 0.25 * hash(gi)
      var gcs = Math.cos(gth)
      var gbx = gcs * erx * 0.96, gby = EY + Math.sin(gth) * ery
      var gflare = 1.1 + 0.3 * hash(gi * 7.7)
      var gtx = gbx * gflare, gty = EY - 1.25
      var greach = (0.2 + 0.62 * Math.pow(Math.abs(gcs), 3)) * coneUp
      var gshim = 0.55 + 0.45 * Math.sin(t / (380 + 260 * hash(gi * 2.9)) + gi * 1.9)
      var gbase = 0.11 * gshim * flickRaw * coneP * (ok ? 1 + 0.7 * bump(rt, 300, 900) + 0.2 * restK : 1)
      for (var gs = 0; gs < 5; gs++) {
        var u0 = gs / 5 * greach, u1 = (gs + 1) / 5 * greach
        var ra = gbase * Math.pow(1 - gs / 5, 1.4)
        crisp.line(tint, ra, fine, cx + mix(gbx, gtx, u0) * R, cy + mix(gby, gty, u0) * R, cx + mix(gbx, gtx, u1) * R, cy + mix(gby, gty, u1) * R)
      }
      var gpk = frac(t / (1300 + 700 * hash(gi * 4.1)) + hash(gi * 1.3)) * greach
      if (gpk < greach - 0.05) {
        var gpa = 0.5 * flickRaw * coneP * (1 - gpk / greach)
        crisp.line(LUMEN ? hotOf(tint) : tint, gpa, fine * 1.2, cx + mix(gbx, gtx, gpk) * R, cy + mix(gby, gty, gpk) * R,
          cx + mix(gbx, gtx, gpk + 0.05) * R, cy + mix(gby, gty, gpk + 0.05) * R)
      }
    }
    // Volume slices through the cone.
    for (var vs = 1; vs <= 3; vs++) {
      var vk = vs / 4
      var vy = mix(EY, topY + 0.25, vk)
      var vr = mix(erx, tw * 0.9, vk)
      crisp.poly(tint, coneA * 0.7, fine, holoEllipse(cx, cy + vy * R, vr * R, ery * 0.7 * R, 24))
    }
    // Rings travelling up the cone.
    var pSpeed = ok ? 2.5 : 1
    for (var pr = 0; pr < 2; pr++) {
      var pph = frac((ok ? t0 + rt * pSpeed : t) / 1700 + pr / 2)
      var pry = mix(EY, topY + 0.1, pph)
      var prr = mix(erx, tw, pph)
      var pa = 0.34 * Math.sin(Math.PI * pph) * flickRaw * coneP * (ok ? 1 - seg(rt, 600, 900) : 1)
      if (pa <= 0.02) continue
      crisp.poly(tint, pa, fine, holoEllipse(cx, cy + pry * R, prr * R, ery * 0.8 * R, 24))
    }
    // Motes rising through the cone.
    var moteSpeed = ok ? 1 + 3 * seg(rt, 0, 300) : 1
    var moteA = (ok ? 0.7 + 0.3 * restK - 0.4 * seg(rt, 350, 700) * (1 - restK) : 1) * coneP * flickRaw
    for (var mo = 0; mo < 36; mo++) {
      var mph = frac((ok ? t0 + rt * moteSpeed : (bad ? t0 + rt * 0.3 : t)) / (1400 + 600 * hash(mo * 5.3)) + hash(mo * 1.7))
      var my = EY - mph * 1.55 * coneUp
      var mx = (hash(mo * 3.1) - 0.5) * mix(erx * 2, 1.1, mph)
      var ma2 = 0.6 * Math.sin(Math.PI * clamp01(mph)) * moteA
      if (ma2 <= 0.02) continue
      crisp.line(tint, ma2, fine * 1.1, cx + mx * R, cy + my * R, cx + mx * R, cy + (my + 0.03) * R)
    }
  }
  flush()

  // --- scan planes: a ring of light wrapped round the surface, in a plane that
  // reaches past the head, with an arm sweeping it and a wake behind ------------
  function surfaceRing(hy) {
    var out = []
    var n = 36
    for (var i = 0; i <= n; i++) {
      var u = -Math.PI + i / n * TAU
      var Q = project(hy <= HEAD_CHIN ? headPoint(u, hy) : neckPoint(u, hy))
      var yq = lensY(Q.y)
      var P = toPx(Q.x + glitchX(Q.x, yq), yq)
      P.f = clamp01(0.5 + 0.5 * Math.cos(u + yaw))
      out.push(P)
    }
    return out
  }
  function drawPlane(sy, k, trails, trailDir, arm, fringe) {
    k *= clamp01((0.97 - Math.abs(sy)) / 0.14)
    if (k <= 0.02 || compact) return
    var hy = (sy - HOLO_CY) / HOLO_K
    var rr = Math.max(0.16, bodySpan(sy).w * 1.28 / HOLO_K)
    var zc = project([0, hy, -0.09]).z
    var ep = [], eal = [], ewd = []
    var i, Q
    for (i = 0; i <= 40; i++) {
      var ang = i / 40 * TAU
      Q = project([Math.cos(ang) * rr, hy, -0.09 + Math.sin(ang) * rr])
      var ey = lensY(Q.y)
      ep.push(toPx(Q.x + glitchX(Q.x, ey), ey))
      eal.push(k * (0.1 + 0.3 * clamp01(0.5 + (Q.z - zc) / (1.8 * rr))))
      ewd.push(thin)
    }
    holoStrip(crisp, tint, ep, eal, ewd)
    var ip = []
    for (i = 0; i <= 28; i++) {
      var ang2 = i / 28 * TAU
      Q = project([Math.cos(ang2) * rr * 0.52, hy, -0.09 + Math.sin(ang2) * rr * 0.52])
      ip.push([cx + Q.x * R, cy + Q.y * R])
    }
    crisp.poly(tint, k * 0.12, fine, ip)
    if (arm) {
      var ar = t / 1400 * TAU
      Q = project([0, hy, -0.09])
      var ac = toPx(Q.x, Q.y)
      for (var ak = 0; ak < 3; ak++) {
        var aa = ar - ak * 0.2
        var QA = project([Math.cos(aa) * rr, hy, -0.09 + Math.sin(aa) * rr])
        var AP = toPx(QA.x, QA.y)
        crisp.line(tint, k * (0.55 - 0.18 * ak), ak === 0 ? hair : fine, ac.x, ac.y, AP.x, AP.y)
      }
    }
    if (hy > HEAD_TOP + 0.02 && hy < NECK_BASE - 0.02) {
      var ring = surfaceRing(hy)
      var ral2 = [], rwd = []
      for (i = 0; i + 1 < ring.length; i++) {
        var fa = (ring[i].f + ring[i + 1].f) / 2
        ral2.push(k * (0.08 + 0.92 * fa * fa))
        rwd.push(fa > 0.5 ? bold : thin)
      }
      holoStrip(crisp, tint, ring, ral2, rwd)
      var rhot = []
      for (i = 0; i + 1 < ring.length; i++) rhot.push(ral2[i] * 0.8)
      if (LUMEN) strip(crisp, hotOf(tint), Math.max(0.5, fine), ring, rhot)
      var rpoly = []
      for (i = 0; i < ring.length; i++) rpoly.push([ring[i].x, ring[i].y])
      soft.poly(tint, k * 0.13, bold * 2.2, rpoly)
      if (fringe && chroma > 0.1) {
        var fa1 = [], fb1 = [], fl1 = [], fl2 = []
        for (i = 0; i < ring.length; i++) {
          fa1.push({ x: ring[i].x + chX * 1.3, y: ring[i].y + chY })
          fb1.push({ x: ring[i].x - chX * 1.3, y: ring[i].y - chY })
          if (i + 1 < ring.length) { fl1.push(ral2[i] * 0.4); fl2.push(ral2[i] * 0.34) }
        }
        strip(crisp, LUMEN ? altOf(tint) : ROLE_FG, fine, fa1, fl1)
        if (!bad) strip(crisp, LUMEN ? alt2Of(tint) : ROLE_ERROR, fine, fb1, fl2)
      }
      for (var tg = 1; tg <= trails; tg++) {
        var trail = surfaceRing(clamp(hy - trailDir * 0.055 * tg, HEAD_TOP + 0.02, NECK_BASE - 0.02))
        var tal = []
        for (i = 0; i + 1 < trail.length; i++) tal.push(k * 0.34 / tg * (0.1 + 0.9 * Math.pow((trail[i].f + trail[i + 1].f) / 2, 2)))
        strip(crisp, tint, fine, trail, tal)
      }
    }
  }

  // The vertical-hold bar of a failing picture: a soft band of light.
  function syncBar(by, h, a) {
    if (a <= 0.01 || by < -1 || by > 1) return
    var bhw = Math.sqrt(Math.max(0, 1 - by * by)) * R * 0.97
    var g1 = ctx.createLinearGradient(0, cy + (by - h) * R, 0, cy + by * R)
    g1.addColorStop(0, rgba(tint, 0))
    g1.addColorStop(1, rgba(tint, a))
    ctx.fillStyle = g1
    ctx.fillRect(cx - bhw, cy + (by - h) * R, bhw * 2, h * R)
    var g2 = ctx.createLinearGradient(0, cy + by * R, 0, cy + (by + h * 0.5) * R)
    g2.addColorStop(0, rgba(tint, a))
    g2.addColorStop(1, rgba(tint, 0))
    ctx.fillStyle = g2
    ctx.fillRect(cx - bhw, cy + by * R, bhw * 2, h * 0.5 * R)
  }

  // --- the head ---------------------------------------------------------------------
  var mesh = holoMesh(compact)
  var solid = ok ? easeOutCubic(seg(rt, 150, 700)) : 0
  var baseA = mix(0.7, 1, solid)
  var mw2 = compact ? Math.max(1, size * 0.018) : fine * 1.3
  // The outline is traced from the slices' extreme points, so it carries the
  // real profile: the skull behind, the nose and chin when the head turns.
  var silL = [], silR = [], silHy = [], silOn = []
  function silEdge(ps, i, sgn) {
    var n = ps.length - 1
    var a = ps[(i - 1 + n) % n], b = ps[i % n], c = ps[(i + 1) % n]
    var den = a.x - 2 * b.x + c.x
    var d = Math.abs(den) > 1e-6 ? clamp(0.5 * (a.x - c.x) / den, -0.5, 0.5) : 0
    var x = b.x - 0.25 * (a.x - c.x) * d
    if (sgn * x < sgn * b.x) x = b.x
    return { x: x, y: b.y + (d > 0 ? (c.y - b.y) * d : (b.y - a.y) * d) }
  }
  for (var ln = 0; ln < mesh.length; ln++) {
    var L = mesh[ln]
    var isSlice = ln < nSl
    var rank = isSlice && ln % 4 === 0 ? 1.25 : 1
    var pts = [], al = [], wd = [], hal = [], cpts = [], cal = [], rpts = [], ral = []
    var sliceOn = bad && isSlice ? (hash(slipStep * 3 + ln * 11) > 0.12 * failK ? 1 : 0.2) : 1
    for (var sj = 0; sj < L.length; sj++) {
      var V = L[sj]
      var hy = V[1]
      var Q = project(V)
      var y1 = lensY(Q.y)
      var dx = glitchX(Q.x, y1) + slipField(hy)
      if (bandK > 0 && Math.abs(y1 - bandY) < 0.09) dx += (hash(Math.floor(t / 60) * 7 + ln) - 0.5) * 0.05 * bandK
      var PX = toPx(Q.x + dx, y1)
      pts.push(PX)
      cpts.push({ x: PX.x + chX, y: PX.y + chY })
      rpts.push({ x: PX.x - chX, y: PX.y - chY })
      // Faces turned away show faintly through; faces towards the camera are
      // lit from the upper left, and a rim light runs where the surface turns
      // away, which is what draws the brow, nose and jaw. Nearer surface is
      // brighter and heavier than the far side.
      var fr = clamp01((Q.f + 0.04) / 0.22)
      var rim = Math.pow(1 - clamp01(Math.abs(Q.f)), 4) * fr
      var zn = clamp01(Q.z + 0.5)
      var sol = solidAt(y1)
      var vis = 1, edge = 0
      if (buildY > -8) {
        vis = clamp01((hy - buildY) / 0.12)
        edge = Math.exp(-Math.pow((hy - buildY) / 0.05, 2))
      }
      var lit = fr * 0.34 * (0.2 + 1.1 * V[6]) * (0.75 + 0.5 * zn)
      var a = baseA * flickRaw * (0.06 * (0.55 + 0.45 * zn) + lit + 0.42 * rim) * mix(0.8, 1.22, sol)
      a *= 0.86 + 0.14 * Math.sin(hy * 41 - t / 480) * Math.sin(hy * 13 + t / 790)
      if (vis < 0.999 && hash(Math.floor(rt / 40) * 17 + ln) > 0.45) a *= 0.5
      a = a * vis * sliceOn + edge * 0.55 * (0.3 + 0.7 * fr) * flickRaw
      a += bandBoost(y1) * boot * (0.25 + 0.75 * fr) * sliceOn
      al.push(a)
      var wk = fr > 0.7 && zn > 0.55 ? 1.3 : (fr < 0.25 ? 0.75 : 1)
      wd.push(mw2 * wk * rank * (1 + 0.12 * sol))
      var hv = bad ? 0 : baseA * flickRaw * 0.7 * rim * vis * (1 + 1.8 * passPulse + 0.5 * sol)
      hal.push(hv > 0.08 ? hv : 0)
      cal.push(a * 0.45 * fr)
      ral.push(a * 0.38 * fr)
    }
    if (isSlice) {
      var mnI = 0, mxI = 0
      for (var se = 1; se < pts.length - 1; se++) {
        if (pts[se].x < pts[mnI].x) mnI = se
        if (pts[se].x > pts[mxI].x) mxI = se
      }
      silL.push(silEdge(pts, mnI, -1))
      silR.push(silEdge(pts, mxI, 1))
      silHy.push(L[0][1])
      silOn.push(sliceOn)
    }
    // The offset copy rides every third slice; that is enough to read as
    // colour fringing at a fraction of the cost.
    if (!compact && chroma > 0.02 && isSlice && ln % 4 === 1) {
      strip(crisp, LUMEN ? altOf(tint) : ROLE_FG, fine, cpts, cal)
      // The opposite fringe in a second colour, which is what makes the
      // split read as chromatic: the error colour on a level-1 host, the
      // theme's third hue on a level-2 one. A miss keeps only one fringe.
      if (!bad) strip(crisp, LUMEN ? alt2Of(tint) : ROLE_ERROR, fine, rpts, ral)
    }
    holoStrip(crisp, tint, pts, al, wd)
    // The rim light burns white-hot where the surface turns away.
    if (LUMEN && !bad) strip(crisp, hotOf(tint), fine, pts, hal)
  }
  crisp.flush()

  // A solid body: the extent of each slice laid in as a faint wide stroke, so
  // the head reads as glass with volume rather than as wire alone. It
  // thickens behind a lock.
  if (!compact) {
    var fillA = bad ? 0.04 * (0.4 + 0.6 * power) : 0.034 + 0.036 * (ok ? Math.max(0.5 * solid, restK) : 0)
    var fillW = slipDy * HOLO_K * R * 1.1
    for (var fi = 0; fi < silL.length; fi++) {
      var fv = (buildY > -8 ? clamp01((silHy[fi] - buildY) / 0.12) : 1) * silOn[fi] * flickRaw
      crisp.line(tint, fillA * fv, fillW, silL[fi].x, silL[fi].y, silR[fi].x, silR[fi].y)
    }
    crisp.flush()
  }

  // Vertex cloud: flares as the lock starts, then fuses into the mesh.
  if (!compact) {
    var cloud = holoPoints()
    var cloudA = ok ? (1 + bump(rt, 150, 400)) * (1 - easeInOutCubic(seg(rt, 450, 800))) : (bad ? 0.6 * (0.4 + 0.6 * power) : 1)
    if (cloudA > 0.01) {
      var dsz = Math.max(1, size * 0.006)
      for (var cpi = 0; cpi < cloud.length; cpi++) {
        var cpt = cloud[cpi]
        var CQ = project(cpt.P)
        if (CQ.f < 0.05) continue
        var chy = cpt.P[1]
        var cvis = buildY > -8 ? clamp01((chy - buildY) / 0.12) : 1
        if (cvis <= 0.02) continue
        var cyq = lensY(CQ.y)
        var cxq = CQ.x + glitchX(CQ.x, cyq) + slipField(chy)
        var shimmer = 0.5 + 0.5 * Math.sin(t / 180 + cpt.j * 40)
        var pa3 = (0.3 + 0.35 * shimmer + bandBoost(cyq)) * (0.3 + 0.9 * cpt.P[6]) * clamp01((CQ.f - 0.05) / 0.3) * cloudA * flickRaw * cvis
        if (pa3 <= 0.02) continue
        var CP = toPx(cxq, cyq)
        if (LUMEN) ctx.glow = shimmer > 0.85 ? pa3 * 0.6 : 0
        ctx.fillStyle = rgba(LUMEN && shimmer > 0.85 && !bad ? hotOf(tint) : tint, pa3)
        ctx.fillRect(CP.x - dsz / 2, CP.y - dsz / 2, dsz, dsz)
      }
      ctx.glow = 0
    }
  }

  // Glints: a few vertices catch the light, one after another.
  if (!compact && !bad) {
    var gcl = holoPoints()
    for (var gl = 0; gl < 3; gl++) {
      var gcyc = t / 820 + gl / 3
      var gph = frac(gcyc)
      var gp = gcl[Math.floor(hash(Math.floor(gcyc) * 3 + gl * 17 + 1) * gcl.length)]
      var GQ = project(gp.P)
      if (GQ.f < 0.3 || (buildY > -8 && gp.P[1] < buildY)) continue
      var gla = Math.pow(Math.sin(Math.PI * gph), 2) * flickRaw * boot * (ok ? 0.75 : 1)
      var GP = toPx(GQ.x, lensY(GQ.y))
      var glr = R * 0.06 * (0.5 + 0.5 * Math.sin(Math.PI * gph))
      var glRole = LUMEN ? hotOf(tint) : tint
      crisp.line(glRole, gla * 0.9, fine * 1.1, GP.x - glr, GP.y, GP.x + glr, GP.y)
      crisp.line(glRole, gla * 0.9, fine * 1.1, GP.x, GP.y - glr * 0.9, GP.x, GP.y + glr * 0.9)
      soft.line(tint, gla * 0.25, bold * 1.4, GP.x - 0.2, GP.y, GP.x + 0.2, GP.y)
    }
  }

  // Silhouette, from the chin up one side, over the crown and down the
  // other. It carries the head at the small slot. While the head is being
  // built only the finished slices are in it, and its top edge is the front.
  var outline = [], choutline = []
  for (var oi = silL.length - 1; oi >= 0; oi--) if (buildY < -8 || silHy[oi] > buildY) outline.push([silL[oi].x, silL[oi].y])
  for (var oj2 = 0; oj2 < silR.length; oj2++) if (buildY < -8 || silHy[oj2] > buildY) outline.push([silR[oj2].x, silR[oj2].y])
  for (var oc = 0; oc < outline.length; oc++) choutline.push([outline[oc][0] + chX * 1.5, outline[oc][1] + chY * 1.5])
  var outA = (0.4 + 0.2 * solid + 0.2 * passFlash + 0.1 * restK) * flickRaw * (bad ? 0.55 + 0.45 * power : 1)
  if (!compact && chroma > 0.02) crisp.poly(LUMEN ? altOf(tint) : ROLE_FG, outA * 0.3, fine, choutline)
  halo.poly(tint, outA * 0.16, thin * 3.6, outline)
  crisp.poly(tint, outA, thin, outline)
  if (LUMEN && !bad) crisp.poly(hotOf(tint), outA * (0.25 + 0.5 * passFlash + 0.2 * restK), Math.max(0.5, thin * 0.4), outline)
  if (!compact && !bad && outline.length > 3) {
    // The aura: the rim light spilling past the edge, in two fading steps.
    var acx = 0, acy = 0
    for (var ai = 0; ai < outline.length; ai++) { acx += outline[ai][0]; acy += outline[ai][1] }
    acx /= outline.length
    acy /= outline.length
    for (var au = 0; au < 2; au++) {
      var asc = 1.022 + au * 0.026
      var apts = []
      for (var aj = 0; aj < outline.length; aj++) apts.push([acx + (outline[aj][0] - acx) * asc, acy + (outline[aj][1] - acy) * asc])
      crisp.poly(tint, outA * (au ? 0.1 : 0.2) * (1 + 0.5 * restK), fine, apts)
    }
  }
  if (bad && !compact && roll !== 0 && rt < 520) {
    // The vertical hold slipping: the picture shows twice, one frame apart.
    var ghostDy = (roll > 0 ? -1 : 1) * R * 0.85
    var gpoly = []
    for (var gj = 0; gj < outline.length; gj++) gpoly.push([outline[gj][0], outline[gj][1] + ghostDy])
    crisp.poly(tint, 0.3 * Math.min(1, Math.abs(roll) * 8), thin, gpoly)
  }
  flush()

  // --- the build front, and the planes of light that scan, pulse and seal the head -------
  if (!compact) {
    if (buildY > -8) drawPlane(HOLO_CY + buildY * HOLO_K, 0.9, 2, -1, false, true)
    if (bandK > 0.02 && bootK >= 1) {
      drawPlane(bandY, bandK * (ok ? 0.7 : 1), ok ? 1 : 3, 1, true, scanning)
      if (band2K > 0.02) drawPlane(band2Y, 0.4 * band2K, 0, 1, false, false)
    }
    if (pulseOn) {
      drawPlane(pulseY, bump(rt, 20, 470), 3, -1, false, false)
      // Streaks of light dragged up behind the pulse.
      var pb = bodySpan(pulseY)
      var pk = bump(rt, 20, 470)
      for (var ps = 0; ps < 9; ps++) {
        var psx = (ps / 8 * 2 - 1) * 0.9 * pb.w + pb.c
        var psh = (0.14 + 0.2 * hash(ps * 3.7)) * (1 - 0.4 * Math.abs(ps / 4 - 1))
        var psg = ctx.createLinearGradient(0, cy + pulseY * R, 0, cy + (pulseY + psh) * R)
        psg.addColorStop(0, rgba(tint, 0.3 * pk))
        psg.addColorStop(1, rgba(tint, 0))
        ctx.fillStyle = psg
        ctx.fillRect(cx + psx * R - fine, cy + pulseY * R, fine * 2, psh * R)
      }
    }
    if (ringOn) drawPlane(ringY, bump(rt, 340, 960), 3, 1, true, false)
    flush()
  }

  // --- orbit rings, levelling into a halo on a lock -----------------------------------
  var fragK = bad ? easeOutCubic(seg(rt, 120, 700)) : 0
  if (!compact) {
    var orbits = [[0.95, 0.45, t / 5000 * TAU], [0.88, -0.5, -t / 7000 * TAU]]
    for (var ob = 0; ob < orbits.length; ob++) {
      var O = orbits[ob]
      var orad = O[0], tilt = O[1], orot = O[2]
      var oyc = 0.05
      var oA = flick * 0.75 * bootGate
      var ok2 = 0
      if (ok) {
        // Both orbits level out and settle as a halo round the head, which
        // snaps shut on PASS.
        ok2 = easeInOutCubic(seg(rt, 200, 640))
        tilt = mix(tilt, 0, ok2)
        orad = mix(orad, ob ? 0.7 : 0.76, ok2)
        oyc = mix(0.05, HOLO_HALO_Y, ok2)
        oA *= 1 - 0.2 * seg(rt, 640, 900) + 0.7 * passFlash
      }
      if (bad) {
        tilt += (hash(Math.floor(rt / 60) * 5 + ob) - 0.5) * 0.8 * (1 - fragK * 0.5)
        oA *= 1 - fragK * 0.85
      }
      if (oA <= 0.02) continue
      var ct = Math.cos(tilt), stl = Math.sin(tilt)
      var opts = [], oal = []
      for (var oj = 0; oj <= 56; oj++) {
        var oa2 = oj / 56 * TAU + orot
        var X3 = Math.cos(oa2) * orad, Z3 = Math.sin(oa2) * orad
        var Y3 = -Z3 * stl, Zt = Z3 * ct
        var OQ = project([X3, Y3 + oyc, Zt])
        opts.push(toPx(OQ.x + glitchX(OQ.x, OQ.y), OQ.y))
        var odash = oj % 2 ? (ob === 0 ? 1 - ok2 : 1) : 1
        oal.push(odash * oA * (0.2 + 0.8 * clamp01((Zt + orad) / (2 * orad))))
      }
      strip(crisp, tint, ok && ob === 0 ? mix(fine * 1.3, thin, restK) : fine * 1.3, opts, oal)
      if (ok && ob === 0 && restK > 0.02) {
        var hpoly = []
        for (var hp = 0; hp < opts.length; hp++) hpoly.push([opts[hp].x, opts[hp].y])
        soft.poly(tint, restK * 0.07, bold * 2, hpoly)
        if (LUMEN) strip(crisp, hotOf(tint), Math.max(0.5, fine), opts, oal.map(function (v) { return v * 0.6 * restK }))
      }
      if (ok && ob === 0 && restK > 0.02) {
        // Graduations round the settled halo.
        for (var gk = 0; gk < 48; gk++) {
          var gka = gk / 48 * TAU + orot
          var gkr0 = orad * (gk % 4 === 0 ? 0.94 : 0.97), gkr1 = orad * (gk % 4 === 0 ? 1.07 : 1.04)
          var QA = project([Math.cos(gka) * gkr0, oyc, Math.sin(gka) * gkr0])
          var QB = project([Math.cos(gka) * gkr1, oyc, Math.sin(gka) * gkr1])
          var gfr = clamp01((Math.sin(gka) + 1) / 2)
          crisp.line(tint, restK * oA * (0.15 + 0.5 * gfr * gfr), fine, cx + QA.x * R, cy + QA.y * R, cx + QB.x * R, cy + QB.y * R)
        }
      }
      for (var nd = 0; nd < 3; nd++) {
        if (ok && ok2 >= 1 && nd > 1) break
        var na = t / (1800 + ob * 700) * TAU * (ob ? -1 : 1) + nd * TAU / 3
        var NX = Math.cos(na) * orad, NZ = Math.sin(na) * orad
        var NQ = project([NX, -NZ * stl + oyc, NZ * ct])
        var NP = toPx(NQ.x, NQ.y)
        var nds = R * 0.024
        var nfront = clamp01((NZ * ct + orad) / (2 * orad))
        var ndia = [[NP.x, NP.y - nds], [NP.x + nds, NP.y], [NP.x, NP.y + nds], [NP.x - nds, NP.y], [NP.x, NP.y - nds]]
        halo.poly(tint, oA * 0.2 * nfront, thin * 3, ndia)
        crisp.poly(tint, oA * (0.3 + 0.7 * nfront), hair, ndia)
      }
    }
    if (ok) {
      // The halo snapping shut on PASS throws a ring outward.
      var lrk = seg(rt, REC_PASS - 30, REC_PASS + 360)
      if (lrk > 0 && lrk < 1) {
        var lrr = mix(0.76, 1.2, easeOutCubic(lrk))
        var lrp = []
        for (var lj = 0; lj <= 40; lj++) {
          var lja = lj / 40 * TAU
          var LQ = project([Math.cos(lja) * lrr, HOLO_HALO_Y, Math.sin(lja) * lrr])
          lrp.push([cx + LQ.x * R, cy + LQ.y * R])
        }
        var lra = 0.7 * Math.pow(1 - lrk, 1.5)
        crisp.poly(LUMEN ? hotOf(tint) : tint, lra, thin, lrp)
        soft.poly(tint, lra * 0.3, bold * 2, lrp)
      }
    }
    halo.flush()
    soft.flush()
    crisp.flush()
  }

  // --- side scopes: the face's depth profile at the right, scan height at the left ----
  if (hud) {
    var sx0 = R * 0.7
    var sy0 = HOLO_CY - 0.62, sy1 = HOLO_CY + 0.62
    var sA = (bad ? 0.45 + 0.55 * power : 1) * boot
    crisp.line(ROLE_FG, 0.3 * sA, fine, cx + sx0, cy + sy0 * R, cx + sx0, cy + sy1 * R)
    for (var sk = 0; sk <= 12; sk++) {
      var sky = cy + mix(sy0, sy1, sk / 12) * R
      crisp.line(ROLE_FG, 0.3 * sA, fine, cx + sx0, sky, cx + sx0 + R * (sk % 3 === 0 ? 0.03 : 0.015), sky)
    }
    var prof = [], pal = []
    for (var sp = 0; sp <= 30; sp++) {
      var py = mix(-0.6, 0.6, sp / 30)
      var pz = headPoint(0, py)[2] * (bad ? 1 + (hash(Math.floor(rt / 40) * 31 + sp) - 0.5) * 0.5 * (1 - fragK) : 1)
      prof.push({ x: cx + sx0 + pz * R * 0.34, y: cy + (py * HOLO_K + HOLO_CY) * R })
      pal.push((0.55 + bandBoost(py * HOLO_K + HOLO_CY)) * sA * flickRaw)
    }
    strip(crisp, tint, fine * 1.5, prof, pal)
    var mk = scanning ? bandY : (ok ? mix(bandY, HOLO_CY, seg(rt, 0, 300)) : bandY)
    if (mk > sy0 && mk < sy1) {
      var mz = headPoint(0, (mk - HOLO_CY) / HOLO_K)[2]
      crisp.line(tint, 0.8 * sA, fine, cx + sx0, cy + mk * R, cx + sx0 + mz * R * 0.34 + R * 0.04, cy + mk * R)
      if (size >= 150) seg7(crisp, tint, 0.7 * sA, 0, fine, cx + sx0 + R * 0.02, cy + mk * R - R * 0.07, R * 0.02, R * 0.036, R * 0.028, pad3(mz * 1000), 0)
    }
    var lx = -R * 0.7
    crisp.line(ROLE_FG, 0.3 * sA, fine, cx + lx, cy + sy0 * R, cx + lx, cy + sy1 * R)
    for (var lk = 0; lk <= 24; lk++) {
      var lky = cy + mix(sy0, sy1, lk / 24) * R
      crisp.line(ROLE_FG, 0.25 * sA, fine, cx + lx, lky, cx + lx - R * (lk % 4 === 0 ? 0.03 : 0.014), lky)
    }
    if (mk > sy0 && mk < sy1) chevron(crisp, tint, 0.9 * sA, hair, cx + lx - R * 0.07, cy + mk * R, 0, R * 0.0, R * 0.035, 0.6)
    crisp.flush()
  }

  // --- the analysis markers, on the head's own surface ---------------------------------
  if (!compact) {
    faceMarkers(halo, crisp, {
      proj: function (X, Y, Z) {
        var V = headFaceVertex(X, Y, 0.03)
        var Q = project(V)
        var PX = toPx(Q.x, lensY(Q.y))
        return { x: PX.x, y: PX.y, v: clamp01((Q.f - 0.04) / 0.26) }
      },
      pass: function (X, Y, q) { return (bandY - (q.y - cy) / R) * boot - (1 - boot) },
      post: function (q) {
        if (!bad) return q
        var qy = (q.y - cy) / R
        return { x: q.x + (glitchX((q.x - cx) / R, qy) + slipField((qy - HOLO_CY - roll) / HOLO_K)) * R, y: q.y, v: q.v }
      },
      tint: tint, U: R * HOLO_K, gain: baseA * flick, labels: size >= 150, clock: t, cx: cx,
      wLine: Math.max(0.6, size * 0.0042), wMark: hair
    })
    flush()
  }

  // --- landmarks, beams and result gestures ---------------------------------------------
  var NS = holoNodes()
  var lmPx = []
  for (var lm = 0; lm < NS.nodes.length; lm++) {
    var LP = project(NS.nodes[lm].P)
    var lly = lensY(LP.y)
    lmPx.push({ p: toPx(LP.x + glitchX(LP.x, lly) + slipField(NS.nodes[lm].P[1]), lly), y: LP.y, f: LP.f })
  }
  if (!compact) {
    // Projection beams from the emitter to the landmarks and the limb, with
    // packets of light running along them.
    var beamA = (ok ? 1 + 2.2 * bump(rt, 520, 780) + 0.3 * restK : (bad ? power * power : 1)) * flickRaw * coneUp
    if (beamA > 0.02) {
      for (var bm = 0; bm < 16; bm++) {
        var bea = bm / 16 * Math.PI
        var bx0 = cx + Math.cos(bea) * erx * R * (bm % 2 ? 1 : 0.7), by0 = cy + (EY + Math.sin(bea) * ery) * R
        var bidx = (bm * 7 + 3) % lmPx.length
        var target = lmPx[bidx].p
        if (lmPx[bidx].f < 0.1) {
          var bsp = headSpan(HOLO_CY)
          target = toPx(bsp.c + (bm % 2 ? 1 : -1) * bsp.w * 0.95, HOLO_CY)
        }
        var bfl = 0.6 + 0.4 * hash(Math.floor(t / 90) * 13 + bm)
        crisp.line(tint, 0.1 * bfl * beamA, fine, bx0, by0, target.x, target.y)
        var bpk = frac(t / (1000 + 600 * hash(bm * 3.3)) + hash(bm * 1.9))
        if (bpk < 0.93) {
          var bpa = 0.5 * Math.sin(Math.PI * bpk) * beamA
          crisp.line(tint, bpa, fine * 1.2, mix(bx0, target.x, bpk), mix(by0, target.y, bpk), mix(bx0, target.x, bpk + 0.07), mix(by0, target.y, bpk + 0.07))
        }
      }
      crisp.flush()
    }
    if (scanning) {
      for (var sl2 = 0; sl2 < lmPx.length; sl2++) {
        var bd2 = Math.abs(lmPx[sl2].y - bandY)
        var sh = clamp01(1 - bd2 / 0.16) * boot
        if (sh <= 0.02 || lmPx[sl2].f < 0.1) continue
        var ds = R * 0.028
        var C0 = lmPx[sl2].p
        crisp.poly(tint, sh * 0.9, hair, [[C0.x, C0.y - ds], [C0.x + ds, C0.y], [C0.x, C0.y + ds], [C0.x - ds, C0.y], [C0.x, C0.y - ds]])
      }
    } else if (ok) {
      for (var rl2 = 0; rl2 < lmPx.length; rl2++) {
        var lockAt = 280 + NS.nodes[rl2].order * 55
        var lk2 = lmPx[rl2].f < 0.1 ? 0 : seg(rt, lockAt, lockAt + REC_LOCK_LEN)
        if (lk2 <= 0) continue
        var LP2 = lmPx[rl2].p
        var ds2 = R * 0.014
        crisp.poly(tint, clamp01(lk2 * 2) * (0.8 + 0.2 * passFlash), fine * 1.5, [[LP2.x, LP2.y - ds2], [LP2.x + ds2, LP2.y], [LP2.x, LP2.y + ds2], [LP2.x - ds2, LP2.y], [LP2.x, LP2.y - ds2]])
        if (lk2 < 1) crisp.arc(tint, (1 - lk2) * 0.8, fine, LP2.x, LP2.y, R * mix(0.07, 0.016, easeOutCubic(lk2)), 0, TAU)
      }
      // The pulse reaching the crown: a flare of rays and a ring of light
      // spreading out across the top of the head.
      if (crownK > 0.02) {
        var cc = bodySpan(HOLO_CROWN + 0.03)
        var ccx = cx + cc.c * R, ccy = cy + HOLO_CROWN * R
        for (var rf = 0; rf < 9; rf++) {
          var rfa = -Math.PI / 2 + (rf - 4) / 4 * 1.15
          var rf0 = R * 0.05, rf1 = rf0 + R * (0.1 + 0.2 * hash(rf * 3.1)) * crownK
          crisp.line(LUMEN ? hotOf(tint) : tint, crownK * 0.8, fine * 1.2, ccx + Math.cos(rfa) * rf0, ccy + Math.sin(rfa) * rf0, ccx + Math.cos(rfa) * rf1, ccy + Math.sin(rfa) * rf1)
        }
        var ck = easeOutCubic(seg(rt, 400, 820))
        var cring = holoEllipse(ccx, ccy + R * 0.1, R * mix(0.12, 0.75, ck), R * mix(0.02, 0.13, ck), 36)
        crisp.poly(tint, crownK * 0.7, thin, cring)
        soft.poly(tint, crownK * 0.2, bold * 2, cring)
      }
    } else {
      for (var bl = 0; bl < lmPx.length; bl += 4) {
        var bo = NS.nodes[bl].order
        var bk = seg(rt, 60 + bo * 30, 300 + bo * 30)
        if (bk <= 0) continue
        var lost = easeOutCubic(seg(rt, 300 + bo * 30, 800))
        var shake = (1 - bk) * R * 0.04
        drawLostTrack(crisp, lmPx[bl].p.x + Math.sin(rt / 23 + bl) * shake, lmPx[bl].p.y + Math.cos(rt / 29 + bl * 2) * shake,
          R, lost, clamp01(bk * 2) * (0.85 - 0.45 * lost), hair, bl)
      }
      var ew = bump(rt, 0, 340)
      if (ew > 0.01) crisp.arc(ROLE_ERROR, ew * 0.3, fine * 1.4, cx, cy, R * mix(0.1, 1.05, easeOutCubic(seg(rt, 0, 340))), 0, TAU)
      drawTears(crisp, tears, cx, cy, R)
      // The vertical-hold bar rolling through the picture, once at the start
      // and then as a slow hum.
      syncBar(mix(-1.05, 1.05, easeInOutCubic(seg(rt, 0, 560))), 0.22, 0.2 * (1 - seg(rt, 380, 560)))
      syncBar(mix(-1.1, 1.1, frac(t / 3400)), 0.16, 0.08 * seg(rt, 500, 800) * (0.4 + 0.6 * power))
      // Static while the projection fails.
      var noiseK = 1 - seg(rt, 350, 800)
      if (noiseK > 0) {
        var nstep = Math.floor(rt / 40)
        for (var nz = 0; nz < 40; nz++) {
          var nr = Math.sqrt(hash(nstep * 131 + nz)) * R
          var na2 = hash(nstep * 71 + nz * 3) * TAU
          var nx = cx + Math.cos(na2) * nr, ny = cy + Math.sin(na2) * nr
          var nlen = R * (0.02 + 0.07 * hash(nz * 13 + nstep))
          crisp.line(nz % 3 ? ROLE_ERROR : ROLE_FG, 0.4 * noiseK, fine, nx - nlen, ny, nx + nlen, ny)
        }
      }
      for (var bb = 0; bb < blocks.length; bb++) {
        var B = blocks[bb]
        var BP = toPx(B.x + B.dx, B.y)
        ctx.fillStyle = rgba(bb % 2 ? ROLE_FG : ROLE_ERROR, 0.14)
        ctx.fillRect(BP.x, BP.y, B.w * R, B.h * R)
        crisp.line(ROLE_ERROR, 0.4, fine, BP.x, BP.y, BP.x + B.w * R, BP.y)
      }
    }
    flush()
  }

  if (hud) paintHoloReadouts(crisp, size, state, t, rt, boot, tint, yaw, pitch, flickRaw)
  crisp.flush()
}

function paintHoloReadouts(p, size, state, t, rt, boot, tint, yaw, pitch, flick) {
  var bad = state === "notRecognized"
  var ok = state === "recognized"
  var g = readoutGeom(size, boot)

  // Top left: head yaw in degrees.
  var deg = yaw * 180 / Math.PI
  var mag = Math.min(99.9, Math.abs(deg))
  var tenths = Math.round(mag * 10)
  var digits = String(Math.floor(tenths / 10))
  while (digits.length < 2) digits = "0" + digits
  readTopLeft(p, g, size, t, bad ? ROLE_ERROR : ROLE_INK, (deg < -0.05 ? "-" : " ") + digits + "." + (tenths % 10))

  readConfidence(p, g, size, state, t, rt, tint)

  // Bottom left: pose and sync gauges, each on a graduated rule. Pointers
  // centre on a lock.
  var fine = Math.max(0.5, size * 0.0038)
  var gw = size * 0.22
  var gauges = [yaw / 0.45, pitch / 0.12, (flick - 0.9) * 10 - (ok ? 0 : 0.2)]
  for (var i = 0; i < 3; i++) {
    var gy = g.base - size * 0.01 - i * size * 0.026
    var v = clamp(gauges[i], -1, 1)
    if (ok) v = mix(v, 0, easeOutCubic(seg(rt, 0, 450)))
    if (bad) v = clamp(v + (hash(Math.floor(rt / 50) * 3 + i) - 0.5) * 1.2 * (1 - seg(rt, 300, 700)), -1, 1)
    p.line(ROLE_FG, 0.2 * boot, g.hair, g.m, gy, g.m + gw, gy)
    for (var k = 0; k <= 10; k++) {
      var kx = g.m + gw * k / 10
      p.line(ROLE_FG, 0.22 * boot, fine, kx, gy - size * (k % 5 === 0 ? 0.008 : 0.004), kx, gy)
    }
    var px = g.m + gw / 2 + v * gw / 2
    p.line(bad ? ROLE_ERROR : tint, 0.9 * boot, g.w * 1.6, px - size * 0.012, gy, px + size * 0.012, gy)
  }

  readStatus(p, g, size, state, t, rt, tint)
  readoutDetail(p, g, size, state, t, rt, tint)
}

// The styles are authored on a 1150 ms lock and a 900 ms miss, and played
// slower than authored so every beat of the sequence reads. A miss is told
// as a story: the lock is attempted and starts to resolve, stutters between
// the accent and the error colour, then fails. The entry clock is kept
// throughout, so each phase eases out of the pose it began from.
var AUTHORED_REC = 1150
var AUTHORED_MISS = 900
var MISS_ATTEMPT = 450

function paintInto(ctx, size, spec) {
  var style = resolveStyle(spec)
  var rt = spec.elapsed || 0
  var t = spec.clock || 0
  var s = spec
  FEAT = { mode: "scan", rt: 0 }
  if (spec.state === "recognized") {
    var kr = AUTHORED_REC / holdMs("recognized")
    s = { state: "recognized", clock: t - rt + rt * kr, elapsed: rt * kr }
    FEAT = { mode: "rec", rt: rt }
  } else if (spec.state === "notRecognized") {
    var km = AUTHORED_MISS / (holdMs("notRecognized") - MISS_ATTEMPT)
    var t0 = t - rt
    if (rt < MISS_ATTEMPT) {
      // The scan carries on while the match is attempted, so the head never
      // jumps to another state before it starts to fail.
      s = { state: "scanning", clock: t, elapsed: Math.max(t, BOOT_MS) }
    } else {
      var fr = rt - MISS_ATTEMPT
      s = { state: "notRecognized", clock: t0 + MISS_ATTEMPT + fr * km, elapsed: fr * km }
      FEAT = { mode: "fail", rt: fr }
    }
  }
  var missing = s.state === "notRecognized"
  MISSING = missing
  FG2 = ROLE_FG
  FG3 = ROLE_FG
  if (style === "radar") paintRadar(ctx, size, s)
  else if (style === "holo") paintHolo(ctx, size, s)
  else paintHud(ctx, size, s)
}

// How long the host should hold each state before it tears the card down.
// This is the cost of the result sequence, well under the host's 2 s clamp.
// Clipping it cuts the confirmation off before the instrument has settled.
function holdMs(state) {
  if (state === "recognized") return 1900
  if (state === "notRecognized") return 1800
  return 0
}

// --- the value-spec boundary ------------------------------------------------

// Stands in for a 2D context so the drawing code above is unchanged, and
// records what it would have drawn instead of drawing it.
function recorder() {
  var ops = []
  var cmds = null
  var stack = []
  var st = { stroke: [ROLE_ACCENT, 1], fill: [ROLE_ACCENT, 1], width: 1, glow: 0 }

  // Roles past the error role only exist on a level-2 host.
  function role(r) {
    if (r === ROLE_INK) return ROLE_FG
    if (GLASS && r === ROLE_FG) return TINT
    return LUMEN || r <= ROLE_ERROR ? r : ROLE_FG
  }
  function lit(op) {
    if (LUMEN && st.glow > 0) op.push(clamp01(st.glow))
    ops.push(op)
  }

  var rec = {
    ops: ops,
    // A dark card adds light where strokes cross, so dense regions run hot.
    // The host ignores additive blending on a light surface.
    reset: function () {
      ops.length = 0
      cmds = null
      st.glow = 0
      if (LUMEN) ops.push([OP_BLEND, 1])
    },
    save: function () { stack.push({ stroke: st.stroke, fill: st.fill, width: st.width, glow: st.glow }) },
    restore: function () { var p = stack.pop(); if (p) st = p },
    beginPath: function () { cmds = [] },
    moveTo: function (x, y) { if (cmds) cmds.push([0, x, y]) },
    lineTo: function (x, y) { if (cmds) cmds.push([1, x, y]) },
    quadraticCurveTo: function (cx, cy, x, y) { if (cmds) cmds.push([2, cx, cy, x, y]) },
    arc: function (cx, cy, r, a0, a1) { if (cmds) cmds.push([3, cx, cy, r, a0, a1]) },
    stroke: function () {
      if (cmds && cmds.length) lit([OP_PATH, role(st.stroke[0]), st.stroke[1], st.width, cmds])
      cmds = null
    },
    fillRect: function (x, y, w, h) {
      if (st.fill && st.fill.__grad) {
        var g = st.fill
        lit([OP_GRAD, role(g.role), g.from, g.to, x, y, w, h, g.y0, g.y1])
      } else {
        lit([OP_RECT, role(st.fill[0]), st.fill[1], x, y, w, h])
      }
    },
    // Level 2 only: switch later ops between normal and additive light.
    blend: function (mode) { if (LUMEN) ops.push([OP_BLEND, mode ? 1 : 0]) },
    createLinearGradient: function (x0, y0, x1, y1) {
      var g = { __grad: true, role: ROLE_ACCENT, from: 0, to: 0, y0: y0, y1: y1 }
      g.addColorStop = function (at, token) {
        g.role = token[0]
        if (at <= 0) g.from = token[1]
        else g.to = token[1]
      }
      return g
    }
  }

  function prop(name, set) { Object.defineProperty(rec, name, { set: set, get: function () { return undefined } }) }
  prop("strokeStyle", function (v) { st.stroke = v })
  prop("fillStyle", function (v) { st.fill = v })
  prop("lineWidth", function (v) { st.width = v })
  prop("lineCap", function () {})
  prop("lineJoin", function () {})
  prop("globalAlpha", function () {})
  // Alpha of later ops on the host's bloom layer. Ignored on a level-1 host.
  prop("glow", function (v) { st.glow = Number(v) || 0 })
  return rec
}

// One frame as data. Numbers and small arrays of numbers, nothing else.
function frame(size, spec) {
  LUMEN = !!spec && Number(spec.host) >= 2
  GLASS = !!spec && Number(spec.host) >= 3
  TINT = ROLE_ACCENT
  var rec = recorder()
  paintInto(rec, size, spec)
  return rec.ops
}
