#!/usr/bin/env node
/**
 * Hollow audit — where does a HIDDEN COLLIDER stick out past the mesh drawn
 * in its place?
 *
 *   node tools/hollow.mjs [--json] [--all] [--top N]
 *
 * WHY THIS EXISTS
 *
 * `drumPlatform`'s cap follows `discOutline` — the exact boundary of a faceted
 * RECTANGLE UNION — while the drum body under it was a `lathe`, which is a
 * circle (an ellipse once squashed). An ellipse inscribed in a rectangle
 * touches it at four points; everywhere else the deck overhung nothing and you
 * could see the sky straight up through an island. That was da98a78, and it
 * was found by eye after a playtest, which is exactly the wrong way round.
 *
 * This measures it instead, on the REAL course — every prefab, every option
 * set `level.js` actually passes — the same way `tools/winding.mjs` attributes
 * real course geometry rather than a synthetic sample.
 *
 * METHOD, and what the number means:
 *
 *   1. Intercept `Level.solid`/`Level.decor` and keep every `{hidden: true}`
 *      box. Intercept `Level.mesh` and keep every drawn vertex, in world
 *      space, with its call site (`blame()`, lifted from winding.mjs).
 *   2. Pair them by emission order: a mesh is the replacement for the
 *      contiguous run of hidden boxes immediately before it. That is exactly
 *      how the kit is written — `disc(..., {hidden: curves})` and then the
 *      `L.mesh()` that draws that volume.
 *   3. Sample the collider union's BOUNDARY (rectangle perimeters, minus the
 *      parts swallowed by a sibling rectangle). For each boundary point,
 *      measure the distance IN PLAN to the nearest drawn triangle. A point
 *      over drawn mass scores 0: it is supported.
 *
 * `unsupported` is therefore the honest headline number: how far a player
 * standing on the very edge of the collider is from the nearest thing that is
 * actually DRAWN under them. On the terrace before da98a78 it read 3.9 m,
 * which is the figure that commit quotes.
 *
 * `dropTop` / `dropBot` are the other half of the same class: a partial lathe
 * or a `sweepTube` whose drawn extent is vertically shorter than the collider
 * it hides behind.
 *
 * A gap is only a BUG if a camera can reach a vantage where it shows, so the
 * table also carries the group's world position and the height of the nearest
 * open air under it. Judge with that column, not with the metres alone.
 */

import { Level, buildCourse } from '../src/level.js'
import { CollisionWorld } from '../src/collision.js'
import * as THREE from 'three'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const showAll = argv.includes('--all')
const TOP = Number(argv[argv.indexOf('--top') + 1]) || 20

const PERIM = 160       // boundary samples per collider rectangle

/**
 * Attribute a call to the kit prefab and the CALL SITE inside it.
 *
 * Not simply the deepest `kit.js` frame, the way winding.mjs does it: the box
 * path goes through `emit()`'s `S`/`D` closures and then `disc()`, so the
 * deepest frame is always the same three lines of plumbing and every collider
 * in the file gets blamed on `kit.js:448`. Skipping the plumbing lands on the
 * line in the prefab that actually asked for the volume, which is the thing
 * that has to be paired with the mesh drawn in its place.
 */
const PLUMBING = new Set(['S', 'D', 'put', 'put_', 'disc', 'emit', 'strut', 'ringOfBoxes', 'boxAt'])
function blame() {
  const lines = (new Error().stack || '').split('\n').slice(1)
  const kit = []
  let levelSite = null
  for (const l of lines) {
    const m = /at (?:async )?([\w.$<>]+) \(?(?:.*\/src\/(\w+)\.js):(\d+)/.exec(l)
    if (!m) continue
    const [, fn, file, line] = m
    if (file === 'kit') kit.push({ fn, line })
    else if (file === 'level' && !levelSite) levelSite = `level.js:${line}`
  }
  const hit = kit.find((f) => !PLUMBING.has(f.fn)) || kit[kit.length - 1]
  if (!hit) return { prefab: 'level', site: levelSite || '-' }
  return { prefab: hit.fn, site: `kit.js:${hit.line}` }
}

// --------------------------------------------------------------- record it

const events = []       // ordered log: {kind:'box'|'mesh', ...}
const _v = new THREE.Vector3()

function recordBox(cx, cy, cz, sx, sy, sz, solid) {
  const { prefab, site } = blame()
  events.push({
    kind: 'box', prefab, site, solid,
    cx, cy, cz, hx: sx / 2, hy: sy / 2, hz: sz / 2,
  })
}

function recordMesh(geo, matrix) {
  const { prefab, site } = blame()
  const pos = geo.attributes.position
  const n = pos.count
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(matrix)
    xs[i] = _v.x; ys[i] = _v.y; zs[i] = _v.z
  }
  const idx = geo.index ? Array.from(geo.index.array) : null
  events.push({ kind: 'mesh', prefab, site, xs, ys, zs, n, idx })
}

