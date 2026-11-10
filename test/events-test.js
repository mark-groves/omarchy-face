#!/usr/bin/env node
'use strict'

// Tests for FaceEvents.js and StreamLimits.js, the journal reader behind the
// standalone card. The Howdy entries and the forgeries are captured from a
// real howdy-next 3.4 PAM stack on Omarchy, trimmed to the fields Service.qml
// asks journalctl for; the facelock lines follow the format facelock 0.2 logs.

const assert = require('assert')
const { parseEntry, cardEvent, stackHasFace } = require('../FaceEvents.js')
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
// polkit 126 and later: a socket-activated helper, named after the agent's uid.
const POLKIT = {
  _EXE: '/usr/lib/polkit-1/polkit-agent-helper-1', _CAP_EFFECTIVE: '1f3fdfeffff', _UID: '0',
  _SYSTEMD_UNIT: 'polkit-agent-helper@0-1-1421_20553-1000.service'
}
// A process gone before journald looked, such as logger.
const LOGGER = { _UID: '1000' }
// python3 logging from inside `unshare -Ur`.
const NAMESPACED = { _EXE: '/usr/bin/python3.14', _CAP_EFFECTIVE: '1ffffffffff', _UID: '1000' }

const entry = (from, message) => JSON.stringify(Object.assign({ MESSAGE: message }, from))
const howdy = (svc, what) => `pam_howdy(${svc}:auth): Face verification ${what}`

const CONTEXT = { uid: '1000', services: { sudo: true, 'sudo-i': true, 'polkit-1': true } }
const read = (line, context = CONTEXT) => cardEvent(parseEntry(line), context)

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

check('the lid gate, an unprefixed skip and session noise show nothing', () => {
  for (const message of [
    'PAM Face verification skipped: Howdy is disabled',
    'pam_exec(sudo:auth): /usr/bin/omarchy-hw-laptop-closed failed: exit code 1',
    'pam_unix(sudo:session): session opened for user root(uid=0) by grovr(uid=1000)',
    '   grovr : TTY=pts/5 ; PWD=/home/grovr ; USER=root ; COMMAND=/usr/bin/true'
  ]) assert.strictEqual(read(entry(SUDO, message)), null, message)
})

// --- scan start and the end of a scan ----------------------------------------

// pam_warn sits just before the face module in the fork's stacks. These are
// real lines from sudo and the polkit helper.
const warn = (svc, fn, rest) => `pam_warn(${svc}:${fn === 'pam_sm_authenticate' ? 'auth' : 'setcred'}): function=[${fn}] ${rest}`
const SUDO_START = warn('sudo', 'pam_sm_authenticate', 'flags=0x8000 service=[sudo] terminal=[/dev/pts/3] user=[grovr] ruser=[grovr] rhost=[<unknown>]')
const POLKIT_START = warn('polkit-1', 'pam_sm_authenticate', 'flags=0 service=[polkit-1] terminal=[<unknown>] user=[grovr] ruser=[grovr] rhost=[<unknown>]')

check('a trusted scan start opens the card scanning', () => {
  assert.deepStrictEqual(read(entry(SUDO, SUDO_START)), { state: 'scanning', service: 'sudo' })
  assert.deepStrictEqual(read(entry(POLKIT, POLKIT_START)), { state: 'scanning', service: 'polkit-1' })
})

check('setcred after an approval is not a scan start', () => {
  for (const flags of ['flags=0x8', 'flags=0x8004'])
    assert.strictEqual(read(entry(SUDO, warn('sudo', 'pam_sm_setcred', flags + ' service=[sudo] terminal=[/dev/pts/3] user=[root] ruser=[grovr] rhost=[<unknown>]'))), null, flags)
})

check('a scan start is trusted like a verdict', () => {
  assert.strictEqual(read(entry(LOGGER, SUDO_START)), null, 'no capabilities recorded')
  assert.strictEqual(read(entry(NAMESPACED, SUDO_START)), null, 'capabilities from a user namespace')
  assert.strictEqual(read(entry(Object.assign({}, SUDO, { _UID: '1001' }), SUDO_START)), null, 'their sudo')
  assert.strictEqual(read(entry(SUDO, POLKIT_START)), null, 'sudo speaking for polkit')
  assert.strictEqual(read(entry(POLKIT, POLKIT_START), { uid: '1000', services: { sudo: true, 'polkit-1': false } }), null, 'the host draws polkit')
})

check('a compare killed for overrunning its CPU budget reads as not recognized', () => {
  assert.deepStrictEqual(read(entry(SUDO, 'pam_howdy(sudo:auth): Child killed by signal CPU time limit exceeded (24)')),
    { state: 'notRecognized', service: 'sudo' })
  assert.deepStrictEqual(read(entry(SUDO, 'pam_howdy(sudo:auth): Child killed by signal Rechenzeitbegrenzung überschritten (24)')),
    { state: 'notRecognized', service: 'sudo' }, 'another locale')
})

check('a scan that ends with no verdict cancels the card', () => {
  for (const message of [
    'pam_howdy(sudo:auth): Face verification skipped: lid is closed',
    'pam_howdy(sudo:auth): Face verification skipped for SSH session',
    'pam_howdy(sudo:auth): Face verification unavailable: no enrolled face model',
    'pam_howdy(sudo:auth): Face verification aborted',
    'pam_howdy(sudo:auth): Child killed by signal Terminated (15)'
  ]) assert.deepStrictEqual(read(entry(SUDO, message)), { state: 'cancel', service: 'sudo' }, message)
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

check('another user\'s prompt is not shown', () => {
  const ok = howdy('sudo', 'succeeded')
  assert.strictEqual(read(entry(Object.assign({}, SUDO, { _UID: '1001' }), ok)), null, 'their sudo')
  assert.strictEqual(read(entry(Object.assign({}, SUDO, { _UID: '0' }), ok)), null, 'a root sudo')
  const theirs = Object.assign({}, POLKIT, { _SYSTEMD_UNIT: 'polkit-agent-helper@4-16385-99999_12345-1001.service' })
  assert.strictEqual(read(entry(theirs, howdy('polkit-1', 'timed out'))), null, 'their polkit agent')
  assert.strictEqual(read(entry(SUDO, ok), { uid: '', services: CONTEXT.services }), null, 'an unknown uid trusts nothing')
})

check('a setuid polkit helper is trusted by its uid, like sudo', () => {
  const setuid = { _EXE: '/usr/lib/polkit-1/polkit-agent-helper-1', _CAP_EFFECTIVE: '1ffffffffff', _UID: '1000', _SYSTEMD_UNIT: 'session-2.scope' }
  assert.deepStrictEqual(read(entry(setuid, howdy('polkit-1', 'succeeded'))), { state: 'recognized', service: 'polkit-1' })
  assert.strictEqual(read(entry(Object.assign({}, setuid, { _UID: '0' }), howdy('polkit-1', 'succeeded'))), null)
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
