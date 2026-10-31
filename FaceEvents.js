// Turns journal entries into face-card verdicts for the standalone card
// (Card.qml). Pure functions, kept out of QML so node can test them
// (test/events-test.js); Service.qml owns the journal process.
//
// Display only. Nothing here authenticates or touches PAM: PAM and the face
// backend do the work and log the outcome, and the card is drawn from the log.
//
//   parseEntry(line) -> entry | null      one line of `journalctl --output=json`
//   verdict(entry, context) -> event | null
//   stackHasFace(text) -> bool            whether a PAM stack loads a face module
//
// context is { uid, services }: the user's uid as a string, and the PAM
// services that get a card right now ({ sudo: true, "polkit-1": false }).
// event is { state: "recognized" | "notRecognized", service }.
//
// The backends log only their verdicts, Howdy as
// pam_howdy(<service>:auth): Face verification succeeded | timed out | failed: <reason>
// and facelock as pam_facelock(<service>): <result>. Neither logs the start of
// a scan, so the card boots and plays the verdict straight away.
//
// Any program running as the user can log the same text, and journals here
// hold forged pam_howdy lines. A verdict counts only when the fields journald
// fills in itself say a real PAM caller sent it:
//   _EXE             sudo or the polkit agent helper, and the service in the
//                    text is one that binary runs
//   _CAP_EFFECTIVE   non-zero: the sender held root's capabilities
//   the user's uid   sudo logs as the user who ran it (_UID). The polkit helper
//                    is socket-activated and always logs as root, so systemd's
//                    name for its instance (_SYSTEMD_UNIT) carries the uid of
//                    the agent that asked; a setuid helper (polkit before 126)
//                    logs as the user, like sudo
// _EXE carries most of the weight. Inside `unshare -Ur` a plain logger reports
// the same capabilities and uid as a real sudo. What is left can show at most
// a fake card, which any program running as the user can draw anyway: a sudo
// run in the user's own namespaces with a fake face module, or a line sent
// just before its sender execs sudo, before journald reads its /proc entry.
//
// The prefixed verdicts are howdy-next 3.4.2's. Earlier versions logged a bare
// "Face verification succeeded" that names no service, and get no card.

// The PAM callers that get a card, and the services each one runs. The lock
// screen, a greeter or su are not here: they draw their own face UI or have
// no face to check.
var CALLERS = {
  "/usr/bin/sudo": ["sudo", "sudo-i"],
  "/usr/lib/polkit-1/polkit-agent-helper-1": ["polkit-1"]
}

var HOWDY = /^pam_howdy\(([^:()]+):auth\): Face verification (succeeded|timed out|failed)/
var FACELOCK = /^pam_facelock\(([^()]+)\): (\w+)/

function parseEntry(line) {
  try {
    var entry = JSON.parse(line)
    return entry && typeof entry === "object" ? entry : null
  } catch (e) {
    return null
  }
}

var HELPER_UNIT = /^polkit-agent-helper@.+-(\d+)\.service$/

function trusted(entry, service, uid) {
  var runs = Object.prototype.hasOwnProperty.call(CALLERS, entry._EXE) ? CALLERS[entry._EXE] : []
  if (runs.indexOf(service) === -1) return false
  var caps = String(entry._CAP_EFFECTIVE || "")
  if (!/^[0-9a-f]+$/i.test(caps) || !/[1-9a-f]/i.test(caps)) return false
  if (uid === "") return false
  var unit = HELPER_UNIT.exec(String(entry._SYSTEMD_UNIT || ""))
  if (service === "polkit-1" && unit) return unit[1] === uid
  return entry._UID === uid
}

function verdict(entry, context) {
  if (!entry || typeof entry.MESSAGE !== "string") return null
  var uid = context && context.uid ? String(context.uid) : ""
  var services = (context && context.services) || {}
  var service = ""
  var state = ""
  var m

  if ((m = entry.MESSAGE.match(HOWDY))) {
    service = m[1]
    state = m[2] === "succeeded" ? "recognized" : "notRecognized"
  } else if ((m = entry.MESSAGE.match(FACELOCK))) {
    service = m[1]
    state = m[2] === "success" ? "recognized"
      : (m[2] === "no_match" || m[2] === "failure" || m[2] === "fail" || m[2] === "failed") ? "notRecognized"
      : ""
  }

  if (state === "" || services[service] !== true) return null
  if (!trusted(entry, service, uid)) return null
  return { state: state, service: service }
}

// The text of /etc/pam.d/<service>, ignoring comments.
function stackHasFace(text) {
  return String(text || "").split("\n").some(function (l) {
    var t = l.replace(/#.*/, "")
    return /\bpam_(howdy|facelock)\.so\b/.test(t)
  })
}

if (typeof module !== "undefined")
  module.exports = { CALLERS, parseEntry, verdict, stackHasFace }
