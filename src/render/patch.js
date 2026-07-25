import * as THREE from 'three'

/**
 * Material injection.
 *
 * Three things have to happen INSIDE the lit material rather than as a
 * post-process, because each of them belongs to one specific term of the
 * lighting equation and a screen-space multiply cannot tell the terms apart:
 *
 *   1. contact shadows -> the SUN's direct term only, never ambient;
 *   2. the ambient budget -> the indirect terms only, so the 20% rule in
 *      skyenv.js survives contact with the HemisphereLight that is already
 *      in the scene;
 *   3. aerial perspective -> after everything, in linear light, using the
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
const PATCH_VERSION = 1

/** Materials that actually run three's lighting pipeline. */
function isLit(m) {
  return !!(m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial))
}

const PARS = /* glsl */ `
uniform sampler2D scContactTex;
uniform vec2 scScreenTexel;
uniform vec3 scSunDirView;
uniform vec3 scSunDirWorld;
// x: contact shadows on, y: IBL gain, z: hemisphere/ambient trim, w: unused
uniform vec4 scFeat;
// x: density at the reference height, y: scale height (m),
// z: reference height (m), w: inscatter boost
uniform vec4 scAerial;
// Per-channel extinction ratios. See scAerialPerspective.
uniform vec3 scAerialBeta;
uniform vec3 scHaze;
uniform vec3 scHazeSun;

/**
 * Screen-space contact shadow for ONE light — the sun.
 *
 * The buffer was marched along a single direction, so it is only valid for the
 * light it was marched for. The fill light points somewhere else entirely and
 * must not receive it, or its shadows point the wrong way. Comparing the
 * incoming light direction against the sun's is a one-instruction way to say
 * that inside an unrolled loop that has no idea which light it is on.
 *
 * 0.999 rather than an equality: both vectors are normalised and interpolated
 * through the same uniform upload, so the residual is float noise, but an exact
 * compare on a float is never the right instrument.
 */
float scContactShadow( vec3 lightDirView ) {
  if ( scFeat.x < 0.5 ) return 1.0;
  if ( dot( lightDirView, scSunDirView ) < 0.999 ) return 1.0;
  return texture2D( scContactTex, gl_FragCoord.xy * scScreenTexel ).r;
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
 */
vec3 scAerialPerspective( vec3 color ) {
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

  vec3 T = exp( -tau * scAerialBeta );

  // Forward scatter: looking toward the sun through the haze is much brighter
  // than looking away through the same haze. At golden hour this is the
  // strongest depth cue in the frame, and it is the reason a backlit distant
  // island reads as backlit rather than as washed out.
  float sunAmt = max( dot( dirW, scSunDirWorld ), 0.0 );
  vec3 inscatter = mix( scHaze, scHazeSun, pow( sunAmt, 4.0 ) ) * scAerial.w;

  return color * T + inscatter * ( 1.0 - T );
}
`

const DIR_WRAPPER = /* glsl */ `
#if ( NUM_DIR_LIGHTS > 0 )
void scGetDirectionalLightInfo( const in DirectionalLight directionalLight, out IncidentLight light ) {
  getDirectionalLightInfo( directionalLight, light );
  light.color *= scContactShadow( light.direction );
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
  // ---- the ambient budget ------------------------------------------------
  // The irradiance variable at this point is the AmbientLight plus the HemisphereLight and
  // nothing else — every direct light goes through RE_Direct. So this is the
  // exact and only lever that trims the scene's existing constant ambient
  // without touching world.js, and it is what keeps total ambient at the 20%
  // of key that skyenv.js normalised the sky map to. Two ambient systems both
  // running at full strength is 40%, and at 40% the key light stops drawing
  // the forms.
  irradiance *= scFeat.z;
  iblIrradiance *= scFeat.y;
}
#endif
#if defined( RE_IndirectSpecular )
  radiance *= scFeat.y;
#endif
`

export class MaterialPatcher {
  constructor() {
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
      scAerial: {
        value: new THREE.Vector4(
          // density at the reference height. 0.0028/m puts ~34% of the light
          // from a 150 m island into haze and ~70% from a 400 m one, which is
          // the archipelago depth the reference art has.
          0.0028,
          // scale height 70 m. The play space itself spans tens of metres of
          // height, so a short scale height would make the haze visibly switch
          // off as the player climbs one tower. 70 m fades it by about a third
          // over that climb — felt, not noticed.
          70,
          // reference height 0 = the nominal deck level.
          0,
          // inscatter boost 1.3: the haze is brighter than the surfaces it
          // covers so distance LIGHTENS. See scAerialPerspective.
          1.3
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
      // Bright warm gold. Matches the sky's horizon band so distant geometry
      // dissolves INTO the sky rather than terminating against a different
      // colour, which is the tell that gives away every painted backdrop.
      scHaze: { value: new THREE.Color(0xffe3bd) },
      // Looking into the sun: brighter and creamier still.
      scHazeSun: { value: new THREE.Color(0xfff3d8).multiplyScalar(1.55) },
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
        'gl_FragColor.rgb = scAerialPerspective( gl_FragColor.rgb );'
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