const origSolid = Level.prototype.solid
const origDecor = Level.prototype.decor
const origMesh = Level.prototype.mesh

Level.prototype.solid = function (cx, cy, cz, sx, sy, sz, kind, opts) {
  if (opts && opts.hidden) recordBox(cx, cy, cz, sx, sy, sz, true)
  return origSolid.call(this, cx, cy, cz, sx, sy, sz, kind, opts)
}
Level.prototype.decor = function (cx, cy, cz, sx, sy, sz, kind, opts) {
  if (opts && opts.hidden) recordBox(cx, cy, cz, sx, sy, sz, false)
  return origDecor.call(this, cx, cy, cz, sx, sy, sz, kind, opts)
}
Level.prototype.mesh = function (kind, geo, matrix, opts) {
  recordMesh(geo, matrix)
  return origMesh.call(this, kind, geo, matrix, opts)
}

const collision = new CollisionWorld()
buildCourse(collision)

Level.prototype.solid = origSolid
Level.prototype.decor = origDecor
Level.prototype.mesh = origMesh

// ----------------------------------------------------------------- pair up
//
// The meshes that replace a contiguous run of hidden boxes are every mesh
// emitted between that run and the next one. ALL of them, not just the first:
// `colonnade` draws its cornice as two separate swept mouldings, one per side
// of the same hidden slab, and scoring against only the first reported 1.45 m
// of missing cornice that is in fact drawn by the second call. The question
// this tool asks is "is anything drawn at the collider's boundary", so the
// answer has to look at everything drawn there.
//
// The FIRST mesh still names the row, because that is the call a reader has to
// go and look at.

const groups = []
let cur = null
for (const e of events) {
  if (e.kind === 'box') {
    if (!cur || cur.meshes.length) cur = { boxes: [], meshes: [] }
    if (!cur.boxes.length) groups.push(cur)
    cur.boxes.push(e)
  } else if (cur && cur.boxes.length) {
    if (!cur.meshes.length) { cur.prefab = e.prefab; cur.site = e.site }
    cur.meshes.push(e)
  }
}
for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].meshes.length) groups.splice(i, 1)

// --------------------------------------------------------------- measure it

/** Is (x, z) inside box b, inflated by `eps`? */
function insideXZ(b, x, z, eps) {
  return Math.abs(x - b.cx) <= b.hx + eps && Math.abs(z - b.cz) <= b.hz + eps
}

/**
 * The drawn mesh's FOOTPRINT: every triangle projected onto XZ, in a uniform
 * grid so a nearest-distance query is local rather than a scan.
 *
 * Projected triangles, not a star polygon of per-azimuth radii. The first cut
 * of this tool used the star polygon and it reported the moss cap — which
 * follows `discOutline` exactly and is provably inside its own collider — as
 * 6.65 m unsupported, because a 60-vertex outline leaves 660 of 720 azimuth
 * bins empty and the "polygon" collapses to the axis in between. A projected
 * triangle either covers a point or it does not; there is nothing to
 * interpolate and nothing to get wrong.
 */
