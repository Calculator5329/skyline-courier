#!/usr/bin/env node
/**
 * Reachability / soft-lock checker for the archipelago.
 *
 *   node tools/reachability.mjs [--json] [--out report.json] [--no-build]
 *     [--port 5207] [--cell 0.5] [--min-area 1.0] [--merge-step 0.6]
 *     [--no-occlusion] [--strict-envelope] [--max-technique grapple] [--limit 20]
 *
 *   --max-technique free|climb|double|wallchain|dash|grapple
 *       Ceiling on what the player is assumed to have. `--max-technique double`
 *       is the interesting one: it turns course-design.md's "the safe line must
 *       exist" rule from a warning into a gate.
 *   --strict-envelope
 *       Drop the inferred wall-jump-chain edges and use only the published
 *       envelope. Honest, and it will fail section 6 by design.
 *
 * docs/course-design.md: "Every solid island must be reachable and escapable.
 * An island you can land on but not leave is a soft-lock, and with this much
 * mobility players will find them. Verify reachability mechanically, not by
 * eye." This is that script.
 *
 * WHAT IT DOES
 *
 *   1. Loads the BUILT game headlessly (same pattern as tools/capture.mjs: we
 *      build dist/ and serve it on our own port, so nothing depends on a dev
 *      server that another agent's edit may hot-reload out from under us).
 *   2. Pulls the real collision boxes, grapple anchors, checkpoints, spawn and
 *      finish straight out of `window.__game.level` — no re-parsing of level.js,
 *      so what is checked is what actually ships.
 *   3. Rasterises every box top face into 0.5 m cells, drops the cells that
 *      have no standing headroom (a face with another box sitting on it is not
 *      a floor), and flood-fills the survivors into "landing platforms".
 *   4. Builds a traversal graph using the envelope in docs/course-design.md,
 *      derived from `TUNING` in src/player.js rather than hardcoded, so a
 *      tuning change is caught instead of silently invalidating this tool.
 *   5. Reports unreachable platforms, dead ends, checkpoints that cannot be
 *      linked without dash/grapple, and the critical path.
 *
 * Exits 1 if any platform is unreachable from spawn or is a dead end, so this
 * can gate CI. Exits 2 on a usage error, 1 on a page error.
 *
 * WHAT IT IS NOT
 *
 * A straight-line envelope check. See the HONESTY block printed with every run
 * and `notes` in the JSON — the approximations are stated in the output rather
 * than buried here, because a checker that reports false confidence is worse
 * than no checker.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  REPO, buildDist, launchBrowser, num, openGame, parseArgs, startStaticServer,
} from './harness.mjs'

// ---------------------------------------------------------------- constants

/** Our own port. 5199 belongs to capture.mjs, 5183 to whoever runs `npm run
 *  dev` — sharing either produces a run that silently measures someone else. */
const PORT = 5207

const CELL = 0.5            // raster cell, ~1.5 capsule diameters (radius 0.34)
const MIN_AREA = 1.0        // m² before a surface counts as a landing platform
const MERGE_STEP = 0.6      // height diff two adjacent cells may have and still
                            // be one platform: a kerb, not a jump
const BUCKET = 4.0          // box spatial-index bucket, in metres

/** Height above a surface we shoot the occlusion chord from: chest height, so
 *  the ray does not graze the very face it is standing on. */
const CHORD_LIFT = 0.9
/** Metres trimmed off each end of an occlusion segment, same reason. */
const CHORD_TRIM = 0.45
/** Boxes are shrunk by this before the slab test, so two coplanar surfaces
 *  (every deck built by `massif`) do not register as a wall. */
const BOX_SHRINK = 0.06

/** Horizontal gap inside which a vertical wall-run is available: you have to
 *  be AT the wall to run up it. */
const CLIMB_GAP = 2.5
/** Height a vertical wall-run adds on top of the entry jump (course-design.md
 *  vertical-reach table: "~3.1 m on top of entry height"). */
const WALLRUN_CLIMB = 3.1

/** Longest airtime we will credit a fall with. Past ~4 s the fall is under
 *  `terminalFall` and our constant-gravity range starts to over-promise; it
 *  also means nothing in a course whose kill plane is at y=-32. */
const MAX_AIRTIME = 4.0

/**
 * The dash band from docs/course-design.md: ~19 m against the double jump's
 * ~13.7 m. Expressed as a ratio rather than an absolute so it scales with the
 * jump numbers, and kept as a calibration constant rather than derived because
 * the dash's real reach depends on `vel.y *= 0.82` hang time and on the fact
 * that air has no friction so the 21 m/s burst is *kept* after `dashTime` —
 * neither of which is a closed form. If you change `dashSpeed`/`dashTime`,
 * re-measure the band in game and update the doc and this number together.
 */
const DASH_GAIN = 19 / 13.7

/**
 * Wall-jump chain — the one technique in course-design.md's vertical table that
 * a point-to-point envelope cannot express ("~2.4 m per jump, unbounded while
 * walls alternate"). Section 6 of the course is built entirely out of it, so a
 * checker without it reports the chain pillars as grapple-gated, which is a
 * lie about a section whose whole point is that you climb it by hand.
 *
 * It is legitimately unbounded in this controller: a wall jump refunds 0.6 s of
 * `wallRunTime` and `wallRegrabCooldown` is only 0.22 s, so one tall face is
 * enough to keep climbing. The inference is therefore "is there a runnable face
 * alongside the whole climb", not "are there two alternating faces".
 *
 * This is the COARSEST thing in this file. Every edge it creates is counted
 * separately and every checkpoint link that leans on one is flagged, so it can
 * never quietly prop up a PASS. `--strict-envelope` turns it off.
 */
const WALLCHAIN_SPAN = 8.0      // horizontal gap a chain covers; the move is vertical
const WALL_REACH = 3.2          // how far off the climb line a usable face may sit
const WALLCHAIN_SAMPLE = 1.5    // vertical sampling interval, metres
const WALLCHAIN_COVER = 0.8     // fraction of sampled heights that need a face
const WALLCHAIN_MAX_RISE = 24   // sanity cap: past this it is a tower, not a climb

/** Tier ordering. "Without dash or grapple" (course-design.md's rule for the
 *  checkpoint chain) means tier <= 1. */
const TIER = { free: 0, climb: 0, double: 1, wallchain: 1, dash: 2, grapple: 3 }
const MODES = ['free', 'climb', 'double', 'wallchain', 'dash', 'grapple']

const MAX_SAMPLES = 48      // sample points per platform used for gap search

// -------------------------------------------------------------- tuning read

/**
 * Read the movement constants out of src/player.js.
 *
 * Deliberately from source rather than baked in: docs/course-design.md says
 * "If you change a tuning constant, recompute this table, because the whole
 * course is built against it." A checker carrying its own stale copy of the
 * envelope would keep passing while the course quietly stopped matching it.
 */
async function readTuning() {
  const src = await readFile(resolve(REPO, 'src/player.js'), 'utf8')
  const want = [
    'gravity', 'jumpSpeed', 'airJumpSpeed', 'sprintSpeed', 'dashSpeed',
    'dashTime', 'grappleRange', 'grappleMinRange', 'climbSpeed', 'climbTime',
    'standHeight', 'radius', 'airJumps',
  ]
  const T = {}
  for (const k of want) {
    const m = src.match(new RegExp(`^\\s*${k}:\\s*(-?[0-9.]+)\\s*,`, 'm'))
    if (!m) throw new Error(`could not read TUNING.${k} from src/player.js`)
    T[k] = parseFloat(m[1])
  }
  return T
}

