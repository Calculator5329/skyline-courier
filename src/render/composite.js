import * as THREE from 'three'
import { COMMON, Pass } from './pass.js'
import { GBUFFER_GLSL } from './gbuffer.js'

/**
 * The final composite. One fragment shader, one read of the framebuffer, one
 * write — bandwidth on an integrated GPU is the actual budget here, and doing
 * grain, sharpen and grade as separate passes costs five full-screen
 * read/writes for effects that are each two instructions.
 *
 * ORDER IS THE ENTIRE POINT. Two domains, and nothing crosses the boundary in
 * the wrong direction:
 *
 *   LINEAR LIGHT (scene-referred, unbounded)
 *     exposure -> chromatic aberration -> + bloom -> cos^4 vignette
 *   --------- AgX tone map + sRGB encode = the display transform ---------
 *   DISPLAY-REFERRED (code values, 0..1)
 *     LUT grade -> film grain -> contrast-adaptive sharpen -> dither -> out
 *
 * Two of those placements are the ones people get wrong:
 *
 *  - The VIGNETTE is in linear light. It models transmission loss through a
 *    lens, which is a physical multiply on radiance. Applied after the tone
 *    curve it becomes a flat multiply on the code value, which puts a hard
 *    ceiling under display white everywhere but dead centre and makes the
 *    whole frame milky. In linear light the same amount costs a fraction of a
 *    stop that the filmic shoulder absorbs in the highlights while still
 *    weighting the mids and shadows toward the corners.
 *
 *  - The LUT is in display space, because that is where it was authored: its
 *    toe and tints are additive CODE VALUE offsets. The brief lists "sRGB
 *    encode" last; it cannot be, because the encode IS the doorway into the
 *    space the grade, grain and sharpen all live in. The DITHER is genuinely
 *    last, immediately before the 8-bit write, which is the only place it can
 *    do its job.
 */

/**
 * AgX.
 *
 * The desaturating inset/outset transform. Everything in this game's palette
 * is saturated — terracotta, moss, brass — and a naive tone curve (or ACES,
 * which has its own notorious hue skew) drives those straight to a clipped
 * neon edge as soon as they are lit. AgX pushes chroma toward the centre of
 * the gamut BEFORE the sigmoid and pulls it back out after, so a bright
 * terracotta desaturates toward cream on its way up instead of clipping to
 * orange. That behaviour is the reason it is here.
 */
const AGX = /* glsl */ `
#ifndef SC_AGX
#define SC_AGX

// sRGB <-> Rec.2020. AgX works in a wide gamut so the inset has somewhere to
// push chroma to.
const mat3 SC_REC2020_FROM_SRGB = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 ) );
const mat3 SC_SRGB_FROM_REC2020 = mat3(
  vec3(  1.6605, -0.1246, -0.0182 ),
  vec3( -0.5876,  1.1329, -0.1006 ),
  vec3( -0.0728, -0.0083,  1.1187 ) );

// Troy Sobotka's 6th-order polynomial fit to the AgX display sigmoid, on the
// log-normalised [0,1] range.
vec3 scAgxSigmoid( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
       + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 scAgX( vec3 color, float slope, float power, float sat ) {
  // The inset compresses chroma toward the achromatic axis; the outset is its
  // (deliberately imperfect) inverse. The asymmetry is the "desaturation on
  // the way up" everyone means when they say AgX.
  const mat3 inset = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
  const mat3 outset = mat3(
    vec3(  1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
    vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ),
    vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );
  // The canonical AgX log range: 16.5 stops from -12.47 to +4.03 EV about
  // mid-grey. These are not tunable — the polynomial above is fitted to them.
  const float minEv = -12.47393;
  const float maxEv = 4.026069;

  color = SC_REC2020_FROM_SRGB * color;
  color = inset * color;
  color = max( color, 1e-10 );          // log2 of zero is not a colour
  color = ( log2( color ) - minEv ) / ( maxEv - minEv );
  color = clamp( color, 0.0, 1.0 );

  // Optional "look" in log space. Kept at identity here: the log range spans
  // 16.5 stops, so a power of 1.2 costs the shadows most of a stop. Contrast
  // belongs in the LUT, which works about a pivot rather than about zero.
  color = pow( max( color * slope, 0.0 ), vec3( power ) );
  float l = scLum( color );
  color = l + sat * ( color - l );

  color = scAgxSigmoid( clamp( color, 0.0, 1.0 ) );
  color = outset * color;
  // The sigmoid's output is display-referred with a 2.2 gamma baked in; undo
  // it so we hand back LINEAR light and this file owns exactly one encode.
  color = pow( max( color, vec3( 0.0 ) ), vec3( 2.2 ) );
  color = SC_SRGB_FROM_REC2020 * color;
  return max( color, vec3( 0.0 ) );
}

#endif
`

