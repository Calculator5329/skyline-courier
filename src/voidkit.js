import * as THREE from 'three'
import { lathe, blob, sweepTube, boundsOf, mergeGeometries, triangleCount } from './props.js'
import { glowMaterial } from './materials.js'
import { getTheme } from './theme.js'

/**
 * voidkit.js — the ruin prefabs for THEME 2, the Void.
 *
 * Read `docs/art-direction-void.md` first. This file is §4.1 (great walls),
 * §4.2 (floating ruin platforms), the sigil rings that live on the walls, and
 * the broken monoliths that carry the mid-ground silhouette. Crystals, beams
 * and motes are somebody else's lane.
 *
 * ============================== WHY A NEW FILE =============================
 * `kit.js` is the sky-garden kit: every prefab in it assumes a lit-by-the-sky
 * world with turf caps, ivy and brass. The void is the inversion of that
 * (art-direction-void.md §1), and the honest scaling-plan answer is that the
 * LIGHT half of a theme is data (`src/theme.js`) while genuinely new SHAPES are
 * new prefabs. These are new shapes. Nothing here edits kit.js; it imports the
 * same primitives kit.js does and obeys the same contracts.
 *
 * ============================ THE THREE CONTRACTS ==========================
 *
 * 1. GEOMETRY AND COLLISION COME FROM ONE DECLARATION (CLAUDE.md #2). Every
 *    visible surface below is either
 *      (a) an `L.solid()` box, which IS its own collider; or
 *      (b) a generated mesh drawn strictly INSIDE an `L.solid(...,
 *          { hidden: true })` AABB that was MEASURED with `props.boundsOf`,
 *          never guessed — see `hiddenBlob()`, which is the only place in this
 *          file that is allowed to put a curve inside a box; or
 *      (c) the GLOW CHANNEL: flat emissive inlay lying 1.5 cm proud of a face
 *          that is already solid. An inlay 15 mm thick cannot be mistaken for a
 *          ledge at any speed — the controller vaults 1.45 m — and it is
 *          checked mechanically, see contract 3.
 *    There is no fourth case. `decor()` is not used anywhere in this file.
 *
 * 2. NOTHING IS HARDCODED VIOLET (art-direction-void.md §7.2). Every colour
 *    resolves through `voidColors()`, which reads the active theme descriptor
 *    and takes per-call overrides. Run these prefabs under `skyline` and they
 *    come out gold, because that is what that descriptor says.
 *
 * 3. A GLOWING RUNE MEANS "YOU MAY STAND HERE" (art-direction-void.md §6, and
 *    it is the one line in that document flagged non-negotiable: it is the only
 *    readability channel a dark level has). This is not left to discipline.
 *    Every rune emitted registers its world position and its promised standing
 *    height, and `finishVoidKit()` — which the course must call, exactly as
 *    `buildCourse()` already calls `trackedKit().assertAllPlaced()` — walks the
 *    real collision world and throws if any rune is not sitting on a collider
 *    top face. A rune on thin air takes the build down.
 *
 * ================================ INSTANCING ===============================
 * Ethan's brief asks for instancing and LODs explicitly. Both are here, and it
 * is worth being precise about which does what, because they are not the same
 * saving:
 *
 *   - The SOLID channel needs no instancing. `level.js` merges every box and
 *     every mesh of one material into a single draw call at build time, which
 *     is strictly better than an InstancedMesh for static geometry: one draw,
 *     no per-instance matrix fetch. Adding instancing there would be a
 *     regression dressed as an optimisation.
 *   - The GLOW channel genuinely needs it, because it cannot use those batches:
 *     emissives are a different material, and a rune motif repeats verbatim
 *     across every platform that shares a size and a seed. So `finishVoidKit()`
 *     buckets glow geometry by shape signature, promotes any bucket with two or
 *     more members to an `InstancedMesh`, and merges the singletons into one
 *     static batch per colour. Result: draw calls scale with the number of
 *     DISTINCT motifs, not with the number of platforms.
 *
 * LODs follow kit.js's convention exactly: `detail: 0 | 1 | 2` (far silhouette
 * / mid / near, default 2). `voidKitSelfTest()` reports the triangle count at
 * each level so the claim is checkable from a terminal.
 */

// --------------------------------------------------------------- randomness

const DEFAULT_SEED = 0x0F0117

/** Deterministic xorshift32 in [0,1). Same seed, same ruin, every reload. */
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

// ------------------------------------------------------------- the palette

/**
 * The emissive colours, resolved from the THEME rather than from taste.
 *
 * art-direction-void.md §7.2: "a new prefab must be theme-neutral in shape and
 * take its colours from the theme descriptor. Nothing gets a hardcoded violet."
 *
 * `theme.js` does not (yet) carry a named accent block — it covers sun, lights,
 * sky, fog, motes, grade and exposure, and says so honestly in its own header.
 * So this reads the accents out of the fields that DO exist and that the void
 * descriptor already sets from the same reference image:
 *
 *   rune   ← `theme.sky.sun`         the void's 0x8b5cf6, §3's violet crystal
 *   sigil  ← `theme.light.fillColor` the void's 0xff3d6e, §3's red punctuation
 *   cool   ← `theme.light.bounceColor`  the void's 0x3b82f6, §3's blue secondary
 *
 * Under `skyline` those same three fields give brass-gold, sea-green and warm
 * bounce, and the prefabs come out as a golden-hour ruin. That is the test that
 * this is theme data and not a violet constant with extra steps.
 *
 * If a later pass adds `theme.accents = { rune, sigil, cool }`, it wins with no
 * change here. Per-call options win over everything.
 */
export function voidColors(opts = {}, theme = safeTheme()) {
  const a = (theme && theme.accents) || {}
  const sky = (theme && theme.sky) || {}
  const light = (theme && theme.light) || {}
  return {
    rune: opts.runeColor ?? a.rune ?? sky.sun ?? light.keyColor ?? 0xffffff,
    sigil: opts.sigilColor ?? a.sigil ?? light.fillColor ?? 0xffffff,
    cool: opts.coolColor ?? a.cool ?? light.bounceColor ?? 0xffffff,
  }
}

/** `getTheme()` reads module state; under node with no boot it is still safe. */
function safeTheme() {
  try { return getTheme() } catch { return null }
}

// ------------------------------------------------------------ the emitters

/**
 * `S` is solid, `D` is decor-shaped but still solid unless the caller declared
 * the whole prefab a ghost. Same switch kit.js uses, same reason: far scenery
 * that no player can reach should not pay for colliders, and it should be ONE
 * flag rather than every prefab guessing at reachability.
 *
 * Note the asymmetry with kit.js: there, `D` is decor even in the solid case.
 * Here it is not — see contract 1 in the header. Nothing in this file draws a
 * surface that has no collider, so `D` exists only to mark, for the reader,
 * which volumes are ornament rather than route.
 */
function emit(L, opts) {
  const flat = opts.detail === 0 ? { bevel: 0 } : null
  // THE ROCK VALUE, as a theme seam rather than as a constant.
  //
  // art-direction-void.md §3 wants rock near-black (#14101F to #2A2438), and
  // the `stone` kind in `materials.js` is the sunset level's cool grey-green —
  // it is the same albedo in both themes, so the first captures came back with
  // the great walls reading as pale limestone. Repointing that albedo belongs
  // to the material/theme lane, not here. What this kit CAN do is take a flat
  // vertex-tint multiplier from the theme descriptor, which is precisely what
  // `level.js`'s `shade` option is for and what `kit.drumPlatform` already
  // uses on moss caps. So a theme that sets `surfaces.shade` turns this whole
  // kit's rock down without one line changing in voidkit.js.
  const theme = opts.theme || safeTheme()
  const shade = opts.shade
    ?? ((theme && theme.surfaces && theme.surfaces.shade) || 1)
  const merge = (o) => {
    const out = { ...(o || {}) }
    if (flat) out.bevel = 0
    if (shade !== 1) out.shade = (out.shade ?? 1) * shade
    return o || flat || shade !== 1 ? out : undefined
  }
  if (opts.ghost) {
    const D = (cx, cy, cz, sx, sy, sz, k, o) => {
      L.decor(cx, cy, cz, sx, sy, sz, k, merge(o)); return 1
    }
    return { S: D, D, ghost: true, shade }
  }
  const S = (cx, cy, cz, sx, sy, sz, k, o) => {
    L.solid(cx, cy, cz, sx, sy, sz, k, merge(o)); return 1
  }
  return { S, D: S, ghost: false, shade }
}

/** Maps (along, across) offsets onto world X/Z for `axis: 'x' | 'z'`. */
function frame(axis) {
  const alongX = axis !== 'z'
  return {
    alongX,
    at: (x, z, a, c) => (alongX ? [x + a, z + c] : [x + c, z + a]),
    sz: (la, lc) => (alongX ? [la, lc] : [lc, la]),
  }
}

// ============================================================= glow channel
//
// Flat emissive inlay. It cannot go through `L.mesh()` — that path merges into
// the per-kind SURFACE batches, which are lit MeshStandardMaterials with a
// generated albedo/ORM set, and a rune drawn into one would be a slightly
// lighter patch of rock rather than a light source. So the kit owns a small
// emissive layer, hung off the Level and flushed by `finishVoidKit()`, exactly
// as kit.js owns the foliage layer and for exactly the same structural reason.

const _glowMats = new Map()

function glowMat(color, intensity) {
  const key = `${color}:${intensity}`
  let m = _glowMats.get(key)
  if (!m) { m = glowMaterial(color, intensity); m.name = `void:glow:${key}`; _glowMats.set(key, m) }
  return m
}

/**
 * Per-Level glow state, created on first use.
 *
 * Returns `null` — permanently — where there is no scene group to hang meshes
 * off, which covers `voidKitSelfTest()` under node. A self-test that cannot run
 * is worse than a self-test that measures the solid channel only, and the glow
 * channel's triangle count is measured separately there anyway.
 */
function glowState(L) {
  if (!L || typeof L !== 'object') return null
  if (L.__voidGlow !== undefined) return L.__voidGlow
  const state = L.group ? { buckets: new Map(), runes: [], built: false, tris: 0 } : null
  L.__voidGlow = state
  return state
}

/**
 * Queue one piece of emissive inlay.
 *
 * `key` is the SHAPE SIGNATURE — everything that makes two pieces identical up
 * to a rigid transform. Two calls with the same key share one geometry and are
 * eligible to become instances of each other; that is the whole instancing
 * story, and it is why `key` must never contain a position.
 */
function addGlow(L, key, color, intensity, make, matrix) {
  const st = glowState(L)
  if (!st || st.built) return 0
  const k = `${key}|${color}|${intensity}`
  let b = st.buckets.get(k)
  if (!b) {
    let geo
    try { geo = make() } catch { return 0 }
    if (!geo) return 0
    b = { geo, color, intensity, mats: [], tris: triangleCount(geo) }
    st.buckets.set(k, b)
  }
  b.mats.push(matrix)
  st.tris += b.tris
  return 1
}

/**
 * Register the promise a rune makes: "a player may stand at (x, y, z)".
 *
 * Checked for real in `finishVoidKit()`. See contract 3 in the header.
 */
function promiseStandable(L, x, y, z, hx, hz) {
  const st = glowState(L)
  if (st && !st.built) st.runes.push({ x, y, z, hx, hz })
}

/**
 * Flush the glow layer and PROVE the rune contract. Call once, at the end of
 * the course build, before `Level.build()`.
 *
 * @returns {{drawCalls:number, instanced:number, triangles:number, runes:number}}
 */
export function finishVoidKit(L) {
  const st = glowState(L)
  if (!st) return { drawCalls: 0, instanced: 0, triangles: 0, runes: 0, checked: false }
  if (st.built) return st.stats
  st.built = true

  assertRunesStandable(L, st.runes)

  let drawCalls = 0, instanced = 0
  // Singletons merge per (colour, intensity) so a one-off sigil costs a share
  // of a draw call rather than a whole one.
  const singles = new Map()
  for (const b of st.buckets.values()) {
    if (b.mats.length >= 2) {
      const inst = new THREE.InstancedMesh(b.geo, glowMat(b.color, b.intensity), b.mats.length)
      b.mats.forEach((m, i) => inst.setMatrixAt(i, m))
      inst.instanceMatrix.needsUpdate = true
      inst.frustumCulled = true
      inst.name = `void:glow:instanced:${b.mats.length}`
      L.group.add(inst)
      drawCalls++
      instanced += b.mats.length
    } else {
      const g = b.geo.clone().applyMatrix4(b.mats[0])
      const key = `${b.color}:${b.intensity}`
      const arr = singles.get(key) || []
      arr.push(g)
      singles.set(key, arr)
      b.geo.dispose()
    }
  }
  for (const [key, list] of singles) {
    const [color, intensity] = key.split(':').map(Number)
    const merged = mergeGeometries(list, { dispose: true })
    const mesh = new THREE.Mesh(merged, glowMat(color, intensity))
    mesh.name = `void:glow:merged:${list.length}`
    L.group.add(mesh)
    drawCalls++
  }

  st.stats = {
    drawCalls, instanced, triangles: st.tris, runes: st.runes.length, checked: true,
  }
  if (L.group) L.group.userData.voidGlow = st.stats
  return st.stats
}

