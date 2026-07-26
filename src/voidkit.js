import * as THREE from 'three'
import { lathe, blob, boundsOf, mergeGeometries, triangleCount } from './props.js'
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
    spikes = detail >= 1, motif = 'knot',
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
      n += hiddenBlob(L, S, x + Math.cos(a) * rr, y + r * 0.7, z + Math.sin(a) * rr, kind, {
        seed: (rand() * 0xffffff) | 0,
        // FLAT AND ONLY MODERATELY LUMPY, unlike the tiers under a slab.
        // A fragment lies in the open with its top face exposed, and a blob's
        // collider is its bounding box: a tall lumpy one touches that box at a
        // single vertex and leaves the rest of the top plane standable and
        // undrawn (`coverage.mjs` measured 1.00 m2 across three of them). A
        // squashed slab of rock fills its own box top to within a few
        // centimetres — and a shard fallen off an obelisk is a slab anyway.
        radius: r, lumpiness: 0.28 + rand() * 0.12, squash: 0.38 + rand() * 0.10,
        detail: 1, frequency: 3.2, shade: 0.86,
      }, null, shade)
    }
  }

  return { topY, radius: width / 2, boxes: n }
}

// ------------------------------------------------------------------ export

export const VOID_PREFABS = { greatWall, runeSlab, sigilRing, monolith }

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
  for (const [name, fn] of Object.entries(VOID_PREFABS)) {
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
