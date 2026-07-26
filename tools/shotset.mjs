#!/usr/bin/env node
/**
 * Capture every named shot into one directory, in one browser launch.
 *
 *   node tools/shotset.mjs --out /path/to/dir
 *     [--port 5199] [--width 1600] [--height 900] [--frames 90] [--hud]
 *     [--quality lite]   graphics quality level — see src/render/quality.js
 *     [--only terrace,vista] [--no-build] [--json]
 *
 * One launch, one build, one server: a shot set captured across several
 * processes is a shot set whose frames are not comparable with each other,
 * which defeats the point of having a set.
 *
 * Every shot is analysed immediately and gets a verdict. A capture that is a
 * uniform sky-only or inside-a-wall frame FAILS, as does any console error, and
 * the process exits non-zero — the harness is only useful if it can say no.
 */

import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { SHOTS, SHOT_NAMES, VOID_SHOTS, VOID_SHOT_NAMES } from './shots.mjs'
import { analyzeFile } from './analyze.mjs'
import {
  DEFAULTS, REPO, buildDist, glRenderer, hideChrome, launchBrowser, num,
  openGame, parseArgs, pumpShot, startStaticServer,
} from './harness.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = resolve(args.out || 'shots')
  const port = num(args.port, DEFAULTS.port)
  const width = num(args.width, DEFAULTS.width)
  const height = num(args.height, DEFAULTS.height)
  const frames = num(args.frames, DEFAULTS.frames)

  // A shot table belongs to a LEVEL, not to the harness. `--theme void`
  // selects the void course (src/main.js picks the course from the theme), so
  // the skyline's coordinates would be pointing at empty space.
  const themeArg = args.theme && args.theme !== true ? String(args.theme) : null
  const table = themeArg === 'void' ? VOID_SHOTS : SHOTS
  const allNames = themeArg === 'void' ? VOID_SHOT_NAMES : SHOT_NAMES
  const names = args.only && args.only !== true
    ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean)
    : allNames
  const unknown = names.filter((n) => !table[n])
  if (unknown.length) {
    console.error(`unknown shots: ${unknown.join(', ')}`)
    process.exit(2)
  }

  if (!args['no-build']) buildDist()
  await mkdir(outDir, { recursive: true })

  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  let browser = null
  const results = []
  let gl = null
  try {
    browser = await launchBrowser()
    // `--theme void` renders the same shots under a different theme. The theme
    // is read once at boot from the URL (src/theme.js), so it has to be on the
    // address the harness opens, not poked in afterwards.
    const themeName = args.theme && args.theme !== true ? String(args.theme) : null
    // Query params rather than a settings click-through: both the theme and
    // the graphics quality level are read once at boot (src/theme.js,
    // src/main.js), so a shot set is captured by asking for the right page
    // rather than by driving a menu that does not exist yet.
    const q = new URLSearchParams()
    if (themeName) q.set('theme', themeName)
    if (args.quality && args.quality !== true) q.set('quality', String(args.quality))
    const url = q.toString() ? `${server.url}?${q}` : server.url
    const { page, errors } = await openGame(browser, url, { width, height })
    await hideChrome(page, { hud: !!args.hud })
    gl = await glRenderer(page)

    for (const name of names) {
      const file = join(outDir, `${name}.png`)
      const before = errors.length
      const info = await pumpShot(page, name, { frames, dt: DEFAULTS.dt })
      await page.screenshot({ path: file, type: 'png' })

      const bytes = (await stat(file)).size
      const image = analyzeFile(file)
      const shotErrors = errors.slice(before)
      const fail = []
      if (bytes < 1024) fail.push('empty-png')
      if (image.uniform) fail.push('uniform-frame')
      if (shotErrors.length) fail.push('page-error')

      results.push({
        shot: name, file, bytes, note: table[name].note,
        render: info, image, errors: shotErrors,
        pass: fail.length === 0, fail,
      })
    }
  } finally {
    if (browser) await browser.close()
    await server.close()
  }

  if (args.json) {
    console.log(JSON.stringify({ outDir, width, height, frames, gl, results }, null, 2))
  } else {
    report(outDir, width, height, frames, gl, results)
  }
  if (results.some((r) => !r.pass)) process.exitCode = 1
}

function report(outDir, width, height, frames, gl, results) {
  console.log(`\nshot set → ${outDir}   ${width}x${height}, ${frames} pumped frames`)
  console.log(`GL: ${gl ? gl.renderer : 'unknown'}\n`)
  // `spread` is the 3x3 REGION spread (max region mean - min region mean) and
  // `dyn` is p99 - p1 over the whole frame. They answer different questions and
  // they have been confused before: docs/art-direction-void.md §2 writes
  // "spread (p99-p1)" but quotes the sunset column's REGION numbers beside it,
  // which sets an acceptance target of >200 against a statistic that would need
  // a ninth of the frame to average pure white. Printing both is cheaper than
  // arguing about which one a target meant.
  const head = ['shot', 'ok', 'lum', 'sat', 'p1/p50/p99', 'spread', 'dyn', 'clip hi/lo', 'draws', 'tris', 'ms/f']
  const rows = results.map((r) => [
    r.shot,
    r.pass ? 'yes' : `NO(${r.fail.join(',')})`,
    String(r.image.luminance),
    String(r.image.saturation),
    `${r.image.percentiles.p1}/${r.image.percentiles.p50}/${r.image.percentiles.p99}`,
    String(r.image.regionSpread),
    String(r.image.dynamicRange),
    `${r.image.clipped.highPct}%/${r.image.clipped.lowPct}%`,
    String(r.render.drawCalls),
    String(r.render.triangles),
    String(r.render.frameMs),
  ])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(w[i])).join('  ')
  console.log(line(head))
  console.log(w.map((n) => '-'.repeat(n)).join('  '))
  for (const row of rows) console.log(line(row))
  for (const r of results) {
    if (r.errors.length) console.log(`\n${r.shot} errors:\n  ${r.errors.join('\n  ')}`)
  }
  console.log('')
}

main().catch((e) => { console.error(e); process.exit(1) })
