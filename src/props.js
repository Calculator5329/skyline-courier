import * as THREE from 'three'
import { mergeGeometries as mergeThree } from 'three/addons/utils/BufferGeometryUtils.js'

/**
 * props.js — the curved-geometry library.
 *
 * WHY THIS FILE EXISTS (docs/geometry-unlock.md, and the art director's
 * critique of the 2026-07-25 build): every mass in the world was an
 * axis-aligned box, and the only rotation anywhere was about Y — which leaves
 * a cuboid's top and bottom faces horizontal, so a Y-rotated cuboid is still a
 * cuboid. Island undersides read as countable stacks of grey cubes, cornices
 * read as three rectangular slabs whose seams cast no shadow, and no shader
 * fixes either of those. A box lit perfectly is still a box.
 *
 * Everything here returns a plain `THREE.BufferGeometry`:
 *   - indexed, so it merges cheaply and welds instead of exploding
 *   - `position` + `normal` + `uv` + `color` on EVERY generator, so any two
 *     outputs can be merged without an attribute-set mismatch
 *   - `uv` is in METRES of surface arc length, matching `Level.mesh()`, which
 *     multiplies uv by TEX_PER_METRE. Never 0..1.
 *
 * THE COLLISION CONTRACT — read before using any of this:
 * nothing in this file can create a collider, by construction. These
 * geometries are handed to `L.mesh()`, which is visual-only. A curve at a
 * height the player can reach still declares an honest AABB with
 * `L.solid(..., { hidden: true })`, and it is the CALLER's job to keep the
 * drawn curve inside that box. Use `boundsOf()` on the returned geometry to
 * size that collider — the number is measured, not guessed.
 *
 * Inset is fine; overhang is the bug that killed the predecessor project. All
 * the radial generators here (lathe, gear, blob, sweepTube) inscribe their
 * vertices ON the nominal circle, so a polygonal approximation is always
 * inside or equal to the circumscribed box — never outside it.
 *
 * DETERMINISM: no `Math.random()`, at module scope or anywhere else. The only
 * randomness is `makeRand(seed)` / the seeded value noise, both explicit.
 *
 * COST: everything is built once at load. There is no per-frame allocation
 * here because nothing here runs per frame. Triangle budgets are controlled by
 * `detail` (FAR / MID / NEAR) on every generator; `propsSelfTest()` prints the
 * actual counts.
 */

// ------------------------------------------------------------------ tunables

/** Detail bands. FAR is a silhouette, NEAR is the default hero quality. */
export const FAR = 0
export const MID = 1
export const NEAR = 2

/** Same seed line as kit.js, so props keyed off a shared seed stay in step. */
const DEFAULT_SEED = 0x5C0117

const TAU = Math.PI * 2
const EPS = 1e-9

/**
 * The default chamfer, in metres. The critique named unchamfered edges three
 * times: a 90-degree arris has no width, so it catches no highlight and casts
 * no shadow line, and the eye reads "primitive". 3.5 cm is enough to be one to
 * three pixels of gradient at gameplay distance and is invisible as a loss of
 * mass at 1 m scale.
 */
const DEFAULT_BEVEL = 0.035

/** Cosine of the angle past which two adjacent faces get a hard crease. */
const DEFAULT_CREASE = Math.cos((34 * Math.PI) / 180)

/** Pick a value for the current detail band. */
function lod(detail, far, mid, near) {
  const d = detail === undefined || detail === null ? NEAR : Math.max(0, Math.min(2, detail | 0))
  return d === FAR ? far : d === MID ? mid : near
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

// ---------------------------------------------------------------- randomness

/** Deterministic xorshift32 in [0,1). Same seed, same geometry, every reload. */
export function makeRand(seed = DEFAULT_SEED) {
  let s = (seed >>> 0) || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

/** Integer hash -> [0,1). Lattice noise needs a value from coords, not a stream. */
function hash3i(ix, iy, iz, seed) {
  let h = Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b)
  h = Math.imul(h ^ ix, 0x27d4eb2d)
  h = Math.imul(h ^ iy, 0x165667b1)
  h = Math.imul(h ^ iz, 0x1b873593)
  h ^= h >>> 15
  h = Math.imul(h, 0x2545f491)
  h ^= h >>> 13
  return (h >>> 0) / 4294967296
}

/** Quintic fade — C2 continuous, so displaced blobs have no lattice creases. */
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10) }

/** Trilinear value noise in [-1,1]. */
function valueNoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const tx = fade(x - xi), ty = fade(y - yi), tz = fade(z - zi)
  let acc = 0
  for (let k = 0; k < 2; k++) {
    const wz = k ? tz : 1 - tz
    for (let j = 0; j < 2; j++) {
      const wy = (j ? ty : 1 - ty) * wz
      for (let i = 0; i < 2; i++) {
        acc += hash3i(xi + i, yi + j, zi + k, seed) * (i ? tx : 1 - tx) * wy
      }
    }
  }
  return acc * 2 - 1
}

/** Fractal value noise in roughly [-1,1]. Three octaves is plenty for rock. */
function fbm3(x, y, z, seed, octaves = 3, gain = 0.5, lacunarity = 2.03) {
  let sum = 0, amp = 1, norm = 0, f = 1
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise3(x * f, y * f, z * f, (seed + o * 0x9e37) | 0) * amp
    norm += amp
    amp *= gain
    f *= lacunarity
  }
  return sum / norm
}

// ------------------------------------------------------------ mesh assembly

/**
 * A growable vertex/index soup. Build-time only — this allocates freely and
 * is thrown away as soon as `geometry()` has copied it into typed arrays.
 */
class Builder {
  constructor() {
    this.pos = []
    this.nrm = []
    this.uv = []
    this.col = []
    this.idx = []
    this.n = 0
  }

  /** Append one vertex, return its index. Colour defaults to white. */
  vert(x, y, z, nx, ny, nz, u, v, r = 1, g = r, b = r) {
    this.pos.push(x, y, z)
    // Normalising here rather than at every call site: a generator that gets
    // a normal slightly off unit length shades subtly wrong and nobody ever
    // finds it. One sqrt per vertex at load time is free.
    const l = Math.hypot(nx, ny, nz) || 1
    this.nrm.push(nx / l, ny / l, nz / l)
    this.uv.push(u, v)
    this.col.push(r, g, b)
    return this.n++
  }

  tri(a, b, c) { this.idx.push(a, b, c) }

  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d) }

  /**
   * Emit a fresh flat-shaded polygon (3 or 4 points), winding it so its front
   * face points along `n`. Winding bugs are the single most common way a
   * generated mesh comes out inside-out, and they are invisible until a
   * backface-culled render; checking the cross product at build time costs
   * nothing and makes the class of bug impossible.
   */
  face(pts, n, uvs, col) {
    const [p0, p1, p2] = pts
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2]
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2]
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0
    const order = flip
      ? (pts.length === 4 ? [3, 2, 1, 0] : [2, 1, 0])
      : (pts.length === 4 ? [0, 1, 2, 3] : [0, 1, 2])
    const base = this.n
    const c = col || [1, 1, 1]
    for (const i of order) {
      const uv = uvs ? uvs[i] : projectUV(pts[i], n)
      this.vert(pts[i][0], pts[i][1], pts[i][2], n[0], n[1], n[2], uv[0], uv[1], c[0], c[1], c[2])
    }
    if (order.length === 4) this.quad(base, base + 1, base + 2, base + 3)
    else this.tri(base, base + 1, base + 2)
  }

  geometry() {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    // setIndex on a plain array picks Uint16 or Uint32 by itself.
    geo.setIndex(this.idx)
    return geo
  }
}

/**
 * Planar UV in metres for a face with normal `n`: drop the dominant axis.
 * Stone and brass are noise-textured, so a per-face planar projection is
 * indistinguishable from a real unwrap and costs nothing.
 */
function projectUV(p, n) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2])
  if (ax >= ay && ax >= az) return [p[2], p[1]]
  if (ay >= az) return [p[0], p[2]]
  return [p[0], p[1]]
}

// ----------------------------------------------------------- outline solver

/**
 * Turn a polyline into a ribbon of shading bands with creases resolved.
 *
 * This is the shared spine of `lathe`, `extrudeAlong`, `sweepTube` and `gear`.
 * Given 2D points it produces, per band, the two vertices that band shades
 * between: one vertex where the join is smooth (normals averaged, so a fillet
 * or a tube reads round) and two where it is sharp (so an arris stays crisp).
 *
 * Returns:
 *   verts  [{ src, x, y, nx, ny, u }]  u = arc length along the outline
 *   bands  [[vertIndexA, vertIndexB]]  one per non-degenerate segment
 *   miter  per SOURCE point: unit direction + scale to offset the whole
 *          outline outward by a constant width (used for the gear's bevel).
 *          It has to be per source point, not per vertex, or a creased corner
 *          would offset its two copies to two different places and tear.
 */
