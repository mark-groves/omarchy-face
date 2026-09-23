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

var OP_PATH = 0   // [OP_PATH, role, alpha, lineWidth, cmds]
var OP_RECT = 1   // [OP_RECT, role, alpha, x, y, w, h]
var OP_GRAD = 2   // [OP_GRAD, role, alphaFrom, alphaTo, x, y, w, h, yFrom, yTo]

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
function easeOutBack(k) { var c = 1.9; var f = k - 1; return 1 + c * f * f * f + 1.2 * f * f }

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

var EYE_L = -0.315
var EYE_R = 0.315
var EYE_Y = -0.205
var EYE_R_IN = 0.088
var MOUTH_Y = 0.305
var MOUTH_HALF = 0.345
var RIM_R = 0.80

// The mouth stays a measured line in every state. Bending it into a smile or
// a frown is what made the old card read as an emoji.
var MOUTH_CURVE = 0.03

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

function depthAt(x, y) {
  var r = Math.sqrt(x * x + y * y) / 0.88
  return Math.sqrt(Math.max(0, 1 - r * r))
}

function inEye(x, y, pad) {
  var dl = Math.hypot(x - EYE_L, y - EYE_Y)
  var dr = Math.hypot(x - EYE_R, y - EYE_Y)
  return Math.min(dl, dr) < EYE_R_IN + pad
}

function inMouth(x, y, pad) {
  return Math.abs(y - MOUTH_Y) < 0.10 + pad && Math.abs(x) < MOUTH_HALF + pad
}

// Facial landmarks, face units. `order` is the lock cascade: eyes first,
// then the centre line, then the mouth, then the outline.
var LANDMARKS = [
  { x: EYE_L, y: EYE_Y, dz: -0.22, order: 0 },
  { x: EYE_R, y: EYE_Y, dz: -0.22, order: 1 },
  { x: 0, y: 0.07, dz: 0.08, order: 3 },
  { x: 0, y: -0.23, dz: -0.04, order: 2 },
  { x: -0.30, y: 0.33, dz: -0.10, order: 5 },
  { x: 0.30, y: 0.33, dz: -0.10, order: 6 },
  { x: 0, y: 0.36, dz: -0.06, order: 7 },
  { x: -0.60, y: -0.30, dz: 0, order: 8 },
  { x: 0.60, y: -0.30, dz: 0, order: 9 },
  { x: 0, y: -0.53, dz: 0, order: 4 },
  { x: -0.50, y: 0.47, dz: 0, order: 10 },
  { x: 0.50, y: 0.47, dz: 0, order: 11 },
  { x: 0, y: 0.65, dz: 0, order: 12 }
]

var LANDMARK_EDGES = [
  [0, 3], [1, 3], [3, 9], [9, 7], [9, 8], [0, 9], [1, 9], [0, 7], [1, 8],
  [0, 2], [1, 2], [3, 2], [2, 4], [2, 5], [4, 6], [5, 6], [2, 6],
  [4, 10], [5, 11], [7, 10], [8, 11], [10, 12], [11, 12], [6, 12], [0, 4], [1, 5]
]

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

