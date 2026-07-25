import * as THREE from 'three'
import { COMMON, Pass, renderTarget } from './pass.js'

/**
 * Progressive dual-filter bloom pyramid (Jimenez, "Next Generation Post
 * Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014) with Karis
 * firefly suppression. Not UnrealBloomPass, and deliberately not a Gaussian
 * chain.
 *
 * The three decisions that make or break it:
 *
 *  1. The prefilter runs on level 0 ONLY, and AFTER the exposure multiply, so
 *     the threshold is a statement about display brightness ("above white")
 *     rather than about raw scene radiance. A fixed linear threshold on
 *     unscaled radiance means something different every time the meter moves.
 *
 *  2. The threshold is driven by MAX CHANNEL, not luminance. Aged brass at
 *     (1.4, 0.95, 0.35) has a luminance of 0.98 — under a luminance threshold
 *     of 1.0 it would not bloom at all, while a white surface of the same
 *     visual punch would. Max-channel means a saturated colour blooms when it
 *     clips, which is what actually happens in a lens.
 *
 *  3. The upsample is BLENDED 50/50 back up the chain, not summed. Summing six
 *     mips multiplies total energy by six and the result is a milky veil you
 *     have to turn down until the actual glow is invisible. A 50/50 lerp at
 *     each step is energy preserving, so the final additive strength means
 *     what it says.
 *
 * This is a sunny toybox game. The target is a soft halo on the lanterns and
 * on sun-facing brass, not atmosphere.
 */