// ----------------------------------------------------------- flight envelope

/**
 * Airtime of a single jump that ends `dy` metres above the launch height.
 * Negative for an unreachable rise.
 */
function tFree(T, dy) {
  const disc = T.jumpSpeed * T.jumpSpeed - 2 * T.gravity * dy
  if (disc < 0) return -1
  return (T.jumpSpeed + Math.sqrt(disc)) / T.gravity
}

/**
 * Airtime of a jump plus air jump, taking whichever of the two strategies gets
 * there — they are genuinely different moves and a player picks per gap:
 *
 *  A. air-jump as LATE as possible (as you fall back through launch height).
 *     Maximum airtime, therefore maximum distance. This is the doc's 13.7 m:
 *     "the double jump resets vertical velocity to 7.6 ... buys another 0.58 s".
 *  B. air-jump at the APEX. Maximum height — the doc's ~2.5 m vertical — at
 *     the cost of airtime.
 */
function tDouble(T, dy) {
  const g = T.gravity, v = T.jumpSpeed, a = T.airJumpSpeed
  let best = -1
  const dA = a * a - 2 * g * dy
  if (dA >= 0) best = Math.max(best, 2 * v / g + (a + Math.sqrt(dA)) / g)
  const apex = v * v / (2 * g)
  const dB = a * a - 2 * g * (dy - apex)
  if (dB >= 0) best = Math.max(best, v / g + (a + Math.sqrt(dB)) / g)
  return best
}

function makeEnvelope(T) {
  const clampT = (t) => (t < 0 ? -1 : Math.min(t, MAX_AIRTIME))
  const env = {
    free: (dy) => { const t = clampT(tFree(T, dy)); return t < 0 ? -1 : T.sprintSpeed * t },
    double: (dy) => { const t = clampT(tDouble(T, dy)); return t < 0 ? -1 : T.sprintSpeed * t },
    dash: (dy) => { const t = clampT(tDouble(T, dy)); return t < 0 ? -1 : T.sprintSpeed * t * DASH_GAIN },
  }
  env.flat = {
    free: env.free(0),
    double: env.double(0),
    dash: env.dash(0),
    grapple: T.grappleRange,
  }
  env.maxRise = {
    free: T.jumpSpeed ** 2 / (2 * T.gravity),
    double: T.jumpSpeed ** 2 / (2 * T.gravity) + T.airJumpSpeed ** 2 / (2 * T.gravity),
  }
  env.maxRise.climb = env.maxRise.free + WALLRUN_CLIMB
  env.maxRise.dash = env.maxRise.double
  return env
}

/** The bands docs/course-design.md publishes, so drift is visible not silent. */
const DOC_BANDS = { free: 7.3, double: 13.7, dash: 19, grapple: 34 }

/**
 * The TUNING values docs/course-design.md quotes in "The numbers".
 *
 * The doc says: "Every number below is derived from TUNING in src/player.js. If
 * you change a tuning constant, recompute this table, because the whole course
 * is built against it." Nothing enforced that, so this does: the run compares
 * the doc's quoted constants against the live ones and says which drifted. The
 * dash band in particular cannot be caught any other way, because DASH_GAIN is
 * calibrated rather than derived and would keep printing 19 m forever.
 */
const DOC_TUNING = {
  gravity: 26, jumpSpeed: 8.6, airJumpSpeed: 7.6, sprintSpeed: 11,
  dashSpeed: 21, dashTime: 0.22, grappleRange: 34, grappleMinRange: 5,
  climbSpeed: 9.2, climbTime: 0.5,
}

function tuningDrift(T) {
  const out = []
  for (const [k, v] of Object.entries(DOC_TUNING)) {
    if (T[k] === undefined) continue
    if (Math.abs(T[k] - v) > 1e-6) out.push({ key: k, doc: v, live: T[k] })
  }
  return out
}

// ---------------------------------------------------------- box spatial index

/**
 * Uniform XZ bucket grid over the collision boxes.
 *
 * Everything in this tool that touches boxes — headroom tests, occlusion rays —
 * is a small spatial query against a few thousand AABBs, and doing those
 * linearly turns a 10 second run into a 10 minute one.
 */
class BoxIndex {
  constructor(boxes) {
    this.boxes = boxes                      // Float64Array, 6 per box
    this.n = boxes.length / 6
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (let i = 0; i < this.n; i++) {
      const o = i * 6
      if (boxes[o] < x0) x0 = boxes[o]
      if (boxes[o + 2] < z0) z0 = boxes[o + 2]
      if (boxes[o + 3] > x1) x1 = boxes[o + 3]
      if (boxes[o + 5] > z1) z1 = boxes[o + 5]
    }
    this.x0 = x0; this.z0 = z0; this.x1 = x1; this.z1 = z1
    this.nx = Math.max(1, Math.ceil((x1 - x0) / BUCKET) + 1)
    this.nz = Math.max(1, Math.ceil((z1 - z0) / BUCKET) + 1)
    this.buckets = new Array(this.nx * this.nz)
    for (let i = 0; i < this.n; i++) {
      const o = i * 6
      const bx0 = this._bx(boxes[o]), bx1 = this._bx(boxes[o + 3])
      const bz0 = this._bz(boxes[o + 2]), bz1 = this._bz(boxes[o + 5])
      for (let bx = bx0; bx <= bx1; bx++) {
        for (let bz = bz0; bz <= bz1; bz++) {
          const k = bx * this.nz + bz
          ;(this.buckets[k] || (this.buckets[k] = [])).push(i)
        }
      }
    }
    // Visited stamps so a box straddling several buckets is tested once per
    // query without allocating a Set per query.
    this._stamp = new Int32Array(this.n)
    this._run = 0
  }

  _bx(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / BUCKET))) }
  _bz(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / BUCKET))) }

  /** Call `fn(boxIndex)` for every box whose bucket overlaps the XZ rect. */
  query(x0, z0, x1, z1, fn) {
    const run = ++this._run
    const bx0 = this._bx(x0), bx1 = this._bx(x1)
    const bz0 = this._bz(z0), bz1 = this._bz(z1)
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let bz = bz0; bz <= bz1; bz++) {
        const list = this.buckets[bx * this.nz + bz]
        if (!list) continue
        for (let i = 0; i < list.length; i++) {
          const b = list[i]
          if (this._stamp[b] === run) continue
          this._stamp[b] = run
          fn(b)
        }
      }
    }
  }
}

// ------------------------------------------------------------------ surfaces

/**
 * Turn the collision world into standable cells.
 *
 * A box's top face is only a floor where nothing sits on it. The kit builds
 * almost everything out of stacked boxes — `massif` alone is a plinth, a body
 * and a cap — so without the headroom test the "platform" count would be three
 * times the number of things you can actually stand on, and the buried faces
 * would invent edges through solid stone.
 */