function resolveOutline(pts, closed, creaseCos = DEFAULT_CREASE) {
  const P = pts.length
  const segs = []
  const count = closed ? P : P - 1
  for (let i = 0; i < count; i++) {
    const a = pts[i], b = pts[(i + 1) % P]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    if (len < 1e-7) continue          // duplicate point: never emit a zero-area band
    segs.push({ i0: i, i1: (i + 1) % P, len, nx: dy / len, ny: -dx / len })
  }
  if (segs.length === 0) throw new Error('props: outline has no non-degenerate segments')

  const S = segs.length
  const verts = []
  const bands = []
  const arcAt = new Array(S + 1)
  let arc = 0
  for (let i = 0; i < S; i++) { arcAt[i] = arc; arc += segs[i].len }
  arcAt[S] = arc

  const smoothWithPrev = (i) => {
    const prev = i === 0 ? (closed ? S - 1 : -1) : i - 1
    if (prev < 0) return false
    // Only a shared corner can be smoothed — a closed outline whose ends do
    // not meet has nothing to average with.
    if (segs[prev].i1 !== segs[i].i0) return false
    return segs[prev].nx * segs[i].nx + segs[prev].ny * segs[i].ny >= creaseCos
  }

  const push = (srcIdx, s, u) => {
    const p = pts[srcIdx]
    verts.push({ src: srcIdx, x: p[0], y: p[1], nx: s.nx, ny: s.ny, u })
    return verts.length - 1
  }

  let prevEnd = -1
  for (let i = 0; i < S; i++) {
    const s = segs[i]
    let a
    if (prevEnd >= 0 && smoothWithPrev(i)) {
      a = prevEnd
      const v = verts[a]
      const nx = v.nx + s.nx, ny = v.ny + s.ny
      const l = Math.hypot(nx, ny) || 1
      v.nx = nx / l; v.ny = ny / l
    } else {
      a = push(s.i0, s, arcAt[i])
    }
    const b = push(s.i1, s, arcAt[i + 1])
    bands.push([a, b])
    prevEnd = b
  }

  // Closed outline: the seam vertex exists twice on purpose (u must run 0..L
  // for the texture) but the two copies share a normal so the shading has no
  // visible seam.
  if (closed && bands.length > 1 && segs[S - 1].i1 === segs[0].i0) {
    const first = verts[bands[0][0]], last = verts[bands[S - 1][1]]
    if (segs[S - 1].nx * segs[0].nx + segs[S - 1].ny * segs[0].ny >= creaseCos) {
      const nx = first.nx + last.nx, ny = first.ny + last.ny
      const l = Math.hypot(nx, ny) || 1
      first.nx = last.nx = nx / l
      first.ny = last.ny = ny / l
    }
  }

  // Miter offsets, per source point, averaged over every segment touching it.
  const miter = new Array(P)
  for (let i = 0; i < P; i++) miter[i] = { x: 0, y: 0, s: 1, max: Infinity }
  for (const s of segs) {
    for (const idx of [s.i0, s.i1]) {
      miter[idx].x += s.nx
      miter[idx].y += s.ny
      // Half the shortest segment meeting here is the furthest this point can
      // be pushed before it walks past its own neighbour and the outline
      // turns inside out. Per-point, so a long flank keeps its full chamfer
      // while a tight tooth root quietly takes a smaller one.
      miter[idx].max = Math.min(miter[idx].max, s.len * 0.5)
    }
  }
  for (let i = 0; i < P; i++) {
    const m = miter[i]
    const l = Math.hypot(m.x, m.y)
    if (l < 1e-6) { m.x = 0; m.y = 0; m.s = 0; m.max = 0; continue }
    m.x /= l; m.y /= l
    // 1/cos(half angle) makes the offset land a constant distance from BOTH
    // edges. Clamped hard at 1.6 (a 76-degree corner): a gear tooth root is
    // sharp enough that an unclamped miter multiplies the bevel by three, and
    // an offset ring that overshoots a neighbouring segment turns inside out —
    // which is exactly what "teeth floating off the hub" looked like.
    m.s = clamp(1 / Math.max(0.34, l / 2), 1, 1.6)
    m.max /= m.s                                  // m.max limits the OFFSET, not the travel
  }

  return { verts, bands, miter, length: arc }
}

// ------------------------------------------------------------------- lathe

/**
 * `lathe(profile, opts)` — the workhorse. Revolve a (radius, height) profile
 * about +Y: column shafts, drums, domes, bells, urns, finials, ring mouldings.
 *
 * `profile` is `[[r, y], ...]` ordered BOTTOM TO TOP. `r` may be 0 at the ends
 * (a dome closes to a point); it may not be negative.
 *
 * opts:
 *   segments     azimuthal facets (default by detail: 8 / 14 / 24)
 *   detail       FAR | MID | NEAR
 *   capTop       close the top disc when the profile ends at r > 0 (default true)
 *   capBottom    same at the bottom (default true)
 *   creaseAngle  radians; profile joins sharper than this get a hard edge.
 *                A turned baluster wants smooth fillets AND crisp rings, and
 *                that is exactly what an angle threshold gives you.
 *   thetaStart / thetaLength  partial revolutions (a half-drum against a wall)
 *   color        [r,g,b] baked into the colour attribute
 *
 * Extent note for the collision contract: vertices lie ON the circle of radius
 * `r`, so the mesh is inscribed in the r-radius box on X and Z at worst, never
 * outside it. Safe to put inside an AABB of 2*rMax.
 */
export function lathe(profile, opts = {}) {
  const pts = normalizeProfile(profile)
  const segments = Math.max(3, opts.segments ?? lod(opts.detail, 8, 14, 24))
  const thetaStart = opts.thetaStart ?? 0
  const thetaLength = opts.thetaLength ?? TAU
  const closedRing = Math.abs(thetaLength - TAU) < 1e-6
  const creaseCos = Math.cos(opts.creaseAngle ?? (34 * Math.PI) / 180)
  const col = opts.color || [1, 1, 1]
  const { verts, bands } = resolveOutline(pts, false, creaseCos)

  const b = new Builder()
  const cols = segments + 1                 // duplicate seam column for UV continuity
  const ringIndex = new Array(verts.length)

  for (let vi = 0; vi < verts.length; vi++) {
    const v = verts[vi]
    const row = new Array(cols)
    for (let c = 0; c < cols; c++) {
      const th = thetaStart + thetaLength * (c / segments)
      const cs = Math.cos(th), sn = Math.sin(th)
      // A profile point at r = 0 is a pole: its normal comes from the profile
      // alone, and every column collapses to the axis.
      const nx = v.nx * cs, nz = v.nx * sn
      row[c] = b.vert(v.x * cs, v.y, v.x * sn, nx, v.ny, nz, th * v.x, v.u, col[0], col[1], col[2])
    }
    ringIndex[vi] = row
  }

  for (const [a, c] of bands) {
    const ra = ringIndex[a], rc = ringIndex[c]
    for (let i = 0; i < segments; i++) {
      // Wound lower vertex, then up the profile, then round in +theta: with
      // the profile running bottom to top that is the OUTWARD face. Getting
      // this backwards is nearly invisible in a preview (you see the inside of
      // the far wall, lit correctly, and it still looks convex) and fatal in
      // game, which is why propsSelfTest audits winding against normals.
      // Degenerate quads at a pole become a single triangle rather than a
      // zero-area pair that computes garbage normals in any later weld.
      const az = verts[a].x < 1e-6, cz = verts[c].x < 1e-6
      if (az && cz) continue
      if (az) b.tri(ra[i], rc[i], rc[i + 1])
      else if (cz) b.tri(ra[i], rc[i], ra[i + 1])
      else b.quad(ra[i], rc[i], rc[i + 1], ra[i + 1])
    }
  }

  const first = pts[0], last = pts[pts.length - 1]
  if ((opts.capBottom ?? true) && first[0] > 1e-6 && closedRing) {
    discCap(b, first[0], first[1], -1, segments, thetaStart, thetaLength, col)
  }
  if ((opts.capTop ?? true) && last[0] > 1e-6 && closedRing) {
    discCap(b, last[0], last[1], 1, segments, thetaStart, thetaLength, col)
  }

  return b.geometry()
}

/** Flat disc closing a lathe end. `dir` is +1 for a top cap, -1 for a bottom. */
function discCap(b, r, y, dir, segments, thetaStart, thetaLength, col) {
  const centre = b.vert(0, y, 0, 0, dir, 0, 0, 0, col[0], col[1], col[2])
  const ring = new Array(segments + 1)
  for (let i = 0; i <= segments; i++) {
    const th = thetaStart + thetaLength * (i / segments)
    const x = Math.cos(th) * r, z = Math.sin(th) * r
    ring[i] = b.vert(x, y, z, 0, dir, 0, x, z, col[0], col[1], col[2])
  }
  for (let i = 0; i < segments; i++) {
    // Increasing theta runs +X toward +Z, which is CLOCKWISE seen from above,
    // so a top cap fans backwards and a bottom cap forwards.
    if (dir > 0) b.tri(centre, ring[i + 1], ring[i])
    else b.tri(centre, ring[i], ring[i + 1])
  }
}

function normalizeProfile(profile) {
  if (!Array.isArray(profile) || profile.length < 2) {
    throw new Error('props.lathe: profile needs at least two [r, y] points')
  }
  const out = []
  for (const p of profile) {
    const r = Array.isArray(p) ? p[0] : p.r
    const y = Array.isArray(p) ? p[1] : p.y
    if (!Number.isFinite(r) || !Number.isFinite(y)) throw new Error('props.lathe: non-finite profile point')
    out.push([Math.max(0, r), y])
  }
  return out
}

// -------------------------------------------------------------- path frames

