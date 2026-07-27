import * as THREE from 'three'
import { surfaceMaterial, glowMaterial, PALETTE } from './materials.js'
import { getTheme } from './theme.js'
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
export class Archipelago {
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
  verify(spawnId, finishId, spine, opts = {}) {
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
    //
    // OPT-OUT, per level. Ethan, 2026-07-25, after playing the void scaffold:
    //
    //   "I don't think there should be a rule that it should be doable without
    //   the grapple and without the ability. The rule should just be it's
    //   doable in NORMAL, and I'm the one who can determine that. So that way
    //   you're not restricted or constrained in any way."
    //
    // The sunset course keeps this gate — it is a teaching course and the safe
    // line is part of its design. The void is authored for the full movement
    // set, and there the gate was producing timid geometry rather than
    // catching bugs. The three gates ABOVE this one (bands honest, nothing
    // orphaned, nothing a trap) still run, and so does the >34 m physical
    // limit: what is switched off here is a taste rule, not a safety check.
    // Playtest is the acceptance test for this course, by the owner's choice.
    for (let i = 1; opts.requireSafeLine !== false && i < spine.length; i++) {
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

/**
 * One themed signal colour, with the shipped value as the fallback.
 *
 * Read at build time rather than baked, and tolerant of running under node
 * (`tools/winding.mjs` and friends import this module with no boot).
 */
function themeAccent(key, fallback) {
  try {
    const t = getTheme()
    const v = t && t.accents && t.accents[key]
    return v == null ? fallback : v
  } catch { return fallback }
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
    // The lowest solid mass in the world is the foot of the big walls under the
    // extension, tapering to about y = -28. -52 keeps the kill plane well below
    // it, so every part of the route — the summit at y = 40 most of all — has a
    // real fall under it, and it still resets inside ~1.6 s at terminal velocity.
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

    // Guard against a mirrored placement flipping triangle winding.
    //
    // A negative-determinant matrix reverses the orientation of every triangle
    // it transforms, and the surface materials are FrontSide, so those
    // triangles would be backface-culled — present, lit, and invisible.
    //
    // HONEST NOTE: as of this writing NO placement in the level is actually
    // mirrored, so this branch is currently dead code. It is kept because it
    // is correct and costs one determinant, and because the moment someone
    // hands a prefab left-to-right with a negative scale it stops being dead.
    //
    // It was NOT the cause of the inconsistent-winding bug either. That bug
    // was real and is now fixed at generation time (`props.Builder.triOut` and
    // `props.flattenFolded`); `node tools/winding.mjs` attributes every
    // remaining triangle to the call that made it and now reports zero.
    const mirrored = matrix.determinant() < 0

    if (index) {
      if (mirrored) {
        for (let i = 0; i < index.count; i += 3) {
          b.idx.push(base + index.getX(i), base + index.getX(i + 2), base + index.getX(i + 1))
        }
      } else {
        for (let i = 0; i < index.count; i++) b.idx.push(base + index.getX(i))
      }
    } else if (mirrored) {
      for (let i = 0; i < count; i += 3) b.idx.push(base + i, base + i + 2, base + i + 1)
    } else {
      for (let i = 0; i < count; i++) b.idx.push(base + i)
    }
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
      // The lantern IS the grapple-anchor marker, so its colour is load-bearing
      // signal rather than decoration — it has to belong to whichever world we
      // are in. See `theme.accents`.
      const mat = glowMaterial(themeAccent('lantern', PALETTE.brass), 2.2)
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

    // Everything in the level moves in shaders (foliage wind, gate/beacon
    // clocks), never by changing an Object3D transform. Freeze the already
    // resolved matrices so the prepass and beauty pass do not re-compose and
    // re-multiply the same static transform tree every frame. The tag lets the
    // executable before/after gate restore three's default behaviour.
    this.group.userData.scStaticRoot = true
    this.group.updateMatrixWorld(true)
    this.group.traverse((object) => {
      object.matrixAutoUpdate = false
      object.matrixWorldAutoUpdate = false
      object.matrixWorldNeedsUpdate = false
    })

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
      uHot: { value: new THREE.Color(themeAccent('gateHot', 0xffc266)) },
      uCool: { value: new THREE.Color(themeAccent('gateCool', 0x9fd8c8)) },
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
   * The goal beacon: a warm light shaft standing over the summit finish.
   *
   * The islands visible from any long air phase used to be unmarked, and until
   * this not one of them told the player where the route ended. taste.md asks
   * the player to "read the route
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
        uColor: { value: new THREE.Color(themeAccent('beacon', 0xffd08a)) },
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
 * Progressive ability unlocks, in course order.
 *
 * Ethan, after playing: *"I wish we only unlocked abilities as we need them and
 * we communicate that to the user (jump for first jumps, wall climb/jump for
 * wall(s), double jump for bigger jumps, q ability for even bigger, and grapple
 * once necessary)."* The move set is handed over one verb at a time, gated on
 * PROGRESS (a checkpoint count, never a timer) and lined up with the section
 * that already teaches that verb in isolation — so the unlock lands exactly
 * where the geometry starts demanding it, which is the same teaching structure
 * docs/course-design.md already believed in but had always granted implicitly.
 *
 * `at` is the value of `run.checkpointsHit` that opens the verb: the Nth
 * checkpoint reached. The spine, in order, is
 *   1 terrace · 2 the gaps · 3 the ledges · 4 the crossing · 5 the chain ·
 *   6 the tower · 7+ the grapple-mandatory extension,
 * so each `at` names the checkpoint whose NEXT leg first demands the verb.
 *
 * ACT FOUR RENUMBER (2026-07-27, the checkpoint-thinning lane): 'the underpass'
 * checkpoint was cut — the slide it marked is taught by geometry, and the leg
 * into it (the section-4 wall-run) is interesting enough to re-run that a save
 * point in the middle of it was only marking progress. Cutting it slides 'the
 * chain' from count 6 to 5 and 'the tower' from 7 to 6, so `dash` and `grapple`
 * move down one to stay pinned to the SAME two checkpoints they always keyed on.
 * The teaching order is unchanged; only the counts renumbered. See the
 * checkpoint list below and `SKYLINE_UNLOCKS`.
 *
 *   jump    from the first step — the base verb, never actually withheld, only
 *           named once the run gets moving.
 *   wall    at 'the ledges' (3): the very next leg is the section-4 wall-run
 *           across the void, the first wall the course puts in the way. Covers
 *           the lateral run, the vertical climb, and the wall-jump (section 6).
 *   double  at 'the crossing' (4): the bigger gaps past the wall.
 *   dash    at 'the chain' (5): the leap off the tower (tower -> far-1) is a
 *           committed dash gap, and it is the leg immediately after the tower —
 *           so the charge has to be in hand a checkpoint early.
 *   grapple at 'the tower' (6): ACT TWO is grapple-mandatory (far-1 -> far-2 is
 *           23 m of void that no jump crosses). The grapple MUST open on the
 *           last spine checkpoint, BEFORE the first crossing that needs it, or
 *           the course soft-locks — the worst bug this feature could ship.
 *
 * Every leg between two of these is completable with exactly the verbs open by
 * the time the player arrives (checked by hand and by driving; see src/hud.js).
 * Because each `at` is the checkpoint that sits on the linear path just BEFORE
 * the leg that needs the verb, and the locked verbs cannot skip ahead of their
 * own checkpoint, the ordering is soft-lock-proof by construction.
 *
 * This order is Ethan's. src/hud.js owns HOW each verb is withheld and how the
 * unlock is announced; this table owns only WHICH verb opens WHERE. Nothing
 * here touches geometry, anchors, or checkpoints, so the reachability gate
 * (tools/reachability.mjs), which assumes the full move set and harvests the
 * static level, is untouched — the withholding is a runtime play-state overlay.
 */
export const SKYLINE_UNLOCKS = [
  { verb: 'jump', at: 0 },
  { verb: 'wall', at: 3 },
  { verb: 'double', at: 4 },
  { verb: 'dash', at: 5 },
  { verb: 'grapple', at: 6 },
]

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
  //
  // The -Z run starts at the island's edge (x=123) rather than at the lintel,
  // so the whole LEFT flank from the checkpoint through the slot is closed by
  // something the player can read. It stops at x=149 on purpose: the apron
  // beyond it is where the `low-7` branch dashes in over the void from
  // z=-26, and a parapet there would delete an authored route to buy nothing.
  K.balustrade(L, 123, 0, -8.6, { length: 26, height: 1.5, thickness: 0.7, kind: 'brass', detail: 1 })
  K.balustrade(L, 131, 0, 5.6, { length: 18, height: 1.5, thickness: 0.7, kind: 'brass', detail: 1 })
  K.vineCurtain(L, 126, -0.5, -9.4, { length: 20, drop: 6 })
  K.waterfall(L, 152, -0.45, 6.4, { height: 30, width: 2.4 })
  // CHECKPOINT THINNING (Act Four): 'the underpass' checkpoint used to sit here
  // at (126, 1.4, -1.5). It was cut. The slide is taught by geometry, `double`
  // was already learned at 'the crossing', and the leg leading into it — the
  // section-4 wall-run over the void — is one of the course's highlights, so a
  // save point in the middle of it only marked progress. Dying in the slide now
  // sends you back to 'the crossing', which re-runs the wall-run: a mistake that
  // costs interesting ground, which is difficulty, not a chore. This is the one
  // cut inside the taught spine; it renumbers `dash`/`grapple` unlocks (see
  // SKYLINE_UNLOCKS) but keeps them pinned to the same two checkpoints.
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

  // ---- The frozen spine, as a graph -------------------------------------
  // The geometry above (Sections 1-7, x 0..229) is FROZEN, so these links
  // DESCRIBE it rather than shape it. They exist so the reachability walk
  // starts at the spawn and covers the taught course in one connected piece.
  // Everything here is a SAFE-LINE mode (free / contiguous / wallrun /
  // walljump / stair): the opening course is a teaching course and is
  // completable with no dash and no grapple, and the checkpoint spine below
  // holds it to that. The grapple only becomes load-bearing in ACT TWO.
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

  // ========================================================== ACT TWO ======
  //
  // THE LONG REACH. Everything below is new, and it is where the grapple stops
  // being optional. The taught spine (Sections 1-7) is completable with no dash
  // and no grapple and keeps its safe line; past the tower the islands pull
  // apart until no jump can cross them, and a brass anchor on the far rim is the
  // only way over. Ethan, 2026-07-26: *"extend the original course farther,
  // making it harder as we go, far spaced out islands, big walls ... that way
  // there is a reason for the grapple. the first part you dont even need it
  // for."* So this is built to exactly that: one dash gap to raise the stakes,
  // then FIVE grapple-mandatory crossings, each wider than the last, over big
  // brass walls that fall away into cloud.
  //
  // Every distance here is checked at load by `Archipelago.verify` against the
  // real engine numbers — a shot over 34 m, or a landing the arrival jump cannot
  // make, throws rather than ships. The margins were worked by hand: the grapple
  // shots land at 18-25 m (well inside the 5-32 m window), every arrival is a
  // free drop off the anchor, and every crossing gap exceeds the 15.6 m dash
  // reach so the cuff is the ONLY way across. Difficulty past the tower is the
  // owner's call, per the brief; these gates prove the course is physically
  // possible, not that it is gentle.
  const re = makeRand(0x5EAC0DE)

  /**
   * A BIG WALL — the brief's "big walls" — carrying an island on its crown.
   *
   * It rises out of the cloud as a tapered brass ashlar shaft with a porcelain
   * cornice and a brass band at every joint, the same mast the observatory
   * tower stood on. Its crown is always NARROWER than the deck above it, so the
   * drum overhangs it and the wall presents no standable face of its own: a
   * thing to see and to fall past, never a platform, which keeps the
   * reachability graph honest. Solid top to bottom, because a wall you can see
   * and fall through is the exact bug that killed the predecessor.
   */
  const wall = (x, zc, botY, topY, topW) => {
    const courses = Math.max(3, Math.round((topY - botY) / 9))
    const h = (topY - botY) / courses
    for (let i = 0; i < courses; i++) {
      const t = i / (courses - 1)
      const w = topW * (1.4 - 0.4 * t)
      L.massif(x, botY + h * (i + 0.5), zc, w, h, w, 'brass', 'porcelain')
      if (i < courses - 1) {
        L.solid(x, botY + h * (i + 1), zc, w + 0.5, 0.4, w + 0.5, 'brass', { shade: 1.1 })
      }
    }
    // The foot, tapering away into cloud. Solid — it hangs under a mass the
    // player falls past — and buried under the shaft, so it is not a platform.
    const base = topW * 1.4
    L.solid(x, botY - h * 0.22, zc, base * 0.78, h * 0.44, base * 0.78, 'stone')
    L.solid(x, botY - h * 0.52, zc, base * 0.5, h * 0.3, base * 0.5, 'stone')
  }

  /**
   * Light per-island dressing off one seeded stream, so the world is stable.
   *
   * The cypress sits at a FIXED corner offset, never a random position through
   * the deck centre: every extension checkpoint is at its island's centre, and
   * a trunk that could wander within a capsule radius of one would trip
   * `assertTriggersClear`. A back corner is comfortably clear of both the
   * checkpoint and the incoming anchor post on the near rim.
   */
  const dressReach = (x, y, z, span, drop) => {
    K.cypress(L, x + span * 0.30, y, z + span * 0.28,
      { height: 5 + re() * 3, rand: re, detail: 1 })
    if (drop) {
      K.waterfall(L, x - span * 0.30, y - 0.45, z - span * 0.42,
        { height: 18 + re() * 16, width: 1.4 + re() * 0.7, rand: re })
    }
  }

  // The islands. Each is square, so its reach-out is its half-width in every
  // direction, and each high one stands on a big wall. No `launchY`: the deck
  // top is the take-off height, and none of these carries a ramp.
  deck(244, 8.4, 0, 12, 12, WILD, { id: 'far-1', detail: 2, bodyDepth: 3.2, seed: (re() * 0xffffff) | 0 })
  deck(280, 8.4, 0, 14, 14, BUILT, { id: 'far-2', detail: 2, bodyDepth: 3.4, seed: (re() * 0xffffff) | 0 })
  deck(300, 20.0, 6, 12, 12, WILD, { id: 'far-3', detail: 2, bodyDepth: 3.0, seed: (re() * 0xffffff) | 0 })
  deck(326, 26.0, -14, 12, 12, WILD, { id: 'far-4', detail: 2, bodyDepth: 3.0, seed: (re() * 0xffffff) | 0 })
  deck(352, 30.0, -30, 12, 12, BUILT, { id: 'far-5', detail: 2, bodyDepth: 3.0, seed: (re() * 0xffffff) | 0 })
  deck(380, 40.0, -46, 16, 16, BUILT, { id: 'summit', detail: 2, bodyDepth: 4.2, seed: (re() * 0xffffff) | 0 })

  // The big walls the high islands stand on. From the terrace they read as a
  // row of brass slabs climbing into the sky; the tallest, under the summit,
  // is ~48 m of wall over open cloud.
  wall(300, 6, -22, 19.5, 6.0)     // under far-3
  wall(326, -14, -16, 25.5, 6.0)   // under far-4
  wall(352, -30, -12, 29.5, 6.0)   // under far-5
  wall(380, -46, -8, 39.5, 7.0)    // under the summit

  dressReach(244, 8.4, 0, 12, true)
  dressReach(280, 8.4, 0, 14, false)
  dressReach(300, 20.0, 6, 12, true)
  dressReach(326, 26.0, -14, 12, false)
  dressReach(352, 30.0, -30, 12, true)

  // THE ANCHORS. One brass lantern on the far rim of every grapple crossing —
  // placing the lantern is what makes the crossing exist (course-design.md:
  // "placing a brass lantern is what makes a route exist"). Remove one and the
  // gap it spans is simply impassable, and the build says so. Each stands on
  // the destination deck, so it is never an anchor floating over nothing.
  const p2 = K.lanternPost(L, 275, 8.4, 0, { height: 4.0 }).flame
  const p3 = K.lanternPost(L, 295.7, 20.0, 3.5, { height: 4.0 }).flame
  const p4 = K.lanternPost(L, 322.0, 26.0, -11.0, { height: 4.0 }).flame
  const p5 = K.lanternPost(L, 347.7, 30.0, -27.4, { height: 4.0 }).flame
  const p6 = K.lanternPost(L, 373.1, 40.0, -42.0, { height: 4.0 }).flame

  // THE OBSERVATORY SUMMIT — a waypoint now, not the finish. Act Three carries
  // the route on past it (below), so the observatory dome, the armillary and the
  // goal beacon have MOVED to the new zenith at the far end: leaving the "top of
  // the world" marker in the middle of the course would lie about where the run
  // ends. The summit keeps a cypress and a standard so it still reads as
  // somewhere you arrive and pause before the long reach out.
  K.cypress(L, 385, 40.0, -42, { height: 6.5, rand: re })
  K.lanternPost(L, 374, 40.0, -50, { height: 3.4 })

  // Checkpoints for Act Two. NOT part of the safe-line spine — grapple-gated by
  // design (see the receipt) — but each stands on its own deck so the trigger is
  // somewhere a body actually fits. The run continues into Act Three below,
  // where L.finish and L.beaconAt are set at the new zenith.
  //
  // CHECKPOINT THINNING (Act Four). This block used to hold four: 'the first
  // reach', 'the great wall', 'the long reach' and 'the skyline'. The last three
  // were cut. They stood one grapple crossing apart in the most homogeneous
  // stretch of the course — swing, land, swing again — so three of the four were
  // marking progress, not gating interesting ground. 'the first reach' survives
  // as the "you just got the grapple" save right after it opens; the next save
  // is now 'the descent' at the start of Act Three, so the whole Act-Two long
  // reach (far-2 -> far-3 -> far-4 -> far-5 -> summit -> sky-1) is one held
  // breath. Ethan asked for exactly this: "we have checkpoints, almost too many
  // ... so it's not difficult." Grapple swings are quick to execute, so a long
  // segment of them raises the stakes without becoming a chore over easy ground.
  L.checkpoint(280, 9.1, 0, 'the first reach')

  // THE EXTENSION GRAPH. tower -> far-1 is a committed dash (the stakes rise
  // before the cuff is needed); everything past far-1 is grapple-only, each
  // edge proven against the real anchor placed above.
  A.link('tower', 'far-1', 'committed', { note: 'the leap off the tower — a 9 m dash gap to raise the stakes' })
  A.link('far-1', 'tower', 'standard', { note: 'fall back onto the tower on a plain double jump' })
  A.link('far-1', 'far-2', 'grapple', { anchor: p2, note: 'the first reach: 23 m of void, no jump crosses it' })
  A.link('far-2', 'far-3', 'grapple', { anchor: p3, note: 'up the first great wall, 11.6 m of climb' })
  A.link('far-3', 'far-4', 'grapple', { anchor: p4, note: 'across and up, turning off the +X axis' })
  A.link('far-4', 'far-5', 'grapple', { anchor: p5, note: 'the long reach, out over the deep cloud' })
  A.link('far-5', 'summit', 'grapple', { anchor: p6, note: 'the last swing onto the skyline, ~34 m above the tower' })

  // ===================================================== ACT FOUR: THE SPIRE
  //
  // THE VERTICAL DETOUR. Ethan, 2026-07-27, after playing the shipped skyline
  // ("the new skyline is awesome so cool"), picking what comes next: a VERTICAL
  // DETOUR — *"a shaft you ascend by wall-running its faces, with anchors placed
  // up it ... roughly 150-200 m of climb — enough that the top is a different
  // world from the bottom."* This is the fix for the thing the "I want to FLY"
  // brief exposed: the course was broad but shallow (708 m across, 67 m up). The
  // spire is 150 m of climb in one place, hung off the Act-Two spine.
  //
  // IT IS A DETOUR, NOT A GATE, and it is LATERAL by design (Ethan: "I wouldn't
  // mind it going ... left and right as well ... the tower plus a sideways loop
  // back to the spine gives shape without making the run longer to re-run"). The
  // spine link far-1 -> far-2 (grapple) is UNTOUCHED, so a player who never
  // enters the spire runs the course exactly as before — `ROUTE` and
  // `report.routeMetres` below do not include a single spire node, so thinning
  // the checkpoints and adding the tower did not lengthen the main line by a
  // metre. The spire enters from far-1 and its top loops back down onto far-2,
  // one island along: an optional side-loop, taken for the view and the launch
  // off the top, skipped with no penalty.
  //
  // WHY OPTIONAL RATHER THAN MANDATORY (the design call the brief asked me to
  // make and write down): the main line is already a proven, gated difficulty
  // curve, and a 150 m blind climb with a single save at the top is the hardest
  // thing in the course. Forcing every run through it — including the leaderboard
  // runs — would turn one spectacular optional ascent into a wall that gates the
  // finish. Kept optional, it is a reward and a flex; made mandatory, it is a
  // toll. Ethan playtests the ceiling; an optional tower lets him raise it
  // without it blocking the parts he already likes.
  //
  // THE CLIMB, modelled honestly. The archipelago's structural modes
  // (wall-run / wall-jump / stair / contiguous) carry their height in geometry
  // rather than in a checked arc, exactly as Sections 4 and 6 do — so the two
  // shaft segments are `wallrun` edges with a note saying HOW, and the geometry
  // below makes the note true: a square brass well with flat runnable inner
  // faces and a ladder of grapple anchors up its centre, ~16 m apart, well
  // inside the 34 m cuff. You wall-run and wall-jump the faces for position and
  // grapple anchor-to-anchor for height. Because I cannot run the course in this
  // lane (dispatched worktrees can't boot a browser), the climb's *feel* is
  // flagged for an owner playtest the same way the HARDCORE line is — the anchor
  // spacing is deliberately generous so the grapple alone carries the ascent if
  // the wall-run timing turns out fussy. Falling in the well drops to the solid
  // base floor, not to the kill plane, so a miss costs the climb, never the run.
  //
  // THE LAUNCH OFF THE TOP feeds OVERDRIVE (the parallel lane): a ramp down the
  // vista deck's launch edge and an anchor slung out over the void ahead of the
  // lip, placed so a swing bottoms out pointing at far-2 — a THROW, not a hop.
  // The exit edge is proven crossable as a plain `standard` double-jump (the
  // 142 m drop buys the airtime), so it is never IMPOSSIBLE in NORMAL; overdrive
  // and the launch anchor just turn the descent into a dive. The slopes ask in
  // the same brief ("slopes for sliding") could not be delivered as authored
  // geometry: the collision world is AABB-only, so no floor contact ever returns
  // the tilted normal the slide-downhill accelerator in src/player.js needs, and
  // that fix lives outside this lane's owned files. `kit.ramp` builds the run-up
  // geometry ready for it; see that prefab's docstring for the full caveat.
  // A dedicated stream, NOT the shared `re` used by Acts Two and Three: drawing
  // from `re` here would advance it and cosmetically reshuffle the facet-jitter
  // seeds and tree heights of the already-shipped Act-Three islands Ethan just
  // playtested and liked. The spire's randomness is its own.
  const rs = makeRand(0x5217E)
  const SPIRE_X = 250, SPIRE_Z = 22
  const SPIRE_BASE_Y = 8, SPIRE_TOP_Y = 150     // 142 m of wall, y 8 -> 150
  // The four brass faces of the well. Outer footprint 9 x 9, walls 1.5 m thick,
  // a 6 m inner clear — opposite faces one wall-jump apart (wallJumpOut is 7 m),
  // and each face 9 m long so a lateral wall-run has room to breathe. The inner
  // faces are DEAD FLAT: like Section 4's crossing wall, nothing is allowed
  // proud of the running plane, so all four are single unbroken slabs.
  const wallMidY = (SPIRE_BASE_Y + SPIRE_TOP_Y) / 2      // 79
  const wallH = SPIRE_TOP_Y - SPIRE_BASE_Y               // 142
  L.solid(SPIRE_X + 3.75, wallMidY, SPIRE_Z, 1.5, wallH, 9, 'brass')            // +x face (inner x=253)
  L.solid(SPIRE_X - 3.75, wallMidY, SPIRE_Z, 1.5, wallH, 9, 'brass')            // -x face (inner x=247)
  L.solid(SPIRE_X, wallMidY, SPIRE_Z + 3.75, 6, wallH, 1.5, 'brass')           // +z face (the back)
  // The -z (entry) face is missing its lowest 7 m: a doorway you run in through
  // from the base ring, so the well is enterable without a hole in a wall-run
  // surface higher up. It resumes at y=15 and runs to the top.
  const doorTop = SPIRE_BASE_Y + 7                                             // 15
  L.solid(SPIRE_X, (doorTop + SPIRE_TOP_Y) / 2, SPIRE_Z - 3.75,
    6, SPIRE_TOP_Y - doorTop, 1.5, 'brass')                                    // -z face above the doorway

  // The base: a moss deck that is the well floor and a 2.5 m landing ring around
  // the shaft's foot, so the jump in from far-1 has somewhere to land before you
  // step through the doorway.
  deck(SPIRE_X, SPIRE_BASE_Y, SPIRE_Z, 14, 14, WILD,
    { id: 'spire-base', bodyDepth: 3.4, seed: (rs() * 0xffffff) | 0 })

  // A mid ledge, two-thirds of the way up: a real shelf against the back face to
  // rest a hand on, and the intermediate archipelago node that keeps each
  // structural climb claim to ~75 m rather than one 142 m leap of faith.
  const SPIRE_MID_Y = 83
  L.solid(SPIRE_X, SPIRE_MID_Y - 0.25, SPIRE_Z + 2.0, 5, 0.5, 3, 'porcelain')
  A.node('spire-mid', SPIRE_X, SPIRE_MID_Y, SPIRE_Z + 2.0, 5, 3, { launchY: SPIRE_MID_Y })

  // The vista deck: the top of the world, and a different one from the bottom —
  // a moss garden 142 m up, abutting the +x face so you mantle straight out of
  // the well onto it. This is the spire's reward and its only save point.
  deck(262, SPIRE_TOP_Y, SPIRE_Z, 14, 14, WILD,
    { id: 'spire-top', bodyDepth: 4.0, seed: (rs() * 0xffffff) | 0 })
  K.cypress(L, 266, SPIRE_TOP_Y, SPIRE_Z + 4, { height: 7.5, rand: rs })
  K.waterfall(L, 258, SPIRE_TOP_Y - 0.5, SPIRE_Z + 5.4, { height: 40, width: 2.2, rand: rs })

  // THE ANCHOR LADDER up the well: bracket lanterns on alternating inner faces,
  // ~16 m apart, each hanging near the well's centre column so it is an easy
  // grapple from the foothold below. This is the ascent the two structural edges
  // are asserting: the grapple does the lifting, the faces do the positioning.
  for (const [ay, side] of [
    [24, 1], [40, -1], [56, 1], [72, -1],          // lower segment: base -> mid
    [96, 1], [112, -1], [128, 1], [144, -1],       // upper segment: mid -> top
  ]) {
    const faceX = SPIRE_X + side * 3.0             // just off the inner face
    K.lanternPost(L, faceX, ay, SPIRE_Z,
      { post: false, reach: -side * 2.4, axis: 'x', height: 0.7 })
  }
  // The climb-out anchor, standing on the vista deck at the well mouth: grapple
  // to it from the top of the last wall-run and you land squarely on the deck,
  // so reaching the top never hinges on a single mantle over the wall lip.
  K.lanternPost(L, 256, SPIRE_TOP_Y, SPIRE_Z, { height: 5.5 })

  // THE LAUNCH. A ramp down the deck's +x edge to pour speed into, and an anchor
  // slung out over the void ahead of the lip — the placement discipline the
  // brief names: "an anchor 6 m above and 10 m short of a gap converts a swing
  // into a throw." Swing off it and the arc bottoms out pointing down the drop
  // at far-2. Nothing here is graph-load-bearing (the exit is a proven plain
  // double-jump); this is the fast/overdrive line, laid in as geometry.
  K.ramp(L, 263, SPIRE_TOP_Y, SPIRE_Z, { length: 6, drop: 3, width: 8, axis: 'x', kind: 'brass' })
  K.lanternPost(L, 269, SPIRE_TOP_Y - 1.0, SPIRE_Z - 4,
    { post: false, reach: 4, axis: 'x', height: 0.5 })

  // THE SPIRE GRAPH. Two band-checked jumps (in from far-1, out onto far-2) and
  // two structural climbs between them; the down direction is a plain fall the
  // player can always take, so no soft-lock. Every edge here was hand-computed
  // against the same envelope `Archipelago.verify` uses:
  //   far-1 -> spire-base : 9.8 m at dy -0.4  -> standard  (a double jump in)
  //   spire-top -> far-2  : 14.4 m at dy -142 -> standard  (the 142 m drop out)
  //   spire-base <-> far-1: the back-out, so entering never traps you.
  A.link('far-1', 'spire-base', 'standard', { note: 'the double-jump across onto the spire foot' })
  A.link('spire-base', 'far-1', 'standard', { note: 'back out of the spire without climbing it' })
  A.link('spire-base', 'spire-mid', 'wallrun',
    { note: 'the lower shaft: wall-run the brass faces and grapple the four anchors at y 24/40/56/72 up to the mid ledge' })
  A.link('spire-mid', 'spire-top', 'wallrun',
    { note: 'the upper shaft: four more anchors at y 96/112/128/144, then the mouth anchor onto the vista deck' })
  A.link('spire-top', 'far-2', 'standard',
    { note: 'the launch off the top — a 142 m drop that lands on far-2, one island along; overdrive turns it into a dive' })

  // The spire's one checkpoint is REGISTERED LAST, down beside 'the zenith'
  // below — deliberately, not where the geometry is built. The gate shader only
  // ever draws the SINGLE next-unreached checkpoint in ARRAY order (level.js
  // `_gates`: it discards every state but "next"), so a spire checkpoint sitting
  // in array order right after 'the first reach' would hijack the hot waypoint
  // and steer every main-line run up an OPTIONAL detour. Registered last, it is
  // only ever "next" once the whole main line is already done — i.e. never, on a
  // finished run — so the waypoint stays on the through-line. The 150 m spire is
  // its own wayfinding; it needs no gate pointing at it.

  // ========================================================= ACT THREE =====
  // THE BIG SKYLINE — the fly gauntlet. Ethan, 2026-07-26: *"extend the original
  // course farther ... I really want to be able to FLY on some of the later
  // parts ... giant walls, cool sliding things, nice anchors so I can LAUNCH
  // myself. big spaces between platforms."* So the route leaves the observatory
  // summit on a downhill double-jump launch and weaves out across a long chain
  // of BIG grapple crossings — 15-21 m of open void each, every anchor slung on
  // the far rim so the swing bottoms out pointing on down the route — drops
  // through a low slide span, then climbs a colonnade of giant brass walls to a
  // new zenith ~26 m above the old summit and 330 m farther east.
  //
  // Horizontal stays the through-line (+X, x 380..712, per Ethan: "main travel
  // direction is horizontal overall"); the LINE weaves z from -48 out to +20 and
  // back, and undulates y 40 -> 23 -> 66 ("okay with rising falling sections"),
  // so it reads as a place rather than the flat straight ladder it was. Each
  // section asks for something new: the descent is downhill flow, the reaches are
  // pure launch-and-swing, the span is a slide beat, the great walls are a
  // vertical grapple climb. Difficulty is a curve — Acts 1-2 are unchanged and
  // Act Three assumes the full move set (grapple opens at 'the tower', long
  // before here). Per the brief it is allowed to be hard; the owner playtests the
  // ceiling. Every crossing is proven at load by `Archipelago.verify` against the
  // real engine numbers (the grapple shots all land at 18-23 m, inside the
  // 5-32 m window with margin; the one jump is a downhill double at 75% of reach).
  //
  // MODES: grappleRange is 34 m in FUN, NORMAL and HARDCORE alike, so every
  // anchor is in reach of all three. The uphill great-wall crossings are a winch
  // fantasy in FUN/NORMAL; in HARDCORE (a tether that holds distance and never
  // reels) the giant brass wall under each high deck is a runnable face — swing
  // to it on the tether, wall-run up onto the deck. That HARDCORE line is
  // by-hand reasoning, NOT a validated per-mode gate — this lane cannot run the
  // harness — so it is flagged for a manual HARDCORE playtest.
  const t3 = [
    { id: 'sky-1',   x: 404, y: 34, z: -38, w: 12, style: WILD },
    { id: 'sky-2',   x: 432, y: 31, z: -24, w: 12, style: BUILT },
    { id: 'span',    x: 460, y: 28, z: -8,  w: 14, style: BUILT },
    { id: 'reach-a', x: 486, y: 27, z: 8,   w: 12, style: WILD },
    { id: 'reach-b', x: 514, y: 26, z: 20,  w: 12, style: BUILT },
    { id: 'gulf',    x: 546, y: 23, z: 14,  w: 12, style: WILD },
    { id: 'rise',    x: 576, y: 27, z: 2,   w: 12, style: BUILT },
    { id: 'wall-1',  x: 604, y: 33, z: -10, w: 12, style: BUILT },
    { id: 'wall-2',  x: 632, y: 41, z: -22, w: 12, style: WILD },
    { id: 'wall-3',  x: 658, y: 50, z: -32, w: 12, style: BUILT },
    { id: 'wall-4',  x: 684, y: 58, z: -40, w: 12, style: WILD },
    { id: 'zenith',  x: 712, y: 66, z: -48, w: 18, style: BUILT },
  ]
  for (const s of t3) {
    deck(s.x, s.y, s.z, s.w, s.w, s.style,
      { id: s.id, detail: 2, bodyDepth: 3.2, seed: (re() * 0xffffff) | 0 })
  }
  // Light dressing on the new islands, off the same seeded stream as Act Two.
  // 'span' is skipped — its slide lintel occupies the middle, where the cypress
  // would otherwise grow — and the zenith gets its own dressing below.
  for (let i = 0; i < t3.length - 1; i++) {
    const s = t3[i]
    if (s.id !== 'span') dressReach(s.x, s.y, s.z, s.w, i % 2 === 0)
  }

  // THE GIANT WALLS. Each high deck of the climb stands on a tapered brass
  // ashlar shaft falling ~46 m into the cloud — the "row of brass slabs climbing
  // into the sky" the brief asks for, and (crown always narrower than the deck it
  // carries, so the drum overhangs it) never a standable face of its own. In
  // HARDCORE the shaft face is the wall-run route up onto the deck above it.
  wall(604, -10, -14, 32.5, 5.0)   // under wall-1
  wall(632, -22, -14, 40.5, 5.0)   // under wall-2
  wall(658, -32, -12, 49.5, 5.0)   // under wall-3
  wall(684, -40, -10, 57.5, 5.0)   // under wall-4
  wall(712, -48, -8,  65.5, 6.0)   // under the zenith

  // THE SLIDE SPAN. A ceiling too low to run under, dropped over the middle of
  // 'span' — the same read as Section 5, out here as a beat of rhythm between two
  // big reaches. Underside at deck + 1.35, the mouldings stacked above it, so
  // nothing the slide passes through is solid. The checkpoint sits on the near
  // rim, clear of the lintel.
  L.solid(462, 30.15, -8, 10, 1.6, 12, 'terracotta')     // lintel, underside 1.35
  L.solid(462, 29.50, -8, 10.6, 0.3, 12.4, 'porcelain')  // impost band
  L.solid(462, 31.10, -8, 9.4, 0.3, 11.4, 'porcelain')   // upper band
  K.balustrade(L, 456, 28, -13.5, { length: 12, height: 1.2, thickness: 0.5, kind: 'brass', detail: 1 })

  // THE ANCHORS + THE GRAPH. summit -> sky-1 is a downhill double-jump launch;
  // every crossing after it is grapple, each anchor computed onto the far deck's
  // near rim (foot on the deck, flame 4 m up) so the shot is 18-23 m — inside the
  // 5-32 m window with margin — and the swing exit points on down the route. The
  // anchors are computed rather than hand-placed so the shot the verifier checks
  // is exactly the shot the geometry produces.
  const chain = [{ id: 'summit', x: 380, y: 40, z: -46, w: 16 }, ...t3]
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i]
    if (i === 1) {
      A.link(a.id, b.id, 'standard',
        { note: 'off the observatory summit, a downhill double-jump launch into Act Three' })
      continue
    }
    const dx = a.x - b.x, dz = a.z - b.z
    const len = Math.hypot(dx, dz) || 1
    const inb = b.w / 2 - 1
    const anchor = K.lanternPost(L, b.x + (dx / len) * inb, b.y, b.z + (dz / len) * inb,
      { height: 4.0 }).flame
    A.link(a.id, b.id, 'grapple', { anchor, note: `Act Three: the big reach onto ${b.id}` })
  }

  // THE ZENITH. The observatory dome, the armillary, the finish and the goal
  // beacon, relocated here from the old summit — the true top of the world now.
  // The dome sits off to the side so the finish trigger and the beacon are not
  // inside it (`assertTriggersClear`).
  K.observatoryDome(L, 716, 66.0, -50, { radius: 4.5, wallHeight: 6 })
  K.armillary(L, 713, 66.0, -53, { radius: 2.8 })
  K.waterfall(L, 712, 65.6, -56.6, { height: 46, width: 2.6, rand: re })
  K.vineCurtain(L, 708, 65.5, -56.8, { length: 6, drop: 7, rand: re })
  K.cypress(L, 705, 66.0, -43, { height: 6.5, rand: re })
  K.lanternPost(L, 704.5, 66.0, -54.5, { height: 3.6 })

  // Act Three checkpoints. Grapple-gated by design, so out of the safe-line
  // spine — but each stands clear on its own deck ('the zenith' beside the dome,
  // never under it).
  //
  // CHECKPOINT THINNING (Act Four). 'the low span' (was at 454, on the slide
  // span's near rim) was cut: the slide beat is short and the swings around it
  // are the same swing the rest of the act is made of, so it saved little. That
  // leaves 'the descent' -> 'the gulf' as one five-crossing segment through the
  // middle reaches, and keeps 'the buttress' — the save the ascent up the giant
  // walls actually needs, since dying at the top of a six-wall climb and redoing
  // all six would be the tedious kind of hard, not the good kind. The endgame
  // (buttress -> zenith) stays three crossings so the hardest ground has the
  // tightest granularity, which is the right shape for a difficulty curve.
  L.checkpoint(404, 34.7, -38, 'the descent')
  L.checkpoint(546, 23.7, 14, 'the gulf')
  L.checkpoint(632, 41.7, -22, 'the buttress')
  L.checkpoint(708, 66.7, -46, 'the zenith')
  // The optional spire's save point (geometry built up in Act Four above),
  // registered here so it lands LAST in the checkpoint array — see the note at
  // the spire for why array order matters to the gate waypoint. It is only ever
  // reached after the tower, so it never disturbs the teaching-unlock counts.
  L.checkpoint(262, 150.6, 22, 'the spire')

  L.finish = new THREE.Vector3(708, 66.6, -46)
  L.beaconAt = { x: 718, y: 74, z: -50, height: 130, radius: 4.4 }

  // ---- The receipt -------------------------------------------------------
  //
  // Everything above is a claim. This is where it is checked, at load, in the
  // shipping build, on the same code path the player runs. A world that fails
  // any of these does not boot — which is the only way a rule about
  // reachability survives contact with a level that keeps growing.
  const ROUTE = [
    'terrace', 'gap-1', 'gap-2', 'gap-3', 'viaduct', 'crossing', 'underpass',
    'chain-foot', 'chain-head', 'tower',
    'far-1', 'far-2', 'far-3', 'far-4', 'far-5', 'summit',
    'sky-1', 'sky-2', 'span', 'reach-a', 'reach-b', 'gulf', 'rise',
    'wall-1', 'wall-2', 'wall-3', 'wall-4', 'zenith',
  ]
  // THE SAFE-LINE SPINE IS THE ORIGINAL TEACHING COURSE ONLY. course-design.md
  // makes the sunset course a teaching course whose no-dash/no-grapple line is
  // part of its design, so Sections 1-7 keep it and every consecutive pair here
  // is reachable with free / contiguous / wall-run / wall-jump / stair alone.
  // The extension past the tower is deliberately grapple-gated — Ethan,
  // 2026-07-26: *"that way there is a reason for the grapple. the first part you
  // dont even need it for."* — so its checkpoints are omitted from this list.
  //
  // Omitting them is exactly how the safe line is dropped for the extension and
  // kept for the spine: `verify`'s safe-line walk only visits SPINE entries. The
  // UNCONDITIONAL gates still bind on EVERY island — bands honest, nothing
  // orphaned from the spawn, nothing a trap with no way on, and the >34 m and
  // grapple-shot physics — so the extension is proven POSSIBLE (and each of its
  // five crossings proven grapple-only), just not proven gentle.
  const SPINE = [
    'terrace', 'gap-1', 'viaduct', 'crossing', 'underpass', 'chain-head', 'tower',
  ]
  const report = A.verify('terrace', 'zenith', SPINE)
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
  // Progressive unlocks (src/hud.js). `id` keys the "verbs already learned"
  // memory per course, so a returning player is handed the whole set at once
  // and never re-taught. The void course declares no schedule and is unaffected.
  L.id = 'skyline'
  L.unlocks = SKYLINE_UNLOCKS
  K.assertAllPlaced()
  return L
}