function extractSurfaces(index, opts) {
  const { boxes } = index
  const n = index.n
  const originX = index.x0, originZ = index.z0
  const cell = opts.cell
  const nx = Math.ceil((index.x1 - index.x0) / cell) + 2
  const nz = Math.ceil((index.z1 - index.z0) / cell) + 2

  // cellIndex -> candidate top heights
  const cand = new Map()
  for (let i = 0; i < n; i++) {
    const o = i * 6
    const top = boxes[o + 4]
    if (top < opts.killY + 0.5) continue    // below the kill plane: not a floor
    const ix0 = Math.ceil((boxes[o] - originX) / cell - 0.5)
    const ix1 = Math.floor((boxes[o + 3] - originX) / cell - 0.5)
    const iz0 = Math.ceil((boxes[o + 2] - originZ) / cell - 0.5)
    const iz1 = Math.floor((boxes[o + 5] - originZ) / cell - 0.5)
    for (let ix = ix0; ix <= ix1; ix++) {
      if (ix < 0 || ix >= nx) continue
      for (let iz = iz0; iz <= iz1; iz++) {
        if (iz < 0 || iz >= nz) continue
        const key = ix * nz + iz
        let list = cand.get(key)
        if (!list) { cand.set(key, [top]); continue }
        // Collapse near-duplicates: overlapping boxes constantly share a top.
        let dup = false
        for (let k = 0; k < list.length; k++) {
          if (Math.abs(list[k] - top) < 0.05) { dup = true; break }
        }
        if (!dup) list.push(top)
      }
    }
  }

  // Headroom. The player is a capsule; test its footprint, not a point, so a
  // cell wedged against a parapet is correctly not a floor.
  const r = opts.radius
  const head = opts.standHeight
  const sx = [], sz = [], sy = []
  for (const [key, list] of cand) {
    const ix = Math.floor(key / nz), iz = key - ix * nz
    const cx = originX + (ix + 0.5) * cell
    const cz = originZ + (iz + 0.5) * cell
    for (let k = 0; k < list.length; k++) {
      const y = list[k]
      let blocked = false
      index.query(cx - r, cz - r, cx + r, cz + r, (b) => {
        if (blocked) return
        const o = b * 6
        if (boxes[o] > cx + r || boxes[o + 3] < cx - r) return
        if (boxes[o + 2] > cz + r || boxes[o + 5] < cz - r) return
        // 0.02 tolerance: the box that GENERATES this floor has max.y === y and
        // must not veto its own top face.
        if (boxes[o + 4] <= y + 0.02) return
        if (boxes[o + 1] >= y + head - 0.02) return
        blocked = true
      })
      if (!blocked) { sx.push(ix); sz.push(iz); sy.push(y) }
    }
  }
  return { sx, sz, sy, nx, nz, originX, originZ, cell }
}

/** Flood-fill standable cells into contiguous platforms. */
function clusterSurfaces(S, mergeStep) {
  const count = S.sy.length
  const byCell = new Map()
  for (let i = 0; i < count; i++) {
    const key = S.sx[i] * S.nz + S.sz[i]
    const l = byCell.get(key)
    if (l) l.push(i); else byCell.set(key, [i])
  }
  const owner = new Int32Array(count).fill(-1)
  const platforms = []
  const stack = []
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]]

  for (let seed = 0; seed < count; seed++) {
    if (owner[seed] !== -1) continue
    const id = platforms.length
    const members = []
    owner[seed] = id
    stack.length = 0
    stack.push(seed)
    while (stack.length) {
      const s = stack.pop()
      members.push(s)
      for (const [dx, dz] of NB) {
        const list = byCell.get((S.sx[s] + dx) * S.nz + (S.sz[s] + dz))
        if (!list) continue
        for (let j = 0; j < list.length; j++) {
          const t = list[j]
          if (owner[t] !== -1) continue
          if (Math.abs(S.sy[t] - S.sy[s]) > mergeStep) continue
          owner[t] = id
          stack.push(t)
        }
      }
    }
    platforms.push(members)
  }
  return { owner, platforms, byCell }
}

/** Summarise each cluster and pick the sample points used for gap testing. */
function buildPlatforms(S, cluster, minArea) {
  const cellArea = S.cell * S.cell
  const out = []
  for (let id = 0; id < cluster.platforms.length; id++) {
    const members = cluster.platforms[id]
    const area = members.length * cellArea
    if (area < minArea) continue

    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
    let y0 = Infinity, y1 = -Infinity, sumX = 0, sumZ = 0, sumY = 0
    const pt = (i) => [
      S.originX + (S.sx[i] + 0.5) * S.cell,
      S.sy[i],
      S.originZ + (S.sz[i] + 0.5) * S.cell,
    ]
    for (const i of members) {
      const [x, y, z] = pt(i)
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (z < z0) z0 = z; if (z > z1) z1 = z
      if (y < y0) y0 = y; if (y > y1) y1 = y
      sumX += x; sumY += y; sumZ += z
    }

    // Sample the PERIMETER: a jump leaves from an edge, not from the middle of
    // a deck, and using interior cells would over-report every gap by half the
    // platform's width.
    const set = new Set(members.map((i) => S.sx[i] * S.nz + S.sz[i]))
    const rim = members.filter((i) => {
      const ix = S.sx[i], iz = S.sz[i]
      return !set.has((ix + 1) * S.nz + iz) || !set.has((ix - 1) * S.nz + iz)
          || !set.has(ix * S.nz + iz + 1) || !set.has(ix * S.nz + iz - 1)
    })
    const pool = rim.length ? rim : members
    const stride = Math.max(1, Math.ceil(pool.length / MAX_SAMPLES))
    const samples = []
    for (let i = 0; i < pool.length; i += stride) samples.push(pt(pool[i]))

    out.push({
      id: out.length,
      cells: members.length,
      area: +area.toFixed(1),
      min: [x0 - S.cell / 2, y0, z0 - S.cell / 2],
      max: [x1 + S.cell / 2, y1, z1 + S.cell / 2],
      centre: [
        +(sumX / members.length).toFixed(2),
        +(sumY / members.length).toFixed(2),
        +(sumZ / members.length).toFixed(2),
      ],
      samples,
      members,
    })
  }
  return out
}

// ----------------------------------------------------------------- occlusion

/**
 * Is the straight segment p0->p1 blocked by a collision box?
 *
 * Slab test against shrunk boxes, with both ends trimmed. The trim is what
 * makes this usable at all: every segment starts and ends within touching
 * distance of the very geometry that forms the platform it is leaving.
 */
function segmentBlocked(index, p0, p1) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2]
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-6) return false
  const tEps = Math.min(0.45, CHORD_TRIM / len)
  const lo = tEps, hi = 1 - tEps
  if (hi <= lo) return false

  const boxes = index.boxes
  const qx0 = Math.min(p0[0], p1[0]), qx1 = Math.max(p0[0], p1[0])
  const qz0 = Math.min(p0[2], p1[2]), qz1 = Math.max(p0[2], p1[2])
  let hit = false
  index.query(qx0, qz0, qx1, qz1, (b) => {
    if (hit) return
    const o = b * 6
    let tmin = lo, tmax = hi
    for (let a = 0; a < 3; a++) {
      const d = a === 0 ? dx : a === 1 ? dy : dz
      const s = p0[a]
      const bmin = boxes[o + a] + BOX_SHRINK
      const bmax = boxes[o + 3 + a] - BOX_SHRINK
      if (bmax <= bmin) return                    // shrunk to nothing: ignore
      if (Math.abs(d) < 1e-9) {
        if (s < bmin || s > bmax) return
        continue
      }
      let t0 = (bmin - s) / d, t1 = (bmax - s) / d
      if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt }
      if (t0 > tmin) tmin = t0
      if (t1 < tmax) tmax = t1
      if (tmin > tmax) return
    }
    hit = true
  })
  return hit
}

/**
 * Is there a runnable face alongside the climb from `a` up to `b`?
 *
 * Samples the vertical corridor between the two points and asks, at each
 * height, whether some collision box spans that height within `WALL_REACH` of
 * the line. A sample height that is INSIDE a box fails outright — that corridor
 * is stone, not air.
 *
 * It does not check that the face is flat, long enough to run, or on the side
 * the player is travelling towards. It is a proximity argument.
 */
