import * as THREE from 'three'
import { COMMON, Pass, renderTarget } from './pass.js'

/**
 * Physical auto-exposure.
 *
 * One scalar drives the entire look downstream. It lives in a 1x1 float target
 * and is never read back to the CPU — a readPixels here would stall the driver
 * for a whole frame of latency and is the single most common way a WebGL post
 * chain ends up at 40fps for no visible reason.
 *
 * The metering chain is:
 *
 *   full-res HDR  --4 taps, clamp, log2, centre weight-->  64x64 (RG)
 *   64x64  --4x4 box-->  16x16  --4x4 box-->  4x4  --4x4 box-->  1x1
 *   1x1 + previous 1x1  --asymmetric adaptation-->  1x1 (exposure, EV)
 *
 * R accumulates weight * log2(luminance), G accumulates weight, so the final
 * divide is a true weighted log-average and every box reduce is exact (64 -> 1
 * in three 4x4 steps reads each source texel exactly once).
 *
 * The photometric conversion is the standard saturation-based one:
 *
 *     EV100 = log2( L * 100 / K ),   K = 12.5  (reflected-light meter constant)
 *     H     = 78 / (q * S) * 2^EV100,  q = 0.65, S = 100   =>  78/65 = 1.2
 *     exposure = 1 / H
 */

const METER = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
// Prepass normal buffer; .z is COVERAGE, 1 where opaque geometry was drawn and
// 0 where the frame is sky. Only consulted when uMeter.w says it is valid.
uniform sampler2D tCoverage;
uniform vec2 uTexel;
uniform vec4 uMeter;   // x tapClamp, y centreFalloff, z horizonBias, w skyWeight (<0 = no mask)
varying vec2 vUv;

// Every tap is clamped BEFORE the log. The sky shader authors a solar disc at
// radiance ~1.6 * sunColor with a pow(...,220) core, and a specular hit on
// brass can exceed that; one such texel inside a 4-tap box, logged, drags the
// weighted mean by whole stops and the level visibly gulps. Clamping in linear
// light first bounds any single tap's contribution to log2(uMeter.x).
float meterTap( vec2 uv ) {
  // Sanitised BEFORE the max(): max(NaN, 0.0) is compiled as a select on a
  // comparison that is false for NaN, so it happily returns NaN on most
  // drivers and the whole weighted average goes with it. See scSanitize.
  vec3 c = max( scSanitize( texture2D( tSrc, uv ).rgb ), vec3( 0.0 ) );
  return min( scLum( c ), uMeter.x );
}

