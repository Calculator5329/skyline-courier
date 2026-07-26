import * as THREE from 'three'
import {
  lathe, extrudeAlong, sweepTube, gear as gearPlate, blob, chamferBox,
  arch as archRing, corniceShape, mergeGeometries,
} from './props.js'
import {
  FoliageField, scatterOnBox, hangFromEdge, vineRope, JUNCTION_MIX,
} from './foliage.js'
import { LOOK_LEVELS, readLook, setLook } from './render/quality.js'

// ------------------------------------------------------------------- the LOOK
//
// One A/B switch for "which generation of the art the world is built from" —
// see the LOOK section of src/render/quality.js for the full argument and the
// three ways it is set. kit.js is where a look is CONSUMED, because the two
// things a look rolls back both live here: the foliage channel and the curve
// geometry. The default (`modern`) makes both gates below no-ops, so a world
// nobody re-looked is byte-identical to today's.
//
// Read once and memoised: the look cannot change without a reload (the course
// is built once at boot), so re-reading the URL per plant would be wasted work.
let _look
function activeLook() {
  if (_look === undefined) _look = readLook()
  return _look
}
/** Whether the vegetation channel is allowed to plant anything this build. */
function foliageEnabled() { return LOOK_LEVELS[activeLook()].foliage }
/** Whether prefabs draw real curves, or fall back to their box silhouette. */
function curvesEnabled() { return LOOK_LEVELS[activeLook()].curves }

/**
 * A view of a Level with its `mesh` channel hidden.
 *
 * `curves: false` (the `legacy` look) turns the whole shared kit blocky by the
 * cleanest lever there is: it hands every prefab the exact Level the node
 * self-test sees — one with no `mesh()` — so each one takes its already-written
 * box fallback, where the collider box is drawn as the visible surface. Nothing
 * about a prefab's logic changes; it simply cannot reach the curve channel.
 *
 * A prototype view rather than a mutated Level: reads of `solid`, `decor`,
 * `group`, `lantern`, `__kitFoliage`, … fall through to the real Level, and the
 * only own property is a `mesh` shadowed to `undefined`. One view per Level
 * (memoised in `trackedKit`) so foliage bookkeeping stays on one object.
 */
function lookMeshless(L) {
  const v = Object.create(L)
  v.mesh = undefined
  return v
}

// Console channel for the A/B, exposed the moment this module loads (main.js
// reassigns `window.__game` wholesale after boot, so a global is the one place
// a patch here survives). `window.setLook('legacy')` then reload; the URL form
// `?look=legacy` needs no console at all.
if (typeof window !== 'undefined') {
  try {
    window.setLook = (name) => setLook(name)
    window.getLook = () => readLook()
    window.LOOK_LEVELS = LOOK_LEVELS
  } catch { /* sandboxed window */ }
}

/**
 * kit.js — architectural prefabs for the sky-garden archipelago.
 *
 * Collision comes from exactly two primitives, `L.solid()` and `L.decor()` in
 * `level.js`, so geometry and collision can never drift (CLAUDE.md #2). This
 * file touches no DOM and calls no `Math.random()` — the world is identical on
 * every reload.
 *
 * WHAT CHANGED, AND WHY IT DID NOT BREAK THE INVARIANT (2026-07-25 art review):
 * this file used to draw every curve as a staircase of axis-aligned boxes.
 * That is the single most recognisable amateur-3D tell there is, and the
 * review named it three times over: a gear rim rasterised into a pixel-art
 * disc, an arch with a sawtooth intrados instead of radiating voussoirs, and
 * a row of cubes where turned balusters belong.
 *
 * The fix is docs/geometry-unlock.md's: keep the invariant, break the
 * representation link. Curves are now real generated geometry handed to
 * `L.mesh()`, which is VISUAL-ONLY and can never create a collider. Where a
 * curve sits at a height a player can reach, the prefab still declares an
 * honest AABB with `L.solid(..., { hidden: true })` and keeps the drawn curve
 * inside it. Where it does not — gear ornament, orrery rings, foliage — there
 * is no collider to reconcile in the first place.
 *
 * THE RULE, restated because it is the bug that killed the predecessor:
 * a surface the player can see and could plausibly stand on is `solid`.
 * `decor` is reserved for things clearly out of reach or clearly not a
 * platform — hanging vines, waterfalls, ornament above head height,
 * distant scenery. Every prefab below documents which parts are which and
 * why. When a prefab is placed far from the route purely as scenery, pass
 * `{ ghost: true }` and *every* box becomes decor in one switch, rather
 * than each prefab guessing at reachability.
 *
 * Silhouette policy (docs/art-direction.md, and Ethan's "a bit less
 * minecraft blocky look please"): curves are approximated as the union of
 * several inscribed axis-aligned rectangles — an octagon or dodecagon read,
 * never a single cube — and masses are chamfered by stacking slightly
 * inset courses. Because the union of the *visible* boxes is also the union
 * of the *collision* boxes, a faceted platform's footprint always equals its
 * collider. The art-direction caveat is honoured by construction: we never
 * inscribe a small collider inside a wide visible disc.
 *
 * Cost control: expensive prefabs take `detail` (0 = far silhouette,
 * 1 = mid, 2 = near, the default). The level places these across four
 * distance bands; band 3 should generally use `detail: 0, ghost: true`.
 *
 * ROUND THREE (2026-07-25 art direction review). Six findings, and where each
 * one is answered:
 *
 *  1. "Every island is the same island." `discRects()` now takes the prefab's
 *     seeded `rand` and pulls each facet INWARD by 8-12%; `drumPlatform` varies
 *     tier count, per-tier inset and — on scenery only — the footprint aspect.
 *     See `discRects` for the proof that the union never grows.
 *  2. "Voxel undersides." The boulder tiers are `props.blob()` at full 3-axis
 *     orientation, drawn inside hidden colliders. No cuboid is left down there.
 *  3. "Moss caps read as snooker tables." `mossCapGeometry()` — real thickness,
 *     an irregular outline, a 10-15 cm overhang with a hard-darkened underside,
 *     and a relief-broken top.
 *  4. "Bare architecture." Every prefab dresses itself out of `foliage.js`;
 *     see THE FOLIAGE CHANNEL below.
 *  5. "Unchamfered edges." Every nosing, cornice and string course gets a
 *     3-5 cm bevel course; mouldings are swept sections, not stacked slabs.
 *  6. "Real curves." `props.arch` voussoirs, `props.gear` involute teeth,
 *     `props.lathe` shafts and domes, `props.extrudeAlong` cornices.
 *
 * ============================ THE FOLIAGE CHANNEL ==========================
 * `foliage.js` draws instanced alpha-tested cards, which the `L.mesh()` batch
 * (one opaque merged geometry per material) structurally cannot carry. So the
 * kit owns a small pool of `FoliageField`s, hung off the Level, bucketed by
 * world position so each one is a separately-cullable draw call, and flushed
 * into `L.group` by `trackedKit().assertAllPlaced()` — which `buildCourse()`
 * already calls as its last act, before `Level.build()` runs.
 *
 * Every path through it is guarded and failure-tolerant: the atlas is painted
 * on a canvas, so there is no field at all under node (`kitSelfTest`), and a
 * throw anywhere in the vegetation layer must never take the course down. A
 * world with no plants is a disappointment; a world that does not load is a
 * bug. `kitFoliageStats(L)` reports what actually got planted.
 *
 * SAFETY: vegetation is decor with no collider, so it obeys taste.md's rule by
 * construction — cards are capped well under step height on anything walkable
 * (`DECK_PLANT_HEIGHT`), and hanging species only ever exist below a lip.
 */

// --------------------------------------------------------------- randomness

const DEFAULT_SEED = 0x5C0117

/** Deterministic xorshift32 in [0,1). Same seed, same world, every reload. */
export function makeRand(seed = DEFAULT_SEED) {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function pick(opts) {
  return opts.rand || makeRand(opts.seed ?? DEFAULT_SEED)
}

// ------------------------------------------------------------- the foliage
//
// See THE FOLIAGE CHANNEL in this file's header for why the kit owns this
// rather than level.js.

/**
 * Metres per field bucket.
 *
 * One field per island is what foliage.js asks for, and one field for the world
 * is what makes frustum culling a no-op. 96 m is the compromise the course
 * actually wants: the route is ~350 m of +X with the archipelago at |z| up to
 * ~100 m, which buckets into a dozen or so fields — each one a single draw call
 * covering about the distance the 55-90 m fade window already spans, so a
 * bucket that is off screen is genuinely off screen.
 */
const FOLIAGE_BUCKET = 96

/**
 * How tall a plant may be on a surface the player can stand on.
 *
 * taste.md: "Non-colliding scenery must never... visually impersonate a surface
 * you can land on." The controller vaults anything up to 1.45 m, so a 24 cm
 * card is not within an order of magnitude of a thing that could be read as a
 * ledge — it is unmistakably grass, at an eye height of 1.6 m. The first pass
 * ran 18 cm and measured invisible from the gameplay camera: too short to
 * catch the low sun, so a deck came back looking swept.
 */
const DECK_PLANT_HEIGHT = 0.24

/** Mostly grass and small leaf, with flowers as the accent. Never moss: a moss
 *  wedge belongs in a corner where water sits, not sprinkled over open paving. */
const DECK_MIX = [['grass', 6], ['flower', 1.3], ['leaf', 0.9], ['fern', 0.4]]
/** A damp, shaded bed — under an arch, beside a waterfall, on an island rim. */
const WILD_MIX = [['grass', 4], ['leaf', 2.4], ['fern', 1.6], ['flower', 1.0], ['ivy', 0.8]]

/**
 * The per-Level foliage state, created on first use.
 *
 * Returns `null` — permanently, and without retrying — in any environment that
 * cannot paint a canvas atlas or has no scene group to hang meshes off. That
 * covers `kitSelfTest()` under node, which must keep working.
 */
function foliageState(L) {
  if (!L || typeof L !== 'object') return null
  if (L.__kitFoliage !== undefined) return L.__kitFoliage
  let state = null
  if (L.group && typeof document !== 'undefined') {
    state = { fields: new Map(), planted: 0, failed: 0, built: false }
  }
  L.__kitFoliage = state
  return state
}

/**
 * The field covering a world position. One per 96 m bucket, made on demand so
 * an empty quadrant of the map costs nothing.
 */
function foliageAt(L, x, z) {
  const state = foliageState(L)
  if (!state || state.built) return null
  const bx = Math.floor(x / FOLIAGE_BUCKET)
  const bz = Math.floor(z / FOLIAGE_BUCKET)
  const key = `${bx}:${bz}`
  let f = state.fields.get(key)
  if (f === undefined) {
    try {
      // The seed is a function of the bucket, not a counter, so a field's
      // contents do not depend on the order islands happened to be built in.
      f = new FoliageField({ seed: (0x5EED1 ^ (bx * 0x9E3779B1) ^ (bz * 0x85EBCA6B)) >>> 0 })
    } catch (e) {
      f = null
      state.failed++
    }
    state.fields.set(key, f)
  }
  return f
}

/**
 * Run `fn(field)` for a position, counting what it planted and swallowing any
 * failure. The vegetation layer is never allowed to be the reason the course
 * fails to load — see this file's header.
 */
function plant(L, x, z, fn) {
  // The one gate the LOOK switch needs for vegetation: every plant in the world
  // — deck grass, moss junctions, hanging ivy — routes through here, so a look
  // with `foliage: false` empties the world of plants by returning before the
  // field is even touched. `modern` never trips it.
  if (!foliageEnabled()) return 0
  const f = foliageAt(L, x, z)
  if (!f) return 0
  try {
    const n = fn(f) || 0
    const state = foliageState(L)
    if (state) state.planted += n
    return n
  } catch (e) {
    const state = foliageState(L)
    if (state) state.failed++
    return 0
  }
}

/**
 * Build every field and hang it in the level's group. Called once, from
 * `trackedKit().assertAllPlaced()`.
 */
function foliageFinish(L) {
  const state = foliageState(L)
  if (!state || state.built) return state
  state.built = true
  for (const f of state.fields.values()) {
    if (!f) continue
    try {
      const g = f.build()
      // The wind clock. main.js drives every other time-varying effect from its
      // own loop; foliage.js exposes a module-level clock instead, and nothing
      // currently ticks it. Rather than leave every plant frozen at its rest
      // pose, each page advances the shared clock as it is about to be drawn —
      // one float write per draw call, in the one place kit.js is allowed to
      // reach. If main.js ever calls `foliageTick()` itself, this becomes a
      // redundant write of the same kind of value and nothing breaks.
      for (const m of g.children) {
        m.onBeforeRender = () => f.update(performance.now() / 1000)
      }
      L.group.add(g)
    } catch (e) {
      state.failed++
    }
  }
  // Published on the level's own group so the headless harness (and a dev
  // console, via `window.__game.level`) can read what the vegetation layer
  // actually cost without importing this module. A claim about lushness that
  // cannot be checked from a terminal is the kind of claim this project has
  // been burned by before.
  if (L.group) L.group.userData.kitFoliage = kitFoliageStats(L)
  return state
}

/** What the vegetation layer actually cost. Diagnostic; safe to call anywhere. */
export function kitFoliageStats(L) {
  const state = foliageState(L)
  if (!state) return { fields: 0, planted: 0, failed: 0, instances: 0, drawCalls: 0, triangles: 0 }
  let instances = 0, drawCalls = 0, triangles = 0
  for (const f of state.fields.values()) {
    if (!f || !f.group) continue
    const s = f.stats()
    instances += s.instances; drawCalls += s.drawCalls; triangles += s.triangles
  }
  return {
    fields: state.fields.size, planted: state.planted, failed: state.failed,
    instances, drawCalls, triangles,
  }
}

/**
 * Scatter plants over a FACETED DISC rather than a rectangle.
 *
 * `foliage.scatterOnBox` is the right tool for a rectangular deck and the wrong
 * one for a drum: the drum's collider is a union of rectangles, so scattering
 * over its bounding box drops plants into four corners that are open sky. This
 * is the same job with the union as the domain — rejection-sampled against the
 * exact `discRects` the platform was built from, so a plant can only ever exist
 * over something solid.
 *
 * The clump mask is the same idea as foliage.js's: a smooth low-frequency field
 * so vegetation grows in patches with bare ground between them. Two octaves of
 * hash lattice noise, evaluated per candidate — no allocation, deterministic.
 */
function scatterDisc(L, cx, y, cz, rects, squash, rand, opts = {}) {
  const {
    density = 5.0, mix = DECK_MIX, inset = 0.35, maxHeight = DECK_PLANT_HEIGHT,
    clump = 0.6, clumpScale = 2.4, max = 400, rimBias = 0.25,
  } = opts
  let hx = 0, hz = 0
  for (const q of rects) { if (q.hx > hx) hx = q.hx; if (q.hz > hz) hz = q.hz }
  if (hx <= inset || hz <= inset) return 0
  const circ = rects.map((q) => ({ hx: q.hx, hz: q.hz / (squash || 1) }))
  // Area of the bounding box is an over-estimate of the union's, and the
  // rejection test below removes the difference — so the attempt count is
  // scaled by the disc's own fill fraction (pi/4 for a near-circle) to land on
  // the requested plants per square metre rather than 27% over it.
  const area = 4 * hx * hz * 0.82
  const attempts = Math.min(max, Math.max(1, Math.round(opts.count ?? area * density)))
  const seed = ((rand() * 0xffffffff) >>> 0) || 1

  return plant(L, cx, cz, (field) => {
    let placed = 0
    for (let i = 0; i < attempts; i++) {
      // Radial warp toward the rim: the reference's islands are green at the
      // edge and worn in the middle where people walk.
      const w = (t) => {
        const c = t * 2 - 1
        return Math.sign(c) * Math.pow(Math.abs(c), 1 - rimBias * 0.6) * 0.5 + 0.5
      }
      const px = (w(rand()) * 2 - 1) * hx
      const pz = (w(rand()) * 2 - 1) * hz
      // Inside the union, with an inset so no card overhangs the collider.
      const th = Math.atan2(pz / (squash || 1), px)
      const rU = unionRadiusAt(circ, th)
      const rr = Math.hypot(px, pz / (squash || 1))
      if (rr > rU - inset) continue
      const m = 1 - clump + clump * clumpNoise((cx + px) / clumpScale, (cz + pz) / clumpScale, seed)
      if (rand() > m) continue
      const species = pickWeighted(mix, rand())
      field.add(species, cx + px, y, cz + pz, { height: 0.5 * maxHeight + rand() * 0.5 * maxHeight })
      placed++
    }
    return placed
  })
}

/**
 * THE MOSS WEDGE, as vegetation rather than as a new geometry primitive.
 *
 * docs/roadmap.md wants moss creeping out of every wall/floor junction; the
 * shader term for it landed and measured invisible. A narrow strip of
 * `JUNCTION_MIX` along the base of the wall is the geometry half, and it is a
 * `scatterOnBox` call rather than a kit primitive because foliage.js already
 * ships the mix and the ledge guard for exactly this.
 *
 * @param {object} edge `{ x, y, z, axis, length, width }` — the junction line,
 *        `y` the floor height, `width` how far the moss creeps out (0.35 m).
 */
function mossJunction(L, edge, opts = {}) {
  const { x, y, z, axis = 'x', length = 4, width = 0.38 } = edge
  if (length <= 0.4) return 0
  const alongX = axis === 'x'
  const cx = x + (alongX ? length / 2 : 0)
  const cz = z + (alongX ? 0 : length / 2)
  return plant(L, cx, cz, (field) => scatterOnBox(field, {
    cx, cy: y, cz, sx: alongX ? length : width, sy: 0, sz: alongX ? width : length,
  }, {
    mix: JUNCTION_MIX,
    density: opts.density ?? 5.5,
    inset: 0.04,
    clump: 0.42,
    clumpScale: 1.4,
    edgeBias: 0,
    maxHeight: opts.maxHeight ?? 0.24,
    y,
  }))
}

/** Drape hanging ivy off a straight lip. Thin wrapper so prefabs read cleanly. */
function drape(L, edge, opts = {}) {
  return plant(L, edge.x, edge.z, (field) => hangFromEdge(field, edge, opts))
}

/**
 * Drape ivy along the ACTUAL boundary polygon of a faceted platform.
 *
 * Draping four cardinal chords instead measured wrong in two directions at
 * once: a chord at the full X extent runs past the corners of the union, so
 * strands ended up hanging in open sky beyond the island (visible in gaps.png
 * as loose leaves floating off the right-hand rim), and a chord pulled in far
 * enough to avoid that buries itself inside the drum, where it is invisible
 * except where it pokes through. The outline polygon is neither: every segment
 * of it is a real edge of the real footprint, so every strand grips stone.
 *
 * `outline` is what `discOutline()` returns — a CCW loop, so the outward
 * normal of the segment a→b is (dz, -dx).
 */
function drapeOutline(L, cx, y, cz, outline, opts = {}) {
  const minRun = opts.minRun ?? 0.9
  let placed = 0
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length]
    const dx = b[0] - a[0], dz = b[1] - a[1]
    const len = Math.hypot(dx, dz)
    if (len < minRun) continue
    const alongX = Math.abs(dx) >= Math.abs(dz)
    // Only the axis-aligned runs, which on a staircase outline is all of them
    // except the corner chamfers — and a 12 cm chamfer is not worth a strand.
    if (alongX ? Math.abs(dz) > len * 0.3 : Math.abs(dx) > len * 0.3) continue
    // Outward normal of a CCW segment is (dz, -dx). `hangFromEdge` offsets
    // along Z for an X-run and along X for a Z-run, so it wants that normal's
    // component on the perpendicular axis.
    const outward = alongX ? Math.sign(-dx) || 1 : Math.sign(dz) || 1
    // It also marches in the POSITIVE axis direction from its anchor, so hand
    // it whichever end of the segment is lower on that axis.
    const s = alongX ? (dx >= 0 ? a : b) : (dz >= 0 ? a : b)
    placed += drape(L, {
      x: cx + s[0], y, z: cz + s[1],
      axis: alongX ? 'x' : 'z',
      length: len,
      outward,
    }, opts)
  }
  return placed
}