function wallSupport(index, a, b) {
  const boxes = index.boxes
  const y0 = a[1] + 1.0                   // start a jump's worth above the floor
  const y1 = b[1] - 0.2
  if (y1 <= y0) return 1
  const steps = Math.max(2, Math.ceil((y1 - y0) / WALLCHAIN_SAMPLE))
  let supported = 0
  for (let s = 0; s <= steps; s++) {
    const h = y0 + (y1 - y0) * (s / steps)
    let ok = false
    let inside = false
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const x = a[0] + (b[0] - a[0]) * t
      const z = a[2] + (b[2] - a[2]) * t
      index.query(x - WALL_REACH, z - WALL_REACH, x + WALL_REACH, z + WALL_REACH, (bi) => {
        const o = bi * 6
        // Must span this height with real face above and below the sample, or
        // it is a floor/ceiling slab rather than something to kick off.
        if (boxes[o + 1] > h - 0.3 || boxes[o + 4] < h + 0.3) return
        const dx = Math.max(boxes[o] - x, x - boxes[o + 3], 0)
        const dz = Math.max(boxes[o + 2] - z, z - boxes[o + 5], 0)
        if (dx === 0 && dz === 0) { inside = true; return }
        if (Math.hypot(dx, dz) <= WALL_REACH) ok = true
      })
      if (inside) return 0
      if (ok) break
    }
    if (ok) supported++
  }
  return supported / (steps + 1)
}

/**
 * Occlusion for a jump: chord test through the arc's apex.
 *
 * A jump is a parabola, not a chord — a straight test from foot to foot calls
 * every parapet and every intervening roof a wall. Testing p0 -> apex -> p1
 * approximates the arc with two segments and gets the common case (hop over a
 * balustrade, clear a low massif) right. It is still an approximation in both
 * directions; see the honesty block.
 */
function jumpOccluded(index, a, b, rise) {
  const p0 = [a[0], a[1] + CHORD_LIFT, a[2]]
  const p1 = [b[0], b[1] + CHORD_LIFT, b[2]]
  const apexY = Math.max(a[1] + rise, Math.max(p0[1], p1[1]) + 0.3)
  const apex = [(p0[0] + p1[0]) / 2, apexY, (p0[2] + p1[2]) / 2]
  return segmentBlocked(index, p0, apex) || segmentBlocked(index, apex, p1)
}

// --------------------------------------------------------------- graph build

function aabbGapH(A, B) {
  const dx = Math.max(0, Math.max(A.min[0] - B.max[0], B.min[0] - A.max[0]))
  const dz = Math.max(0, Math.max(A.min[2] - B.max[2], B.min[2] - A.max[2]))
  return Math.hypot(dx, dz)
}

/**
 * Cheapest jump-family technique that gets from `a` to `b`, or null.
 * Returns `{ mode, gap, dy }`.
 */
function jumpMode(env, a, b) {
  const gap = Math.hypot(b[0] - a[0], b[2] - a[2])
  const dy = b[1] - a[1]
  if (dy <= env.maxRise.free) {
    const r = env.free(dy)
    if (r >= 0 && gap <= r) return { mode: 'free', gap, dy }
  }
  // A vertical wall-run only exists when you are AT the wall, so it is gated on
  // the horizontal gap rather than on reach.
  if (dy > 0 && dy <= env.maxRise.climb && gap <= CLIMB_GAP) {
    return { mode: 'climb', gap, dy }
  }
  if (dy <= env.maxRise.double) {
    const r = env.double(dy)
    if (r >= 0 && gap <= r) return { mode: 'double', gap, dy }
    const rd = env.dash(dy)
    if (rd >= 0 && gap <= rd) return { mode: 'dash', gap, dy }
  }
  return null
}

/**
 * Which anchors each platform can fire at.
 *
 * `grappleMinRange..grappleRange` from at least one point on the platform, with
 * line of sight. Anchor sets are what make the grapple graph O(P*A) instead of
 * O(P^2*A): two platforms sharing an anchor are grapple-connected, which is
 * exactly docs/course-design.md's "34 m of a shared anchor" rule.
 */
function anchorSets(index, platforms, anchors, T, occlusion) {
  const sets = []
  for (const p of platforms) {
    const s = new Set()
    for (let ai = 0; ai < anchors.length; ai++) {
      const a = anchors[ai]
      // Cheap AABB reject before the per-sample loop.
      const dxa = Math.max(0, Math.max(p.min[0] - a[0], a[0] - p.max[0]))
      const dya = Math.max(0, Math.max(p.min[1] - a[1], a[1] - p.max[1]))
      const dza = Math.max(0, Math.max(p.min[2] - a[2], a[2] - p.max[2]))
      if (Math.hypot(dxa, dya, dza) > T.grappleRange) continue
      for (const q of p.samples) {
        const d = Math.hypot(a[0] - q[0], a[1] - q[1], a[2] - q[2])
        if (d < T.grappleMinRange || d > T.grappleRange) continue
        if (occlusion && segmentBlocked(index, [q[0], q[1] + CHORD_LIFT, q[2]], a)) continue
        s.add(ai)
        break
      }
    }
    sets.push(s)
  }
  return sets
}

