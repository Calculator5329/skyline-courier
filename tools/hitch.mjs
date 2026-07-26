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
 */

import { resolve } from 'node:path'
import {
  DEFAULTS, REPO, buildDist, glRenderer, hideChrome, launchBrowser, num,
  openGame, parseArgs, startStaticServer,
} from './harness.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const port = num(args.port, 5351)
  const width = num(args.width, 2560)
  const height = num(args.height, 1440)
  const seconds = num(args.seconds, 20)
  const themeArg = args.theme && args.theme !== true ? String(args.theme) : null

  if (!args['no-build']) buildDist()
  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  let browser = null
  let out = null
  let gl = null
  try {
    browser = await launchBrowser()
    const url = themeArg ? `${server.url}?theme=${encodeURIComponent(themeArg)}` : server.url
    const { page } = await openGame(browser, url, { width, height })
    await hideChrome(page, { hud: false })
    gl = await glRenderer(page)
    out = await page.evaluate(run, { frames: Math.round(seconds * 60), dt: DEFAULTS.dt })
  } finally {
    if (browser) await browser.close()
    await server.close()
  }

  console.log(`\nframe-time distribution — ${themeArg || 'skyline'}  ${width}x${height}  ${seconds}s of running`)
  console.log(`GL: ${gl ? gl.renderer : 'unknown'}\n`)
  const p = out.pct
  console.log(`  frames        ${out.n}`)
  console.log(`  mean          ${p.mean} ms`)
  console.log(`  p50           ${p.p50} ms`)
  console.log(`  p95           ${p.p95} ms`)
  console.log(`  p99           ${p.p99} ms`)
  console.log(`  max           ${p.max} ms`)
  console.log(`  over 16.7 ms  ${out.over60} frames (${out.over60Pct}%)`)
  console.log(`  over 33.3 ms  ${out.over30} frames`)
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

  const sorted = Array.from(times).sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const r = (v) => Math.round(v * 100) / 100
  const worst = Array.from(times)
    .map((ms, i) => ({ i, ms: r(ms) }))
    .sort((a, b) => b.ms - a.ms).slice(0, 10)
  let over60 = 0, over30 = 0
  for (const t of times) { if (t > 16.7) over60++; if (t > 33.3) over30++ }

  return {
    n: frames,
    pct: {
      mean: r(sorted.reduce((s, v) => s + v, 0) / sorted.length),
      p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(sorted[sorted.length - 1]),
    },
    over60, over30, over60Pct: r((over60 / frames) * 100), worst,
  }
}
/* eslint-enable */

main().catch((e) => { console.error(e); process.exit(1) })
