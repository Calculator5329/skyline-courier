import * as THREE from 'three'
import { macroTexture, MACRO_SIZE } from './noise.js'

/**
 * The surface extension: an `onBeforeCompile` patch on MeshStandardMaterial.
 *
 * The problem it exists to solve is not "these surfaces need more detail". It
 * is that a hand-built box has NO variation above the size of its texture tile,
 * and the eye reads scale-invariance as "primitive". A 32 m brass wall painted
 * with a 2.4 m tile is thirteen identical copies of the same 2.4 m, and no
 * amount of extra grain inside the tile fixes that.
 *
 * So everything here works at scales the tile cannot reach:
 *
 *   1. MACRO RELIEF — the shading normal is tilted by the gradient of a
 *      low-frequency field, so a flat slab catches the sun in swales and
 *      ridges. This is the single biggest win: it gives large flat faces a
 *      light response that varies across them, which is what "moulded clay"
 *      looks like and what "untextured box" never does.
 *   2. TWO-BAND MACRO VARIATION — albedo and roughness drift at 1-4 m and
 *      again at 8-16 m. The big band is the only thing that still exists at
 *      40 m, once every finer signal has mipped away.
 *   3. MOSS CREEP WEDGE — walls do not meet floors on a razor line. In a
 *      sky-garden every sheltered inside corner grows something, so the
 *      junction gets a soft 25-40 cm wedge of moss/lichen creeping up it.
 *   4. TOP-FACE TREATMENT — upward faces catch sun-bleach, settled grit and
 *      wear, so a horizontal slab and a vertical wall of the same material
 *      stop being the same pixel.
 *   5. STOCHASTIC DE-TILING — a second, rotated and rescaled sample of the same
 *      texture, height-blended by a low-frequency mask, so the repeat stops
 *      being countable.
 *
 * Base stays MeshStandardMaterial so lighting/IBL work composes with this.
 *
 * VERTEX COLOUR CONTRACT: level.js bakes contact shading * per-box tint jitter
 * as a greyscale value into `color`. Nothing here writes or repurposes it —
 * `<color_fragment>` is left untouched and applies after our albedo work.
 */

// ---------------------------------------------------------------- uniforms

/**
 * ONE shared uniform object, referenced (not copied) by every patched material.
 * `Object.assign(shader.uniforms, SHARED)` copies the uniform *objects*, so a
 * single write to `SHARED.scGroundLevels.value` reaches every material.
 */
export const SHARED = {
  scMacroTex: { value: null },
  /**
   * Up to four world-Y floor planes the dust wedge can sit on. The level is
   * axis-aligned boxes with no "ground" concept, so the wedge needs to be told
   * where the walkable planes are; the shader uses the nearest one at or below
   * the fragment. Unused slots sit far below the kill plane so they never win.
   *
   * Defaults match the course as built: the terrace/pad deck tops at y = 0 and
   * the tower deck at y = 6.4. Callers can override with setGroundLevels().
   */
  scGroundLevels: { value: new THREE.Vector4(0.0, 6.4, -9999.0, -9999.0) },
}

/** Point the dust wedge at a different set of floor planes (max four). */
export function setGroundLevels(levels) {
  const v = SHARED.scGroundLevels.value
  v.set(
    levels[0] ?? -9999,
    levels[1] ?? -9999,
    levels[2] ?? -9999,
    levels[3] ?? -9999
  )
}

// ------------------------------------------------------------------- glsl

const PARS_VERTEX = /* glsl */ `
varying vec3 vScWPos;
varying vec3 vScWNrm;
`

const MAIN_VERTEX = /* glsl */ `
{
  // Computed locally rather than reusing three's worldPosition: that variable
  // only exists when an envmap/shadow/transmission define happens to be set.
  vec4 scWP = modelMatrix * vec4( transformed, 1.0 );
  vScWPos = scWP.xyz;
  vScWNrm = normalize( mat3( modelMatrix ) * objectNormal );
}
`

