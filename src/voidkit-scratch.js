import * as THREE from 'three'
import { CollisionWorld } from './collision.js'
import { Level } from './level.js'
import { buildWorld } from './world.js'
import { RenderPipeline } from './render/index.js'
import { selectTheme } from './theme.js'
import {
  trackedVoidKit, voidKitSelfTest, voidColors,
} from './voidkit.js'

/**
 * THE VOID-KIT SCRATCH STAGE. Not shipped, not part of the course.
 *
 * `docs/purpose.md`: compiling is not verification, and for art the only
 * verification is a rendered frame from the real camera through the real
 * pipeline. `src/voidkit.js` is a prefab library, and prefabs that nothing
 * places cannot be photographed — but the void COURSE is being built in another
 * lane, in files this lane must not touch. So this is the smallest honest
 * stage: the real `Level`, the real `buildWorld`, the real `RenderPipeline`,
 * the real theme, and nothing in it but the four prefabs under test.
 *
 * A frame from here is weaker evidence than a frame from the course — the
 * layout is mine, so it cannot show that the prefabs work in Ethan's level —
 * but it is strictly stronger than reading the source, and it is what catches
 * the class of bug this project keeps hitting: geometry that is absent,
 * inside-out, or invisible.
 *
 * Built only when `SKYLINE_SCRATCH=1` is set for the vite build (see
 * `vite.config.js`), so it cannot reach a deploy.
 */

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.1, 1200)

// Default to the void here rather than to `skyline`: this stage exists to
// photograph theme 2. `?theme=skyline` still works and is the check that the
// prefabs really do take their colours from the descriptor.
const theme = selectTheme(new URLSearchParams(location.search).get('theme') || 'void')
const world = buildWorld(scene, renderer, theme)

// ------------------------------------------------------------- the stage

const collision = new CollisionWorld()
const level = new Level(collision)
const kit = trackedVoidKit()

/**
 * A corridor, because that is what the reference is: "great walls left and
 * right, platforms stepping away and upward toward a bright violet vanishing
 * point" (art-direction-void.md §5). Spacing follows `docs/course-design.md` —
 * every hop below is inside the 7.3 m sprint-jump band.
 */
const WALL_Z = 15
const WALL_LEN = 96
const WALL_H = 40

for (const side of [-1, 1]) {
  const w = kit.greatWall(level, 8, -8, side * WALL_Z, {
    axis: 'x', length: WALL_LEN, height: WALL_H, thickness: 4.0,
    seed: 0x51DE + side, detail: 2, faces: 'both',
  })
  // Sigil rings on the inner faces, at the sizes §4.1 asks for: "in the
  // reference the largest is several storeys across".
  const inner = side > 0 ? -1 : 1
  const [fx, fz] = w.wallFace(inner)
  kit.sigilRing(level, fx - 14, 12, fz, {
    plane: 'xy', side: inner, radius: 7.5, rings: 4, ticks: 32, detail: 2,
  })
  kit.sigilRing(level, fx + 18, 20, fz, {
    plane: 'xy', side: inner, radius: 4.0, rings: 3, ticks: 20, centre: 'diamond', detail: 2,
  })
}

// The stepping line of ruin platforms.
const SLABS = [
  [-26, 0, 0, 7.0, 'knot'],
  [-19, 1.2, -3.5, 6.0, 'rosette'],
  [-12, 2.6, 2.0, 6.5, 'knot'],
  [-5, 4.0, -2.0, 5.5, 'rosette'],
  [2, 5.4, 3.0, 6.0, 'knot'],
  [9, 7.0, -1.0, 7.0, 'rosette'],
  [16, 8.6, 2.5, 5.5, 'knot'],
  [23, 10.4, -2.5, 6.5, 'knot'],
  [30, 12.2, 1.0, 6.0, 'rosette'],
]
for (const [sx, sy, sz, size, motif] of SLABS) {
  kit.runeSlab(level, sx, sy, sz, { size, motif, seed: 0xB0 + sx * 7, detail: 2 })
}

// Monoliths: two on platforms, and a far pair for the mid-ground band.
kit.monolith(level, -25.5, 0, -2.4, { height: 7.5, width: 1.3, seed: 0x11 })
kit.monolith(level, 9.5, 7.0, -2.6, { height: 6.0, width: 1.1, seed: 0x22 })
kit.monolith(level, 23.6, 10.4, -4.4, { height: 3.6, width: 1.6, stump: true, seed: 0x33 })
kit.monolith(level, -40, -8, 9, { height: 22, width: 3.4, seed: 0x44, detail: 1 })
kit.monolith(level, 46, -8, -9, { height: 26, width: 3.8, seed: 0x55, detail: 1 })

