import * as THREE from 'three'
import { Level, Archipelago } from '../level.js'
import { trackedKit } from '../kit.js'

/**
 * THE VOID — theme 2's course.
 *
 * A SECOND LEVEL, not the archipelago repainted. Ethan: "the theme is a totally
 * different map with totally new sprites, totally new everything to match the
 * screen. It's like a totally different level." (`art-direction-void.md` §0.)
 *
 * ------------------------------------------------------- the shape of it
 *
 * The sunset course runs +X along a horizontal spine. This one runs +Y. The
 * brief asks for "the player almost flying upward", so progress is height and
 * the player reads it by looking UP at where they are going.
 *
 * ------------------------------------------- built for the whole movement set
 *
 * The first version of this course was a timid spiral of 5-8 m hops. Ethan,
 * after running it:
 *
 *   "you're limiting yourself with how you place these. It's very very easy and
 *   you don't realize how well I can do with the grapple and the air dash.
 *   Release the constraints on yourself — you can make things far apart, really
 *   creative in terms of placement. If there's something impossible I'll tell
 *   you but I highly doubt it."
 *
 * He then removed the rule that was forcing the timidity outright:
 *
 *   "I don't think there should be a rule that it should be doable without the
 *   grapple and without the ability. The rule should just be it's doable in
 *   NORMAL, and I'm the one who can determine that. So that way you're not
 *   restricted or constrained in any way."
 *
 * Both recorded in `art-direction-void.md` §0b. So this course passes
 * `requireSafeLine: false` and is laid out for the whole movement set: hero
 * islands across the ENTIRE band table, from free hops to 30 m grapple
 * crossings, with deliberate dives onto spurs hung below the main line.
 *
 * What is still enforced: bands must be labelled honestly, nothing may be
 * orphaned, nothing may be a trap, and nothing may exceed 34 m without an
 * anchor — that last one is physics, not taste, and this file throws on it.
 * The acceptance test for difficulty is Ethan playing it in NORMAL.
 *
 * ------------------------------------------------------------- STATUS
 *
 * The LAYOUT is real. The GEOMETRY is still placeholder slabs: the ruin
 * prefabs (`src/voidkit.js` — great walls, rune slabs, sigil rings), the
 * crystals (`src/crystals.js`) and the beams (`src/fx/voidfx.js`) are being
 * built in parallel and drop into the placement hooks marked PREFAB below.
 */

// Physics, from docs/course-design.md. Quoted here because every distance in
// this file is chosen against them and a reader should not have to go looking.
//   sprint jump ~7.3 m · +double ~13.7 m · +dash ~19 m · grapple 5-34 m
//   jump 1.42 m up · double ~2.5 m · mantle <=1.45 m
const REACH_COMMITTED = 19
const REACH_GRAPPLE = 34

