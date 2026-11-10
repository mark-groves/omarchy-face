#!/usr/bin/env node
'use strict'

// Tests for CardSchedule.js: when the standalone card shows which state.
// Times are plain milliseconds; the art's boot is 620 ms and each result's
// beat is 1000 ms here.

const assert = require('assert')
const S = require('../CardSchedule.js')

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failures++
    console.log('  FAIL ' + name + '\n       ' + e.message)
  }
}

const T = { scanMs: 620, noVerdictMs: 5000, beatMs: () => 1000 }

// Feeds [state, at] events in order, advancing to each event's time first.
function run(events, until) {
  let m = S.initial()
  for (const [state, at] of events) {
    m = S.advance(m, at, T)
    m = S.input(m, state, at, T)
  }
  return S.advance(m, until, T)
}
const shows = (m, phase, state, since) => {
  assert.strictEqual(m.phase, phase)
  if (state !== undefined) assert.strictEqual(m.state, state)
  if (since !== undefined) assert.strictEqual(m.since, since)
}

check('a scan start shows the card scanning at once', () => {
  shows(run([['scanning', 100]], 100), 'open', 'scanning', 100)
})

check('a verdict during the boot waits for it, a later one plays on arrival', () => {
  shows(run([['scanning', 0], ['recognized', 300]], 619), 'open', 'scanning')
  shows(run([['scanning', 0], ['recognized', 300]], 620), 'open', 'recognized', 620)
  shows(run([['scanning', 0], ['notRecognized', 900]], 900), 'open', 'notRecognized', 900)
})

check('a verdict with no scan on show opens straight into the result', () => {
  shows(run([['recognized', 50]], 50), 'open', 'recognized', 50)
})

check('a result plays its whole beat, then the card leaves', () => {
  shows(run([['scanning', 0], ['recognized', 700]], 1699), 'open', 'recognized')
  const m = run([['scanning', 0], ['recognized', 700]], 1700)
  shows(m, 'closing')
  shows(S.finishClose(m), 'closed')
})

check('a scan start during a result waits for its beat, and the next verdict for the new boot', () => {
  const events = [['scanning', 0], ['notRecognized', 700], ['scanning', 1200], ['recognized', 1500]]
  shows(run(events, 1699), 'open', 'notRecognized')
  shows(run(events, 1700), 'open', 'scanning', 1700)
  shows(run(events, 2319), 'open', 'scanning')
  shows(run(events, 2320), 'open', 'recognized', 2320)
})

check('a second verdict queues behind the first instead of cutting it', () => {
  const events = [['recognized', 0], ['notRecognized', 200]]
  shows(run(events, 999), 'open', 'recognized', 0)
  shows(run(events, 1000), 'open', 'notRecognized', 1000)
})

check('a scan with no verdict leaves after the no-verdict time, counted from its latest start', () => {
  shows(run([['scanning', 0]], 4999), 'open', 'scanning')
  shows(run([['scanning', 0]], 5000), 'closing')
  const again = run([['scanning', 0], ['scanning', 3000]], 7999)
  shows(again, 'open', 'scanning', 0)
  shows(S.advance(again, 8000, T), 'closing')
})

check('a cancel ends a scan on show, drops a queued one and lets a result finish', () => {
  shows(run([['scanning', 0], ['cancel', 400]], 400), 'closing')
  const queued = run([['recognized', 0], ['scanning', 300], ['cancel', 500]], 500)
  shows(queued, 'open', 'recognized')
  assert.deepStrictEqual(queued.queue, [])
  shows(S.advance(queued, 1000, T), 'closing')
  shows(run([['cancel', 0]], 0), 'closed')
})

check('an event during the exit brings the card back', () => {
  const leaving = run([['scanning', 0], ['cancel', 400]], 400)
  shows(S.input(leaving, 'scanning', 450, T), 'open', 'scanning', 450)
  shows(S.input(leaving, 'recognized', 450, T), 'open', 'recognized', 450)
})

check('close drops the queue and leaves', () => {
  const m = S.close(run([['scanning', 0], ['recognized', 100]], 100))
  shows(m, 'closing')
  assert.deepStrictEqual(m.queue, [])
})

check('the deadline is the next time something changes', () => {
  assert.strictEqual(S.deadline(run([['scanning', 0], ['recognized', 100]], 100), T), 620)
  assert.strictEqual(S.deadline(run([['scanning', 0]], 0), T), 5000)
  assert.strictEqual(S.deadline(run([['recognized', 0]], 0), T), 1000)
  assert.strictEqual(S.deadline(S.initial(), T), 0)
})

check('a replay script reads as timed events, and anything else is refused', () => {
  assert.deepStrictEqual(S.parseReplay('scanning:0, recognized:800'),
    [{ state: 'scanning', at: 0 }, { state: 'recognized', at: 800 }])
  assert.deepStrictEqual(S.parseReplay('recognized:900,scanning:0'),
    [{ state: 'scanning', at: 0 }, { state: 'recognized', at: 900 }])
  for (const bad of ['', 'scanning', 'scanning:-1', 'scanning:x', 'unlock:0', 'scanning:0;recognized:9', 'scanning:60001'])
    assert.strictEqual(S.parseReplay(bad), null, bad)
})

console.log(failures ? `\n${failures} schedule test(s) failed` : '\nall schedule tests passed')
process.exit(failures ? 1 : 0)