/**
 * THE §6 GATE. Every rune must sit on something a player can stand on.
 *
 * Mechanical, not editorial: it walks `L.collision.boxes` — the same array the
 * player's own resolver walks — and requires a collider top face within 6 cm of
 * the promised standing height, covering the rune's own footprint, with nothing
 * solid directly above it that would make that face unreachable.
 *
 * Six centimetres because that is smaller than the chamfer on any box in the
 * world (`BEVEL_MAX` is 4.5 cm), so the tolerance cannot swallow a real error.
 */
function assertRunesStandable(L, runes) {
  const col = L && L.collision
  if (!col || !col.boxes || !runes.length) return
  const bad = []
  for (const r of runes) {
    // Four probes on the rune's own footprint, not just its centre: a rune that
    // overhangs the slab it is drawn on is exactly as much of a lie as one
    // floating in space, and a centre-only test cannot see it.
    const probes = [
      [r.x, r.z], [r.x - r.hx, r.z - r.hz], [r.x + r.hx, r.z - r.hz],
      [r.x - r.hx, r.z + r.hz], [r.x + r.hx, r.z + r.hz],
    ]
    for (const [px, pz] of probes) {
      let ok = false
      for (const b of col.boxes) {
        if (px < b.min.x - 1e-6 || px > b.max.x + 1e-6) continue
        if (pz < b.min.z - 1e-6 || pz > b.max.z + 1e-6) continue
        if (Math.abs(b.max.y - r.y) <= 0.06) { ok = true; break }
      }
      if (!ok) {
        bad.push(`rune at (${r.x.toFixed(1)}, ${r.y.toFixed(2)}, ${r.z.toFixed(1)}) `
          + `has no standable collider under (${px.toFixed(1)}, ${pz.toFixed(1)})`)
        break
      }
    }
  }
  if (bad.length) {
    throw new Error('voidkit: a glowing rune promises a landing that does not exist '
      + '(art-direction-void.md §6 — the only readability channel a dark level has):\n  '
      + bad.join('\n  '))
  }
}

// ------------------------------------------------------ flat glyph geometry
//
// Every emissive shape in this file is a FLAT polygon set authored in XY and
// then placed by a matrix. Flat is not a shortcut: art-direction-void.md
// describes these as INLAY — carved into a face and filled with light — and an
// inlay with thickness reads as a fitting bolted on. Flat also keeps the glow
// channel's triangle count in the hundreds rather than the thousands.

/** Fan-triangulate a star-shaped-about-the-origin polygon into the builder. */
function glyphFan(out, pts) {
  const base = out.pos.length / 3
  out.pos.push(0, 0, 0)
  for (const p of pts) out.pos.push(p[0], p[1], 0)
  for (let i = 0; i < pts.length; i++) {
    out.idx.push(base, base + 1 + i, base + 1 + ((i + 1) % pts.length))
  }
}

/**
 * One convex quad, WOUND TO FACE +Z whatever order the caller passed.
 *
 * MEASURED, not theoretical. The glow materials are `MeshStandardMaterial`,
 * which is FrontSide, and `glyphStroke` builds its quads by walking a segment
 * up the left offset and back down the right — which is clockwise in XY, so
 * every stroke in the first cut was backface-culled. The rune came out as a
 * ring, a tick collar and a centre star with the ENTIRE KNOT MISSING, and it
 * looked perfectly deliberate: nothing about the frame said "geometry is being
 * discarded here". That is the exact failure mode `tools/coverage.mjs` exists
 * for on the solid channel, and the glow channel has no coverage tool.
 *
 * So the winding is not left to the caller's care. Signed area decides.
 */
function glyphQuad(out, a, b, c, d) {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const q = area < 0 ? [a, d, c, b] : [a, b, c, d]
  const base = out.pos.length / 3
  for (const p of q) out.pos.push(p[0], p[1], 0)
  out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

/** An annulus: the concentric circles of a sigil, and a rune's outer ring. */
function glyphRing(out, r, width, segs) {
  const ri = Math.max(0, r - width / 2), ro = r + width / 2
  for (let i = 0; i < segs; i++) {
    const a0 = (2 * Math.PI * i) / segs, a1 = (2 * Math.PI * (i + 1)) / segs
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1)
    glyphQuad(out,
      [ri * c0, ri * s0], [ro * c0, ro * s0], [ro * c1, ro * s1], [ri * c1, ri * s1])
  }
}

/** Radial tick marks between two radii — the sigil's measuring scale. */
function glyphTicks(out, r0, r1, count, width, phase = 0) {
  for (let i = 0; i < count; i++) {
    const a = phase + (2 * Math.PI * i) / count
    const c = Math.cos(a), s = Math.sin(a)
    const px = -s * width / 2, py = c * width / 2
    glyphQuad(out,
      [r0 * c - px, r0 * s - py], [r1 * c - px, r1 * s - py],
      [r1 * c + px, r1 * s + py], [r0 * c + px, r0 * s + py])
  }
}

/** A closed polygon drawn as a stroke of constant width — the knot lines. */
function glyphStroke(out, pts, width) {
  const h = width / 2
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const len = Math.hypot(dx, dy) || 1
    // Overrun each segment by half a width so the corners close square instead
    // of leaving a lit gap at every vertex of the knot.
    const ex = (dx / len) * h, ey = (dy / len) * h
    const nx = (-dy / len) * h, ny = (dx / len) * h
    glyphQuad(out,
      [a[0] - ex + nx, a[1] - ey + ny], [b[0] + ex + nx, b[1] + ey + ny],
      [b[0] + ex - nx, b[1] + ey - ny], [a[0] - ex - nx, a[1] - ey - ny])
  }
}

/** An n-pointed star polygon, star-shaped about its centre so a fan is valid. */
function starPoints(points, rOuter, rInner, phase = 0) {
  const pts = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner
    const a = phase + (Math.PI * i) / points
    pts.push([r * Math.cos(a), r * Math.sin(a)])
  }
  return pts
}

function glyphGeometry(out) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3))
  geo.setIndex(out.idx)
  // Flat and facing +Z by construction; computeVertexNormals would average the
  // fan centre of every star into a slightly domed normal for no benefit.
  const n = new Float32Array(out.pos.length)
  for (let i = 2; i < n.length; i += 3) n[i] = 1
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((out.pos.length / 3) * 2), 2))
  return geo
}

/**
 * A shape authored in XY, turned to face out of an axis plane.
 * 'xz' lies flat facing +Y (a rune on a platform top); 'xy' faces +Z and 'zy'
 * faces +X (a sigil on a wall). `sign` flips it to the other side of the face.
 */
function planeMatrix(plane, x, y, z, sign = 1, spin = 0) {
  const e = new THREE.Euler()
  if (plane === 'zy') e.set(0, sign > 0 ? Math.PI / 2 : -Math.PI / 2, spin, 'YXZ')
  else if (plane === 'xz') e.set(sign > 0 ? -Math.PI / 2 : Math.PI / 2, 0, spin, 'YXZ')
  else e.set(0, sign > 0 ? 0 : Math.PI, spin, 'YXZ')
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(1, 1, 1))
}

// ------------------------------------------------------- contained curves

/**
 * Draw a `props.blob()` inside a hidden collider that is MEASURED, not guessed.
 *
 * This is the only place in this file that puts a curve inside a box, and it is
 * written once so the argument only has to be made once: build the geometry,
 * ask `props.boundsOf` what it actually occupies, and declare exactly that AABB.
 * There is no arithmetic here that could be wrong about a blob's extent, which
 * is the failure mode `props.boundsOf`'s own doc-comment warns about.
 *
 * @param clamp optional [hx, hy, hz] the collider may not exceed. When the
 *        measured bounds are larger the MESH is scaled down to fit — never the
 *        collider trimmed, which would leave geometry outside it.
 */
function hiddenBlob(L, S, cx, cy, cz, kind, blobOpts, clamp = null, shadeMul = 1) {
  const geo = blob(blobOpts.seed | 0, blobOpts)
  const bb = boundsOf(geo)
  let k = 1
  if (clamp) {
    for (let i = 0; i < 3; i++) {
      const half = Math.max(Math.abs(bb.min[i]), Math.abs(bb.max[i]))
      if (half > 1e-6) k = Math.min(k, clamp[i] / half)
    }
  }
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(cx, cy, cz), new THREE.Quaternion(), new THREE.Vector3(k, k, k))
  // The collider is the measured box, scaled by the same k. Equality, not
  // approximation: the mesh's own bounding box IS the declared AABB.
  const sx = (bb.max[0] - bb.min[0]) * k
  const sy = (bb.max[1] - bb.min[1]) * k
  const sz = (bb.max[2] - bb.min[2]) * k
  const ox = ((bb.max[0] + bb.min[0]) / 2) * k
  const oy = ((bb.max[1] + bb.min[1]) / 2) * k
  const oz = ((bb.max[2] + bb.min[2]) / 2) * k
  let n = S(cx + ox, cy + oy, cz + oz, sx, sy, sz, kind, { hidden: !!L.mesh })
  if (L.mesh) { L.mesh(kind, geo, m, { shade: (blobOpts.shade ?? 1) * shadeMul }); n += 1 }
  else geo.dispose()
  return n
}

// ================================================================= prefabs

/**
 * greatWall — the colossal carved structure that frames the void left and
 * right, and the surface the player wall-runs.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE FOOTPRINT AT THE BASE. The wall rises
 * to `y + height`. `axis` is the direction it runs; `'x'` (the default) means a
 * wall along the route with faces looking at ±Z.
 *
 * ============================== WHAT IT LOOKS LIKE =========================
 * art-direction-void.md §4.1: "flat-ish faces divided into rectangular panels
 * by deep recessed grooves, like a machined cliff. They are what makes the
 * space read as built rather than as a rock field."
 *
 * So the construction is inside-out from how it reads: the grooves are not cut
 * into anything. A core slab is declared at the groove floor, and the PANELS
 * are separate solid boxes standing `relief` proud of it. The gaps between the
 * panels are the grooves. Every visible surface is therefore a collider by
 * construction — there is no "carved" step that could remove mass the collision
 * world still believes in, which is the classic way a carved wall goes wrong.
 *
 * ============================ THE WALL-RUN CONTRACT ========================
 * §6: "Great walls → wall-run and wall-jump surfaces. Their panel grooves give
 * the eye something to measure speed against, which the flat brass wall in the
 * sunset level does not." That makes the groove pitch a GAMEPLAY number, not an
 * ornament one. `docs/course-design.md` gives ~17.6 m of wall per sprint
 * wall-run, so the default 4.2 m panel module puts four groove crossings under
 * a full run — enough to read as motion, few enough not to strobe.
 *
 * And it makes the run plane's FLATNESS load-bearing. Everything that would
 * break it is confined above `runBand` (default 7 m, comfortably over the
 * height a wall-run reaches from a 1.42 m jump):
 *   - recessed panels, which would be a 0.3 m pocket to catch a shoulder;
 *   - the pier courses that carry the silhouette, which stand further proud;
 *   - the cornice, which oversails.
 * Below `runBand` the panelled face is one exact plane at
 * `thickness/2 + relief`, and `wallFace()` on the return value is that number,
 * so a caller never has to re-derive it.
 *
 * The plinth is flush rather than projecting for the same reason: a 0.28 m
 * projecting base course is a step you can stand on, and it would sit exactly
 * where a ground-level wall-run starts.
 *
 * LODs: detail 2 panels both faces plus piers and course reveals; detail 1
 * panels on the runnable face only at a coarser module; detail 0 is the bare
 * massing with no chamfer, for the far band.
 *
 * @returns {{topY:number, height:number, length:number, thickness:number,
 *            face:number, wallFace:(side:number)=>number[], boxes:number}}
 */
