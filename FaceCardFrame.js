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
    var rings = [[0, 1], [0.5, 6], [0.92, 10]]
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

  n = 32
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

function paintInto(ctx, size, spec) {
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

  // Glitch tears. A few horizontal strips, re-rolled every 45 ms for the
  // first 300 ms of a miss, each dragging the dots inside it sideways.
  var tears = []
  if (bad && rt < 300) {
    var tstep = Math.floor(rt / 45)
    for (var tj = 0; tj < 3; tj++) {
      tears.push({
        y: (hash(tstep * 5 + tj * 17) * 2 - 1) * 0.85,
        h: 0.035 + hash(tstep * 9 + tj) * 0.06,
        dx: (hash(tstep * 11 + tj * 3) - 0.5) * 0.42
      })
    }
  }

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
    paintMicro(crisp, size, state, t, rt, cx, cy, R, tint)
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
      for (var tk = 0; tk < tears.length; tk++) {
        if (Math.abs(y - tears[tk].y) < tears[tk].h) x += tears[tk].dx
      }

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
    var s = dotBase * zf * (p2.kind === "field" ? 0.72 : 1) * (0.68 + 0.42 * l)
    // The rim and the features carry the face; the depth-map interior is
    // texture behind them. Without this weighting the silhouette dissolves
    // on a light theme, where accent-on-near-white has little contrast.
    var kw = p2.kind === "field" ? 0.46
      : (p2.kind === "skin" ? 0.82 : (p2.kind === "rim" ? 1.12 : 1.25))
    // Floor keeps the silhouette readable between sweeps; the cubed term is
    // the bright crest that rides the scan plane itself.
    var alpha = (0.40 + 0.48 * l + 0.34 * l * l * l) * kw * (0.70 + 0.30 * p2.z)
    if (scanning) alpha *= mix(0.2, 1, boot)

    if (bad && p2.kind !== "field") {
      var reached = clamp01(errWave - Math.hypot(p2.hx, p2.hy))
      alpha *= mix(1, 0.62, reached)
    }
    if (ok) {
      if (p2.kind === "eyeL" || p2.kind === "eyeR" || p2.kind === "mouth") {
        alpha = Math.min(1, alpha * 1.3)
      }
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

      // Each landmark: a reticle contracts and rotates onto it, then leaves a
      // small locked diamond behind.
      for (var rl = 0; rl < lmPx.length; rl++) {
        var k = lmLock[rl]
        if (k <= 0) continue
        var C = lmPx[rl]
        var ret = 1 - k
        if (ret > 0.01) {
          var rs = R * mix(0.05, 0.20, ret)
          var rrot = ret * 0.8
          var ra = clamp01(k * 3) * 0.95
          var sq = []
          for (var q2 = 0; q2 < 4; q2++) {
            var qa2 = rrot + q2 * Math.PI / 2 + Math.PI / 4
            sq.push([C.x + Math.cos(qa2) * rs, C.y + Math.sin(qa2) * rs])
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
        var dAlpha = clamp01(k * 2) * (0.9 + 0.1 * passFlash)
        halo.poly(tint, dAlpha * 0.2, thin * 3.2, [[C.x, C.y - ds], [C.x + ds, C.y], [C.x, C.y + ds], [C.x - ds, C.y], [C.x, C.y - ds]])
        crisp.poly(tint, dAlpha, thin, [[C.x, C.y - ds], [C.x + ds, C.y], [C.x, C.y + ds], [C.x - ds, C.y], [C.x, C.y - ds]])
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
      // A miss: the reticles hunt, fail to converge, and are struck through.
      for (var bl = 0; bl < lmPx.length; bl++) {
        var bc = lmPx[bl]
        var bk = seg(rt, 60 + LANDMARKS[bl].order * 22, 300 + LANDMARKS[bl].order * 22)
        if (bk <= 0) continue
        var shake = (1 - bk) * R * 0.04
        var bx2 = bc.x + Math.sin(rt / 23 + bl) * shake
        var by2 = bc.y + Math.cos(rt / 29 + bl * 2) * shake
        var xs = R * 0.035
        var xa = clamp01(bk * 2) * (0.85 - 0.35 * seg(rt, 500, 900))
        crisp.line(ROLE_ERROR, xa, thin, bx2 - xs, by2 - xs, bx2 + xs, by2 + xs)
        crisp.line(ROLE_ERROR, xa, thin, bx2 - xs, by2 + xs, bx2 + xs, by2 - xs)
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
    for (var tr = 0; tr < tears.length; tr++) {
      var ty = cy + tears[tr].y * R
      var tdx = tears[tr].dx * R
      crisp.line(ROLE_ERROR, 0.45, Math.max(1, tears[tr].h * R * 0.5),
        cx - R * 0.9 + tdx, ty, cx + R * 0.9 + tdx, ty)
    }

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
  if (hud) paintReadouts(crisp, size, state, t, rt, boot, tint)
  crisp.flush()
}

// Instrument readouts in the four corners the round instrument leaves free.
function paintReadouts(p, size, state, t, rt, boot, tint) {
  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var t0 = t - rt

  var m = size * 0.035
  var cw = size * 0.028
  var ch = size * 0.054
  var pitch = size * 0.041
  var w = Math.max(1, size * 0.0075)
  var ghost = 0.07 * boot
  var fgA = 0.62 * boot
  var hair = Math.max(1, size * 0.0065)

  // Top left: frame counter. It freezes on the frame a result was taken.
  var frameNo = t / 16.667
  if (ok) frameNo = seg(rt, 0, REC_PASS) < 1 ? frameNo : (t0 + REC_PASS) / 16.667
  if (bad) frameNo = rt < 300 ? hash(Math.floor(rt / 40)) * 65535 : (t0 + 300) / 16.667
  seg7(p, bad ? ROLE_ERROR : ROLE_FG, fgA, ghost, w, m, m, cw, ch, pitch, hex4(frameNo), 0)
  var tagY = m + ch + size * 0.022
  var tagW = pitch * 4 - (pitch - cw)
  p.line(ROLE_FG, 0.22 * boot, hair, m, tagY, m + tagW, tagY)
  var tick = ((t / 900) % 1) * tagW
  p.line(tint, 0.8 * boot, w * 1.3, m + tick, tagY, m + Math.min(tagW, tick + size * 0.03), tagY)

  // Top right: match confidence over a ten-cell bar.
  var conf = 8 + 6 * Math.sin(t / 700) + 4 * Math.sin(t / 233 + 1) + 3 * Math.sin(t / 91)
  var confT0 = 8 + 6 * Math.sin(t0 / 700) + 4 * Math.sin(t0 / 233 + 1) + 3 * Math.sin(t0 / 91)
  if (ok) conf = mix(confT0, 99.7, easeOutCubic(seg(rt, REC_COUNT[0], REC_COUNT[1])))
  if (bad) conf = mix(confT0, 41, easeOutCubic(seg(rt, 0, 180))) * (1 - easeInOutCubic(seg(rt, 200, 460)))
  var confStr = boot < 0.6 ? "---" : pad3(conf * 10)
  if (confStr !== "---") confStr = confStr.slice(0, 2) + "." + confStr.slice(2)
  var blinkOff = bad && rt > 460 && Math.floor(rt / 120) % 2 === 1
  var confRole = bad ? ROLE_ERROR : (ok ? tint : ROLE_FG)
  var confA = blinkOff ? 0.18 : (ok ? 0.95 : fgA)
  seg7(p, confRole, confA, ghost, w, size - m, m, cw, ch, pitch, confStr, 1)
  var cells = 10
  var barW = pitch * 3
  var cellW = barW / cells
  var filled = clamp01(conf / 100) * cells
  for (var c = 0; c < cells; c++) {
    var on = clamp01(filled - c)
    var x0 = size - m - barW + c * cellW
    p.line(on > 0 ? confRole : ROLE_FG, on > 0 ? mix(0.25, 0.9, on) * boot : 0.12 * boot, w * 1.6,
      x0 + cellW * 0.18, tagY, x0 + cellW * 0.82, tagY)
  }

  // Bottom left: live sample histogram. Bars level out on a lock and drain
  // on a miss.
  var bars = 8
  var bw = size * 0.022
  var bh = size * 0.075
  var base = size - m
  for (var b = 0; b < bars; b++) {
    var live = 0.18 + 0.82 * Math.abs(Math.sin(t / (170 + b * 37) + b * 1.7) * Math.sin(t / (410 + b * 53) + b))
    var hK = live
    if (ok) hK = mix(live, 0.55 + 0.35 * Math.cos(b * 0.9), easeOutCubic(seg(rt, 200, 620)))
    if (bad) hK = live * (1 - easeOutCubic(seg(rt, 100, 500))) * 0.8 + 0.06
    var bx = m + b * bw * 1.35 + bw / 2
    p.line(ROLE_FG, 0.12 * boot, bw, bx, base, bx, base - bh)
    p.line(bad ? ROLE_ERROR : tint, 0.75 * boot, bw, bx, base, bx, base - bh * hK * boot)
  }

  // Bottom right: status word.
  var word = "SCAN"
  if (ok) word = rt < 300 ? "SCAN" : (rt < REC_PASS ? chase(rt) : "PASS")
  if (bad) word = rt < 150 ? "SCAN" : "FAIL"
  var wordOff = bad && rt > 150 && Math.floor(rt / 110) % 2 === 1
  var scanBlink = !ok && !bad && Math.floor(t / 530) % 2 === 1
  var wordA = wordOff ? 0.2 : (ok && rt >= REC_PASS ? 1 : (scanBlink ? fgA * 0.55 : fgA))
  var wordRole = bad ? ROLE_ERROR : (ok && rt >= REC_PASS ? tint : ROLE_FG)
  seg7(p, wordRole, wordA, ghost, w, size - m, base - ch, cw, ch, pitch, word, 1)
}

// The matching beat on the status word: a single segment chases round.
function chase(rt) {
  var frames = ["-   ", " -  ", "  - ", "   -"]
  return frames[Math.floor(rt / 60) % frames.length]
}

// Below roughly 48 px the cloud is a smudge, so the same geometry is rendered
// as vector strokes instead: a segmented ring that closes on a lock and
// breaks on a miss, two eye marks, a measured mouth line, and the scan line.
function paintMicro(p, size, state, t, rt, cx, cy, R, tint) {
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
