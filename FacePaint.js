// Paints FaceCardFrame.js ops on a Canvas, and derives the colours for them
// from an Omarchy theme. Shared by the standalone card (Card.qml) and the
// developer preview (Preview.qml), so both draw exactly what the fork's host
// painter (shell/Commons/FaceCardPainter.js) draws at op level 3: the card on
// a dark glass panel, glow on a blurred bloom layer, additive blending, and
// all six roles resolved against the glass.
//
// Ops are numbers; anything else is not drawn. QML only: it uses Qt.color.

// Tokyo Night, until a theme loads.
var FALLBACK = {
  background: "#1a1b26", foreground: "#a9b1d6", accent: "#7aa2f7", red: "#f7768e",
  yellow: "#e0af68", green: "#9ece6a", cyan: "#449dab", magenta: "#ad8ee6", orange: "#eb927b"
}

// colors.toml text -> { name: "#rrggbb" }, or null when it names no base.
function parseTheme(text) {
  var named = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (m) named[m[1]] = m[2]
  }
  if (!named.background && !named.color0) return null
  if (!named.background) named.background = named.color0
  return named
}

function accentOf(theme) { return theme.accent || theme.color4 || "#7aa2f7" }
function foregroundOf(theme) { return theme.foreground || theme.color7 || "#c0caf5" }
function errorOf(theme) { return theme.red || theme.color1 || "#f7768e" }

function luminance(c) {
  var q = Qt.color(c)
  return 0.2126 * q.r + 0.7152 * q.g + 0.0722 * q.b
}

function hueGap(a, b) {
  var d = Math.abs(a - b) % 1
  return d > 0.5 ? 1 - d : d
}

// A short copy of the host's FaceTheme.roles: hot is the accent pushed toward
// the text colour; secondary and tertiary are the theme's most distinct
// palette hues, never the error colour.
function deriveRoles(theme) {
  var a = Qt.color(accentOf(theme)), f = Qt.color(foregroundOf(theme)), e = Qt.color(errorOf(theme))
  var hot = Qt.tint(a, Qt.rgba(f.r, f.g, f.b, 0.55))
  hot = Qt.hsla(hot.hslHue, hot.hslSaturation, Math.min(0.94, hot.hslLightness + (1 - hot.hslLightness) * 0.35), 1)
  var keys = ["cyan", "magenta", "blue", "green", "yellow", "orange", "bright_cyan", "bright_magenta", "color6", "color5", "color2", "color3"]
  var picks = []
  for (var i = 0; i < keys.length; i++) {
    var v = theme[keys[i]]
    if (!v) continue
    var c = Qt.color(v)
    if (c.hslSaturation < 0.22 || c.hslLightness < 0.25 || c.hslLightness > 0.9) continue
    if (e.hslSaturation > 0.22 && hueGap(c.hslHue, e.hslHue) < 0.05) continue
    picks.push(c)
  }
  function best(away) {
    var top = null, score = 0.06
    for (var j = 0; j < picks.length; j++) {
      var d = hueGap(picks[j].hslHue, a.hslHue)
      if (away) d = Math.min(d, hueGap(picks[j].hslHue, away.hslHue))
      if (d > score) { score = d; top = picks[j] }
    }
    return top
  }
  var second = best(null)
  var third = second ? best(second) : null
  if (!second) second = Qt.hsla((a.hslHue + 0.42) % 1, Math.max(0.45, a.hslSaturation), 0.6, 1)
  if (!third) third = Qt.hsla((a.hslHue + 0.82) % 1, Math.max(0.45, a.hslSaturation), 0.6, 1)
  return [a, f, e, hot, second, third]
}

