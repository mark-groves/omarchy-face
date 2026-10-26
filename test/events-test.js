#!/usr/bin/env node
'use strict'

// Tests for FaceEvents.js and StreamLimits.js, the journal readers behind the
// standalone card. The Howdy lines are captured from a real howdy 3 PAM stack;
// the facelock lines follow the format facelock 0.2 logs.

const assert = require('assert')
const { initialState, step, resolveRequester, stackHasFace } = require('../FaceEvents.js')
const Limits = require('../StreamLimits.js')

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

const FACE = { sudo: true, 'polkit-1': true }

// Feeds lines through step and returns the events in order.
function run(lines, faceServices = FACE, state = initialState()) {
  const events = []
  let probes = 0
  for (const line of lines) {
    const r = step(state, line, faceServices)
    state = r.state
    if (r.event) events.push(r.event)
    if (r.probe) probes++
  }
  return { events, state, probes }
}

const gate = svc => `pam_exec(${svc}:auth): /usr/bin/omarchy-hw-laptop-closed failed: exit code 1`
const howdy = (svc, what) => `pam_howdy(${svc}:auth): Face verification ${what}`

// --- Howdy -------------------------------------------------------------------

check('a sudo scan opens on the lid gate and settles on the verdict', () => {
  const { events, state } = run([gate('sudo'), howdy('sudo', 'succeeded')])
  assert.deepStrictEqual(events, [
    { state: 'scanning', service: 'sudo' },
    { state: 'recognized', service: 'sudo' }
  ])
  assert.strictEqual(state.scanning, false)
})

check('a timeout and a failure both read as not recognized', () => {
  assert.deepStrictEqual(run([gate('polkit-1'), howdy('polkit-1', 'timed out')]).events[1],
    { state: 'notRecognized', service: 'polkit-1' })
  assert.deepStrictEqual(run([gate('sudo'), howdy('sudo', 'failed: camera image too dark')]).events[1],
    { state: 'notRecognized', service: 'sudo' })
})

check('the lid gate opens nothing for a stack without a face module', () => {
  const { events } = run([gate('sudo')], { 'polkit-1': true })
  assert.deepStrictEqual(events, [])
})

check('a verdict with no gate line still reaches the card', () => {
  const { events } = run([howdy('sudo', 'succeeded')])
  assert.deepStrictEqual(events, [{ state: 'recognized', service: 'sudo' }])
})

check('the lock screen and other services are left alone', () => {
  const { events } = run([
    gate('omarchy-lock-face'), howdy('omarchy-lock-face', 'succeeded'),
    gate('sddm'), howdy('sddm', 'timed out'),
    'pam_howdy(omarchy-lock-face:auth): Face verification failed: cannot open configured camera'
  ], { 'omarchy-lock-face': true, sddm: true })
  assert.deepStrictEqual(events, [])
})

check('a disabled Howdy cancels an open scan', () => {
  const { events } = run([gate('sudo'), 'PAM Face verification skipped: Howdy is disabled'])
  assert.deepStrictEqual(events[1], { state: 'cancel', service: 'sudo' })
})

check('session and helper noise changes nothing', () => {
  const { events, state } = run([
    'pam_unix(sudo:session): session opened for user root(uid=0) by grovr(uid=1000)',
    '   grovr : TTY=pts/5 ; PWD=/home/grovr ; USER=root ; COMMAND=/usr/bin/true',
    'pam_howdy: Howdy auth helper prepare timed out',
    'pam_exec(sudo:auth): /usr/bin/omarchy-hw-laptop-closed failed: exit code 2'
  ])
  assert.deepStrictEqual(events, [])
  assert.deepStrictEqual(state, initialState())
})

check('colour codes in a line do not hide it', () => {
  const ESC = '\x1b'
  const { events } = run([ESC + '[32m' + howdy('sudo', 'succeeded') + ESC + '[0m'])
  assert.strictEqual(events.length, 1)
})

// --- facelock ----------------------------------------------------------------

