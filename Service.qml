import QtQuick
import Quickshell
import Quickshell.Io
import "FaceEvents.js" as Events
import "StreamLimits.js" as Limits

// Feeds the standalone card (Card.qml) on a host without the polkit face slot.
//
// Display only. It follows the system journal for the face backend's verdicts
// (Howdy through authpriv, facelock through its daemon and PAM module) and
// tells the card through lastEvent/eventSerial. Nothing here runs with
// privileges, writes a file or touches PAM; the rules live in FaceEvents.js.
//
// On the Omarchy fork the host draws this plugin's FaceCardFrame.js inside its
// own polkit card, lock screen and sudo overlay. There the service stays
// quiet, so a scan never shows two cards.
//
// Every child is launched by absolute path, with a fixed argument vector and a
// closed environment, and everything it prints is bounded in StreamLimits.js.
QtObject {
  id: root

  property var shell: null
  property var manifest: null
  property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"

  // The card watches eventSerial and reads lastEvent.
  property var lastEvent: null
  property int eventSerial: 0

  // The host has the face slot and draws the card itself.
  property bool hostDrawsCard: false

  // PAM services whose stack loads a face module.
  property var faceServices: ({})

  property var state: Events.initialState()

  readonly property var childEnvironment: ({ "PATH": "/usr/bin", "LC_ALL": "C" })
  readonly property int oneShotDeadlineMs: 3000

  function announce(event) {
    if (!event || root.hostDrawsCard) return
    root.lastEvent = event
    root.eventSerial++
  }

  function apply(result) {
    root.state = result.state
    if (result.probe && !root.requester.running) root.requester.running = true
    root.announce(result.event)
  }

  property FileView hostSlot: FileView {
    path: root.omarchyPath + "/shell/Commons/FaceChrome.qml"
    printErrors: false
    onLoaded: root.hostDrawsCard = true
    onLoadFailed: root.hostDrawsCard = false
  }

  property FileView sudoStack: FileView {
    path: "/etc/pam.d/sudo"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.markStack(["sudo", "sudo-i"], text())
    onLoadFailed: root.markStack(["sudo", "sudo-i"], "")
  }

  property FileView polkitStack: FileView {
    path: "/etc/pam.d/polkit-1"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.markStack(["polkit-1"], text())
    onLoadFailed: root.markStack(["polkit-1"], "")
  }

  property FileView suStack: FileView {
    path: "/etc/pam.d/su"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.markStack(["su", "su-l"], text())
    onLoadFailed: root.markStack(["su", "su-l"], "")
  }

  function markStack(services, text) {
    var face = Events.stackHasFace(text)
    var next = Object.assign({}, root.faceServices)
    for (var i = 0; i < services.length; i++) next[services[i]] = face
    root.faceServices = next
  }

  // authpriv carries every PAM module's own lines, Howdy's included. facelock's
  // daemon logs to its unit, and its PAM module under its own identifier.
  property var journalStream: Limits.initialStream()

  property Process journal: Process {
    running: true
    command: ["/usr/bin/journalctl", "--follow", "--lines=0", "--output=cat",
              "SYSLOG_FACILITY=10",
              "+", "_SYSTEMD_UNIT=facelock-daemon.service",
              "+", "SYSLOG_IDENTIFIER=pam_facelock"]
    clearEnvironment: true
    environment: root.childEnvironment
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) {
        var fed = Limits.feed(root.journalStream, chunk, Date.now())
        root.journalStream = fed.stream
        if (fed.overflow) { root.journal.running = false; return }
        for (var i = 0; i < fed.lines.length; i++) {
          root.journalFailures = 0
          root.apply(Events.step(root.state, fed.lines[i], root.faceServices))
        }
      }
    }
    onExited: {
      root.journalStream = Limits.initialStream()
      root.journalFailures++
      root.journalRestart.restart()
    }
  }

  // journalctl exits on journal rotation now and then. Come back, but back off
  // where it cannot run at all, so it is not respawned every few seconds for
  // the life of the shell. The first line read resets this.
  property int journalFailures: 0
  property Timer journalRestart: Timer {
    interval: Math.min(300000, 3000 * Math.max(1, root.journalFailures))
    onTriggered: root.journal.running = true
  }

  // facelock does not name the caller when a scan starts: whichever PAM
  // helper is alive then is the one asking.
  property string requesterText: ""

  property Process requester: Process {
    command: ["/usr/bin/pgrep", "-l", "^(sudo|su|polkit-agent-he)$"]
    clearEnvironment: true
    environment: root.childEnvironment
    stdout: SplitParser {
      splitMarker: ""
      onRead: function(chunk) {
        var got = Limits.collect(root.requesterText, chunk)
        root.requesterText = got.text
        if (got.overflow) root.requester.running = false
      }
    }
    onStarted: {
      root.requesterText = ""
      root.requesterDeadline.restart()
    }
    onExited: {
      root.requesterDeadline.stop()
      root.apply(Events.resolveRequester(root.state, root.requesterText))
      root.requesterText = ""
    }
  }

  property Timer requesterDeadline: Timer {
    interval: root.oneShotDeadlineMs
    onTriggered: root.requester.running = false
  }
}
