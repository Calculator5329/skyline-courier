import * as THREE from 'three'
import { Pass, renderTarget } from './pass.js'
import { GBUFFER_GLSL } from './gbuffer.js'
import { getTheme } from '../theme.js'

/**
 * Screen-space contact shadows.
 *
 * A 2048 shadow map spread over an 84 m frustum is a 4 cm texel before
 * filtering and more like 12 cm after PCF. That is wider than every contact
 * this art direction cares about: the seam where a moss cap sits on stonework,
 * the line under a ledge lip, the join where an ornament meets a wall. Those
 * all fall inside one texel, get the same shadow value as the surface they sit
 * on, and the object reads as a decal printed on the wall rather than a thing
 * resting against it.
 *
 * So we march a short ray through the depth buffer toward the sun and put that
 * last few centimetres back. With a low golden-hour sun the ray is nearly
 * horizontal and long in screen space, which is exactly when this technique is
 * at its best — and exactly when a shadow map is at its worst.
 *
 * The result is multiplied onto the SUN TERM ONLY, inside the material (see
 * patch.js). Never onto ambient: occlusion of a directional light and occlusion
 * of a hemisphere are different quantities, and multiplying a directional
 * visibility term onto ambient is how you get a scene where the shadows are
 * black holes instead of the cool green they should be.
 *
 * ------------------------------ AND THE AO ---------------------------------
 * The same pass also computes a hemisphere ambient occlusion into .b, because
 * it already has the two textures AO needs bound and a jitter value computed,
 * and a separate AO pass would pay that setup twice for no benefit.
 *
 * AO is not a luxury in THIS art direction, it is load-bearing. The sun sits at
 * ~10 degrees of elevation, so a horizontal deck receives sin(10) = 0.17 of the
 * key and is overwhelmingly lit by the ambient term. Every wall/floor junction,
 * every moss cap's overhang and every balustrade base is therefore drawn almost
 * entirely by ambient light, and un-occluded ambient draws none of them: that is
 * precisely the "untextured primitives" read. AO puts the form back into the
 * one term that is actually doing the lighting on a low-sun frame.
 */

