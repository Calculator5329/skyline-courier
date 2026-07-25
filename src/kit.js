/**
 * kit.js — architectural prefabs for the sky-garden archipelago.
 *
 * Everything here is built from exactly two primitives, `L.solid()` and
 * `L.decor()` from `level.js`, so geometry and collision can never drift
 * (CLAUDE.md #2). Nothing in this file imports three, touches the DOM, or
 * calls `Math.random()` — the world is identical on every reload.
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

/**
 * The two emitters, with the `ghost` switch applied once.
 * `S` is solid unless the caller declared the whole prefab unreachable.
 */
function emit(L, opts) {
  const D = (cx, cy, cz, sx, sy, sz, k) => { L.decor(cx, cy, cz, sx, sy, sz, k); return 1 }
  if (opts.ghost) return { S: D, D }
  const S = (cx, cy, cz, sx, sy, sz, k) => { L.solid(cx, cy, cz, sx, sy, sz, k); return 1 }
  return { S, D }
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
 */
function discRects(r, facets = 3, squash = 1) {
  const n = Math.max(1, Math.min(6, facets | 0))
  const R = r / Math.cos((Math.PI / 2) * (0.5 / n))
  const out = []
  for (let i = 0; i < n; i++) {
    const a = (Math.PI / 2) * ((i + 0.5) / n)
    out.push({ hx: R * Math.cos(a), hz: R * squash * Math.sin(a) })
  }
  return out
}

// Vertical tie-break between the rectangles that make up one faceted disc.
//
// Every rect in a disc shares a centre AND a height, so their top faces are
// exactly coplanar and heavily overlapping. Two coplanar surfaces give the
// depth test no winner, and which one survives flips per pixel and per camera
// position — so the ground visibly flickers between materials as you walk.
// (Playtest, Ethan 2026-07-25: "the ground was like switching between green
// and the cobblestone right where you spawn.")
//
// 0.6 mm per rect breaks the tie deterministically. That is comfortably above
// depth-buffer precision at our near/far range, and far below anything a
// player can see or stand on differently — a six-rect stack spans 3 mm,
// against a 1.45 m vault height.
const DISC_EPSILON = 6e-4

/** A faceted disc/drum course. Returns the number of boxes emitted. */
function disc(put, cx, cy, cz, r, h, kind, facets = 3, squash = 1) {
  let n = 0
  let i = 0
  for (const q of discRects(r, facets, squash)) {
    n += put(cx, cy - i * DISC_EPSILON, cz, q.hx * 2, h, q.hz * 2, kind)
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
 * SOLID: the moss cap, the chamfer course, the drum body and every boulder
 * tier — the whole mass. The moss lip overhangs the drum, is at walkable
 * height, and is therefore solid; the footprint of the collision union is
 * pixel-identical to the visible union because they are the same boxes.
 * DECOR: only the optional vine curtain, which hangs below the rim.
 *
 * @returns {{topY:number, radius:number, baseY:number, boxes:number}}
 */
export function drumPlatform(L, x, y, z, opts = {}) {
  const {
    radius = 6, kind = 'stone', capKind = 'moss', detail = 2,
    capThickness = 0.42, bodyDepth = 2.6, tiers = detail === 0 ? 1 : 3,
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
  let n = 0

  // Cap: sits proud of the stone by a lip, top face exactly at y. Thin on
  // purpose — a 40 cm mat overhanging a shadowed rim reads as moss growing
  // over an edge; a 2 m one reads as a green box.
  n += disc(S, x, y - capThickness / 2, z, radius, capThickness, capKind, facets, squash)
  // Chamfer course just under the lip, inset so the cap visibly overhangs it
  // and drops a contact shadow onto the rock. This is what stops the
  // silhouette reading as one extruded slab.
  n += disc(S, x, y - capThickness - 0.26, z, radius * 0.94, 0.55, rimKind, facets, squash)
  // The drum body.
  n += disc(S, x, y - capThickness - 0.53 - bodyDepth / 2, z,
    radius * 0.9, bodyDepth, kind, facets, squash)

  // Boulder underside: descending, progressively inset tiers.
  let ty = y - capThickness - 0.53 - bodyDepth
  let tr = radius * 0.9
  for (let i = 0; i < tiers; i++) {
    const h = 2.2 + rand() * 1.6 + i * 0.5
    tr *= 0.68 + rand() * 0.1
    n += disc(S, x, ty - h / 2, z, tr, h, boulderKind, Math.max(1, facets - 1), squash)
    ty -= h * 0.92
  }

  if (vines) {
    const strands = 3 + ((rand() * 3) | 0)
    for (let i = 0; i < strands; i++) {
      const a = rand() * Math.PI * 2
      const len = 1.6 + rand() * 3.4
      n += D(x + Math.cos(a) * radius * 0.86, y - capThickness - len / 2,
        z + Math.sin(a) * radius * 0.86 * squash, 0.28, len, 0.28, 'moss')
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
    }
    // Springing block: the flared impost the arc launches from.
    const [bx, bz] = F.at(x, z, a, 0)
    const [bsx, bsz] = F.sz(pierWidth * 1.22, depth * 1.12)
    n += S(bx, y + springHeight + 0.22, bz, bsx, 0.44, bsz, kind)
  }

  // Voussoir arc, intrados on the circle of radius R centred at the springing.
  const cy0 = y + springHeight + 0.44
  const arcLen = (Math.PI * R) / segs * 1.3
  for (let i = 0; i < segs; i++) {
    const t = Math.PI * ((i + 0.5) / segs)
    const c = Math.cos(t), s = Math.sin(t)
    const rr = R + vt / 2
    const [cx, cz] = F.at(x, z, -c * rr, 0)
    const [sx, sz] = F.sz(Math.max(vt, Math.abs(s) * arcLen), depth)
    n += S(cx, cy0 + s * rr, cz, sx, Math.max(vt, Math.abs(c) * arcLen), sz, kind)
  }

  const crownY = cy0 + R + vt / 2
  if (keystone) {
    const [kx, kz] = F.at(x, z, 0, 0)
    const [ksx, ksz] = F.sz(vt * 1.4, depth * 1.15)
    n += S(kx, crownY - vt * 0.2, kz, ksx, vt * 1.5, ksz, kind)
    // Brass boss on the keystone — brass is the signature material and should
    // appear at every scale. Overhead ornament, so decor.
    const [bx2, bz2] = F.at(x, z, 0, 0)
    n += D(bx2, crownY + vt * 0.55, bz2, 0.5, 0.5, depth * 1.2, 'brass')
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
    capKind = 'terracotta',
  } = opts
  const F = frame(axis)
  const { S, D } = emit(L, opts)
  const facets = detail >= 2 ? 3 : 1
  const drums = detail >= 2 ? 4 : detail === 1 ? 2 : 1
  const baseFacets = Math.max(1, facets - 1)
  let n = 0

  const shaftTop = y + 0.42 + height
  for (let i = 0; i < count; i++) {
    const a = i * spacing
    const [cx, cz] = F.at(x, z, a, 0)
    // Base: two plinth courses, the lower one wider.
    n += disc(S, cx, y + 0.11, cz, radius * 1.55, 0.22, kind, baseFacets)
    n += disc(S, cx, y + 0.32, cz, radius * 1.3, 0.2, kind, baseFacets)
    // Shaft: stacked drums with a slight entasis so it is not one extrusion.
    for (let d = 0; d < drums; d++) {
      const f = (d + 0.5) / drums
      const rr = radius * (1.02 - 0.13 * f * f)
      n += disc(S, cx, y + 0.42 + height * f, cz, rr, height / drums + 0.02, kind, facets)
    }
    // Capital: flare out again, with a brass collar under it.
    if (detail >= 1) n += disc(D, cx, shaftTop - 0.18, cz, radius * 1.06, 0.16, 'brass', baseFacets)
    n += disc(S, cx, shaftTop + 0.14, cz, radius * 1.35, 0.28, kind, baseFacets)
    n += disc(S, cx, shaftTop + 0.42, cz, radius * 1.62, 0.28, capKind, baseFacets)
  }

  const len = (count - 1) * spacing
  let topY = shaftTop + 0.56
  if (entablature) {
    const [ex, ez] = F.at(x, z, len / 2, 0)
    const [esx, esz] = F.sz(len + radius * 4, radius * 3.4)
    n += S(ex, topY + 0.3, ez, esx, 0.6, esz, kind)
    const [fsx, fsz] = F.sz(len + radius * 4.6, radius * 3.9)
    n += S(ex, topY + 0.78, ez, fsx, 0.36, fsz, capKind)
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
  let n = 0

  // Plinth, in two courses so the edge is chamfered rather than a slab.
  const [px, pz] = F.at(x, z, length / 2, 0)
  let [sx, sz] = F.sz(length, thickness)
  n += S(px, y + plinthHeight * 0.35, pz, sx, plinthHeight * 0.7, sz, kind)
  ;[sx, sz] = F.sz(length, thickness * 0.86)
  n += S(px, y + plinthHeight * 0.85, pz, sx, plinthHeight * 0.3, sz, kind)

  const plinthTopY = y + plinthHeight
  const railY = y + height
  const gap = height - plinthHeight - 0.2

  // Balusters: a turned profile is three stacked boxes (foot, belly, neck).
  const pitch = detail >= 2 ? 0.58 : detail === 1 ? 0.95 : 1.8
  const bw = thickness * 0.42
  for (let a = pitch * 0.6; a < length - pitch * 0.4; a += pitch) {
    const [bx, bz] = F.at(x, z, a, 0)
    if (detail >= 1) {
      n += D(bx, plinthTopY + gap * 0.14, bz, bw, gap * 0.28, bw, kind)
      n += D(bx, plinthTopY + gap * 0.48, bz, bw * 1.5, gap * 0.4, bw * 1.5, kind)
      n += D(bx, plinthTopY + gap * 0.84, bz, bw * 0.8, gap * 0.32, bw * 0.8, kind)
    } else {
      n += D(bx, plinthTopY + gap * 0.5, bz, bw, gap, bw, kind)
    }
  }

  // Top rail: solid, two courses.
  ;[sx, sz] = F.sz(length, thickness * 0.78)
  n += S(px, railY - 0.11, pz, sx, 0.22, sz, kind)
  ;[sx, sz] = F.sz(length, thickness * 0.94)
  n += S(px, railY + 0.05, pz, sx, 0.14, sz, 'terracotta')

  if (posts) {
    for (const a of [0, length]) {
      const [ex, ez] = F.at(x, z, a, 0)
      const [esx, esz] = F.sz(thickness * 1.2, thickness * 1.2)
      n += S(ex, y + (height + 0.24) / 2, ez, esx, height + 0.24, esz, kind)
      const [csx, csz] = F.sz(thickness * 1.5, thickness * 1.5)
      n += S(ex, y + height + 0.34, ez, csx, 0.2, csz, 'terracotta')
      if (detail >= 1) n += D(ex, y + height + 0.58, ez, 0.26, 0.3, 0.26, 'brass')
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
  const put = solidRim ? S : D
  const teeth = opts.teeth ?? (detail >= 2 ? 24 : detail === 1 ? 14 : 8)
  const rimSegs = detail >= 2 ? 26 : detail === 1 ? 16 : 8
  const hubR = radius * 0.22
  let n = 0

  const XY = plane === 'xy', ZY = plane === 'zy'
  const dirs = XY
    ? (c, s) => [c, s, 0]
    : ZY ? (c, s) => [0, s, c] : (c, s) => [c, 0, s]
  const boxAt = (u, v, kk, put_) => put_(x + u[0], y + u[1], z + u[2], v[0], v[1], v[2], kk)
  const flat = (t) => (XY ? [t, t, thickness] : ZY ? [thickness, t, t] : [t, thickness, t])

  // Hub: a faceted boss, deeper than the web so it reads as turned.
  const hd = thickness * 1.9
  for (let i = 0; i < (detail >= 1 ? 3 : 1); i++) {
    const a = (Math.PI / 2) * ((i + 0.5) / (detail >= 1 ? 3 : 1))
    const hx = hubR * Math.cos(a) * 2, hz = hubR * Math.sin(a) * 2
    const size = XY ? [hx, hz, hd] : ZY ? [hd, hz, hx] : [hx, hd, hz]
    boxAt([0, 0, 0], size, kind, put)
  }
  n += detail >= 1 ? 3 : 1

  // Spokes, stepped out from the hub to just inside the rim.
  const rimIn = radius * 0.7
  // Spoke step count drives how a diagonal bar reads. Five boxes over a 2.7 m
  // spoke is a visible staircase at arm's length — these wheels get mounted
  // where the player runs past them, so pay for the extra segments.
  const steps = detail >= 2 ? 9 : detail === 1 ? 5 : 2
  const st = Math.max(0.15, radius * 0.06)
  for (let i = 0; i < spokes; i++) {
    const a = (2 * Math.PI * i) / spokes + Math.PI / spokes
    const c = Math.cos(a), s = Math.sin(a)
    const A = dirs(c * hubR * 0.9, s * hubR * 0.9)
    const B = dirs(c * rimIn, s * rimIn)
    n += strut((cx, cy, cz, bx, by, bz, k) => put(x + cx, y + cy, z + cz, bx, by, bz, k),
      A[0], A[1], A[2], B[0], B[1], B[2], st, steps, kind)
    // Ship's-wheel handle poking past the rim.
    if (detail >= 2 && spokes <= 8) {
      const H = dirs(c * radius * 1.14, s * radius * 1.14)
      boxAt(H, flat(st * 1.1), kind, D)
      n += 1
    }
  }

  // Rim: a continuous web annulus, then teeth standing on it.
  //
  // The web has to be a genuine ring — deep enough radially and dense enough
  // tangentially that its boxes overlap — or the wheel reads as a snowflake:
  // a thin hoop with detached cubes floating around it. Teeth sit at ONE
  // radius rather than alternating in and out, because alternating teeth at a
  // thin web just make the hoop look broken.
  n += ringOfBoxes((cx, cy, cz, bx, by, bz, k) => put(cx, cy, cz, bx, by, bz, k),
    x, y, z, radius * 0.82, radius * 0.28, rimSegs, plane, kind, thickness)
  const tw = Math.max(0.16, (2 * Math.PI * radius) / teeth * 0.45)
  for (let i = 0; i < teeth; i++) {
    const a = (2 * Math.PI * i) / teeth
    const P = dirs(Math.cos(a) * radius, Math.sin(a) * radius)
    boxAt(P, flat(tw), kind, put)
    n += 1
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
  const ring = (r, plane, tt) => ringOfBoxes(
    (cx, cyy, cz, bx, by, bz, k) => D(cx, cyy, cz, bx, by, bz, k),
    x, cy, z, r, tt, segs, plane, kind, tt)

  n += ring(radius, 'xy', t)                 // meridian
  n += ring(radius * 0.99, 'zy', t)          // second meridian
  n += ring(radius * 0.82, 'xz', t * 1.4)    // equator, heavier band
  if (detail >= 1) n += ring(radius * 0.6, 'xz', t)   // inner tropic
  if (detail >= 2) {
    // A tilted band, faked as a squashed horizontal ring lifted off centre —
    // enough to break the perfect concentricity that reads as CAD.
    n += ringOfBoxes((cx, cyy, cz, bx, by, bz, k) => D(cx, cyy, cz, bx, by, bz, k),
      x, cy + radius * 0.34, z, radius * 0.72, t, segs, 'xz', kind, t)
    // Polar axis through the whole assembly.
    n += D(x, cy, z, t, radius * 2.3, t, kind)
  }
  // The little sun at the centre.
  n += D(x, cy, z, radius * 0.2, radius * 0.2, radius * 0.2, 'terracotta')

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
  // Brass string course under the cornice.
  n += disc(D, x, roofY - 0.35, z, radius * 1.03, 0.22, 'brass', facets)
  // Cornice: the dome's landing shelf.
  n += disc(S, x, roofY + 0.22, z, radius * 1.16, 0.44, 'terracotta', facets)

  // Dome: stepped courses on a hemisphere, so the profile is a true curve
  // approximated in stone rather than a cone.
  const domeR = radius * 0.98
  const steps = detail >= 2 ? 6 : detail === 1 ? 4 : 2
  let apex = roofY + 0.44
  for (let i = 0; i < steps; i++) {
    const t0 = (i / steps) * (Math.PI / 2)
    const t1 = ((i + 1) / steps) * (Math.PI / 2)
    const rr = domeR * Math.cos(t0 * 0.94)
    const y0 = roofY + 0.44 + domeR * 0.86 * Math.sin(t0)
    const y1 = roofY + 0.44 + domeR * 0.86 * Math.sin(t1)
    n += disc(S, x, (y0 + y1) / 2, z, rr, Math.max(0.2, y1 - y0), 'terracotta',
      Math.max(1, facets - 1))
    apex = y1
  }

  if (ribs) {
    // Meridian ribs over the dome: overhead ornament, hugging solid courses.
    const count = detail >= 2 ? 8 : 5
    for (let i = 0; i < count; i++) {
      const a = (2 * Math.PI * i) / count
      const c = Math.cos(a), s = Math.sin(a)
      n += strut((cx, cy, cz, bx, by, bz, k) => D(cx, cy, cz, bx, by, bz, k),
        x + c * domeR, roofY + 0.6, z + s * domeR,
        x + c * domeR * 0.12, apex + 0.1, z + s * domeR * 0.12,
        0.2, detail >= 2 ? 5 : 3, 'brass')
    }
    n += ringOfBoxes((cx, cy, cz, bx, by, bz, k) => D(cx, cy, cz, bx, by, bz, k),
      x, roofY + 0.44 + domeR * 0.5, z, domeR * 0.78, 0.16,
      detail >= 2 ? 16 : 10, 'xz', 'brass')
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
    L.decor(x, y + height * 0.06, z, height * 0.055, height * 0.14, height * 0.055, 'terracotta')
    n += 1
  }
  const base = y + height * (trunk ? 0.08 : 0)
  const span = height - (base - y)
  for (let i = 0; i < layers; i++) {
    const f = i / layers
    const h = span / layers
    // Cubic taper: fat and skirted low, needle-thin at the tip.
    const w = height * 0.20 * (1 - f) * (1 - f * 0.45) + height * 0.02
    const jx = (rand() - 0.5) * w * 0.22
    const jz = (rand() - 0.5) * w * 0.22
    L.decor(x + jx, base + h * (i + 0.5), z + jz, w, h * 1.05,
      w * (0.82 + rand() * 0.34), kind)
    n += 1
  }
  // The tip.
  L.decor(x, y + height * 0.99, z, height * 0.03, height * 0.1, height * 0.03, kind)
  n += 1

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

  for (let a = pitch * 0.5; a < length; a += pitch) {
    const len = drop * (0.28 + rand() * 0.72)
    const w = 0.16 + rand() * 0.2
    const [sx, sz] = F.at(x, z, a, (rand() - 0.5) * 0.3)
    L.decor(sx, y - 0.3 - len / 2, sz, w, len, w * 0.8, kind)
    n += 1
    // A leaf clump partway down, on the longer strands only.
    if (detail >= 2 && len > drop * 0.6) {
      L.decor(sx, y - 0.3 - len * 0.55, sz, w * 2.4, len * 0.2, w * 2.0, kind)
      n += 1
    }
    lowest = Math.min(lowest, y - 0.3 - len)
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
    n += S(cx, h - rise / 2 - 0.4, cz, sx, rise + 0.8, sz, kind)
    // Nosing: a slightly proud lip on the front of the tread.
    if (detail >= 1) {
      const [nx, nz] = F.at(x, z, run * i + run * 0.08, 0)
      const [nsx, nsz] = F.sz(run * 0.16, width * 0.99)
      n += S(nx, h - 0.06, nz, nsx, 0.12, nsz, kind)
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
  for (const [name, fn] of Object.entries(PREFABS)) {
    api[name] = (...args) => { placed.add(name); return fn(...args) }
  }
  api.placed = placed
  api.assertAllPlaced = () => {
    const missing = Object.keys(PREFABS).filter((k) => !placed.has(k))
    if (missing.length) {
      throw new Error(`kit prefabs declared but never placed in the course: ${missing.join(', ')}`)
    }
  }
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
      min: r3(min),
      max: r3(max),
      size: r3(max.map((q, k) => q - min[k])),
      ret,
    }
  }
  return out
}