const PARS_FRAGMENT = /* glsl */ `
varying vec3 vScWPos;
varying vec3 vScWNrm;

uniform sampler2D scMacroTex;
uniform vec4 scGroundLevels;
uniform vec4 scMacroP;    // x tiles/metre, y albedo amt, z roughness amt, w hue amt
uniform vec4 scBigP;      // x contrast expansion, y big albedo amt, z big tiles/metre, w big rough amt
uniform vec4 scReliefP;   // x tilt amount, y relief->albedo coupling, z de-tile amount, w unused
uniform vec4 scWeatherP;  // x wedge amt, y top amt, z wedge height (m), w top-rough amt
uniform vec3 scWedgeCol;  // moss / lichen creeping out of the inside corner
uniform vec3 scTopCol;    // sun-bleach + settled grit on upward faces

// Written by the map_fragment block, consumed by the chunk overrides further
// down main(). GLSL globals, so no varyings and no recomputation.
float scRoughAdd;
vec3  scTiltW;

/**
 * Height-preserving blend of two samples of the same texture.
 *
 * A linear mix of two offset samples is the classic de-tiling mistake: it is a
 * 50% average, so contrast collapses and the surface ghosts. Weighting by each
 * sample's own luminance (a stand-in for height — porcelain speckle, brass
 * grain and moss clumps all read brighter where they are proud) and then
 * subtracting a common floor keeps one sample dominant almost everywhere, so
 * the result stays as crisp as either input.
 */
vec3 scHeightBlend( vec3 a, vec3 b, float t ) {
  // 0.6 is the height authority: high enough that the taller sample wins, low
  // enough that the blend mask still steers which one that is.
  float wa = ( 1.0 - t ) + dot( a, vec3( 0.3333 ) ) * 0.6;
  float wb = t + dot( b, vec3( 0.3333 ) ) * 0.6;
  // 0.18 is the transition width in weight space: ~1/6 of the weight range, so
  // the handover happens over a narrow band instead of a mushy half-and-half.
  float k = max( wa, wb ) - 0.18;
  wa = max( wa - k, 0.0 );
  wb = max( wb - k, 0.0 );
  return ( a * wa + b * wb ) / max( wa + wb, 1e-4 );
}
`