/** Accept a Curve, an array of Vector3, or an array of [x,y,z]. */
function toPoints(path, samples) {
  if (path && typeof path.getPoints === 'function') {
    return path.getPoints(samples ?? 24).map((v) => [v.x, v.y, v.z])
  }
  if (!Array.isArray(path) || path.length < 2) {
    throw new Error('props: path needs at least two points')
  }
  return path.map((p) => (Array.isArray(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z]))
}

/**
 * Rotation-minimising frames along a polyline.
 *
 * Frenet frames flip at every inflection — a vine swept with them corkscrews
 * for no reason. This carries the previous normal forward through the smallest
 * rotation that takes one tangent to the next, which is what makes a swept
 * tube look like a rope instead of a ribbon.
 *
 * `up` pins the roll of the first frame so the section's +Y lands along it.
 * Without it the starting normal comes off whichever world axis is least
 * parallel to the tangent, which is fine for a round tube and useless for a
 * cornice — an unrolled cornice would project sideways out of the wall.
 */
function frames(points, closed, up) {
  const M = points.length
  const T = [], N = [], B = [], arc = new Array(M)

  for (let i = 0; i < M; i++) {
    let ax, ay, az
    if (closed) {
      const p = points[(i - 1 + M) % M], q = points[(i + 1) % M]
      ax = q[0] - p[0]; ay = q[1] - p[1]; az = q[2] - p[2]
    } else if (i === 0) {
      ax = points[1][0] - points[0][0]; ay = points[1][1] - points[0][1]; az = points[1][2] - points[0][2]
    } else if (i === M - 1) {
      ax = points[M - 1][0] - points[M - 2][0]; ay = points[M - 1][1] - points[M - 2][1]; az = points[M - 1][2] - points[M - 2][2]
    } else {
      const p = points[i - 1], q = points[i + 1]
      ax = q[0] - p[0]; ay = q[1] - p[1]; az = q[2] - p[2]
    }
    const l = Math.hypot(ax, ay, az) || 1
    T.push([ax / l, ay / l, az / l])
  }

  arc[0] = 0
  for (let i = 1; i < M; i++) {
    const p = points[i - 1], q = points[i]
    arc[i] = arc[i - 1] + Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])
  }

  // Seed the first normal. With `up`, solve for the N that puts B along it
  // (B = T x N, so N = up x T). Without, take whichever world axis is least
  // parallel to the tangent, which at least never degenerates.
  const t0 = T[0]
  let seed
  if (up) {
    const c = cross(up, t0)
    seed = Math.hypot(c[0], c[1], c[2]) > 1e-4 ? c : null
  }
  if (!seed) {
    const ax = Math.abs(t0[0]), ay = Math.abs(t0[1]), az = Math.abs(t0[2])
    seed = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  }
  N.push(orthonormal(seed, t0))

  const q = new THREE.Quaternion()
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vn = new THREE.Vector3()
  for (let i = 1; i < M; i++) {
    va.set(T[i - 1][0], T[i - 1][1], T[i - 1][2])
    vb.set(T[i][0], T[i][1], T[i][2])
    q.setFromUnitVectors(va, vb)
    vn.set(N[i - 1][0], N[i - 1][1], N[i - 1][2]).applyQuaternion(q)
    N.push(orthonormal([vn.x, vn.y, vn.z], T[i]))
  }

  // A closed loop generally does not come back to its starting normal. Spread
  // the leftover angle evenly so an orrery ring has no visible join.
  if (closed && M > 2) {
    const drift = signedAngle(N[M - 1], N[0], T[0])
    for (let i = 1; i < M; i++) N[i] = rotateAbout(N[i], T[i], (drift * i) / (M - 1))
  }

  for (let i = 0; i < M; i++) B.push(cross(T[i], N[i]))
  return { T, N, B, arc, length: arc[M - 1] }
}

function orthonormal(v, t) {
  const d = v[0] * t[0] + v[1] * t[1] + v[2] * t[2]
  let x = v[0] - t[0] * d, y = v[1] - t[1] * d, z = v[2] - t[2] * d
  let l = Math.hypot(x, y, z)
  if (l < 1e-6) {
    // Degenerate: pick any perpendicular rather than emitting a NaN frame.
    const alt = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const c = cross(t, alt)
    x = c[0]; y = c[1]; z = c[2]
    l = Math.hypot(x, y, z) || 1
  }
  return [x / l, y / l, z / l]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function signedAngle(a, b, axis) {
  const d = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1)
  const c = cross(a, b)
  const s = c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2]
  return Math.atan2(s, d)
}

function rotateAbout(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang)
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2]
  const cr = cross(axis, v)
  return [
    v[0] * c + cr[0] * s + axis[0] * d * (1 - c),
    v[1] * c + cr[1] * s + axis[1] * d * (1 - c),
    v[2] * c + cr[2] * s + axis[2] * d * (1 - c),
  ]
}

// ------------------------------------------------------------------- sweeps

/**
 * The shared sweep. `outline` is the resolved cross-section, `points` the
 * path. Everything about arch mouldings, cornices, vines, pipes, chains and
 * orrery rings comes out of this one loop.
 */
function sweepResolved(outline, points, opts, closed, srcPts) {
  const { verts, bands } = outline
  const f = frames(points, closed, opts.up)
  const M = points.length
  const cols = closed ? M + 1 : M      // duplicate seam so v runs the full length
  const twist = opts.twist ?? 0
  const scaleFn = makeScaleFn(opts.scaleAlong ?? opts.taper ?? 1)
  const col = opts.color || [1, 1, 1]
  const b = new Builder()
  const total = f.length + (closed ? dist(points[M - 1], points[0]) : 0)

  const rows = new Array(verts.length)
  for (let vi = 0; vi < verts.length; vi++) rows[vi] = new Array(cols)

  for (let c = 0; c < cols; c++) {
    const j = c % M
    // v is arc length in metres (uv is metric everywhere in this file); t is
    // that same distance normalised, and drives twist and taper.
    const v = closed && c === M ? total : f.arc[j]
    const t = total > EPS ? v / total : 0
    const s = scaleFn(t)
    const ang = twist * t
    const ca = Math.cos(ang), sa = Math.sin(ang)
    const T = f.T[j], N = f.N[j], B = f.B[j]
    const P = points[j]
    // Rate of change of scale per metre of path — the taper term below. A cone
    // whose normals ignore the taper shades like a cylinder and looks wrong at
    // exactly the moment the silhouette says it should not.
    const dsds = scaleSlope(scaleFn, t, total || 1)

    for (let vi = 0; vi < verts.length; vi++) {
      const w = verts[vi]
      const x = (w.x * ca - w.y * sa) * s
      const y = (w.x * sa + w.y * ca) * s
      const nx2 = w.nx * ca - w.ny * sa
      const ny2 = w.nx * sa + w.ny * ca
      const support = w.x * w.nx + w.y * w.ny        // profile radius in the normal dir
      const px = P[0] + N[0] * x + B[0] * y
      const py = P[1] + N[1] * x + B[1] * y
      const pz = P[2] + N[2] * x + B[2] * y
      const tn = -support * dsds
      rows[vi][c] = b.vert(
        px, py, pz,
        N[0] * nx2 + B[0] * ny2 + T[0] * tn,
        N[1] * nx2 + B[1] * ny2 + T[1] * tn,
        N[2] * nx2 + B[2] * ny2 + T[2] * tn,
        w.u, v, col[0], col[1], col[2],
      )
    }
  }

  for (const [a, c] of bands) {
    const ra = rows[a], rc = rows[c]
    for (let i = 0; i < cols - 1; i++) b.quad(ra[i], rc[i], rc[i + 1], ra[i + 1])
  }

  if (!closed) {
    if (opts.capStart ?? true) sweepCap(b, srcPts, points[0], f.N[0], f.B[0], f.T[0], scaleFn(0), twist * 0, -1, col)
    if (opts.capEnd ?? true) {
      sweepCap(b, srcPts, points[M - 1], f.N[M - 1], f.B[M - 1], f.T[M - 1], scaleFn(1), twist, 1, col)
    }
  }

  return b.geometry()
}

function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) }

function makeScaleFn(s) {
  if (typeof s === 'function') return s
  if (Array.isArray(s)) return (t) => s[0] + (s[1] - s[0]) * t
  if (typeof s === 'object' && s) {
    const a = s.start ?? 1, z = s.end ?? 1
    return (t) => a + (z - a) * t
  }
  // A bare number means "taper to this multiple by the end".
  return s === 1 ? () => 1 : (t) => 1 + (s - 1) * t
}

function scaleSlope(fn, t, len) {
  const h = 1e-3
  const a = fn(clamp(t - h, 0, 1)), z = fn(clamp(t + h, 0, 1))
  const dt = clamp(t + h, 0, 1) - clamp(t - h, 0, 1)
  return dt > EPS ? (z - a) / (dt * len) : 0
}

/**
 * Close a sweep end. Uses three's earcut so concave cornice profiles cap
 * correctly — a centroid fan would fold itself inside out on an ogee.
 */