const CONTACT = /* glsl */ `
precision highp float;
${GBUFFER_GLSL}

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform vec3 uSunDirView;
uniform vec4 uParams;   // x length(m)  y thickness(m)  z frame  w strength
uniform vec4 uAO;       // x intensity  y radius(m)  z max screen radius(uv)  w bias
uniform vec4 uAONear;   // the same four, for the short-radius set. x <= 0 = off
varying vec2 vUv;

// 14 steps. Below ~10 the ray steps over thin geometry (railings, the
// clockwork ornaments) and the shadow flickers as the camera moves; above ~16
// the extra samples land inside the same texel and buy nothing. 14 is where the
// curve flattens for a ray this short.
//
// This and the two tap counts below are DEFINES rather than uniforms because
// two of them are loop bounds and GLSL wants a constant expression there. The
// quality levels (src/render/quality.js) turn them via Pass.setDefine, which
// recompiles the pass. The values written here are the defaults, so the
// pass is correct — and identical to what shipped — if nobody sets a level.
#ifndef SC_CS_STEPS
#define SC_CS_STEPS 14
#endif

// 8 AO taps. The bilateral below averages a 5x5 neighbourhood, so each pixel
// effectively sees far more than 8 samples; going to 16 here doubles the cost of
// the most expensive pass in the chain for a difference that disappears into the
// blur. The golden-angle spiral is what makes 8 enough — it has no preferred
// direction, so the residual error is isotropic noise rather than a pattern.
#ifndef SC_AO_TAPS
#define SC_AO_TAPS 8
#endif
// ...and 5 for the short-radius set below. It is the more expensive of the two
// per tap (a tight screen footprint means its neighbours are the pixels every
// other thread also wants, but it runs on top of a full 8-tap set that has
// already paid for the cache line) and it is the cheaper of the two to
// under-sample: it produces a strong, spatially coherent signal in a crease and
// nothing at all in the open, which is exactly the shape the bilateral below
// resolves best. 8 and 5 measured indistinguishable in the frame and 5 gives
// most of the cost back.
//
// A float, and it must never exceed SC_AO_TAPS: it is the taps argument to the
// shared estimator, whose loop is bounded by SC_AO_TAPS. Asking for more near
// taps than broad ones would silently get SC_AO_TAPS of them and a wrong
// normalisation. ContactShadows.setTaps clamps rather than trusting a level.
#ifndef SC_AO_NEAR_TAPS
#define SC_AO_NEAR_TAPS 5.0
#endif
#define SC_GOLDEN_ANGLE 2.39996323

/**
 * Horizon-style hemisphere AO from the depth/normal prepass.
 *
 * For each tap we form the vector from this pixel to the sampled surface and ask
 * how far above the tangent plane it rises: dot(N, v/|v|). That is the sine of
 * the elevation the occluder subtends, which is the correct cosine-weighted
 * contribution for a diffuse hemisphere, and it costs one normalise.
 *
 * The two guards matter more than the estimator:
 *  - the RANGE check discards occluders further away than the radius, otherwise
 *    a near wall darkens a distant floor and you get the classic white halo
 *    around every silhouette;
 *  - the BIAS discards near-tangent samples, which are the same surface seen
 *    through depth-buffer quantisation rather than a real occluder.
 */
float scAmbientOcclusion( vec3 P, vec3 N, float depth, float jitter, vec4 ao, float taps ) {
  if ( ao.x <= 0.0 ) return 1.0;

  float radius = ao.y;
  // World radius -> uv radius. A length L at view depth d subtends L*P00/d in
  // NDC x, and uv is half of NDC. Clamped: at 30 cm from a wall the unclamped
  // footprint is most of the screen, which is both slow (cache misses on every
  // tap) and wrong (it stops being *ambient* occlusion and becomes shading).
  vec2 uvR = vec2( uProj[0][0], uProj[1][1] ) * ( radius / ( 2.0 * max( depth, 0.05 ) ) );
  // Clamp by the LARGER axis and scale both, rather than min()ing each
  // independently. Those two are not the same operation: uv is anisotropic on a
  // 16:9 frame, so an independent min turns the sampling disc — which the
  // projection terms above went to the trouble of making circular in WORLD
  // space — into an ellipse whose short axis is vertical. Every horizontal
  // crease then gets sampled twice as far as every vertical one, which is
  // exactly the sort of bug that reads as "the AO is weak" rather than as "the
  // AO is wrong".
  float over = max( uvR.x, uvR.y ) / max( ao.z, 1e-4 );
  if ( over > 1.0 ) uvR /= over;

  float occ = 0.0;
  for ( int i = 0; i < SC_AO_TAPS; i ++ ) {
    // Uniform across the whole draw (taps is a compile-time-constant argument
    // at both call sites), so this break costs nothing and genuinely saves the
    // taps it skips rather than masking them off.
    if ( float( i ) >= taps ) break;
    float fi = float( i ) + jitter;
    float a = fi * SC_GOLDEN_ANGLE;
    // sqrt of the index gives a UNIFORM disc rather than a centre-heavy one;
    // without it three quarters of the taps land inside the inner third of the
    // radius and the AO has no reach.
    float r = min( 1.0, sqrt( ( fi + 0.5 ) / taps ) );
    vec2 suv = vUv + vec2( cos( a ), sin( a ) ) * r * uvR;
    if ( suv.x <= 0.0 || suv.x >= 1.0 || suv.y <= 0.0 || suv.y >= 1.0 ) continue;
    if ( texture2D( tNormal, suv ).z < 0.5 ) continue;   // sky occludes nothing

    vec3 S = scViewPos( suv, texture2D( tDepth, suv ).r, uProjInv );
    vec3 v = S - P;
    float d = sqrt( max( dot( v, v ), 1e-8 ) );
    float range = clamp( 1.0 - ( d - radius ) / max( radius, 1e-3 ), 0.0, 1.0 );
    occ += max( dot( N, v / d ) - ao.w, 0.0 ) * range;
  }

  return clamp( 1.0 - ao.x * occ / taps, 0.0, 1.0 );
}

void main() {
  vec4 nrm = texture2D( tNormal, vUv );

  // Coverage 0 = the prepass never wrote here = sky. Return full light, full
  // AO, and a huge depth so the bilateral blur below treats it as a hard
  // discontinuity and never bleeds a shadow out over the cloud deck.
  if ( nrm.z < 0.5 ) { gl_FragColor = vec4( 1.0, 1e4, 1.0, 1.0 ); return; }

  float depth = texture2D( tDepth, vUv ).r;
  vec3 P = scViewPos( vUv, depth, uProjInv );
  vec3 N = scDecodeNormal( nrm.xy );
  vec3 L = uSunDirView;

  // Rotate the sample positions per pixel and per frame. Without the jitter the
  // march's 14 steps are visible as 14 concentric bands and the AO spiral is
  // visible as 8 spokes; with it both become noise the bilateral resolves into
  // a soft gradient. Shared by both estimators — they sample different spaces,
  // so one value cannot correlate them.
  float jitter = scIGN( gl_FragCoord.xy + uParams.z * 3.1717 );

  /**
   * TWO RADII, and the near one is the reason interior corners exist.
   *
   * BOTH RADII ARE PER-THEME (see applyThemeAO / uAO defaults below). The
   * numbers this comment reasons about — 0.9 m broad, 0.24 m near — are the
   * SKYLINE's, sized to the sunset archipelago's masonry. The void carries 40 m
   * great walls, 14 m slabs and gaps of tens of metres, so it sets its own,
   * roughly a class larger: a 0.9 m probe finds nothing to occlude in a
   * cathedral, and raising the intensity of an estimator that finds no
   * occluders cannot help. The scale changes; everything below about WHY there
   * are two of them, and why they combine with min(), does not.
   *
   * The broad set (0.9 m, skyline) is sized to the architecture — a moss lip, a
   * balustrade base, a stair nosing — and it is genuinely good at those. It is
   * structurally incapable of drawing a 90-degree wall/floor junction, and not
   * because it is too weak: at a junction the wall runs away to infinity, so
   * most of a 0.9 m disc of taps lands on wall pixels far enough away that the
   * RANGE check discards them, and the screen clamp throws away more. The
   * estimator returns "mostly open" for a quarter-space. Measured off the debug
   * view on closeup.png, that junction came back at 0.75-0.78 visibility
   * against the 0.5 a quarter-space analytically subtends.
   *
   * A 0.22 m disc at the same junction lands every tap on surface that is
   * genuinely within range, and returns something near the analytic answer.
   * The two sets are combined with min() rather than a product: they are
   * estimates of the same visibility function at two scales, so multiplying
   * them counts the same occluder twice and turns every corner into a black
   * hole. min() lets the near set DARKEN what the broad set found and never
   * lighten it, which is the correct direction — the finer estimate is the more
   * trustworthy one at short range, and it says nothing at all in open space.
   *
   * The near set uses a decorrelated jitter (the golden-ratio offset) so its
   * eight taps do not land on the same eight angles as the broad set's and
   * leave a visible eight-spoke rosette that the bilateral cannot resolve.
   */
  float ao = scAmbientOcclusion( P, N, depth, jitter, uAO, float( SC_AO_TAPS ) );
  ao = min( ao, scAmbientOcclusion(
    P, N, depth, fract( jitter + 0.61803399 ), uAONear, SC_AO_NEAR_TAPS ) );

  // A surface already facing away from the sun is in its own shadow; marching
  // from it can only produce a shadow on top of a shadow, at full cost. The AO
  // above still runs for it, which is the whole reason it is computed first.
  float NdL = dot( N, L );
  if ( NdL <= 0.02 ) { gl_FragColor = vec4( 1.0, depth, ao, 1.0 ); return; }

  // Scale the march with depth. A fixed WORLD length would shrink to a fraction
  // of a pixel at range (all cost, no visible result); a fixed SCREEN length
  // would grow into a metres-long ray at range and start acting like a bad
  // ambient occlusion. Growing the world length sub-linearly with distance
  // keeps the screen-space footprint roughly constant. Clamped at 2.5x so a
  // pixel on the far archipelago cannot march 40 m and shadow another island.
  float len = uParams.x * clamp( depth * 0.08 + 0.75, 0.75, 2.5 );

  // Start the ray off the surface along the normal. The constant term (12 mm)
  // covers interpolated-normal error on the merged boxes; the depth-scaled term
  // (0.15% of distance) covers the growing size of a depth texel in world units
  // as the perspective divide stretches it. Without this every lit surface
  // shadows itself on step 0 and the frame comes back uniformly dark.
  vec3 origin = P + N * ( 0.012 + depth * 0.0015 );
  vec3 stepV = L * ( len / float( SC_CS_STEPS ) );

  float occ = 0.0;
  for ( int i = 0; i < SC_CS_STEPS; i ++ ) {
    vec3 sp = origin + stepV * ( float( i ) + jitter );
    vec4 clip = uProj * vec4( sp, 1.0 );
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    // Off screen: there is no depth information to test against, and clamping
    // to the edge texel would smear the border pixel's occlusion down the whole
    // side of the frame.
    if ( suv.x <= 0.0 || suv.x >= 1.0 || suv.y <= 0.0 || suv.y >= 1.0 ) break;

    float sceneDepth = texture2D( tDepth, suv ).r;
    if ( texture2D( tNormal, suv ).z < 0.5 ) continue;   // sky occludes nothing

    float diff = -sp.z - sceneDepth;
    // Same two-part bias as the ray origin, for the same two reasons.
    float bias = 0.004 + sceneDepth * 0.0025;
    // The upper bound is a THICKNESS test. The depth buffer stores one surface,
    // so without it every pixel behind the near facade of a building is
    // "occluded" by it and whole districts go black. 0.42 m says: treat the
    // thing we hit as a slab about that thick and let the ray pass behind it.
    if ( diff > bias && diff < uParams.y ) {
      // Fade with distance travelled, so the shadow dissolves along its length
      // instead of ending at a hard line at the ray's maximum reach. Quadratic
      // rather than linear because the eye reads the near end of a contact
      // shadow as the "real" one.
      float t = ( float( i ) + jitter ) / float( SC_CS_STEPS );
      occ = max( occ, 1.0 - t * t );
      break;
    }
  }

  // .g carries depth through to the blur so it can be edge-aware; .b is the AO.
  gl_FragColor = vec4( 1.0 - occ * uParams.w, depth, ao, 1.0 );
}
`

