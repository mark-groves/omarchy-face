#!/usr/bin/env node
'use strict'

// Behaviour tests for FaceCardFrame.js.
//
// The load-bearing ones are the boundary checks. This plugin is allowed to
// draw on a credential surface only because nothing it touches belongs to the
// host and nothing it returns is anything but a number. If either stops being
// true, the attach is unsound and these tests should fail loudly.
//
// The other load-bearing check is the signed-off visual: a recognised face is
// drawn, not dotted.

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const root = path.join(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'FaceCardFrame.js'), 'utf8')

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

const code = source.split('\n').filter(l => !l.trim().startsWith('//'))

// --- nothing the host owns can be reached ----------------------------------

check('declares itself a QML library', () => {
  assert.match(source, /^\.pragma library\s*$/m)
})

check('imports nothing', () => {
  assert.deepStrictEqual(code.filter(l => /\b(require|import)\s*[("']/.test(l)), [])
})

check('never names a host object', () => {
  const banned = /\b(Qt|Quickshell|Qml)\s*\.|\bparent\b|\bflow\b|\bPamContext\b|\bpasswordInput\b/
  assert.deepStrictEqual(code.filter(l => banned.test(l)), [])
})

check('never names a canvas or a drawing context', () => {
  // A 2D context exposes `canvas`, the canvas is a host Item, and an Item's
  // parent chain reaches the password field. The module must never hold one.
  assert.deepStrictEqual(code.filter(l => /\bcanvas\b|getContext/i.test(l)), [])
})

check('reads no ambient state', () => {
  const banned = /\b(Date|globalThis|window|process|XMLHttpRequest|fetch|setTimeout|setInterval)\b/
  assert.deepStrictEqual(code.filter(l => banned.test(l)), [])
})

// --- load it the way QML would ---------------------------------------------

const body = source.replace(/^\.pragma library\s*$/m, '')
const exported = {}
new Function('__out', body + '\n__out.frame = frame; __out.holdMs = holdMs; __out.STYLE = STYLE; __out.STYLES = STYLES;')(exported)
const { frame, holdMs } = exported

check('the public API takes no context argument', () => {
  assert.strictEqual(frame.length, 2, 'frame(size, spec) should take exactly two arguments')
  assert.strictEqual(holdMs.length, 1)
})

function spec(state, elapsed, clock) {
  return { state: state, elapsed: elapsed, clock: clock === undefined ? 900 : clock }
}
function ops(state, elapsed, size, clock) {
  return frame(size === undefined ? 120 : size, spec(state, elapsed, clock))
}

const STATES = ['scanning', 'recognized', 'notRecognized']
const SIZES = [240, 120, 96, 64, 44, 30, 24]

// --- everything crossing the boundary is a number --------------------------

function assertNumeric(value, where) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNumeric(v, where + '[' + i + ']'))
    return
  }
  assert.strictEqual(typeof value, 'number', where + ' is ' + typeof value + ', not a number')
  assert.ok(isFinite(value), where + ' is not finite')
}

check('a frame is nothing but finite numbers', () => {
  for (const state of STATES) {
    for (const elapsed of [0, 200, 430, 700, 1080]) {
      for (const size of [240, 120, 30]) {
        assertNumeric(ops(state, elapsed, size), state + '@' + elapsed + '/' + size)
      }
    }
  }
})

check('a frame carries no colour, only a role index', () => {
  for (const state of STATES) {
    for (const op of ops(state, 400)) {
      assert.ok(op[1] >= 0 && op[1] <= 2, 'role index out of range: ' + op[1])
    }
  }
})

check('alpha stays in range', () => {
  for (const state of STATES) {
    for (const op of ops(state, 400)) {
      assert.ok(op[2] >= 0 && op[2] <= 1, 'alpha out of range: ' + op[2])
    }
  }
})

check('render does not mutate the spec it is handed', () => {
  const s = spec('recognized', 500)
  const before = JSON.stringify(s)
  frame(120, s)
  assert.strictEqual(JSON.stringify(s), before)
})

// --- determinism, which is why the host can trust the frame ----------------

check('the same spec returns the same frame', () => {
  for (const [state, elapsed] of [['scanning', 0], ['recognized', 430], ['notRecognized', 300]]) {
    assert.deepStrictEqual(ops(state, elapsed), ops(state, elapsed), state + ' at ' + elapsed)
  }
})

check('a different frame really does differ, so the check above is not vacuous', () => {
  assert.notDeepStrictEqual(ops('recognized', 200), ops('recognized', 900))
})

check('the scan sweep is driven by the clock', () => {
  assert.notDeepStrictEqual(ops('scanning', 0, 120, 300), ops('scanning', 0, 120, 1400))
})

// --- the signed-off visual --------------------------------------------------

const OP_RECT = 1
const dots = (list) => list.filter(o => o[0] === OP_RECT).length
const strokes = (list) => list.filter(o => o[0] === 0).length

check('scanning is a dot cloud', () => {
  assert.ok(dots(ops('scanning', 0)) > 100, 'expected a cloud, got ' + dots(ops('scanning', 0)))
})

check('a settled recognised face has no dots left on it', () => {
  for (const elapsed of [1200, 1500, 1800]) {
    assert.strictEqual(dots(ops('recognized', elapsed)), 0, 'dots still painted at ' + elapsed + ' ms')
  }
})

check('the dots are still there while recognition is being worked out', () => {
  assert.ok(dots(ops('recognized', 300)) > 100, 'the identify beat lost its cloud')
})

check('a settled recognised face is drawn with strokes', () => {
  assert.ok(strokes(ops('recognized', holdMs('recognized'))) > 3, 'expected a drawn face')
})

check('a scan boots in rather than popping on', () => {
  const alpha = (list) => list.filter(o => o[0] === OP_RECT).reduce((a, o) => a + o[2], 0)
  assert.ok(alpha(ops('scanning', 0)) < alpha(ops('scanning', 1500)) * 0.5, 'the cloud should assemble on entry')
})

check('a result eases out of the pose it was entered from', () => {
  // Same entry clock, same elapsed: same frame. Different entry clock: the
  // instrument was elsewhere when the result arrived, so the frame differs.
  assert.deepStrictEqual(ops('recognized', 200, 120, 3200), ops('recognized', 200, 120, 3200))
  assert.notDeepStrictEqual(ops('recognized', 200, 120, 3200), ops('recognized', 200, 120, 4700))
})

check('a miss stays a broken cloud rather than resolving', () => {
  assert.ok(dots(ops('notRecognized', 820)) > 50, 'the miss should not resolve into a clean face')
})

check('the card degrades to a vector glyph below 48 px', () => {
  assert.ok(dots(ops('scanning', 0, 30)) < 10, 'a 30 px card should not be a cloud')
  assert.ok(strokes(ops('scanning', 0, 30)) > 0, 'expected strokes at 30 px')
})

check('every size paints something', () => {
  for (const size of SIZES) {
    for (const state of STATES) {
      // Strokes are batched, so count what gets drawn, not how many ops carry it.
      const drawn = ops(state, 400, size).reduce((n, o) => n + (o[0] === 0 ? o[4].length : 1), 0)
      assert.ok(drawn > 3, state + ' at ' + size + ' px painted nothing')
    }
  }
})

check('a frame stays inside the host op budget', () => {
  for (const size of SIZES) {
    for (const state of STATES) {
      for (const elapsed of [0, 300, 700, 1080]) {
        const list = ops(state, elapsed, size)
        assert.ok(list.length < 6000, 'op budget blown: ' + list.length)
        for (const op of list) {
          if (op[0] === 0) assert.ok(op[4].length < 600, 'path command budget blown: ' + op[4].length)
        }
      }
    }
  }
})

// --- the timing contract the host reads ------------------------------------

check('the host is told how long to hold each state', () => {
  assert.strictEqual(holdMs('recognized'), 1500)
  assert.strictEqual(holdMs('notRecognized'), 1200)
  assert.strictEqual(holdMs('scanning'), 0)
  assert.strictEqual(holdMs('anything else'), 0)
})

check('the recognised hold outlasts the last thing it draws', () => {
  assert.notDeepStrictEqual(
    ops('recognized', holdMs('recognized')),
    ops('recognized', holdMs('recognized') - 200),
    'the lock should still be settling 200 ms before the hold ends')
})

check('the host never needs more than two seconds of hold', () => {
  for (const state of STATES) assert.ok(holdMs(state) <= 2000, state + ' asks for ' + holdMs(state))
})

// --- replay cost, which the host pays on a software canvas every frame -----

// The host replays every op and path command in JS on a software canvas each
// frame, so the real 116 px slot gets a budget well inside the host caps.
const REPLAY_OPS = 1000
const REPLAY_CMDS = 6500

function replayCost(list) {
  return { ops: list.length, cmds: list.reduce((n, o) => n + (o[0] === 0 ? o[4].length : 1), 0) }
}

check('a frame at the real 116 px slot stays cheap to replay', () => {
  for (const state of STATES) {
    for (let elapsed = 0; elapsed <= 1200; elapsed += 50) {
      const c = replayCost(ops(state, elapsed, 116, 5000 + elapsed))
      assert.ok(c.ops < REPLAY_OPS && c.cmds < REPLAY_CMDS, state + '@' + elapsed + ' replays ' + c.ops + ' ops, ' + c.cmds + ' commands')
    }
  }
})

// --- styles and the selector --------------------------------------------------

const STYLE_LINE = /^var STYLE = "([a-z]+)"/m

check('the style line is in the exact form the switch filter rewrites', () => {
  const lines = source.split('\n').filter(l => /^var STYLE = /.test(l))
  assert.strictEqual(lines.length, 1, 'expected exactly one STYLE line')
  assert.match(lines[0], /^var STYLE = "[a-z]+" \/\/ omarchy-face:style$/)
})

check('the published default is the HUD', () => {
  assert.strictEqual(source.match(STYLE_LINE)[1], 'hud')
  assert.strictEqual(exported.STYLE, 'hud')
})

check('the switch script offers exactly the module styles', () => {
  const script = fs.readFileSync(path.join(root, 'bin/omarchy-face-style'), 'utf8')
  const m = script.match(/^STYLES=\(([^)]*)\)/m)
  assert.ok(m, 'no STYLES=(...) in the script')
  assert.deepStrictEqual(m[1].trim().split(/\s+/), exported.STYLES)
  assert.deepStrictEqual(exported.STYLES, ['hud', 'radar', 'holo'])
})

