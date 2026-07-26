import * as THREE from 'three'
import { surfaceMaterial, glowMaterial, PALETTE } from './materials.js'
import { makeRand, trackedKit } from './kit.js'

/**
 * The course, as data.
 *
 * The hard rule this file exists to enforce (CLAUDE.md #2): **a visible
 * surface is always a solid one**. `solid()` writes geometry and collision
 * from the same declaration, so the two can never drift. `decor()` is the only
 * way to add something non-solid, and it refuses to sit anywhere near the
 * route. Clockwork Garden's most persistent bug — a thing you could see but
 * not stand on, and a thing you could stand on but not see — is structurally
 * impossible here.
 *
 * All boxes of one material merge into a single draw call, with per-box tint
 * jitter and baked contact shading in the vertex colours. That is what stops
 * a row of identical platforms from reading as a row of identical primitives.
 *
 * Everything architectural is placed through `src/kit.js`, and `buildCourse()`
 * ends by asserting that every prefab the kit exports actually got placed. A
 * kit nobody imports is the exact failure this course shipped with once: the
 * arches, gears, vines, domes and waterfalls all existed in source and none of
 * them existed in a frame.
 */

const TEX_PER_METRE = 0.42

/**
 * FACES is indexed as `axis * 2 + (sign > 0 ? 0 : 1)`, so `+X` is 0, `-X` is 1,
 * `+Y` is 2 and so on. The bevel generator below relies on that ordering to
 * find a UV basis for an arbitrary face, edge or corner polygon.
 */
const FACES = [
  { n: [1, 0, 0],  u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1],  v: [0, 1, 0] },
  { n: [0, 1, 0],  u: [1, 0, 0],  v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, 1] },
  { n: [0, 0, 1],  u: [1, 0, 0],  v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
]

const QUAD = [[-1, -1], [1, -1], [1, 1], [-1, 1]]

/**
 * THE BEVEL. Every box in this game is chamfered by this much, and it is the
 * single highest-leverage number in the file.
 *
 * A 90-degree arris catches no highlight at all: the two faces meeting at it
 * are lit by two different cosines and the edge between them is a step
 * function, so a carved mass reads as a flat coloured shape. Insetting each
 * face by `b` and filling the gap with 12 edge quads and 8 corner triangles
 * puts a 45-degree sliver between every pair of faces, and at golden hour with
 * a low raking sun that sliver lights up along every arris in the world.
 *
 * 4.5 cm is a real stonemason's arris at this scale — big enough to survive
 * two pixels at 30 m, small enough that a 0.9 m mantle ledge is still 0.9 m.
 * The proportional term keeps 12 cm balusters from turning into octagons.
 *
 * THE BEVEL GEOMETRY IS STRICTLY INSIDE THE DECLARED AABB, so the collider
 * declaration is untouched: `solid()` still means exactly what it meant, and
 * art-direction.md's collision caveat is satisfied by construction.
 */
const BEVEL_MAX = 0.045
const BEVEL_FRAC = 0.13

/**
 * Top arrises are lifted and bottom arrises are dropped, in ALBEDO rather than
 * in the lit value.
 *
 * The art review measured a 15-luma spread across the whole tower staircase:
 * the step nosings were drawn with exactly the same weight as the decorative
 * block joints inside each face, so decorative detail out-competed gameplay
 * silhouette. Tread-vs-riser and ledge-edge are the two most load-bearing
 * reads in a first-person parkour game, so they get a fixed offset that does
 * not depend on which way the sun happens to be pointing.
 */
const TOP_EDGE_LIFT = 1.26
const BOT_EDGE_DROP = 0.52

/**
 * Checkpoint gate billboards. Sized in metres, and sized to be SEEN: 7.2 m of
 * width puts the ring at ~90 px from 40 m out and still ~18 px from 200 m,
 * against the old gate's 4 px. The column runs 15 m so it clears the cypress
 * and the balustrade line on the island it stands on.
 */
const MAX_GATES = 32
const GATE_W = 7.2
const GATE_H = 15.0

/** Reverse a polygon's winding if it does not face the way we said it does. */
function faceOut(verts, n) {
  const [a, b, c] = verts
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  const gx = uy * vz - uz * vy
  const gy = uz * vx - ux * vz
  const gz = ux * vy - uy * vx
  if (gx * n[0] + gy * n[1] + gz * n[2] < 0) verts.reverse()
  return verts
}

// Build-time scratch for the mesh channel. Never touched at frame time.
const _v = new THREE.Vector3()
const _nrm = new THREE.Matrix3()

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

// ==================================================== the traversal envelope
//
// Every number here is copied from `TUNING` in `src/player.js` and derived in
// docs/course-design.md. They live here so the level can ASK whether a gap is
// crossable instead of a level designer guessing, which is the difference
// between "I think you can make this" and a build that fails when you cannot.
//
// If a tuning constant moves, these move with it and the course either still
// validates or refuses to load. That refusal is the whole point.
const G_ACC = 26            // TUNING.gravity
const V_JUMP = 8.6          // TUNING.jumpSpeed
const V_AIR = 7.6           // TUNING.airJumpSpeed
const V_RUN = 11.0          // TUNING.sprintSpeed
const APEX = (V_JUMP * V_JUMP) / (2 * G_ACC)     // 1.423 m — a single jump's rise
/** Dash adds ~0.22 s at 21 m/s over the sprint line: 19 m band minus 13.7 m. */
const DASH_BONUS = 5.3
/** Grapple sphere, and therefore the connectivity radius of one lantern. */
const GRAPPLE_MAX = 34
const GRAPPLE_MIN = 5
/**
 * Nobody lands on the last centimetre of a rim at 47 km/h. Every authored gap
 * is held to 82% of the theoretical reach so a slightly early take-off, a
 * slightly wide line or a landing on the chamfer still makes it.
 */
const MARGIN = 0.82

/** Airtime of a plain sprint jump landing `dy` metres above the take-off. */
function airSingle(dy) {
  if (dy > APEX) return -1
  return (V_JUMP + Math.sqrt(V_JUMP * V_JUMP - 2 * G_ACC * dy)) / G_ACC
}

/**
 * Airtime with the double jump spent optimally.
 *
 * Going level or downhill, the air jump is fired as LATE as possible — at the
 * target height — so it buys a full `2·V_AIR/g` of hang on top of the first
 * arc. Going uphill there is no choice: the first arc tops out at APEX and the
 * second has to cover the rest, which is what caps the climb at ~2.53 m.
 */
function airDouble(dy) {
  if (dy <= APEX) return airSingle(dy) + (2 * V_AIR) / G_ACC
  const rest = dy - APEX
  const disc = V_AIR * V_AIR - 2 * G_ACC * rest
  if (disc < 0) return -1
  return V_JUMP / G_ACC + (V_AIR + Math.sqrt(disc)) / G_ACC
}

const reachFree = (dy) => { const t = airSingle(dy); return t < 0 ? -1 : t * V_RUN }
const reachStandard = (dy) => { const t = airDouble(dy); return t < 0 ? -1 : t * V_RUN }
const reachCommitted = (dy) => { const r = reachStandard(dy); return r < 0 ? -1 : r + DASH_BONUS }

/** The narrowest band that clears `gap` at `dy`, or null if nothing does. */
function bandFor(gap, dy) {
  if (gap <= MARGIN * reachFree(dy)) return 'free'
  if (gap <= MARGIN * reachStandard(dy)) return 'standard'
  if (gap <= MARGIN * reachCommitted(dy)) return 'committed'
  return null
}

/** Bands a player with no dash charge and no anchor can still use. */
const SAFE_MODES = new Set(['free', 'standard', 'contiguous', 'stair', 'walljump', 'wallrun'])
const BAND_RANK = { free: 0, standard: 1, committed: 2, grapple: 3 }

// ======================================================== the archipelago
/**
 * The island graph — built BEFORE the geometry, and checked after it.
 *
 * docs/world-plan.md: *"Build the archipelago as a graph first, geometry
 * second: decide which island pairs should connect, then place the lantern
 * that makes each edge exist. An island with no inbound edge is scenery
 * whether you meant it or not."*
 *
 * So this is not a diagram in a doc, it is a data structure the build walks.
 * It answers four questions mechanically, and throws on any of them:
 *
 *  1. Is every island REACHABLE from the spawn?           (forward BFS)
 *  2. Is every island ESCAPABLE — a path onward to the
 *     finish, so no landing is a soft-lock?               (reverse BFS)
 *  3. Is every checkpoint reachable from the previous one
 *     WITHOUT dash or grapple?                            (safe-mode BFS)
 *  4. Is every declared gap actually inside the band it
 *     claims, given the real gravity and jump speeds?     (per-edge)
 *
 * Ethan's most repeated complaint about round one was "I can't get to the
 * other islands". A comment cannot fix that. A failing build can.
 */
class Archipelago {
  constructor() {
    this.nodes = new Map()
    this.edges = []
    /** Islands that are decor: they must be provably OUT of reach. */
    this.scenery = []
  }

  /**
   * Register an island footprint.
   *
   * `lenX`/`lenZ` are the FULL walkable extents, matching what `deck()`
   * reserves, so the graph measures the same rectangle the collider does.
   * `launchY` is the height you actually jump FROM when a ramp or a stair
   * stands on the deck — without it a ziggurat reads as an impossible climb.
   */
  node(id, x, y, z, lenX, lenZ, opts = {}) {
    if (this.nodes.has(id)) throw new Error(`archipelago: duplicate island id "${id}"`)
    const n = {
      id, x, y, z,
      hx: lenX / 2,
      hz: lenZ / 2,
      // A long deck is emitted with `facets: 1` — a true rectangle — and its
      // corners really are that far out. A near-square one is faceted toward a
      // disc, so the inscribed ellipse is the honest (and conservative) read.
      rect: facetsFor(lenX, lenZ) === 1,
      launchY: opts.launchY ?? y,
      kind: opts.kind || 'route',
      out: [],
      in: [],
    }
    this.nodes.set(id, n)
    return n
  }

  get(id) {
    const n = this.nodes.get(id)
    if (!n) throw new Error(`archipelago: no island "${id}"`)
    return n
  }

  /** Half-extent of an island's footprint along a horizontal direction. */
  static reachOut(n, dx, dz) {
    const len = Math.hypot(dx, dz) || 1
    const c = Math.abs(dx / len), s = Math.abs(dz / len)
    if (n.rect) return Math.min(c < 1e-6 ? Infinity : n.hx / c, s < 1e-6 ? Infinity : n.hz / s)
    return 1 / Math.hypot(c / n.hx, s / n.hz)
  }

  /** Edge-to-edge horizontal gap and the height change across it. */
  measure(a, b) {
    const dx = b.x - a.x, dz = b.z - a.z
    const d = Math.hypot(dx, dz)
    const gap = d - Archipelago.reachOut(a, dx, dz) - Archipelago.reachOut(b, dx, dz)
    return { d, gap: Math.max(0, gap), dy: b.y - a.launchY }
  }

  /**
   * Declare a directed connection, and prove it.
   *
   * `mode` is what the player is expected to spend:
   *   free / standard / committed  — distance-checked against the envelope
   *   grapple                      — checked against a real lantern position
   *   contiguous/stair/walljump/wallrun — structural; the height is carried by
   *     geometry rather than by an arc, so there is no distance to check. Every
   *     one of these must say WHY in `note`, or it is just an excuse.
   */
  link(fromId, toId, mode, opts = {}) {
    const a = this.get(fromId), b = this.get(toId)
    const m = this.measure(a, b)
    const e = { from: fromId, to: toId, mode, note: opts.note || '', ...m, ok: true, why: '' }

    if (mode === 'free' || mode === 'standard' || mode === 'committed') {
      const band = bandFor(m.gap, m.dy)
      e.band = band
      if (band == null || BAND_RANK[band] > BAND_RANK[mode]) {
        e.ok = false
        e.why = `${m.gap.toFixed(1)} m at dy ${m.dy.toFixed(1)} needs ${band || '>committed'}`
      }
    } else if (mode === 'grapple') {
      const L = opts.anchor
      if (!L) throw new Error(`archipelago: ${fromId}->${toId} is grapple-gated with no anchor`)
      // Leg one: the shot. Measured from the take-off rim, not the island
      // centre, because that is where the player actually is when they fire.
      const dx = L[0] - a.x, dz = L[2] - a.z
      const rim = Archipelago.reachOut(a, dx, dz)
      const flat = Math.max(0, Math.hypot(dx, dz) - rim)
      const shot = Math.hypot(flat, L[1] - a.launchY)
      // Leg two: the arrival. The line pulls you TO the anchor, so getting off
      // it onto the far island is an ordinary jump from the anchor's height.
      const bx = b.x - L[0], bz = b.z - L[2]
      const drop = Math.max(0, Math.hypot(bx, bz) - Archipelago.reachOut(b, bx, bz))
      const land = bandFor(drop, b.y - L[1])
      e.shot = shot
      e.land = land
      if (shot > GRAPPLE_MAX * 0.94 || shot < GRAPPLE_MIN) {
        e.ok = false
        e.why = `anchor ${shot.toFixed(1)} m from the lip (5..${GRAPPLE_MAX} m)`
      } else if (land == null || BAND_RANK[land] > BAND_RANK.committed) {
        e.ok = false
        e.why = `${drop.toFixed(1)} m from the anchor to ${toId} is not landable`
      }
    } else if (!SAFE_MODES.has(mode)) {
      throw new Error(`archipelago: unknown mode "${mode}" on ${fromId}->${toId}`)
    } else if (!e.note) {
      throw new Error(`archipelago: structural edge ${fromId}->${toId} must say why`)
    }

    a.out.push(e)
    b.in.push(e)
    this.edges.push(e)
    return e
  }

  /** A two-way connection. Both directions are measured independently. */
  both(a, b, mode, opts) {
    this.link(a, b, mode, opts)
    this.link(b, a, mode, opts)
  }

  /** Decor islands, which must be provably untestable. */
  sceneryAt(x, y, z, w, d) { this.scenery.push({ x, y, z, r: Math.max(w, d) / 2 }) }

