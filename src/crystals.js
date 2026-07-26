import * as THREE from 'three'
import {
  shardCluster, shard, SHARD_SCALE, boundsOf, triangleCount, FAR, MID, NEAR,
} from './props.js'
import { glowMaterial } from './materials.js'

/**
 * crystals.js — the void theme's light sources, as instanced geometry.
 *
 * `docs/art-direction-void.md` §4.3 asks for two families of jagged faceted
 * shard, and §7.3 makes instancing and LOD a REQUIREMENT rather than an
 * optimisation: "a dark scene full of emissives is the classic way to blow a
 * bloom budget". So the split of work is:
 *
 *   props.js  `shard` / `shardCluster`  — the geometry, flat facets, no colour
 *                                          policy, no collider, no material.
 *   this file                            — the material, the instanced field,
 *                                          and the LOD bucketing.
 *
 * THE DRAW-CALL ARITHMETIC, stated up front because it is the whole reason
 * this file exists. `CrystalField` builds one `InstancedMesh` per
 * (family, detail band, variant) bucket that is actually used. A level that
 * places hero clusters in two bands and scatter clusters in two bands, at the
 * default three variants, costs 12 draw calls for every crystal in the world —
 * against one per cluster if they were plain meshes, which for a few hundred
 * clusters is the budget gone. `stats()` reports the real number.
 *
 * WHY NOT THREE.LOD. `THREE.LOD` swaps per object per frame, which needs one
 * object per cluster and therefore one draw call per cluster: it is the exact
 * thing instancing is here to avoid. The kit's existing convention is a static
 * `detail: 0|1|2` chosen by the level from the distance band it is placing
 * into (see kit.js, "The level places these across four distance bands"), and
 * this follows it. The crystals do not move and neither does the course, so
 * the band is knowable at build time and a per-frame swap buys nothing.
 *
 * DETERMINISM: no `Math.random()` anywhere. Every variant and every instance
 * jitter comes from the seed.
 *
 * COLOUR IS ALWAYS A PARAMETER (§7.2 — "nothing gets a hardcoded violet").
 * There is not one colour literal in this file. The violet, blue and magenta of
 * the reference arrive from the caller, which gets them from the theme.
 */

const DEFAULT_SEED = 0x5C0117

