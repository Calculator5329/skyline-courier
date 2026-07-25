import * as THREE from 'three'
import { surfaceMaterial, glowMaterial, PALETTE } from './materials.js'
import { makeRand, trackedKit } from './kit.js'

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
 *
 * Everything architectural is placed through `src/kit.js`, and `buildCourse()`
 * ends by asserting that every prefab the kit exports actually got placed. A
 * kit nobody imports is the exact failure this course shipped with once: the
 * arches, gears, vines, domes and waterfalls all existed in source and none of
 * them existed in a frame.
 */

const TEX_PER_METRE = 0.42

/**
 * FACES is indexed as `axis * 2 + (sign > 0 ? 0 : 1)`, so `+X` is 0, `-X` is 1,
 * `+Y` is 2 and so on. The bevel generator below relies on that ordering to
 * find a UV basis for an arbitrary face, edge or corner polygon.
 */
const FACES = [
  { n: [1, 0, 0],  u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1],  v: [0, 1, 0] },
  { n: [0, 1, 0],  u: [1, 0, 0],  v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, 1] },
  { n: [0, 0, 1],  u: [1, 0, 0],  v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]

const QUAD = [[-1, -1], [1, -1], [1, 1], [-1, 1]]

/**
 * THE BEVEL. Every box in this game is chamfered by this much, and it is the
 * single highest-leverage number in the file.
 *
 * A 90-degree arris catches no highlight at all: the two faces meeting at it
 * are lit by two different cosines and the edge between them is a step
 * function, so a carved mass reads as a flat coloured shape. Insetting each
 * face by `b` and filling the gap with 12 edge quads and 8 corner triangles
 * puts a 45-degree sliver between every pair of faces, and at golden hour with
 * a low raking sun that sliver lights up along every arris in the world.
 *
 * 4.5 cm is a real stonemason's arris at this scale — big enough to survive
 * two pixels at 30 m, small enough that a 0.9 m mantle ledge is still 0.9 m.
 * The proportional term keeps 12 cm balusters from turning into octagons.
 *
 * THE BEVEL GEOMETRY IS STRICTLY INSIDE THE DECLARED AABB, so the collider
 * declaration is untouched: `solid()` still means exactly what it meant, and
 * art-direction.md's collision caveat is satisfied by construction.
 */
const BEVEL_MAX = 0.045
const BEVEL_FRAC = 0.13

/**
 * Top arrises are lifted and bottom arrises are dropped, in ALBEDO rather than
 * in the lit value.
 *
 * The art review measured a 15-luma spread across the whole tower staircase:
 * the step nosings were drawn with exactly the same weight as the decorative
 * block joints inside each face, so decorative detail out-competed gameplay
 * silhouette. Tread-vs-riser and ledge-edge are the two most load-bearing
 * reads in a first-person parkour game, so they get a fixed offset that does
 * not depend on which way the sun happens to be pointing.
 */
const TOP_EDGE_LIFT = 1.34
const BOT_EDGE_DROP = 0.52

/** Reverse a polygon's winding if it does not face the way we said it does. */
function faceOut(verts, n) {
  const [a, b, c] = verts
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  const gx = uy * vz - uz * vy
  const gy = uz * vx - ux * vz
  const gz = ux * vy - uy * vx
  if (gx * n[0] + gy * n[1] + gz * n[2] < 0) verts.reverse()
  return verts
}