function buildEdges(index, env, T, platforms, anchors, occlusion, wallchain) {
  const P = platforms.length
  const edges = Array.from({ length: P }, () => new Map())
  const stats = { tested: 0, occluded: 0, byMode: Object.fromEntries(MODES.map((m) => [m, 0])) }
  /** Travel proxy: centre to centre. The rim-to-rim gap measures only the air
   *  between two platforms, so summing it along a route reports a 330 m course
   *  as 110 m of "travel". Both go in the edge; this is the one weighted. */
  const travel = (A, B) => Math.hypot(
    A.centre[0] - B.centre[0], A.centre[1] - B.centre[1], A.centre[2] - B.centre[2])

  // --- jump family --------------------------------------------------------
  for (let i = 0; i < P; i++) {
    const A = platforms[i]
    for (let j = 0; j < P; j++) {
      if (i === j) continue
      const B = platforms[j]
      // Prefilter on AABBs using the most generous drop available between them.
      const dyBest = B.min[1] - A.max[1]
      const reach = Math.max(env.dash(Math.min(dyBest, 0)), CLIMB_GAP)
      if (aabbGapH(A, B) > reach) continue

      let best = null
      for (const a of A.samples) {
        for (const b of B.samples) {
          const m = jumpMode(env, a, b)
          if (!m) continue
          if (best && TIER[m.mode] > TIER[best.mode]) continue
          if (best && TIER[m.mode] === TIER[best.mode] && m.gap >= best.gap) continue
          best = { ...m, a, b }
          if (best.mode === 'free' && best.gap < 1.0) break
        }
        if (best && best.mode === 'free' && best.gap < 1.0) break
      }
      if (!best) continue
      stats.tested++
      if (occlusion) {
        const rise = env.maxRise[best.mode === 'climb' ? 'climb' : best.mode] || env.maxRise.double
        if (jumpOccluded(index, best.a, best.b, rise)) { stats.occluded++; continue }
      }
      if (addEdge(edges, i, j, best.mode, travel(A, B), best.gap)) stats.byMode[best.mode]++
    }
  }

  // --- wall-jump chain ----------------------------------------------------
  if (wallchain) {
    for (let i = 0; i < P; i++) {
      const A = platforms[i]
      for (let j = 0; j < P; j++) {
        if (i === j) continue
        const cur = edges[i].get(j)
        if (cur && TIER[cur.mode] <= TIER.wallchain) continue
        const B = platforms[j]
        const rise = B.min[1] - A.max[1]
        if (rise <= 0 || rise > WALLCHAIN_MAX_RISE) continue
        if (aabbGapH(A, B) > WALLCHAIN_SPAN) continue
        // Closest rim pair: the climb starts from the edge nearest the face.
        let bestPair = null, bestGap = Infinity
        for (const a of A.samples) {
          for (const b of B.samples) {
            if (b[1] <= a[1]) continue
            const gap = Math.hypot(b[0] - a[0], b[2] - a[2])
            if (gap < bestGap) { bestGap = gap; bestPair = [a, b] }
          }
        }
        if (!bestPair || bestGap > WALLCHAIN_SPAN) continue
        if (wallSupport(index, bestPair[0], bestPair[1]) < WALLCHAIN_COVER) continue
        if (addEdge(edges, i, j, 'wallchain', travel(A, B), bestGap)) stats.byMode.wallchain++
      }
    }
  }

  // --- grapple ------------------------------------------------------------
  const sets = anchorSets(index, platforms, anchors, T, occlusion)
  for (let i = 0; i < P; i++) {
    if (!sets[i].size) continue
    for (let j = 0; j < P; j++) {
      if (i === j) continue
      const cur = edges[i].get(j)
      if (cur && TIER[cur.mode] <= TIER.grapple) continue
      let shared = false
      for (const ai of sets[i]) { if (sets[j].has(ai)) { shared = true; break } }
      if (!shared) continue
      const A = platforms[i], B = platforms[j]
      if (addEdge(edges, i, j, 'grapple', travel(A, B), null)) stats.byMode.grapple++
    }
  }

  // Recount from the finished graph: a pair whose technique was upgraded (a
  // dash edge later beaten by a wall chain) would otherwise be counted twice.
  for (const m of MODES) stats.byMode[m] = 0
  for (const map of edges) for (const e of map.values()) stats.byMode[e.mode]++

  return { edges, anchorSets: sets, stats }
}

/** Keeps only the cheapest technique per ordered pair. Returns true if stored. */
function addEdge(edges, i, j, mode, dist, gap) {
  const cur = edges[i].get(j)
  if (cur && TIER[cur.mode] <= TIER[mode]) return false
  edges[i].set(j, { mode, dist: +dist.toFixed(2), gap: gap == null ? null : +gap.toFixed(2) })
  return true
}

// -------------------------------------------------------------- graph search

function reachableFrom(edges, start, maxTier = 3) {
  const seen = new Uint8Array(edges.length)
  if (start < 0) return seen
  seen[start] = 1
  const q = [start]
  while (q.length) {
    const v = q.pop()
    for (const [w, e] of edges[v]) {
      if (seen[w] || TIER[e.mode] > maxTier) continue
      seen[w] = 1
      q.push(w)
    }
  }
  return seen
}

/** Dijkstra by metres travelled; also returns the hop chain. */
function shortestPath(edges, start, goal, maxTier = 3) {
  const n = edges.length
  if (start < 0 || goal < 0) return null
  const dist = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const prevMode = new Array(n).fill(null)
  const done = new Uint8Array(n)
  dist[start] = 0
  for (;;) {
    let u = -1, bestD = Infinity
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < bestD) { bestD = dist[i]; u = i }
    if (u === -1 || u === goal) break
    done[u] = 1
    for (const [w, e] of edges[u]) {
      if (TIER[e.mode] > maxTier) continue
      const nd = dist[u] + e.dist
      if (nd < dist[w]) { dist[w] = nd; prev[w] = u; prevMode[w] = e.mode }
    }
  }
  if (!Number.isFinite(dist[goal])) return null
  const chain = []
  for (let v = goal; v !== start && v !== -1; v = prev[v]) {
    chain.push({ from: prev[v], to: v, mode: prevMode[v] })
  }
  chain.reverse()
  return { metres: +dist[goal].toFixed(1), hops: chain.length, chain }
}

/** Fewest-hops path, for the checkpoint chain report. */
function bfsPath(edges, start, goal, maxTier) {
  if (start < 0 || goal < 0) return null
  if (start === goal) return { hops: 0, chain: [] }
  const prev = new Int32Array(edges.length).fill(-1)
  const prevMode = new Array(edges.length).fill(null)
  const seen = new Uint8Array(edges.length)
  seen[start] = 1
  let q = [start]
  while (q.length) {
    const next = []
    for (const v of q) {
      for (const [w, e] of edges[v]) {
        if (seen[w] || TIER[e.mode] > maxTier) continue
        seen[w] = 1; prev[w] = v; prevMode[w] = e.mode
        if (w === goal) {
          const chain = []
          for (let x = goal; x !== start; x = prev[x]) chain.push({ from: prev[x], to: x, mode: prevMode[x] })
          chain.reverse()
          return { hops: chain.length, chain }
        }
        next.push(w)
      }
    }
    q = next
  }
  return null
}

// ------------------------------------------------------------------ locating

/**
 * Drop-cast a world point onto a platform.
 *
 * Spawn and checkpoints are authored at body height above the deck they belong
 * to (`L.checkpoint(4, 1.4, 0, 'terrace')` sits over a deck whose top is y=0),
 * so "nearest platform in 3D" picks the wrong one near a stack. Highest surface
 * at or below the point, within a widening radius, is what the game does.
 */
function locate(S, point, ownerOfSurface) {
  for (const radius of [1.5, 3.0, 6.0, 12.0]) {
    let best = -1, bestY = -Infinity
    for (let i = 0; i < S.sy.length; i++) {
      const pid = ownerOfSurface[i]
      if (pid === -1) continue
      const y = S.sy[i]
      if (y > point[1] + 0.6) continue
      if (y < point[1] - 30) continue
      const x = S.originX + (S.sx[i] + 0.5) * S.cell
      const z = S.originZ + (S.sz[i] + 0.5) * S.cell
      if (Math.hypot(x - point[0], z - point[2]) > radius) continue
      if (y > bestY) { bestY = y; best = pid }
    }
    if (best !== -1) return best
  }
  return -1
}

// ------------------------------------------------------------- page harvest

const HARVEST = () => {
  const g = window.__game
  if (!g || !g.level) {
    throw new Error('window.__game.level is missing — the debug API in src/main.js '
      + 'is what this tool reads; without it there is nothing to check')
  }
  const L = g.level
  if (!L.collision || !Array.isArray(L.collision.boxes)) {
    throw new Error('level.collision.boxes is missing — the collision world is '
      + 'the only source of truth for what is solid')
  }
  const boxes = []
  const tags = []
  for (const b of L.collision.boxes) {
    boxes.push(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z)
    tags.push(b.tag)
  }
  return {
    boxes,
    tags,
    anchors: L.anchors.map((a) => [a.x, a.y, a.z]),
    checkpoints: L.checkpoints.map((c) => ({
      label: c.label,
      position: [c.position.x, c.position.y, c.position.z],
      radius: c.radius,
    })),
    spawn: [L.spawn.x, L.spawn.y, L.spawn.z],
    finish: L.finish ? [L.finish.x, L.finish.y, L.finish.z] : null,
    killY: L.killY,
  }
}

// ------------------------------------------------------------------ analysis

