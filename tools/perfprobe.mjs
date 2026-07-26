#!/usr/bin/env node
/**
 * Ablation probe: WHERE does the frame time go?
 *
 * A frame-time number on its own tells you nothing about what to fix. This
 * turns one thing off at a time and re-measures, so the answer is a
 * decomposition rather than a guess:
 *
 *   base        everything on
 *   noshadow    every mesh castShadow=false — the shadow pass draws nothing
 *   nolevel     the merged surface meshes hidden — geometry submission cost
 *   nobackdrop  the far ruin bands hidden
 *   nopost      composite straight from the scene target, bloom/contact off
 *   halfres     same scene at quarter the pixels — separates fill from geometry
 *   chalf       contact buffer at half scale, everything else identical
 *   clite       chalf plus the Lite tap counts (10 march / 6 AO / 4 near)
 *
 * Every measurement is a GPU-synced loop (readPixels after each tick), because
 * an unsynced loop measures the CPU queueing work and nothing else.
 *
 *   node tools/perfprobe.mjs [--theme void] [--only ascent] [--no-build]
 *     [--modes base,chalf]     measure a subset — see pickModes
 */

import { resolve } from 'node:path'
import { SHOTS, SHOT_NAMES, VOID_SHOTS, VOID_SHOT_NAMES } from './shots.mjs'
import {
  DEFAULTS, REPO, buildDist, glRenderer, hideChrome, launchBrowser, num,
  openGame, parseArgs, startStaticServer,
} from './harness.mjs'

const MODES = [
  'base',
  'noshadow',    // no shadow pass geometry
  'nolevel',     // the merged surface meshes hidden
  'nobackdrop',  // the far ruin bands hidden
  'nopost',      // bloom off
  'halfres',     // quarter the pixels — the fill/geometry discriminator
  // INCONCLUSIVE — see docs/perf.md. It reads slower than the real material
  // almost everywhere because the stripped clone is a second program and the
  // frame ends up rendering both. Kept so nobody rebuilds it.
  'basicmat',
  'nocontact',   // the depth/normal prepass + contact-shadow march
  // The two candidates the Lite Mode work is deciding between. Both KEEP the
  // pass — see src/render/quality.js on why turning it off is a restyle rather
  // than a setting.
  'chalf',       // contact buffer at half scale, same 14/8/5 steps and taps
  'clite',       // half scale AND the Lite tap counts, 10/6/4
  // Diagnostic, not a candidate: where inside the contact pass the time sits.
  // The bilateral is what makes the jittered march resolvable, so shipping
  // without it is not an option — this only says how much of the pass is the
  // march and how much is the two full-screen blur passes after it.
  'noblur',
]

/**
 * `--modes base,chalf` measures a SUBSET.
 *
 * Not a convenience: every mode in a run is interleaved with every other one
 * and the whole set is repeated four times, so an eight-mode run to answer a
 * two-mode question spends three quarters of its wall clock adding drift to
 * the two arms that matter. A tight subset is the more trustworthy A/B, not
 * just the faster one.
 */
