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
 *   node tools/perfbaseline.mjs --calibrate-visual 5 [--theme skyline]
 *   node tools/perfbaseline.mjs --quality-levels
 *     [--only terrace,crossing,tower,closeup] [--repeats 4]
 *     [--screenshot-shot closeup] [--screenshot-out /durable/path]
 *
 * The baseline is executable, not a stale screenshot: the renderer keeps its
 * old contact lookup, periodic scene walk, full emitter sort and automatic
 * static matrices behind one audit switch. This command captures that arm for
 * every shot before it captures the shipped arm.
 * It exits non-zero if HIGH's luminance or any p1/p50/p99 value moves beyond
 * tolerance. Balanced and Lite intentionally move the image and are reported
 * by `--quality-levels`; they are not inputs to this image-invariance gate.
 * Frame time is evidence, not a gate: noisy machines may make a correct
 * optimization look slower, while a visual mismatch is always a failure.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { chromium } from 'playwright'
import { analyzeBuffer } from './analyze.mjs'
import { SHOTS, SHOT_NAMES, VOID_SHOTS, VOID_SHOT_NAMES } from './shots.mjs'
import {
  DEFAULTS, GPU_ARGS, REPO, buildDist, glRenderer, hideChrome, launchBrowser, num,
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

// The analyzer reports one decimal place. The high-only gate first takes five
// IDENTICAL captures in fresh seeded contexts, records every per-metric range,
// then sets its tolerance exactly one reporting quantum above that run's
// observed maximum. The candidate arm cannot influence this number.
const VISUAL_REPORTING_QUANTUM = 0.1

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

function liveFrameProbe() {
  let s = 0x5c0117
  Math.random = () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }

  const nativeRAF = window.requestAnimationFrame.bind(window)
  const samples = []
  let lastTimestamp = null
  let syncPixel = null
  window.__SC_LIVE_FRAME_AUDIT__ = samples
  window.requestAnimationFrame = (callback) => nativeRAF((timestamp) => {
    const start = performance.now()
    callback(timestamp)
    // Sync only in this opt-in audit arm. Production has no readback; forcing
    // completion here makes `completedMs` CPU + GPU instead of queueing time.
    const game = window.__game
    if (game && game.renderer) {
      const gl = game.renderer.getContext()
      if (!syncPixel) syncPixel = new Uint8Array(4)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel)
    }
    const end = performance.now()
    if (lastTimestamp !== null) {
      samples.push({
        intervalMs: timestamp - lastTimestamp,
        completedMs: end - start,
        heapBytes: performance.memory ? performance.memory.usedJSHeapSize : null,
      })
      if (samples.length > 1200) samples.shift()
    }
    lastTimestamp = timestamp
  })
}

async function openFromDist(browser, url, width, height, live = false) {
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
  await page.addInitScript(live ? liveFrameProbe : seededRandom)
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 })
  await page.evaluate((shots) => { window.__SHOTS__ = shots }, { ...SHOTS, ...VOID_SHOTS })
  return { context, page, errors }
}

function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const r = (v) => +v.toFixed(3)
  return {
    mean: r(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: r(at(0.5)),
    p95: r(at(0.95)),
    p99: r(at(0.99)),
    max: r(sorted[sorted.length - 1]),
  }
}

async function captureLiveFrame(browser, width, height, frames) {
  const { context, page, errors } = await openFromDist(
    browser, 'http://skyline.test/', width, height, true)
  try {
    await hideChrome(page, { hud: false })
    await page.evaluate(() => {
      const g = window.__game
      g.respawn()
      g.hold('fwd')
      g.hold('sprint')
      window.__SC_LIVE_FRAME_AUDIT__.length = 0
    })
    await page.waitForFunction(
      (count) => window.__SC_LIVE_FRAME_AUDIT__.length >= count,
      frames,
      { timeout: Math.max(30000, frames * 50) }
    )
    const samples = await page.evaluate(
      (count) => window.__SC_LIVE_FRAME_AUDIT__.slice(-count),
      frames
    )
    const heap = samples.map((sample) => sample.heapBytes).filter(Number.isFinite)
    const completed = distribution(samples.map((sample) => sample.completedMs))
    return {
      width,
      height,
      frames,
      gl: await glRenderer(page),
      interval: distribution(samples.map((sample) => sample.intervalMs)),
      completed,
      headroom240P95: +(1000 / 240 - completed.p95).toFixed(3),
      heapRangeBytes: heap.length ? Math.max(...heap) - Math.min(...heap) : null,
      errors,
    }
  } finally {
    await context.close()
  }
}

