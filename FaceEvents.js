// Turns journal lines into face-card events for the standalone card (Card.qml)
// on a host without the polkit face slot. A pure reducer, kept out of QML so
// node can test it (test/events-test.js); Service.qml owns the processes.
//
// Display only. Nothing here authenticates or touches PAM: PAM and the face
// backend do the work and log the outcome, and the card is drawn from the log.
//
//   step(state, line, faceServices) -> { state, event?, probe? }
//   resolveRequester(state, pgrepOutput) -> { state, event? }
//
// event is { state: "scanning" | "recognized" | "notRecognized" | "cancel",
// service }. probe asks Service.qml to run the requester pgrep and hand its
// output to resolveRequester.
//
// Howdy logs only its verdict, as pam_howdy(<service>:auth): Face verification
// succeeded | timed out | failed: <reason>. The start of a scan is the line
// Omarchy's lid gate logs just before the face module runs:
// pam_exec(<service>:auth): /usr/bin/omarchy-hw-laptop-closed failed: exit code 1.
// The gate is also in a fingerprint-only stack, so it opens a scan only for a
// service whose PAM stack loads a face module (faceServices, read by
// Service.qml from /etc/pam.d). A stack without the gate still gets the
// verdict: the card then boots and plays the result straight away.
//
// facelock's daemon logs "camera format negotiated" when a scan starts and
// "authentication succeeded|failed" when it ends, without naming the caller,
// so the start asks which PAM helper is waiting. pam_facelock(<service>):
// <result> names the caller at the end.

// PAM services that get a card: terminal elevation and polkit prompts. A lock
// screen, a greeter or a login draws its own face UI, so their scans are left
// alone.
var SERVICES = ["sudo", "sudo-i", "su", "su-l", "polkit-1"]

var GATE = /pam_exec\(([^:()]+):auth\): \S*omarchy-hw-laptop-closed failed: exit code 1/
var HOWDY = /pam_howdy\(([^:()]+):auth\): Face verification (succeeded|timed out|failed)/
var FACELOCK_PAM = /^pam_facelock\(([^()]+)\): (\w+)/

function initialState() {
  // scanning: a scan is open. service: who asked, "" while unknown. quiet: the
  // scan belongs to something that draws its own UI, so its verdict is dropped.
  // announced: the card has been told about this scan.
  return { scanning: false, service: "", quiet: false, announced: false }
}

function shown(service) {
  return SERVICES.indexOf(service) !== -1
}

function hasFace(faceServices, service) {
  return !!(faceServices && faceServices[service])
}

function result(state, verdict, service) {
  var next = initialState()
  if (state.quiet && state.scanning) return { state: next }
  if (!shown(service)) return { state: next }
  return { state: next, event: { state: verdict, service: service } }
}

function step(state, rawLine, faceServices) {
  var s = state || initialState()
  var line = String(rawLine).replace(/\x1b\[[0-9;]*m/g, "")
  var m

  m = line.match(GATE)
  if (m) {
    if (!shown(m[1]) || !hasFace(faceServices, m[1])) return { state: s }
    return {
      state: { scanning: true, service: m[1], quiet: false, announced: true },
      event: { state: "scanning", service: m[1] }
    }
  }

  m = line.match(HOWDY)
  if (m) return result(s, m[2] === "succeeded" ? "recognized" : "notRecognized", m[1])

  if (line.indexOf("Face verification skipped") !== -1) {
    if (!s.scanning || s.quiet) return { state: initialState() }
    return { state: initialState(), event: { state: "cancel", service: s.service } }
  }

  if (line.indexOf("camera format negotiated") !== -1) {
    if (s.scanning) return { state: s }
    return { state: { scanning: true, service: "", quiet: false, announced: false }, probe: true }
  }

  if (line.indexOf("authentication succeeded") !== -1 || line.indexOf("authentication failed") !== -1) {
    // Without a known caller the verdict waits for the pam_facelock line.
    if (!s.scanning || s.quiet || s.service === "") return { state: s }
    var verdict = line.indexOf("authentication succeeded") !== -1 ? "recognized" : "notRecognized"
    return {
      state: { scanning: false, service: s.service, quiet: false, announced: false, settled: true },
      event: { state: verdict, service: s.service }
    }
  }

  if (line.indexOf("authentication cancelled") !== -1) {
    if (!s.scanning || s.quiet) return { state: initialState() }
    return { state: initialState(), event: { state: "cancel", service: s.service } }
  }

  m = line.match(FACELOCK_PAM)
  if (m) {
    // The authoritative end of a facelock scan. A verdict already shown from
    // the daemon line is not shown twice.
    if (s.settled || (s.quiet && s.scanning)) return { state: initialState() }
    var word = m[2]
    var outcome = word === "success" ? "recognized"
      : (word === "no_match" || word === "failure" || word === "fail" || word === "failed") ? "notRecognized"
      : "cancel"
    if (outcome === "cancel" && !s.announced) return { state: initialState() }
    return result({ scanning: false }, outcome, m[1])
  }

  return { state: s }
}

// `pgrep -l` output for the PAM helpers that ask for a face. polkit wins over
// sudo: a polkit prompt run from a terminal leaves a sudo process around.
// Neither means the scan belongs to something else, such as the lock screen.
function resolveRequester(state, pgrepOutput) {
  var s = state || initialState()
  if (!s.scanning || s.service !== "") return { state: s }
  var names = String(pgrepOutput || "").split("\n").map(function (l) {
    return l.trim().split(/\s+/).pop()
  })
  var who = names.indexOf("polkit-agent-he") !== -1 ? "polkit-1"
    : names.indexOf("sudo") !== -1 ? "sudo"
    : ""
  if (who === "") return { state: { scanning: true, service: "", quiet: true, announced: false } }
  return {
    state: { scanning: true, service: who, quiet: false, announced: true },
    event: { state: "scanning", service: who }
  }
}

// Which services in a PAM stack load a face module: the file text of
// /etc/pam.d/<service>, ignoring comments.
function stackHasFace(text) {
  return String(text || "").split("\n").some(function (l) {
    var t = l.replace(/#.*/, "")
    return /\bpam_(howdy|facelock)\.so\b/.test(t)
  })
}

if (typeof module !== "undefined")
  module.exports = { SERVICES, initialState, step, resolveRequester, stackHasFace }
