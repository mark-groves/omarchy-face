import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import "FaceCardFrame.js" as FaceCard
import "FacePaint.js" as FacePaint

// The standalone face card, for a host without the polkit face slot (stock
// Omarchy). Service.qml reports a face scan for sudo or a polkit prompt, and
// this panel drops the same 220 px card the fork draws in its own surfaces in
// under the bar on the focused screen: it scans, then locks or misses, then
// fades. It takes no input and never sits on the lock screen.
//
// The card is drawn the way the fork's host draws it, at op level 3: the frame
// is numbers from FaceCardFrame.js, painted by FacePaint.js on dark glass with
// a GPU bloom.
//
//   omarchy-shell face-card show scanning|recognized|notRecognized
//   omarchy-shell face-card demo
//   omarchy-shell face-card close
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var service: null   // injected by the host: this plugin's Service.qml

  readonly property int side: 220
  readonly property int opLevel: 3

  property bool opened: false
  property string cardState: "scanning"
  property real clock: 0
  property real enteredAt: 0
  property real scanStartedAt: 0
  // A verdict that arrives before the card has finished booting waits for it.
  property string pendingResult: ""
  property real resultDueAt: 0
  property real closeAt: 0
  // A scan with no verdict, such as an abandoned prompt, gives up after this.
  readonly property int scanTimeoutMs: 15000
  // Reading time after a result's own hold.
  readonly property int lingerMs: 500

  property var theme: FacePaint.FALLBACK
  readonly property var glassTheme: FacePaint.deriveGlass(root.theme)
  readonly property var roles: root.glassTheme.roles
  property var ops: []

  function show(state) {
    if (state === "cancel") { close(); return }
    if (state !== "scanning" && state !== "recognized" && state !== "notRecognized") return

    if (!root.opened || state === "scanning") {
      if (!root.opened || root.cardState !== "scanning") {
        root.cardState = "scanning"
        root.enteredAt = root.clock
        root.scanStartedAt = root.clock
      }
      root.pendingResult = ""
      root.opened = true
      root.closeAt = root.clock + root.scanTimeoutMs
    }
    if (state === "scanning") return

    root.pendingResult = state
    root.resultDueAt = root.scanStartedAt + Math.max(0, Number(FaceCard.scanMs()) || 0)
    root.closeAt = Math.max(root.resultDueAt, root.clock) + FaceCard.holdMs(state) + root.lingerMs
  }

  function close() {
    root.opened = false
    root.pendingResult = ""
  }

  function tick() {
    if (root.pendingResult !== "" && root.clock >= root.resultDueAt) {
      root.cardState = root.pendingResult
      root.enteredAt = root.clock
      root.pendingResult = ""
    }
    if (root.opened && root.clock >= root.closeAt) root.opened = false
    root.ops = FaceCard.frame(root.side, {
      state: root.cardState, clock: root.clock, elapsed: root.clock - root.enteredAt, host: root.opLevel
    })
    sharp.requestPaint()
    if (root.bloom) glow.requestPaint()
  }

  Connections {
    target: root.service
    function onEventSerialChanged() {
      var e = root.service.lastEvent
      if (e) root.show(e.state)
    }
  }

  IpcHandler {
    target: "face-card"
    function show(state: string): string { root.show(state); return root.opened ? root.cardState : "closed" }
    function demo(): string {
      root.show("scanning")
      demoTimer.restart()
      return "ok"
    }
    function close(): string { root.close(); return "ok" }
    function state(): string { return root.opened ? (root.pendingResult || root.cardState) : "closed" }
    // What the service sees: whether the host draws the card itself, and which
    // PAM services load a face module.
    function status(): string {
      var s = root.service
      return JSON.stringify({
        opened: root.opened,
        state: root.cardState,
        hostDrawsCard: !!(s && s.hostDrawsCard),
        faceServices: s ? s.faceServices : null,
        journal: !!(s && s.journal && s.journal.running)
      })
    }
  }

  Timer {
    id: demoTimer
    interval: 2400
    onTriggered: root.show("recognized")
  }

  FileView {
    path: Quickshell.env("HOME") + "/.local/state/omarchy/current/theme/colors.toml"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      var named = FacePaint.parseTheme(text())
      if (named) root.theme = named
    }
  }

  // The bloom needs a GPU; on the software scene graph the card is drawn sharp.
  readonly property bool bloom: GraphicsInfo.api !== GraphicsInfo.Software

  PanelWindow {
    id: panel

    screen: {
      var name = Hyprland.focusedMonitor ? Hyprland.focusedMonitor.name : ""
      var screens = Quickshell.screens
      for (var i = 0; i < screens.length; i++) if (screens[i].name === name) return screens[i]
      return screens.length > 0 ? screens[0] : null
    }
    visible: root.opened || card.opacity > 0
    anchors { top: true; left: true; right: true }
    implicitHeight: root.side + Style.space(96)
    color: "transparent"
    WlrLayershell.namespace: "markgroves-face-card"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore
    mask: Region {}

    FrameAnimation {
      running: panel.visible
      onTriggered: {
        // Capped like the host's presented-frame step, so a stall is not a jump.
        root.clock += Math.min(frameTime * 1000, 50)
        root.tick()
      }
    }

    Item {
      id: card
      width: root.side
      height: root.side
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.top: parent.top
      anchors.topMargin: Style.space(64)

      opacity: root.opened ? 1 : 0
      scale: root.opened ? 1 : 0.97
      Behavior on opacity {
        NumberAnimation { duration: Style.duration(root.opened ? 180 : 120); easing.type: Easing.OutCubic }
      }
      Behavior on scale {
        NumberAnimation { duration: Style.duration(180); easing.type: Easing.Bezier; easing.bezierCurve: Style.easeOut }
      }

      Rectangle {
        anchors.fill: parent
        radius: Math.round(root.side * 0.045)
        border.width: 1
        border.color: root.glassTheme.edge
        gradient: Gradient {
          GradientStop { position: 0; color: Qt.tint(root.glassTheme.panel, Qt.alpha(root.glassTheme.edge, 0.55)) }
          GradientStop { position: 0.45; color: root.glassTheme.panel }
          GradientStop { position: 1; color: root.glassTheme.panel }
        }
      }

      // A half-resolution glow layer blurred twice on the GPU, a tight halo
      // and a wide bloom, under the sharp strokes.
      Canvas {
        id: glow
        width: root.side / 2
        height: root.side / 2
        visible: false
        renderTarget: Canvas.Image
        renderStrategy: Canvas.Cooperative
        onPaint: FacePaint.paintOps(getContext("2d"), root.ops, true, 0.5, root.roles, true)
      }
      MultiEffect {
        anchors.fill: parent
        source: glow
        visible: root.bloom
        autoPaddingEnabled: true
        blurEnabled: true
        blur: 1.0
        blurMax: 48
        blurMultiplier: 0.6
        opacity: 0.95
      }
      MultiEffect {
        anchors.fill: parent
        source: glow
        visible: root.bloom
        autoPaddingEnabled: true
        blurEnabled: true
        blur: 0.55
        blurMax: 12
      }
      Canvas {
        id: sharp
        anchors.fill: parent
        renderTarget: Canvas.Image
        renderStrategy: Canvas.Cooperative
        onPaint: FacePaint.paintOps(getContext("2d"), root.ops, false, 1, root.roles, true)
      }
    }
  }
}
