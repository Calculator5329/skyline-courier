#!/usr/bin/env node
/**
 * Backface A/B — how much of the frame is a surface facing the wrong way?
 *
 *   node tools/backface.mjs [--no-build] [--shot terrace] [--json] [--out dir]
 *
 * The measurement behind BUG 1 ("the whole texture is like glass or
 * invisible"). For every shot it renders the frame three ways:
 *
 *   front   what ships — every `surface:*` material FrontSide
 *   double  the same frame with DoubleSide forced
 *   back    BackSide only, which draws EXACTLY the triangles the shipping
 *           frame throws away, and is therefore a picture of the bug
 *
 * `double` minus `front` is the acceptance number: with the winding fixed
 * there is nothing left for DoubleSide to recover, so it must be under 1%.
 * The `back` render is the diagnostic — it is where the culprit is legible.
 *
 * It also raycasts a grid of the pixels that changed and reports, per material
 * and per world region, which triangles are being culled, so the answer is
 * "the rim cornice at island 12", not "somewhere in the frame".
 *
 * Own port (5211): 5199 is capture.mjs, 5207 reachability.mjs, 5183 the dev
 * server. Sharing one silently measures somebody else's build.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PNG } from 'pngjs'
import {
  DEFAULTS, REPO, buildDist, hideChrome, launchBrowser, num, openGame, parseArgs,
  startStaticServer,
} from './harness.mjs'
import { SHOTS } from './shots.mjs'

const PORT = 5219
const args = parseArgs(process.argv.slice(2))
const asJson = !!args.json
const outDir = resolve(REPO, args.out || 'docs/captures/backface')
const width = num(args.width, DEFAULTS.width)
const height = num(args.height, DEFAULTS.height)
const frames = num(args.frames, 40)
const names = args.shot ? [String(args.shot)] : Object.keys(SHOTS)

/** Force one side mode on every `surface:*` mesh and redraw. */
const SET_SIDE = `(mode) => {
  const THREE = window.__game.THREE || null
  const SIDE = { front: 0, back: 1, double: 2 }   // THREE.FrontSide/BackSide/DoubleSide
  const seen = []
  window.__game.scene.traverse((o) => {
    if (!o.isMesh || !o.name || !o.name.startsWith('surface:')) return
    const m = o.material
    if (m.__origSide === undefined) m.__origSide = m.side
    m.side = mode === 'front' ? m.__origSide : SIDE[mode]
    // PIN THE SHADOW SIDE. three derives shadowSide from side (BackSide for a
    // FrontSide material, DoubleSide for a DoubleSide one), so an unpinned A/B
    // measures a different shadow map as well as a different set of visible
    // triangles — and the shadow difference is global, which is how you get a
    // "39% of the frame" number out of a change that recovers nothing.
    m.shadowSide = 1
    m.needsUpdate = true
    seen.push(o.name)
  })
  return seen
}`

async function shoot(page, name, mode) {
  await page.evaluate(({ n, frames }) => {
    window.__SHOT__(n, true)
    for (let i = 0; i < frames; i++) { window.__SHOT__(n); window.__game.tick(1 / 60) }
  }, { n: name, frames })
  return PNG.sync.read(await page.screenshot({ type: 'png' }))
}

/** Fraction of pixels that differ by more than `tol` on any channel. */
function diff(a, b, tol = 6) {
  let n = 0
  const mask = new Uint8Array(a.width * a.height)
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4
    const d = Math.max(
      Math.abs(a.data[o] - b.data[o]),
      Math.abs(a.data[o + 1] - b.data[o + 1]),
      Math.abs(a.data[o + 2] - b.data[o + 2]),
    )
    if (d > tol) { mask[i] = 1; n++ }
  }
  return { fraction: n / mask.length, mask }
}

/**
 * Where did it change? Raycast the centres of a coarse grid of changed cells
 * and report what the ray hit — material kind and world position, which is
 * enough to name the prefab in level.js.
 */
