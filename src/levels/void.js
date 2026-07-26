import * as THREE from 'three'
import { Level, Archipelago } from '../level.js'
import { trackedKit } from '../kit.js'

/**
 * THE VOID — theme 2's course.
 *
 * A SECOND LEVEL, not the archipelago repainted. Ethan, after being shown the
 * sunset course rendered in violet: "that's not going to be the theme. The
 * theme is a totally different map with totally new sprites, totally new
 * everything to match the screen. It's like a totally different level."
 * `docs/art-direction-void.md` §0 records that as binding.
 *
 * ------------------------------------------------------------------ shape
 *
 * The sunset course runs +X along a horizontal spine from x=4 to x=222. This
 * one runs +Y. The brief asks for "the player almost flying upward", and §5 of
 * the art direction turns that into a rule — the vanishing point sits ABOVE
 * the frame, and every hero vantage is framed by a vertical.
 *
 * So the spine here is height. Sections stack up a shaft between two great
 * walls, and the player reads progress by looking up at where they are going
 * rather than out along it.
 *
 * -------------------------------------------------------- what is fixed
 *
 * The traversal envelope does NOT change with the theme. `docs/course-design.md`
 * is the contract and it is enforced by `Archipelago.verify()`:
 *
 *   free       0-7 m      single sprint jump (~7.3 m)
 *   standard   8-13 m     + double jump (~13.7 m)
 *   committed  14-19 m    + dash (~19 m)
 *   grapple    20-32 m    5-34 m to an anchor
 *   >34 m      impassable
 *
 * Vertically: 1.42 m single, ~2.5 m double, ~3.1 m of vertical wall-run on top
 * of entry height, ~2.4 m per wall-jump while walls alternate, and a free
 * mantle at or under 1.45 m. A wall shorter than 1.55 m is a vault, not a climb.
 *
 * And the rule that outranks the rest (`course-design.md`, enforced at
 * `level.js` via SAFE_MODES): **every checkpoint must be reachable from the
 * previous one with no dash and no grapple.** Verify against NORMAL; FUN is a
 * superset. A vertical course makes this easy to violate by accident, because
 * the obvious way to gain height fast is a grapple.
 *
 * ------------------------------------------------------------- STATUS
 *
 * SCAFFOLD. This is the integration spine, landed early and deliberately so
 * that the prefab work being built in parallel — `src/voidkit.js` (great walls,
 * rune slabs, sigil rings, monoliths), `src/crystals.js` (shards) and
 * `src/fx/voidfx.js` (energy beams) — has somewhere to be placed the moment it
 * exists, and so `?theme=void` boots something rather than throwing.
 *
 * It currently builds the minimum a Level must provide to be playable and
 * verifiable: a spawn, a stack of plain landing slabs inside the envelope, a
 * checkpoint chain, grapple anchors and a finish. It is intentionally ugly.
 * Replacing these slabs with real ruin geometry is the next step, and the
 * layout below is a skeleton to hang that on rather than a finished design.
 */

// The shaft. Great walls will stand at +/- WALL_X; the route zigzags between
// them so both are always available to wall-run.
const WALL_X = 13

