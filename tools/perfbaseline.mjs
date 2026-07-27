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
 * The baseline is executable, not a stale screenshot: the renderer keeps its
 * old contact lookup, periodic scene walk, full emitter sort and automatic
 * static matrices behind one audit switch. This command captures that arm for
 * every shot before it captures the shipped arm.
 * It exits non-zero if luminance or any p1/p50/p99 value moves beyond tolerance.
 * Frame time is evidence, not a gate: noisy machines may make a correct
 * optimization look slower, while a visual mismatch is always a failure.
 */

import { readFile } from 'node:fs/promises'
import { extname, normalize, resolve } from 'node:path'
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

// The analyzer reports one decimal place. Both arms boot with the same seeded
// procedural world and pump the same frame count, so the only remaining
// measurement floor is one reporting quantum. 0.2 allows one quantum of
// rounding on each side without accepting a visible percentile movement.
const VISUAL_TOLERANCE = 0.2

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

function compare(ref, got) {
  const deltas = {}
  let pass = true
  for (const key of ['lum', 'p1', 'p50', 'p99']) {
    deltas[key] = +(got[key] - ref[key]).toFixed(1)
    if (Math.abs(deltas[key]) > VISUAL_TOLERANCE) pass = false
  }
  return { pass, deltas }
}

async function captureTheme(browser, theme, args, optimized) {
  const isVoid = theme === 'void'
  const table = isVoid ? VOID_SHOTS : SHOTS
  const names = isVoid ? VOID_SHOT_NAMES : SHOT_NAMES
  const query = isVoid ? '?theme=void' : ''
  const { context, page, errors } = await openFromDist(
    browser, `http://skyline.test/${query}`, args.width, args.height)
  const rows = []
  try {
    await hideChrome(page, { hud: false })
    await page.evaluate((enabled) => {
      const pipeline = window.__game.pipeline
      if (!pipeline || typeof pipeline.setFrameAuditOptimizations !== 'function') {
        throw new Error('frame-audit baseline switch is unavailable')
      }
      pipeline.setFrameAuditOptimizations(enabled)
    }, optimized)
    for (const shot of names) {
      const before = errors.length
      const render = await pumpShot(page, shot, {
        frames: args.frames,
        dt: DEFAULTS.dt,
        syncFrames: args.syncFrames,
      })
      const image = analyzeBuffer(await page.screenshot({ type: 'png' }))
      const measured = visual(image)
      const shotErrors = errors.slice(before)
      rows.push({
        shot,
        note: table[shot].note,
        visual: measured,
        clip: `${image.clipped.highPct}/${image.clipped.lowPct}`,
        draws: render.drawCalls,
        tris: render.triangles,
        frameMs: render.frameMs,
        cpuMs: render.cpuMsPerFrame,
        pass: !image.uniform && shotErrors.length === 0,
        errors: shotErrors,
      })
    }
    return { theme, gl: await glRenderer(page), rows }
  } finally {
    await context.close()
  }
}

function pairResults(baseline, optimized) {
  return baseline.map((before) => {
    const after = optimized.find((candidate) => candidate.theme === before.theme)
    const rows = before.rows.map((a) => {
      const b = after.rows.find((candidate) => candidate.shot === a.shot)
      const check = compare(a.visual, b.visual)
      return {
        shot: a.shot,
        before: a,
        after: b,
        deltas: check.deltas,
        pass: a.pass && b.pass && check.pass,
      }
    })
    return { theme: before.theme, gl: after.gl, rows }
  })
}

function report(results) {
  console.log(`\nvisual tolerance: ±${VISUAL_TOLERANCE} luma units per lum/p1/p50/p99`)
  for (const result of results) {
    console.log(`\n${result.theme} — ${result.gl.renderer}`)
    console.log('| shot | lum | p1/p50/p99 | clip hi/lo | draws | tris | CPU ms/f | synced ms/f | visual |')
    console.log('| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | --- |')
    for (const r of result.rows) {
      const a = r.before
      const b = r.after
      console.log(`| ${r.shot} | ${a.visual.lum} -> ${b.visual.lum} | ${a.visual.p1}/${a.visual.p50}/${a.visual.p99} -> ${b.visual.p1}/${b.visual.p50}/${b.visual.p99} | ${a.clip}% -> ${b.clip}% | ${a.draws} -> ${b.draws} | ${a.tris} -> ${b.tris} | ${a.cpuMs} -> ${b.cpuMs} | ${a.frameMs} -> ${b.frameMs} | ${r.pass ? 'PASS' : 'FAIL'} |`)
      for (const error of [...a.errors, ...b.errors]) console.log(`  ${r.shot}: ${error}`)
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
  let baseline
  let optimized
  try {
    const themes = wanted === 'all' ? ['skyline', 'void'] : [wanted]
    // The full current-tree baseline is deliberately completed before any
    // optimized arm is measured.
    baseline = []
    for (const theme of themes) {
      baseline.push(await captureTheme(browser, theme, args, false))
    }
    optimized = []
    for (const theme of themes) {
      optimized.push(await captureTheme(browser, theme, args, true))
    }
  } finally {
    await browser.close()
  }

  const results = pairResults(baseline, optimized)
  if (cli.json) console.log(JSON.stringify({ tolerance: VISUAL_TOLERANCE, results }, null, 2))
  else report(results)
  if (results.some((r) => r.rows.some((s) => !s.pass))) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
