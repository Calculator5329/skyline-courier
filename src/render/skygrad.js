/**
 * THE SKY, AS ONE EVALUATION.
 *
 * Three systems have to agree about what colour the sky is in a given
 * direction, and until this file they did not:
 *
 *   1. `src/world.js` draws it on the backside sphere;
 *   2. `src/render/patch.js` uses it as the inscattered light in the aerial
 *      perspective — which is to say, as the colour a distant island fades
 *      INTO;
 *   3. `scene.fog`, which in this pipeline only reaches materials the patcher
 *      never saw, and which therefore must not be a fourth opinion.
 *
 * When (1) and (2) disagree the failure is specific and it is the one the art
 * review filed: a single constant fog colour cannot follow a sky that runs cool
 * at the zenith through warm at the horizon to a luminous cloud deck below, so
 * distant geometry terminates against a colour the sky behind it never
 * reaches. Cool blue-white islands in front of a warm tan sky do not read as
 * distance, they read as cut-outs pasted on a backdrop — which is exactly what
 * a painted backdrop looks like, and the whole reason the sky is a shader here
 * in the first place.
 *
 * So the gradient lives here once, as a GLSL string, and both consumers
 * `#include` it. It is deliberately the LOW-FREQUENCY half of the sky only: no
 * billow detail, no solar disc. Both of those are world.js's business, because
 * neither belongs in an integral over a 300 m path through haze — the haze is
 * lit by the whole deck, not by one billow, and a fog that contained the sun
 * disc would print a copy of the sun onto every island edge that happened to
 * line up with it.
 */

/**
 * The canonical sky, in one place so the shader and the JS side cannot drift.
 * Hex values are sRGB and are converted by `THREE.Color` on the way in.
 */
export const SKY = {
  /**
   * Cooler and greener than a midday blue, to agree with the IBL's zenith —
   * that cool cast is what makes shadows read green rather than grey against
   * the amber key.
   */
  zenith: 0x5589a0,
  /** The tight, very warm band the low sun sits in. */
  horizon: 0xffd9a4,
  /**
   * The cloud deck's base value. BRIGHT: everything below the horizon in this
   * world is luminous cloud, never dark earth.
   */
  deck: 0xf6e0c0,
  /** The sun's own colour, for the aureole and the lit sides of the billows. */
  sun: 0xffd9a0,

  /**
   * WORLD Y OF THE CLOUD DECK, IN METRES.
   *
   * This number is the entire difference between a cloud sea and a screen-wide
   * smudge. The deck shader intersects the view ray with a horizontal plane, so
   * the plane's DISTANCE below the camera sets how much of the noise field one
   * pixel spans — and the old shader assumed a distance of exactly 1 metre,
   * which put roughly a fifth of one noise period across the entire lower half
   * of the frame. One period across half a screen is not a cloud, it is a
   * gradient.
   *
   * -230 is 90 m below the lowest island in `level.js`'s far band (which
   * bottoms out around y = -140) and 230 m below the route. Far enough that no
   * island ever looks like it is resting on the deck, close enough that the
   * deck still resolves billows rather than becoming a flat floor at infinity.
   */
  deckY: -230,

  /**
   * METRES PER NOISE UNIT for the two deck layers.
   *
   * The fbm below runs five octaves, so the billow layer's visible features
   * land between `billow` and `billow / 16`: at 420 m that is masses of about
   * 420 m broken into billows of 210, 105, 52 and 26 m. Tens of metres, seen
   * from 230 m up, which is the scale a cloud deck actually reads at.
   *
   * 420 rather than the 150 this was first set to, and the reason is
   * perspective, not taste. The deck is 230 m down, so the nearest part of it
   * the camera can see is already ~250 m out and everything else is further:
   * at 150 m per period the frame contained dozens of periods and the sea came
   * back as bright speckle on a grey field — foam, not cloud. The visible
   * range of a plane below you is enormous, and the feature size has to be
   * sized to that range rather than to the altitude.
   *
   * `bank` is an order of magnitude coarser and moves an order of magnitude
   * slower. It is the layer that survives the horizon fade, and it is what
   * gives the skyline a profile instead of a ruled line.
   */
  billowScale: 420,
  bankScale: 3200,
}

/**
 * `scSkyGradient` plus the two cloud-deck value helpers.
 *
 * Guarded so that a shader which pulls in both this and something else that
 * included it does not redefine the functions.
 */
