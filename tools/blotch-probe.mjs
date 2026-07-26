#!/usr/bin/env node
/**
 * Blotch probe — does the far-band impostor layer punch black holes in the
 * level?
 *
 * ============================== WHAT IT CAUGHT =============================
 *
 * Ethan, on the void build: "some of the terrain is like in the wall or making
 * it invisible". In `shots/ascent.png` the central great wall carried irregular
 * pitch-black masses across its face, reading as holes through the world.
 *
 * They are the FAR-BAND IMPOSTOR CARDS, drawn 900 m away, winning the depth
 * test against a wall 30 m away. `VERT_CARD` in `src/fx/voidbackdrop.js`
 * remaps a card's clip depth so that cards past the camera's far plane are
 * squashed into the last of the depth range instead of being clipped:
 *
 *     float ndc = clip.z / clip.w;
 *     if (ndc > 0.99) ndc = 0.99 + 0.00998 * (1.0 - 1.0 / (1.0 + (ndc - 0.99) * 60.0));
 *     clip.z = ndc * clip.w;
 *
 * The threshold assumes ndc 0.99 means "nearly at the far plane". With this
 * game's camera — `new THREE.PerspectiveCamera(76, aspect, 0.1, 1200)`, i.e.
 * NEAR 0.1 — it does not. ndc = 1.0001667 - 0.200017 / d, so ndc crosses 0.99
 * at d = 19.7 m. The branch therefore fires for EVERY card, and compresses the
 * whole 20 m-to-infinity range into [0.99, 0.99998].
 *
 * The rest of the scene is not remapped, so the two depth scales no longer
 * agree. A card at 900 m lands at ndc 0.9937; un-remapped geometry passes that
 * value at about 31 m. Everything in the level beyond ~31 m from the camera is
 * therefore BEHIND the far band as far as the depth test is concerned, and the
 * card paints its near-black baked ruin silhouette straight over it.
 *
 * The comment above the remap is right that it is monotonic — but monotonic
 * AMONG CARDS. Ordering against un-remapped geometry is what it destroys.
 *
 * =========================== WHAT WAS RULED OUT ============================
 *
 * Recorded because each cost a run, and the shape of this bug invites all of
 * them:
 *
 *   - Geometry intersecting the wall (the density pass's `debrisCloud`,
 *     satellite ruins, boulder tiers). Hiding `void:glow`, `crystals`,
 *     `lanterns` and every `surface:` batch leaves the blotches untouched.
 *   - Z-fighting between coincident faces. Z-fighting shimmers and interleaves;
 *     these are solid, stable, and have a silhouette that belongs to no level
 *     prefab.
 *   - The contact-shadow pass painting AO onto the wall. Plausible — the cards
 *     are `transparent: false` on purpose, so they are NOT excluded from the
 *     depth prepass by `_visitObject` in `src/render/index.js`, and a phantom
 *     near occluder there would look exactly like this. Measured and false:
 *     `no-contact` (pass off, whole scene visible) still blotches.
 *   - `gl.readPixels` on the default framebuffer, as a way to find dark pixels
 *     without screenshots. The pipeline resolves through post-process targets,
 *     so the read comes back uniformly black. Screenshots are the only honest
 *     read of this renderer.
 *   - Ray/AABB picking to name the object under a pixel. The level's surfaces
 *     are ONE merged mesh per material kind, so `surface:stone`'s bounding box
 *     is the whole 508 m shaft and contains the camera. Useless here.
 *
 * ================================ THE TEST =================================
 *
 * `no-depth-squash` re-renders the same frame with the same cards visible and
 * only the remap neutralised (threshold raised out of reach), by patching the
 * material's vertex shader in the page. If the remap is the mechanism, that
 * frame loses the blotches WHILE KEEPING EVERY CARD — which is exactly the
 * thing hiding the layer cannot tell you, and why hiding it was not enough.
 *
 * The metric is a PER-PIXEL DIFF of those two frames, not a whole-frame
 * statistic. `analyze.mjs`'s `clipped.lowPct` was tried first and cannot see
 * this: a blotch is dark against near-black rock, not crushed to zero, so it
 * moves lowPct by 0.00 while covering thousands of pixels. Mean luminance
 * moves too (37.4 vs 38.6) but is confounded by auto-exposure. Two frames from
 * the same build on the same pose differ ONLY by the remap, so the share of
 * pixels the shipped frame renders materially DARKER than the control is the
 * artifact itself, measured directly.
 *
 *   node tools/blotch-probe.mjs [--shot ascent] [--out DIR] [--no-build]
 *
 * Own port (5241) — sharing one silently measures somebody else's build.
 */

import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { analyzeFile } from './analyze.mjs'
import {
  REPO, buildDist, hideChrome, launchBrowser, openGame, parseArgs, pumpShot,
  startStaticServer,
} from './harness.mjs'

const PORT = 5241
const args = parseArgs(process.argv.slice(2))
const SHOT = args.shot && args.shot !== true ? String(args.shot) : 'ascent'
const OUT = resolve(args.out && args.out !== true ? String(args.out)
  : 'docs/captures/blotch')

