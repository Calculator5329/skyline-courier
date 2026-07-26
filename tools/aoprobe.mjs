#!/usr/bin/env node
/**
 * How much is ambient occlusion actually contributing?
 *
 *   node tools/aoprobe.mjs [--theme void] [--shot midclimb] [--no-build]
 *
 * Ethan asked whether AO would have served the look better than the geometry
 * we kept adding. Before answering, measure what the term we ALREADY have is
 * worth — it may be near-invisible at its current settings, in which case it
 * is dead weight rather than a tool.
 *
 * A/B inside ONE page via `pipeline.aoIntensity`, because `docs/perf.md`
 * records that the shot harness is not deterministic across processes: an
 * unchanged build diffs at 4.13/255 on some shots. Same page, same frame,
 * only the uniform changes.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import { DEFAULTS, REPO, buildDist, hideChrome, launchBrowser, num, openGame,
         parseArgs, pumpShot, startStaticServer } from './harness.mjs'

const args = parseArgs(process.argv.slice(2))
const theme = args.theme && args.theme !== true ? String(args.theme) : 'void'
const shots = (args.shot && args.shot !== true ? String(args.shot) : 'midclimb,ascent').split(',')
const outDir = resolve(REPO, 'docs/captures/ao')
if (!args['no-build']) buildDist()
const server = await startStaticServer(resolve(REPO, 'dist'), num(args.port, 5251))
const browser = await launchBrowser()
try {
  const { page } = await openGame(browser, `${server.url}?theme=${theme}`, { width: 1600, height: 900 })
  await hideChrome(page, {})
  await mkdir(outDir, { recursive: true })
  const LEVELS = [['off', 0], ['ship', -1], ['x2', -2]]
  for (const shot of shots) {
    const stats = []
    for (const [name, v] of LEVELS) {
      const applied = await page.evaluate((val) => {
        const p = window.__game.pipeline
        if (p._aoBase === undefined) p._aoBase = p.aoIntensity
        p.aoIntensity = val === -1 ? p._aoBase : val === -2 ? p._aoBase * 2 : val
        return p.aoIntensity
      }, v)
      await pumpShot(page, shot, { frames: DEFAULTS.frames, dt: DEFAULTS.dt })
      const buf = await page.screenshot({ type: 'png' })
      await writeFile(resolve(outDir, `${shot}-${name}.png`), buf)
      const png = PNG.sync.read(buf)
      let sum = 0, n = 0, dark = 0
      for (let i = 0; i < png.data.length; i += 4) {
        const l = 0.2126 * png.data[i] + 0.7152 * png.data[i+1] + 0.0722 * png.data[i+2]
        sum += l; n++; if (l < 24) dark++
      }
      stats.push({ name, applied, mean: sum / n, darkPct: 100 * dark / n })
    }
    const base = stats.find((s) => s.name === 'ship')
    console.log(`\n${shot} (theme ${theme})`)
    for (const s of stats) {
      const d = s.mean - base.mean
      console.log(`  ${s.name.padEnd(5)} intensity ${String(s.applied).padStart(5)}  mean ${s.mean.toFixed(2).padStart(6)}` +
        `  Δ vs shipped ${(d >= 0 ? '+' : '') + d.toFixed(2)}  dark<24 ${s.darkPct.toFixed(2)}%`)
    }
  }
  console.log('\ncaptures in docs/captures/ao — LOOK at them; the numbers only say how much moved, not whether it helps')
} finally { await browser.close(); await server.close() }
