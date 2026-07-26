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
 *   6. THE SUN AUREOLE, in the specular chain only. See SUN LOBE below — this
 *      is the fix for "there is not a single specular highlight anywhere in
 *      the game", which is what made a metal wall read as varnished pine.
 *   7. CAVITY COOL — recesses tint toward the green zenith they actually see
 *      instead of toward the low warm sun they cannot see, and (SC_CAVITY +
 *      specAo) lose reflected radiance, which is what puts a real dark end on
 *      brass's value range.
 *   8. THE HORIZON GLINT. See HORIZON GLINT below. The sun lobe alone only
 *      fires on faces pointed at the sun; this is what makes a metal read as
 *      metal from every other angle.
 *   9. WRAPPED / BACK-LIT DIFFUSE. Foliage is translucent, and under a sun
 *      sitting 10 degrees above the horizon a flat moss deck collects almost
 *      no direct term by cosine law. See WRAP below.
 *  10. WORLD-PLANAR TILE UV. Optional, per material: sample the tile in world
 *      space instead of per-box uv, so a cap built out of several boxes is one
 *      continuous mat rather than several with visible joins.
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
  /**
   * x — squared angular width (radians^2) of the sun's aureole, the lobe the
   *     specular chain is missing. 0.030 is a 10-degree half-width, which is
   *     what a hazy golden-hour sun actually subtends once the aureole is
   *     counted. See SUN LOBE in the fragment source.
   * y — how much of that lobe a fragment loses to being in a pocket, so a
   *     recessed groove does not glint as hard as the proud land beside it.
   * z — weight of the wide aureole term relative to the disc.
   * w — spare.
   */
  scSunP: { value: new THREE.Vector4(0.030, 0.55, 1.0, 0) },
  /**
   * What a shadowed pocket sees. Not black and not grey: it is the cool green
   * zenith from skyenv.js, so the deeper a crevice the greener and cooler it
   * goes. Multiplied into albedo, hence < 1 on every channel.
   */
  scCavityCol: { value: new THREE.Color(0.52, 0.68, 0.64) },
  /**
   * The shadow-side bias. Green up, red down, blue up a little: skyenv's
   * zenith is 0x4d7f83, which is green-dominant rather than blue-dominant, and
   * copying that is what makes the cool side read as a sky-garden's shadow
   * rather than as a moonlit one.
   */
  scShadeCol: { value: new THREE.Color(0.72, 0.94, 0.93) },
  /**
   * THE UP-FACE BIAS, and the counterweight to scShadeCol.
   *
   * A surface facing straight up under a sun at 9.8 degrees elevation collects
   * cos(80) = 0.17 of the key by Lambert, so it is lit almost entirely by
   * ambient — and the ambient here is skyenv's cool green zenith. The measured
   * consequence, on the tower stair where the same porcelain faces two ways
   * 30 cm apart: treads at hue 45.8 / luma 86.7 against risers at hue 34.1 /
   * luma 155.5. One material, +11.7 degrees of green and a 1.8-stop value
   * inversion, purely from which way it points. That is the review's "the floor
   * is green", and it is why the ascent stair does not read as a stair.
   *
   * The physical answer is that an up-face does not only see the zenith — it
   * integrates the WHOLE hemisphere, and at golden hour the largest, brightest
   * part of that hemisphere is the warm horizon ring and the lit cloud sea
   * under it. skyenv normalises its map for irradiance, which averages that
   * ring away against the cool dome above.
   *
   * THE CORRECTION IS A GREEN CUT, NOT A RED BOOST, and that took two attempts
   * to get right.
   *
   * Attempt one ran at (1.24, 1.07, 0.85) — Rec.709 luma 1.09. Up faces are a
   * large share of the screen, so it raised the scene's log-average enough that
   * the adaptive exposure pulled back, and everything that was NOT an up face
   * went dark with it: across the eight-shot set p1 fell 49.8 -> 28.2 and mean
   * saturation rose 0.451 -> 0.520. The decks came back mustard, with blue
   * crushed from 36 code values to 10. A chromatic correction that changes the
   * frame's energy is not a chromatic correction; it is an exposure change
   * wearing one as a disguise.
   *
   * The target says what the shape has to be. A tread should look like the
   * riser under less light: scale the measured riser rgb(207,149,72) by 0.5 and
   * you get (104,75,36). The measured tread is (101,89,36) — red and blue are
   * already right and GREEN is 19% too high. So the fix cuts green.
   *
   * (1.14, 0.90, 1.06) has Rec.709 luma 0.963 on a neutral, but on a
   * sandstone-hued texel — where green is not the dominant channel it is in the
   * luma weights — it lands within 0.2% of unity. It rotates hue and leaves the
   * meter alone, which is the only property that matters here.
   */
  scSkyWarmCol: { value: new THREE.Color(1.14, 0.90, 1.06) },
  /** Verdigris: copper carbonate. The coolest pixel the world owns, and the
   *  only place a green that is not vegetation is allowed to appear. */
  scPatinaCol: { value: new THREE.Color(0x4e8f7a) },
  /**
   * The radiance of the bright band where the cloud sea meets the sky — the
   * one sharp structure in this environment, and the thing the horizon glint
   * puts back. Linear light units, matched to skyenv.js's horizon (0xffcfa0 at
   * gain 1.7) and cloud (0xffd7a8 at gain 1.9) bands, which straddle it.
   *
   * Over 1 on the red channel is not a mistake: skyenv normalises its map for
   * *irradiance*, which averages the whole hemisphere, so the peak radiance of
   * the horizon band is several times the mean it was normalised against.
   */
  scHorizonCol: { value: new THREE.Color(1.55, 1.18, 0.72) },
}

