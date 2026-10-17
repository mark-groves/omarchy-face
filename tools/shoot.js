#!/usr/bin/env node
'use strict'

// Headless visual harness for FaceCardFrame.js.
//
// Serves the repo over loopback, drives headless Chromium through the DevTools
// protocol (node's built-in WebSocket, so no npm install) and writes PNGs, an
// mp4 or a gif. tools/render.html does the painting; it mirrors Preview.qml.
//
//   node tools/shoot.js --style hud --sheet                      contact sheet
//   node tools/shoot.js --style hud --sheet out.png
//   node tools/shoot.js --style hud --state recognized --elapsed 600 --out f.png
//   node tools/shoot.js --style holo --video out.mp4 --seconds 12
//   node tools/shoot.js --style holo --gif out.gif
//   node tools/shoot.js --serve                                  just serve, to open render.html by hand
//
// Run with --help for every option. Needs node 22+, chromium and (for video) ffmpeg.

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const defaultOut = path.join(__dirname, 'out')

const HELP = `usage: node tools/shoot.js [options]

what to draw
  --style S[,S]     hud | radar | holo (default: the installed STYLE)
  --state S[,S]     scanning | recognized | notRecognized (default: all, sheet only)
  --elapsed MS,MS   ms since the state was entered (a list makes a row)
  --clock MS        pin the absolute clock for every cell (default: entered + elapsed)
  --entered MS      clock at state entry (default 0 / 3400 / 9200, the Preview script)
  --timeline T      rows as  state@e1,e2;state@e1,e2   (overrides --state/--elapsed)
  --host N          op level 1, 2 or 3 (default 3: dark glass panel)
  --theme T         tokyo | mocha | latte | gruvbox | nord | dawn | current | path/to/colors.toml
  --side PX         card size (default 220)
  --scale N         device pixel ratio (default 2 sheet, 3 single, 2 video, 1 gif)
  --bloom W,T       wide,tight bloom blur sigma in card px (default 10,3.2)
  --no-labels       no per-cell labels on a sheet

what to write (default dir: tools/out/)
  --sheet [FILE]    contact sheet across a state timeline
  --out FILE        single frame with no chrome (first --state/--elapsed); a bare name lands in tools/out/
  --video [FILE]    mp4 of the Preview.qml script (scan 3400, recognized, scan 3000, miss)
  --gif [FILE]      same, as a gif
  --seconds N       video length (default: one full script cycle, 12 s)
  --fps N           video frame rate (default 30)
  --keep-frames     keep the PNG frames of a video
  --serve [PORT]    serve the repo and print the render.html URL, until killed
`

function parse(argv) {
  const o = {}
  const bool = new Set(['no-labels', 'keep-frames', 'help'])
  const optional = new Set(['sheet', 'video', 'gif', 'serve'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error('unexpected argument ' + a)
    const k = a.slice(2)
    if (bool.has(k)) { o[k] = true; continue }
    const next = argv[i + 1]
    if (optional.has(k) && (next === undefined || next.startsWith('--'))) { o[k] = true; continue }
    if (next === undefined) throw new Error('--' + k + ' needs a value')
    o[k] = next
    i++
  }
  return o
}

// --- colors.toml -> the theme keys render.html expects ------------------------

function readToml(file) {
  const named = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (m) named[m[1]] = m[2]
  }
  if (!named.background && named.color0) named.background = named.color0
  if (!named.background) throw new Error('no background in ' + file)
  return named
}

// --- a tiny static server: the module and the page, nothing else ----------------

function serve(port) {
  const files = {
    '/FaceCardFrame.js': ['FaceCardFrame.js', 'text/javascript; charset=utf-8'],
    '/tools/render.html': ['tools/render.html', 'text/html; charset=utf-8']
  }
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0]
    const f = files[p]
    if (!f) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' })
    res.end(fs.readFileSync(path.join(root, f[0])))
  })
  return new Promise(resolve => server.listen(port || 0, '127.0.0.1', () => resolve(server)))
}