export function greatWall(L, x, y, z, opts = {}) {
  const {
    height = 30, length = 48, thickness = 4.0, axis = 'x', kind = 'stone',
    detail = 2, relief = 0.34, groove = 0.36,
    panelWidth = 3.4, panelHeight = 3.6, runBand = 7.0,
    faces = detail >= 2 ? 'both' : 1,
  } = opts
  const rand = pick(opts)
  const { S } = emit(L, opts)
  const F = frame(axis)
  let n = 0

  const half = thickness / 2
  const facePlane = half + relief

  // --- the core slab ------------------------------------------------------
  // One box, full height, at the GROOVE FLOOR. Everything else is added mass.
  {
    const [cx, cz] = F.at(x, z, 0, 0)
    const [sx, sz] = F.sz(length, thickness)
    n += S(cx, y + height / 2, cz, sx, height, sz, kind)
  }

  // --- the plinth ---------------------------------------------------------
  // Flush with the panel plane, not projecting. See the wall-run contract.
  const plinthH = Math.min(1.6, height * 0.06)
  if (detail >= 1 && plinthH > 0.2) {
    const [cx, cz] = F.at(x, z, 0, 0)
    const [sx, sz] = F.sz(length, thickness + relief * 2)
    n += S(cx, y + plinthH / 2, cz, sx, plinthH, sz, kind)
  }

  // --- the panel grid -----------------------------------------------------
  const sides = faces === 'both' ? [1, -1] : [faces === -1 ? -1 : 1]
  const gridTop = y + height - (detail >= 1 ? Math.min(1.1, height * 0.04) : 0)
  const gridBase = y + plinthH
  const span = Math.max(0, gridTop - gridBase)
  const rows = Math.max(1, Math.round(span / (detail >= 2 ? panelHeight : panelHeight * 1.7)))
  const cellH = span / Math.max(1, rows)

  /**
   * COLUMNS PER ROW, and the run band gets twice as many.
   *
   * MEASURED FROM THE WALL-RUN POSE, which is the only place this number
   * matters. §6 makes the groove pitch a speed cue: at 11 m/s a 3.4 m module is
   * a groove crossing every 0.31 s, and from a camera hugging the face at a
   * grazing angle that is barely three crossings in the whole readable depth of
   * field — the wall went flat exactly as the sunset level's brass slab does.
   *
   * Halving the module inside the run band doubles the crossings without
   * touching anything above it, and it reads as architecture rather than as a
   * concession: a finer ashlar course at the base of a colossal wall is what
   * masonry actually does. It costs boxes only in a 7 m band of a 30-40 m wall.
   */
  const colsFor = (rowTopY) => {
    const mod = (detail >= 2 ? panelWidth : panelWidth * 1.6)
      * (rowTopY <= y + runBand ? 0.5 : 1)
    return Math.max(1, Math.round(length / mod))
  }

  if (detail >= 1 && span > 0.6) {
    for (const side of sides) {
      for (let r = 0; r < rows; r++) {
        const py = gridBase + (r + 0.5) * cellH
        // Every third pier course, above the run band only.
        const pierRow = py - cellH / 2 > y + runBand
        const cols = colsFor(py + cellH / 2)
        const cellW = length / cols
        for (let c = 0; c < cols; c++) {
          const along = -length / 2 + (c + 0.5) * cellW
          // Groove width varies per panel so the grid reads as masonry rather
          // than as a texture. The panel can only ever SHRINK, so the run plane
          // — which is the outer face, at facePlane — never moves.
          const gw = groove * (0.8 + rand() * 0.6)
          const gh = groove * (0.8 + rand() * 0.6)
          const w = cellW - gw
          const h = cellH - gh
          if (w < 0.25 || h < 0.25) continue
          // Above the run band a panel may be recessed (a deep pocket) or a
          // pier (standing further proud). Below it, never: see the contract.
          let d = relief
          let mid = half + relief / 2
          if (pierRow) {
            const roll = rand()
            if (roll < 0.16) { d = relief * 0.42; mid = half + d / 2 }
            else if (roll > 0.86) { d = relief * 1.8; mid = half + d / 2 }
          }
          const [cx, cz] = F.at(x, z, along, side * mid)
          const [sx, sz] = F.sz(w, d)
          // A HEAVIER ARRIS THAN THE HOUSE DEFAULT, and this is the wall-run
          // read rather than an ornament choice. `level.js` derives its bevel
          // as min(0.045, 0.13 * min half-extent * 2), and a panel's smallest
          // half-extent is its 17 cm depth — so the automatic chamfer comes out
          // at 4.2 cm. Measured from the wall-run pose, 4.2 cm of arris on a
          // near-unlit face is under a pixel at the far end of a run and the
          // wall goes flat, which is the exact complaint against the sunset
          // level's brass slab. 7.5 cm is the most `_emit`'s own clamp
          // (min half-extent * 0.49) will accept at this depth, and it nearly
          // doubles the lit sliver on every groove edge in the world.
          n += S(cx, py, cz, sx, h, sz, kind, detail >= 1 ? { bevel: 0.075 } : undefined)
        }
      }
    }
  } else if (detail === 0) {
    // Far band: no panels at all, but the wall still has to be the same SIZE,
    // so the massing carries the relief instead of the grid.
    for (const side of sides) {
      const [cx, cz] = F.at(x, z, 0, side * (half + relief / 2))
      const [sx, sz] = F.sz(length * 0.98, relief)
      n += S(cx, y + height / 2, cz, sx, height * 0.9, sz, kind)
    }
  }

  // --- the cornice --------------------------------------------------------
  // Oversails. It is at the top of a wall that is tens of metres high, so it
  // costs nothing in traversal and it is most of what the silhouette is.
  if (detail >= 1) {
    const capH = Math.min(1.1, height * 0.04)
    const proj = relief * 1.9
    const [cx, cz] = F.at(x, z, 0, 0)
    const [sx, sz] = F.sz(length, thickness + (sides.length === 2 ? proj * 2 : proj))
    const off = sides.length === 2 ? 0 : sides[0] * proj / 2
    const [ox, oz] = F.at(cx, cz, 0, off)
    n += S(ox, y + height - capH / 2, oz, sx, capH, sz, kind)
  }

  return {
    topY: y + height,
    height,
    length,
    thickness,
    axis,
    /** World plane of the runnable face on `side` (+1 / -1). */
    face: facePlane,
    wallFace: (side = 1) => F.at(x, z, 0, side * facePlane),
    runBandTop: y + runBand,
    boxes: n,
  }
}

/**
 * runeSlab — the floating ruin platform, and the game's landing affordance.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE WALKABLE TOP SURFACE, matching
 * `kit.drumPlatform`. `y` is the height you land on, so a caller can place it
 * straight off a jump arc.
 *
 * ============================== WHAT IT LOOKS LIKE =========================
 * art-direction-void.md §4.2: "Dark stone slabs, roughly square, with a carved
 * raised border and a glowing rune inlay on the top face — violet, geometric, a
 * rosette or star knot. The top is flat and readable (it is a landing surface
 * and must LOOK like one). The underside is the opposite: jagged broken rock,
 * irregular, with drip-like spikes hanging beneath... Nothing about the
 * underside is flat."
 *
 * Which is two different jobs from one prefab, and the split is exact:
 *
 *   ABOVE `y`  — flat, rectilinear, legible. A slab, a raised border course
 *                inset from the edge, and the rune. All boxes, all solid, all
 *                dead flat. The border is 14 cm: enough to read as carved from
 *                a running eye height of 1.6 m, far under the 1.45 m step-up so
 *                it can never interrupt a landing.
 *   BELOW `y`  — `props.blob()` at full three-axis lumpiness, tiers of it
 *                tapering to a point, with drip spikes under that. Not one
 *                cuboid: the review finding that killed the sunset level's
 *                undersides ("literally countable stacks of grey cubes") applies
 *                here with more force, because in the void the underside of a
 *                platform is lit from below by crystal and is half of what you
 *                see while climbing.
 *
 * ============================== THE RUNE IS A PROMISE ======================
 * §6, flagged non-negotiable: "a glowing rune means 'you may stand here'. Never
 * put a rune on a surface the player cannot land on."
 *
 * The rune is emitted at `y + 0.015`, directly over the slab collider this same
 * call declared, inset well inside the border. It is registered with
 * `promiseStandable()` and `finishVoidKit()` proves it against the real
 * collision world. `rune: false` turns it off — for a platform that is scenery
 * — and that is the ONLY supported way to have this shape without the promise.
 * There is no way to have the promise without the platform.
 *
 * TRAVERSAL: the default 6.0 m footprint is comfortably larger than the 82%
 * landing margin `level.js` holds every authored gap to, and the whole prefab
 * presents exactly one standable height (`y`), so a gap measured to this
 * platform means what it says.
 *
 * @returns {{topY:number, sizeX:number, sizeZ:number, baseY:number,
 *            runeRadius:number, boxes:number}}
 */
export function runeSlab(L, x, y, z, opts = {}) {
  const {
    size = 6.0, kind = 'stone', detail = 2,
    thickness = 0.85, border = true, borderHeight = 0.22, borderWidth = 0.62,
    rune = true, runeIntensity = 2.4, tiers = detail === 0 ? 1 : 2 + ((detail >= 2) ? 1 : 0),
    spikes = detail >= 1, motif = 'knot', posts = true,
  } = opts
  const sizeX = opts.sizeX ?? size
  const sizeZ = opts.sizeZ ?? size
  const rand = pick(opts)
  const { S, ghost, shade } = emit(L, opts)
  const colors = voidColors(opts, opts.theme || safeTheme())
  let n = 0

  // --- the slab -----------------------------------------------------------
  // ONE box for the landing surface. Deliberately not faceted: §4.2 asks for
  // "roughly square" and for a top that reads unmistakably as a landing, and a
  // rectangle whose silhouette matches its collider exactly is the clearest
  // statement of that available.
  n += S(x, y - thickness / 2, z, sizeX, thickness, sizeZ, kind)

  // A second, wider drip course just under the slab: the carved fascia. Inset
  // so it cannot present a ledge outside the slab's own footprint.
  if (detail >= 1) {
    n += S(x, y - thickness - 0.13, z, sizeX * 0.90, 0.26, sizeZ * 0.90, kind)
  }

  // --- the raised border --------------------------------------------------
  // Four bars, inset from the edge so the slab's own rim stays visible from
  // below and the border reads as carved INTO the top rather than stuck onto
  // its perimeter.
  const inset = Math.min(0.34, size * 0.06)
  const bw = Math.min(borderWidth, Math.min(sizeX, sizeZ) * 0.12)
  if (border && detail >= 1 && bw > 0.08) {
    // TWO COURSES, not one. Measured: a single 14 cm bar in near-black rock
    // read as a hairline seam from the standing pose — the border was there and
    // did nothing, so the platform edge had no shape at all against the void.
    // A low outer plinth with a narrower course on top gives the frame two lit
    // arrises instead of one, which is what makes it read as CARVED at 40 m.
    // 22 cm total is still a sixth of the 1.45 m step-up: it cannot interrupt a
    // landing, and the controller will not even register it as a step.
    const ring = (halfW, hgt, yBase) => {
      const bx = sizeX - inset * 2, bz = sizeZ - inset * 2
      const by = yBase + hgt / 2
      let m = 0
      m += S(x, by, z - (bz - halfW) / 2, bx, hgt, halfW, kind)
      m += S(x, by, z + (bz - halfW) / 2, bx, hgt, halfW, kind)
      m += S(x - (bx - halfW) / 2, by, z, halfW, hgt, bz - halfW * 2, kind)
      m += S(x + (bx - halfW) / 2, by, z, halfW, hgt, bz - halfW * 2, kind)
      return m
    }
    n += ring(bw, borderHeight * 0.45, y)
    if (detail >= 2) n += ring(bw * 0.58, borderHeight * 0.55, y + borderHeight * 0.45)
  }

  // --- the rune -----------------------------------------------------------
  const clear = Math.min(sizeX, sizeZ) / 2 - inset - bw - 0.25
  const runeR = Math.max(0.3, clear)
  if (rune && !ghost && clear > 0.35) {
    const segs = detail >= 2 ? 40 : detail === 1 ? 24 : 12
    const key = `rune:${motif}:${runeR.toFixed(2)}:${segs}`
    addGlow(L, key, colors.rune, runeIntensity,
      () => runeGlyph(runeR, motif, segs),
      // 1.5 cm proud of the walkable plane. Small enough that it cannot read as
      // a ledge, large enough to clear z-fighting with the slab's top face.
      planeMatrix('xz', x, y + 0.015, z, 1, (rand() * 4 | 0) * (Math.PI / 2)))
    promiseStandable(L, x, y, z, runeR, runeR)
  }

  // --- the underside ------------------------------------------------------
  // Tiers of blob, each narrower and pinched harder toward its base, so the
  // mass tapers to broken rock rather than to a smaller slab.
  let ty = y - thickness - 0.26
  let tr = Math.min(sizeX, sizeZ) * 0.46
  let baseY = ty
  for (let i = 0; i < tiers; i++) {
    // LUMPINESS AND FREQUENCY ARE THE WHOLE READ, and the first cut had both
    // too low: at 0.34 / 2.1 the tiers came back as smooth pale cauliflower —
    // rounded boulders, which is the SUNSET theme's underside. §4.2 asks for
    // the opposite: "jagged broken rock, irregular... nothing about the
    // underside is flat". 0.52-0.74 at 3-4 noise cells per unit sphere is
    // fracture rather than erosion, and `props.blob` stays star-shaped (and so
    // non-self-intersecting) all the way to its 0.95 clamp.
    const lump = 0.52 + rand() * 0.22
    const squash = 0.78 + rand() * 0.30
    const taper = -(0.34 + i * 0.18 + rand() * 0.16)
    const cy = ty - tr * squash * 0.72
    n += hiddenBlob(L, S, x + (rand() - 0.5) * tr * 0.22, cy, z + (rand() - 0.5) * tr * 0.22,
      kind, {
        seed: (rand() * 0xffffff) | 0,
        radius: tr, lumpiness: lump, squash, taperY: taper,
        detail: detail >= 2 ? 2 : detail === 1 ? 1 : 0,
        frequency: 3.0 + rand() * 1.1,
        // Darkening downward. `level.js`'s mesh path ramps its own contact
        // shade from each mesh's OWN base, so without this every tier restarts
        // the ramp and the deepest rock comes out as bright as the slab — which
        // is backwards, and measured backwards in the first captures.
        shade: 0.80 - i * 0.09,
      },
      // NEVER WIDER THAN THE FASCIA ABOVE IT, which is a tighter rule than
      // "never wider than the slab" and it was found by measurement, not by
      // reasoning: `node tools/coverage.mjs --page voidkit.html` reported 5.75
      // m2 of exposed collider on the top tier of a 6 m slab. A blob's collider
      // is its bounding BOX, and the corners of that box are empty — harmless
      // while the box is buried under something, and a hole in the world the
      // moment any of it pokes out past the mass above. Clamping to the
      // fascia's own 0.90 keeps every tier buried.
      [sizeX * 0.45, tr * 1.9, sizeZ * 0.45], shade)
    baseY = cy - tr * squash * 1.5
    ty = cy - tr * squash * 0.55
    tr *= 0.66 + rand() * 0.10
  }

  // --- the drip spikes ----------------------------------------------------
  // §4.2: "drip-like spikes hanging beneath". These are SOLID, with a lathed
  // cone drawn inside a collider measured off its own bounding box — not decor.
  // A hanging spike is a thing a player climbing past will meet, and the one
  // bug this project keeps re-finding is geometry you can see and pass through.
  // The price is a ~10 cm box corner at the shoulder of each spike, which is a
  // far smaller lie than a rock that is not there.
  if (spikes && detail >= 1) {
    const count = 3 + ((rand() * 4) | 0)
    for (let i = 0; i < count; i++) {
      const a = (2 * Math.PI * (i + rand() * 0.6)) / count
      const rr = Math.min(sizeX, sizeZ) * (0.12 + rand() * 0.24)
      const sx = x + Math.cos(a) * rr, sz = z + Math.sin(a) * rr
      const len = 0.9 + rand() * 1.9
      const rad = 0.11 + rand() * 0.13
      const top = y - thickness - 0.3 - rand() * 0.5
      const segs = detail >= 2 ? 8 : 5
      // Profile bottom-to-top: a point, a kinked shoulder, a root.
      const geo = lathe([[0, 0], [rad * 0.42, len * 0.34], [rad * 0.82, len * 0.72],
        [rad, len]], { segments: segs, capTop: true, capBottom: false })
      const m = new THREE.Matrix4().makeTranslation(sx, top - len, sz)
      const bb = boundsOf(geo)
      n += S(sx, top - len + (bb.max[1] + bb.min[1]) / 2, sz,
        bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2],
        kind, { hidden: !!L.mesh })
      if (L.mesh) { L.mesh(kind, geo, m, { shade: 0.74 * shade }); n += 1 } else geo.dispose()
      if (top - len < baseY) baseY = top - len
    }
  }

  // --- the broken corner posts --------------------------------------------
  //
  // Ethan, on the density of the frame against his reference: our islands
  // "read as flat squares". They did — a slab with a rune on it has exactly
  // one silhouette, seen from above OR below, and there are fifty of them.
  // Four snapped-off posts at the corners give every island a broken profile
  // and, more usefully, four small verticals that catch the rim light.
  //
  // ON THE DIAGONAL, AND NOWHERE ELSE, and the geometry of that is the safety
  // argument. `level.js` holds every authored gap to an 82% landing margin,
  // which is a margin on the INSCRIBED circle; the corners of a square sit at
  // 1.41 half-widths, well outside anything a jump is measured against. And
  // they are capped at 1.1 m, comfortably under the 1.45 m mantle — so the
  // worst case is a player vaulting one, never a player stopped by one.
  // CLAUDE.md rule 3 is satisfied by the height, not by hoping.
  if (posts && detail >= 1 && Math.min(sizeX, sizeZ) > 4.5) {
    // A DEDICATED RNG STREAM. `runeSlab` draws its tiers, its spikes and its
    // rune rotation from one sequence, and inserting four draws anywhere in
    // the middle of it re-rolls every underside in the level. It did: the
    // first cut of these posts moved one island's tier stack into the
    // headroom of the island below, and `assertTriggersClear` failed with
    // "ascent 2: buried in stone". A separate stream keeps every shape that
    // was already verified byte-identical.
    const prand = makeRand(((opts.seed ?? DEFAULT_SEED) ^ 0x9E3779B1) >>> 0)
    const px = sizeX / 2 - inset - bw * 0.6
    const pz = sizeZ / 2 - inset - bw * 0.6
    for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      if (prand() < 0.22) continue          // some corners have lost theirs
      const ph = 0.45 + prand() * 0.65
      const pw = 0.42 + prand() * 0.22
      n += S(x + cx * px, y + ph / 2, z + cz * pz, pw, ph, pw, kind)
      // A snapped cap: narrower, offset, so the post ends in a break rather
      // than in a flat plinth top.
      if (detail >= 2) {
        n += S(x + cx * (px + 0.06), y + ph + 0.11, z + cz * (pz - 0.05),
          pw * 0.62, 0.22, pw * 0.72, kind)
      }
    }
  }


  return {
    topY: y, sizeX, sizeZ, baseY, runeRadius: runeR, boxes: n,
  }
}