const MAIN_FRAGMENT = /* glsl */ `
#ifdef USE_MAP

  scRoughAdd = 0.0;
  scTiltW = vec3( 0.0 );

  // Two-sided safety: the course is closed boxes, but decor seen from inside a
  // frustum-clipped edge would otherwise shade with an inverted normal.
  vec3 scNw = normalize( vScWNrm ) * ( gl_FrontFacing ? 1.0 : -1.0 );

  // Macro projection frame. Upward faces project onto the ground plane; every
  // other face projects onto (horizontal-along-the-wall, height), which is the
  // frame gravity actually works in — dust settles and glaze slumps along it.
  // 0.62 is cos(~52 deg): boxes are axis-aligned so anything but 0/1 is unused,
  // but the threshold keeps the code honest if a rotated mesh ever arrives.
  float scUp = step( 0.62, abs( scNw.y ) );
  // The 1e-4 offsets keep normalize() finite on the up-face branch, where the
  // horizontal tangent degenerates to the zero vector before the mix picks X.
  vec3 scTu = mix( normalize( vec3( -scNw.z, 0.0, scNw.x ) + vec3( 1e-4, 0.0, 1e-4 ) ),
                   vec3( 1.0, 0.0, 0.0 ), scUp );
  vec3 scTv = mix( vec3( 0.0, 1.0, 0.0 ), vec3( 0.0, 0.0, 1.0 ), scUp );
  vec2 scWuv = vec2( dot( vScWPos, scTu ), dot( vScWPos, scTv ) );

  vec2 scMuv = scWuv * scMacroP.x;
  vec4 mac = texture2D( scMacroTex, scMuv );

  // ---------------------------------------------------------- albedo ----
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );

  #ifdef SC_DETILE
  {
    // Second sample: rotated 36.5 deg and scaled 0.617. Both numbers are chosen
    // to be badly irrational against the tile grid, so the two copies of the
    // texture never come back into phase within any distance you can see.
    const float C = 0.804;  // cos(36.5 deg)
    const float S = 0.595;  // sin(36.5 deg)
    vec2 uv2 = vec2( vMapUv.x * C - vMapUv.y * S, vMapUv.x * S + vMapUv.y * C ) * 0.617
             + vec2( 0.37, 0.71 );
    vec3 alt = texture2D( map, uv2 ).rgb;
    // Blend mask is low-frequency, so whole patches of surface swap copies
    // rather than the two dissolving into each other pixel by pixel.
    float dtm = clamp( ( mac.a - 0.38 ) * 2.4, 0.0, 1.0 ) * scReliefP.z;
    sampledDiffuseColor.rgb = scHeightBlend( sampledDiffuseColor.rgb, alt, dtm );
  }
  #endif

  diffuseColor *= sampledDiffuseColor;

  // ------------------------------------------- band 1: 1-4 m variation ----
  // fbm never spans 0..1 — three octaves of value noise live inside roughly
  // 0.5 +/- 0.18 — so using it raw makes every "variation" a 5% wash. scBigP.x
  // expands the contrast back out around the midpoint before anything uses it.
  float macro = clamp( ( mac.r * 0.58 + mac.g * 0.42 - 0.5 ) * scBigP.x + 0.5, 0.0, 1.0 );
  // 0.62 + 0.80 * macro averages to ~1.02 at macro = 0.5, so the surface keeps
  // its palette value instead of drifting dark as the amount is raised.
  diffuseColor.rgb *= mix( 1.0, 0.62 + 0.80 * macro, scMacroP.y );
  // Hue drift, not just value: warm one part of a slab and cool another, or the
  // variation reads as a lighting artefact rather than as material.
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.045, 1.0, 0.945 ), ( mac.g - 0.5 ) * scMacroP.w );
  // Roughness has to move or nothing in the frame ever glints differently.
  scRoughAdd += ( mac.g - 0.5 ) * scMacroP.z + ( mac.a - 0.5 ) * 0.10;

  // ------------------------------------------ band 2: 8-16 m variation ----
  // The signal that survives at 40 m. Everything above mips away to its mean by
  // then; this band is 4-8x larger than a whole slab, so it is still there.
  {
    vec2 bigUv = scWuv * scBigP.z;
    float big = texture2D( scMacroTex, bigUv ).r * 0.62
              + texture2D( scMacroTex, bigUv * 0.41 + 0.17 ).g * 0.38;
    // Same contrast problem, same fix; 1.15 because two-band averaging has
    // already narrowed this one further than the single-band case.
    big = clamp( ( big - 0.5 ) * scBigP.x * 1.15, -1.0, 1.0 );
    diffuseColor.rgb *= 1.0 + big * scBigP.y;
    scRoughAdd -= big * scBigP.w;
  }

  // ------------------------------------------------------ macro relief ----
  #ifdef SC_RELIEF
  {
    // The tile cannot carry anything bigger than itself, so large-scale form
    // has to come from the shading normal. Tilt it by the gradient of the
    // smooth macro band and a flat slab gains 1-4 m swales and ridges that
    // catch the sun — throwing ridges and slump in moulded clay.
    //
    // 2 texels is the finite-difference step: one texel rides the bilinear
    // reconstruction and returns a facet-y gradient, much more than two and the
    // ridges smear into a single soft bulge.
    const float E = 2.0 / ${MACRO_SIZE}.0;
    float hx = texture2D( scMacroTex, scMuv + vec2( E, 0.0 ) ).b;
    float hy = texture2D( scMacroTex, scMuv + vec2( 0.0, E ) ).b;
    // Gain. Measured on the generated field: the mean 2-texel delta is 0.017
    // and the max is 0.059, so 6.5 puts the tilt at ~6 degrees typical and
    // ~22 degrees on the steepest flank at amount 1.0 — a slab that visibly
    // catches raking light without ever looking like a broken normal map.
    vec2 g = ( vec2( hx, hy ) - mac.b ) * scReliefP.x * 6.5;
    vec3 tilt = -( g.x * scTu + g.y * scTv );
    // Project onto the tangent plane: a tilt with a component along N would
    // just scale the normal, not turn it.
    scTiltW = tilt - scNw * dot( scNw, tilt );
    // A ridge that only turns the normal reads as a lighting bug. Coupling a
    // little albedo to the same field — troughs slightly darker, because a
    // trough is a partly occluded pocket — is what makes it read as form.
    diffuseColor.rgb *= 1.0 - ( mac.b - 0.5 ) * scReliefP.y;
  }
  #endif

  // ------------------------------------------------- moss creep wedge ----
  #ifdef SC_WEDGE
  {
    // Height above the nearest floor plane at or below this fragment.
    vec4 d = vec4( vScWPos.y ) - scGroundLevels;
    // Planes above us are not our floor; 1e4 loses every min().
    d = mix( vec4( 1e4 ), d, step( -0.05, d ) );
    float hAbove = min( min( d.x, d.y ), min( d.z, d.w ) );

    // Near-vertical faces only. A razor-sharp wall/floor junction is the single
    // most reliable "this is an untextured primitive" tell in a box world.
    float vert = smoothstep( 0.72, 0.34, abs( scNw.y ) );
    // 25-40 cm, modulated so the creep line wanders instead of ruling a stripe.
    float wedgeH = scWeatherP.z * ( 0.78 + 0.44 * mac.r );
    float wedge = vert * ( 1.0 - smoothstep( wedgeH * 0.22, wedgeH, hAbove ) );
    // Squared: growth is dense in the sheltered corner and thins fast above it.
    wedge *= wedge * ( 0.70 + 0.52 * smoothstep( 0.20, 0.80, mac.a ) );
    // The fine band chews a ragged edge into the top of the creep — a smooth
    // analytic falloff reads as an airbrushed gradient, not as something alive.
    wedge *= 0.55 + 0.75 * mac.a;
    wedge = clamp( wedge * scWeatherP.x, 0.0, 1.0 );

    // 0.62 rather than a light glaze: moss is opaque where it grows, and this
    // wedge is doing most of the reference's "everything is planted" work.
    diffuseColor.rgb = mix( diffuseColor.rgb, scWedgeCol, wedge * 0.62 );
    // Growth is matte and it buries the substrate's own relief under itself.
    scRoughAdd += wedge * 0.22;
    scTiltW *= 1.0 - wedge * 0.6;
  }
  #endif

  // -------------------------------------------------- top-face settle ----
  #ifdef SC_TOPWEAR
  {
    // Squared so it falls off fast: a 45-degree chamfer collects far less than
    // a flat top does, and only genuinely horizontal faces should read worn.
    float up = clamp( scNw.y, 0.0, 1.0 );
    up *= up;
    // Patchy, not a uniform veil — sun-bleach and foot wear are both blotchy.
    float settle = up * scWeatherP.y * smoothstep( 0.28, 0.78, mac.b * 0.66 + mac.a * 0.48 );
    diffuseColor.rgb = mix( diffuseColor.rgb, scTopCol, settle * 0.38 );
    scRoughAdd += settle * scWeatherP.w;
  }
  #endif

#endif
`