function sweepCap(b, srcPts, P, N, B, T, s, ang, dir, col) {
  const contour = srcPts.map((p) => new THREE.Vector2(p[0], p[1]))
  let tris
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, [])
  } catch (e) {
    tris = null
  }
  if (!tris || tris.length === 0) return
  const ca = Math.cos(ang), sa = Math.sin(ang)
  const n = [T[0] * dir, T[1] * dir, T[2] * dir]
  const idx = srcPts.map((p) => {
    const x = (p[0] * ca - p[1] * sa) * s
    const y = (p[0] * sa + p[1] * ca) * s
    return b.vert(
      P[0] + N[0] * x + B[0] * y,
      P[1] + N[1] * x + B[1] * y,
      P[2] + N[2] * x + B[2] * y,
      n[0], n[1], n[2],
      p[0] * s, p[1] * s, col[0], col[1], col[2],
    )
  })
  // triangulateShape returns CCW triples in the shape's own plane; the end cap
  // faces backwards along the tangent, so one of the two flips.
  for (const t3 of tris) {
    if (dir > 0) b.tri(idx[t3[0]], idx[t3[1]], idx[t3[2]])
    else b.tri(idx[t3[2]], idx[t3[1]], idx[t3[0]])
  }
}

/**
 * `extrudeAlong(shape, path, opts)` — run a 2D section along a 3D path.
 *
 * This is the cornice fix. "A stack of three rectangular slabs whose seams are
 * invisible because each seam has no shadow line" happens because a slab has
 * no section; a real cornice is a fillet, a cavetto and a corona swept along
 * the wall, and every one of those steps is a shadow line by construction.
 * Also: arch voussoir mouldings, string courses, balustrade rails, hand rails,
 * pipe runs, brass banding.
 *
 * `shape` is a CLOSED polygon `[[x, y], ...]` in the section plane, wound
 * counter-clockwise (X is the path's normal direction, Y its binormal).
 * `path` is `[[x,y,z], ...]`, an array of Vector3, or any THREE.Curve.
 *
 * opts:
 *   twist        total radians of section rotation across the whole path
 *   scaleAlong   number (end multiplier) | [start, end] | {start, end} | fn(t)
 *   closed       loop the path (a ring cornice); disables the end caps
 *   capStart / capEnd   default true on an open path
 *   creaseAngle  section joins sharper than this stay crisp (default 34 deg)
 *   pathSegments how finely to sample, when `path` is a Curve
 *   up           world direction the section's +Y should follow (default
 *                [0,1,0] — a cornice must stand up, not roll)
 *   detail, color
 */
export function extrudeAlong(shape, path, opts = {}) {
  const srcPts = normalizeShape(shape)
  const pts = toPoints(path, opts.pathSegments ?? lod(opts.detail, 8, 16, 28))
  const closed = !!opts.closed
  const creaseCos = Math.cos(opts.creaseAngle ?? (34 * Math.PI) / 180)
  const outline = resolveOutline(srcPts, true, creaseCos)
  // A moulding wants a predictable roll; a tube does not care, so only this
  // entry point defaults `up`.
  const o = opts.up === undefined ? { ...opts, up: [0, 1, 0] } : opts
  return sweepResolved(outline, pts, o, closed, srcPts)
}

/**
 * `sweepTube(curvePoints, radius, opts)` — a round tube along a path.
 * Vines, hanging ivy runners, brass pipework, chains, orrery rings, cables,
 * tree branches, waterfall spouts.
 *
 * opts:
 *   segments  radial facets (default by detail: 4 / 6 / 10)
 *   taper     end radius multiplier, or fn(t) -> multiplier. 0.15 is a vine
 *             that actually thins out; 1 is a pipe.
 *   closed    loop it (orrery rings, hoops)
 *   capStart / capEnd, twist, detail, color
 */
export function sweepTube(curvePoints, radius = 0.06, opts = {}) {
  const segments = Math.max(3, opts.segments ?? lod(opts.detail, 4, 6, 10))
  const pts = toPoints(curvePoints, opts.pathSegments ?? lod(opts.detail, 8, 16, 28))
  const ring = []
  for (let i = 0; i < segments; i++) {
    const th = (i / segments) * TAU
    ring.push([Math.cos(th) * radius, Math.sin(th) * radius])
  }
  // creaseAngle PI: a tube is round everywhere, so never crease, even at the
  // 60-degree steps of a 6-sided far-LOD ring. That is what lets a 4-sided
  // vine still read as a vine at 200 m.
  const outline = resolveOutline(ring, true, Math.cos(Math.PI))
  return sweepResolved(outline, pts, opts, !!opts.closed, ring)
}

function normalizeShape(shape) {
  if (!Array.isArray(shape) || shape.length < 3) {
    throw new Error('props: shape needs at least three [x, y] points')
  }
  return shape.map((p) => {
    const x = Array.isArray(p) ? p[0] : p.x
    const y = Array.isArray(p) ? p[1] : p.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('props: non-finite shape point')
    return [x, y]
  })
}

// ------------------------------------------------------- section helpers

/** A circle section, for `extrudeAlong` when you want the caps earcut. */
export function circleShape(r = 0.5, segments = 12) {
  const out = []
  for (let i = 0; i < segments; i++) {
    const th = (i / segments) * TAU
    out.push([Math.cos(th) * r, Math.sin(th) * r])
  }
  return out
}

/** A rounded rectangle section — a hand rail, a chamfered string course. */
export function roundedRectShape(w, h, r = 0.04, cornerSegs = 3) {
  const hw = w / 2, hh = h / 2
  const rr = Math.min(r, hw, hh)
  const out = []
  const corners = [[hw - rr, hh - rr, 0], [-hw + rr, hh - rr, Math.PI / 2],
    [-hw + rr, -hh + rr, Math.PI], [hw - rr, -hh + rr, -Math.PI / 2]]
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= cornerSegs; i++) {
      const a = a0 + (Math.PI / 2) * (i / cornerSegs)
      out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr])
    }
  }
  return out
}

/**
 * A classical cornice section: fillet, cavetto (hollow), corona (the flat
 * projecting slab), and a bed moulding under it. Wound CCW, sitting with its
 * back at x = 0 and projecting toward +x.
 *
 * `project` is how far it stands off the wall, `height` how tall it is. Every
 * step in this profile becomes a horizontal shadow line when swept — which is
 * the entire reason a real cornice reads and a stack of slabs does not.
 */
export function corniceShape(project = 0.28, height = 0.34, hollowSegs = 4) {
  const p = project, h = height
  const out = [[0, 0], [p * 0.34, 0], [p * 0.34, h * 0.12], [p * 0.16, h * 0.12]]
  // Cavetto: a quarter hollow from the bed moulding out to the corona.
  for (let i = 0; i <= hollowSegs; i++) {
    const t = i / hollowSegs
    const a = (Math.PI / 2) * t
    out.push([p * 0.16 + p * 0.62 * Math.sin(a), h * 0.12 + h * 0.5 * (1 - Math.cos(a))])
  }
  out.push([p, h * 0.62], [p, h * 0.86], [p * 0.88, h], [0, h])
  return out
}

// -------------------------------------------------------------------- gear

/**
 * `gear(teeth, opts)` — a real gear with involute flanks and a bevelled face.
 *
 * The tooth flank is the involute of a base circle, which is the curve that
 * actual gear teeth use, generated from the pitch radius with a 20-degree
 * pressure angle. Below the base circle the flank runs radial (the standard
 * approximation for the undercut region). The result is a tooth that is wide
 * at the root, narrow at the tip, and curved in between — visibly not a
 * rectangle stuck on a disc.
 *
 * Both faces are chamfered by `bevel`, offset along the outline's own miter
 * normals, so the crown of every tooth catches a highlight down its length.
 *
 * The geometry lies in XY, thickness along Z: face it with the caller's
 * matrix. Origin at the centre.
 *
 * opts:
 *   tipR, rootR   outer and root radii (default 1.0 / 0.84 * tipR)
 *   thickness     along Z (default 0.12)
 *   bevel         face chamfer (default min(0.02, thickness * 0.22))
 *   bore          centre hole radius; 0 for a solid plate (default 0.3 * rootR)
 *   detail, color
 */