const DOWNSAMPLE = /* glsl */ `
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform sampler2D tExposure;
uniform vec2 uTexel;      // texel size of the SOURCE
uniform vec4 uParams;     // x prefilter(0/1), y threshold, z knee, w fireflyClamp

varying vec2 vUv;

// Sanitised: this is the prefilter, the first thing that reads the scene
// buffer, and a NaN that gets into the pyramid here is smeared over a sixth of
// the frame by the time it comes back out of the upsample. See scSanitize.
vec3 fetch( vec2 uv ) { return max( scSanitize( texture2D( tSrc, uv ).rgb ), vec3( 0.0 ) ); }

// Karis weight: average in 1/(1+L) space so a single 100x pixel contributes
// like a 1x one. Without it, one specular sparkle on a brass rail pumps an
// entire 1/4-res texel and you get a fat blob that pops in and out as the
// camera moves.
float karisWeight( vec3 c ) { return 1.0 / ( 1.0 + scLum( c ) ); }

// Soft-knee highlight isolation. Below (threshold - knee) nothing passes;
// across the 2*knee-wide band the response is quadratic, so there is no visible
// contour where the effect switches on; above it, a straight (L - threshold).
vec3 prefilter( vec3 c, float thr, float knee ) {
  float l = max( max( c.r, c.g ), c.b );
  float soft = clamp( l - thr + knee, 0.0, 2.0 * knee );
  soft = soft * soft / ( 4.0 * knee + 1e-5 );
  return c * ( max( soft, l - thr ) / max( l, 1e-4 ) );
}

void main() {
  // 13-tap "dual filter" kernel: a 3x3 grid at 2-texel spacing plus a 2x2
  // inner box at 1-texel spacing. Combined they form five overlapping 2x2
  // boxes whose weighted sum is a near-perfect 1/2 downsample with none of the
  // aliasing a naive bilinear tap produces on a moving camera.
  vec2 t = uTexel;
  vec3 a = fetch( vUv + vec2( -2.0 * t.x,  2.0 * t.y ) );
  vec3 b = fetch( vUv + vec2(  0.0,        2.0 * t.y ) );
  vec3 c = fetch( vUv + vec2(  2.0 * t.x,  2.0 * t.y ) );
  vec3 d = fetch( vUv + vec2( -2.0 * t.x,  0.0 ) );
  vec3 e = fetch( vUv );
  vec3 f = fetch( vUv + vec2(  2.0 * t.x,  0.0 ) );
  vec3 g = fetch( vUv + vec2( -2.0 * t.x, -2.0 * t.y ) );
  vec3 h = fetch( vUv + vec2(  0.0,       -2.0 * t.y ) );
  vec3 i = fetch( vUv + vec2(  2.0 * t.x, -2.0 * t.y ) );
  vec3 j = fetch( vUv + vec2( -t.x,  t.y ) );
  vec3 k = fetch( vUv + vec2(  t.x,  t.y ) );
  vec3 l = fetch( vUv + vec2( -t.x, -t.y ) );
  vec3 m = fetch( vUv + vec2(  t.x, -t.y ) );

  vec3 result;

  if ( uParams.x > 0.5 ) {
    float ex = texture2D( tExposure, vec2( 0.5 ) ).r;
    a *= ex; b *= ex; c *= ex; d *= ex; e *= ex; f *= ex; g *= ex;
    h *= ex; i *= ex; j *= ex; k *= ex; l *= ex; m *= ex;

    float thr = uParams.y;
    float knee = max( uParams.z, 1e-4 );
    a = prefilter( a, thr, knee ); b = prefilter( b, thr, knee );
    c = prefilter( c, thr, knee ); d = prefilter( d, thr, knee );
    e = prefilter( e, thr, knee ); f = prefilter( f, thr, knee );
    g = prefilter( g, thr, knee ); h = prefilter( h, thr, knee );
    i = prefilter( i, thr, knee ); j = prefilter( j, thr, knee );
    k = prefilter( k, thr, knee ); l = prefilter( l, thr, knee );
    m = prefilter( m, thr, knee );

    // Five 2x2 boxes: four on the corners (1/8 weight each) and one in the
    // centre (1/2 weight). Karis-weight each BOX rather than each tap, which
    // preserves the kernel's shape while still killing fireflies.
    vec3 g0 = ( a + b + d + e ) * 0.25;
    vec3 g1 = ( b + c + e + f ) * 0.25;
    vec3 g2 = ( d + e + g + h ) * 0.25;
    vec3 g3 = ( e + f + h + i ) * 0.25;
    vec3 g4 = ( j + k + l + m ) * 0.25;
    float w0 = karisWeight( g0 ) * 0.125;
    float w1 = karisWeight( g1 ) * 0.125;
    float w2 = karisWeight( g2 ) * 0.125;
    float w3 = karisWeight( g3 ) * 0.125;
    float w4 = karisWeight( g4 ) * 0.5;
    result = ( g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4 ) /
             max( w0 + w1 + w2 + w3 + w4, 1e-5 );
    // Final ceiling on what may enter the pyramid at all. The sky's solar core
    // is authored well above this; letting it in at full value gives the sun a
    // hard-edged disc of bloom that clips flat instead of a soft falloff.
    result = min( result, vec3( uParams.w ) );
  } else {
    // Levels 1..n are a plain weighted downsample — the isolation already
    // happened, and re-thresholding a blurred mip erodes the halo's tail.
    result = e * 0.125;
    result += ( a + c + g + i ) * 0.03125;
    result += ( b + d + f + h ) * 0.0625;
    result += ( j + k + l + m ) * 0.125;
  }

  gl_FragColor = vec4( result, 1.0 );
}
`

const UPSAMPLE = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;    // texel size of the SOURCE (the smaller mip)
uniform float uRadius;
uniform float uWeight;
varying vec2 vUv;

