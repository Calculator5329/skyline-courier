#!/usr/bin/env node
/**
 * Scene inventory: what is in the scene, how big is it, and can it be culled?
 *
 * Prints one row per drawable — triangles, world bounding-sphere radius, and
 * whether it casts shadow — because the interesting question for a merged
 * batch is not how many triangles it has but how large a volume those
 * triangles claim, which is what decides whether the frustum culler can ever
 * say no to it.
 *
 *   node tools/perfinv.mjs [--theme void] [--shot ascent] [--no-build]
 */

import { resolve } from 'node:path'
import {
  DEFAULTS, REPO, buildDist, hideChrome, launchBrowser, num, openGame,
  parseArgs, startStaticServer,
} from './harness.mjs'

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const port = num(args.port, 5321)
  const themeArg = args.theme && args.theme !== true ? String(args.theme) : null
  const shot = args.shot && args.shot !== true ? String(args.shot) : (themeArg === 'void' ? 'ascent' : 'terrace')

  if (!args['no-build']) buildDist()
  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  let browser = null
  let out = null
  try {
    browser = await launchBrowser()
    const url = themeArg ? `${server.url}?theme=${encodeURIComponent(themeArg)}` : server.url
    const { page } = await openGame(browser, url, { width: DEFAULTS.width, height: DEFAULTS.height })
    await hideChrome(page, { hud: false })
    out = await page.evaluate(inventory, { shot, dt: DEFAULTS.dt })
  } finally {
    if (browser) await browser.close()
    await server.close()
  }

  console.log(`\nscene inventory — ${themeArg || 'skyline'} @ ${shot}\n`)
  const head = ['object', 'tris', 'radius', 'centre', 'shadow', 'drawn']
  const body = out.objects.map((o) => [
    o.name, String(o.tris), String(o.radius),
    `${o.cx},${o.cy},${o.cz}`, o.castShadow ? 'yes' : '-', o.visibleInFrustum ? 'yes' : 'CULLED',
  ])
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ')
  console.log(line(head))
  console.log(w.map((n) => '-'.repeat(n)).join('  '))
  for (const b of body) console.log(line(b))
  console.log(`\ntotal tris ${out.total}   drawn ${out.drawn}   casters ${out.casterTris}`)
  console.log(`camera ${out.camera.x},${out.camera.y},${out.camera.z}  far ${out.far}\n`)
}

/* eslint-disable */
function inventory({ shot, dt }) {
  const g = window.__game
  window.__SHOT__(shot, true)
  for (let i = 0; i < 40; i++) { window.__SHOT__(shot); g.tick(dt) }

  const THREE = g.pipeline.constructor.THREE || null
  const cam = g.camera
  cam.updateMatrixWorld()
  const projScreen = new (cam.projectionMatrix.constructor)()
  projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  const frustum = new (g.scene.constructor.prototype.constructor === Object ? Object : Object)()

  const objects = []
  let total = 0, drawn = 0, casterTris = 0
  g.scene.updateMatrixWorld(true)
  g.scene.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh || o.isPoints || o.isLine)) return
    const geo = o.geometry
    if (!geo) return
    if (!geo.boundingSphere) geo.computeBoundingSphere()
    const n = geo.index ? geo.index.count : (geo.attributes.position ? geo.attributes.position.count : 0)
    const inst = o.isInstancedMesh ? o.count : 1
    const tris = Math.round((n / 3) * inst)
    const bs = geo.boundingSphere
    // World-space radius: three does exactly this in Frustum.intersectsObject.
    const sc = o.matrixWorld.getMaxScaleOnAxis()
    const c = bs.center.clone().applyMatrix4(o.matrixWorld)
    const r = bs.radius * sc
    total += tris
    if (o.visible) drawn += tris
    if (o.castShadow) casterTris += tris
    objects.push({
      name: o.name || o.type, tris,
      radius: Math.round(r), cx: Math.round(c.x), cy: Math.round(c.y), cz: Math.round(c.z),
      castShadow: !!o.castShadow, visibleInFrustum: o.visible && o.frustumCulled !== false,
    })
  })
  objects.sort((a, b) => b.tris - a.tris)
  return {
    objects, total, drawn, casterTris, far: cam.far,
    camera: { x: Math.round(cam.position.x), y: Math.round(cam.position.y), z: Math.round(cam.position.z) },
  }
}
/* eslint-enable */

main().catch((e) => { console.error(e); process.exit(1) })
