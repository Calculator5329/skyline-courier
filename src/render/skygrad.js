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
vec3 scSkyGradient( vec3 d, vec3 zenith, vec3 horizon, vec3 deck, vec3 sunColor, vec3 sunDir ) {
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