/**
 * The rune motif: a geometric knot or rosette, authored in XY at radius `r`.
 *
 * §4.2 asks for "violet, geometric, a rosette or star knot". Both are here
 * because a level that repeats one motif on forty platforms reads as a decal:
 *
 *   'knot'    two counter-rotated squares struck as strokes (the eight-point
 *             star knot), inside a double ring, with a small star at the centre
 *   'rosette' six-fold: a ring of struck triangles about a filled star
 *
 * Everything is strokes and thin annuli rather than filled discs, for two
 * reasons that happen to agree: a filled disc of emissive at platform scale
 * blows the bloom budget art-direction-void.md §7.3 warns about, and a rune has
 * to be legible as a SHAPE from 40 m up, which line work is and a blob is not.
 */
function runeGlyph(r, motif = 'knot', segs = 32) {
  const out = { pos: [], idx: [] }
  const w = Math.max(0.045, r * 0.055)

  glyphRing(out, r * 0.98, w, segs)
  glyphRing(out, r * 0.80, w * 0.7, segs)

  if (motif === 'rosette') {
    const petals = 6
    for (let i = 0; i < petals; i++) {
      const a = (2 * Math.PI * i) / petals
      const c = Math.cos(a), s = Math.sin(a)
      const rm = r * 0.52, rt = r * 0.74
      glyphStroke(out, [
        [c * rt, s * rt],
        [c * rm - s * rm * 0.55, s * rm + c * rm * 0.55],
        [c * rm + s * rm * 0.55, s * rm - c * rm * 0.55],
      ], w * 0.85)
    }
    glyphFan(out, starPoints(6, r * 0.34, r * 0.15))
    glyphTicks(out, r * 0.84, r * 0.94, 12, w * 0.8, Math.PI / 12)
  } else {
    // The knot: two squares at 45 degrees, struck, plus the tick collar.
    const k = r * 0.66
    for (const phase of [Math.PI / 4, 0]) {
      const sq = []
      for (let i = 0; i < 4; i++) {
        const a = phase + (Math.PI / 2) * i
        sq.push([k * Math.cos(a), k * Math.sin(a)])
      }
      glyphStroke(out, sq, w * 0.9)
    }
    glyphFan(out, starPoints(4, r * 0.30, r * 0.10, Math.PI / 4))
    glyphTicks(out, r * 0.84, r * 0.94, 8, w, Math.PI / 8)
  }
  return glyphGeometry(out)
}

/**
 * sigilRing — the concentric glowing ring inlaid on a great wall's face.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE RING, ON the wall face. Pass the
 * plane the wall presents (`'xy'` for a wall whose faces look at ±Z, `'zy'` for
 * ±X) and the `side` it faces; the glyph is offset `standoff` out from there.
 *
 * §4.1: "concentric circles with radial tick marks and a star or diamond at the
 * centre, inlaid and glowing red. In the reference the largest is several
 * storeys across. They are the single most memorable element after the
 * crystals." So `radius` defaults to 6 m — a 12 m ring, three storeys — and the
 * colour defaults to the theme's `sigil`, which in the void is §3's red
 * punctuation and NOT the violet the runes own.
 *
 * THAT SEPARATION IS DELIBERATE AND IT IS A GAMEPLAY RULE, not a palette one.
 * §6 gives violet runes the meaning "you may stand here". A sigil ring is on a
 * VERTICAL face, several metres across, and nobody can stand on it — so it must
 * not be able to be read as a rune. Different colour, different geometry
 * family, different surface. `sigilRing` therefore takes no collider and makes
 * no promise, and it will refuse a colour equal to the theme's rune colour.
 *
 * DECOR, NO COLLIDER, and that is safe here in a way it is not elsewhere: the
 * glyph is flat, 12 mm proud of a wall face that IS solid, and vertical. There
 * is no orientation in which 12 mm of inlay on a wall could be mistaken for a
 * standable surface.
 *
 * @returns {{radius:number, glyphs:number, triangles:number}}
 */
export function sigilRing(L, x, y, z, opts = {}) {
  const {
    radius = 6, plane = 'xy', side = 1, standoff = 0.012,
    rings = 3, ticks = 24, centre = 'star', intensity = 2.0, detail = 2,
  } = opts
  const colors = voidColors(opts, opts.theme || safeTheme())
  if (colors.sigil === colors.rune && !opts.sigilColor) {
    throw new Error('voidkit.sigilRing: the sigil colour resolved equal to the rune colour. '
      + 'art-direction-void.md §6 gives the rune colour the meaning "you may stand here"; '
      + 'a wall sigil sharing it would teach the player to jump at a wall. '
      + 'Give the theme a distinct accent or pass `sigilColor`.')
  }

  const segs = detail >= 2 ? 64 : detail === 1 ? 32 : 16
  const nRings = Math.max(1, Math.min(5, rings | 0))
  const nTicks = detail >= 2 ? ticks : detail === 1 ? Math.round(ticks / 2) : 0
  const key = `sigil:${radius.toFixed(2)}:${nRings}:${nTicks}:${centre}:${segs}`

  const spin = plane === 'xz' ? 0 : 0
  const [ox, oy, oz] = plane === 'zy'
    ? [x + side * standoff, y, z]
    : plane === 'xz' ? [x, y + side * standoff, z] : [x, y, z + side * standoff]

  const placed = addGlow(L, key, colors.sigil, intensity,
    () => sigilGlyph(radius, nRings, nTicks, centre, segs),
    planeMatrix(plane, ox, oy, oz, side, spin))

  return { radius, glyphs: placed, triangles: placed ? sigilTriangles(nRings, nTicks, centre, segs) : 0 }
}

function sigilTriangles(nRings, nTicks, centre, segs) {
  return nRings * segs * 2 + nTicks * 2 + (centre === 'diamond' ? 4 : 8) + segs * 2
}

function sigilGlyph(radius, nRings, nTicks, centre, segs) {
  const out = { pos: [], idx: [] }
  const w = Math.max(0.05, radius * 0.026)
  // Rings at decreasing radius with the outermost struck heaviest, so the ring
  // set reads as one object at 200 m instead of as a stack of hairlines.
  for (let i = 0; i < nRings; i++) {
    const t = i / Math.max(1, nRings)
    glyphRing(out, radius * (1 - t * 0.42), w * (1 - t * 0.35), segs)
  }
  if (nTicks) glyphTicks(out, radius * 0.62, radius * 0.86, nTicks, w * 1.1)
  // One more, very fine, just inside the outermost — the machined read.
  glyphRing(out, radius * 0.92, w * 0.35, segs)
  if (centre === 'diamond') glyphFan(out, starPoints(2, radius * 0.30, radius * 0.10, Math.PI / 4))
  else glyphFan(out, starPoints(4, radius * 0.34, radius * 0.11))
  return glyphGeometry(out)
}

/**
 * monolith — a broken obelisk or a stump, for silhouette and mid-ground depth.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE BASE.
 *
 * §5 asks for "depth in three bands" and for every important edge to be backed
 * by glow. That is a level-layout job, but it needs objects to do it with: a
 * void with only walls and platforms has nothing between the near mass and the
 * fog. This is the cheap, repeatable thing that fills that band.
 *
 * SOLID, all of it. A monolith is standable on top (it presents one flat face
 * per course, and the courses are ≤ the 1.45 m step-up apart at the default
 * proportions, so it doubles as a step) and blocking at the side, and both of
 * those are true of the collider because the collider IS the drawn boxes.
 *
 * The break is real geometry rather than a texture: the top course is rotated
 * about the horizontal axis by `breakAngle` using `level.js`'s single-axis `rot`
 * channel, which SHRINKS the visual box until it fits back inside the declared
 * AABB — so a snapped obelisk can never present a face the collision world does
 * not know about. That shrink is also why the break reads: the rotated slab
 * sits slightly inside the shaft, which is exactly what a fracture looks like.
 *
 * NO RUNE, EVER, and that is a rule rather than an omission. §6 reserves the
 * glowing-rune channel for landing affordance; a monolith is mid-ground scenery
 * whose top is usually unreachable, so lighting one would be teaching the
 * player a lie in the one channel a dark level cannot afford to muddy.
 *
 * @returns {{topY:number, radius:number, boxes:number}}
 */