  _walk(startId, dir, allow) {
    const seen = new Set([startId])
    const queue = [startId]
    while (queue.length) {
      const n = this.get(queue.shift())
      for (const e of n[dir]) {
        if (allow && !allow.has(e.mode)) continue
        const next = dir === 'out' ? e.to : e.from
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    return seen
  }

  /**
   * Everything above, run for real. Returns a report; throws on any failure.
   *
   * @param spawnId  where the player starts
   * @param finishId where the route ends
   * @param spine    checkpoint island ids, in route order
   */
  verify(spawnId, finishId, spine) {
    const bad = []
    for (const e of this.edges) if (!e.ok) bad.push(`  ${e.from} -> ${e.to} (${e.mode}): ${e.why}`)
    if (bad.length) {
      throw new Error(`archipelago: ${bad.length} gap(s) outside the traversal envelope:\n${bad.join('\n')}`)
    }

    const reachable = this._walk(spawnId, 'out', null)
    const orphans = [...this.nodes.keys()].filter((id) => !reachable.has(id))
    if (orphans.length) {
      throw new Error(`archipelago: ${orphans.length} island(s) with no route in — `
        + `they are scenery you meant to be solid: ${orphans.join(', ')}`)
    }

    const escapable = this._walk(finishId, 'in', null)
    const traps = [...this.nodes.keys()].filter((id) => !escapable.has(id))
    if (traps.length) {
      throw new Error(`archipelago: ${traps.length} island(s) with no route on — `
        + `land there and the only way out is to fall: ${traps.join(', ')}`)
    }

    // The safe line. course-design.md: dash and grapple are the FAST line, not
    // the only line, so each checkpoint must fall out of a walk that spends
    // neither. Checked leg by leg so a failure names the leg.
    for (let i = 1; i < spine.length; i++) {
      const from = spine[i - 1]
      const safe = this._walk(from, 'out', SAFE_MODES)
      if (!safe.has(spine[i])) {
        throw new Error(`archipelago: checkpoint "${spine[i]}" cannot be reached from `
          + `"${from}" without a dash or a grapple`)
      }
    }

    // Decor has to be genuinely out of the play space. 70 m is the grapple
    // sphere (34 m) plus a committed dash off its far side plus slack, so no
    // player can put a hand on a ghost island however they arrive.
    let worst = Infinity, worstAt = null
    for (const s of this.scenery) {
      for (const n of this.nodes.values()) {
        const d = Math.hypot(s.x - n.x, s.y - n.y, s.z - n.z) - s.r - Math.max(n.hx, n.hz)
        if (d < worst) { worst = d; worstAt = `${n.id} <-> scenery(${s.x.toFixed(0)}, ${s.z.toFixed(0)})` }
      }
    }
    if (this.scenery.length && worst < 70) {
      throw new Error(`archipelago: a decor island is ${worst.toFixed(1)} m from solid ground `
        + `(${worstAt}) — a player will reach it and fall through`)
    }

    const spend = { free: 0, standard: 0, committed: 0, grapple: 0 }
    for (const e of this.edges) if (spend[e.mode] !== undefined) spend[e.mode]++
    return {
      islands: this.nodes.size,
      edges: this.edges.length,
      scenery: this.scenery.length,
      sceneryClearance: this.scenery.length ? +worst.toFixed(1) : null,
      bands: spend,
    }
  }

  /**
   * Every trigger point stands on a deck, with room to stand there.
   *
   * Found four real bugs the moment it was written, all the same shape: a
   * dome, an armillary and two take-off terraces placed at the centre of the
   * island whose checkpoint was also at the centre — so the marker the player
   * is steering at was inside a wall. Nothing else catches this. The graph
   * proves you can GET to an island; only the collision world knows whether
   * the spot you are being sent to is a place a body fits.
   */
  static assertTriggersClear(collision, points) {
    const R = 0.34, H = 1.75
    const bad = []
    for (const [label, x, z, cy] of points) {
      let deck = -Infinity
      for (const b of collision.boxes) {
        if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue
        if (b.max.y <= cy + 0.05 && b.max.y > deck) deck = b.max.y
      }
      if (deck === -Infinity) { bad.push(`${label}: nothing solid under it`); continue }
      const rise = cy - deck
      if (rise <= 0 || rise >= 3.0) { bad.push(`${label}: trigger sits ${rise.toFixed(2)} m over its deck`); continue }
      for (const b of collision.boxes) {
        const dx = Math.max(b.min.x - x, 0, x - b.max.x)
        const dz = Math.max(b.min.z - z, 0, z - b.max.z)
        // Overlaps the capsule in plan, stands more than a step proud of the
        // deck, and is not high enough to duck under.
        if (dx * dx + dz * dz >= R * R) continue
        if (b.max.y <= deck + 0.5 || b.min.y >= deck + H) continue
        bad.push(`${label}: buried in ${b.tag} (top ${b.max.y.toFixed(2)}, deck ${deck.toFixed(2)})`)
        break
      }
    }
    if (bad.length) {
      throw new Error(`archipelago: ${bad.length} trigger point(s) a player cannot stand on:\n  ${bad.join('\n  ')}`)
    }
  }

  /** Travelled length of a named path, through island centres. */
  pathLength(ids) {
    let sum = 0
    for (let i = 1; i < ids.length; i++) {
      const a = this.get(ids[i - 1]), b = this.get(ids[i])
      sum += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    }
    return sum
  }
}

export class Level {
  constructor(collision) {
    this.collision = collision
    this.group = new THREE.Group()
    this.checkpoints = []
    this.lanterns = []
    /** Grapple anchors, handed to the player at startup. */
    this.anchors = []
    this.spawn = new THREE.Vector3(3, 1.2, 0)
    // The course runs along +X. Three's default forward is -Z, so without
    // this the player spawns facing ninety degrees off the route and runs
    // straight off the side of the terrace.
    this.spawnYaw = -Math.PI / 2
    // The deep leg runs at y ≈ -19 with its boulder mass hanging to ≈ -28, so
    // the old -32 floor sat a metre under the lowest island: falling off the
    // underdeep would have reset you before you had finished being scared.
    // -52 gives every part of the route a real fall under it and still resets
    // inside ~1.6 s at terminal velocity.
    this.killY = -52
    this._batches = new Map()
    this._rand = rng(0x5C0117)
  }

  /**
   * A surface you can stand on, run along, or vault. Visible AND solid.
   *
   * `opts` only ever changes the VISUAL. The collider is always the full
   * (sx, sy, sz) box centred on (cx, cy, cz), whatever else is passed:
   *
   *   bevel  override the automatic chamfer (0 disables it, for far scenery)
   *   size   visual box dimensions, defaulting to the collider's; combined
   *          with `rot` this is how a rotated wedge declares an upright AABB
   *   rot    `{ axis: 'x'|'y'|'z', angle }`; the visual box is shrunk if it
   *          needs to be so the rotation cannot push it outside the collider
   *   shade  flat multiplier on the baked vertex tint
   *   hidden emit the collider only — for when a generated mesh (see `mesh()`)
   *          is drawing this volume instead
   */
  solid(cx, cy, cz, sx, sy, sz, kind = 'porcelain', opts) {
    this.collision.addCenteredBox(cx, cy, cz, sx, sy, sz, kind)
    if (!opts || !opts.hidden) this._emit(kind, cx, cy, cz, sx, sy, sz, opts)
    return this
  }

  /** Scenery. Never solid, and never near enough to be mistaken for a route. */
  decor(cx, cy, cz, sx, sy, sz, kind = 'stone', opts) {
    if (!opts || !opts.hidden) this._emit(kind, cx, cy, cz, sx, sy, sz, opts)
    return this
  }

  /**
   * Attach a generated BufferGeometry to a material batch. VISUAL ONLY.
   *
   * This is docs/geometry-unlock.md's break in the representation link, and it
   * is deliberately one-way: a mesh can never create a collider, so the only
   * way to make something standable is still `solid()`. A prefab that wants a
   * real curve where a player will put a foot declares the collider with
   * `solid(..., { hidden: true })` and draws the curve here, and it is the
   * prefab's job to keep the curve inside that collider.
   *
   * The geometry is merged into the same per-kind batch as the boxes, so real
   * curves cost triangles but not draw calls.
   */
  mesh(kind, geo, matrix, opts = {}) {
    const b = this._batches.get(kind) || this._newBatch(kind)
    const pos = geo.attributes.position
    const nAttr = geo.attributes.normal
    const uvAttr = geo.attributes.uv
    const index = geo.index
    const count = pos.count
    const base = b.count
    const jitter = (0.93 + this._rand() * 0.13) * (opts.shade ?? 1)
    const uvScale = opts.uvScale ?? TEX_PER_METRE

    _nrm.getNormalMatrix(matrix)

    // Two passes so the contact-shading ramp can be measured against the
    // mesh's own base, exactly as the box path measures against `minY`.
    const wp = new Float64Array(count * 3)
    let minY = Infinity
    for (let i = 0; i < count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(matrix)
      wp[i * 3] = _v.x; wp[i * 3 + 1] = _v.y; wp[i * 3 + 2] = _v.z
      if (_v.y < minY) minY = _v.y
    }

    for (let i = 0; i < count; i++) {
      const y = wp[i * 3 + 1]
      b.pos.push(wp[i * 3], y, wp[i * 3 + 2])
      _v.fromBufferAttribute(nAttr, i).applyMatrix3(_nrm).normalize()
      b.norm.push(_v.x, _v.y, _v.z)
      b.uv.push(uvAttr ? uvAttr.getX(i) * uvScale : 0,
                uvAttr ? uvAttr.getY(i) * uvScale : 0)
      let shade = 0.70 + 0.30 * Math.min(1, (y - minY) / 1.0)
      if (_v.y > 0.5) shade = Math.min(1.12, shade + 0.10)
      else if (_v.y < -0.5) shade *= 0.72
      const t = shade * jitter
      b.col.push(t, t, t)
    }

    if (index) for (let i = 0; i < index.count; i++) b.idx.push(base + index.getX(i))
    else for (let i = 0; i < count; i++) b.idx.push(base + i)
    b.count += count
    // These geometries exist only to be copied into the batch; nothing ever
    // uploads them, so hand the buffers back at once rather than at load-end.
    geo.dispose()
    return this
  }

  /**
   * A solid mass with a carved profile: full-width plinth, inset body, full
   * -width cornice. Three courses instead of one box, which is the whole
   * difference between a wall and a plank.
   *
   * The union's footprint and its TOP FACE are exactly the box you asked for,
   * so this is a drop-in replacement for `solid()` even where a mantle height
   * or a landing edge is load-bearing. It insets the *middle*, never the
   * extremes — an inset top would move a vault height, and an inset face
   * would put a step in a wall-run.
   */
  massif(cx, cy, cz, sx, sy, sz, kind = 'porcelain', capKind = kind) {
    const top = cy + sy / 2
    const bot = cy - sy / 2
    // Trim depth is capped in absolute terms as well as proportionally: a
    // 12 m wall wants a 22 cm cornice, not a 2.4 m one.
    const cap = Math.min(0.22, sy * 0.2)
    const plinth = Math.min(0.30, sy * 0.18)
    const inset = Math.min(0.22, Math.min(sx, sz) * 0.12)
    this.solid(cx, top - cap / 2, cz, sx, cap, sz, capKind)
    this.solid(cx, bot + plinth / 2, cz, sx, plinth, sz, kind)
    this.solid(cx, (bot + plinth + top - cap) / 2, cz,
      sx - inset * 2, top - cap - bot - plinth, sz - inset * 2, kind)
    return this
  }

  checkpoint(x, y, z, label) {
    this.checkpoints.push({
      position: new THREE.Vector3(x, y, z),
      label,
      radius: 4.5,
      reached: false,
    })
    return this
  }

  /**
   * A brass lantern. Every lantern is also a grapple anchor.
   *
   * That is deliberate rather than convenient: brass has meant "you can use
   * this" since the first wall, so the anchors need no new visual language.
   * A player who has learned to read brass already knows where they can grab.
   *
   * Prefer `kit.lanternPost()` over calling this directly — a bare anchor is
   * an invisible affordance, and an invisible affordance is a tutorial you
   * forgot to write.
   */
  lantern(x, y, z, color = PALETTE.brass) {
    const position = new THREE.Vector3(x, y, z)
    this.lanterns.push({ position, color })
    this.anchors.push(position)
    return this
  }

  // ------------------------------------------------------------- geometry

  _newBatch(kind) {
    const b = { pos: [], norm: [], uv: [], col: [], idx: [], count: 0 }
    this._batches.set(kind, b)
    return b
  }

  /**
   * One chamfered box: 6 inset face quads, 12 edge quads, 8 corner triangles.
   *
   * 44 triangles instead of 12. That is the price of every arris in the world
   * catching a highlight, and on a scene that renders in ~3 ms it is the best
   * value purchase available — see BEVEL_MAX above for why a 90-degree edge is
   * the specific thing that makes generated architecture read as programmer
   * art. `bevel: 0` restores the old 12-triangle box and is used for the far
   * scenery bands, where a 4 cm chamfer is well under a pixel.
   */
  _emit(kind, cx, cy, cz, sx, sy, sz, opts) {
    const b = this._batches.get(kind) || this._newBatch(kind)

    // The collider is (sx, sy, sz). The VISUAL box may be smaller and may be
    // rotated; it may never be larger, so `hit` is the half-extent we test
    // against and `h` is what we actually draw.
    const hit = [sx / 2, sy / 2, sz / 2]
    const vis = opts && opts.size ? opts.size : null
    const h = vis ? [vis[0] / 2, vis[1] / 2, vis[2] / 2] : [hit[0], hit[1], hit[2]]

    // Rotation, as a single-axis turn. A quaternion channel would be more
    // general and would also let a solid escape its collider in three axes at
    // once; one axis covers voussoirs, gear teeth and tilted boulders, and
    // stays trivially provable against the AABB.
    const rot = opts && opts.rot && opts.rot.angle ? opts.rot : null
    let ra = -1, ca = 1, sa = 0, ri = 0, rj = 0
    if (rot) {
      ra = rot.axis === 'x' ? 0 : rot.axis === 'y' ? 1 : 2
      ri = (ra + 1) % 3; rj = (ra + 2) % 3
      ca = Math.cos(rot.angle); sa = Math.sin(rot.angle)
      const C = Math.abs(ca), S = Math.abs(sa)
      // Shrink until the rotated box fits back inside the collider. This is
      // the whole safety argument for the rotation channel: a rotated solid
      // can never present a face the collision world does not know about.
      // `fit: false` opts out and is for decor only — there is no collider to
      // escape from, and a shrunk decor lump is just a smaller lump.
      if (opts.fit !== false) {
        const p = h[ri], q = h[rj]
        const k = Math.min(hit[ri] / (p * C + q * S), hit[rj] / (p * S + q * C), 1)
        h[ri] = p * k; h[rj] = q * k
      }
    }

    let bev = opts && opts.bevel !== undefined
      ? opts.bevel
      : Math.min(BEVEL_MAX, BEVEL_FRAC * Math.min(h[0], h[1], h[2]) * 2)
    // A bevel wider than the box itself inverts the face quads.
    bev = Math.min(bev, Math.min(h[0], h[1], h[2]) * 0.49)

    // Per-box tint jitter so repeated shapes never read as clones.
    const jitter = (0.93 + this._rand() * 0.13) * ((opts && opts.shade) || 1)
    // The contact ramp measures from the box's world base, so it has to know
    // the rotated extent rather than the drawn half-height.
    const hyRot = ra === 1 || !rot
      ? h[1]
      : (ri === 1 ? h[1] * Math.abs(ca) + h[rj] * Math.abs(sa)
                  : h[ri] * Math.abs(sa) + h[1] * Math.abs(ca))
    const minY = cy - hyRot

    const rotate = (p) => {
      if (!rot) return p
      const a = p[ri], c = p[rj]
      p[ri] = a * ca - c * sa
      p[rj] = a * sa + c * ca
      return p
    }

    const push = (verts, n, fi, lift) => {
      const f = FACES[fi]
      const eU = Math.abs(f.u[0]) * h[0] + Math.abs(f.u[1]) * h[1] + Math.abs(f.u[2]) * h[2]
      const eV = Math.abs(f.v[0]) * h[0] + Math.abs(f.v[1]) * h[1] + Math.abs(f.v[2]) * h[2]
      const N = rotate([n[0], n[1], n[2]])
      const base = b.count
      faceOut(verts, n)
      for (const p0 of verts) {
        // UVs come off the UNROTATED local point, so a rotated voussoir keeps
        // its stone courses running along the block rather than through it.
        const u = p0[0] * f.u[0] + p0[1] * f.u[1] + p0[2] * f.u[2]
        const v = p0[0] * f.v[0] + p0[1] * f.v[1] + p0[2] * f.v[2]
        const p = rotate([p0[0], p0[1], p0[2]])
        const y = cy + p[1]
        b.pos.push(cx + p[0], y, cz + p[2])
        b.norm.push(N[0], N[1], N[2])
        b.uv.push((u + eU) * TEX_PER_METRE, (v + eV) * TEX_PER_METRE)

        // Baked contact shading: darken the first metre above each box's base
        // so masses sit on each other instead of floating, and lift upward
        // faces so the sky reads as the light source.
        let shade = 0.70 + 0.30 * Math.min(1, (y - minY) / 1.0)
        if (N[1] > 0.5) shade = Math.min(1.12, shade + 0.10)
        else if (N[1] < -0.5) shade *= 0.72
        const t = shade * jitter * lift
        b.col.push(t, t, t)
      }
      if (verts.length === 4) {
        b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
      } else {
        b.idx.push(base, base + 1, base + 2)
      }
      b.count += verts.length
    }

    // --- the six faces, inset by the bevel in both tangent directions ------
    for (let a = 0; a < 3; a++) {
      for (const s of [1, -1]) {
        const fi = a * 2 + (s > 0 ? 0 : 1)
        const f = FACES[fi]
        const eU = Math.abs(f.u[0]) * h[0] + Math.abs(f.u[1]) * h[1] + Math.abs(f.u[2]) * h[2]
        const eV = Math.abs(f.v[0]) * h[0] + Math.abs(f.v[1]) * h[1] + Math.abs(f.v[2]) * h[2]
        const n = [0, 0, 0]; n[a] = s
        const verts = []
        for (const [su, sv] of QUAD) {
          const p = [0, 0, 0]
          p[a] = s * h[a]
          for (let k = 0; k < 3; k++) {
            p[k] += f.u[k] * su * (eU - bev) + f.v[k] * sv * (eV - bev)
          }
          verts.push(p)
        }
        push(verts, n, fi, 1)
      }
    }

    if (bev <= 0.0005) return

    // --- twelve edge quads, normals at 45 degrees -------------------------
    const R2 = Math.SQRT1_2
    for (let a = 0; a < 3; a++) {
      for (let e = a + 1; e < 3; e++) {
        const c = 3 - a - e            // the axis the edge runs along
        for (const sa2 of [1, -1]) {
          for (const sb of [1, -1]) {
            const n = [0, 0, 0]
            n[a] = sa2 * R2; n[e] = sb * R2
            const at = (onA, tc) => {
              const p = [0, 0, 0]
              p[a] = sa2 * (onA ? h[a] : h[a] - bev)
              p[e] = sb * (onA ? h[e] - bev : h[e])
              p[c] = tc * (h[c] - bev)
              return p
            }
            const lift = n[1] > 0.3 ? TOP_EDGE_LIFT : n[1] < -0.3 ? BOT_EDGE_DROP : 1
            push([at(true, -1), at(true, 1), at(false, 1), at(false, -1)],
              n, a * 2 + (sa2 > 0 ? 0 : 1), lift)
          }
        }
      }
    }

    // --- eight corner triangles -------------------------------------------
    const R3 = 1 / Math.sqrt(3)
    for (const s0 of [1, -1]) {
      for (const s1 of [1, -1]) {
        for (const s2 of [1, -1]) {
          const n = [s0 * R3, s1 * R3, s2 * R3]
          push([
            [s0 * h[0], s1 * (h[1] - bev), s2 * (h[2] - bev)],
            [s0 * (h[0] - bev), s1 * h[1], s2 * (h[2] - bev)],
            [s0 * (h[0] - bev), s1 * (h[1] - bev), s2 * h[2]],
          ], n, s0 > 0 ? 0 : 1, s1 > 0 ? TOP_EDGE_LIFT : BOT_EDGE_DROP)
        }
      }
    }
  }

  build() {
    for (const [kind, b] of this._batches) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.norm, 3))
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2))
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3))
      g.setIndex(b.idx)
      g.computeBoundingSphere()

      const mesh = new THREE.Mesh(g, surfaceMaterial(kind))
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.name = `surface:${kind}`
      this.group.add(mesh)
    }

    // Lanterns: emissive markers that read as waypoints, deliberately small
    // and never on the running line.
    if (this.lanterns.length) {
      const geo = new THREE.IcosahedronGeometry(0.34, 1)
      const mat = glowMaterial(PALETTE.brass, 2.2)
      const inst = new THREE.InstancedMesh(geo, mat, this.lanterns.length)
      const m = new THREE.Matrix4()
      this.lanterns.forEach((l, i) => {
        m.makeTranslation(l.position.x, l.position.y, l.position.z)
        inst.setMatrixAt(i, m)
      })
      inst.instanceMatrix.needsUpdate = true
      inst.name = 'lanterns'
      this.group.add(inst)
    }

    if (this.beaconAt) this.group.add(this._beacon())
    if (this.checkpoints.length) this.group.add(this._gates())

    return this.group
  }

  /**
   * THE CHECKPOINT GATE. The next objective, readable at 47 km/h.
   *
   * The critique was specific: the old gate was "a thin low-contrast brass wire
   * ring at the right edge of frame, off the running line — it will not be seen
   * at 47 km/h". Three things were wrong and all three are fixed here.
   *
   * 1. IT WAS OFF THE LINE. This one is centred on the checkpoint sphere the
   *    game actually tests, at 2.5 m — chest height for a runner — so the thing
   *    you aim at and the thing you trigger are the same thing.
   * 2. IT WAS FLAT-ON ONLY. Each gate is a VIEW-FACING quad, so it presents the
   *    same full circle whether you arrive down the run line, off a grapple, or
   *    falling past it. A ring in a fixed plane is invisible edge-on, which at
   *    an archipelago's approach angles is most of the time.
   * 3. IT DID NOT SAY WHICH ONE. State is per-checkpoint: the NEXT one burns
   *    hot with a rotating three-arc collar and a 12 m light column standing
   *    over it so it clears the island's own skyline; the ones after it are a
   *    faint outline; reached ones switch off. The column is what you steer by
   *    from 200 m, the ring is what you land in from 20 m.
   *
   * One quad per checkpoint, one draw call, no per-frame allocation: the state
   * vector is written in place in `onBeforeRender` from flags the game is
   * already maintaining, and the animation is a clock the shader reads.
   */
  _gates() {
    const cps = this.checkpoints
    const N = Math.min(cps.length, MAX_GATES)
    const pos = new Float32Array(N * 4 * 3)
    const uv = new Float32Array(N * 4 * 2)
    const idx = []
    for (let i = 0; i < N; i++) {
      const p = cps[i].position
      for (let k = 0; k < 4; k++) {
        const j = i * 4 + k
        // Every vertex carries the gate's world anchor; the quad's own extent
        // is built in view space so it can never turn edge-on to the camera.
        pos[j * 3] = p.x; pos[j * 3 + 1] = p.y; pos[j * 3 + 2] = p.z
        uv[j * 2] = QUAD[k][0] > 0 ? 1 : 0
        uv[j * 2 + 1] = QUAD[k][1] > 0 ? 1 : 0
      }
      const b = i * 4
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
    // Per-gate state, read by index: 0 = passed, 1 = next, 2 = later.
    const state = new Float32Array(MAX_GATES)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setAttribute('gateId', new THREE.Float32BufferAttribute(
      Float32Array.from({ length: N * 4 }, (_, j) => (j / 4) | 0), 1))
    geo.setIndex(idx)

    const uniforms = {
      uTime: { value: 0 },
      uState: { value: state },
      uHot: { value: new THREE.Color(0xffc266) },
      uCool: { value: new THREE.Color(0x9fd8c8) },
    }
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,       // wayfinding outranks occlusion, always
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms,
      vertexShader: /* glsl */`
        attribute float gateId;
        uniform float uState[${MAX_GATES}];
        varying vec2 vUv;
        varying float vDist;
        varying float vState;
        void main() {
          vUv = uv;
          vState = uState[int(gateId)];
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // GATE_W x GATE_H metres of view-space billboard, anchored so the
          // ring sits at RING_Y above the checkpoint and the column runs up.
          mv.x += (uv.x - 0.5) * ${GATE_W.toFixed(1)};
          mv.y += (uv.y * ${GATE_H.toFixed(1)}) - ${(GATE_H * 0.18).toFixed(2)};
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform vec3 uHot;
        uniform vec3 uCool;
        varying vec2 vUv;
        varying float vDist;
        varying float vState;
        void main() {
          // ONLY THE NEXT ONE. Depth test is off so a gate is never cut by
          // architecture, and the price of that is that a gate behind a wall
          // still draws — with every unreached checkpoint lit, the view up
          // from the deep came back with three faint rings floating on a
          // sandstone face two metres from the lens, reading as dirt on the
          // glass. One objective at a time is also the clearer instruction.
          if (vState < 0.5 || vState > 1.5) discard;
          float next = 1.0;

          // --- the ring ------------------------------------------------
          // Placed in the lower fifth of the quad, so RING_Y above the deck.
          vec2 rp = vec2((vUv.x - 0.5) * ${GATE_W.toFixed(1)},
                         (vUv.y * ${GATE_H.toFixed(1)}) - ${(GATE_H * 0.18 + 2.5).toFixed(2)});
          float r = length(rp);
          float ring = exp(-pow((r - 2.6) / 0.34, 2.0));
          // Three arcs that turn: a moving pattern is what the eye catches in
          // peripheral vision, and rotation cannot be confused with a z-seam.
          float ang = atan(rp.y, rp.x) + uTime * 0.9;
          float arcs = smoothstep(0.35, 0.75, abs(sin(ang * 1.5)));
          ring *= mix(0.42, 1.0, arcs);

          // --- the column ----------------------------------------------
          // Gaussian across, so there is no step edge for the composite's
          // sharpen pass to undershoot into a black outline.
          float ax = abs(vUv.x - 0.5) * 2.0;
          float col = exp(-ax * ax * 7.0);
          col *= smoothstep(0.16, 0.26, vUv.y) * (1.0 - smoothstep(0.3, 1.0, vUv.y));

          // 0.4 Hz breath, on the next gate only — a steady light reads as
          // architecture, a breathing one reads as an instrument.
          float pulse = 0.82 + 0.18 * sin(uTime * 2.513);
          float a = (ring * 1.0 + col * 0.5) * mix(0.20, 1.0, next) * mix(1.0, pulse, next);
          // Hold up at range and get out of the way once you have arrived.
          a *= mix(0.55, 1.0, smoothstep(220.0, 40.0, vDist));
          a *= smoothstep(5.0, 16.0, vDist);
          vec3 c = mix(uCool, uHot, next);
          // Core above the AgX knee so the tone curve renders it as light
          // rather than as a pale grey stripe.
          gl_FragColor = vec4(c * mix(1.0, 2.6, next), a * 0.7);
        }
      `,
    })

    const m = new THREE.Mesh(geo, mat)
    m.name = 'checkpoint-gates'
    m.renderOrder = 20
    m.frustumCulled = false     // the quad's real extent is a shader product
    m.onBeforeRender = () => {
      uniforms.uTime.value = performance.now() * 0.001
      let next = -1
      for (let i = 0; i < N; i++) if (!cps[i].reached) { next = i; break }
      for (let i = 0; i < N; i++) state[i] = cps[i].reached ? 0 : (i === next ? 1 : 2)
    }
    return m
  }

  /**
   * The goal beacon: a warm light shaft standing over the observatory.
   *
   * Twenty islands are visible from any long air phase and, until this, not
   * one of them was marked. taste.md asks the player to "read the route
   * without a tutorial", and every shipped game in the genre solves that with
   * a single unmistakable horizon cue before it solves anything else.
   *
   * It is drawn, not lit: additive, no depth write, and faded out inside 55 m
   * so it is a horizon marker and never a wall of glare in the last section.
   * There is no collider and no possible reading as a surface — a column of
   * light is not a ledge.
   */
  _beacon() {
    const { x, y, z, height, radius } = this.beaconAt
    // A VIEW-SPACE BILLBOARD, not a cylinder, and that is not a shortcut.
    //
    // The first version was an additive cylinder shell, and it came back from
    // the harness with hard black outlines down both silhouettes. The cause is
    // the composite's contrast-adaptive sharpen: a cylinder's alpha has an
    // INFINITE screen-space derivative at its silhouette, however soft the
    // shader makes the middle, and a step edge in a flat sky is the one input
    // CAS undershoots into black on. A quad expanded along the view's X axis
    // with a gaussian across it has a smooth profile with zero value AND zero
    // slope at both edges, so there is no edge for a sharpen filter to find.
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1)
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      // Depth test off, drawn after the opaques: the critique found "the arch
      // keystone bisects it" in tower.png. A landmark that architecture can cut
      // in half is a landmark you learn to distrust.
      depthTest: false,
      uniforms: {
        uColor: { value: new THREE.Color(0xffd08a) },
        uRadius: { value: radius },
        uHeight: { value: height },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */`
        uniform float uRadius;
        uniform float uHeight;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          vUv = uv;
          // The axis in view space, then a purely horizontal spread. View
          // space is a rigid transform of world space, so uRadius is still
          // metres after the offset. The quad reaches BELOW the anchor as well
          // as above it, because the ground flare needs somewhere to live.
          vec4 mv = modelViewMatrix * vec4(0.0, (uv.y * 1.06 - 0.06) * uHeight, 0.0, 1.0);
          mv.x += (uv.x - 0.5) * 2.0 * uRadius * mix(2.6, 2.2, uv.y);
          vDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        uniform float uTime;
        varying vec2 vUv;
        varying float vDist;
        void main() {
          // 0.4 Hz breath on radius AND intensity. The old shaft was a uniform
          // non-animated stripe measured at ~4 px, "barely brighter than the
          // sky" and indistinguishable from a z-seam. Nothing in a sunset sky
          // pulses; this does, and that is the whole read.
          float breath = sin(uTime * 2.513);
          float wide = 1.0 + 0.16 * breath;

          float ax = abs(vUv.x - 0.5) * 2.0;
          float w = max(0.0, 1.0 - ax * ax);

          // --- the shaft --------------------------------------------------
          // Held to full value for the first third of its height instead of
          // decaying from the base, so the part nearest the dome is the part
          // that is actually bright.
          float v = clamp((vUv.y - 0.057) / 0.943, 0.0, 1.0);
          float shaft = smoothstep(0.0, 0.02, v) * (1.0 - smoothstep(0.28, 1.0, v));
          shaft *= exp(-ax * ax * 2.1 / (wide * wide)) * w * w;
          // A hot narrow core inside the soft body: this is the part that has
          // to survive the AgX shoulder, so it is nearly four times the body's
          // value across a fifth of its width.
          float core = exp(-ax * ax * 24.0) * shaft;

          // --- the ground flare -------------------------------------------
          // A disc of light where the shaft meets the dome. Without it the
          // shaft reads as a decal hanging in the air rather than as something
          // standing ON the landmark it is naming.
          float fy = (vUv.y - 0.057) * ${height.toFixed(1)};
          float fr = length(vec2(ax * ${(radius * 2.2).toFixed(2)}, fy * 2.2));
          float flare = exp(-pow(fr / (${(radius * 1.5).toFixed(2)} * wide), 2.0));

          float a = shaft * 0.62 + flare * 0.5;
          // Match the scene's exponential haze, but keep a floor — a beacon
          // that the fog eats at 300 m is not a beacon.
          float fog = exp(-pow(vDist * 0.0052, 2.0));
          a *= mix(0.5, 1.0, fog);
          // And get out of the way once the player has actually arrived.
          a *= smoothstep(14.0, 55.0, vDist);
          a *= 0.9 + 0.1 * breath;
          vec3 c = uColor * (1.0 + core * 3.4 + flare * 1.6);
          gl_FragColor = vec4(c, a);
        }
      `,
    })
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z)
    m.name = 'goal-beacon'
    m.renderOrder = 18
    m.onBeforeRender = () => { mat.uniforms.uTime.value = performance.now() * 0.001 }
    // One quad whose real extent is computed in the vertex shader, so three's
    // bounding sphere would cull it the moment the camera looks slightly off.
    m.frustumCulled = false
    return m
  }
}