export function gear(teeth = 16, opts = {}) {
  const n = Math.max(5, teeth | 0)
  const tipR = opts.tipR ?? 1
  const rootR = opts.rootR ?? tipR * 0.84
  if (!(rootR > 0) || rootR >= tipR) throw new Error('props.gear: need 0 < rootR < tipR')
  const thickness = opts.thickness ?? 0.12
  let bevel = clamp(opts.bevel ?? Math.min(0.02, thickness * 0.22), 0, Math.min(thickness * 0.45, (tipR - rootR) * 0.4))
  const bore = clamp(opts.bore ?? rootR * 0.3, 0, rootR * 0.8)
  const col = opts.color || [1, 1, 1]

  const flankSegs = lod(opts.detail, 1, 2, 4)
  const tipSegs = lod(opts.detail, 1, 1, 2)
  const rootSegs = lod(opts.detail, 1, 2, 2)

  const p = TAU / n
  const rp = (rootR + tipR) / 2                 // pitch circle: mid-tooth
  const rb = rp * Math.cos((20 * Math.PI) / 180) // base circle at 20 deg pressure angle
  const inv = (r) => {
    if (r <= rb) return 0                        // radial below the base circle
    const ta = Math.sqrt((r / rb) * (r / rb) - 1)
    return ta - Math.acos(clamp(rb / r, -1, 1))
  }
  const invP = inv(rp)
  // Half tooth thickness at radius r, in radians. Quarter pitch at the pitch
  // circle is the textbook standard tooth.
  const halfAt = (r) => Math.max(p * 0.035, p * 0.25 + invP - inv(r))
  const hRoot = Math.min(halfAt(rootR), p * 0.45)
  const hTip = halfAt(tipR)

  const outline = []
  const at = (r, a) => outline.push([Math.cos(a) * r, Math.sin(a) * r])
  for (let t = 0; t < n; t++) {
    const c = t * p
    for (let k = 0; k < rootSegs; k++) {         // root arc in, last point owned by the flank
      at(rootR, c - p / 2 + (p / 2 - hRoot) * (k / rootSegs))
    }
    for (let k = 0; k <= flankSegs; k++) {       // rising involute flank
      const r = rootR + (tipR - rootR) * (k / flankSegs)
      at(r, c - Math.min(halfAt(r), hRoot))
    }
    for (let k = 1; k <= tipSegs; k++) at(tipR, c - hTip + 2 * hTip * (k / tipSegs))
    for (let k = 1; k <= flankSegs; k++) {       // falling flank
      const r = tipR - (tipR - rootR) * (k / flankSegs)
      at(r, c + Math.min(halfAt(r), hRoot))
    }
    for (let k = 1; k < rootSegs; k++) {         // root arc out
      at(rootR, c + hRoot + (p / 2 - hRoot) * (k / rootSegs))
    }
  }

  // Crease at 26 degrees: the involute flank is sampled finely enough to shade
  // smooth, while the tooth tip and root corners stay sharp.
  const res = resolveOutline(outline, true, Math.cos((26 * Math.PI) / 180))
  // A face chamfer is an inward offset of the outline, and an offset bigger
  // than the features it is offsetting eats them: that is what "teeth floating
  // off the hub" was. `miter[].max` self-limits it per point, so a coarse
  // 9-tooth gear with an over-large bevel comes out slightly less chamfered
  // rather than shredded.
  const b = new Builder()
  const hz = thickness / 2

  // Four rings: back face (inset by the bevel), back arris, front arris, front
  // face. Three bands between them: back chamfer, flank, front chamfer.
  const ringZ = [-hz, -hz + bevel, hz - bevel, hz]
  const ringOff = [bevel, 0, 0, bevel]
  const s2 = Math.SQRT1_2
  const bandN = [
    (nx, ny) => [nx * s2, ny * s2, -s2],
    (nx, ny) => [nx, ny, 0],
    (nx, ny) => [nx * s2, ny * s2, s2],
  ]

  const emitRing = (ri, nf) => {
    const off = ringOff[ri], z = ringZ[ri]
    return res.verts.map((v) => {
      const m = res.miter[v.src]
      const o = Math.min(off, m.max)
      const x = v.x - m.x * m.s * o
      const y = v.y - m.y * m.s * o
      const nn = nf(v.nx, v.ny)
      return b.vert(x, y, z, nn[0], nn[1], nn[2], v.u, z, col[0], col[1], col[2])
    })
  }

  for (let band = 0; band < 3; band++) {
    if (bevel <= EPS && band !== 1) continue
    const nf = bandN[band]
    const ra = emitRing(band, nf), rb2 = emitRing(band + 1, nf)
    // Round the outline first, then up in +Z: outward for a CCW outline.
    for (const [a, c] of res.bands) b.quad(ra[a], ra[c], rb2[c], rb2[a])
  }

  // Faces. With a bore, an annulus strip; without, a fan from the centre.
  for (const side of [-1, 1]) {
    const ri = side < 0 ? 0 : 3
    const z = ringZ[ri], off = ringOff[ri]
    const outer = res.verts.map((v) => {
      const m = res.miter[v.src]
      const o = Math.min(off, m.max)
      const x = v.x - m.x * m.s * o, y = v.y - m.y * m.s * o
      return b.vert(x, y, z, 0, 0, side, x, y, col[0], col[1], col[2])
    })
    if (bore > EPS) {
      const inner = res.verts.map((v) => {
        const a = Math.atan2(v.y, v.x)
        const x = Math.cos(a) * bore, y = Math.sin(a) * bore
        return b.vert(x, y, z, 0, 0, side, x, y, col[0], col[1], col[2])
      })
      for (const [a, c] of res.bands) {
        if (side > 0) b.quad(outer[a], outer[c], inner[c], inner[a])
        else b.quad(outer[a], inner[a], inner[c], outer[c])
      }
    } else {
      const centre = b.vert(0, 0, z, 0, 0, side, 0, 0, col[0], col[1], col[2])
      for (const [a, c] of res.bands) {
        if (side > 0) b.tri(centre, outer[a], outer[c])
        else b.tri(centre, outer[c], outer[a])
      }
    }
  }

  // Bore wall, so a gear seen edge-on is not a hole through to the skybox.
  if (bore > EPS) {
    const ringSegs = Math.max(8, lod(opts.detail, 8, 12, 20))
    const front = [], back = []
    for (let i = 0; i <= ringSegs; i++) {
      const a = (i / ringSegs) * TAU
      const cx = Math.cos(a), sy = Math.sin(a)
      back.push(b.vert(cx * bore, sy * bore, -hz, -cx, -sy, 0, a * bore, -hz, col[0], col[1], col[2]))
      front.push(b.vert(cx * bore, sy * bore, hz, -cx, -sy, 0, a * bore, hz, col[0], col[1], col[2]))
    }
    for (let i = 0; i < ringSegs; i++) b.quad(back[i], front[i], front[i + 1], back[i + 1])
  }

  return b.geometry()
}

// -------------------------------------------------------------------- blob

const ICO_T = (1 + Math.sqrt(5)) / 2
const ICO_VERTS = [
  [-1, ICO_T, 0], [1, ICO_T, 0], [-1, -ICO_T, 0], [1, -ICO_T, 0],
  [0, -1, ICO_T], [0, 1, ICO_T], [0, -1, -ICO_T], [0, 1, -ICO_T],
  [ICO_T, 0, -1], [ICO_T, 0, 1], [-ICO_T, 0, -1], [-ICO_T, 0, 1],
]
const ICO_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
]

/**
 * `blob(seed, opts)` — the rounded boulder primitive.
 *
 * THIS IS THE ONE THAT REPLACES THE VOXEL ISLAND UNDERSIDES. "Literally
 * countable stacks of grey cubes with hard 90-degree steps" is what a mass
 * built from boxes looks like from below, and no amount of Y rotation helps,
 * because a Y-rotated cuboid still has a horizontal top and bottom.
 *
 * A subdivided icosahedron (welded, so there are no cracks to displace apart)
 * pushed around by seeded fractal value noise. Smooth-shaded: the silhouette
 * does the work, the material does the rest.
 *
 * opts:
 *   radius     mean radius, metres (default 1)
 *   lumpiness  0 is a sphere, 0.35 is a boulder, 0.6 is a shattered crag.
 *              The useful art range is 0.15-0.45; it is hard-clamped at 0.95
 *              because that is where the displaced radius would reach zero.
 *   squash     Y multiplier; 0.6 is a river cobble, 1.6 is a hanging spur
 *   detail     FAR 80 tris / MID 320 / NEAR 1280
 *   frequency  noise cells per unit sphere (default 1.7 — a handful of lobes)
 *   taperY     multiply the radius by (1 + taperY * dirY): negative pinches
 *              the bottom to a point, which is the island-underside shape
 *   color      [r,g,b] base; mottled by a second noise octave so a rock is
 *              not one flat tone before the material even runs
 */