check('the filter is declared for the entry point', () => {
  const attrs = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8')
  assert.match(attrs, /^FaceCardFrame\.js filter=omarchy-face-style$/m)
})

function styled(style, state, elapsed, size, clock) {
  const s = { state: state, elapsed: elapsed, clock: clock === undefined ? 900 : clock }
  if (style !== undefined) s.style = style
  return frame(size === undefined ? 120 : size, s)
}

// The installed module with its STYLE line rewritten, loaded as the host does.
function installedAs(style) {
  const text = body.replace(STYLE_LINE, 'var STYLE = "' + style + '"')
  const api = {}
  new Function('__out', text + '\n__out.frame = frame;')(api)
  return api.frame
}

check('spec.style picks the style', () => {
  assert.deepStrictEqual(styled(undefined, 'scanning', 2000), styled('hud', 'scanning', 2000))
  assert.notDeepStrictEqual(styled('radar', 'scanning', 2000), styled('hud', 'scanning', 2000))
  assert.notDeepStrictEqual(styled('holo', 'scanning', 2000), styled('hud', 'scanning', 2000))
  assert.notDeepStrictEqual(styled('holo', 'scanning', 2000), styled('radar', 'scanning', 2000))
})

check('the STYLE line picks the style when spec.style is absent', () => {
  for (const style of exported.STYLES) {
    const f = installedAs(style)
    assert.deepStrictEqual(f(120, { state: 'recognized', clock: 1200, elapsed: 500 }), styled(style, 'recognized', 500, 120, 1200), style)
  }
})