// --- DevTools protocol over the built-in WebSocket -------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.n = 0
    this.pending = new Map()
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data)
      const p = m.id && this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result)
    })
  }
  send(method, params) {
    const id = ++this.n
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text))
    return r.result.value
  }
}

async function launchChromium() {
  if (typeof WebSocket === 'undefined') throw new Error('this needs node 22+ (global WebSocket)')
  const bin = process.env.CHROMIUM || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable']
    .find(p => fs.existsSync(p)) || 'chromium'
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'omarchy-face-shoot-'))
  const proc = spawn(bin, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--force-color-profile=srgb',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ''
    const t = setTimeout(() => reject(new Error('chromium did not start:\n' + buf)), 20000)
    proc.stderr.on('data', d => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(t); resolve(m[1]) }
    })
    proc.on('exit', c => { clearTimeout(t); reject(new Error('chromium exited ' + c + '\n' + buf)) })
  })
  const port = new URL(wsUrl).port
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const page = targets.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const cdp = new Cdp(ws)
  const close = () => {
    try { ws.close() } catch (e) {}
    proc.removeAllListeners('exit')
    proc.kill('SIGKILL')
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  }
  return { cdp, close }
}

async function openPage(cdp, url, scale) {
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: scale, mobile: false })
  await cdp.send('Page.navigate', { url })
  for (let i = 0; i < 600; i++) {
    const ready = await cdp.eval('window.__ready === true').catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 50))
    if (i === 599) throw new Error('page never became ready')
  }
  const err = await cdp.eval('window.__error || ""')
  if (err) throw new Error('render.html: ' + err)
}

async function screenshotShot(cdp, scale, file) {
  const [w, h] = await cdp.eval('(() => { const r = document.getElementById("shot").getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)] })()')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: Math.max(w, 1), height: Math.max(h, 1), deviceScaleFactor: scale, mobile: false })
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  return { w: w * scale, h: h * scale }
}

// --- main -----------------------------------------------------------------------

