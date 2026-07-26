import * as THREE from 'three'
import { SKY, SKY_GRADIENT_GLSL } from './skygrad.js'

/**
 * Material injection.
 *
 * Four things have to happen INSIDE the lit material rather than as a
 * post-process, because each of them belongs to one specific term of the
 * lighting equation and a screen-space multiply cannot tell the terms apart:
 *
 *   1. contact shadows -> the SUN's direct term only, never ambient;
 *   2. ambient occlusion -> the INDIRECT terms only, never the sun;
 *   3. the light budget -> the indirect terms AND the non-key directional
 *      lights, so the 20% rule in skyenv.js survives contact with the
 *      HemisphereLight and the two fill lights that are already in the scene;
 *   4. aerial perspective -> after everything, in linear light, using the
 *      fragment's own world position and height.
 *
 * ==================== CHAINING, AND WHY IT LOOKS LIKE THIS ==================
 * Another system patches these same materials for macro relief and detail
 * variation. `onBeforeCompile` is a single slot on the material, so whoever
 * assigns last wins unless everybody chains, and `customProgramCacheKey` has
 * exactly the same problem — a patch that does not contribute to the key gets
 * silently served another patch's cached program.
 *
 * So this file never assigns; it wraps. It captures whatever hook and key are
 * already there and calls them first, and it appends to the key rather than
 * replacing it. It also tracks what it has already patched (WeakSet + a
 * userData version stamp) so that a re-walk of the scene cannot wrap the same
 * material twice and run the injection twice.
 *
 * The injection sites were chosen to be as unhelpful to a collision as
 * possible:
 *
 *  - The contact shadow does NOT expand `lights_fragment_begin` to reach inside
 *    the directional-light loop. It APPENDS a wrapper function to
 *    `lights_pars_begin` and then #defines `getDirectionalLightInfo` to point
 *    at the wrapper. The preprocessor does the rest, the loop body is never
 *    touched, and a second patcher that does want to rewrite the loop still
 *    finds `#include <lights_fragment_begin>` exactly where it expects it.
 *  - The ambient budget APPENDS to `lights_fragment_maps`.
 *  - Aerial perspective replaces `fog_fragment`, which is the one chunk whose
 *    entire job this is taking over.
 * ============================================================================
 */

/**
 * Bump when the injected GLSL changes. It is part of the program cache key, so
 * a stale cached program cannot survive an edit to this file during a dev
 * session.
 */
const PATCH_VERSION = 4

/** Materials that actually run three's lighting pipeline. */
function isLit(m) {
  return !!(m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial))
}

/**
 * A hex colour in LINEAR light, scaled so its Rec.709 luminance is exactly 1.
 *
 * This is what makes the ambient split a pure hue rotation. A tint that changes
 * luminance is an exposure change wearing a colour costume, and it would put
 * the carefully measured 20% ambient budget upstream out by however saturated
 * the tint happens to be.
 */
function lumNormalized(hex) {
  const c = new THREE.Color(hex)
  const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722
  return c.multiplyScalar(l > 1e-6 ? 1 / l : 1)
}