// ------------------------------------------------------------ deck presets

/**
 * Two island profiles, because the archipelago has two kinds of ground.
 *
 * `BUILT` is masonry the courier service laid: sandstone paving over a rock
 * drum. `WILD` is a rock the garden took back: a moss mat over the same drum.
 * Both keep the moss/paving cap as a THIN course proud of a narrower rim, so
 * the cap overhangs and shadows the rock instead of presenting a metre of
 * grass texture down a vertical face.
 */
/**
 * TERRACOTTA IS RESERVED. It appears on route-critical surfaces and nowhere
 * else, which is why both deck presets rim with it.
 *
 * The art review found the one saturated hue in the palette spent on
 * balustrade coping, colonnade cornices and scenery-island rims — decoration
 * that carries no information — while twenty islands were visible from the
 * vista with nothing marking which one was the route. taste.md is explicit:
 * "Surfaces you can use are legible by color and shape alone." So the rule is
 * now mechanical: terracotta means *the route acts here*. Route decks wear a
 * warm band directly under the cap, vault blocks are capped in it, and every
 * scenery island rims in plain stone. From the air the route reads as a chain
 * of warm-rimmed islands in a field of cool ones; on the ground the same band
 * is the landing lip you aim a jump at.
 */
const BUILT = { capKind: 'porcelain', rimKind: 'terracotta', kind: 'stone', boulderKind: 'stone' }
const WILD = { capKind: 'moss', rimKind: 'terracotta', kind: 'stone', boulderKind: 'stone' }

