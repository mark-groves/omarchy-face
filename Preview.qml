import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import "FaceCardFrame.js" as FaceCard

// Developer harness for the face card. Not shipped and not loaded by the host.
//
// It is also the reference for how the host is meant to drive this plugin.
// The plugin returns a frame as numbers. The harness owns the Canvas, owns the
// palette, and does the drawing. It never hands the plugin a context, because
// a context exposes its canvas, the canvas is an Item, and an Item's parent
// chain reaches the password field on a credential surface.
//
// `paintOps` below mirrors the host painter (shell/Commons/FaceCardPainter.js
// in the Omarchy fork) at op level 2: glow on a blurred bloom layer, additive
// blending, and roles 3..5 derived from the theme. Colours come from the
// active Omarchy theme's colors.toml when there is one.
//
//   quickshell -p Preview.qml
ShellRoot {
  id: root

  property real clock: 0
  property string cardState: "scanning"
  property real enteredAt: 0
  property bool sequence: true
  // Op level the harness paints, as the host would report it in spec.host.
  property int host: 2
  // The harness passes the style per frame as spec.style. An installed card
  // takes it from the STYLE line instead (bin/omarchy-face-style).
  property string style: Quickshell.env("FACE_STYLE") || "hud"
  readonly property var styles: [
    { s: "hud", l: "Depth Lattice HUD" },
    { s: "radar", l: "Phosphor Radar" },
    { s: "holo", l: "Holographic Wireframe" }
  ]
  readonly property int side: 220

  // Scripted walk through every state and transition, the way a lock screen
  // sees them: scan, lock, rescan, miss.
  readonly property var script: [
    { s: "scanning", ms: 3400 },
    { s: "recognized", ms: FaceCard.holdMs("recognized") + 900 },
    { s: "scanning", ms: 3000 },
    { s: "notRecognized", ms: FaceCard.holdMs("notRecognized") + 900 }
  ]
  property int scriptAt: 0
  property real scriptEnteredAt: 0

  // Tokyo Night until the active theme loads.
  property var theme: ({
    background: "#1a1b26", foreground: "#a9b1d6", accent: "#7aa2f7", red: "#f7768e",
    yellow: "#e0af68", green: "#9ece6a", cyan: "#449dab", magenta: "#ad8ee6", orange: "#eb927b"
  })
  readonly property color surface: Qt.darker(theme.background, 1.3)
  readonly property color panel: theme.background
  readonly property color accent: theme.accent || theme.color4 || "#7aa2f7"
  readonly property color foreground: theme.foreground || theme.color7 || "#c0caf5"
  readonly property color errorColor: theme.red || theme.color1 || "#f7768e"
  readonly property bool dark: luminance(theme.background) < 0.5
  readonly property var roles: deriveRoles()

  property real paintMs: 0
  property int opCount: 0

  onCardStateChanged: enteredAt = clock

  FileView {
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    printErrors: false
    watchChanges: true
    onFileChanged: reload()
    onLoaded: {
      var named = {}
      var lines = text().split("\n")
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
        if (m) named[m[1]] = m[2]
      }
      if (named.background || named.color0) {
        if (!named.background) named.background = named.color0
        root.theme = named
      }
    }
  }

  FrameAnimation {
    running: true
    onTriggered: {
      // Capped like the host's presented-frame step, so a stall is not a jump.
      root.clock += Math.min(frameTime * 1000, 50)
      if (root.sequence && root.clock - root.scriptEnteredAt >= root.script[root.scriptAt].ms) {
        root.scriptAt = (root.scriptAt + 1) % root.script.length
        root.scriptEnteredAt = root.clock
        root.cardState = root.script[root.scriptAt].s
      }
    }
  }

  function startSequence() {
    root.sequence = true
    root.scriptAt = 0
    root.scriptEnteredAt = root.clock
    root.cardState = "scanning"
    root.enteredAt = root.clock
  }

  function luminance(c) {
    var q = Qt.color(c)
    return 0.2126 * q.r + 0.7152 * q.g + 0.0722 * q.b
  }

  function hueGap(a, b) {
    var d = Math.abs(a - b) % 1
    return d > 0.5 ? 1 - d : d
  }

  // A short copy of the host's FaceTheme.roles: hot is the accent pushed
  // toward the text colour; secondary and tertiary are the theme's most
  // distinct palette hues, never the error colour.
  function deriveRoles() {
    var a = Qt.color(root.accent), f = Qt.color(root.foreground), e = Qt.color(root.errorColor)
    var hot = Qt.tint(a, Qt.rgba(f.r, f.g, f.b, 0.55))
    hot = Qt.hsla(hot.hslHue, hot.hslSaturation, Math.min(0.94, hot.hslLightness + (1 - hot.hslLightness) * 0.35), 1)
    var keys = ["cyan", "magenta", "blue", "green", "yellow", "orange", "bright_cyan", "bright_magenta", "color6", "color5", "color2", "color3"]
    var picks = []
    for (var i = 0; i < keys.length; i++) {
      var v = root.theme[keys[i]]
      if (!v) continue
      var c = Qt.color(v)
      if (c.hslSaturation < 0.22 || c.hslLightness < 0.25 || c.hslLightness > 0.9) continue
      if (e.hslSaturation > 0.22 && root.hueGap(c.hslHue, e.hslHue) < 0.05) continue
      picks.push(c)
    }
    function best(away) {
      var top = null, score = 0.06
      for (var j = 0; j < picks.length; j++) {
        var d = root.hueGap(picks[j].hslHue, a.hslHue)
        if (away) d = Math.min(d, root.hueGap(picks[j].hslHue, away.hslHue))
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

  function roleColor(role, alpha) {
    var c = role >= 1 && role <= 5 && Math.floor(role) === role ? root.roles[role] : root.roles[0]
    return Qt.rgba(c.r, c.g, c.b, Math.max(0, Math.min(1, alpha)))
  }

  // Mirrors the host painter. Ops are numbers; anything else is not drawn.
  // The sharp layer draws each op at its alpha; the glow layer draws only ops
  // with a trailing glow value, at that value, for the bloom to blur.
  function paintOps(ctx, list, glowLayer, scale) {
    ctx.reset()
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    if (scale !== 1) ctx.scale(scale, scale)
    if (glowLayer) ctx.globalCompositeOperation = root.dark ? "lighter" : "source-over"
    var glowAt = [5, 7, 10]
    for (var i = 0; i < list.length; i++) {
      var op = list[i]
      if (op[0] === 3) {
        if (!glowLayer) ctx.globalCompositeOperation = root.dark && op[1] === 1 ? "lighter" : "source-over"
        continue
      }
      var g = op.length > glowAt[op[0]] ? op[glowAt[op[0]]] : 0
      if (glowLayer && !(g > 0)) continue
      if (op[0] === 0) {
        var a = glowLayer ? g : op[2]
        if (a <= 0) continue
        ctx.strokeStyle = root.roleColor(op[1], a)
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
        ctx.fillStyle = root.roleColor(op[1], glowLayer ? g : op[2])
        ctx.fillRect(op[3], op[4], op[5], op[6])
      } else if (op[0] === 2) {
        var k2 = glowLayer ? g : 1
        var gr = ctx.createLinearGradient(0, op[8], 0, op[9])
        gr.addColorStop(0, root.roleColor(op[1], op[2] * k2))
        gr.addColorStop(1, root.roleColor(op[1], op[3] * k2))
        ctx.fillStyle = gr
        ctx.fillRect(op[4], op[5], op[6], op[7])
      }
    }
    ctx.globalCompositeOperation = "source-over"
  }

  function hintFor(s) {
    return s === "notRecognized" ? "Face not recognized"
      : (s === "recognized" ? "Face recognized" : "Look at the camera")
  }

  // One card: a sharp canvas over a half-resolution glow canvas blurred twice
  // on the GPU, as the host's FaceChromeCanvas does.
  component Card: Item {
    id: card
    property string state_: "scanning"
    property real elapsed: 0
    property bool measure: false
    property var ops: []

    width: root.side
    height: root.side

    function refresh() {
      var began = measure ? Date.now() : 0
      card.ops = FaceCard.frame(root.side, { state: state_, clock: root.clock, elapsed: elapsed, style: root.style, host: root.host >= 2 ? 2 : undefined })
      sharp.requestPaint()
      if (root.host >= 2) glow.requestPaint()
      if (measure) {
        root.paintMs = root.paintMs * 0.9 + (Date.now() - began) * 0.1
        root.opCount = card.ops.length
      }
    }

    Canvas {
      id: glow
      width: root.side / 2
      height: root.side / 2
      visible: false
      renderTarget: Canvas.Image
      renderStrategy: Canvas.Cooperative
      onPaint: root.paintOps(getContext("2d"), card.ops, true, 0.5)
    }
    MultiEffect {
      anchors.fill: parent
      source: glow
      visible: root.host >= 2
      autoPaddingEnabled: true
      blurEnabled: true
      blur: 1.0
      blurMax: 48
      blurMultiplier: 0.6
      opacity: root.dark ? 0.95 : 0.45
    }
    MultiEffect {
      anchors.fill: parent
      source: glow
      visible: root.host >= 2
      autoPaddingEnabled: true
      blurEnabled: true
      blur: 0.55
      blurMax: 12
      opacity: root.dark ? 1 : 0.5
    }
    Canvas {
      id: sharp
      anchors.fill: parent
      renderTarget: Canvas.Image
      renderStrategy: Canvas.Cooperative
      onPaint: root.paintOps(getContext("2d"), card.ops, false, 1)
    }

    Connections {
      target: root
      function onClockChanged() { card.refresh() }
      function onStyleChanged() { card.refresh() }
      function onRolesChanged() { card.refresh() }
    }
    onState_Changed: refresh()
    Component.onCompleted: refresh()
  }

  component Chip: Rectangle {
    id: chip
    property string label: ""
    property bool on: false
    signal picked()
    implicitWidth: chipText.implicitWidth + 20
    implicitHeight: 26
    radius: 4
    color: chip.on ? Qt.rgba(root.accent.r, root.accent.g, root.accent.b, 0.18) : Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.06)
    border.width: 1
    border.color: chip.on ? root.accent : "transparent"
    Text {
      id: chipText
      anchors.centerIn: parent
      text: chip.label
      color: chip.on ? root.accent : root.foreground
      font.family: "monospace"
      font.pixelSize: 11
    }
    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: chip.picked()
    }
  }

  FloatingWindow {
    title: "omarchy-face card preview"
    implicitWidth: 1080
    implicitHeight: 440

    Rectangle {
      anchors.fill: parent
      color: root.surface

      Row {
        id: chips
        spacing: 7
        anchors.top: parent.top
        anchors.topMargin: 18
        anchors.horizontalCenter: parent.horizontalCenter
        Chip {
          label: "sequence"
          on: root.sequence
          onPicked: root.startSequence()
        }
        Repeater {
          model: [
            { s: "scanning", l: "Scanning" },
            { s: "recognized", l: "Recognized" },
            { s: "notRecognized", l: "Not recognized" }
          ]
          Chip {
            label: modelData.l
            on: !root.sequence && root.cardState === modelData.s
            onPicked: {
              root.sequence = false
              root.cardState = modelData.s
              root.enteredAt = root.clock
            }
          }
        }
        Chip {
          label: root.host >= 2 ? "host level 2: glow" : "host level 1: no glow"
          on: root.host >= 2
          onPicked: root.host = root.host >= 2 ? 1 : 2
        }
      }

      Row {
        id: styleChips
        spacing: 7
        anchors.top: chips.bottom
        anchors.topMargin: 8
        anchors.horizontalCenter: parent.horizontalCenter
        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: "style"
          color: root.foreground
          opacity: 0.5
          font.family: "monospace"
          font.pixelSize: 11
        }
        Repeater {
          model: root.styles
          Chip {
            label: modelData.l
            on: root.style === modelData.s
            onPicked: root.style = modelData.s
          }
        }
      }

      Row {
        anchors.top: styleChips.bottom
        anchors.topMargin: 18
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: 36

        // The hero: the card at the host's size, walking the script.
        Rectangle {
          width: root.side + 60
          height: root.side + 110
          radius: 10
          color: root.panel

          Card {
            id: hero
            anchors.horizontalCenter: parent.horizontalCenter
            y: 26
            measure: true
            state_: root.cardState
            elapsed: root.clock - root.enteredAt
          }
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: hero.y + hero.height + 16
            text: root.hintFor(root.cardState)
            color: root.cardState === "notRecognized" ? root.errorColor : root.foreground
            font.family: "monospace"
            font.pixelSize: 13
          }
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: hero.y + hero.height + 40
            text: root.opCount + " ops · " + root.paintMs.toFixed(1) + " ms/frame"
            color: root.foreground
            opacity: 0.35
            font.family: "monospace"
            font.pixelSize: 10
          }
        }

        Column {
          spacing: 10

          Text {
            text: "each state at the host's 220 px card, replaying its hold"
            color: root.foreground
            opacity: 0.5
            font.family: "monospace"
            font.pixelSize: 10
          }

          Row {
            spacing: 18
            Repeater {
              model: ["scanning", "recognized", "notRecognized"]
              Column {
                spacing: 8
                Rectangle {
                  width: root.side + 16
                  height: root.side + 16
                  radius: 8
                  color: root.panel
                  Card {
                    anchors.centerIn: parent
                    state_: modelData
                    elapsed: modelData === "scanning" ? 4000 + root.clock : (root.clock % (FaceCard.holdMs(modelData) + 900))
                  }
                }
                Text {
                  anchors.horizontalCenter: parent.horizontalCenter
                  text: root.hintFor(modelData)
                  color: modelData === "notRecognized" ? root.errorColor : root.foreground
                  font.family: "monospace"
                  font.pixelSize: 10
                }
              }
            }
          }
        }
      }
    }
  }
}