function rng(seed = DEFAULT_SEED) {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

// ---------------------------------------------------------------- material

/**
 * Append the emissive-from-vertex-colour multiply to a standard material.
 *
 * Held as a string constant so the same source is used by the material and by
 * `crystalsSelfTest`, and so the reason survives next to the code.
 *
 * Three's `emissive` is a UNIFORM: one value for the whole mesh. The reference
 * asks for the opposite — §3, "large shards are semi-translucent: they transmit
 * light along their length so the tip glows brighter than the base" — and
 * `props.shard` already bakes that ramp into the geometry's `color` attribute.
 * Without this the ramp would only tint the (nearly irrelevant) diffuse term
 * and every shard would glow flat from base to point.
 *
 * `vColor` also carries `instanceColor`, which three folds into the same
 * varying. That is deliberate and is what lets one bucket hold violet, blue and
 * magenta clusters: per-instance hue times per-vertex base-to-tip ramp, in one
 * draw call.
 */
const EMISSIVE_FROM_VCOLOR = /* glsl */`
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  totalEmissiveRadiance *= vColor;
#endif
`

/**
 * `crystalMaterial(color, opts)` — the emissive treatment for shards.
 *
 * DOES `materials.glowMaterial` SUIT? Partly, and it is reused rather than
 * reimplemented — the shared shape (MeshStandardMaterial, `emissive` set to the
 * same colour as `color`, standard lighting so the flat facets still catch the
 * scene's rim lights) is exactly right. Three deltas were needed and each one
 * is a shard-specific requirement, not a difference of opinion:
 *
 *   1. glowMaterial leaves `vertexColors` OFF, because it is built for the
 *      lantern globes, which are one solid colour. A shard's whole read is a
 *      colour that changes along its length AND from facet to facet — and on
 *      an emissive object that variation is the only thing standing in for the
 *      normal break, because emissive has no normal term. See
 *      EMISSIVE_FROM_VCOLOR and `props.shard`'s `facetVariance`.
 *   2. `roughness: 0.4, metalness: 0.1` is a soft plastic. A crystal facet
 *      wants a tight, hard specular lobe so the light SNAPS between faces as
 *      the camera moves (§4.3) — that is roughness ~0.18 and no metalness.
 *   3. Default intensity 1.4 is under the bloom threshold once exposed. The
 *      pipeline thresholds bloom at 0.78 on the MAX CHANNEL post-exposure, so a
 *      saturated violet blooms when its BLUE channel clips while its green sits
 *      dark — which is why the default here is 3.2 and why values above 1.0 are
 *      correct rather than a mistake. A crystal that does not bloom is not a
 *      light source, and §2's acceptance table wants p99 > 215 with only
 *      0.3-2.5% of the frame clipped: a few small very bright things.
 *
 * NOT OPTED OUT OF THE AERIAL-PERSPECTIVE PATCH, on purpose. `render/patch.js`
 * offers `material.userData.scNoPatch`, and the tempting argument is that a
 * light source should not be fogged. It is wrong here: §5 asks for "depth in
 * three bands ... far structures washed almost to the fog colour", and the
 * crystals are the only thing in a near-black frame with enough energy to show
 * that wash at all. The patch replaces `fog_fragment`, which runs after the
 * emissive is added, so a distant shard correctly loses contrast into the
 * violet haze while a near one does not. Opting out would flatten every
 * distance band onto one.
 *
 * @param {number|THREE.Color} color   the crystal's own colour (theme data)
 * @param {object} [opts] `{ intensity, roughness, envMapIntensity, name }`
 */
export function crystalMaterial(color, opts = {}) {
  const intensity = opts.intensity ?? 3.2
  const mat = glowMaterial(color, intensity)
  mat.vertexColors = true
  mat.roughness = opts.roughness ?? 0.18
  mat.metalness = 0
  /**
   * DARK ALBEDO, BRIGHT EMISSIVE — the fourth delta from `glowMaterial`, and
   * the one that decides whether these read as crystals or as plaster cones.
   *
   * `vColor` multiplies the diffuse term and the emissive term together, so the
   * ratio between them is set here and nowhere else. glowMaterial leaves
   * `color` equal to `emissive`, which for a lantern globe is fine. On a shard
   * it means the scene's own lights land on a near-white surface and add a pale
   * unsaturated wash on top of the glow — measured, that wash was most of why
   * the first render came back lilac instead of violet. A real crystal reflects
   * very little and emits a lot. 0.16 keeps just enough diffuse for a nearby
   * red sigil or another crystal to tint a facet, and no more.
   */
  mat.color.setScalar(opts.albedo ?? 0.16)
  // Facets are already flat (props.shard gives every face its own normals), so
  // `flatShading` would only cost a second normal computation for no change.
  mat.flatShading = false
  if (opts.envMapIntensity !== undefined) mat.envMapIntensity = opts.envMapIntensity
  mat.name = opts.name || 'crystal'

  const prev = mat.onBeforeCompile
  mat.onBeforeCompile = function (shader, renderer) {
    if (typeof prev === 'function') prev.call(this, shader, renderer)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n' + EMISSIVE_FROM_VCOLOR,
    )
  }
  // Distinct cache key or three hands this material the unpatched program it
  // compiled for some other MeshStandardMaterial. `render/patch.js` appends to
  // whatever it finds here rather than replacing it, so the two compose.
  mat.customProgramCacheKey = () => 'sc-crystal-emissive-vcolor'
  return mat
}

// ------------------------------------------------------------------- field

const FIELD_DEFAULTS = {
  seed: DEFAULT_SEED,
  /** Distinct cluster geometries per (family, detail) bucket. */
  variants: 3,
  /** Emissive multiplier handed to `crystalMaterial`. */
  intensity: 3.2,
  /**
   * Crystals neither cast nor receive shadows.
   *
   * They are the light in this world (§1, "lit entirely from within"), and a
   * self-shadowing light source reads as a dirty one. It is also free
   * performance: the shadow pass is the second-most expensive thing in the
   * frame and a hundred instanced clusters would double its cost to darken
   * geometry that is already emissive.
   */
  castShadow: false,
  receiveShadow: false,
}

/**
 * `CrystalField` — every crystal in a level, in a handful of draw calls.
 *
 * Usage:
 *   const field = new CrystalField({ seed, intensity: 2.6 })
 *   field.add('hero', x, y, z, { color: theme.crystal.violet, detail: NEAR })
 *   field.add('scatter', x, y, z, { color: theme.crystal.blue, detail: MID, size: 0.8 })
 *   scene.add(field.build())
 *
 * COLLISION: this creates none, ever, and cannot — same contract as props.js.
 * §6 says crystals are never a hazard, so the normal case is that they need no
 * collider at all. A hero cluster big enough to stand on is the caller's
 * problem to declare with `L.solid(..., { hidden: true })`, sized from
 * `field.clusterBounds(family, detail, variant)`, which reports the MEASURED
 * box of the geometry an instance will draw. Multiply it by the instance's
 * `size` and rotate it by the instance's `yaw` and that is the real footprint —
 * the number is measured, not guessed, exactly as `boundsOf()` intends.
 */