const glow = kit.assertAllPlaced()
scene.add(level.build())

// ---------------------------------------------------------------- pipeline

const pipeline = new RenderPipeline(renderer, scene, camera, {
  grade: theme.grade || undefined,
  exposure: theme.exposure || undefined,
  sky: theme.sky
    ? { zenith: theme.sky.zenith, horizon: theme.sky.horizon,
        sunHaze: theme.sky.sun, cloud: theme.sky.deck }
    : undefined,
})
pipeline.setSize(window.innerWidth, window.innerHeight)

// ------------------------------------------------------------------ shots
//
// Eye height is 1.53 m above the feet in the real game (see tools/shots.mjs),
// so every standing pose below is a deck height plus 1.53 — the same eye the
// player has, not a floating camera that flatters the geometry.

const EYE = 1.53

export const VSHOTS = {
  corridor: {
    pos: [-34, 0 + EYE + 1.2, 0], look: [30, 14, 0],
    note: 'down the corridor: great walls left and right, platforms stepping up',
  },
  wallrun: {
    pos: [-14, 4.4, -WALL_Z + 2.0 + 0.32 + 0.9], look: [40, 3.0, -WALL_Z + 3.0],
    note: 'ACCEPTANCE: the wall-run face at run height — grooves must read as speed',
  },
  slabtop: {
    pos: [-14.4, 2.6 + EYE, 2.0], look: [-5, 4.0, -2.0],
    note: 'ACCEPTANCE: standing on a rune slab, the rune reading as a landing',
  },
  runeclose: {
    pos: [-14.6, 2.6 + EYE, 4.6], look: [-12, 2.6, 2.0],
    note: 'the rune inlay close enough to judge the glyph',
  },
  // Raking, NOT straight up. The first cut shot from directly beneath and came
  // back at luminance 1.5 — a black rectangle, which the analyzer correctly
  // failed as a uniform frame. It was not wrong about the geometry (no sky is
  // the pass condition) but it was useless as evidence: an underside with no
  // light on it and no sky behind it cannot be judged at all. From off to one
  // side the tier stack is silhouetted against the fog, which is both the shot
  // that can fail and the composition §5 asks for.
  slabunder: {
    pos: [2.5, 1.0, -8.0], look: [9.5, 5.4, -1.0],
    note: 'ACCEPTANCE: a slab underside from below and to the side — jagged, silhouetted',
  },
  sigil: {
    pos: [-6, 12, -WALL_Z + 2.4 + 16], look: [-6, 12, -WALL_Z + 2.4],
    note: 'a sigil ring on the great wall face',
  },
  // INSIDE the corridor. The first cut sat at z = 14 with the wall spanning
  // z = 13..17 — the camera was buried in the masonry, and the frame it
  // produced (a beautiful raking view along the panel grid) was an accident.
  monoliths: {
    pos: [-34, 3.5, 8.0], look: [24, 8, -2],
    note: 'mid-ground: monoliths and platforms against the far wall',
  },
  vista: {
    pos: [-44, 22, 6], look: [16, 6, 0],
    note: 'the whole stage from above the corridor mouth, three depth bands',
  },
}

const _look = new THREE.Vector3()

window.__VSHOT__ = function (name) {
  const s = VSHOTS[name]
  if (!s) throw new Error(`__VSHOT__: unknown shot ${name}`)
  camera.position.set(s.pos[0], s.pos[1], s.pos[2])
  camera.lookAt(_look.set(s.look[0], s.look[1], s.look[2]))
  camera.updateMatrixWorld(true)
  pipeline.resetExposure()
  return s
}

let clock = 0
function tick(dt) {
  clock += dt
  world.update(clock, camera.position)
  pipeline.render(dt)
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
  pipeline.setSize(window.innerWidth, window.innerHeight)
})

window.__game = {
  scene, camera, renderer, level, pipeline, tick, glow,
  shots: VSHOTS,
  selfTest: () => voidKitSelfTest(),
  colors: voidColors({}, theme),
  drive(frames, dt = 1 / 60) { for (let i = 0; i < frames; i++) tick(dt) },
}

__VSHOT__('corridor')
tick(1 / 60)
window.__READY__ = true
