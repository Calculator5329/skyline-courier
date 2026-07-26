#!/usr/bin/env node
/**
 * Capture the void-kit scratch stage (`voidkit.html` / `src/voidkit-scratch.js`).
 *
 *   node tools/voidshots.mjs --out docs/captures/voidkit
 *     [--only corridor,wallrun] [--theme void] [--width 1600] [--height 900]
 *     [--frames 90] [--no-build] [--json]
 *
 * WHY A SECOND SHOT TOOL. `tools/shotset.mjs` photographs the COURSE, and the
 * course is built in `src/level.js` — a file this lane must not touch while a
 * sibling agent is in it. A prefab nothing places cannot be photographed, and
 * "it compiles" is exactly the evidence `docs/purpose.md` says is worthless.
 * So this points the same harness (same build, same static server, same rAF
 * stub, same analyzer, same fatal-console-error rule) at a stage that contains
 * nothing but the four prefabs under test.
 *
 * It is NOT a replacement for the course shots and it is not in the ship gate.
 * When the void course exists, these prefabs get judged there and this becomes
 * a component-level regression check.
 *
 * Own port (5231): 5199 capture, 5207 reachability, 5219 backface, 5223
 * coverage, 5183 dev. Sharing one silently measures somebody else's build.
 */

import { spawnSync } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { analyzeFile } from './analyze.mjs'
import {
  DEFAULTS, REPO, glRenderer, launchBrowser, num, parseArgs, startStaticServer,
} from './harness.mjs'

const PORT = 5231

/** The scratch page is only in the bundle when the flag is set — see vite.config.js. */
function buildScratch() {
  const r = spawnSync('npm', ['run', 'build'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, SKYLINE_SCRATCH: '1' },
  })
  if (r.status !== 0) {
    process.stderr.write(r.stdout || '')
    process.stderr.write(r.stderr || '')
    throw new Error('npm run build (SKYLINE_SCRATCH=1) failed')
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = resolve(args.out || 'docs/captures/voidkit')
  const width = num(args.width, DEFAULTS.width)
  const height = num(args.height, DEFAULTS.height)
  const frames = num(args.frames, DEFAULTS.frames)
  const themeName = args.theme && args.theme !== true ? String(args.theme) : 'void'

  if (!args['no-build']) buildScratch()
  await mkdir(outDir, { recursive: true })

  const server = await startStaticServer(resolve(REPO, 'dist'), PORT)
  let browser = null
  const results = []
  let gl = null
  let stats = null
  try {
    browser = await launchBrowser()
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`))
    await page.addInitScript(() => {
      window.requestAnimationFrame = () => 0
      window.cancelAnimationFrame = () => {}
    })

    await page.goto(`${server.url}voidkit.html?theme=${encodeURIComponent(themeName)}`,
      { waitUntil: 'load' })
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 })
    gl = await glRenderer(page)

    const all = await page.evaluate(() => Object.keys(window.__game.shots))
    const names = args.only && args.only !== true
      ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean)
      : all
    const unknown = names.filter((n) => !all.includes(n))
    if (unknown.length) throw new Error(`unknown shots: ${unknown.join(', ')}`)

    stats = await page.evaluate(() => ({
      glow: window.__game.glow,
      colors: window.__game.colors,
      colliders: window.__game.level.collision.boxes.length,
    }))

    for (const name of names) {
      const before = errors.length
      const info = await page.evaluate(({ name, frames, dt }) => {
        const g = window.__game
        window.__VSHOT__(name)
        for (let i = 0; i < frames; i++) g.tick(dt)
        const gl2 = g.renderer.getContext()
        const px = new Uint8Array(4)
        const t1 = performance.now()
        for (let i = 0; i < 20; i++) {
          g.tick(dt)
          gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, px)
        }
        const frameMs = (performance.now() - t1) / 20
        g.renderer.info.autoReset = false
        g.renderer.info.reset()
        g.tick(dt)
        const out = {
          drawCalls: g.renderer.info.render.calls,
          triangles: g.renderer.info.render.triangles,
          frameMs: Math.round(frameMs * 1000) / 1000,
        }
        g.renderer.info.autoReset = true
        return out
      }, { name, frames, dt: DEFAULTS.dt })

      const file = join(outDir, `${name}.png`)
      await page.screenshot({ path: file, type: 'png' })
      const bytes = (await stat(file)).size
      const image = analyzeFile(file)
      const shotErrors = errors.slice(before)
      const fail = []
      if (bytes < 1024) fail.push('empty-png')
      if (image.uniform) fail.push('uniform-frame')
      if (shotErrors.length) fail.push('page-error')
      results.push({ shot: name, file, bytes, render: info, image, errors: shotErrors, pass: !fail.length, fail })
    }
  } finally {
    if (browser) await browser.close()
    await server.close()
  }

  if (args.json) {
    console.log(JSON.stringify({ outDir, gl, stats, results }, null, 2))
  } else {
    console.log(`\nvoid-kit stage → ${outDir}   ${width}x${height}, ${frames} pumped frames`)
    console.log(`GL: ${gl ? gl.renderer : 'unknown'}`)
    console.log(`glow layer: ${JSON.stringify(stats && stats.glow)}`)
    console.log(`accents: ${JSON.stringify(stats && stats.colors)}   colliders: ${stats && stats.colliders}\n`)
    const head = ['shot', 'ok', 'lum', 'sat', 'p1/p50/p99', 'spread', 'clip hi/lo', 'draws', 'tris', 'ms/f']
    const rows = results.map((r) => [
      r.shot, r.pass ? 'yes' : `NO(${r.fail.join(',')})`,
      String(r.image.luminance), String(r.image.saturation),
      `${r.image.percentiles.p1}/${r.image.percentiles.p50}/${r.image.percentiles.p99}`,
      String(r.image.regionSpread),
      `${r.image.clipped.highPct}%/${r.image.clipped.lowPct}%`,
      String(r.render.drawCalls), String(r.render.triangles), String(r.render.frameMs),
    ])
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)))
    const line = (c) => c.map((s, i) => s.padEnd(w[i])).join('  ')
    console.log(line(head))
    console.log(w.map((n) => '-'.repeat(n)).join('  '))
    for (const row of rows) console.log(line(row))
    for (const r of results) if (r.errors.length) console.log(`\n${r.shot}:\n  ${r.errors.join('\n  ')}`)
    console.log('')
  }
  if (results.some((r) => !r.pass)) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exit(1) })
