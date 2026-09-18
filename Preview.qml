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
  property bool replay: true

  readonly property color accent: "#1e66f5"
  readonly property color foreground: "#4c4f69"
  readonly property color errorColor: "#d20f39"
  readonly property color surface: "#eff1f5"

  onCardStateChanged: enteredAt = clock

  FrameAnimation {
    running: true
    onTriggered: root.clock += frameTime * 1000
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

  component Card: Canvas {
    property string state_: "scanning"
    property real elapsed: 0
    property int side: 120

    width: side
    height: side
    renderTarget: Canvas.Image
    renderStrategy: Canvas.Cooperative

    onPaint: root.paintOps(getContext("2d"), side,
      FaceCard.frame(side, { state: state_, clock: root.clock, elapsed: elapsed }))
    onElapsedChanged: requestPaint()
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
    color: chip.on ? Qt.rgba(0.12, 0.4, 0.96, 0.22) : Qt.rgba(0.3, 0.31, 0.4, 0.08)
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
    implicitWidth: 720
    implicitHeight: 430

    Rectangle {
      anchors.fill: parent
      color: root.surface

      Column {
        anchors.centerIn: parent
        spacing: 18

        Row {
          spacing: 7
          anchors.horizontalCenter: parent.horizontalCenter
          Repeater {
            model: [
              { s: "scanning", l: "Scanning" },
              { s: "recognized", l: "Recognized" },
              { s: "notRecognized", l: "Not recognized" }
            ]
            Chip {
              label: modelData.l
              on: root.cardState === modelData.s
              onPicked: { root.replay = false; root.cardState = modelData.s }
            }
          }
          Chip {
            label: "replay all"
            on: root.replay
            onPicked: root.replay = true
          }
        }

        // The three states at once, each replaying on its own declared hold.
        Row {
          spacing: 26
          anchors.horizontalCenter: parent.horizontalCenter
          Repeater {
            model: ["scanning", "recognized", "notRecognized"]
            Column {
              spacing: 6
              Card {
                side: 132
                state_: modelData
                elapsed: modelData === "scanning" ? 0 : (root.clock % (FaceCard.holdMs(modelData) + 900))
              }
              Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: modelData === "notRecognized" ? "Face not recognized"
                  : (modelData === "recognized" ? "Face recognized" : "Look at the camera")
                color: modelData === "notRecognized" ? root.errorColor : root.foreground
                font.family: "monospace"
                font.pixelSize: 11
              }
            }
          }
        }

        // The size ladder. 30 px is the lock in-field slot, 26 px the polkit
        // glyph slot. Under 48 px the cloud is rendered as a vector glyph.
        Row {
          spacing: 16
          anchors.horizontalCenter: parent.horizontalCenter
          Repeater {
            model: [120, 96, 64, 44, 30, 24]
            Column {
              spacing: 4
              Item {
                width: modelData
                height: 120
                Card {
                  anchors.centerIn: parent
                  side: modelData
                  state_: root.replay ? "recognized" : root.cardState
                  elapsed: root.replay
                    ? (root.clock % (FaceCard.holdMs("recognized") + 900))
                    : root.clock - root.enteredAt
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