const PARS = /* glsl */ `
${SKY_GRADIENT_GLSL}
uniform sampler2D scContactTex;
uniform vec2 scScreenTexel;
uniform vec3 scSunDirView;
uniform vec3 scSunDirWorld;
// x: contact shadows on, y: IBL gain, z: hemisphere/ambient trim, w: unused
uniform vec4 scFeat;
// x: trim for non-key directionals arriving from ABOVE the horizon (side fill),
// y: trim for non-key directionals arriving from BELOW (the cloud-deck bounce),
// z: 1 once a shadow-casting key light has actually been identified,
// w: how much of the AO buffer to apply to the indirect terms
uniform vec4 scFill;
// x: density at the reference height, y: scale height (m),
// z: reference height (m), w: inscatter boost
uniform vec4 scAerial;
// x: transmittance floor, y: rim strength, z/w: unused
uniform vec4 scAerial2;
// Per-channel extinction ratios. See scAerialPerspective.
uniform vec3 scAerialBeta;
uniform vec3 scHazeSun;
// The sky, sampled by the same function world.js draws it with.
uniform vec3 scSkyZenith;
uniform vec3 scSkyHorizon;
uniform vec3 scSkyDeck;
uniform vec3 scSkySunColor;
// x: warm/cool ambient split strength, y/z/w: unused
uniform vec4 scAmbSplit;
uniform vec3 scAmbUp;
uniform vec3 scAmbDown;

/**
 * The warm/cool split, applied to the AMBIENT terms by surface orientation.
 *
 * docs/art-direction.md calls cool green-tinted shadows against a warm key
 * "the single most defining characteristic" of the reference, and a shadow is
 * by definition a surface receiving no key — so the entire split has to be
 * carried by the ambient or it does not exist. What a shadowed up-facing deck
 * receives is sky; what a shadowed soffit receives is the sunlit cloud deck
 * below. Those are different colours by 40-odd degrees of hue and that
 * difference IS the effect.
 *
 * A HemisphereLight cannot express this at the strength required (it is one
 * lerp with no saturation control and it is 12% of the ambient budget here),
 * and the sky IBL — which does express it, correctly, and does most of the work
 * — is not available at all on a context without float render targets. This
 * term is what makes the split survive that fallback, and it is the one knob
 * that can be pointed at directly when the measurement says the hue separation
 * is short.
 *
 * BOTH tints are normalised to luminance 1 in the constructor, so this rotates
 * hue and changes nothing about the light budget: the 20% rule upstream stays
 * exactly as measured.
 */
vec3 scAmbientTint( vec3 N ) {
  if ( scAmbSplit.x <= 0.0 ) return vec3( 1.0 );
  vec3 wN = inverseTransformDirection( N, viewMatrix );
  // Hemispherical weight, not a step: a vertical wall lands at exactly 0.5 and
  // reads as the average of sky and cloud, which is what a vertical wall
  // actually receives.
  float up = clamp( wN.y * 0.5 + 0.5, 0.0, 1.0 );
  /**
   * ...and then held back on UP-FACING normals by 1 - 0.6 * max(0, N.y).
   *
   * The physics says a deck sees the sky and the sky is cool green, and that is
   * true. What it leaves out is that this sun sits at 9.8 degrees of elevation,
   * so a horizontal surface receives sin(9.8) = 0.17 of the key and is drawn
   * almost entirely by that cool ambient — while the vertical riser beside it
   * takes cos(9.8) = 0.98 and is drawn by the warm key. Applying the full split
   * on top of a 2.5-stop value difference is what turned the ascent stair in
   * tower.png into bright sandstone risers over olive treads: an inversion of
   * both value AND hue on a surface the player has to read at 47 km/h.
   *
   * 0.6 keeps the cool green on walls and soffits, where the split does its
   * work and where nobody is trying to judge a foothold, and hands the deck
   * back its ochre. It is the same trade taste.md asks for everywhere else:
   * the route is legible first, the physics is right second.
   */
  float hold = 1.0 - 0.6 * max( 0.0, wN.y );
  return mix( vec3( 1.0 ), mix( scAmbDown, scAmbUp, up ), scAmbSplit.x * hold );
}

/**
 * Screen-space contact shadow, valid for the SUN and nothing else.
 *
 * The buffer was marched along a single direction, so it is only valid for the
 * light it was marched for. The fill lights point somewhere else entirely and
 * must not receive it, or their shadows point the wrong way. The caller does
 * that test; this function only fetches.
 */
float scContactVisibility() {
  if ( scFeat.x < 0.5 ) return 1.0;
  return texture2D( scContactTex, gl_FragCoord.xy * scScreenTexel ).r;
}

/**
 * Screen-space AO, for the INDIRECT terms only.
 *
 * Never for the sun: the sun's occlusion is a shadow map plus the contact march
 * above, both of which know where the light actually is. Multiplying a
 * hemisphere visibility term onto a directional light double-counts the
 * occlusion in the crease and produces black corners, which is the single most
 * common way SSAO is misused.
 */
float scAmbientVisibility() {
  if ( scFeat.x < 0.5 ) return 1.0;
  float ao = texture2D( scContactTex, gl_FragCoord.xy * scScreenTexel ).b;
  return mix( 1.0, ao, scFill.w );
}

/**
 * Aerial perspective: the closed-form exponential-height fog integral.
 *
 * FogExp2 assumes a uniform medium, which is wrong in the way that matters
 * most for this game. Air thins with height, so the haze between you and a
 * distant island depends on how HIGH the two of you are, not just how far
 * apart — and that difference is the whole sensation of standing on a rooftop.
 * A uniform fog gives an island at 300 m the same veil whether you are on the
 * cloud deck or 200 m above it.
 *
 * Density is rho(h) = rho0 * exp( -(h - href) / H ). Along a straight ray the
 * height is linear in t, so the integral has a closed form:
 *
 *   tau = rho0 * exp( -(h0 - href)/H ) * d * ( 1 - exp(-dy/H) ) / (dy/H)
 *
 * with dy the height gained over the ray and the trailing factor tending to 1
 * as dy -> 0. One exp and one divide; no marching.
 *
 * Extinction is then PER CHANNEL. That is where the distance desaturation comes
 * from: blue is removed from the direct path fastest, so a distant terracotta
 * roof loses its blue first and drifts toward the gold of the inscatter rather
 * than fading uniformly toward grey. Grey is what a single-channel fog gives
 * you, and grey murk is the failure mode this art direction cannot survive.
 *
 * The inscatter colour is BRIGHTER than most surfaces in the scene, on purpose:
 * distant geometry has to LIGHTEN into the haze. Haze that darkens what it
 * covers reads as smog; haze that lightens it reads as distance.
 *
 * ===================== WHY THE HAZE IS THE SKY =============================
 * A single warm inscatter colour is what an unfinished background looks like.
 * Every island at every distance converges on the same value, so near, mid and
 * far read as one flat card at three scales and the archipelago — the headline
 * effect of this art direction — stops being legible as depth at all.
 *
 * The version before this one already knew that and answered it with three
 * hand-picked haze colours blended by the view ray's angle to the sun. It was
 * an improvement and it was still wrong, in a way the art review named
 * exactly: three constants cannot follow a sky that runs cool at the zenith
 * through a tight warm band at the horizon to a luminous cloud deck below.
 * Measured, an island 300 m out came back cool blue-white in front of a warm
 * tan sky and popped forward as a cut-out.
 *
 * So the inscatter is now SAMPLED FROM THE SKY, in the view direction, using
 * scSkyGradient — literally the same function world.js draws the dome with
 * (see render/skygrad.js). The two cannot disagree, because there is only one
 * of them. That is also the physically honest answer: the light scattered into
 * a horizontal path IS, to first order, the sky radiance along it.
 *
 * The directional structure the hand-picked colours were reaching for comes
 * for free and in more detail — an island silhouetted a few degrees above the
 * horizon gets the bright warm band, one below it gets the cloud deck, one seen
 * against the zenith gets the cool green, and everything toward the sun gets
 * the aureole — with the tight forward lobe kept on top for the last ~30
 * degrees, because that is a scattering phase function and not a sky colour.
 *
 * The transmittance FLOOR does the rest: no matter how much haze a ray crosses,
 * a fixed fraction of the surface's own colour survives. Physically that is a
 * cheat; compositionally it is the difference between four legible distance
 * bands and a wall of fog with rectangles printed on it.
 *
 * N is the view-space shading normal, passed in rather than read from three's
 * own "normal" variable: this is a function declared alongside the lighting
 * parameters, and that variable is a local of main(). The call site is inside
 * main(), where it is in scope.
 */
vec3 scAerialPerspective( vec3 color, vec3 N ) {
  if ( scAerial.x <= 0.0 ) return color;

  vec3 viewV = -vViewPosition;                 // fragment position, view space
  float dist = length( viewV );
  if ( dist < 1e-4 ) return color;
  vec3 dirW = inverseTransformDirection( viewV / dist, viewMatrix );
  float h0 = cameraPosition.y - scAerial.z;
  float h1 = ( cameraPosition.y + dirW.y * dist ) - scAerial.z;

  float H = max( 1.0, scAerial.y );
  float k = ( h1 - h0 ) / H;
  // (1 - exp(-k))/k, with the removable singularity at k = 0 replaced by its
  // series expansion. Without this a perfectly horizontal ray divides by zero
  // and the horizon comes back NaN.
  float ramp = abs( k ) < 1e-3 ? 1.0 - 0.5 * k : ( 1.0 - exp( -k ) ) / k;
  // Clamped so a camera far below the reference plane cannot produce exp() of
  // a large positive number and saturate the whole frame to haze.
  float base = exp( -clamp( h0 / H, -3.0, 20.0 ) );
  float tau = scAerial.x * base * dist * max( ramp, 0.0 );

  vec3 T = max( exp( -tau * scAerialBeta ), vec3( scAerial2.x ) );

  float sunCos = dot( dirW, scSunDirWorld );

  // THE INSCATTER IS THE SKY. One evaluation, shared with the dome — see the
  // block comment above and render/skygrad.js. Every bit of directional and
  // vertical structure comes from here, which is why there is no longer a
  // hand-picked "cool side" constant to keep in sync with anything.
  vec3 inscatter = scSkyGradient(
    dirW, scSkyZenith, scSkyHorizon, scSkyDeck, scSkySunColor, scSunDirWorld );

  // The tight forward lobe, kept separate because it is a phase function
  // rather than a sky colour: the last ~30 degrees around the solar azimuth
  // scatter far more light toward the eye than the sky in that direction is
  // itself emitting, and that excess is what makes a backlit island read as
  // backlit instead of merely hazy.
  inscatter = mix( inscatter, scHazeSun, pow( max( sunCos, 0.0 ), 3.0 ) * scAerial2.w );
  inscatter *= scAerial.w;

  vec3 result = color * T + inscatter * ( 1.0 - T );

  // --- distance-aware chroma restore --------------------------------------
  // AgX's inset is a desaturating transform by construction, and it takes its
  // biggest bite exactly where this pipeline can least afford it: a low-contrast
  // warm haze covering a distant island is pushed toward the achromatic axis
  // until the far, mid and near bands are the same brown. A global saturation
  // lift in the LUT cannot fix that without over-saturating the foreground,
  // which is already fine.
  //
  // So the restore is keyed on how much haze the ray actually crossed. Near
  // geometry is untouched; a speck at 600 m gets its hue back, which is what
  // keeps four distance bands legible as four distance bands rather than as one
  // flat card at four scales.
  if ( scAerial2.z > 0.0 ) {
    float hazed = clamp( 1.0 - dot( T, vec3( 0.3333 ) ), 0.0, 1.0 );
    float lr = dot( result, vec3( 0.2126, 0.7152, 0.0722 ) );
    result = lr + ( result - lr ) * ( 1.0 + scAerial2.z * hazed );
  }

  // --- backlit silhouette rim ---------------------------------------------
  // A low sun behind an object lights the sliver of surface that turns away
  // from the camera, and that bright edge is what separates a distant island
  // from the haze it sits in. Approximated from the view-space normal: pure
  // Fresnel falloff, gated hard on the view ray pointing sunward so it can
  // never fire on a front-lit surface and read as a glow outline. Added AFTER
  // extinction on purpose — a rim that the haze eats is a rim that does not do
  // its one job.
  if ( scAerial2.y > 0.0 ) {
    float fres = 1.0 - abs( dot( normalize( N ), normalize( vViewPosition ) ) );
    float rim = fres * fres * fres * fres * pow( max( sunCos, 0.0 ), 2.0 );
    result += scHazeSun * ( rim * scAerial2.y );
  }

  return result;
}
`