function pickModes(arg) {
  if (!arg || arg === true) return MODES
  const want = String(arg).split(',').map((s) => s.trim()).filter(Boolean)
  const bad = want.filter((m) => !MODES.includes(m))
  if (bad.length) {
    console.error(`unknown modes: ${bad.join(', ')}\nknown: ${MODES.join(', ')}`)
    process.exit(2)
  }
  // `base` is what everything is quoted against; a run without it is a table of
  // absolute numbers from a box whose absolutes move 4x between runs.
  return want.includes('base') ? want : ['base', ...want]
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const port = num(args.port, 5311)
  const width = num(args.width, DEFAULTS.width)
  const height = num(args.height, DEFAULTS.height)
  const themeArg = args.theme && args.theme !== true ? String(args.theme) : null
  const table = themeArg === 'void' ? VOID_SHOTS : SHOTS
  const allNames = themeArg === 'void' ? VOID_SHOT_NAMES : SHOT_NAMES
  const names = args.only && args.only !== true
    ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean)
    : allNames
  const modes = pickModes(args.modes)

  if (!args['no-build']) buildDist()
  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  let browser = null
  const rows = []
  let gl = null
  try {
    browser = await launchBrowser()
    const url = themeArg ? `${server.url}?theme=${encodeURIComponent(themeArg)}` : server.url
    const { page } = await openGame(browser, url, { width, height })
    await hideChrome(page, { hud: false })
    gl = await glRenderer(page)
    for (const name of names) {
      const r = await page.evaluate(probe, { name, modes, dt: DEFAULTS.dt })
      rows.push({ shot: name, ...r })
    }
  } finally {
    if (browser) await browser.close()
    await server.close()
  }

  console.log(`\nablation probe — ${themeArg || 'skyline'}   ${width}x${height}`)
  console.log(`GL: ${gl ? gl.renderer : 'unknown'}\n`)
  const head = ['shot', ...modes.map((m) => `${m} ms`), 'draws', 'tris', 'shadowTris']
  const body = rows.map((r) => [
    r.shot, ...modes.map((m) => String(r.ms[m])),
    String(r.draws), String(r.tris), String(r.shadowTris),
  ])
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (c) => c.map((x, i) => x.padEnd(w[i])).join('  ')
  console.log(line(head))
  console.log(w.map((n) => '-'.repeat(n)).join('  '))
  for (const b of body) console.log(line(b))
  console.log('')
  if (args.json) console.log(JSON.stringify(rows, null, 2))
}