function analyse(index, env, T, platforms, anchors, level, S, ownerOfSurface,
  occlusion, wallchain, maxTier = 3) {
  const { edges, anchorSets: sets, stats } =
    buildEdges(index, env, T, platforms, anchors, occlusion, wallchain)
  const usable = (i) => {
    let n = 0
    for (const e of edges[i].values()) if (TIER[e.mode] <= maxTier) n++
    return n
  }

  const spawnPid = locate(S, level.spawn, ownerOfSurface)
  const finishPid = level.finish ? locate(S, level.finish, ownerOfSurface) : -1
  const cpPids = level.checkpoints.map((c) => locate(S, c.position, ownerOfSurface))

  const reach = reachableFrom(edges, spawnPid, maxTier)
  const unreachable = []
  const deadEnds = []
  for (let i = 0; i < platforms.length; i++) {
    if (!reach[i]) { unreachable.push(i); continue }
    if (usable(i) === 0) deadEnds.push(i)
  }

  const critical = shortestPath(edges, spawnPid, finishPid, maxTier)

  // Checkpoint chain, tier<=1 (no dash, no grapple) — course-design.md:
  // "every checkpoint must remain reachable from the previous one WITHOUT
  // using dash or grapple".
  const chain = []
  for (let i = 1; i < cpPids.length; i++) {
    const from = cpPids[i - 1], to = cpPids[i]
    const safe = bfsPath(edges, from, to, Math.min(1, maxTier))
    const any = safe ? null : bfsPath(edges, from, to, maxTier)
    chain.push({
      from: level.checkpoints[i - 1].label,
      to: level.checkpoints[i].label,
      fromPlatform: from,
      toPlatform: to,
      safe: !!safe,
      hops: safe ? safe.hops : (any ? any.hops : null),
      requires: safe ? null : (any ? techniqueGate(any.chain) : 'no route at all'),
      // Which techniques the safe route leans on, so a link that only survives
      // because of the wall-chain inference says so instead of reading as clean.
      uses: safe ? [...new Set(safe.chain.map((c) => c.mode))] : [],
    })
  }

  const unusedAnchors = []
  for (let ai = 0; ai < anchors.length; ai++) {
    let used = false
    for (const s of sets) if (s.has(ai)) { used = true; break }
    if (!used) unusedAnchors.push(ai)
  }

  return {
    edges, sets, stats, spawnPid, finishPid, cpPids, reach, maxTier,
    unreachable, deadEnds, critical, chain, unusedAnchors,
  }
}

function techniqueGate(chainArr) {
  const gated = new Set(chainArr.filter((c) => TIER[c.mode] > 1).map((c) => c.mode))
  return gated.size ? [...gated].join(' + ') : 'unknown'
}

function nearestReachable(platforms, reach, i) {
  const A = platforms[i]
  let best = null
  for (let j = 0; j < platforms.length; j++) {
    if (!reach[j] || j === i) continue
    const B = platforms[j]
    const gap = aabbGapH(A, B)
    // Positive `rise` = this unreachable platform sits above the reachable one,
    // which is the interesting case: it needs height, not distance.
    const rise = A.centre[1] - B.centre[1]
    if (!best || gap < best.gap) best = { j, gap: +gap.toFixed(1), rise: +rise.toFixed(1) }
  }
  return best
}

// -------------------------------------------------------------------- report

const f2 = (v) => (v >= 0 ? ' ' : '') + v.toFixed(1)
const pos = (p) => `(${f2(p[0])}, ${f2(p[1])}, ${f2(p[2])})`

function printReport(R, ctx) {
  const { platforms, env, T, level, anchors, opts } = ctx
  const L = []
  const say = (s = '') => L.push(s)

  say('skyline-courier — reachability')
  say('='.repeat(72))
  say(`collision boxes ${ctx.boxCount}   walkable cells ${ctx.cellCount}   `
    + `platforms ${platforms.length}   anchors ${anchors.length}`)
  say(`grid ${opts.cell} m   min platform area ${opts.minArea} m²   `
    + `merge step ${opts.mergeStep} m   occlusion ${opts.occlusion ? 'ON' : 'OFF'}`
    + `   wall-chain inference ${opts.wallchain ? 'ON' : 'OFF'}`)
  if (opts.maxTier < 3) {
    say(`TECHNIQUE CEILING: ${opts.maxTechnique} — everything above it is treated as unavailable`)
  }
  say()

  say('ENVELOPE  (derived from TUNING in src/player.js, flat ground)')
  for (const m of ['free', 'double', 'dash', 'grapple']) {
    const got = env.flat[m]
    const doc = DOC_BANDS[m]
    const drift = Math.abs(got - doc) > 0.4 ? `   <-- docs/course-design.md says ${doc} m` : ''
    say(`  ${m.padEnd(8)} ${got.toFixed(1).padStart(5)} m`
      + `   max rise ${(env.maxRise[m] ?? T.grappleRange).toFixed(2)} m${drift}`
      + (m === 'dash' ? '   (calibrated to the doc, not derived)' : ''))
  }
  say(`  climb    ${CLIMB_GAP.toFixed(1).padStart(5)} m   max rise ${env.maxRise.climb.toFixed(2)} m`
    + '   (vertical wall-run, only at the wall)')
  if (ctx.drift.length) {
    say()
    say('  !! docs/course-design.md quotes TUNING values that no longer match')
    say('     src/player.js. The published bands — and every gap in the course')
    say('     built against them — are stale until that table is recomputed:')
    for (const d of ctx.drift) say(`       ${d.key}: doc ${d.doc}, live ${d.live}`)
  }
  if (opts.wallchain) {
    say(`  wallchain ${WALLCHAIN_SPAN.toFixed(1).padStart(4)} m   max rise ${WALLCHAIN_MAX_RISE.toFixed(2)} m`
      + '   (INFERRED — face within ' + WALL_REACH + ' m of the climb line)')
  }
  say()

  const pname = (i) => (i < 0 ? 'NONE' : `#${i} ${pos(platforms[i].centre)} ${platforms[i].area} m²`)
  say(`spawn   platform ${pname(R.spawnPid)}`)
  say(`finish  platform ${pname(R.finishPid)}`
    + (level.finish === null
      ? '   (the level declares no L.finish — nothing to route to)'
      : R.finishPid < 0
        ? `   !! L.finish is at ${pos(level.finish)} with NO landing platform under it`
        : ''))
  say()

  // --- failures ----------------------------------------------------------
  say(`UNREACHABLE FROM SPAWN — ${R.unreachable.length}`)
  if (!R.unreachable.length) say('  none')
  for (const i of R.unreachable.slice(0, opts.limit)) {
    const near = nearestReachable(platforms, R.reach, i)
    const p = platforms[i]
    say(`  #${String(i).padEnd(4)} ${pos(p.centre)}  ${String(p.area).padStart(7)} m²`
      + (near
        ? `   nearest reachable #${near.j}: ${near.gap} m across, `
          + `${near.rise >= 0 ? `${near.rise} m above it` : `${-near.rise} m below it`}`
        : '   no reachable platform anywhere'))
  }
  if (R.unreachable.length > opts.limit) say(`  ... ${R.unreachable.length - opts.limit} more (--limit)`)
  say()

  say(`DEAD ENDS — reachable, no outbound edge — ${R.deadEnds.length}`)
  if (!R.deadEnds.length) say('  none')
  for (const i of R.deadEnds.slice(0, opts.limit)) {
    const p = platforms[i]
    say(`  #${String(i).padEnd(4)} ${pos(p.centre)}  ${String(p.area).padStart(7)} m²`
      + `   anchors in range: ${R.sets[i].size}`)
  }
  if (R.deadEnds.length > opts.limit) say(`  ... ${R.deadEnds.length - opts.limit} more (--limit)`)
  say()

  // --- checkpoint chain ---------------------------------------------------
  say('CHECKPOINT CHAIN — each checkpoint from the previous one, NO dash, NO grapple')
  for (const c of R.chain) {
    const tag = c.safe ? 'ok  ' : 'FAIL'
    const detail = c.safe
      ? `${String(c.hops).padStart(2)} hops   ${c.uses.join(' ')}`
        + (c.uses.includes('wallchain') ? '   <-- leans on the INFERRED wall chain' : '')
      : (c.requires === 'no route at all'
        ? 'no route at all'
        : `needs ${c.requires} (${c.hops} hops with everything)`)
    say(`  ${tag}  ${c.from.padEnd(16)} -> ${c.to.padEnd(16)} ${detail}`)
  }
  const cpUnreached = R.cpPids
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p === -1 || !R.reach[x.p])
  if (cpUnreached.length) {
    say('  checkpoints not reachable from spawn at all:')
    for (const x of cpUnreached) {
      say(`    ${level.checkpoints[x.i].label}`
        + (x.p === -1 ? '  (no platform under it — floating checkpoint)' : ''))
    }
  }
  say()

  // --- critical path ------------------------------------------------------
  say('CRITICAL PATH  spawn -> finish')
  if (level.finish === null) {
    say('  not checked — the level declares no L.finish')
  } else if (R.finishPid < 0) {
    say('  NO ROUTE. L.finish has no landing platform under it, so there is')
    say('  nothing to route to. Either the finish is over a void or its deck is')
    say(`  below the ${opts.minArea} m² platform threshold.`)
  } else if (!R.critical) {
    say('  NO ROUTE. The finish is not reachable from spawn with any technique.')
  } else {
    const hist = {}
    for (const c of R.critical.chain) hist[c.mode] = (hist[c.mode] || 0) + 1
    const gaps = R.critical.chain.map((c) => R.edges[c.from].get(c.to).gap).filter((g) => g != null)
    say(`  ${R.critical.hops} hops, ~${R.critical.metres} m of route`
      + '  (platform centre to platform centre — a travel proxy, not a path length)')
    say(`  techniques: ${MODES.filter((m) => hist[m]).map((m) => `${m}x${hist[m]}`).join('  ') || 'none'}`)
    if (gaps.length) say(`  widest gap on the route: ${Math.max(...gaps).toFixed(1)} m`)
    const safe = shortestPath(R.edges, R.spawnPid, R.finishPid, Math.min(1, R.maxTier))
    say(safe
      ? `  no-dash/no-grapple route exists: ${safe.hops} hops, ~${safe.metres} m`
      : '  WARNING: the finish cannot be reached without dash or grapple')
  }
  say()

  // --- graph shape --------------------------------------------------------
  let edgeCount = 0
  for (const m of R.edges) edgeCount += m.size
  say('GRAPH')
  say(`  ${edgeCount} directed edges   `
    + MODES.map((m) => `${m} ${R.stats.byMode[m]}`).join('   '))
  say(`  jump pairs rejected by the occlusion test: ${R.stats.occluded}`
    + ` of ${R.stats.tested} that passed the envelope`)
  say(`  anchors serving no platform: ${R.unusedAnchors.length}`
    + (R.unusedAnchors.length ? `  [${R.unusedAnchors.slice(0, 8).map((i) => pos(anchors[i])).join(' ')}${R.unusedAnchors.length > 8 ? ' ...' : ''}]` : ''))
  say()

  return L.join('\n')
}