async function locate(page, name, mask, w, h, cells = 24) {
  const pts = []
  const cw = Math.ceil(w / cells), ch = Math.ceil(h / cells)
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      let hit = 0, sx = 0, sy = 0
      for (let y = gy * ch; y < Math.min(h, (gy + 1) * ch); y += 3) {
        for (let x = gx * cw; x < Math.min(w, (gx + 1) * cw); x += 3) {
          if (mask[y * w + x]) { hit++; sx += x; sy += y }
        }
      }
      if (hit > 8) pts.push([sx / hit / w * 2 - 1, -(sy / hit / h) * 2 + 1, hit])
    }
  }
  if (!pts.length) return []
  // Only the heaviest cells. Each ray is brute-forced against every surface
  // triangle in the world, which is honest but not free.
  const rays = pts.sort((a, b) => b[2] - a[2]).slice(0, 12)
  return page.evaluate(({ n, rays }) => {
    window.__SHOT__(n)
    const g = window.__game
    const cam = g.camera
    // three is not on the debug API, so the two classes we need come off
    // objects that already exist. `unproject` and `clone` are all this uses.
    const V3 = cam.position.constructor
    const meshes = []
    g.scene.traverse((o) => { if (o.isMesh && o.name && o.name.startsWith('surface:')) meshes.push(o) })

    const out = []
    for (const [px, py, weight] of rays) {
      const near = new V3(px, py, -1).unproject(cam)
      const dir = new V3(px, py, 1).unproject(cam).sub(near).normalize()
      const o = cam.position
      let best = null
      for (const m of meshes) {
        const pos = m.geometry.attributes.position.array
        const ix = m.geometry.index.array
        for (let i = 0; i < ix.length; i += 3) {
          const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3
          // Moller-Trumbore, two-sided on purpose: the triangles we are hunting
          // are precisely the ones a one-sided test would skip.
          const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2]
          const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2]
          const hx = dir.y * e2z - dir.z * e2y, hy = dir.z * e2x - dir.x * e2z, hz = dir.x * e2y - dir.y * e2x
          const det = e1x * hx + e1y * hy + e1z * hz
          if (det > -1e-9 && det < 1e-9) continue
          const inv = 1 / det
          const sx = o.x - pos[a], sy = o.y - pos[a + 1], sz = o.z - pos[a + 2]
          const u = (sx * hx + sy * hy + sz * hz) * inv
          if (u < 0 || u > 1) continue
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
          const v = (dir.x * qx + dir.y * qy + dir.z * qz) * inv
          if (v < 0 || u + v > 1) continue
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv
          if (t < 0.05 || (best && t >= best.t)) continue
          // Geometric normal from winding: det < 0 means the ray hit the BACK
          // of this triangle, i.e. FrontSide would have thrown it away.
          best = { t, kind: m.name.replace('surface:', ''), back: det < 0, tri: i / 3 }
        }
      }
      if (!best) { out.push({ weight, miss: true }); continue }
      out.push({
        weight,
        kind: best.kind,
        at: [+(o.x + dir.x * best.t).toFixed(1), +(o.y + dir.y * best.t).toFixed(1), +(o.z + dir.z * best.t).toFixed(1)],
        dist: +best.t.toFixed(1),
        facing: best.back ? -1 : 1,
        tri: best.tri,
      })
    }
    return out
  }, { n: name, rays })
}

/**
 * THE HONEST GEOMETRIC METRIC: what share of the frame has a BACK face as its
 * nearest surface?
 *
 * The DoubleSide pixel diff cannot answer that on its own. Turning a material
 * two-sided also changes the shadow map, feeds the contact/AO pass a set of
 * back faces it never had, and moves the exposure meter — all of which repaint
 * pixels whose nearest surface never changed at all. This casts a grid of view
 * rays through the real merged geometry and asks the only question that
 * matters: is the first thing this pixel sees a triangle whose front face
 * points away? That is "you can see through the world", with no renderer in
 * the loop to confound it.
 */
async function seeThrough(page, name, grid = 28) {
  return page.evaluate(({ n, grid }) => {
    window.__SHOT__(n)
    const g = window.__game
    const cam = g.camera
    const V3 = cam.position.constructor
    const meshes = []
    g.scene.traverse((o) => { if (o.isMesh && o.name && o.name.startsWith('surface:')) meshes.push(o) })
    const o = cam.position
    let hits = 0, back = 0, worst = null
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const px = ((gx + 0.5) / grid) * 2 - 1
        const py = ((gy + 0.5) / grid) * 2 - 1
        const near = new V3(px, py, -1).unproject(cam)
        const dir = new V3(px, py, 1).unproject(cam).sub(near).normalize()
        let best = null
        for (const m of meshes) {
          const pos = m.geometry.attributes.position.array
          const ix = m.geometry.index.array
          for (let i = 0; i < ix.length; i += 3) {
            const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3
            const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2]
            const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2]
            const hx = dir.y * e2z - dir.z * e2y, hy = dir.z * e2x - dir.x * e2z, hz = dir.x * e2y - dir.y * e2x
            const det = e1x * hx + e1y * hy + e1z * hz
            if (det > -1e-9 && det < 1e-9) continue
            const inv = 1 / det
            const sx = o.x - pos[a], sy = o.y - pos[a + 1], sz = o.z - pos[a + 2]
            const u = (sx * hx + sy * hy + sz * hz) * inv
            if (u < 0 || u > 1) continue
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x
            const v = (dir.x * qx + dir.y * qy + dir.z * qz) * inv
            if (v < 0 || u + v > 1) continue
            const t = (e2x * qx + e2y * qy + e2z * qz) * inv
            if (t < 0.05 || (best && t >= best.t)) continue
            best = { t, back: det < 0, kind: m.name.replace('surface:', '') }
          }
        }
        if (!best) continue
        hits++
        if (best.back) {
          back++
          if (!worst || best.t < worst.t) {
            worst = {
              t: best.t,
              kind: best.kind,
              at: [+(o.x + dir.x * best.t).toFixed(1), +(o.y + dir.y * best.t).toFixed(1), +(o.z + dir.z * best.t).toFixed(1)],
            }
          }
        }
      }
    }
    return { rays: hits, back, fraction: hits ? back / hits : 0, nearest: worst }
  }, { n: name, grid })
}