const COMPOSITE = /* glsl */ `
precision highp float;
precision highp sampler3D;
${COMMON}
${AGX}
${GBUFFER_GLSL}

uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tExposure;
uniform sampler3D tLut;
// The contact/AO buffer and the prepass normal buffer, bound ONLY for the debug
// views below. They cost one sampler binding and nothing else when uDebug.x = 0.
uniform sampler2D tDebugContact;
uniform sampler2D tDebugNormal;

uniform vec2 uTexel;
uniform vec4 uLens;    // x chromatic, y vignette, z grain, w time
uniform vec4 uGrade;   // x bloomStrength, y lutStrength, z sharpen, w lutSize
uniform vec4 uLook;    // x agxSlope, y agxPower, z agxSat, w exposureScale
// x: debug view id (0 = off), y: scale for the depth view, z/w spare.
uniform vec4 uDebug;

varying vec2 vUv;

// Sample the 33^3 LUT with the texel-centre correction. Without the
// (n-1)/n + 0.5/n remap, input 0 and input 1 sample HALF a texel outside the
// lattice and clamp, which flattens the very ends of the curve — exactly where
// the toe and shoulder live.
vec3 sampleLut( vec3 c ) {
  float n = uGrade.w;
  vec3 uvw = clamp( c, 0.0, 1.0 ) * ( ( n - 1.0 ) / n ) + ( 0.5 / n );
  return texture( tLut, uvw ).rgb;
}

/**
 * Debug views.
 *
 * This exists because "are the contact shadows on?" was answered for months by
 * reading a boolean somebody set rather than by looking at the buffer, and the
 * boolean was true while the buffer was white. A view that puts the actual
 * texels on screen is the only honest answer, and it makes the failure
 * screenshot-testable: the harness can capture mode 1 and assert that the frame
 * is NOT uniformly white.
 *
 * Written straight to the framebuffer with no tone map and no grade — the whole
 * point is to see the raw signal, and a debug view that has been through AgX is
 * a debug view of AgX.
 */
bool scDebugView( int mode, out vec3 outColor ) {
  if ( mode == 1 ) {            // contact-shadow visibility: 1 = lit, 0 = occluded
    outColor = vec3( texture2D( tDebugContact, vUv ).r );
  } else if ( mode == 2 ) {     // ambient occlusion
    outColor = vec3( texture2D( tDebugContact, vUv ).b );
  } else if ( mode == 3 ) {     // linear view depth, metres / uDebug.y
    outColor = vec3( texture2D( tDebugContact, vUv ).g / max( uDebug.y, 1e-3 ) );
  } else if ( mode == 4 ) {     // prepass normals, remapped to 0..1
    vec4 n = texture2D( tDebugNormal, vUv );
    outColor = n.z < 0.5 ? vec3( 0.0 ) : scDecodeNormal( n.xy ) * 0.5 + 0.5;
  } else {
    return false;
  }
  return true;
}

void main() {
  // Uniform branch: every fragment takes the same side, so on any GPU built
  // this decade the untaken side costs nothing.
  int dbg = int( uDebug.x + 0.5 );
  if ( dbg > 0 ) {
    vec3 dcol;
    if ( scDebugView( dbg, dcol ) ) {
      gl_FragColor = vec4( clamp( dcol, 0.0, 1.0 ), 1.0 );
      return;
    }
  }

  float exposure = texture2D( tExposure, vec2( 0.5 ) ).r * uLook.w;

  vec2 d = vUv - 0.5;
  float r2 = dot( d, d );

  // ==================== LINEAR LIGHT ====================================

  // --- chromatic aberration ----------------------------------------------
  // Three radial taps with an offset that grows as r^2, like real lateral
  // chromatic aberration in a wide-angle lens (this camera is at 76 degrees,
  // where a real lens would show it). The centre of the frame — where the
  // player reads the route — is untouched by construction.
  vec3 hdr;
  float ca = uLens.x * r2;
  if ( ca > 0.000002 ) {
    vec2 o = d * ca;
    hdr.r = texture2D( tColor, vUv + o ).r;
    hdr.g = texture2D( tColor, vUv ).g;
    hdr.b = texture2D( tColor, vUv - o ).b;
  } else {
    hdr = texture2D( tColor, vUv ).rgb;
  }
  hdr = max( hdr, vec3( 0.0 ) );

  // Un-aberrated centre + 4 neighbours, kept for the sharpen below. Taken
  // BEFORE the CA offset on purpose: sharpening the aberrated fetch against
  // unshifted neighbours makes the difference contain the CA offset itself and
  // the sharpen then amplifies it into coarse magenta/green fringes.
  vec3 centre = max( texture2D( tColor, vUv ).rgb, vec3( 0.0 ) );
  float lN1 = scLum( max( texture2D( tColor, vUv + vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) ) );
  float lN2 = scLum( max( texture2D( tColor, vUv - vec2( uTexel.x, 0.0 ) ).rgb, vec3( 0.0 ) ) );
  float lN3 = scLum( max( texture2D( tColor, vUv + vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) ) );
  float lN4 = scLum( max( texture2D( tColor, vUv - vec2( 0.0, uTexel.y ) ).rgb, vec3( 0.0 ) ) );

  hdr *= exposure;

  // --- bloom, ADDED ------------------------------------------------------
  // Added, not mixed. mix() with a pyramid is veiling glare: it replaces N% of
  // every pixel with a blurred copy of the frame, which is a haze you can
  // never turn up far enough to actually see a lantern glow. The pyramid was
  // thresholded and is energy-preserving, so adding it puts light around the
  // things that are above white and leaves everything else exactly where the
  // shading put it.
  vec3 bloom = max( texture2D( tBloom, vUv ).rgb, vec3( 0.0 ) );
  hdr += bloom * max( uGrade.x, 0.0 );

  // --- cos^4 lens shading (vignette) -------------------------------------
  // The natural falloff of an off-axis ray is cos^4(theta). With r2 in uv
  // units and a 2.2 coefficient, 1/(1+2.2*r2)^2 is that curve for roughly this
  // field of view: about a fifth of a stop lost in the corners at full
  // strength. Gentle by design — this is a sunny game and a heavy vignette is
  // the fastest way to make it look like a different, grimmer one.
  float cos4 = pow( 1.0 / ( 1.0 + r2 * 2.2 ), 2.0 );
  hdr *= mix( 1.0, cos4, uLens.y );

  // ==================== DISPLAY TRANSFORM ================================

  vec3 linear = scAgX( hdr, uLook.x, uLook.y, uLook.z );
  vec3 disp = scLinearToSrgb( clamp( linear, 0.0, 1.0 ) );

  // ==================== DISPLAY-REFERRED =================================

  // --- 33^3 grade LUT ----------------------------------------------------
  disp = mix( disp, sampleLut( disp ), uGrade.y );

  // --- film grain --------------------------------------------------------
  // Two decorrelated hashes at different scales so it does not read as a fixed
  // pixel pattern. Response rises with brightness: real sensor noise is
  // loudest through the mids once it has been through a display transform, and
  // grain in the darks is the thing the eye reads as "dirty image". This is
  // deliberately the opposite of the naive "more grain where it is dark".
  if ( uLens.z > 0.0002 ) {
    float g1 = scHash12( gl_FragCoord.xy + uLens.w * 137.13 ) - 0.5;
    float g2 = scHash12( gl_FragCoord.xy * 1.7 - uLens.w * 71.3 ) - 0.5;
    float noise = g1 * 0.65 + g2 * 0.35;
    float l = scLum( disp );
    float response = uLens.z * ( 0.35 + 0.65 * smoothstep( 0.0, 0.30, l ) );
    disp += noise * response;
  }

  // --- contrast-adaptive sharpen -----------------------------------------
  // AMD CAS in spirit: a scalar gain around the centre luminance, reduced
  // where local contrast is already high so it does not ring on hard edges.
  //
  // The tone curve is monotonic, so local contrast can be measured on a cheap
  // perceptual proxy of the exposed linear luminance rather than by pushing
  // four extra taps through the whole chain: sqrt() is a gamma-2.0
  // approximation to the sRGB OETF, one instruction, and more than accurate
  // enough for a term that only ever scales the result by a few percent.
  //
  // LUMINANCE ONLY, applied as a scalar multiply — a scalar gain cannot invent
  // chroma, so this can never produce a coloured fringe.
  if ( uGrade.z > 0.001 ) {
    float lc = sqrt( max( scLum( centre ) * exposure, 0.0 ) );
    float p1 = sqrt( max( lN1 * exposure, 0.0 ) );
    float p2 = sqrt( max( lN2 * exposure, 0.0 ) );
    float p3 = sqrt( max( lN3 * exposure, 0.0 ) );
    float p4 = sqrt( max( lN4 * exposure, 0.0 ) );
    float lmn = min( min( p1, p2 ), min( p3, p4 ) );
    float lmx = max( max( p1, p2 ), max( p3, p4 ) );
    float blur = ( p1 + p2 + p3 + p4 ) * 0.25;
    // Michelson contrast with a small epsilon so a flat black area does not
    // divide by zero and claim infinite contrast.
    float contrast = ( lmx - lmn ) / ( lmx + lmn + 0.02 );
    // 1.6: local contrast of ~0.63 and above gets no sharpening at all, which
    // is roughly where a silhouette edge sits. Flat clay surfaces, which is
    // most of this level, get the full amount.
    float amount = uGrade.z * ( 1.0 - clamp( contrast * 1.6, 0.0, 1.0 ) );
    // ...and none in the noise floor, where "detail" is the grain we just
    // added. The bounds are in the sqrt (perceptual) domain, so 0.03..0.12
    // here is linear 0.001..0.014 — the bottom two stops.
    amount *= smoothstep( 0.03, 0.12, lc );
    // Written as 1 + delta rather than (lc + delta)/lc so that a zero centre
    // luminance yields a gain of exactly 1 instead of 0/eps = 0, which would
    // punch black holes in the darkest pixels of the frame.
    float gain = 1.0 + amount * ( lc - blur ) / max( lc, 1e-3 );
    // Cap at 2x: an unbounded gain on a near-black pixel next to a bright one
    // is a white speckle.
    disp *= clamp( gain, 0.0, 2.0 );
  }

  // --- ordered dither, then the 8-bit write ------------------------------
  // +/- half a code value of structured error. The sky here is a single smooth
  // gradient across the whole frame, which is the textbook case for 8-bit
  // banding; this costs one texture-free instruction and removes it entirely.
  disp += scBayer4( gl_FragCoord.xy ) * ( 1.0 / 255.0 );

  gl_FragColor = vec4( clamp( disp, 0.0, 1.0 ), 1.0 );
}
`

