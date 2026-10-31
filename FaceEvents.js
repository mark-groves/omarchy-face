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
//   _UID             the user's own uid, or root
// _EXE carries most of the weight. Inside `unshare -Ur` a plain logger reports
// the same capabilities and uid as a real sudo. What is left is a sudo run in
// the user's own namespaces with a fake face module, which can show at most a
// fake card, and any program running as the user can draw one anyway.

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

function trusted(entry, service, uid) {
  var runs = Object.prototype.hasOwnProperty.call(CALLERS, entry._EXE) ? CALLERS[entry._EXE] : []
  if (runs.indexOf(service) === -1) return false
  var caps = String(entry._CAP_EFFECTIVE || "")
  if (!/^[0-9a-f]+$/i.test(caps) || !/[1-9a-f]/i.test(caps)) return false
  return entry._UID === "0" || (uid !== "" && entry._UID === uid)
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