/**
 * One run each. `base` is the shipped frame; `no-depth-squash` is the control
 * that isolates the remap; the other two are kept because they are what
 * localised the layer in the first place and they cost one frame each.
 */
const MODES = [
  'base',
  'no-depth-squash',
  'hide-void-backdrop-far-impostors',
  'no-contact',
]

/** A pixel counts as occluded when the shipped frame is this much darker. */
const DARKER_BY = 24

/**
 * Share of the frame the cards may take before this is a bug rather than tone.
 * Contact shadows and the haze gradient both move a few thousand pixels by
 * more than `DARKER_BY` frame to frame; 0.5 % of 1600x900 is 7200 px, which is
 * comfortably above that and far below the ~4 % the live bug measures.
 */
const MAX_OCCLUDED_PCT = 0.5

/** Fraction of `a` that is at least `DARKER_BY` darker than `b`, per pixel. */
function occludedPct(aPath, bPath) {
  const A = PNG.sync.read(readFileSync(aPath))
  const B = PNG.sync.read(readFileSync(bPath))
  if (A.width !== B.width || A.height !== B.height) return NaN
  let n = 0
  for (let i = 0; i < A.data.length; i += 4) {
    const la = 0.2126 * A.data[i] + 0.7152 * A.data[i + 1] + 0.0722 * A.data[i + 2]
    const lb = 0.2126 * B.data[i] + 0.7152 * B.data[i + 1] + 0.0722 * B.data[i + 2]
    if (lb - la >= DARKER_BY) n++
  }
  return +((100 * n) / (A.width * A.height)).toFixed(2)
}

async function main() {
  if (!args['no-build']) buildDist()
  await mkdir(OUT, { recursive: true })
  const server = await startStaticServer(resolve(REPO, 'dist'), PORT)
  let browser = null
  const rows = []
  try {
    browser = await launchBrowser()
    const { page } = await openGame(browser, `${server.url}?theme=void`,
      { width: 1600, height: 900 })
    await hideChrome(page)

    for (const mode of MODES) {
      await page.evaluate((m) => {
        const g = window.__game
        g.pipeline.contactShadows = m !== 'no-contact'
        g.scene.traverse((o) => {
          if (!o.material) return

          // Visibility, restored exactly rather than set back to true.
          const was = o.userData.__probeWas
          if (was !== undefined) { o.visible = was; delete o.userData.__probeWas }
          if (m.startsWith('hide-') && (o.name || '').startsWith(m.slice(5))) {
            o.userData.__probeWas = o.visible
            o.visible = false
          }

          // The remap, patched live. `src/fx/voidbackdrop.js` belongs to
          // another lane, and a diagnostic that requires editing the file it
          // is diagnosing is a diagnostic nobody runs.
          const mat = o.material
          if (!mat.vertexShader || !mat.vertexShader.includes('ndc > 0.99')) return
          if (!o.userData.__vsOrig) o.userData.__vsOrig = mat.vertexShader
          mat.vertexShader = m === 'no-depth-squash'
            ? o.userData.__vsOrig.replace('ndc > 0.99)', 'ndc > 1.0e9)')
            : o.userData.__vsOrig
          mat.needsUpdate = true
        })
      }, mode)

      await pumpShot(page, SHOT, { frames: 30, dt: 1 / 60, syncFrames: 4 })
      const file = join(OUT, `${SHOT}-${mode.replace(/[^a-z0-9]+/gi, '_')}.png`)
      await page.screenshot({ path: file, type: 'png' })
      const a = analyzeFile(file)
      rows.push({ mode, file, black: a.clipped.lowPct, lum: a.luminance })
    }
  } finally {
    if (browser) await browser.close()
    await server.close()
  }

  console.log(`\nblotch probe — shot "${SHOT}"  ->  ${OUT}\n`)
  const ctrl = rows.find((r) => r.mode === 'no-depth-squash')
  console.log('mode                                lum   occluded% vs control')
  console.log('---------------------------------  -----  --------------------')
  for (const r of rows) {
    const occ = r.mode === 'no-depth-squash' ? 0 : occludedPct(r.file, ctrl.file)
    if (r.mode === 'base') r.occluded = occ
    console.log(`${r.mode.padEnd(33)}  ${String(r.lum).padStart(5)}  ${occ}`)
  }

  const base = rows.find((r) => r.mode === 'base')
  const excess = base.occluded
  console.log(`\nframe covered by cards that should be behind the level: ${excess} %`)
  if (excess > MAX_OCCLUDED_PCT) {
    console.log('\nFAIL — the far-band impostor cards are drawing over near geometry.\n'
      + '  VERT_CARD in src/fx/voidbackdrop.js remaps clip depth above ndc 0.99.\n'
      + '  With near = 0.1 that threshold is 19.7 m, not the far plane, so every\n'
      + '  card is pulled in front of anything past ~31 m. Remap only what would\n'
      + '  actually be clipped (ndc > 1.0).')
    process.exitCode = 1
  } else {
    console.log('\nOK — no card is winning the depth test against the level.')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