// Build-time scratch for the mesh channel. Never touched at frame time.
const _v = new THREE.Vector3()
const _nrm = new THREE.Matrix3()

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
    /** Grapple anchors, handed to the player at startup. */
    this.anchors = []
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

  /**
   * A solid mass with a carved profile: full-width plinth, inset body, full
   * -width cornice. Three courses instead of one box, which is the whole
   * difference between a wall and a plank.
   *
   * The union's footprint and its TOP FACE are exactly the box you asked for,
   * so this is a drop-in replacement for `solid()` even where a mantle height
   * or a landing edge is load-bearing. It insets the *middle*, never the
   * extremes — an inset top would move a vault height, and an inset face
   * would put a step in a wall-run.
   */
  massif(cx, cy, cz, sx, sy, sz, kind = 'porcelain', capKind = kind) {
    const top = cy + sy / 2
    const bot = cy - sy / 2
    // Trim depth is capped in absolute terms as well as proportionally: a
    // 12 m wall wants a 22 cm cornice, not a 2.4 m one.
    const cap = Math.min(0.22, sy * 0.2)
    const plinth = Math.min(0.30, sy * 0.18)
    const inset = Math.min(0.22, Math.min(sx, sz) * 0.12)
    this.solid(cx, top - cap / 2, cz, sx, cap, sz, capKind)
    this.solid(cx, bot + plinth / 2, cz, sx, plinth, sz, kind)
    this.solid(cx, (bot + plinth + top - cap) / 2, cz,
      sx - inset * 2, top - cap - bot - plinth, sz - inset * 2, kind)
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

  /**
   * A brass lantern. Every lantern is also a grapple anchor.
   *
   * That is deliberate rather than convenient: brass has meant "you can use
   * this" since the first wall, so the anchors need no new visual language.
   * A player who has learned to read brass already knows where they can grab.
   *
   * Prefer `kit.lanternPost()` over calling this directly — a bare anchor is
   * an invisible affordance, and an invisible affordance is a tutorial you
   * forgot to write.
   */
  lantern(x, y, z, color = PALETTE.brass) {
    const position = new THREE.Vector3(x, y, z)
    this.lanterns.push({ position, color })
    this.anchors.push(position)
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
}

// ------------------------------------------------------------ deck presets

/**
 * Two island profiles, because the archipelago has two kinds of ground.
 *
 * `BUILT` is masonry the courier service laid: sandstone paving over a rock
 * drum. `WILD` is a rock the garden took back: a moss mat over the same drum.
 * Both keep the moss/paving cap as a THIN course proud of a narrower rim, so
 * the cap overhangs and shadows the rock instead of presenting a metre of
 * grass texture down a vertical face.
 */
const BUILT = { capKind: 'porcelain', rimKind: 'porcelain', kind: 'stone', boulderKind: 'stone' }
const WILD = { capKind: 'moss', rimKind: 'porcelain', kind: 'stone', boulderKind: 'stone' }

/**
 * Facet count is chosen by aspect ratio, not by taste.
 *
 * `drumPlatform` approximates a disc, and `squash` turns that disc into an
 * ellipse. Facet an ellipse whose aspect is 3:1 and the ends taper to a
 * point — which is charming on a boulder and lethal on a 30 m terrace you
 * spawn at the end of. So: long decks get facets 1 (a rectangle whose
 * silhouette comes from the overhanging cap and the tapering underside),
 * near-square ones get the full rounded read.
 */
function facetsFor(lengthX, lengthZ) {
  const aspect = Math.max(lengthX, lengthZ) / Math.min(lengthX, lengthZ)
  return aspect > 2.0 ? 1 : aspect > 1.4 ? 2 : 4
}

/**
 * The opening leg of the route.
 *
 * Each section teaches exactly one verb in isolation, then the last two
 * sections demand them in combination. Nothing is explained in text: a brass
 * surface is always something to wall-run, moss is always somewhere safe to
 * land, and every gap is sized so that the correct technique clears it with
 * room while the wrong one does not.
 *
 * Section coordinates on the original seven-checkpoint spine (x 0..229) are
 * FROZEN: deck tops, wall faces and the underpass clearance are read directly
 * by `tools/shots.mjs`, and by the player's muscle memory. The kit dresses
 * those volumes; it does not move them.
 */
export function buildCourse(collision) {
  const L = new Level(collision)
  const K = trackedKit()
  L.spawn.set(4, 1.4, 0)

  // A deck helper that keeps every island honest: the drum's footprint IS its
  // collider (art-direction.md's collision caveat), and the caller passes the
  // walkable top height directly, so a platform can be placed straight off a
  // jump arc.
  const deck = (x, y, z, lenX, lenZ, style, opts = {}) => K.drumPlatform(L, x, y, z, {
    radius: lenX / 2,
    squash: lenZ / lenX,
    facets: facetsFor(lenX, lenZ),
    ...style,
    ...opts,
  })

  // ---- Section 1: the colonnaded terrace. Run, sprint, feel the friction. --
  //
  // The establishing shot lives here, so the priority is that it establishes
  // something. The old terrace was 16 m wide between two 2.8 m parapets: an
  // orange corridor with no visible edge, no void and no archipelago, which
  // is the one thing a floating-island game cannot afford in its first frame.
  // Now the deck is 10.4 m wide, the parapet is 1.0 m (vault height — it reads
  // as an affordance rather than a fence) and covers only the first 13 m, and
  // the far side is an open colonnade you see straight through. The drop is
  // visible from the spawn on both sides.
  deck(14, 0, 0, 30, 10.4, BUILT, { bodyDepth: 3.2, capThickness: 0.5 })
  K.colonnade(L, 5, 0, 4.0, {
    count: 6, spacing: 4.2, height: 4.2, radius: 0.5, capKind: 'terracotta',
  })
  K.balustrade(L, 0.5, 0, -4.7, { length: 13, height: 1.0, thickness: 0.45 })

  // Low blocks to run over — the vault, before you know it is a vault.
  L.massif(20, 0.35, -2.2, 2.4, 0.8, 3.0, 'terracotta', 'porcelain')
  L.massif(24, 0.5, 2.4, 2.4, 1.1, 3.0, 'terracotta', 'porcelain')

  // The premise, hung off the edge the player can now see: water falling out
  // of a garden into open sky.
  K.waterfall(L, 26.5, -0.55, -5.0, { height: 30, width: 2.0 })
  K.vineCurtain(L, 15, -0.55, -5.1, { length: 12, drop: 5 })
  K.vineCurtain(L, 8, -0.55, 5.1, { length: 10, drop: 4 })

  L.checkpoint(4, 1.4, 0, 'terrace')
  // Corner standards, hard against the parapet line so nothing solid is ever
  // in the running lane, plus a bracket anchor slung under the colonnade.
  K.lanternPost(L, 1.6, 0, -4.7, { height: 3.2 })
  K.lanternPost(L, 27.6, 0, 4.6, { height: 3.4 })
  K.lanternPost(L, 13.4, 4.9, 4.0, { post: false, reach: -2.4, axis: 'z', height: 0.9 })

  // ---- Section 2: gap jumps. Momentum is the only way across. -----------
  // Three wild drums: moss over rock, vines off the lip, and a fall off the
  // middle one so the void between them has something in it.
  deck(38, 0, 0, 10, 12, WILD)
  deck(52, 0, 1.5, 10, 12, WILD)
  deck(67, 0, -1.0, 11, 13, WILD)
  K.waterfall(L, 52, -0.4, 7.2, { height: 26, width: 1.8 })
  K.cypress(L, 69.4, 0, 4.0, { height: 6.5 })
  K.cypress(L, 65.0, 0, -5.4, { height: 5.2 })
  K.cypress(L, 36.2, 0, 4.6, { height: 5.8 })
  L.checkpoint(38, 1.4, 0, 'the gaps')
  K.lanternPost(L, 38, 0, -5.2, { height: 3.0 })
  K.lanternPost(L, 52, 0, 6.6, { height: 3.2 })

  // ---- Section 3: the arched viaduct. Ledges at exactly mantle height. ---
  // Same deck volume as before (x 73..95, z ±7, top y=0), but carried on a
  // three-bay arcade instead of hanging in the air on nothing. `facets: 1` is
  // deliberate against the aspect rule: an elliptical footprint would pull the
  // deck edge inboard of the piers, and a pier standing outside the thing it
  // carries is worse than a square corner.
  deck(84, 0, 0, 22, 14, BUILT, { bodyDepth: 3.2, facets: 1 })
  for (const ax of [77, 84, 91]) {
    K.archway(L, ax, -12.6, 0, {
      axis: 'z', span: 7, pierWidth: 1.6, depth: 2.4, springHeight: 4.8,
      detail: 1, kind: 'porcelain',
    })
    // Pier feet, tapering into cloud. Solid, because they are directly under
    // a deck edge the player will fall past and a rock you drop through is
    // the same lie as a platform you drop through.
    for (const s of [-1, 1]) {
      L.solid(ax, -13.6, s * 4.3, 2.8, 2.0, 2.0, 'stone')
      L.solid(ax, -16.4, s * 4.3, 2.0, 3.6, 1.4, 'stone')
    }
  }
  // The vault line itself: three carved ledges, 12 m across so there is no
  // running around them. Mantle heights 0.9 / 1.1 / 0.7 are unchanged.
  L.massif(78, 0.45, 0, 1.6, 0.9, 12, 'terracotta', 'porcelain')
  L.massif(84, 0.55, 0, 1.6, 1.1, 12, 'terracotta', 'porcelain')
  L.massif(90, 0.35, 0, 1.6, 0.7, 12, 'terracotta', 'porcelain')
  K.balustrade(L, 75, 0, 6.5, { length: 18, height: 1.05, thickness: 0.45 })
  K.vineCurtain(L, 76, -0.5, -6.9, { length: 16, drop: 5.5 })
  K.waterfall(L, 93.5, -0.45, -6.6, { height: 28, width: 2.2 })
  L.checkpoint(76, 1.4, 0, 'the ledges')
  K.lanternPost(L, 74.4, 0, -6.4, { height: 3.2 })
  K.lanternPost(L, 94.2, 0, 6.4, { height: 3.2 })

  // ---- Section 4: the wall-run crossing. Brass means runnable. ----------
  // One long wall over a void. The approach ledge deliberately hugs it, so a
  // player running the obvious line is already inside the wall's reach when
  // the floor disappears — the technique gets taught by the geometry rather
  // than by a prompt. A corridor with the wall metres away teaches nothing,
  // because you never touch it.
  //
  // THE CONSTRAINT ON DRESSING THIS WALL: the run face at z = -4.0 must stay
  // dead flat over the full 32 m. A wall-run does not survive a pilaster every
  // four metres, so every piece of ornament goes BEHIND the face, ABOVE the
  // cornice, or BELOW the plinth — never proud of the running plane.
  L.solid(102, 4.0, -4.35, 32, 12, 0.7, 'brass')      // the run face, z = -4.0
  L.solid(102, 3.4, -5.3, 32, 13.2, 1.2, 'brass')     // back mass
  L.solid(102, -1.6, -5.0, 32.6, 1.4, 2.4, 'brass')   // plinth, below the void lip
  L.solid(102, 10.4, -5.0, 33, 0.8, 2.6, 'terracotta') // cornice, 40 cm proud at y=10
  L.solid(102, 6.4, -6.1, 32.4, 0.5, 0.6, 'terracotta') // back string course
  for (const bx of [88, 96, 104, 112]) {
    L.massif(bx, 3.0, -6.3, 1.8, 14, 1.0, 'porcelain') // back buttresses
  }
  // The machinery that supposedly drives the wall, mounted where a wall-runner
  // can never clip it: teeth start at y ≈ 10.8, above the cornice.
  L.solid(102, 14.2, -5.6, 24, 0.55, 0.55, 'brass')   // drive axle
  K.gearWheel(L, 92, 13.8, -5.0, { radius: 2.6, plane: 'xy', spokes: 6, solidRim: true, detail: 1 })
  K.gearWheel(L, 102, 14.6, -5.0, { radius: 3.4, plane: 'xy', spokes: 8, solidRim: true })
  K.gearWheel(L, 112, 13.8, -5.0, { radius: 2.6, plane: 'xy', spokes: 6, solidRim: true, detail: 1 })

  // Approach ledge, now a spur of the same viaduct: top y=0, ends at x=100.
  L.solid(93, -0.5, -3.2, 14, 1, 2.6, 'porcelain')
  L.solid(93, -1.35, -3.2, 14, 0.7, 3.6, 'porcelain')  // corbel course under it
  for (const ax of [89, 95.5]) {
    K.archway(L, ax, -9.4, -3.2, {
      axis: 'z', span: 3.0, pierWidth: 0.9, depth: 1.8, springHeight: 5.0,
      detail: 1, kind: 'porcelain',
    })
  }
  deck(116, 0, -3.0, 13, 11, WILD)                      // landing
  K.waterfall(L, 118, -0.4, -8.2, { height: 24, width: 1.9 })
  K.cypress(L, 120.4, 0, 1.4, { height: 6.2 })
  L.checkpoint(116, 1.4, -3.0, 'the crossing')
  // Anchor slung out over the void on a bracket, so the grapple line into the
  // crossing exists in space rather than inside the cornice.
  K.lanternPost(L, 102, 10.8, -5.0, { post: false, reach: 1.6, axis: 'z', height: 0.9 })
  K.lanternPost(L, 112, 0, -7.4, { height: 3.2 })

  // ---- Section 5: the slide. A ceiling too low to run under. ------------
  deck(140, 0, -1.5, 34, 16, BUILT, { bodyDepth: 3.4 })
  // 18 m of ceiling: long enough that you must arrive fast, short enough that
  // a correctly-timed slide clears it without the friction stranding you
  // halfway under a roof you cannot stand up inside. The underside stays at
  // 1.35 exactly; the mouldings are stacked ABOVE and AROUND it, never below.
  L.solid(140, 2.15, -1.5, 18, 1.6, 15, 'terracotta')    // underside 1.35
  L.solid(140, 1.5, -1.5, 18.6, 0.3, 15.4, 'porcelain')  // impost band, 1.35..1.65
  L.solid(140, 3.1, -1.5, 17.4, 0.3, 14.4, 'porcelain')  // 2.95..3.25
  L.solid(140, 3.55, -1.5, 18.4, 0.6, 15.2, 'terracotta') // cornice, top 3.85
  // Drive gears standing ON the lintel roof, 3 m and 15 m back from its front
  // face. Hung on the front face instead they sit six metres from the
  // approaching player's eye and fill the frame with one wheel — a machine
  // that hides the obstacle it drives is decoration doing damage. From the
  // roof they read at the right scale and the slot stays the subject. Lowest
  // tooth is at y ≈ 3.7, far above the 1.35 m slide slot, so nothing the
  // slide passes through is solid.
  for (const [gx, gz] of [[134, -5.6], [146, 2.6]]) {
    K.gearWheel(L, gx, 6.0, gz, { radius: 2.0, plane: 'zy', spokes: 6, solidRim: true })
  }
  // Brass edging either side of the slot: same signal as before, now a real
  // balustrade rather than two planks. `detail: 1` on purpose — at full
  // baluster pitch an 18 m run reads as a picket fence, not a rail.
  K.balustrade(L, 131, 0, -8.6, { length: 18, height: 1.5, thickness: 0.7, kind: 'brass', detail: 1 })
  K.balustrade(L, 131, 0, 5.6, { length: 18, height: 1.5, thickness: 0.7, kind: 'brass', detail: 1 })
  K.vineCurtain(L, 126, -0.5, -9.4, { length: 20, drop: 6 })
  K.waterfall(L, 152, -0.45, 6.4, { height: 30, width: 2.4 })
  L.checkpoint(126, 1.4, -1.5, 'the underpass')
  K.lanternPost(L, 133, 3.85, -8.0, { height: 2.6 })
  K.lanternPost(L, 147, 3.85, 5.0, { height: 2.6 })

  // ---- Section 6: the wall-jump chain. Everything, together. ------------
  // Faces sit at z = ±2.3, so the crossing is 4.6 m — comfortably inside one
  // wall-jump's outward kick, and impossible to walk. The pillars are battered
  // in X only: the running face has to stay one flat plane from y=-4.5 to
  // y=10.5, so all the taper, banding and machinery lives on the outboard
  // side where nobody's shoulder ever touches it.
  deck(156, 0, 0, 8, 10, BUILT)
  for (const [px, zc] of [[163, -3.0], [175, 3.0], [187, -3.0]]) {
    const dir = zc < 0 ? 1 : -1          // +1 when the run face is on the +Z side
    L.solid(px, -5.2, zc, 10.4, 1.4, 2.6, 'porcelain')   // plinth
    L.solid(px, -1.5, zc, 9.6, 6.0, 1.4, 'brass')        // lower course
    L.solid(px, 4.0, zc, 9.2, 5.0, 1.4, 'brass')         // middle course
    L.solid(px, 8.5, zc, 8.6, 4.0, 1.4, 'brass')         // upper course
    L.solid(px, 10.9, zc, 9.4, 0.8, 2.2, 'terracotta')   // capital, above the run
    L.solid(px, 3.2, zc - dir * 0.85, 9.4, 0.4, 0.5, 'terracotta') // outboard band
    K.gearWheel(L, px, 6.4, zc - dir * 0.95, {
      radius: 2.6, plane: 'xy', spokes: 6, solidRim: true, detail: 1,
    })
    // A second wheel lying flat on the capital. The outboard one faces away
    // from a player flying the chain and is only ever seen from the vista;
    // this one is the pillar's silhouette from underneath, which is the angle
    // the section is actually played at.
    K.gearWheel(L, px, 11.5, zc, {
      radius: 2.2, plane: 'xz', spokes: 6, solidRim: true, detail: 1,
    })
    // The anchor a chain-runner actually aims at, on a bracket off the capital
    // so it hangs in the flight path instead of inside the masonry.
    K.lanternPost(L, px, 11.3, zc, { post: false, reach: dir * 1.4, axis: 'z', height: 0.6 })
  }
  deck(197, 1.7, 0, 11, 12, WILD)
  K.waterfall(L, 197, 1.3, 5.6, { height: 26, width: 2.0 })
  K.cypress(L, 199.6, 1.7, 3.2, { height: 6.0 })
  L.checkpoint(197, 3.0, 0, 'the chain')
  K.lanternPost(L, 193.5, 1.7, -4.6, { height: 3.2 })

  // ---- Section 7: the ascent and the observatory gate. ------------------
  // Same flight as before (8 × 0.55 m rise, 1.6 m run, 8 m wide) so the
  // ascent's rhythm is untouched, but carved: nosings, raking cheeks, newel
  // posts, and moss crept over the two steps that live in shade.
  K.stairFlight(L, 202, 1.5, 0, { steps: 8, rise: 0.55, run: 1.6, width: 8 })
  deck(222, 6.4, 0, 14, 14, WILD)
  // A paved court laid across the moss plateau. It exists because the gate
  // architecture is rectangular and the plateau is not: without it the
  // colonnade's end columns stand off the rounded edge in mid-air.
  L.solid(222, 6.15, 0, 14.6, 0.5, 10.0, 'porcelain')
  L.solid(222, 5.75, 0, 13.8, 0.4, 9.2, 'porcelain')
  for (const cz of [-4.2, 4.2]) {
    K.colonnade(L, 217.2, 6.4, cz, {
      count: 4, spacing: 3.6, height: 3.6, radius: 0.48, capKind: 'terracotta',
    })
    K.lanternPost(L, 220.8, 11.86, cz, {
      post: false, reach: cz < 0 ? 2.4 : -2.4, axis: 'z', height: 0.8,
    })
  }
  K.archway(L, 227.4, 6.4, 0, {
    axis: 'z', span: 6, pierWidth: 1.4, depth: 1.8, springHeight: 3.4,
  })
  K.lanternPost(L, 227.4, 13.64, 0, { post: false, height: 0.8 })
  K.vineCurtain(L, 218.2, 5.9, -5.2, { length: 7.6, drop: 6 })
  K.waterfall(L, 221, 5.95, -6.9, { height: 34, width: 2.4 })
  L.checkpoint(222, 7.0, 0, 'the tower')

  // ---- Section 8: the gearworks climb. -----------------------------------
  // Seven drums spiralling up the side of a brass machine. Every step is a
  // 2.0 m rise across a 1–3 m gap, which the double jump clears with room and
  // neither the dash nor the grapple is needed for — course-design.md's rule
  // that the safe line must never be gated on a charge. The fast line is the
  // lantern chain: each drum carries a standard, so a confident player can
  // grapple straight up the outside and skip four platforms.
  const CLIMB = [
    [237, 8.0, 0, 10, 9],
    [247, 10.0, -5.0, 8, 8],
    [256, 12.0, 3.5, 8, 8],
    [265, 14.0, -4.0, 8, 8],
    [274, 16.0, 3.5, 8, 8],
    [283, 18.0, -3.5, 9, 9],
    [293, 20.0, 1.0, 10, 8.5],
  ]
  CLIMB.forEach(([cx, cy, cz, lx, lz], i) => {
    deck(cx, cy, cz, lx, lz, WILD)
    // Standards go on the outboard lip, away from the landing zone in the
    // middle of each drum — a solid post where you touch down is a
    // momentum bug, and momentum is the fantasy (taste.md).
    const side = cz > 0 ? 1 : -1
    K.lanternPost(L, cx, cy, cz + side * (lz * 0.36), { height: 3.0 })
    if (i % 2 === 0) K.cypress(L, cx - lx * 0.28, cy, cz - side * (lz * 0.22), { height: 5.4 })
  })
  K.waterfall(L, 265, 13.6, -7.4, { height: 34, width: 2.2 })
  K.waterfall(L, 293, 19.6, 4.4, { height: 40, width: 2.6 })
  // The machine itself: three brass towers standing off the route at z = -16,
  // each carrying a wheel big enough to read from the terrace. `solidRim`
  // because they sit at climbing height — a 9 m gear you can see and fall
  // through is the forbidden bug at architectural scale.
  const TOWERS = [[240, 10.0, 6.5], [262, 13.0, 9.0], [284, 17.0, 6.5]]
  for (const [tx, ty, tr] of TOWERS) {
    L.massif(tx, ty - 13, -17.5, 3.4, 26, 3.4, 'porcelain', 'terracotta')
    L.massif(tx, ty - 27.5, -17.5, 4.6, 3, 4.6, 'stone')
    K.gearWheel(L, tx, ty, -15.6, {
      radius: tr, plane: 'xy', spokes: 8, solidRim: true, detail: 1,
    })
  }
  L.checkpoint(247, 11.0, -5.0, 'the gearworks')
  L.checkpoint(274, 17.0, 3.5, 'the high gears')

  // ---- Section 9: the observatory approach. ------------------------------
  // A balustraded causeway on two arches, a carved flight, and the dome. The
  // last hundred metres are the only stretch of the course with no jump in
  // them at all: after the climb the player has earned an approach.
  deck(306, 20.0, 0, 14, 9, BUILT, { bodyDepth: 2.4, tiers: 0, facets: 1 })
  for (const ax of [303, 309]) {
    K.archway(L, ax, 9.4, 0, {
      axis: 'z', span: 5, pierWidth: 1.2, depth: 2.0, springHeight: 3.6,
      detail: 1, kind: 'porcelain',
    })
  }
  for (const bz of [-4.1, 4.1]) {
    K.balustrade(L, 299.4, 20.0, bz, { length: 13.2, height: 1.05, thickness: 0.45 })
  }
  L.checkpoint(303, 21.0, 0, 'the causeway')
  K.lanternPost(L, 299.4, 21.05, -4.1, { post: false, height: 1.0 })
  K.lanternPost(L, 312.6, 21.05, 4.1, { post: false, height: 1.0 })

  K.stairFlight(L, 313, 20.0, 0, { steps: 7, rise: 0.62, run: 1.7, width: 7 })
  const OBS_Y = 20.0 + 0.62 * 7          // 24.34 — the island top matches the flight
  deck(336, OBS_Y, 0, 24, 24, WILD, { bodyDepth: 4.0 })
  K.observatoryDome(L, 338, OBS_Y, 0, { radius: 6.5, wallHeight: 7 })
  // The flanking colonnades hug the approach rather than the island rim: the
  // rim is a rounded drum and a straight row of columns run out to its edge
  // ends with the last two standing in mid-air.
  for (const cz of [-4.0, 4.0]) {
    K.colonnade(L, 327, OBS_Y, cz, { count: 3, spacing: 3.0, height: 3.4, radius: 0.48 })
  }
  K.armillary(L, 336, OBS_Y, -10.2, { radius: 2.6 })
  K.waterfall(L, 336, OBS_Y - 0.4, -11.6, { height: 42, width: 2.6 })
  K.waterfall(L, 347.4, OBS_Y - 0.4, 0, { height: 38, width: 2.2 })
  K.vineCurtain(L, 334, OBS_Y - 0.5, -11.7, { length: 4, drop: 7 })
  K.cypress(L, 330, OBS_Y, 8.4, { height: 7.5 })
  K.cypress(L, 344, OBS_Y, -6.0, { height: 6.5 })
  K.lanternPost(L, 327.5, OBS_Y, -5.4, { height: 3.4 })
  K.lanternPost(L, 327.5, OBS_Y, 5.4, { height: 3.4 })

  L.finish = new THREE.Vector3(329.5, OBS_Y + 0.8, 0)

  // ---- Scenery: a floating archipelago, per docs/art-direction.md -------
  // The reference has no ground plane and no city — islands drift in open sky
  // above a cloud deck, at every distance from near to specks. Depth is the
  // headline effect, so these are seeded across three distance bands rather
  // than scattered uniformly: the eye reads scale from having near, mid and
  // far all present at once.
  //
  // Every one of these is `ghost: true`, which turns the whole prefab to
  // decor in one switch. That is safe here and ONLY here: the nearest band
  // sits 38 m off the running line and at least 10 m below it, so nothing
  // can be mistaken for a platform. Anything closer than that gets built with
  // the solid path above, no exceptions.
  const rand = makeRand(0xA11CE)

  const isle = (x, y, z, w, detail) => {
    const d = w * (0.78 + rand() * 0.44)
    const stone = rand() > 0.45 ? 'stone' : 'terracotta'
    K.drumPlatform(L, x, y, z, {
      radius: w / 2,
      squash: d / w,
      facets: facetsFor(w, d),
      capKind: 'moss',
      rimKind: stone,
      kind: stone,
      boulderKind: 'stone',
      detail,
      ghost: true,
      rand,
    })
    return { x, y, z, w, d }
  }

  // Near band — big enough to show a profile: cypress stands, vines off the
  // underside, the occasional waterfall and a brass ornament on the skyline.
  for (let i = 0; i < 16; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const x = -20 + rand() * 380
    const z = side * (38 + rand() * 55)
    const y = -10 - rand() * 22
    const w = 14 + rand() * 20
    const a = isle(x, y, z, w, 2)
    const n = 1 + ((rand() * 3) | 0)
    for (let c = 0; c < n; c++) {
      K.cypress(L, x + (rand() - 0.5) * a.w * 0.5, y,
        z + (rand() - 0.5) * a.d * 0.5, { height: 5 + rand() * 7, rand })
    }
    K.vineCurtain(L, x - a.w * 0.25, y - 0.5, z + side * a.d * 0.44,
      { length: a.w * 0.5, drop: 5 + rand() * 4, rand, ghost: true })
    if (rand() > 0.45) {
      K.waterfall(L, x + (rand() - 0.5) * a.w * 0.4, y - 0.4, z - side * a.d * 0.46,
        { height: 22 + rand() * 26, width: 1.4 + rand(), rand })
    }
    // Brass is the signature material of this world and should be visible at
    // every distance, so half the near islands carry a machine on the skyline.
    if (rand() > 0.5) {
      K.armillary(L, x + (rand() - 0.5) * a.w * 0.3, y, z, {
        radius: 2 + rand() * 2.4, detail: 1, ghost: true, rand,
      })
    } else if (rand() > 0.35) {
      K.gearWheel(L, x, y + 4 + rand() * 4, z, {
        radius: 2.4 + rand() * 2.6, plane: rand() > 0.5 ? 'xy' : 'zy',
        spokes: 6, detail: 1, ghost: true,
      })
    }
  }

  // Mid band — reads as structure, not detail. One observatory out here gives
  // the eye something to name, which is what stops a haze full of rocks from
  // reading as noise.
  for (let i = 0; i < 26; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const x = -70 + rand() * 520
    const z = side * (95 + rand() * 90)
    const y = -6 - rand() * 60
    const w = 16 + rand() * 26
    isle(x, y, z, w, 1)
    if (rand() > 0.62) {
      K.cypress(L, x + (rand() - 0.5) * w * 0.4, y, z, { height: 7 + rand() * 6, detail: 1, rand })
    }
    if (rand() > 0.86) {
      K.observatoryDome(L, x, y, z, {
        radius: 3.4 + rand() * 2, wallHeight: 4 + rand() * 3,
        detail: 1, ghost: true, rand,
      })
    }
  }

  // Far band — silhouette only, dissolving into the golden haze.
  for (let i = 0; i < 34; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const x = -200 + rand() * 800
    const z = side * (200 + rand() * 340)
    const y = 30 - rand() * 150
    const w = 22 + rand() * 46
    isle(x, y, z, w, 0)
    // The occasional distant spire, like the reference's far towers.
    if (rand() > 0.66) {
      L.decor(x + (rand() - 0.5) * w * 0.4, y + 12 + rand() * 8, z,
        w * 0.16, 22 + rand() * 26, w * 0.16, 'terracotta')
    }
  }

  K.assertAllPlaced()
  return L
}
