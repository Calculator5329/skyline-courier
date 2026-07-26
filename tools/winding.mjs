#!/usr/bin/env node
/**
 * Winding audit — which generator emits triangles that face the wrong way?
 *
 *   node tools/winding.mjs [--json] [--all]
 *
 * WHY THIS EXISTS
 *
 * Ethan, playing: "places where the texture is totally invisible and I can see
 * the foliage sticking out of the texture but the whole texture is like glass
 * or invisible." The surface materials are FrontSide, so a triangle whose
 * vertex ORDER disagrees with its own vertex NORMALS is backface-culled:
 * present in the buffer, lit correctly if you ever saw it, and a hole in the
 * world from the side you actually stand on. Forcing DoubleSide used to
 * recover 13.4% of the frame, which is the measure of how bad it was.
 *
 * `propsSelfTest()` audits winding too, but only for the handful of option
 * combinations it happens to build. This runs the REAL course — every prefab,
 * every option the level actually passes — and attributes each flipped
 * triangle to the `kit.js` prefab and `props.js` generator that produced it,
 * by intercepting `Level.mesh()` and reading the call stack.
 *
 * Exits 1 if any flipped triangle survives, so it can gate CI alongside
 * tools/reachability.mjs.
 */

import * as THREE from 'three'
import { Level, buildCourse } from '../src/level.js'
import { CollisionWorld } from '../src/collision.js'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const showAll = argv.includes('--all')

// Same threshold and the same arithmetic as propsSelfTest's winding audit, so
// the two tools can never disagree about what "flipped" means. A real
// inversion scores ~-1.0; the steepest legitimate disagreement measured in
// this library is -0.55, on a smooth-shaded blob facet in a deep crease.
const FLIP_COS = Number(process.env.FLIP_COS ?? -0.7)

/** Flipped-triangle count for one geometry, plus the worst dot seen. */
function auditGeometry(geo) {
  const pos = geo.attributes.position
  const nrm = geo.attributes.normal
  const ix = geo.index
  let flipped = 0, worst = 1, tris = 0
  const n = ix ? ix.count : pos.count
  for (let i = 0; i < n; i += 3) {
    const a = ix ? ix.getX(i) : i
    const b = ix ? ix.getX(i + 1) : i + 1
    const c = ix ? ix.getX(i + 2) : i + 2
    if (a === b || b === c || a === c) continue
    tris++
    const ax = pos.getX(b) - pos.getX(a), ay = pos.getY(b) - pos.getY(a), az = pos.getZ(b) - pos.getZ(a)
    const bx = pos.getX(c) - pos.getX(a), by = pos.getY(c) - pos.getY(a), bz = pos.getZ(c) - pos.getZ(a)
    const gx = ay * bz - az * by, gy = az * bx - ax * bz, gz = ax * by - ay * bx
    const gl = Math.hypot(gx, gy, gz)
    if (gl < 1e-12) continue
    const nx = (nrm.getX(a) + nrm.getX(b) + nrm.getX(c)) / 3
    const ny = (nrm.getY(a) + nrm.getY(b) + nrm.getY(c)) / 3
    const nz = (nrm.getZ(a) + nrm.getZ(b) + nrm.getZ(c)) / 3
    const nl = Math.hypot(nx, ny, nz) || 1
    const d = (gx * nx + gy * ny + gz * nz) / (gl * nl)
    if (d < worst) worst = d
    if (d < FLIP_COS) flipped++
  }
  return { flipped, worst, tris }
}

/**
 * Attribute a `Level.mesh()` call to source. The immediate frames are this
 * tool and level.js, so we walk out to the first kit.js frame — the prefab —
 * and separately report the deepest props.js frame, which is the generator.
 */