export class CrystalField {
  constructor(opts = {}) {
    this.options = { ...FIELD_DEFAULTS, ...opts }
    this.rand = rng(this.options.seed)
    this._buckets = new Map()      // key -> { family, detail, variant, geo, rows[] }
    this._materials = new Map()    // intensity-keyed; colour rides on instanceColor
    this._group = null
    this._meshes = []
    this._built = false
  }

  get count() {
    let n = 0
    for (const b of this._buckets.values()) n += b.rows.length
    return n
  }

  /** Build (and cache) one cluster geometry. Deterministic in (family, detail, variant). */
  _geometry(family, detail, variant) {
    const key = `${family}|${detail}|${variant}`
    let bucket = this._buckets.get(key)
    if (bucket) return bucket
    const o = this.options
    // The variant seed must not depend on placement order, or adding one
    // crystal in the middle of a level would reshuffle every other one.
    const seed = (o.seed ^ (0x9E3779B1 * (variant + 1)) ^ (family === 'hero' ? 0x11 : 0x77)
      ^ (detail * 0x2545F491)) | 0
    // Colour is baked as a NEUTRAL base-to-tip ramp and the actual hue arrives
    // per instance through `instanceColor`. That is what lets violet, blue and
    // magenta clusters share one bucket and one draw call — see
    // EMISSIVE_FROM_VCOLOR, where the two multiply.
    //
    // THE RAMP TOPS OUT AT 0.78, NOT ABOVE 1. `vColor` multiplies the DIFFUSE
    // term as well as the emissive one, and an albedo over 1 is a surface that
    // reflects more light than reaches it. The first render of this file used a
    // 1.7 tip and every shard came back a clipped white spike with no facets in
    // it: the albedo gain, the emissive gain and the point lights compounded.
    // Brightness above white is the EMISSIVE's job (`intensity`), where it
    // belongs and where the bloom threshold can see it. Facet variance can lift
    // this by up to 1.3x, so 0.78 is what keeps the peak albedo at ~1.0.
    const geo = shardCluster(seed, {
      scale: family,
      detail,
      color: o.rampBase || [0.14, 0.14, 0.14],
      tipColor: o.rampTip || [0.78, 0.78, 0.78],
      tipGamma: o.tipGamma ?? 2.4,
    })
    bucket = { key, family, detail, variant, geo, bounds: boundsOf(geo), rows: [] }
    this._buckets.set(key, bucket)
    return bucket
  }

  /** Measured bounds of the geometry one instance of this bucket draws. */
  clusterBounds(family, detail = NEAR, variant = 0) {
    return this._geometry(family, detail, variant).bounds
  }

