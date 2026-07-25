import * as THREE from 'three'

/**
 * Depth + view-normal prepass.
 *
 * Screen-space contact shadows need two things the beauty pass cannot give
 * them: a LINEAR view depth in metres (three's depth buffer is hyperbolic and
 * reconstructing metres from it costs a divide plus the near/far constants) and
 * a view-space normal (to push the ray origin off the surface it starts on).
 *
 * Two MRT attachments rather than one packed target:
 *
 *   0  RG16F   octahedral view normal (xy), coverage (z), unused (w)
 *   1  R32F    linear view depth in METRES, positive, 0 = nothing here
 *
 * COVERAGE is the sky test. The colour attachments are cleared to zero, so any
 * texel the geometry pass never touched reads coverage 0 and every consumer
 * treats it as "infinitely far away" instead of as a surface at the origin —
 * which is exactly what we want for the sky, and it costs one compare instead
 * of a second depth-buffer read.
 *
 * The depth attachment is R32F where the context can render to it. Half-float
 * would quantise to ~6 cm at 100 m, and the contact-shadow bias lives at
 * 4 mm + 0.25% of depth, so a half-float depth buffer puts the bias inside the
 * quantisation error and the shadow starts self-intersecting at range.
 */

/** GLSL shared between this prepass and anything that reads its output. */
export const GBUFFER_GLSL = /* glsl */ `
#ifndef SC_GBUFFER
#define SC_GBUFFER

// --- octahedral normal packing ---------------------------------------------
// Two channels instead of three, and the error is bounded and uniform over the
// sphere (unlike the xy-and-reconstruct-z trick, which cannot represent a
// back-facing normal at all — and interpolated vertex normals on a merged mesh
// absolutely do face slightly away from the camera at silhouettes).
vec2 scOctWrap( vec2 v ) {
  return ( 1.0 - abs( v.yx ) ) * vec2( v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0 );
}
vec2 scEncodeNormal( vec3 n ) {
  n /= ( abs( n.x ) + abs( n.y ) + abs( n.z ) + 1e-8 );
  n.xy = n.z >= 0.0 ? n.xy : scOctWrap( n.xy );
  return n.xy;
}
vec3 scDecodeNormal( vec2 f ) {
  vec3 n = vec3( f.x, f.y, 1.0 - abs( f.x ) - abs( f.y ) );
  float t = max( -n.z, 0.0 );
  n.xy += vec2( n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t );
  return normalize( n );
}

// View-space position from a uv and a POSITIVE linear view depth. The inverse
// projection gives a ray; normalising it so its z is -1 turns "somewhere along
// the ray" into "exactly `depth` metres in front of the camera plane", which is
// the quantity the prepass stored.
vec3 scViewPos( vec2 uv, float depth, mat4 projInv ) {
  vec4 h = projInv * vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
  vec3 dir = h.xyz / h.w;
  dir /= max( 1e-6, -dir.z );
  return dir * depth;
}

// Interleaved gradient noise (Jimenez). The right dither for rotating a sample
// kernel: over a 2x2 quad it takes four well-spread values, so the ray-march
// start offsets decorrelate at exactly the scale the blur below averages over.
// A white-noise hash would leave salt-and-pepper the bilateral cannot remove.
float scIGN( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

#endif
`