function footprint(meshes) {
  const tri = []
  const triY = []
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const m of meshes) {
  const idx = m.idx
  const n = idx ? idx.length : m.n
  for (let i = 0; i + 2 < n; i += 3) {
    const a = idx ? idx[i] : i, b = idx ? idx[i + 1] : i + 1, c = idx ? idx[i + 2] : i + 2
    const t = [m.xs[a], m.zs[a], m.xs[b], m.zs[b], m.xs[c], m.zs[c]]
    // Degenerate in plan (a vertical wall quad seen from above) still carries
    // its edge, which is what a nearest-distance query needs, so keep it.
    tri.push(t)
    triY.push(Math.max(m.ys[a], m.ys[b], m.ys[c]))
    for (let k = 0; k < 6; k += 2) {
      if (t[k] < minX) minX = t[k]
      if (t[k] > maxX) maxX = t[k]
      if (t[k + 1] < minZ) minZ = t[k + 1]
      if (t[k + 1] > maxZ) maxZ = t[k + 1]
    }
  }
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 1e-3)
  const cells = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(tri.length))))
  const cell = span / cells
  const grid = new Map()
  const key = (i, j) => i * 100003 + j
  for (let t = 0; t < tri.length; t++) {
    const q = tri[t]
    const i0 = Math.floor((Math.min(q[0], q[2], q[4]) - minX) / cell)
    const i1 = Math.floor((Math.max(q[0], q[2], q[4]) - minX) / cell)
    const j0 = Math.floor((Math.min(q[1], q[3], q[5]) - minZ) / cell)
    const j1 = Math.floor((Math.max(q[1], q[3], q[5]) - minZ) / cell)
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j)
        let a = grid.get(k)
        if (!a) grid.set(k, (a = []))
        a.push(t)
      }
    }
  }
  return { tri, triY, grid, cell, minX, minZ, maxX, maxZ, cells: Math.ceil(span / cell) }
}

/** Distance from (px, pz) to a projected triangle; 0 inside it. */
function triDist(q, px, pz) {
  const [ax, az, bx, bz, cx, cz] = q
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz)
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz)
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  if (!(neg && pos)) return 0
  let best = Infinity
  for (let e = 0; e < 3; e++) {
    const ux = q[e * 2], uz = q[e * 2 + 1]
    const vx = q[((e + 1) % 3) * 2], vz = q[((e + 1) % 3) * 2 + 1]
    const ex = vx - ux, ez = vz - uz
    const ll = ex * ex + ez * ez
    let t = ll > 1e-12 ? ((px - ux) * ex + (pz - uz) * ez) / ll : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const d = Math.hypot(px - (ux + ex * t), pz - (uz + ez * t))
    if (d < best) best = d
  }
  return best
}

/**
 * The highest drawn surface at (px, pz) at or below `ceil`, or null.
 *
 * The perimeter measure above answers "is the collider's EDGE drawn". This
 * answers "is its TOP drawn", which is the other way the same mismatch shows:
 * `colonnade`'s cornice slab is a full-width collider with a swept moulding
 * down each side and nothing at all between them, so the player runs along the
 * roof 36 cm above the highest thing they can see.
 */
function topDrawnAt(fp, px, pz, ceil) {
  let best = null
  const ci = Math.floor((px - fp.minX) / fp.cell)
  const cj = Math.floor((pz - fp.minZ) / fp.cell)
  const a = fp.grid.get(ci * 100003 + cj)
  if (!a) return null
  for (const t of a) {
    const q = fp.tri[t]
    if (triDist(q, px, pz) > 0) continue
    const y = fp.triY[t]
    if (y <= ceil + 0.05 && (best === null || y > best)) best = y
  }
  return best
}

/** Nearest drawn surface to (px, pz), in plan. 0 means "there is mass here". */
function distToMesh(fp, px, pz) {
  const ci = Math.floor((px - fp.minX) / fp.cell)
  const cj = Math.floor((pz - fp.minZ) / fp.cell)
  let best = Infinity
  const seen = new Set()
  for (let ring = 0; ring <= fp.cells + 2; ring++) {
    // Everything in this ring is at least (ring-1)*cell away, so once `best`
    // beats that the search is done.
    if (best <= (ring - 1) * fp.cell) break
    for (let i = ci - ring; i <= ci + ring; i++) {
      for (let j = cj - ring; j <= cj + ring; j++) {
        if (ring > 0 && Math.abs(i - ci) !== ring && Math.abs(j - cj) !== ring) continue
        const a = fp.grid.get(i * 100003 + j)
        if (!a) continue
        for (const t of a) {
          if (seen.has(t)) continue
          seen.add(t)
          const d = triDist(fp.tri[t], px, pz)
          if (d < best) best = d
          if (best === 0) return 0
        }
      }
    }
  }
  return best === Infinity ? Math.hypot(px - fp.minX, pz - fp.minZ) : best
}

