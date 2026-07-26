/**
 * The named shot table.
 *
 * A shot is a frozen pose: feet position, look direction, and optionally a
 * velocity so the camera rig's speed-driven FOV sits where it would during
 * actual play. The harness re-applies the pose on every pumped frame, so a
 * mid-air shot stays mid-air instead of falling for a second and a half.
 *
 * Coordinates are read off `src/level.js`, not invented. The course runs along
 * +X from the terrace at x=4 to the tower at x=222. Useful facts from there:
 *   - `position` is FEET (see collision.js resolve()); the eye sits
 *     `standHeight - eyeDrop` = 1.53 m above it.
 *   - Every section's deck is declared as `solid(cx, -0.5, cz, w, 1, d)`, so
 *     the walkable top is y = 0 unless stated otherwise.
 *   - Brass means runnable, so brass is what the wall shots point at.
 * Ground shots sit 2 cm above the deck: on it, but not interpenetrating it, so
 * the first sim step resolves to a clean grounded contact rather than a push-out.
 */

const DECK = 0.02          // feet clearance above a deck top at y = 0

/**
 * Yaw that looks along the horizontal direction (dx, dz).
 *
 * Three's default forward is -Z and the rig yaws about Y, so a yaw of θ looks
 * along (-sinθ, -cosθ). Inverting that is the only bit of trigonometry in this
 * file, and getting it wrong is how you end up shooting the empty sky.
 */
export function yawTo(dx, dz) {
  return Math.atan2(-dx, -dz)
}

const EAST = yawTo(1, 0)     // down the route, +X
const NORTH = yawTo(0, -1)   // across it, -Z