export class GBuffer {
  /**
   * @param {boolean} floatDepth  true if the context can render to R32F
   *                              (EXT_color_buffer_float). Falls back to R16F.
   */
  constructor(floatDepth) {
    this.rt = null
    this.width = 0
    this.height = 0
    this._depthType = floatDepth ? THREE.FloatType : THREE.HalfFloatType

    this.material = new THREE.ShaderMaterial({
      name: 'sc-prepass',
      // GLSL3 so we can name the MRT attachments with layout qualifiers. three
      // rewrites `varying`/`attribute` for us (see WebGLProgram's GLSL3 prefix),
      // which is why this still reads like GLSL 1.
      glslVersion: THREE.GLSL3,
      side: THREE.FrontSide,
      uniforms: {},
      vertexShader: /* glsl */ `
        #include <common>
        #include <batching_pars_vertex>

        varying vec3 vNrm;
        varying float vViewDepth;

        void main() {
          #include <batching_vertex>
          #include <beginnormal_vertex>
          #include <defaultnormal_vertex>
          #include <begin_vertex>
          #include <project_vertex>
          vNrm = transformedNormal;
          // -mvPosition.z, i.e. distance along the view axis, not radial
          // distance. Everything downstream reconstructs with scViewPos, which
          // assumes exactly this convention.
          vViewDepth = -mvPosition.z;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${GBUFFER_GLSL}

        varying vec3 vNrm;
        varying float vViewDepth;

        layout(location = 0) out vec4 gNormal;
        layout(location = 1) out vec4 gDepth;

        void main() {
          vec3 n = normalize( vNrm );
          // Interior faces of the merged level boxes do get rasterised (the
          // player runs through arches). Flipping to the geometric facing keeps
          // the ray-origin offset pointing out of the surface rather than into
          // it, which is the difference between a contact shadow and a band of
          // self-occlusion.
          if ( !gl_FrontFacing ) n = -n;
          gNormal = vec4( scEncodeNormal( n ), 1.0, 0.0 );
          gDepth = vec4( vViewDepth, 0.0, 0.0, 1.0 );
        }
      `,
    })
  }

  get normalTexture() {
    return this.rt ? this.rt.textures[0] : null
  }

  get depthTexture() {
    return this.rt ? this.rt.textures[1] : null
  }

  setSize(w, h) {
    w = Math.max(1, w | 0)
    h = Math.max(1, h | 0)
    if (this.rt && this.width === w && this.height === h) return
    this.width = w
    this.height = h
    if (this.rt) this.rt.dispose()

    const rt = new THREE.WebGLRenderTarget(w, h, {
      count: 2,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      // NEAREST everywhere. A filtered normal buffer interpolates two unrelated
      // octahedral encodings across every silhouette and produces a normal that
      // points at neither surface; a filtered depth buffer invents a ramp
      // between a foreground and a background that the ray march then walks
      // straight down. Both artefacts read as a dark fringe around every edge.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      // The prepass is a real geometry pass and needs to depth-test against
      // itself, or the contact shadows are computed from whichever surface the
      // draw order happened to put last.
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    })
    rt.textures[0].format = THREE.RGBAFormat
    rt.textures[0].type = THREE.HalfFloatType
    rt.textures[0].name = 'sc-gb-normal'
    rt.textures[1].format = THREE.RedFormat
    rt.textures[1].type = this._depthType
    rt.textures[1].name = 'sc-gb-depth'
    for (const t of rt.textures) {
      t.minFilter = THREE.NearestFilter
      t.magFilter = THREE.NearestFilter
      t.generateMipmaps = false
    }
    this.rt = rt
  }

  /**
   * Render the prepass.
   *
   * `hidden`/`hiddenVis` are parallel arrays owned by the caller: objects that
   * must not appear in the buffer (the sky sphere, the additive motes, anything
   * transparent) and their pre-existing `visible` flags, so the restore is
   * exact rather than "set everything back to true".
   */
  render(renderer, scene, camera, hidden, hiddenVis) {
    for (let i = 0; i < hidden.length; i++) {
      hiddenVis[i] = hidden[i].visible
      hidden[i].visible = false
    }

    const prevOverride = scene.overrideMaterial
    scene.overrideMaterial = this.material
    renderer.setRenderTarget(this.rt)
    // Colour AND depth: the colour clear to zero is what makes coverage 0 mean
    // "sky" (see the class note).
    renderer.clear(true, true, false)
    renderer.render(scene, camera)
    scene.overrideMaterial = prevOverride

    for (let i = 0; i < hidden.length; i++) hidden[i].visible = hiddenVis[i]
  }

  dispose() {
    if (this.rt) this.rt.dispose()
    this.material.dispose()
  }
}
