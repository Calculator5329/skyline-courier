import * as THREE from 'three'
import { Level, Archipelago } from '../level.js'
import { trackedKit } from '../kit.js'
import {
  greatWall, runeSlab, sigilRing, monolith, finishVoidKit, voidColors, makeRand,
  debrisCloud, brokenArch, ruinSpire, ziggurat, hangingChain, causeway, statue,
  banner, voidOrb,
} from '../voidkit.js'
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
  const theme = (() => { try { return getTheme() } catch { return null } })()
  const colors = voidColors({}, theme)
  const accents = (theme && theme.accents) || {}
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
      // QUIET. At 2.3 the inlay clipped to white and stopped being violet at
      // all — it read as a strip light set into the floor rather than as a
      // glyph carved in glowing stone, and it was the brightest thing in every
      // frame. §6 wants the rune to SAY "you may stand here", which needs it
      // legible, not incandescent. Bigger landings get a proportionally
      // quieter one so the hero islands do not become light sources.
      runeIntensity: 0.85 * Math.min(1, 7 / Math.max(4, w)) + 0.55,
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
    const p = nodes.get(a), q = nodes.get(b)
    const g = dist(p, q)
    // THE BAND IS NOT A HORIZONTAL DISTANCE. This picked from `g` alone and
    // shipped a course that failed its own validator in production — a 1.1 m
    // step at dy 2.0 was declared `free`, and a free hop is a single jump,
    // which buys 1.42 m of height. `connect()` was made dy-aware when this bit
    // once before; `hop` was not, so the next author to call it directly walked
    // into the same hole. Fixed at the source this time.
    const dy = q.y - p.y
    const mode = (g <= 7 && dy <= 1.4) ? 'free'
      : (g <= 13 && dy <= 2.5) ? 'standard'
        : 'committed'
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
  // The course used to be ONE widening spiral of forty near-identical hops.
  // Ethan wants it "vast and expanding" and said twice it must be bigger — and
  // a spiral of forty similar crossings at ninety similar distances is not
  // vast, it is repetitive. So the flight is now built in SECTIONS with
  // distinct character (docs/course-design.md: "teach, then combine, then
  // test"), climbing higher, reaching further OUT, and — once — diving BELOW
  // itself, the one axis the old course never used:
  //
  //   the ledges    a low rhythm of plain jumps, before any anchor exists
  //   the climb     the spiral proper: grapple crossings, walls, cathedrals
  //   the wide      the radius throws OUT to ~180 m and the walls thin to sky
  //   the plunge    a dive off the wide arc, down into the deep and back up
  //   the weave     the radius pulls IN and the route zig-zags, tight and fast
  //   the approach  the final ascent, pulling toward the axis and the spire
  //
  // Every distance is still the band table's, and every crossing over 2.2 m of
  // climb is a grapple whose two legs `Archipelago.link` re-proves — nothing
  // below is placed by eye.
  const HEROES = 44
  const heroIds = []
  const walls = []
  const lerp = (a, b, u) => a + (b - a) * u
  // The radius PROFILE, as keyframes in t. Out to a vast 178 m at the middle
  // of the climb, then pulled back toward the axis for the weave and the
  // spire. Piecewise-linear so the per-step change stays bounded well under
  // the crossing budget: the steepest segment is ~7 m of radius per island,
  // and the ±6 m jitter on top of it never brings a step near the 31 m cap the
  // law-of-cosines guard enforces below.
  const R_KEYS = [[0, 36], [0.28, 100], [0.5, 178], [0.72, 96], [1, 50]]
  const rProfile = (u) => {
    for (let k = 1; k < R_KEYS.length; k++) {
      if (u <= R_KEYS[k][0]) {
        return lerp(R_KEYS[k - 1][1], R_KEYS[k][1],
          (u - R_KEYS[k - 1][0]) / (R_KEYS[k][0] - R_KEYS[k - 1][0]))
      }
    }
    return R_KEYS[R_KEYS.length - 1][1]
  }

  // ---------------------------------------------------------- COLOSSAL SCALE
  //
  // Ethan's standing critique of the void frames is that NOTHING IN THEM IS
  // ENORMOUS — everything sits within ~3x of everything else, so the eye has no
  // yardstick and the 508 m shaft reads as merely tall rather than vast. The
  // reference (docs/reference/theme2-void.png) is built on the opposite: a
  // COLOSSAL violet shard filling the whole left edge and a CATHEDRAL-scale
  // wall on the right carrying a rune circle several storeys across, sitting
  // beside 2 m fragments. Range is the whole trick, and KEEPING THE SMALL END
  // is half of it — everything below is additive, so the ordinary 46 m walls
  // and the per-island shards it sits next to are untouched.
  //
  // A handful of islands — chosen to fall under the acceptance cameras
  // (tools/shots.mjs VOID_SHOTS) rather than at random, so a colossus the route
  // never passes is not built — get a SECOND, far bigger structure beside the
  // ordinary wall: a ~140 m cathedral set back past the wall-run wall, and a
  // tens-of-metres crystal erupting at its foot. Both are cheap by construction
  // (a big object is not a detailed one):
  //   - the cathedral uses coarse, monumental masonry courses, so a wall three
  //     times taller carries about an ordinary wall's box count, and every box
  //     merges into the one 'stone' batch — zero extra draw calls; and
  //   - the crystal reuses the instanced hero buckets the per-island clusters
  //     already built (crystals.js keys buckets on family/detail/variant, not
  //     size), so it costs instances, never a draw call.
  //
  // SAFETY (CLAUDE.md rule 2, Archipelago.verify(), reachability.mjs): neither
  // carries a route and neither can be landed on.
  //   - The cathedral is SET BACK to r+26 — ten metres OUTSIDE the r+16
  //     wall-run wall and well beyond every grapple arc on the spiral — and it
  //     grows only UPWARD from the ordinary wall's base, so it adds mass in an
  //     empty vertical column, never across a crossing. Its cornice sits ~120 m
  //     over the nearest island, far from any graph landing, so it is no more
  //     an accidental landing than the ordinary wall's cornice already was.
  //   - The crystal has NO collider (crystals.js owns none), so it can neither
  //     block a jump nor be stood on. Its base sits 14 m BELOW the island and
  //     it erupts UP, so at the island's own height the shards are still at
  //     their narrow root; the wide spray happens tens of metres overhead,
  //     offset outward, framing the vantage without ever crossing the rune the
  //     player has to read (§6).
  const COLOSSAL_WALLS = new Set([0, 12, 24, 34, 42])
  const placeColossus = (i, r, ang, yTop, axis) => {
    const alongX = axis === 'x'
    const cwx = Math.cos(ang) * (r + 26), cwz = Math.sin(ang) * (r + 26)
    const height = 132 + (i % 3) * 14           // 132–160 m: ~3–3.5x an ordinary wall
    const length = 54
    // COARSE MASONRY so triple the height is not triple the boxes: bigger
    // stones on a bigger wall is what real cathedral masonry does. runBand 0
    // because nobody wall-runs a set-back landmark, which frees every course to
    // carry pier/recess relief instead of a flat run plane.
    const w = greatWall(L, cwx, yTop - 14, cwz, {
      height, length, thickness: 5, axis, detail: 2,
      panelWidth: 7.0, panelHeight: 7.0, runBand: 0,
      seed: hash(`colossus-${i}`),
    })
    // Registered for the dressing pass exactly like an ordinary wall, so the
    // arcades/spires/banners crown the cathedral head too.
    walls.push({ x: cwx, y: yTop - 14, z: cwz, axis, height, length, i, ang })

    // THE RUNE CIRCLE, several storeys across, on the face that looks back at
    // the shaft. RED — the reference's cathedral circle is red, and §6 reserves
    // the rune's VIOLET for "you may stand here", so a wall glyph must not share
    // it. Placed 0.45 m PROUD of the nominal face: a pier panel can stand
    // ~0.27 m past it, and a sigil on the core plane would be swallowed by the
    // relief (which is the bug the ordinary-wall sigils quietly have).
    const inward = alongX ? -Math.sign(cwz || 1) : -Math.sign(cwx || 1)
    const ySig = yTop - 14 + height * 0.42
    const proud = w.face + 0.45
    if (alongX) {
      sigilRing(L, cwx, ySig, cwz + inward * proud, {
        radius: 22, plane: 'xy', side: inward, rings: 4, ticks: 36,
        sigilColor: colors.sigil, detail: 2,
      })
    } else {
      sigilRing(L, cwx + inward * proud, ySig, cwz, {
        radius: 22, plane: 'zy', side: inward, rings: 4, ticks: 36,
        sigilColor: colors.sigil, detail: 2,
      })
    }

    // THE COLOSSAL SHARD at the cathedral foot, erupting up the inward face
    // toward the route: tens of metres of violet, the reference's left-edge
    // element. Straight up (tilt 0) — the cluster's own shard tilts give the
    // spray, and a symmetric root centred on the wall foot keeps the wide part
    // clear of the island rim it stands 26 m outside of.
    crystals.add('hero',
      alongX ? cwx : cwx + inward * (w.face + 1.5),
      yTop - 14,
      alongX ? cwz + inward * (w.face + 1.5) : cwz, {
        color: colors.rune, detail: 2, size: 3.6 + (i % 3) * 0.5,
      })
  }

  // ------------------------------------------------------------- the ledges
  //
  // A low rhythm of plain jumps leaving the plaza, before the flight and before
  // any anchor exists. The old course put a grapple crossing as the player's
  // very first move; this teaches the jump first (docs/course-design.md:
  // "teach, then combine"). Small pads, a gentle 2 m/step rise so `connect`
  // keeps them as hops rather than grapples, and it hands off to the spiral at
  // the height and bearing the first hero wants.
  let prev = 'plaza'
  const LEDGES = 6
  for (let i = 0; i < LEDGES; i++) {
    const u = i / (LEDGES - 1)
    const la = 0.7 + (u - 0.5) * 0.4
    const lr = 10 + u * 30
    const ly = 2 + u * 10
    const id = `ledge-${i}`
    pad(id, Math.cos(la) * lr, ly, Math.sin(la) * lr, 5)
    connect(prev, id, 'the ledges — a plain jump, no anchor needed')
    prev = id
  }

  // ------------------------------------------------------------- the spiral
  let ang = 0.7
  let lastR = 0
  let dir = 1
  for (let i = 0; i < HEROES; i++) {
    const t = i / (HEROES - 1)
    // Radius from the phase PROFILE plus a modest jitter. The profile carries
    // the size (out to ~184 m, back to ~50 m); the jitter only textures it.
    const r = rProfile(t) + 6 * Math.sin(i * 1.7)
    if (i > 0) {
      // THE LAW OF COSINES, not the chord formula — consecutive islands do not
      // share a radius. Solve d^2 = r1^2 + r^2 - 2 r1 r cos(dtheta) for the
      // dtheta that lands the crossing on CROSSING (31, a metre under the 34 m
      // cuff), and clamp when even dtheta = 0 is too far (the radial step alone
      // exceeds the cap). The guard measures centres, the graph measures rims,
      // so the guard is the stricter of the two and this is what keeps every
      // crossing physically buildable however the profile opens out.
      const r1 = lastR || r
      const cosStep = (r1 * r1 + r * r - CROSSING * CROSSING) / (2 * r1 * r)
      const maxStep = cosStep >= 1 ? 0 : cosStep <= -1 ? Math.PI : Math.acos(cosStep)
      // The route DOUBLES BACK at a phase-dependent cadence — a long smooth
      // sweep out through the wide band, a tight zig-zag through the weave — so
      // the player keeps seeing the space they crossed from a new side, and so
      // each section reads differently even though the crossing budget is one.
      const cadence = t < 0.28 ? 5 : t < 0.5 ? 999 : t < 0.72 ? 3 : 2
      if (i % cadence === 0) dir = -dir
      ang += Math.min(2.1, maxStep) * dir
    }
    // Steady climb to a finish ~80 m higher than the old spire. The ±2 m jitter
    // is charged against the grapple shot like everything else: a step never
    // climbs more than ~17 m, which keeps the shot inside 31.9 m even on the
    // tightest crossing and leaves the dive-spurs their own margin below.
    const y = 18 + i * 13 + 2 * Math.sin(i * 2.3)
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

    // A great wall stands beyond the island — a wall-run face and a vertical
    // for the frame (§5). DENSE where the architecture teaches (the climb) and
    // crowns the finish (the approach); THIN through the wide band, where the
    // point is open sky. Both densities are variety.
    const wallHere = (t < 0.28 || t > 0.72) ? (i % 2 === 0) : (i % 4 === 0)
    if (wallHere) {
      const wx = Math.cos(ang) * (r + 16), wz = Math.sin(ang) * (r + 16)
      // `greatWall` only runs along X or Z, so pick whichever is more nearly
      // tangential to the spiral here — the face the player travels alongside.
      const axis = Math.abs(Math.cos(ang)) > Math.abs(Math.sin(ang)) ? 'z' : 'x'
      greatWall(L, wx, y - 14, wz, {
        height: 46, length: 40, thickness: 4, axis, detail: 2, seed: hash(`wall-${i}`),
      })
      walls.push({ x: wx, y: y - 14, z: wz, axis, height: 46, length: 40, i, ang })
      // A big sigil low on the face where the player passes it, and on every
      // third wall a second, smaller one high up, so the wall has a hierarchy
      // rather than one centred badge. §4.1 calls it the most memorable element
      // after the crystals.
      sigilRing(L, wx, y + 9, wz, {
        radius: 13 + (i % 3) * 2.5, axis, color: colors.sigil, detail: 2,
      })
      if (i % 3 === 1) {
        sigilRing(L, wx, y + 27, wz, {
          radius: 6.5, axis, color: colors.rune, detail: 1,
        })
      }
      // A cathedral behind the ordinary wall on the chosen islands, giving the
      // frame a mass many times the size of anything beside it. See COLOSSAL
      // SCALE above for why it is safe and cheap.
      if (COLOSSAL_WALLS.has(i)) placeColossus(i, r, ang, y, axis)
    }
  }

  // ------------------------------------------------------------- the plunge
  //
  // The one thing the old course never did: go DOWN. A dive off the wide arc
  // into the deep, then a near-vertical climb back to the line it left. Falling
  // is cheap — you just fall — so the dive is a chain of one-way drops; the
  // climb out is the expensive axis, so it is a stack of near-vertical grapples
  // — small horizontal, ~20 m of lift each, which is exactly what one anchor
  // over a shaft buys. It loops back onto hero-22, so it can never be a trap:
  // you arrive by dropping in and you leave by the way you climbed. Every leg
  // was solved against the grapple maths by hand — the horizontal offsets are
  // kept > 2·rim so the reverse shot off the higher island clears the 5 m
  // minimum, and the climbs stay under ~24 m so the shot clears the 31.9 m max.
  {
    const e = nodes.get('hero-22')
    const inv = 1 / (Math.hypot(e.x, e.z) || 1)
    const ix = -e.x * inv, iz = -e.z * inv          // unit vector toward the axis
    const P = (id, along, dy, w) =>
      pad(id, e.x + ix * along, e.y + dy, e.z + iz * along, w)
    P('plunge-0', 16, -24, 8)
    P('plunge-1', 30, -46, 9)     // the basin — the deepest point on the course
    P('plunge-2', 42, -24, 8)
    P('plunge-3', 28, -4, 8)
    drop('hero-22', 'plunge-0', 'the dive — off the wide arc, into the deep')
    drop('plunge-0', 'plunge-1', 'deeper — the basin, 46 m below the line')
    const b = nodes.get('plunge-1')
    L.checkpoint(b.x, b.y + 1.0, b.z, 'the basin')
    connect('plunge-1', 'plunge-2', 'climbing the shaft — a near-vertical hook')
    connect('plunge-2', 'plunge-3', 'climbing the shaft')
    connect('plunge-3', 'hero-22', 'back onto the line')
  }

  // ============================================================ SIDE PATHS
  //
  // Optional, not recovery. Each branches off a hero island, sits somewhere
  // the main line does not go, and links BACK on — an island with no route on
  // is a trap and `verify()` says so. These are where a player who is good
  // with the cuff gets rewarded for looking around, which is the whole point
  // of giving them 34 m of grapple.
  const BRANCH_AT = [3, 8, 13, 19, 25, 30, 36, 41]
  BRANCH_AT.forEach((h, k) => {
    const base = nodes.get(heroIds[h])
    const nxt = nodes.get(heroIds[Math.min(h + 1, HEROES - 1)])
    // Placed relative to BOTH ends it must reach, not just its parent. A spur
    // hung off the parent alone kept landing outside grapple range of the
    // island it has to rejoin, which is the same physical limit as above and
    // is worth solving by construction rather than by nudging constants.
    // Placed OUTWARD from the midpoint of the crossing, straight along its
    // radius — no angular rotation. An earlier version rotated the spur a fixed
    // 0.22 rad around the shaft, which was fine while the route only ever wound
    // one way but throws the spur >34 m from its rejoin island the moment the
    // route DOUBLES BACK (the weave does this repeatedly): the rotation then
    // fights the step instead of following it. A pure radial offset is
    // direction-agnostic, so `dOut` stays ~17 m however the arc is turning.
    const mx = (base.x + nxt.x) / 2, mz = (base.z + nxt.z) / 2
    const md = Math.hypot(mx, mz) || 1
    const rr = md + 8
    const ang = Math.atan2(mz, mx)
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
  // RED IS PUNCTUATION. art-direction-void.md §3: red "is the rarest and most
  // intense colour and it must stay rare. If red is everywhere, the image
  // loses its focal points."
  //
  // This was `[rune, sigil, cool]` cycled per island, which made a THIRD of
  // every hero cluster sigil-red — including the biggest crystal on the
  // course, at the spawn vantage. The crystal lane flagged it while fixing
  // their saturation. Violet is the body colour of this world, blue is the
  // depth cue, and red appears about one island in nine.
  const CRYSTAL = [
    colors.rune, colors.rune, colors.cool,
    colors.rune, colors.cool, colors.rune,
    colors.cool, colors.rune, colors.sigil,
  ]
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

  // THE FLOOR COLOSSUS — the single most dominant shard on the course, and the
  // one the establishing `ascent` camera (tools/shots.mjs: floor of the shaft,
  // looking up) is built to catch. It stands to the -X/+Z side the camera faces
  // so it fills the left edge exactly as the reference's colossal shard does,
  // erupting from below the floor to tens of metres up. Off the spawn plaza and
  // the teaching-wall line (both around the origin at z≈0), 20 m away in Z, and
  // colliderless like every crystal — it cannot touch the route.
  crystals.add('hero', -18, -10, 20, {
    color: colors.rune, detail: 2, size: 5.0,
  })

  // Broken obelisks for mid-ground silhouette. Decor by placement — they stand
  // off the route, so they read as ruin rather than as something to land on.
  //
  // KEPT CLEAR of every landing and its checkpoint. These are solid (a monolith
  // owns a collider) and the reshaped route reaches these radii at these
  // heights, so an obelisk that clipped a rune slab would bury a trigger
  // (assertTriggersClear catches it) or put a wall across a run. Checked, not
  // assumed — a few skipped silhouettes cost nothing.
  for (let i = 0; i < 9; i++) {
    const a2 = i * 2.1
    const rr = 34 + (i % 4) * 16
    const mxo = Math.cos(a2) * rr, myo = 6 + i * 22, mzo = Math.sin(a2) * rr
    let clear = true
    for (const n of nodes.values()) {
      if (Math.abs(n.y - myo) > 16) continue
      if (Math.hypot(n.x - mxo, n.z - mzo) < Math.max(n.w, n.d) / 2 + 6) { clear = false; break }
    }
    if (!clear) continue
    monolith(L, mxo, myo, mzo, {
      height: 11 + (i % 3) * 4, detail: 1, seed: hash(`mono-${i}`),
    })
  }

  // ============================================================ THE DRESSING
  //
  // Ethan, 2026-07-25, holding the build up against his reference image:
  //
  //   "we are significantly less detailed and have less cool unique additions
  //   compared to the reference image and we have less depth and detail in the
  //   backdrop as well and less overall objects we have."
  //
  // Correct, and the `plunge` capture is the proof: a 508 m shaft with four
  // dark squares in it and violet fog everywhere else. The reference frame is
  // DENSE — broken arcades, hanging chains, spires, statuary, ziggurat masses,
  // debris at every depth, orbs receding into the haze, banners, cracked
  // causeways, and ruin districts stacked layer on layer.
  //
  // Everything below places that, in the four bands §5 asks for. It runs AFTER
  // every island exists, because where a thing is allowed to go is decided by
  // measuring its distance to the route rather than by eye.
  const dr = makeRand(0xD8E551)
  const nodeList = [...nodes.values()]

  /**
   * Distance from a sphere of radius `r` at (x, y, z) to the nearest island.
   *
   * EXACTLY the expression `Archipelago.verify()` uses for decor clearance, so
   * a placement that passes here passes there. That is the point: the ghost
   * decision below is not a judgement, it is the same arithmetic the validator
   * will re-run, and anything that gets it wrong takes the build down.
   */
  const clearance = (x, y, z, r = 0) => {
    let best = Infinity
    for (const n of nodeList) {
      const d = Math.hypot(x - n.x, y - n.y, z - n.z) - r - Math.max(n.w, n.d) / 2
      if (d < best) best = d
    }
    return best
  }

  // 70 m is `verify()`'s bar (the grapple sphere plus a dash off its far side
  // plus slack). 78 is that with a margin, because the extents passed below are
  // nominal and a ruin is allowed to be a little bigger than its footprint.
  const GHOST_MIN = 78

  /**
   * THE KEEP-OUT VOLUME around a landing, and why it is a volume rather than
   * a radius.
   *
   * The first cut gated solid dressing on one scalar — 3D distance to the
   * nearest island — and it shipped a checkpoint INSIDE A RUIN:
   *
   *   archipelago: 1 trigger point(s) a player cannot stand on:
   *     ascent 2: buried in stone (top 128.53, deck 120.86)
   *
   * A scalar cannot express what is actually wanted. A statue hung 14 m BELOW
   * an island is fine at 18 m away; an arcade 18 m away at the island's own
   * height is a wall across the landing. The two are the same distance, and
   * only one of them is a bug.
   *
   * So: a cylinder round every island, 5.5 m proud of its rim, running from
   * 4 m under the deck (the underside dressing lives below that) to 9 m over
   * it (head-room, plus the arc of a landing). Nothing solid may touch it. The
   * caller passes the prefab's real horizontal radius and its real vertical
   * span, which is why every call site below states both.
   */
  const HEAD_ROOM = 9
  const UNDER_ROOM = 4
  const RIM_ROOM = 5.5
  const blocksRoute = (x, z, rx, yLo, yHi, except = null) => {
    for (const n of nodeList) {
      if (n.id === except) continue
      if (yHi < n.y - UNDER_ROOM || yLo > n.y + HEAD_ROOM) continue
      const rr = Math.max(n.w, n.d) / 2 + RIM_ROOM
      if (Math.hypot(x - n.x, z - n.z) <= rx + rr) return true
    }
    return false
  }

  let ghosted = 0, solidified = 0, skipped = 0

  /**
   * Place a dressing prefab at the honest collision level for where it lands.
   *
   *   far from the route  → `ghost` (drawn, no collider), registered as scenery
   *                         so `verify()` PROVES nobody can reach it
   *   clear of the route  → solid, with a real collider for every surface
   *   in the keep-out     → not placed at all
   *
   * There is no fourth case, and in particular there is no "it is only decor,
   * it is probably fine". Every hollow-collider bug this project has shipped
   * came from that sentence.
   *
   * `lo` and `hi` are the prefab's vertical span RELATIVE TO `y`. They default
   * to a mass standing on its anchor; anything that hangs (chains, banners) or
   * is centred on it (debris clouds) must say so.
   */
  const dress = (fn, x, y, z, extent, opts = {}) => {
    const lo = y + (opts.lo ?? 0)
    const hi = y + (opts.hi ?? 12)
    if (clearance(x, y, z, extent) >= GHOST_MIN) {
      A.sceneryAt(x, y, z, extent * 2, extent * 2)
      ghosted++
      return fn(L, x, y, z, { ...opts, ghost: true })
    }
    if (!blocksRoute(x, z, extent, lo, hi)) {
      solidified++
      return fn(L, x, y, z, { ...opts, ghost: false })
    }
    skipped++
    return null
  }

  /** Ghost-only: a mass with a genuinely flat top, which a landing must not be. */
  const dressFar = (fn, x, y, z, extent, opts = {}) => {
    if (clearance(x, y, z, extent) < GHOST_MIN) { skipped++; return null }
    A.sceneryAt(x, y, z, extent * 2, extent * 2)
    ghosted++
    return fn(L, x, y, z, { ...opts, ghost: true })
  }

  /**
   * An orb, with the radius QUANTISED and the colour taken from a short list.
   *
   * Both constraints are the draw-call budget rather than taste: the glow
   * channel buckets by (shape, colour, intensity), so three radii and two
   * colours is seven instanced draws for six hundred orbs, and a continuous
   * radius would be six hundred draws. See `voidkit.voidOrb`.
   */
  // SMALL. The first pass ran 0.25/0.5/1.0 at intensity 1.5 and the metre-wide
  // ones photographed as hard white hexagons hanging in mid-air — the single
  // most obviously wrong thing in the capture. §4.5 asks for "fine dust motes
  // drifting slowly, catching light" and "glowing orbs", not for lamps: these
  // are points of light that give the fog something to recede past.
  // ONE SIGNAL, ONE MEANING — the rule the skyline already lives by, where
  // brass means "you can use this" and every lantern is a grapple anchor.
  //
  // Ethan, playing the void: "the fake lanterns (blue and purple) in the void
  // suck because they are hard to distinguish. Can we remove or allow the user
  // to use the grapple on those, or any mix of that?"
  //
  // He was right and the numbers were damning: ~600 decorative orbs in violet
  // AND blue, against 57 real anchors in violet. Aiming at a glowing point,
  // the odds were about ten to one that it was scenery. That is not a hard
  // read, it is an unfair one.
  //
  // The mix, and it is now a rule a player can learn in one crossing:
  //   BIG, BRIGHT, VIOLET-WHITE  = an anchor. Hook it.
  //   SMALL, DIM, BLUE           = distance. Scenery, and never violet.
  //
  // Ambient orbs lose the violet entirely — sharing a hue with the anchors was
  // the whole problem — and drop in size and brightness so they read as points
  // the fog recedes past (§4.5) rather than as lamps.
  const ORB_R = [0.22, 0.30]

  /**
   * IF IT GLOWS, YOU CAN HOOK IT. Every orb within reach of the route is a
   * real grapple anchor.
   *
   * Ethan asked for "remove, or allow the user to use the grapple on those, or
   * any mix". I first tried the mix — big bright violet orbs hookable, small
   * dim blue ones scenery — on the theory that one signal with one meaning is
   * the rule the skyline already lives by. Playing it, he came straight back:
   * "blue orbs still exist and don't let me grapple".
   *
   * So the mix was the wrong call. A distinction that is legible in a still
   * frame is not legible at 12 m/s while you are aiming at something, and a
   * light you cannot use is a light that lies to you. The simplest rule is the
   * one that survives motion, and it costs nothing: EVERY orb is an anchor.
   * That also matches his standing direction (docs/intent.md) that the answer
   * to ambiguity is more ability, never less.
   *
   * The reach test is why this is not simply "all 600 of them": orbs out in the
   * far ruin districts are hundreds of metres past the play volume, so an
   * anchor there would be a hook the cuff can never reach — the same lie in the
   * opposite direction. Only orbs near the route are registered.
   */
  const ORB_ANCHOR_REACH = 55
  // Thinned. Ethan: "I would say reduce overall number please... we cant have
  // decorations resembling them even if the colors differ."
  let orbSeq = 0
  const ORB_KEEP = 3        // one orb in three survives

  /**
   * AN ORB IS AN ANCHOR. There is no decorative orb any more, at any colour.
   *
   * The history is worth keeping because it took three passes to land. First
   * there were ~600 decorative orbs sharing the anchors' violet, and aiming at
   * a glowing point was a ten-to-one bet — Ethan: "the fake lanterns (blue and
   * purple) in the void suck because they are hard to distinguish". So I split
   * them by colour and size. He came back: "blue orbs still exist and don't let
   * me grapple" — a distinction legible in a still frame is not legible at
   * 12 m/s. So every orb became an anchor. He came back again, with the rule
   * that actually settles it: "we cant have decorations resembling them EVEN IF
   * THE COLORS DIFFER."
   *
   * That is the correct generalisation and it is stricter than anything I
   * proposed: the shape is the signal. A glowing sphere means "hook me", and
   * nothing else in the level may be one. Colour was never going to carry that
   * load at speed.
   *
   * So an orb out of the cuff's reach is not drawn at all, and the survivors
   * are thinned to a third — a hook every few metres is noise, and noise is
   * what made the original 600 unreadable.
   */
  const orb = (x, y, z) => {
    let near = false
    for (const n of nodes.values()) {
      if (Math.abs(n.y - y) > ORB_ANCHOR_REACH) continue
      if (Math.hypot(n.x - x, n.z - z) <= ORB_ANCHOR_REACH) { near = true; break }
    }
    if (!near) return                     // out of reach: draw nothing at all
    if (orbSeq++ % ORB_KEEP !== 0) return  // thinned
    voidOrb(L, x, y, z, { radius: 0.42, color: colors.cool, intensity: 1.25 })
    L.anchors.push(new THREE.Vector3(x, y, z))
  }

  /**
   * A HOOK — a real grapple anchor wearing the void's own light.
   *
   * `L.lantern()` would register the anchor and then draw a brass lantern with
   * it, which is the sunset level's object. This registers the anchor and lets
   * the orb be its body, so the thing you see IS the thing you can hook.
   *
   * Deliberately generous. Ethan's standing direction is that movement is
   * overpowered on purpose and that the answer to "this trivialises it" is a
   * bigger course, not a smaller ability — so where there was ambiguity, the
   * resolution is MORE places to hook, not fewer lights.
   */
  const hook = (x, y, z) => {
    voidOrb(L, x, y, z, {
      radius: 0.55,
      color: accents.lantern ?? colors.rune,
      intensity: 2.1,
    })
    L.anchors.push(new THREE.Vector3(x, y, z))
  }

  // ------------------------------------------------------- band 1: the near
  //
  // Dressing hung ON and UNDER the islands. Everything here is solid and
  // everything here is BELOW the landing plane or outside its rim — §6 keeps
  // the standing surface clean so the rune stays the only thing that says
  // "stand here", and CLAUDE.md rule 3 keeps the running line clear.
  heroIds.forEach((id, i) => {
    const n = nodes.get(id)
    const h = hash(id)
    const a0 = (h / 0xffffffff) * Math.PI * 2

    // Chains hanging off the rim into the void. The reference is full of them
    // and they do the one thing nothing else here does: they give the empty
    // space under a floating island a scale, because you can see how far the
    // chain falls before the fog takes it.
    //
    // A CHAIN IS TESTED AGAINST THE KEEP-OUT LIKE ANYTHING ELSE, excluding the
    // island it hangs from. This is not belt-and-braces: the spiral doubles
    // back over itself every five islands, so a 25 m chain dropped off one rim
    // lands squarely in the headroom of the island below it. The first cut did
    // exactly that and `Archipelago.assertTriggersClear` caught it —
    // "ascent 2: buried in stone (top 128.53, deck 120.86)" — a checkpoint the
    // player would have walked into a chain link to reach.
    for (let k = 0; k < 2; k++) {
      const a = a0 + 1.1 + k * 2.9
      const cx = n.x + Math.cos(a) * n.w * 0.44
      const cz = n.z + Math.sin(a) * n.w * 0.44
      const len = 12 + (h % 17)
      if (blocksRoute(cx, cz, 1.2, n.y - 1.1 - len, n.y - 1.1, id)) continue
      hangingChain(L, cx, n.y - 1.1, cz, {
        length: len, radius: 0.10, detail: 1, seed: h + k * 977, kind: 'stone',
      })
    }

    // A SATELLITE RUIN, hung below and to one side of every island.
    //
    // Below, deliberately. The flight arc from one island to the next rises,
    // so anything under the lower island is out of the line by construction —
    // which is what lets these be real solid mass 15 m from a landing instead
    // of scenery pushed 80 m away where it does nothing for the frame.
    const sa = a0 + 2.2
    const sr = 15 + (h % 10)
    const sx = n.x + Math.cos(sa) * sr
    const sz = n.z + Math.sin(sa) * sr
    const sy = n.y - 11 - (h % 13)
    const kind = i % 4
    if (kind === 0) {
      dress(statue, sx, sy, sz, 4, { height: 9 + (h % 7), detail: 2, seed: h, hi: 18 })
    } else if (kind === 1) {
      dress(brokenArch, sx, sy, sz, 12, {
        hi: 11,
        bays: 2, span: 7, rise: 4, depth: 2.2, crest: 2.6, detail: 2,
        axis: Math.abs(Math.cos(sa)) > Math.abs(Math.sin(sa)) ? 'z' : 'x', seed: h,
      })
    } else if (kind === 2) {
      dress(ruinSpire, sx, sy - 12, sz, 5, {
        height: 22 + (h % 15), width: 3.2, detail: 2, seed: h, hi: 22 + (h % 15),
      })
    } else {
      dress(monolith, sx, sy, sz, 4, { height: 9 + (h % 6), width: 1.7, detail: 2, seed: h, hi: 16 })
    }
    // Crystals on the satellite: §4.3's scatter family, whose job is exactly
    // this — making the world continuous rather than a set of staged objects.
    crystals.add('scatter', sx + 1.2, sy + 1.0, sz - 0.8, {
      color: i % 5 === 0 ? colors.cool : colors.rune, detail: 1, size: 0.9,
    })
    // A pair of orbs behind and below the landing. §5: "every important edge
    // needs a glow behind it — this is a composition rule, and it must be
    // designed into the level layout." A dark slab rim against violet fog has
    // no read at all; the same rim against an orb has one.
    orb(n.x - Math.cos(a0) * (n.w * 0.5 + 6), n.y - 4.5, n.z - Math.sin(a0) * (n.w * 0.5 + 6), i)

    // TWO HOOKS PER ISLAND, over the rim and out at the height a player is
    // actually flying at when they arrive. These are new anchors on top of the
    // 57 the crossings already place — the ambiguity is resolved by making the
    // bright lights genuinely hookable, not by deleting lights.
    //
    // Offset a third of a turn apart so at least one is usually on the side
    // you are approaching from, and lifted clear of the deck so hooking one
    // does not fight the landing you are about to make.
    for (let q = 0; q < 2; q++) {
      const ha = a0 + 2.1 + q * 2.4
      hook(n.x + Math.cos(ha) * (n.w * 0.5 + 5.5), n.y + 6.5 + q * 3,
        n.z + Math.sin(ha) * (n.w * 0.5 + 5.5))
    }
    orb(sx - 3, sy + 5, sz + 2.5, i + 1, i % 9 === 4)
  })

  // -------------------------------------------------- band 1b: the great walls
  //
  // The largest unused surface in the level. Each wall is 40 m long with its
  // cornice 32 m over its island, and it carried nothing but a sigil ring.
  for (const w of walls) {
    const alongX = w.axis === 'x'
    const top = w.y + w.height
    // Which side faces the shaft axis — that is the face the player sees.
    const inward = alongX
      ? -Math.sign(w.z || 1)
      : -Math.sign(w.x || 1)
    const at = (a, c) => (alongX ? [w.x + a, w.z + c] : [w.x + c, w.z + a])

    // A ruined arcade standing on the cornice. This is the single biggest
    // silhouette change in the level: a wall used to end in a flat line 32 m
    // over the route, and it now ends in arches with fog behind them.
    {
      const [ax, az] = at(0, 0)
      dress(brokenArch, ax, top, az, 22, {
        hi: 12,
        bays: 3, span: 8.5, rise: 4.6, pierWidth: 2.2, depth: 3.0, crest: 3.4,
        axis: w.axis, detail: 2, broken: 0.45, seed: hash(`arc-${w.i}`),
      })
    }
    // Spires at both ends, so the wall reads as a gatehouse rather than a slab.
    for (const end of [-1, 1]) {
      const [px, pz] = at(end * w.length * 0.44, 0)
      dress(ruinSpire, px, top, pz, 5, {
        height: 20 + (w.i % 4) * 7, width: 3.4, detail: 2, hi: 20 + (w.i % 4) * 7,
        seed: hash(`sp-${w.i}-${end}`),
      })
    }
    // Statuary along the parapet, facing the route.
    if (w.i % 4 === 0) {
      for (const s of [-1, 1]) {
        const [px, pz] = at(s * w.length * 0.20, inward * 1.4)
        dress(statue, px, top, pz, 3.5, {
          height: 8.5, detail: 2, hi: 10, seed: hash(`st-${w.i}-${s}`),
        })
      }
    }
    // Banners on the inward face, hung from under the cornice. High above the
    // 7 m wall-run band, so they cannot put a step in a run.
    for (const s of [-1, 1]) {
      const [px, pz] = at(s * w.length * 0.30, inward * (2.0 + 0.34 + 0.10))
      dress(banner, px, top - 2.5, pz, 7, {
        lo: -(18 + (w.i % 3) * 4), hi: 1,
        length: 13 + (w.i % 3) * 4, width: 2.6, axis: w.axis, detail: 2,
        seamSide: inward, seed: hash(`bn-${w.i}-${s}`),
      })
    }
    // Chains off the OUTWARD face, falling away from the route.
    for (let k = 0; k < 3; k++) {
      const [px, pz] = at((k - 1) * w.length * 0.28, -inward * 2.6)
      const len = 16 + k * 9
      if (blocksRoute(px, pz, 1.2, top - 1.0 - len, top - 1.0)) continue
      hangingChain(L, px, top - 1.0, pz, {
        length: len, radius: 0.11, detail: 1, seed: hash(`ch-${w.i}-${k}`),
      })
    }
    // Crystal clusters clinging to the wall head, and an orb behind the
    // arcade so the arches are backed by light rather than by fog.
    for (let k = 0; k < 3; k++) {
      const [px, pz] = at((k - 1) * w.length * 0.30, inward * 1.9)
      crystals.add('scatter', px, top + 0.4, pz, {
        color: k === 1 ? colors.cool : colors.rune, detail: 1, size: 0.8 + k * 0.16,
      })
    }
    const [bx, bz] = at(0, -inward * 9)
    orb(bx, top + 7, bz, w.i, w.i % 6 === 2)
  }

  // -------------------------------------------------- band 2: the mid ground
  //
  // The volume the course FLIES THROUGH and does not touch: the interior of the
  // spiral, and the shell just outside it. This was completely empty, which is
  // why `plunge` — the shot looking straight down the shaft — came back as four
  // squares on a violet field.
  //
  // Everything here hangs 22-60 m BELOW the local route height. A player who
  // falls passes it; a player on the line never meets it. It is also the depth
  // §5 wants the mid band at: close enough to hold detail, far enough that the
  // violet haze has started to take it.
  const MID = 46
  for (let i = 0; i < MID; i++) {
    const t = i / (MID - 1)
    // Follow the spiral's own opening-out, so the mid ruins sit inside the
    // course rather than in a cylinder that the course grows out of.
    const routeR = 40 + t * 130
    const a = 1.4 + i * 2.399963          // golden angle: never repeats a spoke
    const rr = routeR * (0.20 + dr() * 0.62)
    const y = 10 + t * 560 - (24 + dr() * 40)
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr
    const sh = 30 + dr() * 26
    const pick3 = i % 5
    if (pick3 === 0) {
      dress(brokenArch, x, y, z, 26, {
        hi: 13,
        bays: 2 + (i % 3), span: 9, rise: 5, depth: 2.8, crest: 3.4, detail: 1,
        axis: dr() > 0.5 ? 'x' : 'z', broken: 0.5, seed: 0xA0 + i,
      })
    } else if (pick3 === 1) {
      dress(ruinSpire, x, y - 18, z, 8, {
        height: sh, width: 4.0, detail: 1, seed: 0xB0 + i, hi: sh,
      })
    } else if (pick3 === 2) {
      dress(statue, x, y, z, 6, { height: 13 + dr() * 8, detail: 1, seed: 0xC0 + i, hi: 24 })
    } else if (pick3 === 3) {
      dress(monolith, x, y, z, 5, { height: 13 + dr() * 9, width: 2.2, detail: 1, seed: 0xD0 + i, hi: 23 })
    } else {
      dress(debrisCloud, x, y, z, 24, {
        lo: -17, hi: 17,
        count: 22, radius: 22, spreadY: 16, size: 1.1, detail: 0, seed: 0xE0 + i,
      })
    }
    // Chains and orbs go in regardless of what the mass is — they are what
    // ties the band together and what backs its silhouettes.
    dress(hangingChain, x + 6, y + 10, z - 4, 4, {
      lo: -(42), hi: 1,
      length: 18 + dr() * 22, radius: 0.13, detail: 1, seed: 0xF0 + i,
    })
    orb(x - 5, y + 8, z + 5, i, i % 11 === 3)
    orb(x + 7, y - 9, z - 6, i + 2)
  }

  // ------------------------------------------------- band 3: the far district
  //
  // §5: "far structures washed almost to the fog colour." That only works if
  // there ARE far structures — §8 names "fog thick enough to hide the fact that
  // nothing was built behind it" as a specific failure mode, and that is what
  // the build was doing.
  //
  // Four concentric rings of ruin districts, stacked over the whole ~590 m of
  // climb and well below and above it, each ring coarser than the last. The
  // inner ring sits at r >= 235, comfortably outside the widened ~184 m spiral,
  // so every one of these is over 78 m from any island — ghost decor that
  // `Archipelago.verify()` proves nobody can reach. (`dressFar` also drops any
  // single piece that lands inside 78 m, so the clearance holds by construction
  // even where a ring's jitter reaches inward.)
  const RINGS = [
    { r: 235, count: 14, detail: 1, scale: 1.0 },
    { r: 330, count: 16, detail: 1, scale: 1.5 },
    { r: 440, count: 15, detail: 0, scale: 2.1 },
    { r: 585, count: 13, detail: 0, scale: 3.0 },
  ]
  for (const ring of RINGS) {
    const prev = []
    for (let i = 0; i < ring.count; i++) {
      const a = (2 * Math.PI * i) / ring.count + ring.r * 0.017
      const rr = ring.r * (0.86 + dr() * 0.3)
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr
      // Spread over more than the course's own height so the district reads as
      // going on above and below the climb rather than as a wall around it.
      const y = -180 + dr() * 940
      const s = ring.scale
      const ext = 30 * s
      dressFar(ziggurat, x, y, z, ext, {
        width: 22 * s, height: 17 * s, detail: ring.detail, seed: 0x1000 + i * 31,
      })
      for (let k = 0; k < 2; k++) {
        const ox = x + (dr() - 0.5) * 60 * s, oz = z + (dr() - 0.5) * 60 * s
        const oy = y + (dr() - 0.5) * 70 * s
        dressFar(ruinSpire, ox, oy, oz, 14 * s, {
          height: (34 + dr() * 30) * s, width: 4.2 * s, detail: ring.detail,
          seed: 0x2000 + i * 17 + k,
        })
      }
      dressFar(brokenArch, x + 26 * s, y + 20 * s, z - 18 * s, 26 * s, {
        bays: 3, span: 9 * s, rise: 5 * s, pierWidth: 2.4 * s, depth: 3 * s,
        crest: 4 * s, detail: ring.detail, axis: dr() > 0.5 ? 'x' : 'z',
        broken: 0.5, seed: 0x3000 + i,
      })
      dressFar(debrisCloud, x, y + 24 * s, z, 46 * s, {
        count: ring.detail >= 1 ? 34 : 22, radius: 44 * s, spreadY: 34 * s,
        size: 1.5 * s, detail: 0, seed: 0x4000 + i,
      })
      dressFar(hangingChain, x + 12 * s, y - 6 * s, z + 10 * s, 6 * s, {
        length: (30 + dr() * 40) * s, radius: 0.3 * s, detail: 1, seed: 0x5000 + i,
      })
      // A cracked causeway to the previous district in the ring. This is what
      // turns a scatter of masses into a CITY: two ruins joined by a broken
      // bridge read as one place, and the gap in the bridge is the thing that
      // says the place is dead.
      if (prev.length && dr() > 0.35) {
        const p = prev[prev.length - 1]
        if (Math.hypot(p[0] - x, p[2] - z) < 260 * s) {
          dressFar(causeway, p[0], p[1] + 8 * s, p[2], 130 * s, {
            to: [x, y + 12 * s, z], width: 5 * s, thickness: 1.2 * s,
            detail: ring.detail, seed: 0x6000 + i,
          })
        }
      }
      prev.push([x, y, z])
      for (let k = 0; k < 3; k++) {
        orb(x + (dr() - 0.5) * 90 * s, y + (dr() - 0.5) * 90 * s, z + (dr() - 0.5) * 90 * s,
          i + k, (i + k) % 13 === 5)
      }
    }
  }

  // ------------------------------------------- band 2b: drift down the axis
  //
  // The one part of the shaft the spiral never occupies: its own middle, high
  // up, where the route has widened past 180 m and the centre line is 100 m
  // from anything. That is the volume `ascent` looks straight up through and
  // `plunge` looks straight down through, and it was pure fog.
  for (let i = 0; i < 38; i++) {
    const t = i / 37
    const y = -40 + t * 680
    const a = i * 2.399963
    const rr = (12 + dr() * 46) * Math.min(1, 0.25 + t)
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr
    dressFar(debrisCloud, x, y, z, 34, {
      count: 26, radius: 30, spreadY: 26, size: 1.3, detail: 0, seed: 0x7000 + i,
    })
    if (i % 3 === 0) {
      dressFar(ruinSpire, x, y, z, 12, {
        height: 30 + dr() * 30, width: 4.0, detail: 1, seed: 0x7100 + i,
      })
    }
    for (let k = 0; k < 4; k++) {
      orb(x + (dr() - 0.5) * 70, y + (dr() - 0.5) * 70, z + (dr() - 0.5) * 70, i + k,
        (i + k) % 17 === 6)
    }
  }

  L.report_dressing = { ghosted, solidified, skipped }

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