function honesty(opts, delta) {
  const L = []
  const say = (s = '') => L.push(s)
  say('HONESTY — what this check does NOT prove')
  say('-'.repeat(72))
  say('  * Edges are a straight-line envelope test between platform rim samples.')
  say('    It answers "is the gap inside the published reach", not "can a human')
  say('    hit it". Timing, approach angle and run-up length are not modelled.')
  say('  * A jump is checked as a two-segment chord through its arc apex, not as')
  say('    the real parabola. It can still call a clearable parapet a wall')
  say('    (false BLOCK) and can still miss a thin overhang that a real arc would')
  say('    clip (false PASS).')
  say('  * Grapple edges use docs/course-design.md\'s shared-anchor rule: both')
  say('    platforms within 5-34 m of one anchor with line of sight. The swing')
  say('    itself is not simulated, and `grappleAim` (you must be LOOKING at the')
  say('    anchor) is not modelled at all.')
  say(`  * The wall-run climb is credited whenever a platform is <=${CLIMB_GAP} m away`)
  say('    and inside the climb rise. It assumes the face under that platform is a')
  say('    runnable wall; it does not check wall height, length or approach.')
  if (opts.wallchain) {
    say('  * WALL-CHAIN EDGES ARE THE COARSEST INFERENCE HERE. They are created')
    say(`    purely because a collision box spans the climb within ${WALL_REACH} m of it.`)
    say('    Nothing checks that the face is flat, long enough to run, correctly')
    say('    oriented, or that the wall-run timer survives the climb. Re-run with')
    say('    --strict-envelope to see the graph without them.')
  } else {
    say('  * Wall-chain inference is OFF (--strict-envelope), so any section built')
    say('    around wall-jumping — section 6 of this course is — will report as')
    say('    grapple-gated. That is the model missing a move, not a level bug.')
  }
  say('  * Platforms below ' + opts.killY + ' m (the kill plane) are excluded entirely.')
  say(`  * Surfaces smaller than ${opts.minArea} m² are not counted as platforms, so a`)
  say('    genuinely tiny landing spot will be invisible to this check.')
  say('  * Falling is treated as free and always survivable, which matches the')
  say('    design (the cloud deck respawns you). A "dead end" is therefore a flow')
  say('    failure — you can only leave by dying — not a frozen player.')
  if (delta) {
    say()
    if (delta.same) {
      say('  * Occlusion cross-check: re-running with occlusion OFF gives the same')
      say('    verdict, so no result below depends on the chord approximation.')
    } else {
      say('  * !! Occlusion cross-check DISAGREES. With occlusion off,')
      say(`       unreachable ${delta.offUnreachable} vs ${delta.onUnreachable}, `
        + `dead ends ${delta.offDeadEnds} vs ${delta.onDeadEnds}.`)
      say('       The verdict is being decided by the chord approximation, not by')
      say('       the envelope. Check the listed platforms in game before acting.')
    }
  }
  return L.join('\n')
}

