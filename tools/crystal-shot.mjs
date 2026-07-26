#!/usr/bin/env node
/**
 * Scratch shot harness for the crystal lane.
 *
 *   node tools/crystal-shot.mjs [--out docs/captures/crystals] [--frames 90]
 *     [--width 1600] [--height 900] [--views hero,under,far]
 *
 * WHY THIS EXISTS AND WHY IT IS SEPARATE FROM `shotset.mjs`. `shotset.mjs`
 * photographs the course, and the crystals are not in the course yet — placing
 * them is a different lane and `src/level.js` is off limits in this one. So
 * this renders `tools/crystal-preview.html` instead, through the REAL
 * `RenderPipeline` and the REAL void theme, and runs the same analysis
 * `shotset.mjs` runs so the numbers are comparable with
 * `docs/art-direction-void.md` §2.
 *
 * It serves the page with vite's own dev server (bare `three` imports have to
 * be resolved by something) rather than the static server in `harness.mjs`,
 * which is the only structural difference from the shipped harness.
 *
 * Delete-safe: nothing in the game imports it, and `vite build` only reads
 * `index.html`, so neither this nor the preview page reaches `dist/`.
 */

import { mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { analyzeFile } from './analyze.mjs'
import { REPO, launchBrowser, num, parseArgs } from './harness.mjs'

/**
 * The scratch views. Each is a camera pose on the preview page, chosen to
 * answer one question about the shards rather than to be pretty:
 *   hero  — do hero clusters read as architecture, silhouetted against glow?
 *   close — are the facets flat, and does each one hold its own value?
 *   under — do scatter clusters work hanging off a lip, tilted past horizontal?
 *   far   — does aerial perspective wash the distant LOD bands into the fog?
 *
 * `--ev` is not a cheat. Auto-exposure meters the whole frame, and this scratch
 * scene is mostly empty sky where the real void course is mostly rock, so the
 * meter sits about a stop and a half hot here. `--ev -1.4` puts the frame in
 * the range art-direction-void.md §2 specifies, which is the only condition
 * under which a judgement about the crystals means anything.
 */
const VIEWS = {
  hero: { cx: 0, cy: 1.5, cz: 14, lx: 0, ly: 5.5, lz: -10 },
  close: { cx: -4.2, cy: 2.4, cz: 3.6, lx: -6.6, ly: 7.5, lz: -1.6 },
  under: { cx: -15.0, cy: -6.0, cz: 5.0, lx: -8.7, ly: -1.4, lz: -3.0 },
  far: { cx: 4, cy: 3.0, cz: 22, lx: -6, ly: 8.0, lz: -34 },
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = resolve(REPO, args.out || 'docs/captures/crystals')
  const width = num(args.width, 1600)
  const height = num(args.height, 900)
  const frames = num(args.frames, 90)
  const names = args.views && args.views !== true
    ? String(args.views).split(',').map((s) => s.trim()).filter(Boolean)
    : Object.keys(VIEWS)

  await mkdir(outDir, { recursive: true })

  const server = await createServer({ root: REPO, server: { port: 5187, strictPort: true } })
  await server.listen()
  const base = `http://127.0.0.1:5187/tools/crystal-preview.html`

  const browser = await launchBrowser()
  const results = []
  try {
    for (const name of names) {
      const v = VIEWS[name]
      if (!v) throw new Error(`unknown view ${name}`)
      const page = await browser.newPage({ viewport: { width, height } })
      const errors = []
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
      page.on('pageerror', (e) => errors.push(String(e)))

      const qs = new URLSearchParams({
        w: String(width), h: String(height), frames: String(frames),
        ev: String(num(args.ev, 0)), intensity: String(num(args.intensity, 3.2)),
        ...Object.fromEntries(Object.entries(v).map(([k, n]) => [k, String(n)])),
      })
      await page.goto(`${base}?${qs}`, { waitUntil: 'load' })
      await page.waitForFunction('window.__ready === true', null, { timeout: 30000 })
      const stats = await page.evaluate('window.__stats()')

      const file = join(outDir, `${name}.png`)
      await page.screenshot({ path: file, type: 'png' })
      const bytes = (await stat(file)).size
      const image = analyzeFile(file)
      results.push({ view: name, file, bytes, image, stats, errors })
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }

  // Same columns as art-direction-void.md §2, so a scratch shot can be read
  // against the acceptance table without a translation step.
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('view', 8), pad('lum', 7), pad('p1', 5), pad('p50', 6), pad('p99', 6),
    pad('spread', 7), pad('clipLo', 8), pad('clipHi', 8), pad('sat', 6), 'errors')
  for (const r of results) {
    const i = r.image
    const p = i.percentiles
    console.log(pad(r.view, 8), pad(i.luminance, 7), pad(p.p1, 5), pad(p.p50, 6), pad(p.p99, 6),
      pad(p.p99 - p.p1, 7), pad(i.clipped.lowPct, 8), pad(i.clipped.highPct, 8),
      pad(i.saturation, 6), r.errors.length ? r.errors[0].slice(0, 60) : '-')
  }
  const f = results[0] && results[0].stats && results[0].stats.field
  if (f) {
    console.log(`\ncrystal field: ${f.drawCalls} draw calls, ${f.instances} instances, ${f.triangles} triangles`)
    for (const b of f.buckets) console.log(`  ${pad(b.key, 22)} ${pad(b.instances, 5)} x ${b.trianglesPerInstance} tris`)
  }
  const bad = results.filter((r) => r.errors.length || r.bytes < 1024 || r.image.uniform)
  if (bad.length) {
    console.error('\nFAILED:', bad.map((b) => b.view).join(', '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