// ---------------------------------------------------------------------- run

if (!args['no-build']) buildDist()
const server = await startStaticServer(resolve(REPO, 'dist'), PORT)
const browser = await launchBrowser()

/**
 * A FRESH PAGE PER SHOT, and it is not paranoia.
 *
 * Measured: `tower` reports 3.2% on a fresh page and 37% when it runs seventh
 * in a sequence. Something in the pipeline carries history across a cut that
 * `__SHOT__(name, true)` does not clear, so a shot's number depends on which
 * shots preceded it — and a metric that depends on that cannot be used to
 * decide whether a fix worked.
 */
async function freshPage() {
  const g = await openGame(browser, `http://127.0.0.1:${PORT}/`, { width, height })
  await hideChrome(g.page)
  await g.page.evaluate(`window.__setSide = ${SET_SIDE}`)
  // FREEZE THE EXPOSURE METER. Auto-exposure reacts to the frame's own
  // content, so recovering (or not recovering) any surface shifts the tone of
  // every pixel and a whole-frame diff then reports tens of percent for a
  // change that recovered nothing.
  await g.page.evaluate(() => { window.__game.pipeline.exposure = null })
  return g
}
const report = []
const allErrors = []
await mkdir(outDir, { recursive: true })

for (const name of names) {
  const { context, page, errors } = await freshPage()
  allErrors.push(...errors)
  await page.evaluate('window.__setSide("front")')
  const front = await shoot(page, name, 'front')
  await page.evaluate('window.__setSide("double")')
  const dbl = await shoot(page, name, 'double')
  await page.evaluate('window.__setSide("back")')
  const back = await shoot(page, name, 'back')
  await page.evaluate('window.__setSide("front")')

  const d = diff(front, dbl)
  const where = await locate(page, name, d.mask, front.width, front.height)
  const top = where
    .filter((p) => !p.miss)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
  const st = await seeThrough(page, name)
  report.push({
    shot: name,
    doubleSideDelta: +(d.fraction * 100).toFixed(2),
    seeThrough: +(st.fraction * 100).toFixed(2),
    seeThroughRays: `${st.back}/${st.rays}`,
    nearestBackface: st.nearest,
    samples: top,
  })

  if (d.fraction > 0.002 || args.out) {
    await writeFile(resolve(outDir, `${name}-front.png`), PNG.sync.write(front))
    await writeFile(resolve(outDir, `${name}-double.png`), PNG.sync.write(dbl))
    await writeFile(resolve(outDir, `${name}-back.png`), PNG.sync.write(back))
  }
  await context.close()
}

await browser.close()
server.close()

if (allErrors.length) {
  console.error('page errors:\n  ' + allErrors.slice(0, 5).join('\n  '))
  process.exit(1)
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  for (const r of report) {
    console.log(`${r.shot.padEnd(12)} see-through ${String(r.seeThrough).padStart(6)}% (${r.seeThroughRays} rays)   DoubleSide repaints ${String(r.doubleSideDelta).padStart(6)}% of pixels`)
    if (r.nearestBackface) {
      console.log(`   nearest backface: ${r.nearestBackface.kind} at ${JSON.stringify(r.nearestBackface.at)} ${r.nearestBackface.t.toFixed(1)} m`)
    }
    for (const s of r.samples) {
      console.log(`   ${String(s.kind).padEnd(11)} at ${JSON.stringify(s.at).padEnd(22)} ${s.dist} m  facing ${s.facing}  tri ${s.tri}`)
    }
  }
  const worst = Math.max(...report.map((r) => r.seeThrough))
  console.log(`\nworst see-through: ${worst}%   ${worst < 1 ? 'PASS — no pixel\'s nearest surface faces away' : 'FAIL'}`)
  console.log(`captures in ${outDir}`)
}
process.exit(Math.max(...report.map((r) => r.seeThrough)) < 1 ? 0 : 1)