/**
 * THE FIVE SHARED COLOURS ARE THEME DATA, not constants.
 *
 * Every value in `SHARED` above is a statement about THIS SKY: "a pocket sees
 * the cool green zenith", "an up face sees the warm horizon ring", "the sharp
 * structure in this environment is the cloud sea". All five are true of a
 * golden-hour archipelago and all five are false in a void, where there is no
 * sun, no horizon and no cloud sea — `docs/art-direction-void.md` §1: the
 * sunset theme is "lit BY THE SKY", the void theme is "lit BY OBJECTS".
 *
 * They are five of `docs/scaling-plan.md`'s 48 hardcoded colours, and they are
 * the five with the largest reach, because every lit texel in the game passes
 * through at least one of them. Left alone under the void they paint a warm
 * horizon bias onto every up-facing rock and a green zenith into every crevice,
 * which is a large part of why near-black violet rock photographed as pale
 * chalky limestone.
 *
 * The defaults below are the skyline's own values, LIFTED VERBATIM, so a theme
 * that names none of them renders exactly as before. `theme.surfaces.macro`
 * names the ones it wants to move; `applyThemeSurfaces` in materials.js is the
 * only caller.
 */
const MACRO_DEFAULTS = {
  cavity: [0.52, 0.68, 0.64],
  shade: [0.72, 0.94, 0.93],
  skyWarm: [1.14, 0.90, 1.06],
  horizon: [1.55, 1.18, 0.72],
  patina: 0x4e8f7a,
}

/**
 * Point the five environment-derived colours at a theme's own sky.
 *
 * Values are linear multipliers (or a hex, for patina, which is a substance
 * rather than a light). Anything omitted falls back to the skyline default, so
 * a partial block is legal and means "leave the rest alone".
 */