/* eslint-disable */
function probe({ name, modes, dt }) {
  const g = window.__game
  const renderer = g.renderer
  const gl = renderer.getContext()
  const px = new Uint8Array(4)

  const surfaces = []
  const backdrop = []
  const casters = []
  g.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isPoints && !o.isLine) return
    if (typeof o.name === 'string' && o.name.startsWith('surface:')) surfaces.push(o)
    if (typeof o.name === 'string' && o.name.startsWith('void-backdrop')) backdrop.push(o)
    if (o.castShadow) casters.push(o)
  })

  const measure = (frames) => {
    for (let i = 0; i < 30; i++) { window.__SHOT__(name); g.tick(dt) }
    const t = performance.now()
    for (let i = 0; i < frames; i++) {
      window.__SHOT__(name); g.tick(dt)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    }
    return Math.round(((performance.now() - t) / frames) * 1000) / 1000
  }

  window.__SHOT__(name, true)
  const FR = 40
  const REPS = 4
  const samples = {}
  for (const m of modes) samples[m] = []

  // A plain-PBR stand-in for every surface material: the same lighting model,
  // but no albedo/normal/ORM samplers and none of the custom GLSL that
  // materials/shader.js grafts on. If swapping this in collapses the frame,
  // the cost is the SHADER running per fragment; if it does not, the cost is
  // the number of fragments or the geometry. Those have completely different
  // fixes, so guessing between them is not an option.
  const plainCache = new Map()
  const plainFor = (mat) => {
    let p = plainCache.get(mat)
    if (p) return p
    p = mat.clone()
    p.map = null; p.normalMap = null; p.roughnessMap = null; p.metalnessMap = null
    p.onBeforeCompile = () => {}
    p.customProgramCacheKey = () => 'perfprobe-plain'
    p.defines = {}
    p.needsUpdate = true
    plainCache.set(mat, p)
    return p
  }

  const setup = (mode) => {
    if (mode === 'basicmat') {
      for (const o of surfaces) {
        if (!o.userData._realMat) o.userData._realMat = o.material
        o.material = plainFor(o.userData._realMat)
      }
    }
    if (mode === 'nocontact') g.pipeline.contactShadows = false
    // The contact pass owns its own scale and tap counts, so these two set the
    // pass directly rather than going through g.setQuality — which would also
    // move the pixel ratio and confound the two things being separated.
    if (mode === 'noblur' && g.pipeline.contact) {
      const c = g.pipeline.contact
      if (!c._realBlur) c._realBlur = c.blur.render.bind(c.blur)
      c.blur.render = () => {}
    }
    if (mode === 'chalf' && g.pipeline.contact) g.pipeline.contact.scale = 0.5
    if (mode === 'clite' && g.pipeline.contact) {
      g.pipeline.contact.scale = 0.5
      g.pipeline.contact.setTaps({ steps: 10, ao: 6, aoNear: 4 })
    }
    if (mode === 'noshadow') for (const o of casters) o.castShadow = false
    if (mode === 'nolevel') for (const o of surfaces) o.visible = false
    if (mode === 'nobackdrop') for (const o of backdrop) o.visible = false
    if (mode === 'nopost') {
      if (g.pipeline.setContactEnabled) g.pipeline.setContactEnabled(false)
      if (g.pipeline.bloom) { g.pipeline._bloomStrength = g.pipeline.bloom.strength; g.pipeline.bloom.strength = 0 }
    }
    if (mode === 'halfres') {
      renderer.setPixelRatio(0.5)
      g.pipeline.setSize(renderer.domElement.width, renderer.domElement.height)
    }
  }
  const teardown = (mode) => {
    if (mode === 'basicmat') for (const o of surfaces) o.material = o.userData._realMat
    if (mode === 'nocontact') g.pipeline.contactShadows = true
    if (mode === 'noblur' && g.pipeline.contact && g.pipeline.contact._realBlur) {
      g.pipeline.contact.blur.render = g.pipeline.contact._realBlur
    }
    if (mode === 'chalf' && g.pipeline.contact) g.pipeline.contact.scale = 1
    if (mode === 'clite' && g.pipeline.contact) {
      g.pipeline.contact.scale = 1
      g.pipeline.contact.setTaps({ steps: 14, ao: 8, aoNear: 5 })
    }
    if (mode === 'noshadow') for (const o of casters) o.castShadow = true
    if (mode === 'nolevel') for (const o of surfaces) o.visible = true
    if (mode === 'nobackdrop') for (const o of backdrop) o.visible = true
    if (mode === 'nopost') {
      if (g.pipeline.setContactEnabled) g.pipeline.setContactEnabled(true)
      if (g.pipeline.bloom && g.pipeline._bloomStrength !== undefined) {
        g.pipeline.bloom.strength = g.pipeline._bloomStrength
      }
    }
    if (mode === 'halfres') {
      renderer.setPixelRatio(1)
      g.pipeline.setSize(renderer.domElement.width, renderer.domElement.height)
    }
  }

  // ROUND-ROBIN, not mode-at-a-time. Measuring all of mode A then all of mode
  // B attributes any thermal or driver drift over the run to the difference
  // between the modes, which is how the first version of this probe produced a
  // frame that got FASTER when work was added. Interleaving spreads drift
  // evenly, and the min over repeats drops scheduler noise, which is one-sided.
  for (let rep = 0; rep < REPS; rep++) {
    // Rotate the order too. Even with a warm-up inside every measurement, the
    // mode that ran FIRST in a rep was consistently the slow one — the GPU had
    // not reached its boost clock. A fixed order bakes that into whichever
    // mode is listed first, which is `base`, which is the one everything else
    // is compared against.
    const order = modes.slice(rep % modes.length).concat(modes.slice(0, rep % modes.length))
    for (const mode of order) {
      setup(mode)
      samples[mode].push(measure(FR))
      teardown(mode)
    }
  }
  const ms = {}
  for (const m of modes) ms[m] = Math.min(...samples[m])

  // Beauty-pass counters, and the shadow pass measured on its own by rendering
  // the scene from the shadow camera's point of view is not available here —
  // instead we report the triangles the shadow pass WOULD submit, which is the
  // sum over every caster of its index count.
  renderer.info.autoReset = false
  renderer.info.reset()
  window.__SHOT__(name); g.tick(dt)
  const draws = renderer.info.render.calls
  const tris = renderer.info.render.triangles
  renderer.info.autoReset = true

  let shadowTris = 0
  for (const o of casters) {
    const geo = o.geometry
    if (!geo) continue
    const n = geo.index ? geo.index.count : (geo.attributes.position ? geo.attributes.position.count : 0)
    shadowTris += (n / 3) * (o.isInstancedMesh ? o.count : 1)
  }

  return { ms, draws, tris, shadowTris: Math.round(shadowTris) }
}
/* eslint-enable */

main().catch((e) => { console.error(e); process.exit(1) })