void main() {
  // 9-tap tent (1 2 1 / 2 4 2 / 1 2 1) / 16. A tent on the way up is the exact
  // partner of the box on the way down: together they approximate a wide
  // Gaussian at a fraction of the taps, and the reconstruction has no visible
  // mip structure.
  vec2 t = uTexel * uRadius;
  vec3 a = texture2D( tSrc, vUv + vec2( -t.x,  t.y ) ).rgb;
  vec3 b = texture2D( tSrc, vUv + vec2(  0.0,  t.y ) ).rgb;
  vec3 c = texture2D( tSrc, vUv + vec2(  t.x,  t.y ) ).rgb;
  vec3 d = texture2D( tSrc, vUv + vec2( -t.x,  0.0 ) ).rgb;
  vec3 e = texture2D( tSrc, vUv ).rgb;
  vec3 f = texture2D( tSrc, vUv + vec2(  t.x,  0.0 ) ).rgb;
  vec3 g = texture2D( tSrc, vUv + vec2( -t.x, -t.y ) ).rgb;
  vec3 h = texture2D( tSrc, vUv + vec2(  0.0, -t.y ) ).rgb;
  vec3 i = texture2D( tSrc, vUv + vec2(  t.x, -t.y ) ).rgb;
  vec3 sum = e * 4.0 + ( b + d + f + h ) * 2.0 + ( a + c + g + i );

  // Alpha = uWeight with normal blending gives dst = mix(dst, src, uWeight).
  // At 0.5 that is the energy-preserving accumulation this whole design rests
  // on: each level contributes half, so the total never exceeds the brightest
  // input rather than growing with the level count.
  gl_FragColor = vec4( sum * 0.0625, uWeight );
}
`

export class Bloom {
  constructor(type, levels = 6) {
    this.levels = levels
    this.type = type

    this.down = new Pass('sc-bloom-down', DOWNSAMPLE, {
      tSrc: { value: null },
      tExposure: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uParams: { value: new THREE.Vector4(0, 1.0, 0.6, 24) },
    })

    this.up = new Pass('sc-bloom-up', UPSAMPLE, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 },
      uWeight: { value: 0.5 },
    }, { blending: THREE.NormalBlending, transparent: true })

    /**
     * Threshold in exposure-scaled linear light, max-channel.
     *
     * 1.05 rather than 1.0: with the meter parked on mid-grey, sunlit cream
     * porcelain lands just under 1.0 and the lantern emissives and brass
     * speculars land above it. A threshold at exactly 1.0 puts the whole
     * sunlit half of the level a hair inside the knee and the frame hazes over.
     */
    this.threshold = 1.05

    /**
     * Knee half-width. 0.5 is wide — a full stop of soft ramp — because the
     * cheerful flat-shaded surfaces here have large areas at nearly identical
     * brightness, and a tight knee draws a visible contour line across them.
     */
    this.knee = 0.5

    /** Ceiling on any single pyramid input. See the shader comment. */
    this.fireflyClamp = 24

    this.mips = []
    this.texture = null
  }

  setSize(w, h) {
    for (const m of this.mips) m.rt.dispose()
    this.mips.length = 0
    let mw = w
    let mh = h
    for (let i = 0; i < this.levels; i++) {
      mw = Math.max(1, Math.floor(mw / 2))
      mh = Math.max(1, Math.floor(mh / 2))
      this.mips.push({ rt: renderTarget(mw, mh, this.type, { name: `sc-bloom${i}` }), w: mw, h: mh })
      // Stop early on a small window rather than grinding down to 1x1 mips,
      // where the tent kernel is sampling the clamp edge more than the image.
      if (mw <= 2 || mh <= 2) break
    }
  }

  render(renderer, sourceTexture, sourceW, sourceH, exposureTexture) {
    const n = this.mips.length
    if (n === 0) return null

    const du = this.down.uniforms
    du.tExposure.value = exposureTexture
    for (let i = 0; i < n; i++) {
      const src = i === 0 ? sourceTexture : this.mips[i - 1].rt.texture
      const sw = i === 0 ? sourceW : this.mips[i - 1].w
      const sh = i === 0 ? sourceH : this.mips[i - 1].h
      du.tSrc.value = src
      du.uTexel.value.set(1 / sw, 1 / sh)
      du.uParams.value.set(i === 0 ? 1 : 0, this.threshold, this.knee, this.fireflyClamp)
      this.down.render(renderer, this.mips[i].rt)
    }

    const uu = this.up.uniforms
    for (let i = n - 1; i > 0; i--) {
      uu.tSrc.value = this.mips[i].rt.texture
      uu.uTexel.value.set(1 / this.mips[i].w, 1 / this.mips[i].h)
      // The two coarsest levels are 1/32 and 1/64 resolution: a radius-1 tent
      // there reaches 30+ screen pixels, which is exactly the halo that eats a
      // rooftop silhouette against a bright sky. Tighten the spread and drop
      // the blend weight on those two only — the low-frequency component of
      // the glow survives, its reach does not. Readability of the route beats
      // the last 10% of glow width every time.
      const wide = i >= n - 2
      uu.uRadius.value = wide ? 0.65 : 1.0
      uu.uWeight.value = wide ? 0.35 : 0.5
      this.up.render(renderer, this.mips[i - 1].rt)
    }

    this.texture = this.mips[0].rt.texture
    return this.texture
  }

  dispose() {
    for (const m of this.mips) m.rt.dispose()
    this.mips.length = 0
    this.down.dispose()
    this.up.dispose()
  }
}