export function setMacroColors(macro = {}) {
  const m = { ...MACRO_DEFAULTS, ...macro }
  const set = (u, v) => {
    if (Array.isArray(v)) u.value.setRGB(v[0], v[1], v[2])
    else u.value.set(v)
  }
  set(SHARED.scCavityCol, m.cavity)
  set(SHARED.scShadeCol, m.shade)
  set(SHARED.scSkyWarmCol, m.skyWarm)
  set(SHARED.scHorizonCol, m.horizon)
  set(SHARED.scPatinaCol, m.patina)
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
uniform vec4 scReliefP;   // x tilt amount, y relief->albedo coupling, z de-tile amount, w world-uv tiles/metre
uniform vec4 scWeatherP;  // x wedge amt, y top amt, z wedge height (m), w top-rough amt
uniform vec4 scSpecP;     // x sun-lobe amount, y cavity strength, z shade-tint amt, w up-face warm amt
uniform vec4 scGlintP;    // x horizon-glint amount, y specular AO from cavity, z glint band width, w unused
uniform vec4 scWrapP;     // x wrap width, y wrap amount, z back-lit transmission, w unused
uniform vec4 scSunP;      // shared: x aureole width^2, y cavity's bite on specular
uniform vec3 scWedgeCol;  // moss / lichen creeping out of the inside corner
uniform vec3 scTopCol;    // sun-bleach + settled grit on upward faces
uniform vec3 scCavityCol; // what a pocket sees: the cool green zenith
uniform vec3 scShadeCol;  // what the sun-away hemisphere sees: the same sky
uniform vec3 scSkyWarmCol;// what an UP face sees: the warm horizon ring
uniform vec3 scHorizonCol;// the bright band where the cloud sea meets the sky
uniform vec3 scPatinaCol; // verdigris, on downward faces and in crevices
uniform vec4 scPatinaP;   // x downward-face amount, y crevice amount, z metalness kill, w unused

// Written by the map_fragment block, consumed by the chunk overrides further
// down main(). GLSL globals, so no varyings and no recomputation. scCavity is
// initialised to "fully open" so the lighting hook is safe on any permutation
// that never runs the map block at all.
float scRoughAdd;
vec3  scTiltW;
float scCavity = 1.0;
/** How much of this texel is corrosion product rather than bare metal. Written
 *  by the patina block, consumed by the metalness chunk override — verdigris is
 *  a dielectric salt, and leaving metalness at 1 under it is what made the last
 *  attempt read as green paint on gold. 0 on every material that opts out. */
float scPatina = 0.0;
/**
 * The uv every tile-scale map is sampled at. Normally just vMapUv; under
 * SC_WORLDUV it is the world-planar projection instead, and then the roughness,
 * metalness and normal chunks have to be pointed at it too — sampling albedo in
 * world space and form in box space would put the moss colour and the moss
 * bumps in different places, which is worse than the seam it fixes.
 */
vec2 scUv0 = vec2( 0.0 );
/**
 * The world-space projection frame the tile is laid out in: scTuW along +u,
 * scTvW along +v, scNwW the face normal. Written by the map block.
 *
 * Kept as globals so the normal chunk can build a tangent frame from them
 * ANALYTICALLY under SC_WORLDUV. The obvious alternative — three's
 * getTangentFrame(), which derives the frame from the screen-space derivatives
 * of the uv — turned out to be a NaN source: it scales its tangents by
 * inversesqrt(det), and on a fragment where the world-planar uv happens to have
 * a near-zero derivative that scale overflows, the subsequent normalize() sees
 * an infinity, and one NaN normal poisons the exposure meter's log-average and
 * takes the WHOLE FRAME to black. Measured: every capture came back at
 * luminance 5.9 with a dynamic range of 3.8.
 *
 * The level is axis-aligned boxes, so the analytic frame is not an
 * approximation — it is exactly the frame the projection was built in, and it
 * cannot degenerate.
 */
vec3 scTuW = vec3( 1.0, 0.0, 0.0 );
vec3 scTvW = vec3( 0.0, 1.0, 0.0 );
vec3 scNwW = vec3( 0.0, 0.0, 1.0 );

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
  // Published for the normal chunk; see the declarations above.
  scTuW = scTu; scTvW = scTv; scNwW = scNw;

  vec2 scMuv = scWuv * scMacroP.x;
  vec4 mac = texture2D( scMacroTex, scMuv );

  // ------------------------------------------------------- tile frame ----
  // WORLD-PLANAR UV. A moss cap assembled from four boxes has four independent
  // uv origins, so the mat visibly steps at every box join — that seam is
  // exactly what the art review found across the top of the gaps deck. Driving
  // the tile off the world position instead makes the whole cap one mat. Only
  // materials that ask for it pay: everything with registered detail (ashlar,
  // roof laps, brass bands) wants to stay keyed to its box.
  #ifdef SC_WORLDUV
    scUv0 = scWuv * scReliefP.w;
  #else
    scUv0 = vMapUv;
  #endif

  // ---------------------------------------------------------- albedo ----
  vec4 sampledDiffuseColor = texture2D( map, scUv0 );

  #ifdef SC_DETILE
  {
    // Second sample: rotated 36.5 deg and scaled 0.617. Both numbers are chosen
    // to be badly irrational against the tile grid, so the two copies of the
    // texture never come back into phase within any distance you can see.
    const float C = 0.804;  // cos(36.5 deg)
    const float S = 0.595;  // sin(36.5 deg)
    vec2 uv2 = vec2( scUv0.x * C - scUv0.y * S, scUv0.x * S + scUv0.y * C ) * 0.617
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
  //
  // Warm and cool are NOT two ends of one axis here. The warm end is the low
  // sun (red up, blue down); the cool end is the green zenith (green AND blue
  // up, red down). Swinging a single symmetric vector gives red<->cyan, which
  // is the wrong cool and is part of why the frame reads as one orange wedge.
  {
    float hs = ( mac.g - 0.5 ) * scMacroP.w;
    vec3 warm = vec3( 1.11, 1.00, 0.86 );
    vec3 cool = vec3( 0.89, 1.02, 1.03 );
    diffuseColor.rgb *= mix( vec3( 1.0 ), mix( cool, warm, step( 0.0, hs ) ), abs( hs ) );
  }
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

  // ----------------------------------------------------- cavity cool ----
  #ifdef SC_CAVITY
  {
    // Alpha of the normal map carries "how deep in a pocket am I", measured by
    // textures.js as local height minus regional height. 1 = proud or flat.
    scCavity = texture2D( normalMap, scUv0 ).a;
    float occ = ( 1.0 - scCavity ) * scSpecP.y;
    // The single most defining characteristic of the reference is a warm key
    // against cool green shadow, and it has to start here. A mortar joint, a
    // band channel, the gap between two roof tiles: none of them can see a sun
    // sitting 12 degrees above the horizon, and all of them can see the zenith.
    // Tinting them toward it is not grading, it is what is actually happening.
    diffuseColor.rgb *= mix( vec3( 1.0 ), scCavityCol, occ );
    // Sheltered pockets hold dust and damp, so they are also duller.
    scRoughAdd += occ * 0.12;
  }
  #endif

  // ---------------------------------------------------------- verdigris ----
  #ifdef SC_PATINA
  {
    // Copper carbonate forms where water sits and where it never dries: the
    // soffit of a band, the underside of a bracket, the lee of a boss. The
    // tile's own verdigris pass already covers the pockets it can see inside
    // one 2.4 m square; this is the half that needs a WORLD normal, and it is
    // the half the art director asked for — a full-screen brass wall came back
    // spanning 1.9 degrees of hue across every region measured, so there is at
    // present no cool pixel anywhere on the signature material.
    //
    // Downward faces, widened by a low-frequency patchiness so one soffit
    // corrodes and the next does not. -0.12 to -0.72 in N.y is a soft turn
    // starting just past horizontal: a slab's underside is full strength, a
    // 45-degree chamfer takes about half, and a wall takes none.
    float down = smoothstep( -0.12, -0.72, scNw.y );
    float blotch = smoothstep( 0.28, 0.74, mac.r * 0.60 + mac.a * 0.50 );
    // The crevice half keeps a floor under the blotch and the downward half does
    // not, and that asymmetry is deliberate. A soffit either has grown a crust
    // or it has not, so patchiness there is the whole read; a band channel on a
    // VERTICAL plate always holds some film, and gating it on the same mask
    // zeroed it over most of a wall — measured on the closeup brass, the
    // fraction of texels greener than hue 52 came out at 0.33%, i.e. no cool
    // pixel anywhere on the signature material, which is the finding this term
    // exists to answer.
    // 2.6 on the pocket term, because the raw cavity signal is not a mask.
    // Measured on the brass tile: a rivet band channel is 40 code values below
    // the plate, which against a radius-9 blur at gain 3.2 comes back as
    // 1 - cavity = 0.26. Driving the crust off that directly puts a 19% film in
    // the deepest channel on the material and nothing anywhere else, and 19% of
    // a desaturated teal under a key this orange is not a colour — measured, it
    // moved the channel's hue by 3 degrees and left the fraction of texels
    // greener than hue 52 at 1.4%. Rescaled, a band floor reads ~0.67 and the
    // crust lands at the brief's ~0.35.
    float pocket = clamp( ( 1.0 - scCavity ) * 2.6, 0.0, 1.0 );
    scPatina = clamp( down * blotch * scPatinaP.x
                      + pocket * ( 0.45 + 0.55 * blotch ) * scPatinaP.y,
                      0.0, 0.60 );
    diffuseColor.rgb = mix( diffuseColor.rgb, scPatinaCol, scPatina );
    // Crust is matte. A green that keeps the plate's polish reads as tinted
    // lacquer; the roughness break is most of what says "different substance".
    scRoughAdd += scPatina * 0.34;
  }
  #endif

  // ------------------------------------------------ shadow-side cool ----
  #if defined( SC_SHADETINT ) && ( NUM_DIR_LIGHTS > 0 )
  {
    // A face turned away from the sun is lit by sky alone, and this sky's upper
    // dome is a cool green (skyenv zenith 0x4d7f83). Physically that belongs in
    // the ambient term, and the ambient term is where the art review found it
    // missing — but envMapIntensity is the only ambient knob a material owns,
    // and on its own it cannot separate "facing the sun" from "facing away".
    //
    // So this is a stylisation and is stated as one: it biases albedo toward
    // the sky's colour on the sun-away hemisphere. It is the same move a
    // stylised animated feature makes with a shadow-colour ramp, it costs one
    // dot product, and it produces the warm-key/cool-green-shadow split that
    // docs/art-direction.md calls the single most defining characteristic of
    // the reference. The real fix is a stronger cool ambient upstream; when
    // that lands, this amount should come down, not stay.
    vec3 scLv = directionalLights[ 0 ].direction;
    float ndl = dot( normalize( mat3( viewMatrix ) * scNw ), scLv );
    // Wide crossover: a hard terminator here would draw a second, wrong
    // shadow edge across every curved-looking surface.
    float away = smoothstep( 0.35, -0.30, ndl );
    /**
     * CLAMPED ON UP-FACING NORMALS, and this is the fix for the stair.
     *
     * With the sun at 9.8 degrees, an up-face has N.L = 0.17 — inside this
     * term's crossover, so a horizontal tread that is in FULL SUN was being
     * told it faces away from it and tinted cool for the privilege. A vertical
     * riser catching the same sun at N.L = 0.9 got none of it. That is a lie
     * about the lighting, and the measured cost was a tread reading 11.7
     * degrees greener than the riser 30 cm above it.
     *
     * 1 - 0.6 * N.y: an up-face keeps 40% of the bias (a deck genuinely does
     * see more sky than a wall does), a vertical face keeps all of it, and a
     * soffit — which sees the cloud sea, not the zenith — keeps all of it too.
     */
    away *= 1.0 - 0.6 * max( 0.0, scNw.y );
    diffuseColor.rgb *= mix( vec3( 1.0 ), scShadeCol, away * scSpecP.z );
  }
  #endif

  // -------------------------------------------------- up-face sky warm ----
  // The other half of the stair fix: the warm horizon ring an up-face
  // integrates. See scSkyWarmCol. Squared so it falls off fast — only a
  // genuinely horizontal surface collects a full hemisphere, and a 45-degree
  // chamfer collects a quarter of this rather than half, which keeps the term
  // off anything that reads as a wall. No light dependency, so unlike the
  // shade tint above it does not need NUM_DIR_LIGHTS.
  #ifdef SC_UPWARM
  {
    float upFace = clamp( scNw.y, 0.0, 1.0 );
    upFace *= upFace;
    diffuseColor.rgb *= mix( vec3( 1.0 ), scSkyWarmCol, upFace * scSpecP.w );
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
 * ============================== THE SUN LOBE ==============================
 *
 * skyenv.js deliberately leaves the sun disc out of the IBL, and it is right
 * to: the DirectionalLight already carries the sun's direct energy, and putting
 * a disc in an 8192-texel equirect that is then normalised for irradiance would
 * double-count the brightest thing in the scene into every diffuse surface.
 *
 * But that decision took the sun out of the SPECULAR chain too, and specular is
 * the only chain a metal has. With diffuse suppressed by metalness and nothing
 * bright anywhere in the environment to mirror, brass returned a flat orange
 * gradient — which is exactly what varnished wood looks like, and is exactly
 * what the art review found. Measured: clipped-high was 0.00% in all eight
 * captures. There was not one specular highlight in the entire game.
 *
 * So the disc goes back, on the specular side only, added straight into
 * `radiance` where an env map's pre-convolved reflection would have landed:
 *
 *   - Direction and colour come from `directionalLights[0]`, so this tracks
 *     whatever world.js does with the sun and cannot drift out of sync.
 *   - Diffuse is untouched, so nothing is double-counted.
 *   - The lobe is the surface's own GGX width convolved with the sun's aureole
 *     (scSunP.x). At golden hour the aureole is genuinely 8-10 degrees wide and
 *     carries real energy, so a broad lobe here is physical, not a cheat.
 *   - Peak radiance scales with the lobe's sharpness (n / 2pi) because a fixed
 *     amount of energy squeezed into a smaller solid angle is brighter. Without
 *     that, polishing a surface would make it dimmer.
 *
 * It is not shadowed, which is correct for the same reason an env map is not:
 * this is the sky's reflection, not the direct term.
 */
const SUN_LOBE = /* glsl */ `
#if defined( SC_SUNLOBE ) && ( NUM_DIR_LIGHTS > 0 )
{
  vec3 scL = directionalLights[ 0 ].direction;
  vec3 scR = reflect( -geometryViewDir, geometryNormal );
  float scCa = max( dot( scR, scL ), 0.0 );
  // A face turned away from the sun can still produce a positive R.L at
  // grazing angles; without this gate the shaded side of a wall glints.
  float scFace = smoothstep( 0.0, 0.16, dot( geometryNormal, scL ) );
  float scAlpha = max( material.roughness * material.roughness, 0.0025 );
  // Widths add in quadrature: surface lobe convolved with source lobe.
  float scW = scAlpha * scAlpha + scSunP.x;
  // Capped at 240 (~5 degrees). Beyond that the lobe is narrower than a pixel
  // footprint on a normal-mapped surface and turns into crawling fireflies.
  float scN = min( 2.0 / scW, 240.0 );
  // 0.159 = 1/(2pi): converts the lobe's peak back to a radiance.
  float scDisc = pow( scCa, scN ) * scN * 0.159;
  // The WIDE half of the sunset lobe, and the half that actually does the work.
  // A disc-only highlight is ~7 degrees across; whether it lands is a coin
  // flip on where the camera happens to be, and a material that is only metal
  // from one angle is not a material. skyenv.js models the same aureole for the
  // diffuse chain as 0.34*exp(-gamma*0.62) — tens of degrees wide, carrying
  // real energy — and this is its specular counterpart. It gives every metal
  // face a bright sun side and a dark away side, which is the actual reason a
  // reflective surface reads as reflective.
  float scHaze = scCa * scCa * ( 0.35 + 0.65 * scCa );
  radiance += directionalLights[ 0 ].color
            * ( scDisc + scHaze * scSunP.z ) * scFace * scSpecP.x
            * mix( 1.0 - scSunP.y, 1.0, scCavity );
}
#endif
`

/**
 * ============================ THE HORIZON GLINT ============================
 *
 * The sun lobe above only fires on faces that mirror the sun into the eye, and
 * `scFace` deliberately gates it off on everything else. That is correct, and
 * it also means a brass wall facing anywhere but the sun has NOTHING sharp to
 * reflect: skyenv.js is a 128x64 equirect of smooth gradients, run through
 * PMREM, so what a polished plate returns is a smooth gradient. Measured on the
 * crossing capture, a 200x200 patch of "polished brass" spanned 24 luma. That
 * is orange paint, and no roughness value fixes it, because you cannot get a
 * highlight out of an environment that has none.
 *
 * The real sky has exactly one sharp feature: the line where the cloud sea ends
 * and the sky begins. It is bright, it is narrow, and — this is the part that
 * matters — a polished surface shows it as a BAND that sweeps as the camera
 * moves, because the reflected direction sweeps. That sweep is the actual
 * perceptual cue for "metal"; colour is not.
 *
 * So: an analytic band added into `radiance`, keyed to the elevation of the
 * reflected direction, widened by the surface's own roughness, and weighted by
 * a Fresnel term so grazing angles go bright. Three consequences:
 *
 *   - It is view-dependent, so it moves. A wall-run gets directional parallax
 *     off the wall it is running along.
 *   - It goes through RE_IndirectSpecular, so it is tinted by F0. On brass that
 *     is a gold tint; on sandstone (F0 = 0.04 dielectric) it is a faint white
 *     sheen, which is what separates the two.
 *   - Because it is added to `radiance` AFTER the cavity occlusion below, a
 *     rivet channel does not glint and the rivet crown beside it does.
 *
 * It is a stylisation of one specific real feature, not a fake highlight: the
 * band is where the environment actually is bright.
 */
const HORIZON_GLINT = /* glsl */ `
#ifdef SC_CAVITY
  // SPECULAR OCCLUSION. Reflected radiance is the only thing painting a metal,
  // so without this a recessed plate is exactly as bright as a proud rivet and
  // brass has no dark end at all. This is what gives it a value RANGE.
  radiance *= mix( 1.0 - scGlintP.y, 1.0, scCavity );
#endif
#ifdef SC_GLINT
{
  vec3 scRv = reflect( -geometryViewDir, geometryNormal );
  // Band half-width in sin(elevation). A mirror shows the horizon as a hard
  // line; a satin finish smears it over tens of degrees. Driving the width off
  // the material's own roughness is what makes the polished rivet crowns read
  // as a different finish from the plate they sit in.
  float scBw = mix( 0.05, 0.40, material.roughness );
  float scBand = exp( -( scRv.y * scRv.y ) / ( scBw * scBw ) );
  // Schlick-shaped weight: at normal incidence a surface returns a few percent
  // of what it sees, at grazing it returns nearly all of it. 0.30 rather than
  // 0 at the bottom because F0 on a metal is already high.
  float scFr = pow( 1.0 - clamp( dot( geometryNormal, geometryViewDir ), 0.0, 1.0 ), 4.0 );
  radiance += scHorizonCol * scBand * ( 0.30 + 1.10 * scFr ) * scGlintP.x;
}
#endif
`

/**
 * ================================= WRAP ===================================
 *
 * The sun sits at elevation 9.8 degrees (world.js: sunDir.y = 0.17). A flat
 * moss deck facing straight up therefore collects cos(80 deg) = 0.17 of the
 * key, and everything else it has is ambient — which is why the measured moss
 * deck came back at value 0.17 while the sandstone beside it was at 0.44. Half
 * of that is albedo (fixed in textures.js) and half is this: Lambert is simply
 * the wrong BRDF for foliage.
 *
 * Moss is a stack of translucent filaments a few millimetres deep. Light that
 * enters near the terminator scatters inside and leaves again on the shaded
 * side, so the real falloff is much softer than max(N.L, 0) — the standard
 * cheap model is (N.L + w)/(1 + w), and at w = 0.4 an up-facing deck under this
 * sun goes from 0.17 to 0.41 of the key. That is the single biggest available
 * lever on "the moss reads as mud".
 *
 * Plus a back-lit transmission term: a cap edge overhanging the void with the
 * sun behind it glows, because you are looking THROUGH a few millimetres of
 * moss at the sun. It is the reference art's most recognisable vegetation cue.
 *
 * Both terms are unshadowed, which is a deliberate simplification: three
 * applies the shadow inside the light loop and does not publish the result, and
 * a transmission term that respects a shadow map cast by the very surface it is
 * transmitting through is wrong anyway. The amounts are sized so an in-shadow
 * moss cap gains a lift, not a second sun.
 */
const WRAP_DIFFUSE = /* glsl */ `
#if defined( SC_WRAP ) && ( NUM_DIR_LIGHTS > 0 )
{
  vec3 scWl = directionalLights[ 0 ].direction;
  float scNl = dot( geometryNormal, scWl );
  float scWrapped = clamp( ( scNl + scWrapP.x ) / ( 1.0 + scWrapP.x ), 0.0, 1.0 );
  // Only the part Lambert did not already deliver, so this never double-counts
  // the lit side — it fills in the terminator and the shaded hemisphere.
  float scExtra = max( scWrapped - max( scNl, 0.0 ), 0.0 );
  // Back-lit: sun behind the surface AND pointed at the eye. Squared, so it is
  // a rim on the edge that overhangs the void rather than a wash.
  float scBack = clamp( -dot( geometryViewDir, scWl ), 0.0, 1.0 );
  scBack *= scBack * clamp( 0.30 - scNl, 0.0, 1.0 );
  reflectedLight.directDiffuse += directionalLights[ 0 ].color * material.diffuseColor
    * ( scExtra * scWrapP.y + scBack * scWrapP.z ) * RECIPROCAL_PI;
}
#endif
`

/**
 * Chunk overrides. `<color_fragment>` is deliberately absent: level.js owns the
 * vertex colour channels and they must apply exactly as they do today.
 */
const OVERRIDES = [
  // Roughness offset from the macro bands / wedge / top wear. The 0.04 floor
  // keeps porcelain and brass glossy enough to still catch a highlight. The
  // chunk is replaced rather than appended to because under SC_WORLDUV the
  // sample has to move to the world-planar uv along with the albedo.
  [
    '#include <roughnessmap_fragment>',
    `float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
  roughnessFactor *= texture2D( roughnessMap, scUv0 ).g;
#endif
roughnessFactor = clamp( roughnessFactor + scRoughAdd, 0.04, 1.0 );`,
  ],
  [
    '#include <metalnessmap_fragment>',
    `float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  metalnessFactor *= texture2D( metalnessMap, scUv0 ).b;
#endif
#ifdef SC_PATINA
  // Verdigris is a dielectric salt sitting ON the alloy, not a tint of it.
  // Without this the crust keeps a metal's F0 and reads as green anodising.
  metalnessFactor *= 1.0 - scPatina * scPatinaP.z;
#endif`,
  ],
  // The macro tilt is added AFTER the tile-scale normal map, not instead of
  // it: they work at different scales and both are wanted. `normal` is
  // view-space here; viewMatrix is rigid, so its upper 3x3 carries a world
  // direction across without renormalising.
  [
    '#include <normal_fragment_maps>',
    `#include <normal_fragment_maps>
#if defined( SC_WORLDUV ) && defined( USE_NORMALMAP_TANGENTSPACE ) && defined( USE_MAP )
{
  // The tangent frame three just built was derived from the screen-space
  // derivatives of vNormalMapUv, and we sampled somewhere else entirely — so it
  // has to be rebuilt in the frame the world-planar projection actually used.
  // Built analytically from that projection rather than from derivatives; see
  // the scTuW declaration for why the derivative route is a NaN hazard.
  //
  // viewMatrix's upper 3x3 is a rotation, and scTuW/scTvW/scNwW are an
  // orthonormal triple by construction, so this needs no renormalisation and
  // has no degenerate case.
  vec3 scMapN = texture2D( normalMap, scUv0 ).xyz * 2.0 - 1.0;
  scMapN.xy *= normalScale;
  normal = mat3( viewMatrix ) * ( scTuW * scMapN.x + scTvW * scMapN.y + scNwW * scMapN.z );
  normal = normalize( normal );
}
#endif
#if defined( SC_RELIEF ) && defined( USE_MAP )
  normal = normalize( normal + mat3( viewMatrix ) * scTiltW );
#endif`,
  ],
  // Wrapped and back-lit diffuse, added to the direct chain right after three
  // has finished accumulating it.
  ['#include <lights_fragment_begin>', '#include <lights_fragment_begin>\n' + WRAP_DIFFUSE],
  // The sun's aureole and the horizon band, into the IBL specular accumulator
  // only. Placed after <lights_fragment_maps> because that is where `radiance`
  // is filled and before <lights_fragment_end>, which is where it is consumed.
  [
    '#include <lights_fragment_maps>',
    '#include <lights_fragment_maps>\n' + HORIZON_GLINT + SUN_LOBE,
  ],
]

/**
 * Cache-key generation. Bump when the GLSL above changes in a way that must
 * invalidate a warm program cache — three keys programs on the chunk set plus
 * this string, and will happily reuse a stale compiled program otherwise.
 */
const SHADER_VERSION = 'sc4'

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
  /**
   * How much of the sun's aureole this material reflects. 0 disables the lobe
   * and its branch. Metals want the most; a matte moss cap wants a trace, but
   * not zero — a wet moss cap does catch the sky.
   */
  sunLobe: 0,
  /** how hard a recess is tinted toward the cool zenith; 0 disables */
  cavity: 0,
  /** how hard the sun-away hemisphere is tinted cool; 0 disables */
  shadeTint: 0,
  /**
   * How hard an UP-facing face is biased toward the warm horizon ring; 0
   * disables the term and its branch. See scSkyWarmCol — this is the knob that
   * decides whether a walking deck reads as sandstone or as mint.
   */
  upWarm: 0,
  /**
   * Verdigris on downward faces. 0 disables the term, its two uniforms and its
   * branch. Metals only: on a dielectric it is just a green stain, and the
   * materials that want one already paint it into the tile.
   */
  patina: 0,
  /** verdigris in crevices, riding the same cavity signal as `cavity` */
  patinaCavity: 0.30,
  /** how much metalness the crust kills where it is at full strength */
  patinaMetal: 0.85,
  /**
   * How much of the cloud-sea horizon band this surface mirrors back. 0
   * disables the term and its branch. See THE HORIZON GLINT — this is the knob
   * that decides whether a material reads as polished or as painted.
   */
  glint: 0,
  /**
   * How much reflected radiance a fully-enclosed pocket loses. Needs cavity > 0
   * (the signal rides in the normal map's alpha). On a metal this is the only
   * thing that produces a dark end at all.
   */
  specAo: 0.55,
  /** wrapped-diffuse width w in (N.L + w)/(1 + w). See WRAP. */
  wrapWidth: 0.4,
  /** wrapped-diffuse amount; 0 disables the term and its branch */
  wrap: 0,
  /** back-lit transmission amount; rides along with `wrap` */
  backlit: 0,
  /**
   * Sample the tile in world-planar space at this many repeats per metre
   * instead of per-box uv. 0 = off (use vMapUv). Must match level.js's
   * TEX_PER_METRE when on, or the material changes texel density.
   */
  worldUv: 0,
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
    scReliefP: { value: new THREE.Vector4(p.relief, p.reliefAlbedo, p.detile, p.worldUv) },
    scWeatherP: {
      value: new THREE.Vector4(p.wedge, p.topDust, p.wedgeHeight, p.topRough),
    },
    scSpecP: { value: new THREE.Vector4(p.sunLobe, p.cavity, p.shadeTint, p.upWarm) },
    scGlintP: { value: new THREE.Vector4(p.glint, p.specAo, 0, 0) },
    scPatinaP: {
      value: new THREE.Vector4(p.patina, p.patinaCavity, p.patinaMetal, 0),
    },
    scWrapP: { value: new THREE.Vector4(p.wrapWidth, p.wrap, p.backlit, 0) },
    // THREE.Color converts the sRGB hex into the renderer's working space.
    scWedgeCol: { value: new THREE.Color(p.wedgeColor) },
    scTopCol: { value: new THREE.Color(p.topColor) },
  }

  const defines = {}
  if (p.relief > 0) defines.SC_RELIEF = ''
  if (p.detile > 0) defines.SC_DETILE = ''
  if (p.wedge > 0) defines.SC_WEDGE = ''
  if (p.topDust > 0) defines.SC_TOPWEAR = ''
  if (p.sunLobe > 0) defines.SC_SUNLOBE = ''
  // Cavity rides in the normal map's alpha, so it cannot be enabled without one.
  if (p.cavity > 0 && material.normalMap) defines.SC_CAVITY = ''
  if (p.shadeTint > 0) defines.SC_SHADETINT = ''
  if (p.upWarm > 0) defines.SC_UPWARM = ''
  // The crevice half of the patina rides the cavity signal, so like SC_CAVITY
  // it needs a normal map to read the alpha out of.
  if (p.patina > 0 && material.normalMap) defines.SC_PATINA = ''
  if (p.glint > 0) defines.SC_GLINT = ''
  if (p.wrap > 0 || p.backlit > 0) defines.SC_WRAP = ''
  if (p.worldUv > 0) defines.SC_WORLDUV = ''

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