function reportLive(rows) {
  console.log('\nlive rAF audit — running forward+sprint; completed time includes an audit-only GPU sync')
  console.log('| native size | rAF interval p50/p95/p99 | completed p50/p95/p99/max | 240 Hz headroom at p95 | JS heap range |')
  console.log('| --- | --- | --- | ---: | ---: |')
  for (const row of rows) {
    console.log(`| ${row.width}x${row.height} | ${row.interval.p50}/${row.interval.p95}/${row.interval.p99} | ${row.completed.p50}/${row.completed.p95}/${row.completed.p99}/${row.completed.max} | ${row.headroom240P95} ms | ${row.heapRangeBytes ?? 'unavailable'} |`)
    for (const error of row.errors) console.log(`  ${row.width}x${row.height}: ${error}`)
  }
  console.log('')
}

async function runLiveAudit(cli) {
  const frames = num(cli.frames, 300)
  const sizes = cli.width || cli.height
    ? [[num(cli.width, 1920), num(cli.height, 1080)]]
    : [[1920, 1080], [2560, 1440]]
  const browser = cli.headed
    ? await chromium.launch({ headless: false, args: GPU_ARGS })
    : await launchBrowser()
  const rows = []
  try {
    for (const [width, height] of sizes) {
      rows.push(await captureLiveFrame(browser, width, height, frames))
    }
  } finally {
    await browser.close()
  }
  if (cli.json) console.log(JSON.stringify({ live: true, rows }, null, 2))
  else reportLive(rows)
  if (rows.some((row) => row.errors.length)) process.exitCode = 1
}

function visual(image) {
  return {
    lum: image.luminance,
    p1: image.percentiles.p1,
    p50: image.percentiles.p50,
    p99: image.percentiles.p99,
  }
}

function compare(ref, got, tolerance) {
  const deltas = {}
  let pass = true
  for (const key of ['lum', 'p1', 'p50', 'p99']) {
    deltas[key] = +(got[key] - ref[key]).toFixed(1)
    if (Math.abs(deltas[key]) > tolerance) pass = false
  }
  return { pass, deltas }
}