export function blob(seed = DEFAULT_SEED, opts = {}) {
  const radius = opts.radius ?? 1
  // Clamped below 1 on purpose. The displaced radius is
  // radius * (1 + lumpiness * n) * (1 + taperY * dirY) with n and dirY in
  // [-1,1]; keeping both factors strictly positive keeps the surface
  // star-shaped about the origin, which is what makes self-intersection
  // impossible rather than merely unlikely.
  const lumpiness = clamp(opts.lumpiness ?? 0.3, 0, 0.95)
  const squash = opts.squash ?? 1
  const taperY = clamp(opts.taperY ?? 0, -0.95, 0.95)
  const freq = opts.frequency ?? 1.7
  const sub = clamp(opts.subdivisions ?? lod(opts.detail, 1, 2, 3), 0, 4)
  const base = opts.color || [1, 1, 1]
  const mottle = opts.mottle ?? 0.12
  const s = seed | 0

  // Weld by edge-midpoint cache: an unwelded icosahedron (which is what
  // THREE.IcosahedronGeometry gives you) tears open the moment you displace it.
  const verts = ICO_VERTS.map((v) => {
    const l = Math.hypot(v[0], v[1], v[2])
    return [v[0] / l, v[1] / l, v[2] / l]
  })
  let faces = ICO_FACES.map((f) => f.slice())
  const cache = new Map()
  const midpoint = (a, c) => {
    const key = a < c ? a * 65536 + c : c * 65536 + a
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const va = verts[a], vc = verts[c]
    let x = va[0] + vc[0], y = va[1] + vc[1], z = va[2] + vc[2]
    const l = Math.hypot(x, y, z) || 1
    verts.push([x / l, y / l, z / l])
    const idx = verts.length - 1
    cache.set(key, idx)
    return idx
  }
  for (let it = 0; it < sub; it++) {
    const next = []
    for (const [a, c, d] of faces) {
      const ac = midpoint(a, c), cd = midpoint(c, d), da = midpoint(d, a)
      next.push([a, ac, da], [c, cd, ac], [d, da, cd], [ac, cd, da])
    }
    faces = next
  }

  // BAND-LIMIT THE NOISE TO THE MESH. A displacement finer than the vertex
  // spacing cannot be represented: it aliases into speckle and, at high
  // lumpiness, folds triangles through each other. So drop the base frequency
  // and the octave count to whatever this subdivision level can actually
  // carry. The useful side effect is honest LOD — a far boulder is a SMOOTHER
  // version of the same rock, not a different rock, so the silhouette does not
  // jump when it swaps detail band.
  // The BASE frequency is held fixed across detail bands and only the octaves
  // above Nyquist are dropped, so every LOD of one seed is the same rock with
  // less relief — lower the base too and the far LOD becomes a different
  // silhouette, which pops the moment the two are ever seen together.
  const edge = 1.05 / Math.pow(2, sub)     // mean edge of a unit icosphere
  const nyquist = 1 / (2 * edge)
  const f0 = freq
  let octaves = 1
  while (octaves < 3 && f0 * Math.pow(2.03, octaves) <= nyquist) octaves++

  const b = new Builder()
  const displaced = new Array(verts.length)
  for (let i = 0; i < verts.length; i++) {
    const d = verts[i]
    const n = fbm3(d[0] * f0, d[1] * f0, d[2] * f0, s, octaves)
    const r = radius * (1 + lumpiness * n) * (1 + taperY * d[1])
    displaced[i] = [d[0] * r, d[1] * r * squash, d[2] * r]
  }

  for (let i = 0; i < verts.length; i++) {
    const p = displaced[i]
    // Diagonal planar UV in metres. A spherical unwrap would put a pinch at
    // both poles and a seam down one side; a boulder's texture is noise, so a
    // projection with no seam anywhere beats a correct-but-pinched one.
    const u = (p[0] + p[2]) * Math.SQRT1_2
    // Colour mottle may run finer than the geometry — it moves no vertices.
    const m = fbm3(verts[i][0] * freq * 2.6 + 11.5, verts[i][1] * freq * 2.6, verts[i][2] * freq * 2.6, (s ^ 0x5bd1) | 0, 2)
    const k = 1 + mottle * m
    // Normals are filled in after the fact, from the faces.
    b.vert(p[0], p[1], p[2], 0, 1, 0, u, p[1], base[0] * k, base[1] * k, base[2] * k)
  }
  for (const [a, c, d] of faces) b.tri(a, c, d)

  const geo = b.geometry()
  geo.computeVertexNormals()      // smooth, welded, seamless
  return geo
}

// --------------------------------------------------------------- chamferBox

/**
 * `chamferBox(sx, sy, sz, bevel)` — a box with all 12 edges and 8 corners cut.
 *
 * The critique named unchamfered edges three times, and this is the cheapest
 * possible answer: 44 triangles instead of 12, and every horizontal arris
 * grows a 3-5 cm strip at 45 degrees that is a different brightness from both
 * faces it joins. That strip IS the shadow line. It is the difference between
 * a carved stone block and an engine primitive, and it costs nothing.
 *
 * The outer extent is exactly (sx, sy, sz) — the bevel eats inward from the
 * corners, never outward — so this is a drop-in visual for an AABB collider of
 * the same size, with no overhang anywhere. That is the collision contract.
 */
export function chamferBox(sx = 1, sy = 1, sz = 1, bevel = DEFAULT_BEVEL, opts = {}) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2
  const b = clamp(bevel, 0, Math.min(hx, hy, hz) * 0.9)
  if (b <= EPS) return plainBox(sx, sy, sz, opts.color)
  const corners = []
  for (let i = 0; i < 8; i++) {
    corners.push([(i & 4 ? 1 : -1) * hx, (i & 2 ? 1 : -1) * hy, (i & 1 ? 1 : -1) * hz])
  }
  return chamferHex(corners, b, opts.color)
}

/** The unchamfered fallback — 12 triangles, for far scenery where a 3 cm arris is sub-pixel. */
function plainBox(sx, sy, sz, color) {
  const b = new Builder()
  const hx = sx / 2, hy = sy / 2, hz = sz / 2
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let a = 0; a < 3; a++) {
    for (const s of [1, -1]) {
      const n = [axes[a][0] * s, axes[a][1] * s, axes[a][2] * s]
      const u = axes[(a + 1) % 3], v = axes[(a + 2) % 3]
      const h = [hx, hy, hz]
      const pt = (su, sv) => [
        n[0] * h[0] + u[0] * su * h[(a + 1) % 3] + v[0] * sv * h[(a + 2) % 3],
        n[1] * h[1] + u[1] * su * h[(a + 1) % 3] + v[1] * sv * h[(a + 2) % 3],
        n[2] * h[2] + u[2] * su * h[(a + 1) % 3] + v[2] * sv * h[(a + 2) % 3],
      ]
      b.face([pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)], n, null, color)
    }
  }
  return b.geometry()
}

/**
 * Chamfer a general convex hexahedron. Corners are indexed by bit:
 * bit 2 = +X side, bit 1 = +Y side, bit 0 = +Z side.
 *
 * Generalising the chamfer to any hex (not just a cuboid) is what lets `arch`
 * chamfer a radiating wedge, whose faces are not axis-aligned and whose
 * opposite faces are not parallel. Each corner is pulled `bevel` along both of
 * its in-face edge directions, which is the standard chamfer construction and
 * stays valid for any convex hex.
 */
export function chamferHex(corners, bevel = DEFAULT_BEVEL, color) {
  const b = new Builder()
  const C = corners.map((c) => [c[0], c[1], c[2]])
  const centroid = [0, 0, 0]
  for (const c of C) { centroid[0] += c[0] / 8; centroid[1] += c[1] / 8; centroid[2] += c[2] / 8 }

  // Neighbour along axis a (0=x,1=y,2=z) is the corner with that bit flipped.
  const bit = [4, 2, 1]
  const neighbour = (i, a) => i ^ bit[a]

  // Clamp the bevel so it can never exceed a third of the shortest edge —
  // past that the inset points cross and the solid turns inside out.
  let shortest = Infinity
  for (let i = 0; i < 8; i++) {
    for (let a = 0; a < 3; a++) {
      const j = neighbour(i, a)
      if (j > i) shortest = Math.min(shortest, dist(C[i], C[j]))
    }
  }
  const bv = clamp(bevel, 0, shortest / 3)
  if (bv <= EPS) {
    // Degenerate hex or no bevel asked for: emit the six faces flat.
    for (let a = 0; a < 3; a++) {
      for (const s of [0, 1]) {
        const quad = faceCorners(a, s)
        const pts = quad.map((i) => C[i])
        b.face(pts, outwardNormal(pts, centroid), null, color)
      }
    }
    return b.geometry()
  }

  /** inset[i][a] — corner i pulled in on the face perpendicular to axis a. */
  const inset = []
  for (let i = 0; i < 8; i++) {
    inset.push([null, null, null])
    for (let a = 0; a < 3; a++) {
      const p = C[i]
      let x = p[0], y = p[1], z = p[2]
      for (let k = 0; k < 3; k++) {
        if (k === a) continue                    // in-face directions only
        const q = C[neighbour(i, k)]
        const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2]
        const l = Math.hypot(dx, dy, dz) || 1
        x += (dx / l) * bv; y += (dy / l) * bv; z += (dz / l) * bv
      }
      inset[i][a] = [x, y, z]
    }
  }

  // Six faces, inset on both in-face axes.
  for (let a = 0; a < 3; a++) {
    for (const s of [0, 1]) {
      const quad = faceCorners(a, s)
      const pts = quad.map((i) => inset[i][a])
      b.face(pts, outwardNormal(pts, centroid), null, color)
    }
  }

  // Twelve edge chamfers. An edge runs along axis c and is shared by the faces
  // perpendicular to the other two axes.
  for (let c = 0; c < 3; c++) {
    const a = (c + 1) % 3, d = (c + 2) % 3
    for (const sa of [0, 1]) {
      for (const sd of [0, 1]) {
        const i0 = cornerIndex(a, sa, d, sd, c, 0)
        const i1 = cornerIndex(a, sa, d, sd, c, 1)
        const pts = [inset[i0][a], inset[i1][a], inset[i1][d], inset[i0][d]]
        b.face(pts, outwardNormal(pts, centroid), null, color)
      }
    }
  }

  // Eight corner triangles.
  for (let i = 0; i < 8; i++) {
    const pts = [inset[i][0], inset[i][1], inset[i][2]]
    b.face(pts, outwardNormal(pts, centroid), null, color)
  }

  return b.geometry()
}

/** The four corner indices of the face perpendicular to axis `a` on side `s`. */
function faceCorners(a, s) {
  const bit = [4, 2, 1]
  const other = [(a + 1) % 3, (a + 2) % 3]
  const out = []
  for (const [p, q] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    out.push((s ? bit[a] : 0) | (p ? bit[other[0]] : 0) | (q ? bit[other[1]] : 0))
  }
  return out
}

function cornerIndex(a, sa, d, sd, c, sc) {
  const bit = [4, 2, 1]
  return (sa ? bit[a] : 0) | (sd ? bit[d] : 0) | (sc ? bit[c] : 0)
}

