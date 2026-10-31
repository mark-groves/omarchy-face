import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "FaceEvents.js" as Events
import "StreamLimits.js" as Limits

// Feeds the standalone card (Card.qml) with face verdicts for sudo and polkit
// prompts.
//
// Display only. It follows the system journal for the face backend's verdicts
// and tells the card through lastEvent/eventSerial. Nothing here runs with
// privileges, writes a file or touches PAM; which lines count is decided in
// FaceEvents.js.
//
// The journal is followed only while /etc/pam.d/sudo or polkit-1 loads a face
// module. On the Omarchy fork the host draws this plugin's FaceCardFrame.js
// inside its own polkit dialog and lock screen, so polkit verdicts are left to
// it there and only sudo gets this card.
//
// The child is launched by absolute path, with a fixed argument vector and a
// closed environment, and everything it prints is bounded in StreamLimits.js.
QtObject {
  id: root

  property var shell: null
  property var manifest: null

  // The card watches eventSerial and reads lastEvent.
  property var lastEvent: null
  property int eventSerial: 0

  // The fork's face slot is a qs.Commons singleton that stock Omarchy does not
  // have, so on stock the lookup throws.
  readonly property bool hostDrawsPolkit: {
    try {
      return FaceChrome.cardSide > 0
    } catch (e) {
      return false
    }
  }

  property bool sudoHasFace: false
  property bool polkitHasFace: false

  // The PAM services that get a card right now.
  readonly property var services: ({
    "sudo": root.sudoHasFace,
    "sudo-i": root.sudoHasFace,
    "polkit-1": root.polkitHasFace && !root.hostDrawsPolkit
  })
  readonly property bool following: root.sudoHasFace || (root.polkitHasFace && !root.hostDrawsPolkit)

  // A real sudo logs as the user who ran it. pam_systemd names the runtime
  // directory after that uid.
  readonly property string uid: {
    var m = /^\/run\/user\/(\d+)$/.exec(Quickshell.env("XDG_RUNTIME_DIR") || "")
    return m ? m[1] : ""
  }

  readonly property var childEnvironment: ({ "PATH": "/usr/bin", "LC_ALL": "C" })

  onFollowingChanged: root.journal.running = root.following

  property FileView sudoStack: FileView {
    path: "/etc/pam.d/sudo"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.sudoHasFace = Events.stackHasFace(text())
    onLoadFailed: root.sudoHasFace = false
  }

  property FileView polkitStack: FileView {
    path: "/etc/pam.d/polkit-1"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.polkitHasFace = Events.stackHasFace(text())
    onLoadFailed: root.polkitHasFace = false
  }

  property var journalStream: Limits.initialStream()

  // Only the callers' own lines, trimmed to the fields the trust check reads.
  property Process journal: Process {
    command: ["/usr/bin/journalctl", "--follow", "--lines=0", "--output=json",
              "--output-fields=MESSAGE,_EXE,_UID,_CAP_EFFECTIVE"]
      .concat(Object.keys(Events.CALLERS).map(function(exe) { return "_EXE=" + exe }))
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
          var event = Events.verdict(Events.parseEntry(fed.lines[i]), { uid: root.uid, services: root.services })
          if (event) {
            root.lastEvent = event
            root.eventSerial++
          }
        }
      }
    }
    onExited: {
      root.journalStream = Limits.initialStream()
      if (!root.following) return
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
    onTriggered: root.journal.running = root.following
  }
}