void main() {
  // 4 taps on the diagonals of the source footprint. The 64x64 target is a
  // ~30x reduction, so this is a sparse sample of each cell on purpose: the
  // reduce chain below averages 4096 of these, and the extra taps would buy
  // precision we do not need for a value that is then smoothed over a second.
  float lum = meterTap( vUv + vec2( -1.0, -1.0 ) * uTexel );
  lum += meterTap( vUv + vec2(  1.0, -1.0 ) * uTexel );
  lum += meterTap( vUv + vec2( -1.0,  1.0 ) * uTexel );
  lum += meterTap( vUv + vec2(  1.0,  1.0 ) * uTexel );
  // Floor at 1e-5 so a fully black region contributes log2(1e-5) = -16.6 rather
  // than -inf, which would poison the whole average with a NaN.
  lum = max( lum * 0.25, 1e-5 );

  // Centre-weighted metering: a Gaussian in normalised device space. The player
  // is aiming at the middle of the frame and that is what has to be exposed
  // correctly.
  vec2 d = ( vUv - 0.5 ) * 2.0;
  float w = exp( -dot( d, d ) * uMeter.y );

  // ...and biased BELOW the horizon line. This is a first-person parkour game:
  // the camera pitch sits near level, so the top third of almost every frame is
  // sky and the bottom two thirds are the ledges the player is actually reading.
  // Letting a bright sky band into the average unweighted pulls the exposure
  // down until the route is a silhouette against it — the classic outdoor
  // metering failure. There is no depth buffer in this chain to identify sky
  // properly, and screen position is a perfectly good proxy for a camera that
  // is never far from level.
  w *= mix( 1.0, uMeter.z, smoothstep( 0.45, 0.95, vUv.y ) );

  // ...and biased off the SKY, properly, using the prepass coverage mask.
  //
  // The screen-position bias above is a proxy that works for a camera near
  // level and fails completely for the shot that matters most: from a high
  // vantage, two thirds of the frame is sky and haze BELOW the horizon line,
  // where the proxy gives it a full vote. Measured, the vista shot came back at
  // the lowest luminance spread and the lowest saturation of the eight — it was
  // being metered by its own sky, which is the textbook way to turn a
  // golden-hour wide shot into dishwater. A sky-filled frame should be a BRIGHT
  // frame; only the geometry in it needs to sit in the middle of the range.
  //
  // The mask is free: the contact-shadow prepass already wrote it this frame,
  // one texture read, no new pass. 4 taps rather than 1 because the meter
  // footprint is ~30 source texels wide and a single tap on a NEAREST-filtered
  // mask would alias the silhouettes into the exposure.
  if ( uMeter.w >= 0.0 ) {
    float cov = texture2D( tCoverage, vUv + vec2( -1.0, -1.0 ) * uTexel ).z
              + texture2D( tCoverage, vUv + vec2(  1.0, -1.0 ) * uTexel ).z
              + texture2D( tCoverage, vUv + vec2( -1.0,  1.0 ) * uTexel ).z
              + texture2D( tCoverage, vUv + vec2(  1.0,  1.0 ) * uTexel ).z;
    w *= mix( uMeter.w, 1.0, clamp( cov * 0.25, 0.0, 1.0 ) );
  }

  gl_FragColor = vec4( log2( lum ) * w, w, 0.0, 1.0 );
}
`

const REDUCE = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  // Exact 4x4 box: offsets -1.5..1.5 texels cover the 4x4 source block that
  // maps to this destination texel, with no overlap and no gap.
  vec2 s = vec2( 0.0 );
  for ( int y = 0; y < 4; y ++ ) {
    for ( int x = 0; x < 4; x ++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 1.5 ) * uTexel;
      s += texture2D( tSrc, vUv + o ).rg;
    }
  }
  gl_FragColor = vec4( s * ( 1.0 / 16.0 ), 0.0, 1.0 );
}
`

const ADAPT = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform sampler2D tPrev;
uniform vec4 uParams;   // x dt, y rateBrighten, z rateDarken, w compensation (stops)
uniform vec4 uLimits;   // x minEV, y maxEV, z reset, w unused
uniform vec2 uClamp;    // x minExposure, y maxExposure
varying vec2 vUv;