/**
 * Facet count is chosen by aspect ratio, not by taste.
 *
 * `drumPlatform` approximates a disc, and `squash` turns that disc into an
 * ellipse. Facet an ellipse whose aspect is 3:1 and the ends taper to a
 * point — which is charming on a boulder and lethal on a 30 m terrace you
 * spawn at the end of. So: long decks get facets 1 (a rectangle whose
 * silhouette comes from the overhanging cap and the tapering underside),
 * near-square ones get the full rounded read.
 */
function facetsFor(lengthX, lengthZ) {
  const aspect = Math.max(lengthX, lengthZ) / Math.min(lengthX, lengthZ)
  // 5 rather than 4 on the near-square case: the moss skirt smooths the
  // outline it hangs off, but it cannot smooth the CAP'S TOP FACE, and from
  // any airborne shot the top face is most of what you see. Each extra facet
  // halves the depth of the steps in it for one more box per course.
  return aspect > 2.0 ? 1 : aspect > 1.4 ? 2 : 5
}

/**
 * The opening leg of the route.
 *
 * Each section teaches exactly one verb in isolation, then the last two
 * sections demand them in combination. Nothing is explained in text: a brass
 * surface is always something to wall-run, moss is always somewhere safe to
 * land, and every gap is sized so that the correct technique clears it with
 * room while the wrong one does not.
 *
 * Section coordinates on the original seven-checkpoint spine (x 0..229) are
 * FROZEN: deck tops, wall faces and the underpass clearance are read directly
 * by `tools/shots.mjs`, and by the player's muscle memory. The kit dresses
 * those volumes; it does not move them.
 */