export function createComposite(lut) {
  return new Pass('sc-composite', COMPOSITE, {
    tColor: { value: null },
    tBloom: { value: null },
    tExposure: { value: null },
    tLut: { value: lut.texture },
    tDebugContact: { value: null },
    tDebugNormal: { value: null },
    // Debug view off, depth view normalised over 120 m (the far archipelago).
    uDebug: { value: new THREE.Vector4(0, 120, 0, 0) },
    uTexel: { value: new THREE.Vector2() },
    uLens: {
      value: new THREE.Vector4(
        // chromatic: offset = 0.0009 * r^2 uv units, so ~0.45 of a texel at
        // 1080p in the extreme corner. Present as lens character, invisible as
        // an artefact.
        0.0009,
        // vignette: 0.16 of the full cos^4 falloff. Enough to weight the eye
        // toward the centre of the route, not enough to read as a vignette.
        0.16,
        // grain: 0.006 in code-value units, i.e. +/- 1.5 codes at the peak of
        // the response curve. Below the threshold where it reads as noise;
        // above the threshold where it stops the image looking synthetic.
        0.006,
        0 // time, driven per frame
      ),
    },
    uGrade: {
      value: new THREE.Vector4(
        // bloomStrength: 0.36. The pyramid is energy-preserving and already
        // thresholded, so this is a true "36% of the over-threshold energy is
        // scattered" — it cannot veil the frame, because everything below the
        // threshold contributes exactly zero to it.
        //
        // It was 0.05, which is the right number for a scene whose highlights
        // are already at display white and only want a suggestion of a halo.
        // Measured, nothing here reaches white at all: the sun renders as a flat
        // lemon disc with a crisp edge and the lantern emissives as flat pale
        // octagons. A golden-hour frame with no aureole around its sun has no
        // light source in it. 0.36, against the lowered threshold, is what puts
        // the aureole back and pushes the cores of the emissives over white so
        // they actually clip.
        0.36,
        // lutStrength: 1.0 — the grade is the look, not an option.
        1.0,
        // sharpen: 0.20. The scene has no TAA to compensate for; this is here
        // to keep the clay surfaces crisp under the grain and the MSAA
        // resolve, and a fifth is about where it stops being felt as an effect.
        0.20,
        lut.size
      ),
    },
    uLook: {
      value: new THREE.Vector4(
        // AgX slope. PINNED AT 1.0. It multiplies the LOG-NORMALISED value, so
        // 1.05 is not "5% brighter", it is half a stop applied to the entire
        // image at the exact point where AgX has decided where mid-grey goes.
        1.0,
        // AgX power. 1.0 for the same reason: over a 16.5-stop log range a
        // power is an enormous, shadow-weighted contrast change. Use the LUT.
        1.0,
        // AgX log-space saturation. 1.0; chroma is restored in the LUT, in
        // display space, where a number is interpretable.
        1.0,
        // exposureScale: a plain multiplier on top of the metered exposure,
        // for cutscene/fade use. 1.0 = whatever the meter says.
        1.0
      ),
    },
  })
}