export function monolith(L, x, y, z, opts = {}) {
  const {
    height = 9, width = 1.5, kind = 'stone', detail = 2,
    taper = 0.58, stump = false, breakAngle = 0.34, courses: wantCourses,
  } = opts
  const rand = pick(opts)
  const { S, shade } = emit(L, opts)
  const h = stump ? height * 0.32 : height
  // THREE, NOT FIVE. `level.js` bakes a contact ramp into the bottom metre of
  // every box, so a shaft cut into five courses arrives with five dark bands
  // across it and reads as a stack of plates — measured in the mid-ground shot,
  // and it is the same "countable cubes" tell kit.js's header names. Fewer,
  // taller, overlapping courses put the ramp where a fracture actually is.
  const courses = wantCourses ?? (detail === 0 ? 1 : detail === 1 ? 2 : 3)
  let n = 0

  // --- the plinth ---------------------------------------------------------
  // Unrotated, for the coverage reason argued at the shaft below: its top is an
  // exposed shelf all the way round the shaft, and a turned box draws that
  // shelf smaller than it declares it.
  if (detail >= 1) {
    n += S(x, y + 0.22, z, width * 1.42, 0.44, width * 1.42, kind)
  }

  // --- the shaft ----------------------------------------------------------
  const base = y + (detail >= 1 ? 0.44 : 0)
  const shaft = h - (detail >= 1 ? 0.44 : 0)
  const each = shaft / courses
  // A LEAN. Nothing that has stood in a void long enough to break is still
  // plumb, and a vertical stack of axis-aligned boxes is the one silhouette
  // this kit must not produce. The offset accumulates up the shaft and stays
  // inside the plinth's own footprint, so the mass is still supported.
  const leanX = (rand() - 0.5) * width * 0.30
  const leanZ = (rand() - 0.5) * width * 0.30
  let topY = base
  for (let i = 0; i < courses; i++) {
    const t0 = i / courses, t1 = (i + 1) / courses
    // Linear taper, sampled at the course's own mid-height, so the stack reads
    // as one tapering mass rather than as a telescope.
    const w = width * (1 - taper * (t0 + t1) / 2)
    const cy = base + shaft * (t0 + t1) / 2
    const x2 = x + leanX * t1, z2 = z + leanZ * t1
    const last = i === courses - 1
    if (last && !stump && detail >= 1) {
      // ============================= THE SNAPPED TOP ======================
      // A STEPPED FRACTURE, not a tilted box, and this is the one place in this
      // file where the collision contract changed the art rather than the other
      // way round. Worth writing down, because the tilted box is the obvious
      // solution and it is wrong.
      //
      // The first cut rotated the top course about X or Z. `level.js` shrinks a
      // rotated box until it fits back inside its AABB, which is safe — but the
      // AABB's TOP FACE is then a flat plane that the tilted slab only touches
      // along one edge. `tools/coverage.mjs` reported the entire 4.00 m2 face
      // of each tall monolith as standable with nothing drawn above it: an
      // invisible roof, hovering over a broken obelisk, exactly the class of
      // bug that tool was written for.
      //
      // A diagonal cut approximated by three offset plates has no such plane.
      // Every plate is an axis-aligned solid box, so every plate's top face IS
      // its own drawn surface, and the profile still reads as a snap because
      // the steps are 20-30 cm against a 1.5-3.5 m section. It is less elegant
      // in source and strictly more honest in the world.
      const plates = 3
      const dir = rand() > 0.5 ? 1 : -1
      const alongX = rand() > 0.5
      const ph = each / plates
      for (let p = 0; p < plates; p++) {
        // Each plate keeps the full section on one axis and loses ground on the
        // other, so the fracture runs diagonally across the shaft.
        const cut = w * (0.16 + p * breakAngle * 0.9)
        const pw = Math.max(w * 0.25, w - cut)
        const shift = dir * (w - pw) / 2
        n += S(x2 + (alongX ? shift : 0), cy - each / 2 + ph * (p + 0.5), z2 + (alongX ? 0 : shift),
          alongX ? pw : w, ph, alongX ? w : pw, kind)
      }
    } else {
      // NO Y ROTATION HERE, and the reason is worth the paragraph because the
      // obvious move is to add one.
      //
      // A Y turn on a shaft course costs coverage and buys nothing. It costs
      // because `level.js`'s `fit` shrinks the drawn box until its rotated
      // footprint fits back inside the declared AABB, so the collider's top
      // face ends up LARGER than the drawn top face — and a monolith's lower
      // course tops are exposed shelves once the course above tapers in.
      // Measured: 6.00 m2 and 5.75 m2 of standable-but-undrawn surface on the
      // two tall monoliths alone, on a stage with a 1 m2 budget.
      //
      // And it buys nothing because kit.js's own header already says it: "a
      // Y-rotated cuboid is still a cuboid". A square section turned about Y is
      // a square section. The silhouette variety here comes from the lean, the
      // taper, the snapped top and the fragments — all of which are real shape
      // changes, none of which shrink a drawn box away from its collider.
      //
      // OVERLAP, and only where there is declared mass to overlap INTO.
      //
      // The courses exactly abut, so the join lands where `level.js` restarts
      // its contact ramp and draws a dark band across the shaft — several of
      // those is what made the first cut read as a stack of plates. Making a
      // course 14% taller buries the seam inside the mass.
      //
      // BOTH the collider and the drawing grow, which is the whole point. The
      // first attempt grew only the drawing (`size`), and `coverage.mjs` caught
      // it immediately: the drawn top face then sits 0.76 m ABOVE the collider
      // top, so the exposed shelf where the course above tapers in had no
      // upward-facing geometry at its own height — 6.00 m2 of it. Growing the
      // declaration keeps the two identical, and the extra volume is buried in
      // the neighbouring course anyway. The topmost course never grows: there
      // is nothing above it to hide the extra in.
      const grow = last ? 1 : 1.14
      n += S(x2, cy, z2, w, each * grow, w, kind)
    }
    topY = base + shaft * t1
  }

  // --- fallen fragments ---------------------------------------------------
  // A broken obelisk with nothing at its foot is a model, not a ruin.
  if (detail >= 2 && !stump) {
    const chunks = 1 + ((rand() * 3) | 0)
    for (let i = 0; i < chunks; i++) {
      const a = 2 * Math.PI * rand()
      const rr = width * (1.1 + rand() * 1.6)
      const r = width * (0.20 + rand() * 0.22)
      // A CHAMFERED CUBOID, NOT A BLOB, and the reasoning this replaces was
      // right about the wrong axis. A fragment lies in the open with its top
      // face exposed, and a blob is drawn inside its bounding BOX — squashing
      // it flat does stop it touching that box's top at a single vertex, which
      // is what the previous note fixed. What squashing cannot fix is the four
      // CORNERS of that face: a round thing in a square box misses 21% of the
      // top however flat it is, for ever. One fragment is half a square metre
      // and invisible; the void course now places thirty monoliths and two
      // hundred debris chips, and `coverage.mjs --page ?theme=void` billed the
      // difference at 152 m2. A box IS its own collider, exactly — and a shard
      // fallen off an obelisk is a slab of cut stone anyway.
      n += S(x + Math.cos(a) * rr, y + r * 0.45, z + Math.sin(a) * rr,
        r * (1.5 + rand() * 0.8), r * (0.75 + rand() * 0.5), r * (1.5 + rand() * 0.8),
        kind, { shade: 0.86 * shade })
    }
  }

  return { topY, radius: width / 2, boxes: n }
}

// ========================================================== THE DRESSING KIT
//
// Ethan, 2026-07-25, comparing the build to the reference image:
//
//   "we are significantly less detailed and have less cool unique additions
//   compared to the reference image and we have less depth and detail in the
//   backdrop as well and less overall objects we have."
//
// He is right, and the diagnosis is specific: four prefab types cannot fill a
// 508 m shaft. The reference frame has, ON TOP of walls, slabs, sigils and
// crystals — broken arcades, hanging chains, thin spires, carved statuary,
// stepped ziggurat masses, small floating debris at every depth, glowing orbs
// receding into the haze, hanging banners, cracked causeways between masses,
// and ruin districts stacked layer on layer. Everything below exists to put
// those things in the frame.
//
// ============================ WHAT THEY ALL SHARE ==========================
//
// 1. THEY COST TRIANGLES, NOT DRAW CALLS. `level.js` merges every box and
//    every `L.mesh()` of one kind into ONE geometry at build time, so an
//    arcade, a chain and a thousand rock chips all land in the same batch the
//    great walls are already in. That is what makes this affordable: the void
//    ran 73-107 draws before this file grew and it runs the same after, and
//    the whole budget conversation is about vertex throughput instead. Where
//    a prefab genuinely cannot share that batch (the glowing orbs — a
//    different material) it goes through the glow channel, which instances by
//    shape signature, so hundreds of orbs are still one draw call.
//
// 2. NOTHING HAS A LARGE FLAT TOP. `docs/course-design.md` and the brief agree:
//    nothing decorative may become an accidental landing. Every mass here ends
//    in a ragged crest, a broken crown, an arch extrados or a needle, and the
//    few genuinely flat faces are ziggurat steps, which are ghost-only. The
//    constraint improved the silhouettes: a ruin with a flat top reads as a
//    building site.
//
// 3. THEY ARE ALL GHOSTABLE, AND THE CALLER DECIDES BY MEASUREMENT. `emit()`'s
//    `ghost` flag switches every emitter from `L.solid` to `L.decor`. The
//    course (`levels/void.js`) sets it from the 3D distance to the nearest
//    graph node, and registers what it ghosts with `Archipelago.sceneryAt` so
//    `verify()` proves the clearance rather than taking the placement's word
//    for it. Near the route: real colliders, always. Far from it: no collider,
//    proven unreachable. There is no middle.
//
// 4. EVERY LOD IS REAL. `detail: 0` drops the chamfer (12 triangles a box
//    instead of 44) and coarsens the slicing, which is what lets a far ruin
//    district of two hundred masses cost less than one great wall.

// --------------------------------------------------------------- rock chips
//
// A tiny pool of displaced icosahedra, shared by every debris cloud in the
// world. `subdivisions: 0` is deliberate: `blob`'s default LOD floor is one
// subdivision (80 triangles) and a 60 cm chip tumbling at 200 m does not need
// them. A raw displaced icosahedron is 20 triangles and, because the noise is
// band-limited to the mesh, it comes out as an angular chunk of rock rather
// than a smooth pebble — which is the read the reference wants anyway.

const _chunk = new Map()

function chunkGeometry(i, sub = 0) {
  const key = `${i}:${sub}`
  let g = _chunk.get(key)
  if (!g) {
    g = blob(0xD1B500 + i * 7919, {
      radius: 1,
      lumpiness: 0.46 + (i % 5) * 0.05,
      squash: 0.44 + (i % 4) * 0.14,
      taperY: -0.18,
      frequency: 3.3,
      subdivisions: sub,
      mottle: 0.10,
    })
    _chunk.set(key, g)
  }
  return g
}

/**
 * debrisCloud — small floating rock, a lot of it, at many depths.
 *
 * ANCHOR: (x, y, z) is the CENTRE of the cloud.
 *
 * The single highest-value thing in this file, and the cheapest. The reference
 * image's sense of a world rather than a diorama comes almost entirely from the
 * fact that the space BETWEEN the big masses is not empty — there is always
 * something tumbling in it, at every distance, catching a little light. Ours
 * had nothing between the islands at all, which is why the `plunge` frame read
 * as four dark squares on a violet field.
 *
 * At 20 triangles a chip and zero draw calls, a thousand of them cost less than
 * one great wall's panel grid. That is the whole argument for doing this first.
 *
 * COLLISION. Ghost by default, because a cloud is placed where the course has
 * proved no player can reach — see `ghost` in the header above. Passed
 * `ghost: false` every chip becomes a `hiddenBlob`: a measured AABB with the
 * rock drawn inside it. The solid form is deliberately SQUASHED and only
 * a chamfered cuboid, for the reason `monolith`'s fallen fragments give at
 * length — a blob is drawn inside its bounding BOX and can never cover that
 * box's four top corners, which across two hundred chips is exactly the
 * standable-but-undrawn area `tools/coverage.mjs` exists to catch.
 */
