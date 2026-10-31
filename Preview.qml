import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
import "FaceCardFrame.js" as FaceCard
import "FacePaint.js" as FacePaint

// Developer harness for the face card. Not shipped and not loaded by the host.
//
// It is also the reference for how the host is meant to drive this plugin.
// The plugin returns a frame as numbers. The harness owns the Canvas, owns the
// palette, and does the drawing. It never hands the plugin a context, because
// a context exposes its canvas, the canvas is an Item, and an Item's parent
// chain reaches the password field on a credential surface.
//
// FacePaint.js mirrors the host painter (shell/Commons/FaceCardPainter.js in
// the Omarchy fork) at op level 3, and is the same painter the standalone card
// (Card.qml) uses. Colours come from the active Omarchy theme's colors.toml
// when there is one.
//
//   quickshell -p Preview.qml
ShellRoot {
  id: root

  property real clock: 0
  property string cardState: "scanning"
  property real enteredAt: 0
  property bool sequence: true
  // Op level the harness paints, as the host would report it in spec.host.
  property int host: 3
  // The harness passes the style per frame as spec.style, as Card.qml does
  // with the style saved in the plugin's shell.json row.
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

  property var theme: FacePaint.FALLBACK
  readonly property color surface: Qt.darker(theme.background, 1.3)
  readonly property color panel: theme.background
  readonly property color accent: FacePaint.accentOf(theme)
  readonly property color foreground: FacePaint.foregroundOf(theme)
  readonly property color errorColor: FacePaint.errorOf(theme)
  readonly property bool glass: root.host >= 3
  readonly property var glassTheme: FacePaint.deriveGlass(root.theme)
  readonly property bool dark: root.glass || FacePaint.luminance(theme.background) < 0.5
  readonly property var roles: root.glass ? root.glassTheme.roles : FacePaint.deriveRoles(root.theme)

  property real paintMs: 0
  property int opCount: 0

  onCardStateChanged: enteredAt = clock

  FileView {
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    printErrors: false
    watchChanges: true
    onFileChanged: reload()
    onLoaded: {
      var named = FacePaint.parseTheme(text())
      if (named) root.theme = named
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

    Rectangle {
      anchors.fill: parent
      visible: root.glass
      radius: Math.round(root.side * 0.045)
      border.width: 1
      border.color: root.glassTheme.edge
      gradient: Gradient {
        GradientStop { position: 0; color: Qt.tint(root.glassTheme.panel, Qt.alpha(root.glassTheme.edge, 0.55)) }
        GradientStop { position: 0.45; color: root.glassTheme.panel }
        GradientStop { position: 1; color: root.glassTheme.panel }
      }
    }

    function refresh() {
      var began = measure ? Date.now() : 0
      card.ops = FaceCard.frame(root.side, { state: state_, clock: root.clock, elapsed: elapsed, style: root.style, host: root.host >= 2 ? root.host : undefined })
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
      onPaint: FacePaint.paintOps(getContext("2d"), card.ops, true, 0.5, root.roles, root.dark)
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
      opacity: root.dark ? 0.95 : 0.85
    }
    MultiEffect {
      anchors.fill: parent
      source: glow
      visible: root.host >= 2
      autoPaddingEnabled: true
      blurEnabled: true
      blur: 0.55
      blurMax: 12
      opacity: 1
    }
    Canvas {
      id: sharp
      anchors.fill: parent
      renderTarget: Canvas.Image
      renderStrategy: Canvas.Cooperative
      onPaint: FacePaint.paintOps(getContext("2d"), card.ops, false, 1, root.roles, root.dark)
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
          label: root.host >= 3 ? "host level 3: glass" : (root.host === 2 ? "host level 2: glow" : "host level 1: no glow")
          on: root.host >= 2
          onPicked: root.host = root.host >= 3 ? 1 : root.host + 1
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