const DIR_WRAPPER = /* glsl */ `
#if ( NUM_DIR_LIGHTS > 0 )
/**
 * The whole non-key light budget, enforced from inside the unrolled light loop.
 *
 * world.js adds three DirectionalLights: the shadow-casting key, a cool side
 * fill from the opposite azimuth, and a warm bounce from below the cloud deck.
 * Measured, the fill and the bounce together spend more than the entire ambient
 * budget again, which is why every box in the frame was lit almost identically
 * on all faces. skyenv.js already makes the argument: ambient that approaches
 * the key kills the shapes the key is drawing.
 *
 * We cannot delete another file's lights, and we should not want to — the level
 * is one declaration and the lighting rig belongs to world.js. What this
 * pipeline owns is the BUDGET, so it trims them here, at the only point in the
 * shader where the terms are still separable, using ratios measured off the
 * lights themselves (see RenderPipeline._walk). If world.js dials its own fills
 * down to the budget, the trims measure out at 1.0 and this costs nothing.
 *
 * Classification is by the world-space direction TOWARD the light, because that
 * is the only thing distinguishable inside a loop that has no idea which light
 * index it is on: pointing up = a side fill the sky IBL is already doing
 * directionally and better; pointing down = the cloud-deck bounce, which is
 * real, is what keeps the undersides of floating islands from going black, and
 * therefore keeps a (much smaller) share of the budget.
 */
void scGetDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
  getDirectionalLightInfo( directionalLight, light );

  // 0.999 rather than an equality: both vectors are normalised and uploaded
  // through the same path, so the residual is float noise, but an exact compare
  // on a float is never the right instrument.
  float isKey = step( 0.999, dot( light.direction, scSunDirView ) );

  vec3 dirW = inverseTransformDirection( light.direction, viewMatrix );
  float trim = dirW.y < 0.0 ? scFill.y : scFill.x;
  // scFill.z is 0 until the scene walk has actually found a shadow-casting key.
  // Without that guard, a frame rendered before the walk has run would classify
  // the sun itself as a fill and come back black.
  trim = mix( 1.0, trim, scFill.z );

  light.color *= mix( trim, scContactVisibility(), isKey );
}
// From here on every call site in the lighting template resolves to the
// wrapper. Defined AFTER the body above, so the body's own call still reaches
// three's function and this is not infinite recursion.
#define getDirectionalLightInfo( a, b ) scGetDirectionalLightInfo( a, b )
#endif
`