/** Face normal from three points, flipped to point away from the solid's centre. */
function outwardNormal(pts, centroid) {
  const [p0, p1, p2] = pts
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2]
  const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2]
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
  const l = Math.hypot(nx, ny, nz) || 1
  nx /= l; ny /= l; nz /= l
  const dx = p0[0] - centroid[0], dy = p0[1] - centroid[1], dz = p0[2] - centroid[2]
  return nx * dx + ny * dy + nz * dz < 0 ? [-nx, -ny, -nz] : [nx, ny, nz]
}

// -------------------------------------------------------------------- arch

/**
 * `arch(span, rise, depth, voussoirs, opts)` — a real radiating arch.
 *
 * Not a staircase, and not a stack of slabs. Every block is a wedge cut on the
 * arch's own radial lines, chamfered on all twelve edges, and separated from
 * its neighbours by a joint gap. Two things follow from that, and they are the
 * whole point:
 *   - the intrados is a smooth curve made of flat facets that all point at the
 *     centre, so the soffit has no sawtooth;
 *   - every joint is a real recess with two chamfers meeting in it, so it
 *     casts a shadow line whatever the sun does. "Seams with no shadow line"
 *     was the named failure of the old stacked-slab cornice.
 *
 * Geometry sits in XY (extruded along Z by `depth`), origin at the CENTRE of
 * the springing line, springing at y = 0.
 *
 * MIND THE EXTENT when sizing the collider: `span` is the clear opening at the
 * INTRADOS, and the ring stands outside it, so a semicircular `arch(3.6, 1.8,
 * 0.9, 11)` measures 4.61 m wide, not 3.6. Always take the number from
 * `boundsOf()` rather than from `span`.
 *
 * `rise` < span/2 gives a segmental arch, = span/2 a semicircle, > span/2 a
 * stilted/horseshoe one. All three come out of the same circle solve.
 *
 * opts:
 *   ringDepth  radial thickness of the voussoir ring (default span * 0.14)
 *   jointGap   mortar joint width in metres (default 0.012)
 *   bevel      per-block chamfer (default 0.03)
 *   keystone   extra extrados on the middle block, as a fraction of ringDepth
 *              (default 0.22; 0 disables). Needs an odd `voussoirs`.
 *   jitter     seeded per-block extrados variation in metres (default 0.012),
 *              so a row of blocks reads as cut by hand rather than by loop
 *   seed
 */
export function arch(span = 4, rise = 2, depth = 0.8, voussoirs = 9, opts = {}) {
  if (!(span > 0) || !(rise > 0)) throw new Error('props.arch: span and rise must be positive')
  const n = Math.max(3, voussoirs | 0)
  const ringDepth = opts.ringDepth ?? Math.max(0.2, Math.min(0.9, span * 0.14))
  const jointGap = opts.jointGap ?? 0.012
  const bevel = opts.bevel ?? 0.03
  const keystone = opts.keystone ?? 0.22
  const jitter = opts.jitter ?? 0.012
  const rand = makeRand(opts.seed ?? DEFAULT_SEED)
  const col = opts.color

  // Circle through (+-span/2, 0) and (0, rise).
  const yc = (rise * rise - (span * span) / 4) / (2 * rise)
  const R = rise - yc
  const a0 = Math.atan2(-yc, span / 2)
  const a1 = Math.PI - a0
  const slice = (a1 - a0) / n
  const halfGap = Math.min(jointGap / 2 / R, slice * 0.3)
  const hz = depth / 2
  const mid = (n - 1) / 2

  const parts = []
  for (let i = 0; i < n; i++) {
    const s0 = a0 + slice * i + halfGap
    const s1 = a0 + slice * (i + 1) - halfGap
    let rOut = R + ringDepth + (rand() - 0.5) * 2 * jitter
    if (keystone > 0 && i === mid) rOut += ringDepth * keystone
    const P = (a, r, z) => [Math.cos(a) * r, yc + Math.sin(a) * r, z]
    // Corner bit order: bit2 = +X (which is the far angular end), bit1 = +Y
    // (the extrados), bit0 = +Z (the front face).
    const corners = []
    for (let k = 0; k < 8; k++) {
      const a = k & 4 ? s1 : s0
      const r = k & 2 ? rOut : R
      const z = k & 1 ? hz : -hz
      corners.push(P(a, r, z))
    }
    parts.push(chamferHex(corners, bevel, col))
  }
  return mergeGeometries(parts, { dispose: true })
}

// ------------------------------------------------------------------- merge

/**
 * Merge a list of geometries into one.
 *
 * three's own `BufferGeometryUtils.mergeGeometries` works fine here (checked:
 * it imports nothing but `three` itself, and resolves through the package's
 * `./addons/*` export in both vite and bare node), so this is a thin wrapper
 * around it rather than a reimplementation. What it adds is the normalisation
 * pass three's version refuses to do for you: it bails on any attribute-set
 * mismatch, and "one geometry in the list has no uv" is otherwise a runtime
 * error at world-build time rather than something you can just fix.
 *
 * opts.dispose frees the inputs afterwards (the level batcher copies vertices
 * out immediately, so holding them is pure waste).
 */
export function mergeGeometries(list, opts = {}) {
  const geos = (list || []).filter(Boolean)
  if (geos.length === 0) return new THREE.BufferGeometry()
  if (geos.length === 1) return geos[0]

  const names = new Set()
  let anyIndexed = false
  for (const g of geos) {
    for (const k of Object.keys(g.attributes)) names.add(k)
    if (g.index) anyIndexed = true
  }

  for (const g of geos) {
    if (names.has('normal') && !g.attributes.normal) g.computeVertexNormals()
    const count = g.attributes.position.count
    if (names.has('uv') && !g.attributes.uv) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2))
    }
    if (names.has('color') && !g.attributes.color) {
      const c = new Float32Array(count * 3).fill(1)
      g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3))
    }
    for (const k of Object.keys(g.attributes)) if (!names.has(k)) g.deleteAttribute(k)
    if (anyIndexed && !g.index) {
      const idx = new Array(count)
      for (let i = 0; i < count; i++) idx[i] = i
      g.setIndex(idx)
    }
  }

  const merged = mergeThree(geos, false)
  if (!merged) throw new Error('props.mergeGeometries: three rejected the list')
  if (opts.dispose) for (const g of geos) g.dispose()
  return merged
}

// ------------------------------------------------------------------ helpers

/**
 * Measured bounds of a geometry, as plain numbers.
 *
 * This is how a caller sizes the `L.solid(..., { hidden: true })` collider that
 * has to sit around a generated mesh: measure it, do not guess it. Guessing is
 * how a visible surface ends up outside its collider, which is the exact bug
 * that killed the predecessor project.
 */
export function boundsOf(geo) {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  return {
    min: [bb.min.x, bb.min.y, bb.min.z],
    max: [bb.max.x, bb.max.y, bb.max.z],
    size: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z],
    centre: [(bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, (bb.max.z + bb.min.z) / 2],
  }
}

/** Triangle count of a geometry, indexed or not. */
export function triangleCount(geo) {
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3
}

// ---------------------------------------------------------------- self test

const r3 = (v) => Math.round(v * 1000) / 1000

/**
 * `propsSelfTest()` — every generator built at representative scale, with its
 * triangle count, bounding box and a validity audit.
 *
 * There is no browser in this loop: `node src/props.js` prints this. It exists
 * so that "is the dome 3 m across or 300?" and "did that gear come out
 * inside-out?" are answerable before anything is placed in the world.
 *
 * Checks per generator: finite positions, unit-length normals, indices in
 * range, no degenerate triangles beyond a small tolerance, and — where the
 * caller declared one — that the measured size matches the nominal size, which
 * is the number the AABB collider will be built from.
 */