export function debrisCloud(L, x, y, z, opts = {}) {
  const {
    count = 26, radius = 22, size = 1.0, kind = 'stone', detail = 0,
  } = opts
  const ghost = opts.ghost !== false
  const spreadY = opts.spreadY ?? radius * 0.75
  const rand = pick(opts)
  const { S, shade } = emit(L, { ...opts, ghost })
  const sub = detail >= 2 ? 1 : 0
  let n = 0
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2
    // sqrt so the cloud is uniform in AREA rather than crowding its centre.
    const rr = radius * Math.sqrt(rand())
    const px = x + Math.cos(a) * rr
    const pz = z + Math.sin(a) * rr
    const py = y + (rand() - 0.5) * 2 * spreadY
    // rand^2 biases hard toward small: a cloud of equal-sized rocks reads as a
    // pattern, and the few large ones are what give the small ones a scale.
    const s = size * (0.26 + rand() * rand() * 1.6)
    if (ghost) {
      if (!L.mesh) continue
      const geo = chunkGeometry(i % 6, sub).clone()
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(rand() * 6.283, rand() * 6.283, rand() * 6.283))
      L.mesh(kind, geo, new THREE.Matrix4().compose(
        new THREE.Vector3(px, py, pz), q,
        new THREE.Vector3(s, s * (0.55 + rand() * 0.55), s * (0.75 + rand() * 0.5))),
      { shade: (0.70 + rand() * 0.24) * shade })
      n++
    } else {
      // A SOLID CHIP IS A BOX, and this is measured rather than fastidious.
      //
      // A blob is drawn inside its own bounding BOX, and a round thing in a
      // square box never covers the four corners — 21% of that box's top face,
      // at every squash and every lumpiness, for ever. One fallen fragment is
      // 1 m2 of standable-but-undrawn and nobody notices; two hundred debris
      // chips is 139 m2, which is what `coverage.mjs --page ?theme=void`
      // reported and what took the void from 0.5 m2 of debt to 152.
      //
      // So the solid form is a small chamfered cuboid with randomised
      // proportions. It IS its own collider, exactly, and at the sizes debris
      // is drawn at the difference from a blob is a chamfer.
      n += S(px, py, pz,
        s * (1.3 + rand() * 0.7), s * (0.7 + rand() * 0.5), s * (1.3 + rand() * 0.7), kind)
    }
  }
  return { count, pieces: n }
}

/**
 * brokenArch — a ruined arcade: a wall pierced by arched openings, its crest
 * broken, some of its arches collapsed.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE FOOTPRINT AT THE BASE. `axis` is the
 * direction the arcade runs.
 *
 * ======================= WHY A PIERCED WALL, NOT A RING ====================
 * The obvious construction is `props.arch()` — a ring of voussoirs, each a box
 * rotated to the arc tangent. It was built that way first and it is WRONG here,
 * for a reason that is worth recording because it will come up again.
 *
 * `level.js`'s `rot` channel shrinks a rotated box until it fits back inside
 * its declared AABB. That keeps the collider honest, but it means a voussoir at
 * 45 degrees touches the TOP of its own AABB along one edge and leaves the rest
 * of that face standable with nothing drawn on it. Across the exposed extrados
 * of one arch that is several square metres of invisible floor — the exact bug
 * class `tools/coverage.mjs` was written for, multiplied by every arch in the
 * level.
 *
 * A wall with the arch CUT OUT of it has no rotated boxes at all. It is
 * sampled in vertical slices: each slice is one axis-aligned solid box running
 * from its own floor (the ground, or the intrados curve where a slice passes
 * through an opening) to its own crest. Every slice's top face IS its own drawn
 * top face, at every angle, so coverage is exact by construction — and the
 * silhouette is better, because a ruined arcade in the reference is a pierced
 * wall rather than a freestanding ring.
 *
 * The crest is a ragged function of position rather than a flat line, which
 * also means this can never present a long flat landing however it is placed.
 *
 * @returns {{length:number, topY:number, boxes:number}}
 */
export function brokenArch(L, x, y, z, opts = {}) {
  const {
    bays = 3, span = 8, rise = 4.4, pierWidth = 2.0, depth = 2.4,
    crest = 3.0, axis = 'x', kind = 'stone', detail = 2, broken = 0.4,
    pilasters = true,
  } = opts
  const legHeight = opts.legHeight ?? rise * 0.85
  const rand = pick(opts)
  const { S } = emit(L, opts)
  const F = frame(axis)
  const nBays = Math.max(1, bays | 0)
  const pitch = span + pierWidth
  const total = nBays * pitch + pierWidth
  const springY = y + legHeight
  const crownY = springY + rise
  let n = 0

  // The crest: two incommensurate sine waves with random phase, so the top of
  // the wall is broken everywhere and repeats nowhere. Evaluated as a function
  // of position rather than sampled per box, so the profile is continuous and
  // the boxes tile it instead of stepping randomly against each other.
  const p1 = rand() * 6.283, p2 = rand() * 6.283
  const w1 = 0.19 + rand() * 0.12, w2 = 0.61 + rand() * 0.3
  const crestAt = (u) => crownY + crest * (
    0.30 + 0.44 * (0.5 + 0.5 * Math.sin(u * w1 + p1))
    + 0.26 * (0.5 + 0.5 * Math.sin(u * w2 + p2)))

  // Which bays have lost their arch, and from which side the collapse runs.
  const bayState = []
  for (let b = 0; b < nBays; b++) {
    const hit = rand() < broken
    bayState.push({
      broken: hit,
      side: rand() > 0.5 ? 1 : -1,
      // How far across the opening the collapse has eaten, as a fraction.
      eaten: 0.35 + rand() * 0.75,
    })
  }

  const sliceW = detail >= 2 ? 0.66 : detail === 1 ? 1.1 : 1.9
  const slices = Math.max(4, Math.round(total / sliceW))
  const sw = total / slices
  const flat = detail === 0 ? { bevel: 0 } : undefined

  for (let i = 0; i < slices; i++) {
    const u = -total / 2 + (i + 0.5) * sw
    let floor = y
    let top = crestAt(u)

    // Inside an opening?
    for (let b = 0; b < nBays; b++) {
      const ob = -total / 2 + pierWidth + span / 2 + b * pitch
      const du = u - ob
      if (Math.abs(du) >= span / 2) continue
      const st = bayState[b]
      // Elliptical intrados. Always defined, unlike the circular one, and at
      // these proportions the eye cannot tell them apart.
      const t = du / (span / 2)
      const arch = springY + rise * Math.sqrt(Math.max(0, 1 - t * t))
      if (st.broken && (du * st.side) > (span / 2) * (1 - st.eaten)) {
        // The collapsed end of a broken bay: the wall is simply gone above the
        // springing, leaving a ragged stub of leg.
        top = Math.min(top, springY + rise * 0.22 * (0.4 + rand() * 0.6))
      } else {
        floor = arch
      }
      break
    }

    if (top - floor < 0.32) continue
    const [cx, cz] = F.at(x, z, u, 0)
    const [sx, sz] = F.sz(sw * 1.02, depth)
    n += S(cx, (floor + top) / 2, cz, sx, top - floor, sz, kind, flat)
  }

  // Pilasters — a shallow buttress standing proud of both faces at every pier.
  // Without them a pierced wall is a slab with holes in it; with them the
  // arcade has an order, and the shadow down each pier is what makes the
  // openings read as openings at 200 m.
  if (pilasters && detail >= 1) {
    for (let b = 0; b <= nBays; b++) {
      const u = -total / 2 + pierWidth / 2 + b * pitch
      const h = springY + rise * 0.28 - y
      for (const side of [1, -1]) {
        const [cx, cz] = F.at(x, z, u, side * (depth / 2 + 0.19))
        const [sx, sz] = F.sz(pierWidth * 0.72, 0.38)
        n += S(cx, y + h / 2, cz, sx, h, sz, kind, flat)
      }
    }
  }

  return { length: total, topY: crestAt(0), springY, crownY, boxes: n }
}

/**
 * ruinSpire — a tall thin tower, snapped off near the top.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE BASE.
 *
 * §5 asks every hero vantage to be framed by a vertical, and the course had
 * exactly two kinds of vertical in it: the great walls (which are 40 m wide and
 * read as ground rather than as a line) and the energy beams (which are
 * emissive and belong to another lane). A spire is the third: a hard dark
 * vertical, cheap enough to place forty of, that gives the fog something to
 * recede past.
 *
 * It is `monolith` grown up rather than a variant of it — the difference that
 * matters is the CORNER PILASTERS, four strips standing proud the whole height.
 * A bare tapering stack at 40 m reads as a smooth cone in the haze; the
 * pilasters give it four hard edges that catch the rim light §5 asks for, and
 * they are what makes the same silhouette read as built rather than as rock.
 *
 * @returns {{topY:number, width:number, boxes:number}}
 */
export function ruinSpire(L, x, y, z, opts = {}) {
  const {
    height = 34, width = 4.0, kind = 'stone', detail = 2, taper = 0.66,
    fins = true, broken = true,
  } = opts
  const courses = opts.courses ?? (detail === 0 ? 2 : detail === 1 ? 4 : 6)
  const rand = pick(opts)
  const { S } = emit(L, opts)
  const flat = detail === 0 ? { bevel: 0 } : undefined
  let n = 0

  // Plinth. Two courses so the foot has a moulding rather than a hard meeting
  // with the ground it is (usually) not standing on anyway.
  const plinthH = Math.min(1.4, height * 0.05)
  n += S(x, y + plinthH * 0.3, z, width * 1.55, plinthH * 0.6, width * 1.55, kind, flat)
  if (detail >= 1) n += S(x, y + plinthH * 0.8, z, width * 1.28, plinthH * 0.4, width * 1.28, kind, flat)

  const base = y + plinthH
  const shaft = height * (broken ? 0.88 : 1) - plinthH
  const each = shaft / courses
  const leanX = (rand() - 0.5) * width * 0.5
  const leanZ = (rand() - 0.5) * width * 0.5
  const widthAt = (t) => width * (1 - taper * t)

  for (let i = 0; i < courses; i++) {
    const t0 = i / courses, t1 = (i + 1) / courses
    const w = widthAt((t0 + t1) / 2)
    const cy = base + shaft * (t0 + t1) / 2
    const x2 = x + leanX * t1, z2 = z + leanZ * t1
    const last = i === courses - 1
    if (last && broken && detail >= 1) {
      // The same stepped fracture `monolith` argues for: three offset plates
      // approximating a diagonal break, every one of them axis-aligned so
      // every one of them draws its own top face.
      const plates = 3
      const dir = rand() > 0.5 ? 1 : -1
      const alongX = rand() > 0.5
      const ph = each / plates
      for (let p = 0; p < plates; p++) {
        const cut = w * (0.14 + p * 0.30)
        const pw = Math.max(w * 0.22, w - cut)
        const shift = dir * (w - pw) / 2
        n += S(x2 + (alongX ? shift : 0), cy - each / 2 + ph * (p + 0.5), z2 + (alongX ? 0 : shift),
          alongX ? pw : w, ph, alongX ? w : pw, kind, flat)
      }
    } else {
      n += S(x2, cy, z2, w, each * (last ? 1 : 1.12), w, kind, flat)
    }
    // Corner pilasters. Face-centred rather than corner-set: a strip on the
    // diagonal is invisible in silhouette from three of the four cardinal
    // directions, and this tower is seen from all of them.
    if (fins && detail >= 1 && !(last && broken)) {
      const fw = Math.max(0.34, w * 0.26), fp = 0.30
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        n += S(x2 + ox * (w / 2 + fp / 2), cy, z2 + oz * (w / 2 + fp / 2),
          ox ? fp : fw, each * 0.94, ox ? fw : fp, kind, flat)
      }
    }
  }

  return { topY: base + shaft, width, boxes: n }
}

/**
 * ziggurat — a stepped mass, for the far band's skyline.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE BASE.
 *
 * The reference's depth does not come from fog alone; it comes from the fact
 * that there is a DISTRICT behind the fog — big stepped masses, layer on layer,
 * each one a little more washed out than the last. A spire is a line and an
 * arcade is a plane; this is the volume, and it is the shape that reads at
 * 400 m when everything else has dissolved.
 *
 * GHOST BY DEFAULT and it should stay that way. Its steps are the one genuinely
 * large flat surface in this file, which is fine at 300 m where the course has
 * proved nobody can arrive and would be an accidental landing anywhere nearer.
 *
 * @returns {{topY:number, width:number, boxes:number}}
 */
