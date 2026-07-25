import * as THREE from 'three'
import { surfaceMaterial, glowMaterial, PALETTE } from './materials.js'

/**
 * The course, as data.
 *
 * The hard rule this file exists to enforce (CLAUDE.md #2): **a visible
 * surface is always a solid one**. `solid()` writes geometry and collision
 * from the same declaration, so the two can never drift. `decor()` is the only
 * way to add something non-solid, and it refuses to sit anywhere near the
 * route. Clockwork Garden's most persistent bug — a thing you could see but
 * not stand on, and a thing you could stand on but not see — is structurally
 * impossible here.
 *
 * All boxes of one material merge into a single draw call, with per-box tint
 * jitter and baked contact shading in the vertex colours. That is what stops
 * a row of identical platforms from reading as a row of identical primitives.
 */

const TEX_PER_METRE = 0.42

const FACES = [
  { n: [1, 0, 0],  u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1],  v: [0, 1, 0] },
  { n: [0, 1, 0],  u: [1, 0, 0],  v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, 1] },
  { n: [0, 0, 1],  u: [1, 0, 0],  v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

export class Level {
  constructor(collision) {
    this.collision = collision
    this.group = new THREE.Group()
    this.checkpoints = []
    this.lanterns = []
    this.spawn = new THREE.Vector3(3, 1.2, 0)
    // The course runs along +X. Three's default forward is -Z, so without
    // this the player spawns facing ninety degrees off the route and runs
    // straight off the side of the terrace.
    this.spawnYaw = -Math.PI / 2
    this.killY = -32
    this._batches = new Map()
    this._rand = rng(0x5C0117)
  }

  /** A surface you can stand on, run along, or vault. Visible AND solid. */
  solid(cx, cy, cz, sx, sy, sz, kind = 'porcelain') {
    this.collision.addCenteredBox(cx, cy, cz, sx, sy, sz, kind)
    this._emit(kind, cx, cy, cz, sx, sy, sz)
    return this
  }

  /** Scenery. Never solid, and never near enough to be mistaken for a route. */
  decor(cx, cy, cz, sx, sy, sz, kind = 'stone') {
    this._emit(kind, cx, cy, cz, sx, sy, sz)
    return this
  }

  checkpoint(x, y, z, label) {
    this.checkpoints.push({
      position: new THREE.Vector3(x, y, z),
      label,
      radius: 4.5,
      reached: false,
    })
    return this
  }

  lantern(x, y, z, color = PALETTE.brass) {
    this.lanterns.push({ position: new THREE.Vector3(x, y, z), color })
    return this
  }

  // ------------------------------------------------------------- geometry

  _emit(kind, cx, cy, cz, sx, sy, sz) {
    let b = this._batches.get(kind)
    if (!b) {
      b = { pos: [], norm: [], uv: [], col: [], idx: [], count: 0 }
      this._batches.set(kind, b)
    }

    const hx = sx / 2, hy = sy / 2, hz = sz / 2
    const minY = cy - hy
    // Per-box tint jitter so repeated shapes never read as clones.
    const jitter = 0.93 + this._rand() * 0.13

    for (const f of FACES) {
      const [nx, ny, nz] = f.n
      const eN = Math.abs(nx) * hx + Math.abs(ny) * hy + Math.abs(nz) * hz
      const eU = Math.abs(f.u[0]) * hx + Math.abs(f.u[1]) * hy + Math.abs(f.u[2]) * hz
      const eV = Math.abs(f.v[0]) * hx + Math.abs(f.v[1]) * hy + Math.abs(f.v[2]) * hz
      const base = b.count

      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = cx + nx * eN + f.u[0] * su * eU + f.v[0] * sv * eV
        const y = cy + ny * eN + f.u[1] * su * eU + f.v[1] * sv * eV
        const z = cz + nz * eN + f.u[2] * su * eU + f.v[2] * sv * eV

        b.pos.push(x, y, z)
        b.norm.push(nx, ny, nz)
        b.uv.push((su * 0.5 + 0.5) * eU * 2 * TEX_PER_METRE,
                  (sv * 0.5 + 0.5) * eV * 2 * TEX_PER_METRE)

        // Baked contact shading: darken the first metre above each box's base
        // so masses sit on each other instead of floating, and lift upward
        // faces so the sky reads as the light source.
        let shade = 0.70 + 0.30 * Math.min(1, (y - minY) / 1.0)
        if (ny > 0.5) shade = Math.min(1.12, shade + 0.10)
        else if (ny < -0.5) shade *= 0.72
        const t = shade * jitter
        b.col.push(t, t, t)
      }

      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      b.count += 4
    }
  }

  build() {
    for (const [kind, b] of this._batches) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.norm, 3))
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2))
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3))
      g.setIndex(b.idx)
      g.computeBoundingSphere()

      const mesh = new THREE.Mesh(g, surfaceMaterial(kind))
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.name = `surface:${kind}`
      this.group.add(mesh)
    }

    // Lanterns: emissive markers that read as waypoints, deliberately small
    // and never on the running line.
    if (this.lanterns.length) {
      const geo = new THREE.IcosahedronGeometry(0.34, 1)
      const mat = glowMaterial(PALETTE.brass, 2.2)
      const inst = new THREE.InstancedMesh(geo, mat, this.lanterns.length)
      const m = new THREE.Matrix4()
      this.lanterns.forEach((l, i) => {
        m.makeTranslation(l.position.x, l.position.y, l.position.z)
        inst.setMatrixAt(i, m)
      })
      inst.instanceMatrix.needsUpdate = true
      inst.name = 'lanterns'
      this.group.add(inst)
    }

    return this.group
  }

  // ---------------------------------------------------------------- helpers

  /**
   * A run of shallow steps. The controller's vault/step-up handles these
   * without the player ever feeling them, which is how we get slopes out of
   * an axis-aligned collision world without lying about what is solid.
   */
  stair(x0, y0, z, count, rise, run, width, kind = 'porcelain') {
    for (let i = 0; i < count; i++) {
      const h = y0 + rise * (i + 1)
      this.solid(x0 + run * (i + 0.5), h - rise / 2 - 0.4, z, run, rise + 0.8, width, kind)
    }
    return this
  }
}

