#!/usr/bin/env node
/**
 * Capture one named shot from the built game.
 *
 *   node tools/capture.mjs --shot terrace --out shots/terrace.png
 *     [--port 5199] [--width 1600] [--height 900] [--frames 90] [--hud]
 *     [--no-build] [--json]
 *
 * Exits non-zero if the build fails, the shot name is unknown, or the page
 * logged a console/page error — a screenshot taken from a page that threw is
 * worse than no screenshot, because it looks like evidence.
 */

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { SHOTS, SHOT_NAMES } from './shots.mjs'
import {
  DEFAULTS, REPO, buildDist, glRenderer, hideChrome, launchBrowser, num,
  openGame, parseArgs, pumpShot, startStaticServer,
} from './harness.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const shot = args.shot
  if (!shot || !SHOTS[shot]) {
    console.error(`--shot must be one of: ${SHOT_NAMES.join(', ')}`)
    process.exit(2)
  }
  const out = resolve(args.out || `shots/${shot}.png`)
  const port = num(args.port, DEFAULTS.port)
  const width = num(args.width, DEFAULTS.width)
  const height = num(args.height, DEFAULTS.height)
  const frames = num(args.frames, DEFAULTS.frames)

  if (!args['no-build']) buildDist()
  await mkdir(dirname(out), { recursive: true })

  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  let browser = null
  try {
    browser = await launchBrowser()
    const { page, errors } = await openGame(browser, server.url, { width, height })
    await hideChrome(page, { hud: !!args.hud })

    const gl = await glRenderer(page)
    const info = await pumpShot(page, shot, { frames, dt: DEFAULTS.dt })
    await page.screenshot({ path: out, type: 'png' })

    const report = { shot, out, width, height, frames, gl, ...info, errors }
    console.log(JSON.stringify(report, null, args.json ? 0 : 2))
    if (errors.length) process.exitCode = 1
  } finally {
    if (browser) await browser.close()
    await server.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