export function ziggurat(L, x, y, z, opts = {}) {
  const {
    width = 26, height = 20, kind = 'stone', detail = 1, shrink = 0.70,
    crown = true,
  } = opts
  const steps = opts.steps ?? (detail === 0 ? 3 : detail === 1 ? 5 : 7)
  const rand = pick(opts)
  const { S } = emit(L, { ghost: true, ...opts })
  const flat = detail === 0 ? { bevel: 0 } : undefined
  const each = height / steps
  let n = 0
  let w = width

  // THE STACK DRIFTS. A ziggurat whose courses share one axis is a symmetric
  // pyramid, and a symmetric pyramid of `bevel: 0` boxes at 400 m is a
  // staircase — which is exactly what the first far-band capture came back as,
  // three of them in a row, reading as voxel art rather than as ruin. Letting
  // each course wander a fraction of its own inset costs nothing and turns the
  // same box count into a mass that has collapsed unevenly.
  let ox = 0, oz = 0
  for (let i = 0; i < steps; i++) {
    const cy = y + each * (i + 0.5)
    const last = i === steps - 1
    if (last && detail >= 1) {
      // The top course is BROKEN into two offset plates, so the mass never
      // finishes in a clean rectangle — a ziggurat with a tidy top reads as
      // architecture drawn by a compiler.
      const a = w * (0.42 + rand() * 0.2)
      n += S(x + ox - (w - a) / 2, cy, z + oz, a, each, w * (0.7 + rand() * 0.3), kind, flat)
      n += S(x + ox + a / 2, cy - each * 0.22, z + oz + w * 0.1,
        w - a, each * 0.56, w * 0.55, kind, flat)
    } else {
      n += S(x + ox, cy, z + oz, w, each * 1.04, w * (0.86 + rand() * 0.28), kind, flat)
    }
    // Corner buttresses on the bottom two courses: the shadow line that stops
    // a stack of boxes from reading as a stack of boxes.
    if (i < 2 && detail >= 1) {
      const bw = w * 0.16
      for (const [bx, bz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        n += S(x + ox + bx * (w / 2 - bw * 0.3), cy, z + oz + bz * (w / 2 - bw * 0.3),
          bw, each * 1.1, bw, kind, flat)
      }
    }
    const nw = w * (shrink + rand() * 0.06)
    ox += (rand() - 0.5) * (w - nw) * 0.9
    oz += (rand() - 0.5) * (w - nw) * 0.9
    w = nw
  }

  if (crown && detail >= 1) {
    // A broken shrine on the summit. Different silhouette from the steps, so
    // the mass terminates in something rather than simply stopping.
    n += ruinSpire(L, x + ox, y + height, z + oz, {
      height: height * 0.55, width: Math.max(1.6, w * 1.3), detail: Math.max(0, detail - 1),
      taper: 0.5, seed: (rand() * 0xffffff) | 0, ghost: true, kind,
    }).boxes
  }

  return { topY: y + height, width, boxes: n }
}

/**
 * hangingChain — a cable or chain hung from a mass, sagging into the void.
 *
 * ANCHOR: (x, y, z) is the TOP ATTACHMENT. `to` hangs it to a second point;
 * without one it falls free, drifting a little as it goes.
 *
 * The reference is full of these and they do something no other prefab here
 * does: they connect masses that are otherwise floating independently, which is
 * most of what makes the space read as one place instead of as a set of props.
 * They are also nearly free — a four-sided tube at ten path segments is 80
 * triangles for twenty metres of world.
 *
 * COLLISION. Solid by default, and the collider is one small hidden AABB per
 * path segment rather than one box round the whole curve: a catenary's own
 * bounding box is a slab metres across and almost entirely empty, which is a
 * far bigger lie than the ~8 cm of box corner at each link. `ghost: true` drops
 * the colliders for the far band, where the course has proved no player can
 * reach it.
 *
 * @returns {{length:number, boxes:number}}
 */
export function hangingChain(L, x, y, z, opts = {}) {
  const {
    length = 20, radius = 0.09, kind = 'stone', detail = 1, sag = 0.16,
    weight = true, links = null,
  } = opts
  const rand = pick(opts)
  const ghost = !!opts.ghost
  const { S, shade } = emit(L, opts)
  const segs = detail >= 2 ? 6 : detail === 1 ? 4 : 3
  const steps = links ?? (detail >= 2 ? 12 : detail === 1 ? 9 : 6)
  const to = opts.to || null
  let n = 0

  // The path. Hung between two points it is a catenary approximated by a
  // parabola (indistinguishable at these spans); hung free it falls with a
  // slow drift, because a dead-vertical line reads as a wire and the reference
  // has weight on everything.
  const pts = []
  // THE DRIFT IS SMALL, AND THAT IS A COLLISION NUMBER RATHER THAN AN ART ONE.
  // Each path span gets one AABB, so a chain that wanders 3 m sideways over ten
  // links declares ten 0.8 m boxes with a 10 cm tube running diagonally through
  // each — and the top face of every one of those boxes is standable with
  // nothing drawn on it. Measured: 40 m2 across the course's hundred chains.
  // At 5% the per-span drift is under the 0.5 m coverage cell, so each box is
  // sampled once, at its centre, where the chain actually is. It also still
  // reads: a hanging chain in the reference is a near-vertical line with a
  // little life in it, not a bent wire.
  const driftX = (rand() - 0.5) * length * 0.05
  const driftZ = (rand() - 0.5) * length * 0.05
  const span = to ? Math.hypot(to[0] - x, to[2] - z) : 0
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    if (to) {
      const px = x + (to[0] - x) * t
      const pz = z + (to[2] - z) * t
      const py = y + (to[1] - y) * t - sag * span * 4 * t * (1 - t)
      pts.push([px, py, pz])
    } else {
      pts.push([x + driftX * t * t, y - length * t, z + driftZ * t * t])
    }
  }

  const geo = sweepTube(pts, radius, { segments: segs, detail, taper: 0.82, pathSegments: steps })
  if (L.mesh) {
    if (!ghost) {
      // One AABB per span of the path, measured from the two ends plus the
      // tube radius. Nothing about the drawn curve leaves it.
      for (let i = 0; i < steps; i++) {
        const a = pts[i], b = pts[i + 1]
        const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, cz = (a[2] + b[2]) / 2
        n += S(cx, cy, cz,
          Math.abs(b[0] - a[0]) + radius * 2,
          Math.abs(b[1] - a[1]) + radius * 2,
          Math.abs(b[2] - a[2]) + radius * 2, kind, { hidden: true })
      }
    }
    L.mesh(kind, geo, new THREE.Matrix4(), { shade: 0.86 * shade })
    n += 1
  } else geo.dispose()

  // A counterweight on a free-hanging chain: the thing that says it is heavy.
  if (weight && !to && detail >= 1) {
    const end = pts[pts.length - 1]
    const r = radius * (2.2 + rand() * 1.2)
    if (ghost) {
      if (L.mesh) {
        const g = chunkGeometry(3, 0).clone()
        L.mesh(kind, g, new THREE.Matrix4().compose(
          new THREE.Vector3(end[0], end[1] - r * 0.5, end[2]),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(rand(), rand() * 3, rand())),
          new THREE.Vector3(r, r * 1.5, r)), { shade: 0.8 * shade })
        n += 1
      }
    } else {
      // A BLOCK, not a blob, for the coverage reason argued at `statue`'s head:
      // a rounded lump only touches the top of its own collider at a point, and
      // there are a hundred of these hanging off the islands and the walls. A
      // squared stone counterweight is also simply what a chain like this ends
      // in.
      n += S(end[0], end[1] - r * 0.75, end[2], r * 1.7, r * 1.5, r * 1.7, kind)
      n += S(end[0], end[1] - r * 1.62, end[2], r * 1.15, r * 0.4, r * 1.15, kind)
    }
  }

  return { length: to ? Math.hypot(to[0] - x, to[1] - y, to[2] - z) : length, boxes: n }
}

/**
 * causeway — a cracked bridge running between two masses.
 *
 * ANCHOR: (x, y, z) is one end; `to` is the other.
 *
 * §5's "silhouette against glow" wants long horizontals crossing the frame at
 * mid depth, and a broken one is better than a whole one: the gap is what tells
 * you it is a ruin rather than a road. It is also the cheapest way to make two
 * far masses read as ONE district instead of two objects.
 *
 * GHOST BY DEFAULT, for the reason `ziggurat` gives: a causeway deck is a long
 * flat surface, which is a landing anywhere the player could get to it.
 *
 * @returns {{span:number, boxes:number}}
 */
export function causeway(L, x, y, z, opts = {}) {
  const {
    width = 4.0, thickness = 0.9, kind = 'stone', detail = 1, parapet = true,
    sag = 0.05,
  } = opts
  const to = opts.to || [x + 60, y - 8, z]
  const rand = pick(opts)
  const { S } = emit(L, { ghost: true, ...opts })
  const flat = detail === 0 ? { bevel: 0 } : undefined
  const dx = to[0] - x, dy = to[1] - y, dz = to[2] - z
  const span = Math.hypot(dx, dz)
  const segLen = detail >= 2 ? 3.2 : detail === 1 ? 4.6 : 7.0
  const count = Math.max(3, Math.round(span / segLen))
  const gaps = opts.gaps ?? (1 + ((rand() * 2) | 0))
  // Which segments are missing. Never the two ends — a bridge with no abutment
  // reads as a floating plank rather than as a broken bridge.
  const missing = new Set()
  for (let g = 0; g < gaps; g++) {
    const at = 1 + ((rand() * (count - 2)) | 0)
    missing.add(at)
    if (rand() > 0.55) missing.add(at + 1)
  }
  // Across the span, so the deck and the parapets share one axis frame.
  const ux = dx / (span || 1), uz = dz / (span || 1)
  const nx = -uz, nz = ux
  let n = 0

  for (let i = 0; i < count; i++) {
    if (missing.has(i)) continue
    const t = (i + 0.5) / count
    const px = x + dx * t, pz = z + dz * t
    const py = y + dy * t - sag * span * 4 * t * (1 - t)
    const len = (span / count) * 1.04
    // Axis-aligned boxes sized to the segment's own footprint. A rotated deck
    // would cost the same coverage argument `brokenArch` refuses to pay.
    const sx = Math.abs(ux) * len + Math.abs(nx) * width
    const sz = Math.abs(uz) * len + Math.abs(nz) * width
    n += S(px, py, pz, sx, thickness, sz, kind, flat)
    if (parapet && detail >= 1 && rand() > 0.35) {
      const side = rand() > 0.5 ? 1 : -1
      const pw = 0.42
      n += S(px + nx * side * (width / 2 - pw / 2), py + thickness / 2 + 0.34,
        pz + nz * side * (width / 2 - pw / 2),
        Math.abs(ux) * len * 0.9 + Math.abs(nx) * pw,
        0.68,
        Math.abs(uz) * len * 0.9 + Math.abs(nz) * pw, kind, flat)
    }
  }
  return { span, boxes: n }
}

/**
 * statue — a carved figure on a pillar, the void's inhabitants.
 *
 * ANCHOR: (x, y, z) is the CENTRE OF THE BASE.
 *
 * Everything else in this kit is architecture, and a ruin with no figures in it
 * reads as a quarry. The reference has carved statuary and pillars all through
 * the mid ground, and one silhouette with a HEAD on it changes the register of
 * the whole frame — it says somebody built this and is gone.
 *
 * Deliberately crude and deliberately boxy: this is a colossal carved figure
 * seen at 30 to 200 m in near-darkness, not a character model. Every part is an
 * axis-aligned solid box except the head, which is a `hiddenBlob` — a rounded
 * head against a rectilinear body is the whole read, and it is one blob.
 *
 * @returns {{topY:number, boxes:number}}
 */
export function statue(L, x, y, z, opts = {}) {
  const {
    height = 10, kind = 'stone', detail = 2, armless = false,
  } = opts
  const rand = pick(opts)
  const { S, shade } = emit(L, opts)
  const flat = detail === 0 ? { bevel: 0 } : undefined
  const s = height / 10          // everything below is authored at height 10
  let n = 0

  // Plinth: two courses, the upper one inset.
  n += S(x, y + 0.35 * s, z, 3.4 * s, 0.7 * s, 3.4 * s, kind, flat)
  n += S(x, y + 0.95 * s, z, 2.7 * s, 0.5 * s, 2.7 * s, kind, flat)

  // The robe: three courses narrowing upward, with a lean so the figure has a
  // contrapposto rather than standing to attention.
  const lean = (rand() - 0.5) * 0.5 * s
  const robe = [[1.2, 2.4, 2.1], [3.5, 2.0, 1.75], [5.4, 1.4, 1.5]]
  for (let i = 0; i < robe.length; i++) {
    const [by, bh, bw] = robe[i]
    if (detail === 0 && i === 1) continue
    n += S(x + lean * (by / 6), y + (by + bh / 2) * s, z + lean * 0.4 * (by / 6),
      bw * s, bh * s, bw * 0.86 * s, kind, flat)
  }

  // Shoulders and head.
  const sy = 6.8 * s
  n += S(x + lean * 1.15, y + sy, z + lean * 0.46, 2.7 * s, 0.9 * s, 1.5 * s, kind, flat)
  const hx = x + lean * 1.2, hz = z + lean * 0.48
  // ============================ THE HEAD IS BOXES =============================
  // It was a `hiddenBlob`, on the reasoning that a rounded head against a
  // rectilinear body is the whole read. `tools/coverage.mjs --page ?theme=void`
  // refused it, and was right: a blob is drawn inside its own bounding BOX, and
  // a near-spherical one only reaches that box's top face at a single point.
  // The tolerance is 60 cm, so on a head 3 m across the outer ring of the
  // collider's top face is standable with nothing drawn on it — and across the
  // thirty statues in this course that measured 299.75 m2 against a 200 m2
  // budget. The exact bug the tool exists for, arriving through a prefab that
  // looked innocent.
  //
  // Two stacked boxes — jaw and crown, the crown narrower and set back — give a
  // head that reads at the only distances anyone sees it from, and every top
  // face in it is its own drawn surface. The blob is kept for the SHOULDERS'
  // silhouette instead, where it is buried under the head and cannot be
  // exposed.
  n += S(hx, y + sy + 0.86 * s, hz, 1.30 * s, 1.05 * s, 1.24 * s, kind, flat)
  if (detail >= 1) {
    n += S(hx - 0.06 * s, y + sy + 1.62 * s, hz + 0.05 * s,
      1.06 * s, 0.52 * s, 1.02 * s, kind, flat)
  }

  // Arms folded across the chest — two short boxes, and one of them is
  // sometimes missing, because these are ruins.
  if (!armless && detail >= 1) {
    for (const side of [1, -1]) {
      if (rand() < 0.22) continue
      n += S(x + lean * 1.05 + side * 0.95 * s, y + 5.6 * s, z + lean * 0.42,
        0.62 * s, 1.9 * s, 0.62 * s, kind, flat)
    }
  }

  return { topY: y + sy + 1.9 * s, boxes: n }
}