/**
 * Chunk overrides. `<color_fragment>` is deliberately absent: level.js owns the
 * vertex colour channels and they must apply exactly as they do today.
 */
const OVERRIDES = [
  // Roughness offset from the macro bands / wedge / top wear. The 0.04 floor
  // keeps porcelain and brass glossy enough to still catch a highlight.
  [
    '#include <roughnessmap_fragment>',
    '#include <roughnessmap_fragment>\nroughnessFactor = clamp( roughnessFactor + scRoughAdd, 0.04, 1.0 );',
  ],
  // No normalMap on these materials, so this chunk is empty and ours replaces
  // it wholesale. `normal` is view-space here; viewMatrix is rigid, so its
  // upper 3x3 carries a world direction across without renormalising.
  [
    '#include <normal_fragment_maps>',
    `#include <normal_fragment_maps>
#if defined( SC_RELIEF ) && defined( USE_MAP )
  normal = normalize( normal + mat3( viewMatrix ) * scTiltW );
#endif`,
  ],
]

/**
 * Cache-key generation. Bump when the GLSL above changes in a way that must
 * invalidate a warm program cache — three keys programs on the chunk set plus
 * this string, and will happily reuse a stale compiled program otherwise.
 */
const SHADER_VERSION = 'sc1'

export const DEFAULT_PARAMS = {
  /** macro tiles per metre. 0.085 -> ~11.8 m period, so features land at 1-4 m. */
  macroScale: 0.085,
  /** albedo amount for band 1 */
  macroAlbedo: 0.3,
  /** signed roughness amount for band 1 */
  macroRough: 0.16,
  /** hue drift amount for band 1 */
  macroHue: 0.35,
  /** contrast expansion applied to every fbm read (see MAIN_FRAGMENT) */
  contrast: 2.3,
  /** albedo amount for band 2 */
  bigAlbedo: 0.1,
  /** band 2 tiles per metre. 0.022 -> ~45 m period, features at 8-16 m. */
  bigScale: 0.022,
  /** signed roughness amount for band 2 */
  bigRough: 0.1,
  /** macro-gradient normal tilt; 0 disables the layer and its two fetches */
  relief: 0,
  /** how much of the relief field also darkens albedo */
  reliefAlbedo: 0.14,
  /** de-tiling blend amount; 0 disables the extra fetch */
  detile: 0,
  /** moss creep amount at the wall/floor junction; 0 disables */
  wedge: 0,
  /** wedge height in metres before modulation */
  wedgeHeight: 0.34,
  /** sun-bleach / settled wear on upward faces; 0 disables */
  topDust: 0,
  /** roughness added where top wear is at full strength */
  topRough: 0.2,
  /** what creeps out of the inside corner — a deep shadowed moss by default */
  wedgeColor: 0x40662f,
  /** what settles on upward faces — warm sun-bleached grit */
  topColor: 0xe6d2a8,
}