const AMBIENT = /* glsl */ `
#if defined( RE_IndirectDiffuse )
{
  // ---- the ambient budget, and the AO that gives it form -----------------
  // The irradiance variable at this point is the AmbientLight plus the HemisphereLight and
  // nothing else — every direct light goes through RE_Direct. So this is the
  // exact and only lever that trims the scene's existing constant ambient
  // without touching world.js, and it is what keeps total ambient at the 20%
  // of key that skyenv.js normalised the sky map to. Two ambient systems both
  // running at full strength is 40%, and at 40% the key light stops drawing
  // the forms.
  float scAO = scAmbientVisibility();
  vec3 scTint = scAmbientTint( normal );
  irradiance *= scFeat.z * scAO * scTint;
  iblIrradiance *= scFeat.y * scAO * scTint;
}
#endif
#if defined( RE_IndirectSpecular )
  // Half the AO on the specular term. A diffuse hemisphere integrates the whole
  // visibility function, so full AO is correct there; a specular lobe integrates
  // a narrow cone about the reflection vector, which is far less likely to be
  // blocked by the same crease. Applying the diffuse AO at full strength to
  // radiance is what kills the brass — the one material in this world whose
  // whole character is that it catches the sky.
  radiance *= scFeat.y * mix( 1.0, scAmbientVisibility(), 0.5 );
#endif
`

