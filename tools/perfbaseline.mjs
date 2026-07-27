#!/usr/bin/env node
/**
 * Reproducible visual/performance baseline without a listening socket.
 *
 * The ordinary shot harness serves dist/ over localhost. Sandboxed lanes cannot
 * bind a port, so this runner fulfils browser requests directly from dist/.
 * It also seeds Math.random before the game loads: before/after captures then
 * compare the same procedural world rather than two different mote fields.
 *
 *   node tools/perfbaseline.mjs [--no-build] [--json]
 *     [--theme skyline|void|all] [--frames 90] [--sync-frames 40]
 *
 * With a stored REFERENCE below, the command exits non-zero if luminance or any
 * p1/p50/p99 value moves by more than VISUAL_TOLERANCE. Frame time is evidence,
 * not a gate: noisy machines may make a correct optimization look slower, while
 * a visual mismatch is always a failed optimization.
 */

import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { analyzeBuffer } from './analyze.mjs'
import { SHOTS, SHOT_NAMES, VOID_SHOTS, VOID_SHOT_NAMES } from './shots.mjs'
import {
  DEFAULTS, REPO, buildDist, glRenderer, hideChrome, launchBrowser, num,
  parseArgs, pumpShot,
} from './harness.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
}

// The analyzer reports one decimal place. Two independently loaded, seeded
// baseline runs were byte/metric identical, so 0.1 is the measured noise floor
// (one reporting quantum), and 0.2 allows one quantum of rounding on each side.
const VISUAL_TOLERANCE = 0.2

// Filled from the untouched tree before the optimization. Keep only the values
// that define "same rendered image"; draw/triangle/frame values are printed as
// the performance reference but are not used to excuse a visual mismatch.
const REFERENCE = {}

function seededRandom() {
  let s = 0x5c0117
  Math.random = () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
  window.requestAnimationFrame = () => 0
  window.cancelAnimationFrame = () => {}
}

async function openFromDist(browser, url, width, height) {
  const root = resolve(REPO, 'dist')
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  })
  await context.route('http://skyline.test/**', async (route) => {
    try {
      const requestUrl = new URL(route.request().url())
      let pathname = decodeURIComponent(requestUrl.pathname)
      if (pathname.endsWith('/')) pathname += 'index.html'
      const file = resolve(root, normalize(pathname).replace(/^[/\\]+/, ''))
      if (!file.startsWith(root + '/')) {
        await route.fulfill({ status: 403, body: 'forbidden' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: MIME[extname(file)] || 'application/octet-stream',
        body: await readFile(file),
      })
    } catch {
      await route.fulfill({ status: 404, body: 'not found' })
    }
  })

  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => {
    errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`)
  })
  await page.addInitScript(seededRandom)
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 })
  await page.evaluate((shots) => { window.__SHOTS__ = shots }, { ...SHOTS, ...VOID_SHOTS })
  return { context, page, errors }
}

function visual(image) {
  return {
    lum: image.luminance,
    p1: image.percentiles.p1,
    p50: image.percentiles.p50,
    p99: image.percentiles.p99,
  }
}

function compare(theme, shot, got) {
  const ref = REFERENCE[theme]?.[shot]
  if (!ref) return { pass: true, deltas: null }
  const deltas = {}
  let pass = true
  for (const key of ['lum', 'p1', 'p50', 'p99']) {
    deltas[key] = +(got[key] - ref[key]).toFixed(1)
    if (Math.abs(deltas[key]) > VISUAL_TOLERANCE) pass = false
  }
  return { pass, deltas }
}

async function captureTheme(browser, theme, args) {
  const isVoid = theme === 'void'
  const table = isVoid ? VOID_SHOTS : SHOTS
  const names = isVoid ? VOID_SHOT_NAMES : SHOT_NAMES
  const query = isVoid ? '?theme=void' : ''
  const { context, page, errors } = await openFromDist(
    browser, `http://skyline.test/${query}`, args.width, args.height)
  const rows = []
  try {
    await hideChrome(page, { hud: false })
    for (const shot of names) {
      const before = errors.length
      const render = await pumpShot(page, shot, {
        frames: args.frames,
        dt: DEFAULTS.dt,
        syncFrames: args.syncFrames,
      })
      const image = analyzeBuffer(await page.screenshot({ type: 'png' }))
      const measured = visual(image)
      const check = compare(theme, shot, measured)
      const shotErrors = errors.slice(before)
      rows.push({
        shot,
        note: table[shot].note,
        visual: measured,
        clip: `${image.clipped.highPct}/${image.clipped.lowPct}`,
        draws: render.drawCalls,
        tris: render.triangles,
        frameMs: render.frameMs,
        pass: check.pass && !image.uniform && shotErrors.length === 0,
        deltas: check.deltas,
        errors: shotErrors,
      })
    }
    return { theme, gl: await glRenderer(page), rows }
  } finally {
    await context.close()
  }
}

function report(results) {
  console.log(`\nvisual tolerance: ±${VISUAL_TOLERANCE} luma units per lum/p1/p50/p99`)
  for (const result of results) {
    console.log(`\n${result.theme} — ${result.gl.renderer}`)
    console.log('| shot | lum | p1/p50/p99 | clip hi/lo | draws | tris | ms/f | visual |')
    console.log('| --- | ---: | --- | --- | ---: | ---: | ---: | --- |')
    for (const r of result.rows) {
      const v = r.visual
      console.log(`| ${r.shot} | ${v.lum} | ${v.p1}/${v.p50}/${v.p99} | ${r.clip}% | ${r.draws} | ${r.tris} | ${r.frameMs} | ${r.pass ? 'PASS' : 'FAIL'} |`)
      for (const error of r.errors) console.log(`  ${r.shot}: ${error}`)
    }
  }
  console.log('')
}

async function main() {
  const cli = parseArgs(process.argv.slice(2))
  const args = {
    width: num(cli.width, DEFAULTS.width),
    height: num(cli.height, DEFAULTS.height),
    frames: num(cli.frames, DEFAULTS.frames),
    syncFrames: num(cli['sync-frames'], 40),
  }
  const wanted = cli.theme && cli.theme !== true ? String(cli.theme) : 'all'
  if (!['all', 'skyline', 'void'].includes(wanted)) {
    console.error('theme must be skyline, void, or all')
    process.exit(2)
  }
  if (!cli['no-build']) buildDist()

  const browser = await launchBrowser()
  let results
  try {
    const themes = wanted === 'all' ? ['skyline', 'void'] : [wanted]
    results = []
    for (const theme of themes) results.push(await captureTheme(browser, theme, args))
  } finally {
    await browser.close()
  }

  if (cli.json) console.log(JSON.stringify({ tolerance: VISUAL_TOLERANCE, results }, null, 2))
  else report(results)
  if (results.some((r) => r.rows.some((s) => !s.pass))) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