/**
 * banner — hanging cloth, with a lit seam down it.
 *
 * ANCHOR: (x, y, z) is the TOP RAIL. It hangs DOWN from there. `axis` is the
 * direction the rail runs; the cloth faces across it.
 *
 * The reference has banners the height of several storeys hanging off the great
 * walls, and they do a specific job §5 asks for: they break the wall's panel
 * grid with a soft vertical, and their bottom edge is the only ragged, hanging
 * silhouette in a frame that is otherwise all straight lines and points.
 *
 * NO ROTATION ANYWHERE. The wave is made by OFFSETTING each course along the
 * cloth's normal, not by turning it — a turned box is shrunk to fit its
 * collider (see `brokenArch`'s note), and a stack of shrinking boxes is a
 * ladder rather than a hanging cloth. Offsetting costs nothing and reads
 * better.
 *
 * The lit seam goes through the glow channel in the theme's COOL accent, never
 * the rune colour: §6 reserves that colour for "you may stand here" and a
 * banner is on a wall.
 *
 * @returns {{bottomY:number, boxes:number}}
 */
export function banner(L, x, y, z, opts = {}) {
  const {
    length = 12, width = 2.4, thickness = 0.14, axis = 'x', kind = 'stone',
    detail = 2, seam = true, seamIntensity = 1.1,
  } = opts
  const rand = pick(opts)
  const { S, ghost } = emit(L, opts)
  const colors = voidColors(opts, opts.theme || safeTheme())
  const F = frame(axis)
  const courses = detail >= 2 ? 7 : detail === 1 ? 4 : 2
  const each = length / courses
  const flat = detail === 0 ? { bevel: 0 } : undefined
  const phase = rand() * 6.283
  const amp = Math.min(0.42, width * 0.20)
  let n = 0

  // The rail the cloth hangs from.
  {
    const [cx, cz] = F.at(x, z, 0, 0)
    const [sx, sz] = F.sz(width * 1.14, thickness * 2.6)
    n += S(cx, y - 0.16, cz, sx, 0.32, sz, kind, flat)
  }

  for (let i = 0; i < courses; i++) {
    const t = (i + 0.5) / courses
    // Narrows slightly as it falls, and swings across its own normal.
    const w = width * (1 - 0.16 * t)
    const off = Math.sin(phase + t * 3.4) * amp * t
    const [cx, cz] = F.at(x, z, 0, off)
    const [sx, sz] = F.sz(w, thickness)
    n += S(cx, y - 0.32 - each * (i + 0.5), cz, sx, each * 1.02, sz, kind, flat)
  }

  // The torn hem: two tails of different length, so the bottom edge is never a
  // straight line.
  const hemY = y - 0.32 - length
  if (detail >= 1) {
    const offH = Math.sin(phase + 3.4) * amp
    for (const side of [-1, 1]) {
      const drop = each * (0.4 + rand() * 0.9)
      const [cx, cz] = F.at(x, z, side * width * 0.24, offH)
      const [sx, sz] = F.sz(width * 0.40, thickness)
      n += S(cx, hemY - drop / 2, cz, sx, drop, sz, kind, flat)
    }
  }

  if (seam && !ghost && detail >= 1) {
    const key = `banner:${width.toFixed(2)}:${length.toFixed(1)}`
    const plane = F.alongX ? 'xy' : 'zy'
    const side = opts.seamSide ?? 1
    const [ox, oz] = F.at(x, z, 0, side * (thickness / 2 + amp + 0.02))
    addGlow(L, key, colors.cool, seamIntensity,
      () => bannerSeam(width, length),
      planeMatrix(plane, ox, y - 0.32 - length / 2, oz, side, 0))
  }

  return { bottomY: hemY, boxes: n }
}

/** The banner's lit seam: a long thin stroke with rungs, authored in XY. */
function bannerSeam(width, length) {
  const out = { pos: [], idx: [] }
  const w = Math.max(0.05, width * 0.045)
  const h = length / 2
  glyphQuad(out, [-w, -h * 0.92], [w, -h * 0.92], [w, h * 0.92], [-w, h * 0.92])
  const rungs = Math.max(2, Math.round(length / 2.4))
  for (let i = 0; i < rungs; i++) {
    const yy = -h * 0.8 + (h * 1.6 * i) / Math.max(1, rungs - 1)
    const rw = width * (0.14 + 0.10 * (i % 2))
    glyphQuad(out, [-rw, yy - w * 0.7], [rw, yy - w * 0.7], [rw, yy + w * 0.7], [-rw, yy + w * 0.7])
  }
  return glyphGeometry(out)
}

/**
 * voidOrb — a glowing point of light hanging in the void.
 *
 * §5: "every important edge needs a glow behind it — this is a composition rule
 * and it must be designed into the level layout." Until now the only things
 * that could provide that glow were the crystals (which sit ON mass, so they
 * light it from the front rather than backing it) and the beams (four of them,
 * in fixed places). An orb can go anywhere, including BEHIND a ruin at a depth
 * where nothing else exists, which is exactly what §5 is asking for and what
 * makes the far band read as receding rather than as flat.
 *
 * It is also how the frame gets §4.5's "glowing orbs and motes at many depths"
 * as real geometry with real parallax, rather than as a particle sheet.
 *
 * COST: an icosahedron at detail 1 is 80 triangles, and the radius is QUANTISED
 * so orbs bucket together in the glow channel — hundreds of them are one
 * `InstancedMesh` and one draw call. That quantisation is the entire reason
 * this is affordable; do not pass a continuous radius.
 *
 * ONE SUBDIVISION, NOT ZERO, and it was measured rather than assumed. The first
 * cut used a bare icosahedron: twenty facets, each a flat plane of emissive at
 * an intensity above the bloom threshold, which reads at close range as a hard
 * white HEXAGON hanging in the air — a paper cutout, and the single most
 * obviously wrong thing in the capture. Eighty facets plus an intensity that
 * sits just under the clip point gives a round bloomed point of light, which is
 * what §4.5 is asking for. Sixty extra triangles on an object there are six
 * hundred of is four hundredths of the level's budget.
 *
 * No collider, and none is possible to want: it is a light, it is 60 cm across,
 * and there is no orientation in which it could be a landing.
 */
export function voidOrb(L, x, y, z, opts = {}) {
  const { intensity = 1.0, detail = 1 } = opts
  const colors = voidColors(opts, opts.theme || safeTheme())
  const color = opts.color ?? colors.cool
  // Quantised to 5 cm on a small set of sizes. See the cost note above.
  const r = Math.max(0.15, Math.round((opts.radius ?? 0.4) * 20) / 20)
  const sub = detail >= 1 ? 1 : 0
  const placed = addGlow(L, `orb:${r}:${sub}`, color, intensity,
    () => new THREE.IcosahedronGeometry(r, sub),
    new THREE.Matrix4().makeTranslation(x, y, z))
  return { radius: r, placed }
}

// ------------------------------------------------------------------ export

export const VOID_PREFABS = { greatWall, runeSlab, sigilRing, monolith }

/**
 * The dressing kit, kept OUT of `VOID_PREFABS` on purpose.
 *
 * `trackedVoidKit().assertAllPlaced()` exists to catch "prefab written, never
 * imported, eight captures with none of them in frame". That contract is about
 * the four load-bearing prefabs — a course without a great wall is broken.
 * These nine are dressing: a caller that wants arcades but no statues is making
 * a legitimate choice, and folding them into the same assertion would turn a
 * real invariant into a checklist. They are still measured by
 * `voidKitSelfTest()`, which walks both maps.
 */
export const VOID_DRESSING = {
  debrisCloud, brokenArch, ruinSpire, ziggurat, hangingChain, causeway,
  statue, banner, voidOrb,
}

/**
 * A recording facade over VOID_PREFABS, plus the two assertions that close the
 * loop. Mirrors `kit.trackedKit()` deliberately — a course that already knows
 * that pattern gets this one for free.
 *
 * `assertAllPlaced()` catches the failure kit.js's header describes: every
 * prefab written, none imported, eight captures with not one of them in frame,
 * and `npm run build` green throughout. It also FLUSHES the glow layer, which
 * is where the §6 rune check runs — so forgetting to call it is not a way to
 * skip the check, it is a way to have no runes at all.
 */
export function trackedVoidKit() {
  const placed = new Set()
  const api = {}
  let level = null
  for (const [name, fn] of Object.entries(VOID_PREFABS)) {
    api[name] = (...args) => {
      placed.add(name)
      if (args.length && args[0] && typeof args[0] === 'object') level = args[0]
      return fn(...args)
    }
  }
  api.placed = placed
  api.assertAllPlaced = () => {
    const missing = Object.keys(VOID_PREFABS).filter((k) => !placed.has(k))
    if (missing.length) {
      throw new Error(`voidkit prefabs declared but never placed: ${missing.join(', ')}`)
    }
    return level ? finishVoidKit(level) : null
  }
  api.finish = () => (level ? finishVoidKit(level) : null)
  return api
}

/**
 * voidKitSelfTest — build every prefab at every LOD against a throwaway
 * recorder, and report boxes, bounds and TRIANGLES, so the cost claim can be
 * checked from a terminal without a browser.
 *
 * The triangle model is level.js's, not an estimate: a chamfered box is 44
 * triangles (6 inset faces + 12 edge quads + 8 corner tris) and a `bevel: 0`
 * box — which `emit()` forces at `detail: 0` — is 12. Generated meshes are
 * counted exactly, and the glow channel is counted separately because it is a
 * different material and therefore a different budget.
 */
export function voidKitSelfTest(overrides = {}, levels = [0, 1, 2]) {
  const out = {}
  for (const [name, fn] of Object.entries({ ...VOID_PREFABS, ...VOID_DRESSING })) {
    out[name] = {}
    for (const detail of levels) {
      const rec = { solid: 0, decor: 0, boxes: [], meshes: 0, meshTris: 0, glow: 0, glowTris: 0 }
      const push = (cx, cy, cz, sx, sy, sz) => rec.boxes.push([cx, cy, cz, sx, sy, sz])
      const stub = {
        // A minimal Level: no `group`, so the glow layer stays null and is
        // measured through the counting hook below instead.
        solid: (cx, cy, cz, sx, sy, sz, k, o) => {
          rec.solid++
          if (!o || !o.hidden) rec.boxTris = (rec.boxTris || 0) + (o && o.bevel === 0 ? 12 : 44)
          push(cx, cy, cz, sx, sy, sz)
          return stub
        },
        decor: (cx, cy, cz, sx, sy, sz, k, o) => {
          rec.decor++
          if (!o || !o.hidden) rec.boxTris = (rec.boxTris || 0) + (o && o.bevel === 0 ? 12 : 44)
          push(cx, cy, cz, sx, sy, sz)
          return stub
        },
        mesh: (kind, geo, matrix) => {
          rec.meshes++
          rec.meshTris += triangleCount(geo)
          geo.computeBoundingBox()
          const bb = geo.boundingBox.clone().applyMatrix4(matrix)
          push((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2,
            bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z)
          return stub
        },
      }
      // The glow channel needs a group to exist at all; give it a real one so
      // the self-test walks the same branch the game does, and flush it here.
      stub.group = new THREE.Group()
      const ret = fn(stub, 0, 0, 0, { seed: 0xC0FFEE, detail, ...(overrides[name] || {}) })
      const st = stub.__voidGlow
      if (st) {
        for (const b of st.buckets.values()) { rec.glow += b.mats.length; rec.glowTris += b.tris * b.mats.length }
      }
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (const b of rec.boxes) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], b[k] - b[k + 3] / 2)
          max[k] = Math.max(max[k], b[k] + b[k + 3] / 2)
        }
      }
      const r3 = (v) => v.map((q) => Math.round(q * 100) / 100)
      out[name][`detail${detail}`] = {
        solid: rec.solid, decor: rec.decor, meshes: rec.meshes,
        boxTris: rec.boxTris || 0,
        meshTris: Math.round(rec.meshTris),
        surfaceTris: (rec.boxTris || 0) + Math.round(rec.meshTris),
        glyphs: rec.glow, glowTris: rec.glowTris,
        min: r3(min), max: r3(max), size: r3(max.map((q, k) => q - min[k])),
        ret,
      }
    }
  }
  return out
}
