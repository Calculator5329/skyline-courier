import * as THREE from 'three'

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

/** Bevelled extrusion of a closed profile — every extruded arris chamfered. */
function extrude(shape, depth, bevel) {
  const b = Math.max(0.004, Math.min(bevel, depth * 0.32))
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: depth - b * 2,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: 0,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 3,
  })
  geo.translate(0, 0, -depth / 2)
  return geo
}

/**
 * A real gear: a toothed outline with a trapezoid tooth profile and a
 * chamfered crown, spoke windows cut as holes, extruded in one piece.
 *
 * This replaces a ring of axis-aligned cubes placed at angles. The review's
 * words were "a jagged pixel-art disc extruded into 3D, and it is the single
 * most amateur read in the set", and it was right: teeth are radial, and
 * approximating them with cubes announces that the engine cannot rotate.
 */
function gearGeometry(radius, thickness, teeth, spokes) {
  const rTip = radius
  const rRoot = radius * 0.845
  const p = (2 * Math.PI) / teeth
  const shape = new THREE.Shape()
  for (let i = 0; i < teeth; i++) {
    const a0 = i * p
    // root · rising flank · tip land · falling flank — a trapezoid tooth, not
    // a square one, so the crown catches the sun along a taper.
    const prof = [[rRoot, 0.0], [rRoot, 0.23], [rTip, 0.35], [rTip, 0.65], [rRoot, 0.77]]
    for (const [r, f] of prof) {
      const a = a0 + p * f
      const x = Math.cos(a) * r, y = Math.sin(a) * r
      if (i === 0 && f === 0.0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    }
  }
  shape.closePath()

  if (spokes >= 3) {
    const rIn = radius * 0.32, rOut = radius * 0.70
    const w = (2 * Math.PI) / spokes
    const gap = w * 0.17           // half the angular width of one spoke
    for (let i = 0; i < spokes; i++) {
      const a0 = i * w + gap, a1 = (i + 1) * w - gap
      const hole = new THREE.Path()
      const STEPS = 5
      for (let k = 0; k <= STEPS; k++) {
        const a = a0 + (a1 - a0) * (k / STEPS)
        const x = Math.cos(a) * rOut, y = Math.sin(a) * rOut
        if (k === 0) hole.moveTo(x, y); else hole.lineTo(x, y)
      }
      for (let k = STEPS; k >= 0; k--) {
        const a = a0 + (a1 - a0) * (k / STEPS)
        hole.lineTo(Math.cos(a) * rIn, Math.sin(a) * rIn)
      }
      hole.closePath()
      shape.holes.push(hole)
    }
  }
  return extrude(shape, thickness, Math.min(0.05, radius * 0.035))
}

/**
 * One voussoir: a trapezoid narrow at the intrados and wide at the extrados,
 * chamfered on every arris. Swept to its own tangent angle by the caller.
 */
function voussoirGeometry(wIn, wOut, radial, depth) {
  const s = new THREE.Shape()
  s.moveTo(-wIn / 2, -radial / 2)
  s.lineTo(wIn / 2, -radial / 2)
  s.lineTo(wOut / 2, radial / 2)
  s.lineTo(-wOut / 2, radial / 2)
  s.closePath()
  return extrude(s, depth, Math.min(0.035, radial * 0.14))
}

/**
 * A lathe from a (radius, height) profile. The honest way to draw anything
 * turned: balusters, finials, column drums, domes.
 */
function latheGeometry(profile, segments) {
  const pts = profile.map(([r, h]) => new THREE.Vector2(Math.max(1e-4, r), h))
  const geo = new THREE.LatheGeometry(pts, segments)
  geo.computeVertexNormals()
  return geo
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
 * THE MOSS LIP — the skirt that hangs off the edge of every island cap.
 *
 * art-direction.md asks for moss caps with "a soft irregular overhanging lip";
 * the review found square notches, because a cap built as a union of
 * concentric rectangles has a stepped outline and nothing hides it.
 *
 * The skirt is a three-ring band swept round the cap. Its top ring hugs the
 * union's ACTUAL stepped boundary, so it is always anchored on stone; its
 * middle ring bulges out to a smoothed radius plus 10–22 cm of noise, which
 * both rounds the notches off and casts the contact shadow that makes the cap
 * read as a mat growing over a rock; its bottom ring tucks back underneath.
 *
 * It is decor, and it overhangs the collider, and that is legal for exactly
 * one reason: its highest point is 2 cm BELOW the walkable surface and it
 * slopes away downwards from there. There is no height at which it presents
 * something to stand on — it is a lip under an edge, not a ledge beside one.
 */
function skirtGeometry(rects, across, squash, drop, rand, segs) {
  const circ = rects.map((q) => ({ hx: q.hx, hz: q.hz / squash }))
  const pos = [], uv = [], idx = []
  for (let i = 0; i <= segs; i++) {
    const th = (2 * Math.PI * i) / segs
    const c = Math.cos(th), s = Math.sin(th)
    const rU = unionRadiusAt(circ, th)
    // 65% of the way from the stepped boundary to the across-flats radius:
    // enough to fill the notches, never so much that the lip leaves the stone.
    const over = 0.10 + rand() * 0.12
    const rB = rU * 0.35 + across * 0.65 + over
    const arc = th * across
    // The bulge sits only 12% of the drop below the cap's top edge. High
    // enough that the SMOOTH outline is what the eye reads from above — which
    // is the whole point, since the stepped one underneath it is what the
    // collider has to be — and still unambiguously under the walking surface.
    const ring = [
      [rU * 0.995, -0.015, 0],
      [rB, -drop * 0.12, 1],
      [rU * 0.88, -drop, 2],
    ]
    for (const [r, h, v] of ring) {
      pos.push(r * c, h, r * s * squash)
      uv.push(arc, v * drop)
    }
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 3, b = (i + 1) * 3
    idx.push(a, b, b + 1, a, b + 1, a + 1)
    idx.push(a + 1, b + 1, b + 2, a + 1, b + 2, a + 2)
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
function disc(put, cx, cy, cz, r, h, kind, facets = 3, squash = 1, o) {
  let n = 0
  let i = 0
  for (const q of discRects(r, facets, squash)) {
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

  // The moss lip. See skirtGeometry for what it is and why it may overhang.
  if (L.mesh && detail >= 1) {
    L.mesh(capKind,
      skirtGeometry(discRects(radius, facets, squash), radius, squash,
        capThickness * 1.25, rand, detail >= 2 ? 28 : 16),
      place(x, y, z, _q.identity()), { shade: 0.97 })
    n += 1
  }

  // Boulder underside: descending, progressively inset tiers.
  let ty = y - capThickness - 0.53 - bodyDepth
  let tr = radius * 0.9
  for (let i = 0; i < tiers; i++) {
    const h = 2.2 + rand() * 1.6 + i * 0.5
    tr *= 0.68 + rand() * 0.1
    n += disc(S, x, ty - h / 2, z, tr, h, boulderKind, Math.max(1, facets - 1), squash)
    // Boulder lumps: rotated, irregular masses hung off each tier so the
    // underside reads as a chunky rounded rock rather than as the hard stepped
    // terrace the review found in crossing.png and chain.png. They are decor,
    // and they are legal because every one of them lives UNDER an overhang
    // wider than itself — nothing here is reachable from above, which is the
    // escape route art-direction.md's collision caveat explicitly grants for
    // island undersides.
    if (detail >= 1) {
      const lumps = detail >= 2 ? 7 : 4
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

  // --- the voussoir arc -------------------------------------------------
  //
  // This used to be axis-aligned boxes stepped along the arc, which gave every
  // arch in the game a notched, sawtooth intrados. Real voussoirs are
  // trapezoids radiating from the arc centre, so that is what these are: the
  // tangential width is computed at the intrados AND at the extrados from the
  // same circle, and each block is swept to its own tangent angle.
  //
  // The collider stays an axis-aligned box — it is the AABB of the rotated
  // wedge, computed exactly, so it always contains what is drawn. An extrados
  // a player mantles onto from a wall-run is still a real ledge; it is just no
  // longer a staircase.
  const cy0 = y + springHeight + 0.44
  const rr = R + vt / 2
  // For a z-spanning arch the wedge's local +X (its tangential axis) has to
  // land on world +Z, which is a -90 degree turn about Y. The sign matters:
  // +90 lands it on -Z and every voussoir tilts the wrong way round the arc.
  const archQuat = axis === 'z'
    ? new THREE.Quaternion().setFromEuler(_e.set(0, -Math.PI / 2, 0))
    : new THREE.Quaternion()
  const wIn = (Math.PI * R) / segs * 1.03
  const wOut = (Math.PI * (R + vt)) / segs * 1.03
  const wMax = Math.max(wIn, wOut)
  for (let i = 0; i < segs; i++) {
    const t = Math.PI * ((i + 0.5) / segs)
    const c = Math.cos(t), s = Math.sin(t)
    // The wedge's radial axis points along (-c, s); tilting the upright block
    // by phi = pi/2 - t about the arch-plane normal puts it there.
    const phi = Math.PI / 2 - t
    const [cx, cz] = F.at(x, z, -c * rr, 0)
    const cyv = cy0 + s * rr
    // Exact AABB of the rotated trapezoid. |cos phi| = |sin t| = s, |sin phi| = |c|.
    const aAlong = wMax * s + vt * Math.abs(c)
    const aUp = wMax * Math.abs(c) + vt * s
    const [sx, sz] = F.sz(aAlong, depth)
    n += S(cx, cyv, cz, sx, aUp, sz, kind, { hidden: !!L.mesh })
    if (L.mesh) {
      const q = archQuat.clone()
        .multiply(new THREE.Quaternion().setFromEuler(_e.set(0, 0, phi)))
      L.mesh(kind, voussoirGeometry(wIn, wOut, vt, depth), place(cx, cyv, cz, q))
    }
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

  // THE WHEEL. One extrusion: toothed rim, chamfered crowns, spoke windows.
  if (L.mesh) {
    L.mesh(kind, gearGeometry(radius, thickness, teeth, detail >= 1 ? spokes : 0),
      place(x, y, z, planeQuat(plane, (radius * 7.3) % 1)), { shade: 1.0 })
    n += 1
    // Hub boss, turned: a stepped cylinder standing proud of the web on both
    // sides. Without it the wheel reads as a flat cut-out.
    const hd = thickness * 1.9
    L.mesh(kind, latheGeometry([
      [0, -hd / 2], [hubR * 1.15, -hd / 2], [hubR * 1.15, -hd * 0.18],
      [hubR * 0.82, -hd * 0.1], [hubR * 0.82, hd * 0.1],
      [hubR * 1.15, hd * 0.18], [hubR * 1.15, hd / 2], [0, hd / 2],
    ], detail >= 2 ? 16 : 10), place(x, y, z, planeQuat(plane, 0)
      .multiply(new THREE.Quaternion().setFromEuler(_e.set(Math.PI / 2, 0, 0)))))
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
  // Brass string course under the cornice.
  n += disc(D, x, roofY - 0.35, z, radius * 1.03, 0.22, 'brass', facets)
  // Cornice: the dome's landing shelf.
  n += disc(S, x, roofY + 0.22, z, radius * 1.16, 0.44, 'terracotta', facets)

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
  if (shell) {
    // The shell is revolved at 0.93 of the stepped courses' half-width across
    // flats. That keeps it inside the collider everywhere except eight narrow
    // slivers at the facet corners, which is the direction art-direction.md
    // explicitly sanctions: "accept a small non-walkable overhang at the
    // corners rather than the reverse".
    const SEG = detail >= 2 ? 12 : 7
    for (let i = 0; i <= SEG; i++) {
      const t = (i / SEG) * (Math.PI / 2)
      shell.push([domeR * Math.cos(t * 0.94) * 0.93, domeR * 0.86 * Math.sin(t)])
    }
    L.mesh('terracotta', latheGeometry(shell, detail >= 2 ? 18 : 10),
      place(x, roofY + 0.44, z, _q.identity()))
    n += 1
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
      min: r3(min),
      max: r3(max),
      size: r3(max.map((q, k) => q - min[k])),
      ret,
    }
  }
  return out
}