export const SKY_GRADIENT_GLSL = /* glsl */ `
#ifndef SC_SKY_GRADIENT
#define SC_SKY_GRADIENT

/**
 * VOID MODE. 0 = the sky above; 1 = no sky at all.
 *
 * Declared HERE, inside the shared include, rather than in each consumer, for
 * the same reason the gradient itself lives here: the dome, the aerial
 * perspective and scene.fog have to agree about what is behind the world, and
 * a mode flag that only one of them knew about would reintroduce exactly the
 * "distant geometry terminates against a colour the sky never reaches" bug
 * this file was written to kill. Every shader that includes this gets the
 * declaration; a consumer that never sets it gets WebGL's default of 0, which
 * is the shipped skyline path unchanged.
 */
uniform float scSkyVoid;

/**
 * The shaded side of a billow.
 *
 * 0.55 of the deck value, against a lit side that sits near 0.95 of it. The old
 * pair was 0.80 versus a lit side at 0.88 — under 20% apart, which is why a
 * shader that computed a full domain-warped fbm delivered a flat gradient: you
 * cannot see structure through an eight-percent value split, whatever the
 * structure is.
 *
 * The per-channel tint leans the shade green-blue. Cloud shadow is lit by the
 * sky above it rather than by the sun, and this sky is cool green at the top,
 * so a warm shade is not a stylistic choice, it is a missing light source. The
 * tint is normalised to luminance ~0.98 so it rotates hue and leaves the 0.55
 * value split where it is written.
 */
vec3 scCloudShade( vec3 deck ) {
  return deck * 0.55 * vec3( 0.86, 1.00, 1.12 );
}

/** The sunlit side of a billow: the deck value pulled 42% toward the sun. */
vec3 scCloudLit( vec3 deck, vec3 sunColor ) {
  return mix( deck, sunColor, 0.42 );
}

/**
 * THE VOID's answer to the same question: what is behind the world?
 *
 * Nothing. docs/art-direction-void.md §3 is explicit — "there is no sun and no
 * sky; anything that reads as a horizon line is wrong" — so this is not the
 * function above with darker inputs, it is a different shape:
 *
 *  - NO DECK. The luminous cloud sea below the horizon is the single biggest
 *    contributor of light in the skyline frame and there is nothing like it in
 *    a void. Everything below eye level is more void, not a floor.
 *  - NO BAND, NO LINE. The gradient above runs a tight bright band at h = 0
 *    against a dark zenith, which IS a horizon. Here the ramp is one smooth
 *    monotone function of height spread over 130 degrees of dome, so there is
 *    no h at which the derivative spikes and therefore no edge for the eye to
 *    latch onto.
 *  - NO SUN TERM. No disc, no aureole, no azimuthal warming. A directional
 *    brightening in the background of a void is a sun by any other name.
 *
 * The ramp is squared on purpose. A linear fade puts the mid-violet across the
 * whole lower dome and that is the murk failure: most of the dome has to sit
 * within a hair of the near-black zenith, with the haze colour only arriving
 * well below eye level, where the depth of the void is. At h = 0 this returns
 * about 15% of the way from black toward the haze — dark enough that a distant
 * silhouette still reads against it, violet enough that it is never grey.
 *
 * The deck and sunColor arguments are unused here, deliberately: the signature
 * is shared so that a caller cannot accidentally invoke one mode's parameter
 * list against the other.
 */
vec3 scVoidGradient( vec3 d, vec3 zenith, vec3 haze ) {
  // 0 at the top of the dome, 1 far below. Edges chosen so the ramp never
  // finishes inside the frame: straight up is fully black, straight down is
  // fully haze, and every angle between is on the curve.
  //
  // The window is skewed UPWARD (0.75 above, -0.55 below) because the camera
  // in this course spends its time looking up (§5, "look up, not down"): the
  // half of the dome the player actually reads is the half above eye level, so
  // that is the half the ramp has to spend its resolution on.
  float t = smoothstep( 0.75, -0.55, d.y );
  // pow 1.2 rather than the square this started as. The square was measured
  // and rejected: it held 85% of the dome within a hair of the near-black
  // zenith, which read correctly as "dark" and then failed §2 in the other
  // direction — p50 collapsed to 9 against a target of 22-45 and a tenth of
  // every frame clipped to true black against a target of 2-8%. §2 asks for a
  // LOW-KEY image, not an EMPTY one, and the difference between those two is
  // exactly this exponent.
  return mix( zenith, haze, pow( t, 1.2 ) );
}

/**
 * Low-frequency sky radiance in direction d (unit, world space).
 *
 * Above the horizon: a tight warm band running to a barely-blue zenith, warmed
 * broadly toward the sun's azimuth. The pow(h, 0.42) holds the warm band down
 * in the bottom third of the dome — at golden hour the sky is mostly light, and
 * a wide blue wash immediately reads as midday.
 *
 * Below it: the cloud sea's MEAN value. Not its lit side and not its shade,
 * because this function's other job is to be the colour distance fades into,
 * and haze integrates the whole deck.
 */
/**
 * The dispatcher, and the shipped skyline gradient below the branch.
 *
 * The mode test lives HERE rather than at each call site so that the sky is
 * still exactly one evaluation shared by the dome, the aerial perspective and
 * scene.fog — the property this file exists to hold.
 */
vec3 scSkyGradient( vec3 d, vec3 zenith, vec3 horizon, vec3 deck, vec3 sunColor, vec3 sunDir ) {
  if ( scSkyVoid > 0.5 ) return scVoidGradient( d, zenith, horizon );

  float h = d.y;
  float sun = max( dot( d, sunDir ), 0.0 );

  vec3 sky = mix( horizon, zenith, pow( clamp( h, 0.0, 1.0 ), 0.42 ) );

  // Warm the whole sky toward the sun's azimuth, not just the disc. This is
  // what makes the light feel directional when you turn to face it.
  sky += sunColor * pow( sun, 3.0 ) * 0.14;
  sky += sunColor * pow( sun, 1.2 ) * 0.05 * smoothstep( 0.55, 0.0, abs( h ) );

  vec3 deckMean = mix( scCloudShade( deck ), scCloudLit( deck, sunColor ), 0.5 );
  return mix( sky, deckMean, smoothstep( 0.0, 0.10, -h ) );
}

#endif
`
