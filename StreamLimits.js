// Ceilings on what Service.qml reads from its child processes.
//
// A SplitParser with a delimiter, and a StdioCollector, buffer inside
// Quickshell before any plugin code can check a length. With an empty
// splitMarker a SplitParser hands over each chunk as it arrives and keeps
// nothing, so every reader here takes raw chunks and assembles lines below,
// checking each length before the string it guards is built. On overflow the
// caller stops the child at once.

var MAX_LINE = 4096             // the longest real authpriv line is a few hundred
var MAX_LINES_PER_WINDOW = 400  // authpriv is busy during an update, never this busy
var WINDOW_MS = 1000
var MAX_COLLECTED = 4096        // pgrep -l for two names; real output is under 100

function initialStream() {
  return { pending: "", windowStart: 0, lines: 0 }
}

// feed(stream, chunk, now) -> { stream, lines, overflow }
function feed(stream, chunk, now) {
  var text = String(chunk)
  var pending = stream.pending
  var windowStart = stream.windowStart
  var count = stream.lines
  var out = []
  var start = 0

  for (;;) {
    var newline = text.indexOf("\n", start)
    var end = newline === -1 ? text.length : newline
    if (pending.length + (end - start) > MAX_LINE)
      return { stream: initialStream(), lines: out, overflow: true }
    if (newline === -1) {
      pending = pending + text.slice(start)
      break
    }
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now
      count = 0
    }
    if (++count > MAX_LINES_PER_WINDOW)
      return { stream: initialStream(), lines: out, overflow: true }
    out.push(pending + text.slice(start, newline))
    pending = ""
    start = newline + 1
  }

  return { stream: { pending: pending, windowStart: windowStart, lines: count }, lines: out, overflow: false }
}

// collect(text, chunk) -> { text, overflow }: a one-shot child's whole answer.
function collect(text, chunk) {
  var add = String(chunk)
  if (text.length + add.length > MAX_COLLECTED) return { text: "", overflow: true }
  return { text: text + add, overflow: false }
}

if (typeof module !== "undefined")
  module.exports = { MAX_LINE, MAX_LINES_PER_WINDOW, WINDOW_MS, MAX_COLLECTED, initialStream, feed, collect }