export function buildCourse(collision) {
  const L = new Level(collision)
  const K = trackedKit()
  L.spawn.set(4, 1.4, 0)

  // A deck helper that keeps every island honest: the drum's footprint IS its
  // collider (art-direction.md's collision caveat), and the caller passes the
  // walkable top height directly, so a platform can be placed straight off a
  // jump arc.
  const A = new Archipelago()
  //
  // `id` is not decoration. Passing one registers the island in the
  // archipelago graph with the SAME extents the collider gets, which is what
  // makes "graph first, geometry second" a mechanism instead of a promise: an
  // island the graph has never heard of cannot be linked, and an island with
  // no link fails the build.
  const deck = (x, y, z, lenX, lenZ, style, opts = {}) => {
    if (opts.id) A.node(opts.id, x, y, z, lenX, lenZ, { launchY: opts.launchY })
    return K.drumPlatform(L, x, y, z, {
      radius: lenX / 2,
      squash: lenZ / lenX,
      facets: facetsFor(lenX, lenZ),
      ...style,
      ...opts,
    })
  }

  // ---- Section 1: the colonnaded terrace. Run, sprint, feel the friction. --
  //
  // The establishing shot lives here, so the priority is that it establishes
  // something. The old terrace was 16 m wide between two 2.8 m parapets: an
  // orange corridor with no visible edge, no void and no archipelago, which
  // is the one thing a floating-island game cannot afford in its first frame.
  // Now the deck is 10.4 m wide, the parapet is 1.0 m (vault height — it reads
  // as an affordance rather than a fence) and covers only the first 13 m, and
  // the far side is an open colonnade you see straight through. The drop is
  // visible from the spawn on both sides.
  deck(14, 0, 0, 30, 10.4, BUILT, { bodyDepth: 3.2, capThickness: 0.5, id: 'terrace' })
  K.colonnade(L, 5, 0, 4.0, {
    count: 6, spacing: 4.2, height: 4.2, radius: 0.5,
  })
  K.balustrade(L, 0.5, 0, -4.7, { length: 13, height: 1.0, thickness: 0.45 })

  // Low blocks to run over — the vault, before you know it is a vault. The
  // CAP is terracotta and the body is sandstone, which is the reserved-hue
  // rule applied literally: the accent goes on the face you put a hand or a
  // foot on, not on the mass underneath it.
  L.massif(20, 0.35, -2.2, 2.4, 0.8, 3.0, 'porcelain', 'terracotta')
  L.massif(24, 0.5, 2.4, 2.4, 1.1, 3.0, 'porcelain', 'terracotta')

  // The premise, hung off the edge the player can now see: water falling out
  // of a garden into open sky.
  K.waterfall(L, 26.5, -0.55, -5.0, { height: 30, width: 2.0 })
  K.vineCurtain(L, 15, -0.55, -5.1, { length: 12, drop: 5 })
  K.vineCurtain(L, 8, -0.55, 5.1, { length: 10, drop: 4 })

  L.checkpoint(4, 1.4, 0, 'terrace')
  // Corner standards, hard against the parapet line so nothing solid is ever
  // in the running lane, plus a bracket anchor slung under the colonnade.
  K.lanternPost(L, 1.6, 0, -4.7, { height: 3.2 })
  K.lanternPost(L, 27.6, 0, 4.6, { height: 3.4 })
  K.lanternPost(L, 13.4, 4.9, 4.0, { post: false, reach: -2.4, axis: 'z', height: 0.9 })

  // ---- Section 2: gap jumps. Momentum is the only way across. -----------
  // Three wild drums: moss over rock, vines off the lip, and a fall off the
  // middle one so the void between them has something in it.
  deck(38, 0, 0, 10, 12, WILD, { id: 'gap-1' })
  deck(52, 0, 1.5, 10, 12, WILD, { id: 'gap-2' })
  deck(67, 0, -1.0, 11, 13, WILD, { id: 'gap-3' })
  K.waterfall(L, 52, -0.4, 7.2, { height: 26, width: 1.8 })
  K.cypress(L, 69.4, 0, 4.0, { height: 6.5 })
  K.cypress(L, 65.0, 0, -5.4, { height: 5.2 })
  K.cypress(L, 36.2, 0, 4.6, { height: 5.8 })
  L.checkpoint(38, 1.4, 0, 'the gaps')
  K.lanternPost(L, 38, 0, -5.2, { height: 3.0 })
  K.lanternPost(L, 52, 0, 6.6, { height: 3.2 })

  // ---- Section 3: the arched viaduct. Ledges at exactly mantle height. ---
  // Same deck volume as before (x 73..95, z ±7, top y=0), but carried on a
  // three-bay arcade instead of hanging in the air on nothing. `facets: 1` is
  // deliberate against the aspect rule: an elliptical footprint would pull the
  // deck edge inboard of the piers, and a pier standing outside the thing it
  // carries is worse than a square corner.
  deck(84, 0, 0, 22, 14, BUILT, { bodyDepth: 3.2, facets: 1, id: 'viaduct' })
  for (const ax of [77, 84, 91]) {
    K.archway(L, ax, -12.6, 0, {
      axis: 'z', span: 7, pierWidth: 1.6, depth: 2.4, springHeight: 4.8,
      detail: 1, kind: 'porcelain',
    })
    // Pier feet, tapering into cloud. Solid, because they are directly under
    // a deck edge the player will fall past and a rock you drop through is
    // the same lie as a platform you drop through.
    for (const s of [-1, 1]) {
      L.solid(ax, -13.6, s * 4.3, 2.8, 2.0, 2.0, 'stone')
      L.solid(ax, -16.4, s * 4.3, 2.0, 3.6, 1.4, 'stone')
    }
  }
  // The vault line itself: three carved ledges, 12 m across so there is no
  // running around them. Mantle heights 0.9 / 1.1 / 0.7 are unchanged.
  L.massif(78, 0.45, 0, 1.6, 0.9, 12, 'porcelain', 'terracotta')
  L.massif(84, 0.55, 0, 1.6, 1.1, 12, 'porcelain', 'terracotta')
  L.massif(90, 0.35, 0, 1.6, 0.7, 12, 'porcelain', 'terracotta')
  K.balustrade(L, 75, 0, 6.5, { length: 18, height: 1.05, thickness: 0.45 })
  K.vineCurtain(L, 76, -0.5, -6.9, { length: 16, drop: 5.5 })
  K.waterfall(L, 93.5, -0.45, -6.6, { height: 28, width: 2.2 })
  L.checkpoint(76, 1.4, 0, 'the ledges')
  K.lanternPost(L, 74.4, 0, -6.4, { height: 3.2 })
  K.lanternPost(L, 94.2, 0, 6.4, { height: 3.2 })

  // ---- Section 4: the wall-run crossing. Brass means runnable. ----------
  // One long wall over a void. The approach ledge deliberately hugs it, so a
  // player running the obvious line is already inside the wall's reach when
  // the floor disappears — the technique gets taught by the geometry rather
  // than by a prompt. A corridor with the wall metres away teaches nothing,
  // because you never touch it.
  //
  // THE CONSTRAINT ON DRESSING THIS WALL: the run face at z = -4.0 must stay
  // dead flat over the full 32 m. A wall-run does not survive a pilaster every
  // four metres, so every piece of ornament goes BEHIND the face, ABOVE the
  // cornice, or BELOW the plinth — never proud of the running plane.
  //
  // The plane is broken in three ways that all respect that constraint.
  // (1) The run face is emitted as alternating 5.4 m bays and 0.6 m piers, all
  //     coplanar and all brass, differing only in baked tint. The collider
  //     union is bit-identical to the single 32 m box it replaces, and the
  //     chamfer between neighbours draws a 9 cm reveal down the wall every
  //     6 m — articulation the eye reads, and that a shoulder cannot.
  // (2) A flush string course at y≈8, again a tint change and not a profile.
  // (3) Everything with real depth is stacked ABOVE the cornice at y=10.8,
  //     where a wall-runner has already left the wall.
  // Field height 10.1 m (y -2.0 .. 8.1); the two flush courses above it carry
  // the run face on up to y=10 so the collider union is unchanged.
  const WALL_X0 = 86.0, WALL_JAMB = 1.2, WALL_BAYS = 5
  const bayW = (32 - WALL_JAMB * 2) / WALL_BAYS       // 5.92 m
  const pierW = 0.62
  for (let i = 0; i < WALL_BAYS; i++) {
    const x0 = WALL_X0 + WALL_JAMB + i * bayW
    L.solid(x0 + (bayW - pierW) / 2, 3.05, -4.35, bayW - pierW, 10.1, 0.7, 'brass')
    L.solid(x0 + bayW - pierW / 2, 3.05, -4.35, pierW, 10.1, 0.7, 'brass', { shade: 0.82 })
  }
  // Entry and exit jambs. Terracotta is the reserved route hue and this is the
  // one place on a 32 m brass wall where it belongs: it names the door, at the
  // two metres of wall that are approach and dismount rather than run.
  L.solid(86.6, 3.05, -4.35, 1.2, 10.1, 0.7, 'terracotta')
  L.solid(117.4, 3.05, -4.35, 1.2, 10.1, 0.7, 'terracotta')
  L.solid(102, 8.55, -4.35, 32, 0.9, 0.7, 'brass', { shade: 1.12 })  // string course
  L.solid(102, 9.5, -4.35, 32, 1.0, 0.7, 'brass')                    // frieze
  L.solid(102, 3.4, -5.3, 32, 13.2, 1.2, 'brass')     // back mass
  L.solid(102, -1.6, -5.0, 32.6, 1.4, 2.4, 'brass')   // plinth, below the void lip
  L.solid(102, 10.4, -5.0, 33, 0.8, 2.6, 'porcelain')  // cornice, 40 cm proud at y=10
  L.solid(102, 6.4, -6.1, 32.4, 0.5, 0.6, 'brass')     // back string course
  for (const bx of [88, 96, 104, 112]) {
    L.massif(bx, 3.0, -6.3, 1.8, 14, 1.0, 'porcelain') // back buttresses
  }
  // Pilaster caps on the skyline. These stand 0.35 m proud and are the only
  // thing on this wall that breaks its profile — legal because their feet are
  // at y=10.8, four metres above the highest reachable wall-run.
  for (const px of [89.5, 96.5, 107.5, 114.5]) {
    L.massif(px, 12.0, -5.0, 1.5, 2.6, 3.3, 'porcelain', 'brass')
  }
  // The machinery that supposedly drives the wall, mounted where a wall-runner
  // can never clip it: teeth start at y ≈ 10.8, above the cornice.
  L.solid(102, 14.2, -5.6, 24, 0.55, 0.55, 'brass')   // drive axle
  K.gearWheel(L, 92, 13.8, -5.0, { radius: 2.6, plane: 'xy', spokes: 6, solidRim: true, detail: 1 })
  K.gearWheel(L, 102, 14.6, -5.0, { radius: 3.4, plane: 'xy', spokes: 8, solidRim: true })
  K.gearWheel(L, 112, 13.8, -5.0, { radius: 2.6, plane: 'xy', spokes: 6, solidRim: true, detail: 1 })

  // Approach ledge, now a spur of the same viaduct: top y=0, ends at x=100.
  L.solid(93, -0.5, -3.2, 14, 1, 2.6, 'porcelain')
  L.solid(93, -1.35, -3.2, 14, 0.7, 3.6, 'porcelain')  // corbel course under it
  for (const ax of [89, 95.5]) {
    K.archway(L, ax, -9.4, -3.2, {
      axis: 'z', span: 3.0, pierWidth: 0.9, depth: 1.8, springHeight: 5.0,
      detail: 1, kind: 'porcelain',
    })
  }
  deck(116, 0, -3.0, 13, 11, WILD, { id: 'crossing' })  // landing
  K.waterfall(L, 118, -0.4, -8.2, { height: 24, width: 1.9 })
  K.cypress(L, 120.4, 0, 1.4, { height: 6.2 })
  L.checkpoint(116, 1.4, -3.0, 'the crossing')
  // Anchor slung out over the void on a bracket, so the grapple line into the
  // crossing exists in space rather than inside the cornice.
  // Three brackets rather than one, on the new pilaster rhythm. A 32 m
  // crossing with a single mid-span anchor gives the grapple exactly one
  // moment; three turn the wall into a line a confident player can swing the
  // whole length of without ever touching the face. They hang 1.6 m out over
  // the void on the -Z side, so the anchor volume is in the flight path
  // instead of buried inside the cornice, and none of them has a floor
  // footprint to trip a wall-runner on.
  for (const ax of [91, 102, 113]) {
    K.lanternPost(L, ax, 10.8, -5.0, { post: false, reach: 1.6, axis: 'z', height: 0.9 })
  }
  K.lanternPost(L, 112, 0, -7.4, { height: 3.2 })

  // ---- Section 5: the slide. A ceiling too low to run under. ------------
  deck(140, 0, -1.5, 34, 16, BUILT, { bodyDepth: 3.4, id: 'underpass' })
  // 18 m of ceiling: long enough that you must arrive fast, short enough that
  // a correctly-timed slide clears it without the friction stranding you
  // halfway under a roof you cannot stand up inside. The underside stays at
  // 1.35 exactly; the mouldings are stacked ABOVE and AROUND it, never below.
  L.solid(140, 2.15, -1.5, 18, 1.6, 15, 'terracotta')    // underside 1.35
  L.solid(140, 1.5, -1.5, 18.6, 0.3, 15.4, 'porcelain')  // impost band, 1.35..1.65
  L.solid(140, 3.1, -1.5, 17.4, 0.3, 14.4, 'porcelain')  // 2.95..3.25
  L.solid(140, 3.55, -1.5, 18.4, 0.6, 15.2, 'terracotta') // cornice, top 3.85
  // Drive gears standing ON the lintel roof, 3 m and 15 m back from its front
  // face. Hung on the front face instead they sit six metres from the
  // approaching player's eye and fill the frame with one wheel — a machine
  // that hides the obstacle it drives is decoration doing damage. From the
  // roof they read at the right scale and the slot stays the subject. Lowest
  // tooth is at y ≈ 3.7, far above the 1.35 m slide slot, so nothing the
  // slide passes through is solid.
  for (const [gx, gz] of [[134, -5.6], [146, 2.6]]) {
    K.gearWheel(L, gx, 6.0, gz, { radius: 2.0, plane: 'zy', spokes: 6, solidRim: true })
  }
  // Brass edging either side of the slot: same signal as before, now a real
  // balustrade rather than two planks. `detail: 1` on purpose — at full
  // baluster pitch an 18 m run reads as a picket fence, not a rail.
  K.balustrade(L, 131, 0, -8.6, { length: 18, height: 1.5, thickness: 0.7, kind: 'brass', detail: 1 })
  K.balustrade(L, 131, 0, 5.6, { length: 18, height: 1.5, thickness: 0.7, kind: 'brass', detail: 1 })
  K.vineCurtain(L, 126, -0.5, -9.4, { length: 20, drop: 6 })
  K.waterfall(L, 152, -0.45, 6.4, { height: 30, width: 2.4 })
  L.checkpoint(126, 1.4, -1.5, 'the underpass')
  K.lanternPost(L, 133, 3.85, -8.0, { height: 2.6 })
  K.lanternPost(L, 147, 3.85, 5.0, { height: 2.6 })

  // ---- Section 6: the wall-jump chain. Everything, together. ------------
  // Faces sit at z = ±2.3, so the crossing is 4.6 m — comfortably inside one
  // wall-jump's outward kick, and impossible to walk. The pillars are battered
  // in X only: the running face has to stay one flat plane from y=-4.5 to
  // y=10.5, so all the taper, banding and machinery lives on the outboard
  // side where nobody's shoulder ever touches it.
  deck(156, 0, 0, 8, 10, BUILT, { id: 'chain-foot' })
  for (const [px, zc] of [[163, -3.0], [175, 3.0], [187, -3.0]]) {
    const dir = zc < 0 ? 1 : -1          // +1 when the run face is on the +Z side
    L.solid(px, -5.2, zc, 10.4, 1.4, 2.6, 'porcelain')   // plinth
    L.solid(px, -1.5, zc, 9.6, 6.0, 1.4, 'brass')        // lower course
    L.solid(px, 4.0, zc, 9.2, 5.0, 1.4, 'brass')         // middle course
    L.solid(px, 8.5, zc, 8.6, 4.0, 1.4, 'brass')         // upper course
    L.solid(px, 10.9, zc, 9.4, 0.8, 2.2, 'porcelain')    // capital, above the run
    L.solid(px, 3.2, zc - dir * 0.85, 9.4, 0.4, 0.5, 'brass') // outboard band
    K.gearWheel(L, px, 6.4, zc - dir * 0.95, {
      radius: 2.6, plane: 'xy', spokes: 6, solidRim: true, detail: 1,
    })
    // A second wheel lying flat on the capital. The outboard one faces away
    // from a player flying the chain and is only ever seen from the vista;
    // this one is the pillar's silhouette from underneath, which is the angle
    // the section is actually played at.
    K.gearWheel(L, px, 11.5, zc, {
      radius: 2.2, plane: 'xz', spokes: 6, solidRim: true, detail: 1,
    })
    // The anchor a chain-runner actually aims at, on a bracket off the capital
    // so it hangs in the flight path instead of inside the masonry.
    K.lanternPost(L, px, 11.3, zc, { post: false, reach: dir * 1.4, axis: 'z', height: 0.6 })
  }
  deck(197, 1.7, 0, 11, 12, WILD, { id: 'chain-head' })
  K.waterfall(L, 197, 1.3, 5.6, { height: 26, width: 2.0 })
  K.cypress(L, 199.6, 1.7, 3.2, { height: 6.0 })
  L.checkpoint(197, 3.0, 0, 'the chain')
  K.lanternPost(L, 193.5, 1.7, -4.6, { height: 3.2 })

  // ---- Section 7: the ascent and the observatory gate. ------------------
  // Same flight as before (8 × 0.55 m rise, 1.6 m run, 8 m wide) so the
  // ascent's rhythm is untouched, but carved: nosings, raking cheeks, newel
  // posts, and moss crept over the two steps that live in shade.
  K.stairFlight(L, 202, 1.5, 0, { steps: 8, rise: 0.55, run: 1.6, width: 8 })
  deck(222, 6.4, 0, 14, 14, WILD, { id: 'tower' })
  // A paved court laid across the moss plateau. It exists because the gate
  // architecture is rectangular and the plateau is not: without it the
  // colonnade's end columns stand off the rounded edge in mid-air.
  L.solid(222, 6.15, 0, 14.6, 0.5, 10.0, 'porcelain')
  L.solid(222, 5.75, 0, 13.8, 0.4, 9.2, 'porcelain')
  for (const cz of [-4.2, 4.2]) {
    K.colonnade(L, 217.2, 6.4, cz, {
      count: 4, spacing: 3.6, height: 3.6, radius: 0.48,
    })
    K.lanternPost(L, 220.8, 11.86, cz, {
      post: false, reach: cz < 0 ? 2.4 : -2.4, axis: 'z', height: 0.8,
    })
  }
  K.archway(L, 227.4, 6.4, 0, {
    axis: 'z', span: 6, pierWidth: 1.4, depth: 1.8, springHeight: 3.4,
  })
  K.lanternPost(L, 227.4, 13.64, 0, { post: false, height: 0.8 })
  K.vineCurtain(L, 218.2, 5.9, -5.2, { length: 7.6, drop: 6 })
  K.waterfall(L, 221, 5.95, -6.9, { height: 34, width: 2.4 })
  L.checkpoint(222, 7.0, 0, 'the tower')

  // ---- Section 8: the gearworks climb. -----------------------------------
  // Seven drums spiralling up the side of a brass machine. Every step is a
  // 2.0 m rise across a 1–3 m gap, which the double jump clears with room and
  // neither the dash nor the grapple is needed for — course-design.md's rule
  // that the safe line must never be gated on a charge. The fast line is the
  // lantern chain: each drum carries a standard, so a confident player can
  // grapple straight up the outside and skip four platforms.
  const CLIMB = [
    [237, 8.0, 0, 10, 9],
    [247, 10.0, -5.0, 8, 8],
    [256, 12.0, 3.5, 8, 8],
    [265, 14.0, -4.0, 8, 8],
    [274, 16.0, 3.5, 8, 8],
    [283, 18.0, -3.5, 9, 9],
    [293, 20.0, 1.0, 10, 8.5],
  ]
  CLIMB.forEach(([cx, cy, cz, lx, lz], i) => {
    deck(cx, cy, cz, lx, lz, WILD, { id: `climb-${i}` })
    // Standards go on the outboard lip, away from the landing zone in the
    // middle of each drum — a solid post where you touch down is a
    // momentum bug, and momentum is the fantasy (taste.md).
    const side = cz > 0 ? 1 : -1
    K.lanternPost(L, cx, cy, cz + side * (lz * 0.36), { height: 3.0 })
    if (i % 2 === 0) K.cypress(L, cx - lx * 0.28, cy, cz - side * (lz * 0.22), { height: 5.4 })
  })
  K.waterfall(L, 265, 13.6, -7.4, { height: 34, width: 2.2 })
  K.waterfall(L, 293, 19.6, 4.4, { height: 40, width: 2.6 })
  // The machine itself: three brass towers standing off the route at z = -16,
  // each carrying a wheel big enough to read from the terrace. `solidRim`
  // because they sit at climbing height — a 9 m gear you can see and fall
  // through is the forbidden bug at architectural scale.
  const TOWERS = [[240, 10.0, 6.5], [262, 13.0, 9.0], [284, 17.0, 6.5]]
  for (const [tx, ty, tr] of TOWERS) {
    L.massif(tx, ty - 13, -17.5, 3.4, 26, 3.4, 'porcelain', 'terracotta')
    L.massif(tx, ty - 27.5, -17.5, 4.6, 3, 4.6, 'stone')
    K.gearWheel(L, tx, ty, -15.6, {
      radius: tr, plane: 'xy', spokes: 8, solidRim: true, detail: 1,
    })
  }
  L.checkpoint(247, 11.0, -5.0, 'the gearworks')
  L.checkpoint(274, 17.0, 3.5, 'the high gears')

  // ---- Section 9: the observatory approach. ------------------------------
  // A balustraded causeway on two arches, a carved flight, and the dome. The
  // last hundred metres are the only stretch of the course with no jump in
  // them at all: after the climb the player has earned an approach.
  deck(306, 20.0, 0, 14, 9, BUILT, { bodyDepth: 2.4, tiers: 0, facets: 1, id: 'causeway' })
  for (const ax of [303, 309]) {
    K.archway(L, ax, 9.4, 0, {
      axis: 'z', span: 5, pierWidth: 1.2, depth: 2.0, springHeight: 3.6,
      detail: 1, kind: 'porcelain',
    })
  }
  for (const bz of [-4.1, 4.1]) {
    K.balustrade(L, 299.4, 20.0, bz, { length: 13.2, height: 1.05, thickness: 0.45 })
  }
  L.checkpoint(303, 21.0, 0, 'the causeway')
  K.lanternPost(L, 299.4, 21.05, -4.1, { post: false, height: 1.0 })
  K.lanternPost(L, 312.6, 21.05, 4.1, { post: false, height: 1.0 })

  K.stairFlight(L, 313, 20.0, 0, { steps: 7, rise: 0.62, run: 1.7, width: 7 })
  const OBS_Y = 20.0 + 0.62 * 7          // 24.34 — the island top matches the flight
  deck(336, OBS_Y, 0, 24, 24, WILD, { bodyDepth: 4.0, id: 'observatory' })
  K.observatoryDome(L, 338, OBS_Y, 0, { radius: 6.5, wallHeight: 7 })
  // The flanking colonnades hug the approach rather than the island rim: the
  // rim is a rounded drum and a straight row of columns run out to its edge
  // ends with the last two standing in mid-air.
  for (const cz of [-4.0, 4.0]) {
    K.colonnade(L, 327, OBS_Y, cz, { count: 3, spacing: 3.0, height: 3.4, radius: 0.48 })
  }
  K.armillary(L, 336, OBS_Y, -10.2, { radius: 2.6 })
  K.waterfall(L, 336, OBS_Y - 0.4, -11.6, { height: 42, width: 2.6 })
  K.waterfall(L, 347.4, OBS_Y - 0.4, 0, { height: 38, width: 2.2 })
  K.vineCurtain(L, 334, OBS_Y - 0.5, -11.7, { length: 4, drop: 7 })
  K.cypress(L, 330, OBS_Y, 8.4, { height: 7.5 })
  K.cypress(L, 344, OBS_Y, -6.0, { height: 6.5 })
  K.lanternPost(L, 327.5, OBS_Y, -5.4, { height: 3.4 })
  K.lanternPost(L, 327.5, OBS_Y, 5.4, { height: 3.4 })

  // The observatory used to be the finish. It is now the end of the OPENING
  // ACT and the courier depot the long haul leaves from — docs/world-plan.md:
  // "the current course becomes its opening act". Nothing above this line
  // moved; a checkpoint was added where the finish trigger used to sit.
  L.checkpoint(329.5, OBS_Y + 0.8, 0, 'the observatory')

  // ---- Act one, as a graph ----------------------------------------------
  // The geometry above is frozen (tools/shots.mjs reads these coordinates and
  // so does muscle memory), so these links DESCRIBE it rather than shape it.
  // They exist so the reachability walk starts at the spawn and covers the
  // whole world in one piece instead of two disconnected halves.
  A.link('terrace', 'gap-1', 'free')
  A.link('gap-1', 'gap-2', 'free')
  A.link('gap-2', 'gap-3', 'free')
  A.link('gap-3', 'viaduct', 'contiguous', { note: 'the decks meet at x=72.5/73' })
  A.link('viaduct', 'crossing', 'wallrun',
    { note: 'section 4: the approach ledge runs to x=100 and the brass face at z=-4 carries the last 10 m' })
  A.link('crossing', 'underpass', 'contiguous', { note: 'the decks meet at x=122.5/123' })
  A.link('underpass', 'chain-foot', 'contiguous', { note: 'the section 5 and 6 decks overlap at x=152..157' })
  A.link('chain-foot', 'chain-head', 'walljump',
    { note: 'section 6: three battered pillars at z=+/-2.3, a 4.6 m crossing per kick' })
  A.link('chain-head', 'tower', 'stair', { note: 'section 7: stairFlight 8 x 0.55 m from x=202' })
  A.link('tower', 'climb-0', 'standard')
  for (let i = 0; i < CLIMB.length - 1; i++) A.link(`climb-${i}`, `climb-${i + 1}`, 'standard')
  A.link('climb-6', 'causeway', 'free')
  A.link('causeway', 'observatory', 'stair', { note: 'section 9: stairFlight 7 x 0.62 m from x=313' })
  // Backward links on the opening act, so falling short never strands you on
  // an island whose only exit is the jump you just failed.
  A.link('gap-1', 'terrace', 'free')
  A.link('gap-2', 'gap-1', 'free')
  A.link('gap-3', 'gap-2', 'free')
  A.link('viaduct', 'gap-3', 'contiguous', { note: 'the decks meet at x=72.5/73' })
  A.link('crossing', 'viaduct', 'wallrun', { note: 'the same brass face, run the other way' })
  A.link('underpass', 'crossing', 'contiguous', { note: 'the decks meet at x=122.5/123' })
  A.link('chain-foot', 'underpass', 'contiguous', { note: 'the section 5 and 6 decks overlap' })
  A.link('chain-head', 'chain-foot', 'walljump', { note: 'the same three pillars, flown west' })
  A.link('tower', 'chain-head', 'stair', { note: 'the ascent flight, descended' })
  A.link('climb-0', 'tower', 'free')
  for (let i = CLIMB.length - 1; i > 0; i--) A.link(`climb-${i}`, `climb-${i - 1}`, 'free')
  A.link('causeway', 'climb-6', 'free')
  A.link('observatory', 'causeway', 'stair', { note: 'the approach flight, descended' })

  // ========================================================== ACT TWO ======
  //
  // THE LONG HAUL. Everything from here is new, and it is built to four rules
  // out of docs/world-plan.md and docs/course-design.md:
  //
  //   * It is a GRAPH, not a corridor. Every island below is registered with
  //     `isle()` and linked with `A.link()`, and the build refuses to load if
  //     any of them is unreachable, inescapable, or gated on a charge the
  //     safe line is not allowed to need.
  //   * It TURNS. Act one is 350 m of +X. Act two goes north, then 190 m back
  //     west, then south under the course it just ran, then up a spiral, then
  //     north-west across itself again, then straight up. The player sees the
  //     opening act from four different angles and two different altitudes.
  //   * It uses the FULL vertical range: the deep sits at y = -20 directly
  //     beneath the underpass island, the finish at y = +88 directly above it.
  //   * It REUSES the kit. There is not one new prefab below — the scale comes
  //     from composition, per-island seeds and the two towers.
  const r2 = makeRand(0x5EA51DE)

  /**
   * One island of the long haul: deck, graph node, and a lantern.
   *
   * THE LANTERN IS NOT DECORATION. Every solid island in this world carries
   * one and no decor island carries any, so "brass that glows" is the single
   * unambiguous word for *you can get there* — which is the answer to the
   * playtest complaint that the horizon was a painted backdrop. It is also the
   * anchor that authors the grapple edges, so placing it is level design.
   */
  const isle = (id, x, y, z, lenX, lenZ, style, o = {}) => {
    deck(x, y, z, lenX, lenZ, style, {
      id,
      launchY: o.launchY,
      detail: o.detail ?? 1,
      bodyDepth: o.bodyDepth ?? 3.0,
      seed: (r2() * 0xffffff) | 0,
    })
    // Outboard lip, never the middle: a solid post where you touch down is a
    // momentum bug, and momentum is the fantasy (taste.md).
    const px = x + (o.post ? o.post[0] : 0)
    const pz = z + (o.post ? o.post[1] : lenZ * 0.36)
    const lp = K.lanternPost(L, px, y, pz, { height: o.postH ?? 3.2 })
    return lp.flame
  }

  /**
   * Per-island dressing, drawn from one seeded stream so the world is the same
   * every reload. Cypress, a waterfall off the lip, and a machine on the
   * skyline — the three things art-direction.md says an island in this world
   * has, in proportions that vary rather than repeat.
   */
  const dress = (x, y, z, lenX, lenZ, heavy) => {
    const hx = lenX / 2, hz = lenZ / 2
    const n = heavy ? 1 + ((r2() * 3) | 0) : (r2() > 0.45 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      K.cypress(L, x + (r2() - 0.5) * hx * 1.1, y, z + (r2() - 0.5) * hz * 1.1,
        { height: 5 + r2() * 4.5, rand: r2, detail: heavy ? 2 : 1 })
    }
    // ONE ISLAND IN FIVE, not one in two. At 45% the archipelago came back
    // from the harness standing on stilts: a pale 2 m column under half the
    // islands in the frame reads as a leg, not as water, and it flattens the
    // floating read that is the whole premise. Rare, off-centre and hung from
    // a corner of the rim is what makes one look like a waterfall.
    if (r2() > 0.80) {
      K.waterfall(L, x + (0.3 + r2() * 0.5) * hx * (r2() > 0.5 ? 1 : -1), y - 0.45,
        z - hz * 0.86, { height: 16 + r2() * 20, width: 1.4 + r2() * 0.8, rand: r2 })
    }
    if (r2() > 0.62) {
      K.vineCurtain(L, x - hx * 0.3, y - 0.55, z + hz * 0.94,
        { length: hx * 0.9, drop: 4 + r2() * 3, rand: r2 })
    }
  }

  /**
   * A stepped terrace climbing `courses` metres up an island deck.
   *
   * This is how the two towers gain height on the SAFE line. course-design.md
   * forbids gating a checkpoint on dash or grapple, and 7.6 m between storeys
   * is three times what a double jump can climb — so the deck carries six
   * one-metre courses (inside `vaultMaxHeight` 1.45, so they are taken at
   * speed without even a jump) and the storey hop becomes a 1.6 m step.
   *
   * Axis-aligned on purpose: the collider is an AABB, so a ramp that ran on
   * the true chord would present a stepped face the collision world could not
   * describe. It is oriented to whichever axis the chord leans on.
   */
  const rampUp = (x, y, z, dirX, dirZ, courses = 6, rise = 1.0, run = 2.0, width = 7) => {
    const useX = Math.abs(dirX) >= Math.abs(dirZ)
    const sign = (useX ? dirX : dirZ) >= 0 ? 1 : -1
    for (let i = 0; i < courses; i++) {
      const top = y + rise * (i + 1)
      const off = sign * (run * (i + 0.5) - (courses * run) / 2)
      const h = rise * (i + 1) + 0.7          // every course reaches the deck
      // ONLY THE TOP COURSE WEARS THE ACCENT. Terracotta is reserved for
      // surfaces the route acts on, and on a terrace exactly one course
      // qualifies: the one you take off from. Capping all six turned eleven
      // towers into red staircases and spent the hue on decoration again —
      // the precise failure this rule exists to prevent.
      L.massif(useX ? x + off : x, top - h / 2, useX ? z : z + off,
        useX ? run : width, h, useX ? width : run,
        'porcelain', i === courses - 1 ? 'terracotta' : 'porcelain')
    }
    return y + rise * courses
  }

  /**
   * The shaft of a tower, as courses rather than as one prism.
   *
   * The first version of both towers was a single `massif` 54 and 62 m tall.
   * From the north-west approach they came back reading as chequerboard posts:
   * one continuous ashlar face that tall tiles visibly, and `massif`'s single
   * plinth and cornice are lost at 3% of the height. Nine-metre courses, each
   * with its own plinth and cornice, a brass band at every joint, and a 34%
   * batter from foot to crown give the silhouette a dozen horizontal shadow
   * lines and a taper — which is what a tower has and a post does not.
   */
  const mast = (x, zc, botY, topY, topW) => {
    const courses = Math.max(3, Math.round((topY - botY) / 9))
    const h = (topY - botY) / courses
    for (let i = 0; i < courses; i++) {
      const t = i / (courses - 1)
      const w = topW * (1.34 - 0.34 * t)
      L.massif(x, botY + h * (i + 0.5), zc, w, h, w, 'porcelain')
      if (i < courses - 1) {
        L.solid(x, botY + h * (i + 1), zc, w + 0.55, 0.42, w + 0.55, 'brass', { shade: 1.08 })
      }
    }
    // The foot, tapering away into cloud the way every island in the reference
    // does. Solid, because it hangs directly under a mass the player falls past.
    const base = topW * 1.34
    L.solid(x, botY - h * 0.22, zc, base * 0.78, h * 0.44, base * 0.78, 'stone')
    L.solid(x, botY - h * 0.52, zc, base * 0.5, h * 0.3, base * 0.5, 'stone')
  }

  // ---- Leg A: the north spur. The first time the route leaves the +X axis. -
  // Four islands climbing 2 m a step off the observatory's north rim, so the
  // player's first act after the opening course is to turn ninety degrees and
  // look back down the whole thing.
  const LEG_A = [
    ['spur-1', 346, 26.0, -20, 12, 12],
    ['spur-2', 343, 28.0, -34, 12, 12],
    ['spur-3', 333, 30.0, -47, 14, 13],
    ['spur-4', 317, 32.0, -56, 12, 12],
  ]
  LEG_A.forEach(([id, x, y, z, lx, lz], i) => {
    isle(id, x, y, z, lx, lz, i === 2 ? BUILT : WILD, { detail: i === 2 ? 2 : 1, post: [0, -lz * 0.36] })
    dress(x, y, z, lx, lz, i === 2)
    A.link(i === 0 ? 'observatory' : LEG_A[i - 1][0], id, 'standard')
  })
  // Off the diagonal the route takes across this island, not on it: a dome
  // centred on the deck puts a solid wall exactly where the checkpoint is.
  K.observatoryDome(L, 336, 30.0, -50.4, { radius: 3.2, wallHeight: 4.2 })
  L.checkpoint(333, 31.0, -47, 'the north spur')

  // ---- Leg B: the long west run. 190 m back down the world, descending. ----
  // This is the leg that makes the world read as a place: it runs parallel to
  // the whole opening act, 65 m off it and steadily dropping through its
  // altitude, so the terrace you started on passes by on your left at eye
  // level and then above you.
  const LEG_B = [
    ['west-1', 300, 29.0, -63, 13, 12],
    ['west-2', 281, 25.0, -69, 12, 12],
    ['west-3', 262, 20.5, -73, 14, 13],
    ['west-4', 243, 15.5, -76, 12, 12],
    ['west-5', 224, 10.5, -78, 13, 12],
    ['west-6', 205, 5.0, -79, 12, 12],
    ['west-7', 186, -0.5, -78, 13, 12],
    ['west-8', 168, -6.5, -75, 12, 12],
    ['west-9', 151, -13.0, -70, 16, 15],
  ]
  LEG_B.forEach(([id, x, y, z, lx, lz], i) => {
    const cp = i === 2 || i === 5 || i === 8
    isle(id, x, y, z, lx, lz, cp ? BUILT : WILD, { detail: cp ? 2 : 1, post: [0, -lz * 0.36] })
    dress(x, y, z, lx, lz, cp)
    A.link(i === 0 ? 'spur-4' : LEG_B[i - 1][0], id, 'standard')
  })
  // SPANNING ACROSS THE RUN, not along it. Leg B runs -X, so `axis: 'x'`
  // put a 1.3 m pier squarely in the running line and the harness came back
  // with a wall three metres from the lens. An arch is a gate you run
  // through; its piers belong either side of you.
  K.archway(L, 262, 20.5, -73, { axis: 'z', span: 6, pierWidth: 1.3, depth: 1.8, springHeight: 3.4 })
  // Off to the south rim: a colonnade laid down the island's centre line is
  // four solid columns in the middle of a leg that runs along X.
  K.colonnade(L, 218, 10.5, -81.4, { count: 4, spacing: 3.4, height: 3.4, radius: 0.46 })
  K.balustrade(L, 145, -13.0, -76, { length: 13, height: 1.05, thickness: 0.45 })
  L.checkpoint(262, 21.5, -73, 'the west run')
  L.checkpoint(205, 6.0, -79, 'the low road')

  // ---- Leg C: the deep crossing. Under the course, at y = -20. -------------
  // `deep-4` sits directly beneath the section-5 underpass island: its deck is
  // 20 m below the deck the player slid across twenty minutes ago, close
  // enough that the boulder underside and the waterfall off its rim fill the
  // sky. Seeing your own route from a new angle is most of what makes a
  // traversal world read as a place (docs/world-plan.md).
  const LEG_C = [
    ['deep-1', 152, -16.0, -52, 13, 12],
    ['deep-2', 152, -18.0, -34, 13, 12],
    ['deep-3', 151, -19.5, -16, 14, 13],
    ['deep-4', 150, -20.0, 3, 15, 14],
    ['deep-5', 152, -18.0, 21, 13, 12],
    ['deep-6', 156, -16.0, 38, 13, 12],
  ]
  LEG_C.forEach(([id, x, y, z, lx, lz], i) => {
    const cp = i === 3 || i === 5
    isle(id, x, y, z, lx, lz, cp ? BUILT : WILD, { detail: cp ? 2 : 1, post: [-lx * 0.36, 0] })
    dress(x, y, z, lx, lz, cp)
    A.link(i === 0 ? 'west-9' : LEG_C[i - 1][0], id, 'standard')
  })
  // Off the run line for the same reason: the deep's checkpoint is at x=150.
  K.armillary(L, 145.5, -20.0, 6, { radius: 2.8 })
  K.waterfall(L, 150, -20.4, -3.5, { height: 26, width: 2.4 })
  L.checkpoint(150, -19.0, 3, 'the deep')
  L.checkpoint(156, -15.0, 38, 'the south shore')

  // ---- Leg D: the orrery. 46 m of climb around a brass shaft. -------------
  // Six storeys on a 20 m helix, each one a deck with a six-course terrace on
  // it. The terrace is the safe line — one-metre courses are under
  // `vaultMaxHeight`, so they are taken at a run — and it turns a 7.6 m storey
  // into a 1.6 m step. The fast line is the shaft's own lantern chain: three
  // grapples straight up the middle skip four storeys, which is the biggest
  // single time saving in the world and costs both charges to set up.
  isle('orrery-foot', 172, -14.0, 42, 16, 15, BUILT, { detail: 2, post: [-6, 0] })
  dress(172, -14.0, 42, 16, 15, true)
  A.link('deep-6', 'orrery-foot', 'standard')
  K.colonnade(L, 167, -14.0, 48.6, { count: 3, spacing: 3.4, height: 3.4, radius: 0.46 })
  L.checkpoint(172, -13.0, 42, 'the foot of the orrery')

  const ORR = { x: 204, z: 66, r: 20, y0: -12, step: 7.6 }
  const storeys = []
  for (let k = 0; k < 6; k++) {
    // 210 degrees puts storey zero on the approach side; 60 degrees a storey
    // means the chord is exactly the helix radius, which is the gap the
    // terrace's 1.6 m step has to clear.
    const a = ((210 + k * 60) * Math.PI) / 180
    const sx = ORR.x + Math.cos(a) * ORR.r
    const sz = ORR.z + Math.sin(a) * ORR.r
    const sy = ORR.y0 + k * ORR.step
    const id = `orrery-${k}`
    isle(id, sx, sy, sz, 14, 13, k % 2 ? WILD : BUILT, {
      detail: 1, launchY: sy + 6.0, post: [Math.cos(a) * 5.4, Math.sin(a) * 5.0],
    })
    // The terrace climbs toward the next storey, so the top course is the
    // take-off and the player never has to turn round on it.
    const na = ((210 + (k + 1) * 60) * Math.PI) / 180
    rampUp(sx, sy, sz, ORR.x + Math.cos(na) * ORR.r - sx, ORR.z + Math.sin(na) * ORR.r - sz)
    K.cypress(L, sx - Math.cos(a) * 4.6, sy, sz - Math.sin(a) * 4.6, { height: 5 + r2() * 3, rand: r2 })
    A.link(k === 0 ? 'orrery-foot' : `orrery-${k - 1}`, id, 'standard')
    storeys.push([id, sx, sy, sz])
  }
  // The machine the helix winds around. Solid from top to bottom: it stands at
  // climbing height and a 60 m tower you can see and fall through is the
  // forbidden bug at architectural scale.
  mast(ORR.x, ORR.z, -30, 32, 6.4)
  for (const [gy, gr] of [[-6, 8.5], [6, 7.0], [18, 8.5], [29, 6.0]]) {
    K.gearWheel(L, ORR.x, gy, ORR.z, { radius: gr, plane: gy % 12 ? 'zy' : 'xy', spokes: 8, solidRim: true })
  }
  K.armillary(L, ORR.x, 32.4, ORR.z, { radius: 3.2 })
  K.waterfall(L, ORR.x + 3.4, -28.0, ORR.z, { height: 34, width: 2.2 })

  const crownY = ORR.y0 + 6 * ORR.step
  const crownFlame = isle('orrery-crown', ORR.x, crownY, ORR.z, 18, 18, BUILT,
    { detail: 2, launchY: crownY + 3.0, bodyDepth: 4.0 })
  rampUp(ORR.x, crownY, ORR.z, -1, -1, 3)
  A.link('orrery-5', 'orrery-crown', 'standard')
  K.observatoryDome(L, ORR.x + 4.5, crownY, ORR.z + 4.5, { radius: 4.4, wallHeight: 5 })
  // Beside the crown's take-off terrace, not inside it.
  L.checkpoint(ORR.x, crownY + 1.0, ORR.z - 5.5, 'the orrery')

  // THE FAST LINE, authored by three lanterns. Each one is a bracket off the
  // shaft hanging in the air the player is already flying through, and each
  // makes exactly one edge exist that would not otherwise: docs/course-design
  // .md, "placing a brass lantern is what makes a route exist".
  const lift1 = K.lanternPost(L, ORR.x, 1.6, ORR.z, { post: false, reach: 4.2, axis: 'x', height: 0.8 })
  const lift2 = K.lanternPost(L, ORR.x, 16.7, ORR.z, { post: false, reach: 4.6, axis: 'z', height: 0.8 })
  A.link('orrery-0', 'orrery-2', 'grapple', { anchor: lift1.flame, note: 'skips one storey' })
  A.link('orrery-2', 'orrery-4', 'grapple', { anchor: lift2.flame, note: 'skips one storey' })
  A.link('orrery-4', 'orrery-crown', 'grapple', { anchor: crownFlame, note: 'skips the last storey' })

  // ---- Leg E: the high road. North-west, 33 m over the opening act. -------
  // `high-4` passes directly above the section-6 wall-jump chain at y = 44,
  // and `high-6` above the section-4 brass crossing. This is the crossing-over
  // -itself that docs/world-plan.md rates above raw length.
  const LEG_E = [
    ['high-1', 194, 38.0, 50, 13, 12],
    ['high-2', 186, 40.0, 34, 13, 12],
    ['high-3', 179, 42.0, 18, 13, 12],
    ['high-4', 174, 44.0, 2, 13, 12],
    ['high-5', 171, 46.0, -14, 13, 12],
    ['high-6', 170, 48.0, -33, 14, 13],
  ]
  LEG_E.forEach(([id, x, y, z, lx, lz], i) => {
    const cp = i === 2 || i === 5
    isle(id, x, y, z, lx, lz, cp ? BUILT : WILD, { detail: cp ? 2 : 1, post: [lx * 0.36, 0] })
    dress(x, y, z, lx, lz, cp)
    A.link(i === 0 ? 'orrery-crown' : LEG_E[i - 1][0], id, 'standard')
  })
  K.balustrade(L, 173, 42.0, 23, { length: 12, height: 1.05, thickness: 0.45 })
  K.vineCurtain(L, 168, 47.4, -39, { length: 8, drop: 7 })
  L.checkpoint(179, 43.0, 18, 'the high road')
  L.checkpoint(170, 49.0, -33, 'the north shelf')

  // ---- Leg F: the skyline. The last 38 m, straight up. --------------------
  // The same helix trick as the orrery, tighter and higher, standing directly
  // over the section-5 underpass island — so the finish is 88 m above a deck
  // the player slid across in the first minute, and `deep-4` is 108 m directly
  // below the finish. One vertical line through the whole world.
  const SKY = { x: 152, z: -6, r: 17, y0: 50.0, step: 7.6 }
  for (let k = 0; k < 5; k++) {
    const a = ((-60 + k * 60) * Math.PI) / 180
    const sx = SKY.x + Math.cos(a) * SKY.r
    const sz = SKY.z + Math.sin(a) * SKY.r
    const sy = SKY.y0 + k * SKY.step
    const id = `sky-${k}`
    isle(id, sx, sy, sz, 14, 13, k % 2 ? BUILT : WILD, {
      detail: k === 2 ? 2 : 1, launchY: sy + 6.0, post: [Math.cos(a) * 5.4, Math.sin(a) * 5.0],
    })
    const na = ((-60 + (k + 1) * 60) * Math.PI) / 180
    rampUp(sx, sy, sz, SKY.x + Math.cos(na) * SKY.r - sx, SKY.z + Math.sin(na) * SKY.r - sz)
    K.cypress(L, sx - Math.cos(a) * 4.6, sy, sz - Math.sin(a) * 4.6, { height: 4.5 + r2() * 3, rand: r2 })
    A.link(k === 0 ? 'high-6' : `sky-${k - 1}`, id, 'standard')
  }
  // On the top course of sky-2's terrace: the natural pause point on the
  // climb, and the one part of that deck the terrace does not cover.
  L.checkpoint(155.0, 72.3, 8.72, 'the last light')

  const FIN_Y = SKY.y0 + 5 * SKY.step          // 88.0 — the top of the world
  isle('skyline', SKY.x, FIN_Y, SKY.z, 18, 18, BUILT, { detail: 2, bodyDepth: 4.5 })
  A.link('sky-4', 'skyline', 'standard')
  // The mast the finish stands on, hanging in open sky above the underpass.
  mast(SKY.x, SKY.z, FIN_Y - 55, FIN_Y - 1, 5.6)
  K.gearWheel(L, SKY.x, FIN_Y - 14, SKY.z, { radius: 6.5, plane: 'xy', spokes: 8, solidRim: true })
  // THE FINISH COURT, laid out around the run line rather than across it.
  // The first version put the dome at x+3 with a 5.6 m radius and the finish
  // trigger at x-1, which buried the trigger inside the dome's wall — the
  // player would have run into a mass of blocks two metres from the lens
  // instead of arriving somewhere. The player comes in from -X off sky-4, so:
  // arch, then an open court with the trigger in it, then the dome behind it
  // as the thing the last hundred metres were aimed at.
  K.archway(L, SKY.x - 7.2, FIN_Y, SKY.z, { axis: 'z', span: 6, pierWidth: 1.4, depth: 1.8, springHeight: 3.4 })
  K.observatoryDome(L, SKY.x + 5.5, FIN_Y, SKY.z, { radius: 4.6, wallHeight: 6.5 })
  K.armillary(L, SKY.x - 1.0, FIN_Y, SKY.z - 8.0, { radius: 3.0 })
  K.waterfall(L, SKY.x, FIN_Y - 0.5, SKY.z + 8.4, { height: 46, width: 2.6 })
  K.vineCurtain(L, SKY.x - 4, FIN_Y - 0.6, SKY.z - 8.5, { length: 8, drop: 7 })
  for (const cz2 of [-4.6, 4.6]) {
    K.colonnade(L, SKY.x - 4.6, FIN_Y, SKY.z + cz2, { count: 3, spacing: 3.2, height: 3.4, radius: 0.48 })
    K.lanternPost(L, SKY.x - 6.0, FIN_Y, SKY.z + cz2 * 1.35, { height: 3.4 })
  }
  L.checkpoint(SKY.x - 3.5, FIN_Y + 1.0, SKY.z, 'the skyline')
  L.finish = new THREE.Vector3(SKY.x - 3.5, FIN_Y + 0.8, SKY.z)
  // The beacon stands on the finish mast, 88 m up and 150 m from the terrace:
  // from the spawn it is 30 degrees above the horizon and dead ahead, which is
  // the whole point — one unmistakable cue that names where the route ends
  // before the player has taken a single step.
  L.beaconAt = { x: SKY.x + 5.5, y: FIN_Y + 8, z: SKY.z, height: 130, radius: 4.4 }

  // ---- The branch lines -------------------------------------------------
  //
  // course-design.md asks for "at least three points where a fast, risky line
  // and a safe, slower line diverge and rejoin", and world-plan.md asks for an
  // archipelago rather than a chain. These five loops do both jobs at once:
  // each one leaves the spine, runs out through the band the player used to
  // see only as unreachable decor, and comes back on. Every one of them is
  // solid, every one carries lanterns, and none of them is a dead end.
  //
  // They are also what fills the near distance now that the ghost bands are
  // gone. An island 25 m off the running line that you CAN land on is worth
  // ten you cannot.
  const branch = (rows, style) => rows.forEach(([id, x, y, z, lx, lz], i) => {
    isle(id, x, y, z, lx, lz, style, { detail: 1, post: [0, -lz * 0.36] })
    dress(x, y, z, lx, lz, false)
  })

  // (1) The west drops — off the terrace's south rim at the very first jump,
  // rejoining the viaduct on a grapple. The fast line skips sections 2 and 3.
  const BR_W = [
    ['drop-w1', 26, -2.0, 18, 13, 12],
    ['drop-w2', 44, -4.0, 30, 12, 12],
    ['drop-w3', 62, -2.0, 36, 12, 12],
    ['drop-w4', 79, 0.0, 29, 13, 12],
  ]
  branch(BR_W, WILD)
  A.link('terrace', 'drop-w1', 'standard')
  A.link('drop-w1', 'terrace', 'committed')
  A.link('drop-w1', 'drop-w2', 'standard')
  A.link('drop-w2', 'drop-w1', 'committed')
  A.link('drop-w2', 'drop-w3', 'standard')
  A.link('drop-w3', 'drop-w2', 'free')
  A.link('drop-w3', 'drop-w4', 'standard')
  A.link('drop-w4', 'drop-w3', 'free')
  const wGate = K.lanternPost(L, 86, 0, 7.0, { height: 3.4 })
  A.link('drop-w4', 'viaduct', 'grapple',
    { anchor: wGate.flame, note: 'the shortcut back onto the spine, past sections 2 and 3' })

  // (2) The north drops — the same idea on the other side, rejoining the
  // viaduct on a plain jump, so this one is the SAFE alternative opening.
  const BR_M = [
    ['drop-n1', 18, -2.0, -20, 13, 12],
    ['drop-n2', 36, -4.0, -30, 12, 12],
    ['drop-n3', 56, -3.0, -36, 12, 12],
    ['drop-n4', 74, -1.0, -30, 12, 12],
    ['drop-n5', 84, 0.0, -18, 12, 12],
  ]
  branch(BR_M, WILD)
  A.link('terrace', 'drop-n1', 'standard')
  A.link('drop-n1', 'terrace', 'committed')
  A.link('drop-n1', 'drop-n2', 'standard')
  A.link('drop-n2', 'drop-n1', 'committed')
  A.link('drop-n2', 'drop-n3', 'standard')
  A.link('drop-n3', 'drop-n2', 'standard')
  A.link('drop-n3', 'drop-n4', 'standard')
  A.link('drop-n4', 'drop-n3', 'free')
  A.link('drop-n4', 'drop-n5', 'standard')
  A.link('drop-n5', 'drop-n4', 'free')
  A.link('drop-n5', 'viaduct', 'free')
  A.link('viaduct', 'drop-n5', 'free')

  // (3) The low north road — leaves the section-4 landing, drops under the
  // course's altitude and comes back up onto the underpass island on a dash.
  const BR_N = [
    ['low-1', 108, -3.0, -26, 13, 12],
    ['low-2', 96, -5.0, -40, 12, 12],
    ['low-3', 104, -6.0, -56, 12, 12],
    ['low-4', 122, -5.0, -62, 12, 12],
    ['low-5', 140, -3.0, -58, 12, 12],
    ['low-6', 152, -1.0, -44, 12, 12],
    ['low-7', 154, 0.0, -26, 12, 12],
  ]
  branch(BR_N, WILD)
  A.link('crossing', 'low-1', 'standard')
  A.link('low-1', 'low-2', 'standard')
  A.link('low-2', 'low-1', 'committed')
  A.link('low-2', 'low-3', 'standard')
  A.link('low-3', 'low-2', 'standard')
  A.link('low-3', 'low-4', 'standard')
  A.link('low-4', 'low-3', 'standard')
  A.link('low-4', 'low-5', 'standard')
  A.link('low-5', 'low-4', 'standard')
  A.link('low-5', 'low-6', 'standard')
  A.link('low-6', 'low-5', 'standard')
  A.link('low-6', 'low-7', 'standard')
  A.link('low-7', 'low-6', 'standard')
  A.link('low-7', 'underpass', 'committed')

  // (4) The mid drops — the +Z side of the underpass, rejoining the wall-jump
  // chain's landing on a grapple off a lantern that was already there. A
  // lantern placed for one crossing authoring a second is exactly the point of
  // "grapple range is the connectivity graph".
  //
  // THE ALTITUDES HERE ARE NOT FREE. `mid-3` flies directly over `deep-6` on
  // the leg-C climb, and a drumPlatform hangs a ~13 m boulder tail under its
  // deck — at the first altitude these were given, that tail came down to
  // within half a metre of the deck below and the south shore checkpoint was
  // inside it. The whole branch was lifted so the tail clears the deck under
  // it by more than a standing capsule. `assertTriggersClear` is what caught
  // it; the rule is that a branch crossing over a leg needs 15 m, not 14.
  const BR_R = [
    ['mid-1', 127, -1.0, 19, 13, 12],
    ['mid-2', 138, -1.0, 32, 12, 12],
    ['mid-3', 156, 1.0, 38, 12, 12],
    ['mid-4', 170, 1.0, 26, 12, 12],
    ['mid-5', 176, 2.0, 14, 12, 12],
  ]
  branch(BR_R, WILD)
  A.link('underpass', 'mid-1', 'standard')
  A.link('mid-1', 'underpass', 'standard')
  A.link('mid-1', 'mid-2', 'standard')
  A.link('mid-2', 'mid-1', 'standard')
  A.link('mid-2', 'mid-3', 'standard')
  A.link('mid-3', 'mid-2', 'standard')
  A.link('mid-3', 'mid-4', 'standard')
  A.link('mid-4', 'mid-3', 'standard')
  A.link('mid-4', 'mid-5', 'standard')
  A.link('mid-5', 'mid-4', 'standard')
  A.link('mid-5', 'chain-head', 'grapple',
    { anchor: [193.5, 4.9, -4.6], note: 'the section-6 landing lantern, reused as a crossing' })

  // (5) The south loop — leaves the gearworks climb on a dash, runs the whole
  // +Z side of the last third, and rejoins twice: at the causeway and at the
  // observatory. Two rejoin points is what stops a branch from being a detour.
  const BR_P = [
    ['sun-1', 266, 14.0, 20, 12, 11],
    ['sun-2', 282, 16.0, 26, 12, 12],
    ['sun-3', 298, 18.0, 20, 12, 11],
    ['sun-4', 310, 20.0, 12, 12, 12],
    ['sun-5', 322, 20.0, 18, 12, 12],
    ['sun-6', 338, 22.0, 20, 12, 12],
  ]
  branch(BR_P, BUILT)
  A.link('climb-2', 'sun-1', 'committed')
  A.link('sun-1', 'sun-2', 'standard')
  A.link('sun-2', 'sun-1', 'standard')
  A.link('sun-2', 'sun-3', 'standard')
  A.link('sun-3', 'sun-2', 'standard')
  A.link('sun-3', 'sun-4', 'standard')
  A.link('sun-4', 'sun-3', 'standard')
  A.link('sun-4', 'causeway', 'free')
  A.link('causeway', 'sun-4', 'free')
  A.link('sun-4', 'sun-5', 'free')
  A.link('sun-5', 'sun-4', 'free')
  A.link('sun-5', 'sun-6', 'standard')
  A.link('sun-6', 'sun-5', 'standard')
  A.link('sun-6', 'observatory', 'standard')

  // ---- The far band: the only scenery left in the world ------------------
  //
  // Round one drew forty-two islands in the near and mid distance and made
  // every one of them `decor()`. Ethan's most repeated note was "I can't get
  // to the other islands", and he was right: they were a painted backdrop the
  // moment you tried. They are gone, replaced by the solid archipelago above.
  //
  // What is left is genuinely far. `Archipelago.verify()` measures the closest
  // approach of any ghost island to any solid one and fails the build under
  // 70 m — the grapple sphere plus a committed dash off its far side plus
  // slack — so "the player can never test it" is a measurement, not a hope.
  const rand = makeRand(0xA11CE)

  const ghost = (x, y, z, w, detail) => {
    const d = w * (0.78 + rand() * 0.44)
    // NO TERRACOTTA AND NO LANTERN OUT HERE. Both are reserved: the warm rim
    // band means "the route acts on this surface" and a lit lantern means "you
    // can reach this". Spending either on scenery is what emptied the accent
    // of meaning the first time round.
    const stone = rand() > 0.45 ? 'stone' : 'porcelain'
    K.drumPlatform(L, x, y, z, {
      radius: w / 2, squash: d / w, facets: facetsFor(w, d),
      capKind: 'moss', rimKind: stone, kind: stone, boulderKind: 'stone',
      detail, ghost: true, rand,
    })
    A.sceneryAt(x, y, z, w, d)
    return { x, y, z, w, d }
  }

  // Two rings, both outside the play space: a nearer one that still resolves a
  // silhouette and carries brass on its skyline, and a far one dissolving into
  // the golden haze. Depth is the headline effect (art-direction.md), and with
  // the route now spanning 108 m of altitude the bands are seeded across a
  // much taller slab of sky than round one's.
  for (let i = 0; i < 30; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const x = -120 + rand() * 640
    const z = side * (235 + rand() * 150)
    const y = 30 - rand() * 120
    const w = 20 + rand() * 30
    const a = ghost(x, y, z, w, 1)
    if (rand() > 0.5) {
      K.cypress(L, x + (rand() - 0.5) * a.w * 0.5, y, z, { height: 7 + rand() * 6, detail: 1, rand })
    }
    if (rand() > 0.72) {
      K.armillary(L, x, y, z, { radius: 2.4 + rand() * 2.4, detail: 1, ghost: true, rand })
    } else if (rand() > 0.6) {
      K.gearWheel(L, x, y + 4 + rand() * 4, z, {
        radius: 2.6 + rand() * 2.8, plane: rand() > 0.5 ? 'xy' : 'zy',
        spokes: 6, detail: 1, ghost: true,
      })
    }
    if (rand() > 0.8) {
      K.observatoryDome(L, x, y, z, {
        radius: 3.4 + rand() * 2, wallHeight: 4 + rand() * 3, detail: 1, ghost: true, rand,
      })
    }
  }

  for (let i = 0; i < 38; i++) {
    const side = i % 2 === 0 ? -1 : 1
    const x = -320 + rand() * 1000
    const z = side * (420 + rand() * 380)
    const y = 60 - rand() * 200
    const w = 26 + rand() * 52
    ghost(x, y, z, w, 0)
    // The occasional distant spire, like the reference's far towers. `bevel: 0`
    // across the far band: a 4 cm chamfer at 400 m is a fraction of a pixel,
    // so it is 32 wasted triangles per box and nothing else.
    if (rand() > 0.6) {
      L.decor(x + (rand() - 0.5) * w * 0.4, y + 12 + rand() * 8, z,
        w * 0.16, 22 + rand() * 26, w * 0.16, 'porcelain', { bevel: 0 })
    }
  }

  // ---- The receipt -------------------------------------------------------
  //
  // Everything above is a claim. This is where it is checked, at load, in the
  // shipping build, on the same code path the player runs. A world that fails
  // any of these does not boot — which is the only way a rule about
  // reachability survives contact with a level that keeps growing.
  const ROUTE = [
    'terrace', 'gap-1', 'gap-2', 'gap-3', 'viaduct', 'crossing', 'underpass',
    'chain-foot', 'chain-head', 'tower',
    'climb-0', 'climb-1', 'climb-2', 'climb-3', 'climb-4', 'climb-5', 'climb-6',
    'causeway', 'observatory',
    'spur-1', 'spur-2', 'spur-3', 'spur-4',
    'west-1', 'west-2', 'west-3', 'west-4', 'west-5', 'west-6', 'west-7', 'west-8', 'west-9',
    'deep-1', 'deep-2', 'deep-3', 'deep-4', 'deep-5', 'deep-6',
    'orrery-foot', 'orrery-0', 'orrery-1', 'orrery-2', 'orrery-3', 'orrery-4', 'orrery-5',
    'orrery-crown',
    'high-1', 'high-2', 'high-3', 'high-4', 'high-5', 'high-6',
    'sky-0', 'sky-1', 'sky-2', 'sky-3', 'sky-4', 'skyline',
  ]
  /** The checkpoint spine: the safe line must connect these with no charges. */
  const SPINE = [
    'terrace', 'gap-1', 'viaduct', 'crossing', 'underpass', 'chain-head', 'tower',
    'climb-1', 'climb-4', 'causeway', 'observatory', 'spur-3', 'west-3', 'west-6',
    'deep-4', 'deep-6', 'orrery-foot', 'orrery-crown', 'high-3', 'high-6', 'sky-2',
    'skyline',
  ]
  const report = A.verify('terrace', 'skyline', SPINE)
  Archipelago.assertTriggersClear(collision, [
    ...L.checkpoints.map((c) => [c.label, c.position.x, c.position.z, c.position.y]),
    ['finish', L.finish.x, L.finish.z, L.finish.y],
    ['spawn', L.spawn.x, L.spawn.z, L.spawn.y],
  ])
  report.routeMetres = Math.round(A.pathLength(ROUTE))
  report.checkpoints = L.checkpoints.length
  report.solidIslands = A.nodes.size
  report.verticalRange = [
    Math.round(Math.min(...[...A.nodes.values()].map((n) => n.y))),
    Math.round(Math.max(...[...A.nodes.values()].map((n) => n.y))),
  ]
  report.anchors = L.anchors.length
  L.graph = A
  L.report = report
  K.assertAllPlaced()
  return L
}
