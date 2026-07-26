/**
 * Shared plumbing for the headless verification harness.
 *
 * Everything here exists to make a capture mean something:
 *
 *  - We build and serve `dist/` ourselves rather than pointing at whatever dev
 *    server happens to be running. A dev server that another agent's edit
 *    hot-reloads mid-capture produces a screenshot of a page that no longer
 *    exists, and you cannot tell that from the PNG.
 *  - We stub `requestAnimationFrame` before the app loads and drive the game
 *    with explicit fixed-dt ticks. rAF is throttled to zero in a backgrounded
 *    or headless-composited tab, so a harness that waited on it would measure a
 *    game that was never running — and even when it does run, real-time frames
 *    make every capture a different frame of a moving world.
 *  - Console errors and page errors are fatal. A screenshot of a broken frame
 *    is still a screenshot.
 */

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { SHOTS, VOID_SHOTS } from './shots.mjs'

export const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Chromium flags. Without these headless falls back to SwiftShader defaults
 *  that both look different and run at a tenth of the speed, so the ms/frame
 *  number would be measuring the wrong renderer. */
export const GPU_ARGS = [
  '--ignore-gpu-blocklist',
  '--enable-gpu-rasterization',
  '--use-gl=angle',
  '--force-color-profile=srgb',
  '--force-device-scale-factor=1',
  '--hide-scrollbars',
  '--mute-audio',
]

export const DEFAULTS = {
  port: 5199,
  width: 1600,
  height: 900,
  frames: 90,      // pump length: enough for the exposure meter to converge
  dt: 1 / 60,
}

// ------------------------------------------------------------------- args

/** Minimal `--key value` / `--flag` parser. No dependency earns its keep here. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

export function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

// ------------------------------------------------------------------ build

export function buildDist() {
  const r = spawnSync('npm', ['run', 'build'], { cwd: REPO, encoding: 'utf8' })
  if (r.status !== 0) {
    process.stderr.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    throw new Error('npm run build failed')
  }
  return (r.stdout || '').trim().split('\n').slice(-1)[0]
}

// ----------------------------------------------------------------- server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}

/**
 * A static file server over `root`, on our own port.
 *
 * Deliberately tiny and deliberately ours: it is torn down in a finally block
 * so a failed capture never leaves a port held.
 */
export function startStaticServer(root, port) {
  const base = resolve(root)
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      let p = decodeURIComponent(url.pathname)
      if (p.endsWith('/')) p += 'index.html'
      // normalize() first: a path that escapes the root is a bug or an attack,
      // and either way it must not read the filesystem.
      const file = join(base, normalize(p))
      if (!file.startsWith(base)) { res.writeHead(403).end(); return }
      const body = await readFile(file)
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    }
  })

  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => {
      ok({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

// ---------------------------------------------------------------- browser

export async function launchBrowser() {
  return chromium.launch({ headless: true, args: GPU_ARGS })
}

/**
 * Open the game, wait for a drawn frame, and return a page wired for capture.
 *
 * The rAF stub goes in before any script runs: with it in place the game's own
 * loop ticks exactly once (synchronously, from `frame()`) and then stops, and
 * every subsequent frame is one we asked for.
 */
export async function openGame(browser, url, { width, height, reducedMotion = 'no-preference' }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    // Defaults to off so a shot set is comparable frame to frame; the menu set
    // flips it on for one capture, because "everything decorative stops and
    // every readout keeps its value" is a promise nothing else checks.
    reducedMotion,
  })
  const page = await context.newPage()

  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => {
    // A missing chunk is invisible in a screenshot but fatal to what it shows.
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`)
  })

  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0
    window.cancelAnimationFrame = () => {}
  })

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 })
  // Both tables are injected, keyed by name. A shot belongs to a LEVEL, and
  // `--theme void` boots a different level, so the harness cannot assume the
  // skyline coordinates are the ones in play. Names are disjoint across the
  // two tables, so one merged object is unambiguous.
  await page.evaluate((shots) => { window.__SHOTS__ = shots }, { ...SHOTS, ...VOID_SHOTS })

  return { context, page, errors }
}

/** Hide the click-to-start overlay, and (by default) the HUD as well: HUD
 *  pixels are saturated UI colour that would poison every analyze.mjs number. */
export async function hideChrome(page, { hud = false } = {}) {
  await page.evaluate((keepHud) => {
    const overlay = document.getElementById('overlay')
    if (overlay) overlay.classList.add('hidden')
    const h = document.getElementById('hud')
    if (h) h.style.display = keepHud ? '' : 'none'
  }, hud)
}

/**
 * Apply a shot, pump frames, and report what the renderer did.
 *
 * The pose is re-applied every frame (see `__SHOT__`), which is what makes a
 * mid-air shot hold still. Draw calls are counted over a single clean frame
 * with `info.autoReset` off, because the pipeline issues several renderer
 * passes per frame and the default per-render reset would report only the last.
 */
export async function pumpShot(page, name, { frames, dt, syncFrames = 20 }) {
  return page.evaluate(({ name, frames, dt, SYNC_FRAMES }) => {
    const g = window.__game
    const renderer = g.renderer

    window.__SHOT__(name, true)

    const t0 = performance.now()
    for (let i = 0; i < frames; i++) {
      window.__SHOT__(name)
      g.tick(dt)
    }
    const cpuMsPerFrame = (performance.now() - t0) / frames

    // WebGL commands are queued, so the loop above measures the CPU submitting
    // work and nothing about the GPU doing it — which is how you get a "3000
    // fps" number from a frame that takes 12 ms to draw. A 1x1 readPixels after
    // each tick forces a flush, so this second pass is the honest one.
    const gl = renderer.getContext()
    const px = new Uint8Array(4)
    const t1 = performance.now()
    for (let i = 0; i < SYNC_FRAMES; i++) {
      window.__SHOT__(name)
      g.tick(dt)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    }
    const frameMs = (performance.now() - t1) / SYNC_FRAMES

    renderer.info.autoReset = false
    renderer.info.reset()
    window.__SHOT__(name)
    g.tick(dt)
    const info = {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs ? renderer.info.programs.length : null,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
    }
    renderer.info.autoReset = true

    const cam = g.camera
    const round = (v) => Math.round(v * 1000) / 1000
    return {
      ...info,
      frameMs: round(frameMs),
      cpuMsPerFrame: round(cpuMsPerFrame),
      fps: Math.round(1000 / frameMs),
      camera: {
        x: +cam.position.x.toFixed(2),
        y: +cam.position.y.toFixed(2),
        z: +cam.position.z.toFixed(2),
        fov: +cam.fov.toFixed(1),
      },
      grounded: g.player.grounded,
      speed: +g.player.speed.toFixed(2),
    }
  }, { name, frames, dt, SYNC_FRAMES: syncFrames })
}

/**
 * Which GL implementation actually drew the frame.
 *
 * Worth printing with every run: a capture made on SwiftShader and one made on
 * a real GPU are not the same evidence, and the timing numbers are not
 * comparable at all.
 */
export async function glRenderer(page) {
  return page.evaluate(() => {
    const gl = window.__game.renderer.getContext()
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    }
  })
}