check('an unknown style paints the installed one, never nothing', () => {
  assert.deepStrictEqual(styled('sparkles', 'scanning', 2000), styled('hud', 'scanning', 2000))
  assert.deepStrictEqual(styled(42, 'scanning', 2000), styled('hud', 'scanning', 2000))
  const radar = installedAs('radar')
  assert.deepStrictEqual(radar(120, { state: 'scanning', clock: 900, elapsed: 2000, style: 'nope' }), styled('radar', 'scanning', 2000))
  const broken = installedAs('nope')
  assert.deepStrictEqual(broken(120, { state: 'scanning', clock: 900, elapsed: 2000 }), styled('hud', 'scanning', 2000))
})

for (const style of exported.STYLES) {
  check(style + ': a frame is nothing but finite numbers, roles and alphas in range', () => {
    for (const state of STATES) {
      for (const elapsed of [0, 200, 430, 700, 1080, 2600]) {
        for (const size of [240, 120, 30]) {
          const list = styled(style, state, elapsed, size, 5000 + elapsed)
          assertNumeric(list, style + ' ' + state + '@' + elapsed + '/' + size)
          for (const op of list) {
            assert.ok(op[1] >= 0 && op[1] <= 2, 'role out of range')
            assert.ok(op[2] >= 0 && op[2] <= 1, 'alpha out of range')
          }
        }
      }
    }
  })

  check(style + ': the same spec returns the same frame', () => {
    for (const [state, elapsed] of [['scanning', 1500], ['recognized', 430], ['notRecognized', 300]]) {
      assert.deepStrictEqual(styled(style, state, elapsed), styled(style, state, elapsed))
    }
  })

  check(style + ': ambient motion is driven by the clock', () => {
    assert.notDeepStrictEqual(styled(style, 'scanning', 3000, 120, 3300), styled(style, 'scanning', 3000, 120, 4400))
  })

  check(style + ': a scan boots in rather than popping on', () => {
    const drawn = (list) => list.reduce((n, o) => n + (o[0] === 0 ? o[4].length * o[2] : o[2]), 0)
    assert.ok(drawn(styled(style, 'scanning', 0)) < drawn(styled(style, 'scanning', 3000)) * 0.5)
  })

  check(style + ': a result eases out of the pose it was entered from', () => {
    assert.notDeepStrictEqual(styled(style, 'recognized', 200, 120, 3200), styled(style, 'recognized', 200, 120, 4700))
  })

  check(style + ': a settled recognised face is strokes only, no dots', () => {
    for (const elapsed of [1200, 1500, 1800]) {
      const list = styled(style, 'recognized', elapsed)
      assert.strictEqual(list.filter(o => o[0] === OP_RECT).length, 0, 'dots at ' + elapsed)
      assert.ok(strokes(list) > 3, 'expected a drawn face at ' + elapsed)
    }
  })

  check(style + ': a miss opens with a fault strobe, then paints in the error role only', () => {
    assert.ok(styled(style, 'notRecognized', 0).some(o => o[1] === 0), 'expected the strobe to open in the accent')
    for (const elapsed of [300, 700, 1200]) {
      const accent = styled(style, 'notRecognized', elapsed).filter(o => o[1] === 0)
      assert.strictEqual(accent.length, 0, 'accent ops in a miss at ' + elapsed)
    }
  })

  check(style + ': the recognised hold outlasts the last thing it draws', () => {
    assert.notDeepStrictEqual(
      styled(style, 'recognized', holdMs('recognized')),
      styled(style, 'recognized', holdMs('recognized') - 200))
  })

  check(style + ': every size paints something', () => {
    for (const size of SIZES) {
      for (const state of STATES) {
        const drawn = styled(style, state, 400, size).reduce((n, o) => n + (o[0] === 0 ? o[4].length : 1), 0)
        assert.ok(drawn > 3, style + ' ' + state + ' at ' + size + ' px painted nothing')
      }
    }
  })

  check(style + ': frames stay inside the host budgets and cheap at 116 px', () => {
    for (const size of SIZES) {
      for (const state of STATES) {
        for (let elapsed = 0; elapsed <= 3000; elapsed += 100) {
          const list = styled(style, state, elapsed, size, 5000 + elapsed)
          assert.ok(list.length < 6000, style + ' op budget blown: ' + list.length)
          if (size === 116) {
            const c = replayCost(list)
            assert.ok(c.ops < REPLAY_OPS && c.cmds < REPLAY_CMDS, style + ' ' + state + '@' + elapsed + ' replays ' + c.ops + ' ops, ' + c.cmds + ' commands')
          }
          for (const op of list) if (op[0] === 0) assert.ok(op[4].length < 600, 'path command budget blown')
        }
      }
    }
  })
}

check('the HUD also paints a miss in the error role only after its strobe', () => {
  for (const elapsed of [300, 700, 1200]) {
    assert.strictEqual(styled('hud', 'notRecognized', elapsed).filter(o => o[1] === 0).length, 0)
  }
})

console.log(failures === 0 ? '\nall frame tests passed' : '\n' + failures + ' frame test(s) failed')
process.exit(failures === 0 ? 0 : 1)
