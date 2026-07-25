#!/usr/bin/env node
// Hue histogram + point samples. usage: node hue.mjs <png> [x,y ...]
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

function hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d > 1e-6) {
    if (mx === r) h = 60 * (((g - b) / d) % 6)
    else if (mx === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  return [h, mx === 0 ? 0 : d / mx, mx]
}

const file = process.argv[2]
const png = PNG.sync.read(readFileSync(file))
const { width, height, data } = png
const bins = new Array(18).fill(0)
let counted = 0
for (let i = 0; i < width * height; i++) {
  const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
  const [h, s] = hsv(r, g, b)
  if (s < 0.06) continue // achromatic pixels carry no hue
  bins[Math.floor(h / 20) % 18]++
  counted++
}
console.log(file)
const top = bins.map((v, i) => [i * 20, (100 * v) / counted]).sort((a, b) => b[1] - a[1])
console.log('  top hue bins: ' + top.slice(0, 5).map(([d, p]) => `${d}-${d + 20}deg ${p.toFixed(1)}%`).join('  '))
const green = bins.slice(4, 8).reduce((a, b) => a + b, 0) // 80-160
console.log(`  green 80-160deg: ${((100 * green) / counted).toFixed(1)}%   chromatic pixels ${((100 * counted) / (width * height)).toFixed(1)}%`)
for (const arg of process.argv.slice(3)) {
  const [x, y] = arg.split(',').map(Number)
  const i = (y * width + x) * 4
  const [h, s, v] = hsv(data[i], data[i + 1], data[i + 2])
  console.log(`  (${x},${y}) rgb(${data[i]},${data[i + 1]},${data[i + 2]})  hue ${h.toFixed(0)} sat ${s.toFixed(2)} val ${v.toFixed(2)}`)
}