async function captureTheme(browser, theme, args, optimized, quality = 'high') {
  const isVoid = theme === 'void'
  const table = isVoid ? VOID_SHOTS : SHOTS
  const names = isVoid ? VOID_SHOT_NAMES : SHOT_NAMES
  const query = new URLSearchParams({ quality })
  if (isVoid) query.set('theme', 'void')
  const { context, page, errors } = await openFromDist(
    browser, `http://skyline.test/?${query}`, args.width, args.height)
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

function calibrationRanges(captures) {
  const rows = []
  for (const theme of captures[0].map((capture) => capture.theme)) {
    const themeCaptures = captures.map(
      (capture) => capture.find((candidate) => candidate.theme === theme)
    )
    for (const first of themeCaptures[0].rows) {
      const metrics = {}
      for (const key of ['lum', 'p1', 'p50', 'p99']) {
        const values = themeCaptures.map(
          (capture) => capture.rows.find((row) => row.shot === first.shot).visual[key]
        )
        metrics[key] = {
          min: Math.min(...values),
          max: Math.max(...values),
          range: +(Math.max(...values) - Math.min(...values)).toFixed(1),
        }
      }
      rows.push({ theme, shot: first.shot, metrics })
    }
  }
  return rows
}

async function measureVisualCalibration(browser, themes, args, count) {
  if (!Number.isInteger(count) || count < 5) {
    throw new Error('visual calibration requires an integer capture count >= 5')
  }
  const captures = []
  for (let run = 0; run < count; run++) {
    const sample = []
    for (const theme of themes) {
      // Exact same high-quality arm every time: no optimization switch changes
      // between captures. A fresh context exposes real capture/driver noise.
      sample.push(await captureTheme(browser, theme, args, true, 'high'))
    }
    captures.push(sample)
  }
  const rows = calibrationRanges(captures)
  const observedMax = Math.max(
    ...rows.flatMap((row) => Object.values(row.metrics).map((metric) => metric.range))
  )
  return {
    quality: 'high',
    captures: count,
    observedMax,
    tolerance: +(observedMax + VISUAL_REPORTING_QUANTUM).toFixed(1),
    rows,
  }
}

function reportVisualCalibration(calibration) {
  const { captures, observedMax, tolerance, rows } = calibration
  console.log(`\nhigh-only visual reproducibility — ${captures} identical captures`)
  console.log('| theme | shot | lum range | p1 range | p50 range | p99 range |')
  console.log('| --- | --- | ---: | ---: | ---: | ---: |')
  for (const row of rows) {
    console.log(`| ${row.theme} | ${row.shot} | ${row.metrics.lum.range} | ${row.metrics.p1.range} | ${row.metrics.p50.range} | ${row.metrics.p99.range} |`)
  }
  console.log(`\nobserved maximum range: ${observedMax} luma units`)
  console.log(`high-only gate tolerance: ±${tolerance} (observed max + one 0.1 reporting quantum)\n`)
}

async function runVisualCalibration(browser, themes, args, count, json) {
  const calibration = await measureVisualCalibration(browser, themes, args, count)
  if (json) {
    console.log(JSON.stringify({ calibration: true, ...calibration }, null, 2))
    return
  }
  reportVisualCalibration(calibration)
}

const QUALITY_NAMES = ['high', 'balanced', 'lite']

function qualityShotNames(cli) {
  const names = cli.only && cli.only !== true
    ? String(cli.only).split(',').map((name) => name.trim()).filter(Boolean)
    : ['terrace', 'crossing', 'tower', 'closeup']
  const unknown = names.filter((name) => !SHOTS[name])
  if (unknown.length) {
    throw new Error(`unknown skyline shots: ${unknown.join(', ')}`)
  }
  return names
}

async function captureQualitySize(browser, width, height, args, options) {
  const { context, page, errors } = await openFromDist(
    browser, 'http://skyline.test/?quality=high', width, height)
  try {
    await hideChrome(page, { hud: false })
    const samples = Object.fromEntries(
      QUALITY_NAMES.map((quality) => [
        quality,
        Object.fromEntries(options.names.map((shot) => [shot, []])),
      ])
    )
    for (let repeat = 0; repeat < options.repeats; repeat++) {
      const order = QUALITY_NAMES.slice(repeat % QUALITY_NAMES.length)
        .concat(QUALITY_NAMES.slice(0, repeat % QUALITY_NAMES.length))
      for (const shot of options.names) {
        for (const quality of order) {
          await page.evaluate((name) => window.__game.setQuality(name), quality)
          const measured = await pumpShot(page, shot, {
            frames: args.frames,
            dt: DEFAULTS.dt,
            syncFrames: args.syncFrames,
          })
          samples[quality][shot].push(measured.frameMs)
        }
      }
    }

    const rows = QUALITY_NAMES.map((quality) => {
      const shots = options.names.map((shot) => ({
        shot,
        samples: samples[quality][shot],
        // Scheduler noise is one-sided. This matches perfprobe's established
        // minimum-of-interleaved-repeats hygiene.
        frameMs: Math.min(...samples[quality][shot]),
      }))
      return {
        quality,
        shots,
        meanMs: +(shots.reduce((sum, shot) => sum + shot.frameMs, 0) / shots.length)
          .toFixed(3),
      }
    })

    const screenshots = []
    if (options.screenshotOut && width === 1600 && height === 900) {
      await mkdir(options.screenshotOut, { recursive: true })
      for (const quality of QUALITY_NAMES) {
        await page.evaluate((name) => window.__game.setQuality(name), quality)
        await pumpShot(page, options.screenshotShot, {
          frames: args.frames,
          dt: DEFAULTS.dt,
          syncFrames: args.syncFrames,
        })
        const path = join(options.screenshotOut, `${quality}.png`)
        const png = await page.screenshot({ path, type: 'png' })
        screenshots.push({
          quality,
          shot: options.screenshotShot,
          path,
          visual: visual(analyzeBuffer(png)),
        })
      }
    }
    return {
      width,
      height,
      gl: await glRenderer(page),
      rows,
      screenshots,
      errors,
    }
  } finally {
    await context.close()
  }
}

function reportQualityLevels(results, options) {
  console.log(`\nquality levels — ${options.names.join(', ')}; minimum of ${options.repeats} interleaved repeats per shot`)
  console.log('| level | 1600x900 mean ms/f | 2560x1440 mean ms/f | 1440p / 240 Hz |')
  console.log('| --- | ---: | ---: | --- |')
  const bySize = (quality, width) => results
    .find((result) => result.width === width).rows
    .find((row) => row.quality === quality)
  for (const quality of QUALITY_NAMES) {
    const small = bySize(quality, 1600)
    const large = bySize(quality, 2560)
    const verdict = large.meanMs <= 1000 / 240 ? 'reaches 240 Hz' : 'misses 240 Hz'
    console.log(`| ${quality} | ${small.meanMs} | ${large.meanMs} | ${verdict} |`)
  }
  for (const result of results) {
    console.log(`\n${result.width}x${result.height} — ${result.gl.renderer}`)
    for (const row of result.rows) {
      console.log(`  ${row.quality}: ${row.shots.map((shot) => `${shot.shot}=${shot.frameMs}`).join(', ')}`)
    }
    for (const error of result.errors) console.log(`  error: ${error}`)
  }
  const screenshots = results.flatMap((result) => result.screenshots)
  if (screenshots.length) {
    console.log(`\nsame-shot captures (${options.screenshotShot}):`)
    for (const shot of screenshots) console.log(`  ${shot.quality}: ${shot.path}`)
  }
  console.log('')
}

async function runQualityLevels(browser, cli, args) {
  const options = {
    names: qualityShotNames(cli),
    repeats: num(cli.repeats, 4),
    screenshotShot: cli['screenshot-shot'] && cli['screenshot-shot'] !== true
      ? String(cli['screenshot-shot'])
      : 'closeup',
    screenshotOut: cli['screenshot-out'] && cli['screenshot-out'] !== true
      ? resolve(String(cli['screenshot-out']))
      : null,
  }
  if (!Number.isInteger(options.repeats) || options.repeats < 2) {
    throw new Error('--repeats must be an integer >= 2')
  }
  if (!SHOTS[options.screenshotShot]) {
    throw new Error(`unknown screenshot shot: ${options.screenshotShot}`)
  }
  const results = []
  for (const [width, height] of [[1600, 900], [2560, 1440]]) {
    results.push(await captureQualitySize(browser, width, height, args, options))
  }
  if (cli.json) {
    console.log(JSON.stringify({ qualityLevels: true, options, results }, null, 2))
  } else {
    reportQualityLevels(results, options)
  }
  if (results.some((result) => result.errors.length)) process.exitCode = 1
}

function pairResults(baseline, optimized, tolerance) {
  return baseline.map((before) => {
    const after = optimized.find((candidate) => candidate.theme === before.theme)
    const rows = before.rows.map((a) => {
      const b = after.rows.find((candidate) => candidate.shot === a.shot)
      const check = compare(a.visual, b.visual, tolerance)
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

function report(results, calibration) {
  reportVisualCalibration(calibration)
  console.log(`visual tolerance: ±${calibration.tolerance} luma units per lum/p1/p50/p99`)
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
  if (cli.live) {
    await runLiveAudit(cli)
    return
  }

  const browser = await launchBrowser()
  let baseline
  let optimized
  let calibration
  try {
    const themes = wanted === 'all' ? ['skyline', 'void'] : [wanted]
    if (cli['calibrate-visual']) {
      await runVisualCalibration(
        browser, themes, args, num(cli['calibrate-visual'], 0), !!cli.json)
      return
    }
    if (cli['quality-levels']) {
      await runQualityLevels(browser, cli, args)
      return
    }
    // Calibrate from identical HIGH captures before either comparison arm.
    // This is deliberately part of every gate run: a stale constant is what
    // manufactured the original failures when terrace p99 moved by 0.7.
    calibration = await measureVisualCalibration(browser, themes, args, 5)
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

  const results = pairResults(baseline, optimized, calibration.tolerance)
  if (cli.json) console.log(JSON.stringify({ calibration, results }, null, 2))
  else report(results, calibration)
  if (results.some((r) => r.rows.some((s) => !s.pass))) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