/** Weighted pick from `[[key, weight], ...]`. */
function pickWeighted(mix, r) {
  let total = 0
  for (const m of mix) total += m[1]
  let t = r * total
  for (const m of mix) { t -= m[1]; if (t <= 0) return m[0] }
  return mix[mix.length - 1][0]
}

/**
 * Smooth 0..1 lattice noise. Value noise on an integer hash, two octaves,
 * quintic fade — the cheapest thing that makes a density mask read as patches
 * of ground rather than as film grain.
 */
function clumpNoise(x, z, seed) {
  return 0.65 * valueNoise(x, z, seed) + 0.35 * valueNoise(x * 2.7 + 11.3, z * 2.7 - 4.1, seed ^ 0x9e37)
}

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z)
  const fx = x - x0, fz = z - z0
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10)
  const a = hash2(x0, z0, seed), b = hash2(x0 + 1, z0, seed)
  const c = hash2(x0, z0 + 1, seed), d = hash2(x0 + 1, z0 + 1, seed)
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
}

function hash2(x, z, seed) {
  let h = (x * 374761393 + z * 668265263 + seed) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * The two emitters, with the `ghost` switch applied once.
 * `S` is solid unless the caller declared the whole prefab unreachable.
 */
function emit(L, opts) {
  // Far scenery gets no chamfer. A 4.5 cm arris at 300 m is a fraction of a
  // pixel, so it is 32 triangles per box buying nothing; `detail: 0` is
  // already this kit's word for "silhouette only".
  const flat = opts.detail === 0 ? { bevel: 0 } : undefined
  const merge = (o) => (flat && !o ? flat : (flat && o ? { ...o, bevel: 0 } : o))
  const D = (cx, cy, cz, sx, sy, sz, k, o) => {
    L.decor(cx, cy, cz, sx, sy, sz, k, merge(o)); return 1
  }
  if (opts.ghost) return { S: D, D }
  const S = (cx, cy, cz, sx, sy, sz, k, o) => {
    L.solid(cx, cy, cz, sx, sy, sz, k, merge(o)); return 1
  }
  return { S, D }
}

// ------------------------------------------------- generated curve geometry
//
// Everything below produces a THREE.BufferGeometry for `L.mesh()`. None of it
// can create a collider, by construction — see this file's header.

const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _pos = new THREE.Vector3()
const _one = new THREE.Vector3(1, 1, 1)
// Scratch scale, for the one thing that genuinely needs it: squashing a
// revolved solid onto an elliptical footprint. Read by `Matrix4.compose`
// inside `place()` before anything else can touch it.
const _sc = new THREE.Vector3(1, 1, 1)

/**
 * A shape authored in XY and extruded along +Z, turned to face out of one of
 * the three axis planes: 'xy' faces +Z (a gear on a wall), 'zy' faces +X,
 * 'xz' lies flat like a turntable.
 */
function planeQuat(plane, spin = 0) {
  if (plane === 'zy') _e.set(0, -Math.PI / 2, spin, 'YXZ')
  else if (plane === 'xz') _e.set(-Math.PI / 2, 0, spin, 'YXZ')
  else _e.set(0, 0, spin, 'YXZ')
  return new THREE.Quaternion().setFromEuler(_e)
}

function place(x, y, z, quat, scale = _one) {
  return new THREE.Matrix4().compose(_pos.set(x, y, z), quat, scale)
}

/**
 * A random orientation on all three axes.
 *
 * The review's second finding was that the only rotation anywhere in this file
 * was `{ axis: 'y' }`, and "a Y-rotated cuboid is still a cuboid" — its top and
 * bottom stay horizontal, so the countable-cubes read survives the rotation
 * that was added to hide it. Anything that carries no collision constraint can
 * and should be turned in three axes.
 *
 * Uniform over the sphere via the standard subgroup construction, so a stand of
 * boulders has no preferred pole.
 */
function orient3(rand) {
  const u1 = rand(), u2 = rand(), u3 = rand()
  const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1)
  return new THREE.Quaternion(
    s1 * Math.sin(2 * Math.PI * u2), s1 * Math.cos(2 * Math.PI * u2),
    s2 * Math.sin(2 * Math.PI * u3), s2 * Math.cos(2 * Math.PI * u3))
}

/** A lathe from a (radius, height) profile, via props.js. */
function latheGeometry(profile, segments, opts) {
  return lathe(profile, { segments, ...opts })
}

/**
 * The union radius of a faceted disc at one azimuth, in circular space (the
 * caller has already divided the squash out of `hz`).
 */
function unionRadiusAt(rects, theta) {
  const c = Math.abs(Math.cos(theta)), s = Math.abs(Math.sin(theta))
  let best = 0
  for (const q of rects) {
    const t = Math.min(c > 1e-6 ? q.hx / c : Infinity, s > 1e-6 ? q.hz / s : Infinity)
    if (t > best) best = t
  }
  return best
}

/**
 * THE MOSS CAP — the turf mat that is the top of every island.
 *
 * WHAT WAS WRONG (art review, 2026-07-25): "moss caps read as snooker tables".
 * The cap was a union of flat boxes at one height with a separate skirt band
 * tacked round it, which produced three separate failures at once — a
 * perfectly flat top with no relief, hard triangular gussets where the skirt
 * bulged past the stepped union at the facet corners, and a lip that stood
 * proud of the collider and so presented as a walkable ledge from above.
 *
 * This is one closed mat instead, with five rings of section:
 *
 *   0  the crown, `relief` below y at most, domed and noise-broken
 *   1  the outer top edge, at the outline radius
 *   2  the arris, one bevel down and in — MATCHED TO level.js's own 4.5 cm box
 *      chamfer, which is what kills the corner-gusset read: the cap and the
 *      drum under it now turn their edges over by the same amount
 *   3  the bottom of the fascia, a full `thickness` below the top
 *   4  the underside, tucked back in to `inner` — this is the 10-15 cm
 *      overhang band, and because its normal points down, level.js's mesh path
 *      darkens it to 0.72 automatically. That contact shadow is what makes the
 *      cap read as a mat GROWING OVER a rock rather than a plate resting on it
 *
 * THE COLLISION CONTRACT, in three steps that are each individually provable:
 *   1. `discOutline()` walks the exact boundary of the collider's own rectangle
 *      union, so the starting polygon IS the footprint, not an approximation.
 *   2. It is scaled by `pull` <= 0.99. Scaling a union of origin-centred
 *      rectangles by k <= 1 gives a subset of itself, whatever the facets are.
 *   3. Every ring is a further radial scale <= 1 of that, and the union is
 *      star-shaped about its centre.
 * So no vertex can be outside the collider — inset, never overhang, which is
 * docs/geometry-unlock.md's rule. The old skirt broke it; nothing here can.
 * Audited by `kitSelfTest`, which measures a 6 m drum at exactly 12 m across.
 *
 * TOP RELIEF. `relief` is subtracted, never added — the walkable plane and the
 * collider's top face are both `y`, so a crown that bulged upward would put
 * visible turf above the surface you stand on — and it is biased so the peaks
 * reach exactly `y` rather than stopping below it. See the `dip` mapping.
 */
/**
 * The exact outline of a faceted disc's union, as a closed CCW polygon in XZ.
 *
 * WHY NOT SAMPLE IT RADIALLY. The union of N nested rectangles is a STAIRCASE,
 * not a curve. Sampling `unionRadiusAt` at uniform angles and joining the
 * samples cuts diagonally across every step, so each step's re-entrant corner
 * becomes a sharp V — which is exactly what the first cut of the moss cap came
 * back with, and it is a worse artefact than the stepped edge it was trying to
 * hide. Walking the staircase itself reproduces the footprint the collider
 * actually has, and the convex corners can then be chamfered (always inward,
 * so always legal) to turn the 90-degree arrises over.
 *
 * `inset` is METRES, applied as a per-point radial scale k = 1 - inset/len.
 * Any k <= 1 keeps the point inside the union (the union of origin-centred
 * rectangles is star-shaped about the origin), so this is safe by the same
 * argument a global scale was — but it no longer costs a fraction of the
 * RADIUS. A global 0.99 pull is 1% of half-span, which is 3 cm on a 6 m drum
 * and 15 cm on the 30 m terrace, and the moss cap's 0-2% jitter on top of it
 * reached 0.45 m of deck that the player stands on and cannot see. An inset is
 * a manufacturing clearance; it is the same two centimetres at every scale.
 *
 * NO `squash` PARAMETER, DELIBERATELY. `discRects` already puts the squash in
 * `hz` — it is the collider's own half-extent, not a circular one — so this
 * function taking a squash and multiplying by it again applied it TWICE. Every
 * caller passed the same squash it had just given `discRects`, so on the route
 * decks (`deck()` in level.js is where squash comes from; the terrace is
 * 10.4 m across a 30 m span, squash 0.35) the drawn cap, rim, drum and ivy
 * were all a THIRD of the deck's real width in Z while the collider stayed
 * full width. Measured by `tools/hollow.mjs`: 4.55 m of turf missing from the
 * side of a 16 m deck, which is the "between the main path and the guardrail
 * it's completely transparent" Ethan reported and which da98a78 diagnosed only
 * half of — the lathe was a circle AND it was squashed twice.
 *
 * @returns {Array<[number,number]>} points, with `.len` (radius per point) set.
 */
function discOutline(rects, inset, chamfer) {
  const n = rects.length
  // One quadrant, from the +X axis round to the +Z axis.
  const quad = [[rects[0].hx, 0]]
  for (let i = 0; i < n; i++) {
    quad.push([rects[i].hx, rects[i].hz])
    if (i + 1 < n) quad.push([rects[i + 1].hx, rects[i].hz])
  }
  quad.push([0, rects[n - 1].hz])

  // Mirror into four quadrants, dropping the shared axis points.
  const loop = []
  const push = (px, pz) => {
    const last = loop[loop.length - 1]
    if (!last || Math.abs(last[0] - px) > 1e-6 || Math.abs(last[1] - pz) > 1e-6) loop.push([px, pz])
  }
  for (const [px, pz] of quad) push(px, pz)
  for (let i = quad.length - 1; i >= 0; i--) push(-quad[i][0], quad[i][1])
  for (let i = 0; i < quad.length; i++) push(-quad[i][0], -quad[i][1])
  for (let i = quad.length - 1; i >= 0; i--) push(quad[i][0], -quad[i][1])
  if (loop.length > 1) {
    const a = loop[0], b = loop[loop.length - 1]
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) loop.pop()
  }

  // Chamfer every CONVEX corner. Cutting a convex corner only ever removes
  // area, so this can never push the outline outside the union; concave
  // corners are left alone precisely because cutting one would.
  const out = []
  const M = loop.length
  for (let i = 0; i < M; i++) {
    const p = loop[i], a = loop[(i - 1 + M) % M], b = loop[(i + 1) % M]
    const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])
    const la = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1
    const lb = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1
    // CCW winding makes a left turn (cross > 0) the convex case.
    const c = cross > 0 ? Math.min(chamfer, la * 0.45, lb * 0.45) : 0
    if (c > 1e-4) {
      out.push([p[0] - (p[0] - a[0]) / la * c, p[1] - (p[1] - a[1]) / la * c])
      out.push([p[0] + (b[0] - p[0]) / lb * c, p[1] + (b[1] - p[1]) / lb * c])
    } else {
      out.push([p[0], p[1]])
    }
  }
  for (const p of out) {
    const len = Math.hypot(p[0], p[1]) || 1e-6
    const k = Math.max(0.5, 1 - inset / len)
    p[0] *= k; p[1] *= k
  }
  return out
}

/**
 * How far to cut the union's convex corners off when drawing it.
 *
 * BOUNDED IN METRES, and that bound is the point. Cutting a corner with legs
 * of length c leaves the collider's actual corner 0.707 c outside the drawn
 * edge — a ledge you stand on with nothing under it. At `hx * 0.07` that was
 * 1.26 m on the largest islands, measured by `tools/hollow.mjs`; the ceiling
 * holds it under 0.16 m everywhere, which is the same order as the cap's own
 * overhang and an order below anything a player can stand on.
 *
 * The floor still tracks `bevel`, because the chamfer's job on a small drum is
 * to turn the union's 90-degree steps over by the SAME amount level.js turns
 * the box arrises over — matching those two is what killed the corner gussets
 * the art review found.
 */
function cornerChamfer(rects, bevel) {
  return Math.min(0.22, Math.max(bevel * 2.6, rects[0].hx * 0.07))
}

