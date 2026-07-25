#!/usr/bin/env node
/**
 * Numeric description of a captured frame — pngjs only, no browser.
 *
 * The point of this file is to make the look arguable with measurements
 * instead of adjectives. "Too grey" is a matter of opinion; a mean saturation
 * of 0.11 is not. It also catches the harness's own failure mode: a shot that
 * is looking at empty sky, or is stuck inside a wall, has nine near-identical
 * regions, which `uniform` flags without anyone having to open the PNG.
 *
 *   node tools/analyze.mjs <file.png> [--json]
 */

import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

/** Rec.709 luma on gamma-encoded values: this is a perceptual description of
 *  the delivered image, not a physical one, so no linearisation. */
function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function pct(sorted, p) {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[i]
}

export function analyzeBuffer(buf) {
  const png = PNG.sync.read(buf)
  const { width, height, data } = png

  let sr = 0, sg = 0, sb = 0, sl = 0, ssat = 0
  let clipHigh = 0, clipLow = 0
  const lums = new Float64Array(width * height)

  // 3x3 region accumulators, row-major (top-left first).
  const reg = Array.from({ length: 9 }, () => ({ r: 0, g: 0, b: 0, l: 0, n: 0 }))

  for (let y = 0; y < height; y++) {
    const ry = Math.min(2, Math.floor((y * 3) / height))
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const l = luma(r, g, b)
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
      const sat = mx === 0 ? 0 : (mx - mn) / mx

      sr += r; sg += g; sb += b; sl += l; ssat += sat
      // Clipping thresholds are deliberately not 255/0: an HDR pipeline that
      // is only *nearly* clipping has already lost the highlight detail.
      if (mx >= 250) clipHigh++
      if (mx <= 5) clipLow++
      lums[y * width + x] = l

      const k = ry * 3 + Math.min(2, Math.floor((x * 3) / width))
      const R = reg[k]
      R.r += r; R.g += g; R.b += b; R.l += l; R.n++
    }
  }

  const n = width * height
  const sorted = Float64Array.from(lums).sort()

  const regions = reg.map((R, i) => ({
    cell: ['TL', 'TC', 'TR', 'ML', 'MC', 'MR', 'BL', 'BC', 'BR'][i],
    r: +(R.r / R.n).toFixed(1),
    g: +(R.g / R.n).toFixed(1),
    b: +(R.b / R.n).toFixed(1),
    lum: +(R.l / R.n).toFixed(1),
  }))

  const regionLums = regions.map((r) => r.lum)
  const regionSpread = Math.max(...regionLums) - Math.min(...regionLums)
  const p1 = pct(sorted, 1), p50 = pct(sorted, 50), p99 = pct(sorted, 99)

  // "Uniform" = nothing in the frame varies enough to be geometry. Both tests
  // have to fail: a legitimately flat-lit shot still has tonal range, and a
  // shot of a busy wall still has region-to-region variation.
  const uniform = regionSpread < 6 && (p99 - p1) < 24

  return {
    width,
    height,
    mean: { r: +(sr / n).toFixed(1), g: +(sg / n).toFixed(1), b: +(sb / n).toFixed(1) },
    luminance: +(sl / n).toFixed(1),
    saturation: +(ssat / n).toFixed(3),
    percentiles: { p1: +p1.toFixed(1), p50: +p50.toFixed(1), p99: +p99.toFixed(1) },
    clipped: {
      highPct: +((100 * clipHigh) / n).toFixed(2),
      lowPct: +((100 * clipLow) / n).toFixed(2),
    },
    regionSpread: +regionSpread.toFixed(1),
    dynamicRange: +(p99 - p1).toFixed(1),
    uniform,
    regions,
  }
}

export function analyzeFile(path) {
  return analyzeBuffer(readFileSync(path))
}

function main() {
  const args = process.argv.slice(2)
  const file = args.find((a) => !a.startsWith('--'))
  if (!file) {
    console.error('usage: node tools/analyze.mjs <file.png> [--json]')
    process.exit(2)
  }
  const a = analyzeFile(file)
  if (args.includes('--json')) {
    console.log(JSON.stringify(a, null, 2))
    return
  }
  console.log(`${file}  ${a.width}x${a.height}`)
  console.log(`  mean RGB      ${a.mean.r} ${a.mean.g} ${a.mean.b}`)
  console.log(`  luminance     ${a.luminance}   saturation ${a.saturation}`)
  console.log(`  percentiles   p1 ${a.percentiles.p1}  p50 ${a.percentiles.p50}  p99 ${a.percentiles.p99}`)
  console.log(`  clipped       high ${a.clipped.highPct}%  low ${a.clipped.lowPct}%`)
  console.log(`  regionSpread  ${a.regionSpread}   dynamicRange ${a.dynamicRange}   uniform ${a.uniform}`)
  for (let i = 0; i < 3; i++) {
    console.log('  ' + a.regions.slice(i * 3, i * 3 + 3)
      .map((r) => `${r.cell} ${String(r.lum).padStart(5)}`).join('   '))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
