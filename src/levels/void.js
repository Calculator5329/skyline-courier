import * as THREE from 'three'
import { Level, Archipelago } from '../level.js'
import { trackedKit } from '../kit.js'
import { greatWall, runeSlab, sigilRing, monolith, finishVoidKit, voidColors } from '../voidkit.js'
import { CrystalField } from '../crystals.js'
import { getTheme } from '../theme.js'

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
const CROSSING = 31

export function buildVoidCourse(collision) {
  const L = new Level(collision)
  const K = trackedKit()
  const A = new Archipelago()

  L.spawn.set(0, 1.4, 0)
  L.spawnYaw = 0
  // Far deeper than the skyline's -52. The void has to read as bottomless
  // (§6), which means the player must fall long enough to believe it.
  L.killY = -180

  const nodes = new Map()
  // Stable per-island seed. Placement order must not decide what an island
  // looks like, or inserting one changes every one after it.
  const hash = (str) => {
    let h = 2166136261
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
    return h >>> 0
  }
  const colors = voidColors({}, (() => { try { return getTheme() } catch { return null } })())
  // One field for the whole course: crystals are instanced per (shape, LOD),
  // so putting every cluster through one field is what keeps 300 of them at a
  // dozen draw calls instead of 300.
  //
  // INTENSITY IS RE-CALIBRATED HERE, and it had to be. `crystals.js` ships
  // 3.2, measured against a scratch scene that was mostly empty sky — so the
  // auto-exposure meter sat about a stop and a half hot and 3.2 looked right.
  // Dropped into a course full of rock the meter closes down, every shard
  // clipped to white, and the two families stopped being violet and blue at
  // all. Its author flagged exactly this. 1.35 keeps the cores bright enough
  // to clear the 0.78 bloom threshold while the BODY of the shard still
  // carries its hue, which is the whole point of having two families.
  const crystals = new CrystalField({ seed: 0x5EED, intensity: 1.35 })

  /** A landing surface: collider and graph node from ONE declaration. */
  const pad = (id, x, y, z, w, d = w) => {
    A.node(id, x, y, z, w, d)
    // A CARVED RUNE SLAB, not a box. `runeSlab` puts its walkable top at `y`,
    // which is exactly this helper's contract, and it emits its own collider
    // for every surface it draws.
    //
    // The glowing inlay is not decoration: art-direction-void.md §6 makes it
    // the readability channel — "a glowing rune means you may stand here" —
    // and it is the ONLY such channel a near-black level has. So every landing
    // in this course gets one, and nothing that is not a landing ever does.
    runeSlab(L, x, y, z, {
      sizeX: w, sizeZ: d, detail: 2, seed: hash(id),
      // Bigger landings get a proportionally quieter rune, or the hero islands
      // read as light sources rather than as floors.
      runeIntensity: 2.4 * Math.min(1, 7 / Math.max(4, w)) + 1.1,
    })
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

  // ---- THE TEACHING WALL --------------------------------------------------
  //
  // Ethan: "it's not super intuitive how you're running up the wall versus
  // jumping off of it. Like if you're supposed to hold space bar, if you're
  // supposed to tap it or whatever."
  //
  // The inputs turned out not to be the problem — the wall verbs are automatic
  // and a head-on wall simply was not jumpable, which is fixed in player.js.
  // What is left is that nothing ever TEACHES the verb. So: one wall, on the
  // spawn plaza, with a rune-lit ledge at 5.0 m.
  //
  // 5.0 m is chosen against the mechanic, not by eye. A climb now runs for
  // climbTime 0.9 s at climbSpeed 9.2 with the ramp in player.js, which
  // integrates to about 5.6 m — so this ledge is reachable by a climb with
  // margin, and NOT by a double jump (~2.5 m). There is exactly one way up,
  // it is visible from the spawn point, and the rune says you may stand on it.
  {
    const WX = -11, WZ = 0
    greatWall(L, WX, 0, WZ, {
      height: 14, length: 16, thickness: 3, axis: 'z', detail: 2, seed: 0x7EAC4,
    })
    const ledge = pad('lesson', WX + 3.6, 5.0, WZ, 5, 9)
    // Structural: the height is carried by the wall, not by an arc, so there is
    // no distance for the band table to check — which is exactly what the
    // `wallrun` mode is for, and it must say why.
    A.link('plaza', 'lesson', 'wallrun',
      { note: 'the teaching wall — a 5.0 m ledge, only reachable by running up the face' })
    A.link('lesson', 'plaza', 'free', { note: 'step back off' })
    void ledge
  }

  // ============================================================ THE FLIGHT
  //
  // Twelve hero islands on a widening, rising spiral, spaced across the WHOLE
  // band table — free hops next to 30 m grapple crossings — because a course
  // with one characteristic distance has one characteristic feeling. The
  // radius grows as it climbs so the space opens OUT: the reference image is
  // vast, and a shaft of constant width reads as a corridor however tall.
  const HEROES = 40
  const heroIds = []
  let prev = 'plaza'
  let ang = 0.7
  let lastR = 0
  for (let i = 0; i < HEROES; i++) {
    const t = i / (HEROES - 1)
    // The radius JITTER has to be counted against the crossing budget too: the
    // angular cap bounds the arc, but a swing of +/-12 m in radius on top of it
    // is another 24 m of chord the cap never saw. Kept modest for that reason —
    // the course gets its size from the growing radius and the count, not from
    // the wobble.
    const r = 32 + t * 106 + 7 * Math.sin(i * 1.7)
    // THE ANGULAR STEP IS CAPPED BY GRAPPLE RANGE, not chosen for looks. A
    // fixed step that reads well at r=18 throws the next island 43 m away at
    // r=56, which is past the cuff and therefore unbuildable. Chord = 2r
    // sin(step/2), so this is the largest step that keeps the next island
    // inside a 29 m reach with slack under the 34 m limit.
    if (i > 0) {
      // 36 m of crossing. The midpoint anchor puts each leg at ~18 m, which is
      // just inside the 19 m `committed` arrival and far inside the 31.9 m
      // shot limit — so 38 m is the hard ceiling this geometry allows and 36
      // leaves a metre of slack for the rim maths. Chord = 2r sin(step/2).
      //
      // Ethan: "we will have it be much longer, much bigger... we can cover
      // more distance, both height-wise, but also distance-wise" and "release
      // the constraints on yourself". This is the number that decides how big
      // the course feels, and it is now at the physical limit of the cuff.
      // THE LAW OF COSINES, not the chord formula. Consecutive islands do not
      // share a radius — this spiral widens by up to 17 m in a step — and
      // `2r sin(dtheta/2)` silently assumes they do. Two attempts at budgeting
      // the radial change out of the arc still overran (39.4 m, then 38.8 m,
      // against a 34 m cuff) because the error is not separable.
      //
      // CROSSING is centre-to-centre, and the 34 m cuff limit is what bounds
      // it: the graph measures rim-to-rim (so it sees less than this) but the
      // guard below measures centres (so it sees exactly this), and the guard
      // is the stricter of the two. 33 leaves a metre of slack under it.
      //
      // Exactly: d^2 = r1^2 + r2^2 - 2 r1 r2 cos(dtheta). Solve it for the
      // dtheta that lands d on the cap, and clamp when even dtheta = 0 is too
      // far — which happens when the RADIAL step alone exceeds the cap, and is
      // a real constraint on how fast the spiral may open out.
      const r1 = lastR || r
      const cosStep = (r1 * r1 + r * r - CROSSING * CROSSING) / (2 * r1 * r)
      const maxStep = cosStep >= 1 ? 0 : cosStep <= -1 ? Math.PI : Math.acos(cosStep)
      // Alternate the direction of travel around the shaft every few islands,
      // so the route doubles back over itself and the player keeps seeing the
      // space they just crossed from a new side.
      ang += Math.min(2.1, maxStep) * (i % 5 === 0 ? -1 : 1)
    }
    // The VERTICAL variance is charged against the grapple shot as well. The
    // anchor hangs `LIFT` above the higher of the two islands, so the shot is
    // hypot(crossing/2, rise + LIFT) — and a +/-7 m wobble on a 12.5 m rise
    // makes some steps a 26 m climb, which put the shot at 32.6 m against a
    // 31.9 m limit. Halved for that reason, not for looks.
    const y = 5 + i * 12.5 + 3.5 * Math.sin(i * 2.3)
    const id = `hero-${i}`
    // Landing size falls as the course goes on: the difficulty curve lives in
    // the TARGET, not in the distance, so late jumps ask for precision while
    // still feeling like flight.
    pad(id, Math.cos(ang) * r, y, Math.sin(ang) * r, 14 - t * 6)
    heroIds.push(id)
    lastR = r

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
      const wx = Math.cos(ang) * (r + 16), wz = Math.sin(ang) * (r + 16)
      // `greatWall` only runs along X or Z, so pick whichever is more nearly
      // tangential to the spiral here — that is the face the player travels
      // alongside, and therefore the one they can wall-run.
      const axis = Math.abs(Math.cos(ang)) > Math.abs(Math.sin(ang)) ? 'z' : 'x'
      greatWall(L, wx, y - 14, wz, {
        height: 46, length: 40, thickness: 4, axis, detail: 2, seed: hash(`wall-${i}`),
      })
      // The sigil ring rides the wall face. §4.1 calls it the most memorable
      // element after the crystals, and it doubles as a landmark for reading
      // which way is on.
      if (i % 4 === 0) {
        sigilRing(L, wx, y + 6, wz, { radius: 7.5, axis, color: colors.sigil, detail: 2 })
      }
    }
  }

  // ============================================================ SIDE PATHS
  //
  // Optional, not recovery. Each branches off a hero island, sits somewhere
  // the main line does not go, and links BACK on — an island with no route on
  // is a trap and `verify()` says so. These are where a player who is good
  // with the cuff gets rewarded for looking around, which is the whole point
  // of giving them 34 m of grapple.
  const BRANCH_AT = [3, 8, 13, 18, 23, 28, 33, 37]
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
  for (let i = 4; i < HEROES; i += 5) {
    const n = nodes.get(heroIds[i])
    L.checkpoint(n.x, n.y + 1.0, n.z, `ascent ${((i - 4) / 5 | 0) + 1}`)
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

  // ============================================================== CRYSTALS
  //
  // §4.3: two families. HERO shards are architecture — big enough to frame a
  // vantage — and go beside the landings and at the foot of the walls, where
  // they light the thing the player is aiming at. SCATTER shards go under the
  // slab lips and along the ruin edges, and their job is continuity: they are
  // what stops the world reading as a set of staged objects with nothing
  // between them.
  //
  // They are also the LIGHT in this theme (§1), so placement is a lighting
  // decision, not a dressing one — every landing gets one within a few metres.
  const CRYSTAL = [colors.rune, colors.sigil, colors.cool]
  let ci = 0
  for (const n of nodes.values()) {
    const a0 = hash(n.id) / 0xffffffff * Math.PI * 2
    const half = n.w / 2
    // Hero cluster just off the rim, never ON the landing: a crystal you can
    // trip over is a movement bug, and §6 keeps the standing surface clean.
    // ROOTED IN THE ROCK, not floating beside it. Ethan: "many of the red and
    // blue fern-like things you added are floating."
    //
    // That was mine, and it was an overcorrection: I had pushed them OUTSIDE
    // the rim to keep the landing surface clean, which put them in open air
    // with nothing to grow from. `runeSlab`'s underside tiers are boxes of
    // half-extent 0.45 * size — that is 0.9 * half — so anything past ~0.9
    // half-widths from the centre has no mass behind it. Everything below is
    // inside that envelope and reads as erupting from the stone.
    crystals.add('hero', n.x + Math.cos(a0) * half * 0.84, n.y - 1.15,
      n.z + Math.sin(a0) * half * 0.84, {
        color: CRYSTAL[ci % CRYSTAL.length], detail: 2, size: 0.72 + (hash(n.id) % 7) * 0.07,
      })
    // Scatter under the lip, hanging into the void the way §4.2 describes the
    // undersides.
    for (let k = 0; k < 4; k++) {
      const a1 = a0 + 1.35 + k * 1.63
      // Under the lip and inside the tier envelope. Still clear of the landing
      // surface — §6 keeps that clean so the rune stays the only thing saying
      // "stand here" — but now with rock behind it.
      // Into the FASCIA, which is a solid box (0.90 of the slab size, spanning
      // about y-0.85 to y-1.11) rather than into the tier blobs below it. The
      // tiers are lumpy and only fill part of their bounding box, so a shard
      // sized against the box still had its root in open air on the concave
      // parts — which is what was reading as floating ferns.
      crystals.add('scatter', n.x + Math.cos(a1) * half * 0.70, n.y - 1.02,
        n.z + Math.sin(a1) * half * 0.70, {
          color: CRYSTAL[(ci + k) % CRYSTAL.length], detail: k < 2 ? 2 : 1,
          size: 0.70 + k * 0.10,
        })
    }
    ci++
  }

  // Broken obelisks for mid-ground silhouette. Decor by placement — they stand
  // off the route, so they read as ruin rather than as something to land on.
  for (let i = 0; i < 9; i++) {
    const a2 = i * 2.1
    const rr = 34 + (i % 4) * 16
    monolith(L, Math.cos(a2) * rr, 6 + i * 22, Math.sin(a2) * rr, {
      height: 11 + (i % 3) * 4, detail: 1, seed: hash(`mono-${i}`),
    })
  }

  L.group.add(crystals.build())
  // Flushes the glow channel into instanced meshes, and asserts every rune it
  // drew is over something standable.
  const glow = finishVoidKit(L)
  void glow

  const spineIds = ['plaza']
  for (let i = 4; i < HEROES; i += 5) spineIds.push(heroIds[i])
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
