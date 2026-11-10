import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import "FaceCardFrame.js" as FaceCard
import "FacePaint.js" as FacePaint
import "CardSchedule.js" as Schedule

// The standalone face card. Service.qml reports face events for sudo, or for
// a polkit prompt where the host does not draw the card in its own dialog
// (stock Omarchy), and this panel drops the same 220 px card the fork draws in
// its own surfaces in under the bar on the focused screen: it opens scanning
// when the scan starts, plays the verdict, then fades. It takes no input and
// never sits on the lock screen. CardFace.qml draws it and decides when each
// state shows; journal events, `show` and `replay` all reach it through
// show().
//
// The card is drawn the way the fork's host draws it, at op level 3: the frame
// is numbers from FaceCardFrame.js, painted by FacePaint.js on dark glass with
// a GPU bloom.
//
// The style is this plugin's row in ~/.config/omarchy/shell.json,
// { "id": "markgroves.polkit-face", "style": "radar" }, written through the
// shell's updateEntryInline like any plugin's own settings.
//
//   omarchy-shell face-card show scanning|recognized|notRecognized|cancel
//   omarchy-shell face-card replay "scanning:0,recognized:800"
//   omarchy-shell face-card demo
//   omarchy-shell face-card close
//   omarchy-shell face-card stats
//   omarchy-shell face-card style hud|radar|holo
//   omarchy-shell face-card styles
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var service: null   // injected by the host: this plugin's Service.qml

  readonly property int side: 220

  // This plugin's own row in shell.json.
  property string shellConfigText: ""
  readonly property var settings: root.ownEntry(root.shellConfigText, root.manifest ? root.manifest.id : "")
  readonly property string style: FaceCard.STYLES.indexOf(root.settings.style) !== -1
    ? root.settings.style : FaceCard.DEFAULT_STYLE

  property var theme: FacePaint.FALLBACK

  // True from a real face event (the journal's) until its card has gone. A
  // real event ends a preview (`show`, `replay`, `demo`) at once, dropping
  // its queued states, so a scripted verdict never plays into a real scan,
  // and no preview starts while a real card is up.
  property bool realShowing: false
  readonly property string refused: "refused: the card is showing a real face scan"

  // The one way in for a face event, whoever reports it.
  function show(state, real) {
    if (real && !root.realShowing) {
      root.stopReplay()
      face.close()
    } else if (!real && root.realShowing) {
      return false
    }
    face.show(state)
    if (real && face.needsWindow) root.realShowing = true
    return true
  }

  Connections {
    target: face
    function onNeedsWindowChanged() {
      if (!face.needsWindow) root.realShowing = false
    }
  }

  function ownEntry(text, id) {
    var config = null
    try {
      config = JSON.parse(text)
    } catch (e) {
      return {}
    }
    var plugins = config && Array.isArray(config.plugins) ? config.plugins : []
    for (var i = 0; i < plugins.length; i++)
      if (plugins[i] && plugins[i].id === id) return plugins[i]
    return {}
  }

  // Writes the style into this plugin's row. The row keeps any other setting.
  function setStyle(name) {
    if (FaceCard.STYLES.indexOf(name) === -1) return false
    if (name === root.style) return true
    var next = {}
    for (var key in root.settings) if (key !== "id") next[key] = root.settings[key]
    next.style = name
    return !!(root.shell && root.manifest && root.shell.updateEntryInline(root.manifest.id, next))
  }

  function close() {
    root.stopReplay()
    face.close()
  }

  // A replay feeds show() at times relative to the call, as journal events
  // would arrive. A new replay replaces one still running.
  property var replayEvents: []
  property real replayStartedAt: 0

  function startReplay(script) {
    var events = Schedule.parseReplay(script)
    if (!events || events.length === 0) return null
    root.replayEvents = events.slice()
    root.replayStartedAt = Date.now()
    root.feedReplay()
    return events
  }

  function feedReplay() {
    var now = Date.now()
    while (root.replayEvents.length && root.replayStartedAt + root.replayEvents[0].at <= now)
      root.show(root.replayEvents.shift().state)
    if (root.replayEvents.length === 0) return
    replayTimer.interval = Math.max(1, Math.ceil(root.replayStartedAt + root.replayEvents[0].at - now))
    replayTimer.restart()
  }

  function stopReplay() {
    root.replayEvents = []
    replayTimer.stop()
  }

  Timer {
    id: replayTimer
    onTriggered: root.feedReplay()
  }

  Connections {
    target: root.service
    function onEventSerialChanged() {
      var e = root.service.lastEvent
      if (e) root.show(e.state, true)
    }
  }

  IpcHandler {
    target: "face-card"
    function show(state: string): string {
      if (!root.show(state, false)) return root.refused
      return face.shownState || "closed"
    }
    // Events at milliseconds from now, through the same path as the journal's:
    // replay "scanning:0,recognized:800"
    function replay(script: string): string {
      if (root.realShowing) return root.refused
      var events = root.startReplay(script)
      if (!events) return "could not read the replay: give state:ms pairs such as scanning:0,recognized:800 (states: "
        + Schedule.STATES.join(" ") + ", 0 to 60000 ms)"
      return "replaying " + events.length + " events over " + events[events.length - 1].at + " ms"
    }
    function demo(): string {
      if (root.realShowing) return root.refused
      root.startReplay("scanning:0,recognized:2400")
      return "ok"
    }
    function close(): string { root.close(); return "ok" }
    // The last finished showing's face-probe line.
    function stats(): string { return JSON.stringify(face.lastProbe || {}) }
    function style(name: string): string {
      if (!root.setStyle(name)) return "could not set the style to " + name + " (styles: " + FaceCard.STYLES.join(" ") + ")"
      return name
    }
    function styles(): string { return root.style + " (styles: " + FaceCard.STYLES.join(" ") + ")" }
    function state(): string { return face.phase === "open" ? face.shownState : face.phase }
    // What the service sees: whether the host draws polkit prompts itself,
    // which PAM services get a card, and whether the journal is followed.
    function status(): string {
      var s = root.service
      return JSON.stringify({
        opened: face.phase !== "closed",
        state: face.shownState,
        queued: face.queued,
        quality: face.qualityLevel,
        style: root.style,
        hostDrawsPolkit: !!(s && s.hostDrawsPolkit),
        services: s ? s.services : null,
        journal: !!(s && s.journal && s.journal.running)
      })
    }
  }

  FileView {
    path: Quickshell.env("HOME") + "/.config/omarchy/shell.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.shellConfigText = text()
    onLoadFailed: root.shellConfigText = ""
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

  PanelWindow {
    id: panel

    screen: {
      var name = Hyprland.focusedMonitor ? Hyprland.focusedMonitor.name : ""
      var screens = Quickshell.screens
      for (var i = 0; i < screens.length; i++) if (screens[i].name === name) return screens[i]
      return screens.length > 0 ? screens[0] : null
    }
    visible: face.needsWindow
    anchors { top: true; left: true; right: true }
    implicitHeight: root.side + Style.space(96)
    color: "transparent"
    WlrLayershell.namespace: "markgroves-face-card"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore
    mask: Region {}

    CardFace {
      id: face
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.top: parent.top
      anchors.topMargin: Style.space(64)
      side: root.side
      style: root.style
      theme: root.theme
      enterMs: Style.duration(180)
      exitMs: Style.duration(120)
      easeOut: Style.easeOut
      surface: "sudo"
      windowName: "markgroves-face-card"
    }
  }
}