export class MaterialPatcher {
  /**
   * @param {object} [options] per-theme atmosphere colours. See `theme.aerial`.
   *   Everything defaults to the shipped golden-hour values, so the skyline
   *   theme is unchanged by construction.
   */
  constructor(options = {}) {
    /**
     * ONE uniform object, shared by every patched material.
     *
     * three stores the object handed to onBeforeCompile as the material's
     * uniform source, so inserting the same `{ value }` boxes into every
     * shader means a single write per frame updates all of them — no per-material
     * loop, and nothing to allocate in render().
     */
    this.uniforms = {
      scContactTex: { value: null },
      scScreenTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
      scSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      scSunDirWorld: { value: new THREE.Vector3(0, 1, 0) },
      scFeat: { value: new THREE.Vector4(0, 1, 1, 0) },
      scFill: {
        value: new THREE.Vector4(
          // Side-fill and bounce trims start at 1 (no trim) and are measured by
          // RenderPipeline._walk on the first frame.
          1,
          1,
          // Disarmed until a key light has been found. See the wrapper.
          0,
          // AO strength on the indirect terms. 0.9 rather than 1.0: the level
          // geometry already carries a hand-baked vertex-colour contact term
          // (level.js darkens the first metre above every box base), and
          // stacking a full-strength screen-space AO on top of it doubles the
          // occlusion in exactly the places the artist already handled.
          0.9
        ),
      },
      scAerial: {
        value: new THREE.Vector4(
          // Density at the reference height.
          //
          // Was 0.0028, which with the per-channel betas below is an effective
          // ~0.0031/m: an island at 250 m kept 13% of its own colour and the
          // whole background collapsed onto one value by ~120 m. Measured
          // regionSpread on the vista shot was 39.8, the flattest frame in the
          // set, for the shot that is supposed to BE the art direction.
          //
          // 0.0014/m, down again from 0.0019. Measured on the vista shot after
          // the metering fix below let it be exposed properly: it came back at
          // 0.312 mean saturation, the lowest in the set, because once the
          // frame was bright the haze was simply the brightest thing in it and
          // every island past the near band was more inscatter than surface.
          // Depth has to be carried by four legible bands, not by one veil, and
          // a veil that thick cannot produce bands at any exposure.
          0.0014,
          // scale height 70 m. The play space itself spans tens of metres of
          // height, so a short scale height would make the haze visibly switch
          // off as the player climbs one tower. 70 m fades it by about a third
          // over that climb — felt, not noticed.
          70,
          // reference height 0 = the nominal deck level.
          0,
          // Inscatter boost 0.92, down from 1.3.
          //
          // The haze still has to be brighter than the SURFACES it covers so
          // that distance lightens — the extinction maths guarantees that,
          // because a shadowed island side is far below any of these colours.
          // What it must NOT be is brighter than the SKY behind it, and at 1.3
          // it was: the far archipelago came back as white paper cut-outs
          // pasted over a darker sky, which is the exact opposite of the read.
          // A solid object seen through 300 m of golden air is a shade DARKER
          // than the luminous air beside it.
          0.92
        ),
      },
      scAerial2: {
        value: new THREE.Vector4(
          // Transmittance floor 0.20, up from 0.12: a far speck keeps a fifth of
          // its own colour no matter how much air is in front of it. See the
          // note in scAerialPerspective on why this cheat earns its place — and
          // note that it is the ONLY thing standing between the far archipelago
          // and a single flat value, because extinction is exponential and every
          // band past the second is deep in its tail.
          0.20,
          // Rim strength 0.16, in linear light against a scHazeSun that is
          // already above 1. Enough to draw a lit edge on a backlit silhouette;
          // well under the point where it reads as an outline shader.
          0.16,
          // Distance chroma restore, 0.55 at full haze. Measured against the
          // vista shot, which came back at 0.338 mean saturation — the LOWEST
          // of the eight harness frames, for the one image whose stated job is
          // to sell the art direction. Sized so the far bands come back to
          // roughly the foreground's chroma rather than exceeding it; above
          // ~0.8 the horizon starts to read as a poster.
          0.55,
          // Forward-lobe strength, 0.42. How far the inscatter is allowed to
          // depart from the sky's own value looking straight down the solar
          // azimuth. It replaces what used to be a full lerp to `scHazeSun`,
          // which at 1.0 printed a bright cream disc onto every surface facing
          // the sun regardless of how much air was actually in front of it.
          0.42
        ),
      },
      scAerialBeta: {
        // Rayleigh is 1/lambda^4, which at Rec.709 primaries is roughly
        // (0.43, 1.0, 2.44) — far too strong on its own, and it would turn the
        // distance blue, which is the opposite of this art direction. Blended
        // ~40% toward neutral aerosol scattering (which is what a warm, hazy,
        // low-sun sky is actually full of) gives a gentle warm-ward drift with
        // distance instead of a blue wall.
        value: new THREE.Vector3(0.72, 1.0, 1.62),
      },
      // The forward-scatter lobe's colour: brighter and creamier than any part
      // of the sky, because it is the sun's own light redirected toward the eye
      // by the haze rather than the haze's ambient glow.
      // THE COLOUR OF THE LIGHT IN THE AIR, and per theme, because it turns out
      // to be most of the light landing on anything.
      //
      // Measured on the void by the materials lane: with the Fresnel rim below
      // ON, a lit rock face is rgb(104,69,61) — bronze. With `aerialRim` at 0,
      // the SAME face is rgb(1.0, 0.9, 7.1). So this warm haze was supplying
      // essentially all of it, and supplying it golden-hour cream, which is why
      // near-black violet rock kept photographing as tan whatever the painter
      // did. It is the single biggest reason the void did not look like its
      // reference.
      scHazeSun: { value: new THREE.Color(options.hazeSun ?? 0xfff0d2)
        .multiplyScalar(options.hazeGain ?? 1.5) },
      /**
       * THE SKY, and the reason there is no separate haze palette any more.
       *
       * These four are the exact values `world.js` hands its dome shader —
       * both sides read them from `skygrad.js`. Changing the sky's horizon here
       * without changing it there is not possible, which is the point: the
       * previous three-constant haze had to be manually re-matched every time
       * the sky moved, and measured on the shot set it had drifted far enough
       * that distant islands came back cool blue-white against a warm tan sky.
       */
      /**
       * Void mode, shared with the dome. See render/skygrad.js.
       *
       * It lives in the SAME uniform block as the sky colours for the same
       * reason they do: the aerial perspective's inscatter and the dome behind
       * it must be one evaluation. A void whose haze still remembered a cloud
       * deck would fade every distant ruin into a colour the background does
       * not contain.
       */
      scSkyVoid: { value: 0 },
      scSkyZenith: { value: new THREE.Color(SKY.zenith) },
      scSkyHorizon: { value: new THREE.Color(SKY.horizon) },
      scSkyDeck: { value: new THREE.Color(SKY.deck) },
      scSkySunColor: { value: new THREE.Color(SKY.sun) },
      // Ambient split strength. 0.30, measured rather than chosen: at 0.42 the
      // terrace deck came back at hue 45 lit / 57-69 shadowed, which clears the
      // +20-degree separation target but drags the LIT sandstone from ochre to
      // olive on the way — the deck is an up-facing surface, so it takes the
      // full cool tint whether the sun is on it or not. 0.30 keeps the
      // separation and hands the ochre back. See scAmbientTint.
      scAmbSplit: { value: new THREE.Vector4(0.30, 0, 0, 0) },
      // Sky-facing: the green-cyan of the zenith band, matched to skyenv's
      // zenith so the two ambient systems agree instead of fighting.
      scAmbUp: { value: lumNormalized(options.ambUp ?? 0x8fd8c4) },
      // Down-facing: the sunlit cloud deck. Warm, and the reason island
      // undersides are lit rather than black.
      scAmbDown: { value: lumNormalized(options.ambDown ?? 0xffcf96) },
    }

    this._patched = new WeakSet()
    this.count = 0
    this.key = `sc-render-${PATCH_VERSION}`
  }

