#!/usr/bin/env node
/**
 * WHAT IS THE AUTO-EXPOSURE ACTUALLY DOING? — a probe, not a gate.
 *
 * `docs/art-direction-void.md` §7.4 says to treat a drifting exposure as a bug,
 * and the shot set cannot see one: it pumps 90 frames and photographs the last,
 * so a meter that hunted for two seconds and a meter that snapped instantly
 * produce the same PNG. This reads the metered EV and the exposure multiplier
 * straight out of the 1x1 adaptation target at several points along the pump,
 * for every shot, so "it settled" is a measurement rather than a hope.
 *
 * A readPixels per sample stalls the pipeline for a frame. That is exactly why
 * the renderer never does this itself (see the block comment in
 * render/exposure.js) and exactly why this lives in tools/ and not in src/.
 *
 *   node tools/evprobe.mjs [--theme void] [--no-build] [--port 5210]
 */

import { SHOT_NAMES } from './shots.mjs'
import {
  DEFAULTS, REPO, buildDist, hideChrome, launchBrowser, num, openGame,
  parseArgs, startStaticServer,
} from './harness.mjs'
import { resolve } from 'node:path'

// The adaptation targets are HalfFloatType (render/index.js picks the type
// once for the whole chain), so the readback buffer has to be a Uint16Array of
// raw half-float bits and the decode has to happen here. Handing three a
// Float32Array against a half target reads zeros silently, which looks exactly
// like a meter stuck at EV 0 — a fun half hour.
const READ = `(() => {
  const g = window.__game
  const e = g.pipeline.exposure
  if (!e) return null
  const rt = e.adapt[e._flip]
  const buf = new Uint16Array(4)
  g.renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, buf)
  const half = (h) => {
    const s = (h & 0x8000) ? -1 : 1
    const ex = (h >> 10) & 0x1f
    const m = h & 0x3ff
    if (ex === 0) return s * m * Math.pow(2, -24)
    if (ex === 31) return m ? NaN : s * Infinity
    return s * (m + 1024) * Math.pow(2, ex - 25)
  }
  return { exposure: half(buf[0]), ev: half(buf[1]) }
})()`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const port = num(args.port, 5210)
  if (!args['no-build']) buildDist()

  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  const browser = await launchBrowser()
  try {
    const themeName = args.theme && args.theme !== true ? String(args.theme) : null
    const url = themeName ? `${server.url}?theme=${encodeURIComponent(themeName)}` : server.url
    const { page } = await openGame(browser, url, { width: 800, height: 450 })
    await hideChrome(page, {})

    // Widen the EV window from outside, to find out where the meter WANTS to
    // sit before deciding where to let it. A window is only defensible once you
    // know which side of it the scene is on: this theme's first window was
    // -1.5..+1.5 and every shot pinned against the floor, which is a fixed
    // exposure wearing an auto-exposure costume.
    if (args.minev || args.maxev) {
      await page.evaluate(({ lo, hi }) => {
        const u = window.__game.pipeline.exposure.adaptPass.uniforms.uLimits.value
        if (lo !== undefined) u.x = lo
        if (hi !== undefined) u.y = hi
      }, { lo: args.minev ? Number(args.minev) : undefined,
           hi: args.maxev ? Number(args.maxev) : undefined })
    }

    const names = args.only && args.only !== true
      ? String(args.only).split(',').map((s) => s.trim())
      : SHOT_NAMES

    console.log(`\nexposure probe — theme ${themeName || 'skyline'}`)
    console.log('shot        EV@10   EV@30   EV@90   exposure   drift(30->90)')
    console.log('---------   -----   -----   -----   --------   -------------')
    for (const name of names) {
      const samples = {}
      await page.evaluate((n) => { window.__SHOT__(n, true) }, name)
      for (const upTo of [10, 30, 90]) {
        const step = upTo - (samples._at || 0)
        await page.evaluate(({ n, s }) => {
          for (let i = 0; i < s; i++) { window.__SHOT__(n); window.__game.tick(1 / 60) }
        }, { n: name, s: step })
        samples._at = upTo
        samples[upTo] = await page.evaluate(READ)
      }
      const d = Math.abs(samples[90].ev - samples[30].ev)
      console.log([
        name.padEnd(9),
        samples[10].ev.toFixed(2).padStart(7),
        samples[30].ev.toFixed(2).padStart(7),
        samples[90].ev.toFixed(2).padStart(7),
        samples[90].exposure.toFixed(4).padStart(10),
        `${d.toFixed(3)}${d > 0.15 ? '  DRIFT' : ''}`.padStart(13),
      ].join('   '))
    }
    console.log('')
  } finally {
    await browser.close()
    await server.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