/**
 * How much clear air is under (px, pz) at height y — the reachability column.
 * A 4 m gap on an island underside a camera can fly under matters; the same
 * gap buried inside solid mass does not.
 */
function airBelow(px, pz, y) {
  let gap = 999
  for (const b of collision.boxes) {
    if (b.min.y > y - 0.02) continue
    if (px < b.min.x || px > b.max.x || pz < b.min.z || pz > b.max.z) continue
    const d = Math.max(0, y - b.max.y)
    if (d < gap) gap = d
  }
  return gap
}

/**
 * How much clear air is ABOVE the unsupported point — the other half of
 * reachability, and the one that separates a real bug from an accounting
 * artefact. A tier collider that reaches 4 m further out than the boulder
 * drawn inside it is buried under the drum above it: no camera and no foot
 * ever meets that surface. The same 4 m on a deck edge with open sky over it
 * is a ledge you stand on and a hole you see through.
 */
function airAbove(px, pz, y) {
  let gap = 999
  for (const b of collision.boxes) {
    if (b.max.y < y + 0.02) continue
    if (px < b.min.x || px > b.max.x || pz < b.min.z || pz > b.max.z) continue
    // A box that straddles this height covers the point outright; one that
    // starts above it covers it after that much clear air. Either way the
    // question is how far a camera has to get before the gap can be seen.
    const d = Math.max(0, b.min.y - y)
    if (d < gap) gap = d
  }
  return gap
}

const rows = []
for (const g of groups) {
  const b = g.boxes, ms = g.meshes, m = ms[0]
  let ax = 0, az = 0
  for (const q of b) { ax += q.cx; az += q.cz }
  ax /= b.length; az /= b.length

  let colTop = -Infinity, colBot = Infinity
  for (const q of b) {
    colTop = Math.max(colTop, q.cy + q.hy)
    colBot = Math.min(colBot, q.cy - q.hy)
  }
  let meshTop = -Infinity, meshBot = Infinity
  for (const q of ms) {
    for (let i = 0; i < q.n; i++) {
      if (q.ys[i] > meshTop) meshTop = q.ys[i]
      if (q.ys[i] < meshBot) meshBot = q.ys[i]
    }
  }

  const fp = footprint(ms)

  // Walk the union's boundary. A perimeter sample that falls strictly inside
  // ANOTHER rectangle of the same union is interior, not boundary.
  let worst = 0, wx = 0, wz = 0
  for (const q of b) {
    for (let i = 0; i < PERIM; i++) {
      const t = (i / PERIM) * 4
      let px, pz
      if (t < 1) { px = q.cx - q.hx + 2 * q.hx * t; pz = q.cz - q.hz }
      else if (t < 2) { px = q.cx + q.hx; pz = q.cz - q.hz + 2 * q.hz * (t - 1) }
      else if (t < 3) { px = q.cx + q.hx - 2 * q.hx * (t - 2); pz = q.cz + q.hz }
      else { px = q.cx - q.hx; pz = q.cz + q.hz - 2 * q.hz * (t - 3) }
      let interior = false
      for (const o of b) {
        if (o === q) continue
        if (insideXZ(o, px, pz, -1e-4)) { interior = true; break }
      }
      if (interior) continue
      const d = distToMesh(fp, px, pz)
      if (d > worst) { worst = d; wx = px; wz = pz }
    }
  }

  // The top face, on a grid. Only the boxes that actually REACH `colTop` have
  // one; a lower course of the same union is buried under its own sibling.
  let roof = 0, rx = 0, rz = 0
  for (const q of b) {
    if (q.cy + q.hy < colTop - 0.01) continue
    // Only a face a player could stand on. A `gearWheel` collider is a plate
    // standing on edge; its "top face" is a 34 cm strip and asking what is
    // drawn under it is meaningless.
    if (q.hy > 2 * Math.min(q.hx, q.hz)) continue
    const nx = Math.min(24, Math.max(2, Math.ceil(q.hx * 2 / 0.3)))
    const nz = Math.min(24, Math.max(2, Math.ceil(q.hz * 2 / 0.3)))
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const px = q.cx - q.hx + (2 * q.hx * i) / nx
        const pz = q.cz - q.hz + (2 * q.hz * j) / nz
        // Covered from above by more of the same prefab's own mass? Then it is
        // not a roof anyone stands on or sees.
        if (airAbove(px, pz, colTop) < 0.05) continue
        const y = topDrawnAt(fp, px, pz, colTop)
        // Against THIS box's own depth, not the group's. An `archway` group is
        // every voussoir in the ring, so the union spans the whole arch and a
        // missing sample would otherwise score the arch's full 4 m height.
        const gap = y === null ? Math.min(2 * q.hy, colTop - colBot) : colTop - y
        if (gap > roof) { roof = gap; rx = px; rz = pz }
      }
    }
  }

  rows.push({
    prefab: g.prefab,
    colliderSite: b[0].site,
    solid: b[0].solid,
    meshSite: g.site,
    x: ax, y: colTop, z: az,
    colTop, colBot, meshTop, meshBot,
    unsupported: worst,
    at: [wx, wz],
    air: worst > 0.02 ? airBelow(wx, wz, colBot) : 0,
    sky: worst > 0.02 ? airAbove(wx, wz, colTop) : 0,
    dropTop: Math.max(0, colTop - meshTop),
    dropBot: Math.max(0, meshBot - colBot),
    roof, roofAt: [rx, rz],
  })
}

