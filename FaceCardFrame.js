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
//   clock        free-running milliseconds, drives the scan sweep
//   elapsed      milliseconds since `state` was entered
//
// Colours are not in the spec. Ops carry a role index and the host resolves
// it against the live theme.
//
// Determinism is a security property here, not a nicety. Nothing calls
// Math.random() after buildParticles, no frame-to-frame accumulator exists,
// and the failure drag is evaluated in closed form. The same spec renders the
// same pixels every time, which is what lets the host paint this itself
// instead of loading a plugin Item next to the password field.
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

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    var t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
function clamp01(v) { return clamp(v, 0, 1) }
function mix(a, b, k) { return a + (b - a) * k }

// Normalised progress through the [a, b] millisecond window.
function seg(ms, a, b) { return clamp01((ms - a) / (b - a)) }

function easeOutCubic(k) { var f = 1 - k; return 1 - f * f * f }
function easeInCubic(k) { return k * k * k }
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

// Mouth curvature per state. Positive bows the centre downward, which reads as
// a smile once y grows downward on screen.
var CURVE_SCAN = 0.045
var CURVE_OK = 0.205
var CURVE_BAD = -0.075

// Recognition reads as three beats. Unclear, then who is it, then clear.
// The dot cloud carries the first two and is gone by the third, where a drawn
// face takes over. Mark's call: no dots on the recognised face.
var REC_SMILE = [690, 890]
var REC_CHECK = [770, 1020]

// When each feature group stops drifting and locks onto its home.
function recLock(kind) {
  if (kind === "eyeL" || kind === "eyeR") return [170, 330]
  if (kind === "mouth") return [250, 410]
  if (kind === "rim") return [320, 480]
  return [200, 430]
}

// When each group's dots shrink out, handing that feature to the stroke.
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

// The check that recognition assembles out of the discarded ambient dots.
var CHECK_CX = 0.60
var CHECK_CY = 0.60
var CHECK_S = 0.40
var CHECK_PTS = [[-0.62, 0.00], [-0.16, 0.44], [0.62, -0.46]]

