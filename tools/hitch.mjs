#!/usr/bin/env node
/**
 * Frame-time DISTRIBUTION while the course is actually being run.
 *
 * Every other instrument here reports a mean from a parked camera, and a mean
 * cannot see the thing players call lag. A frame budget of 4 ms with one 60 ms
 * stall every two seconds reads as a stutter, not as 250 fps, and it is
 * invisible to `shotset`. So: hold forward, run, and keep every frame time.
 *
 *   node tools/hitch.mjs [--theme void] [--seconds 20] [--no-build]
 *   node tools/hitch.mjs --self-test
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEFAULTS, REPO, buildDist, glRenderer, hideChrome, launchBrowser, num,
  openGame, parseArgs, startStaticServer,
} from './harness.mjs'

export const HITCH_MS = 1000 / 60

/**
 * One definition for every performance receipt in this repo. "1% low" is the
 * conventional FPS representation of p99 frame time; it is intentionally not
 * the mean FPS of the slowest samples, which can hide an isolated stall.
 */
export function summarizeFrameTimes(values, hitchMs = HITCH_MS) {
  const times = Array.from(values, Number).filter(Number.isFinite)
  if (!times.length) throw new Error('cannot summarize an empty frame-time sample')
  const sorted = times.slice().sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    sorted.length
  const p99 = at(0.99)
  const hitches = times.filter((value) => value > hitchMs)
  const r = (value) => +value.toFixed(3)
  return {
    frames: times.length,
    meanMs: r(mean),
    p50Ms: r(at(0.5)),
    p95Ms: r(at(0.95)),
    p99Ms: r(p99),
    onePctLowFps: r(1000 / p99),
    stddevMs: r(Math.sqrt(variance)),
    hitchThresholdMs: r(hitchMs),
    hitchCount: hitches.length,
    worstHitchMs: hitches.length ? r(Math.max(...hitches)) : 0,
    maxMs: r(sorted[sorted.length - 1]),
  }
}

/**
 * Measure every GPU-synchronized pumped frame at a fixed shot. This is kept
 * here beside the running-course hitch probe so shotset and perfbaseline cannot
 * silently grow different hitch definitions.
 */
export async function measurePumpedFrames(page, name, { frames, dt }) {
  const times = await page.evaluate(({ shot, count, fixedDt }) => {
    const g = window.__game
    const gl = g.renderer.getContext()
    const pixel = new Uint8Array(4)
    const measured = new Array(count)
    window.__SHOT__(shot, true)
    for (let i = 0; i < count; i++) {
      window.__SHOT__(shot)
      const start = performance.now()
      g.tick(fixedDt)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      measured[i] = performance.now() - start
    }
    return measured
  }, { shot: name, count: frames, fixedDt: dt })
  return { times, consistency: summarizeFrameTimes(times) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args['self-test']) {
    selfTest()
    console.log('hitch metrics self-test: PASS')
    return
  }
  const port = num(args.port, 5351)
  const width = num(args.width, 2560)
  const height = num(args.height, 1440)
  const seconds = num(args.seconds, 20)
  const themeArg = args.theme && args.theme !== true ? String(args.theme) : null
  const quality = args.quality && args.quality !== true ? String(args.quality) : 'high'

  if (!args['no-build']) buildDist()
  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  let browser = null
  let out = null
  let gl = null
  try {
    browser = await launchBrowser()
    const query = new URLSearchParams({ quality })
    if (themeArg) query.set('theme', themeArg)
    const url = `${server.url}?${query}`
    const { page } = await openGame(browser, url, { width, height })
    await hideChrome(page, { hud: false })
    gl = await glRenderer(page)
    out = await page.evaluate(run, { frames: Math.round(seconds * 60), dt: DEFAULTS.dt })
    out.consistency = summarizeFrameTimes(out.times)
  } finally {
    if (browser) await browser.close()
    await server.close()
  }

  console.log(`\nframe-time consistency — ${themeArg || 'skyline'} / ${quality}  ${width}x${height}  ${seconds}s of running`)
  console.log(`GL: ${gl ? gl.renderer : 'unknown'}\n`)
  const p = out.consistency
  console.log(`  frames        ${p.frames}`)
  console.log(`  mean          ${p.meanMs} ms`)
  console.log(`  p50           ${p.p50Ms} ms`)
  console.log(`  p95           ${p.p95Ms} ms`)
  console.log(`  p99           ${p.p99Ms} ms`)
  console.log(`  1% low        ${p.onePctLowFps} fps`)
  console.log(`  std deviation ${p.stddevMs} ms`)
  console.log(`  hitches       ${p.hitchCount} frames over ${p.hitchThresholdMs} ms`)
  console.log(`  worst hitch   ${p.worstHitchMs || 'none'}${p.worstHitchMs ? ' ms' : ''}`)
  console.log(`  max           ${p.maxMs} ms`)
  console.log(`\n  worst 10 frames (index: ms)`)
  console.log(`    ${out.worst.map((w) => `${w.i}:${w.ms}`).join('  ')}`)
  console.log('')
  if (args.json) console.log(JSON.stringify(out))
}

/* eslint-disable */
function run({ frames, dt }) {
  const g = window.__game
  const renderer = g.renderer
  const gl = renderer.getContext()
  const px = new Uint8Array(4)

  g.respawn()
  g.hold('fwd')
  g.hold('sprint')

  // Warm up: first-frame shader compiles and lazy allocations are real, but
  // they are a LOADING problem, not a running one, and mixing them into the
  // running distribution would hide everything else.
  for (let i = 0; i < 120; i++) {
    g.tick(dt)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
  }

  const times = new Float64Array(frames)
  for (let i = 0; i < frames; i++) {
    const t = performance.now()
    g.tick(dt)
    // Sync, or the array records how fast the CPU can queue and nothing about
    // when the frame was actually finished.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    times[i] = performance.now() - t
  }
  g.release('fwd'); g.release('sprint')

  const r = (v) => Math.round(v * 100) / 100
  const worst = Array.from(times)
    .map((ms, i) => ({ i, ms: r(ms) }))
    .sort((a, b) => b.ms - a.ms).slice(0, 10)

  return {
    times: Array.from(times),
    worst,
  }
}
/* eslint-enable */

function selfTest() {
  const steady = summarizeFrameTimes([4, 4, 4, 4])
  if (steady.meanMs !== 4 || steady.p99Ms !== 4 || steady.onePctLowFps !== 250 ||
      steady.stddevMs !== 0 || steady.hitchCount !== 0 || steady.worstHitchMs !== 0) {
    throw new Error(`steady sample mismatch: ${JSON.stringify(steady)}`)
  }
  const hitched = summarizeFrameTimes([4, 4, 4, 20])
  if (hitched.meanMs !== 8 || hitched.p99Ms !== 20 || hitched.onePctLowFps !== 50 ||
      hitched.hitchCount !== 1 || hitched.worstHitchMs !== 20 ||
      Math.abs(hitched.stddevMs - 6.928) > 0.001) {
    throw new Error(`hitched sample mismatch: ${JSON.stringify(hitched)}`)
  }
  let rejected = false
  try { summarizeFrameTimes([]) } catch { rejected = true }
  if (!rejected) throw new Error('empty sample was accepted')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
