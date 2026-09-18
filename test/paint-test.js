#!/usr/bin/env node
'use strict'

// Behaviour tests for FaceCardPaint.js.
//
// Two of these are load-bearing rather than cosmetic. The purity checks are the
// reason the host is allowed to paint this plugin instead of loading it as an
// Item beside a password field, and the dot-count check is the visual Mark
// signed off: a recognised face is drawn, not dotted.

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'FaceCardPaint.js'), 'utf8')

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

// --- the module has no route out of itself ---------------------------------

check('declares itself a QML library', () => {
  assert.match(source, /^\.pragma library\s*$/m)
})

check('imports nothing', () => {
  const hits = source.split('\n').filter(l =>
    !l.trim().startsWith('//') && /\b(require|import)\s*[("']/.test(l))
  assert.deepStrictEqual(hits, [])
})

check('never names a host object', () => {
  const banned = /\b(Qt|Quickshell|Qml)\s*\.|\bparent\b|\bflow\b|\bPamContext\b|\bpasswordInput\b/
  const hits = source.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => !l.trim().startsWith('//') && banned.test(l))
    .map(([n, l]) => n + ': ' + l.trim())
  assert.deepStrictEqual(hits, [])
})

check('reads no ambient state', () => {
  const banned = /\b(Date|globalThis|window|process|XMLHttpRequest|fetch|setTimeout|setInterval)\b/
  const hits = source.split('\n')
    .filter(l => !l.trim().startsWith('//') && banned.test(l))
  assert.deepStrictEqual(hits, [])
})

// --- load it the way QML would ---------------------------------------------

const body = source.replace(/^\.pragma library\s*$/m, '')
const exported = {}
new Function('__out', body + '\n__out.render = render; __out.holdMs = holdMs;')(exported)
const { render, holdMs } = exported

// A 2D context stand-in that records every call instead of drawing.
function recorder() {
  const calls = []
  const noop = () => {}
  const ctx = {
    calls,
    createLinearGradient: () => ({ addColorStop: noop })
  }
  const methods = ['reset', 'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'arc', 'quadraticCurveTo', 'stroke', 'fill', 'fillRect', 'strokeRect', 'clearRect']
  for (const m of methods) {
    ctx[m] = (...args) => calls.push(m + '(' + args.map(a =>
      typeof a === 'number' ? a.toFixed(4) : String(a)).join(',') + ')')
  }
  for (const p of ['fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'globalAlpha']) {
    let v
    Object.defineProperty(ctx, p, {
      get: () => v,
      set: (n) => { v = n; calls.push(p + '=' + (typeof n === 'number' ? n.toFixed(4) : n)) }
    })
  }
  return ctx
}

const PALETTE = { accent: '#1e66f5', foreground: '#4c4f69', errorColor: '#d20f39' }
function spec(state, elapsed, clock) {
  return Object.assign({ state, elapsed, clock: clock === undefined ? 900 : clock }, PALETTE)
}
function trace(state, elapsed, size, clock) {
  const ctx = recorder()
  render(ctx, size === undefined ? 120 : size, spec(state, elapsed, clock))
  return ctx.calls
}
const dots = (calls) => calls.filter(c => c.startsWith('fillRect(')).length

// --- determinism, which is the security property ---------------------------

check('the same spec renders the same frame', () => {
  for (const [state, elapsed] of [['scanning', 0], ['recognized', 430], ['notRecognized', 300]]) {
    assert.deepStrictEqual(trace(state, elapsed), trace(state, elapsed), state + ' at ' + elapsed)
  }
})

check('a different frame really does differ, so the check above is not vacuous', () => {
  assert.notDeepStrictEqual(trace('recognized', 200), trace('recognized', 900))
})

check('the scan sweep is driven by the clock', () => {
  assert.notDeepStrictEqual(trace('scanning', 0, 120, 300), trace('scanning', 0, 120, 1400))
})

check('render does not mutate the spec it is handed', () => {
  const s = spec('recognized', 500)
  const before = JSON.stringify(s)
  render(recorder(), 120, s)
  assert.strictEqual(JSON.stringify(s), before)
})

// --- the signed-off visual --------------------------------------------------

check('scanning is a dot cloud', () => {
  assert.ok(dots(trace('scanning', 0)) > 100, 'expected a cloud, got ' + dots(trace('scanning', 0)))
})

check('a settled recognised face has no dots left on it', () => {
  for (const elapsed of [780, 900, 1050, 1400]) {
    assert.strictEqual(dots(trace('recognized', elapsed)), 0, 'dots still painted at ' + elapsed + ' ms')
  }
})

check('the dots are still there while recognition is being worked out', () => {
  assert.ok(dots(trace('recognized', 300)) > 100, 'the identify beat lost its cloud')
})

check('a settled recognised face is drawn with strokes', () => {
  const calls = trace('recognized', 1050)
  assert.ok(calls.filter(c => c === 'stroke()').length > 3, 'expected a drawn face')
})

check('a miss stays a broken cloud rather than resolving', () => {
  assert.ok(dots(trace('notRecognized', 820)) > 50, 'the miss should not resolve into a clean face')
})

check('the card degrades to a vector glyph below 48 px', () => {
  assert.ok(dots(trace('scanning', 0, 30)) < 10, 'a 30 px card should not be a cloud')
  assert.ok(trace('scanning', 0, 30).filter(c => c === 'stroke()').length > 0, 'expected strokes at 30 px')
})

check('every size paints something', () => {
  for (const size of [240, 120, 96, 64, 44, 30, 24]) {
    for (const state of ['scanning', 'recognized', 'notRecognized']) {
      assert.ok(trace(state, 400, size).length > 5, state + ' at ' + size + ' px painted nothing')
    }
  }
})

// --- the timing contract the host reads ------------------------------------

check('the host is told how long to hold each state', () => {
  assert.strictEqual(holdMs('recognized'), 1050)
  assert.strictEqual(holdMs('notRecognized'), 820)
  assert.strictEqual(holdMs('scanning'), 0)
  assert.strictEqual(holdMs('anything else'), 0)
})

check('the recognised hold outlasts the last thing it draws', () => {
  const settled = trace('recognized', holdMs('recognized'))
  const earlier = trace('recognized', holdMs('recognized') - 200)
  assert.notDeepStrictEqual(settled, earlier, 'the check should still be drawing 200 ms before the hold ends')
})

console.log(failures === 0 ? '\nall paint tests passed' : '\n' + failures + ' paint test(s) failed')
process.exit(failures === 0 ? 0 : 1)
