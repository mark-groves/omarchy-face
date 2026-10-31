// Ceilings on what Service.qml reads from journalctl.
//
// A SplitParser with a delimiter, and a StdioCollector, buffer inside
// Quickshell before any plugin code can check a length. With an empty
// splitMarker a SplitParser hands over each chunk as it arrives and keeps
// nothing, so the reader takes raw chunks and assembles lines below,
// checking each length before the string it guards is built. On overflow the
// caller stops the child at once.

var MAX_LINE = 4096             // an entry trimmed to four fields is about 500 bytes
var MAX_LINES_PER_WINDOW = 400  // sudo and polkit log a few lines a prompt, never this many
var WINDOW_MS = 1000

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

if (typeof module !== "undefined")
  module.exports = { MAX_LINE, MAX_LINES_PER_WINDOW, WINDOW_MS, initialStream, feed }