export function buildVoidCourse(collision) {
  const L = new Level(collision)
  const K = trackedKit()
  const A = new Archipelago()

  L.spawn.set(0, 1.4, 0)
  L.spawnYaw = 0
  // Deeper than the skyline's -52: the void is meant to read as bottomless
  // (§6), so the player needs to fall long enough to believe it before the
  // respawn catches them.
  L.killY = -90

  /**
   * One landing slab, registered in the graph with the SAME extents it gets as
   * a collider — "graph first, geometry second" is a mechanism only while
   * those two numbers are the same number.
   */
  const pad = (id, x, y, z, w = 7, d = 7) => {
    A.node(id, x, y, z, w, d)
    L.solid(x, y - 0.5, z, w, 1, d, 'stone')
    return { x, y, z }
  }

  // ---- the climb ---------------------------------------------------------
  //
  // Rise per step is kept inside the no-dash-no-grapple rule: a 2.4 m lift over
  // a <=13 m gap is a double jump, which is `standard`. The zigzag in Z is what
  // keeps a wall within reach on alternating sides for the wall-run sections
  // the great walls will provide.
  let prev = pad('base', 0, 0, 0, 16, 16)
  L.checkpoint(0, 1.0, 0, 'the descent')
  const spine = ['base']

  // THE COST OF HEIGHT, learned from the validator rather than assumed. The
  // envelope de-rates horizontal reach as vertical gain grows, and steeply: at
  // dy 3.0 even a 6.9 m gap is beyond `committed`, because a double jump buys
  // only ~2.5 m of height in total. A vertical course therefore cannot be a
  // few big lifts — it has to be MANY small ones, which is also what the brief
  // asks for ("many platforms rising high into the sky").
  //
  // 1.4 m per step is inside a single jump (1.42 m) with nothing spent, so the
  // whole climb stays inside the no-dash-no-grapple rule with margin.
  const RISE = 1.4
  const STEPS = 58

  let y = 0
  for (let i = 0; i < STEPS; i++) {
    const id = `rise-${i}`
    // A slow spiral rather than a zigzag: it keeps consecutive pads close
    // (cheap hops) while walking the route right around the shaft, so both
    // great walls come into reach repeatedly and the player is always turning
    // to look at something new on the way up.
    // The angular step is set by HEADROOM, not by taste. At 1.4 m of rise per
    // step, two consecutive pads that overlap in XZ leave less than a standing
    // capsule (1.75 m) between them — `assertTriggersClear` caught exactly
    // that, and it would have meant a course with nowhere legal to stand. So
    // consecutive pads are pushed far enough apart that they cannot overlap:
    // chord = 2*r*sin(step/2) ~= 7.6 m against a 4.5 m pad.
    const a = i * 1.15
    const r = 7.0 + 1.5 * Math.sin(i * 0.31)
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    y += RISE
    const here = pad(id, x, y, z, 4.5, 4.5)
    const gap = Math.hypot(here.x - prev.x, here.z - prev.z)
    A.both(spine[spine.length - 1], id, gap <= 7 ? 'free' : 'standard')
    if (i % 5 === 0) L.lantern(here.x, here.y + 3.2, here.z)
    if (i % 12 === 11) L.checkpoint(here.x, here.y + 1.0, here.z, `ascent ${((i / 12) | 0) + 1}`)
    spine.push(id)
    prev = here
  }

  // Derived from where the climb actually ENDED, not a constant. A hardcoded
  // summit height is how you get a final hop the graph rejects as impassable
  // the first time the rise-per-step changes.
  const top = pad('summit', 0, y + 1.4, 0, 12, 12)
  A.both(spine[spine.length - 1], 'summit', 'standard')
  spine.push('summit')
  L.checkpoint(top.x, top.y + 1.0, top.z, 'the summit')
  L.finish = new THREE.Vector3(top.x, top.y + 1.0, top.z)
  // The beacon wants a SHAPE, not a point — `Level._beacon()` destructures
  // `{x, y, z, height, radius}` and a bare Vector3 throws on `height.toFixed`.
  // Tall and narrow here: it is the one thing visible from the floor of an
  // 84 m shaft, and art-direction-void.md §5 wants every hero vantage framed
  // by a vertical.
  L.beaconAt = { x: top.x, y: top.y + 6, z: top.z, height: 150, radius: 3.6 }

  L.report = A.verify('base', 'summit', spine)
  Archipelago.assertTriggersClear(collision, [
    ...L.checkpoints.map((c) => [c.label, c.position.x, c.position.z, c.position.y]),
    ['finish', L.finish.x, L.finish.z, L.finish.y],
    ['spawn', L.spawn.x, L.spawn.z, L.spawn.y],
  ])
  L.graph = A
  // The void course places none of the sunset kit — no waterfall, no cypress,
  // no vine curtain. It declares an empty manifest rather than being held to
  // the whole kit; see `trackedKit().assertAllPlaced`.
  K.assertAllPlaced([])
  return L
}