export function propsSelfTest() {
  const cases = []

  // `closed` says the case should come out as a sealed solid, which is what
  // makes the signed-volume check meaningful. Default true: everything here is
  // a solid except the deliberately open half-drum.
  const add = (name, make, expect, note, closed = true) => {
    let geo = null, err = null
    try { geo = make() } catch (e) { err = e && e.message ? e.message : String(e) }
    cases.push({ name, geo, expect, note, err, closed })
  }

  add('lathe.columnDrum', () => lathe([
    [0.62, 0], [0.62, 0.10], [0.56, 0.16], [0.56, 1.34], [0.62, 1.40], [0.62, 1.50],
  ]), null, 'a shaft with a torus-less astragal at each end')

  add('lathe.dome', () => {
    const p = []
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * (Math.PI / 2)
      p.push([Math.cos(a) * 2.4, Math.sin(a) * 1.7])
    }
    return lathe(p, { capBottom: true, capTop: false })
  }, [4.8, 1.7, 4.8], '4.8 m observatory dome')

  add('lathe.baluster', () => lathe([
    [0.09, 0], [0.09, 0.05], [0.06, 0.09], [0.13, 0.26], [0.10, 0.44],
    [0.05, 0.56], [0.07, 0.62], [0.07, 0.70],
  ], { detail: MID }), null, 'turned baluster, smooth fillets and crisp rings')

  add('lathe.halfDrum', () => lathe([[0.9, 0], [0.9, 0.4], [0.78, 0.5]], { thetaLength: Math.PI }),
    [1.8, 0.5, 0.9], 'partial revolution, for a drum set into a wall', false)

  add('extrudeAlong.cornice', () => extrudeAlong(
    corniceShape(0.28, 0.34),
    [[-3, 0, 0], [3, 0, 0]],
    { pathSegments: 2 },
  ), null, 'the slab-stack replacement: a real swept section')

  add('extrudeAlong.twistedRail', () => {
    const path = []
    for (let i = 0; i <= 16; i++) {
      const t = i / 16
      path.push([-2 + 4 * t, Math.sin(t * Math.PI) * 0.8, 0])
    }
    return extrudeAlong(roundedRectShape(0.13, 0.09, 0.03), path, { twist: Math.PI * 0.5 })
  }, null, 'hand rail over an arch, twisting')

  add('sweepTube.vine', () => {
    const path = []
    for (let i = 0; i <= 18; i++) {
      const t = i / 18
      path.push([Math.sin(t * 5.1) * 0.28, -t * 3.2, Math.cos(t * 4.3) * 0.24])
    }
    return sweepTube(path, 0.05, { taper: 0.25 })
  }, null, '3.2 m hanging vine, thinning to a quarter')

  add('sweepTube.orreryRing', () => {
    const path = []
    const N = 28
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU
      path.push([Math.cos(a) * 2.2, 0, Math.sin(a) * 2.2])
    }
    return sweepTube(path, 0.055, { closed: true })
  }, [4.51, 0.11, 4.51], 'brass orrery hoop, 4.4 m across')

  add('gear.brass', () => gear(22, { tipR: 1.1, rootR: 0.92, thickness: 0.16 }),
    [2.2, 2.2, 0.16], 'involute teeth, bevelled crown, bored hub')

  add('gear.far', () => gear(14, { tipR: 0.6, rootR: 0.49, thickness: 0.1, detail: FAR }),
    [1.2, 1.2, 0.1], 'same gear at silhouette detail')

  add('gear.coarseFatBevel', () => gear(9, { tipR: 1, rootR: 0.7, thickness: 0.35, bore: 0, bevel: 0.06 }),
    [2, 2, 0.35], 'few teeth + an over-large bevel: the offset must self-limit')

  add('blob.boulder', () => blob(0xB0, { radius: 1.6, lumpiness: 0.32, squash: 0.78 }),
    null, 'island underside lump — replaces a stack of cubes')

  add('blob.islandKeel', () => blob(0x1517, {
    radius: 5.2, lumpiness: 0.26, squash: 1.5, taperY: -0.42, detail: MID,
  }), null, 'the tapering keel under an island')

  add('chamferBox.block', () => chamferBox(1.2, 0.45, 0.9, 0.035), [1.2, 0.45, 0.9],
    'masonry block; extent is exact, so it drops into its own AABB')

  add('arch.gateway', () => arch(3.6, 1.8, 0.9, 11), null,
    'semicircular gateway, 11 voussoirs plus keystone')

  add('arch.segmental', () => arch(5.0, 1.2, 0.7, 13, { ringDepth: 0.5 }), null,
    'shallow segmental arch over a terrace')

  add('merge.mixed', () => mergeGeometries([
    chamferBox(0.4, 0.4, 0.4, 0.03),
    lathe([[0.2, 0], [0.2, 0.5]], { detail: MID }),
  ]), null, 'attribute-compatible merge across two generators')

  const generators = []
  const problems = []
  let totalTriangles = 0

  for (const c of cases) {
    if (c.err) {
      problems.push(`${c.name}: threw — ${c.err}`)
      generators.push({ name: c.name, note: c.note, error: c.err })
      continue
    }
    const geo = c.geo
    const pos = geo.attributes.position
    const nrm = geo.attributes.normal
    const tris = triangleCount(geo)
    totalTriangles += tris

    let badPos = 0, badNrm = 0, badIdx = 0, degenerate = 0, flipped = 0, volume = 0
    for (let i = 0; i < pos.count; i++) {
      if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) badPos++
      const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i))
      if (!Number.isFinite(l) || Math.abs(l - 1) > 0.02) badNrm++
    }
    if (geo.index) {
      const ix = geo.index
      for (let i = 0; i < ix.count; i += 3) {
        const a = ix.getX(i), b2 = ix.getX(i + 1), c2 = ix.getX(i + 2)
        if (a >= pos.count || b2 >= pos.count || c2 >= pos.count) { badIdx++; continue }
        if (a === b2 || b2 === c2 || a === c2) { degenerate++; continue }
        // WINDING AUDIT. A triangle whose vertex order disagrees with its own
        // vertex normals faces the wrong way, and with backface culling on
        // that is a hole in the world. It is also all but invisible in a
        // preview — an inside-out convex solid still shows a lit silhouette —
        // so it has to be checked arithmetically or it does not get checked.
        // (It earned its keep: it found the lathe walls, the lathe end caps
        // and the gear side bands all wound backwards on the first run.)
        //
        // Threshold from measurement, not taste. A real inversion scores
        // -1.0 on essentially every triangle. The steepest legitimate
        // disagreement in this library is -0.55, on a smooth-shaded blob
        // where a facet in a deep crease leans away from its own averaged
        // vertex normals. -0.7 separates the two with room to spare.
        const ax = pos.getX(b2) - pos.getX(a), ay = pos.getY(b2) - pos.getY(a), az = pos.getZ(b2) - pos.getZ(a)
        const bx = pos.getX(c2) - pos.getX(a), by = pos.getY(c2) - pos.getY(a), bz = pos.getZ(c2) - pos.getZ(a)
        const gx = ay * bz - az * by, gy = az * bx - ax * bz, gz = ax * by - ay * bx
        const gl = Math.hypot(gx, gy, gz)
        if (gl < 1e-12) { degenerate++; continue }
        let nx = (nrm.getX(a) + nrm.getX(b2) + nrm.getX(c2)) / 3
        let ny = (nrm.getY(a) + nrm.getY(b2) + nrm.getY(c2)) / 3
        let nz = (nrm.getZ(a) + nrm.getZ(b2) + nrm.getZ(c2)) / 3
        const nl = Math.hypot(nx, ny, nz) || 1
        if ((gx * nx + gy * ny + gz * nz) / (gl * nl) < -0.7) flipped++
        // Signed volume by the divergence theorem. On a closed solid this is
        // positive iff the whole thing is outward-facing — an exact global
        // check that no per-triangle heuristic can give you.
        volume += (pos.getX(a) * (pos.getY(b2) * pos.getZ(c2) - pos.getZ(b2) * pos.getY(c2))
          - pos.getY(a) * (pos.getX(b2) * pos.getZ(c2) - pos.getZ(b2) * pos.getX(c2))
          + pos.getZ(a) * (pos.getX(b2) * pos.getY(c2) - pos.getY(b2) * pos.getX(c2))) / 6
      }
    }

    const bounds = boundsOf(geo)
    const entry = {
      name: c.name,
      note: c.note,
      triangles: tris,
      vertices: pos.count,
      indexed: !!geo.index,
      flipped,
      volume: r3(volume),
      attributes: Object.keys(geo.attributes).sort(),
      size: bounds.size.map(r3),
      min: bounds.min.map(r3),
      max: bounds.max.map(r3),
    }
    generators.push(entry)

    if (badPos) problems.push(`${c.name}: ${badPos} non-finite positions`)
    if (badNrm) problems.push(`${c.name}: ${badNrm} normals not unit length`)
    if (badIdx) problems.push(`${c.name}: ${badIdx} out-of-range indices`)
    if (degenerate) problems.push(`${c.name}: ${degenerate} degenerate triangles`)
    if (flipped) problems.push(`${c.name}: ${flipped}/${tris} triangles wound inside-out`)
    // Only meaningful on a closed solid; an open shell has no enclosed volume.
    if (c.closed && volume <= 0) {
      problems.push(`${c.name}: signed volume ${r3(volume)} — the solid is inside-out`)
    }
    if (!geo.index) problems.push(`${c.name}: not indexed`)
    for (const need of ['position', 'normal', 'uv', 'color']) {
      if (!geo.attributes[need]) problems.push(`${c.name}: missing '${need}' attribute`)
    }
    if (c.expect) {
      for (let a = 0; a < 3; a++) {
        // 1 cm tolerance: a polygonal approximation is inscribed, so it may be
        // a little SMALLER than nominal. Larger would be an overhang bug.
        const d = bounds.size[a] - c.expect[a]
        if (d > 0.01) problems.push(`${c.name}: axis ${a} is ${r3(d)} m LARGER than nominal — overhang risk`)
        else if (d < -0.06) problems.push(`${c.name}: axis ${a} is ${r3(-d)} m smaller than nominal`)
      }
    }
    geo.dispose()
  }

  return { generators, problems, totalTriangles, ok: problems.length === 0 }
}

// Running `node src/props.js` prints the self test. Guarded on `process` so
// the browser bundle never touches it, and importing no node modules so vite
// has nothing to externalise.
if (typeof process !== 'undefined' && Array.isArray(process.argv) &&
    typeof process.argv[1] === 'string' && /props\.js$/.test(process.argv[1])) {
  const t = propsSelfTest()
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('generator', 26), pad('tris', 7), pad('verts', 7), 'size (m)')
  for (const g of t.generators) {
    if (g.error) { console.log(pad(g.name, 26), 'ERROR', g.error); continue }
    console.log(pad(g.name, 26), pad(g.triangles, 7), pad(g.vertices, 7), JSON.stringify(g.size))
  }
  console.log('\ntotal triangles:', t.totalTriangles)
  console.log('problems:', t.problems.length ? '\n  ' + t.problems.join('\n  ') : 'none')
}
