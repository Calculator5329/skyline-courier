#!/usr/bin/env node
/**
 * Floor coverage audit — is there DRAWN geometry above every surface the
 * player can stand on?
 *
 *   node tools/coverage.mjs [--no-build] [--cell 0.5] [--max-area 1.0] [--json]
 *     [--limit 25] [--out docs/captures/coverage.json]
 *
 * WHY THIS EXISTS
 *
 * Three separate bugs in one session all had the same shape: a collider the
 * player stands on, with no visible surface above it. Ethan, playing: "between
 * the main path and the guardrail on the side it's completely transparent",
 * and "I can SEE UP THROUGH the platforms". In the worst case (`a710168`,
 * `discOutline` applying squash twice) the terrace was a 10.4 m deck drawn
 * 3.6 m wide — 48% of it walkable and invisible.
 *
 * None of the existing tools could catch it:
 *   - `winding.mjs` PASSED: the triangles that existed were wound correctly.
 *   - `backface.mjs` PASSED after the first fix: nothing was facing away.
 *     Geometry that is ABSENT is not geometry that is backfacing, and that
 *     distinction cost three rounds of misdiagnosis.
 *   - `shotset.mjs` renders honest frames, but a human then has to notice that
 *     sky in a particular 200 px region is wrong. Twice I looked straight at
 *     it and talked myself out of it, because sky over a deck EDGE is correct.
 *
 * So this asserts the invariant directly and numerically, with no frame and no
 * judgement in the loop: sample every exposed collider top face on a grid, and
 * require a drawn, upward-facing triangle within a short distance above it.
 *
 * "Exposed" matters — a box buried under another box is structure, not floor,
 * and nobody ever sees it. Only faces with open sky above them are checked.
 *
 * Own port (5223): 5199 capture, 5207 reachability, 5219 backface, 5183 dev.
 * Sharing one silently measures somebody else's build.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  REPO, buildDist, launchBrowser, num, openGame, parseArgs, startStaticServer,
} from './harness.mjs'

const PORT = 5223
const args = parseArgs(process.argv.slice(2))
const CELL = num(args.cell, 0.5)
// A deck that is 1 m2 short is a bug you can fall through; 1 m2 of slack over
// the whole 4881-box world is measurement noise at the grid resolution.
const MAX_AREA = num(args['max-area'], 1.0)
const LIMIT = num(args.limit, 25)

async function main() {
  if (!args['no-build']) buildDist()
  const server = await startStaticServer(resolve(REPO, 'dist'), PORT)
  let browser = null
  try {
    browser = await launchBrowser()
    const { page } = await openGame(browser, server.url, { width: 640, height: 360 })
    const result = await page.evaluate(audit, { CELL })

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      report(result)
    }
    if (args.out) {
      const out = resolve(REPO, args.out)
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, JSON.stringify(result, null, 2))
    }
    process.exitCode = result.uncoveredArea > MAX_AREA ? 1 : 0
  } finally {
    if (browser) await browser.close()
    await server.close()
  }
}

function report(r) {
  console.log(`floor coverage — ${r.cells.toLocaleString()} sampled cells over ${r.boxes.toLocaleString()} colliders`)
  console.log(`  covered      ${r.covered.toLocaleString()} / ${r.cells.toLocaleString()} = ${(100 * r.covered / Math.max(1, r.cells)).toFixed(2)}%`)
  console.log(`  uncovered    ${r.uncoveredArea.toFixed(2)} m2 of standable surface with nothing drawn above it`)
  if (r.worst.length) {
    console.log('')
    console.log('worst offenders (by uncovered area)')
    console.log('  m2     tag          top y    extent (x, z)                    centre')
    for (const w of r.worst.slice(0, LIMIT)) {
      const ext = `${w.sx.toFixed(1)} x ${w.sz.toFixed(1)}`
      console.log(`  ${w.area.toFixed(2).padStart(6)} ${w.tag.padEnd(12)} ${w.y.toFixed(2).padStart(7)}  ${ext.padEnd(32)} ${w.cx.toFixed(1)},${w.cz.toFixed(1)}`)
    }
  }
  console.log('')
  console.log(r.uncoveredArea > MAX_AREA
    ? `FAIL — ${r.uncoveredArea.toFixed(2)} m2 uncovered exceeds the ${MAX_AREA} m2 budget`
    : 'PASS — every exposed collider top face has drawn geometry above it')
}

/**
 * Runs INSIDE the page. Self-contained by necessity — nothing from module
 * scope crosses into `page.evaluate`.
 */
