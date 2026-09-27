import QtQuick
import Quickshell
import "FaceCardFrame.js" as FaceCard

// Developer harness for the face card. Not shipped and not loaded by the host.
//
// It is also the reference for how the host is meant to drive this plugin.
// The plugin returns a frame as numbers. The harness owns the Canvas, owns the
// palette, and does the drawing. It never hands the plugin a context, because
// a context exposes its canvas, the canvas is an Item, and an Item's parent
// chain reaches the password field on a credential surface.
//
// `paintOps` below mirrors the host painter in shell/Commons/FaceCardPainter.js.
//
//   quickshell -p Preview.qml
ShellRoot {
  id: root

  property real clock: 0
  property string cardState: "scanning"
  property real enteredAt: 0
  property bool sequence: true
  property bool dark: true
  // The harness passes the style per frame as spec.style. An installed card
  // takes it from the STYLE line instead (bin/omarchy-face-style).
  property string style: Quickshell.env("FACE_STYLE") || "hud"
  readonly property var styles: [
    { s: "hud", l: "Depth Lattice HUD" },
    { s: "radar", l: "Phosphor Radar" },
    { s: "holo", l: "Holographic Wireframe" }
  ]

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

  readonly property color surface: dark ? "#16161e" : "#eff1f5"
  readonly property color panel: dark ? "#1a1b26" : "#e6e9ef"
  readonly property color accent: dark ? "#7aa2f7" : "#1e66f5"
  readonly property color foreground: dark ? "#c0caf5" : "#4c4f69"
  readonly property color errorColor: dark ? "#f7768e" : "#d20f39"

  property real paintMs: 0
  property int opCount: 0

  onCardStateChanged: enteredAt = clock

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

  function roleColor(role, alpha) {
    var c = role === 2 ? root.errorColor : (role === 1 ? root.foreground : root.accent)
    return Qt.rgba(c.r, c.g, c.b, Math.max(0, Math.min(1, alpha)))
  }

  // Mirrors the host painter. Ops are numbers; anything else is not drawn.
  function paintOps(ctx, size, list) {
    ctx.reset()
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    for (var i = 0; i < list.length; i++) {
      var op = list[i]
      if (op[0] === 0) {
        ctx.strokeStyle = root.roleColor(op[1], op[2])
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
        ctx.fillStyle = root.roleColor(op[1], op[2])
        ctx.fillRect(op[3], op[4], op[5], op[6])
      } else if (op[0] === 2) {
        var g = ctx.createLinearGradient(0, op[8], 0, op[9])
        g.addColorStop(0, root.roleColor(op[1], op[2]))
        g.addColorStop(1, root.roleColor(op[1], op[3]))
        ctx.fillStyle = g
        ctx.fillRect(op[4], op[5], op[6], op[7])
      }
    }
  }

  function hintFor(s) {
    return s === "notRecognized" ? "Face not recognized"
      : (s === "recognized" ? "Face recognized" : "Look at the camera")
  }

  component Card: Canvas {
    id: card
    property string state_: "scanning"
    property real elapsed: 0
    property int side: 116
    property bool measure: false

    width: side
    height: side
    renderTarget: Canvas.Image
    renderStrategy: Canvas.Cooperative

    onPaint: {
      var began = measure ? Date.now() : 0
      var ops = FaceCard.frame(side, { state: state_, clock: root.clock, elapsed: elapsed, style: root.style })
      root.paintOps(getContext("2d"), side, ops)
      if (measure) {
        root.paintMs = root.paintMs * 0.9 + (Date.now() - began) * 0.1
        root.opCount = ops.length
      }
    }
    Connections {
      target: root
      function onClockChanged() { card.requestPaint() }
      function onStyleChanged() { card.requestPaint() }
    }
    onState_Changed: requestPaint()
    Component.onCompleted: requestPaint()
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
    implicitWidth: 900
    implicitHeight: 570

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
          label: root.dark ? "dark" : "light"
          on: false
          onPicked: root.dark = !root.dark
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
        anchors.topMargin: 16
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: 40

        // The hero: the card at a large size, walking the script.
        Rectangle {
          width: 330
          height: 400
          radius: 10
          color: root.panel

          Card {
            id: hero
            anchors.horizontalCenter: parent.horizontalCenter
            y: 24
            side: 282
            measure: true
            state_: root.cardState
            elapsed: root.clock - root.enteredAt
          }
          Text {
            anchors.horizontalCenter: parent.horizontalCenter
            y: hero.y + hero.height + 18
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
          spacing: 26

          Text {
            text: "116 px, the real lock / polkit / sudo slot"
            color: root.foreground
            opacity: 0.5
            font.family: "monospace"
            font.pixelSize: 10
          }

          // The three states at the real slot size, each replaying on its hold.
          Row {
            spacing: 22
            Repeater {
              model: ["scanning", "recognized", "notRecognized"]
              Column {
                spacing: 8
                Rectangle {
                  width: 132
                  height: 132
                  radius: 8
                  color: root.panel
                  Card {
                    anchors.centerIn: parent
                    side: 116
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

          Text {
            text: "size ladder: chrome drops below 100 / 76 px, vector glyph below 48 px"
            color: root.foreground
            opacity: 0.5
            font.family: "monospace"
            font.pixelSize: 10
          }

          Row {
            spacing: 16
            Repeater {
              model: [96, 64, 44, 30, 24]
              Column {
                spacing: 4
                Item {
                  width: modelData
                  height: 100
                  Card {
                    anchors.centerIn: parent
                    side: modelData
                    state_: root.cardState
                    elapsed: root.clock - root.enteredAt
                  }
                }
                Text {
                  anchors.horizontalCenter: parent.horizontalCenter
                  text: modelData
                  color: root.foreground
                  opacity: 0.5
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