void main() {
  vec2 s = texture2D( tSrc, vec2( 0.5 ) ).rg;
  float avgLogLum = s.x / max( s.y, 1e-4 );
  float lum = max( exp2( avgLogLum ), 1e-5 );

  // EV100 from average scene luminance. K = 12.5 is the ISO reflected-light
  // calibration constant every light meter on earth is built around.
  float ev100 = log2( lum * 100.0 / 12.5 );

  // Hard EV window. This is the "a sky-filling frame must not crush the level
  // to silhouette" guard, and it is deliberately narrow: this level is one
  // sunny exterior lit by a fixed 2.5-intensity sun, so the honest range of
  // scene luminance is well under four stops. Anything outside the window is a
  // metering artefact (looking straight into the sun, or straight into a
  // shadowed alcove at arm's length), not a lighting change.
  ev100 = clamp( ev100, uLimits.x, uLimits.y );

  float prevEv = scSanitize( texture2D( tPrev, vec2( 0.5 ) ).ggg ).g;
  if ( uLimits.z > 0.5 ) prevEv = ev100;   // first frame: snap, do not fade in from black
  // The adaptation is a feedback loop through a render target, which means one
  // bad value is not one bad frame, it is every frame from here on. Both inputs
  // are checked so the loop can always recover on its own rather than needing a
  // resetExposure() from a caller who has no way of knowing it is stuck.
  if ( !( ev100 == ev100 ) ) ev100 = prevEv;
  if ( !( prevEv == prevEv ) ) prevEv = ev100;
  // Both poisoned: fall back to EV 0 rather than to a stuck loop. One wrong
  // frame that then adapts is recoverable; a latched NaN is not.
  if ( !( ev100 == ev100 ) ) { ev100 = 0.0; prevEv = 0.0; }

  // Asymmetric adaptation. A higher EV means less exposure, i.e. the image gets
  // DARKER. The eye (and every film stock) closes down fast and opens up slowly,
  // and it reads as wrong the other way round: a fast brighten looks like the
  // gain being yanked, a slow darken looks like being blinded.
  float rate = ev100 > prevEv ? uParams.z : uParams.y;
  // Exponential approach, frame-rate independent: k = 1 - e^(-dt/tau).
  float k = clamp( 1.0 - exp( -uParams.x * rate ), 0.0, 1.0 );
  float ev = mix( prevEv, ev100, k );

  // H = 78 / (q * S) * 2^EV100 with q = 0.65, S = 100 -> 78/65 = 1.2 exactly.
  float H = 1.2 * exp2( ev );
  // Compensation is in stops of BRIGHTNESS (+1 = one stop brighter), which is
  // the sign a human expects from an exposure dial, so it multiplies rather
  // than being added to EV100.
  float exposure = exp2( uParams.w ) / H;

  // Second, absolute belt-and-braces clamp. The EV window above bounds the
  // meter; this bounds the result, so no combination of compensation and a
  // pathological frame can hand the composite a 200x or a 0.001x multiplier.
  exposure = clamp( exposure, uClamp.x, uClamp.y );

  gl_FragColor = vec4( exposure, ev, 0.0, 1.0 );
}
`

export class AutoExposure {
  constructor(type, options = {}) {
    this.meterPass = new Pass('sc-meter', METER, {
      tSrc: { value: null },
      tCoverage: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uMeter: {
        value: new THREE.Vector4(
          // tapClamp: 8.0 linear. Diffuse sunlit porcelain in this level lands
          // around 1.5-2.5; 8 is comfortably above any real surface and well
          // below the sun disc, so it only ever bites on genuine specular
          // events and the sky's solar core.
          8.0,
          // centreFalloff: weight = exp(-r^2 * 1.1) over ndc, so the corners get
          // ~13% of the centre's vote. Tight enough to be centre-weighted,
          // loose enough that a wall filling the left half still counts.
          1.1,
          // horizonBias: the top of the frame votes at 30%. Not zero — the sky
          // IS the key light here and ignoring it entirely makes the exposure
          // jump every time the player looks down at a ledge.
          0.30,
          // skyWeight: a sky texel votes at 15% of a geometry texel. Negative
          // disables the mask entirely, which is what happens when there is no
          // prepass to read (no float render targets); the screen-position bias
          // above is then the only sky rejection, exactly as before.
          //
          // Not zero: with the mask at zero, a frame that is entirely sky has no
          // votes at all and the weighted average divides by its epsilon. 0.15
          // also keeps a genuinely brighter sky nudging the meter, which is
          // right — walking out of an arch into open sky should stop down a
          // little.
          0.15
        ),
      },
    })

    this.reducePass = new Pass('sc-meter-reduce', REDUCE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
    })

    this.adaptPass = new Pass('sc-adapt', ADAPT, {
      tSrc: { value: null },
      tPrev: { value: null },
      uParams: {
        value: new THREE.Vector4(
          1 / 60, // dt, overwritten every frame
          // Brighten: tau ~1.2s -> rate 1/1.2 = 0.83.
          1 / 1.2,
          // Darken: tau ~0.4s -> rate 1/0.4 = 2.5. Three times faster than
          // brightening, matching how pupils actually behave.
          1 / 0.4,
          // exposureCompensation, in stops of brightness. Default +0.75:
          // the ISO speed constant puts the metered average at 12.5/(1.2*100)
          // = 0.104 linear, but AgX is built to place 18% (0.18) grey at mid
          // display. 0.18/0.104 is +0.79 stops, so +0.75 lands the average
          // scene value on mid-grey instead of three-quarters of a stop under
          // it. This is the single knob to turn if the game reads dim.
          0.75
        ),
      },
      uLimits: {
        value: new THREE.Vector4(
          // minEV/maxEV: L in [0.06, 4.0] -> EV100 in [-1.06, 5.0]. Rounded out
          // by a stop each way for headroom against a stray frame.
          //
          // PER THEME. The window above is deliberately narrow because the
          // skyline level is one outdoor daylight condition — but a near-black
          // void meters far below EV -2, pins against this floor and stops
          // adapting, so the frame reads exactly as dark as the clamp allows
          // and no darker. See src/theme.js, `exposure.minEV`.
          options.minEV ?? -2.0,
          options.maxEV ?? 6.0,
          1, // reset flag, cleared after the first update
          0
        ),
      },
      uClamp: {
        value: new THREE.Vector2(
          // Absolute exposure window. At EV100 = 6 the formula gives
          // 2^0.75/(1.2*64) = 0.022 and at EV100 = -2 it gives 5.6; these
          // clamps sit just outside that so they only catch pathologies.
          options.clampLo ?? 0.02,
          options.clampHi ?? 6.0
        ),
      },
    })

    // 64x64 is the largest reduction that still divides cleanly by 4 three
    // times (64 -> 16 -> 4 -> 1) and is small enough that the whole metering
    // chain is a rounding error on the frame budget.
    const o = { type, name: 'sc-exposure' }
    this.rt64 = renderTarget(64, 64, type, o)
    this.rt16 = renderTarget(16, 16, type, o)
    this.rt4 = renderTarget(4, 4, type, o)
    this.rt1 = renderTarget(1, 1, type, o)
    // Ping-pong: the adaptation reads last frame's result while writing this
    // frame's, and a target cannot be bound for read and write simultaneously.
    this.adapt = [renderTarget(1, 1, type, o), renderTarget(1, 1, type, o)]
    this._flip = 0
    this._reset = true
  }

  /** Current exposure, as a 1x1 texture. R = exposure multiplier, G = EV. */
  get texture() {
    return this.adapt[this._flip].texture
  }

  /** Force the next frame to snap rather than fade (teleport, respawn). */
  reset() {
    this._reset = true
  }

  get exposureCompensation() {
    return this.adaptPass.uniforms.uParams.value.w
  }

  set exposureCompensation(stops) {
    this.adaptPass.uniforms.uParams.value.w = stops
  }

  /**
   * Point the meter at this frame's prepass coverage mask, or null to fall back
   * to screen-position sky rejection alone.
   *
   * @param {THREE.Texture|null} tex prepass normal buffer (.z = coverage)
   * @param {number} skyWeight relative vote of a sky texel, 0..1
   */
  setCoverage(tex, skyWeight = 0.15) {
    this.meterPass.uniforms.tCoverage.value = tex
    this.meterPass.uniforms.uMeter.value.w = tex ? skyWeight : -1
  }

  update(renderer, sourceTexture, sw, sh, dt) {
    const mu = this.meterPass.uniforms
    mu.tSrc.value = sourceTexture
    mu.uTexel.value.set(1 / sw, 1 / sh)
    this.meterPass.render(renderer, this.rt64)

    const ru = this.reducePass.uniforms
    ru.tSrc.value = this.rt64.texture
    ru.uTexel.value.set(1 / 64, 1 / 64)
    this.reducePass.render(renderer, this.rt16)
    ru.tSrc.value = this.rt16.texture
    ru.uTexel.value.set(1 / 16, 1 / 16)
    this.reducePass.render(renderer, this.rt4)
    ru.tSrc.value = this.rt4.texture
    ru.uTexel.value.set(1 / 4, 1 / 4)
    this.reducePass.render(renderer, this.rt1)

    const au = this.adaptPass.uniforms
    au.tSrc.value = this.rt1.texture
    au.tPrev.value = this.adapt[this._flip].texture
    // Cap dt at 100ms so a tab-switch or a GC hitch does not resolve the whole
    // adaptation in one step, which reads as a flash.
    au.uParams.value.x = Math.min(dt, 0.1)
    au.uLimits.value.z = this._reset ? 1 : 0
    this._reset = false

    const dst = this.adapt[this._flip ^ 1]
    this.adaptPass.render(renderer, dst)
    this._flip ^= 1
    return dst.texture
  }

  dispose() {
    this.rt64.dispose()
    this.rt16.dispose()
    this.rt4.dispose()
    this.rt1.dispose()
    this.adapt[0].dispose()
    this.adapt[1].dispose()
    this.meterPass.dispose()
    this.reducePass.dispose()
    this.adaptPass.dispose()
  }
}