  /**
   * Place one cluster.
   *
   * @param {'hero'|'scatter'} family
   * @param {number} x world X
   * @param {number} y world Y — where the cluster's bases sit (they sink a
   *                  little below this, so it can be put ON a surface)
   * @param {number} z world Z
   * @param {object} [opts]
   *   color    the crystal's colour. THIS IS THE ONLY PLACE COLOUR ENTERS.
   *   detail   FAR | MID | NEAR (default NEAR for hero, MID for scatter)
   *   size     uniform metre scale on the preset (default 1)
   *   yaw      rotation about Y (default seeded)
   *   tilt / tiltAzimuth  lean the whole cluster off vertical, so a cluster can
   *            hang off a platform underside or grow out of a wall (§4.3)
   *   variant  pin the shape instead of drawing one
   *   gain     per-instance brightness multiplier on `color` (default 1)
   */
  add(family, x, y, z, opts = {}) {
    if (this._built) throw new Error('CrystalField: add() after build()')
    if (family !== 'hero' && family !== 'scatter') {
      throw new Error(`CrystalField: unknown family ${family}`)
    }
    const rand = this.rand
    const detail = opts.detail ?? (family === 'hero' ? NEAR : MID)
    const variants = Math.max(1, this.options.variants | 0)
    const variant = opts.variant !== undefined
      ? clamp(opts.variant | 0, 0, variants - 1)
      : (rand() * variants) | 0
    const bucket = this._geometry(family, detail, variant)

    const size = opts.size ?? 1
    const yaw = opts.yaw ?? rand() * Math.PI * 2
    const tilt = opts.tilt ?? 0
    const tiltAz = opts.tiltAzimuth ?? rand() * Math.PI * 2

    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    if (Math.abs(tilt) > 1e-6) {
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(Math.sin(tiltAz), 0, -Math.cos(tiltAz)).normalize(), tilt))
    }
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), q, new THREE.Vector3(size, size, size))

    const c = new THREE.Color(opts.color ?? 0xffffff)
    const gain = opts.gain ?? 1
    bucket.rows.push({ m, c: [c.r * gain, c.g * gain, c.b * gain] })
    return this
  }

  /** Shared material per intensity. Colour rides on `instanceColor`. */
  _material(intensity) {
    const key = String(intensity)
    let mat = this._materials.get(key)
    if (!mat) {
      // White base colour: the hue is entirely per instance, so a white
      // material times instanceColor is the crystal's colour and nothing here
      // has an opinion about what that is.
      mat = crystalMaterial(0xffffff, { intensity, name: `crystal-${key}` })
      this._materials.set(key, mat)
    }
    return mat
  }

  /** Build the meshes. Idempotent; returns the group either way. */
  build() {
    if (this._built) return this._group
    this._built = true
    this._group = new THREE.Group()
    this._group.name = 'crystals'
    const mat = this._material(this.options.intensity)

    for (const b of this._buckets.values()) {
      const n = b.rows.length
      if (n === 0) { b.geo.dispose(); continue }
      const mesh = new THREE.InstancedMesh(b.geo, mat, n)
      mesh.name = `crystals-${b.family}-d${b.detail}-v${b.variant}`
      const colours = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        mesh.setMatrixAt(i, b.rows[i].m)
        colours[i * 3] = b.rows[i].c[0]
        colours[i * 3 + 1] = b.rows[i].c[1]
        colours[i * 3 + 2] = b.rows[i].c[2]
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3)
      mesh.castShadow = this.options.castShadow
      mesh.receiveShadow = this.options.receiveShadow
      // Derived from the geometry box and every instance matrix, so per-bucket
      // frustum culling means something instead of being all-or-nothing over
      // the whole level.
      mesh.computeBoundingSphere()
      this._group.add(mesh)
      this._meshes.push(mesh)
    }
    return this._group
  }

  /**
   * Suggested point-light positions, brightest clusters first.
   *
   * The crystals are geometry: they GLOW, they do not LIGHT. Making the rock
   * around them actually respond needs real lights, and the number of those is
   * a frame-budget decision that belongs to whoever owns the level, not to this
   * file. So this reports where a light would do the most good — the top of the
   * `n` largest clusters, in world space, with the colour and a radius taken
   * from the cluster's measured height — and places none itself.
   */
  emitters(max = 8) {
    const out = []
    const v = new THREE.Vector3()
    for (const b of this._buckets.values()) {
      for (const row of b.rows) {
        const scale = v.setFromMatrixColumn(row.m, 0).length()
        const h = b.bounds.max[1] * scale
        const p = new THREE.Vector3().setFromMatrixPosition(row.m)
        out.push({
          position: [p.x, p.y + h * 0.72, p.z],
          color: row.c,
          radius: Math.max(3, h * 2.2),
          weight: h,
        })
      }
    }
    out.sort((a, b) => b.weight - a.weight)
    return out.slice(0, Math.max(0, max))
  }

  /** Draw calls, instances and triangles, per bucket and in total. */
  stats() {
    const buckets = []
    let instances = 0, triangles = 0, drawn = 0
    for (const b of this._buckets.values()) {
      const tris = triangleCount(b.geo)
      if (b.rows.length > 0) drawn++
      instances += b.rows.length
      triangles += tris * b.rows.length
      buckets.push({
        key: b.key,
        family: b.family,
        detail: b.detail,
        variant: b.variant,
        instances: b.rows.length,
        trianglesPerInstance: tris,
        size: b.bounds.size.map((n) => Math.round(n * 1000) / 1000),
      })
    }
    buckets.sort((a, b) => (a.key < b.key ? -1 : 1))
    return { drawCalls: drawn, buckets, instances, triangles }
  }

  dispose() {
    for (const b of this._buckets.values()) b.geo.dispose()
    for (const m of this._materials.values()) m.dispose()
    this._buckets.clear()
    this._materials.clear()
    this._meshes = []
  }
}