function blame() {
  const lines = (new Error().stack || '').split('\n').slice(1)
  let prefab = null, generator = null
  for (const l of lines) {
    const m = /at (?:async )?([\w.$<>]+) \(?(?:.*\/src\/(\w+)\.js):(\d+)/.exec(l)
    if (!m) continue
    const [, fn, file, line] = m
    // The call SITE, not just the function: one prefab makes half a dozen
    // mesh() calls and they come from different generators, so the line number
    // is what actually identifies the geometry. (The generator frame itself is
    // long gone — `lathe()` returned before `mesh()` was called.)
    if (file === 'kit' && !prefab) { prefab = fn; generator = `kit.js:${line}` }
    if (file === 'level' && !prefab) generator = `level.js:${line}`
  }
  return { prefab: prefab || 'level', generator: generator || '-' }
}

// ------------------------------------------------------------------ run it

const rows = new Map()
const origMesh = Level.prototype.mesh
Level.prototype.mesh = function (kind, geo, matrix, opts) {
  const { flipped, worst, tris } = auditGeometry(geo)
  const { prefab, generator } = blame()
  const key = `${prefab}|${generator}|${kind}`
  const r = rows.get(key) || { prefab, generator, kind, calls: 0, tris: 0, flipped: 0, worst: 1 }
  r.calls++; r.tris += tris; r.flipped += flipped
  if (worst < r.worst) r.worst = worst
  rows.set(key, r)
  return origMesh.call(this, kind, geo, matrix, opts)
}

// The box path (`_emit`) writes straight into the batch arrays, so it is
// audited by diffing the batch's index range across the call rather than by
// handing us a geometry. Boxes are supposed to be incapable of this — which is
// exactly why it is worth checking rather than assuming.
const origEmit = Level.prototype._emit
Level.prototype._emit = function (kind, ...rest) {
  const b = this._batches.get(kind)
  const start = b ? b.idx.length : 0
  const r = origEmit.call(this, kind, ...rest)
  const bb = this._batches.get(kind)
  const { flipped, worst, tris } = auditRange(bb, start, bb.idx.length)
  if (tris) {
    const { prefab, generator } = blame()
    const key = `${prefab}|box:${generator}|${kind}`
    const row = rows.get(key) || { prefab, generator: `box:${generator}`, kind, calls: 0, tris: 0, flipped: 0, worst: 1 }
    row.calls++; row.tris += tris; row.flipped += flipped
    if (worst < row.worst) row.worst = worst
    rows.set(key, row)
  }
  return r
}

/** Same audit against a raw batch (flat arrays) over an index range. */
function auditRange(b, from, to) {
  let flipped = 0, worst = 1, tris = 0
  for (let i = from; i < to; i += 3) {
    const a = b.idx[i], c = b.idx[i + 1], d = b.idx[i + 2]
    if (a === c || c === d || a === d) continue
    tris++
    const ax = b.pos[c * 3] - b.pos[a * 3], ay = b.pos[c * 3 + 1] - b.pos[a * 3 + 1], az = b.pos[c * 3 + 2] - b.pos[a * 3 + 2]
    const bx = b.pos[d * 3] - b.pos[a * 3], by = b.pos[d * 3 + 1] - b.pos[a * 3 + 1], bz = b.pos[d * 3 + 2] - b.pos[a * 3 + 2]
    const gx = ay * bz - az * by, gy = az * bx - ax * bz, gz = ax * by - ay * bx
    const gl = Math.hypot(gx, gy, gz)
    if (gl < 1e-12) continue
    const nx = (b.norm[a * 3] + b.norm[c * 3] + b.norm[d * 3]) / 3
    const ny = (b.norm[a * 3 + 1] + b.norm[c * 3 + 1] + b.norm[d * 3 + 1]) / 3
    const nz = (b.norm[a * 3 + 2] + b.norm[c * 3 + 2] + b.norm[d * 3 + 2]) / 3
    const nl = Math.hypot(nx, ny, nz) || 1
    const dot = (gx * nx + gy * ny + gz * nz) / (gl * nl)
    if (dot < worst) worst = dot
    if (dot < FLIP_COS) flipped++
  }
  return { flipped, worst, tris }
}

const collision = new CollisionWorld()
const level = buildCourse(collision)
Level.prototype.mesh = origMesh
Level.prototype._emit = origEmit

// Ground truth: the merged per-kind batches, exactly as `build()` uploads
// them. The per-call attribution above must add up to this, or the tool is
// blaming the wrong thing.
const batches = []
let batchFlipped = 0, batchTris = 0
for (const [kind, b] of level._batches) {
  const { flipped, worst, tris } = auditRange(b, 0, b.idx.length)
  batches.push({ kind, tris, flipped, worst })
  batchFlipped += flipped; batchTris += tris
}

const all = [...rows.values()].sort((a, b) => b.flipped - a.flipped || a.worst - b.worst)
const bad = all.filter((r) => r.flipped > 0)
const totalTris = all.reduce((s, r) => s + r.tris, 0)
const totalFlipped = all.reduce((s, r) => s + r.flipped, 0)

if (asJson) {
  console.log(JSON.stringify({ totalTris, totalFlipped, batchTris, batchFlipped, batches, rows: all }, null, 2))
} else {
  const pad = (s, n) => String(s).padEnd(n)
  const show = showAll ? all : (bad.length ? bad : all.slice(0, 10))
  console.log(pad('prefab', 24), pad('generator', 16), pad('kind', 12), pad('calls', 7), pad('tris', 9), pad('flipped', 9), 'worst dot')
  for (const r of show) {
    console.log(pad(r.prefab, 24), pad(r.generator, 16), pad(r.kind, 12),
      pad(r.calls, 7), pad(r.tris, 9), pad(r.flipped, 9), r.worst.toFixed(3))
  }
  console.log('')
  console.log(pad('surface batch', 24), pad('tris', 9), pad('flipped', 9), 'worst dot')
  for (const b of batches) console.log(pad(b.kind, 24), pad(b.tris, 9), pad(b.flipped, 9), b.worst.toFixed(3))
  console.log(`\nattributed: ${totalFlipped} flipped of ${totalTris} tris`)
  console.log(`merged surface:* meshes: ${batchFlipped} flipped of ${batchTris} tris`)
  console.log(batchFlipped === 0 ? 'PASS — every triangle agrees with its own normals'
    : `FAIL — ${batchFlipped} triangles are backface-culled from the side you see them`)
}

process.exit(batchFlipped === 0 ? 0 : 1)