function audit({ CELL }) {
  const g = window.__game
  const boxes = g.level.collision.boxes

  // ---- spatial hash of upward-facing drawn triangles, bucketed on XZ -------
  const GRID = 4
  const key = (i, j) => i * 100000 + j
  const tbuckets = new Map()
  let triCount = 0
  g.scene.traverse((o) => {
    if (!o.isMesh || !o.name || !o.name.startsWith('surface:')) return
    o.updateWorldMatrix(true, false)
    const pos = o.geometry.attributes.position, idx = o.geometry.index
    const m = o.matrixWorld.elements
    const n = idx ? idx.count : pos.count
    const P = (i) => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
      return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      ]
    }
    for (let t = 0; t < n; t += 3) {
      const a = P(idx ? idx.getX(t) : t)
      const b = P(idx ? idx.getX(t + 1) : t + 1)
      const c = P(idx ? idx.getX(t + 2) : t + 2)
      // Upward-facing only. A wall cannot be the floor you are standing on,
      // and including walls would let a parapet vouch for the deck beside it.
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const len = Math.hypot(nx, ny, nz) || 1e-9
      if (Math.abs(ny) / len < 0.30) continue
      triCount++
      const mnx = Math.min(a[0], b[0], c[0]), mxx = Math.max(a[0], b[0], c[0])
      const mnz = Math.min(a[2], b[2], c[2]), mxz = Math.max(a[2], b[2], c[2])
      const tri = [a, b, c, mnx, mxx, mnz, mxz]
      for (let i = Math.floor(mnx / GRID); i <= Math.floor(mxx / GRID); i++) {
        for (let j = Math.floor(mnz / GRID); j <= Math.floor(mxz / GRID); j++) {
          const k = key(i, j)
          let arr = tbuckets.get(k)
          if (!arr) tbuckets.set(k, arr = [])
          arr.push(tri)
        }
      }
    }
  })

  // ---- spatial hash of colliders, for the "is this face exposed" test -----
  const bbuckets = new Map()
  for (const bx of boxes) {
    for (let i = Math.floor(bx.min.x / GRID); i <= Math.floor(bx.max.x / GRID); i++) {
      for (let j = Math.floor(bx.min.z / GRID); j <= Math.floor(bx.max.z / GRID); j++) {
        const k = key(i, j)
        let arr = bbuckets.get(k)
        if (!arr) bbuckets.set(k, arr = [])
        arr.push(bx)
      }
    }
  }

  const inTri = (px, pz, a, b, c) => {
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
    if (Math.abs(d) < 1e-12) return false
    const l1 = ((b[2] - c[2]) * (px - c[0]) + (c[0] - b[0]) * (pz - c[2])) / d
    const l2 = ((c[2] - a[2]) * (px - c[0]) + (a[0] - c[0]) * (pz - c[2])) / d
    const l3 = 1 - l1 - l2
    return l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6
  }

  let cells = 0, covered = 0
  const worst = []
  const cellArea = CELL * CELL

  for (const bx of boxes) {
    const y = bx.max.y
    const sx = bx.max.x - bx.min.x, sz = bx.max.z - bx.min.z
    if (sx < CELL || sz < CELL) continue          // too thin to sample honestly
    let miss = 0, mine = 0
    for (let px = bx.min.x + CELL / 2; px < bx.max.x; px += CELL) {
      for (let pz = bx.min.z + CELL / 2; pz < bx.max.z; pz += CELL) {
        // Exposed? Anything solid sitting above this point makes it structure,
        // not floor — nobody stands there and nobody ever sees it.
        const bs = bbuckets.get(key(Math.floor(px / GRID), Math.floor(pz / GRID))) || []
        let buried = false
        for (const o of bs) {
          if (o === bx) continue
          if (px < o.min.x || px > o.max.x || pz < o.min.z || pz > o.max.z) continue
          if (o.max.y > y + 0.05) { buried = true; break }
        }
        if (buried) continue

        mine++
        cells++
        const ts = tbuckets.get(key(Math.floor(px / GRID), Math.floor(pz / GRID))) || []
        let hit = false
        for (const T of ts) {
          if (px < T[3] || px > T[4] || pz < T[5] || pz > T[6]) continue
          if (!inTri(px, pz, T[0], T[1], T[2])) continue
          // The drawn surface has to be AT this face, not a roof 8 m overhead.
          // Generous below (turf dips, mouldings sit under the walking plane)
          // and tight above (anything higher is a different storey).
          const ty = (T[0][1] + T[1][1] + T[2][1]) / 3
          if (ty < y - 0.60 || ty > y + 0.30) continue
          hit = true
          break
        }
        if (hit) covered++
        else miss++
      }
    }
    if (miss > 0) {
      worst.push({
        area: miss * cellArea, cells: mine, missing: miss, tag: bx.tag || '?',
        y, sx, sz, cx: (bx.min.x + bx.max.x) / 2, cz: (bx.min.z + bx.max.z) / 2,
      })
    }
  }
  worst.sort((a, b) => b.area - a.area)
  return {
    boxes: boxes.length, triangles: triCount, cell: CELL,
    cells, covered, uncoveredArea: (cells - covered) * cellArea,
    worst: worst.slice(0, 200),
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