async function main() {
  const o = parse(process.argv.slice(2))
  if (o.help) { process.stdout.write(HELP); return }

  if (o.serve) {
    const port = o.serve === true ? 8765 : Number(o.serve)
    const server = await serve(port)
    const base = 'http://127.0.0.1:' + server.address().port + '/tools/render.html'
    console.log('serving ' + base + '?style=hud&host=3\nctrl-c to stop')
    return
  }

  const mode = o.video ? 'video' : o.gif ? 'gif' : o.out ? 'single' : 'sheet'
  const style = (o.style || '').split(',')[0] || 'hud'
  const host = o.host || '3'
  const themeName = o.theme || 'tokyo'

  const q = new URLSearchParams()
  if (o.style) q.set('style', o.style)
  for (const k of ['state', 'elapsed', 'clock', 'entered', 'timeline', 'side', 'bloom']) if (o[k] !== undefined) q.set(k, o[k])
  q.set('host', host)
  if (o['no-labels']) q.set('labels', '0')
  let tag = themeName
  if (themeName === 'current' || themeName.endsWith('.toml') || themeName.includes('/')) {
    const file = themeName === 'current' ? path.join(os.homedir(), '.local/state/omarchy/current/theme/colors.toml') : themeName
    q.set('themejson', JSON.stringify(readToml(file)))
    tag = themeName === 'current' ? 'current' : path.basename(file, '.toml')
  } else {
    q.set('theme', themeName)
  }

  const scale = Number(o.scale || { sheet: 2, single: 3, video: 2, gif: 1 }[mode])
  q.set('scale', String(scale))
  q.set('layout', { sheet: 'sheet', single: 'single', video: 'stage', gif: 'stage' }[mode])
  if (mode === 'single' && !o.state) q.set('state', 'scanning')
  if (mode === 'single' && !o.elapsed && !o.timeline) q.set('elapsed', '0')
  if (mode === 'single' && !o.timeline) {
    // One frame: the first state, the first elapsed.
    q.set('state', q.get('state').split(',')[0])
    q.set('elapsed', q.get('elapsed').split(',')[0])
    q.set('style', style)
    q.set('labels', '0')
  }

  const resolveOut = (given, def) => path.resolve(given === true || given === undefined ? path.join(defaultOut, def) : (path.basename(given) === given ? path.join(defaultOut, given) : given))
  const server = await serve(0)
  const url = 'http://127.0.0.1:' + server.address().port + '/tools/render.html?' + q.toString()
  const browser = await launchChromium()
  const finish = () => { browser.close(); server.close() }

  try {
    await openPage(browser.cdp, url, scale)
    if (mode === 'sheet') {
      const file = resolveOut(o.sheet, 'sheet-' + (o.style || style).replace(/,/g, '+') + '-h' + host + '-' + tag + '.png')
      const d = await screenshotShot(browser.cdp, scale, file)
      const stats = await browser.cdp.eval('window.harness.stats')
      console.log(file + '  (' + d.w + 'x' + d.h + ', ' + stats.length + ' frames)')
      for (const s of stats) console.log('  ' + s.style + ' ' + s.state + ' e=' + s.elapsed + ' c=' + Math.round(s.clock) + ': ' + s.ops + ' ops, ' + s.glowOps + ' glow, ' + s.frameMs.toFixed(1) + ' ms')
    } else if (mode === 'single') {
      const st = q.get('state'), el = q.get('elapsed')
      const file = resolveOut(o.out, 'frame.png')
      const d = await screenshotShot(browser.cdp, scale, file)
      const s = (await browser.cdp.eval('window.harness.stats'))[0]
      console.log(file + '  (' + d.w + 'x' + d.h + ', ' + style + ' ' + st + ' e=' + el + ': ' + s.ops + ' ops, ' + s.glowOps + ' glow)')
    } else {
      const fps = Number(o.fps || 30)
      const total = await browser.cdp.eval('window.harness.scriptTotal')
      const seconds = Number(o.seconds || total / 1000)
      const frames = Math.round(seconds * fps)
      const ext = mode === 'gif' ? '.gif' : '.mp4'
      const file = resolveOut(o[mode], 'anim-' + style + '-h' + host + '-' + tag + ext)
      const dir = path.join(path.dirname(file), 'frames-' + path.basename(file, ext))
      fs.rmSync(dir, { recursive: true, force: true })
      fs.mkdirSync(dir, { recursive: true })
      const t0 = Date.now()
      for (let i = 0; i < frames; i++) {
        const f = await browser.cdp.eval('window.harness.stage(' + JSON.stringify(style) + ', ' + (i * 1000 / fps) + ')')
        fs.writeFileSync(path.join(dir, String(i).padStart(5, '0') + '.png'), Buffer.from(f.url.split(',')[1], 'base64'))
        if (i % 30 === 29) process.stderr.write('  frame ' + (i + 1) + '/' + frames + '\r')
      }
      process.stderr.write('\n')
      const inPat = path.join(dir, '%05d.png')
      let args
      if (mode === 'gif') {
        args = ['-y', '-v', 'error', '-framerate', String(fps), '-i', inPat,
          '-vf', 'fps=' + Math.min(fps, 20) + ',split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
          '-loop', '0', file]
      } else {
        args = ['-y', '-v', 'error', '-framerate', String(fps), '-i', inPat,
          '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-movflags', '+faststart', file]
      }
      const r = spawnSync('ffmpeg', args, { stdio: 'inherit' })
      if (r.status !== 0) throw new Error('ffmpeg failed')
      if (!o['keep-frames']) fs.rmSync(dir, { recursive: true, force: true })
      console.log(file + '  (' + frames + ' frames at ' + fps + ' fps, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s to render)')
    }
  } finally {
    finish()
  }
}

main().then(() => { if (!process.argv.includes('--serve')) process.exit(0) }, e => { console.error('shoot: ' + (e && e.message || e)); process.exit(1) })