export const SHOTS = {
  // Section 1. Standing on the terrace deck (top y=0, x 1..29) at the spawn,
  // looking down the route past the two vault blocks at x=20 and x=24.
  terrace: {
    pos: [4, DECK, 0],
    yaw: EAST,
    // Barely below level. Anything steeper and the deck eats two thirds of the
    // frame, which tells you about the floor tile and nothing about the route.
    pitch: -0.04,
    vel: [7, 0, 0],          // jogging: opens the FOV the way play does
    note: 'start of the route, terracotta balustrades framing the run',
  },

  // Section 2. Mid-air in the first gap: deck 1 ends at x=43, deck 2 starts at
  // x=47. Apex of a sprint jump is a little over 1.4 m, so y=1.6 is honest.
  gaps: {
    // Just off the take-off edge (deck 1 ends at x=43), not halfway across:
    // from the middle of the gap the far deck is close enough to fill the lower
    // frame and the void never appears at all. A gap shot that cannot see the
    // gap is just another platform shot.
    pos: [43.5, 1.8, 0.4],
    yaw: EAST,
    pitch: -0.30,
    vel: [12, 1.5, 0],
    note: 'airborne over the first moss gap, void and cloud below',
  },

  // Section 4. On the brass wall (face at z=-4.0, x 86..118, top y=10) at
  // wall-run height, out over the void where the approach ledge has ended.
  // Yawed 20° toward the wall so the brass fills the left of the frame.
  crossing: {
    pos: [97, 4.2, -3.5],
    // Only 10° off the run direction. Yawing hard into the wall at wall-run
    // range fills the frame with one flat brass slab and hides the drop; a
    // shallow angle shows the wall running away to the landing instead.
    yaw: EAST + 0.18,
    pitch: -0.06,
    vel: [13, 0.4, 0],
    note: 'mid wall-run along the brass crossing',
  },

  // Section 5. Approaching the underpass from the checkpoint side. The ceiling
  // slab spans x 131..149 with its underside at y=1.35 — below eye height, so
  // this must be shot from OUTSIDE that span or the camera is inside concrete.
  underpass: {
    // 7 m back from the slab. Closer and the slab's front face reads as a solid
    // wall filling the frame; from here it is a lintel with a 1.35 m slot under
    // it, which is the thing the section is actually about.
    pos: [124, DECK, -1.5],
    yaw: EAST,
    pitch: -0.05,
    vel: [11, 0, 0],
    note: 'the slide: a ceiling too low to run under, brass rails either side',
  },

  // Section 6. Between the first two wall-jump pillars (x=163 face z=-2.3,
  // x=175 face z=+2.3), at the height the chain is actually flown at.
  chain: {
    pos: [169, 5.0, 0],
    yaw: EAST,
    pitch: 0.04,
    vel: [12, 1, 1.5],
    note: 'inside the wall-jump chain, brass pillars left and right',
  },

  // Section 7. Partway up the ascent stair, looking at the finish.
  //
  // NOT from on the tower deck itself: the finish is a three-sided brass court
  // (walls at z=±6, back wall at x=228.5) and standing inside it frames a brass
  // box with the route out of shot. Read off `stair(202, 1.5, 0, 8, 0.55, 1.6)`:
  // step 5 spans x 208.4..210.0 with its top at y = 1.5 + 0.55*5 = 4.25.
  tower: {
    pos: [209.2, 4.25 + DECK, 0],
    yaw: EAST,
    pitch: 0.08,
    vel: [8, 0, 0],
    note: 'the finish — brass arch on a moss deck at the top of the ascent',
  },

  // High and off the route, looking back across the archipelago roughly into
  // the sun (world.js: sunDir = (-0.62, 0.17, 0.77)) but 20° off axis, so the
  // frame is backlit and hazy without the sun disc blowing out the middle.
  vista: {
    pos: [140, 46, -30],
    yaw: yawTo(-0.62, 0.62),
    pitch: -0.17,
    note: 'archipelago and cloud sea, backlit — the depth read',
  },

  // Material judgement. The section-4 approach ledge (porcelain/sandstone, top
  // y=0, z -4.5..-1.9) runs straight into the brass wall face at z=-4.0. That
  // junction, at 1.8 m, is where sandstone-vs-brass gets argued honestly.
  closeup: {
    pos: [93, DECK, -2.3],
    // Aimed along the junction rather than square at the wall: a 10 m brass
    // slab shot head-on from 1.8 m is a texture swatch, not a material read.
    // This puts brass in the upper left, sandstone deck in the lower right,
    // and the contact line between them across the middle.
    yaw: yawTo(0.75, -0.66),
    pitch: -0.30,
    note: 'sandstone deck meeting the brass wall, close enough to judge detail',
  },

  // ---- The invisible-surface shots. -------------------------------------
  //
  // Ethan's report, 2026-07-25: "if you go below any of the floating platforms
  // it looks like they're HOLLOW ... I can SEE UP THROUGH the platforms", and
  // "between the main path and the guardrail on the side it's completely
  // transparent". Both are acceptance shots, not beauty shots: they exist to
  // be READ, and they fail while any sky is visible where mass should be.

  // Under the terrace — `deck(14, 0, 0, 30, 10.4, BUILT, {bodyDepth: 3.2})`,
  // so the drum body runs from about y=-0.5 down to y=-3.7 with boulder tiers
  // below that. From 14 m under it, looking straight up, the whole underside
  // fills the frame: a solid island shows stone, a hollow one shows sky.
  underside: {
    // 34 m down, not 14: the terrace hangs a boulder tail roughly 13 m under
    // its deck, so the first attempt at this shot had the camera INSIDE the
    // tier stack and photographed the inside of a rock.
    pos: [14, -34, 0],
    yaw: EAST,
    pitch: 1.35,             // very nearly straight up
    note: 'ACCEPTANCE: under the terrace looking up — must show no sky',
  },

  // The deck strip. The terrace deck is 10.4 m across (z -5.2..+5.2) and the
  // balustrade sits at z=-4.7, so there is a ~0.3 m strip of deck OUTSIDE the
  // guardrail. That strip is what reads as transparent. Shot from on the deck
  // just inside the rail, looking down and out across it.
  deckstrip: {
    pos: [8, DECK, -3.6],
    yaw: yawTo(0.35, -0.94),
    pitch: -0.62,            // down at the rail's foot and the strip beyond it
    note: 'ACCEPTANCE: the deck strip outside the balustrade — must show no sky',
  },

  // The unambiguous one. Both shots above look OUT over the island's edge,
  // where sky is the correct answer and the bug is therefore not falsifiable.
  // This stands at the last centimetre of the terrace's COLLIDER (z=-5.2, so
  // feet at -5.15) and looks STRAIGHT DOWN. The player is standing here, so
  // there is floor here by definition: any sky in this frame is floor that was
  // never drawn. Nothing else in the frame to argue about.
  edgefeet: {
    // Hovering 6 m above the deck and 4 m inboard, looking down and out across
    // the rim. Straight-down does not work: the rig clamps pitch short of the
    // nadir, so a -87 degree shot comes back looking at the horizon. This
    // angle still puts the whole strip — deck, balustrade, outer edge, and the
    // void past it — in one frame, and the deck either reaches the edge or it
    // does not.
    pos: [8, 6, -1.0],
    yaw: NORTH,
    pitch: -0.95,
    note: 'ACCEPTANCE: the deck rim from above — deck must reach its own edge',
  },
}