/**
 * The opening leg of the route.
 *
 * Each section teaches exactly one verb in isolation, then the last two
 * sections demand them in combination. Nothing is explained in text: a brass
 * surface is always something to wall-run, moss is always somewhere safe to
 * land, and every gap is sized so that the correct technique clears it with
 * room while the wrong one does not.
 */
export function buildCourse(collision) {
  const L = new Level(collision)
  L.spawn.set(4, 1.4, 0)

  // ---- Section 1: the terrace. Run, sprint, feel the friction. ----------
  L.solid(14, -0.5, 0, 30, 1, 16, 'porcelain')
  L.solid(14, 0.4, -8.4, 30, 2.8, 0.8, 'terracotta')
  L.solid(14, 0.4, 8.4, 30, 2.8, 0.8, 'terracotta')
  L.checkpoint(4, 1.4, 0, 'terrace')
  L.lantern(2, 3.4, -6)
  L.lantern(2, 3.4, 6)

  // Low blocks to run over — the vault, before you know it is a vault.
  L.solid(20, 0.35, -2.2, 2.4, 0.8, 3.0, 'terracotta')
  L.solid(24, 0.5, 2.4, 2.4, 1.1, 3.0, 'terracotta')

  // ---- Section 2: gap jumps. Momentum is the only way across. -----------
  L.solid(38, -0.5, 0, 10, 1, 12, 'moss')
  L.solid(52, -0.5, 1.5, 10, 1, 12, 'moss')
  L.solid(67, -0.5, -1.0, 11, 1, 13, 'moss')
  L.checkpoint(38, 1.4, 0, 'the gaps')
  L.lantern(38, 2.6, -6.5)
  L.lantern(52, 2.6, 7.0)

  // ---- Section 3: the vault line. Ledges at exactly mantle height. ------
  L.solid(84, -0.5, 0, 22, 1, 12, 'porcelain')
  L.solid(78, 0.45, 0, 1.6, 0.9, 12, 'terracotta')
  L.solid(84, 0.55, 0, 1.6, 1.1, 12, 'terracotta')
  L.solid(90, 0.35, 0, 1.6, 0.7, 12, 'terracotta')
  L.checkpoint(76, 1.4, 0, 'the ledges')

  // ---- Section 4: the wall-run crossing. Brass means runnable. ----------
  // One long wall over a void. The approach ledge deliberately hugs it, so a
  // player running the obvious line is already inside the wall's reach when
  // the floor disappears — the technique gets taught by the geometry rather
  // than by a prompt. A corridor with the wall metres away teaches nothing,
  // because you never touch it.
  L.solid(102, 4.0, -4.6, 32, 12, 1.2, 'brass')   // face at z = -4.0
  L.solid(93, -0.5, -3.2, 14, 1, 2.6, 'porcelain')  // approach ledge, ends x=100
  L.solid(116, -0.5, -3.0, 13, 1, 11, 'moss')       // landing
  L.checkpoint(116, 1.4, -3.0, 'the crossing')
  L.lantern(102, 10.6, -4.0)
  L.lantern(116, 2.6, -7.5)

  // ---- Section 5: the slide. A ceiling too low to run under. ------------
  L.solid(140, -0.5, -1.5, 34, 1, 15, 'porcelain')
  // 18 m of ceiling: long enough that you must arrive fast, short enough that
  // a correctly-timed slide clears it without the friction stranding you
  // halfway under a roof you cannot stand up inside.
  L.solid(140, 2.15, -1.5, 18, 1.6, 15, 'terracotta')  // underside at 1.35
  L.solid(140, 1.0, -8.6, 18, 1.2, 0.8, 'brass')
  L.solid(140, 1.0, 5.6, 18, 1.2, 0.8, 'brass')
  L.checkpoint(126, 1.4, -1.5, 'the underpass')

  // ---- Section 6: the wall-jump chain. Everything, together. ------------
  // Faces sit at z = ±2.3, so the crossing is 4.6 m — comfortably inside one
  // wall-jump's outward kick, and impossible to walk.
  L.solid(163, 3.0, -3.0, 9, 15, 1.4, 'brass')
  L.solid(175, 3.0, 3.0, 9, 15, 1.4, 'brass')
  L.solid(187, 3.0, -3.0, 9, 15, 1.4, 'brass')
  L.solid(156, -0.5, 0, 8, 1, 10, 'porcelain')
  L.solid(197, 1.2, 0, 11, 1, 12, 'moss')
  L.checkpoint(197, 3.0, 0, 'the chain')
  L.lantern(163, 11.0, -2.3)
  L.lantern(175, 11.0, 2.3)
  L.lantern(187, 11.0, -2.3)

  // ---- Section 7: the ascent and the bell. ------------------------------
  L.stair(202, 1.5, 0, 8, 0.55, 1.6, 8, 'porcelain')
  L.solid(222, 5.9, 0, 14, 1, 14, 'moss')
  L.solid(222, 8.4, -6.0, 14, 4, 1.0, 'brass')
  L.solid(222, 8.4, 6.0, 14, 4, 1.0, 'brass')
  L.solid(228.5, 8.4, 0, 1.0, 4, 12, 'brass')
  L.checkpoint(222, 7.0, 0, 'the tower')
  L.lantern(217, 8.0, -5.0)
  L.lantern(217, 8.0, 5.0)

  L.finish = new THREE.Vector3(226, 7.0, 0)

  // ---- Scenery. Off-route by construction, per docs/taste.md. -----------
  const rand = rng(0xA11CE)
  for (let i = 0; i < 26; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const x = 5 + rand() * 230
    const z = side * (34 + rand() * 90)
    const y = -14 - rand() * 26
    const w = 8 + rand() * 22
    L.decor(x, y, z, w, 6 + rand() * 14, w * (0.7 + rand() * 0.6), 'stone')
    L.decor(x, y + 4 + rand() * 3, z, w * 0.82, 1.4, w * 0.6, 'moss')
  }
  // Distant towers: real geometry with real silhouettes, never a painted card.
  for (let i = 0; i < 18; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const x = -40 + rand() * 330
    const z = side * (120 + rand() * 190)
    const h = 40 + rand() * 90
    L.decor(x, h / 2 - 40, z, 12 + rand() * 16, h, 12 + rand() * 16, 'stone')
    L.decor(x, h - 39, z, 6 + rand() * 6, 5, 6 + rand() * 6, 'terracotta')
  }

  return L
}