/**
 * Install the extension on a MeshStandardMaterial.
 * @param {THREE.MeshStandardMaterial} material
 * @param {object} params  overrides on DEFAULT_PARAMS
 */
export function extendSurfaceMaterial(material, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params }

  if (!SHARED.scMacroTex.value) SHARED.scMacroTex.value = macroTexture(MACRO_SIZE)

  // Per-material uniforms. Allocated once, here, at load — nothing in the frame
  // loop touches these, so the render path allocates nothing.
  const own = {
    scMacroP: {
      value: new THREE.Vector4(p.macroScale, p.macroAlbedo, p.macroRough, p.macroHue),
    },
    scBigP: { value: new THREE.Vector4(p.contrast, p.bigAlbedo, p.bigScale, p.bigRough) },
    scReliefP: { value: new THREE.Vector4(p.relief, p.reliefAlbedo, p.detile, 0) },
    scWeatherP: {
      value: new THREE.Vector4(p.wedge, p.topDust, p.wedgeHeight, p.topRough),
    },
    // THREE.Color converts the sRGB hex into the renderer's working space.
    scWedgeCol: { value: new THREE.Color(p.wedgeColor) },
    scTopCol: { value: new THREE.Color(p.topColor) },
  }

  const defines = {}
  if (p.relief > 0) defines.SC_RELIEF = ''
  if (p.detile > 0) defines.SC_DETILE = ''
  if (p.wedge > 0) defines.SC_WEDGE = ''
  if (p.topDust > 0) defines.SC_TOPWEAR = ''

  Object.assign(material.defines ?? (material.defines = {}), defines)
  material.userData.scUniforms = own
  material.userData.scParams = p

  const key = `${SHADER_VERSION}:${Object.keys(defines).sort().join('|')}`
  material.customProgramCacheKey = () => key

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, SHARED, own)

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS_VERTEX)
      .replace('#include <project_vertex>', MAIN_VERTEX + '\n#include <project_vertex>')

    // The pars block has to land after three has declared `map` and the uv
    // varyings, so it hooks a later include rather than <common>.
    let fs = shader.fragmentShader
      .replace(
        '#include <clipping_planes_pars_fragment>',
        '#include <clipping_planes_pars_fragment>\n' + PARS_FRAGMENT
      )
      .replace('#include <map_fragment>', MAIN_FRAGMENT)

    for (const [find, repl] of OVERRIDES) fs = fs.replace(find, repl)
    shader.fragmentShader = fs
  }

  material.needsUpdate = true
  return material
}