function mossCapGeometry(rects, thickness, overhang, bevel, rand) {
  // 2 cm of guaranteed clearance, so the mat's outer face is inside the
  // collider rather than exactly on it, plus 0-4 cm per island so no two caps
  // are the same size at the same radius.
  //
  // ABSOLUTE, not a percentage. This was `0.99 - rand() * 0.02` — up to 3% of
  // the half-span — which is 4 cm on a 3 m drum but 0.45 m on the 30 m
  // terrace, and that 0.45 m is deck the player walks on with nothing drawn
  // under it. Variation in a silhouette should not be paid for in collision
  // honesty; the facet jitter in `discShape` is where island-to-island
  // variation belongs, and it varies the COLLIDER too.
  const inset = 0.02 + rand() * 0.04
  // The chamfer that turns the outline's corners over. It is asked for large
  // and clamped by `discOutline` to 45% of the shorter of the two edges at
  // each corner, which is what turns the union's 90-degree steps into a
  // faceted, roughly octagonal rim instead of a jigsaw edge. The corner
  // gussets the review saw were the cap and the drum below it turning their
  // arrises over by different amounts; both are now driven by `bevel`.
  const outline = discOutline(rects, inset, cornerChamfer(rects, bevel))
  const M = outline.length
  const relief = Math.min(0.10, thickness * 0.42)
  const nSeed = ((rand() * 0xffffff) | 0) || 1
  const pos = [], uv = [], idx = []
  const RINGS = 5

  let arc = 0
  for (let i = 0; i < M; i++) {
    const p = outline[i]
    const prev = outline[(i - 1 + M) % M]
    if (i > 0) arc += Math.hypot(p[0] - prev[0], p[1] - prev[1])
    const len = Math.hypot(p[0], p[1]) || 1e-6
    // Inward offsets expressed as radial scales — the outline is star-shaped
    // about the centre, so scaling toward it always stays inside.
    const kBev = Math.max(0.55, 1 - bevel / len)
    const kIn = Math.max(0.5, 1 - overhang / len)
    // Crown relief. Real turf is not a plane, and shape is the ONLY channel
    // the kit has for breaking the top: `level.js`'s mesh path derives its
    // vertex tint from world height and normal, and does not read a geometry
    // colour attribute, so per-vertex VALUE has to come from per-vertex SHAPE.
    // A few centimetres of lattice noise is what stops the cap shading as one
    // flat plate, which was the snooker-table read.
    //
    // BIASED SO THE PEAKS TOUCH ZERO. Measured: an unbiased dip put the whole
    // crown 2.5-10 cm BELOW the collider's top face, so the player walked four
    // centimetres above the visible turf — the same class of error as a
    // floating platform, just small enough to be missed by eye. Mapping the
    // noise through max(0, n - 0.35) leaves a third of the mat flat at exactly
    // the walking plane and dips the rest away from it, which is both correct
    // and what turf between clumps actually does.
    const dip = (n) => -relief * Math.max(0, n - 0.35) / 0.65
    const hInner = dip(clumpNoise(p[0] * 0.35, p[1] * 0.35, nSeed))
    const hMid = dip(clumpNoise(p[0] * 0.8, p[1] * 0.8, nSeed))
    const ring = [
      [0.5, hInner, 0],
      [kBev, hMid, 1],
      [1, hMid - bevel, 2],
      [1, -thickness + bevel * 0.5, 3],
      [kIn, -thickness - overhang * 0.35, 4],
    ]
    for (const [k, h, v] of ring) {
      pos.push(p[0] * k, h, p[1] * k)
      uv.push(arc, v * 0.35)
    }
  }
  for (let i = 0; i < M; i++) {
    const a = i * RINGS, b = ((i + 1) % M) * RINGS
    for (let k = 0; k < RINGS - 1; k++) {
      idx.push(a + k, b + k, b + k + 1, a + k, b + k + 1, a + k + 1)
    }
  }
  // Close the crown with a fan.
  const centre = pos.length / 3
  pos.push(0, -relief * 0.5, 0)
  uv.push(0, 0)
  for (let i = 0; i < M; i++) {
    idx.push(centre, ((i + 1) % M) * RINGS, i * RINGS)
  }
  // AND CLOSE THE UNDERSIDE. This used to say the inner ring was "covered by
  // the rim course directly beneath it — capping it would spend triangles on a
  // face no camera reaches". Both halves of that are wrong at detail 2, which
  // is the near band: the rim there is a swept CORNICE ~0.2 m wide at the very
  // edge, not a disc, so the annulus between it and the drum below (0.9 R to
  // R - overhang, over a metre on a big island) is open sky, and what the
  // camera meets looking up through it is the BACK of the crown, which is
  // culled. `tools/backface.mjs` caught it as the last see-through ray in the
  // `underside` shot: moss at [48.3, 0, 1.9], 47 m out and straight overhead.
  // M triangles per island, once.
  const under = pos.length / 3
  pos.push(0, -thickness - overhang * 0.35, 0)
  uv.push(0, 0)
  for (let i = 0; i < M; i++) {
    idx.push(under, i * RINGS + 4, ((i + 1) % M) * RINGS + 4)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

/**
 * Loft a (radial scale, height) profile around a closed outline.
 *
 * WHY THIS EXISTS. `lathe` revolves a profile about the axis, so it always
 * produces a circle — or, scaled, an ellipse. Every other course of a
 * `drumPlatform` follows `discOutline`, which is a chamfered RECTANGLE UNION.
 * An ellipse inscribed in a rectangle touches it only at four points, so the
 * cap above was overhanging thin air everywhere else: measured on the terrace,
 * 0.52 m unsupported at mid-span and 3.94 m near the ends. Ethan, playing:
 * "if you go below any of the floating platforms it looks like they're HOLLOW
 * ... I can SEE UP THROUGH the platforms".
 *
 * That was NOT a winding or a cap-flag bug — `tools/backface.mjs` shows
 * DoubleSide does not repaint those pixels, which is the signature of geometry
 * that is absent rather than facing away. Lofting the same profile around the
 * island's own outline makes the drawn body agree with the collider it is
 * hidden behind, which is the actual invariant.
 *
 * `outline` is the closed [x, z] loop, ordered +X toward +Z (as `discOutline`
 * emits it). `profile` is `[[k, y], ...]` BOTTOM TO TOP, where `k` scales the
 * outline radially — the loop is star-shaped about the origin, so a scale of
 * k <= 1 can never leave the collider.
 */
function loftOutline(outline, profile, opts = {}) {
  const M = outline.length
  const R = profile.length
  const pos = [], uv = [], idx = []

  let arc = 0
  for (let i = 0; i < M; i++) {
    const p = outline[i]
    const prev = outline[(i - 1 + M) % M]
    if (i > 0) arc += Math.hypot(p[0] - prev[0], p[1] - prev[1])
    for (const [k, y] of profile) {
      pos.push(p[0] * k, y, p[1] * k)
      uv.push(arc, y)
    }
  }
  for (let i = 0; i < M; i++) {
    const a = i * R, b = ((i + 1) % M) * R
    for (let k = 0; k < R - 1; k++) {
      // Outward, worked rather than guessed. `discOutline` runs +X toward +Z,
      // which is clockwise seen from above, so the wall quad has to go up the
      // profile FIRST and round the loop second: (a, a+1, b+1, b). Wound the
      // other way every island turns inside out, which is exactly the failure
      // this function exists to fix.
      idx.push(a + k, a + k + 1, b + k + 1, a + k, b + k + 1, b + k)
    }
  }
  // Close the bottom. The tiers hung under an island are inset and narrower
  // than it, so without this the ring is an open tube and the sky is visible
  // straight up through the middle of it from underneath.
  if (opts.capBottom ?? true) {
    const y0 = profile[0][1], k0 = profile[0][0]
    const centre = pos.length / 3
    pos.push(0, y0, 0)
    uv.push(0, 0)
    for (let i = 0; i < M; i++) {
      const p = outline[i], q = outline[(i + 1) % M]
      const ai = pos.length / 3
      pos.push(p[0] * k0, y0, p[1] * k0, q[0] * k0, y0, q[1] * k0)
      uv.push(p[0], p[1], q[0], q[1])
      idx.push(centre, ai, ai + 1)          // fans forward => -Y, a floor seen from below
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

// ----------------------------------------------------------- shape helpers

/**
 * Half-extents of N rectangles whose union approximates a disc.
 *
 * `r` is the half-width ACROSS FLATS: the union's extent on X is always
 * exactly 2r whatever the facet count, so a platform never changes size
 * when its LOD changes — the facets only chamfer the corners off the
 * square. facets 1 is that square, 2 an octagon, 3 a dodecagon, 4+ reads as
 * a circle at platform scale. Every rectangle's corners lie on one common
 * circle, so the silhouette is a convex polygon rather than a stepped cross.
 *
 * ======================= WHY THIS TAKES A `rand` ==========================
 * The art review's sharpest single finding: "twelve identical silhouettes in
 * gaps.png". This function was fully deterministic in `r` and `facets`, so
 * every drumPlatform of a given radius was GEOMETRICALLY CONGRUENT — reuse
 * read as copy-paste, which docs/world-plan.md names as the thing that has to
 * stop before the world can get bigger.
 *
 * Each facet is now pulled INWARD by 8-12%, and inward is the whole safety
 * argument: the union is a subset of what it was, so the collider can only
 * ever shrink, never grow past what the caller reserved. There is no height at
 * which a jittered platform presents a surface its collider does not have,
 * because the visible boxes ARE the collider boxes.
 *
 * WHAT IS NEVER JITTERED: rect 0's `hx` and rect n-1's `hz`, which are the two
 * rectangles that set the union's extent across flats. Pinning them keeps
 * `radius` an exact promise — a 10.4 m deck stays 10.4 m across, so no jump on
 * the route changes length — while every facet BETWEEN them moves, which is
 * where the silhouette lives. `aspect` is the caller's opt-in to varying the
 * overall footprint too, and level.js only passes it on scenery.
 */
function discRects(r, facets = 3, squash = 1, shape = null) {
  const n = Math.max(1, Math.min(6, facets | 0))
  const R = r / Math.cos((Math.PI / 2) * (0.5 / n))
  const ax = shape ? shape.aspect[0] : 1
  const az = shape ? shape.aspect[1] : 1
  const j = shape ? shape.facet : null
  const out = []
  for (let i = 0; i < n; i++) {
    const a = (Math.PI / 2) * ((i + 0.5) / n)
    // ONE radius per facet, not an independent hx and hz.
    //
    // Measured the hard way: jittering the two half-extents separately pulls a
    // rectangle out of step with its neighbours, and because the union of
    // nested rectangles is a STAIRCASE, an out-of-step rectangle deepens the
    // step next to it. Two independent 12% pulls compounded into ~20% notches,
    // and the moss cap — which has to follow that boundary to stay inside the
    // collider — came back as a five-pointed star.
    //
    // Scaling the whole rectangle keeps its corner on a circle of radius R*j,
    // so the staircase keeps its regular character and only its proportions
    // change. The facet-to-facet ratio of cos(a) is at least 1.18 at every
    // facet count this kit uses, comfortably more than the 1.11 the jitter can
    // introduce, so hx stays monotonically decreasing and hz monotonically
    // increasing — which is exactly the condition for no new re-entrant corner.
    const s = j && n > 2 && i > 0 && i < n - 1 ? j[i] : 1
    out.push({ hx: R * Math.cos(a) * ax * s, hz: R * squash * Math.sin(a) * az * s })
  }
  return out
}

/**
 * ONE island's shape signature: the per-facet inward pulls and the footprint
 * aspect, drawn once and then reused by every course of that island.
 *
 * It has to be drawn once rather than per `disc()` call, or the cap, the rim,
 * the body and four boulder tiers would each jitter differently and the stack
 * would read as a pile of misaligned plates instead of as one carved mass.
 *
 * `aspect` is inward-only and opt-in (`vary`), because `deck()` in level.js
 * pins the route's footprints deliberately and a platform that quietly loses
 * 20% of its landing area is a movement bug, not a silhouette improvement.
 */
function discShape(facets, rand, vary = false) {
  const n = Math.max(1, Math.min(6, facets | 0))
  // 3-10% inward per interior facet. The outer two are never touched: they are
  // the rectangles that set the union's extent across flats, and `radius` has
  // to stay an exact promise or a jump on the route quietly changes length.
  const facet = new Array(n)
  for (let i = 0; i < n; i++) facet[i] = 1 - (0.03 + rand() * 0.07)
  let aspect = [1, 1]
  if (vary) {
    // One axis holds at 1 and the other pulls in by up to 25%, so the ratio
    // covers the review's requested 0.75-1.35 without either extent ever
    // growing past the radius the caller reserved.
    const pull = 1 - rand() * 0.25
    aspect = rand() > 0.5 ? [pull, 1] : [1, pull]
  }
  return { facet, aspect }
}

// Vertical tie-break between the rectangles that make up one faceted disc.
//
// Every rect in a disc shares a centre AND a height, so their top faces are
// exactly coplanar and heavily overlapping. Two coplanar surfaces give the
// depth test no winner, and which one survives changes per pixel and per
// camera position — so the ground visibly flickers between moss and stone as
// you walk. (Playtest, Ethan 2026-07-25: "the ground was like switching
// between green and the cobblestone".)
//
// 0.6 mm per rect breaks the tie deterministically. It is comfortably larger
// than depth precision at our near/far range, and far below anything a player
// can see or stand on differently — the whole stack of six spans 3 mm.
const DISC_EPSILON = 6e-4

/** A faceted disc/drum course. Returns the number of boxes emitted. */
function disc(put, cx, cy, cz, r, h, kind, facets = 3, squash = 1, o, shape = null) {
  let n = 0
  let i = 0
  for (const q of discRects(r, facets, squash, shape)) {
    n += put(cx, cy - i * DISC_EPSILON, cz, q.hx * 2, h, q.hz * 2, kind, o)
    i++
  }
  return n
}

/**
 * A staircase of small boxes marching from A to B — how this kit draws any
 * line that is not axis-aligned (spokes, telescope barrels, buttresses).
 * Each box is stretched along the dominant direction so the run reads as a
 * chamfered bar rather than a dotted line.
 */
function strut(put, ax, ay, az, bx, by, bz, t, steps, kind) {
  const dx = bx - ax, dy = by - ay, dz = bz - az
  const len = Math.hypot(dx, dy, dz) || 1e-6
  const s = Math.max(1, steps | 0)
  const seg = (len / s) * 1.35
  let n = 0
  for (let i = 0; i < s; i++) {
    const f = (i + 0.5) / s
    n += put(ax + dx * f, ay + dy * f, az + dz * f,
      Math.max(t, Math.abs(dx / len) * seg),
      Math.max(t, Math.abs(dy / len) * seg),
      Math.max(t, Math.abs(dz / len) * seg), kind)
  }
  return n
}

/**
 * A circle drawn as `segs` tangentially-stretched boxes, in one of the three
 * axis planes. The workhorse behind gear rims and armillary rings.
 */
function ringOfBoxes(put, cx, cy, cz, r, t, segs, plane, kind, depth = t) {
  const seg = (2 * Math.PI * r / Math.max(3, segs)) * 1.25
  let n = 0
  for (let i = 0; i < segs; i++) {
    const a = (2 * Math.PI * i) / segs
    const c = Math.cos(a), s = Math.sin(a)
    const lu = Math.max(t, Math.abs(s) * seg)   // tangential span
    const lv = Math.max(t, Math.abs(c) * seg)
    if (plane === 'xy') n += put(cx + r * c, cy + r * s, cz, lu, lv, depth, kind)
    else if (plane === 'zy') n += put(cx, cy + r * s, cz + r * c, depth, lv, lu, kind)
    else n += put(cx + r * c, cy, cz + r * s, lu, depth, lv, kind)
  }
  return n
}

/** Maps (along, across) offsets onto world X/Z for `axis: 'x' | 'z'`. */
function frame(axis) {
  const alongX = axis !== 'z'
  return {
    at: (x, z, a, c) => (alongX ? [x + a, z + c] : [x + c, z + a]),
    sz: (la, lc) => (alongX ? [la, lc] : [lc, la]),
  }
}

// ================================================================= prefabs

/**
 * drumPlatform — the archipelago's signature shape: a faceted stone drum
 * with a thick moss cap that overhangs by a lip, and a boulder underside
 * tapering away beneath it.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE WALKABLE TOP SURFACE. `y` is the
 * height you land on, so a caller can place it straight off a jump arc.
 *
 * SOLID: the moss cap, the rim course, the drum body and every boulder tier —
 * the whole mass, and at exactly the extents it has always had. What changed
 * in round three is only what DRAWS those volumes: where there is a mesh
 * channel the boxes become `{ hidden: true }` colliders and a turf mat, a
 * lathed drum and a stack of `props.blob()` boulders are drawn inside them.
 * Every one of those is provably inset — see `mossCapGeometry`'s collision
 * contract and the containment note on the tier blobs — so the surface you can
 * stand on is never larger than the surface you can see by more than the
 * chamfer, and never smaller by any amount.
 * DECOR: the hero vines, the boulder spurs, and the ivy, all of which exist
 * only below the rim.
 *
 * VARIATION: `rand` drives the facet pull, tier count, tier inset, cap outline,
 * rim height, boulder seeds and planting. Two islands of the same radius are
 * no longer congruent — which was the review's headline finding.
 *
 * @returns {{topY:number, radius:number, baseY:number, boxes:number}}
 */
export function drumPlatform(L, x, y, z, opts = {}) {
  const {
    radius = 6, kind = 'stone', capKind = 'moss', detail = 2,
    capThickness = 0.42, bodyDepth = 2.6,
    vines = detail >= 2, squash = 1,
  } = opts
  // The cap is the *built* surface (paving or turf) and the mass below it is
  // living rock, so they are almost never the same material. Defaulting both
  // to `kind` would put grass texture down the vertical faces of the drum,
  // which is precisely the "slice of astroturf" read we are fixing.
  const rimKind = opts.rimKind ?? kind
  const boulderKind = opts.boulderKind ?? kind
  const rand = pick(opts)
  const facets = opts.facets ?? (detail >= 2 ? 4 : detail === 1 ? 3 : 1)
  const { S, D } = emit(L, opts)
  const curves = !!L.mesh && detail >= 1
  let n = 0

  // THE SHAPE SIGNATURE. Drawn once and threaded through every course, so this
  // island's facets are its own and its stack still lines up. `ghost` platforms
  // are scenery nobody stands on, so those also vary their footprint aspect;
  // route decks keep the extent level.js reserved, exactly.
  const shape = discShape(facets, rand, !!opts.ghost)

  // Tier count and the inset each tier takes are per-island now. Three tiers of
  // 0.68 every time is the other half of why the archipelago read as one island
  // stamped twelve times — the underside is most of an island's silhouette.
  const tiers = opts.tiers ?? (detail === 0 ? 1 : 2 + ((rand() * 3) | 0))
  const tierInset = 0.60 + rand() * 0.18

  // THE OVERHANG. The cap stands this far proud of the stone below it, and the
  // band it casts is the contact shadow that makes a cap read as turf growing
  // over rock. 10-15 cm is the review's number and it is absolute rather than
  // proportional on purpose: it is a shadow width, so it should not scale with
  // the island the way a percentage of the radius would.
  const overhang = 0.10 + rand() * 0.05
  // Matched to level.js's BEVEL_MAX. The corner gussets the review saw were the
  // cap turning its edge over by a different amount from the drum under it.
  const bevel = 0.045

  // Cap collider: unchanged in extent and height, so the surface the player
  // lands on is the surface it always was. When there is a mesh channel the
  // boxes are hidden and `mossCapGeometry` draws the mat instead.
  n += disc(S, x, y - capThickness / 2, z, radius, capThickness, capKind, facets, squash,
    { hidden: curves }, shape)
  if (curves) {
    L.mesh(capKind,
      mossCapGeometry(discRects(radius, facets, squash, shape),
        capThickness, overhang, bevel, rand),
      place(x, y, z, _q.identity()),
      // Value jitter across islands, on top of level.js's own per-call tint
      // jitter. The review also asked for moss to stop being the brightest
      // thing in the frame; 0.86-0.96 puts sandstone back on top.
      { shade: 0.86 + rand() * 0.10 })
    n += 1
  }

  // THE RIM COURSE — the moulding the cap overhangs.
  //
  // This was one continuous prism at one radius, which is why every island read
  // as a three-layer cake: green plate, red stripe, grey block. It is now a
  // real string course with a swept cornice section, so it has a fillet, a
  // hollow and a corona in it and every one of those is a horizontal shadow
  // line. Its height and radius are per-island, and the collider is the same
  // faceted disc it always was.
  const rimTop = y - capThickness - 0.04
  // Shallower than the 0.55 m band this replaces. The rim carries the route
  // accent hue on built islands, and moving it out to (radius - overhang) to
  // give the cap its 10-15 cm of shadow also made it a far wider stripe on
  // screen — "green plate, red stripe, grey block" got LOUDER, not quieter.
  // 30-42 cm of moulding under a 42 cm cap is the proportion that reads as a
  // cornice rather than as a layer of the cake.
  const rimH = 0.30 + rand() * 0.12
  const rimR = radius - overhang - rand() * radius * 0.018
  //
  // The swept version is the single most expensive piece of an island —
  // ~1300 triangles against ~3400 for the whole platform — so it is spent only
  // where the eye can resolve a cornice profile at all. Beyond the near band
  // the box course is what a 30 cm moulding is worth.
  const richRim = curves && detail >= 2
  n += disc(S, x, rimTop - rimH / 2, z, rimR, rimH, rimKind, facets, squash,
    { hidden: richRim }, shape)
  if (richRim) {
    // Swept along the rim's own staircase outline, for the same reason the cap
    // is: a path sampled at uniform angles cuts across the steps and puts a
    // sharp V in the moulding at every re-entrant corner.
    //
    // The section stands PROUD of the path by `project` along the path normal,
    // so the path is inset by that much plus 2 cm and the moulding's outer
    // face lands just inside the collider rather than on it. A heavy chamfer
    // on the outline's convex corners keeps the miter at those corners near
    // 22 degrees, where a swept section still behaves.
    //
    // `discOutline`'s inset is metres now, so this is exactly `project + 2 cm`
    // and no more. The old form solved for a global radial SCALE that moved
    // the narrow axis in by that much, which then moved the long axis in by
    // the same FRACTION — 0.6 m of missing moulding at the ends of a 30 m
    // terrace, on the course's most-looked-at edge.
    const project = rimH * 0.5
    const rects = discRects(rimR, facets, squash, shape)
    const outline = discOutline(rects, project + 0.02, project * 2.2)
    const path = outline.map((p) => [p[0], 0, p[1]])
    L.mesh(rimKind, extrudeAlong(corniceShape(project, rimH, 3), path, {
      closed: true, detail: detail >= 2 ? 2 : 1, pathSegments: path.length,
    }), place(x, rimTop - rimH, z, _q.identity()), { shade: 0.95 })
    n += 1
  }
  const bodyTop = rimTop - rimH - 0.02

  // The drum body. A lathed batter with a string course rather than one
  // straight prism: "drums stop being stepped" is the review's wording, and a
  // wall that leans in by 4% over its height is what a real revetment does.
  n += disc(S, x, bodyTop - bodyDepth / 2, z, radius * 0.9, bodyDepth, kind, facets, squash,
    { hidden: curves }, shape)
  if (curves) {
    // LOFTED ALONG THE ISLAND'S OWN OUTLINE, not revolved.
    //
    // This was a `lathe`, which is a circle, sitting under a cap that follows
    // the faceted rectangle union. The two only touch at four points, so the
    // deck overhung nothing everywhere else — 0.52 m at the terrace's mid-span
    // and 3.94 m near its ends — and you could see the sky straight up through
    // an island from below. See `loftOutline` for the measurement.
    //
    // Inscribed in the collider by construction, same argument as before but
    // now on the right shape: the body's collider IS this rectangle union at
    // `radius * 0.9`, `discOutline` never leaves it, and every profile scale
    // below is <= 1.
    const rects = discRects(radius * 0.9, facets, squash, shape)
    const outline = discOutline(rects, 0.02, cornerChamfer(rects, bevel))
    L.mesh(kind, loftOutline(outline, [
      [0.88, -bodyDepth],
      [0.97, -bodyDepth * 0.72],
      [0.985, -bodyDepth * 0.34],
      [0.93, -bodyDepth * 0.30],   // string course, a real shadow line
      [0.99, -bodyDepth * 0.24],
      [1.00, -0.06],
      [0.97, 0],
    ]),
    place(x, bodyTop, z, _q.identity()))
    n += 1
  }

  // ------------------------------------------------------- the underside
  //
  // KILLING THE VOXELS. The tiers stay solid — they are the island's mass and
  // the review explicitly said to leave the solid discs alone — but where there
  // is a mesh channel they are hidden and a `props.blob()` is drawn inside
  // each one. A blob is a welded icosphere pushed around by seeded fractal
  // noise: it has no horizontal top, no horizontal bottom and no countable
  // step, which is precisely what a Y-rotated cuboid could never stop having.
  //
  // CONTAINMENT, stated rather than hoped: blob's displaced radius is
  // `r * (1 + lumpiness * nz)` with `nz` in [-1,1], so asking for
  // `r = tr / (1 + lumpiness)` guarantees every vertex is inside the tier's
  // across-flats half-width. The lumps hung off the tiers carry no collider at
  // all and no constraint either — they live under an overhang wider than
  // themselves, which is the case art-direction.md grants for island undersides.
  let ty = bodyTop - bodyDepth
  let tr = radius * 0.9
  for (let i = 0; i < tiers; i++) {
    const h = 2.2 + rand() * 1.6 + i * 0.5
    tr *= tierInset + rand() * 0.1
    n += disc(S, x, ty - h / 2, z, tr, h, boulderKind, Math.max(1, facets - 1), squash,
      { hidden: curves }, shape)
    if (curves) {
      // CONTAINMENT, worked rather than assumed. blob's displaced radius is
      //   R = radius * (1 + lumpiness * noise) * (1 + taperY * dirY)
      // with noise and dirY both in [-1,1], so its horizontal extent is bounded
      // by radius * (1 + lumpiness) * (1 + taperY). Solving that for the tier's
      // across-flats half-width `tr` is what `rBase` is. Y is then bounded by
      // tr * squashY, so squashY is set to put it exactly on the tier's height.
      const LUMP = 0.34
      // POSITIVE taperY widens the top and pinches the bottom — checked against
      // the formula above rather than taken from props.js's prose, which reads
      // the sign the other way round. Wide-over-narrow is the island underside.
      const taper = 0.28 + rand() * 0.22
      const rBase = tr / ((1 + LUMP) * (1 + taper))
      L.mesh(boulderKind, blob((rand() * 0xffffff) | 0, {
        radius: rBase,
        lumpiness: LUMP,
        taperY: taper,
        squash: (h / 2) / tr,
        frequency: 1.3 + rand() * 0.7,
        // MID, not NEAR: 320 triangles rather than 1280. Sixty islands with
        // three tiers each is 180 of these in the world, and an island
        // underside is seen from 30 m and below, where the extra subdivision
        // buys smoother relief on a shape the eye reads as a silhouette. The
        // cost of getting this wrong is the whole frame budget.
        detail: detail >= 2 ? 1 : 0,
      }), place(x, ty - h / 2, z, _q.identity(), _sc.set(1, 1, squash)),
      { shade: 0.94 + rand() * 0.1 })
      n += 1

      // Spurs and boulders hung off the tier, at full three-axis orientation.
      //
      // These carry no collider, and the licence for that is that they live
      // UNDER an overhang wider than themselves — so their reach is clamped to
      // the drum's own radius rather than left to whatever the random sizes
      // happen to add up to. Without the clamp a first-tier spur measured
      // 3 cm outside the island's footprint, which is a visible surface with
      // no collider under it and therefore the one bug this project exists to
      // not have, however small.
      const lumps = detail >= 2 ? 5 : 2
      const reach = tr * 0.72
      // blob's horizontal extent is radius * (1 + lumpiness) * (1 + taperY);
      // 0.46 and 0.25 are the maxima the calls below can draw.
      const maxAllowed = Math.max(0.1, (radius * 0.88 - reach) / (1.46 * 1.25))
      for (let k = 0; k < lumps; k++) {
        const a = (2 * Math.PI * (k + rand() * 0.7)) / lumps
        const lr = Math.min(maxAllowed, tr * (0.26 + rand() * 0.22))
        const ly = ty - h * (0.12 + rand() * 0.62)
        L.mesh(boulderKind, blob((rand() * 0xffffff) | 0, {
          radius: lr,
          lumpiness: 0.30 + rand() * 0.16,
          squash: 0.7 + rand() * 0.8,
          taperY: (rand() - 0.5) * 0.5,
          detail: 0,          // 80 triangles: a spur is pure silhouette
        }), place(x + Math.cos(a) * reach, ly, z + Math.sin(a) * reach * squash,
          orient3(rand)), { shade: 0.9 + rand() * 0.16 })
        n += 1
      }
    } else if (detail >= 1) {
      // No mesh channel (the far LOD, and the self-test's box recorder): keep
      // the old box lumps rather than leaving the underside a bare prism.
      const lumps = 4
      for (let k = 0; k < lumps; k++) {
        const a = (2 * Math.PI * (k + rand() * 0.7)) / lumps
        const lr = tr * (0.62 + rand() * 0.46)
        const ly = ty - h * (0.10 + rand() * 0.66)
        n += D(x + Math.cos(a) * tr * 0.80, ly, z + Math.sin(a) * tr * 0.80 * squash,
          lr, h * (0.46 + rand() * 0.44), lr * squash * (0.7 + rand() * 0.5),
          boulderKind, { rot: { axis: 'y', angle: a }, fit: false })
      }
    }
    ty -= h * 0.92
  }

  // ---------------------------------------------------------- the planting
  //
  // "Vegetation is a primary element, not a garnish" (art-direction.md), and
  // the review measured a frame of architecture at 100% bare stone. An island
  // gets three layers of it: a scattered deck, ivy over the rim, and — where
  // the player will actually stand next to it — two hero vines as real tubes.
  //
  // PLANTS GROW ON TURF, NOT ON A SWEPT MARBLE FLOOR. Ethan, playing: "can we
  // remove foliage from the marble floors and just keep it on the green
  // floors". The deck scatter used to run on every island regardless of its
  // cap material, so the BUILT islands — porcelain, the formal paved ones —
  // came up with grass and ferns sprouting through polished stone.
  //
  // The rim ivy below is deliberately NOT gated on this: it hangs off the
  // outside of the stone lip rather than growing out of the floor, which is
  // what ivy does to a real balustrade, and it is most of what keeps a built
  // island from reading as bare architecture.
  const turfCap = capKind === 'moss'
  if (detail >= 1 && turfCap) {
    const rects = discRects(radius, facets, squash, shape)
    scatterDisc(L, x, y + 0.02, z, rects, squash, rand, {
      // Scenery is backdrop: capped hard, because sixteen near-band islands at
      // deck density would plant more cards than the whole route needs.
      // 6.5/m2 on the route, measured rather than chosen: at 5.0 with the cap
      // at 420 attempts a 256 m2 terrace came back with ~290 plants and read
      // as a swept deck with weeds at the edges. Scenery stays capped hard —
      // sixteen near-band islands at route density is more cards than the
      // whole route needs, for something 40 m off the running line.
      density: opts.ghost ? 1.1 : 6.5,
      max: opts.ghost ? 90 : 1100,
      mix: opts.ghost ? WILD_MIX : DECK_MIX,
      maxHeight: opts.ghost ? 0.34 : DECK_PLANT_HEIGHT,
      inset: 0.4,
      rimBias: 0.3,
    })

    // Ivy over the rim, along the island's real boundary. `hangFromEdge` emits
    // strictly below the lip, so a drape can never be a phantom ledge.
    //
    // Pitch 1.15 rather than the library's 0.5 default: at 0.5 the perimeter
    // of a 30 m terrace came back as a continuous hedge standing along both
    // edges of the running line, and taste.md is explicit that scenery must
    // never "obscure the view" — on a floating-island course the VOID is the
    // read that matters most. Broken cover with gaps in it is also just what
    // ivy on a wall looks like.
    drapeOutline(L, x, y - capThickness, z,
      discOutline(discRects(radius, facets, squash, shape), 0.02, 0), {
        drop: [0.7, 1.5 + radius * 0.1],
        pitch: opts.ghost ? 1.9 : 1.15,
        minRun: Math.max(0.9, radius * 0.12),
      })
  }

  if (vines) {
    // Hero vines: real swept tubes on a catenary, for the two or three the
    // player runs within arm's reach of. A card seen from 40 cm is a card.
    const strands = 2 + ((rand() * 2) | 0)
    for (let i = 0; i < strands; i++) {
      const a = rand() * Math.PI * 2
      const c = Math.cos(a), s = Math.sin(a)
      const ax2 = x + c * radius * 0.9
      const az2 = z + s * radius * squash * 0.9
      const len = 1.8 + rand() * 3.6
      if (L.mesh) {
        const rope = vineRope(ax2, y - capThickness - 0.05, az2, {
          drop: len, reach: 0.25 + rand() * 0.4, dir: [c, s],
          seed: ((rand() * 0xffffff) | 0) || 1,
          radius: [0.055, 0.02],
        })
        L.mesh('moss', sweepTube(rope, 0.05, {
          detail: detail >= 2 ? 1 : 0, taper: 0.34, capStart: false, capEnd: false,
        }), place(0, 0, 0, _q.identity()), { shade: 0.9 })
        n += 1
      } else {
        n += D(ax2, y - capThickness - len / 2, az2, 0.28, len, 0.28, 'moss')
      }
    }
  }

  return { topY: y, radius, baseY: ty, boxes: n }
}

/**
 * archway — a sandstone arch: two battered piers, springing blocks, and a
 * semicircular ring of voussoirs built as a staircase of small blocks. At
 * reference scale the steps read as true carved joints, not as stairs.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE OPENING AT ITS BASE — y is the
 * floor the piers stand on, so an arch drops onto a terrace at the terrace's
 * own top height. Spans along `axis` ('x' default, or 'z').
 *
 * SOLID: everything. The piers are obviously solid, and the extrados is a
 * genuine ledge the player will try to mantle onto from a wall-run — an arch
 * you can see over the route and fall through is exactly the forbidden bug.
 *
 * @returns {{topY:number, crownY:number, clearHeight:number, span:number, boxes:number}}
 */
export function archway(L, x, y, z, opts = {}) {
  const {
    span = 6, pierWidth = 1.5, depth = 2.2, springHeight = 3.2,
    kind = 'porcelain', axis = 'x', detail = 2, keystone = detail >= 1,
  } = opts
  const F = frame(axis)
  const { S, D } = emit(L, opts)
  const R = span / 2
  const vt = opts.voussoir ?? (detail >= 2 ? 0.8 : 1.2)
  const segs = detail >= 2 ? 11 : detail === 1 ? 7 : 5
  let n = 0

  const rand = pick(opts)

  for (const side of [-1, 1]) {
    const a = side * (R + pierWidth / 2)
    // Pier: three courses, each slightly inset, for a battered chamfer.
    const courses = detail >= 1 ? 3 : 1
    for (let i = 0; i < courses; i++) {
      const h = springHeight / courses
      const w = pierWidth * (1 - i * 0.045)
      const d = depth * (1 - i * 0.03)
      const [cx, cz] = F.at(x, z, a, 0)
      const [sx, sz] = F.sz(w, d)
      n += S(cx, y + h * (i + 0.5), cz, sx, sy_(h), sz, kind)
      // A BEVEL COURSE at every joint. The review's fifth finding: a course
      // boundary with no relief in it has no shadow line, so a battered pier
      // reads as one prism with lines painted on. 4 cm proud and 8 cm tall is
      // enough to self-shadow at a 10-degree sun and invisible as added mass.
      if (detail >= 1 && i < courses - 1) {
        const [bsx2, bsz2] = F.sz(w + 0.08, d + 0.08)
        n += S(cx, y + h * (i + 1) - 0.04, cz, bsx2, 0.08, bsz2, kind, { shade: 1.08 })
      }
    }
    // Springing block: the flared impost the arc launches from, in two courses
    // so its own top edge turns over rather than ending in a square arris.
    const [bx, bz] = F.at(x, z, a, 0)
    const [bsx, bsz] = F.sz(pierWidth * 1.22, depth * 1.12)
    n += S(bx, y + springHeight + 0.16, bz, bsx, 0.32, bsz, kind)
    const [csx, csz] = F.sz(pierWidth * 1.34, depth * 1.2)
    n += S(bx, y + springHeight + 0.38, bz, csx, 0.12, csz, kind, { shade: 1.1 })
  }

  // --- the voussoir ring -------------------------------------------------
  //
  // `props.arch()` builds this now: every block is a wedge cut on the arch's
  // own radial lines, chamfered on all twelve edges, separated from its
  // neighbours by a real mortar joint. That last part is the whole gain over
  // the hand-rolled trapezoids this replaces — a joint that is a recess with
  // two chamfers meeting in it casts a shadow line whatever the sun is doing,
  // where an abutting joint casts nothing and the ring reads as one solid.
  //
  // The collider is unchanged in kind: one axis-aligned box per block, sized
  // as the exact AABB of that block's wedge, so an extrados a player mantles
  // onto from a wall-run is still a real ledge and never a staircase.
  const cy0 = y + springHeight + 0.44
  const rr = R + vt / 2
  const wIn = (Math.PI * R) / segs * 1.03
  const wOut = (Math.PI * (R + vt)) / segs * 1.03
  const wMax = Math.max(wIn, wOut)
  for (let i = 0; i < segs; i++) {
    const t = Math.PI * ((i + 0.5) / segs)
    const c = Math.cos(t), s = Math.sin(t)
    const [cx, cz] = F.at(x, z, -c * rr, 0)
    const cyv = cy0 + s * rr
    // AABB of the rotated trapezoid, plus 3 cm. |cos phi| = |sin t| = s and
    // |sin phi| = |c| give the exact figure; the margin covers `props.arch`'s
    // per-block extrados jitter, and it is spent in the safe direction — a
    // collider slightly larger than its mesh, never a mesh outside its
    // collider, which is docs/geometry-unlock.md's rule.
    const aAlong = wMax * s + vt * Math.abs(c) + 0.03
    const aUp = wMax * Math.abs(c) + vt * s + 0.03
    const [sx, sz] = F.sz(aAlong, depth)
    n += S(cx, cyv, cz, sx, aUp, sz, kind, { hidden: !!L.mesh })
  }
  if (L.mesh) {
    // One merged ring, drawn once. `arch` sits in XY with its springing line at
    // y = 0 and the opening centred on x = 0, extruded along Z — which is
    // exactly this prefab's own frame for an x-spanning arch, and a -90 degree
    // turn about Y for a z-spanning one.
    const q = axis === 'z'
      ? new THREE.Quaternion().setFromEuler(_e.set(0, -Math.PI / 2, 0))
      : new THREE.Quaternion()
    L.mesh(kind, archRing(span, R, depth, segs, {
      ringDepth: vt,
      // A 2 cm joint at a 6 m span is a stonemason's joint, and it is the
      // shadow line the whole ring reads by.
      jointGap: 0.02,
      bevel: Math.min(0.045, vt * 0.2),
      keystone: keystone ? 0.26 : 0,
      jitter: 0.014,
      seed: ((rand() * 0xffffff) | 0) || 1,
    }), place(x, cy0, z, q))
    n += 1
  }

  const crownY = cy0 + R + vt / 2
  if (keystone) {
    const [kx, kz] = F.at(x, z, 0, 0)
    const [ksx, ksz] = F.sz(vt * 1.4, depth * 1.15)
    // Base flush with the INTRADOS at the crown (crownY - vt/2), projecting
    // 0.8 vt above the extrados. Centred any lower and the keystone dangles
    // below the soffit as a block floating in the opening, which is what the
    // old numbers did once the voussoirs around it became real wedges.
    n += S(kx, crownY + vt * 0.15, kz, ksx, vt * 1.3, ksz, kind)
    // Brass boss on the keystone — brass is the signature material and should
    // appear at every scale. Overhead ornament, so decor.
    const [bx2, bz2] = F.at(x, z, 0, 0)
    n += D(bx2, crownY + vt * 1.0, bz2, 0.5, 0.4, depth * 1.2, 'brass')
  }

  // ---------------------------------------------------------- the planting
  //
  // "no frame contains a stone mass over ~3 m wide with a completely unbroken
  // top edge" (docs/roadmap.md). An arch is the worst offender in the set: a
  // clean semicircle of stone against sky. Ivy off both springings breaks the
  // extrados, moss at the pier bases breaks the floor junction, and ferns in
  // the soffit shade are what the reference puts under every arch.
  if (detail >= 1) {
    for (const side of [-1, 1]) {
      const a = side * (R + pierWidth / 2)
      const [px, pz] = F.at(x, z, a - pierWidth / 2, -depth / 2)
      mossJunction(L, { x: px, y, z: pz, axis, length: pierWidth, width: depth * 0.9 })
      // Off the springing block, where the ring leaves the pier: the one place
      // a real arch always grows something, because the impost holds water.
      const [dx2, dz2] = F.at(x, z, a - pierWidth * 0.6, -depth / 2)
      drape(L, {
        x: dx2, y: y + springHeight + 0.3, z: dz2,
        axis, length: pierWidth * 1.2, outward: -1,
      }, { drop: [0.7, 1.6 + R * 0.25], pitch: 0.5 })
    }
    // Ferns under the soffit, in the damp shade the arch casts all day.
    const [fx, fz] = F.at(x, z, -R * 0.55, -depth * 0.3)
    const [fsx, fsz] = F.sz(R * 1.1, depth * 0.6)
    plant(L, fx + fsx / 2, fz + fsz / 2, (field) => scatterOnBox(field, {
      cx: fx + fsx / 2, cy: y, cz: fz + fsz / 2, sx: fsx, sy: 0, sz: fsz,
    }, {
      mix: [['fern', 5], ['grass', 2], ['leaf', 1.5]],
      density: 1.6, clump: 0.5, maxHeight: 0.3, inset: 0.2, y,
    }))
  }

  return {
    topY: crownY, crownY, clearHeight: springHeight + R,
    span, boxes: n,
  }
}

// Tiny guard: a course height must stay positive even at detail 0.
function sy_(h) { return Math.max(0.05, h) }

/**
 * colonnade — a row of columns (base, chamfered shaft, capital) carrying a
 * continuous entablature. The reference's covered walkway.
 *
 * ANCHOR: (x, y, z) is the BASE CENTRE OF THE FIRST COLUMN — y is the floor
 * it stands on. The row marches along `axis` in +ve direction.
 *
 * SOLID: everything. The entablature is a roof the player will run along,
 * the column bases are knee-height ledges to vault, and the shafts must
 * block movement or the colonnade is a hologram.
 *
 * @returns {{topY:number, length:number, spacing:number, boxes:number}}
 */
export function colonnade(L, x, y, z, opts = {}) {
  const {
    count = 5, spacing = 4.0, height = 5.0, radius = 0.55,
    kind = 'porcelain', axis = 'x', detail = 2, entablature = true,
    // NOT terracotta. A cornice is the least interactive surface in the game
    // and it used to carry the palette's only saturated hue; that hue is now
    // reserved for route-critical surfaces (see level.js's BUILT/WILD note).
    capKind = 'porcelain',
  } = opts
  const F = frame(axis)
  const { S, D } = emit(L, opts)
  const rand = pick(opts)
  const facets = detail >= 2 ? 3 : 1
  const drums = detail >= 2 ? 4 : detail === 1 ? 2 : 1
  const baseFacets = Math.max(1, facets - 1)
  const curves = !!L.mesh && detail >= 1
  let n = 0

  const shaftTop = y + 0.42 + height
  for (let i = 0; i < count; i++) {
    const a = i * spacing
    const [cx, cz] = F.at(x, z, a, 0)
    // Base: two plinth courses, the lower one wider.
    n += disc(S, cx, y + 0.11, cz, radius * 1.55, 0.22, kind, baseFacets)
    n += disc(S, cx, y + 0.32, cz, radius * 1.3, 0.2, kind, baseFacets)
    // Shaft: the collider stays a stack of faceted drums, because a wall-run
    // along a colonnade has to behave identically at every column. What gets
    // DRAWN is a single turned shaft — apophyge, entasis, astragal, echinus —
    // inscribed inside those drums. `lathe` puts every vertex on the circle of
    // the profile radius, and the drum's across-flats half-width is the same
    // number, so the shaft can never leave its collider.
    for (let d = 0; d < drums; d++) {
      const f = (d + 0.5) / drums
      const rr = radius * (1.02 - 0.13 * f * f)
      n += disc(S, cx, y + 0.42 + height * f, cz, rr, height / drums + 0.02, kind, facets,
        1, { hidden: curves })
    }
    if (curves) {
      const H = height
      L.mesh(kind, latheGeometry([
        [radius * 1.00, 0],
        [radius * 1.00, 0.06],
        [radius * 0.96, 0.16],          // apophyge — the shaft leaves the base
        [radius * 1.00, 0.30],
        [radius * 1.00, H * 0.30],      // entasis: the swell, then the taper
        [radius * 0.955, H * 0.62],
        [radius * 0.88, H * 0.92],
        [radius * 0.845, H * 0.965],
        [radius * 0.90, H * 0.975],     // astragal — the ring under the neck
        [radius * 0.845, H * 0.99],
        [radius * 0.86, H],
      ], detail >= 2 ? 14 : 9, { capTop: false, capBottom: false }),
      place(cx, y + 0.42, cz, _q.identity()), { shade: 0.98 + rand() * 0.06 })
      n += 1
    }
    // Capital: flare out again, with a brass collar under it.
    if (detail >= 1) n += disc(D, cx, shaftTop - 0.18, cz, radius * 1.06, 0.16, 'brass', baseFacets)
    n += disc(S, cx, shaftTop + 0.14, cz, radius * 1.35, 0.28, kind, baseFacets,
      1, { hidden: curves })
    if (curves) {
      // The echinus: a real turned cushion between the neck and the abacus,
      // which is the one part of a column the eye uses to date the order.
      L.mesh(kind, latheGeometry([
        [radius * 0.86, 0], [radius * 1.02, 0.10], [radius * 1.22, 0.20],
        [radius * 1.33, 0.26], [radius * 1.35, 0.28],
      ], detail >= 2 ? 14 : 9, { capBottom: false }),
      place(cx, shaftTop, cz, _q.identity()))
      n += 1
    }
    n += disc(S, cx, shaftTop + 0.42, cz, radius * 1.62, 0.28, capKind, baseFacets)
    // The abacus's own bevel course — 4 cm proud, so the square block on top
    // of the capital turns its bottom arris over instead of ending flat.
    if (detail >= 1) {
      n += disc(D, cx, shaftTop + 0.29, cz, radius * 1.5, 0.06, capKind, baseFacets)
    }
  }

  const len = (count - 1) * spacing
  let topY = shaftTop + 0.56
  if (entablature) {
    const [ex, ez] = F.at(x, z, len / 2, 0)
    const [esx, esz] = F.sz(len + radius * 4, radius * 3.4)
    n += S(ex, topY + 0.3, ez, esx, 0.6, esz, kind)
    const [fsx, fsz] = F.sz(len + radius * 4.6, radius * 3.9)
    // The cornice. Two stacked slabs is exactly the failure props.js was
    // written for — "seams whose shadow line is invisible because a slab has
    // no section". This is a swept cornice: fillet, cavetto, corona. Every
    // step in that profile is a horizontal shadow line by construction, and
    // the collider is the same box the slab always was.
    // NOT `{hidden: true}`. The mouldings below are swept down the two long
    // EDGES of this slab and nothing is drawn between them, so hiding the whole
    // box left the middle of the cornice — a strip 2 * (halfW - proj) wide and
    // the full length of the run — undrawn while it stayed solid: measured
    // 0.36 m of colonnade roof that the player runs along above the highest
    // thing they can see, plus 0.47 m of missing slab at each end of the run.
    // `size` draws the CORE, exactly up to where the mouldings take over.
    const corniceProj = curves ? radius * 0.5 : 0
    n += S(ex, topY + 0.78, ez, fsx, 0.36, fsz, capKind,
      curves ? { size: [fsx, 0.36, fsz - 2 * corniceProj] } : undefined)
    if (curves) {
      const proj = corniceProj
      const halfW = fsz / 2
      for (const side of [-1, 1]) {
        // Section stands proud along +X of the path frame, which for a path
        // running along `axis` with up = +Y is the outward horizontal — so the
        // path is laid on the far side and the moulding projects back inward
        // to land inside the slab's own footprint.
        const [p0x, p0z] = F.at(x, z, -radius * 2.3, side * (halfW - proj))
        const [p1x, p1z] = F.at(x, z, len + radius * 2.3, side * (halfW - proj))
        const path = side > 0
          ? [[p0x, topY + 0.60, p0z], [p1x, topY + 0.60, p1z]]
          : [[p1x, topY + 0.60, p1z], [p0x, topY + 0.60, p0z]]
        L.mesh(capKind, extrudeAlong(corniceShape(proj, 0.36, 3), path,
          { detail: detail >= 2 ? 2 : 1, pathSegments: 2 }),
        place(0, 0, 0, _q.identity()), { shade: 1.04 })
        n += 1
      }
    }
    topY += 0.96
    if (detail >= 1) {
      // Dentils under the cornice — pure overhead ornament, out of reach.
      const step = spacing / 3
      for (let d = 0; d * step <= len; d++) {
        const [dx, dz] = F.at(x, z, d * step, 0)
        const [dsx, dsz] = F.sz(step * 0.42, radius * 3.6)
        n += D(dx, topY - 1.14, dz, dsx, 0.2, dsz, capKind)
      }
    }
  }

  // ---------------------------------------------------------- the planting
  //
  // tower.png came back with two colonnades in it and not one plant. Ivy off
  // the architrave is the reference's own answer, and it is also the cheapest
  // way to break a 20 m unbroken horizontal edge.
  if (detail >= 1) {
    const half = radius * 1.9
    for (const side of [-1, 1]) {
      const [dx, dz] = F.at(x, z, -radius * 2, side * half)
      drape(L, {
        x: dx, y: shaftTop + 0.56, z: dz,
        axis, length: len + radius * 4, outward: side,
      }, { drop: [0.8, 2.2], pitch: 1.15 })
    }
    // Moss where each column meets the floor. A column standing on a perfectly
    // clean line is the single most synthetic read in the frame.
    for (let i = 0; i < count; i++) {
      const [cx, cz] = F.at(x, z, i * spacing, 0)
      mossJunction(L, {
        x: cx - radius * 1.5, y, z: cz - radius * 1.5,
        axis: 'x', length: radius * 3, width: radius * 3,
      }, { density: 3.2 })
    }
  }

  return { topY, length: len, spacing, boxes: n }
}

/**
 * balustrade — the low railing that edges every terrace in the references:
 * a plinth, turned balusters, a top rail, and heavier end posts.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE PLINTH'S BOTTOM FACE at the start
 * of the run; the run extends `length` along `axis` in the +ve direction.
 *
 * SOLID: the plinth (it is a knee-high ledge at walkable height — the player
 * will stand on it), the top rail (a railing that does not stop you is a
 * trap, and it is at mantle height), and the end posts.
 * DECOR: the individual balusters between them. They are thin, fully
 * enclosed above and below by solid geometry, and no one lands on a 12 cm
 * spindle — colliding them would just make the railing feel sticky.
 *
 * @returns {{topY:number, plinthTopY:number, length:number, boxes:number}}
 */
export function balustrade(L, x, y, z, opts = {}) {
  const {
    length = 10, height = 1.15, kind = 'porcelain', axis = 'x',
    detail = 2, plinthHeight = 0.34, thickness = 0.5, posts = true,
  } = opts
  const F = frame(axis)
  const { S, D } = emit(L, opts)
  const rand = pick(opts)
  let n = 0

  // Plinth, in two courses so the edge is chamfered rather than a slab.
  const [px, pz] = F.at(x, z, length / 2, 0)
  let [sx, sz] = F.sz(length, thickness)
  n += S(px, y + plinthHeight * 0.35, pz, sx, plinthHeight * 0.7, sz, kind)
  ;[sx, sz] = F.sz(length, thickness * 0.86)
  n += S(px, y + plinthHeight * 0.85, pz, sx, plinthHeight * 0.3, sz, kind)
  // The bevel course between them: 4 cm proud of the upper course, so the
  // step from plinth to die is a shadow line rather than an invisible seam.
  if (detail >= 1) {
    ;[sx, sz] = F.sz(length, thickness * 0.94)
    n += S(px, y + plinthHeight * 0.70, pz, sx, 0.05, sz, kind, { shade: 1.14 })
  }

  const plinthTopY = y + plinthHeight
  const railY = y + height
  const gap = height - plinthHeight - 0.2

  // Balusters, genuinely turned: base · swell · neck · cap, revolved.
  //
  // These were three stacked cubes, which the art review called out as "a row
  // of literal cubes where turned balusters belong" — and it is the one piece
  // of ornament the player stands right next to on the opening terrace, so it
  // sets the standard for everything behind it. A 10-segment lathe over a
  // 5-point profile is ~90 triangles; at a 58 cm pitch that is affordable.
  const pitch = detail >= 2 ? 0.58 : detail === 1 ? 0.95 : 1.8
  const bw = thickness * 0.42
  for (let a = pitch * 0.6; a < length - pitch * 0.4; a += pitch) {
    const [bx, bz] = F.at(x, z, a, 0)
    if (L.mesh && detail >= 1) {
      const g = gap
      L.mesh(kind, latheGeometry([
        [bw * 0.62, 0],            // base fillet
        [bw * 0.62, g * 0.08],
        [bw * 0.34, g * 0.20],     // waist above the base
        [bw * 0.78, g * 0.44],     // the swell
        [bw * 0.70, g * 0.60],
        [bw * 0.30, g * 0.78],     // neck
        [bw * 0.44, g * 0.90],
        [bw * 0.60, g * 0.97],     // cap
        [0, g],
      ], detail >= 2 ? 10 : 7), place(bx, plinthTopY, bz, _q.identity()))
      n += 1
    } else {
      n += D(bx, plinthTopY + gap * 0.5, bz, bw, gap, bw, kind)
    }
  }

  // Top rail: solid, two courses. NOT terracotta any more — the coping is the
  // one thing on a balustrade a player never interacts with, and spending the
  // route hue on it is what emptied the accent of meaning (see level.js).
  ;[sx, sz] = F.sz(length, thickness * 0.78)
  n += S(px, railY - 0.11, pz, sx, 0.22, sz, kind)
  ;[sx, sz] = F.sz(length, thickness * 0.94)
  n += S(px, railY + 0.05, pz, sx, 0.14, sz, kind, { shade: 0.88 })

  if (posts) {
    for (const a of [0, length]) {
      const [ex, ez] = F.at(x, z, a, 0)
      const [esx, esz] = F.sz(thickness * 1.2, thickness * 1.2)
      n += S(ex, y + (height + 0.24) / 2, ez, esx, height + 0.24, esz, kind)
      const [csx, csz] = F.sz(thickness * 1.5, thickness * 1.5)
      n += S(ex, y + height + 0.34, ez, csx, 0.2, csz, kind)
      // Newel finial: a turned brass pineapple, the reference's favourite way
      // of ending a run of stonework.
      if (L.mesh) {
        L.mesh('brass', latheGeometry([
          [0.03, 0], [0.15, 0.03], [0.11, 0.10], [0.17, 0.20],
          [0.10, 0.30], [0.05, 0.36], [0, 0.40],
        ], detail >= 2 ? 10 : 6), place(ex, y + height + 0.44, ez, _q.identity()))
        n += 1
      } else if (detail >= 1) {
        n += D(ex, y + height + 0.58, ez, 0.26, 0.3, 0.26, 'brass')
      }
    }
  }

  // ---------------------------------------------------------- the planting
  //
  // A balustrade edges a terrace, so it is exactly where the reference hangs
  // ivy: over the coping and down the outboard face, with moss in the angle
  // where the plinth meets the paving.
  if (detail >= 1) {
    const [dx, dz] = F.at(x, z, 0, thickness * 0.52)
    drape(L, { x: dx, y: railY - 0.05, z: dz, axis, length, outward: 1 },
      { drop: [0.5, 1.3], pitch: 1.5, proud: 0.06 })
    for (const side of [-1, 1]) {
      const [mx, mz] = F.at(x, z, 0, side * (thickness * 0.5 + 0.16))
      mossJunction(L, { x: mx, y, z: mz, axis, length, width: 0.3 }, { density: 4.5 })
    }
  }

  return { topY: railY + 0.12, plinthTopY, length, boxes: n }
}

/**
 * gearWheel — the world's signature brass ornament: a machined gear or
 * ship's wheel with a hub, a bolt circle, radiating spokes and a toothed
 * rim. The teeth alternate in and out around the rim, which is what makes
 * it read as machined rather than as a hoop.
 *
 * ANCHOR: (x, y, z) is the WHEEL'S CENTRE. `plane` is the plane it lies in:
 * 'xy' (facing +Z, the default — a gear on a wall), 'zy' (facing +X),
 * or 'xz' (lying flat, like a turntable).
 *
 * DECOR by default: a gear is mounted above head height or flush on a wall,
 * and a spinning rim is not a platform. If you place one flat and low
 * enough to become a stepping stone, you MUST pass `{ solidRim: true }` —
 * then hub, spokes and rim are all solid so what you see is what you land
 * on. Never place a decor gear at walkable height.
 *
 * @returns {{radius:number, hubRadius:number, teeth:number, boxes:number}}
 */
export function gearWheel(L, x, y, z, opts = {}) {
  const {
    radius = 2.4, plane = 'xy', thickness = 0.34, spokes = 6,
    kind = 'brass', detail = 2, solidRim = false,
  } = opts
  const { S, D } = emit(L, opts)
  const teeth = opts.teeth ?? (detail >= 2 ? 26 : detail === 1 ? 18 : 12)
  const hubR = radius * 0.22
  let n = 0

  const XY = plane === 'xy', ZY = plane === 'zy'
  const dirs = XY
    ? (c, s) => [c, s, 0]
    : ZY ? (c, s) => [0, s, c] : (c, s) => [c, 0, s]
  const boxAt = (u, v, kk, put_) => put_(x + u[0], y + u[1], z + u[2], v[0], v[1], v[2], kk)
  const flat = (t) => (XY ? [t, t, thickness] : ZY ? [thickness, t, t] : [t, thickness, t])

  // THE COLLIDER, when this wheel is one. A gear at climbing height that you
  // can see and fall through is the forbidden bug at architectural scale, so
  // `solidRim` still declares an honest faceted disc — but hidden, because the
  // real wheel below is what gets drawn. The disc stops at 0.9 R, inside the
  // tooth tips: art-direction.md's caveat prefers a small non-walkable
  // overhang (here, one 25 cm tooth) to a ledge that is not there.
  if (solidRim) {
    const cf = detail >= 2 ? 3 : 2
    for (const q of discRects(radius * 0.9, cf, 1)) {
      const a = q.hx * 2, b = q.hz * 2
      const size = XY ? [a, b, thickness] : ZY ? [thickness, b, a] : [a, thickness, b]
      S(x, y, z, size[0], size[1], size[2], kind, { hidden: true })
      n += 1
    }
  }

  // THE WHEEL. `props.gear()` cuts the teeth on a real involute flank taken
  // off a 20-degree pressure angle, so each tooth is wide at the root, narrow
  // at the tip and CURVED between — the thing a trapezoid stuck on a disc can
  // never be. Both faces are chamfered along the outline's own miter normals,
  // which puts a highlight down the crown of every tooth.
  //
  // The plate is bored out and the spokes are separate bars, rather than
  // windows cut in one extrusion, because that is how a cast wheel is actually
  // made: the spokes stand proud of the web and catch the light on their own
  // edges. Merged into one geometry, so it is still a single batch append.
  if (L.mesh) {
    const parts = []
    const bore = radius * (detail >= 1 && spokes >= 3 ? 0.62 : 0.30)
    parts.push(gearPlate(teeth, {
      tipR: radius,
      rootR: radius * 0.845,
      thickness,
      bevel: Math.min(0.035, thickness * 0.24),
      bore,
      detail,
    }))
    if (detail >= 1 && spokes >= 3) {
      const sl = bore - hubR * 0.7
      const sw = Math.max(0.1, radius * 0.11)
      for (let i = 0; i < spokes; i++) {
        const a = (2 * Math.PI * i) / spokes
        const g = chamferBox(sl + radius * 0.1, sw, thickness * 0.72, 0.022)
        g.applyMatrix4(new THREE.Matrix4().compose(
          _pos.set(0, 0, 0), _q.setFromEuler(_e.set(0, 0, a)), _one))
        g.applyMatrix4(new THREE.Matrix4().makeTranslation(
          Math.cos(a) * (hubR * 0.7 + sl / 2), Math.sin(a) * (hubR * 0.7 + sl / 2), 0))
        parts.push(g)
      }
    }
    // Hub boss: a stepped turning standing proud of the web on both sides.
    // Without it the wheel reads as a flat cut-out with a hole in it.
    const hd = thickness * 1.9
    const hub = latheGeometry([
      [0, -hd / 2], [hubR * 1.15, -hd / 2], [hubR * 1.15, -hd * 0.18],
      [hubR * 0.82, -hd * 0.1], [hubR * 0.82, hd * 0.1],
      [hubR * 1.15, hd * 0.18], [hubR * 1.15, hd / 2], [0, hd / 2],
    ], detail >= 2 ? 16 : 10)
    // The lathe revolves about +Y and the gear lies in XY, so the hub turns a
    // quarter about X to put its axis down +Z with the rest of the wheel.
    hub.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2))
    parts.push(hub)

    L.mesh(kind, mergeGeometries(parts, { dispose: true }),
      place(x, y, z, planeQuat(plane, (radius * 7.3) % 1)), { shade: 1.0 })
    n += 1
  }

  // Ship's-wheel handles poking past the rim: still boxes, because a 16 cm
  // stub at 2 m is a stub whatever it is made of, and they are the one part of
  // the wheel that breaks its circle.
  const st = Math.max(0.15, radius * 0.06)
  if (detail >= 2 && spokes <= 8) {
    for (let i = 0; i < spokes; i++) {
      const a = (2 * Math.PI * i) / spokes + Math.PI / spokes
      const H = dirs(Math.cos(a) * radius * 1.12, Math.sin(a) * radius * 1.12)
      boxAt(H, flat(st * 1.1), kind, D)
      n += 1
    }
  }

  return { radius, hubRadius: hubR, teeth, boxes: n }
}

/**
 * armillary — the orrery that crowns the big islands: three concentric
 * brass rings in different planes, a tilted equatorial band, a glowing
 * core, and a tapered stand.
 *
 * ANCHOR: (x, y, z) is the BASE OF THE STAND — y is the surface it sits on,
 * so it drops straight onto a drumPlatform's `topY`.
 *
 * SOLID: only the stand's plinth and column, which are a real obstacle at
 * ankle-to-chest height. DECOR: every ring and the core — they float above
 * head height, they are 15 cm bars, and a player who clips a ring mid-jump
 * should sail through rather than be swatted out of the air.
 *
 * @returns {{topY:number, centreY:number, radius:number, boxes:number}}
 */
export function armillary(L, x, y, z, opts = {}) {
  const {
    radius = 2.6, standHeight = 1.8, kind = 'brass', detail = 2,
  } = opts
  const { S, D } = emit(L, opts)
  const segs = detail >= 2 ? 16 : detail === 1 ? 10 : 6
  const t = Math.max(0.14, radius * 0.07)
  let n = 0

  // Stand: plinth, tapered column, collar.
  n += disc(S, x, y + 0.18, z, radius * 0.5, 0.36, 'porcelain', detail >= 1 ? 3 : 1)
  n += disc(S, x, y + 0.36 + standHeight * 0.5, z, radius * 0.17, standHeight, kind,
    detail >= 1 ? 2 : 1)
  n += disc(S, x, y + 0.36 + standHeight, z, radius * 0.28, 0.2, kind, detail >= 1 ? 2 : 1)

  const cy = y + 0.46 + standHeight + radius
  // Orrery rings are real tori now. A ring is the one shape a box union can
  // never fake — the reference's armillaries are 15 cm brass bar bent round a
  // circle, and a bar has no flats in it anywhere.
  const ring = (r, plane, tt, lift = 0) => {
    if (!L.mesh) {
      return ringOfBoxes((cx, cyy, cz, bx, by, bz, k) => D(cx, cyy, cz, bx, by, bz, k),
        x, cy + lift, z, r, tt, segs, plane, kind, tt)
    }
    const geo = new THREE.TorusGeometry(r, tt / 2, detail >= 2 ? 6 : 4, segs)
    L.mesh(kind, geo, place(x, cy + lift, z, planeQuat(plane)))
    return 1
  }

  n += ring(radius, 'xy', t)                 // meridian
  n += ring(radius * 0.99, 'zy', t)          // second meridian
  n += ring(radius * 0.82, 'xz', t * 1.4)    // equator, heavier band
  if (detail >= 1) n += ring(radius * 0.6, 'xz', t)   // inner tropic
  if (detail >= 2) {
    // A tilted band lifted off centre — enough to break the perfect
    // concentricity that reads as CAD.
    n += ring(radius * 0.72, 'xz', t, radius * 0.34)
    // Polar axis through the whole assembly.
    n += D(x, cy, z, t, radius * 2.3, t, kind)
  }
  // The little sun at the centre.
  if (L.mesh) {
    L.mesh('terracotta', new THREE.IcosahedronGeometry(radius * 0.13, 1),
      place(x, cy, z, _q.identity()))
    n += 1
  } else {
    n += D(x, cy, z, radius * 0.2, radius * 0.2, radius * 0.2, 'terracotta')
  }

  return { topY: cy + radius, centreY: cy, radius, boxes: n }
}

/**
 * observatoryDome — reference image 1's centrepiece: a faceted sandstone
 * drum with recessed windows and a brass string course, a stepped dome
 * above it, a cage of brass ribs over the dome, a finial, and a telescope
 * barrel poking out of a shutter slot.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE BUILDING'S FOOTPRINT AT ITS BASE —
 * y is the ground the drum stands on.
 *
 * SOLID: the drum, every dome course, and the telescope barrel. The dome is
 * a stepped mass the player will absolutely try to run up, and the barrel
 * is a genuine (and delightful) ledge to land on.
 * DECOR: the window glass (recessed inside the solid wall, so it can never
 * be the thing you land on), the brass ribs (they hug the dome courses that
 * are already solid), and the finial above the apex.
 *
 * @returns {{roofY:number, topY:number, radius:number, boxes:number}}
 */
export function observatoryDome(L, x, y, z, opts = {}) {
  const {
    radius = 5, wallHeight = 6, kind = 'porcelain', detail = 2,
    telescope = detail >= 1, ribs = detail >= 1, windows = detail >= 1,
  } = opts
  const rand = pick(opts)
  const facets = opts.facets ?? (detail >= 2 ? 4 : detail === 1 ? 3 : 1)
  const { S, D } = emit(L, opts)
  let n = 0

  // Plinth and drum, in courses so the wall has horizontal joints.
  n += disc(S, x, y + 0.25, z, radius * 1.1, 0.5, kind, facets)
  const courses = detail >= 2 ? 4 : detail === 1 ? 2 : 1
  for (let i = 0; i < courses; i++) {
    const h = wallHeight / courses
    n += disc(S, x, y + 0.5 + h * (i + 0.5), z, radius * (1 - i * 0.012), h, kind, facets)
  }
  const roofY = y + 0.5 + wallHeight

  if (windows) {
    // Tall recessed lights, set INSIDE the wall face so they never present a
    // ledge. Teal glass, per the art direction's verdigris accents.
    const count = detail >= 2 ? 8 : 5
    for (let i = 0; i < count; i++) {
      const a = (2 * Math.PI * i) / count + 0.2
      const c = Math.cos(a), s = Math.sin(a)
      n += D(x + c * radius * 0.92, y + 0.5 + wallHeight * 0.55, z + s * radius * 0.92,
        Math.max(0.5, Math.abs(s) * 1.3), wallHeight * 0.42, Math.max(0.5, Math.abs(c) * 1.3),
        'moss')
    }
  }
  // Brass string course under the cornice — a swept ring moulding rather than
  // a flat band, so it has a top and a bottom edge that each catch light.
  n += disc(D, x, roofY - 0.35, z, radius * 1.03, 0.22, 'brass', facets, 1,
    { hidden: !!L.mesh })
  if (L.mesh) {
    L.mesh('brass', latheGeometry([
      [radius * 0.99, -0.11], [radius * 1.03, -0.07],
      [radius * 1.03, 0.05], [radius * 0.99, 0.11],
    ], detail >= 2 ? 20 : 12, { capTop: false, capBottom: false }),
    place(x, roofY - 0.35, z, _q.identity()))
    n += 1
  }
  // Cornice: the dome's landing shelf, and a real swept section on it.
  n += disc(S, x, roofY + 0.22, z, radius * 1.16, 0.44, 'terracotta', facets)
  if (L.mesh && detail >= 1) {
    const segs = detail >= 2 ? 20 : 12
    const proj = 0.24
    const path = []
    for (let i = 0; i < segs; i++) {
      const th = (2 * Math.PI * i) / segs
      const rr = radius * 1.16 - proj - 0.02
      // Swept INSIDE the shelf's own slab (roofY..roofY+0.44), not on top of
      // it: the shelf is a landing the player lands on, and a 22 cm moulding
      // standing proud of a walkable surface with no collider under it is the
      // forbidden bug in miniature.
      path.push([x + Math.cos(th) * rr, roofY + 0.22, z + Math.sin(th) * rr])
    }
    L.mesh('terracotta', extrudeAlong(corniceShape(proj, 0.22, 3), path,
      { closed: true, detail: detail >= 2 ? 2 : 1 }),
    place(0, 0, 0, _q.identity()), { shade: 1.05 })
    n += 1
  }

  // Dome: stepped stone courses carry the COLLISION, because a dome the player
  // runs up has to behave the same way every time. The visible dome is a real
  // revolved shell drawn just inside those courses — a hemisphere is the one
  // form where a stepped approximation is unmistakable at any distance, and
  // this is the building the whole last section is an approach to.
  const domeR = radius * 0.98
  const steps = detail >= 2 ? 6 : detail === 1 ? 4 : 2
  let apex = roofY + 0.44
  const shell = L.mesh ? [] : null
  for (let i = 0; i < steps; i++) {
    const t0 = (i / steps) * (Math.PI / 2)
    const t1 = ((i + 1) / steps) * (Math.PI / 2)
    const rr = domeR * Math.cos(t0 * 0.94)
    const y0 = roofY + 0.44 + domeR * 0.86 * Math.sin(t0)
    const y1 = roofY + 0.44 + domeR * 0.86 * Math.sin(t1)
    n += disc(S, x, (y0 + y1) / 2, z, rr, Math.max(0.2, y1 - y0), 'terracotta',
      Math.max(1, facets - 1), 1, { hidden: !!shell })
    apex = y1
  }
  const domeRects = discRects(domeR, Math.max(1, facets - 1), 1)
  if (shell) {
    // LOFTED ALONG THE COURSES' OWN OUTLINE, not revolved — the same
    // correction `drumPlatform`'s body needed, for the same reason.
    //
    // This was a lathe at 0.93 of the stepped courses' half-width across
    // flats, described as leaving "eight narrow slivers at the facet corners".
    // Measured by `tools/hollow.mjs` those slivers are 0.95 m deep on the big
    // dome: a player runs up the dome and stands the better part of a metre
    // outside anything that is drawn. Sweeping the courses' own outline makes
    // the drawn surface agree with the collider at every azimuth, and the only
    // clearance left is the 2 cm inset.
    //
    // `cos(t * 0.94)` is exactly the radial scale each stepped course already
    // uses, so the profile below IS the course stack — the loft interpolates
    // between the steps instead of approximating them with a circle.
    const SEG = detail >= 2 ? 12 : 7
    for (let i = 0; i <= SEG; i++) {
      const t = (i / SEG) * (Math.PI / 2)
      shell.push([Math.cos(t * 0.94), domeR * 0.86 * Math.sin(t)])
    }
    // Shut the crown. `cos(0.94 * PI/2)` is 0.094, not 0, so the profile above
    // ends on an open ring half a metre across with the finial's sky behind it.
    shell.push([0, domeR * 0.86])
    L.mesh('terracotta',
      loftOutline(discOutline(domeRects, 0.02, cornerChamfer(domeRects, 0.045)), shell,
        // The base sits on the cornice shelf, which is a solid drawn disc
        // 16% wider than the dome. Nothing can see the underside.
        { capBottom: false }),
      place(x, roofY + 0.44, z, _q.identity()))
    n += 1
  }

  if (ribs) {
    // Meridian ribs over the dome: overhead ornament, hugging solid courses.
    //
    // A rib is a bent brass bar, and a bar bent over a dome has no flats in it
    // anywhere, so this is `sweepTube` along the dome's own meridian rather
    // than the staircase of little boxes it used to be. The path is sampled
    // from the same profile the shell is swept from, offset 6 cm out, so a rib
    // sits ON the dome instead of cutting through it.
    //
    // The dome is a faceted union now, not a circle, so the offset has to be
    // taken from the union's radius AT THE RIB'S OWN AZIMUTH. On a circle they
    // are the same number; on the union they differ by up to 4%, which at this
    // radius is a rib buried in the roof for half its length.
    const count = detail >= 2 ? 8 : 5
    for (let i = 0; i < count; i++) {
      const a = (2 * Math.PI * i) / count
      const c = Math.cos(a), s = Math.sin(a)
      if (L.mesh) {
        const pts = []
        const SEG = detail >= 2 ? 9 : 6
        const rAz = unionRadiusAt(domeRects, a)
        for (let k = 0; k <= SEG; k++) {
          const t = (k / SEG) * (Math.PI / 2)
          const rr = rAz * Math.cos(t * 0.94) + 0.06
          pts.push([x + c * rr, roofY + 0.44 + domeR * 0.86 * Math.sin(t) + 0.05, z + s * rr])
        }
        L.mesh('brass', sweepTube(pts, 0.075, {
          detail: detail >= 2 ? 1 : 0, capStart: false, capEnd: false,
        }), place(0, 0, 0, _q.identity()), { shade: 1.06 })
        n += 1
      } else {
        n += strut((cx, cy, cz, bx, by, bz, k) => D(cx, cy, cz, bx, by, bz, k),
          x + c * domeR, roofY + 0.6, z + s * domeR,
          x + c * domeR * 0.12, apex + 0.1, z + s * domeR * 0.12,
          0.2, detail >= 2 ? 5 : 3, 'brass')
      }
    }
    // The latitude hoop that ties the ribs together.
    if (L.mesh) {
      const hr = domeR * 0.78
      L.mesh('brass', new THREE.TorusGeometry(hr, 0.07, detail >= 2 ? 6 : 4,
        detail >= 2 ? 20 : 12),
      place(x, roofY + 0.44 + domeR * 0.5, z, planeQuat('xz')))
      n += 1
    } else {
      n += ringOfBoxes((cx, cy, cz, bx, by, bz, k) => D(cx, cy, cz, bx, by, bz, k),
        x, roofY + 0.44 + domeR * 0.5, z, domeR * 0.78, 0.16,
        detail >= 2 ? 16 : 10, 'xz', 'brass')
    }
  }

  // Finial.
  n += D(x, apex + 0.45, z, 0.34, 0.9, 0.34, 'brass')
  n += D(x, apex + 1.0, z, 0.6, 0.18, 0.6, 'brass')

  let topY = apex + 1.1
  if (telescope) {
    // Barrel out of a shutter slot, raked up and out. Solid: it is a ledge.
    const a = rand() * Math.PI * 2
    const c = Math.cos(a), s = Math.sin(a)
    const y0 = roofY + domeR * 0.5
    const len = radius * 1.5
    n += strut((cx, cy, cz, bx, by, bz, k) => S(cx, cy, cz, bx, by, bz, k),
      x + c * domeR * 0.2, y0, z + s * domeR * 0.2,
      x + c * (domeR * 0.2 + len), y0 + len * 0.72, z + s * (domeR * 0.2 + len),
      0.62, detail >= 2 ? 6 : 3, 'brass')
    // Objective ring at the muzzle.
    n += D(x + c * (domeR * 0.2 + len), y0 + len * 0.72, z + s * (domeR * 0.2 + len),
      0.95, 0.95, 0.95, 'brass')
    topY = Math.max(topY, y0 + len * 0.72 + 0.5)
  }

  // ---------------------------------------------------------- the planting
  //
  // The observatory is the building the whole last section is an approach to,
  // and it was 100% bare stone. Ivy off the cornice breaks a 12 m unbroken
  // horizontal edge, and moss round the plinth stops the drum reading as a
  // cylinder set into the ground with a cookie cutter.
  if (detail >= 1) {
    const segs = 6
    for (let i = 0; i < segs; i++) {
      const a = (2 * Math.PI * i) / segs
      const c = Math.cos(a), s = Math.sin(a)
      const rr = radius * 1.14
      // A chord of the cornice ring, laid along whichever world axis it is
      // more nearly parallel to — `hangFromEdge` runs on one axis, and picking
      // the closer one keeps the drape tangential rather than radial.
      const alongX = Math.abs(c) < Math.abs(s)
      const runLen = radius * 0.9
      drape(L, {
        x: x + c * rr - (alongX ? runLen / 2 : 0),
        y: roofY + 0.2,
        z: z + s * rr - (alongX ? 0 : runLen / 2),
        axis: alongX ? 'x' : 'z',
        length: runLen,
        outward: alongX ? Math.sign(s) || 1 : Math.sign(c) || 1,
      }, { drop: [1.0, 2.4], pitch: 0.7 })
    }
    // Moss out of the plinth/ground junction, all the way round.
    for (const [ox, oz, ax2] of [[0, -1, 'x'], [0, 1, 'x'], [-1, 0, 'z'], [1, 0, 'z']]) {
      const w = radius * 1.9
      mossJunction(L, {
        x: x + ox * radius * 1.12 - (ax2 === 'x' ? w / 2 : 0),
        y: y + 0.5,
        z: z + oz * radius * 1.12 - (ax2 === 'z' ? w / 2 : 0),
        axis: ax2, length: w, width: 0.5,
      }, { density: 4.0 })
    }
  }

  return { roofY: roofY + 0.44, topY, radius, boxes: n }
}

/**
 * cypress — the dark narrow conifers that punctuate every island: a
 * tapering stack of moss boxes, each rotated in footprint against the last
 * so the silhouette is ragged rather than a chimney.
 *
 * ANCHOR: (x, y, z) is the TREE'S BASE — y is the ground it grows from.
 *
 * DECOR: always, and the `ghost` option is ignored. A tree is never a
 * platform; a 40 cm trunk collider on a running line is a movement bug, and
 * foliage you can brush through is the correct feel.
 *
 * @returns {{topY:number, height:number, boxes:number}}
 */
export function cypress(L, x, y, z, opts = {}) {
  const { height = 7, kind = 'moss', detail = 2, trunk = detail >= 2 } = opts
  const rand = pick(opts)
  const layers = detail >= 2 ? 6 : detail === 1 ? 4 : 2
  let n = 0

  if (trunk) {
    if (L.mesh) {
      // A real trunk: a swept tube that leans, tapers and is not vertical.
      // A box for a trunk is the one thing that gives a stand of trees away
      // instantly, because every trunk in the stand is then parallel.
      const lean = 0.04 + rand() * 0.06
      const dir = rand() * 6.283
      const pts = []
      const H = height * 0.30
      for (let k = 0; k <= 4; k++) {
        const t = k / 4
        pts.push([
          x + Math.cos(dir) * lean * height * t * t,
          y + H * t,
          z + Math.sin(dir) * lean * height * t * t,
        ])
      }
      L.mesh('terracotta', sweepTube(pts, height * 0.035, {
        detail: detail >= 2 ? 1 : 0, taper: 0.62, capStart: false, capEnd: false,
      }), place(0, 0, 0, _q.identity()), { shade: 0.86 })
      n += 1
    } else {
      L.decor(x, y + height * 0.06, z, height * 0.055, height * 0.14, height * 0.055, 'terracotta')
      n += 1
    }
  }
  const base = y + height * (trunk ? 0.08 : 0)
  const span = height - (base - y)

  if (L.mesh) {
    // A revolved silhouette with a jagged profile: each layer's skirt flares
    // out and pinches back in, so the outline is a stack of soft cones rather
    // than a chimney of cubes. Revolving it is what buys the round read; the
    // per-layer jitter is what stops a stand of them looking cloned.
    const prof = [[height * 0.012, 0]]
    for (let i = 0; i < layers; i++) {
      const f = i / layers
      const taper = (1 - f * 0.92) * (1 - f * 0.30)
      const w = height * 0.115 * taper * (0.86 + rand() * 0.3)
      prof.push([w, span * (f + 0.30 / layers)])
      prof.push([w * (0.56 + rand() * 0.14), span * (f + 0.96 / layers)])
    }
    prof.push([height * 0.008, span])
    L.mesh(kind, latheGeometry(prof, detail >= 2 ? 9 : 6),
      place(x, base, z, _q.setFromEuler(_e.set(0, rand() * 6.283, 0))))
    n += 1
  } else {
    for (let i = 0; i < layers; i++) {
      const f = i / layers
      const h = span / layers
      const w = height * 0.20 * (1 - f) * (1 - f * 0.45) + height * 0.02
      L.decor(x + (rand() - 0.5) * w * 0.22, base + h * (i + 0.5),
        z + (rand() - 0.5) * w * 0.22, w, h * 1.05, w * (0.82 + rand() * 0.34), kind)
      n += 1
    }
    L.decor(x, y + height * 0.99, z, height * 0.03, height * 0.1, height * 0.03, kind)
    n += 1
  }

  // A skirt of real leaf cards round the base. A lathed cone reads as a
  // cypress in silhouette and as a cone up close; the cards are what put a
  // broken, translucent edge on it where the player can see one.
  if (detail >= 2) {
    plant(L, x, z, (field) => {
      const r = height * 0.13
      let placed = 0
      const tufts = 7 + ((rand() * 5) | 0)
      for (let i = 0; i < tufts; i++) {
        const a = rand() * 6.283
        const d = r * (0.4 + rand() * 0.8)
        field.add(rand() > 0.35 ? 'leaf' : 'fern',
          x + Math.cos(a) * d, y, z + Math.sin(a) * d,
          { height: 0.26 + rand() * 0.26 })
        placed++
      }
      return placed
    })
  }

  return { topY: y + height, height, boxes: n }
}

/**
 * vineCurtain — ivy trailing off a ledge in strands of varied length, with
 * a thicker mat where it grips the lip.
 *
 * ANCHOR: (x, y, z) is a point ON THE EDGE IT HANGS FROM — y is the lip
 * height. Everything is emitted BELOW y, spread along `axis` over `length`.
 *
 * DECOR: unconditionally, and by construction it can only exist under the
 * lip, so it can never masquerade as a surface. `ghost` is ignored.
 *
 * @returns {{bottomY:number, length:number, boxes:number}}
 */
export function vineCurtain(L, x, y, z, opts = {}) {
  const {
    length = 6, drop = 4, axis = 'x', kind = 'moss', detail = 2, density = 1,
  } = opts
  const rand = pick(opts)
  const F = frame(axis)
  const pitch = (detail >= 2 ? 0.55 : detail === 1 ? 1.0 : 2.0) / Math.max(0.25, density)
  let n = 0
  let lowest = y

  // The mat along the lip — thin, and tucked just under it.
  const [mx, mz] = F.at(x, z, length / 2, 0)
  const [msx, msz] = F.sz(length, 0.36)
  L.decor(mx, y - 0.16, mz, msx, 0.32, msz, kind)
  n += 1

  // THE MASS is instanced cards now, not boxes: an ivy strand drawn as a
  // 20 cm prism is a green stick, and this prefab is placed on every island
  // rim in the world, so it was a green stick sixty times over. The cards
  // carry an alpha-tested silhouette and a wind term for a sixth of the cost.
  const placed = drape(L, { x, y, z, axis, length, outward: 1 }, {
    drop: [drop * 0.3, drop],
    pitch,
    jitter: 0.24,
  })

  if (placed > 0) {
    // Two hero strands as real swept tubes, for the ones the player passes
    // within arm's reach of.
    if (L.mesh && detail >= 2) {
      for (let i = 0; i < 2; i++) {
        const a = length * (0.25 + rand() * 0.5)
        const [sx, sz] = F.at(x, z, a, 0)
        const len = drop * (0.5 + rand() * 0.5)
        const rope = vineRope(sx, y - 0.1, sz, {
          drop: len, reach: 0.2 + rand() * 0.3,
          dir: axis === 'x' ? [0, 1] : [1, 0],
          seed: ((rand() * 0xffffff) | 0) || 1,
        })
        L.mesh(kind, sweepTube(rope, 0.045, {
          detail: 1, taper: 0.35, capStart: false, capEnd: false,
        }), place(0, 0, 0, _q.identity()), { shade: 0.92 })
        n += 1
        lowest = Math.min(lowest, y - 0.1 - len)
      }
    }
    lowest = Math.min(lowest, y - drop)
  } else {
    // No foliage channel (node, or a field that failed to build): fall back to
    // the box strands rather than leaving every rim in the world bare.
    for (let a = pitch * 0.5; a < length; a += pitch) {
      const len = drop * (0.28 + rand() * 0.72)
      const w = 0.16 + rand() * 0.2
      const [sx, sz] = F.at(x, z, a, (rand() - 0.5) * 0.3)
      L.decor(sx, y - 0.3 - len / 2, sz, w, len, w * 0.8, kind)
      n += 1
      if (detail >= 2 && len > drop * 0.6) {
        L.decor(sx, y - 0.3 - len * 0.55, sz, w * 2.4, len * 0.2, w * 2.0, kind)
        n += 1
      }
      lowest = Math.min(lowest, y - 0.3 - len)
    }
  }

  return { bottomY: lowest, length, boxes: n }
}

/**
 * waterfall — a pale column spilling off an island edge into cloud: a
 * gathering lip, a falling ribbon that widens and frays as it drops, and a
 * burst of spray where it dissolves.
 *
 * ANCHOR: (x, y, z) is the LIP THE WATER LEAVES — y is the top of the fall;
 * the column descends from there.
 *
 * DECOR: unconditionally. Falling water is not a platform, and a collider
 * here would stop a player mid-dive off the island. `ghost` is ignored.
 *
 * @returns {{bottomY:number, width:number, boxes:number}}
 */
export function waterfall(L, x, y, z, opts = {}) {
  const {
    height = 18, width = 1.6, kind = 'porcelain', detail = 2, spray = true,
  } = opts
  const rand = pick(opts)
  const segs = detail >= 2 ? 6 : detail === 1 ? 4 : 2
  let n = 0

  // Lip: the water gathers and rounds over the edge.
  L.decor(x, y - 0.12, z, width * 1.25, 0.28, width * 0.9, kind)
  n += 1

  // The wet margin. Ferns and moss at the head of a fall is the single most
  // reliable "this place has water in it" cue the reference uses, and it costs
  // a dozen cards. Everything sits AT the lip height, so nothing here can be
  // mistaken for a step down into the fall.
  if (detail >= 1) {
    plant(L, x, z, (field) => scatterOnBox(field, {
      cx: x, cy: y, cz: z, sx: width * 3.2, sy: 0, sz: width * 2.6,
    }, {
      mix: [['fern', 4], ['grass', 3], ['moss', 2], ['leaf', 1]],
      density: 2.6, clump: 0.4, maxHeight: 0.3, inset: 0.15, y: y + 0.02,
    }))
  }

  for (let i = 0; i < segs; i++) {
    const f = (i + 0.5) / segs
    const h = height / segs
    const w = width * (1 + f * 0.55)
    L.decor(x + (rand() - 0.5) * width * 0.25, y - 0.2 - h * (i + 0.5),
      z + (rand() - 0.5) * width * 0.2, w, h * 1.02, w * 0.55, kind)
    n += 1
    // A frayed outrider ribbon on the lower half.
    if (detail >= 2 && f > 0.4) {
      L.decor(x + (rand() - 0.5) * width * 1.4, y - 0.2 - h * (i + 0.5), z,
        width * 0.3, h * 0.8, width * 0.3, kind)
      n += 1
    }
  }

  const bottomY = y - 0.2 - height
  if (spray) {
    const puffs = detail >= 2 ? 4 : 2
    for (let i = 0; i < puffs; i++) {
      const w = width * (1.6 + rand() * 1.8)
      L.decor(x + (rand() - 0.5) * width * 2, bottomY + rand() * 1.6,
        z + (rand() - 0.5) * width * 2, w, 0.8 + rand(), w * 0.8, kind)
      n += 1
    }
  }

  return { bottomY, width, boxes: n }
}

/**
 * stairFlight — a carved sandstone stair with side cheeks, a nosing course
 * on each tread, and moss crept over the bottom two steps where the shade
 * sits.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE BOTTOM STEP'S FRONT EDGE AT FLOOR
 * LEVEL — the flight climbs along `axis` in the +ve direction, so the first
 * tread is at y + rise.
 *
 * SOLID: every tread and both cheeks. Treads are the definition of a
 * walkable surface, and the cheeks are the wall a player wall-runs along
 * on the way up. Only the tiny brass nosing studs are decor, and they sit
 * flush in the tread they garnish.
 *
 * @returns {{topY:number, run:number, width:number, boxes:number}}
 */
export function stairFlight(L, x, y, z, opts = {}) {
  const {
    steps = 8, rise = 0.55, run = 1.6, width = 6, kind = 'porcelain',
    axis = 'x', detail = 2, cheeks = true, moss = true,
  } = opts
  const F = frame(axis)
  const { S, D } = emit(L, opts)
  let n = 0

  for (let i = 0; i < steps; i++) {
    const h = y + rise * (i + 1)
    const a = run * (i + 0.5)
    const [cx, cz] = F.at(x, z, a, 0)
    // Each tread is a full-depth block down to the floor line minus a bit,
    // exactly like Level.stair() — the controller's step-up eats these.
    const [sx, sz] = F.sz(run, width)
    // Slightly under-lit against the nosing above it, so the pair reads as
    // tread-then-riser at a glance instead of as one continuous ramp.
    n += S(cx, h - rise / 2 - 0.4, cz, sx, rise + 0.8, sz, kind, { shade: 0.94 })
    // Nosing: a proud lip on the front of the tread, deliberately over-lit.
    //
    // The art review measured a 15-luma spread across this entire staircase —
    // the step edges were drawn at exactly the weight of the decorative block
    // joints inside each face, so the ascent was a guess rather than a read.
    // Tread-versus-riser is the load-bearing silhouette in a first-person
    // parkour game, so this strip gets a flat +30% albedo that holds whatever
    // the sun is doing, and the riser under it gets a matching darkening.
    if (detail >= 1) {
      const [nx, nz] = F.at(x, z, run * i + run * 0.08, 0)
      const [nsx, nsz] = F.sz(run * 0.16, width * 0.99)
      n += S(nx, h - 0.06, nz, nsx, 0.12, nsz, kind, { shade: 1.32 })
      // THE BEVEL COURSE under the nosing (roadmap: "step, cornice and string
      // course helpers get a 3-5 cm bevel course inset from the mass below, so
      // every horizontal edge self-shadows"). 4 cm tall, set BACK 5 cm from
      // the nosing above it, so the nosing overhangs it and lays a hard line
      // across the riser at any sun angle — which is what stops the ascent
      // being a guess. Darkened to make the pair read as light-over-dark.
      const [rx, rz] = F.at(x, z, run * i + run * 0.13, 0)
      const [rsx, rsz] = F.sz(run * 0.10, width * 0.985)
      n += S(rx, h - 0.16, rz, rsx, 0.04, rsz, kind, { shade: 0.74 })
    }
    // Moss crept over the shaded bottom steps.
    if (moss && i < 2) {
      const [gx, gz] = F.at(x, z, a, 0)
      const [gsx, gsz] = F.sz(run * 0.94, width * (i === 0 ? 0.98 : 0.6))
      n += S(gx, h + 0.05, gz, gsx, 0.14, gsz, 'moss')
    }
  }

  const topY = y + rise * steps
  if (cheeks) {
    for (const side of [-1, 1]) {
      // A raking cheek wall, stepped to follow the nosing line.
      const cs = detail >= 2 ? steps : Math.max(2, steps >> 1)
      const per = steps / cs
      for (let i = 0; i < cs; i++) {
        const a = run * per * (i + 0.5)
        const h = y + rise * per * (i + 1)
        const [cx, cz] = F.at(x, z, a, side * (width / 2 + 0.35))
        const [sx, sz] = F.sz(run * per, 0.7)
        n += S(cx, h - 0.1, cz, sx, rise * per + 1.4, sz, kind)
      }
      // Newel posts, bottom and top.
      for (const [a, h] of [[-0.35, y], [run * steps + 0.35, topY]]) {
        const [px, pz] = F.at(x, z, a, side * (width / 2 + 0.35))
        n += S(px, h + 0.55, pz, 0.9, 1.5, 0.9, kind)
        n += D(px, h + 1.45, pz, 0.42, 0.42, 0.42, 'brass')
      }
    }
  }

  // ---------------------------------------------------------- the planting
  //
  // Moss in the angle where each tread meets its cheek wall — the damp corner
  // of a real stair, and the junction the review measured as "perfectly clean
  // hard lines". Kept to the outer 60 cm of each side so the running line down
  // the middle of the flight stays clear paving.
  if (detail >= 1 && cheeks) {
    for (const side of [-1, 1]) {
      for (let i = 0; i < steps; i += 1) {
        const h = y + rise * (i + 1)
        const [gx, gz] = F.at(x, z, run * i + run * 0.12, side * (width / 2 - 0.3))
        mossJunction(L, {
          x: gx, y: h + 0.02, z: gz, axis, length: run * 0.8, width: 0.5,
        }, { density: 3.0, maxHeight: 0.16 })
      }
    }
    // Grass and ferns tumbling over the outside of the cheek walls.
    for (const side of [-1, 1]) {
      const [dx, dz] = F.at(x, z, 0, side * (width / 2 + 0.7))
      drape(L, { x: dx, y: y + 0.9, z: dz, axis, length: run * steps, outward: side },
        { drop: [0.4, 1.0], pitch: 1.6 })
    }
  }

  return { topY, run: run * steps, width, boxes: n }
}

/**
 * lanternPost — the brass standard that carries a lantern, plus the lantern
 * itself via `L.lantern()`.
 *
 * This is the one prefab that is level design rather than decoration: every
 * lantern is a grapple anchor, so placing one authors a 34 m reachable
 * volume. That is why the flame's world position is returned — a caller
 * sizing a crossing needs the number, not a vibe.
 *
 * ANCHOR: (x, y, z) is the FOOT of the post; the flame sits at y + height.
 *
 * SOLID: the plinth and the shaft. The placement contract that makes this
 * safe is the caller's, not the prefab's — a standard belongs at a parapet,
 * a corner, or against a wall, never on the running line, because a 30 cm
 * collider in the middle of a sprint is a momentum bug (taste.md). Pass
 * `{ post: false }` for the bracket form, which hangs the lantern off an
 * entablature or wall with no floor footprint at all and is the right
 * choice anywhere near the route.
 * DECOR: the cage, the finial and the bracket arm — all above head height.
 *
 * @returns {{flame:[number,number,number], topY:number, boxes:number}}
 */
export function lanternPost(L, x, y, z, opts = {}) {
  const {
    height = 3.2, kind = 'brass', detail = 2, post = true,
    reach = 0, axis = 'x', color,
  } = opts
  const F = frame(axis)
  const { S, D } = emit(L, opts)
  let n = 0

  if (post) {
    // Plinth, tapered shaft, collar. Two courses on the plinth so the base
    // has a chamfer instead of reading as a peg pushed into the floor.
    n += disc(S, x, y + 0.13, z, 0.42, 0.26, 'porcelain', detail >= 1 ? 3 : 1)
    n += disc(S, x, y + 0.34, z, 0.31, 0.18, kind, detail >= 1 ? 3 : 1)
    n += disc(S, x, y + 0.43 + (height - 0.9) / 2, z, 0.13, height - 0.9, kind,
      detail >= 1 ? 2 : 1)
    n += disc(S, x, y + height - 0.45, z, 0.22, 0.16, kind, detail >= 1 ? 2 : 1)
  }

  // Optional bracket arm, so a lantern can be hung off a wall or a cornice
  // and put its anchor out over a void where the crossing actually needs it.
  let [fx, fz] = [x, z]
  if (reach) {
    const [ax, az] = F.at(x, z, reach / 2, 0)
    const [asx, asz] = F.sz(Math.abs(reach), 0.16)
    n += D(ax, y + height - 0.34, az, asx, 0.16, asz, kind)
    ;[fx, fz] = F.at(x, z, reach, 0)
    // A diagonal knee under the arm; a cantilever with nothing under it reads
    // as a floating stick.
    if (detail >= 1) {
      n += strut((cx, cy, cz, bx, by, bz, k) => D(cx, cy, cz, bx, by, bz, k),
        x, y + height - 1.1, z, fx, y + height - 0.42, fz, 0.13, 3, kind)
    }
  }

  // Cage: four uprights and a capping cone, around where the glow sits.
  const fy = y + height
  if (detail >= 1) {
    for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      n += D(fx + ox * 0.26, fy, fz + oz * 0.26, 0.09, 0.86, 0.09, kind)
    }
    n += D(fx, fy - 0.46, fz, 0.72, 0.12, 0.72, kind)
    n += D(fx, fy + 0.5, fz, 0.66, 0.14, 0.66, kind)
    n += D(fx, fy + 0.66, fz, 0.34, 0.22, 0.34, kind)
  }
  n += D(fx, fy + 0.86, fz, 0.14, 0.3, 0.14, kind)

  // The glow itself, and with it the grapple anchor.
  if (L.lantern) L.lantern(fx, fy, fz, color)

  return { flame: [fx, fy, fz], topY: fy + 1.0, boxes: n }
}

// ------------------------------------------------------------------ export

export const PREFABS = {
  drumPlatform, archway, colonnade, balustrade, gearWheel, armillary,
  observatoryDome, cypress, vineCurtain, waterfall, stairFlight, lanternPost,
}

/**
 * A recording facade over PREFABS, plus the assertion that closes the loop.
 *
 * The failure this exists to make impossible: every prefab in this file was
 * written, none was ever imported, and eight captures went by with not one
 * arch, gear, vine or dome in them while `npm run build` stayed green. A
 * dead export is invisible; a thrown error is not. `buildCourse()` calls
 * `assertAllPlaced()` at the end, so an unplaced prefab takes the game down
 * on load — which the headless shot harness reports as a page error and
 * fails on. Build-green is no longer a way to ship a rotting kit.
 */
export function trackedKit() {
  const placed = new Set()
  const api = {}
  let level = null
  // THE CURVE GATE, at the one point every prefab call passes through. When the
  // active look forbids curves, hand each prefab a mesh-less view of the Level
  // (see `lookMeshless`) so the whole shared kit takes its box fallback in one
  // place, rather than threading a flag through a dozen prefabs. `modern` /
  // `no-foliage` keep curves on, so `meshless` is false and the Level is passed
  // straight through, unchanged. One view per Level so `level` (used for the
  // foliage flush) stays a single object.
  const meshless = !curvesEnabled()
  const views = meshless ? new WeakMap() : null
  const asLevel = (L) => {
    if (!meshless || !L || typeof L !== 'object') return L
    let v = views.get(L)
    if (!v) { v = lookMeshless(L); views.set(L, v) }
    return v
  }
  for (const [name, fn] of Object.entries(PREFABS)) {
    api[name] = (...args) => {
      placed.add(name)
      // Every prefab takes the Level first. Remembering it is what lets
      // `assertAllPlaced` flush the vegetation without level.js having to know
      // the foliage layer exists — see THE FOLIAGE CHANNEL in the header.
      if (args.length && args[0] && typeof args[0] === 'object') {
        args[0] = asLevel(args[0])
        level = args[0]
      }
      return fn(...args)
    }
  }
  api.placed = placed
  /**
   * @param {string[]} [expected] the prefabs THIS course claims to use.
   *
   * Defaults to the whole kit, which is what `buildCourse()` still gets. The
   * parameter exists because "every declared prefab is placed" stops being
   * checkable from one course the moment there are two: the void course
   * legitimately places no waterfall, cypress or vine curtain, and without
   * this it simply throws on boot.
   */
  api.assertAllPlaced = (expected = Object.keys(PREFABS)) => {
    const unknown = expected.filter((k) => !PREFABS[k])
    if (unknown.length) {
      throw new Error(`course expects prefabs that do not exist: ${unknown.join(', ')}`)
    }
    const missing = expected.filter((k) => !placed.has(k))
    if (missing.length) {
      throw new Error(`kit prefabs declared but never placed in the course: ${missing.join(', ')}`)
    }
    // THE FLUSH. `buildCourse()` calls this as its last act and `Level.build()`
    // runs after it, so a group added here is in the scene. Fields have to be
    // built after the last `add()` — an InstancedMesh is sized once — and this
    // is the only end-of-build hook the kit is given.
    if (level) foliageFinish(level)
    return api.foliage()
  }
  api.foliage = () => kitFoliageStats(level)
  return api
}

/**
 * kitSelfTest — build every prefab against a throwaway recorder and report
 * box counts and bounds, so scale can be sanity-checked from a terminal
 * without a browser. Purely diagnostic; it never touches a real Level.
 *
 * @param {object} [overrides] per-prefab option overrides, e.g.
 *   `{ cypress: { detail: 0 } }`.
 * @returns {object} { [name]: { boxes, solid, decor, size, min, max, ret } }
 */
export function kitSelfTest(overrides = {}) {
  const out = {}
  for (const [name, fn] of Object.entries(PREFABS)) {
    const rec = { solid: 0, decor: 0, boxes: [] }
    const push = (cx, cy, cz, sx, sy, sz, kind) => {
      rec.boxes.push([cx, cy, cz, sx, sy, sz, kind])
    }
    const stub = {
      solid: (...a) => { rec.solid++; push(...a); return stub },
      decor: (...a) => { rec.decor++; push(...a); return stub },
      // lanternPost registers a grapple anchor; the recorder only needs to
      // count it, but it must exist or the prefab throws under test.
      lantern: (lx, ly, lz) => { rec.anchors = (rec.anchors || 0) + 1; return stub },
      // The generated-curve channel. Present so the self-test walks the same
      // branch the game does — a stub without it silently tests the fallback
      // box path, which is the code nobody ships.
      mesh: (kind, geo, matrix) => {
        rec.meshes = (rec.meshes || 0) + 1
        rec.meshTris = (rec.meshTris || 0)
          + (geo.index ? geo.index.count : geo.attributes.position.count) / 3
        geo.computeBoundingBox()
        const bb = geo.boundingBox.clone().applyMatrix4(matrix)
        push((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2,
          bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z, kind)
        return stub
      },
    }
    const ret = fn(stub, 0, 0, 0, { seed: 0xC0FFEE, ...(overrides[name] || {}) })
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const b of rec.boxes) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b[k] - b[k + 3] / 2)
        max[k] = Math.max(max[k], b[k] + b[k + 3] / 2)
      }
    }
    const r3 = (v) => v.map((q) => Math.round(q * 100) / 100)
    out[name] = {
      boxes: rec.boxes.length,
      solid: rec.solid,
      decor: rec.decor,
      // The generated-curve channel, reported rather than implied. A prefab
      // that claims to be built on real curves and shows `meshes: 0` here is
      // lying, and this is the number that catches it from a terminal.
      meshes: rec.meshes || 0,
      meshTris: Math.round(rec.meshTris || 0),
      min: r3(min),
      max: r3(max),
      size: r3(max.map((q, k) => q - min[k])),
      ret,
    }
  }
  return out
}