  /**
   * Wrap `material`. Returns true if it was patched by this call.
   *
   * Idempotent by WeakSet AND by a userData stamp: the WeakSet catches a repeat
   * within this patcher's lifetime, the stamp catches a second patcher instance
   * built after a hot reload finding an already-wrapped material.
   */
  patch(material) {
    if (!isLit(material)) return false
    if (this._patched.has(material)) return false
    if (material.userData && material.userData.scPatchVersion === PATCH_VERSION) return false
    if (material.userData && material.userData.scNoPatch) return false

    this._patched.add(material)
    if (material.userData) material.userData.scPatchVersion = PATCH_VERSION
    this.count++

    const uniforms = this.uniforms
    const key = this.key
    // Capture, do not clobber. Whatever is already here runs first and keeps
    // its own `this`.
    const prevHook = material.onBeforeCompile
    const prevKey = material.customProgramCacheKey

    material.onBeforeCompile = function (shader, renderer) {
      if (typeof prevHook === 'function') prevHook.call(this, shader, renderer)

      for (const k in uniforms) shader.uniforms[k] = uniforms[k]

      let fs = shader.fragmentShader

      // 1. contact shadow, via a preprocessor wrapper around the light getter.
      fs = fs.replace(
        '#include <lights_pars_begin>',
        '#include <lights_pars_begin>\n' + PARS + DIR_WRAPPER
      )

      // 2. ambient budget, appended after the indirect terms are gathered.
      fs = fs.replace(
        '#include <lights_fragment_maps>',
        '#include <lights_fragment_maps>\n' + AMBIENT
      )

      // 3. aerial perspective, REPLACING three's fog.
      //
      // Placement is load-bearing: fog_fragment sits after tonemapping and
      // colorspace, and in this pipeline both of those are no-ops (NoToneMapping,
      // and the HDR target is LinearSRGB), so gl_FragColor here is still
      // scene-referred linear light. That is the only space in which an
      // extinction/inscatter model means anything — applied to display code
      // values it would be a cross-fade to a flat colour.
      fs = fs.replace(
        '#include <fog_fragment>',
        'gl_FragColor.rgb = scAerialPerspective( gl_FragColor.rgb, normal );'
      )

      shader.fragmentShader = fs
    }

    material.customProgramCacheKey = function () {
      const base = typeof prevKey === 'function' ? prevKey.call(this) : ''
      // Appended, not replaced: the other patcher's key contribution has to
      // survive or two of its variants collapse onto one cached program.
      return base + key
    }

    material.needsUpdate = true
    return true
  }