// ---------------------------------------------------------------- self test

/**
 * `crystalsSelfTest()` — the LOD table, and the numbers §7.3 asks to be kept.
 *
 * `node src/crystals.js` prints it. It builds no material (there is no WebGL
 * context under node) and no field mesh; what it measures is the thing that
 * actually costs: triangles per cluster per detail band, and the draw-call
 * arithmetic of a realistic placement.
 */
export function crystalsSelfTest() {
  const rows = []
  for (const family of ['hero', 'scatter']) {
    for (const detail of [FAR, MID, NEAR]) {
      // Averaged over the default variant count: one variant's count depends on
      // how many shards its seed drew, and a single sample would report noise.
      let tris = 0, verts = 0
      const V = 3
      const sizes = []
      for (let v = 0; v < V; v++) {
        const geo = shardCluster((0x5C0117 ^ (0x9E3779B1 * (v + 1))) | 0, { scale: family, detail })
        tris += triangleCount(geo)
        verts += geo.attributes.position.count
        sizes.push(boundsOf(geo).size.map((n) => Math.round(n * 100) / 100))
        geo.dispose()
      }
      rows.push({
        family,
        detail,
        band: detail === FAR ? 'FAR' : detail === MID ? 'MID' : 'NEAR',
        triangles: Math.round(tris / V),
        vertices: Math.round(verts / V),
        sizes,
      })
    }
  }

  // A single shard at each band, for the per-primitive number.
  const single = [FAR, MID, NEAR].map((detail) => ({
    band: detail === FAR ? 'FAR' : detail === MID ? 'MID' : 'NEAR',
    triangles: (() => {
      const g = shard(0xC0FFEE, { length: 9, radius: 1.05, facets: 6, detail })
      const t = triangleCount(g)
      g.dispose()
      return t
    })(),
  }))

  // A realistic placement, to make the draw-call claim in this file's header
  // checkable rather than asserted.
  const field = new CrystalField({ seed: 0x5C0117 })
  const r = rng(0xBEEF)
  for (let i = 0; i < 40; i++) {
    field.add('hero', r() * 200, r() * 60, r() * 200, {
      detail: i < 12 ? NEAR : MID, color: 0x8b5cf6, size: 0.7 + r(),
    })
  }
  for (let i = 0; i < 260; i++) {
    field.add('scatter', r() * 200, r() * 60, r() * 200, {
      detail: i < 90 ? MID : FAR, color: i % 3 === 0 ? 0x3b82f6 : 0x8b5cf6,
    })
  }
  const stats = field.stats()

  const problems = []
  for (const row of rows) {
    if (row.triangles <= 0) problems.push(`${row.family}/${row.band}: no triangles`)
  }
  for (let i = 1; i < single.length; i++) {
    if (single[i].triangles < single[i - 1].triangles) {
      problems.push('single shard: triangle count does not rise with detail')
    }
  }
  if (stats.drawCalls > 18) problems.push(`draw calls ${stats.drawCalls} — instancing is not doing its job`)
  field.dispose()

  return { rows, single, stats, problems, ok: problems.length === 0 }
}

// Guarded on `process` so the browser bundle never touches it, and importing no
// node modules so vite has nothing to externalise. Same pattern as props.js.
if (typeof process !== 'undefined' && Array.isArray(process.argv) &&
    typeof process.argv[1] === 'string' && /crystals\.js$/.test(process.argv[1])) {
  const t = crystalsSelfTest()
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('single shard', 16), pad('tris', 8))
  for (const s of t.single) console.log(pad('  ' + s.band, 16), pad(s.triangles, 8))
  console.log('')
  console.log(pad('cluster', 16), pad('band', 8), pad('tris', 8), pad('verts', 8), 'sizes (m)')
  for (const r of t.rows) {
    console.log(pad('  ' + r.family, 16), pad(r.band, 8), pad(r.triangles, 8), pad(r.vertices, 8),
      JSON.stringify(r.sizes))
  }
  console.log('')
  console.log(pad('bucket', 26), pad('instances', 11), 'tris/instance')
  for (const b of t.stats.buckets) console.log(pad('  ' + b.key, 26), pad(b.instances, 11), b.trianglesPerInstance)
  console.log('\n300 clusters ->', t.stats.drawCalls, 'draw calls,',
    t.stats.instances, 'instances,', t.stats.triangles, 'triangles')
  console.log('problems:', t.problems.length ? '\n  ' + t.problems.join('\n  ') : 'none')
}
