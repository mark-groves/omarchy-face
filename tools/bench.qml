import QtQuick

// What frame() costs in Qt's own JavaScript engine (QV4), which is what the
// host and Card.qml pay on the shell's GUI thread every frame. node is about
// five times faster on the same code, so a change is measured here.
//
// Each file is loaded the way the fork's host loads a plugin (FaceChrome:
// strip the pragma, `new Function` over the text) and runs every style and
// state on the 220 px card at host level 3, 60 frames a second of each.
// Several files are interleaved, so a before and an after run under the
// same conditions:
//
//   QT_FORCE_STDERR_LOGGING=1 QT_QPA_PLATFORM=offscreen QML_DISABLE_DISK_CACHE=1 \
//     taskset -c 3 qml6 tools/bench.qml -- /abs/before/FaceCardFrame.js /abs/after/FaceCardFrame.js
//
// Options after the files: --reps=N (default 3), --styles=hud,radar,holo.
// QT_FORCE_STDERR_LOGGING keeps the output off the system journal; taskset
// keeps one core type (P and E cores differ by about 1.6x). Times are
// Date.now() milliseconds, so a mean is good to about 0.01 ms; "<=20" drops
// frames the scheduler took away, which on a busy machine skew the mean.
QtObject {
  Component.onCompleted: {
    try {
      run()
    } catch (e) {
      console.log("bench: " + e)
    }
    Qt.quit()
  }

  function load(path) {
    var xhr = new XMLHttpRequest()
    xhr.open("GET", "file://" + path, false)
    xhr.send()
    var src = String(xhr.responseText).replace(/^\s*\.pragma\s+library\s*$/m, "")
    return new Function(src + "\nreturn { frame: typeof frame === 'function' ? frame : null };")()
  }

  function run() {
    var args = Qt.application.arguments
    var files = [], reps = 3, styles = ["hud", "radar", "holo"]
    var seen = false
    for (var i = 0; i < args.length; i++) {
      if (seen) {
        if (args[i].indexOf("--reps=") === 0) reps = Number(args[i].slice(7))
        else if (args[i].indexOf("--styles=") === 0) styles = args[i].slice(9).split(",")
        else files.push(args[i])
      }
      if (args[i] === "--") seen = true
    }
    if (!files.length) throw new Error("usage: qml6 tools/bench.qml -- FILE [FILE...] [--reps=N] [--styles=a,b]")
    var apis = files.map(load)
    var phases = [["scanning", 3000], ["recognized", 1900], ["notRecognized", 1800]]

    function play(api, style, state, len, clock0, times) {
      var total = 0
      for (var e = 0; e <= len; e += 16.7) {
        var a = Date.now()
        api.frame(220, { state: state, elapsed: e, clock: clock0 + e, host: 3, style: style })
        var d = Date.now() - a
        total += d
        if (times) times.push(d)
      }
      return total
    }

    // The first frames of a fresh module are several times slower.
    for (var f = 0; f < apis.length; f++)
      for (var s = 0; s < styles.length; s++)
        for (var p = 0; p < phases.length; p++) play(apis[f], styles[s], phases[p][0], 600, 5000, null)

    var acc = files.map(function () { return {} })
    for (var rep = 0; rep < reps; rep++) {
      for (f = 0; f < apis.length; f++) {
        for (s = 0; s < styles.length; s++) for (p = 0; p < phases.length; p++) {
          var k = styles[s] + " " + phases[p][0]
          var cell = acc[f][k] || (acc[f][k] = [])
          play(apis[f], styles[s], phases[p][0], phases[p][1], 5000 + rep * 777, cell)
        }
      }
    }

    for (f = 0; f < files.length; f++) {
      console.log("== " + files[f])
      var all = 0, n = 0
      for (k in acc[f]) {
        var t = acc[f][k].slice().sort(function (x, y) { return x - y })
        var sum = 0, kept = 0, keptN = 0
        for (i = 0; i < t.length; i++) {
          sum += t[i]
          if (t[i] <= 20) { kept += t[i]; keptN++ }
        }
        all += sum
        n += t.length
        console.log("  " + (k + "                    ").slice(0, 20) + "  mean " + (sum / t.length).toFixed(2)
          + " ms  <=20 " + (kept / keptN).toFixed(2) + "  p95 " + t[Math.floor(t.length * 0.95)] + "  max " + t[t.length - 1])
      }
      console.log("  all                   mean " + (all / n).toFixed(2) + " ms over " + n + " frames")
    }
  }
}
