#!/usr/bin/env node
'use strict'

// Tests for FaceEvents.js and StreamLimits.js, the journal reader behind the
// standalone card. The Howdy entries and the forgeries are captured from a
// real howdy-next 3.4 PAM stack on Omarchy, trimmed to the fields Service.qml
// asks journalctl for; the facelock lines follow the format facelock 0.2 logs.

const assert = require('assert')
const { parseEntry, verdict, stackHasFace } = require('../FaceEvents.js')
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

// Who journald says sent a line.
const SUDO = { _EXE: '/usr/bin/sudo', _CAP_EFFECTIVE: '1ffffffffff', _UID: '1000' }
const POLKIT = { _EXE: '/usr/lib/polkit-1/polkit-agent-helper-1', _CAP_EFFECTIVE: '1f3fdfeffff', _UID: '0' }
// A process gone before journald looked, such as logger.
const LOGGER = { _UID: '1000' }
// python3 logging from inside `unshare -Ur`.
const NAMESPACED = { _EXE: '/usr/bin/python3.14', _CAP_EFFECTIVE: '1ffffffffff', _UID: '1000' }

const entry = (from, message) => JSON.stringify(Object.assign({ MESSAGE: message }, from))
const howdy = (svc, what) => `pam_howdy(${svc}:auth): Face verification ${what}`

const CONTEXT = { uid: '1000', services: { sudo: true, 'sudo-i': true, 'polkit-1': true } }
const read = (line, context = CONTEXT) => verdict(parseEntry(line), context)

// --- Howdy -------------------------------------------------------------------

check('a real sudo or polkit verdict reaches the card', () => {
  assert.deepStrictEqual(read(entry(SUDO, howdy('sudo', 'succeeded'))), { state: 'recognized', service: 'sudo' })
  assert.deepStrictEqual(read(entry(POLKIT, howdy('polkit-1', 'succeeded'))), { state: 'recognized', service: 'polkit-1' })
})

check('a timeout and a failure both read as not recognized', () => {
  assert.deepStrictEqual(read(entry(SUDO, howdy('sudo', 'timed out'))), { state: 'notRecognized', service: 'sudo' })
  assert.deepStrictEqual(read(entry(POLKIT, howdy('polkit-1', 'failed: camera image too dark'))),
    { state: 'notRecognized', service: 'polkit-1' })
})

check('a skip, the lid gate and session noise show nothing', () => {
  for (const message of [
    'PAM Face verification skipped: Howdy is disabled',
    'pam_exec(sudo:auth): /usr/bin/omarchy-hw-laptop-closed failed: exit code 1',
    'pam_unix(sudo:session): session opened for user root(uid=0) by grovr(uid=1000)',
    '   grovr : TTY=pts/5 ; PWD=/home/grovr ; USER=root ; COMMAND=/usr/bin/true'
  ]) assert.strictEqual(read(entry(SUDO, message)), null, message)
})

// --- trust -------------------------------------------------------------------

check('a verdict any user process can log is not trusted', () => {
  const forged = howdy('sudo', 'succeeded')
  assert.strictEqual(read(entry(LOGGER, forged)), null, 'no capabilities recorded')
  assert.strictEqual(read(entry(Object.assign({}, SUDO, { _CAP_EFFECTIVE: '0' }), forged)), null, 'no capabilities held')
  assert.strictEqual(read(entry(NAMESPACED, forged)), null, 'capabilities from a user namespace')
})

check('a caller only speaks for its own service', () => {
  assert.strictEqual(read(entry(SUDO, howdy('polkit-1', 'succeeded'))), null)
  assert.strictEqual(read(entry(POLKIT, howdy('sudo', 'succeeded'))), null)
})

check('another user\'s sudo is not shown', () => {
  assert.strictEqual(read(entry(Object.assign({}, SUDO, { _UID: '1001' }), howdy('sudo', 'succeeded'))), null)
  assert.strictEqual(read(entry(SUDO, howdy('sudo', 'succeeded')), { uid: '', services: CONTEXT.services }), null,
    'an unknown uid trusts only root')
})

// --- services ------------------------------------------------------------------

check('only services that get a card right now are shown', () => {
  const sudoOnly = { uid: '1000', services: { sudo: true, 'sudo-i': true, 'polkit-1': false } }
  assert.strictEqual(read(entry(POLKIT, howdy('polkit-1', 'succeeded')), sudoOnly), null)
  assert.deepStrictEqual(read(entry(SUDO, howdy('sudo-i', 'timed out')), sudoOnly), { state: 'notRecognized', service: 'sudo-i' })
  assert.strictEqual(read(entry(SUDO, howdy('sudo', 'succeeded')), { uid: '1000', services: {} }), null)
})

check('the lock screen and other services are left alone', () => {
  const lock = { _EXE: '/usr/bin/quickshell', _CAP_EFFECTIVE: '0', _UID: '1000' }
  assert.strictEqual(read(entry(lock, howdy('omarchy-lock-face', 'succeeded'))), null)
  assert.strictEqual(read(entry(SUDO, howdy('su', 'succeeded'))), null)
})

// --- facelock ----------------------------------------------------------------

check('a facelock verdict reads like Howdy\'s', () => {
  assert.deepStrictEqual(read(entry(SUDO, 'pam_facelock(sudo): success for user alice')), { state: 'recognized', service: 'sudo' })
  assert.deepStrictEqual(read(entry(POLKIT, 'pam_facelock(polkit-1): no_match for user alice')), { state: 'notRecognized', service: 'polkit-1' })
  assert.strictEqual(read(entry(SUDO, 'pam_facelock(sudo): cancelled for user alice')), null)
})

// --- input ---------------------------------------------------------------------

check('a line that is not one journal entry is ignored', () => {
  assert.strictEqual(read('pam_howdy(sudo:auth): Face verification succeeded'), null)
  assert.strictEqual(read('{"MESSAGE": [112, 97, 109], "_EXE": "/usr/bin/sudo"}'), null, 'binary MESSAGE')
  assert.strictEqual(read('null'), null)
  assert.strictEqual(read(''), null)
})

// --- PAM stacks ----------------------------------------------------------------

check('a PAM stack has face only where a face module is loaded', () => {
  assert.strictEqual(stackHasFace('auth sufficient pam_howdy.so\nauth include system-auth'), true)
  assert.strictEqual(stackHasFace('-auth sufficient pam_facelock.so'), true)
  assert.strictEqual(stackHasFace('# auth sufficient pam_howdy.so\nauth sufficient pam_fprintd.so'), false)
  assert.strictEqual(stackHasFace(''), false)
})

// --- stream ceilings -----------------------------------------------------------

check('lines are assembled across chunks', () => {
  let r = Limits.feed(Limits.initialStream(), '{"MESSAGE":"pam_howdy(sudo:au', 0)
  assert.deepStrictEqual(r.lines, [])
  r = Limits.feed(r.stream, 'th): x"}\nnext\n', 1)
  assert.deepStrictEqual(r.lines, ['{"MESSAGE":"pam_howdy(sudo:auth): x"}', 'next'])
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

console.log(failures ? `\n${failures} event test(s) failed` : '\nall event tests passed')
process.exit(failures ? 1 : 0)