/**
 * Separable depth-aware blur.
 *
 * The jitter above traded banding for noise; this is where the noise is paid
 * off. Weights fall off with the DEPTH difference so the blur never averages a
 * foreground pixel with a background one — which would drag the contact shadow
 * off the ornament and out into the air beside it.
 */
const BILATERAL = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uDirection;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tSrc, vUv ).rgb;
  // Contact visibility and AO ride the same weights: they were estimated from
  // the same depth buffer at the same texel, so anything that makes a neighbour
  // a bad blur partner for one makes it a bad partner for the other.
  vec2 sum = c.rb * 0.5;
  float wsum = 0.5;
  for ( int i = 1; i <= 2; i ++ ) {
    vec2 o = uDirection * float( i );
    vec3 a = texture2D( tSrc, vUv + o ).rgb;
    vec3 b = texture2D( tSrc, vUv - o ).rgb;
    float w = 0.3 / float( i );
    // Depth tolerance is RELATIVE (divided by the centre depth): a 10 cm step
    // is a hard edge at 2 m and noise at 200 m, and a fixed tolerance either
    // over-blurs up close or refuses to blur at all in the distance.
    float wa = w * exp( -abs( a.g - c.g ) * 40.0 / max( 0.1, c.g ) );
    float wb = w * exp( -abs( b.g - c.g ) * 40.0 / max( 0.1, c.g ) );
    sum += a.rb * wa + b.rb * wb;
    wsum += wa + wb;
  }
  sum /= wsum;
  gl_FragColor = vec4( sum.x, c.g, sum.y, 1.0 );
}
`

export class ContactShadows {
  constructor() {
    this.pass = new Pass('sc-contact', CONTACT, {
      tDepth: { value: null },
      tNormal: { value: null },
      uProj: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
      uParams: {
        value: new THREE.Vector4(
          // length: 0.45 m at 1x, so 0.34..1.1 m of world travel across the
          // distance ramp. Sized to the actual contacts in this art direction —
          // a moss cap's overhang, an ornament's standoff from a wall — not to
          // "how far can we afford to march".
          0.45,
          // thickness: 0.42 m. See the thickness test in the shader.
          0.42,
          0, // frame counter, driven per frame
          // strength: 0.95. It used to be 0.85 on the argument that a contact
          // darker than the neighbouring shadow-mapped shadow reads as an
          // outline. That argument was made when non-key light ran at 43% of
          // key, which floored every shadow at a value the contact could
          // undercut. At the 20% budget the pipeline now enforces, the two
          // agree at 0.95 and the extra 10% is the difference between a moss
          // cap that sits on the stone and one that is printed on it.
          0.95
        ),
      },
      uAO: {
        value: new THREE.Vector4(
          // intensity 2.6, up from 1.55, because 1.55 did not do what its own
          // comment claimed. MEASURED off the debug view (pipeline.debugView =
          // 2) on the closeup shot: the sandstone/brass wall-floor junction came
          // back at 0.75-0.78 visibility, not the 0.5 a quarter-space analytically
          // subtends. A quarter of a stop of darkening at a right-angled
          // junction is invisible once it has been through a 15%-of-key ambient
          // term, an AgX shoulder and a grade — which is precisely the "stacked
          // masses read as decals" note the art director filed.
          //
          // Still the right knob to turn rather than another cut to the ambient
          // budget: AO darkens CREASES, which adds form, whereas cutting ambient
          // darkens whole faces, which at some point stops being contrast and
          // starts being an unreadable route.
          2.6,
          // radius 0.9 m, up from 0.7. Sized to the architecture, not to the
          // screen: the features this has to draw are the 0.3-0.6 m offsets of a
          // moss lip, a balustrade base and a stair nosing, and a radius equal to
          // the feature size only ever catches half of it. A 2 m radius would
          // turn the whole scene into soft dirt in the corners and stop
          // describing anything; 0.9 covers the feature and its shoulder.
          0.9,
          // max screen radius, 0.10 uv, up from 0.055.
          //
          // This clamp, not the radius above, was the binding constraint in the
          // near field: at 2 m the 0.7 m radius wanted 0.12 uv horizontally and
          // was cut to 0.055, i.e. an effective world radius of ~0.3 m — a third
          // of what the tuning above says it is, exactly where the player is
          // looking. 0.10 restores it without letting a pixel 30 cm from a wall
          // sample a quarter of the screen.
          0.10,
          // bias 0.16, up from 0.12: discard occluders within ~9 degrees of the
          // tangent plane rather than ~7. Raised in step with the intensity
          // above, and for the same measurement: half the frame was sitting in
          // the 0.80-0.90 band, which is not crease occlusion, it is a grey
          // wash over flat surfaces from depth quantisation. Intensity alone
          // would have deepened the wash along with the creases; this is what
          // keeps an open deck white so that a corner reads as a corner.
          0.16
        ),
      },
      uAONear: {
        value: new THREE.Vector4(
          // intensity 3.0. Higher than the broad set because it has to reach
          // the analytic answer for a quarter-space (0.5) from an estimator
          // that undercounts, and because it acts through min() — it only ever
          // shows up where it found something the broad set did not.
          3.2,
          // radius 0.24 m. Sized to the FILLET the architecture does not have:
          // the wall/floor junctions in this level are hard 90-degree corners
          // and this is the band either side of the crease that a real one
          // would occlude. Larger and it stops being a corner term and starts
          // duplicating the broad set at extra cost; smaller and it lands
          // inside a couple of depth texels at any distance and returns noise.
          0.24,
          // max screen radius 0.075 uv.
          //
          // MEASURED, after 0.045 left closeup.png's p1 at 30.8 against a
          // target of 25. At the 1.8 m the wall/floor junction in that shot
          // sits at, a 0.24 m radius wants 0.078 uv vertically, so a 0.045
          // clamp was cutting the effective world radius to 0.13 m — barely
          // half of the tuning above — in exactly the near field the set exists
          // for. This is the same mistake the broad set's clamp made before it
          // went 0.055 -> 0.10, and it is worth stating twice: the CLAMP, not
          // the radius, is what binds up close.
          0.075,
          // bias 0.12, below the broad set's 0.16. That bias was raised to stop
          // depth quantisation over a 0.9 m disc reading as a grey wash on flat
          // surfaces; over 0.22 m there is far less depth difference to
          // quantise, and the same 0.16 here would discard most of a real
          // corner along with the noise.
          0.12
        ),
      },
    })
    this.blur = new Pass('sc-contact-blur', BILATERAL, {
      tSrc: { value: null },
      uDirection: { value: new THREE.Vector2() },
    })
    this.rtA = null
    this.rtB = null
    this.texture = null
    this._texel = new THREE.Vector2(1 / 1920, 1 / 1080)
    this._frame = 0

    /**
     * Resolution of this pass relative to the beauty pass. 1 = full.
     *
     * Safe to change ONLY because the material samples the result by uv
     * (`gl_FragCoord.xy * scScreenTexel` in patch.js, which is the beauty
     * pass's texel and so lands in 0..1 whatever size this target is) and the
     * target filters linearly. The march itself is resolution-independent: it
     * steps in uv and reads the FULL-resolution depth/normal prepass, so a
     * half-scale buffer takes fewer samples of the same function rather than a
     * coarser function.
     *
     * `_sized` is the full-resolution size we were last handed, kept so the
     * scale can be changed without a window resize to trigger it.
     */
    this._scale = 1
    this._sized = [0, 0]

    // The uniform values above ARE the skyline's tuning and its regression
    // baseline; a theme sized at a different feature scale overrides them here.
    // Read once, at construction — the theme is fixed for the boot (see
    // selectTheme in theme.js) and main.js selects it before building the
    // pipeline that constructs this pass, so getTheme() is already the active
    // one. A theme that names no `ao` block renders byte-identical to before
    // this hook existed.
    this.applyThemeAO(getTheme().ao)
  }

  /**
   * Overlay a theme's AO settings onto the shipped defaults. Every field is
   * optional and falls through to the default (the skyline value) when absent,
   * so a theme states only what it wants to move — the same partial-overlay
   * shape `grade`, `exposure` and `aerial` use in theme.js.
   *
   *   intensity / radius / maxScreen / bias           -> the broad set (uAO)
   *   nearIntensity / nearRadius / nearMaxScreen / nearBias -> the near set (uAONear)
   *
   * `maxScreen` (the uv screen-radius clamp) matters as much as `radius`: at any
   * real viewing distance the clamp, not the world radius, is what binds — see
   * the two measured notes on the uAO/uAONear defaults below. A theme that
   * raises the world radius without raising this clamp only moves the distance
   * at which the AO gives up, not its reach up close.
   */
  applyThemeAO(ao) {
    if (!ao) return
    const broad = this.pass.uniforms.uAO.value
    const near = this.pass.uniforms.uAONear.value
    if (ao.intensity != null) broad.x = ao.intensity
    if (ao.radius != null) broad.y = ao.radius
    if (ao.maxScreen != null) broad.z = ao.maxScreen
    if (ao.bias != null) broad.w = ao.bias
    if (ao.nearIntensity != null) near.x = ao.nearIntensity
    if (ao.nearRadius != null) near.y = ao.nearRadius
    if (ao.nearMaxScreen != null) near.z = ao.nearMaxScreen
    if (ao.nearBias != null) near.w = ao.nearBias
  }

  /** @returns {number} resolution scale, 1 = full. */
  get scale() { return this._scale }
  set scale(s) {
    const v = Math.min(1, Math.max(0.25, s || 1))
    if (v === this._scale) return
    this._scale = v
    if (this._sized[0] > 0) this.setSize(this._sized[0], this._sized[1])
  }

  /**
   * Ray-march steps and AO tap counts. Recompiles only when something moved.
   *
   * `near` is clamped to `ao` because the near set runs through the same loop,
   * which is bounded by SC_AO_TAPS — see the define block at the top.
   */
  setTaps({ steps, ao, aoNear }) {
    const a = Math.max(1, Math.round(ao))
    const n = Math.min(a, Math.max(1, Math.round(aoNear)))
    this.pass.setDefine('SC_CS_STEPS', Math.max(1, Math.round(steps)))
    this.pass.setDefine('SC_AO_TAPS', a)
    // Must carry a decimal point: it is used as a float argument and a divisor.
    this.pass.setDefine('SC_AO_NEAR_TAPS', n.toFixed(1))
  }

  get length() { return this.pass.uniforms.uParams.value.x }
  set length(m) { this.pass.uniforms.uParams.value.x = m }

  get thickness() { return this.pass.uniforms.uParams.value.y }
  set thickness(m) { this.pass.uniforms.uParams.value.y = m }

  get strength() { return this.pass.uniforms.uParams.value.w }
  set strength(s) { this.pass.uniforms.uParams.value.w = s }

  /** AO intensity. 0 disables the AO taps entirely (the branch is uniform). */
  get aoIntensity() { return this.pass.uniforms.uAO.value.x }
  set aoIntensity(v) { this.pass.uniforms.uAO.value.x = v }

  /** AO world radius in metres. */
  get aoRadius() { return this.pass.uniforms.uAO.value.y }
  set aoRadius(v) { this.pass.uniforms.uAO.value.y = v }

  /** Short-radius (interior-corner) AO strength. 0 skips its taps entirely. */
  get aoNearIntensity() { return this.pass.uniforms.uAONear.value.x }
  set aoNearIntensity(v) { this.pass.uniforms.uAONear.value.x = v }

  /** Short-radius AO world radius, metres. Size it to a fillet, not a wall. */
  get aoNearRadius() { return this.pass.uniforms.uAONear.value.y }
  set aoNearRadius(v) { this.pass.uniforms.uAONear.value.y = v }

  /** @param {number} w @param {number} h FULL beauty-pass size; `scale` is applied here. */
  setSize(w, h) {
    this._sized[0] = w
    this._sized[1] = h
    const sw = Math.max(1, Math.round(w * this._scale))
    const sh = Math.max(1, Math.round(h * this._scale))
    if (this.rtA && this.rtA.width === sw && this.rtA.height === sh) return
    if (this.rtA) this.rtA.dispose()
    if (this.rtB) this.rtB.dispose()
    // RGBA16F: visibility, depth for the bilateral, AO. It was RG16F before the
    // AO moved into this pass; the third channel is worth the bandwidth because
    // the alternative is a second full-resolution pass that re-reads the same
    // two prepass textures to produce it.
    const o = { name: 'sc-contact' }
    this.rtA = renderTarget(sw, sh, THREE.HalfFloatType, o)
    this.rtB = renderTarget(sw, sh, THREE.HalfFloatType, o)
    // The blur's step is THIS target's texel, not the screen's — so at half
    // scale it stays a two-tap-either-side blur of its own buffer rather than
    // silently becoming a half-width one.
    this._texel.set(1 / sw, 1 / sh)
  }

  /** @param {THREE.Vector3} sunDirView unit direction TOWARD the sun, view space. */
  render(renderer, gbuffer, camera, sunDirView) {
    const u = this.pass.uniforms
    u.tDepth.value = gbuffer.depthTexture
    u.tNormal.value = gbuffer.normalTexture
    u.uProj.value.copy(camera.projectionMatrix)
    u.uProjInv.value.copy(camera.projectionMatrixInverse)
    u.uSunDirView.value.copy(sunDirView)
    // Wrapped at 64: the frame number only ever feeds the IGN offset, and an
    // unbounded float loses the fractional precision the noise depends on.
    this._frame = (this._frame + 1) % 64
    u.uParams.value.z = this._frame
    this.pass.render(renderer, this.rtA)

    const b = this.blur.uniforms
    b.tSrc.value = this.rtA.texture
    b.uDirection.value.set(this._texel.x, 0)
    this.blur.render(renderer, this.rtB)
    b.tSrc.value = this.rtB.texture
    b.uDirection.value.set(0, this._texel.y)
    this.blur.render(renderer, this.rtA)

    this.texture = this.rtA.texture
    return this.texture
  }

  dispose() {
    if (this.rtA) this.rtA.dispose()
    if (this.rtB) this.rtB.dispose()
    this.pass.dispose()
    this.blur.dispose()
  }
}
