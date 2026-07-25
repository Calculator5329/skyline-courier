import * as THREE from 'three'

/**
 * Full-screen pass infrastructure.
 *
 * One geometry, one scene, one camera, shared by every pass in the chain. A
 * "pass" is a material we swap onto that single mesh — there is no
 * EffectComposer, no per-pass Scene, and nothing here allocates once the
 * pipeline is built.
 *
 * The primitive is a TRIANGLE, not a quad. A quad has a diagonal seam down the
 * middle where two triangles meet: every 2x2 quad the rasteriser packs along
 * that seam is half-wasted, and any derivative-using code (our sharpen taps,
 * for one) sees a discontinuity there. One oversized triangle clipped to the
 * viewport covers the same pixels with better quad occupancy and no seam.
 */

/**
 * Vertex shader for the full-screen triangle.
 *
 * Positions are (-1,-1), (3,-1), (-1,3): a triangle twice the size of the
 * viewport in each axis, so the visible [-1,1] square is entirely interior.
 * UV is derived from position rather than an attribute so it stays exact.
 */
export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`

/**
 * GLSL helpers shared by more than one pass.
 *
 * three's ShaderMaterial source is rewritten to GLSL ES 3.00 before compiling
 * (see WebGLProgram), so `texture2D` is aliased to `texture`, `varying` to
 * in/out, and sampler3D is available even though this reads like GLSL 1.
 */
export const COMMON = /* glsl */ `
#ifndef SC_COMMON
#define SC_COMMON

// Rec.709 luminance weights. The whole pipeline is sRGB/Rec.709 primaries,
// so these are the correct coefficients everywhere we need a scalar "how
// bright is this" — metering, Karis weighting, sharpen.
float scLum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

/**
 * Replace non-finite components with 0.
 *
 * A single NaN texel anywhere in the scene buffer is not a local artefact in an
 * HDR chain, it is a whole-frame outage, and it is worth one instruction to
 * refuse it. NaN propagates through the bloom pyramid's downsample and, far
 * worse, through the exposure reduction: max( nan, 1e-5 ) returns the floor, so
 * the weighted log-average collapses, the meter pins at its minimum EV, and the
 * value it writes into the adaptation ping-pong keeps it there for every
 * subsequent frame. Observed exactly that: an intermittent NaN somewhere in the
 * scene turned every capture in a harness session black and kept it black.
 *
 * A self-compare is false only for NaN, and the magnitude test catches +/-inf.
 * Written without isnan()/isinf() because drivers have historically disagreed
 * about them under fast-math, whereas the self-compare is the form that
 * survives every one of them.
 */
vec3 scSanitize( vec3 c ) {
  bvec3 finite = bvec3(
    c.x == c.x && abs( c.x ) < 1e20,
    c.y == c.y && abs( c.y ) < 1e20,
    c.z == c.z && abs( c.z ) < 1e20 );
  return vec3( finite.x ? c.x : 0.0, finite.y ? c.y : 0.0, finite.z ? c.z : 0.0 );
}

// sRGB OETF. This is the boundary between scene-referred linear light and
// display-referred code values; everything after it is measured in the same
// units a colourist works in.
vec3 scLinearToSrgb( vec3 c ) {
  c = max( c, vec3( 0.0 ) );
  return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666667 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
}

// Cheap, well-distributed hash. Used for grain only, where the eye is looking
// for "no structure" rather than for any particular spectral property.
float scHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

// 4x4 ordered (Bayer) dither, returned in [-0.5, 0.5].
//
// Ordered rather than random for the final 8-bit write: the error it injects
// is deterministic and spatially decorrelated from frame to frame only if we
// want it to be, so a static gradient (our sky) does not shimmer. A hash-based
// dither on a still frame crawls.
float scBayer4( vec2 p ) {
  mat4 m = mat4(
     0.0, 12.0,  3.0, 15.0,
     8.0,  4.0, 11.0,  7.0,
     2.0, 14.0,  1.0, 13.0,
    10.0,  6.0,  9.0,  5.0 );
  ivec2 i = ivec2( mod( p, 4.0 ) );
  return m[ i.x ][ i.y ] * ( 1.0 / 16.0 ) - 0.5;
}

#endif
`

// --- the one shared full-screen triangle ------------------------------------

const _geometry = new THREE.BufferGeometry()
_geometry.setAttribute(
  'position',
  new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
)
// three's ShaderMaterial prefix declares `attribute vec2 uv` whether or not we
// use it; supplying the attribute costs 24 bytes and removes any chance of a
// driver that fails to optimise it away complaining about an unbound one.
_geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
// Bounding sphere is set by hand and made enormous: the mesh is frustum-culling
// disabled anyway, but three still wants a valid sphere and computing one from
// clip-space positions is meaningless.
_geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8)

const _scene = new THREE.Scene()
_scene.matrixAutoUpdate = false
const _camera = new THREE.Camera()
const _mesh = new THREE.Mesh(_geometry, null)
_mesh.frustumCulled = false
_mesh.matrixAutoUpdate = false
_scene.add(_mesh)

/**
 * Draw `material` over `target` (null = the canvas).
 *
 * autoClear is forced off and restored. This matters: the bloom upsample
 * deliberately blends into an already-populated mip, and three's default
 * autoClear would wipe it before every draw.
 */
export function blit(renderer, material, target) {
  const prevAutoClear = renderer.autoClear
  renderer.autoClear = false
  _mesh.material = material
  renderer.setRenderTarget(target)
  renderer.render(_scene, _camera)
  renderer.autoClear = prevAutoClear
}

/** A post pass: a ShaderMaterial plus the uniform block it owns. */
export class Pass {
  constructor(name, fragmentShader, uniforms, opts = {}) {
    this.name = name
    this.uniforms = uniforms
    this.material = new THREE.ShaderMaterial({
      name,
      uniforms,
      vertexShader: FS_VERT,
      fragmentShader,
      // Depth is meaningless for a full-screen triangle and leaving these on
      // costs a depth test per pixel plus a depth write we would then have to
      // clear.
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      transparent: opts.transparent ?? false,
      premultipliedAlpha: false,
    })
  }

  render(renderer, target) {
    blit(renderer, this.material, target)
  }

  dispose() {
    this.material.dispose()
  }
}

/**
 * Does this context support rendering INTO a float/half-float colour buffer?
 *
 * Sampling half-float is core in WebGL2; rendering to it is not — it needs
 * EXT_color_buffer_float (or the half-float-only variant on some mobile
 * drivers). Without it every HDR target silently falls back to RGBA8, which
 * clips at 1.0 and makes auto-exposure and threshold bloom meaningless, so we
 * detect it once and branch the whole pipeline on the answer.
 */
export function detectHdrSupport(renderer) {
  const gl = renderer.getContext()
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
  if (!isWebGL2) return false
  return (
    renderer.extensions.has('EXT_color_buffer_float') ||
    renderer.extensions.has('EXT_color_buffer_half_float')
  )
}

/**
 * Colour target with sane defaults for post.
 *
 * `type` is passed in rather than assumed so the no-float fallback path can
 * build the identical target graph with UnsignedByteType and everything
 * downstream keeps working.
 */
export function renderTarget(w, h, type, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
    type,
    format: THREE.RGBAFormat,
    // LinearSRGBColorSpace, not sRGB: everything up to the composite is
    // scene-referred linear light and must not be encoded on write.
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...opts,
  })
  rt.texture.name = opts.name ?? 'sc-rt'
  return rt
}

export function disposeFullScreenGeometry() {
  _geometry.dispose()
}