const camera = 'INFO facelock_camera::capture: camera format negotiated device=/dev/video0 format=YUYV'
const ok = 'INFO facelock_daemon::auth: authentication succeeded user="alice" similarity="0.93" frames=3'
const bad = 'INFO facelock_daemon::auth: authentication failed user="alice" similarity="0.12"'

check('a facelock scan asks who is waiting, then shows the verdict once', () => {
  let r = run([camera])
  assert.strictEqual(r.probes, 1)
  assert.deepStrictEqual(r.events, [])
  const asked = resolveRequester(r.state, '4242 sudo\n')
  assert.deepStrictEqual(asked.event, { state: 'scanning', service: 'sudo' })
  r = run([ok, 'pam_facelock(sudo): success for user alice'], FACE, asked.state)
  assert.deepStrictEqual(r.events, [{ state: 'recognized', service: 'sudo' }])
})

check('polkit wins over a sudo process left in the terminal', () => {
  const r = run([camera])
  const asked = resolveRequester(r.state, '100 sudo\n200 polkit-agent-he\n')
  assert.strictEqual(asked.event.service, 'polkit-1')
})

check('a facelock scan nobody asked for is the lock screen, and stays quiet', () => {
  let r = run([camera])
  const asked = resolveRequester(r.state, '')
  assert.strictEqual(asked.event, undefined)
  r = run([bad, 'pam_facelock(omarchy-lock-face): no_match for user alice'], FACE, asked.state)
  assert.deepStrictEqual(r.events, [])
})

check('the pam_facelock line alone still settles the card', () => {
  const r = run([camera, bad, 'pam_facelock(sudo): no_match for user alice'])
  assert.deepStrictEqual(r.events, [{ state: 'notRecognized', service: 'sudo' }])
})

check('a cancelled facelock scan closes the card', () => {
  const r = run([camera])
  const asked = resolveRequester(r.state, '9 sudo')
  const done = run(['authentication cancelled'], FACE, asked.state)
  assert.deepStrictEqual(done.events, [{ state: 'cancel', service: 'sudo' }])
})

// --- PAM stacks ----------------------------------------------------------------

check('a PAM stack has face only where a face module is loaded', () => {
  assert.strictEqual(stackHasFace('auth sufficient pam_howdy.so\nauth include system-auth'), true)
  assert.strictEqual(stackHasFace('auth sufficient pam_facelock.so'), true)
  assert.strictEqual(stackHasFace('# auth sufficient pam_howdy.so\nauth sufficient pam_fprintd.so'), false)
  assert.strictEqual(stackHasFace(''), false)
})

// --- stream ceilings -----------------------------------------------------------

check('lines are assembled across chunks', () => {
  let s = Limits.initialStream()
  let r = Limits.feed(s, 'pam_howdy(sudo:au', 0)
  assert.deepStrictEqual(r.lines, [])
  r = Limits.feed(r.stream, 'th): x\nnext\n', 1)
  assert.deepStrictEqual(r.lines, ['pam_howdy(sudo:auth): x', 'next'])
})

check('an endless line stops the child before it is held', () => {
  const r = Limits.feed(Limits.initialStream(), 'x'.repeat(Limits.MAX_LINE + 1), 0)
  assert.strictEqual(r.overflow, true)
  assert.strictEqual(r.stream.pending, '')
})

check('a flood of lines stops the child', () => {
  const r = Limits.feed(Limits.initialStream(), 'a\n'.repeat(Limits.MAX_LINES_PER_WINDOW + 1), 0)
  assert.strictEqual(r.overflow, true)
})

check('a one-shot answer is capped', () => {
  assert.strictEqual(Limits.collect('', 'x'.repeat(Limits.MAX_COLLECTED + 1)).overflow, true)
  assert.deepStrictEqual(Limits.collect('1 sudo', '\n'), { text: '1 sudo\n', overflow: false })
})

console.log(failures ? `\n${failures} event test(s) failed` : '\nall event tests passed')
process.exit(failures ? 1 : 0)