/**
 * The VOID shot table — theme 2's course, which is a different level entirely
 * and therefore a different set of coordinates. `src/levels/void.js` is a
 * vertical spiral: a 16 m base pad at the origin, 58 pads of 4.5 m rising
 * 1.4 m each on a spiral of radius ~7-8.5, summit at y ~83.
 *
 * These are deliberately framed to test the ART DIRECTION rather than to be
 * pretty: art-direction-void.md's acceptance table (§2) is measured off them,
 * and §5 says the hero vantages must LOOK UP, because the vanishing point of
 * this level sits above the frame.
 */
export const VOID_SHOTS = {
  // Read off `src/levels/void.js` at build time, not invented. The course is a
  // widening spiral: 51 islands, 508 m of climb, 142 m of radius.
  //   plaza     0.0    0.0    0.0
  //   hero-8   30.4  103.5  -51.5
  //   hero-20  -4.2  258.2   90.0
  //   hero-39  61.7  496.0 -120.9
  //   spire    38.3  507.0  -75.0

  // The floor of the shaft, looking up the whole 508 m. The establishing shot,
  // and the one that has to sell the scale.
  ascent: {
    pos: [0, DECK, 0],
    yaw: yawTo(-1, 0.4),
    pitch: 0.62,
    note: 'VOID: from the floor of the shaft, looking up the whole climb',
  },

  // Low on the spiral, reading the next crossing. The readability test: in a
  // near-black level, can a player tell where to go next?
  midclimb: {
    pos: [30.4, 103.5 + DECK, -51.5],
    yaw: yawTo(-0.6, 0.8),
    pitch: 0.18,
    vel: [9, 0, 6],
    note: 'VOID: on hero-8, reading the next crossing',
  },

  // Airborne high up with the whole shaft below. The depth read, and the frame
  // where a bottomless drop either works or does not.
  plunge: {
    pos: [-4.2, 262, 86],
    yaw: yawTo(0.3, -1),
    pitch: -0.72,
    vel: [8, -5, -12],
    note: 'VOID: airborne at mid-height, looking back down the shaft',
  },

  // From the spire, back down over everything. The payoff.
  summit: {
    pos: [38.3, 507.0 + DECK, -75.0],
    yaw: yawTo(-0.5, 0.86),
    pitch: -0.30,
    note: 'VOID: the spire at 507 m, looking back down the course',
  },
}

export const VOID_SHOT_NAMES = Object.keys(VOID_SHOTS)
export const SHOT_NAMES = Object.keys(SHOTS)
