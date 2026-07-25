import * as THREE from 'three'
import { Pass, renderTarget } from './pass.js'
import { GBUFFER_GLSL } from './gbuffer.js'

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
varying vec2 vUv;

// 14 steps. Below ~10 the ray steps over thin geometry (railings, the
// clockwork ornaments) and the shadow flickers as the camera moves; above ~16
// the extra samples land inside the same texel and buy nothing. 14 is where the
// curve flattens for a ray this short.
#define SC_CS_STEPS 14

void main() {
  vec4 nrm = texture2D( tNormal, vUv );

  // Coverage 0 = the prepass never wrote here = sky. Return full light and a
  // huge depth so the bilateral blur below treats it as a hard discontinuity
  // and never bleeds a shadow out over the cloud deck.
  if ( nrm.z < 0.5 ) { gl_FragColor = vec4( 1.0, 1e4, 0.0, 1.0 ); return; }

  float depth = texture2D( tDepth, vUv ).r;
  vec3 P = scViewPos( vUv, depth, uProjInv );
  vec3 N = scDecodeNormal( nrm.xy );
  vec3 L = uSunDirView;

  // A surface already facing away from the sun is in its own shadow; marching
  // from it can only produce a shadow on top of a shadow, at full cost.
  float NdL = dot( N, L );
  if ( NdL <= 0.02 ) { gl_FragColor = vec4( 1.0, depth, 0.0, 1.0 ); return; }

  // Scale the march with depth. A fixed WORLD length would shrink to a fraction
  // of a pixel at range (all cost, no visible result); a fixed SCREEN length
  // would grow into a metres-long ray at range and start acting like a bad
  // ambient occlusion. Growing the world length sub-linearly with distance
  // keeps the screen-space footprint roughly constant. Clamped at 2.5x so a
  // pixel on the far archipelago cannot march 40 m and shadow another island.
  float len = uParams.x * clamp( depth * 0.08 + 0.75, 0.75, 2.5 );

  // Rotate the sample positions per pixel and per frame. Without the jitter the
  // 14 steps are visible as 14 concentric bands; with it they become noise that
  // the bilateral below resolves into a soft gradient.
  float jitter = scIGN( gl_FragCoord.xy + uParams.z * 3.1717 );

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

  // .g carries depth through to the blur so it can be edge-aware.
  gl_FragColor = vec4( 1.0 - occ * uParams.w, depth, 0.0, 1.0 );
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
  vec2 c = texture2D( tSrc, vUv ).rg;
  float sum = c.r * 0.5;
  float wsum = 0.5;
  for ( int i = 1; i <= 2; i ++ ) {
    vec2 o = uDirection * float( i );
    vec2 a = texture2D( tSrc, vUv + o ).rg;
    vec2 b = texture2D( tSrc, vUv - o ).rg;
    float w = 0.3 / float( i );
    // Depth tolerance is RELATIVE (divided by the centre depth): a 10 cm step
    // is a hard edge at 2 m and noise at 200 m, and a fixed tolerance either
    // over-blurs up close or refuses to blur at all in the distance.
    float wa = w * exp( -abs( a.g - c.g ) * 40.0 / max( 0.1, c.g ) );
    float wb = w * exp( -abs( b.g - c.g ) * 40.0 / max( 0.1, c.g ) );
    sum += a.r * wa + b.r * wb;
    wsum += wa + wb;
  }
  gl_FragColor = vec4( sum / wsum, c.g, 0.0, 1.0 );
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
          // strength: 0.85, not 1.0. A contact shadow that removes 100% of the
          // key light is darker than the shadow-mapped shadow immediately next
          // to it (which is filtered, and floored by ambient), so the contact
          // reads as a black outline rather than as the same shadow getting
          // tighter. 0.85 makes them agree.
          0.85
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
  }

  get length() { return this.pass.uniforms.uParams.value.x }
  set length(m) { this.pass.uniforms.uParams.value.x = m }

  get thickness() { return this.pass.uniforms.uParams.value.y }
  set thickness(m) { this.pass.uniforms.uParams.value.y = m }

  get strength() { return this.pass.uniforms.uParams.value.w }
  set strength(s) { this.pass.uniforms.uParams.value.w = s }

  setSize(w, h) {
    if (this.rtA) this.rtA.dispose()
    if (this.rtB) this.rtB.dispose()
    // RG16F: one channel of visibility, one of depth for the bilateral. Half
    // the bandwidth of RGBA at full resolution, and visibility genuinely does
    // not need more than 11 bits of mantissa.
    const o = { name: 'sc-contact', format: THREE.RGFormat }
    this.rtA = renderTarget(w, h, THREE.HalfFloatType, o)
    this.rtB = renderTarget(w, h, THREE.HalfFloatType, o)
    this._texel.set(1 / Math.max(1, w), 1 / Math.max(1, h))
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