  // ------------------------------------------------------------- live values

  setScreenSize(w, h) {
    this.uniforms.scScreenTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h))
  }

  setContactEnabled(on) {
    this.uniforms.scFeat.value.x = on ? 1 : 0
  }

  setContactTexture(tex) {
    this.uniforms.scContactTex.value = tex
  }

  get iblGain() { return this.uniforms.scFeat.value.y }
  set iblGain(v) { this.uniforms.scFeat.value.y = v }

  get ambientTrim() { return this.uniforms.scFeat.value.z }
  set ambientTrim(v) { this.uniforms.scFeat.value.z = v }

  /**
   * Trims on the non-key DirectionalLights, measured by the pipeline.
   * @param {number} side   multiplier on lights arriving from above the horizon
   * @param {number} bounce multiplier on lights arriving from below it
   * @param {boolean} armed true once a shadow-casting key has been identified
   */
  setFillTrim(side, bounce, armed) {
    const v = this.uniforms.scFill.value
    v.x = side
    v.y = bounce
    v.z = armed ? 1 : 0
  }

  /** How much of the AO buffer reaches the indirect terms. 0 = off. */
  get aoStrength() { return this.uniforms.scFill.value.w }
  set aoStrength(v) { this.uniforms.scFill.value.w = v }

  /** Floor on aerial transmittance — how much of its own colour a far surface keeps. */
  get aerialFloor() { return this.uniforms.scAerial2.value.x }
  set aerialFloor(v) { this.uniforms.scAerial2.value.x = v }

  /** Backlit silhouette rim strength. */
  get aerialRim() { return this.uniforms.scAerial2.value.y }
  set aerialRim(v) { this.uniforms.scAerial2.value.y = v }

  /** Chroma restored at full haze, to undo AgX's desaturation at distance. */
  get aerialChroma() { return this.uniforms.scAerial2.value.z }
  set aerialChroma(v) { this.uniforms.scAerial2.value.z = v }

  /** How far the inscatter departs from the sky down the solar azimuth. 0..1. */
  get aerialSunLobe() { return this.uniforms.scAerial2.value.w }
  set aerialSunLobe(v) { this.uniforms.scAerial2.value.w = v }

  /**
   * Re-point the haze's copy of the sky.
   *
   * @param {object} c any subset of {zenith, horizon, deck, sun} as hex.
   *
   * There is deliberately no way to set a haze colour that is not a sky colour.
   * If the dome moves, this moves with it or distant geometry starts
   * terminating against a colour the sky behind it does not reach.
   */
  setSkyColors(c) {
    if (c.voidMode !== undefined) this.uniforms.scSkyVoid.value = c.voidMode ? 1 : 0
    if (c.zenith !== undefined) this.uniforms.scSkyZenith.value.set(c.zenith)
    if (c.horizon !== undefined) this.uniforms.scSkyHorizon.value.set(c.horizon)
    if (c.deck !== undefined) this.uniforms.scSkyDeck.value.set(c.deck)
    if (c.sun !== undefined) this.uniforms.scSkySunColor.value.set(c.sun)
  }

  /** Warm/cool ambient split strength. 0 = off. See scAmbientTint. */
  get ambientSplit() { return this.uniforms.scAmbSplit.value.x }
  set ambientSplit(v) { this.uniforms.scAmbSplit.value.x = v }

  /** Sky-facing ambient tint (hex, sRGB). Normalised to luminance 1. */
  setAmbientUpColor(hex) { this.uniforms.scAmbUp.value.copy(lumNormalized(hex)) }

  /** Down-facing ambient tint (hex, sRGB). Normalised to luminance 1. */
  setAmbientDownColor(hex) { this.uniforms.scAmbDown.value.copy(lumNormalized(hex)) }

  get aerialDensity() { return this.uniforms.scAerial.value.x }
  set aerialDensity(v) { this.uniforms.scAerial.value.x = v }

  get aerialScaleHeight() { return this.uniforms.scAerial.value.y }
  set aerialScaleHeight(v) { this.uniforms.scAerial.value.y = v }

  get aerialReferenceHeight() { return this.uniforms.scAerial.value.z }
  set aerialReferenceHeight(v) { this.uniforms.scAerial.value.z = v }

  get aerialInscatter() { return this.uniforms.scAerial.value.w }
  set aerialInscatter(v) { this.uniforms.scAerial.value.w = v }

  dispose() {
    this._patched = new WeakSet()
  }
}