// ------------------------------------------------------------- roll it up

const bySite = new Map()
for (const r of rows) {
  const key = `${r.prefab}|${r.colliderSite}>${r.meshSite}`
  const cur = bySite.get(key)
  if (!cur || Math.max(r.unsupported, r.roof) > Math.max(cur.unsupported, cur.roof)) bySite.set(key, { ...r, key, count: 0 })
  bySite.get(key).count = (cur?.count ?? 0) + 1
}
const table = [...bySite.values()].sort((a, b) => Math.max(b.unsupported, b.roof) - Math.max(a.unsupported, a.roof))

if (asJson) {
  console.log(JSON.stringify({ groups: groups.length, table, rows: showAll ? rows : undefined }, null, 2))
} else {
  const pad = (s, n) => String(s).padEnd(n)
  const num = (v, n = 8) => pad(v.toFixed(2), n)
  console.log(pad('prefab', 18), pad('collider', 14), pad('mesh', 14), pad('n', 5), pad('collides', 9),
    pad('unsup', 8), pad('dropTop', 8), pad('dropBot', 8), pad('roofGap', 8), pad('airBelow', 9), pad('skyAbove', 9), 'worst instance (x, y, z)')
  for (const r of (showAll ? table : table.slice(0, TOP))) {
    console.log(pad(r.prefab, 18), pad(r.colliderSite, 14), pad(r.meshSite, 14), pad(r.count, 5), pad(r.solid ? 'yes' : 'DECOR', 9),
      num(r.unsupported), num(r.dropTop), num(r.dropBot), num(r.roof), num(r.air, 9), num(r.sky, 9),
      `(${r.x.toFixed(1)}, ${r.y.toFixed(1)}, ${r.z.toFixed(1)})  edge at (${r.at[0].toFixed(1)}, ${r.at[1].toFixed(1)})`)
  }
  console.log(`\n${groups.length} hidden-collider groups measured, ${table.length} distinct call sites.`)
  const bad = table.filter((r) => r.unsupported > 0.25 || r.dropTop > 0.25 || r.dropBot > 0.25 || r.roof > 0.25)
  console.log(bad.length === 0
    ? 'PASS — every hidden collider is drawn to within 25 cm of its own boundary'
    : `${bad.length} call site(s) over 25 cm — judge each against reachability`)
}