function buildParticles(seed) {
  var key = "p2" + seed
  if (CACHE[key]) return CACHE[key]

  var rnd = mulberry32(seed)
  var ps = []

  function push(kind, hx, hy, z, shade) {
    ps.push({
      kind: kind, hx: hx, hy: hy, z: z, shade: shade, d: Math.hypot(hx, hy / 1.1),
      sa: rnd(), sb: rnd(), sc: rnd(), n1: -1, n2: -1, n3: -1
    })
  }

  // A jittered lattice over the relief-mapped face. Shading from the surface
  // slope under a light from the upper left is what makes the sockets, the
  // nose ridge and the cheekbones appear: nothing is drawn as a feature.
  var step = 0.066
  var lx = -0.45, ly = -0.55, lz = 0.7
  var ll = Math.hypot(lx, ly, lz)
  for (var gy = -0.8; gy <= 0.8; gy += step) {
    for (var gx = -0.64; gx <= 0.64; gx += step) {
      var x = gx + (rnd() - 0.5) * step * 0.7
      var y = gy + (rnd() - 0.5) * step * 0.7
      var ins = holoInside(x, y)
      if (ins <= 0.01) continue
      var z = holoZAt(x, y)
      var e = 0.01
      var zx = (holoZAt(x + e, y) - holoZAt(x - e, y)) / (2 * e)
      var zy = (holoZAt(x, y + e) - holoZAt(x, y - e)) / (2 * e)
      var nl = Math.hypot(zx, zy, 1)
      var shade = clamp01(0.5 + 0.5 * ((-zx * lx - zy * ly + lz) / (nl * ll)) * 1.4 - 0.2)
      push(ins < 0.14 ? "edge" : "skin", x, y, z, shade)
    }
  }

  for (var i = 0; i < 44; i++) {
    var a = rnd() * Math.PI * 2
    var fr = 0.98 + rnd() * 0.62
    push("field", Math.cos(a) * fr, Math.sin(a) * fr * 0.82, 0.10 + rnd() * 0.22, 0.5)
  }

  // Static mesh topology, resolved once. Per-frame nearest-neighbour search
  // would be quadratic every tick and is not needed: the homes never move.
  var face = []
  for (i = 0; i < ps.length; i++) if (ps[i].kind !== "field") face.push(i)
  for (var fi = 0; fi < face.length; fi++) {
    var pi = face[fi]
    var b1 = 9, b2 = 9, b3 = 9, i1 = -1, i2 = -1, i3 = -1
    for (var fj = 0; fj < face.length; fj++) {
      if (fj === fi) continue
      var pj = face[fj]
      var d = Math.hypot(ps[pi].hx - ps[pj].hx, ps[pi].hy - ps[pj].hy)
      if (d < b1) { b3 = b2; i3 = i2; b2 = b1; i2 = i1; b1 = d; i1 = pj }
      else if (d < b2) { b3 = b2; i3 = i2; b2 = d; i2 = pj }
      else if (d < b3) { b3 = d; i3 = pj }
    }
    ps[pi].n1 = i1
    ps[pi].n2 = i2
    ps[pi].n3 = i3
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
function swayYaw(t) { return 0.15 * Math.sin(t / 5200 * TAU) + 0.03 * Math.sin(t / 1730 * TAU) }
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

// Batches strokes that share a role, alpha and width into one path op.
// Alpha is quantised into 1/32 steps, which is below what a 1 px line can
// show and turns hundreds of mesh edges into a handful of ops.
function pen(ctx) {
  var order = []
  var groups = {}

  function group(role, a, w) {
    var qa = Math.round(clamp01(a) * 32) / 32
    if (qa <= 0) return null
    var qw = Math.max(0.25, Math.round(w * 4) / 4)
    var key = role + ":" + qa + ":" + qw
    var g = groups[key]
    if (!g) {
      g = groups[key] = { role: role, a: qa, w: qw, cmds: [] }
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
      order = []
      groups = {}
    }
  }
}

// A line with bloom: a wide faint pass under the crisp one. Two pens keep the
// halo under every crisp stroke of the same layer.
function glowLine(halo, crisp, role, a, w, x0, y0, x1, y1) {
  halo.line(role, a * 0.16, w * 3.6, x0, y0, x1, y1)
  crisp.line(role, a, w, x0, y0, x1, y1)
}

function glowArc(halo, crisp, role, a, w, x, y, r, a0, a1) {
  halo.arc(role, a * 0.16, w * 3.6, x, y, r, a0, a1)
  crisp.arc(role, a, w, x, y, r, a0, a1)
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

  var P = buildParticles(1337)
  var ps = P.all
  var cx = size / 2
  var cy = size / 2
  var R = size * 0.45
  // The face sits a little inside the instrument, which leaves an annulus for
  // the spectrum ring between the rim and the dashed ring.
  var FSC = compact ? 1 : 0.92
  var RF = R * FSC

  ctx.reset()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var scanning = !ok && !bad
  var tint = bad ? missTint(rt) : ROLE_ACCENT

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
    var still = easeOutCubic(seg(rt, 0, 420))
    yaw = mix(swayYaw(t0 + rt * (1 - still)), 0, still)
    pitch = mix(swayPitch(t0 + rt * (1 - still)), 0, still)
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

  var halo = pen(ctx)
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
    var lines = 30
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
      var la = (major ? 0.46 : 0.20) + near * 0.55 * (ok ? 1 - closeK : 1) + passFlash * 0.5
      var len = R * (major ? 0.065 : 0.032) * (1 + near * 0.4)
      crisp.line(tint, la * dim, major ? thin : hair,
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
      glowArc(halo, crisp, tint, (0.62 + passFlash * 0.38) * dim, bold, cx, cy, dr, start, start + span)
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
      crisp.arc(ROLE_FG, 0.20 * dim, hair, cx, cy, dashR, da, da + 0.055)
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
      a = 1 - easeOutCubic(seg(rt, 120, 420)) * 0.55
    }

    var wander = 1 - a
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
        var spread = p.kind === "field" ? 2.1 : 0.32
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
  var dotBase = Math.max(1, size * (compact ? 0.030 : 0.0165))

  if (!compact) {
    var meshFade = ok ? 1 - easeInOutCubic(seg(rt, 390, 620)) : 1
    if (meshFade > 0.01) {
      for (var mi = 0; mi < P.face.length; mi++) {
        var pi = P.face[mi]
        var pp = ps[pi]
        var nbs = [pp.n1, pp.n2, pp.n3]
        for (var nb = 0; nb < 3; nb++) {
          var nj = nbs[nb]
          if (nj < 0 || nj < pi) continue
          var la2 = Math.min(lit[pi], lit[nj])
          // The mesh never fully disappears: it is the standing structure the
          // scan wake lights up, not something the wake draws from nothing.
          crisp.line(tint, (0.07 + 0.62 * la2) * meshFade * boot * (nb === 2 ? 0.6 : 1), nb === 2 ? fine : hair,
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
    var s = dotBase * zf * (p2.kind === "field" ? 0.72 : 1) * (0.68 + 0.42 * l)
    // The rim and the features carry the face; the depth-map interior is
    // texture behind them. Without this weighting the silhouette dissolves
    // on a light theme, where accent-on-near-white has little contrast.
    var kw = p2.kind === "field" ? 0.46
      : (p2.kind === "edge" ? 1.05 : 0.5 + 0.7 * p2.shade)
    // Floor keeps the silhouette readable between sweeps; the cubed term is
    // the bright crest that rides the scan plane itself.
    var alpha = (0.40 + 0.48 * l + 0.34 * l * l * l) * kw * (0.70 + 0.30 * p2.z)
    if (scanning) alpha *= mix(0.2, 1, boot)

    if (bad && p2.kind !== "field") {
      var reached = clamp01(errWave - Math.hypot(p2.hx, p2.hy))
      alpha *= mix(1, 0.62, reached)
    }
    if (ok) {
      var dw = recDissolve(p2)
      var gone = easeInOutCubic(seg(rt, dw[0], dw[1]))
      if (gone >= 0.998) continue
      alpha *= 1 - gone
      s *= 1 - gone * 0.9
    }

    ctx.fillStyle = rgba(tint, alpha)
    ctx.fillRect(pos[i2].x - s / 2, pos[i2].y - s / 2, s, s)
  }

  // Chromatic split on a miss: a foreground ghost of the cloud slips off
  // register while the lock tears, as a failing sensor would.
  if (bad && !compact) {
    var split = bump(rt, 0, 520) * size * 0.022
    if (split > 0.3) {
      var gs = dotBase * 0.8
      for (var ci = 0; ci < ps.length; ci += 2) {
        if (ps[ci].kind === "field") continue
        ctx.fillStyle = rgba(ROLE_FG, 0.22 * bump(rt, 0, 520))
        ctx.fillRect(pos[ci].x + split - gs / 2, pos[ci].y - split * 0.3 - gs / 2, gs, gs)
      }
    }
  }

  // --- landmarks ----------------------------------------------------------------
  var lmPx = []
  var lmLock = []
  for (var lm = 0; lm < LANDMARKS.length; lm++) {
    var L = LANDMARKS[lm]
    var lp = project(L.x * faceScale, L.y * faceScale, holoZAt(L.x, L.y) * DEPTH)
    lmPx.push(toPx(lp.x, lp.y))
    var lockAt = REC_LOCK0 + L.order * REC_LOCK_STEP
    lmLock.push(ok ? seg(rt, lockAt, lockAt + REC_LOCK_LEN) : 0)
  }

  if (!compact) {
    if (scanning) {
      // Hunting: a crosshair flares on each landmark as the plane crosses it.
      for (var sl = 0; sl < lmPx.length; sl++) {
        var ly2 = (lmPx[sl].y - cy) / R
        var hit = acquisition(plane, ly2)
        var ha = clamp01((hit - 0.25) * 1.4) * boot
        if (ha <= 0.02) continue
        var jit = Math.sin(t / 47 + sl * 3.1) * R * 0.012 * (1 - hit)
        var hs = R * (0.05 + 0.03 * (1 - hit))
        var hg = hs * 0.4
        var hx2 = lmPx[sl].x + jit
        var hy2 = lmPx[sl].y
        crisp.line(tint, ha * 0.9, hair, hx2 - hs, hy2, hx2 - hg, hy2)
        crisp.line(tint, ha * 0.9, hair, hx2 + hg, hy2, hx2 + hs, hy2)
        crisp.line(tint, ha * 0.9, hair, hx2, hy2 - hs, hx2, hy2 - hg)
        crisp.line(tint, ha * 0.9, hair, hx2, hy2 + hg, hx2, hy2 + hs)
      }
      flush()
    } else if (ok) {
      // Graph edges draw out from each endpoint once both ends are locked.
      for (var ge = 0; ge < LANDMARK_EDGES.length; ge++) {
        var E = LANDMARK_EDGES[ge]
        var ek = easeInOutCubic(Math.min(lmLock[E[0]], lmLock[E[1]]))
        if (ek <= 0.01) continue
        var A = lmPx[E[0]], B = lmPx[E[1]]
        var mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2
        var ea = 0.34 + 0.2 * passFlash
        crisp.line(tint, ea, hair, mx, my, mix(mx, A.x, ek), mix(my, A.y, ek))
        crisp.line(tint, ea, hair, mx, my, mix(mx, B.x, ek), mix(my, B.y, ek))
      }

      for (var rl = 0; rl < lmPx.length; rl++) {
        drawLockReticle(halo, crisp, tint, lmPx[rl], lmLock[rl], R, hair, thin, passFlash)
      }

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
      // Landmark IDs flash up beside each reticle as it locks.
      if (size >= 150) {
        for (var lid = 0; lid < lmPx.length; lid++) {
          var la3 = Math.max(bump(rt, REC_LOCK0 + LANDMARKS[lid].order * REC_LOCK_STEP, REC_LOCK0 + LANDMARKS[lid].order * REC_LOCK_STEP + 420), lmLock[lid] * 0.3)
          if (la3 <= 0.02) continue
          var idn = String(lid + 1)
          if (idn.length < 2) idn = "0" + idn
          seg7(crisp, tint, la3, 0, fine, lmPx[lid].x + R * 0.045, lmPx[lid].y - R * 0.085, R * 0.022, R * 0.04, R * 0.032, idn, 0)
        }
      }
      flush()
    } else {
      // A miss: the reticles hunt, fail to converge, and lose track. Not on
      // the eye and mouth landmarks: boxes there arrange into a face.
      for (var bl = 0; bl < lmPx.length; bl++) {
        if (bl === 0 || bl === 1 || bl === 4 || bl === 5) continue
        var bc = lmPx[bl]
        var bk = seg(rt, 60 + LANDMARKS[bl].order * 22, 300 + LANDMARKS[bl].order * 22)
        if (bk <= 0) continue
        var shake = (1 - bk) * R * 0.04
        var lost = easeOutCubic(seg(rt, 300 + LANDMARKS[bl].order * 22, 800))
        drawLostTrack(crisp, bc.x + Math.sin(rt / 23 + bl) * shake, bc.y + Math.cos(rt / 29 + bl * 2) * shake,
          R, lost, clamp01(bk * 2) * (0.85 - 0.45 * lost), hair, bl)
      }
      flush()
    }
  } else if (ok) {
    var rimC = easeInOutCubic(seg(rt, 460, 700))
    if (rimC > 0.004) {
      crisp.arc(tint, Math.min(1, rimC * 2.4), Math.max(1, size * 0.036), cx, cy, R * RIM_R * faceScale,
        -Math.PI / 2, -Math.PI / 2 + TAU * rimC)
    }
    crisp.flush()
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

    glowLine(halo, crisp, tint, 0.92 * planeK, thin, cx - pw, py, cx + pw, py)
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
    crisp.line(ROLE_FG, 0.3 * planeK, fine, vx, cy - vh, vx, cy + vh)
    for (var vt = -8; vt <= 8; vt++) {
      var vty = cy + vt * vh / 9
      crisp.line(ROLE_FG, 0.35 * planeK, fine, vx, vty, vx + R * (vt % 4 === 0 ? 0.035 : 0.016), vty)
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
  var role = bad ? ROLE_ERROR : (ok ? tint : ROLE_FG)
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
  var role = bad ? ROLE_ERROR : (ok && rt >= REC_PASS ? tint : ROLE_FG)
  seg7(p, role, a, g.ghost, g.w, size - g.m, g.base - g.ch, g.cw, g.ch, g.pitch, word, 1)
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
  readTopLeft(p, g, size, t, bad ? ROLE_ERROR : ROLE_FG, hex4(frameNo))

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
    p.line(ROLE_FG, 0.12 * boot, bw, bx, g.base, bx, g.base - bh)
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
// breaks on a miss, two eye marks, a measured mouth line, and the scan line.
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

  for (var e = 0; e < 2; e++) {
    var ex = cx + (e === 0 ? EYE_L : EYE_R) * R
    var ey = cy + EYE_Y * R
    p.line(tint, baseA, w * 1.2, ex - R * 0.07, ey, ex + R * 0.07, ey)
  }
  p.line(tint, baseA, w, cx - MOUTH_HALF * 0.85 * R, cy + MOUTH_Y * R, cx + MOUTH_HALF * 0.85 * R, cy + MOUTH_Y * R)

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

// A polyline whose segments carry their own alpha. Consecutive segments in
// the same alpha step share one subpath, which keeps dense meshes cheap to
// replay. An alpha of zero breaks the line.
function strip(p, role, w, pts, al) {
  var run = null
  var runA = -1
  for (var i = 1; i < pts.length; i++) {
    var a = Math.round(clamp01(al[i - 1]) * 32) / 32
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
    var x = g.m + i * cell * 1.45
    p.line(on ? (bad ? ROLE_ERROR : tint) : ROLE_FG, (on ? 0.7 : 0.12) * g.boot, g.w * 1.1, x, y, x + cell, y)
  }
  var rw = g.pitch * 3
  var rx = size - g.m - rw
  var ry = g.tagY + size * 0.016
  var ticks = []
  for (var k = 0; k <= 20; k++) {
    var tx = rx + rw * k / 20
    var th = size * (k % 5 === 0 ? 0.012 : 0.006)
    p.line(ROLE_FG, 0.28 * g.boot, fine, tx, ry, tx, ry + th)
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
      p.line(bad ? ROLE_ERROR : (wd === 0 ? tint : ROLE_FG), (wd === 0 ? 0.6 : 0.3) * g.boot, fine, xx, lyy, xx + wl, lyy)
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
  p.poly(bad ? ROLE_ERROR : tint, 0.7 * g.boot, fine, tr)

  var cm = size * 0.012
  var corners = [[cm, cm], [size - cm, cm], [cm, size - cm], [size - cm, size - cm]]
  for (var c = 0; c < 4; c++) {
    var q = corners[c]
    p.line(ROLE_FG, 0.3 * g.boot, fine, q[0] - cm * 0.6, q[1], q[0] + cm * 0.6, q[1])
    p.line(ROLE_FG, 0.3 * g.boot, fine, q[0], q[1] - cm * 0.6, q[0], q[1] + cm * 0.6)
  }
}

// HUD backplate: a fine polar grid behind the cloud, with registration
// crosses at its major intersections.
function hudGraticule(p, cx, cy, R, fine, hair, boot, tint, t) {
  for (var r = 1; r <= 5; r++) p.arc(ROLE_FG, 0.085 * boot, fine, cx, cy, R * r * 0.15, 0, TAU)
  for (var s = 0; s < 24; s++) {
    var a = s * TAU / 24
    p.line(ROLE_FG, (s % 2 ? 0.045 : 0.075) * boot, fine,
      cx + Math.cos(a) * R * 0.1, cy + Math.sin(a) * R * 0.1, cx + Math.cos(a) * R * 0.76, cy + Math.sin(a) * R * 0.76)
  }
  var k = R * 0.018
  for (var ri = 1; ri <= 2; ri++) {
    for (var ci = 0; ci < 12; ci++) {
      var ca = ci * TAU / 12 + ri * 0.26
      var x = cx + Math.cos(ca) * R * ri * 0.3, y = cy + Math.sin(ca) * R * ri * 0.3
      var tw = 0.10 + 0.08 * Math.sin(t / 600 + ci + ri * 2)
      p.line(tint, tw * boot, fine, x - k, y, x + k, y)
      p.line(tint, tw * boot, fine, x, y - k, x, y + k)
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
    crisp.line(tint, (0.24 + 0.62 * v) * dim, i % 2 === 0 ? hair : fine,
      cx + Math.cos(ang) * rb, cy + Math.sin(ang) * rb, cx + Math.cos(ang) * (rb + len), cy + Math.sin(ang) * (rb + len))
  }

  // Vernier: a fine scale turning against the bezel, 1.6 times as fast.
  var vr = ringPose(0, state, t, rt) * -1.6
  for (var vi = 0; vi < 144; vi++) {
    if (vi / 144 > boot) break
    var va = vr + vi * TAU / 144
    var vl = R * (vi % 12 === 0 ? 0.03 : 0.016)
    crisp.line(ROLE_FG, (vi % 12 === 0 ? 0.55 : 0.3) * dim * (1 + passFlash), fine,
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
    crisp.line(tint, 0.24 * dim * boot, fine,
      cx + Math.cos(ma) * R * 1.083, cy + Math.sin(ma) * R * 1.083,
      cx + Math.cos(ma) * (R * 1.083 + ml), cy + Math.sin(ma) * (R * 1.083 + ml))
  }

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

// HUD face topology: iso-depth contours of the relief and profile curves
// over the cloud, swayed with it and lit by the scan plane. A lock lights
// the contours from the deepest level up in a cascade; a miss shears and
// breaks them.
function hudTopology(halo, crisp, state, t, rt, boot, tint, fine, hair, plane, project, toPx, FSC, tears, shearK, faceScale) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var scanning = !ok && !bad
  var brk = bad ? easeOutCubic(seg(rt, 150, 600)) : 0
  function place(x, y, d) {
    var pr = project(x * faceScale, y * faceScale, d)
    var X = pr.x, Y = pr.y
    if (bad) {
      var band = Math.floor((y + 1.2) / 0.48)
      X += shearK * (band % 2 === 0 ? 0.16 : -0.16) + tearShift(tears, Y)
    }
    return { u: Y, p: toPx(X, Y) }
  }
  function lightAt(u, base, seed) {
    var a = base
    if (scanning) a += 0.6 * acquisition(plane, u * FSC)
    if (bad && hash(seed) < brk) a = 0
    return a * boot
  }
  var topo = holoContours()
  for (var ts = 0; ts < topo.segs.length; ts++) {
    var S = topo.segs[ts]
    var li = S[5]
    var cas = ok ? bump(rt, 240 + li * 45, 560 + li * 45) : 0
    var base = 0.14 + 0.55 * cas + (ok ? 0.16 * seg(rt, 500, 900) : 0)
    var A = place(S[0], S[1], S[4] * DEPTH), B = place(S[2], S[3], S[4] * DEPTH)
    var a = lightAt((A.u + B.u) / 2, base, ts * 7 + 1)
    if (a > 0.004) crisp.line(tint, a, fine, A.p.x, A.p.y, B.p.x, B.p.y)
  }
  var profiles = [[1, 0, 0], [0, 1, 0], [1, 0, 0.36], [1, 0, -0.36], [0, 1, 0.4], [0, 1, -0.4]]
  var profA = 0.13 + (ok ? 0.3 * bump(rt, 300, 700) + 0.1 * seg(rt, 600, 900) : 0)
  for (var pi = 0; pi < profiles.length; pi++) {
    var P = profiles[pi]
    var pts2 = [], al2 = []
    for (var s = 0; s <= 28; s++) {
      var u = mix(-0.86, 0.86, s / 28)
      var x = P[0] ? P[2] : u
      var y = P[0] ? u : P[2]
      if (holoInside(x, y) <= 0.01) {
        // Off the mask: end the run here.
        if (pts2.length > 1) strip(crisp, tint, fine, pts2, al2)
        pts2 = []
        al2 = []
        continue
      }
      var q2 = place(x, y, holoZAt(x, y) * DEPTH)
      pts2.push(q2.p)
      al2.push(lightAt(q2.u, profA, pi * 57 + s))
    }
    if (pts2.length > 1) strip(crisp, tint, fine, pts2, al2)
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

// --- Phosphor Radar -------------------------------------------------------------
//
// A plan-position scope. The sweep arm refreshes a dense topology of returns
// laid on the face: the rim, depth contours, two iris rings, the nose column,
// a level mouth row and a speckle of skin. Returns decay behind the arm but
// never below a floor, so the whole face stays legible at 116 px between
// sweeps; the first revolution after entry paints it in. Returns are range
// cells, short arcs about the scope centre, never smooth outlines, so the
// face reads as sensor data. Around it: a fine graticule with sub-ticks, a
// nodding sector scanner, a range strobe, interference, and target brackets.

var RADAR_REV_MS = 2400
var RADAR_CLUTTER = 90
var RADAR_FLOOR = 0.2

function radarReturns() {
  if (CACHE.radar3) return CACHE.radar3
  var rnd = mulberry32(4242)
  var rs = []
  function add(kind, x, y, gain) {
    var z = holoInside(x, y) > 0 ? holoZAt(x, y) : 0
    rs.push({ kind: kind, x: x, y: y, r: Math.hypot(x, y), a: Math.atan2(y, x), gain: gain * (0.7 + 0.5 * z), j: rnd() })
  }
  var i, a
  // The silhouette of the mask.
  for (i = 0; i < 64; i++) {
    a = (i / 64) * TAU
    var sy = HOLO_B * Math.sin(a)
    add("rim", HOLO_A * Math.cos(a) * holoTaper(sy) * 1.02, sy * 1.02, 0.85)
  }
  // The face itself is its relief: returns laid along the iso-depth
  // contours, so the nose, sockets and cheekbones emerge as topography.
  var topo = holoContours()
  for (i = 0; i < topo.segs.length; i++) {
    var S = topo.segs[i]
    add("topo", (S[0] + S[2]) / 2, (S[1] + S[3]) / 2, 0.45 + 0.07 * S[5])
  }
  var n = 0
  while (n < 40) {
    var sx = (rnd() * 2 - 1) * 0.6
    var sy2 = (rnd() * 2 - 1) * 0.78
    if (holoInside(sx, sy2) <= 0.05) continue
    add("skin", sx, sy2, 0.3)
    n++
  }
  CACHE.radar3 = rs
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

  var halo = pen(ctx)
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
    for (var me = 0; me < 2; me++) {
      var mex = cx + (me === 0 ? EYE_L : EYE_R) * R
      crisp.arc(tint, 0.95, mw * 1.1, cx, cy, Math.hypot(mex - cx, EYE_Y * R), Math.atan2(EYE_Y * R, mex - cx) - 0.2, Math.atan2(EYE_Y * R, mex - cx) + 0.2)
    }
    for (var mm = -1; mm <= 1; mm++) {
      var mmx = cx + mm * MOUTH_HALF * 0.7 * R
      crisp.line(tint, 0.95, mw, mmx, cy + (MOUTH_Y - 0.08) * R, mmx, cy + (MOUTH_Y + 0.08) * R)
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
        crisp.line(ROLE_FG, 0.16 * boot, fine,
          cx + Math.cos(sa0) * rad, cy + Math.sin(sa0) * rad,
          cx + Math.cos(sa0) * (rad - tl), cy + Math.sin(sa0) * (rad - tl))
      }
    }
    // Bearing spokes: every 10 degrees fine, every 30 heavier.
    for (var sp = 0; sp < 36; sp++) {
      var sa = sp * TAU / 36
      var heavy = sp % 3 === 0
      crisp.line(ROLE_FG, (heavy ? 0.075 : 0.035) * boot, heavy ? hair : fine,
        cx + Math.cos(sa) * R * 0.05, cy + Math.sin(sa) * R * 0.05,
        cx + Math.cos(sa) * R * 0.975, cy + Math.sin(sa) * R * 0.975)
    }
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
      var la = (major ? 0.5 : 0.2) + near * 0.6 + passFlash * 0.4
      var len = R * (major ? 0.065 : 0.03)
      crisp.line(tint, la, major ? thin : hair,
        cx + Math.cos(ba) * R * 1.0, cy + Math.sin(ba) * R * 1.0,
        cx + Math.cos(ba) * (R * 1.0 + len), cy + Math.sin(ba) * (R * 1.0 + len))
    }
    for (var mt = 0; mt < 180; mt++) {
      var mta = mt * TAU / 180
      var offd = Math.abs(((mta % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4)
      if (offd < 0.3) continue
      crisp.line(ROLE_FG, 0.2 * boot, fine,
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
      crisp.arc(tint, 0.8 * armK, hair, cx, cy, gate, arm - 0.09 * dir - 0.04, arm + 0.04)
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
        crisp.line(ROLE_FG, 0.2 * secK, fine, cx + Math.cos(lim) * d0, cy + Math.sin(lim) * d0, cx + Math.cos(lim) * d1, cy + Math.sin(lim) * d1)
      }
    }
    crisp.arc(ROLE_FG, 0.22 * secK, fine, cx, cy, R * 0.94, secC - 0.85, secC + 0.85)
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
    if (bad) alpha *= 1 - 0.45 * seg(rt, 200, 800)
    alpha *= 1 + passFlash * 0.2
    var w = clamp(0.03 / Math.max(q.r, 0.05), 0.05, 0.22)
    if (q.kind === "rim") w *= mix(0.8, 1.2, holdK)
    if (q.kind === "topo" || q.kind === "skin") w *= 0.7
    var feat = q.kind !== "skin" && q.kind !== "topo"
    var lw = compact ? Math.max(1, size * 0.03)
      : (q.kind === "rim" ? Math.max(1, size * 0.018) : (feat ? Math.max(1, size * 0.013) : Math.max(0.75, size * 0.011)))
    var ox = bad ? tearShift(tears, q.y) * R : 0
    var qr = q.r * R
    if (bad && jamK > 0) qr += (hash(jitStep * 7 + i) - 0.5) * 0.05 * R * jamK
    {
      crisp.arc(tint, alpha, lw, cx + ox, cy, qr, q.a - w, q.a + w)
      // Phosphor bloom on fresh returns.
      if (!compact && q.kind === "topo" && fresh > 0.45) halo.arc(tint, alpha * 0.18 * fresh, lw * 3, cx + ox, cy, qr, q.a - w, q.a + w)
    }
    if (smearK > 0.01) {
      var r1 = qr * (1 + 0.32 * smearK * (0.5 + q.j))
      crisp.line(tint, alpha * 0.5, fine, cx + ox + Math.cos(q.a) * qr, cy + Math.sin(q.a) * qr,
        cx + ox + Math.cos(q.a) * r1, cy + Math.sin(q.a) * r1)
    }
  }

  // Clutter: re-rolled per sweep cycle, flooding in on a miss and filtered
  // out by a lock.
  var nClutter = scanning ? 22 : (bad ? Math.round(22 + (RADAR_CLUTTER - 22) * easeOutCubic(seg(rt, 0, 400))) : 22)
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
    var trk = [LANDMARKS[2], LANDMARKS[9], LANDMARKS[11]]
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
    // Feature trackers.
    for (var ey = 0; ey < trk.length; ey++) {
      var exPx = cx + trk[ey].x * R, eyPx = cy + trk[ey].y * R
      if (bad) {
        var bk = seg(rt, 60 + ey * 40, 300 + ey * 40)
        drawLostTrack(crisp, exPx + Math.sin(rt / 23 + ey) * R * 0.03, eyPx + Math.cos(rt / 29 + ey) * R * 0.03,
          R, easeOutCubic(seg(rt, 300, 800)), clamp01(bk * 2) * 0.8, hair, ey + 20)
        continue
      }
      var hunt = scanning ? 1 : 1 - easeOutCubic(seg(rt, 420 + ey * 60, 600 + ey * 60))
      var ex2 = exPx + Math.sin(t / (410 + ey * 90) + ey * 2) * R * 0.05 * hunt
      var ey2 = eyPx + Math.cos(t / (530 + ey * 70) + ey * 3) * R * 0.04 * hunt
      var eh = R * mix(0.06, 0.11, hunt)
      bracketBox(crisp, tint, (0.35 + 0.5 * (1 - hunt)) * boot, fine * 1.4, ex2, ey2, eh, eh * 0.45)
      if (labels) {
        // Coordinates beside each tracker, scrambling while it hunts.
        var cv = hunt > 0.05 ? hash(Math.floor(t / 70) + ey * 9) * 999 : (trk[ey].x + 1) * 400 + ey * 17
        seg7(crisp, tint, 0.55 * boot, 0, fine, ex2 + eh + R * 0.02, ey2 - eh, R * 0.02, R * 0.036, R * 0.028, pad3(cv), 0)
      }
    }
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
  readTopLeft(p, g, size, t, bad ? ROLE_ERROR : ROLE_FG, " " + pad3(deg))

  readConfidence(p, g, size, state, t, rt, tint)

  // Bottom left: A-scope. Return amplitude against range along the arm, over
  // a fine grid.
  var x0 = g.m
  var wA = size * 0.23
  var hA = size * 0.075
  var yb = g.base
  for (var gx = 0; gx <= 6; gx++) p.line(ROLE_FG, 0.1 * boot, fine, x0 + wA * gx / 6, yb, x0 + wA * gx / 6, yb - hA)
  for (var gy = 1; gy <= 2; gy++) p.line(ROLE_FG, 0.1 * boot, fine, x0, yb - hA * gy / 3, x0 + wA, yb - hA * gy / 3)
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
// A projected face mask, built in layers: a relief-mapped half ellipsoid
// wired by a dense latitude/longitude mesh in true perspective, a vertex
// point cloud, iso-depth contours of the relief, a cage turning the other
// way outside it, and two tilted orbit rings. It rises from an emitter
// through projection beams and a volumetric cone. It turns no more than about
// 22 degrees, with a bold silhouette, so it stays a legible face at 116 px
// while the parallax sells the depth. The mouth is a level line on the
// surface in every state.

var HOLO_A = 0.60
var HOLO_B = 0.78
var HOLO_C = 0.55
var HOLO_CY = -0.10
var HOLO_F = 3.4
var HOLO_BAND_MS = 2300
var HOLO_SLICES = 24

// The face's bone structure as relief on the mask. Every style draws the
// face from this surface alone (its depth, slope and contours), never from
// drawn eyes or a mouth, which is what keeps it from reading as an emoji.
function holoRelief(x, y) {
  var ex = Math.abs(x) - 0.25
  var nose = 0.2 * Math.exp(-((x / 0.07) * (x / 0.07) + ((y - 0.02) / 0.2) * ((y - 0.02) / 0.2)))
  var tip = 0.04 * Math.exp(-((x / 0.06) * (x / 0.06) + ((y - 0.13) / 0.05) * ((y - 0.13) / 0.05)))
  var sock = -0.09 * Math.exp(-((ex / 0.12) * (ex / 0.12) + ((y + 0.18) / 0.08) * ((y + 0.18) / 0.08)))
  var brow = 0.04 * Math.exp(-((ex / 0.17) * (ex / 0.17) + ((y + 0.31) / 0.05) * ((y + 0.31) / 0.05)))
  var cx0 = Math.abs(x) - 0.3
  var cheek = 0.04 * Math.exp(-((cx0 / 0.12) * (cx0 / 0.12) + ((y - 0.06) / 0.1) * ((y - 0.06) / 0.1)))
  var lips = 0.03 * Math.exp(-((x / 0.18) * (x / 0.18) + ((y - 0.36) / 0.045) * ((y - 0.36) / 0.045)))
  var chin = 0.03 * Math.exp(-((x / 0.15) * (x / 0.15) + ((y - 0.6) / 0.08) * ((y - 0.6) / 0.08)))
  return nose + tip + sock + brow + cheek + lips + chin
}

function holoTaper(y) { return y > 0 ? 1 - 0.30 * (y / HOLO_B) * (y / HOLO_B) : 1 }

function holoSurface(u, v) {
  var cv = Math.cos(v)
  var y = HOLO_B * Math.sin(v)
  var x = HOLO_A * Math.sin(u) * cv * holoTaper(y)
  var z = HOLO_C * Math.cos(u) * cv + holoRelief(x, y) * Math.max(0, Math.cos(u))
  return [x, y, z]
}

function holoInside(x, y) {
  var xt = x / holoTaper(y)
  return 1 - (xt / HOLO_A) * (xt / HOLO_A) - (y / HOLO_B) * (y / HOLO_B)
}

function holoZAt(x, y) {
  return HOLO_C * Math.sqrt(Math.max(0, holoInside(x, y))) + holoRelief(x, y)
}

function holoYaw(t) { return 0.38 * Math.sin(t / 6400 * TAU) + 0.04 * Math.sin(t / 1900 * TAU) }
function holoPitch(t) { return 0.08 * Math.sin(t / 8100 * TAU + 0.7) }

function holoMesh(compact) {
  var key = compact ? "holoC" : "holo2"
  if (CACHE[key]) return CACHE[key]
  var lines = []
  // Structured light: dense horizontal slices that bend over the relief, a
  // few verticals to hold them together.
  var nLat = compact ? 5 : HOLO_SLICES
  var nLon = compact ? 5 : 7
  var i, j, pts
  for (i = 0; i < nLat; i++) {
    var v = mix(-1.25, 1.25, i / (nLat - 1))
    pts = []
    for (j = 0; j <= (compact ? 18 : 28); j++) pts.push(holoSurface(mix(-1.75, 1.75, j / (compact ? 18 : 28)), v))
    lines.push(pts)
  }
  for (i = 0; i < nLon; i++) {
    var u = mix(-1.45, 1.45, i / (nLon - 1))
    pts = []
    for (j = 0; j <= (compact ? 16 : 22); j++) pts.push(holoSurface(u, mix(-1.35, 1.35, j / (compact ? 16 : 22))))
    lines.push(pts)
  }
  CACHE[key] = lines
  return lines
}

// The vertex cloud: a jittered lattice on the surface, front half only.
function holoPoints() {
  if (CACHE.holoP) return CACHE.holoP
  var rnd = mulberry32(777)
  var pts = []
  for (var i = 0; i < 16; i++) {
    for (var j = 0; j < 22; j++) {
      var u = mix(-1.5, 1.5, (j + rnd() * 0.6) / 21.6)
      var v = mix(-1.3, 1.3, (i + rnd() * 0.6) / 15.6)
      var P = holoSurface(u, v)
      pts.push({ P: P, j: rnd(), k: rnd() })
    }
  }
  CACHE.holoP = pts
  return pts
}

// Iso-depth contours of the relief, by marching squares. Static geometry in
// face space; the pose is applied per frame.
function holoContours() {
  if (CACHE.holoT) return CACHE.holoT
  var nx = 20, ny = 28
  var x0 = -0.64, x1 = 0.64, y0 = -0.82, y1 = 0.82
  var levels = [0.12, 0.22, 0.32, 0.41, 0.49, 0.56, 0.62, 0.67]
  var grid = []
  for (var j = 0; j <= ny; j++) {
    var row = []
    for (var i = 0; i <= nx; i++) {
      var x = mix(x0, x1, i / nx), y = mix(y0, y1, j / ny)
      row.push(holoInside(x, y) > 0 ? holoZAt(x, y) : -1)
    }
    grid.push(row)
  }
  var segs = []
  function lerp(a, b, va, vb, L) { return a + (b - a) * ((L - va) / (vb - va)) }
  for (var li = 0; li < levels.length; li++) {
    var L = levels[li]
    for (var cj = 0; cj < ny; cj++) {
      for (var ci = 0; ci < nx; ci++) {
        var xa = mix(x0, x1, ci / nx), xb = mix(x0, x1, (ci + 1) / nx)
        var ya = mix(y0, y1, cj / ny), yb = mix(y0, y1, (cj + 1) / ny)
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
  CACHE.holoT = { segs: segs, levels: levels.length }
  return CACHE.holoT
}

// Solver nodes: a jittered lattice of surface points the lock resolves in a
// wave from the nose outward. Deliberately not the landmark set: a lock
// diamond in each eye socket reads as pupils.
function holoNodes() {
  if (CACHE.holoN) return CACHE.holoN
  var nodes = []
  var us = [-0.95, -0.48, 0, 0.48, 0.95], vs = [-0.95, -0.5, -0.05, 0.4, 0.85]
  for (var i = 0; i < vs.length; i++) {
    for (var j = 0; j < us.length; j++) {
      var u = us[j] + (hash(i * 7 + j * 3 + 1) - 0.5) * 0.22
      var v = vs[i] + (hash(i * 5 + j * 11 + 2) - 0.5) * 0.18
      var P = holoSurface(u, v)
      nodes.push({ P: P, i: i, j: j, order: Math.hypot(P[0], P[1] - 0.05) * 6 + hash(i * 13 + j) })
    }
  }
  var edges = []
  for (var n = 0; n < nodes.length; n++) {
    if (nodes[n].j < us.length - 1) edges.push([n, n + 1])
    if (nodes[n].i < vs.length - 1) edges.push([n, n + us.length])
    if (nodes[n].j < us.length - 1 && nodes[n].i < vs.length - 1 && (nodes[n].i + nodes[n].j) % 2 === 0) edges.push([n, n + us.length + 1])
  }
  CACHE.holoN = { nodes: nodes, edges: edges }
  return CACHE.holoN
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
  var t0 = t - rt

  var hair = Math.max(1, size * 0.0065)
  var thin = Math.max(1, size * 0.009)
  var bold = Math.max(1, size * 0.016)
  var fine = Math.max(0.5, size * 0.0038)

  var boot = scanning ? easeOutCubic(seg(rt, 0, BOOT_MS)) : 1

  // Pose: slow turn, eased face-on by a lock, jerked by a miss.
  var yaw = holoYaw(t)
  var pitch = holoPitch(t)
  if (ok) {
    var still = easeOutCubic(seg(rt, 0, 450))
    yaw = mix(holoYaw(t0 + rt * (1 - still)), 0, still)
    pitch = mix(holoPitch(t0 + rt * (1 - still)), 0, still)
  } else if (bad) {
    var jstep = Math.min(6, Math.floor(rt / 55))
    yaw = holoYaw(t0 + rt * 0.2) + (jstep > 0 ? (hash(jstep * 7 + 3) - 0.5) * 0.35 : 0)
    pitch = holoPitch(t0 + rt * 0.2) + (jstep > 0 ? (hash(jstep * 5 + 1) - 0.5) * 0.12 : 0)
  }
  var cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), spp = Math.sin(pitch)

  // Projector flicker. Steady on a lock; failing on a miss.
  var flick = 0.9 + 0.1 * Math.sin(t / 41) * Math.sin(t / 97)
  if (hash(Math.floor(t / 140)) > 0.93) flick *= 0.7
  if (ok) flick = mix(flick, 1, seg(rt, 0, 300))
  if (bad) {
    flick *= 1 - 0.35 * easeOutCubic(seg(rt, 150, 700))
    if (rt > 100 && rt < 600 && hash(Math.floor(rt / 70) + 17) > 0.55) flick *= 0.55
  }
  flick *= boot

  var bandY = mix(-1.1, 1.1, frac(t / HOLO_BAND_MS))
  var band2Y = mix(1.1, -1.1, frac(t / 3100 + 0.3))
  var bandK = scanning ? 1 : (ok ? 1 - seg(rt, 0, 300) : 1)
  var ringY = ok ? mix(HOLO_CY - 0.86, HOLO_CY + 0.8, easeInOutCubic(seg(rt, 150, 700))) : -9
  var ringK = ok ? bump(rt, 150, 760) : 0
  var ring2Y = ok ? mix(HOLO_CY + 0.8, HOLO_CY - 0.86, easeInOutCubic(seg(rt, 350, 900))) : -9
  var ring2K = ok ? bump(rt, 350, 940) : 0
  var solid = ok ? easeOutCubic(seg(rt, 150, 700)) : 0
  var frag = bad ? easeOutCubic(seg(rt, 120, 700)) : 0
  var fragTau = bad ? Math.max(0, rt - 120) / 1000 : 0
  var passFlash = ok ? bump(rt, REC_PASS - 40, REC_PASS + 420) : 0
  var tears = bad ? glitchTears(rt) : []

  // Vertical hold slips: a brief roll every few seconds, forced by a miss.
  var roll = 0
  var rollPh = frac(t / 2600)
  if (scanning && hash(Math.floor(t / 2600) + 5) > 0.55 && rollPh < 0.05) roll = 0.12 * Math.sin(Math.PI * rollPh / 0.05)
  if (bad) roll = 0.16 * bump(rt, 100, 260)

  // Block glitches: rectangles of the image slipped sideways.
  var blocks = []
  var blockOn = bad ? rt < 520 : (scanning && hash(Math.floor(t / 200) + 11) > 0.93)
  if (blockOn) {
    var bs = Math.floor((bad ? rt : t) / 50)
    for (var bi = 0; bi < (bad ? 7 : 2); bi++) {
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

  // Chromatic offset: a foreground copy of the mesh off register.
  var chroma = (scanning ? 1 : (ok ? 1 - seg(rt, 0, 300) : 1 + 4 * bump(rt, 0, 600))) * boot
  var chX = size * 0.006 * chroma * (bad ? 1 + (hash(Math.floor(rt / 40)) - 0.5) : 1)
  var chY = -size * 0.003 * chroma

  function project(P) {
    var xr = P[0] * cyw + P[2] * syw
    var zr = -P[0] * syw + P[2] * cyw
    var yr = P[1] * cp - zr * spp
    var z2 = P[1] * spp + zr * cp
    var s = HOLO_F / (HOLO_F - z2)
    return { x: xr * s, y: yr * s + HOLO_CY + roll, z: z2 }
  }
  function toPx(x, y) { return { x: cx + x * R, y: cy + y * R } }
  function glitchX(x, y) {
    return (bad ? tearShift(tears, y) : 0) + blockShift(x, y)
  }
  function bandBoost(y) {
    var a = 0
    var d1 = Math.abs(y - bandY)
    if (d1 < 0.09) a += 0.45 * (1 - d1 / 0.09) * bandK
    var d2 = Math.abs(y - band2Y)
    if (d2 < 0.04) a += 0.3 * (1 - d2 / 0.04) * bandK
    if (ringK > 0) { var r1 = Math.abs(y - ringY); if (r1 < 0.1) a += 0.5 * (1 - r1 / 0.1) * ringK }
    if (ring2K > 0) { var r2 = Math.abs(y - ring2Y); if (r2 < 0.1) a += 0.4 * (1 - r2 / 0.1) * ring2K }
    return a
  }

  var halo = pen(ctx)
  var crisp = pen(ctx)
  function flush() { halo.flush(); crisp.flush() }

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
    // Features slide with the turn, which is what reads as a head at 24 px.
    var turn = bad ? 0 : Math.sin(mrot) * R * 0.16
    var fy = cy - R * 0.08
    for (var me = -1; me <= 1; me += 2) {
      crisp.line(tint, 0.95, mw, cx + turn + me * R * 0.3 - R * 0.08, fy - R * 0.14, cx + turn + me * R * 0.3 + R * 0.08, fy - R * 0.14)
    }
    crisp.line(tint, 0.95, mw, cx + turn - R * 0.2, fy + R * 0.3, cx + turn + R * 0.2, fy + R * 0.3)
    crisp.line(tint, 0.9, mw, cx - R * 0.5, cy + R * 0.86, cx + R * 0.5, cy + R * 0.86)
    if (ok) {
      var mh = bump(rt, 40, 520)
      if (mh > 0.01) crisp.arc(tint, mh * 0.7, Math.max(1, size * 0.04), cx, cy, R * mix(0.84, 1.08, easeOutCubic(seg(rt, 40, 520))), 0, TAU)
    }
    crisp.flush()
    return
  }

  var EY = 0.9
  var erx = 0.46
  var ery = 0.07
  var outlineW = function (y) {
    return Math.sqrt(HOLO_A * HOLO_A * cyw * cyw + HOLO_C * HOLO_C * syw * syw) * holoTaper(y - HOLO_CY)
  }

  // --- scanlines and a fine backplate grid --------------------------------------
  if (!compact) {
    var lines = 48
    for (var li = 0; li < lines; li++) {
      var ly = ((li + 0.5) / lines) * 2 - 1
      var half = Math.sqrt(Math.max(0, 1 - ly * ly))
      if (half <= 0.05) continue
      crisp.line(ROLE_FG, (li % 4 === 0 ? 0.05 : 0.03) * boot, fine, cx - half * R, cy + ly * R, cx + half * R, cy + ly * R)
    }
    for (var gv = -4; gv <= 4; gv++) {
      var gx = gv * 0.22
      var gh = Math.sqrt(Math.max(0, 1 - gx * gx))
      crisp.line(ROLE_FG, 0.03 * boot, fine, cx + gx * R, cy - gh * R, cx + gx * R, cy + gh * R)
    }
    var rollL = mix(-1, 1, frac(t / 900))
    var rh = Math.sqrt(Math.max(0, 1 - rollL * rollL))
    crisp.line(tint, 0.12 * flick * (1 - solid), hair, cx - rh * R, cy + rollL * R, cx + rh * R, cy + rollL * R)
    if (roll > 0.005) {
      var tearY = cy + (0.95 - roll * 4) * R
      crisp.line(tint, 0.5, hair, cx - R * 0.95, tearY, cx + R * 0.95, tearY)
    }
    // Circular frame with a fine graduated scale.
    crisp.arc(ROLE_FG, 0.16 * boot, fine, cx, cy, R * 1.02, 0, TAU)
    for (var gt = 0; gt < 120; gt++) {
      var ga = gt * TAU / 120
      var goff = Math.abs(((ga % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4)
      if (goff < 0.3) continue
      var gl = R * (gt % 10 === 0 ? 0.05 : (gt % 5 === 0 ? 0.03 : 0.015))
      crisp.line(tint, (gt % 10 === 0 ? 0.4 : 0.2) * boot, fine,
        cx + Math.cos(ga) * R * 1.02, cy + Math.sin(ga) * R * 1.02, cx + Math.cos(ga) * (R * 1.02 + gl), cy + Math.sin(ga) * (R * 1.02 + gl))
    }
    // Yaw index riding the frame.
    var yi = -Math.PI / 2 + clamp(yaw * 1.4, -0.45, 0.45)
    chevron(crisp, tint, 0.85 * boot, thin, cx, cy, yi, R * 0.97, R * 0.05, 0.08)
    crisp.flush()
  }

  // --- the outer cage, turning against the mask -----------------------------------
  if (!compact) {
    var cageRot = t / 9000 * TAU
    if (ok) cageRot = t0 / 9000 * TAU + TAU * 0.6 * easeInOutCubic(seg(rt, 0, 600))
    if (bad) cageRot = t0 / 9000 * TAU + (hash(Math.floor(rt / 50) + 2) - 0.5) * 0.5 * (1 - seg(rt, 400, 700))
    var cageS = ok ? mix(1, 0.9, easeInOutCubic(seg(rt, 300, 750))) : 1
    var cageA = (ok ? 1 - 0.65 * easeInOutCubic(seg(rt, 400, 800)) : (bad ? 1 - 0.7 * frag : 1)) * flick
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
          al.push((0.05 + 0.32 * front * front) * cageA * (dashed && i % 2 ? 0 : 1))
        }
        strip(crisp, tint, fine, pts, al)
      }
      for (var cm = 0; cm < 12; cm++) {
        var ph = cm * TAU / 12
        var mer = []
        for (var cv = 0; cv <= 18; cv++) {
          var vv = mix(-1.35, 1.35, cv / 18)
          mer.push([CA * Math.cos(vv) * Math.sin(ph), CB * Math.sin(vv), CA * Math.cos(vv) * Math.cos(ph)])
        }
        cageLine(mer, bad && frag > 0.3)
      }
      for (var cpl = -2; cpl <= 2; cpl++) {
        var pv = cpl * 0.5
        var par = []
        for (var cu = 0; cu <= 36; cu++) {
          var uu = cu / 36 * TAU
          par.push([CA * Math.cos(pv) * Math.sin(uu), CB * Math.sin(pv), CA * Math.cos(pv) * Math.cos(uu)])
        }
        cageLine(par, bad && frag > 0.3)
      }
      crisp.flush()
    }
  }

  // --- emitter, volumetric cone, projection beams ---------------------------------
  var ePulse = 0.5 + 0.5 * Math.sin(t / 420)
  var eA = (0.55 + 0.25 * passFlash) * boot * (bad ? mix(1, 0.4, frag) : 1)
  var ring = []
  for (var ei = 0; ei <= 32; ei++) {
    var ea = ei / 32 * TAU
    ring.push([cx + Math.cos(ea) * erx * R, cy + (EY + Math.sin(ea) * ery) * R])
  }
  if (bad) {
    for (var ed = 0; ed < 32; ed += 2) {
      if (hash(Math.floor(rt / 60) * 3 + ed) < frag * 0.7) continue
      crisp.line(tint, eA, thin, ring[ed][0], ring[ed][1], ring[ed + 1][0], ring[ed + 1][1])
    }
  } else {
    halo.poly(tint, eA * 0.16, thin * 3.6, ring)
    crisp.poly(tint, eA, thin, ring)
  }
  for (var ec = 1; ec <= 2; ec++) {
    var er = erx * (ec === 1 ? 0.72 + 0.04 * ePulse : 0.45)
    var inner = []
    for (var ej = 0; ej <= 28; ej++) {
      var ea2 = ej / 28 * TAU
      inner.push([cx + Math.cos(ea2) * er * R, cy + (EY + Math.sin(ea2) * ery * er / erx) * R])
    }
    crisp.poly(tint, eA * (ec === 1 ? 0.55 : 0.35), fine, inner)
  }
  if (!compact) {
    // Emitter ticks turning around the base.
    var etr = t / 3000 * TAU
    for (var et = 0; et < 32; et++) {
      var eta = etr + et * TAU / 32
      var ex0 = cx + Math.cos(eta) * erx * R, ey0 = cy + (EY + Math.sin(eta) * ery) * R
      var ex1 = cx + Math.cos(eta) * erx * 1.08 * R, ey1 = cy + (EY + Math.sin(eta) * ery * 1.08) * R
      if (Math.sin(eta) < -0.2) continue
      crisp.line(tint, eA * 0.6, fine, ex0, ey0, ex1, ey1)
    }
    var coneA = 0.09 * flick * (bad ? 1 - frag : 1)
    var topY = HOLO_CY + 0.1
    var tw = outlineW(topY) * 0.98
    crisp.line(tint, coneA, hair, cx - erx * R, cy + EY * R, cx - tw * R, cy + topY * R)
    crisp.line(tint, coneA, hair, cx + erx * R, cy + EY * R, cx + tw * R, cy + topY * R)
    // Volume slices through the cone.
    for (var vs = 1; vs <= 5; vs++) {
      var vk = vs / 6
      var vy = mix(EY, topY + 0.25, vk)
      var vr = mix(erx, tw * 0.9, vk)
      var sl = []
      for (var vj = 0; vj <= 24; vj++) {
        var va = vj / 24 * TAU
        sl.push([cx + Math.cos(va) * vr * R, cy + (vy + Math.sin(va) * ery * 0.7) * R])
      }
      crisp.poly(tint, coneA * 0.55, fine, sl)
    }
    // Pulse rings travelling up the cone.
    var pSpeed = ok ? 2.5 : 1
    for (var pr = 0; pr < 3; pr++) {
      var pph = frac((ok ? t0 + rt * pSpeed : t) / 1500 + pr / 3)
      var pry = mix(EY, topY + 0.1, pph)
      var prr = mix(erx, tw, pph)
      var pa = 0.3 * Math.sin(Math.PI * pph) * flick * (bad ? 1 - frag : 1) * (ok ? 1 - seg(rt, 600, 900) : 1)
      if (pa <= 0.02) continue
      var pp = []
      for (var pj = 0; pj <= 24; pj++) {
        var pa2 = pj / 24 * TAU
        pp.push([cx + Math.cos(pa2) * prr * R, cy + (pry + Math.sin(pa2) * ery * 0.8) * R])
      }
      crisp.poly(tint, pa, fine, pp)
    }
    // Motes rising through the cone.
    var moteSpeed = ok ? 1 + 3 * seg(rt, 0, 300) : 1
    var moteA = ok ? 1 - seg(rt, 350, 700) : (bad ? 1 - frag : 1)
    for (var mo = 0; mo < 40; mo++) {
      var mph = frac((ok ? t0 + rt * moteSpeed : t) / (1400 + 600 * hash(mo * 5.3)) + hash(mo * 1.7))
      if (bad) mph = frac(t0 / 1700 + hash(mo * 1.7)) - 0.4 * fragTau
      var my = EY - mph * 1.55
      var mx = (hash(mo * 3.1) - 0.5) * mix(erx * 2, 1.1, mph)
      var ma2 = 0.55 * Math.sin(Math.PI * clamp01(mph)) * moteA * flick
      if (ma2 <= 0.02) continue
      crisp.line(tint, ma2, fine, cx + mx * R, cy + my * R, cx + mx * R, cy + (my + 0.03) * R)
    }
  }
  flush()

  // --- the mask ------------------------------------------------------------------
  var mesh = holoMesh(compact)
  var baseA = mix(0.7, 1, solid)
  var mw2 = compact ? Math.max(1, size * 0.018) : fine * 1.3
  for (var ln = 0; ln < mesh.length; ln++) {
    var L = mesh[ln]
    var pts = [], al = [], cpts = [], cal = []
    for (var sj = 0; sj < L.length; sj++) {
      var Q = project(L[sj])
      var x0 = Q.x, y0 = Q.y
      if (bad && frag > 0) {
        // Vertices detach and drift outward under drag.
        var sid = ln * 31 + sj
        var nl = Math.hypot(x0, y0 - HOLO_CY) || 0.001
        var sp2 = 0.55 * (0.4 + hash(sid))
        x0 += dragOffset(sp2 * x0 / nl, fragTau, 3.5)
        y0 += dragOffset(sp2 * (y0 - HOLO_CY) / nl, fragTau, 3.5) + dragOffset(0.1, fragTau, 2)
      }
      var dx = glitchX(x0, y0)
      if (bandK > 0 && Math.abs(y0 - bandY) < 0.09) dx += (hash(Math.floor(t / 60) * 7 + ln) - 0.5) * 0.06 * bandK
      var PX = toPx(x0 + dx, y0)
      pts.push(PX)
      cpts.push({ x: PX.x + chX, y: PX.y + chY })
      var da = clamp01((Q.z + 0.12) / 0.62)
      var a = baseA * (0.1 + 0.9 * Math.pow(da, 1.2)) * flick + bandBoost(y0) * boot
      if (bad && frag > 0 && hash(ln * 31 + sj + 5) < frag * 0.35) a = 0
      al.push(a)
      cal.push(a * 0.35)
    }
    // The offset copy rides every other slice; that is enough to read as
    // colour fringing at a fraction of the cost.
    if (!compact && chroma > 0.02 && ln < HOLO_SLICES && ln % 2 === 0) strip(crisp, ROLE_FG, fine, cpts, cal)
    strip(crisp, tint, mw2, pts, al)
  }
  crisp.flush()

  // Iso-depth contours: the relief as a topographic map on the mask.
  if (!compact) {
    var topo = holoContours()
    for (var ts = 0; ts < topo.segs.length; ts++) {
      var S = topo.segs[ts]
      var A0 = project([S[0], S[1], S[4]]), B0 = project([S[2], S[3], S[4]])
      var casc = ok ? bump(rt, 250 + (topo.levels - S[5]) * 45, 600 + (topo.levels - S[5]) * 45) : 0
      var ca = (0.22 + 0.6 * casc + 0.18 * solid) * flick * clamp01((A0.z + 0.1) / 0.5) + bandBoost(A0.y) * 0.5
      if (bad && hash(ts * 3 + 1) < frag) continue
      var ax = A0.x + glitchX(A0.x, A0.y), bx = B0.x + glitchX(B0.x, B0.y)
      var AP = toPx(ax, A0.y), BP = toPx(bx, B0.y)
      crisp.line(tint, ca, fine, AP.x, AP.y, BP.x, BP.y)
    }
    crisp.flush()
  }

  // Vertex cloud: flares as the lock starts, then fuses into the mesh.
  if (!compact) {
    var cloud = holoPoints()
    var cloudA = ok ? (1 + bump(rt, 150, 400)) * (1 - easeInOutCubic(seg(rt, 450, 800))) : (bad ? 1 - 0.5 * frag : 1)
    if (cloudA > 0.01) {
      var dsz = Math.max(1, size * 0.0065)
      for (var cpi = 0; cpi < cloud.length; cpi++) {
        var cpt = cloud[cpi]
        var CQ = project(cpt.P)
        if (CQ.z < -0.05) continue
        var cxq = CQ.x, cyq = CQ.y
        if (bad) {
          cxq += dragOffset((cpt.j - 0.5) * 0.9, fragTau, 3) + glitchX(cxq, cyq)
          cyq += dragOffset((cpt.k - 0.3) * 0.6, fragTau, 3)
        }
        var shimmer = 0.5 + 0.5 * Math.sin(t / 180 + cpt.j * 40)
        var pa3 = (0.25 + 0.35 * shimmer + bandBoost(cyq)) * clamp01((CQ.z + 0.1) / 0.55) * cloudA * flick
        if (pa3 <= 0.02) continue
        var CP = toPx(cxq, cyq)
        ctx.fillStyle = rgba(tint, pa3)
        ctx.fillRect(CP.x - dsz / 2, CP.y - dsz / 2, dsz, dsz)
      }
    }
  }

  // Silhouette. It carries the face at the small slot.
  var outline = [], choutline = []
  for (var oi = 0; oi <= 48; oi++) {
    var oa = oi / 48 * TAU
    var oy2 = Math.sin(oa) * HOLO_B * (1 + 0.02 * Math.cos(oa))
    var ox2 = Math.cos(oa) * outlineW(oy2 + HOLO_CY)
    var oyy = oy2 + HOLO_CY + roll
    ox2 += glitchX(ox2, oyy)
    var OP = toPx(ox2, oyy)
    outline.push([OP.x, OP.y])
    choutline.push([OP.x + chX * 1.5, OP.y + chY * 1.5])
  }
  var outA = (0.5 + 0.35 * solid + 0.15 * passFlash) * flick * (bad ? 1 - 0.6 * frag : 1)
  if (!compact && chroma > 0.02) crisp.poly(ROLE_FG, outA * 0.3, fine, choutline)
  if (bad && frag > 0.05) {
    for (var od = 0; od < 48; od += 2) crisp.line(tint, outA, thin, outline[od][0], outline[od][1], outline[od + 1][0], outline[od + 1][1])
  } else {
    halo.poly(tint, outA * 0.16, thin * 3.6, outline)
    crisp.poly(tint, outA, thin, outline)
  }

  flush()

  // --- orbit rings ------------------------------------------------------------------
  if (!compact) {
    var orbits = [[0.95, 0.45, t / 5000 * TAU], [0.88, -0.5, -t / 7000 * TAU]]
    for (var ob = 0; ob < orbits.length; ob++) {
      var O = orbits[ob]
      var orad = O[0], tilt = O[1], orot = O[2]
      var oA = flick * 0.75
      if (ok) {
        // Both orbits level out and settle as a halo at eye height.
        var ok2 = easeInOutCubic(seg(rt, 150, 600))
        tilt = mix(tilt, 0, ok2)
        orad = mix(orad, ob ? 0.7 : 0.76, ok2)
        oA *= 1 - 0.45 * seg(rt, 550, 850)
      }
      if (bad) {
        tilt += (hash(Math.floor(rt / 60) * 5 + ob) - 0.5) * 0.8 * (1 - frag * 0.5)
        oA *= 1 - frag * 0.8
      }
      if (oA <= 0.02) continue
      var ct = Math.cos(tilt), stl = Math.sin(tilt)
      var opts = [], oal = []
      var nodes = []
      for (var oj = 0; oj <= 56; oj++) {
        var oa2 = oj / 56 * TAU + orot
        var X3 = Math.cos(oa2) * orad, Z3 = Math.sin(oa2) * orad
        var Y3 = -Z3 * stl, Zt = Z3 * ct
        var OQ = project([X3, Y3 + 0.05, Zt])
        opts.push(toPx(OQ.x + glitchX(OQ.x, OQ.y), OQ.y))
        oal.push((oj % 2 ? 0 : 1) * oA * (0.2 + 0.8 * clamp01((Zt + orad) / (2 * orad))))
      }
      strip(crisp, tint, fine * 1.3, opts, oal)
      for (var nd = 0; nd < 3; nd++) {
        if (ok && seg(rt, 150, 600) >= 1 && nd > 0) break
        var na = t / (1800 + ob * 700) * TAU * (ob ? -1 : 1) + nd * TAU / 3
        var NX = Math.cos(na) * orad, NZ = Math.sin(na) * orad
        var NQ = project([NX, -NZ * stl + 0.05, NZ * ct])
        var NP = toPx(NQ.x, NQ.y)
        var nds = R * 0.024
        var front = clamp01((NZ * ct + orad) / (2 * orad))
        var ndia = [[NP.x, NP.y - nds], [NP.x + nds, NP.y], [NP.x, NP.y + nds], [NP.x - nds, NP.y], [NP.x, NP.y - nds]]
        halo.poly(tint, oA * 0.2 * front, thin * 3, ndia)
        crisp.poly(tint, oA * (0.3 + 0.7 * front), hair, ndia)
      }
    }
    halo.flush()
    crisp.flush()
  }

  // --- side scopes: the face's depth profile at the right, scan height at the left ----
  if (hud) {
    var sx0 = R * 0.7
    var sy0 = HOLO_CY - 0.62, sy1 = HOLO_CY + 0.62
    var sA = (bad ? 1 - 0.6 * frag : 1) * boot
    crisp.line(ROLE_FG, 0.3 * sA, fine, cx + sx0, cy + sy0 * R, cx + sx0, cy + sy1 * R)
    for (var sk = 0; sk <= 12; sk++) {
      var sky = cy + mix(sy0, sy1, sk / 12) * R
      crisp.line(ROLE_FG, 0.3 * sA, fine, cx + sx0, sky, cx + sx0 + R * (sk % 3 === 0 ? 0.03 : 0.015), sky)
    }
    var prof = [], pal = []
    for (var sp = 0; sp <= 30; sp++) {
      var py = mix(-0.6, 0.6, sp / 30)
      var pz = holoZAt(0, py) * (bad ? 1 + (hash(Math.floor(rt / 40) * 31 + sp) - 0.5) * 0.5 * (1 - frag) : 1)
      prof.push({ x: cx + sx0 + pz * R * 0.34, y: cy + (py + HOLO_CY) * R })
      pal.push((0.55 + bandBoost(py + HOLO_CY)) * sA * flick)
    }
    strip(crisp, tint, fine * 1.5, prof, pal)
    var mk = scanning ? bandY : (ok ? mix(bandY, HOLO_CY, seg(rt, 0, 300)) : bandY)
    if (mk > sy0 && mk < sy1) {
      var mz = holoZAt(0, mk - HOLO_CY)
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

  // --- landmarks, beams, scanner rings and result gestures ------------------------------
  var NS = holoNodes()
  var lmPx = []
  for (var lm = 0; lm < NS.nodes.length; lm++) {
    var LP = project(NS.nodes[lm].P)
    lmPx.push({ p: toPx(LP.x + glitchX(LP.x, LP.y), LP.y), y: LP.y, z: LP.z })
  }
  if (!compact) {
    // Projection beams from the emitter to the landmarks and the limb.
    var beamA = (ok ? 1 + 2.5 * bump(rt, 520, 780) : (bad ? 1 - frag : 1)) * flick
    if (beamA > 0.02) {
      for (var bm = 0; bm < 24; bm++) {
        var bea = bm / 24 * Math.PI
        var bx0 = cx + Math.cos(bea) * erx * R * (bm % 2 ? 1 : 0.7), by0 = cy + (EY + Math.sin(bea) * ery) * R
        var target = bm < lmPx.length ? lmPx[(bm * 7) % lmPx.length].p : toPx((bm % 2 ? 1 : -1) * outlineW(HOLO_CY) * 0.95, HOLO_CY)
        var bfl = 0.6 + 0.4 * hash(Math.floor(t / 90) * 13 + bm)
        crisp.line(tint, 0.06 * bfl * beamA, fine, bx0, by0, target.x, target.y)
      }
      crisp.flush()
    }
    if (scanning) {
      for (var sl2 = 0; sl2 < lmPx.length; sl2++) {
        var bd2 = Math.abs(lmPx[sl2].y - bandY)
        var sh = clamp01(1 - bd2 / 0.16) * boot
        if (sh <= 0.02 || lmPx[sl2].z < 0) continue
        var ds = R * 0.028
        var C0 = lmPx[sl2].p
        crisp.poly(tint, sh * 0.9, hair, [[C0.x, C0.y - ds], [C0.x + ds, C0.y], [C0.x, C0.y + ds], [C0.x - ds, C0.y], [C0.x, C0.y - ds]])
      }
    } else if (ok) {
      var lockK = []
      for (var rl = 0; rl < lmPx.length; rl++) {
        var lockAt = 280 + NS.nodes[rl].order * 55
        lockK.push(lmPx[rl].z < -0.05 ? 0 : seg(rt, lockAt, lockAt + REC_LOCK_LEN))
      }
      // The solver lattice draws out on the surface between locked nodes.
      for (var ge = 0; ge < NS.edges.length; ge++) {
        var E = NS.edges[ge]
        var ek = easeInOutCubic(Math.min(lockK[E[0]], lockK[E[1]]))
        if (ek <= 0.01) continue
        var GA = lmPx[E[0]].p, GB = lmPx[E[1]].p
        var gmx = (GA.x + GB.x) / 2, gmy = (GA.y + GB.y) / 2
        crisp.line(tint, 0.35 + 0.2 * passFlash, fine * 1.3, gmx, gmy, mix(gmx, GA.x, ek), mix(gmy, GA.y, ek))
        crisp.line(tint, 0.35 + 0.2 * passFlash, fine * 1.3, gmx, gmy, mix(gmx, GB.x, ek), mix(gmy, GB.y, ek))
      }
      for (var rl2 = 0; rl2 < lmPx.length; rl2++) drawLockReticle(halo, crisp, tint, lmPx[rl2].p, lockK[rl2], R, hair, thin, passFlash)
      var scanRings = [[ringY, ringK, 1.1], [ring2Y, ring2K, 1.04]]
      for (var sr2 = 0; sr2 < scanRings.length; sr2++) {
        var SRy = scanRings[sr2][0], SRk = scanRings[sr2][1]
        if (SRk <= 0.01) continue
        var rw = outlineW(SRy) * scanRings[sr2][2]
        var rp = []
        for (var ri = 0; ri <= 32; ri++) {
          var ra = ri / 32 * TAU
          rp.push([cx + Math.cos(ra) * rw * R, cy + (SRy + Math.sin(ra) * 0.07) * R])
        }
        halo.poly(tint, SRk * 0.2, bold * 3, rp)
        crisp.poly(tint, SRk * 0.9, thin, rp)
      }
      var wave = bump(rt, REC_WAVE[0], REC_WAVE[1])
      if (wave > 0.01) {
        var wk = easeOutCubic(seg(rt, REC_WAVE[0], REC_WAVE[1]))
        var wp = []
        for (var wi = 0; wi <= 32; wi++) {
          var wa2 = wi / 32 * TAU
          wp.push([cx + Math.cos(wa2) * mix(erx, 1.05, wk) * R, cy + (EY + Math.sin(wa2) * mix(ery, 0.2, wk)) * R])
        }
        halo.poly(tint, wave * 0.12, bold * 3, wp)
        crisp.poly(tint, wave * 0.6, thin, wp)
      }
    } else {
      for (var bl = 0; bl < lmPx.length; bl += 2) {
        var bo = NS.nodes[bl].order
        var bk = seg(rt, 60 + bo * 30, 300 + bo * 30)
        if (bk <= 0) continue
        var lost = easeOutCubic(seg(rt, 300 + bo * 30, 800))
        var shake = (1 - bk) * R * 0.04
        drawLostTrack(crisp, lmPx[bl].p.x + Math.sin(rt / 23 + bl) * shake, lmPx[bl].p.y + Math.cos(rt / 29 + bl * 2) * shake,
          R, lost, clamp01(bk * 2) * (0.85 - 0.45 * lost), hair, bl)
      }
      var ew = bump(rt, 0, 340)
      if (ew > 0.01) crisp.arc(ROLE_ERROR, ew * 0.6, Math.max(1, size * 0.018), cx, cy, R * mix(0.1, 1.05, easeOutCubic(seg(rt, 0, 340))), 0, TAU)
      drawTears(crisp, tears, cx, cy, R)
      // Static while the projection fails.
      var noiseK = 1 - seg(rt, 350, 800)
      if (noiseK > 0) {
        var nstep = Math.floor(rt / 40)
        for (var nz = 0; nz < 80; nz++) {
          var nr = Math.sqrt(hash(nstep * 131 + nz)) * R
          var na = hash(nstep * 71 + nz * 3) * TAU
          var nx = cx + Math.cos(na) * nr, ny = cy + Math.sin(na) * nr
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

  if (hud) paintHoloReadouts(crisp, size, state, t, rt, boot, tint, yaw, pitch, flick)
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
  readTopLeft(p, g, size, t, bad ? ROLE_ERROR : ROLE_FG, (deg < -0.05 ? "-" : " ") + digits + "." + (tenths % 10))

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

// The styles are authored on a 1150 ms lock and a 900 ms miss. Results are
// played slower than authored so each beat of the sequence reads; the entry
// clock is kept, so every result still eases out of the pose it began from.
var AUTHORED_HOLD = { recognized: 1150, notRecognized: 900 }

function paintInto(ctx, size, spec) {
  var style = resolveStyle(spec)
  var authored = AUTHORED_HOLD[spec.state]
  var s = spec
  if (authored) {
    var k = authored / holdMs(spec.state)
    var rt = spec.elapsed || 0
    s = { state: spec.state, clock: (spec.clock || 0) - rt + rt * k, elapsed: rt * k }
  }
  if (style === "radar") paintRadar(ctx, size, s)
  else if (style === "holo") paintHolo(ctx, size, s)
  else paintHud(ctx, size, s)
}

// How long the host should hold each state before it tears the card down.
// This is the cost of the result sequence, well under the host's 2 s clamp.
// Clipping it cuts the confirmation off before the instrument has settled.
function holdMs(state) {
  if (state === "recognized") return 1500
  if (state === "notRecognized") return 1200
  return 0
}

// --- the value-spec boundary ------------------------------------------------

// Stands in for a 2D context so the drawing code above is unchanged, and
// records what it would have drawn instead of drawing it.
function recorder() {
  var ops = []
  var cmds = null
  var stack = []
  var st = { stroke: [ROLE_ACCENT, 1], fill: [ROLE_ACCENT, 1], width: 1 }

  var rec = {
    ops: ops,
    reset: function () { ops.length = 0; cmds = null },
    save: function () { stack.push({ stroke: st.stroke, fill: st.fill, width: st.width }) },
    restore: function () { var p = stack.pop(); if (p) st = p },
    beginPath: function () { cmds = [] },
    moveTo: function (x, y) { if (cmds) cmds.push([0, x, y]) },
    lineTo: function (x, y) { if (cmds) cmds.push([1, x, y]) },
    quadraticCurveTo: function (cx, cy, x, y) { if (cmds) cmds.push([2, cx, cy, x, y]) },
    arc: function (cx, cy, r, a0, a1) { if (cmds) cmds.push([3, cx, cy, r, a0, a1]) },
    stroke: function () {
      if (cmds && cmds.length) ops.push([OP_PATH, st.stroke[0], st.stroke[1], st.width, cmds])
      cmds = null
    },
    fillRect: function (x, y, w, h) {
      if (st.fill && st.fill.__grad) {
        var g = st.fill
        ops.push([OP_GRAD, g.role, g.from, g.to, x, y, w, h, g.y0, g.y1])
      } else {
        ops.push([OP_RECT, st.fill[0], st.fill[1], x, y, w, h])
      }
    },
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
  return rec
}

// One frame as data. Numbers and small arrays of numbers, nothing else.
function frame(size, spec) {
  var rec = recorder()
  paintInto(rec, size, spec)
  return rec.ops
}