function checkPoint(u) {
  // Constant-speed walk along the two-segment polyline.
  var l1 = Math.hypot(CHECK_PTS[1][0] - CHECK_PTS[0][0], CHECK_PTS[1][1] - CHECK_PTS[0][1])
  var l2 = Math.hypot(CHECK_PTS[2][0] - CHECK_PTS[1][0], CHECK_PTS[2][1] - CHECK_PTS[1][1])
  var d = u * (l1 + l2)
  var a, b, k
  if (d <= l1) { a = CHECK_PTS[0]; b = CHECK_PTS[1]; k = l1 > 0 ? d / l1 : 0 }
  else { a = CHECK_PTS[1]; b = CHECK_PTS[2]; k = l2 > 0 ? (d - l1) / l2 : 0 }
  return {
    x: CHECK_CX + CHECK_S * mix(a[0], b[0], k),
    y: CHECK_CY + CHECK_S * mix(a[1], b[1], k)
  }
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
      ang: Math.atan2(hy, hx),
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
    push("mouth", u * MOUTH_HALF, MOUTH_Y, { u: u })
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

// Where a particle's home sits once the mouth and eye morphs are applied.
function morphedHome(p, curve, squint) {
  if (p.kind === "mouth") {
    return { x: p.hx, y: MOUTH_Y + curve * (1 - p.u * p.u) }
  }
  if (p.kind === "eyeL" || p.kind === "eyeR") {
    var cx = p.kind === "eyeL" ? EYE_L : EYE_R
    var t = p.ex / EYE_R_IN
    var y = EYE_Y + p.ey * (1 - 0.86 * squint) - squint * 0.105 * (1 - t * t)
    return { x: cx + p.ex, y: y }
  }
  return { x: p.hx, y: p.hy }
}

var SWEEP_MS = 1900

// Signed distance from the scan plane, negative ahead of it and positive in its
// wake, so the wake can decay over a longer tail than the leading edge.
function scanPlane(t) {
  var ph = (t % SWEEP_MS) / SWEEP_MS
  var down = ph < 0.5
  var k = down ? ph * 2 : (1 - ph) * 2
  var eased = easeInOutCubic(k)
  return { y: mix(-1.12, 1.12, eased), dir: down ? 1 : -1 }
}

function acquisition(p, plane, hy) {
  var d = (plane.y - hy) * plane.dir
  if (d >= 0) return Math.exp(-d / 0.55)
  return Math.exp(-(-d) / 0.055)
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

function paintInto(ctx, size, spec) {
  var state = spec.state || "scanning"
  var t = spec.clock || 0
  var rt = spec.elapsed || 0
  var compact = size < 76
  var micro = size < 48

  var P = buildParticles(1337)
  var ps = P.all
  var cx = size / 2
  var cy = size / 2
  var R = size * 0.46

  ctx.reset()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  var ok = state === "recognized"
  var bad = state === "notRecognized"
  var tint = bad ? ROLE_ERROR : ROLE_ACCENT

  var curve = CURVE_SCAN
  var squint = 0
  if (ok) {
    var beat = easeOutCubic(seg(rt, REC_SMILE[0], REC_SMILE[1]))
    curve = mix(CURVE_SCAN, CURVE_OK, beat)
    squint = beat
  } else if (bad) {
    curve = mix(CURVE_SCAN, CURVE_BAD, easeOutCubic(seg(rt, 150, 330)))
  }

  var plane = scanPlane(t)
  var scanning = state === "scanning"

  // Global result gestures.
  var lockPulse = ok ? spring(rt, 430, 330, 2.8) * 0.055 : 0
  var faceScale = 1 + lockPulse
  var shearK = bad ? (1 - easeOutCubic(seg(rt, 70, 240))) * seg(rt, 0, 60) : 0
  var scatterTau = bad ? Math.max(0, rt - 150) / 1000 : 0
  var errWave = bad ? seg(rt, 0, 220) * 2.2 : 0

  function toPx(x, y) { return { x: cx + x * R, y: cy + y * R } }

  // --- ambient instrument chrome -------------------------------------------
  if (!micro && scanning) {
    ctx.save()
    ctx.strokeStyle = rgba(ROLE_FG, 0.07)
    ctx.lineWidth = Math.max(1, size * 0.005)
    for (var rb = 0; rb < 5; rb++) {
      var by = cy + ((rb / 4) * 2 - 1) * R * 1.02
      ctx.beginPath()
      ctx.moveTo(cx - R * 1.05, by)
      ctx.lineTo(cx + R * 1.05, by)
      ctx.stroke()
    }
    ctx.restore()
  }

  if (!compact) {
    // Counter-rotating instrument arcs. Deliberately not corner brackets.
    var spin = (t / 4200) * Math.PI * 2
    ctx.save()
    ctx.lineWidth = Math.max(1, size * 0.011)
    ctx.strokeStyle = rgba(tint, bad ? 0.5 : 0.42)
    var arcR = R * (1.03 + (ok ? easeOutCubic(seg(rt, 0, 260)) * -0.04 : 0) + (bad ? easeOutCubic(seg(rt, 0, 300)) * 0.10 : 0))
    for (var q = 0; q < 2; q++) {
      var a0 = spin * (q === 0 ? 1 : -1) + q * Math.PI
      ctx.beginPath()
      ctx.arc(cx, cy, arcR, a0, a0 + 0.62)
      ctx.stroke()
    }
    ctx.restore()

    // Cardinal ticks.
    ctx.save()
    ctx.strokeStyle = rgba(tint, 0.55)
    ctx.lineWidth = Math.max(1, size * 0.013)
    for (var ti = 0; ti < 4; ti++) {
      var ta = ti * Math.PI / 2
      var t0 = R * 1.12
      var t1 = R * (1.12 + (ok ? 0.10 : 0.07))
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(ta) * t0, cy + Math.sin(ta) * t0)
      ctx.lineTo(cx + Math.cos(ta) * t1, cy + Math.sin(ta) * t1)
      ctx.stroke()
    }
    ctx.restore()
  }

  // --- resolve every particle's on-screen position -------------------------
  var pos = new Array(ps.length)
  var lit = new Array(ps.length)

  for (var i = 0; i < ps.length; i++) {
    var p = ps[i]
    var home = morphedHome(p, curve, squint)
    var hx = home.x
    var hy = home.y
    var a = 0

    if (scanning) {
      a = acquisition(p, plane, hy)
      if (p.kind === "field") a *= 0.35
    } else if (ok) {
      var lw = recLock(p.kind)
      a = p.kind === "field" ? 0.3 : easeOutCubic(seg(rt, lw[0], lw[1]))
    } else {
      a = 1 - easeOutCubic(seg(rt, 120, 420)) * 0.55
    }

    // Unacquired dots drift; acquisition pulls them onto the depth surface.
    var wander = 1 - a
    var slack = p.kind === "field" ? 0.150 : (p.kind === "rim" ? 0.055 : 0.105)
    var dx = Math.sin(t / 1000 * 0.85 + p.sa * 6.283) * slack * wander
    var dy = Math.cos(t / 1000 * 0.71 + p.sb * 6.283) * slack * wander

    var x = hx + dx
    var y = hy + dy

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

      if (scatterTau > 0) {
        var len = Math.hypot(hx, hy) || 0.001
        var spread = p.kind === "field" ? 2.1 : 0.32
        var vx = (hx / len) * spread * (0.45 + p.sa)
        var vy = (hy / len) * spread * (0.45 + p.sb) - 0.25
        x += dragOffset(vx, scatterTau, 4.2)
        y += dragOffset(vy, scatterTau, 4.2)
      }
    }

    pos[i] = toPx(x, y)
    lit[i] = a
  }

  // --- recognition: the ambient field is swept out and leaves nothing ------
  var checkOn = ok && !compact
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

  // --- painters ------------------------------------------------------
  var dotBase = Math.max(1, size * (compact ? 0.030 : 0.0225))

  function drawDots() {
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
  }

  // Below roughly 34 px a point cloud is a smudge, so the same geometry is
  // rendered as vector strokes instead. The morphs and the scan line carry
  // across unchanged, which is what keeps the indicator recognisable as the
  // same card it grew out of.
  function drawMicroGlyph() {
    var w = Math.max(1, size * 0.072)
    ctx.lineWidth = w
    var baseA = ok ? 1 : (bad ? 0.9 : 0.86)

    if (bad) {
      var brk2 = easeOutCubic(seg(rt, 200, 560))
      for (var mi2 = 0; mi2 < 8; mi2++) {
        var ma = (mi2 / 8) * Math.PI * 2 + brk2 * 0.3 * (mi2 % 2 ? 1 : -1)
        strokeArc(cx, cy, R * (RIM_R + brk2 * 0.22), ma, ma + 0.42, baseA * (1 - brk2 * 0.45), w)
      }
    } else {
      ctx.strokeStyle = rgba(tint, baseA * (ok ? 1 : 0.8))
      ctx.beginPath()
      ctx.arc(cx, cy, R * RIM_R * (ok ? faceScale : 1), 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.lineWidth = w
    ctx.strokeStyle = rgba(tint, baseA)
    ctx.fillStyle = rgba(tint, baseA)
    for (var me = 0; me < 2; me++) {
      var mex = me === 0 ? EYE_L : EYE_R
      var mp = toPx(mex, EYE_Y)
      if (squint > 0.35) {
        ctx.beginPath()
        ctx.arc(mp.x, mp.y + R * 0.05, R * 0.13, Math.PI * 1.12, Math.PI * 1.88)
        ctx.stroke()
      } else {
        var ds = w * 1.5
        ctx.fillRect(mp.x - ds / 2, mp.y - ds / 2, ds, ds)
      }
    }

    ctx.beginPath()
    var mm0 = toPx(-MOUTH_HALF * 0.92, MOUTH_Y)
    var mmc = toPx(0, MOUTH_Y + curve * 2)
    var mm1 = toPx(MOUTH_HALF * 0.92, MOUTH_Y)
    ctx.moveTo(mm0.x, mm0.y)
    ctx.quadraticCurveTo(mmc.x, mmc.y, mm1.x, mm1.y)
    ctx.stroke()

    if (ok) {
      var mh = bump(rt, 40, 520)
      if (mh > 0.01) {
        ctx.strokeStyle = rgba(tint, mh * 0.7)
        ctx.lineWidth = Math.max(1, size * 0.04 * (1 - seg(rt, 40, 520) * 0.7))
        ctx.beginPath()
        ctx.arc(cx, cy, R * mix(0.84, 1.35, easeOutCubic(seg(rt, 40, 520))), 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  }

  function bracket(x0, y0, x1, y1, alpha, k) {
    if (alpha <= 0.01) return
    var pad = R * (0.030 + 0.055 * (1 - k))
    var ax = cx + x0 * R - pad
    var bx = cx + x1 * R + pad
    var ay = cy + y0 * R - pad
    var by = cy + y1 * R + pad
    var len = Math.min(bx - ax, by - ay) * 0.34
    ctx.strokeStyle = rgba(tint, alpha)
    ctx.lineWidth = Math.max(1, size * 0.019)
    var corners = [[ax, ay, 1, 1], [bx, ay, -1, 1], [ax, by, 1, -1], [bx, by, -1, -1]]
    for (var ci = 0; ci < 4; ci++) {
      var c = corners[ci]
      ctx.beginPath()
      ctx.moveTo(c[0] + c[2] * len, c[1])
      ctx.lineTo(c[0], c[1])
      ctx.lineTo(c[0], c[1] + c[3] * len)
      ctx.stroke()
    }
  }

  function drawIdentify() {
    if (compact) return
    bracket(EYE_L - 0.13, EYE_Y - 0.11, EYE_R + 0.13, EYE_Y + 0.11,
      bump(rt, 140, 400) * 1.0, easeOutCubic(seg(rt, 170, 330)))
    bracket(-MOUTH_HALF, MOUTH_Y - 0.08, MOUTH_HALF, MOUTH_Y + 0.08,
      bump(rt, 225, 480) * 1.0, easeOutCubic(seg(rt, 250, 410)))
  }

  function quadPt(p0, pc, p1, u) {
    var m = 1 - u
    return {
      x: m * m * p0.x + 2 * m * u * pc.x + u * u * p1.x,
      y: m * m * p0.y + 2 * m * u * pc.y + u * u * p1.y
    }
  }

  // The clear beat. A drawn face, not a dotted one. The rim sweeps in from the
  // top, then the features arrive, then the smile lands.
  function drawFaceReveal() {
    var w = Math.max(1, size * (compact ? 0.036 : 0.027))
    ctx.lineWidth = w

    var rimK = easeInOutCubic(seg(rt, 460, 700))
    if (rimK > 0.004) {
      ctx.strokeStyle = rgba(tint, Math.min(1, rimK * 2.4))
      ctx.beginPath()
      ctx.arc(cx, cy, R * RIM_R * faceScale, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * rimK)
      ctx.stroke()
    }

    var eyeK = easeOutCubic(seg(rt, 555, 720))
    if (eyeK > 0.01) {
      ctx.strokeStyle = rgba(tint, eyeK)
      // The circle opens continuously into the happy arc as squint rises, so
      // the neutral eye and the smiling eye are one shape, never two.
      var a0 = mix(0, Math.PI * 1.14, squint)
      var a1 = mix(Math.PI * 2, Math.PI * 1.86, squint)
      var er = R * EYE_R_IN * mix(1.0, 1.55, squint) * eyeK
      for (var ei2 = 0; ei2 < 2; ei2++) {
        var ecx2 = ei2 === 0 ? EYE_L : EYE_R
        var ep = toPx(ecx2 * faceScale, EYE_Y * faceScale + 0.05 * squint)
        ctx.beginPath()
        ctx.arc(ep.x, ep.y, er, a0, a1)
        ctx.stroke()
      }
    }

    // The mouth grows outward from the centre. Drawing it end to end reads as
    // a stub creeping across the face for the first half of the window.
    var mouthK = easeInOutCubic(seg(rt, 575, 775))
    if (mouthK > 0.01) {
      ctx.strokeStyle = rgba(tint, Math.min(1, mouthK * 1.8))
      var q0 = toPx(-MOUTH_HALF * faceScale, MOUTH_Y * faceScale)
      var qc = toPx(0, (MOUTH_Y + curve * 2) * faceScale)
      var q1 = toPx(MOUTH_HALF * faceScale, MOUTH_Y * faceScale)
      var u0 = 0.5 - mouthK / 2
      var u1 = 0.5 + mouthK / 2
      var start = quadPt(q0, qc, q1, u0)
      ctx.beginPath()
      ctx.moveTo(start.x, start.y)
      for (var qi = 1; qi <= 18; qi++) {
        var qp = quadPt(q0, qc, q1, mix(u0, u1, qi / 18))
        ctx.lineTo(qp.x, qp.y)
      }
      ctx.stroke()
    }
  }

  function drawMesh(alphaScale) {
    if (micro) return
    ctx.lineWidth = Math.max(1, size * 0.0045)
    for (var mi = 0; mi < P.face.length; mi++) {
      var pi = P.face[mi]
      var pp = ps[pi]
      var nbs = [pp.n1, pp.n2]
      for (var nb = 0; nb < 2; nb++) {
        var nj = nbs[nb]
        if (nj < 0 || nj < pi) continue
        var la = Math.min(lit[pi], lit[nj])
        // The mesh never fully disappears: it is the standing structure the
        // scan wake lights up, not something the wake draws from nothing.
        ctx.strokeStyle = rgba(tint, (0.07 + 0.68 * la) * alphaScale)
        ctx.beginPath()
        ctx.moveTo(pos[pi].x, pos[pi].y)
        ctx.lineTo(pos[nj].x, pos[nj].y)
        ctx.stroke()
      }
    }
  }

  function strokeArc(cxp, cyp, r, from, to, alpha, w) {
    if (to <= from) return
    ctx.strokeStyle = rgba(tint, alpha)
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.arc(cxp, cyp, r, from, to)
    ctx.stroke()
  }

  // The vector face on its own, at the same radius the rim dots already sit on.
  // Fading this in while the dots shrink reads as the cloud fusing into a line,
  // not as one drawing dissolving into another.
  if (micro) {
    drawMicroGlyph()
  } else {
    if (compact && !bad && !ok) {
      // A faint rim anchors the silhouette once the mesh is dropped.
      ctx.strokeStyle = rgba(tint, 0.28)
      ctx.lineWidth = Math.max(1, size * 0.018)
      ctx.beginPath()
      ctx.arc(cx, cy, R * RIM_R, 0, Math.PI * 2)
      ctx.stroke()
    }
    if (!compact) drawMesh(ok ? 1 - easeInOutCubic(seg(rt, 390, 620)) : 1)
    drawDots()
    if (ok) {
      drawIdentify()
      drawFaceReveal()
    }
  }

  // --- scan plane ----------------------------------------------------------
  if (scanning) {
    var py = cy + plane.y * R
    var trail = R * 0.30
    var grad = ctx.createLinearGradient(0, py - plane.dir * trail, 0, py)
    grad.addColorStop(0, rgba(tint, 0))
    grad.addColorStop(1, rgba(tint, 0.11))
    ctx.fillStyle = grad
    ctx.fillRect(cx - R * 1.05, Math.min(py, py - plane.dir * trail), R * 2.1, trail)

    ctx.strokeStyle = rgba(tint, 0.92)
    ctx.lineWidth = Math.max(1, size * 0.009)
    ctx.beginPath()
    ctx.moveTo(cx - R * 1.05, py)
    ctx.lineTo(cx + R * 1.05, py)
    ctx.stroke()

    if (!micro) {
      ctx.fillStyle = rgba(tint, 1)
      var nub = Math.max(2, size * 0.028)
      ctx.fillRect(cx - R * 1.05 - nub / 2, py - nub / 2, nub, nub)
      ctx.fillRect(cx + R * 1.05 - nub / 2, py - nub / 2, nub, nub)
    }
  }

  // --- result flourishes ---------------------------------------------------
  if (ok) {
    var halo = bump(rt, 400, 900)
    if (halo > 0.01 && !micro) {
      var hr = R * mix(0.80, 1.5, easeOutCubic(seg(rt, 400, 900)))
      ctx.strokeStyle = rgba(tint, halo * 0.55)
      ctx.lineWidth = Math.max(1, size * 0.016 * (1 - seg(rt, 400, 900) * 0.7))
      ctx.beginPath()
      ctx.arc(cx, cy, hr, 0, Math.PI * 2)
      ctx.stroke()
    }

    if (checkOn) {
      var drawn = easeInOutCubic(seg(rt, REC_CHECK[0], REC_CHECK[1]))
      if (drawn > 0.02) {
        ctx.strokeStyle = rgba(tint, Math.min(1, drawn * 1.4))
        ctx.lineWidth = Math.max(1, size * 0.038)
        ctx.beginPath()
        var first = checkPoint(0)
        var fp0 = toPx(first.x, first.y)
        ctx.moveTo(fp0.x, fp0.y)
        var segs = 16
        for (var ck = 1; ck <= segs; ck++) {
          var uu = (ck / segs) * drawn
          var cp = checkPoint(uu)
          var cpp = toPx(cp.x, cp.y)
          ctx.lineTo(cpp.x, cpp.y)
        }
        ctx.stroke()
      }
    }
  }

  if (bad && !micro) {
    // Error wave: a ring that races out as the anchors let go.
    var ew = bump(rt, 0, 340)
    if (ew > 0.01) {
      ctx.strokeStyle = rgba(ROLE_ERROR, ew * 0.6)
      ctx.lineWidth = Math.max(1, size * 0.018)
      ctx.beginPath()
      ctx.arc(cx, cy, R * mix(0.1, 1.35, easeOutCubic(seg(rt, 0, 340))), 0, Math.PI * 2)
      ctx.stroke()
    }

    // Broken rim: dashes that drift apart once the lock is gone.
    var brk = easeOutCubic(seg(rt, 240, 620))
    if (brk > 0.02) {
      ctx.strokeStyle = rgba(ROLE_ERROR, 0.45 * (1 - brk * 0.4))
      ctx.lineWidth = Math.max(1, size * 0.012)
      for (var di = 0; di < 10; di++) {
        var da = (di / 10) * Math.PI * 2 + brk * 0.22 * (di % 2 ? 1 : -1)
        strokeArc(cx, cy, R * (RIM_R + brk * 0.26), da, da + 0.24, 0.45 * (1 - brk * 0.4), Math.max(1, size * 0.012))
      }
    }
  }
}

// How long the host should hold each state before it tears the card down.
// The recognised value is the cost of the identification beat. Clipping it
// cuts the check off mid-draw.
function holdMs(state) {
  if (state === "recognized") return 1050
  if (state === "notRecognized") return 820
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