// ---------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const opts = {
    cell: num(args.cell, CELL),
    minArea: num(args['min-area'], MIN_AREA),
    mergeStep: num(args['merge-step'], MERGE_STEP),
    occlusion: !args['no-occlusion'],
    wallchain: !args['strict-envelope'],
    limit: num(args.limit, 20),
    killY: 0,
    // Ceiling on the techniques the player is allowed. Default: everything.
    // `--max-technique double` answers course-design.md's real question —
    // "does the safe line exist" — as a gate rather than as a warning.
    maxTechnique: args['max-technique'] === undefined ? 'grapple' : String(args['max-technique']),
  }
  if (opts.cell <= 0.05 || opts.cell > 4) {
    console.error('--cell must be between 0.05 and 4 metres')
    process.exit(2)
  }
  if (!(opts.maxTechnique in TIER)) {
    console.error(`--max-technique must be one of: ${MODES.join(', ')}`)
    process.exit(2)
  }
  opts.maxTier = TIER[opts.maxTechnique]
  const port = num(args.port, PORT)

  const T = await readTuning()
  const env = makeEnvelope(T)

  if (!args['no-build']) buildDist()

  const server = await startStaticServer(resolve(REPO, 'dist'), port)
  let browser = null
  let level = null
  let errors = []
  try {
    browser = await launchBrowser()
    const opened = await openGame(browser, server.url, { width: 640, height: 360 })
    errors = opened.errors
    level = await opened.page.evaluate(HARVEST)
  } finally {
    if (browser) await browser.close()
    await server.close()
  }

  if (errors.length) {
    console.error('page errors — the level may not have finished building:')
    for (const e of errors) console.error('  ' + e)
    process.exit(1)
  }

  opts.killY = level.killY

  const boxes = Float64Array.from(level.boxes)
  const index = new BoxIndex(boxes)
  const S = extractSurfaces(index, {
    cell: opts.cell,
    killY: level.killY,
    radius: T.radius,
    standHeight: T.standHeight,
  })
  const cluster = clusterSurfaces(S, opts.mergeStep)
  const platforms = buildPlatforms(S, cluster, opts.minArea)

  // Cluster ids are dense over ALL clusters; platforms drop the sub-minimum
  // ones and renumber, so surfaces need a map into the surviving numbering.
  const clusterToPlatform = new Int32Array(cluster.platforms.length).fill(-1)
  for (const p of platforms) {
    for (const m of p.members) { clusterToPlatform[cluster.owner[m]] = p.id; break }
  }
  const ownerOfSurface = new Int32Array(S.sy.length)
  for (let i = 0; i < S.sy.length; i++) ownerOfSurface[i] = clusterToPlatform[cluster.owner[i]]

  const R = analyse(index, env, T, platforms, level.anchors, level, S,
    ownerOfSurface, opts.occlusion, opts.wallchain, opts.maxTier)

  // Occlusion cross-check: if turning it off changes the verdict, the verdict is
  // an artefact of the approximation and the run says so instead of pretending.
  let delta = null
  if (opts.occlusion) {
    const off = analyse(index, env, T, platforms, level.anchors, level, S,
      ownerOfSurface, false, opts.wallchain, opts.maxTier)
    delta = {
      onUnreachable: R.unreachable.length, offUnreachable: off.unreachable.length,
      onDeadEnds: R.deadEnds.length, offDeadEnds: off.deadEnds.length,
    }
    delta.same = delta.onUnreachable === delta.offUnreachable
      && delta.onDeadEnds === delta.offDeadEnds
  }

  const drift = tuningDrift(T)
  const ctx = {
    platforms, env, T, level, anchors: level.anchors, opts, drift,
    boxCount: index.n, cellCount: S.sy.length,
  }

  // course-design.md: "The route must remain completable end to end." A finish
  // the player cannot stand on, or cannot get to, is a completability failure
  // and belongs in the gate next to the soft-locks. A level that has not
  // declared a finish yet is a different thing and only earns a note.
  const finishDeclared = level.finish !== null
  const finishOk = !finishDeclared || (R.finishPid >= 0 && !!R.reach[R.finishPid])
  const failed = R.unreachable.length > 0 || R.deadEnds.length > 0 || !finishOk
  const chainFailed = R.chain.some((c) => !c.safe)

  if (args.json || args.out) {
    const payload = {
      ok: !failed,
      chainOk: !chainFailed,
      finishDeclared,
      finishOk,
      tuning: T,
      envelope: {
        flat: env.flat, maxRise: env.maxRise, climbGap: CLIMB_GAP,
        docBands: DOC_BANDS, dashGain: DASH_GAIN, docTuningDrift: drift,
        wallchain: opts.wallchain
          ? { span: WALLCHAIN_SPAN, reach: WALL_REACH, maxRise: WALLCHAIN_MAX_RISE, inferred: true }
          : null,
      },
      options: opts,
      counts: {
        collisionBoxes: index.n,
        walkableCells: S.sy.length,
        platforms: platforms.length,
        anchors: level.anchors.length,
        edges: R.edges.reduce((a, m) => a + m.size, 0),
        edgesByMode: R.stats.byMode,
        occludedRejections: R.stats.occluded,
      },
      spawnPlatform: R.spawnPid,
      finishPlatform: R.finishPid,
      platforms: platforms.map((p) => ({
        id: p.id, centre: p.centre, area: p.area,
        min: p.min.map((v) => +v.toFixed(2)), max: p.max.map((v) => +v.toFixed(2)),
        reachable: !!R.reach[p.id],
        outDegree: R.edges[p.id].size,
        anchorsInRange: R.sets[p.id].size,
      })),
      unreachable: R.unreachable,
      deadEnds: R.deadEnds,
      checkpoints: level.checkpoints.map((c, i) => ({
        label: c.label, position: c.position, platform: R.cpPids[i],
        reachableFromSpawn: R.cpPids[i] >= 0 && !!R.reach[R.cpPids[i]],
      })),
      checkpointChain: R.chain,
      criticalPath: R.critical,
      unusedAnchors: R.unusedAnchors.map((i) => level.anchors[i]),
      occlusionCrossCheck: delta,
      notes: [
        'Edges are a straight-line envelope test between platform rim samples; timing and approach angle are not modelled.',
        'Jump occlusion is a two-segment chord through the arc apex, so both false blocks and false passes are possible.',
        'Grapple edges use the shared-anchor rule from docs/course-design.md; the swing and the aim cone are not simulated.',
        'Wall-run climb is credited on proximity alone and does not verify that a runnable wall exists.',
        opts.wallchain
          ? 'Wall-chain edges are inferred from a collision box spanning the climb nearby; nothing verifies the face is runnable. Re-run with --strict-envelope to drop them.'
          : 'Wall-chain inference is off, so wall-jump sections report as grapple-gated.',
        `Surfaces below the kill plane (${level.killY} m) and smaller than ${opts.minArea} m2 are excluded.`,
        'Falling is free and survivable by design, so a dead end is a flow failure, not a frozen player.',
      ],
    }
    const text = JSON.stringify(payload, null, args.out ? 2 : 0)
    if (args.out) {
      const out = resolve(args.out)
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, text)
    }
    if (args.json) console.log(text)
  }

  if (!args.json) {
    console.log(printReport(R, ctx))
    console.log(honesty(opts, delta))
    console.log()
    const why = []
    if (R.unreachable.length) why.push(`${R.unreachable.length} unreachable`)
    if (R.deadEnds.length) why.push(`${R.deadEnds.length} dead ends`)
    if (!finishOk) {
      why.push(R.finishPid < 0
        ? 'the finish has no landing platform under it'
        : 'the finish is not reachable from spawn')
    }
    console.log(failed
      ? `FAIL — ${why.join(', ')}`
      : 'PASS — every platform is reachable from spawn and has a way off it'
        + (finishDeclared ? ', and the finish is reachable' : ''))
    if (!finishDeclared) {
      console.log('NOTE — this level declares no L.finish, so end-to-end '
        + 'completability was not checked')
    }
    if (chainFailed) {
      console.log('WARN — the checkpoint chain needs dash or grapple somewhere '
        + '(docs/course-design.md forbids this); not a gate failure, but it is a bug')
    }
    if (args.out) console.log(`json: ${resolve(args.out)}`)
  }

  process.exitCode = failed ? 1 : 0
}

main().catch((e) => { console.error(e); process.exit(1) })