export function buildVoidCourse(collision) {
  const L = new Level(collision)
  const K = trackedKit()
  const A = new Archipelago()

  L.spawn.set(0, 1.4, 0)
  L.spawnYaw = 0
  // Far deeper than the skyline's -52. The void has to read as bottomless
  // (§6), which means the player must fall long enough to believe it.
  L.killY = -140

  const nodes = new Map()

  /** A landing surface: collider and graph node from ONE declaration. */
  const pad = (id, x, y, z, w, d = w) => {
    A.node(id, x, y, z, w, d)
    L.solid(x, y - 0.6, z, w, 1.2, d, 'stone')
    const n = { id, x, y, z, w, d }
    nodes.set(id, n)
    return n
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

  /**
   * Link two islands, choosing the band from the ACTUAL distance rather than
   * from intent — `verify()` re-checks it and a wrong label is a hard failure.
   */
  const hop = (a, b, note) => {
    const g = dist(nodes.get(a), nodes.get(b))
    const mode = g <= 7 ? 'free' : g <= 13 ? 'standard' : 'committed'
    A.both(a, b, mode, note ? { note } : undefined)
    return mode
  }

  /**
   * Connect two islands with whatever the geometry actually needs.
   *
   * VERTICAL GAIN IS THE EXPENSIVE AXIS and it is easy to forget, because the
   * band table is written in horizontal metres. A double jump buys ~2.5 m of
   * height in total, so anything above that is a grapple however short the hop
   * looks in plan — the first draft of this course tried to jump 10 m straight
   * up and the validator rightly refused it.
   */
  /**
   * A ONE-WAY drop. `hop`/`A.both` mirror a link, and a mirrored dive is a lie:
   * falling 7 m onto a spur is free, climbing 7 m back out is not, and the
   * validator catches the reverse edge as unachievable. A dive in and a
   * different route out is also just better design — it commits the player.
   */
  /**
   * A grapple crossing: ONE anchor, hung in the void BETWEEN the two islands.
   *
   * Ethan, playing: "there's two to three anchors per platform, when really
   * there should be one, and sometimes, rarely, there's none. And the anchors
   * don't necessarily need to always be on the platform."
   *
   * The previous version placed one anchor per DIRECTION, each sitting over an
   * island, on my reasoning that a single anchor could not satisfy both of
   * `Archipelago.link`'s legs. That was wrong, and the arithmetic is worth
   * writing down because it is also what unlocked the long crossings:
   *
   *   the shot     take-off RIM to anchor, 5 .. 34*0.94 = 31.9 m
   *   the arrival  anchor to landing, no worse than `committed` (19 m)
   *
   * At the MIDPOINT both legs are about half the crossing, so one anchor serves
   * both directions for any gap up to roughly 2 x 19 = 38 m — nearly double
   * what an anchor over the landing allowed. One anchor, in mid-air, and a much
   * bigger course all fall out of the same correction.
   */
  const fly = (a, b, note) => {
    const LIFT = 5
    const p = nodes.get(a), q = nodes.get(b)
    const ax = (p.x + q.x) / 2
    const az = (p.z + q.z) / 2
    const ay = Math.max(p.y, q.y) + LIFT
    L.lantern(ax, ay, az)
    A.both(a, b, 'grapple', { anchor: [ax, ay, az], note })
  }

  const drop = (a, b, note) => {
    const p = nodes.get(a), q = nodes.get(b)
    const g = dist(p, q)
    // Falling does not make a gap shorter. A dive of 26 m is still past
    // `committed` however far down the landing is, so a long dive is a grapple
    // like any other long crossing — it just happens to end lower.
    if (g > REACH_COMMITTED) {
      const ax = (p.x + q.x) / 2, az = (p.z + q.z) / 2
      const ay = Math.max(p.y, q.y) + 5
      L.lantern(ax, ay, az)
      A.link(a, b, 'grapple', { anchor: [ax, ay, az], note })
      return
    }
    A.link(a, b, g <= 7 ? 'free' : g <= 13 ? 'standard' : 'committed', note ? { note } : undefined)
  }

  const connect = (a, b, note) => {
    const p = nodes.get(a), q = nodes.get(b)
    const g = dist(p, q)
    const dy = q.y - p.y
    if (dy > 2.2 || g > REACH_COMMITTED) return fly(a, b, note)
    return hop(a, b, note)
  }


  // ======================================================== the ground floor
  //
  // A wide shattered plaza. It is big on purpose: it is the establishing shot
  // (VOID_SHOTS.ascent looks straight up from here) and the player needs room
  // to build speed before the first committed jump.
  pad('plaza', 0, 0, 0, 26, 26)
  L.checkpoint(0, 1.0, 0, 'the floor')

  // ============================================================ THE FLIGHT
  //
  // Twelve hero islands on a widening, rising spiral, spaced across the WHOLE
  // band table — free hops next to 30 m grapple crossings — because a course
  // with one characteristic distance has one characteristic feeling. The
  // radius grows as it climbs so the space opens OUT: the reference image is
  // vast, and a shaft of constant width reads as a corridor however tall.
  const HEROES = 22
  const heroIds = []
  let prev = 'plaza'
  let ang = 0.7
  for (let i = 0; i < HEROES; i++) {
    const t = i / (HEROES - 1)
    // The radius JITTER has to be counted against the crossing budget too: the
    // angular cap bounds the arc, but a swing of +/-12 m in radius on top of it
    // is another 24 m of chord the cap never saw. Kept modest for that reason —
    // the course gets its size from the growing radius and the count, not from
    // the wobble.
    const r = 30 + t * 62 + 5 * Math.sin(i * 1.7)
    // THE ANGULAR STEP IS CAPPED BY GRAPPLE RANGE, not chosen for looks. A
    // fixed step that reads well at r=18 throws the next island 43 m away at
    // r=56, which is past the cuff and therefore unbuildable. Chord = 2r
    // sin(step/2), so this is the largest step that keeps the next island
    // inside a 29 m reach with slack under the 34 m limit.
    if (i > 0) {
      // 32 m of crossing: the midpoint anchor puts each leg at ~16 m, inside
      // both the 31.9 m shot limit and the 19 m committed arrival. Chord =
      // 2r sin(step/2). This is more than half again the old cap and it is the
      // single number that decides how big the course feels.
      const maxStep = 2 * Math.asin(Math.min(0.999, 30 / (2 * r)))
      // Alternate the direction of travel around the shaft every few islands,
      // so the route doubles back over itself and the player keeps seeing the
      // space they just crossed from a new side.
      ang += Math.min(2.1, maxStep) * (i % 5 === 0 ? -1 : 1)
    }
    const y = 5 + i * 10.5 + 6 * Math.sin(i * 2.3)
    const id = `hero-${i}`
    // Landing size falls as the course goes on: the difficulty curve lives in
    // the TARGET, not in the distance, so late jumps ask for precision while
    // still feeling like flight.
    pad(id, Math.cos(ang) * r, y, Math.sin(ang) * r, 14 - t * 6)
    heroIds.push(id)

    const g = dist(nodes.get(prev), nodes.get(id))
    if (g > REACH_GRAPPLE) {
      // Refuse to author the impossible. Ethan relaxed the TASTE constraint,
      // not the engine: past 34 m with no anchor there is no input that closes
      // the gap, and shipping one would be a bug rather than a challenge.
      throw new Error(`void: hero-${i} is ${g.toFixed(1)} m from ${prev}, past grapple range`)
    }
    connect(prev, id, 'the flight — long crossing, swing up into the landing')
    prev = id

    // PREFAB HOOK: a great wall stands beyond every other hero island, giving
    // the flight a wall-run face and the frame a vertical (§5). Placeholder
    // slab until src/voidkit.js lands.
    if (i % 2 === 0) {
      L.solid(Math.cos(ang) * (r + 15), y + 10, Math.sin(ang) * (r + 15), 3.5, 42, 26, 'stone')
    }
  }

  // ============================================================ SIDE PATHS
  //
  // Optional, not recovery. Each branches off a hero island, sits somewhere
  // the main line does not go, and links BACK on — an island with no route on
  // is a trap and `verify()` says so. These are where a player who is good
  // with the cuff gets rewarded for looking around, which is the whole point
  // of giving them 34 m of grapple.
  const BRANCH_AT = [2, 6, 10, 14, 18]
  BRANCH_AT.forEach((h, k) => {
    const base = nodes.get(heroIds[h])
    const nxt = nodes.get(heroIds[Math.min(h + 1, HEROES - 1)])
    // Placed relative to BOTH ends it must reach, not just its parent. A spur
    // hung off the parent alone kept landing outside grapple range of the
    // island it has to rejoin, which is the same physical limit as above and
    // is worth solving by construction rather than by nudging constants.
    const mx = (base.x + nxt.x) / 2, mz = (base.z + nxt.z) / 2
    const ang = Math.atan2(mz, mx) + 0.22
    // Bounded by the crossing budget, not by a fixed cap: the spur has to be
    // rejoinable from where it sits, and out at r=90 a flat +5 m offset is a
    // very different fraction of the arc than it is at r=30.
    const rr = Math.hypot(mx, mz) + 5
    const id = `spur-${k}`
    // Hung BELOW its parent: a dive off the main line, then a climb back. The
    // void reads as bottomless, so dropping deliberately is the boldest thing
    // the course can ask for and the most fun to recover from.
    // Hung only ~7 m below. A deeper dive reads better but the climb back out
    // is a grapple shot measured from the spur's rim to an anchor above the
    // island it rejoins, and depth is on the long side of that hypotenuse —
    // past about 8 m there is no anchor position that satisfies both legs.
    pad(id, Math.cos(ang) * rr, Math.min(base.y, nxt.y) - 7, Math.sin(ang) * rr, 8)
    drop(heroIds[h], id, 'the dive — a one-way commitment off the main line')
    const dOut = dist(nodes.get(id), nxt)
    if (dOut > REACH_GRAPPLE) throw new Error(`void: spur-${k} cannot rejoin the route`)
    connect(id, nxt.id, 'the climb back out of the spur')
  })

  // Checkpoints along the flight. Sparse on purpose: a checkpoint every third
  // island keeps the stakes real without making a missed flight expensive.
  for (let i = 3; i < HEROES; i += 4) {
    const n = nodes.get(heroIds[i])
    L.checkpoint(n.x, n.y + 1.0, n.z, `ascent ${((i - 3) / 4 | 0) + 1}`)
  }

  // ============================================================== the spire
  //
  // The payoff: set back over the middle of the shaft, reached by the longest
  // crossing on the course.
  const last = nodes.get(heroIds[HEROES - 1])
  // Pulled in toward the axis, but only as far as the cuff can actually reach.
  // The first version sat at 0.2 of the last island's radius and 18 m above it,
  // which is a 49 m shot — a finish nobody can get to is not a finish.
  const spire = pad('spire', last.x * 0.62, last.y + 11, last.z * 0.62, 14)
  connect(heroIds[HEROES - 1], 'spire', 'the last crossing, out over the whole shaft')
  L.checkpoint(spire.x, spire.y + 1.0, spire.z, 'the spire')

  L.finish = new THREE.Vector3(spire.x, spire.y + 1.0, spire.z)
  // Tall and narrow: the one thing visible from the floor of the shaft.
  L.beaconAt = { x: spire.x, y: spire.y + 8, z: spire.z, height: 210, radius: 4.0 }

  const spineIds = ['plaza']
  for (let i = 3; i < HEROES; i += 4) spineIds.push(heroIds[i])
  spineIds.push('spire')

  // requireSafeLine: false — Ethan, 2026-07-25: "the rule should just be it's
  // doable in NORMAL, and I'm the one who can determine that." See level.js.
  // Every other gate still runs, including the 34 m physical limit above.
  L.report = A.verify('plaza', 'spire', spineIds, { requireSafeLine: false })
  Archipelago.assertTriggersClear(collision, [
    ...L.checkpoints.map((c) => [c.label, c.position.x, c.position.z, c.position.y]),
    ['finish', L.finish.x, L.finish.z, L.finish.y],
    ['spawn', L.spawn.x, L.spawn.z, L.spawn.y],
  ])
  L.graph = A
  // The void places none of the sunset kit — no waterfall, cypress or vine
  // curtain. It declares an empty manifest; see trackedKit().assertAllPlaced.
  K.assertAllPlaced([])
  return L
}
