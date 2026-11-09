// When the standalone card (Card.qml) shows which state. Pure functions over a
// plain model, kept out of QML so node can test them (test/schedule-test.js).
//
//   initial() -> model
//   input(model, state, now, timing) -> model   a face event: scanning,
//                                               recognized, notRecognized or cancel
//   advance(model, now, timing) -> model        plays whatever is due by now
//   deadline(model, timing) -> ms | 0           when advance() next has work
//   close(model) -> model                       leave now, dropping the queue
//   finishClose(model) -> model                 the card's exit has played out
//
// Times are wall-clock milliseconds (Date.now() in the card). timing is
// { scanMs, noVerdictMs, beatMs: function (state) -> ms }: the art's boot,
// how long a scan with no verdict stays up, and each result's beat.
//
// model is { phase, state, since, scanSince, queue }:
//   phase      "closed", "open", or "closing" while the exit plays
//   state      what the card shows: "scanning", "recognized" or "notRecognized"
//   since      when that state began; the art's elapsed counts from it
//   scanSince  when the scan on show was reported; the no-verdict close counts from it
//   queue      events not shown yet, oldest first: [{ state, at }]
//
// The rules:
// - A scan start opens the card scanning at once. Another scan start while it
//   scans restarts the no-verdict clock, not the boot.
// - A verdict during a scan plays at max(its arrival, the scan's start +
//   scanMs), so the boot always plays out.
// - A verdict with no scan on show (its start line was missed) opens straight
//   into the result. There is no boot to fake: the command has already run.
// - A result plays its whole beat before anything replaces it. Later events
//   queue behind it in order, and with nothing queued the card leaves after
//   the beat.
// - A cancel ends the scan it belongs to: a queued scan is dropped, and a scan
//   on show with nothing after it leaves at once. A result still plays its beat.
// - A scan with no verdict leaves noVerdictMs after it was reported.

var STATES = ["scanning", "recognized", "notRecognized", "cancel"]
var MAX_QUEUE = 8

function initial() {
  return { phase: "closed", state: "", since: 0, scanSince: 0, queue: [] }
}

function copy(m) {
  return { phase: m.phase, state: m.state, since: m.since, scanSince: m.scanSince, queue: m.queue.slice() }
}

function isResult(state) {
  return state === "recognized" || state === "notRecognized"
}

function beat(timing, state) {
  var ms = Number(timing.beatMs(state))
  return ms > 0 ? ms : 0
}

// The earliest time the queue's head may replace what is on show.
function dueAt(m, next, timing) {
  if (m.phase !== "open") return next.at
  if (m.state === "scanning")
    return isResult(next.state) ? Math.max(next.at, m.since + Math.max(0, Number(timing.scanMs) || 0)) : next.at
  return Math.max(next.at, m.since + beat(timing, m.state))
}

// When what is on show ends by itself, with nothing queued.
function endsAt(m, timing) {
  return m.state === "scanning" ? m.scanSince + timing.noVerdictMs : m.since + beat(timing, m.state)
}

function input(model, state, now, timing) {
  if (STATES.indexOf(state) === -1) return model
  var m = copy(model)
  var tail = m.queue.length ? m.queue[m.queue.length - 1] : null

  if (state === "cancel") {
    while (m.queue.length && m.queue[m.queue.length - 1].state === "scanning") m.queue.pop()
    if (m.phase === "open" && m.state === "scanning" && m.queue.length === 0) m.queue.push({ state: "cancel", at: now })
  } else if (state === "scanning" && tail && tail.state === "scanning") {
    m.queue[m.queue.length - 1] = { state: "scanning", at: now }
  } else if (state === "scanning" && !tail && m.phase === "open" && m.state === "scanning") {
    m.scanSince = now
  } else {
    m.queue.push({ state: state, at: now })
    if (m.queue.length > MAX_QUEUE) m.queue.splice(0, m.queue.length - MAX_QUEUE)
  }
  return advance(m, now, timing)
}

function advance(model, now, timing) {
  var m = model
  for (var guard = 0; guard <= MAX_QUEUE; guard++) {
    if (m.queue.length === 0) {
      if (m.phase === "open" && endsAt(m, timing) <= now) {
        m = copy(m)
        m.phase = "closing"
      }
      return m
    }
    var next = m.queue[0]
    var due = dueAt(m, next, timing)
    if (due > now) return m
    m = copy(m)
    m.queue.shift()
    if (next.state === "cancel") {
      if (m.phase === "open" && m.state === "scanning") m.phase = "closing"
    } else if (next.state === "scanning" && m.phase === "open" && m.state === "scanning") {
      m.scanSince = next.at
    } else {
      m.phase = "open"
      m.state = next.state
      m.since = due
      if (next.state === "scanning") m.scanSince = next.at
    }
  }
  return m
}

function deadline(model, timing) {
  if (model.queue.length) return dueAt(model, model.queue[0], timing)
  return model.phase === "open" ? endsAt(model, timing) : 0
}

function close(model) {
  if (model.phase === "closed" && model.queue.length === 0) return model
  var m = copy(model)
  m.queue = []
  if (m.phase !== "closed") m.phase = "closing"
  return m
}

function finishClose(model) {
  if (model.phase !== "closing") return model
  var m = copy(model)
  m.phase = "closed"
  m.state = ""
  return m
}

if (typeof module !== "undefined")
  module.exports = { STATES, MAX_QUEUE, initial, input, advance, deadline, close, finishClose }
