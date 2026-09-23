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

// When each feature group stops drifting and locks onto its home.
function recLock(kind) {
  if (kind === "eyeL" || kind === "eyeR") return [170, 330]
  if (kind === "mouth") return [250, 410]
  if (kind === "rim") return [320, 480]
  return [200, 430]
}

// When each group's dots shrink out, handing that feature to the wireframe.
function recDissolve(kind) {
  if (kind === "skin") return [420, 610]
  if (kind === "eyeL" || kind === "eyeR") return [470, 650]
  if (kind === "mouth") return [510, 690]
  if (kind === "rim") return [540, 730]
  return [380, 570]
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
  var key = "p" + seed
  if (CACHE[key]) return CACHE[key]

  var rnd = mulberry32(seed)
  var ps = []

  function push(kind, hx, hy, extra) {
    var p = {
      kind: kind,
      hx: hx,
      hy: hy,
      z: depthAt(hx, hy),
      sa: rnd(),
      sb: rnd(),
      sc: rnd(),
      u: 0,
      ex: 0,
      ey: 0,
      n1: -1,
      n2: -1
    }
    if (extra) for (var k in extra) p[k] = extra[k]
    ps.push(p)
  }

  var i, n, a

  n = 92
  for (i = 0; i < n; i++) {
    a = (i / n) * Math.PI * 2
    push("rim", Math.cos(a) * RIM_R, Math.sin(a) * RIM_R)
  }

  var eyes = [[EYE_L, "eyeL"], [EYE_R, "eyeR"]]
  for (var e = 0; e < 2; e++) {
    // Hollow iris rings, not filled discs. A dense eye cluster locks into a
    // solid blob, and two blobs over a bar is a cartoon face.
    var rings = [[0.55, 5], [1.3, 12]]
    for (var ri = 0; ri < rings.length; ri++) {
      var rr = rings[ri][0] * EYE_R_IN
      var rc = rings[ri][1]
      for (i = 0; i < rc; i++) {
        a = (i / rc) * Math.PI * 2 + ri * 0.4
        var ox = Math.cos(a) * rr
        var oy = Math.sin(a) * rr
        push(eyes[e][1], eyes[e][0] + ox, EYE_Y + oy, { ex: ox, ey: oy })
        ps[ps.length - 1].z = depthAt(eyes[e][0], EYE_Y) - 0.22
      }
    }
  }

  // Sparse enough to stay a dotted measurement line when it locks, rather
  // than fusing into a solid bar.
  n = 15
  for (i = 0; i < n; i++) {
    var u = (i / (n - 1)) * 2 - 1
    push("mouth", u * MOUTH_HALF, MOUTH_Y + MOUTH_CURVE * (1 - u * u), { u: u })
    ps[ps.length - 1].z = depthAt(u * MOUTH_HALF, MOUTH_Y) - 0.10
  }

  // Depth-map surface. Feature zones are carved out so the eyes and mouth stay
  // legible when the whole card shrinks to the in-field indicator size.
  var ringDefs = [[0.20, 7], [0.35, 11], [0.50, 15], [0.63, 18], [0.73, 20]]
  for (var rd = 0; rd < ringDefs.length; rd++) {
    var radius = ringDefs[rd][0]
    var count = ringDefs[rd][1]
    var jitter = rnd() * Math.PI * 2
    for (i = 0; i < count; i++) {
      a = (i / count) * Math.PI * 2 + jitter
      var sx = Math.cos(a) * radius
      var sy = Math.sin(a) * radius
      if (inEye(sx, sy, 0.055) || inMouth(sx, sy, 0.02)) continue
      push("skin", sx, sy)
    }
  }

  n = 44
  for (i = 0; i < n; i++) {
    a = rnd() * Math.PI * 2
    var fr = 0.98 + rnd() * 0.62
    push("field", Math.cos(a) * fr, Math.sin(a) * fr * 0.82)
    ps[ps.length - 1].z = 0.10 + rnd() * 0.22
  }

  // Static mesh topology, resolved once. Per-frame nearest-neighbour search
  // would be quadratic every tick and is not needed: the homes never move.
  var face = []
  for (i = 0; i < ps.length; i++) if (ps[i].kind !== "field") face.push(i)
  for (var fi = 0; fi < face.length; fi++) {
    var pi = face[fi]
    var b1 = 9, b2 = 9, i1 = -1, i2 = -1
    for (var fj = 0; fj < face.length; fj++) {
      if (fj === fi) continue
      var pj = face[fj]
      var d = Math.hypot(ps[pi].hx - ps[pj].hx, ps[pi].hy - ps[pj].hy)
      if (d < b1) { b2 = b1; i2 = i1; b1 = d; i1 = pj }
      else if (d < b2) { b2 = d; i2 = pj }
    }
    ps[pi].n1 = i1
    ps[pi].n2 = i2
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
    var k = easeOutCubic(seg(rt, REC_SETTLE[0], REC_SETTLE[1]))
    return mix(ringAt(ring, t0 + rt * (1 - k)), target, k)
      + spring(rt, REC_SETTLE[1] - 120, 300, 3.2) * 0.05 * (ring % 2 ? -1 : 1)
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

  ctx.reset()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var scanning = !ok && !bad
  var tint = bad ? ROLE_ERROR : ROLE_ACCENT

  // Base stroke weights. Everything scales with the card; the floor keeps
  // hairlines on the pixel grid at the real 116 px slot.
  var hair = Math.max(1, size * 0.0065)
  var thin = Math.max(1, size * 0.009)
  var bold = Math.max(1, size * 0.016)

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
  function toPx(x, y) { return { x: cx + x * R, y: cy + y * R } }

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
      a = acquisition(plane, pr.y)
      if (p.kind === "field") a *= 0.35
    } else if (ok) {
      var lw = recLock(p.kind)
      a = p.kind === "field" ? 0.3 : easeOutCubic(seg(rt, lw[0], lw[1]))
    } else {
      a = 1 - easeOutCubic(seg(rt, 120, 420)) * 0.55
    }

    var wander = 1 - a
    var slack = p.kind === "field" ? 0.150 : (p.kind === "rim" ? 0.055 : 0.105)
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
  var dotBase = Math.max(1, size * (compact ? 0.030 : 0.0215))

  if (!compact) {
    var meshFade = ok ? 1 - easeInOutCubic(seg(rt, 390, 620)) : 1
    if (meshFade > 0.01) {
      for (var mi = 0; mi < P.face.length; mi++) {
        var pi = P.face[mi]
        var pp = ps[pi]
        var nbs = [pp.n1, pp.n2]
        for (var nb = 0; nb < 2; nb++) {
          var nj = nbs[nb]
          if (nj < 0 || nj < pi) continue
          var la2 = Math.min(lit[pi], lit[nj])
          // The mesh never fully disappears: it is the standing structure the
          // scan wake lights up, not something the wake draws from nothing.
          crisp.line(tint, (0.07 + 0.62 * la2) * meshFade * boot, hair,
            pos[pi].x, pos[pi].y, pos[nj].x, pos[nj].y)
        }
      }
      crisp.flush()
    }
  } else if (scanning) {
    crisp.arc(tint, 0.28, Math.max(1, size * 0.018), cx, cy, R * RIM_R, 0, TAU)
    crisp.flush()
  }

  for (var i2 = 0; i2 < ps.length; i2++) {
    var p2 = ps[i2]
    if (compact && p2.kind === "field" && !ok) continue

    var l = lit[i2]
    var zf = 0.55 + 0.75 * p2.z
    var eye = p2.kind === "eyeL" || p2.kind === "eyeR"
    var s = dotBase * zf * (p2.kind === "field" ? 0.72 : (eye ? 0.72 : 1)) * (0.68 + 0.42 * l)
    // The rim and the features carry the face; the depth-map interior is
    // texture behind them. Without this weighting the silhouette dissolves
    // on a light theme, where accent-on-near-white has little contrast.
    var kw = p2.kind === "field" ? 0.46
      : (p2.kind === "skin" ? 0.82 : (p2.kind === "rim" ? 1.12 : 0.98))
    // Floor keeps the silhouette readable between sweeps; the cubed term is
    // the bright crest that rides the scan plane itself.
    var alpha = (0.40 + 0.48 * l + 0.34 * l * l * l) * kw * (0.70 + 0.30 * p2.z)
    if (scanning) alpha *= mix(0.2, 1, boot)

    if (bad && p2.kind !== "field") {
      var reached = clamp01(errWave - Math.hypot(p2.hx, p2.hy))
      alpha *= mix(1, 0.62, reached)
    }
    if (ok) {
      var dw = recDissolve(p2.kind)
      var gone = easeInOutCubic(seg(rt, dw[0], dw[1]))
      if (gone >= 0.998) continue
      alpha *= 1 - gone
      s *= 1 - gone * 0.9
    }

    ctx.fillStyle = rgba(tint, alpha)
    ctx.fillRect(pos[i2].x - s / 2, pos[i2].y - s / 2, s, s)
  }

  // --- landmarks ----------------------------------------------------------------
  var lmPx = []
  var lmLock = []
  for (var lm = 0; lm < LANDMARKS.length; lm++) {
    var L = LANDMARKS[lm]
    var lp = project(L.x * faceScale, L.y * faceScale, (depthAt(L.x, L.y) + L.dz) * DEPTH)
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

      // Eye contours and the rim close out of the dissolving cloud.
      var eyeK = easeOutCubic(seg(rt, 520, 720))
      if (eyeK > 0.01) {
        for (var ey = 0; ey < 2; ey++) {
          var ec = lmPx[ey]
          glowArc(halo, crisp, tint, eyeK * 0.8, thin, ec.x, ec.y, R * EYE_R_IN * 1.35 * eyeK, -Math.PI / 2, -Math.PI / 2 + TAU * eyeK)
        }
      }
      var rimK = easeInOutCubic(seg(rt, 460, 700))
      if (rimK > 0.004) {
        glowArc(halo, crisp, tint, Math.min(1, rimK * 2.4), bold * 0.85, cx, cy, R * RIM_R * faceScale,
          -Math.PI / 2 - Math.PI * rimK, -Math.PI / 2 + Math.PI * rimK)
      }
      flush()
    } else {
      // A miss: the reticles hunt, fail to converge, and lose track.
      for (var bl = 0; bl < lmPx.length; bl++) {
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
    for (var ce = 0; ce < 2; ce++) {
      var cek = easeOutCubic(seg(rt, 555, 720))
      if (cek > 0.01) crisp.arc(tint, cek, Math.max(1, size * 0.036), lmPx[ce].x, lmPx[ce].y, R * EYE_R_IN * cek, 0, TAU)
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

  // --- result flourishes ---------------------------------------------------
  if (ok) {
    var wave = bump(rt, REC_WAVE[0], REC_WAVE[1])
    if (wave > 0.01) {
      var wk = easeOutCubic(seg(rt, REC_WAVE[0], REC_WAVE[1]))
      glowArc(halo, crisp, tint, wave * 0.6, Math.max(1, size * 0.014 * (1 - wk * 0.7)), cx, cy, R * mix(0.80, 1.08, wk), 0, TAU)
      flush()
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
        crisp.arc(ROLE_ERROR, 0.45 * (1 - brk * 0.4), thin, cx, cy, R * (RIM_R + brk * 0.12), bda, bda + 0.24)
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

// --- shared result gestures ---------------------------------------------------

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
// A plan-position scope. The sweep arm refreshes a fixed set of returns laid
// on the face: the rim, two iris rings, the nose and a level mouth line, over
// sparse skin. Returns decay behind the arm but never below a floor, so the
// whole face stays legible at 116 px between sweeps; the first revolution
// after entry paints it in. Returns are range cells, short arcs about the
// scope centre, never smooth outlines, so the face reads as sensor data.

var RADAR_REV_MS = 2400
var RADAR_CLUTTER = 90
var RADAR_FLOOR = 0.2

function radarReturns() {
  if (CACHE.radar) return CACHE.radar
  var rnd = mulberry32(4242)
  var rs = []
  function add(kind, x, y, gain) {
    rs.push({ kind: kind, x: x, y: y, r: Math.hypot(x, y), a: Math.atan2(y, x), gain: gain, j: rnd() })
  }
  var i, a
  for (i = 0; i < 44; i++) {
    a = (i / 44) * TAU
    add("rim", Math.cos(a) * RIM_R, Math.sin(a) * RIM_R, 1)
  }
  for (var e = 0; e < 2; e++) {
    var ex = e === 0 ? EYE_L : EYE_R
    for (i = 0; i < 7; i++) {
      a = (i / 7) * TAU + 0.3
      add("eye", ex + Math.cos(a) * 0.105, EYE_Y + Math.sin(a) * 0.085, 0.95)
    }
  }
  add("nose", 0, -0.07, 0.7)
  add("nose", 0, 0.03, 0.75)
  add("nose", -0.05, 0.12, 0.7)
  add("nose", 0.05, 0.12, 0.7)
  for (i = 0; i < 9; i++) {
    var u = (i / 8) * 2 - 1
    add("mouth", u * MOUTH_HALF * 0.9, MOUTH_Y, 0.9)
  }
  var n = 0
  while (n < 30) {
    var sx = (rnd() * 2 - 1) * 0.7
    var sy = (rnd() * 2 - 1) * 0.72
    if (Math.hypot(sx, sy) > 0.7 || inEye(sx, sy, 0.06) || inMouth(sx, sy, 0.03)) continue
    add("skin", sx, sy, 0.38)
    n++
  }
  CACHE.radar = rs
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

function paintRadar(ctx, size, spec) {
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
  var tint = bad ? ROLE_ERROR : ROLE_ACCENT

  var hair = Math.max(1, size * 0.0065)
  var thin = Math.max(1, size * 0.009)
  var bold = Math.max(1, size * 0.016)

  var boot = scanning ? easeOutCubic(seg(rt, 0, BOOT_MS)) : 1
  var sweepU = radarSweep(state, t, rt)
  var arm = sweepU - Math.PI / 2
  // Everything the arm has passed since this state was entered.
  var swept = scanning ? rt / RADAR_REV_MS * TAU : TAU

  var armK = scanning ? boot : (ok ? 1 - easeOutCubic(seg(rt, 420, 680)) : mix(1, 0.45, seg(rt, 300, 700)))
  var holdK = ok ? easeOutCubic(seg(rt, 150, 500)) : 0
  var smearK = bad ? easeOutCubic(seg(rt, 120, 520)) : 0
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
    var mArm = ok ? (t - rt) / RADAR_REV_MS * TAU - Math.PI / 2 : arm
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

  // --- graticule --------------------------------------------------------------
  var wob = function (i) { return bad && rt < 420 ? 1 + (hash(Math.floor(rt / 60) * 3 + i) - 0.5) * 0.06 : 1 }
  var ringDraw = TAU * seg(boot, 0, 0.9)
  var breathe = 1 + 0.008 * Math.sin(t / 900)
  var lockRing = ok ? easeInOutCubic(seg(rt, 300, 650)) : 0
  if (!compact) {
    crisp.arc(ROLE_FG, 0.11 * boot, hair, cx, cy, R * 0.33 * breathe * wob(1), -Math.PI / 2, -Math.PI / 2 + ringDraw)
    var r2 = R * mix(0.66 * breathe, 0.9, lockRing) * wob(2)
    glowArc(halo, crisp, lockRing > 0 ? tint : ROLE_FG, mix(0.11, 0.75 + 0.25 * passFlash, lockRing) * boot,
      mix(hair, bold * 0.7, lockRing), cx, cy, r2, -Math.PI / 2, -Math.PI / 2 + ringDraw)
    for (var sp = 0; sp < 8; sp++) {
      var sa = sp * Math.PI / 4
      var long = sp % 2 === 0
      crisp.line(ROLE_FG, (long ? 0.08 : 0.045) * boot, hair,
        cx + Math.cos(sa) * R * 0.05, cy + Math.sin(sa) * R * 0.05,
        cx + Math.cos(sa) * R * 0.98, cy + Math.sin(sa) * R * 0.98)
    }
    // Bearing bezel. Ticks brighten as the arm passes, like the HUD cursor.
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
    // Bearing index riding the bezel with the arm.
    if (armK > 0.02) chevron(crisp, tint, 0.9 * armK, thin, cx, cy, arm, R * 1.075, R * 0.05, 0.07)
  }
  glowArc(halo, crisp, tint, (0.42 + passFlash * 0.4) * boot * (bad ? mix(1, 0.6, smearK) : 1), thin, cx, cy, R * 0.985 * wob(3), -Math.PI / 2, -Math.PI / 2 + ringDraw)
  flush()

  // --- sweep and its persistence wedge ------------------------------------------
  if (armK > 0.01) {
    var dir = bad ? -1 : 1
    var trail = compact ? 10 : 26
    for (var k = 1; k <= trail; k++) {
      var wa = arm - dir * k * 0.045
      crisp.line(tint, 0.3 * Math.exp(-k / 8) * armK, compact ? thin : hair,
        cx + Math.cos(wa) * R * 0.04, cy + Math.sin(wa) * R * 0.04,
        cx + Math.cos(wa) * R * 0.975, cy + Math.sin(wa) * R * 0.975)
    }
    crisp.flush()
    glowLine(halo, crisp, tint, 0.95 * armK, thin, cx, cy, cx + Math.cos(arm) * R * 0.98, cy + Math.sin(arm) * R * 0.98)
    flush()
  }

  // --- returns -----------------------------------------------------------------------
  for (var i = 0; i < R_ret.length; i++) {
    var q = R_ret[i]
    if (compact && q.kind === "skin") continue
    var ag = ageOf(q.a)
    var vis = visible(ag.f)
    if (vis <= 0) continue
    var fresh = Math.exp(-ag.f * (bad ? 6 : 3))
    fresh = mix(fresh, 1, holdK)
    var flick = scanning ? 0.82 + 0.18 * hash(ag.c * 13 + i) : 1
    var alpha = q.gain * (RADAR_FLOOR + (1 - RADAR_FLOOR) * fresh) * flick * vis
    if (bad) alpha *= 1 - 0.45 * seg(rt, 200, 800)
    alpha *= 1 + passFlash * 0.2
    var w = clamp(0.03 / Math.max(q.r, 0.05), 0.05, 0.22)
    if (q.kind === "rim") w *= mix(1, 1.8, holdK)
    var feat = q.kind !== "skin"
    var lw = compact ? Math.max(1, size * 0.03) : (feat ? Math.max(1, size * 0.02) : Math.max(1, size * 0.014))
    var ox = bad ? tearShift(tears, q.y) * R : 0
    if (q.kind === "mouth" || q.kind === "nose") {
      // Radial ticks. Range arcs along the mouth bow into a smile at the
      // bottom of the scope; ticks read as a measured row.
      var tl = R * 0.035
      crisp.line(tint, alpha, lw, cx + ox + Math.cos(q.a) * (q.r * R - tl), cy + Math.sin(q.a) * (q.r * R - tl),
        cx + ox + Math.cos(q.a) * (q.r * R + tl), cy + Math.sin(q.a) * (q.r * R + tl))
    } else {
      crisp.arc(tint, alpha, lw, cx + ox, cy, q.r * R, q.a - w, q.a + w)
    }
    if (smearK > 0.01) {
      // Returns smear radially as the track is lost.
      var r0 = q.r * R, r1 = q.r * R * (1 + 0.32 * smearK * (0.5 + q.j))
      crisp.line(tint, alpha * 0.5, hair, cx + ox + Math.cos(q.a) * r0, cy + Math.sin(q.a) * r0,
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
  crisp.flush()

  // --- lock symbology ------------------------------------------------------------------
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
    if (ok) {
      // Two sonar pings clear the scope as the track is confirmed.
      var pings = [[600, 1000], [740, 1120]]
      for (var pi = 0; pi < pings.length; pi++) {
        var pb = bump(rt, pings[pi][0], pings[pi][1])
        if (pb <= 0.01) continue
        var pk = easeOutCubic(seg(rt, pings[pi][0], pings[pi][1]))
        glowArc(halo, crisp, tint, pb * 0.55, Math.max(1, size * 0.012 * (1 - pk * 0.6)), cx, cy, R * mix(0.08, 1.05, pk), 0, TAU)
      }
      // Track marker at the centre.
      var tk = easeOutBack(seg(rt, 480, 680))
      if (tk > 0) {
        var ts = R * mix(0.12, 0.05, tk)
        crisp.poly(tint, clamp01(tk * 2), thin, [[cx, cy - ts], [cx + ts, cy], [cx, cy + ts], [cx - ts, cy], [cx, cy - ts]])
      }
    } else {
      var ew = bump(rt, 0, 340)
      if (ew > 0.01) crisp.arc(ROLE_ERROR, ew * 0.6, Math.max(1, size * 0.018), cx, cy, R * mix(0.1, 1.05, easeOutCubic(seg(rt, 0, 340))), 0, TAU)
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

  // Top left: arm bearing in degrees. It spins with the lock and scrambles
  // on a miss.
  var deg = frac((arm + Math.PI / 2) / TAU) * 360
  if (bad && rt < 300) deg = hash(Math.floor(rt / 40)) * 359
  readTopLeft(p, g, size, t, bad ? ROLE_ERROR : ROLE_FG, " " + pad3(deg))

  readConfidence(p, g, size, state, t, rt, tint)

  // Bottom left: A-scope. Return amplitude against range along the arm.
  var x0 = g.m
  var wA = size * 0.23
  var hA = size * 0.07
  var yb = g.base
  p.line(ROLE_FG, 0.18 * boot, g.hair, x0, yb, x0 + wA, yb)
  p.line(ROLE_FG, 0.12 * boot, g.hair, x0, yb, x0, yb - hA)
  var n = 28
  var noiseStep = Math.floor(t / 50)
  var pts = []
  for (var s = 0; s <= n; s++) {
    var rr = s / n
    var amp = 0.06 + 0.07 * hash(noiseStep * 31 + s) * (bad ? 2.2 : 1)
    for (var i = 0; i < returns.length; i++) {
      var q = returns[i]
      var d = Math.atan2(Math.sin(q.a - arm), Math.cos(q.a - arm))
      if (Math.abs(d) > 0.14) continue
      var dr = (rr - q.r / 1.0) / 0.045
      amp += q.gain * 0.8 * Math.exp(-dr * dr) * (1 - Math.abs(d) / 0.14)
    }
    pts.push([x0 + rr * wA, yb - Math.min(1, amp) * hA * boot])
  }
  p.poly(bad ? ROLE_ERROR : tint, 0.85 * boot, g.hair, pts)

  readStatus(p, g, size, state, t, rt, tint)
}

// --- Holographic Wireframe ---------------------------------------------------
//
// A projected face mask: a relief-mapped half ellipsoid, wired by latitude
// and longitude lines in true perspective, rising from an emitter ring. It
// turns no more than about 22 degrees, with a bold silhouette and surface
// feature contours, so it stays a legible face at 116 px while the parallax
// sells the depth. The mouth is a level line on the surface in every state.

var HOLO_A = 0.60
var HOLO_B = 0.78
var HOLO_C = 0.55
var HOLO_CY = -0.10
var HOLO_F = 3.4
var HOLO_BAND_MS = 2300

function holoRelief(x, y) {
  var ex = Math.abs(x) - 0.25
  var nose = 0.15 * Math.exp(-((x / 0.075) * (x / 0.075) + ((y - 0.02) / 0.19) * ((y - 0.02) / 0.19)))
  var sock = -0.07 * Math.exp(-((ex / 0.12) * (ex / 0.12) + ((y + 0.18) / 0.08) * ((y + 0.18) / 0.08)))
  var brow = 0.03 * Math.exp(-((ex / 0.16) * (ex / 0.16) + ((y + 0.30) / 0.05) * ((y + 0.30) / 0.05)))
  var lips = 0.025 * Math.exp(-((x / 0.2) * (x / 0.2) + ((y - 0.36) / 0.05) * ((y - 0.36) / 0.05)))
  return nose + sock + brow + lips
}

function holoTaper(y) { return y > 0 ? 1 - 0.30 * (y / HOLO_B) * (y / HOLO_B) : 1 }

function holoSurface(u, v) {
  var cv = Math.cos(v)
  var y = HOLO_B * Math.sin(v)
  var x = HOLO_A * Math.sin(u) * cv * holoTaper(y)
  var z = HOLO_C * Math.cos(u) * cv + holoRelief(x, y) * Math.max(0, Math.cos(u))
  return [x, y, z]
}

function holoZAt(x, y) {
  var xt = x / holoTaper(y)
  var q = 1 - (xt / HOLO_A) * (xt / HOLO_A) - (y / HOLO_B) * (y / HOLO_B)
  return HOLO_C * Math.sqrt(Math.max(0, q)) + holoRelief(x, y)
}

function holoYaw(t) { return 0.38 * Math.sin(t / 6400 * TAU) + 0.04 * Math.sin(t / 1900 * TAU) }
function holoPitch(t) { return 0.08 * Math.sin(t / 8100 * TAU + 0.7) }

function holoMesh(compact) {
  var key = compact ? "holoC" : "holo"
  if (CACHE[key]) return CACHE[key]
  var lines = []
  var nLat = compact ? 5 : 9
  var nLon = compact ? 5 : 9
  var i, j, pts
  for (i = 0; i < nLat; i++) {
    var v = mix(-1.22, 1.22, i / (nLat - 1))
    pts = []
    for (j = 0; j <= 22; j++) pts.push(holoSurface(mix(-1.75, 1.75, j / 22), v))
    lines.push(pts)
  }
  for (i = 0; i < nLon; i++) {
    var u = mix(-1.4, 1.4, i / (nLon - 1))
    pts = []
    for (j = 0; j <= 18; j++) pts.push(holoSurface(u, mix(-1.35, 1.35, j / 18)))
    lines.push(pts)
  }
  CACHE[key] = lines
  return lines
}

function holoFeatures() {
  if (CACHE.holoF) return CACHE.holoF
  var f = []
  var i, pts
  function onSurface(x, y) { return [x, y, holoZAt(x, y) + 0.004] }
  for (var e = -1; e <= 1; e += 2) {
    pts = []
    for (i = 0; i <= 16; i++) {
      var a = (i / 16) * TAU
      pts.push(onSurface(e * 0.25 + Math.cos(a) * 0.10, -0.18 + Math.sin(a) * 0.045))
    }
    f.push(pts)
    pts = []
    for (i = 0; i <= 6; i++) {
      var bx = 0.13 + 0.25 * i / 6
      pts.push(onSurface(e * bx, -0.29 - 0.025 * Math.sin(Math.PI * i / 6)))
    }
    f.push(pts)
  }
  pts = []
  for (i = 0; i <= 6; i++) pts.push(onSurface(0, mix(-0.14, 0.11, i / 6)))
  f.push(pts)
  f.push([onSurface(-0.06, 0.14), onSurface(0, 0.17), onSurface(0.06, 0.14)])
  pts = []
  for (i = 0; i <= 8; i++) pts.push(onSurface(mix(-0.19, 0.19, i / 8), 0.36))
  f.push(pts)
  CACHE.holoF = f
  return f
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
  var tint = bad ? ROLE_ERROR : ROLE_ACCENT
  var t0 = t - rt

  var hair = Math.max(1, size * 0.0065)
  var thin = Math.max(1, size * 0.009)
  var bold = Math.max(1, size * 0.016)

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
    flick *= 1 - 0.5 * easeOutCubic(seg(rt, 150, 700))
    if (rt > 100 && rt < 600 && hash(Math.floor(rt / 70) + 17) > 0.55) flick *= 0.45
  }
  flick *= boot

  var bandY = mix(-1.1, 1.1, frac(t / HOLO_BAND_MS))
  var bandK = scanning ? 1 : (ok ? 1 - seg(rt, 0, 300) : 1)
  var ringY = ok ? mix(HOLO_CY - 0.86, HOLO_CY + 0.8, easeInOutCubic(seg(rt, 150, 700))) : -9
  var ringK = ok ? bump(rt, 150, 760) : 0
  var solid = ok ? easeOutCubic(seg(rt, 150, 700)) : 0
  var frag = bad ? easeOutCubic(seg(rt, 120, 700)) : 0
  var fragTau = bad ? Math.max(0, rt - 120) / 1000 : 0
  var passFlash = ok ? bump(rt, REC_PASS - 40, REC_PASS + 420) : 0
  var tears = bad ? glitchTears(rt) : []

  function project(P) {
    var xr = P[0] * cyw + P[2] * syw
    var zr = -P[0] * syw + P[2] * cyw
    var yr = P[1] * cp - zr * spp
    var z2 = P[1] * spp + zr * cp
    var s = HOLO_F / (HOLO_F - z2)
    return { x: xr * s, y: yr * s + HOLO_CY, z: z2 }
  }
  function toPx(x, y) { return { x: cx + x * R, y: cy + y * R } }

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
        var pts = []
        for (var mi = 0; mi <= 16; mi++) {
          var aa = mi / 16 * TAU
          pts.push([cx + Math.cos(aa) * rx, cy - R * 0.08 + Math.sin(aa) * R * 0.72])
        }
        crisp.poly(tint, 0.55, Math.max(1, mw * 0.6), pts)
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

  // --- scanlines --------------------------------------------------------------
  if (!compact) {
    var lines = 38
    for (var li = 0; li < lines; li++) {
      var ly = ((li + 0.5) / lines) * 2 - 1
      var half = Math.sqrt(Math.max(0, 1 - ly * ly))
      if (half <= 0.05) continue
      crisp.line(ROLE_FG, 0.04 * boot, hair, cx - half * R, cy + ly * R, cx + half * R, cy + ly * R)
    }
    var roll = mix(-1, 1, frac(t / 900))
    var rh = Math.sqrt(Math.max(0, 1 - roll * roll))
    crisp.line(tint, 0.12 * flick * (1 - solid), hair, cx - rh * R, cy + roll * R, cx + rh * R, cy + roll * R)
    crisp.flush()
  }

  // --- emitter and projection cone ------------------------------------------
  var EY = 0.9
  var erx = 0.46
  var ery = 0.07
  var ePulse = 0.5 + 0.5 * Math.sin(t / 420)
  var eA = (0.55 + 0.25 * passFlash) * boot * (bad ? mix(1, 0.4, frag) : 1)
  var ring = []
  var ringIn = []
  for (var ei = 0; ei <= 28; ei++) {
    var ea = ei / 28 * TAU
    ring.push([cx + Math.cos(ea) * erx * R, cy + (EY + Math.sin(ea) * ery) * R])
    ringIn.push([cx + Math.cos(ea) * (0.26 + 0.04 * ePulse) * R, cy + (EY + Math.sin(ea) * ery * 0.6) * R])
  }
  if (bad) {
    for (var ed = 0; ed < 28; ed += 2) {
      if (hash(Math.floor(rt / 60) * 3 + ed) < frag * 0.7) continue
      crisp.line(tint, eA, thin, ring[ed][0], ring[ed][1], ring[ed + 1][0], ring[ed + 1][1])
    }
  } else {
    halo.poly(tint, eA * 0.16, thin * 3.6, ring)
    crisp.poly(tint, eA, thin, ring)
  }
  crisp.poly(tint, eA * 0.6, hair, ringIn)

  var outlineW = function (y) {
    return Math.sqrt(HOLO_A * HOLO_A * cyw * cyw + HOLO_C * HOLO_C * syw * syw) * holoTaper(y - HOLO_CY)
  }
  if (!compact) {
    var coneA = 0.09 * flick * (bad ? 1 - frag : 1)
    var topY = HOLO_CY + 0.1
    var tw = outlineW(topY) * 0.98
    crisp.line(tint, coneA, hair, cx - erx * R, cy + EY * R, cx - tw * R, cy + topY * R)
    crisp.line(tint, coneA, hair, cx + erx * R, cy + EY * R, cx + tw * R, cy + topY * R)
    for (var cr = 1; cr <= 4; cr++) {
      var fx = mix(-1, 1, cr / 5)
      crisp.line(tint, coneA * 0.6, hair, cx + fx * erx * R, cy + EY * R, cx + fx * tw * 0.8 * R, cy + (topY + 0.2) * R)
    }
    // Motes rising through the cone. A lock blows them upward and clears
    // them; a miss lets them fall.
    var moteSpeed = ok ? 1 + 3 * seg(rt, 0, 300) : 1
    var moteA = ok ? 1 - seg(rt, 350, 700) : (bad ? 1 - frag : 1)
    for (var mo = 0; mo < 16; mo++) {
      var ph = frac((ok ? t0 + rt * moteSpeed : t) / 1700 + hash(mo * 1.7))
      if (bad) ph = frac(t0 / 1700 + hash(mo * 1.7)) - 0.4 * fragTau
      var my = EY - ph * 1.55
      var mx = (hash(mo * 3.1) - 0.5) * mix(erx * 2, 1.0, ph)
      var ma2 = 0.55 * Math.sin(Math.PI * clamp01(ph)) * moteA * flick
      if (ma2 <= 0.02) continue
      crisp.line(tint, ma2, hair, cx + mx * R, cy + my * R, cx + mx * R, cy + (my + 0.035) * R)
    }
  }
  flush()

  // --- the mask ------------------------------------------------------------------
  var mesh = holoMesh(compact)
  var baseA = mix(0.78, 1, solid)
  for (var ln = 0; ln < mesh.length; ln++) {
    var L = mesh[ln]
    var prev = project(L[0])
    for (var sj = 1; sj < L.length; sj++) {
      var cur = project(L[sj])
      var mz = (prev.z + cur.z) / 2
      var my2 = (prev.y + cur.y) / 2
      var da = clamp01((mz + 0.12) / 0.62)
      var a = baseA * (0.1 + 0.9 * Math.pow(da, 1.2)) * flick
      var x0 = prev.x, y0 = prev.y, x1 = cur.x, y1 = cur.y
      var dx = 0
      if (bandK > 0) {
        var bd = Math.abs(my2 - bandY)
        if (bd < 0.09) {
          a += 0.45 * (1 - bd / 0.09) * bandK * boot
          dx += (hash(Math.floor(t / 60) * 7 + ln) - 0.5) * 0.06 * bandK
        }
      }
      if (ringK > 0) {
        var rd = Math.abs(my2 - ringY)
        if (rd < 0.1) a += 0.5 * (1 - rd / 0.1) * ringK
      }
      if (bad) {
        dx += tearShift(tears, my2)
        if (frag > 0) {
          // Segments detach, shrink and drift outward under drag.
          var sid = ln * 31 + sj
          var mxs = (x0 + x1) / 2, mys = (y0 + y1) / 2
          var nl = Math.hypot(mxs, mys - HOLO_CY) || 0.001
          var sp2 = 0.35 * (0.4 + hash(sid))
          var ox = dragOffset(sp2 * mxs / nl, fragTau, 3.5)
          var oy = dragOffset(sp2 * (mys - HOLO_CY) / nl, fragTau, 3.5) + dragOffset(0.1, fragTau, 2)
          var shrink = 1 - 0.55 * frag * (0.5 + 0.5 * hash(sid + 9))
          x0 = mxs + (x0 - mxs) * shrink + ox
          x1 = mxs + (x1 - mxs) * shrink + ox
          y0 = mys + (y0 - mys) * shrink + oy
          y1 = mys + (y1 - mys) * shrink + oy
        }
      }
      var A = toPx(x0 + dx, y0), B = toPx(x1 + dx, y1)
      crisp.line(tint, a, compact ? Math.max(1, size * 0.018) : hair, A.x, A.y, B.x, B.y)
      prev = cur
    }
  }
  crisp.flush()

  // Silhouette. It carries the face at the small slot.
  var outline = []
  for (var oi = 0; oi <= 40; oi++) {
    var oa = oi / 40 * TAU
    var oy2 = Math.sin(oa) * HOLO_B * (1 + 0.02 * Math.cos(oa))
    var ox2 = Math.cos(oa) * outlineW(oy2 + HOLO_CY) * 1.0
    var oyy = oy2 + HOLO_CY
    ox2 += bad ? tearShift(tears, oyy) : 0
    var OP = toPx(ox2, oyy)
    outline.push([OP.x, OP.y])
  }
  var outA = (0.5 + 0.35 * solid + 0.15 * passFlash) * flick * (bad ? 1 - 0.6 * frag : 1)
  if (bad && frag > 0.05) {
    for (var od = 0; od < 40; od += 2) crisp.line(tint, outA, thin, outline[od][0], outline[od][1], outline[od + 1][0], outline[od + 1][1])
  } else {
    halo.poly(tint, outA * 0.16, thin * 3.6, outline)
    crisp.poly(tint, outA, thin, outline)
  }

  // Feature contours on the surface.
  var feats = holoFeatures()
  var fA = (0.72 + 0.28 * solid) * flick * (bad ? 1 - 0.5 * frag : 1)
  for (var fi = 0; fi < feats.length; fi++) {
    var fp = []
    for (var fj = 0; fj < feats[fi].length; fj++) {
      var P = project(feats[fi][fj])
      var fdx = bad ? tearShift(tears, P.y) : 0
      if (bad && frag > 0) {
        fdx += dragOffset(0.25 * (hash(fi + 40) - 0.5), fragTau, 3.5)
      }
      var FP = toPx(P.x + fdx, P.y + (bad ? dragOffset(0.08, fragTau, 2) : 0))
      fp.push([FP.x, FP.y])
    }
    crisp.poly(tint, fA, compact ? Math.max(1, size * 0.022) : thin, fp)
  }
  flush()

  // --- landmarks, scanner ring and result gestures -------------------------------------
  var lmPx = []
  for (var lm = 0; lm < LANDMARKS.length; lm++) {
    var LMk = LANDMARKS[lm]
    var LP = project([LMk.x * 0.9, LMk.y * 0.92, holoZAt(LMk.x * 0.9, LMk.y * 0.92)])
    lmPx.push({ p: toPx(LP.x + (bad ? tearShift(tears, LP.y) : 0), LP.y), y: LP.y, z: LP.z })
  }
  if (!compact) {
    if (scanning) {
      for (var sl = 0; sl < lmPx.length; sl++) {
        var bd2 = Math.abs(lmPx[sl].y - bandY)
        var sh = clamp01(1 - bd2 / 0.16) * boot
        if (sh <= 0.02 || lmPx[sl].z < 0) continue
        var ds = R * 0.028
        var C0 = lmPx[sl].p
        crisp.poly(tint, sh * 0.9, hair, [[C0.x, C0.y - ds], [C0.x + ds, C0.y], [C0.x, C0.y + ds], [C0.x - ds, C0.y], [C0.x, C0.y - ds]])
      }
    } else if (ok) {
      for (var rl = 0; rl < lmPx.length; rl++) {
        var lockAt = 300 + LANDMARKS[rl].order * 30
        drawLockReticle(halo, crisp, tint, lmPx[rl].p, seg(rt, lockAt, lockAt + REC_LOCK_LEN), R, hair, thin, passFlash)
      }
      if (ringK > 0.01) {
        // A body-scanner ring travels down the mask once as it solidifies.
        var rw = outlineW(ringY) * 1.1
        var rp = []
        for (var ri = 0; ri <= 28; ri++) {
          var ra = ri / 28 * TAU
          rp.push([cx + Math.cos(ra) * rw * R, cy + (ringY + Math.sin(ra) * 0.07) * R])
        }
        halo.poly(tint, ringK * 0.2, bold * 3, rp)
        crisp.poly(tint, ringK * 0.9, thin, rp)
      }
      var wave = bump(rt, REC_WAVE[0], REC_WAVE[1])
      if (wave > 0.01) {
        var wk = easeOutCubic(seg(rt, REC_WAVE[0], REC_WAVE[1]))
        var wp = []
        for (var wi = 0; wi <= 28; wi++) {
          var wa2 = wi / 28 * TAU
          wp.push([cx + Math.cos(wa2) * mix(erx, 1.05, wk) * R, cy + (EY + Math.sin(wa2) * mix(ery, 0.2, wk)) * R])
        }
        halo.poly(tint, wave * 0.12, bold * 3, wp)
        crisp.poly(tint, wave * 0.6, thin, wp)
      }
    } else {
      for (var bl = 0; bl < lmPx.length; bl++) {
        var bk = seg(rt, 60 + LANDMARKS[bl].order * 22, 300 + LANDMARKS[bl].order * 22)
        if (bk <= 0) continue
        var lost = easeOutCubic(seg(rt, 300 + LANDMARKS[bl].order * 22, 800))
        var shake = (1 - bk) * R * 0.04
        drawLostTrack(crisp, lmPx[bl].p.x + Math.sin(rt / 23 + bl) * shake, lmPx[bl].p.y + Math.cos(rt / 29 + bl * 2) * shake,
          R, lost, clamp01(bk * 2) * (0.85 - 0.45 * lost), hair, bl)
      }
      var ew = bump(rt, 0, 340)
      if (ew > 0.01) crisp.arc(ROLE_ERROR, ew * 0.6, Math.max(1, size * 0.018), cx, cy, R * mix(0.1, 1.05, easeOutCubic(seg(rt, 0, 340))), 0, TAU)
      drawTears(crisp, tears, cx, cy, R)
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

  // Bottom left: pose and sync gauges. Pointers centre on a lock.
  var gw = size * 0.22
  var gauges = [yaw / 0.45, pitch / 0.12, (flick - 0.9) * 10 - (ok ? 0 : 0.2)]
  for (var i = 0; i < 3; i++) {
    var gy = g.base - size * 0.01 - i * size * 0.026
    var v = clamp(gauges[i], -1, 1)
    if (ok) v = mix(v, 0, easeOutCubic(seg(rt, 0, 450)))
    if (bad) v = clamp(v + (hash(Math.floor(rt / 50) * 3 + i) - 0.5) * 1.2 * (1 - seg(rt, 300, 700)), -1, 1)
    p.line(ROLE_FG, 0.2 * boot, g.hair, g.m, gy, g.m + gw, gy)
    p.line(ROLE_FG, 0.3 * boot, g.hair, g.m + gw / 2, gy - size * 0.008, g.m + gw / 2, gy + size * 0.008)
    var px = g.m + gw / 2 + v * gw / 2
    p.line(bad ? ROLE_ERROR : tint, 0.9 * boot, g.w * 1.6, px - size * 0.012, gy, px + size * 0.012, gy)
  }

  readStatus(p, g, size, state, t, rt, tint)
}

function paintInto(ctx, size, spec) {
  var style = resolveStyle(spec)
  if (style === "radar") paintRadar(ctx, size, spec)
  else if (style === "holo") paintHolo(ctx, size, spec)
  else paintHud(ctx, size, spec)
}

// How long the host should hold each state before it tears the card down.
// The recognised value is the cost of the identification beat. Clipping it
// cuts the shockwave off before the reticle has settled.
function holdMs(state) {
  if (state === "recognized") return 1150
  if (state === "notRecognized") return 900
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