// WCAG contrast, for lifting colours off the glass as FaceTheme.glass does.
function relLum(c) {
  function lin(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

function contrast(a, b) {
  var la = relLum(a), lb = relLum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function liftOver(c, bg, target) {
  var out = Qt.color(c)
  var l = out.hslLightness
  while (contrast(out, bg) < target && l < 0.94) {
    l = Math.min(0.94, l + 0.02)
    out = Qt.hsla(out.hslHue, out.hslSaturation, l, 1)
  }
  return out
}

// A short copy of the host's FaceTheme.glass: the panel is the theme's darker
// base tinted toward the accent and deepened; every role is lifted until it
// reads on it.
function deriveGlass(theme) {
  var a = Qt.color(accentOf(theme)), f = Qt.color(foregroundOf(theme)), b = Qt.color(theme.background || foregroundOf(theme))
  var darkBase = relLum(b) <= relLum(f) ? b : f
  var lightBase = relLum(b) <= relLum(f) ? f : b
  var t = Qt.tint(darkBase, Qt.rgba(a.r, a.g, a.b, 0.14))
  var panel = Qt.hsla(t.hslHue, Math.min(t.hslSaturation, 0.32),
    Math.min(darkBase.hslLightness, Math.max(0.05, Math.min(0.1, t.hslLightness * 0.8))), 1)
  var e = Qt.tint(darkBase, Qt.rgba(a.r, a.g, a.b, 0.3))
  var edge = Qt.hsla(e.hslHue, e.hslSaturation, Math.max(0.16, Math.min(0.24, e.hslLightness)), 1)
  var base = deriveRoles(theme)
  var lit = liftOver(a, panel, 6)
  var ink = liftOver(lightBase, panel, 11)
  var hot = Qt.tint(lit, Qt.rgba(ink.r, ink.g, ink.b, 0.55))
  hot = Qt.hsla(hot.hslHue, hot.hslSaturation, Math.min(0.94, hot.hslLightness + (1 - hot.hslLightness) * 0.35), 1)
  return {
    panel: panel, edge: edge,
    roles: [lit, ink, liftOver(errorOf(theme), panel, 5), hot, liftOver(base[4], panel, 5), liftOver(base[5], panel, 5)]
  }
}

function roleColor(roles, role, alpha) {
  var c = role >= 1 && role <= 5 && Math.floor(role) === role ? roles[role] : roles[0]
  return Qt.rgba(c.r, c.g, c.b, Math.max(0, Math.min(1, alpha)))
}

// The sharp layer draws each op at its alpha; the glow layer draws only ops
// with a trailing glow value, at that value, for the bloom to blur. Additive
// blending is used only on a dark surface.
function paintOps(ctx, list, glowLayer, scale, roles, dark) {
  ctx.reset()
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  if (scale !== 1) ctx.scale(scale, scale)
  if (glowLayer) ctx.globalCompositeOperation = dark ? "lighter" : "source-over"
  var glowAt = [5, 7, 10]
  for (var i = 0; i < list.length; i++) {
    var op = list[i]
    if (op[0] === 3) {
      if (!glowLayer) ctx.globalCompositeOperation = dark && op[1] === 1 ? "lighter" : "source-over"
      continue
    }
    var g = op.length > glowAt[op[0]] ? op[glowAt[op[0]]] : 0
    if (glowLayer && !(g > 0)) continue
    if (op[0] === 0) {
      var a = glowLayer ? g : op[2]
      if (a <= 0) continue
      ctx.strokeStyle = roleColor(roles, op[1], a)
      ctx.lineWidth = op[3]
      ctx.beginPath()
      var cmds = op[4]
      for (var c = 0; c < cmds.length; c++) {
        var k = cmds[c]
        if (k[0] === 0) ctx.moveTo(k[1], k[2])
        else if (k[0] === 1) ctx.lineTo(k[1], k[2])
        else if (k[0] === 2) ctx.quadraticCurveTo(k[1], k[2], k[3], k[4])
        else if (k[0] === 3) ctx.arc(k[1], k[2], k[3], k[4], k[5])
      }
      ctx.stroke()
    } else if (op[0] === 1) {
      ctx.fillStyle = roleColor(roles, op[1], glowLayer ? g : op[2])
      ctx.fillRect(op[3], op[4], op[5], op[6])
    } else if (op[0] === 2) {
      var k2 = glowLayer ? g : 1
      var gr = ctx.createLinearGradient(0, op[8], 0, op[9])
      gr.addColorStop(0, roleColor(roles, op[1], op[2] * k2))
      gr.addColorStop(1, roleColor(roles, op[1], op[3] * k2))
      ctx.fillStyle = gr
      ctx.fillRect(op[4], op[5], op[6], op[7])
    }
  }
  ctx.globalCompositeOperation = "source-over"
}
